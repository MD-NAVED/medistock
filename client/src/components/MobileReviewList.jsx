import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  Box, Typography, Paper, IconButton, Autocomplete, TextField, Chip, Divider, Button, Tabs, Tab, Collapse
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import WarningIcon from '@mui/icons-material/Warning';

// Helper to calculate line total (matches Purchases.jsx)
const lineTotal = (l) => {
  const q = Number(l.quantity) || 0;
  const p = Number(l.buy_price) || 0;
  return q * p;
};

const fmt = (v) => v.toLocaleString('en-IN', { style: 'currency', currency: 'INR' });

export default function MobileReviewList({ lines, setLines, setLine, medicines, scannedNotice, scanEngine }) {
  const [tab, setTab] = useState('needs-fix');
  const [expandedItems, setExpandedItems] = useState({});
  const itemRefs = useRef([]);

  // Compute item statuses
  const itemsWithStatus = useMemo(() => {
    return lines.map((l, originalIndex) => {
      let status = 'ready';
      let errors = 0;

      if (!l.medicine_id) errors++;
      if (!l.batch_number || !l.batch_number.trim()) errors++;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(l.expiry_date)) errors++;
      if (!(Number(l.quantity) > 0)) errors++;
      if (!(Number(l.buy_price) >= 0 && l.buy_price !== '')) errors++;

      if (errors > 0) {
        status = 'needs-fix';
      } else if (l.lowConfidence || (l.candidates && l.candidates.length > 0)) {
        status = 'verify';
      } else {
        status = 'ready';
      }

      return { ...l, originalIndex, status, errors };
    });
  }, [lines]);

  const counts = useMemo(() => ({
    all: itemsWithStatus.length,
    'needs-fix': itemsWithStatus.filter(i => i.status === 'needs-fix').length,
    verify: itemsWithStatus.filter(i => i.status === 'verify').length,
    ready: itemsWithStatus.filter(i => i.status === 'ready').length,
  }), [itemsWithStatus]);

  // Default tab logic
  useEffect(() => {
    if (counts['needs-fix'] > 0 && tab !== 'needs-fix') {
      setTab('needs-fix');
    } else if (counts['needs-fix'] === 0 && tab === 'needs-fix') {
      setTab('all');
    }
  }, [counts['needs-fix']]);

  // Auto-expand items that need fix
  useEffect(() => {
    const newExpanded = { ...expandedItems };
    let changed = false;
    itemsWithStatus.forEach((item) => {
      if (item.status === 'needs-fix' && expandedItems[item.originalIndex] === undefined) {
        newExpanded[item.originalIndex] = true;
        changed = true;
      }
    });
    if (changed) setExpandedItems(newExpanded);
  }, [itemsWithStatus]);

  const filteredItems = itemsWithStatus.filter(item => tab === 'all' || item.status === tab);

  const toggleExpand = (idx) => {
    setExpandedItems(prev => ({ ...prev, [idx]: !prev[idx] }));
  };

  const jumpToNextIssue = () => {
    const nextIssue = itemsWithStatus.find(i => i.status === 'needs-fix' || i.status === 'verify');
    if (nextIssue) {
      setTab('all');
      setExpandedItems(prev => ({ ...prev, [nextIssue.originalIndex]: true }));
      setTimeout(() => {
        itemRefs.current[nextIssue.originalIndex]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
    }
  };

  const totalAmount = itemsWithStatus.reduce((sum, item) => sum + lineTotal(item), 0);

  return (
    <Box sx={{ pb: 10 }}>
      {/* STICKY SUMMARY HEADER */}
      <Box sx={{ position: 'sticky', top: 0, zIndex: 10, bgcolor: 'background.paper', pt: 1, pb: 1, borderBottom: '1px solid #ddd' }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', px: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>
              Total: {fmt(totalAmount)}
            </Typography>
            {scanEngine === 'gemini' && (
              <Chip size="small" label="✨ AI Scan (Gemini)" sx={{ bgcolor: '#f3e5f5', color: '#7b1fa2', fontWeight: 700, height: 22, fontSize: 10 }} />
            )}
            {scanEngine === 'tesseract' && (
              <Chip size="small" label="📄 Local OCR" sx={{ bgcolor: '#fff3e0', color: '#e65100', fontWeight: 600, height: 22, fontSize: 10 }} />
            )}
          </Box>
          {(counts['needs-fix'] > 0 || counts['verify'] > 0) && (
            <Button size="small" variant="outlined" color="error" onClick={jumpToNextIssue} endIcon={<ExpandMoreIcon />}>
              Jump to next issue
            </Button>
          )}
        </Box>
        <Tabs value={tab} onChange={(e, v) => setTab(v)} variant="scrollable" scrollButtons="auto" sx={{ minHeight: 40, mt: 1 }}>
          <Tab label={`All (${counts.all})`} value="all" sx={{ minHeight: 40, textTransform: 'none' }} />
          <Tab label={`🔴 Needs Fix (${counts['needs-fix']})`} value="needs-fix" sx={{ minHeight: 40, textTransform: 'none' }} />
          <Tab label={`⚠️ Verify (${counts.verify})`} value="verify" sx={{ minHeight: 40, textTransform: 'none' }} />
          <Tab label={`✅ Ready (${counts.ready})`} value="ready" sx={{ minHeight: 40, textTransform: 'none' }} />
        </Tabs>
      </Box>

      {/* COMPACT ROW LAYOUT */}
      <Box sx={{ mt: 2, px: 1 }}>
        {filteredItems.map((item, idx) => {
          const { originalIndex: i, status } = item;
          const isExpanded = !!expandedItems[i];
          const med = medicines.find((m) => m.id === item.medicine_id);
          const hasError = status === 'needs-fix';
          const hasWarning = status === 'verify';

          return (
            <Paper
              key={i}
              ref={el => itemRefs.current[i] = el}
              sx={{
                mb: 1.5,
                bgcolor: '#fafbfb',
                border: hasError ? '1px solid #d32f2f' : hasWarning ? '1px solid #ed6c02' : '1px solid #e0e6e4',
                overflow: 'hidden',
                ...(idx < 10 ? {
                  animation: 'itemFadeSlide 200ms cubic-bezier(0.16, 1, 0.3, 1) both',
                  animationDelay: `${idx * 30}ms`,
                } : {}),
              }}
            >
              {/* Compact Summary Row */}
              <Box
                onClick={() => toggleExpand(i)}
                sx={{
                  display: 'flex', alignItems: 'center', p: 1.5, cursor: 'pointer',
                  bgcolor: hasError ? '#fff8f8' : hasWarning ? '#fffcf5' : '#fafffa'
                }}
              >
                {hasError ? <ErrorIcon color="error" sx={{ mr: 1, fontSize: 20 }} /> :
                 hasWarning ? <WarningIcon color="warning" sx={{ mr: 1, fontSize: 20 }} /> :
                 <CheckCircleIcon color="success" sx={{ mr: 1, fontSize: 20 }} />}
                
                <Box sx={{ flexGrow: 1, overflow: 'hidden' }}>
                  <Typography variant="body2" sx={{ fontWeight: 'bold', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {med ? med.name : (item.matchedName || item.rawLine || `Item ${i + 1}`)}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {item.batch_number || '-'} | {item.quantity || 0} qty @ ₹{item.buy_price || 0}
                  </Typography>
                </Box>
                <Typography variant="body2" sx={{ fontWeight: 'bold', mx: 1 }}>
                  {fmt(lineTotal(item))}
                </Typography>
                {isExpanded ? <ExpandLessIcon color="action" /> : <ExpandMoreIcon color="action" />}
              </Box>

              {/* Expanded Form (Existing UI) */}
              <Collapse in={isExpanded}>
                <Box sx={{ p: 2, pt: 0, borderTop: '1px solid #eee' }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', mb: 1.5, mt: 1 }}>
                    <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>Edit Details</Typography>
                    <IconButton size="small" color="error" disabled={lines.length === 1}
                      onClick={(e) => { e.stopPropagation(); setLines(lines.filter((_, idx) => idx !== i)); }}>
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Box>

                  <Autocomplete
                    size="small" options={medicines} value={med || null} fullWidth
                    onChange={(e, v) => {
                       // clear lowConfidence if they explicitly selected something
                       setLine(i, { medicine_id: v ? v.id : null, buy_price: v ? String(v.buy_price) : item.buy_price, candidates: [], lowConfidence: false });
                    }}
                    getOptionLabel={(o) => `${o.name} — ${o.company}`}
                    renderInput={(p) => (
                      <TextField
                        {...p}
                        label="Select medicine *"
                        error={scannedNotice && !item.medicine_id}
                        helperText={scannedNotice && !item.medicine_id ? 'Please verify this field' : ''}
                      />
                    )}
                    sx={{ mb: 1 }}
                  />

                  {scannedNotice && item.candidates && item.candidates.length > 0 && !item.medicine_id && (
                    <Box sx={{ mb: 1.5, display: 'flex', flexWrap: 'wrap', gap: 0.5, alignItems: 'center' }}>
                      <Typography variant="caption" sx={{ color: 'warning.dark', fontWeight: 600 }}>Top suggestions:</Typography>
                      {item.candidates.map((c) => (
                        <Chip
                          key={c.id}
                          size="small"
                          variant="outlined"
                          color="primary"
                          label={`${c.name} (${c.company || 'Generic'})`}
                          onClick={() => setLine(i, {
                            medicine_id: c.id,
                            buy_price: c.buy_price ? String(c.buy_price) : item.buy_price,
                            candidates: [],
                            lowConfidence: false
                          })}
                          sx={{ fontSize: 11, cursor: 'pointer' }}
                        />
                      ))}
                    </Box>
                  )}

                  <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.5 }}>
                    <TextField size="small" label="Batch # *" value={item.batch_number}
                      error={scannedNotice && !item.batch_number.trim()}
                      helperText={scannedNotice && !item.batch_number.trim() ? 'Please verify' : ''}
                      onChange={(e) => setLine(i, { batch_number: e.target.value })} placeholder="e.g. AB1234" />
                    <TextField size="small" label="Expiry *" type="date" value={item.expiry_date}
                      error={scannedNotice && !/^\d{4}-\d{2}-\d{2}$/.test(item.expiry_date)}
                      helperText={scannedNotice && !/^\d{4}-\d{2}-\d{2}$/.test(item.expiry_date) ? 'Please verify' : ''}
                      InputLabelProps={{ shrink: true }}
                      onChange={(e) => setLine(i, { expiry_date: e.target.value })} />
                    <TextField size="small" label="Qty *" type="number" value={item.quantity}
                      error={scannedNotice && !(Number(item.quantity) > 0)}
                      helperText={scannedNotice && !(Number(item.quantity) > 0) ? 'Please verify' : ''}
                      inputProps={{ min: 1 }} onChange={(e) => setLine(i, { quantity: e.target.value })} />
                    <TextField size="small" label="Buy Price (₹) *" type="number" value={item.buy_price}
                      error={scannedNotice && !(Number(item.buy_price) >= 0 && item.buy_price !== '')}
                      helperText={scannedNotice && !(Number(item.buy_price) >= 0 && item.buy_price !== '') ? 'Please verify' : ''}
                      inputProps={{ min: 0, step: '0.01' }} onChange={(e) => setLine(i, { buy_price: e.target.value })} />
                  </Box>
                </Box>
              </Collapse>
            </Paper>
          );
        })}
        {filteredItems.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', mt: 4 }}>
            No items in this category.
          </Typography>
        )}
      </Box>
    </Box>
  );
}
