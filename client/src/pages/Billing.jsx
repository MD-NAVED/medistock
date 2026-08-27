import { useEffect, useMemo, useState } from 'react';
import {
  Box, Typography, Paper, TextField, Button, Autocomplete, Table, TableBody,
  TableCell, TableContainer, TableHead, TableRow, IconButton, Chip, Dialog,
  DialogTitle, DialogContent, DialogActions, Divider, Snackbar, Alert, InputAdornment,
  Checkbox, FormControlLabel, useMediaQuery,
} from '@mui/material';
import AddShoppingCartIcon from '@mui/icons-material/AddShoppingCart';
import DeleteIcon from '@mui/icons-material/Delete';
import PointOfSaleIcon from '@mui/icons-material/PointOfSale';
import PrintIcon from '@mui/icons-material/Print';
import LocalPharmacyRoundedIcon from '@mui/icons-material/LocalPharmacyRounded';
import { api } from '../api';
import { printInvoice } from '../printInvoice';
import { fmt, fmtDate } from '../utils';
import MedicineLogo from '../components/MedicineLogo';

export default function Billing() {
  const isMobile = useMediaQuery('(max-width:900px)');
  const [medicines, setMedicines] = useState([]);
  const [settings, setSettings] = useState(null);
  const [selected, setSelected] = useState(null);
  const [qty, setQty] = useState(1);
  const [cart, setCart] = useState([]);
  const [customer, setCustomer] = useState('');
  const [udhaar, setUdhaar] = useState(false);
  const [udhaarAmt, setUdhaarAmt] = useState('');
  const [busy, setBusy] = useState(false);
  const [snack, setSnack] = useState(null);
  const [invoice, setInvoice] = useState(null); // {sale, items} after success

  const loadMedicines = () => api('/api/medicines').then(setMedicines).catch(() => {});
  useEffect(() => {
    loadMedicines();
    api('/api/settings').then(setSettings).catch(() => {});
  }, []);

  const gstOn = !!settings?.gst_enabled;

  const totals = useMemo(() => {
    const subtotal = cart.reduce((s, c) => s + c.qty * c.price, 0);
    const gst = gstOn ? cart.reduce((s, c) => s + (c.qty * c.price * c.gst_rate) / 100, 0) : 0;
    return { subtotal, gst, total: subtotal + gst };
  }, [cart, gstOn]);

  // While udhaar is ticked, the pending amount tracks the bill total until
  // the counter staff edits it (part-payment: they type the lesser amount).
  useEffect(() => {
    if (udhaar) setUdhaarAmt(totals.total.toFixed(2));
  }, [udhaar, totals.total]);

  const addToCart = () => {
    if (!selected) return;
    const existing = cart.find((c) => c.id === selected.id);
    const alreadyIn = existing ? existing.qty : 0;
    if (alreadyIn + Number(qty) > selected.stock) {
      setSnack({ severity: 'warning', message: `Only ${selected.stock} units of ${selected.name} in stock (batch-wise, soonest expiry first)` });
      return;
    }
    if (existing) {
      setCart(cart.map((c) => (c.id === selected.id ? { ...c, qty: c.qty + Number(qty) } : c)));
    } else {
      setCart([...cart, { id: selected.id, name: selected.name, company: selected.company, price: selected.sell_price, gst_rate: selected.gst_rate, stock: selected.stock, qty: Number(qty), logo_url: selected.logo_url }]);
    }
    setSelected(null);
    setQty(1);
  };

  const completeSale = async () => {
    if (udhaar && !(Number(udhaarAmt) > 0)) {
      setSnack({ severity: 'warning', message: 'Please enter a valid credit amount (> 0)' });
      return;
    }
    if (udhaar && !customer.trim()) {
      setSnack({ severity: 'warning', message: 'Please enter customer name for credit sale' });
      return;
    }
    setBusy(true);
    try {
      const data = await api('/api/sales', {
        method: 'POST',
        body: { customer_name: customer, items: cart.map((c) => ({ medicine_id: c.id, quantity: c.qty })) },
      });
      // Bill is already saved — a failed khata entry must never lose the sale,
      // so it is reported as a warning instead of throwing.
      if (udhaar) {
        try {
          await api('/api/khata/entries', {
            method: 'POST',
            body: {
              customer_name: customer.trim(),
              kind: 'credit',
              amount: Number(udhaarAmt),
              note: 'Bill ' + data.sale.invoice_number,
              sale_id: data.sale.id,
            },
          });
          setSnack({ severity: 'success', message: `${fmt(Number(udhaarAmt))} recorded on credit for ${customer.trim()}` });
        } catch (err) {
          setSnack({ severity: 'warning', message: 'Sale completed, but ledger entry failed: ' + err.message });
        }
      }
      setInvoice(data);
      setCart([]);
      setCustomer('');
      setUdhaar(false);
      setUdhaarAmt('');
      loadMedicines();
    } catch (e) {
      setSnack({ severity: 'error', message: e.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: { xs: 2, md: 3 }, fontSize: { xs: 20, md: 24 } }}>
        Billing — New Sale
      </Typography>

      <Box sx={{ display: 'flex', gap: { xs: 2, md: 3 }, flexDirection: { xs: 'column', md: 'row' }, alignItems: 'flex-start' }}>
        {/* LEFT: search + cart */}
        <Paper sx={{ p: { xs: 2, md: 3 }, flexGrow: 1, width: '100%' }}>
          <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
            <Autocomplete
              sx={{ flexGrow: 1, width: { xs: '100%', sm: 'auto' }, minWidth: { xs: 0, sm: 260 } }}
              options={medicines}
              value={selected}
              onChange={(e, v) => setSelected(v)}
              getOptionLabel={(o) => `${o.name} — ${o.company}`}
              renderOption={(props, o) => {
                const { key, ...rest } = props;
                return (
                  <li key={key} {...rest}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexGrow: 1 }}>
                      <MedicineLogo src={o.logo_url} text={o.company || o.name} />
                      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                        <Typography sx={{ fontSize: 14 }}>{o.name} <Typography component="span" variant="caption" color="text.secondary">— {o.company}</Typography></Typography>
                        <Typography variant="caption" color={o.stock <= 0 ? 'error.main' : 'text.secondary'}>
                          {fmt(o.sell_price)} · Stock: {o.stock} {o.stock <= 0 ? '(OUT OF STOCK)' : ''}
                        </Typography>
                      </Box>
                    </Box>
                  </li>
                );
              }}
              renderInput={(params) => <TextField {...params} label="Search medicine (name or company)" autoFocus size="small" />}
            />
            <TextField
              size="small" type="number" label="Qty" value={qty}
              inputProps={{ min: 1 }}
              onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
              sx={{ width: 90 }}
            />
            <Button
              variant="contained" startIcon={<AddShoppingCartIcon />} onClick={addToCart}
              disabled={!selected || selected.stock <= 0}
              sx={{ flexGrow: { xs: 1, sm: 0 } }}
            >
              Add
            </Button>
          </Box>

          {isMobile ? (
            /* Mobile: cart items as stacked cards — no sideways scrolling */
            <Box sx={{ mt: 2 }}>
              {cart.length === 0 && (
                <Typography color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>
                  Cart is empty — search a medicine above to start a bill 🧾
                </Typography>
              )}
              {cart.map((c) => (
                <Paper key={c.id} variant="outlined" sx={{ p: 1.8, mb: 1.5, bgcolor: '#fafbfb' }}>
                  <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
                    <MedicineLogo src={c.logo_url} text={c.company || c.name} />
                    <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                      <Typography sx={{ fontSize: 14, fontWeight: 700, lineHeight: 1.3 }}>{c.name}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {c.company} · {fmt(c.price)} each{gstOn ? ` · GST ${c.gst_rate}%` : ''}
                      </Typography>
                    </Box>
                    <IconButton size="small" color="error" onClick={() => setCart(cart.filter((x) => x.id !== c.id))} aria-label={'Remove ' + c.name}>
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Box>
                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mt: 1.5 }}>
                    <TextField
                      size="small" type="number" label="Qty" value={c.qty}
                      inputProps={{ min: 1, max: c.stock }}
                      onChange={(e) => {
                        const v = Math.max(1, Math.min(c.stock, Number(e.target.value) || 1));
                        setCart(cart.map((x) => (x.id === c.id ? { ...x, qty: v } : x)));
                      }}
                      sx={{ width: 96 }}
                    />
                    <Box sx={{ textAlign: 'right' }}>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>Line total</Typography>
                      <Typography sx={{ fontWeight: 800, fontSize: 16 }}>
                        {fmt(c.qty * c.price * (gstOn ? 1 + c.gst_rate / 100 : 1))}
                      </Typography>
                    </Box>
                  </Box>
                  <Typography variant="caption" color="text.secondary">in stock: {c.stock}</Typography>
                </Paper>
              ))}
            </Box>
          ) : (
            <TableContainer sx={{ mt: 2 }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Medicine</TableCell>
                    <TableCell align="center">Qty</TableCell>
                    <TableCell align="right">Price</TableCell>
                    {gstOn && <TableCell align="right">GST</TableCell>}
                    <TableCell align="right">Total</TableCell>
                    <TableCell />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {cart.length === 0 && (
                    <TableRow><TableCell colSpan={6}><Typography color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>Cart is empty — search a medicine above to start a bill 🧾</Typography></TableCell></TableRow>
                  )}
                  {cart.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <MedicineLogo src={c.logo_url} text={c.company || c.name} />
                          <Box>
                            <Typography sx={{ fontSize: 14, fontWeight: 600 }}>{c.name}</Typography>
                            <Typography variant="caption" color="text.secondary">{c.company} · stock {c.stock}</Typography>
                          </Box>
                        </Box>
                      </TableCell>
                      <TableCell align="center">
                        <TextField size="small" type="number" value={c.qty} inputProps={{ min: 1, max: c.stock }}
                          onChange={(e) => {
                            const v = Math.max(1, Math.min(c.stock, Number(e.target.value) || 1));
                            setCart(cart.map((x) => (x.id === c.id ? { ...x, qty: v } : x)));
                          }}
                          sx={{ width: 76 }} />
                      </TableCell>
                      <TableCell align="right">{fmt(c.price)}</TableCell>
                      {gstOn && <TableCell align="right">{c.gst_rate}%</TableCell>}
                      <TableCell align="right" sx={{ fontWeight: 700 }}>{fmt(c.qty * c.price * (gstOn ? 1 + c.gst_rate / 100 : 1))}</TableCell>
                      <TableCell padding="checkbox">
                        <IconButton size="small" color="error" onClick={() => setCart(cart.filter((x) => x.id !== c.id))}><DeleteIcon fontSize="small" /></IconButton>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Paper>

        {/* RIGHT: summary */}
        <Paper sx={{ p: { xs: 2, md: 3 }, width: { xs: '100%', md: 330 }, position: { xs: 'static', md: 'sticky' }, top: 90 }}>
          <Typography variant="h6" sx={{ mb: 2 }}>Bill Summary</Typography>
          <TextField label="Customer name (optional)" size="small" fullWidth value={customer} onChange={(e) => setCustomer(e.target.value)} sx={{ mb: 1.5 }} />
          <FormControlLabel
            control={<Checkbox checked={udhaar} onChange={(e) => setUdhaar(e.target.checked)} size="small" />}
            label={<Typography variant="body2">Record on Credit (Khata)</Typography>}
            sx={{ mb: udhaar ? 1.5 : 2.5, display: 'flex' }}
          />
          {udhaar && (
            <TextField
              size="small" fullWidth type="number" label="Credit Amount" value={udhaarAmt}
              onChange={(e) => setUdhaarAmt(e.target.value)}
              inputProps={{ min: 1, step: '0.01', max: Math.ceil(totals.total) }}
              InputProps={{ startAdornment: <InputAdornment position="start">₹</InputAdornment> }}
              helperText="Full or partial credit — recorded to customer ledger"
              sx={{ mb: 2.5 }}
            />
          )}
          <Box sx={{ display: 'flex', justifyContent: 'space-between', py: 0.7 }}>
            <Typography color="text.secondary">Items</Typography>
            <Typography>{cart.reduce((s, c) => s + c.qty, 0)}</Typography>
          </Box>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', py: 0.7 }}>
            <Typography color="text.secondary">Subtotal</Typography>
            <Typography>{fmt(totals.subtotal)}</Typography>
          </Box>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', py: 0.7 }}>
            <Typography color="text.secondary">GST {gstOn ? '' : '(off)'}</Typography>
            <Typography>{fmt(totals.gst)}</Typography>
          </Box>
          <Divider sx={{ my: 1.5 }} />
          <Box sx={{ display: 'flex', justifyContent: 'space-between', py: 0.7 }}>
            <Typography variant="h6">TOTAL</Typography>
            <Typography variant="h5" color="primary.main" sx={{ fontWeight: 800 }}>{fmt(totals.total)}</Typography>
          </Box>
          <Button
            variant="contained" size="large" fullWidth startIcon={<PointOfSaleIcon />}
            disabled={!cart.length || busy} onClick={completeSale} sx={{ mt: 2, py: 1.3 }}
          >
            {busy ? 'Saving…' : 'Complete Sale & Print'}
          </Button>
          <Chip size="small" color="info" variant="outlined" label="FEFO: soonest-expiry batch sold first" sx={{ mt: 2 }} />
        </Paper>
      </Box>

      {/* Invoice success dialog */}
      <Dialog open={!!invoice} onClose={() => setInvoice(null)} maxWidth="xs" fullWidth>
        {invoice && (
          <>
            <DialogTitle sx={{ textAlign: 'center', bgcolor: 'success.main', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1 }}>
              <LocalPharmacyRoundedIcon /> Sale Complete!
            </DialogTitle>
            <DialogContent sx={{ textAlign: 'center', py: 3 }}>
              <Typography variant="body2" color="text.secondary">Invoice</Typography>
              <Typography variant="h6" sx={{ fontWeight: 800 }}>{invoice.sale.invoice_number}</Typography>
              <Typography sx={{ mt: 1 }}>{invoice.items.length} item line(s) · {invoice.items.reduce((s, i) => s + i.quantity, 0)} units</Typography>
              <Typography variant="h4" color="success.main" sx={{ fontWeight: 800, my: 1.5 }}>{fmt(invoice.sale.total)}</Typography>
              <Typography variant="caption" color="text.secondary">
                Stock has been automatically reduced (FEFO — soonest expiry first).<br />
                Latest expiry sold: {fmtDate(invoice.items.map((i) => i.expiry_date).sort()[0])}
              </Typography>
            </DialogContent>
            <DialogActions sx={{ justifyContent: 'center', pb: 3 }}>
              <Button variant="outlined" onClick={() => setInvoice(null)}>New Sale</Button>
              <Button variant="contained" startIcon={<PrintIcon />} onClick={() => printInvoice(settings, invoice.sale, invoice.items)}>
                Print Bill
              </Button>
            </DialogActions>
          </>
        )}
      </Dialog>

      <Snackbar open={!!snack} autoHideDuration={4500} onClose={() => setSnack(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        {snack && <Alert severity={snack.severity} onClose={() => setSnack(null)} sx={{ width: '100%' }}>{snack.message}</Alert>}
      </Snackbar>
    </Box>
  );
}
