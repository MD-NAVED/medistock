import { useEffect, useState } from 'react';
import {
  Box, Typography, Paper, Grid, Button, TextField, Chip, Divider,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Dialog, DialogTitle, DialogContent, DialogActions, Snackbar, Alert,
  Stack, Card, CardContent, InputAdornment, IconButton, Tooltip, useMediaQuery,
} from '@mui/material';
import CardGiftcardIcon from '@mui/icons-material/CardGiftcard';
import WhatsAppIcon from '@mui/icons-material/WhatsApp';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import AccountBalanceWalletIcon from '@mui/icons-material/AccountBalanceWallet';
import MonetizationOnIcon from '@mui/icons-material/MonetizationOn';
import StoreIcon from '@mui/icons-material/Store';
import VerifiedIcon from '@mui/icons-material/Verified';
import BoltIcon from '@mui/icons-material/Bolt';
import CurrencyRupeeIcon from '@mui/icons-material/CurrencyRupee';
import ShareIcon from '@mui/icons-material/Share';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { api } from '../api';
import { fmt, fmtDate, fmtDateTime } from '../utils';

const COMMISSION_TABLE = [
  { plan: 'Starter Yearly (₹2,999)', commission: '₹450', freeMonths: '+1 Month Free' },
  { plan: 'Pro Yearly — Best Value (₹4,999)', commission: '₹750', freeMonths: '+2 Months Free', highlight: true },
  { plan: 'Elite Yearly (₹7,999)', commission: '₹1,200', freeMonths: '+3 Months Free' },
  { plan: 'Founder Pack — 3 Years (₹14,999)', commission: '₹2,250', freeMonths: '+6 Months Free' },
];

export default function Referrals() {
  const isMobile = useMediaQuery('(max-width:600px)');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [snack, setSnack] = useState(null);

  // Dialogs
  const [redeemOpen, setRedeemOpen] = useState(false);
  const [redeemAmt, setRedeemAmt] = useState(250);
  const [payoutOpen, setPayoutOpen] = useState(false);
  const [payoutAmt, setPayoutAmt] = useState('');
  const [upiId, setUpiId] = useState('');
  const [busy, setBusy] = useState(false);

  const loadData = () => {
    api('/api/referrals/summary')
      .then((res) => {
        setData(res);
        setLoading(false);
      })
      .catch((err) => {
        setSnack({ severity: 'error', message: err.message });
        setLoading(false);
      });
  };

  useEffect(() => {
    loadData();
  }, []);

  const copyToClipboard = (text, label) => {
    navigator.clipboard.writeText(text);
    setSnack({ severity: 'success', message: `${label} copied to clipboard!` });
  };

  const getWhatsAppShareLink = () => {
    if (!data) return '#';
    const text =
      `🏥 *Namaste!* Main apni pharmacy ke liye *MediStock* pharmacy billing & stock management software use kar raha hoon.\n\n` +
      `✨ Agar aap bhi register karna chahte hain toh mere referral link se karein aur paayein *21 Din ka Free Trial* (7 Din Extra Free!):\n` +
      `👉 ${data.referral_link}\n\n` +
      `*Referral Code:* ${data.referral_code}\n\n` +
      `Camera invoice scanner, WhatsApp bills, aur expiry alerts sab available hai! Try karke dekhein.`;
    return 'https://wa.me/?text=' + encodeURIComponent(text);
  };

  const handleRedeemExtension = async () => {
    setBusy(true);
    try {
      const res = await api('/api/referrals/redeem-extension', {
        method: 'POST',
        body: { amount: Number(redeemAmt) },
      });
      setSnack({
        severity: 'success',
        message: `🎉 Successfully redeemed ₹${res.redeemed_amount}! +${res.days_added} days added to your subscription.`,
      });
      setRedeemOpen(false);
      loadData();
    } catch (err) {
      setSnack({ severity: 'error', message: err.message });
    } finally {
      setBusy(false);
    }
  };

  const handleRequestPayout = async () => {
    setBusy(true);
    try {
      const res = await api('/api/referrals/request-payout', {
        method: 'POST',
        body: { amount: Number(payoutAmt), upi_id: upiId },
      });
      setSnack({
        severity: 'success',
        message: res.message || 'Payout request submitted successfully!',
      });
      setPayoutOpen(false);
      setPayoutAmt('');
      loadData();
    } catch (err) {
      setSnack({ severity: 'error', message: err.message });
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <Typography color="text.secondary" sx={{ py: 8, textAlign: 'center' }}>
        Loading Refer & Earn dashboard…
      </Typography>
    );
  }

  const wallet = data?.wallet_balance || 0;

  return (
    <Box sx={{ maxWidth: 1000, mx: 'auto' }}>
      {/* Hero Banner */}
      <Paper
        sx={{
          p: { xs: 2.5, md: 4 },
          mb: 3,
          background: 'linear-gradient(135deg, #0b695c 0%, #004d40 100%)',
          color: '#fff',
          borderRadius: 3,
        }}
      >
        <Grid container spacing={2} alignItems="center">
          <Grid item xs={12} md={8}>
            <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1 }}>
              <CardGiftcardIcon sx={{ fontSize: 32, color: '#80cbc4' }} />
              <Typography variant="h5" sx={{ fontWeight: 800 }}>
                Refer Chemist Friends & Earn 15%
              </Typography>
            </Stack>
            <Typography variant="body2" sx={{ opacity: 0.9, lineHeight: 1.6, mb: 2 }}>
              Invite other pharmacy & medical store owners to MediStock. When they subscribe to any plan, you earn a <b>15% cash commission (up to ₹2,250 per store)</b> directly into your wallet. Your friends get an extended <b>21-Day Free Trial</b>!
            </Typography>

            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, alignItems: 'center' }}>
              <Button
                variant="contained"
                startIcon={<WhatsAppIcon />}
                href={getWhatsAppShareLink()}
                target="_blank"
                rel="noopener"
                sx={{
                  bgcolor: '#25D366',
                  '&:hover': { bgcolor: '#1ebe5d' },
                  color: '#fff',
                  fontWeight: 700,
                  px: 2.5,
                  py: 1,
                  fontSize: 14,
                  boxShadow: '0 4px 14px rgba(37,211,102,0.4)',
                }}
              >
                Share on WhatsApp
              </Button>
              <Button
                variant="outlined"
                startIcon={<ContentCopyIcon />}
                onClick={() => copyToClipboard(data?.referral_link, 'Referral link')}
                sx={{
                  borderColor: 'rgba(255,255,255,0.7)',
                  color: '#fff',
                  '&:hover': { borderColor: '#fff', bgcolor: 'rgba(255,255,255,0.1)' },
                  fontWeight: 600,
                }}
              >
                Copy Invite Link
              </Button>
            </Box>
          </Grid>

          {/* Personal Referral Code Box */}
          <Grid item xs={12} md={4}>
            <Paper
              sx={{
                p: 2.5,
                bgcolor: 'rgba(255,255,255,0.12)',
                backdropFilter: 'blur(10px)',
                borderRadius: 2,
                textAlign: 'center',
                border: '1px solid rgba(255,255,255,0.2)',
              }}
            >
              <Typography variant="caption" sx={{ textTransform: 'uppercase', letterSpacing: 1, opacity: 0.85, fontWeight: 700 }}>
                Your Referral Code
              </Typography>
              <Typography variant="h4" sx={{ fontWeight: 900, my: 0.5, letterSpacing: 2, color: '#80cbc4' }}>
                {data?.referral_code}
              </Typography>
              <Button
                size="small"
                onClick={() => copyToClipboard(data?.referral_code, 'Referral code')}
                sx={{ color: '#fff', textTransform: 'none', opacity: 0.9, '&:hover': { opacity: 1 } }}
              >
                Tap to copy code
              </Button>
            </Paper>
          </Grid>
        </Grid>
      </Paper>

      {/* 4 Stats Cards */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={6} sm={3}>
          <Paper sx={{ p: 2, textAlign: 'center', borderRadius: 2 }}>
            <AccountBalanceWalletIcon color="primary" sx={{ fontSize: 28, mb: 0.5 }} />
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>Wallet Balance</Typography>
            <Typography variant="h6" sx={{ fontWeight: 800, color: 'primary.main' }}>
              ₹{wallet.toFixed(2)}
            </Typography>
          </Paper>
        </Grid>
        <Grid item xs={6} sm={3}>
          <Paper sx={{ p: 2, textAlign: 'center', borderRadius: 2 }}>
            <MonetizationOnIcon color="success" sx={{ fontSize: 28, mb: 0.5 }} />
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>Total Earned</Typography>
            <Typography variant="h6" sx={{ fontWeight: 800, color: 'success.main' }}>
              ₹{(data?.total_earned || 0).toFixed(2)}
            </Typography>
          </Paper>
        </Grid>
        <Grid item xs={6} sm={3}>
          <Paper sx={{ p: 2, textAlign: 'center', borderRadius: 2 }}>
            <StoreIcon color="info" sx={{ fontSize: 28, mb: 0.5 }} />
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>Invited Stores</Typography>
            <Typography variant="h6" sx={{ fontWeight: 800 }}>
              {data?.referred_count || 0}
            </Typography>
          </Paper>
        </Grid>
        <Grid item xs={6} sm={3}>
          <Paper sx={{ p: 2, textAlign: 'center', borderRadius: 2 }}>
            <VerifiedIcon color="secondary" sx={{ fontSize: 28, mb: 0.5 }} />
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>Subscribed Stores</Typography>
            <Typography variant="h6" sx={{ fontWeight: 800, color: 'secondary.main' }}>
              {data?.paid_count || 0}
            </Typography>
          </Paper>
        </Grid>
      </Grid>

      {/* Wallet Actions (Redeem / Withdraw) */}
      <Paper sx={{ p: 2.5, mb: 3, borderRadius: 2, bgcolor: '#fbfcfc', border: '1px solid #e0e6e4' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 2 }}>
          <Box>
            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
              Use Your Earnings (Available: ₹{wallet.toFixed(2)})
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Convert your wallet balance into free subscription months or withdraw cash directly to your UPI.
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
            <Button
              variant="contained"
              color="primary"
              startIcon={<BoltIcon />}
              disabled={wallet < 50}
              onClick={() => { setRedeemAmt(Math.min(wallet, 250)); setRedeemOpen(true); }}
              sx={{ fontWeight: 700 }}
            >
              Get Free Subscription
            </Button>
            <Button
              variant="outlined"
              color="success"
              startIcon={<CurrencyRupeeIcon />}
              disabled={wallet < 100}
              onClick={() => { setPayoutAmt(String(Math.floor(wallet))); setPayoutOpen(true); }}
              sx={{ fontWeight: 700 }}
            >
              Withdraw to UPI
            </Button>
          </Box>
        </Box>
      </Paper>

      {/* Commission Earnings Rate Card */}
      <Paper sx={{ p: { xs: 2, md: 3 }, mb: 3, borderRadius: 2 }}>
        <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>
          💰 Commission Rates Breakdown
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          Every time a medical store referred by you purchases or renews their subscription, you instantly receive 15% commission:
        </Typography>

        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow sx={{ bgcolor: '#f4f8f7' }}>
                <TableCell sx={{ fontWeight: 700 }}>Plan Subscribed by Friend</TableCell>
                <TableCell align="right" sx={{ fontWeight: 700 }}>Your Cash Reward</TableCell>
                <TableCell align="right" sx={{ fontWeight: 700 }}>OR Free Extension</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {COMMISSION_TABLE.map((r) => (
                <TableRow key={r.plan} sx={{ bgcolor: r.highlight ? '#e8f5e9' : 'inherit' }}>
                  <TableCell>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <CheckCircleIcon sx={{ fontSize: 16, color: 'success.main' }} />
                      <Typography sx={{ fontSize: 13, fontWeight: r.highlight ? 700 : 500 }}>
                        {r.plan}
                      </Typography>
                      {r.highlight && <Chip size="small" color="success" label="Top Choice" sx={{ height: 20, fontSize: 10 }} />}
                    </Box>
                  </TableCell>
                  <TableCell align="right" sx={{ fontWeight: 800, color: 'success.main', fontSize: 14 }}>
                    {r.commission}
                  </TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700, color: 'primary.main', fontSize: 13 }}>
                    {r.freeMonths}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      {/* Referred Stores List */}
      <Paper sx={{ p: { xs: 2, md: 3 }, mb: 3, borderRadius: 2 }}>
        <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>
          👥 Your Invited Chemist Stores
        </Typography>
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow sx={{ bgcolor: '#f4f8f7' }}>
                <TableCell>Store Name</TableCell>
                <TableCell>Owner & City</TableCell>
                <TableCell>Joined On</TableCell>
                <TableCell align="center">Status</TableCell>
                <TableCell align="right">Commission Earned</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {(!data?.referred_stores || data.referred_stores.length === 0) ? (
                <TableRow>
                  <TableCell colSpan={5} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                    No chemist stores invited yet. Tap <b>Share on WhatsApp</b> above to invite your first friend!
                  </TableCell>
                </TableRow>
              ) : (
                data.referred_stores.map((s) => (
                  <TableRow key={s.id} hover>
                    <TableCell sx={{ fontWeight: 600 }}>{s.store_name}</TableCell>
                    <TableCell>
                      <Typography sx={{ fontSize: 13 }}>{s.owner_name}</Typography>
                      {s.city && <Typography variant="caption" color="text.secondary">{s.city}</Typography>}
                    </TableCell>
                    <TableCell>{fmtDate(s.created_at)}</TableCell>
                    <TableCell align="center">
                      <Chip
                        size="small"
                        color={s.status === 'active' ? 'success' : 'info'}
                        label={s.status === 'active' ? 'Subscribed' : 'On Free Trial'}
                        variant="outlined"
                      />
                    </TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700, color: s.total_commission_earned > 0 ? 'success.main' : 'text.secondary' }}>
                      {s.total_commission_earned > 0 ? `+₹${s.total_commission_earned.toFixed(2)}` : 'Pending plan'}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      {/* Transactions History */}
      {data?.transactions && data.transactions.length > 0 && (
        <Paper sx={{ p: { xs: 2, md: 3 }, borderRadius: 2 }}>
          <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>
            📜 Wallet History
          </Typography>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow sx={{ bgcolor: '#f4f8f7' }}>
                  <TableCell>Date</TableCell>
                  <TableCell>Activity</TableCell>
                  <TableCell align="right">Amount</TableCell>
                  <TableCell align="center">Status</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.transactions.map((tx) => (
                  <TableRow key={tx.id}>
                    <TableCell>{fmtDateTime(tx.created_at)}</TableCell>
                    <TableCell>
                      <Typography sx={{ fontSize: 13 }}>{tx.note || tx.type}</Typography>
                      {tx.upi_id && <Typography variant="caption" color="text.secondary">UPI: {tx.upi_id}</Typography>}
                    </TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700, color: tx.type === 'reward_earned' ? 'success.main' : 'text.primary' }}>
                      {tx.type === 'reward_earned' ? `+₹${tx.amount.toFixed(2)}` : `-₹${tx.amount.toFixed(2)}`}
                    </TableCell>
                    <TableCell align="center">
                      <Chip
                        size="small"
                        color={tx.status === 'completed' ? 'success' : tx.status === 'pending' ? 'warning' : 'error'}
                        label={tx.status}
                        variant="outlined"
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Paper>
      )}

      {/* Dialog 1: Redeem for Subscription Extension */}
      <Dialog open={redeemOpen} onClose={() => setRedeemOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>Get Free Subscription</DialogTitle>
        <DialogContent sx={{ pt: '16px !important' }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Convert your wallet balance into free subscription days. (₹250 = 30 days extension).
          </Typography>
          <TextField
            label="Redeem Amount (₹)"
            type="number"
            fullWidth
            value={redeemAmt}
            onChange={(e) => setRedeemAmt(e.target.value)}
            inputProps={{ min: 50, max: wallet }}
            InputProps={{ startAdornment: <InputAdornment position="start">₹</InputAdornment> }}
            helperText={`Available: ₹${wallet.toFixed(2)} · Adds ≈ ${Math.round((Number(redeemAmt || 0) / 250) * 30)} days to your plan`}
          />
        </DialogContent>
        <DialogActions sx={{ p: 2 }}>
          <Button onClick={() => setRedeemOpen(false)} disabled={busy}>Cancel</Button>
          <Button variant="contained" onClick={handleRedeemExtension} disabled={busy || Number(redeemAmt) < 50 || Number(redeemAmt) > wallet}>
            {busy ? 'Applying…' : 'Redeem Free Days'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Dialog 2: Request UPI Payout */}
      <Dialog open={payoutOpen} onClose={() => setPayoutOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>Withdraw Cash to UPI</DialogTitle>
        <DialogContent sx={{ pt: '16px !important' }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Enter your UPI ID to receive direct cash into your bank account.
          </Typography>
          <TextField
            label="UPI ID"
            placeholder="e.g. 9876543210@upi or name@okaxis"
            fullWidth
            value={upiId}
            onChange={(e) => setUpiId(e.target.value)}
            sx={{ mb: 2 }}
          />
          <TextField
            label="Withdrawal Amount (₹)"
            type="number"
            fullWidth
            value={payoutAmt}
            onChange={(e) => setPayoutAmt(e.target.value)}
            inputProps={{ min: 100, max: wallet }}
            InputProps={{ startAdornment: <InputAdornment position="start">₹</InputAdornment> }}
            helperText={`Available balance: ₹${wallet.toFixed(2)} (Min: ₹100)`}
          />
        </DialogContent>
        <DialogActions sx={{ p: 2 }}>
          <Button onClick={() => setPayoutOpen(false)} disabled={busy}>Cancel</Button>
          <Button
            variant="contained"
            color="success"
            onClick={handleRequestPayout}
            disabled={busy || !upiId.includes('@') || Number(payoutAmt) < 100 || Number(payoutAmt) > wallet}
          >
            {busy ? 'Submitting…' : 'Submit Payout Request'}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={!!snack} autoHideDuration={5000} onClose={() => setSnack(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        {snack && <Alert severity={snack.severity} onClose={() => setSnack(null)} sx={{ width: '100%' }}>{snack.message}</Alert>}
      </Snackbar>
    </Box>
  );
}
