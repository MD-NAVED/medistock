import { useEffect, useRef, useState } from 'react';
import {
  Box, Typography, Paper, Button, Chip, Alert, Snackbar, CircularProgress,
  Divider, Stack, Grid, ToggleButtonGroup, ToggleButton, useMediaQuery, Collapse,
} from '@mui/material';
import WorkspacePremiumIcon from '@mui/icons-material/WorkspacePremium';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import BoltIcon from '@mui/icons-material/Bolt';
import RocketLaunchIcon from '@mui/icons-material/RocketLaunch';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { api } from '../api';
import { useAuth } from '../auth';
import TrialBanner from '../components/TrialBanner';

/**
 * In-app subscription renewal with the 3-tier pricing ladder
 * (Starter / Pro / Elite × monthly / yearly, plus the 3-year Founder Pack).
 * The pharmacy owner pays through Razorpay's trusted checkout (UPI / cards /
 * netbanking) — never a personal UPI ID — and the store unlocks the moment
 * the server verifies the signature.
 */

const TIER_INFO = {
  starter: { name: 'Starter', blurb: 'Everything you need to run the counter.' },
  pro: { name: 'Pro', blurb: 'Save time — Khata, WhatsApp bills, full reports.' },
  elite: { name: 'Elite', blurb: 'Full power — scanner + daily WhatsApp summary.' },
};

const FEATURE_ROWS = [
  { label: 'Billing & GST invoices', tiers: ['starter', 'pro', 'elite'] },
  { label: 'Medicines, stock & expiry alerts', tiers: ['starter', 'pro', 'elite'] },
  { label: 'Purchases & dashboard', tiers: ['starter', 'pro', 'elite'] },
  { label: 'Up to 3 staff accounts', tiers: ['starter', 'pro', 'elite'] },
  { label: 'Up to 5 staff accounts', tiers: ['pro', 'elite'] },
  { label: 'Khata (Udhaar Book)', tiers: ['pro', 'elite'] },
  { label: 'WhatsApp bill sending', tiers: ['pro', 'elite'] },
  { label: 'Excel/CSV data import', tiers: ['pro', 'elite'] },
  { label: 'Full sales & purchase reports', tiers: ['pro', 'elite'] },
  { label: 'AI Invoice Scanner (Beta)', tiers: ['elite'] },
  { label: 'WhatsApp daily business summary', tiers: ['elite'] },
];

const inr = (paise) => '₹' + (paise / 100).toLocaleString('en-IN');

const TIER_ORDER = ['starter', 'pro', 'elite'];
// Features a tier ADDS on top of the one below. Elite shows ALL features
// so the flagship card is fully packed with every feature listed.
const addedFeatures = (tier) => {
  if (tier === 'elite') {
    return [
      { label: 'AI Invoice Scanner (Beta)' },
      { label: 'WhatsApp daily business summary' },
      { label: 'Khata (Credit / Udhaar book)' },
      { label: 'WhatsApp bill sending' },
      { label: 'Full sales & profit reports' },
      { label: 'Excel & CSV data import' },
      { label: 'Unlimited staff accounts' },
      { label: 'Billing & GST invoices' },
      { label: 'Medicines, stock & expiry alerts' },
      { label: 'Purchases & real-time dashboard' },
    ];
  }
  const idx = TIER_ORDER.indexOf(tier);
  const inherited = idx > 0
    ? new Set(FEATURE_ROWS.filter((r) => r.tiers.includes(TIER_ORDER[idx - 1])).map((r) => r.label))
    : new Set();
  return FEATURE_ROWS.filter((r) => r.tiers.includes(tier) && !inherited.has(r.label));
};
const INHERITS_LINE = {
  pro: 'Everything in Starter, plus:',
  elite: '⭐ Complete All-in-One Package — All Features Unlocked:',
};

export default function Subscription() {
  const locked = new URLSearchParams(window.location.search).get('locked') === '1';
  const { user } = useAuth();
  const isNarrow = useMediaQuery('(max-width:600px)');
  const [plans, setPlans] = useState([]);
  const [gateway, setGateway] = useState('not_configured');
  const [selectedPlan, setSelectedPlan] = useState('pro-yearly');
  const [expanded, setExpanded] = useState({ starter: true, pro: true, elite: true });
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

  const planFor = (tier, months) => plans.find((p) => p.tier === tier && p.months === months);
  const founderPack = plans.find((p) => p.id === 'elite-3yr');
  const selected = plans.find((p) => p.id === selectedPlan);

  const setTierCycle = (tier, months) => {
    const p = planFor(tier, months);
    if (p) setSelectedPlan(p.id);
  };
  const currentTier = ['starter', 'pro', 'elite'].includes(user?.tier) ? user.tier : 'starter';

  const payNow = async () => {
    setPaying(true);
    try {
      if (gateway !== 'razorpay' || !scriptLoaded.current) {
        setSnack({
          severity: 'warning',
          message: 'Online payment is not active yet. Please try again in a few minutes or contact support.',
        });
        return;
      }
      const order = await api('/api/billing/create-order', { method: 'POST', body: { plan: selectedPlan } });

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
              message: `Payment successful! Your subscription is now active for ${order.months} month(s). 🎉`,
            });
            loadPlans();
          } catch (e) {
            setSnack({ severity: 'error', message: 'Payment verification failed: ' + e.message });
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
    <Box sx={{ maxWidth: 980, mx: 'auto' }}>
      <TrialBanner showUpgradeButton={false} />
      {locked && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Your trial or subscription has ended — your store is locked.
          Choose a plan below and pay; the store unlocks the moment payment succeeds.
        </Alert>
      )}
      <Paper sx={{ p: { xs: 2.5, md: 4 }, textAlign: 'center', mb: 3, background: 'linear-gradient(135deg,#0b695c 0%,#0d8a75 100%)', color: '#fff' }}>
        <WorkspacePremiumIcon sx={{ fontSize: 48, mb: 1 }} />
        <Typography variant="h5" sx={{ fontWeight: 700 }}>
          MediStock Subscription
        </Typography>
        <Typography sx={{ mt: 0.5, opacity: 0.9, fontSize: 14 }}>
          Secure payment by Razorpay — UPI, Debit/Credit Card and NetBanking are all accepted.
          Your current plan: <strong style={{ textTransform: 'capitalize' }}>{currentTier}</strong>
        </Typography>
      </Paper>

      {gateway !== 'razorpay' && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Online payment gateway is being set up. You will be able to pay in-app very soon.
        </Alert>
      )}

      <Stack alignItems="center" sx={{ mb: 3 }}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={selectedPlan?.endsWith('-monthly') ? 'monthly' : selectedPlan === 'elite-3yr' ? 'founder' : 'yearly'}
          onChange={(e, v) => {
            if (v === 'founder' && founderPack) { setSelectedPlan('elite-3yr'); return; }
            if (v === 'monthly' || v === 'yearly') {
              const tier = selected?.tier || 'pro';
              setTierCycle(tier, v === 'monthly' ? 1 : 12);
            }
          }}
        >
          <ToggleButton value="monthly">Monthly</ToggleButton>
          <ToggleButton value="yearly">
            Yearly{!isNarrow && <>&nbsp;<strong style={{ color: '#0b695c' }}>(save 2 months)</strong></>}
          </ToggleButton>
          <ToggleButton value="founder">{isNarrow ? '3-Yr Pack' : '3-Year Founder Pack'}</ToggleButton>
        </ToggleButtonGroup>
      </Stack>

      <Grid container spacing={2} alignItems="flex-start">
        {['starter', 'pro', 'elite'].map((tier) => {
          const monthly = planFor(tier, 1);
          const yearly = planFor(tier, 12);
          const shown = selectedPlan?.endsWith('-monthly') ? monthly : yearly;
          const isCurrent = currentTier === tier && !locked;
          const isPro = tier === 'pro';
          const open = !!expanded[tier];
          return (
            <Grid item xs={12} sm={4} key={tier}>
              <Paper
                sx={{
                  p: 2.5, height: 'auto', position: 'relative',
                  border: selectedPlan === shown?.id ? '2px solid #0b695c' : '1px solid #e0e6e4',
                  ...(isPro && selectedPlan !== shown?.id ? { borderColor: '#0b695c', borderWidth: 1 } : {}),
                }}
              >
                {isPro && (
                  <Chip size="small" color="success" icon={<BoltIcon />} label="Most Popular"
                    sx={{ position: 'absolute', top: -12, left: '50%', transform: 'translateX(-50%)' }} />
                )}
                <Box
                  onClick={() => {
                    if (shown) setSelectedPlan(shown.id);
                    setExpanded((e) => ({ ...e, [tier]: !e[tier] }));
                  }}
                  sx={{ cursor: 'pointer' }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
                    <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                      <Typography sx={{ fontWeight: 800, fontSize: 20, textTransform: 'uppercase', letterSpacing: 1 }}>{TIER_INFO[tier].name}</Typography>
                      <Typography variant="caption" color="text.secondary">{TIER_INFO[tier].blurb}</Typography>
                    </Box>
                    <ExpandMoreIcon
                      color="primary"
                      sx={{ mt: 0.5, transition: 'transform 0.2s', transform: open ? 'rotate(180deg)' : 'none' }}
                    />
                  </Box>
                  <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1, mt: 1 }}>
                    <Typography sx={{ fontWeight: 800, fontSize: 28 }}>
                      {shown ? inr(shown.amount) : '—'}
                      <Typography component="span" variant="caption" color="text.secondary"> /{selectedPlan?.endsWith('-monthly') ? 'month' : 'year'}</Typography>
                    </Typography>
                    {isCurrent && <Chip size="small" label="Your plan" color="primary" variant="outlined" />}
                  </Box>
                  {shown && (
                    <Typography variant="caption" color="text.secondary">
                      ≈ ₹{shown.price_per_month}/month · tap to {open ? 'hide' : 'show'} features
                    </Typography>
                  )}
                </Box>

                <Collapse in={open}>
                  <Divider sx={{ my: 1.5 }} />
                  {INHERITS_LINE[tier] && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>
                      {INHERITS_LINE[tier]}
                    </Typography>
                  )}
                  <Stack spacing={0.75}>
                    {addedFeatures(tier).map((row) => (
                      <Stack key={row.label} direction="row" spacing={1} alignItems="center">
                        <CheckCircleIcon sx={{ fontSize: 17, color: 'success.main' }} />
                        <Typography variant="caption">{row.label}</Typography>
                      </Stack>
                    ))}
                  </Stack>
                </Collapse>
              </Paper>
            </Grid>
          );
        })}
      </Grid>

      {founderPack && (
        <Paper
          onClick={() => setSelectedPlan('elite-3yr')}
          sx={{
            mt: 3, p: 2.5, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap',
            border: selectedPlan === 'elite-3yr' ? '2px solid #0b695c' : '1px dashed #0b695c',
          }}
        >
          <RocketLaunchIcon sx={{ color: '#0b695c', fontSize: 34 }} />
          <Box sx={{ flexGrow: 1 }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography sx={{ fontWeight: 800 }}>{founderPack.label}</Typography>
              <Chip size="small" color="warning" label="Launch Offer" />
            </Stack>
            <Typography variant="caption" color="text.secondary">{founderPack.tagline} — ≈ ₹{founderPack.price_per_month}/month</Typography>
          </Box>
          <Typography sx={{ fontWeight: 800, fontSize: 24 }}>{inr(founderPack.amount)}</Typography>
        </Paper>
      )}

      <Button
        fullWidth size="large" variant="contained" onClick={payNow}
        disabled={paying || gateway !== 'razorpay' || !selected}
        sx={{ mt: 3, mb: 2, py: 1.6, fontWeight: 700, fontSize: 16 }}
      >
        {paying ? 'Opening secure checkout…' : `🔒 Continue with ${selected?.label || 'Pro'} — ${selected ? inr(selected.amount) : ''}`}
      </Button>

      <Snackbar
        open={!!snack} autoHideDuration={6000} onClose={() => setSnack(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        {snack && <Alert severity={snack.severity} onClose={() => setSnack(null)} sx={{ width: '100%' }}>{snack.message}</Alert>}
      </Snackbar>
    </Box>
  );
}
