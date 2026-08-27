import { useCallback, useEffect, useState } from 'react';
import {
  Box, Typography, TextField, Button, Snackbar, Alert, Dialog,
  DialogTitle, DialogContent, DialogActions, IconButton, InputAdornment,
  Paper, useMediaQuery, CircularProgress, Tooltip,
} from '@mui/material';
import { DataGrid } from '@mui/x-data-grid';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/DeleteOutline';
import SearchIcon from '@mui/icons-material/Search';
import { api } from '../api';
import { useAuth } from '../auth';
import MedicineLogo from '../components/MedicineLogo';

const EMPTY_FORM = { name: '', aliases: '', logo_url: '' };

export default function Companies() {
  const { user } = useAuth();
  const isOwner = user.role === 'owner';
  const isMobile = useMediaQuery('(max-width:900px)');
  const [rows, setRows] = useState([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [snack, setSnack] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api('/api/companies'));
    } catch (e) {
      setSnack({ severity: 'error', message: e.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = rows.filter((c) => {
    const hay = (c.name + ' ' + (c.aliases || '')).toLowerCase();
    return hay.includes(q.toLowerCase().trim());
  });

  const openAdd = () => { setEditing(null); setForm(EMPTY_FORM); setDialogOpen(true); };
  const openEdit = (row) => {
    setEditing(row);
    setForm({ name: row.name, aliases: row.aliases || '', logo_url: row.logo_url || '' });
    setDialogOpen(true);
  };

  const save = async () => {
    try {
      if (editing) {
        await api('/api/companies/' + editing.id, { method: 'PUT', body: form });
        setSnack({ severity: 'success', message: 'Company updated' });
      } else {
        await api('/api/companies', { method: 'POST', body: form });
        setSnack({ severity: 'success', message: 'Company added' });
      }
      setDialogOpen(false);
      load();
    } catch (e) {
      setSnack({ severity: 'error', message: e.message });
    }
  };

  const confirmDelete = async () => {
    setDeleteBusy(true);
    try {
      await api('/api/companies/' + deleteTarget.id, { method: 'DELETE' });
      setSnack({ severity: 'success', message: `“${deleteTarget.name}” removed` });
      setDeleteTarget(null);
      load();
    } catch (e) {
      setSnack({ severity: 'error', message: e.message });
      setDeleteTarget(null);
    } finally {
      setDeleteBusy(false);
    }
  };

  const columns = [
    {
      field: 'name', headerName: 'Company', flex: 1.5, minWidth: 240,
      renderCell: (p) => (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, height: '100%', width: '100%', minWidth: 0 }}>
          <MedicineLogo src={p.row.logo_url} text={p.row.name} />
          <Typography sx={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.value}</Typography>
        </Box>
      ),
    },
    { field: 'aliases', headerName: 'Also matches', flex: 1, minWidth: 200, renderCell: (p) => <Typography variant="caption" color="text.secondary" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.value || '—'}</Typography> },
    ...(isOwner ? [{
      field: 'actions', headerName: '', width: 100, sortable: false, filterable: false,
      renderCell: (p) => (
        <Box>
          <Tooltip title="Edit logo / aliases">
            <IconButton size="small" onClick={() => openEdit(p.row)}><EditIcon fontSize="small" /></IconButton>
          </Tooltip>
          <Tooltip title="Remove company">
            <IconButton size="small" color="error" onClick={() => setDeleteTarget(p.row)}><DeleteIcon fontSize="small" /></IconButton>
          </Tooltip>
        </Box>
      ),
    }] : []),
  ];

  return (
    <Box>
      <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', mb: 2, flexWrap: 'wrap' }}>
        <Typography variant="h5" sx={{ flexGrow: 1, fontSize: { xs: 20, md: 24 } }}>
          Medicine Companies ({rows.length})
        </Typography>
        <TextField
          size="small" placeholder="Search company…"
          value={q} onChange={(e) => setQ(e.target.value)}
          InputProps={{ startAdornment: (<InputAdornment position="start"><SearchIcon /></InputAdornment>) }}
          sx={{ width: { xs: '100%', sm: 300 }, order: { xs: 3, sm: 0 } }}
        />
        {isOwner && (
          <Button variant="contained" startIcon={<AddIcon />} onClick={openAdd} sx={{ whiteSpace: 'nowrap' }}>
            Add Company
          </Button>
        )}
      </Box>

      <Alert severity="info" sx={{ mb: 2 }}>
        Medicines match their <b>company name</b> against this list automatically, so the brand logo
        appears on the medicine without manual entry. Add any company logo URL to expand the directory.
      </Alert>

      {isMobile ? (
        <Box>
          {loading && (<Box sx={{ display: 'flex', justifyContent: 'center', py: 5 }}><CircularProgress /></Box>)}
          {!loading && filtered.length === 0 && (<Alert severity="info">No companies found{q ? ` for “${q}”` : ''}.</Alert>)}
          {!loading && filtered.map((c) => (
            <Paper key={c.id} sx={{ p: 1.5, mb: 1.5, display: 'flex', alignItems: 'center', gap: 1.5 }}>
              <MedicineLogo src={c.logo_url} text={c.name} size={40} />
              <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                <Typography sx={{ fontWeight: 700, fontSize: 14 }}>{c.name}</Typography>
                {c.aliases && <Typography variant="caption" color="text.secondary">{c.aliases}</Typography>}
              </Box>
              {isOwner && (
                <>
                  <IconButton size="small" onClick={() => openEdit(c)}><EditIcon fontSize="small" /></IconButton>
                  <IconButton size="small" color="error" onClick={() => setDeleteTarget(c)}><DeleteIcon fontSize="small" /></IconButton>
                </>
              )}
            </Paper>
          ))}
        </Box>
      ) : (
        <Box sx={{ height: 560, bgcolor: 'background.paper', borderRadius: 2, border: '1px solid #e0e6e4' }}>
          <DataGrid
            rows={filtered} columns={columns} loading={loading}
            rowHeight={56}
            pageSizeOptions={[25, 50, 100]} initialState={{ pagination: { paginationModel: { pageSize: 25 } } }}
            disableRowSelectionOnClick sx={{ border: 'none' }}
          />
        </Box>
      )}

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{editing ? 'Edit Company' : 'Add Company'}</DialogTitle>
        <DialogContent sx={{ pt: '8px !important' }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <MedicineLogo src={form.logo_url} text={form.name || 'C'} size={48} />
              <Typography variant="caption" color="text.secondary">
                Logo preview — clears to a letter if the image can't load.
              </Typography>
            </Box>
            <TextField label="Company Name *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <TextField
              label="Aliases (comma-separated)"
              value={form.aliases}
              onChange={(e) => setForm({ ...form, aliases: e.target.value })}
              helperText="Other spellings, e.g. for 'Johnson & Johnson' add 'J&J'"
            />
            <TextField
              label="Logo Image URL"
              value={form.logo_url}
              onChange={(e) => setForm({ ...form, logo_url: e.target.value })}
              placeholder="https://…"
            />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={save} disabled={!form.name.trim()}>
            {editing ? 'Save Changes' : 'Add Company'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)} maxWidth="xs" fullWidth>
        {deleteTarget && (
          <>
            <DialogTitle>Remove “{deleteTarget.name}”?</DialogTitle>
            <DialogContent>
              <Typography variant="body2" color="text.secondary">
                Medicines that already have this logo keep it, but future matches for this company
                will fall back to a letter avatar.
              </Typography>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setDeleteTarget(null)} disabled={deleteBusy}>Keep it</Button>
              <Button color="error" variant="contained" onClick={confirmDelete} disabled={deleteBusy}>
                {deleteBusy ? 'Removing…' : 'Remove'}
              </Button>
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