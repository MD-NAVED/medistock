import { useEffect, useRef, useState } from 'react';
import {
  Box, Typography, Paper, Button, Chip, Alert, Snackbar, CircularProgress,
  Divider, Stack, Radio, RadioGroup, FormControlLabel, FormControl,
} from '@mui/material';
import WorkspacePremiumIcon from '@mui/icons-material/WorkspacePremium';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import BoltIcon from '@mui/icons-material/Bolt';
import { api } from '../api';
import { fmtDate } from '../utils';

/**
 * In-app subscription renewal — the pharmacy owner pays through Razorpay's
 * trusted checkout (UPI / cards / netbanking) instead of a personal UPI ID,
 * so there is never a "yeh scammer to nahi?" doubt. Payment success activates
 * the subscription instantly (server verifies the signature).
 */

export default function Subscription() {
  const [plans, setPlans] = useState([]);
  const [gateway, setGateway] = useState('not_configured');
  const [selected, setSelected] = useState('yearly');
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);
  const [snack, setSnack] = useState(null);
  const scriptLoaded = useRef(false);

  const loadPlans = () => {
    api('/api/billing/plans')
      .then((r) => {
        setPlans(r.plans || []);
        setGateway(r.gateway || 'not_configured');
        setLoading(false);
      })
      .catch((e) => {
        setSnack({ severity: 'error', message: e.message });
        setLoading(false);
      });
  };

  useEffect(() => {
    loadPlans();
    if (window.Razorpay) { scriptLoaded.current = true; return; }
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => { scriptLoaded.current = true; };
    document.body.appendChild(s);
  }, []);

  const payNow = async () => {
    setPaying(true);
    try {
      if (gateway !== 'razorpay' || !scriptLoaded.current) {
        setSnack({
          severity: 'warning',
          message: 'Online payment abhi activate nahi hui. Thodi der baad try karein ya support se sampark karein.',
        });
        return;
      }
      const order = await api('/api/billing/create-order', { method: 'POST', body: { plan: selected } });

      const rzp = new window.Razorpay({
        key: order.key_id,
        amount: order.amount,
        currency: order.currency,
        name: 'MediStock',
        description: `Subscription — ${order.store_name}`,
        order_id: order.order_id,
        prefill: { name: order.store_name },
        theme: { color: '#0b695c' },
        handler: async (resp) => {
          try {
            await api('/api/billing/verify', { method: 'POST', body: resp });
            setSnack({
              severity: 'success',
              message: `Payment successful! Aapki subscription ${order.months} mahine ke liye activate ho gayi hai. 🎉`,
            });
            loadPlans();
          } catch (e) {
            setSnack({ severity: 'error', message: 'Payment verify nahi hui: ' + e.message });
          }
        },
        modal: { ondismiss: () => setPaying(false) },
      });
      rzp.open();
    } catch (e) {
      setSnack({ severity: 'error', message: e.message });
    } finally {
      setPaying(false);
    }
  };

  if (loading) {
    return <Box sx={{ display: 'grid', placeItems: 'center', py: 10 }}><CircularProgress /></Box>;
  }

  return (
    <Box sx={{ maxWidth: 760, mx: 'auto' }}>
      <Paper sx={{ p: { xs: 2.5, md: 4 }, textAlign: 'center', mb: 3, background: 'linear-gradient(135deg,#0b695c 0%,#0d8a75 100%)', color: '#fff' }}>
        <WorkspacePremiumIcon sx={{ fontSize: 48, mb: 1 }} />
        <Typography variant="h5" sx={{ fontWeight: 700 }}>
          MediStock Subscription Renew
        </Typography>
        <Typography sx={{ mt: 0.5, opacity: 0.9, fontSize: 14 }}>
          Secure payment by Razorpay — UPI, Debit/Credit Card, NetBanking sab chalega.
        </Typography>
      </Paper>

      {gateway !== 'razorpay' && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Online payment gateway is being set up. You will be able to pay in-app very soon.
        </Alert>
      )}

      <FormControl component="div" fullWidth>
        <RadioGroup value={selected} onChange={(e) => setSelected(e.target.value)}>
          <Stack spacing={2}>
            {plans.map((p) => (
              <Paper
                key={p.id}
                onClick={() => setSelected(p.id)}
                sx={{
                  p: 2.5, cursor: 'pointer',
                  border: selected === p.id ? '2px solid #0b695c' : '1px solid #e0e6e4',
                  display: 'flex', alignItems: 'center', gap: 2,
                }}
              >
                <Radio checked={selected === p.id} />
                <Box sx={{ flexGrow: 1 }}>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Typography sx={{ fontWeight: 700 }}>{p.label}</Typography>
                    {p.id === 'yearly' && <Chip size="small" color="success" icon={<BoltIcon />} label="Best Value" />}
                  </Stack>
                  <Typography variant="caption" color="text.secondary">
                    {p.tagline} • ₹{p.price_per_month}/month equivalent
                  </Typography>
                </Box>
                <Box sx={{ textAlign: 'right' }}>
                  <Typography sx={{ fontWeight: 800, fontSize: 20 }}>
                    ₹{(p.amount / 100).toLocaleString('en-IN')}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {p.months} month{p.months > 1 ? 's' : ''}
                  </Typography>
                </Box>
              </Paper>
            ))}
          </Stack>
        </RadioGroup>
      </FormControl>

      <Button
        fullWidth size="large" variant="contained" onClick={payNow}
        disabled={paying || gateway !== 'razorpay'}
        sx={{ mt: 3, py: 1.6, fontWeight: 700, fontSize: 16 }}
      >
        {paying ? 'Opening secure checkout…' : '🔒 Pay Securely with Razorpay'}
      </Button>

      <Divider sx={{ my: 3 }} />
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} justifyContent="center">
        {['PCI-DSS Secure Checkout', 'Auto activation on payment', 'Data stays in cloud backup'].map((t) => (
          <Chip key={t} size="small" icon={<CheckCircleIcon />} label={t} variant="outlined" />
        ))}
      </Stack>

      <Snackbar
        open={!!snack} autoHideDuration={6000} onClose={() => setSnack(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        {snack && <Alert severity={snack.severity} onClose={() => setSnack(null)} sx={{ width: '100%' }}>{snack.message}</Alert>}
      </Snackbar>
    </Box>
  );
}
