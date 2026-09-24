import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Box, Typography, Paper, Tabs, Tab, Chip, Skeleton, Button, Alert,
} from '@mui/material';
import ShoppingCartIcon from '@mui/icons-material/ShoppingCart';
import { api } from '../api';
import { fmt, fmtDate, fmtQty } from '../utils';

function ExpiryChip({ days_left }) {
  let color = 'success', label = days_left + ' days left';
  if (days_left < 0) { color = 'error'; label = 'EXPIRED ' + Math.abs(days_left) + ' days ago'; }
  else if (days_left <= 30) { color = 'error'; label = 'Only ' + days_left + ' days left!'; }
  else if (days_left <= 60) { color = 'warning'; label = days_left + ' days left'; }
  return <Chip size="small" color={color} variant={days_left <= 30 ? 'filled' : 'outlined'} label={label} />;
}

export default function Alerts() {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState(0);

  useEffect(() => {
    api('/api/alerts').then(setData).catch(() => {});
  }, []);

  if (!data) return <Skeleton variant="rounded" height={400} />;

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 3 }}>Alerts</Typography>

      <Paper sx={{ mb: 3 }}>
        <Tabs value={tab} onChange={(e, v) => setTab(v)}>
          <Tab label={`⚠️ Low Stock (${data.counts.low})`} />
          <Tab label={`📅 Expiry Watch (${data.counts.expiring})`} />
        </Tabs>
      </Paper>

      {tab === 0 && (
        <Paper sx={{ p: { xs: 2, md: 3 } }}>
          {data.low.length === 0 ? (
            <Alert severity="success">All medicines are above their low-stock levels. Great job! ✅</Alert>
          ) : (
            <>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                These medicines have reached their alert level — order them from your supplier.
              </Typography>
              {data.low.map((l) => (
                <Box key={l.id} sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 1.5, borderBottom: '1px solid #f0f0f0', flexWrap: 'wrap' }}>
                  <Box sx={{ flexGrow: 1, minWidth: 200 }}>
                    <Typography sx={{ fontWeight: 600 }}>{l.name}</Typography>
                    <Typography variant="caption" color="text.secondary">{l.company} · Shelf {l.shelf || '—'}</Typography>
                  </Box>
                  <Chip
                    size="small" label={l.stock <= 0 ? 'OUT OF STOCK' : l.stock + ' left'}
                    color={l.stock <= 0 ? 'error' : 'warning'} variant="filled"
                    sx={l.stock > 0 ? { animation: 'amberBadgePulse 2.5s infinite ease-in-out' } : {}}
                  />
                  <Typography variant="caption" color="text.secondary">alert at ≤ {l.low_stock_threshold}</Typography>
                  <Button size="small" variant="outlined" startIcon={<ShoppingCartIcon />} component={Link} to="/purchases">
                    Restock
                  </Button>
                </Box>
              ))}
            </>
          )}
        </Paper>
      )}

      {tab === 1 && (
        <Paper sx={{ p: { xs: 2, md: 3 } }}>
          {data.expiring.length === 0 ? (
            <Alert severity="success">No batches expiring in the next 90 days. ✅</Alert>
          ) : (
            <>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Batches expiring within 90 days — sell these first (FEFO billing already does this automatically).
              </Typography>
              {data.expiring.map((e) => (
                <Box key={e.id} sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 1.5, borderBottom: '1px solid #f0f0f0', flexWrap: 'wrap' }}>
                  <Box sx={{ flexGrow: 1, minWidth: 220 }}>
                    <Typography sx={{ fontWeight: 600 }}>{e.name}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {e.company} · Batch {e.batch_number} · Shelf {e.shelf || '—'}
                    </Typography>
                  </Box>
                  <Typography variant="body2">Expires <b>{fmtDate(e.expiry_date)}</b></Typography>
                  <Typography variant="body2" color="text.secondary">{fmtQty(e.quantity)} units</Typography>
                  <ExpiryChip days_left={e.days_left} />
                </Box>
              ))}
            </>
          )}
        </Paper>
      )}
    </Box>
  );
}
