import { useEffect, useState } from 'react';
import {
  Box, Typography, Dialog, DialogTitle, DialogContent, DialogActions, Button,
  Table, TableBody, TableCell, TableHead, TableRow, TableContainer, TextField,
  Chip, Divider, Alert, CircularProgress, IconButton, Paper, Tooltip,
  FormControlLabel, Checkbox, useMediaQuery,
} from '@mui/material';
import PrintIcon from '@mui/icons-material/Print';
import CloseIcon from '@mui/icons-material/Close';
import UndoIcon from '@mui/icons-material/Undo';
import BlockIcon from '@mui/icons-material/Block';
import { api } from '../api';
import { printInvoice } from '../printInvoice';
import { fmt, fmtDateTime, fmtDate } from '../utils';

export function statusChip(status, returnedUnits) {
  if (status === 'cancelled') return <Chip size="small" color="error" label="Cancelled" />;
  if (status === 'returned') return <Chip size="small" color="warning" label="Fully returned" />;
  if (status === 'partial_return' || returnedUnits > 0) {
    return <Chip size="small" color="warning" variant="outlined" label="Part returned" />;
  }
  return <Chip size="small" color="success" variant="outlined" label="Active" />;
}

/**
 * Bill detail with the two corrections a counter actually needs:
 * cancel the whole bill, or take back some units. Both put stock back.
 */
export default function BillDetailDialog({ saleId, settings, onClose, onChanged }) {
  const isMobile = useMediaQuery('(max-width:900px)');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState('view'); // view | return | cancel
  const [returnQty, setReturnQty] = useState({}); // sale_item_id -> qty
  const [reason, setReason] = useState('');
  const [restock, setRestock] = useState(true);

  const load = () => {
    setData(null);
    api('/api/sales/' + saleId).then(setData).catch((e) => setError(e.message));
  };
  useEffect(load, [saleId]);

  const startReturn = () => {
    setReturnQty({});
    setReason('');
    setRestock(true);
    setMode('return');
  };

  const returnTotal = data
    ? data.items.reduce((sum, it) => {
        const q = Number(returnQty[it.id] || 0);
        return sum + q * it.unit_price * (1 + (it.gst_rate || 0) / 100);
      }, 0)
    : 0;
  const anyReturnSelected = Object.values(returnQty).some((q) => Number(q) > 0);

  const submitReturn = async () => {
    setBusy(true);
    setError('');
    try {
      const items = Object.entries(returnQty)
        .filter(([, q]) => Number(q) > 0)
        .map(([id, q]) => ({ sale_item_id: Number(id), quantity: Number(q) }));
      const r = await api(`/api/sales/${saleId}/return`, { method: 'POST', body: { items, reason, restock } });
      setMode('view');
      load();
      onChanged?.(`Return saved — ${fmt(r.refund_amount)} refunded${r.restocked ? ' and stock put back' : ''}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const submitCancel = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api(`/api/sales/${saleId}/cancel`, { method: 'POST', body: { reason, restock } });
      setMode('view');
      load();
      onChanged?.(`Bill cancelled — ${fmt(r.refund_amount)} refunded${r.restocked ? ' and stock put back' : ''}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const doPrint = () => {
    if (!data) return;
    const ok = printInvoice(settings, { ...data.sale }, data.items, { reprint: true, refunded: data.refunded });
    if (!ok) setError('Your browser blocked the print window. Allow pop-ups for this site and try again.');
  };

  const sale = data?.sale;
  const canCorrect = sale && sale.status !== 'cancelled' &&
    data.items.some((i) => i.returnable_qty > 0);

  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth fullScreen={isMobile}>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 1 }}>
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography sx={{ fontWeight: 700, fontSize: 18 }}>
            {sale ? sale.invoice_number : 'Loading bill…'}
          </Typography>
          {sale && (
            <Typography variant="caption" color="text.secondary">
              {fmtDateTime(sale.created_at)} · by {sale.served_by}
              {sale.customer_name ? ` · ${sale.customer_name}` : ''}
            </Typography>
          )}
        </Box>
        {sale && statusChip(sale.status)}
        <IconButton onClick={onClose} aria-label="Close"><CloseIcon /></IconButton>
      </DialogTitle>

      <DialogContent dividers>
        {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}
        {!data && !error && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 5 }}><CircularProgress /></Box>
        )}

        {data && (
          <>
            {sale.status === 'cancelled' && (
              <Alert severity="error" sx={{ mb: 2 }}>
                This bill was cancelled on {fmtDateTime(sale.cancelled_at)}
                {sale.cancel_reason ? ` — “${sale.cancel_reason}”` : ''}. Stock was returned to inventory.
              </Alert>
            )}

            {mode === 'view' && (
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Item</TableCell>
                      <TableCell align="center">Qty</TableCell>
                      <TableCell align="right">Rate</TableCell>
                      <TableCell align="right">Amount</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {data.items.map((it) => (
                      <TableRow key={it.id} sx={it.returned_qty > 0 ? { bgcolor: '#fff8e1' } : undefined}>
                        <TableCell>
                          <Typography sx={{ fontSize: 14, fontWeight: 600 }}>{it.medicine_name}</Typography>
                          <Typography variant="caption" color="text.secondary">
                            {it.company} · Batch {it.batch_number} · Exp {fmtDate(it.expiry_date)}
                          </Typography>
                          {it.returned_qty > 0 && (
                            <Typography variant="caption" color="warning.main" sx={{ display: 'block' }}>
                              {it.returned_qty} returned
                            </Typography>
                          )}
                        </TableCell>
                        <TableCell align="center">
                          {it.returned_qty > 0 ? `${it.returnable_qty} of ${it.quantity}` : it.quantity}
                        </TableCell>
                        <TableCell align="right">{fmt(it.unit_price)}</TableCell>
                        <TableCell align="right" sx={{ fontWeight: 600 }}>
                          {fmt(it.returnable_qty * it.unit_price * (1 + (it.gst_rate || 0) / 100))}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}

            {mode === 'return' && (
              <Box>
                <Alert severity="info" sx={{ mb: 2 }}>
                  Enter how many units the customer brought back. Each unit goes back into the
                  same batch it was sold from, so expiry tracking stays correct.
                </Alert>
                {data.items.filter((it) => it.returnable_qty > 0).map((it) => (
                  <Paper key={it.id} variant="outlined" sx={{ p: 1.8, mb: 1.5 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
                      <Box sx={{ flexGrow: 1, minWidth: 170 }}>
                        <Typography sx={{ fontSize: 14, fontWeight: 600 }}>{it.medicine_name}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {it.company} · Batch {it.batch_number} · {fmt(it.unit_price)} each
                        </Typography>
                      </Box>
                      <TextField
                        size="small" type="number" label="Return qty"
                        value={returnQty[it.id] ?? ''}
                        inputProps={{ min: 0, max: it.returnable_qty }}
                        helperText={`max ${it.returnable_qty}`}
                        onChange={(e) => {
                          const v = e.target.value === '' ? '' :
                            Math.max(0, Math.min(it.returnable_qty, Math.floor(Number(e.target.value) || 0)));
                          setReturnQty({ ...returnQty, [it.id]: v });
                        }}
                        sx={{ width: 120 }}
                      />
                      <Button size="small" onClick={() => setReturnQty({ ...returnQty, [it.id]: it.returnable_qty })}>
                        All
                      </Button>
                    </Box>
                  </Paper>
                ))}
                <TextField
                  label="Reason (optional)" fullWidth size="small" sx={{ mt: 1 }}
                  value={reason} onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. patient did not need the full course"
                />
                <FormControlLabel
                  sx={{ mt: 1 }}
                  control={<Checkbox checked={restock} onChange={(e) => setRestock(e.target.checked)} />}
                  label="Put the returned units back into sellable stock"
                />
                {!restock && (
                  <Alert severity="warning" sx={{ mt: 1 }}>
                    Unchecked: the customer is refunded but the medicine is <b>not</b> added back to
                    stock. Use this when the returned strip cannot be resold.
                  </Alert>
                )}
                <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 2 }}>
                  <Typography variant="h6">Refund</Typography>
                  <Typography variant="h6" color="primary.main">{fmt(returnTotal)}</Typography>
                </Box>
              </Box>
            )}

            {mode === 'cancel' && (
              <Box>
                <Alert severity="warning" sx={{ mb: 2 }}>
                  This cancels the <b>whole bill</b>. Every unit not already returned goes back into
                  stock, and the bill stops counting in sales and profit reports.
                </Alert>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                  {data.items.filter((i) => i.returnable_qty > 0).length} line(s),{' '}
                  {data.items.reduce((s, i) => s + i.returnable_qty, 0)} unit(s) will be returned to stock.
                </Typography>
                <TextField
                  label="Reason" fullWidth size="small" autoFocus
                  value={reason} onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. wrong medicine billed"
                />
                <FormControlLabel
                  sx={{ mt: 1 }}
                  control={<Checkbox checked={restock} onChange={(e) => setRestock(e.target.checked)} />}
                  label="Put the stock back into inventory"
                />
              </Box>
            )}

            <Divider sx={{ my: 2 }} />

            <Box sx={{ maxWidth: 320, ml: 'auto' }}>
              <Row label="Subtotal" value={fmt(sale.subtotal)} />
              <Row label="GST" value={fmt(sale.gst_amount)} />
              <Row label="Bill total" value={fmt(sale.total)} />
              {data.refunded > 0 && <Row label="Refunded" value={'− ' + fmt(data.refunded)} color="error.main" />}
              <Divider sx={{ my: 1 }} />
              <Row label="Net" value={fmt(data.net_total)} bold />
            </Box>

            {data.returns.length > 0 && mode === 'view' && (
              <Box sx={{ mt: 3 }}>
                <Typography variant="subtitle2" sx={{ mb: 1 }}>Correction history</Typography>
                {data.returns.map((r) => (
                  <Paper key={r.id} variant="outlined" sx={{ p: 1.5, mb: 1 }}>
                    <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                      <Chip size="small" color={r.kind === 'cancel' ? 'error' : 'warning'}
                        label={r.kind === 'cancel' ? 'Bill cancelled' : 'Items returned'} />
                      <Typography variant="caption" color="text.secondary">
                        {fmtDateTime(r.created_at)} · by {r.user_name}
                      </Typography>
                      <Typography sx={{ ml: 'auto', fontWeight: 700 }}>{fmt(r.refund_amount)}</Typography>
                    </Box>
                    {r.reason && (
                      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>“{r.reason}”</Typography>
                    )}
                    {r.items.map((ri, idx) => (
                      <Typography key={idx} variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                        {ri.quantity} × {ri.medicine_name} (batch {ri.batch_number})
                      </Typography>
                    ))}
                  </Paper>
                ))}
              </Box>
            )}
          </>
        )}
      </DialogContent>

      <DialogActions sx={{ px: 2.5, py: 2, flexWrap: 'wrap', gap: 1 }}>
        {mode === 'view' && (
          <>
            <Button startIcon={<PrintIcon />} onClick={doPrint} disabled={!data}>Reprint</Button>
            <Box sx={{ flexGrow: 1 }} />
            {canCorrect ? (
              <>
                <Button startIcon={<UndoIcon />} color="warning" variant="outlined" onClick={startReturn}>
                  Return items
                </Button>
                <Button startIcon={<BlockIcon />} color="error" variant="contained"
                  onClick={() => { setReason(''); setRestock(true); setMode('cancel'); }}>
                  Cancel bill
                </Button>
              </>
            ) : (
              <Button onClick={onClose}>Close</Button>
            )}
          </>
        )}

        {mode === 'return' && (
          <>
            <Button onClick={() => setMode('view')} disabled={busy}>Back</Button>
            <Box sx={{ flexGrow: 1 }} />
            <Button variant="contained" color="warning" onClick={submitReturn} disabled={busy || !anyReturnSelected}>
              {busy ? 'Saving…' : `Confirm return ${anyReturnSelected ? '· ' + fmt(returnTotal) : ''}`}
            </Button>
          </>
        )}

        {mode === 'cancel' && (
          <>
            <Button onClick={() => setMode('view')} disabled={busy}>Back</Button>
            <Box sx={{ flexGrow: 1 }} />
            <Tooltip title={reason.trim() ? '' : 'Please write why this bill is being cancelled'}>
              <span>
                <Button variant="contained" color="error" onClick={submitCancel} disabled={busy || !reason.trim()}>
                  {busy ? 'Cancelling…' : 'Confirm cancel bill'}
                </Button>
              </span>
            </Tooltip>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}

function Row({ label, value, bold, color }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', py: 0.4 }}>
      <Typography color={bold ? 'text.primary' : 'text.secondary'} sx={{ fontWeight: bold ? 700 : 400 }}>
        {label}
      </Typography>
      <Typography sx={{ fontWeight: bold ? 800 : 500 }} color={color}>{value}</Typography>
    </Box>
  );
}
