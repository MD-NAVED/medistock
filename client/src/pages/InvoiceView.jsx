import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Box, Typography, Paper, Button, CircularProgress } from '@mui/material';
import PrintIcon from '@mui/icons-material/Print';
import LocalPharmacyIcon from '@mui/icons-material/LocalPharmacy';
import { api } from '../api';
import { fmt, fmtDate } from '../utils';

/**
 * Public, read-only invoice page. Opened by the customer from the WhatsApp
 * bill link — no login; the ?t= share token is the credential. Print button
 * gives a clean receipt (browser "Save as PDF" produces the PDF).
 */
export default function InvoiceView() {
  const { id } = useParams();
  const [search] = useSearchParams();
  const token = search.get('t') || '';
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/api/public/invoice/' + id + '?t=' + encodeURIComponent(token))
      .then(setData)
      .catch((e) => setError(e.message));
  }, [id, token]);

  if (error) {
    return (
      <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: '#f4f6f5', p: 2 }}>
        <Paper sx={{ p: 4, textAlign: 'center' }}>
          <Typography variant="h6">Invoice not available</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>{error}</Typography>
        </Paper>
      </Box>
    );
  }
  if (!data) {
    return <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><CircularProgress /></Box>;
  }

  const { sale, items, store } = data;
  const gstRows = {};
  items.forEach((it) => {
    const key = it.gst_rate;
    gstRows[key] = (gstRows[key] || 0) + (it.line_total * it.gst_rate) / 100;
  });

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: '#eef2f1', py: { xs: 0, sm: 4 }, px: { xs: 0, sm: 2 } }}>
      <style>{`@media print { .no-print { display: none !important; } body { background: #fff; } .invoice-sheet { box-shadow: none !important; } }`}</style>
      <Box sx={{ maxWidth: 480, mx: 'auto', mb: 2, display: 'flex', justifyContent: 'flex-end' }} className="no-print">
        <Button variant="contained" startIcon={<PrintIcon />} onClick={() => window.print()} sx={{ mr: { xs: 1, sm: 0 } }}>
          Print / Save PDF
        </Button>
      </Box>

      <Paper sx={{ maxWidth: 480, mx: 'auto', p: { xs: 2.5, sm: 4 }, borderRadius: { xs: 0, sm: 2 } }} className="invoice-sheet">
        <Box sx={{ textAlign: 'center', borderBottom: '2px solid #0b695c', pb: 2, mb: 2 }}>
          <LocalPharmacyIcon sx={{ fontSize: 40, color: '#0b695c' }} />
          <Typography variant="h5" sx={{ fontWeight: 800, color: '#0b695c' }}>{store.name}</Typography>
          {store.address && <Typography variant="body2" color="text.secondary">{store.address}</Typography>}
          {(store.phone || store.gstin) && (
            <Typography variant="body2" color="text.secondary">
              {store.phone}{store.phone && store.gstin ? ' · ' : ''}{store.gstin ? 'GSTIN: ' + store.gstin : ''}
            </Typography>
          )}
          <Typography variant="subtitle2" sx={{ mt: 1, fontWeight: 700 }}>TAX INVOICE</Typography>
        </Box>

        <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1.5, gap: 1 }}>
          <Typography variant="body2"><b>Invoice:</b> {sale.invoice_number}</Typography>
          <Typography variant="body2"><b>Date:</b> {fmtDate(sale.created_at)}</Typography>
        </Box>
        {sale.customer_name && <Typography variant="body2" sx={{ mb: 2 }}><b>Customer:</b> {sale.customer_name}</Typography>}

        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 12 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #ccc', textAlign: 'left' }}>
              <th style={{ padding: '6px 4px' }}>Item</th>
              <th style={{ padding: '6px 4px', textAlign: 'center' }}>Qty</th>
              <th style={{ padding: '6px 4px', textAlign: 'right' }}>Rate</th>
              <th style={{ padding: '6px 4px', textAlign: 'right' }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={i} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: '6px 4px' }}>
                  {it.medicine_name}
                  <div style={{ fontSize: 11, color: '#777' }}>{it.company} · {it.batch_number}</div>
                </td>
                <td style={{ padding: '6px 4px', textAlign: 'center' }}>{it.quantity}</td>
                <td style={{ padding: '6px 4px', textAlign: 'right' }}>{fmt(it.unit_price)}</td>
                <td style={{ padding: '6px 4px', textAlign: 'right' }}>{fmt(it.line_total)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <Box sx={{ borderTop: '1px solid #ddd', pt: 1.5 }}>
          <Row label="Subtotal" value={fmt(sale.subtotal)} />
          {Object.entries(gstRows).map(([rate, amt]) => (
            <Row key={rate} label={`GST @ ${rate}%`} value={fmt(amt)} />
          ))}
          <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 1, pt: 1, borderTop: '2px solid #0b695c' }}>
            <Typography sx={{ fontWeight: 800, fontSize: 18, color: '#0b695c' }}>TOTAL</Typography>
            <Typography sx={{ fontWeight: 800, fontSize: 18, color: '#0b695c' }}>{fmt(sale.total)}</Typography>
          </Box>
        </Box>

        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textAlign: 'center', mt: 3 }}>
          Thank you for your visit! 💊<br />Generated via MediStock
        </Typography>
      </Paper>
    </Box>
  );
}

function Row({ label, value }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', py: 0.3 }}>
      <Typography variant="body2" color="text.secondary">{label}</Typography>
      <Typography variant="body2">{value}</Typography>
    </Box>
  );
}
