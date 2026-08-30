import { useMemo, useRef, useState } from 'react';
import {
  Box, Typography, Paper, Button, Alert, AlertTitle, TextField, MenuItem,
  Table, TableBody, TableCell, TableHead, TableRow, Chip, LinearProgress,
  Link, Stack,
} from '@mui/material';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import DownloadIcon from '@mui/icons-material/Download';
import { api } from '../api';
import { fmt } from '../utils';

/**
 * One-time onboarding import for pharmacies switching from other software
 * (Marg, TradeEasy, plain Excel…). Upload → map columns → preview → import.
 * Stock rows carry batch no + expiry so FEFO billing and expiry alerts keep
 * working from day one.
 */

const FIELDS = [
  { key: 'name', label: 'Medicine Name *', required: true, patterns: ['name', 'itemname', 'productname', 'medicine', 'medicinename', 'item', 'product', 'itemdescription'] },
  { key: 'company', label: 'Company', patterns: ['company', 'companyname', 'manufacturer', 'mfr', 'mfg', 'brand', 'firm'] },
  { key: 'type', label: 'Type (Tablet/Syrup…)', patterns: ['type', 'form', 'packing', 'pack', 'category', 'segment'] },
  { key: 'shelf', label: 'Shelf / Rack', patterns: ['shelf', 'rack', 'location', 'shelfno', 'rackno', 'godown', 'place'] },
  { key: 'gst_rate', label: 'GST %', patterns: ['gst', 'gstpercent', 'gstrate', 'tax', 'taxpercent', 'vat'] },
  { key: 'buy_price', label: 'Buy Price / PTR', patterns: ['ptr', 'purchaseprice', 'purchaserate', 'buyprice', 'buyrate', 'tradeprice', 'cost', 'costprice', 'pprice'] },
  { key: 'sell_price', label: 'Sell Price / MRP', patterns: ['mrp', 'sellprice', 'sellingprice', 'saleprice', 'retailprice', 'retail', 'price', 'rprice'] },
  { key: 'batch_no', label: 'Batch No', patterns: ['batch', 'batchno', 'batchnumber', 'batchid', 'bno'] },
  { key: 'expiry_date', label: 'Expiry Date', patterns: ['expiry', 'expirydate', 'expdate', 'exp', 'expdateyyyy mm dd', 'expdt', 'expdateyyyy mmdd', 'expdate', 'expry'] },
  { key: 'quantity', label: 'Stock Qty', patterns: ['qty', 'quantity', 'stock', 'stockqty', 'balance', 'balanceqty', 'closing', 'closingstock', 'currentstock', 'physicalstock'] },
];

const normHeader = (h) => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');
const CHUNK = 250;

function guessField(key, headers) {
  const field = FIELDS.find((f) => f.key === key);
  const normed = headers.map(normHeader);
  for (const p of field.patterns) {
    const idx = normed.indexOf(p);
    if (idx !== -1) return headers[idx];
  }
  for (const p of field.patterns) {
    const idx = normed.findIndex((h) => h.includes(p));
    if (idx !== -1) return headers[idx];
  }
  return '';
}

/* Mirrors the server's importDateToISO so preview rows match what will import. */
function toISODate(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s) || /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/.exec(s);
  if (!m) return null;
  let y, mo, d;
  if (/^\d{4}-/.test(s)) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else { d = +m[1]; mo = +m[2]; y = +m[3]; if (y < 100) y += 2000; }
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

function buildRows(parsed, mapping) {
  return parsed.rows.map((raw) => {
    const get = (k) => (mapping[k] ? String(raw.cells[mapping[k]] ?? '').trim() : '');
    return {
      i: raw.i,
      name: get('name'), company: get('company'), type: get('type'), shelf: get('shelf'),
      gst_rate: get('gst_rate'), buy_price: get('buy_price'), sell_price: get('sell_price'),
      batch_no: get('batch_no'), expiry_date: get('expiry_date'), quantity: get('quantity'),
    };
  });
}

function rowProblem(r) {
  if (!r.name) return 'Medicine name is empty';
  const qty = Number(String(r.quantity).replace(/[₹,\s]/g, ''));
  if (qty > 0 && !toISODate(r.expiry_date)) return 'Expiry date not readable — its stock will be skipped';
  return null;
}

function downloadCsv(filename, rows) {
  const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const csv = rows.map((r) => r.map(esc).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ImportData({ onImported }) {
  const fileRef = useRef(null);
  const [step, setStep] = useState('upload'); // upload | map | preview | done
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [parsed, setParsed] = useState(null); // { sheet, headers, rows }
  const [mapping, setMapping] = useState({});
  const [progress, setProgress] = useState(0);
  const [summary, setSummary] = useState(null);

  const mapped = useMemo(() => (parsed ? buildRows(parsed, mapping) : []), [parsed, mapping]);
  const problems = useMemo(() => mapped.map(rowProblem), [mapped]);
  const okCount = mapped.filter((_, i) => !problems[i]).length;

  const start = async (file) => {
    setError('');
    setBusy(true);
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(new Error('Could not read the file'));
        fr.readAsDataURL(file);
      });
      const file_base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      const res = await api('/api/import/parse', { method: 'POST', body: { file_base64 } });
      if (!res.rows.length) throw new Error('No data rows found in the file');
      const auto = {};
      FIELDS.forEach((f) => { auto[f.key] = guessField(f.key, res.headers); });
      setParsed(res);
      setMapping(auto);
      setStep('map');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const runImport = async () => {
    setBusy(true);
    setError('');
    setStep('preview');
    const clean = mapped.filter((r) => !rowProblem(r));
    const totals = { created: 0, revived: 0, existing: 0, batches_added: 0, batches_updated: 0, stock_skipped: 0, skipped: [] };
    let chunkNo = 0;
    try {
      for (let i = 0; i < clean.length; i += CHUNK) {
        chunkNo = Math.floor(i / CHUNK) + 1;
        const part = clean.slice(i, i + CHUNK).map((r, j) => ({ ...r, i: i + j + 1 }));
        const s = await api('/api/import/commit', { method: 'POST', body: { rows: part } });
        totals.created += s.created;
        totals.revived += s.revived;
        totals.existing += s.existing;
        totals.batches_added += s.batches_added;
        totals.batches_updated += s.batches_updated;
        totals.stock_skipped += s.stock_skipped;
        totals.skipped.push(...s.skipped);
        setProgress(Math.min(100, Math.round(((i + part.length) / clean.length) * 100)));
      }
      setSummary(totals);
      setStep('done');
      onImported?.();
    } catch (e) {
      setError(e.message + ' — problem in chunk ' + chunkNo + '. The rest is already imported, please try again.');
      setStep('map');
    } finally {
      setBusy(false);
    }
  };

  const reset = () => { setStep('upload'); setParsed(null); setMapping({}); setSummary(null); setProgress(0); setError(''); };

  return (
    <Stack spacing={2}>
      {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}

      {step === 'upload' && (
        <Paper sx={{ p: { xs: 2, md: 3 } }}>
          <Alert severity="info" sx={{ mb: 2 }}>
            <AlertTitle>Bring data from your old software</AlertTitle>
            Export the <b>items list from Marg / TradeEasy / any software as Excel or CSV</b>
            and upload it here. MediStock detects the columns automatically — name, company,
            MRP, batch, expiry and stock. Existing stock comes in batch-wise, so expiry alerts
            and FEFO billing work correctly from day one.
          </Alert>
          <input
            ref={fileRef} type="file" hidden accept=".xlsx,.xls,.csv"
            onChange={(e) => { const f = e.target.files[0]; if (f) start(f); e.target.value = ''; }}
          />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <Button variant="contained" size="large" startIcon={<UploadFileIcon />} onClick={() => fileRef.current?.click()} disabled={busy}>
              {busy ? 'Reading file…' : 'Choose Excel / CSV file'}
            </Button>
            <Button
              startIcon={<DownloadIcon />}
              onClick={() => downloadCsv('MediStock-Import-Template.csv', [
                ['Item Name', 'Company', 'Type', 'Shelf', 'GST %', 'Buy Price', 'MRP', 'Batch No', 'Expiry Date', 'Stock Qty'],
                ['Dolo 650mg', 'Micro Labs', 'Tablet', 'A1', '12', '1.30', '2.00', 'DL2451', '12/2027', '500'],
                ['Ascoril LS Syrup', 'Glenmark', 'Syrup', 'B1', '12', '98.00', '125.00', 'AS118', '05/2026', '24'],
              ])}
            >
              Download sample template
            </Button>
          </Stack>
          {busy && <LinearProgress sx={{ mt: 2 }} />}
        </Paper>
      )}

      {step === 'map' && parsed && (
        <Paper sx={{ p: { xs: 2, md: 3 } }}>
          <Typography variant="h6" sx={{ mb: 0.5 }}>Step 2 — Match columns</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            File: <b>{parsed.sheet}</b> sheet, <b>{parsed.rows.length}</b> rows. MediStock
            guessed these automatically — pick a different column if any is wrong.
          </Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2 }}>
            {FIELDS.map((f) => (
              <TextField
                key={f.key} select size="small"
                label={f.label + (f.required ? '' : ' (optional)')}
                value={mapping[f.key] || ''}
                onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value })}
              >
                <MenuItem value=""><em>— Not present —</em></MenuItem>
                {parsed.headers.map((h) => <MenuItem key={h} value={h}>{h}</MenuItem>)}
              </TextField>
            ))}
          </Box>
          <Stack direction="row" spacing={1.5} sx={{ mt: 3 }}>
            <Button variant="contained" disabled={!mapping.name || busy} onClick={() => setStep('preview')}>
              Preview ({okCount} rows ready)
            </Button>
            <Button onClick={reset}>Cancel</Button>
          </Stack>
          {!mapping.name && <Typography variant="caption" color="error" sx={{ mt: 1, display: 'block' }}>Medicine Name ka column zaroori hai</Typography>}
        </Paper>
      )}

      {step === 'preview' && (
        <Paper sx={{ p: { xs: 2, md: 3 } }}>
          <Typography variant="h6" sx={{ mb: 1 }}>Step 3 — Preview</Typography>
          <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: 'wrap', gap: 1 }}>
            <Chip label={`${okCount} rows ready`} color="success" variant="outlined" />
            {mapped.length - okCount > 0 && <Chip label={`${mapped.length - okCount} rows will be skipped`} color="warning" variant="outlined" />}
            {mapping.batch_no && mapping.quantity && <Chip label="Stock batch-wise import hoga" color="info" variant="outlined" />}
          </Stack>
          <Box sx={{ maxHeight: 340, overflow: 'auto', border: '1px solid #e0e6e4', borderRadius: 1 }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell>Status</TableCell>
                  <TableCell>Medicine</TableCell>
                  <TableCell>Company</TableCell>
                  <TableCell>MRP</TableCell>
                  <TableCell>Batch</TableCell>
                  <TableCell>Expiry</TableCell>
                  <TableCell>Qty</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {mapped.slice(0, 100).map((r, i) => (
                  <TableRow key={r.i}>
                    <TableCell>{problems[i]
                      ? <ErrorOutlineIcon color="warning" fontSize="small" titleAccess={problems[i]} />
                      : <CheckCircleIcon color="success" fontSize="small" />}</TableCell>
                    <TableCell>{r.name || <em style={{ color: '#c55' }}>—</em>}</TableCell>
                    <TableCell>{r.company}</TableCell>
                    <TableCell>{r.sell_price ? fmt(r.sell_price) : ''}</TableCell>
                    <TableCell>{r.batch_no}</TableCell>
                    <TableCell>{r.expiry_date}</TableCell>
                    <TableCell>{r.quantity}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
          {mapped.length > 100 && <Typography variant="caption" color="text.secondary">…and {mapped.length - 100} more rows</Typography>}
          <Stack direction="row" spacing={1.5} sx={{ mt: 3 }}>
            <Button variant="contained" color="success" disabled={busy || !okCount} onClick={runImport}>
              {busy ? `Importing… ${progress}%` : `Import now (${okCount} rows)`}
            </Button>
            <Button disabled={busy} onClick={() => setStep('map')}>Back</Button>
          </Stack>
          {busy && <LinearProgress sx={{ mt: 2 }} />}
        </Paper>
      )}

      {step === 'done' && summary && (
        <Paper sx={{ p: { xs: 2, md: 3 }, textAlign: 'center' }}>
          <CheckCircleIcon color="success" sx={{ fontSize: 56, mb: 1 }} />
          <Typography variant="h6" sx={{ mb: 2 }}>Import complete!</Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', sm: 'repeat(3, 1fr)' }, gap: 1.5, maxWidth: 560, mx: 'auto', mb: 2 }}>
            <Chip label={`New medicines: ${summary.created}`} color="success" />
            <Chip label={`Already existed: ${summary.existing}`} />
            <Chip label={`Restored: ${summary.revived}`} />
            <Chip label={`New batches: ${summary.batches_added}`} color="info" />
            <Chip label={`Batches updated: ${summary.batches_updated}`} color="info" />
            <Chip label={`Stock skipped: ${summary.stock_skipped}`} color={summary.stock_skipped ? 'warning' : 'default'} variant="outlined" />
          </Box>
          {summary.skipped.length > 0 && (
            <Alert severity="warning" sx={{ textAlign: 'left', mb: 2 }}>
              {summary.skipped.length} problem(s): {summary.skipped.slice(0, 3).map((s) => `Row ${s.i} — ${s.reason}`).join(' | ')}
              {summary.skipped.length > 3 ? ' …' : ''}
            </Alert>
          )}
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Stock and expiry alerts work immediately. If anything imported wrong, you can
            remove specific items from the Medicines page.
          </Typography>
          <Button variant="contained" onClick={() => { reset(); onImported?.(); }}>Done</Button>
        </Paper>
      )}
    </Stack>
  );
}
