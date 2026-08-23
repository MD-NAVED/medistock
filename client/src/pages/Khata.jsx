import { useEffect, useState } from 'react';
import {
  Box, Typography, Paper, TextField, Button, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, IconButton, Chip, Dialog, DialogTitle,
  DialogContent, DialogActions, MenuItem, Snackbar, Alert, InputAdornment,
} from '@mui/material';
import PersonAddAlt1Icon from '@mui/icons-material/PersonAddAlt1';
import HistoryIcon from '@mui/icons-material/History';
import PostAddIcon from '@mui/icons-material/PostAdd';
import MenuBookIcon from '@mui/icons-material/MenuBook';
import { api } from '../api';
import { fmt, fmtDate, fmtDateTime } from '../utils';

const KINDS = [
  { value: 'credit', label: 'Udhaar Diya (credit)' },
  { value: 'payment', label: 'Payment Aaya' },
  { value: 'discount', label: 'Maaf Kiya (discount)' },
];

const kindChip = (kind) => {
  if (kind === 'credit') return <Chip size="small" color="error" variant="outlined" label="Udhaar" />;
  if (kind === 'payment') return <Chip size="small" color="success" variant="outlined" label="Payment" />;
  return <Chip size="small" color="info" variant="outlined" label="Maaf" />;
};

export default function Khata() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [snack, setSnack] = useState(null);

  // New-customer dialog
  const [newCust, setNewCust] = useState(null); // { name, phone }
  // Customer history dialog
  const [detail, setDetail] = useState(null); // loaded customer object
  // Add-entry dialog: { customer_id, kind, amount, note } — customer_id null = ask name
  const [entry, setEntry] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => api('/api/khata').then(setRows).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const openDetail = (id) => {
    api('/api/khata/customers/' + id).then(setDetail).catch((e) => setSnack({ severity: 'error', message: e.message }));
  };

  const saveCustomer = async () => {
    setBusy(true);
    try {
      await api('/api/khata/customers', { method: 'POST', body: { name: newCust.name, phone: newCust.phone || '' } });
      setNewCust(null);
      setSnack({ severity: 'success', message: 'Customer khata me add ho gaya' });
      load();
    } catch (e) {
      setSnack({ severity: 'error', message: e.message });
    } finally { setBusy(false); }
  };

  const saveEntry = async () => {
    setBusy(true);
    try {
      await api('/api/khata/entries', {
        method: 'POST',
        body: {
          customer_id: entry.customerId || undefined,
          customer_name: entry.customerId ? undefined : entry.customerName,
          kind: entry.kind, amount: Number(entry.amount), note: entry.note || '',
        },
      });
      setEntry(null);
      setSnack({ severity: 'success', message: 'Khata entry save ho gayi' });
      load();
      if (detail) openDetail(detail.id);
    } catch (e) {
      setSnack({ severity: 'error', message: e.message });
    } finally { setBusy(false); }
  };

  if (error) return <Alert severity="error">{error}</Alert>;
  if (!rows) return <Typography color="text.secondary" sx={{ py: 6, textAlign: 'center' }}>Loading khata…</Typography>;

  const totalDue = rows.reduce((s, r) => s + Math.max(0, r.balance), 0);
  const dueCount = rows.filter((r) => r.balance > 0.004).length;

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1.5, mb: 3 }}>
        <Typography variant="h5">Khata — Udhaar Book</Typography>
        <Button variant="contained" startIcon={<PersonAddAlt1Icon />} onClick={() => setNewCust({ name: '', phone: '' })}>
          Naya Customer
        </Button>
      </Box>

      <Paper sx={{ p: 2, mb: 3, display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
        <MenuBookIcon color="primary" />
        <Typography sx={{ fontWeight: 700 }}>
          Kul Baiki (total pending): <Box component="span" color={totalDue > 0 ? 'error.main' : 'success.main'}>{fmt(totalDue)}</Box>
        </Typography>
        <Chip size="small" label={`${rows.length} customer`} variant="outlined" />
        {dueCount > 0 && <Chip size="small" color="error" variant="outlined" label={`${dueCount} se baaki hai`} />}
      </Paper>

      <TableContainer component={Paper}>
        <Table size="small">
          <TableHead>
            <TableRow sx={{ bgcolor: '#f6f9f8' }}>
              <TableCell>Customer</TableCell>
              <TableCell align="right">Baiki (pending)</TableCell>
              <TableCell align="right" sx={{ display: { xs: 'none', sm: 'table-cell' } }}>Total Udhaar</TableCell>
              <TableCell align="right" sx={{ display: { xs: 'none', sm: 'table-cell' } }}>Entries</TableCell>
              <TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>Last Entry</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={6}>
                  <Typography color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>
                    Khata khaali hai — billing pe "Udhaar" tick karke ya "Naya Customer" se shuru karo 📖
                  </Typography>
                </TableCell>
              </TableRow>
            )}
            {rows.map((r) => (
              <TableRow key={r.id} hover>
                <TableCell>
                  <Typography sx={{ fontSize: 14, fontWeight: 600 }}>{r.name}</Typography>
                  {r.phone && <Typography variant="caption" color="text.secondary">{r.phone}</Typography>}
                </TableCell>
                <TableCell align="right">
                  <Typography sx={{ fontWeight: 800, color: r.balance > 0.004 ? 'error.main' : 'success.main' }}>
                    {fmt(r.balance)}
                  </Typography>
                </TableCell>
                <TableCell align="right" sx={{ display: { xs: 'none', sm: 'table-cell' } }}>{fmt(r.total_credit)}</TableCell>
                <TableCell align="right" sx={{ display: { xs: 'none', sm: 'table-cell' } }}>{r.entries}</TableCell>
                <TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>{r.last_entry ? fmtDateTime(r.last_entry) : '—'}</TableCell>
                <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                  <IconButton size="small" color="primary" onClick={() => openDetail(r.id)} aria-label={'History ' + r.name}>
                    <HistoryIcon fontSize="small" />
                  </IconButton>
                  <IconButton size="small" color="success" onClick={() => setEntry({ customerId: r.id, name: r.name, kind: 'payment', amount: '', note: '' })} aria-label={'Add entry ' + r.name}>
                    <PostAddIcon fontSize="small" />
                  </IconButton>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      {/* New customer dialog */}
      <Dialog open={!!newCust} onClose={() => setNewCust(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Naya Customer (Khata)</DialogTitle>
        <DialogContent sx={{ pt: '16px !important' }}>
          <TextField autoFocus fullWidth label="Customer ka naam" value={newCust?.name || ''}
            onChange={(e) => setNewCust({ ...newCust, name: e.target.value })} sx={{ mb: 2 }} />
          <TextField fullWidth label="Phone (optional)" value={newCust?.phone || ''}
            onChange={(e) => setNewCust({ ...newCust, phone: e.target.value })} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setNewCust(null)}>Cancel</Button>
          <Button variant="contained" disabled={!newCust?.name?.trim() || busy} onClick={saveCustomer}>Save</Button>
        </DialogActions>
      </Dialog>

      {/* Customer history dialog */}
      <Dialog open={!!detail} onClose={() => setDetail(null)} maxWidth="sm" fullWidth>
        {detail && (
          <>
            <DialogTitle sx={{ pb: 0 }}>
              {detail.name}
              {detail.phone && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{detail.phone}</Typography>}
            </DialogTitle>
            <DialogContent>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, my: 1.5, flexWrap: 'wrap' }}>
                <Typography variant="h5" sx={{ fontWeight: 800, color: detail.balance > 0.004 ? 'error.main' : 'success.main' }}>
                  {fmt(detail.balance)}
                </Typography>
                <Typography variant="caption" color="text.secondary">baiki (pending)</Typography>
                <Box sx={{ flexGrow: 1 }} />
                <Button size="small" variant="outlined" color="success"
                  onClick={() => setEntry({ customerId: detail.id, name: detail.name, kind: 'payment', amount: Math.max(0, detail.balance).toFixed(2), note: '' })}>
                  Payment Aaya
                </Button>
                <Button size="small" variant="outlined" color="error"
                  onClick={() => setEntry({ customerId: detail.id, name: detail.name, kind: 'credit', amount: '', note: '' })}>
                  Udhaar Diya
                </Button>
              </Box>

              <TableContainer sx={{ mt: 1 }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Date</TableCell>
                      <TableCell>Type</TableCell>
                      <TableCell align="right">Amount</TableCell>
                      <TableCell>Note</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {detail.entries.length === 0 && (
                      <TableRow><TableCell colSpan={4}><Typography color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>Koi entry nahi hai</Typography></TableCell></TableRow>
                    )}
                    {detail.entries.map((e) => (
                      <TableRow key={e.id}>
                        <TableCell>{fmtDateTime(e.created_at)}</TableCell>
                        <TableCell>{kindChip(e.kind)}</TableCell>
                        <TableCell align="right" sx={{ fontWeight: 700, color: e.kind === 'credit' ? 'error.main' : 'success.main' }}>
                          {e.kind === 'credit' ? '+' : '−'}{fmt(e.amount).replace('₹', '₹')}
                        </TableCell>
                        <TableCell>
                          {e.note && <Typography variant="body2">{e.note}</Typography>}
                          {e.invoice_number && <Typography variant="caption" color="primary.main">Bill {e.invoice_number}</Typography>}
                          {e.by_name && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>by {e.by_name}</Typography>}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setDetail(null)}>Close</Button>
            </DialogActions>
          </>
        )}
      </Dialog>

      {/* Add-entry dialog */}
      <Dialog open={!!entry} onClose={() => setEntry(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Khata Entry — {entry?.name || 'Naya Customer'}</DialogTitle>
        <DialogContent sx={{ pt: '16px !important' }}>
          {!entry?.customerId && (
            <TextField autoFocus fullWidth label="Customer ka naam" value={entry?.customerName || ''}
              onChange={(e) => setEntry({ ...entry, customerName: e.target.value })} sx={{ mb: 2 }}
              helperText="Same naam wala customer milega, warna naya ban jayega" />
          )}
          <TextField select fullWidth label="Type" value={entry?.kind || 'credit'}
            onChange={(e) => setEntry({ ...entry, kind: e.target.value })} sx={{ mb: 2 }}>
            {KINDS.map((k) => <MenuItem key={k.value} value={k.value}>{k.label}</MenuItem>)}
          </TextField>
          <TextField fullWidth type="number" label="Amount (₹)" value={entry?.amount ?? ''}
            onChange={(e) => setEntry({ ...entry, amount: e.target.value })}
            inputProps={{ min: 0, step: '0.01' }}
            InputProps={{ startAdornment: <InputAdornment position="start">₹</InputAdornment> }}
            sx={{ mb: 2 }} />
          <TextField fullWidth label="Note (optional)" value={entry?.note || ''}
            onChange={(e) => setEntry({ ...entry, note: e.target.value })} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEntry(null)}>Cancel</Button>
          <Button variant="contained" disabled={busy || !(Number(entry?.amount) > 0) || (!entry?.customerId && !entry?.customerName?.trim())} onClick={saveEntry}>
            Save Entry
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={!!snack} autoHideDuration={4500} onClose={() => setSnack(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        {snack && <Alert severity={snack.severity} onClose={() => setSnack(null)} sx={{ width: '100%' }}>{snack.message}</Alert>}
      </Snackbar>
    </Box>
  );
}
