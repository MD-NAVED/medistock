import { useEffect, useMemo, useState } from 'react';
import {
  Box, Typography, Paper, TextField, Button, Autocomplete, Table, TableBody,
  TableCell, TableContainer, TableHead, TableRow, IconButton, Chip, Dialog,
  DialogTitle, DialogContent, DialogActions, Divider, Snackbar, Alert, InputAdornment,
  Checkbox, FormControlLabel, useMediaQuery,
} from '@mui/material';
import AddShoppingCartIcon from '@mui/icons-material/AddShoppingCart';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import PointOfSaleIcon from '@mui/icons-material/PointOfSale';
import WhatsAppIcon from '@mui/icons-material/WhatsApp';
import PrintIcon from '@mui/icons-material/Print';
import LocalPharmacyRoundedIcon from '@mui/icons-material/LocalPharmacyRounded';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { api } from '../api';
import { printInvoice } from '../printInvoice';
import { fmt, fmtDate } from '../utils';
import { buildWhatsAppLink } from '../utils/whatsapp';

const digitsOnly = (s) => String(s || '').replace(/\D/g, '');

import MedicineLogo from '../components/MedicineLogo';
import { useAuth } from '../auth';
import { tierAllows, userTier } from '../tiers';
import UpgradeDialog from '../components/UpgradeDialog';

export default function Billing() {
  const isMobile = useMediaQuery('(max-width:900px)');
  const [medicines, setMedicines] = useState([]);
  const [settings, setSettings] = useState(null);
  const [selected, setSelected] = useState(null);
  const [qty, setQty] = useState(1);
  const [cart, setCart] = useState([]);
  const [customer, setCustomer] = useState('');
  const [phone, setPhone] = useState('');
  const [udhaar, setUdhaar] = useState(false);
  const [udhaarAmt, setUdhaarAmt] = useState('');
  const [busy, setBusy] = useState(false);
  const [snack, setSnack] = useState(null);
  const [whatsappToast, setWhatsappToast] = useState(false);
  const [invoice, setInvoice] = useState(null); // {sale, items} after success
  const { user } = useAuth();
  const [upgrade, setUpgrade] = useState(null);
  const can = (f) => tierAllows(userTier(user), f);

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
        body: { customer_name: customer, customer_phone: phone, items: cart.map((c) => ({ medicine_id: c.id, quantity: c.qty })) },
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
      setPhone('');
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
    <Box sx={{ pb: { xs: cart.length > 0 ? 10 : 2, md: 0 } }}>
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
            /* Mobile: compact list rows with stepper — fast billing for 10+ items */
            <Box sx={{ mt: 2 }}>
              {cart.length === 0 && (
                <Typography color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>
                  Cart is empty — search a medicine above to start a bill 🧾
                </Typography>
              )}
              {cart.map((c) => (
                <Paper key={c.id} variant="outlined" sx={{ p: 1.2, mb: 1, bgcolor: '#fafbfb', borderRadius: 2 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, flexGrow: 1 }}>
                      <MedicineLogo src={c.logo_url} text={c.company || c.name} />
                      <Box sx={{ minWidth: 0 }}>
                        <Typography sx={{ fontSize: 13, fontWeight: 700, lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {c.name}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 11 }}>
                          {c.company} · {fmt(c.price)} {gstOn ? `(+${c.gst_rate}% GST)` : ''}
                        </Typography>
                      </Box>
                    </Box>
                    <Box sx={{ textAlign: 'right', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 0.5 }}>
                      <Typography sx={{ fontWeight: 800, fontSize: 14, color: 'text.primary' }}>
                        {fmt(c.qty * c.price * (gstOn ? 1 + c.gst_rate / 100 : 1))}
                      </Typography>
                      <IconButton size="small" color="error" onClick={() => setCart(cart.filter((x) => x.id !== c.id))} sx={{ p: 0.4 }}>
                        <DeleteIcon sx={{ fontSize: 18 }} />
                      </IconButton>
                    </Box>
                  </Box>

                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mt: 0.8, pt: 0.6, borderTop: '1px dashed #e4ebe9' }}>
                    <Typography variant="caption" color={c.stock <= 5 ? 'error.main' : 'text.secondary'} sx={{ fontSize: 11, fontWeight: c.stock <= 5 ? 600 : 400 }}>
                      In stock: {c.stock} {c.stock <= 5 ? '⚠️ Low' : ''}
                    </Typography>
                    <Box sx={{ display: 'inline-flex', alignItems: 'center', bgcolor: '#eef5f3', borderRadius: 1.5, border: '1px solid #d0e2dd' }}>
                      <IconButton
                        size="small"
                        disabled={c.qty <= 1}
                        onClick={() => setCart(cart.map((x) => (x.id === c.id ? { ...x, qty: Math.max(1, x.qty - 1) } : x)))}
                        sx={{ p: 0.3 }}
                      >
                        <RemoveIcon sx={{ fontSize: 14 }} />
                      </IconButton>
                      <TextField
                        variant="standard"
                        type="number"
                        value={c.qty}
                        onChange={(e) => {
                          const v = Math.max(1, Math.min(c.stock, Number(e.target.value) || 1));
                          setCart(cart.map((x) => (x.id === c.id ? { ...x, qty: v } : x)));
                        }}
                        inputProps={{ min: 1, max: c.stock, style: { textAlign: 'center', padding: '1px 0', fontSize: 12, fontWeight: 700, width: 28 } }}
                        InputProps={{ disableUnderline: true }}
                      />
                      <IconButton
                        size="small"
                        disabled={c.qty >= c.stock}
                        onClick={() => setCart(cart.map((x) => (x.id === c.id ? { ...x, qty: Math.min(c.stock, x.qty + 1) } : x)))}
                        sx={{ p: 0.3 }}
                      >
                        <AddIcon sx={{ fontSize: 14 }} />
                      </IconButton>
                    </Box>
                  </Box>
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
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
                          <MedicineLogo src={c.logo_url} text={c.company || c.name} />
                          <Box sx={{ minWidth: 0 }}>
                            <Typography sx={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</Typography>
                            <Typography variant="caption" color="text.secondary" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.company} · stock {c.stock}</Typography>
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
        <Paper id="bill-summary-card" sx={{ p: { xs: 2, md: 3 }, width: { xs: '100%', md: 330 }, position: { xs: 'static', md: 'sticky' }, top: 90 }}>
          <Typography variant="h6" sx={{ mb: 2 }}>Bill Summary</Typography>
          <TextField label="Customer name (optional)" size="small" fullWidth value={customer} onChange={(e) => setCustomer(e.target.value)} sx={{ mb: 1.5 }} />
          <TextField label="WhatsApp number (optional)" size="small" fullWidth value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/[^\d+ ]/g, ''))}
            placeholder="10-digit mobile — bill goes on WhatsApp"
            helperText="Send the bill on WhatsApp after checkout" />
          {can('khata') && (
            <FormControlLabel
              control={<Checkbox checked={udhaar} onChange={(e) => setUdhaar(e.target.checked)} size="small" />}
              label={<Typography variant="body2">Record on Credit (Khata)</Typography>}
              sx={{ mb: udhaar ? 1.5 : 2.5, display: 'flex' }}
            />
          )}
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

      {/* Mobile Sticky Quick-Checkout Floating Bar */}
      {isMobile && cart.length > 0 && (
        <Paper
          elevation={6}
          sx={{
            position: 'fixed',
            bottom: 0,
            left: 0,
            right: 0,
            p: 1.5,
            px: 2,
            zIndex: 1000,
            bgcolor: '#004d40',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderTop: '2px solid #00695c',
            boxShadow: '0 -4px 20px rgba(0,0,0,0.2)',
          }}
        >
          <Box sx={{ minWidth: 0, flexGrow: 1, pr: 1.5 }}>
            <Typography sx={{ fontSize: 11, opacity: 0.85 }}>
              {cart.reduce((s, c) => s + c.qty, 0)} items in bill
            </Typography>
            <Typography sx={{ fontWeight: 800, fontSize: 18, color: '#80cbc4', lineHeight: 1.1 }}>
              {fmt(totals.total)}
            </Typography>
          </Box>
          <Button
            variant="contained"
            onClick={() => {
              const el = document.getElementById('bill-summary-card');
              if (el) el.scrollIntoView({ behavior: 'smooth' });
            }}
            sx={{
              bgcolor: '#00897b',
              '&:hover': { bgcolor: '#00796b' },
              fontWeight: 800,
              fontSize: 14,
              px: 2.5,
              py: 1,
              borderRadius: 2,
              textTransform: 'none',
              boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
              whiteSpace: 'nowrap',
            }}
          >
            Checkout ➔
          </Button>
        </Paper>
      )}

      {/* Invoice success dialog */}
      <Dialog open={!!invoice} onClose={() => setInvoice(null)} maxWidth="xs" fullWidth>
        {invoice && (
          <Box sx={{ position: 'relative', overflow: 'hidden' }}>
            <Box
              sx={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                bgcolor: '#4caf50',
                pointerEvents: 'none',
                zIndex: 10,
                animation: 'greenFlash 300ms ease-out forwards',
              }}
            />
            <DialogTitle sx={{ textAlign: 'center', bgcolor: 'success.main', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1 }}>
              <CheckCircleIcon sx={{ animation: 'checkPop 300ms cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards', fontSize: 26 }} /> Sale Complete!
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
            <DialogActions sx={{ justifyContent: 'center', pb: 3, flexWrap: 'wrap', gap: 1 }}>
              <Button variant="outlined" onClick={() => setInvoice(null)}>New Sale</Button>
              <Button variant="contained" startIcon={<PrintIcon />} onClick={() => printInvoice(settings, invoice.sale, invoice.items)}>
                Print Bill
              </Button>
              {digitsOnly(invoice.sale.customer_phone).length >= 10 && (
                <Button
                  variant="contained" color="success"
                  startIcon={<WhatsAppIcon />}
                  onClick={() => {
                    if (!can('whatsapp_bill')) { setUpgrade({ feature: 'whatsapp_bill', requiredTier: 'pro' }); return; }
                    window.open(buildWhatsAppLink(invoice, settings?.store_name || 'MediStock Pharmacy'), '_blank', 'noopener');
                    setWhatsappToast(true);
                  }}
                >
                  Send on WhatsApp
                </Button>
              )}
            </DialogActions>
          </Box>
        )}
      </Dialog>

      {/* WhatsApp Bill Sent Toast */}
      <Snackbar
        open={whatsappToast}
        autoHideDuration={4000}
        onClose={() => setWhatsappToast(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        sx={{ animation: 'toastSlideUp 300ms ease-out' }}
      >
        <Alert
          onClose={() => setWhatsappToast(false)}
          severity="success"
          icon={
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: '#2e7d32' }}>
              <polyline points="20 6 9 17 4 12" className="checkmark-draw" />
            </svg>
          }
          sx={{ width: '100%', alignItems: 'center', boxShadow: '0 4px 14px rgba(0,0,0,0.15)' }}
        >
          WhatsApp bill link opened!
        </Alert>
      </Snackbar>

      <UpgradeDialog open={!!upgrade} onClose={() => setUpgrade(null)} feature={upgrade?.feature} requiredTier={upgrade?.requiredTier} />
      <Snackbar open={!!snack} autoHideDuration={4500} onClose={() => setSnack(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        {snack && <Alert severity={snack.severity} onClose={() => setSnack(null)} sx={{ width: '100%' }}>{snack.message}</Alert>}
      </Snackbar>
    </Box>
  );
}
