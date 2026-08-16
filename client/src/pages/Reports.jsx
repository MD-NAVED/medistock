import { useEffect, useState } from 'react';
import {
  Box, Typography, Paper, TextField, Button, Grid, Avatar, Divider, Skeleton,
  Chip, Snackbar, Alert, useMediaQuery,
} from '@mui/material';
import IndianRupeeIcon from '@mui/icons-material/CurrencyRupee';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import InventoryIcon from '@mui/icons-material/Inventory2';
import SearchIcon from '@mui/icons-material/Search';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { api } from '../api';
import BillDetailDialog, { statusChip } from '../components/BillDetailDialog';
import { fmt, fmtDateTime, daysAgoStr, todayStr } from '../utils';

function SummaryCard({ icon, title, value, color, hint }) {
  return (
    <Paper sx={{ p: 2.5, display: 'flex', alignItems: 'center', gap: 2, height: '100%' }}>
      <Avatar variant="rounded" sx={{ bgcolor: color + '.main', width: 46, height: 46 }}>{icon}</Avatar>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 600 }}>{title}</Typography>
        <Typography variant="h5" sx={{ fontWeight: 800 }}>{value}</Typography>
        {hint && <Typography variant="caption" color="text.secondary">{hint}</Typography>}
      </Box>
    </Paper>
  );
}

export default function Reports() {
  const isMobile = useMediaQuery('(max-width:900px)');
  const [from, setFrom] = useState(daysAgoStr(29));
  const [to, setTo] = useState(todayStr());
  const [applied, setApplied] = useState({ from: daysAgoStr(29), to: todayStr() });
  const [data, setData] = useState(null);
  const [settings, setSettings] = useState(null);
  const [openBillId, setOpenBillId] = useState(null);
  const [snack, setSnack] = useState('');
  const [showAll, setShowAll] = useState(false);

  const load = () => {
    setData(null);
    api(`/api/reports/sales?from=${applied.from}&to=${applied.to}`).then(setData).catch(() => {});
  };

  useEffect(load, [applied]);
  useEffect(() => { api('/api/settings').then(setSettings).catch(() => {}); }, []);

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: { xs: 2, md: 3 }, fontSize: { xs: 20, md: 24 } }}>Reports</Typography>

      <Paper sx={{ p: 2.5, mb: 3, display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
        <TextField size="small" type="date" label="From" value={from} onChange={(e) => setFrom(e.target.value)}
          InputLabelProps={{ shrink: true }} sx={{ width: { xs: '47%', sm: 180 } }} />
        <TextField size="small" type="date" label="To" value={to} onChange={(e) => setTo(e.target.value)}
          InputLabelProps={{ shrink: true }} sx={{ width: { xs: '47%', sm: 180 } }} />
        <Button variant="contained" startIcon={<SearchIcon />} onClick={() => setApplied({ from, to })} disabled={!from || !to}>
          Apply
        </Button>
      </Paper>

      {!data ? (
        <Skeleton variant="rounded" height={400} />
      ) : (
        <>
          <Grid container spacing={2.5} sx={{ mb: 2.5 }}>
            <Grid item xs={12} sm={6} md={3}>
              <SummaryCard icon={<IndianRupeeIcon />} title="Net Revenue" value={fmt(data.summary.revenue)}
                color="primary" hint="cancelled bills & returns excluded" />
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <SummaryCard icon={<TrendingUpIcon />} title="Net Profit" value={fmt(data.summary.profit)} color="success" />
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <SummaryCard icon={<ReceiptLongIcon />} title="Bills" value={String(data.summary.bills)} color="secondary" />
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <SummaryCard icon={<InventoryIcon />} title="Units Sold" value={String(data.summary.units)} color="warning" />
            </Grid>
          </Grid>

          {/* Corrections & losses for the same window */}
          <Paper sx={{ p: 2.5, mb: 3 }}>
            <Typography variant="subtitle2" sx={{ mb: 1.5 }}>Corrections & losses in this period</Typography>
            <Box sx={{ display: 'flex', gap: { xs: 2, md: 5 }, flexWrap: 'wrap' }}>
              <Box>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>Cancelled bills</Typography>
                <Typography sx={{ fontWeight: 700 }}>
                  {data.cancelled.count} <Typography component="span" variant="caption" color="text.secondary">
                    ({fmt(data.cancelled.amount)})</Typography>
                </Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>Refunds paid</Typography>
                <Typography sx={{ fontWeight: 700 }}>
                  {data.refunds.count} <Typography component="span" variant="caption" color="text.secondary">
                    ({fmt(data.refunds.amount)})</Typography>
                </Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>Expired / damaged stock</Typography>
                <Typography sx={{ fontWeight: 700, color: data.writeoffs.loss > 0 ? 'error.main' : 'inherit' }}>
                  {data.writeoffs.units} units <Typography component="span" variant="caption" color="text.secondary">
                    (loss {fmt(data.writeoffs.loss)})</Typography>
                </Typography>
              </Box>
            </Box>
          </Paper>

          <Grid container spacing={3}>
            <Grid item xs={12} md={5}>
              <Paper sx={{ p: 3, height: '100%' }}>
                <Typography variant="h6" sx={{ mb: 2 }}>🏆 Best Sellers</Typography>
                {data.bestSellers.length === 0 && <Typography color="text.secondary">No sales in this period.</Typography>}
                {data.bestSellers.map((b, i) => (
                  <Box key={i} sx={{ py: 1.2, borderBottom: i < data.bestSellers.length - 1 ? '1px solid #f0f0f0' : 'none' }}>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1 }}>
                      <Typography sx={{ fontSize: 14, fontWeight: 600 }}>{i + 1}. {b.name}</Typography>
                      <Typography sx={{ fontSize: 14, fontWeight: 700, whiteSpace: 'nowrap' }}>{b.qty} units</Typography>
                    </Box>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                      <Typography variant="caption" color="text.secondary">{b.company}</Typography>
                      <Typography variant="caption" color="success.main" sx={{ fontWeight: 600 }}>profit {fmt(b.profit)}</Typography>
                    </Box>
                  </Box>
                ))}
              </Paper>
            </Grid>

            <Grid item xs={12} md={7}>
              <Paper sx={{ p: { xs: 2, md: 3 }, height: '100%' }}>
                <Typography variant="h6" sx={{ mb: 0.5 }}>Bills</Typography>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
                  Tap a bill to view it, reprint it, cancel it, or take items back.
                </Typography>
                {data.sales.length === 0 && <Typography color="text.secondary">No bills in this period.</Typography>}
                {data.sales.slice(0, showAll ? undefined : 20).map((s) => (
                  <Box
                    key={s.id}
                    component="button"
                    type="button"
                    onClick={() => setOpenBillId(s.id)}
                    aria-label={`Open bill ${s.invoice_number}`}
                    sx={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1,
                      width: '100%', textAlign: 'left', font: 'inherit', color: 'inherit',
                      background: 'none', border: 'none', borderBottom: '1px solid #f0f0f0',
                      py: 1.2, px: 0.5, cursor: 'pointer', borderRadius: 1,
                      '&:hover': { bgcolor: '#f5faf9' },
                      '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
                    }}
                  >
                    <Box sx={{ minWidth: 0 }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                        <Typography sx={{ fontSize: 14, fontWeight: 600 }}>{s.invoice_number}</Typography>
                        {statusChip(s.status, s.returned_units)}
                      </Box>
                      <Typography variant="caption" color="text.secondary">
                        {fmtDateTime(s.created_at)} · {s.item_count} items · by {s.served_by}
                      </Typography>
                    </Box>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                      <Typography sx={{
                        fontWeight: 700, whiteSpace: 'nowrap',
                        textDecoration: s.status === 'cancelled' ? 'line-through' : 'none',
                        color: s.status === 'cancelled' ? 'text.disabled' : 'text.primary',
                      }}>
                        {fmt(s.total)}
                      </Typography>
                      <ChevronRightIcon fontSize="small" color="disabled" />
                    </Box>
                  </Box>
                ))}
                {data.sales.length > 20 && (
                  <Button size="small" sx={{ mt: 1.5 }} onClick={() => setShowAll(!showAll)}>
                    {showAll ? 'Show fewer' : `Show all ${data.sales.length} bills`}
                  </Button>
                )}
              </Paper>
            </Grid>
          </Grid>
        </>
      )}

      {openBillId && (
        <BillDetailDialog
          saleId={openBillId}
          settings={settings}
          onClose={() => setOpenBillId(null)}
          onChanged={(msg) => { setSnack(msg); load(); }}
        />
      )}

      <Snackbar open={!!snack} autoHideDuration={5000} onClose={() => setSnack('')}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        <Alert severity="success" onClose={() => setSnack('')} sx={{ width: '100%' }}>{snack}</Alert>
      </Snackbar>
    </Box>
  );
}
