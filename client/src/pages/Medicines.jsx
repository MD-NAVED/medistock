import { useCallback, useEffect, useState } from 'react';
import {
  Box, Typography, TextField, Button, Chip, Snackbar, Alert, Dialog,
  DialogTitle, DialogContent, DialogActions, MenuItem, IconButton, InputAdornment,
  Paper, Divider, useMediaQuery, CircularProgress, Tooltip,
} from '@mui/material';
import { DataGrid } from '@mui/x-data-grid';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import SearchIcon from '@mui/icons-material/Search';
import DeleteIcon from '@mui/icons-material/DeleteOutline';
import InventoryIcon from '@mui/icons-material/Inventory2';
import { api } from '../api';
import { useAuth } from '../auth';
import BatchDialog from '../components/BatchDialog';
import { fmt, MEDICINE_TYPES, GST_RATES } from '../utils';

const EMPTY_FORM = {
  name: '', company: '', type: 'Tablet', shelf: '',
  buy_price: '', sell_price: '', gst_rate: 12, low_stock_threshold: 10,
};

function stockColor(stock, threshold) {
  if (stock <= 0) return 'error';
  return stock <= threshold ? 'warning' : 'success';
}

/** Mobile view: one card per medicine so nothing needs sideways scrolling. */
function MedicineCard({ row, isOwner, onEdit, onBatches, onDelete }) {
  return (
    <Paper sx={{ p: 2, mb: 1.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography sx={{ fontWeight: 700, fontSize: 15, lineHeight: 1.3 }}>{row.name}</Typography>
          <Typography variant="caption" color="text.secondary">
            {row.company} · {row.type}{row.shelf ? ' · Shelf ' + row.shelf : ''}
          </Typography>
        </Box>
        {isOwner && (
          <>
            <IconButton size="small" onClick={() => onEdit(row)} aria-label={'Edit ' + row.name}>
              <EditIcon fontSize="small" />
            </IconButton>
            <IconButton size="small" color="error" onClick={() => onDelete(row)} aria-label={'Remove ' + row.name}>
              <DeleteIcon fontSize="small" />
            </IconButton>
          </>
        )}
      </Box>

      <Divider sx={{ my: 1.2 }} />

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Chip
          size="small"
          label={row.stock <= 0 ? 'Out of stock' : row.stock + ' units'}
          color={stockColor(row.stock, row.low_stock_threshold)}
          variant={row.stock <= row.low_stock_threshold ? 'filled' : 'outlined'}
        />
        <Typography variant="caption" color="text.secondary">alert at ≤ {row.low_stock_threshold}</Typography>
        <Button size="small" startIcon={<InventoryIcon />} onClick={() => onBatches(row)} sx={{ ml: 'auto' }}>
          Batches
        </Button>
      </Box>

      <Box sx={{ display: 'flex', gap: 3, mt: 1.2 }}>
        <Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>Buy</Typography>
          <Typography sx={{ fontSize: 14, fontWeight: 600 }}>{fmt(row.buy_price)}</Typography>
        </Box>
        <Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>Sell</Typography>
          <Typography sx={{ fontSize: 14, fontWeight: 700, color: 'primary.main' }}>{fmt(row.sell_price)}</Typography>
        </Box>
        <Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>GST</Typography>
          <Typography sx={{ fontSize: 14, fontWeight: 600 }}>{row.gst_rate}%</Typography>
        </Box>
      </Box>
    </Paper>
  );
}

export default function Medicines() {
  const { user } = useAuth();
  const isOwner = user.role === 'owner';
  const isMobile = useMediaQuery('(max-width:900px)');
  const [rows, setRows] = useState([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState(null); // medicine row being edited
  const [form, setForm] = useState(EMPTY_FORM);
  const [snack, setSnack] = useState(null); // {severity, message}
  const [batchFor, setBatchFor] = useState(null); // medicine whose batches are open
  const [deleteTarget, setDeleteTarget] = useState(null); // medicine pending removal
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  const load = useCallback(async (query) => {
    setLoading(true);
    try {
      setRows(await api('/api/medicines?q=' + encodeURIComponent(query)));
    } catch (e) {
      setSnack({ severity: 'error', message: e.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => load(q), 350); // debounce search
    return () => clearTimeout(t);
  }, [q, load]);

  const openAdd = () => { setEditing(null); setForm(EMPTY_FORM); setDialogOpen(true); };
  const openEdit = (row) => {
    setEditing(row);
    setForm({
      name: row.name, company: row.company, type: row.type, shelf: row.shelf,
      buy_price: row.buy_price, sell_price: row.sell_price,
      gst_rate: row.gst_rate, low_stock_threshold: row.low_stock_threshold,
    });
    setDialogOpen(true);
  };

  const save = async () => {
    try {
      if (editing) {
        await api('/api/medicines/' + editing.id, { method: 'PUT', body: form });
        setSnack({ severity: 'success', message: 'Medicine updated' });
      } else {
        const r = await api('/api/medicines', { method: 'POST', body: form });
        setSnack({
          severity: 'success',
          message: r.restored
            ? 'This medicine was removed earlier — it has been restored to the catalog'
            : 'Medicine added to catalog',
        });
      }
      setDialogOpen(false);
      load(q);
    } catch (e) {
      setSnack({ severity: 'error', message: e.message });
    }
  };

  const askDelete = (row) => { setDeleteTarget(row); setDeleteError(''); };

  const confirmDelete = async (force) => {
    setDeleteBusy(true);
    setDeleteError('');
    try {
      await api('/api/medicines/' + deleteTarget.id + (force ? '?force=1' : ''), { method: 'DELETE' });
      setSnack({ severity: 'success', message: `“${deleteTarget.name}” removed from the catalog` });
      setDeleteTarget(null);
      load(q);
    } catch (e) {
      setDeleteError(e.message);
    } finally {
      setDeleteBusy(false);
    }
  };

  const columns = [
    {
      field: 'name', headerName: 'Medicine', flex: 1.4, minWidth: 220,
      renderCell: (p) => (
        <Box sx={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', height: '100%' }}>
          <Typography sx={{ fontSize: 14, fontWeight: 600, lineHeight: 1.3 }}>{p.value}</Typography>
          <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.3 }}>{p.row.company}</Typography>
        </Box>
      ),
    },
    { field: 'type', headerName: 'Type', width: 110, renderCell: (p) => <Chip size="small" variant="outlined" label={p.value} /> },
    { field: 'shelf', headerName: 'Shelf', width: 90 },
    {
      field: 'stock', headerName: 'Stock', width: 110, type: 'number',
      renderCell: (p) => (
        <Chip
          size="small"
          label={p.value + ' units'}
          color={p.value <= 0 ? 'error' : p.value <= p.row.low_stock_threshold ? 'warning' : 'success'}
          variant={p.value <= p.row.low_stock_threshold ? 'filled' : 'outlined'}
        />
      ),
    },
    { field: 'buy_price', headerName: 'Buy', width: 100, type: 'number', valueFormatter: (value) => fmt(value) },
    { field: 'sell_price', headerName: 'Sell', width: 100, type: 'number', valueFormatter: (value) => fmt(value) },
    { field: 'gst_rate', headerName: 'GST %', width: 80, type: 'number' },
    { field: 'low_stock_threshold', headerName: 'Alert At', width: 90, type: 'number' },
    {
      field: 'batches', headerName: 'Batches', width: 110, sortable: false, filterable: false,
      renderCell: (p) => (
        <Button size="small" startIcon={<InventoryIcon />} onClick={() => setBatchFor(p.row)}>
          View
        </Button>
      ),
    },
    ...(isOwner ? [{
      field: 'actions', headerName: '', width: 100, sortable: false, filterable: false,
      renderCell: (p) => (
        <Box>
          <Tooltip title="Edit details">
            <IconButton size="small" onClick={() => openEdit(p.row)}><EditIcon fontSize="small" /></IconButton>
          </Tooltip>
          <Tooltip title="Remove from catalog">
            <IconButton size="small" color="error" onClick={() => askDelete(p.row)}>
              <DeleteIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
      ),
    }] : []),
  ];

  return (
    <Box>
      <Box sx={{ display: 'flex', gap: { xs: 1.5, md: 2 }, alignItems: 'center', mb: 2, flexWrap: 'wrap' }}>
        <Typography variant="h5" sx={{ flexGrow: 1, fontSize: { xs: 20, md: 24 } }}>
          Medicines ({rows.length})
        </Typography>
        <TextField
          size="small" placeholder="Search name or company…"
          value={q} onChange={(e) => setQ(e.target.value)}
          InputProps={{ startAdornment: (<InputAdornment position="start"><SearchIcon /></InputAdornment>) }}
          sx={{ width: { xs: '100%', sm: 300 }, order: { xs: 3, sm: 0 } }}
        />
        {isOwner && (
          <Button variant="contained" startIcon={<AddIcon />} onClick={openAdd} sx={{ whiteSpace: 'nowrap' }}>
            Add
          </Button>
        )}
      </Box>

      {isMobile ? (
        <Box>
          {loading && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 5 }}><CircularProgress /></Box>
          )}
          {!loading && rows.length === 0 && (
            <Alert severity="info">No medicines found{q ? ` for “${q}”` : ''}.</Alert>
          )}
          {!loading && rows.map((row) => (
            <MedicineCard
              key={row.id} row={row} isOwner={isOwner}
              onEdit={openEdit} onBatches={setBatchFor} onDelete={askDelete}
            />
          ))}
        </Box>
      ) : (
        <Box sx={{ height: 620, bgcolor: 'background.paper', borderRadius: 2, border: '1px solid #e0e6e4' }}>
          <DataGrid
            rows={rows} columns={columns} loading={loading}
            rowHeight={62}
            pageSizeOptions={[25, 50, 100]} initialState={{ pagination: { paginationModel: { pageSize: 25 } } }}
            disableRowSelectionOnClick sx={{ border: 'none' }}
          />
        </Box>
      )}

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{editing ? 'Edit Medicine' : 'Add Medicine to Catalog'}</DialogTitle>
        <DialogContent sx={{ pt: '8px !important' }}>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2, mt: 1 }}>
            <TextField label="Medicine Name *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <TextField label="Company *" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
            <TextField select label="Type" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              {MEDICINE_TYPES.map((t) => <MenuItem key={t} value={t}>{t}</MenuItem>)}
            </TextField>
            <TextField label="Shelf Location (e.g. A1)" value={form.shelf} onChange={(e) => setForm({ ...form, shelf: e.target.value })} />
            <TextField label="Buy Price (₹)" type="number" inputProps={{ min: 0, step: '0.01' }} value={form.buy_price} onChange={(e) => setForm({ ...form, buy_price: e.target.value })} />
            <TextField label="Sell Price (₹) *" type="number" inputProps={{ min: 0, step: '0.01' }} value={form.sell_price} onChange={(e) => setForm({ ...form, sell_price: e.target.value })} />
            <TextField select label="GST Rate %" value={form.gst_rate} onChange={(e) => setForm({ ...form, gst_rate: e.target.value })}>
              {GST_RATES.map((r) => <MenuItem key={r} value={r}>{r}%</MenuItem>)}
            </TextField>
            <TextField label="Low Stock Alert At" type="number" inputProps={{ min: 0 }} value={form.low_stock_threshold} onChange={(e) => setForm({ ...form, low_stock_threshold: e.target.value })} />
          </Box>
          <Alert severity="info" sx={{ mt: 2 }}>
            Stock is added via <b>Purchases</b> (stock in) and reduced automatically by <b>Billing</b> (stock out).
          </Alert>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={save} disabled={!form.name.trim() || !form.company.trim() || Number(form.sell_price) <= 0}>
            {editing ? 'Save Changes' : 'Add Medicine'}
          </Button>
        </DialogActions>
      </Dialog>

      {batchFor && (
        <BatchDialog
          medicineId={batchFor.id}
          onClose={() => setBatchFor(null)}
          onChanged={(msg) => { setSnack({ severity: 'success', message: msg }); load(q); }}
        />
      )}

      {/* Remove from catalog — soft delete, so sales history stays intact */}
      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)} maxWidth="xs" fullWidth>
        {deleteTarget && (
          <>
            <DialogTitle>Remove “{deleteTarget.name}”?</DialogTitle>
            <DialogContent>
              {deleteError && <Alert severity="warning" sx={{ mb: 2 }}>{deleteError}</Alert>}
              <Typography variant="body2" color="text.secondary">
                It disappears from the catalog and from billing search. Past bills that include it
                stay unchanged, and adding the same name + company again restores it.
              </Typography>
              {deleteTarget.stock > 0 && (
                <Alert severity="error" sx={{ mt: 2 }}>
                  This medicine still has <b>{deleteTarget.stock} units</b> in stock. Normally you
                  should sell it or write it off first.
                </Alert>
              )}
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setDeleteTarget(null)} disabled={deleteBusy}>Keep it</Button>
              {deleteError ? (
                <Button color="error" variant="contained" onClick={() => confirmDelete(true)} disabled={deleteBusy}>
                  {deleteBusy ? 'Removing…' : 'Remove anyway'}
                </Button>
              ) : (
                <Button color="error" variant="contained" onClick={() => confirmDelete(false)} disabled={deleteBusy}>
                  {deleteBusy ? 'Removing…' : 'Remove'}
                </Button>
              )}
            </DialogActions>
          </>
        )}
      </Dialog>

      <Snackbar open={!!snack} autoHideDuration={5000} onClose={() => setSnack(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        {snack && <Alert severity={snack.severity} onClose={() => setSnack(null)} sx={{ width: '100%' }}>{snack.message}</Alert>}
      </Snackbar>
    </Box>
  );
}
