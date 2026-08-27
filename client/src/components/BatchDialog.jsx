import { useEffect, useState } from 'react';
import {
  Box, Typography, Dialog, DialogTitle, DialogContent, DialogActions, Button,
  Table, TableBody, TableCell, TableHead, TableRow, TableContainer, TextField,
  Chip, Divider, Alert, CircularProgress, IconButton, MenuItem, Paper,
  useMediaQuery,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import DeleteSweepIcon from '@mui/icons-material/DeleteSweep';
import { api } from '../api';
import { fmt, fmtDate, fmtDateTime } from '../utils';
import MedicineLogo from './MedicineLogo';

const REASONS = [
  { value: 'expired', label: 'Expired' },
  { value: 'damaged', label: 'Damaged / broken' },
  { value: 'lost', label: 'Lost / missing' },
  { value: 'other', label: 'Other' },
];

export function expiryChip(daysLeft) {
  if (daysLeft < 0) return <Chip size="small" color="error" label={`Expired ${Math.abs(daysLeft)}d ago`} />;
  if (daysLeft <= 30) return <Chip size="small" color="error" variant="filled" label={`${daysLeft}d left`} />;
  if (daysLeft <= 90) return <Chip size="small" color="warning" label={`${daysLeft}d left`} />;
  return <Chip size="small" color="success" variant="outlined" label={`${daysLeft}d left`} />;
}

/**
 * Batch-level view of one medicine: which batches exist, what expires when,
 * and the write-off action that removes expired or damaged units from stock.
 */
export default function BatchDialog({ medicineId, onClose, onChanged }) {
  const isMobile = useMediaQuery('(max-width:900px)');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState(null); // batch being written off
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('expired');
  const [note, setNote] = useState('');

  const load = () => {
    setData(null);
    api(`/api/medicines/${medicineId}/detail`).then(setData).catch((e) => setError(e.message));
  };
  useEffect(load, [medicineId]);

  const startWriteoff = (batch) => {
    setTarget(batch);
    setQty(String(batch.quantity));
    setReason(batch.days_left < 0 ? 'expired' : 'damaged');
    setNote('');
    setError('');
  };

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api(`/api/batches/${target.id}/writeoff`, {
        method: 'POST',
        body: { quantity: Number(qty), reason, note },
      });
      setTarget(null);
      load();
      onChanged?.(`${r.removed} unit(s) removed from stock — loss ${fmt(r.cost_value)}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const med = data?.medicine;
  const live = data ? data.batches.filter((b) => b.quantity > 0) : [];
  const empty = data ? data.batches.filter((b) => b.quantity <= 0) : [];

  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth fullScreen={isMobile}>
      <DialogTitle sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, pr: 1 }}>
        <MedicineLogo src={med?.logo_url} text={med?.company || med?.name || 'M'} />
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography sx={{ fontWeight: 700, fontSize: 18, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{med ? med.name : 'Loading…'}</Typography>
          {med && (
            <Typography variant="caption" color="text.secondary" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {med.company} · {med.type}{med.shelf ? ` · Shelf ${med.shelf}` : ''} · total stock {data.totalStock}
            </Typography>
          )}
        </Box>
        <IconButton onClick={onClose} aria-label="Close"><CloseIcon /></IconButton>
      </DialogTitle>

      <DialogContent dividers>
        {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}
        {!data && !error && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 5 }}><CircularProgress /></Box>
        )}

        {data && !target && (
          <>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>Batches in stock</Typography>
            {live.length === 0 && <Alert severity="warning">No stock left. Add stock from the Purchases page.</Alert>}

            {live.length > 0 && (isMobile ? (
              <Box>
                {live.map((b) => (
                  <Paper key={b.id} variant="outlined" sx={{ p: 1.8, mb: 1.5 }}>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1 }}>
                      <Box>
                        <Typography sx={{ fontWeight: 700, fontSize: 14 }}>Batch {b.batch_number}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          Expires {fmtDate(b.expiry_date)}
                        </Typography>
                      </Box>
                      <Typography sx={{ fontWeight: 700 }}>{b.quantity} units</Typography>
                    </Box>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1.2, flexWrap: 'wrap' }}>
                      {expiryChip(b.days_left)}
                      <Button size="small" color="error" startIcon={<DeleteSweepIcon />}
                        onClick={() => startWriteoff(b)} sx={{ ml: 'auto' }}>
                        Write off
                      </Button>
                    </Box>
                  </Paper>
                ))}
              </Box>
            ) : (
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Batch #</TableCell>
                      <TableCell>Expiry</TableCell>
                      <TableCell align="center">Status</TableCell>
                      <TableCell align="right">Qty</TableCell>
                      <TableCell align="right">Stock value</TableCell>
                      <TableCell />
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {live.map((b) => (
                      <TableRow key={b.id} sx={b.days_left < 0 ? { bgcolor: '#ffebee' } : undefined}>
                        <TableCell sx={{ fontWeight: 600 }}>{b.batch_number}</TableCell>
                        <TableCell>{fmtDate(b.expiry_date)}</TableCell>
                        <TableCell align="center">{expiryChip(b.days_left)}</TableCell>
                        <TableCell align="right" sx={{ fontWeight: 700 }}>{b.quantity}</TableCell>
                        <TableCell align="right">{fmt(b.quantity * med.buy_price)}</TableCell>
                        <TableCell align="right">
                          <Button size="small" color="error" startIcon={<DeleteSweepIcon />} onClick={() => startWriteoff(b)}>
                            Write off
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            ))}

            <Alert severity="info" sx={{ mt: 2 }}>
              Billing always sells the batch that expires soonest (FEFO), so the top batch here is
              the one going out next.
            </Alert>

            {empty.length > 0 && (
              <Box sx={{ mt: 2.5 }}>
                <Typography variant="caption" color="text.secondary">
                  Finished batches: {empty.map((b) => b.batch_number).join(', ')}
                </Typography>
              </Box>
            )}

            {data.writeoffs.length > 0 && (
              <Box sx={{ mt: 3 }}>
                <Divider sx={{ mb: 1.5 }} />
                <Typography variant="subtitle2" sx={{ mb: 1 }}>Write-off history</Typography>
                {data.writeoffs.map((w) => (
                  <Box key={w.id} sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, py: 0.7 }}>
                    <Box>
                      <Typography variant="body2">
                        {w.quantity} units · batch {w.batch_number} · <b>{w.reason}</b>
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {fmtDateTime(w.created_at)} · by {w.user_name}{w.note ? ` · “${w.note}”` : ''}
                      </Typography>
                    </Box>
                    <Typography variant="body2" color="error.main" sx={{ whiteSpace: 'nowrap' }}>
                      − {fmt(w.cost_value)}
                    </Typography>
                  </Box>
                ))}
              </Box>
            )}
          </>
        )}

        {data && target && (
          <Box>
            <Alert severity="warning" sx={{ mb: 2 }}>
              Removing stock from batch <b>{target.batch_number}</b> (expires {fmtDate(target.expiry_date)}).
              This cannot be undone, but it is recorded in the write-off history.
            </Alert>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2 }}>
              <TextField
                label="Quantity to remove" type="number" value={qty} autoFocus
                inputProps={{ min: 1, max: target.quantity }}
                helperText={`Batch has ${target.quantity} units`}
                onChange={(e) => setQty(e.target.value)}
              />
              <TextField select label="Reason" value={reason} onChange={(e) => setReason(e.target.value)}>
                {REASONS.map((r) => <MenuItem key={r.value} value={r.value}>{r.label}</MenuItem>)}
              </TextField>
            </Box>
            <TextField
              label="Note (optional)" fullWidth sx={{ mt: 2 }} value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. destroyed as per disposal rules"
            />
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 2 }}>
              <Typography color="text.secondary">Stock loss</Typography>
              <Typography sx={{ fontWeight: 700 }} color="error.main">
                {fmt((Number(qty) || 0) * med.buy_price)}
              </Typography>
            </Box>
          </Box>
        )}
      </DialogContent>

      <DialogActions sx={{ px: 2.5, py: 2 }}>
        {target ? (
          <>
            <Button onClick={() => setTarget(null)} disabled={busy}>Back</Button>
            <Box sx={{ flexGrow: 1 }} />
            <Button variant="contained" color="error" onClick={submit}
              disabled={busy || !(Number(qty) > 0 && Number(qty) <= target.quantity)}>
              {busy ? 'Removing…' : 'Remove from stock'}
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>Close</Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
