import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Box, Card, CardContent, Typography, Grid, Avatar, Paper, Button, Skeleton, Alert,
} from '@mui/material';
import IndianRupeeIcon from '@mui/icons-material/CurrencyRupee';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import EventBusyIcon from '@mui/icons-material/EventBusy';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import WhatsAppIcon from '@mui/icons-material/WhatsApp';
import { BarChart } from '@mui/x-charts/BarChart';
import { api } from '../api';
import { fmt, fmtQty } from '../utils';

function StatCard({ icon, title, value, color, link, linkLabel }) {
  return (
    <Card sx={{ height: '100%' }}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', mb: 1.5 }}>
          <Avatar variant="rounded" sx={{ bgcolor: color + '.main', mr: 1.5, width: 44, height: 44 }}>
            {icon}
          </Avatar>
          <Typography color="text.secondary" variant="body2" sx={{ fontWeight: 600 }}>{title}</Typography>
        </Box>
        <Typography variant="h4" sx={{ fontWeight: 800, mb: link ? 1 : 0 }}>{value}</Typography>
        {link && (
          <Button size="small" endIcon={<ArrowForwardIcon />} component={Link} to={link} sx={{ textTransform: 'none', px: 0 }}>
            {linkLabel}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const [dash, setDash] = useState(null);
  const [alerts, setAlerts] = useState(null);
  const [error, setError] = useState('');
  const [waBusy, setWaBusy] = useState(false);

  useEffect(() => {
    api('/api/reports/dashboard').then(setDash).catch((e) => setError(e.message));
    api('/api/alerts').then(setAlerts).catch(() => {});
  }, []);

  // Fetch today's ready-made summary from the server and hand it to WhatsApp
  // as a share link — the owner picks the chat (usually his own) and taps send.
  const sendWhatsApp = async () => {
    setWaBusy(true);
    try {
      const d = await api('/api/whatsapp/summary');
      window.open('https://wa.me/?text=' + encodeURIComponent(d.text), '_blank');
    } catch (e) {
      setError(e.message);
    }
    setWaBusy(false);
  };

  if (error) return <Alert severity="error">{error}</Alert>;
  if (!dash) {
    return (
      <Grid container spacing={3}>
        {[...Array(4)].map((_, i) => (
          <Grid item xs={12} sm={6} md={3} key={i}><Skeleton variant="rounded" height={130} /></Grid>
        ))}
        <Grid item xs={12}><Skeleton variant="rounded" height={320} /></Grid>
      </Grid>
    );
  }

  const days = dash.last7.map((d) => new Date(d.day + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short' }));
  const revenues = dash.last7.map((d) => Math.round(d.revenue));

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1.5, mb: 3 }}>
        <Typography variant="h5">Dashboard</Typography>
        <Button
          variant="contained"
          disableElevation
          startIcon={<WhatsAppIcon />}
          onClick={sendWhatsApp}
          disabled={waBusy}
          sx={{ textTransform: 'none', fontWeight: 700, bgcolor: '#25D366', '&:hover': { bgcolor: '#1eb85a' } }}
        >
          {waBusy ? 'Ban raha hai…' : 'WhatsApp Summary'}
        </Button>
      </Box>

      <Grid container spacing={3} sx={{ mb: 3 }}>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard icon={<IndianRupeeIcon />} title="Today's Sales" value={fmt(dash.today.revenue)} color="primary" />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard icon={<TrendingUpIcon />} title="Today's Profit" value={fmt(dash.todayProfit)} color="success" />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard icon={<WarningAmberIcon />} title="Low Stock Items" value={fmtQty(dash.alerts.low)} color="warning" link="/alerts" linkLabel="View alerts" />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard icon={<EventBusyIcon />} title="Expiring ≤ 90 Days" value={fmtQty(dash.alerts.expiring)} color="error" link="/alerts" linkLabel="View alerts" />
        </Grid>
      </Grid>

      <Grid container spacing={3}>
        <Grid item xs={12} md={7}>
          <Paper sx={{ p: 3, height: '100%' }}>
            <Typography variant="h6" sx={{ mb: 2 }}>Sales — Last 7 Days</Typography>
            {dash.last7.length > 0 ? (
              <BarChart
                xAxis={[{ scaleType: 'band', data: days }]}
                series={[{ data: revenues, label: 'Revenue (₹)' }]}
                height={300}
                margin={{ left: 60 }}
              />
            ) : (
              <Typography color="text.secondary" sx={{ py: 8, textAlign: 'center' }}>No sales yet — create your first bill!</Typography>
            )}
          </Paper>
        </Grid>

        <Grid item xs={12} md={5}>
          <Paper sx={{ p: 3, height: '100%' }}>
            <Typography variant="h6" sx={{ mb: 1.5 }}>Top Sellers (7 days)</Typography>
            {dash.topSellers.length === 0 && <Typography color="text.secondary">No sales yet.</Typography>}
            {dash.topSellers.map((t, i) => (
              <Box key={i} sx={{ display: 'flex', alignItems: 'center', py: 1.2, borderBottom: i < dash.topSellers.length - 1 ? '1px solid #f0f0f0' : 'none' }}>
                <Avatar sx={{ bgcolor: 'primary.main', width: 28, height: 28, fontSize: 13, mr: 1.5 }}>{i + 1}</Avatar>
                <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                  <Typography noWrap sx={{ fontSize: 14, fontWeight: 600 }}>{t.name}</Typography>
                  <Typography variant="caption" color="text.secondary">{t.company}</Typography>
                </Box>
                <Box sx={{ textAlign: 'right' }}>
                  <Typography sx={{ fontSize: 14, fontWeight: 700 }}>{fmtQty(t.qty)} units</Typography>
                  <Typography variant="caption" color="text.secondary">{fmt(t.revenue)}</Typography>
                </Box>
              </Box>
            ))}

            {alerts && (alerts.low.length > 0 || alerts.expiring.length > 0) && (
              <Box sx={{ mt: 3 }}>
                <Typography variant="h6" sx={{ mb: 1 }}>⚠️ Needs Attention</Typography>
                {alerts.low.slice(0, 3).map((l) => (
                  <Typography key={'l' + l.id} variant="body2" color="warning.main" sx={{ py: 0.3 }}>
                    Low stock: {l.name} — {l.company} ({fmtQty(l.stock)} left)
                  </Typography>
                ))}
                {alerts.expiring.slice(0, 3).map((e) => (
                  <Typography key={'e' + e.id} variant="body2" color="error.main" sx={{ py: 0.3 }}>
                    {e.days_left < 0 ? 'EXPIRED' : 'Expiring'}: {e.name} batch {e.batch_number} ({e.days_left < 0 ? fmtQty(e.quantity) + ' units dead stock' : e.days_left + ' days'})
                  </Typography>
                ))}
              </Box>
            )}
          </Paper>
        </Grid>
      </Grid>
    </Box>
  );
}
