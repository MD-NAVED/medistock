import { useEffect, useState, useRef } from 'react';
import {
  Box, Typography, Button, Paper, Snackbar, Alert, Dialog, DialogTitle,
  DialogContent, DialogActions, TextField, MenuItem, Autocomplete, IconButton,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Chip, Divider,
  useMediaQuery, Tooltip, CircularProgress, LinearProgress, Stack,
} from '@mui/material';
import { DataGrid } from '@mui/x-data-grid';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import SaveIcon from '@mui/icons-material/Save';
import UndoIcon from '@mui/icons-material/Undo';
import EditIcon from '@mui/icons-material/Edit';
import PhotoCameraIcon from '@mui/icons-material/PhotoCamera';
import DocumentScannerIcon from '@mui/icons-material/DocumentScanner';
import { api } from '../api';
import { useAuth } from '../auth';
import { fmt, fmtDate, fmtDateTime, todayStr } from '../utils';
import { parseInvoiceImage } from '../utils/invoiceParser';

const EMPTY_LINE = { medicine_id: null, batch_number: '', expiry_date: '', quantity: '', buy_price: '' };
const EMPTY_HEAD = { supplier_name: '', invoice_number: '', date: '' };

/** Mobile view: one card per purchase so nothing needs sideways scrolling. */
function PurchaseCard({ row, isOwner, onOpen }) {
  const reversed = row.status === 'reversed';
  return (
    <Paper sx={{ p: 2, mb: 1.5, opacity: reversed ? 0.75 : 1 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 1 }}>
        <Box sx={{ minWidth: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <Typography sx={{ fontWeight: 700, fontSize: 15 }}>{row.invoice_number}</Typography>
            {reversed && <Chip size="small" color="error" label="Reversed" />}
          </Box>
          <Typography variant="caption" color="text.secondary">{row.supplier_name || 'No supplier name'}</Typography>
        </Box>
        <Typography sx={{
          fontWeight: 800, color: reversed ? 'text.disabled' : 'primary.main', whiteSpace: 'nowrap',
          textDecoration: reversed ? 'line-through' : 'none',
        }}>
          {fmt(row.total)}
        </Typography>
      </Box>
      <Divider sx={{ my: 1.2 }} />
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
        <Chip size="small" variant="outlined" label={`${row.item_count} item${row.item_count === 1 ? '' : 's'}`} />
        <Typography variant="caption" color="text.secondary">{fmtDateTime(row.created_at)}</Typography>
        <Typography variant="caption" color="text.secondary">· by {row.created_by}</Typography>
        <Button size="small" onClick={() => onOpen(row)} sx={{ ml: 'auto' }}>Details</Button>
      </Box>
    </Paper>
  );
}

export default function Purchases() {
  const { user } = useAuth();
  const isOwner = user.role === 'owner';
  const isMobile = useMediaQuery('(max-width:900px)');
  const [rows, setRows] = useState([]);
  const [medicines, setMedicines] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [snack, setSnack] = useState(null);
  const [head, setHead] = useState({ supplier_name: '', invoice_number: '', date: todayStr() });
  const [lines, setLines] = useState([{ ...EMPTY_LINE }]);
  const [detailId, setDetailId] = useState(null);       // purchase being viewed
  const [detail, setDetail] = useState(null);           // loaded detail payload
  const [reverseMode, setReverseMode] = useState(false);
  const [reverseReason, setReverseReason] = useState('');
  const [detailError, setDetailError] = useState('');

  // Edit purchase
  const [editMode, setEditMode] = useState(false);
  const [editHead, setEditHead] = useState({ ...EMPTY_HEAD });
  const [editLines, setEditLines] = useState([{ ...EMPTY_LINE }]);

  // Camera & Image Invoice Scanner
  const [scanBusy, setScanBusy] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [scanStatus, setScanStatus] = useState('');
  const [scannedNotice, setScannedNotice] = useState(false);
  const fileInputRef = useRef(null);

  const handleScanInvoice = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    setScanBusy(true);
    setScanProgress(5);
    setScanStatus('Loading invoice image…');

    try {
      let medList = medicines;
      if (!medList.length) {
        medList = await api('/api/medicines');
        setMedicines(medList);
      }

      const parsed = await parseInvoiceImage(file, medList, (status, pct) => {
        setScanStatus(status);
        setScanProgress(pct);
      });

      setHead({
        supplier_name: parsed.supplier_name || '',
        invoice_number: parsed.invoice_number || '',
        date: parsed.date || todayStr(),
      });

      if (parsed.items && parsed.items.length > 0) {
        setLines(parsed.items.map((it) => ({
          medicine_id: it.medicine_id,
          batch_number: it.batch_number,
          expiry_date: it.expiry_date,
          quantity: it.quantity,
          buy_price: it.buy_price,
        })));
      } else {
        setLines([{ ...EMPTY_LINE }]);
      }

      setScannedNotice(true);
      setOpen(true);
      setSnack({ severity: 'success', message: 'Invoice scanned! Pre-filled purchase details below for review.' });
    } catch (err) {
      setSnack({ severity: 'error', message: err.message || 'Invoice scan failed. Please enter details manually.' });
    } finally {
      setScanBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const load = () => {
    api('/api/purchases').then(setRows).catch((e) => setSnack({ severity: 'error', message: e.message }));
  };
  useEffect(load, []);

  const openDetail = (row) => {
    setDetailId(row.id);
    setDetail(null);
    setReverseMode(false);
    setReverseReason('');
    setDetailError('');
    api('/api/purchases/' + row.id).then(setDetail).catch((e) => setDetailError(e.message));
  };

  const closeDetail = () => { setDetailId(null); setDetail(null); };

  const doReverse = async () => {
    setBusy(true);
    setDetailError('');
    try {
      const r = await api(`/api/purchases/${detailId}/reverse`, {
        method: 'POST', body: { reason: reverseReason },
      });
      setSnack({
        severity: 'success',
        message: `Purchase reversed — ${r.reversed_items} item(s) removed from stock`,
      });
      closeDetail();
      load();
    } catch (e) {
      setDetailError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const openDialog = () => {
    setHead({ supplier_name: '', invoice_number: '', date: todayStr() });
    setLines([{ ...EMPTY_LINE }]);
    setScannedNotice(false);
    setOpen(true);
    api('/api/medicines').then(setMedicines).catch(() => {});
  };

  const setLine = (i, patch) => setLines(lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const lineTotal = (l) => (Number(l.quantity) || 0) * (Number(l.buy_price) || 0);
  const grandTotal = lines.reduce((s, l) => s + lineTotal(l), 0);
  const canSave = lines.every((l) =>
    l.medicine_id && l.batch_number.trim() && /^\d{4}-\d{2}-\d{2}$/.test(l.expiry_date) && Number(l.quantity) > 0 && Number(l.buy_price) >= 0
  );

  const save = async () => {
    setBusy(true);
    try {
      const r = await api('/api/purchases', {
        method: 'POST',
        body: {
          supplier_name: head.supplier_name,
          invoice_number: head.invoice_number,
          items: lines.map((l) => ({ ...l, quantity: Number(l.quantity), buy_price: Number(l.buy_price) })),
        },
      });
      setSnack({ severity: 'success', message: `Purchase saved — stock automatically increased (total ${fmt(r.total)})` });
      setOpen(false);
      load();
    } catch (e) {
      setSnack({ severity: 'error', message: e.message });
    } finally {
      setBusy(false);
    }
  };

  // ----- Edit purchase (owner only). The detail dialog stays open underneath;
  // after saving we re-fetch it so the user sees the corrected lines. -----
  const setEditLine = (i, patch) => setEditLines(editLines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const editGrandTotal = editLines.reduce((s, l) => s + lineTotal(l), 0);
  const editCanSave = editLines.length > 0 && editLines.every((l) =>
    l.medicine_id && l.batch_number.trim() && /^\d{4}-\d{2}-\d{2}$/.test(l.expiry_date) && Number(l.quantity) > 0 && Number(l.buy_price) >= 0
  );

  const openEdit = () => {
    if (!detail) return;
    setEditHead({
      supplier_name: detail.purchase.supplier_name || '',
      invoice_number: detail.purchase.invoice_number || '',
      date: '',
    });
    setEditLines(detail.items.map((it) => ({
      medicine_id: it.medicine_id,
      batch_number: it.batch_number,
      expiry_date: it.expiry_date,
      quantity: String(it.quantity),
      buy_price: String(it.buy_price),
    })));
    api('/api/medicines').then(setMedicines).catch(() => {});
    setEditMode(true);
  };

  const saveEdit = async () => {
    setBusy(true);
    try {
      const r = await api(`/api/purchases/${detailId}`, {
        method: 'PUT',
        body: {
          supplier_name: editHead.supplier_name,
          invoice_number: editHead.invoice_number,
          items: editLines.map((l) => ({ ...l, quantity: Number(l.quantity), buy_price: Number(l.buy_price) })),
        },
      });
      setSnack({ severity: 'success', message: `Purchase updated — stock adjusted (new total ${fmt(r.total)})` });
      setEditMode(false);
      api('/api/purchases/' + detailId).then(setDetail).catch(() => {});
      load();
    } catch (e) {
      setSnack({ severity: 'error', message: e.message });
    } finally {
      setBusy(false);
    }
  };

  const columns = [
    {
      field: 'invoice_number', headerName: 'Purchase Invoice', width: 170,
      renderCell: (p) => (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, height: '100%' }}>
          <Typography sx={{
            fontSize: 14, fontWeight: 600,
            textDecoration: p.row.status === 'reversed' ? 'line-through' : 'none',
            color: p.row.status === 'reversed' ? 'text.disabled' : 'text.primary',
          }}>
            {p.value}
          </Typography>
          {p.row.status === 'reversed' && <Chip size="small" color="error" label="Reversed" />}
        </Box>
      ),
    },
    { field: 'supplier_name', headerName: 'Supplier', flex: 1, minWidth: 170 },
    { field: 'item_count', headerName: 'Items', width: 80, type: 'number' },
    { field: 'total', headerName: 'Total', width: 120, type: 'number', valueFormatter: (value) => fmt(value) },
    { field: 'created_by', headerName: 'Entered By', width: 130 },
    { field: 'created_at', headerName: 'Date', width: 160, valueFormatter: (value) => fmtDateTime(value) },
    {
      field: 'details', headerName: '', width: 100, sortable: false, filterable: false,
      renderCell: (p) => <Button size="small" onClick={() => openDetail(p.row)}>Details</Button>,
    },
  ];

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 2, flexWrap: 'wrap', gap: { xs: 1.5, md: 2 } }}>
        <Typography variant="h5" sx={{ flexGrow: 1, fontSize: { xs: 20, md: 24 } }}>Purchases — Stock In</Typography>
        
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: 'none' }}
          onChange={handleScanInvoice}
        />

        <Button
          variant="contained"
          color="secondary"
          startIcon={<PhotoCameraIcon />}
          onClick={() => fileInputRef.current?.click()}
          disabled={scanBusy}
          sx={{ whiteSpace: 'nowrap', bgcolor: '#7b1fa2', '&:hover': { bgcolor: '#6a1b9a' } }}
        >
          {scanBusy ? 'Scanning…' : (isMobile ? 'Scan Invoice' : 'Scan Bill (Camera/Image)')}
        </Button>

        <Button variant="contained" startIcon={<AddIcon />} onClick={openDialog} sx={{ whiteSpace: 'nowrap' }}>
          {isMobile ? 'Manual Entry' : 'Manual Purchase Entry'}
        </Button>
      </Box>

      <Alert severity="success" icon={<DocumentScannerIcon />} sx={{ mb: 2 }}>
        📷 <b>Smart Camera Invoice Scanning Enabled</b>: Take a photo or upload a supplier bill to automatically extract items, batches & prices for review.
      </Alert>

      {isMobile ? (
        <Box>
          {rows.length === 0 && <Alert severity="info">No purchases yet. Tap “New Entry” to add stock.</Alert>}
          {rows.map((row) => <PurchaseCard key={row.id} row={row} isOwner={isOwner} onOpen={openDetail} />)}
        </Box>
      ) : (
        <Box sx={{ height: 560, bgcolor: 'background.paper', borderRadius: 2, border: '1px solid #e0e6e4' }}>
          <DataGrid rows={rows} columns={columns} pageSizeOptions={[25, 50]} disableRowSelectionOnClick sx={{ border: 'none' }} />
        </Box>
      )}

      {/* Purchase detail + reverse */}
      <Dialog open={!!detailId} onClose={closeDetail} maxWidth="sm" fullWidth fullScreen={isMobile}>
        <DialogTitle>
          {detail ? detail.purchase.invoice_number : 'Purchase details'}
          {detail?.purchase.status === 'reversed' && (
            <Chip size="small" color="error" label="Reversed" sx={{ ml: 1 }} />
          )}
        </DialogTitle>
        <DialogContent dividers>
          {detailError && <Alert severity="warning" sx={{ mb: 2 }} onClose={() => setDetailError('')}>{detailError}</Alert>}
          {!detail && !detailError && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress /></Box>
          )}

          {detail && (
            <>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                {detail.purchase.supplier_name || 'No supplier name'} · {fmtDateTime(detail.purchase.created_at)} ·
                entered by {detail.purchase.created_by}
              </Typography>

              {detail.purchase.status === 'reversed' && (
                <Alert severity="error" sx={{ mb: 2 }}>
                  Reversed on {fmtDateTime(detail.purchase.reversed_at)}
                  {detail.purchase.reverse_reason ? ` — “${detail.purchase.reverse_reason}”` : ''}.
                  These units were taken back out of stock.
                </Alert>
              )}

              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Medicine</TableCell>
                      <TableCell>Batch</TableCell>
                      <TableCell align="right">Qty</TableCell>
                      <TableCell align="right">Cost</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {detail.items.map((it) => (
                      <TableRow key={it.id}>
                        <TableCell>
                          <Typography sx={{ fontSize: 14, fontWeight: 600 }}>{it.medicine_name}</Typography>
                          <Typography variant="caption" color="text.secondary">{it.company}</Typography>
                        </TableCell>
                        <TableCell>
                          {it.batch_number}
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                            exp {fmtDate(it.expiry_date)}
                          </Typography>
                        </TableCell>
                        <TableCell align="right" sx={{ fontWeight: 700 }}>{it.quantity}</TableCell>
                        <TableCell align="right">{fmt(it.quantity * it.buy_price)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>

              <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 2 }}>
                <Typography variant="h6">Total</Typography>
                <Typography variant="h6">{fmt(detail.purchase.total)}</Typography>
              </Box>

              {reverseMode && (
                <Box sx={{ mt: 2 }}>
                  <Alert severity="warning" sx={{ mb: 2 }}>
                    Reversing takes these units back out of stock. It only works while the stock is
                    still unsold — if some was already billed, the reversal is refused.
                  </Alert>
                  <TextField
                    label="Reason" fullWidth size="small" autoFocus value={reverseReason}
                    onChange={(e) => setReverseReason(e.target.value)}
                    placeholder="e.g. same invoice entered twice"
                  />
                </Box>
              )}
            </>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 2.5, py: 2 }}>
          {reverseMode ? (
            <>
              <Button onClick={() => setReverseMode(false)} disabled={busy}>Back</Button>
              <Box sx={{ flexGrow: 1 }} />
              <Button variant="contained" color="error" onClick={doReverse} disabled={busy || !reverseReason.trim()}>
                {busy ? 'Reversing…' : 'Confirm reverse'}
              </Button>
            </>
          ) : (
            <>
              <Button onClick={closeDetail}>Close</Button>
              <Box sx={{ flexGrow: 1 }} />
              {detail && detail.purchase.status !== 'reversed' && (
                <Tooltip title={isOwner ? '' : 'Only the owner can edit a purchase'}>
                  <span>
                    <Button variant="outlined" startIcon={<EditIcon />} onClick={openEdit} disabled={!isOwner}>
                      Edit
                    </Button>
                  </span>
                </Tooltip>
              )}
              {detail && detail.purchase.status !== 'reversed' && (
                <Tooltip title={isOwner ? '' : 'Only the owner can reverse a purchase'}>
                  <span>
                    <Button color="error" variant="outlined" startIcon={<UndoIcon />}
                      onClick={() => setReverseMode(true)} disabled={!isOwner}>
                      Reverse purchase
                    </Button>
                  </span>
                </Tooltip>
              )}
            </>
          )}
        </DialogActions>
      </Dialog>

      {/* Invoice Scanning Progress Dialog */}
      <Dialog open={scanBusy} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ textAlign: 'center', pb: 1 }}>Scanning Invoice…</DialogTitle>
        <DialogContent sx={{ textAlign: 'center', py: 3 }}>
          <CircularProgress size={48} sx={{ mb: 2, color: '#7b1fa2' }} />
          <Typography variant="body1" sx={{ fontWeight: 600, mb: 1 }}>{scanStatus}</Typography>
          <LinearProgress variant="determinate" value={scanProgress} sx={{ height: 8, borderRadius: 4, bgcolor: '#f3e5f5', '& .MuiLinearProgress-bar': { bgcolor: '#7b1fa2' } }} />
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            Extracting supplier, medicines, batch numbers & prices…
          </Typography>
        </DialogContent>
      </Dialog>

      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="md" fullWidth fullScreen={isMobile}>
        <DialogTitle>New Purchase — add stock by batch</DialogTitle>
        <DialogContent sx={{ pt: '8px !important' }}>
          {scannedNotice && (
            <Alert severity="info" sx={{ mb: 2, mt: 1 }}>
              ✨ <b>Scanned from Invoice</b>: Supplier details, batch numbers, quantities, and prices pre-filled below. Please review and adjust any field before saving to update stock.
            </Alert>
          )}
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2, mt: 1 }}>
            <TextField label="Supplier Name" value={head.supplier_name} onChange={(e) => setHead({ ...head, supplier_name: e.target.value })} />
            <TextField label="Supplier Invoice No. (optional)" value={head.invoice_number} onChange={(e) => setHead({ ...head, invoice_number: e.target.value })} />
          </Box>

          <Divider sx={{ my: 2.5 }} />

          {isMobile ? (
            /* Mobile: each purchase line becomes a stacked card */
            <Box>
              {lines.map((l, i) => {
                const med = medicines.find((m) => m.id === l.medicine_id);
                return (
                  <Paper key={i} sx={{ p: 2, mb: 2, bgcolor: '#fafbfb' }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', mb: 1.5 }}>
                      <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>Item {i + 1}</Typography>
                      <IconButton size="small" color="error" disabled={lines.length === 1}
                        onClick={() => setLines(lines.filter((_, idx) => idx !== i))}>
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Box>
                    <Autocomplete
                      size="small" options={medicines} value={med || null} fullWidth
                      onChange={(e, v) => setLine(i, { medicine_id: v ? v.id : null, buy_price: v ? v.buy_price : l.buy_price })}
                      getOptionLabel={(o) => `${o.name} — ${o.company}`}
                      renderInput={(p) => <TextField {...p} label="Select medicine" />}
                      sx={{ mb: 2 }}
                    />
                    <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.5 }}>
                      <TextField size="small" label="Batch #" value={l.batch_number}
                        onChange={(e) => setLine(i, { batch_number: e.target.value })} placeholder="e.g. AB1234" />
                      <TextField size="small" label="Expiry" type="date" value={l.expiry_date}
                        InputLabelProps={{ shrink: true }}
                        onChange={(e) => setLine(i, { expiry_date: e.target.value })} />
                      <TextField size="small" label="Qty" type="number" value={l.quantity}
                        inputProps={{ min: 1 }} onChange={(e) => setLine(i, { quantity: e.target.value })} />
                      <TextField size="small" label="Buy Price (₹)" type="number" value={l.buy_price}
                        inputProps={{ min: 0, step: '0.01' }} onChange={(e) => setLine(i, { buy_price: e.target.value })} />
                    </Box>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 1.5 }}>
                      <Typography variant="body2" color="text.secondary">Line total</Typography>
                      <Typography sx={{ fontWeight: 700 }}>{fmt(lineTotal(l))}</Typography>
                    </Box>
                  </Paper>
                );
              })}
            </Box>
          ) : (
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Medicine</TableCell>
                    <TableCell>Batch #</TableCell>
                    <TableCell>Expiry</TableCell>
                    <TableCell>Qty</TableCell>
                    <TableCell>Buy Price</TableCell>
                    <TableCell align="right">Line Total</TableCell>
                    <TableCell />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {lines.map((l, i) => {
                    const med = medicines.find((m) => m.id === l.medicine_id);
                    return (
                      <TableRow key={i}>
                        <TableCell sx={{ minWidth: 240 }}>
                          <Autocomplete
                            size="small" options={medicines} value={med || null}
                            onChange={(e, v) => setLine(i, { medicine_id: v ? v.id : null, buy_price: v ? v.buy_price : l.buy_price })}
                            getOptionLabel={(o) => `${o.name} — ${o.company}`}
                            renderInput={(p) => <TextField {...p} label="Select medicine" />}
                          />
                        </TableCell>
                        <TableCell><TextField size="small" value={l.batch_number} onChange={(e) => setLine(i, { batch_number: e.target.value })} placeholder="e.g. AB1234" sx={{ width: 120 }} /></TableCell>
                        <TableCell><TextField size="small" type="date" value={l.expiry_date} onChange={(e) => setLine(i, { expiry_date: e.target.value })} sx={{ width: 160 }} inputProps={{ min: '2000-01-01' }} /></TableCell>
                        <TableCell><TextField size="small" type="number" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} inputProps={{ min: 1 }} sx={{ width: 90 }} /></TableCell>
                        <TableCell><TextField size="small" type="number" value={l.buy_price} onChange={(e) => setLine(i, { buy_price: e.target.value })} inputProps={{ min: 0, step: '0.01' }} sx={{ width: 110 }} /></TableCell>
                        <TableCell align="right" sx={{ fontWeight: 700 }}>{fmt(lineTotal(l))}</TableCell>
                        <TableCell padding="checkbox">
                          <IconButton size="small" color="error" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, idx) => idx !== i))}>
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          )}

          <Button size="small" startIcon={<AddIcon />} onClick={() => setLines([...lines, { ...EMPTY_LINE }])} sx={{ mt: 1 }}>
            Add another item
          </Button>
          <Alert severity="info" sx={{ mt: 2 }}>
            Entering the same batch number again? It will simply <b>add to the existing batch quantity</b>. New batch numbers create a new stock batch with its own expiry.
          </Alert>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2, flexWrap: 'wrap', gap: 1 }}>
          <Typography sx={{ flexGrow: 1, fontWeight: 800, fontSize: 18 }}>Total: {fmt(grandTotal)}</Typography>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="contained" startIcon={<SaveIcon />} onClick={save} disabled={busy || !canSave}>
            {busy ? 'Saving…' : 'Save & Update Stock'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Edit purchase — pre-filled from the open detail dialog */}
      <Dialog open={editMode} onClose={() => setEditMode(false)} maxWidth="md" fullWidth fullScreen={isMobile}>
        <DialogTitle>Edit Purchase — stock is adjusted automatically</DialogTitle>
        <DialogContent sx={{ pt: '8px !important' }}>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2, mt: 1 }}>
            <TextField label="Supplier Name" value={editHead.supplier_name} onChange={(e) => setEditHead({ ...editHead, supplier_name: e.target.value })} />
            <TextField label="Supplier Invoice No. (optional)" value={editHead.invoice_number} onChange={(e) => setEditHead({ ...editHead, invoice_number: e.target.value })} />
          </Box>

          <Divider sx={{ my: 2.5 }} />

          {isMobile ? (
            <Box>
              {editLines.map((l, i) => {
                const med = medicines.find((m) => m.id === l.medicine_id);
                return (
                  <Paper key={i} sx={{ p: 2, mb: 2, bgcolor: '#fafbfb' }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', mb: 1.5 }}>
                      <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>Item {i + 1}</Typography>
                      <IconButton size="small" color="error" disabled={editLines.length === 1}
                        onClick={() => setEditLines(editLines.filter((_, idx) => idx !== i))}>
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Box>
                    <Autocomplete
                      size="small" options={medicines} value={med || null} fullWidth
                      onChange={(e, v) => setEditLine(i, { medicine_id: v ? v.id : null, buy_price: v ? v.buy_price : l.buy_price })}
                      getOptionLabel={(o) => `${o.name} — ${o.company}`}
                      renderInput={(p) => <TextField {...p} label="Select medicine" />}
                      sx={{ mb: 2 }}
                    />
                    <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.5 }}>
                      <TextField size="small" label="Batch #" value={l.batch_number}
                        onChange={(e) => setEditLine(i, { batch_number: e.target.value })} placeholder="e.g. AB1234" />
                      <TextField size="small" label="Expiry" type="date" value={l.expiry_date}
                        InputLabelProps={{ shrink: true }}
                        onChange={(e) => setEditLine(i, { expiry_date: e.target.value })} />
                      <TextField size="small" label="Qty" type="number" value={l.quantity}
                        inputProps={{ min: 1 }} onChange={(e) => setEditLine(i, { quantity: e.target.value })} />
                      <TextField size="small" label="Buy Price (₹)" type="number" value={l.buy_price}
                        inputProps={{ min: 0, step: '0.01' }} onChange={(e) => setEditLine(i, { buy_price: e.target.value })} />
                    </Box>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 1.5 }}>
                      <Typography variant="body2" color="text.secondary">Line total</Typography>
                      <Typography sx={{ fontWeight: 700 }}>{fmt(lineTotal(l))}</Typography>
                    </Box>
                  </Paper>
                );
              })}
            </Box>
          ) : (
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Medicine</TableCell>
                    <TableCell>Batch #</TableCell>
                    <TableCell>Expiry</TableCell>
                    <TableCell>Qty</TableCell>
                    <TableCell>Buy Price</TableCell>
                    <TableCell align="right">Line Total</TableCell>
                    <TableCell />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {editLines.map((l, i) => {
                    const med = medicines.find((m) => m.id === l.medicine_id);
                    return (
                      <TableRow key={i}>
                        <TableCell sx={{ minWidth: 240 }}>
                          <Autocomplete
                            size="small" options={medicines} value={med || null}
                            onChange={(e, v) => setEditLine(i, { medicine_id: v ? v.id : null, buy_price: v ? v.buy_price : l.buy_price })}
                            getOptionLabel={(o) => `${o.name} — ${o.company}`}
                            renderInput={(p) => <TextField {...p} label="Select medicine" />}
                          />
                        </TableCell>
                        <TableCell><TextField size="small" value={l.batch_number} onChange={(e) => setEditLine(i, { batch_number: e.target.value })} placeholder="e.g. AB1234" sx={{ width: 120 }} /></TableCell>
                        <TableCell><TextField size="small" type="date" value={l.expiry_date} onChange={(e) => setEditLine(i, { expiry_date: e.target.value })} sx={{ width: 160 }} inputProps={{ min: '2000-01-01' }} /></TableCell>
                        <TableCell><TextField size="small" type="number" value={l.quantity} onChange={(e) => setEditLine(i, { quantity: e.target.value })} inputProps={{ min: 1 }} sx={{ width: 90 }} /></TableCell>
                        <TableCell><TextField size="small" type="number" value={l.buy_price} onChange={(e) => setEditLine(i, { buy_price: e.target.value })} inputProps={{ min: 0, step: '0.01' }} sx={{ width: 110 }} /></TableCell>
                        <TableCell align="right" sx={{ fontWeight: 700 }}>{fmt(lineTotal(l))}</TableCell>
                        <TableCell padding="checkbox">
                          <IconButton size="small" color="error" disabled={editLines.length === 1} onClick={() => setEditLines(editLines.filter((_, idx) => idx !== i))}>
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          )}

          <Button size="small" startIcon={<AddIcon />} onClick={() => setEditLines([...editLines, { ...EMPTY_LINE }])} sx={{ mt: 1 }}>
            Add another item
          </Button>
          <Alert severity="warning" sx={{ mt: 2 }}>
            Reducing a quantity or removing an item only works while that stock is still <b>unsold</b> —
            if some units were already billed, the server refuses the edit so stock never goes negative.
          </Alert>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2, flexWrap: 'wrap', gap: 1 }}>
          <Typography sx={{ flexGrow: 1, fontWeight: 800, fontSize: 18 }}>Total: {fmt(editGrandTotal)}</Typography>
          <Button onClick={() => setEditMode(false)}>Cancel</Button>
          <Button variant="contained" startIcon={<SaveIcon />} onClick={saveEdit} disabled={busy || !editCanSave}>
            {busy ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={!!snack} autoHideDuration={4500} onClose={() => setSnack(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        {snack && <Alert severity={snack.severity} onClose={() => setSnack(null)} sx={{ width: '100%' }}>{snack.message}</Alert>}
      </Snackbar>
    </Box>
  );
}
