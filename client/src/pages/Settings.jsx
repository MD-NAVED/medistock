import { useEffect, useState } from 'react';
import {
  Box, Typography, Paper, Tabs, Tab, TextField, Button, Switch,
  FormControlLabel, Divider, Snackbar, Alert, Dialog, DialogTitle,
  DialogContent, DialogActions, MenuItem, Chip, IconButton, Tooltip,
  useMediaQuery,
} from '@mui/material';
import PersonAddIcon from '@mui/icons-material/PersonAdd';
import SaveIcon from '@mui/icons-material/Save';
import BlockIcon from '@mui/icons-material/Block';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import LockResetIcon from '@mui/icons-material/LockReset';
import KeyIcon from '@mui/icons-material/Key';
import CloudDoneIcon from '@mui/icons-material/CloudDone';
import { api } from '../api';
import { useAuth } from '../auth';
import { fmtDateTime } from '../utils';

export default function Settings() {
  const { user } = useAuth();
  const isMobile = useMediaQuery('(max-width:900px)');
  const [tab, setTab] = useState(0);
  const [store, setStore] = useState(null);
  const [users, setUsers] = useState([]);
  const [snack, setSnack] = useState(null);
  const [userDialog, setUserDialog] = useState(false);
  const [nu, setNu] = useState({ name: '', username: '', password: '', role: 'employee' });

  // password change (own account)
  const [pwDialog, setPwDialog] = useState(false);
  const [pw, setPw] = useState({ current_password: '', new_password: '', confirm: '' });
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState('');

  // owner resetting someone else's password
  const [resetTarget, setResetTarget] = useState(null);
  const [resetPw, setResetPw] = useState('');
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState('');

  useEffect(() => {
    api('/api/settings').then(setStore).catch((e) => setSnack({ severity: 'error', message: e.message }));
    loadUsers();
  }, []);

  const loadUsers = () => api('/api/users').then(setUsers).catch(() => {});

  const saveStore = async () => {
    try {
      const s = await api('/api/settings', { method: 'PUT', body: store });
      setStore(s);
      setSnack({ severity: 'success', message: 'Store settings saved' });
    } catch (e) {
      setSnack({ severity: 'error', message: e.message });
    }
  };

  const addUser = async () => {
    try {
      await api('/api/users', { method: 'POST', body: nu });
      setSnack({ severity: 'success', message: `User "${nu.name}" added` });
      setUserDialog(false);
      setNu({ name: '', username: '', password: '', role: 'employee' });
      loadUsers();
    } catch (e) {
      setSnack({ severity: 'error', message: e.message });
    }
  };

  const toggleActive = async (u) => {
    try {
      await api('/api/users/' + u.id, { method: 'PUT', body: { active: !u.active } });
      setSnack({
        severity: 'success',
        message: u.active ? `${u.name} deactivated and signed out everywhere` : `${u.name} reactivated`,
      });
      loadUsers();
    } catch (e) {
      setSnack({ severity: 'error', message: e.message });
    }
  };

  const changeOwnPassword = async () => {
    setPwBusy(true);
    setPwError('');
    try {
      await api('/api/auth/change-password', {
        method: 'POST',
        body: { current_password: pw.current_password, new_password: pw.new_password },
      });
      setPwDialog(false);
      setPw({ current_password: '', new_password: '', confirm: '' });
      setSnack({ severity: 'success', message: 'Password changed. Your other devices were signed out.' });
    } catch (e) {
      setPwError(e.message);
    } finally {
      setPwBusy(false);
    }
  };

  const resetUserPassword = async () => {
    setResetBusy(true);
    setResetError('');
    try {
      await api(`/api/users/${resetTarget.id}/reset-password`, {
        method: 'POST', body: { new_password: resetPw },
      });
      setSnack({
        severity: 'success',
        message: `Password reset for ${resetTarget.name}. They must log in again with the new password.`,
      });
      setResetTarget(null);
      setResetPw('');
    } catch (e) {
      setResetError(e.message);
    } finally {
      setResetBusy(false);
    }
  };

  if (!store) return null;

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: { xs: 2, md: 3 }, fontSize: { xs: 20, md: 24 } }}>Settings</Typography>

      <Paper sx={{ mb: 3 }}>
        <Tabs value={tab} onChange={(e, v) => setTab(v)} variant={isMobile ? 'scrollable' : 'standard'} scrollButtons="auto">
          <Tab label="🏪 Store" />
          <Tab label={`👥 Users (${users.length})`} />
          <Tab label="🔐 Security" />
        </Tabs>
      </Paper>

      {tab === 0 && (
        <Paper sx={{ p: { xs: 2, md: 4 }, maxWidth: 720 }}>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2.5 }}>
            <TextField label="Store Name" value={store.store_name} onChange={(e) => setStore({ ...store, store_name: e.target.value })} />
            <TextField label="Phone" value={store.phone} onChange={(e) => setStore({ ...store, phone: e.target.value })} />
            <TextField label="Address" value={store.store_address} onChange={(e) => setStore({ ...store, store_address: e.target.value })} sx={{ gridColumn: { sm: '1 / -1' } }} />
            <TextField label="Drug License No." value={store.license_number} onChange={(e) => setStore({ ...store, license_number: e.target.value })} />
            <Box sx={{ border: '1px solid #e0e6e4', borderRadius: 2, p: 2 }}>
              <FormControlLabel
                control={<Switch checked={!!store.gst_enabled} onChange={(e) => setStore({ ...store, gst_enabled: e.target.checked })} />}
                label={<Typography sx={{ fontWeight: 600 }}>GST billing enabled</Typography>}
              />
              <Typography variant="caption" color="text.secondary">
                When ON, each medicine's GST % is added on top of the price on every bill.
              </Typography>
              {store.gst_enabled && (
                <TextField label="GSTIN Number" size="small" fullWidth value={store.gst_number} onChange={(e) => setStore({ ...store, gst_number: e.target.value })} sx={{ mt: 2 }} />
              )}
            </Box>
          </Box>
          <Button variant="contained" startIcon={<SaveIcon />} onClick={saveStore} sx={{ mt: 3 }}>
            Save Settings
          </Button>
        </Paper>
      )}

      {tab === 1 && (
        <Paper sx={{ p: { xs: 2, md: 3 }, maxWidth: 720 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', mb: 2, gap: 1, flexWrap: 'wrap' }}>
            <Typography variant="body2" color="text.secondary" sx={{ flexGrow: 1, minWidth: 200 }}>
              Owners have full access. Employees can do billing and purchases but cannot change settings, prices or users.
            </Typography>
            <Button variant="contained" size="small" startIcon={<PersonAddIcon />} onClick={() => setUserDialog(true)}>
              Add User
            </Button>
          </Box>
          <Divider sx={{ mb: 1 }} />
          {users.map((u) => (
            <Box key={u.id} sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 1.5, borderBottom: '1px solid #f0f0f0', flexWrap: 'wrap' }}>
              <Box sx={{ flexGrow: 1, minWidth: 150 }}>
                <Typography sx={{ fontWeight: 600 }}>
                  {u.name} <Typography component="span" variant="caption" color="text.secondary">(@{u.username})</Typography>
                  {!u.active && <Chip size="small" color="error" label="Inactive" sx={{ ml: 1 }} />}
                </Typography>
                <Typography variant="caption" color="text.secondary">joined {fmtDateTime(u.created_at)}</Typography>
              </Box>
              <Chip size="small" color={u.role === 'owner' ? 'primary' : 'default'} variant={u.role === 'owner' ? 'filled' : 'outlined'} label={u.role === 'owner' ? '👑 Owner' : 'Employee'} />
              <Tooltip title="Reset this user's password">
                <IconButton size="small" onClick={() => { setResetTarget(u); setResetPw(''); setResetError(''); }}>
                  <LockResetIcon />
                </IconButton>
              </Tooltip>
              <Tooltip title={u.id === user.id ? 'You cannot deactivate yourself' : (u.active ? 'Deactivate user' : 'Activate user')}>
                <span>
                  <IconButton size="small" color={u.active ? 'success' : 'error'} onClick={() => toggleActive(u)} disabled={u.id === user.id}>
                    {u.active ? <CheckCircleIcon /> : <BlockIcon />}
                  </IconButton>
                </span>
              </Tooltip>
            </Box>
          ))}
        </Paper>
      )}

      {tab === 2 && (
        <Box sx={{ display: 'grid', gap: 3, maxWidth: 720 }}>
          <Paper sx={{ p: { xs: 2, md: 3 } }}>
            <Typography variant="h6" sx={{ mb: 1 }}>Your password</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Signed in as <b>{user.name}</b> (@{user.username}). Changing your password signs you
              out on every other device.
            </Typography>
            <Button variant="contained" startIcon={<KeyIcon />} onClick={() => { setPw({ current_password: '', new_password: '', confirm: '' }); setPwError(''); setPwDialog(true); }}>
              Change my password
            </Button>
          </Paper>

          <Paper sx={{ p: { xs: 2, md: 3 } }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
              <CloudDoneIcon color="success" />
              <Typography variant="h6">Database backups</Typography>
            </Box>
            <Typography variant="body2" color="text.secondary">
              Your data lives in a managed cloud database (Supabase). Backups are handled by the
              database provider, so there is nothing to run from this page. For extra safety you
              can export a copy of your data from the Supabase dashboard (Database → Backups,
              or a CSV export of each table) whenever you want an off-site copy.
            </Typography>
          </Paper>

          <Paper sx={{ p: { xs: 2, md: 3 } }}>
            <Typography variant="h6" sx={{ mb: 1 }}>How this install is protected</Typography>
            <Typography variant="body2" color="text.secondary" component="div">
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                <li>Passwords are stored with scrypt salted hashing, never in readable form.</li>
                <li>Login sessions live in the database, so a server restart does not sign everyone out.</li>
                <li>After 8 wrong passwords for one username, that username is locked for 15 minutes.</li>
                <li>Deactivating a user immediately ends their open sessions.</li>
              </ul>
            </Typography>
            <Alert severity="info" sx={{ mt: 2 }}>
              Traffic is served over <b>HTTPS</b> by the hosting platform. Keep your Supabase
              login safe — anyone with it can reach the database directly.
            </Alert>
          </Paper>
        </Box>
      )}

      {/* Change own password */}
      <Dialog open={pwDialog} onClose={() => setPwDialog(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Change my password</DialogTitle>
        <DialogContent sx={{ pt: '8px !important' }}>
          {pwError && <Alert severity="error" sx={{ mb: 2 }}>{pwError}</Alert>}
          <Box sx={{ display: 'grid', gap: 2, mt: 1 }}>
            <TextField label="Current password" type="password" autoFocus
              value={pw.current_password} onChange={(e) => setPw({ ...pw, current_password: e.target.value })} />
            <TextField label="New password" type="password" helperText="At least 6 characters"
              value={pw.new_password} onChange={(e) => setPw({ ...pw, new_password: e.target.value })} />
            <TextField label="Confirm new password" type="password"
              error={!!pw.confirm && pw.confirm !== pw.new_password}
              helperText={pw.confirm && pw.confirm !== pw.new_password ? 'Passwords do not match' : ' '}
              value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPwDialog(false)} disabled={pwBusy}>Cancel</Button>
          <Button variant="contained" onClick={changeOwnPassword}
            disabled={pwBusy || !pw.current_password || pw.new_password.length < 6 || pw.new_password !== pw.confirm}>
            {pwBusy ? 'Saving…' : 'Change password'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Owner resets another user's password */}
      <Dialog open={!!resetTarget} onClose={() => setResetTarget(null)} maxWidth="xs" fullWidth>
        {resetTarget && (
          <>
            <DialogTitle>Reset password for {resetTarget.name}</DialogTitle>
            <DialogContent sx={{ pt: '8px !important' }}>
              {resetError && <Alert severity="error" sx={{ mb: 2 }}>{resetError}</Alert>}
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Set a new password and tell it to {resetTarget.name} directly. They will be signed
                out everywhere and must log in again.
              </Typography>
              <TextField label="New password" type="text" fullWidth autoFocus
                helperText="At least 6 characters. Ask them to change it after logging in."
                value={resetPw} onChange={(e) => setResetPw(e.target.value)} />
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setResetTarget(null)} disabled={resetBusy}>Cancel</Button>
              <Button variant="contained" color="warning" onClick={resetUserPassword}
                disabled={resetBusy || resetPw.length < 6}>
                {resetBusy ? 'Resetting…' : 'Reset password'}
              </Button>
            </DialogActions>
          </>
        )}
      </Dialog>

      <Dialog open={userDialog} onClose={() => setUserDialog(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Add User</DialogTitle>
        <DialogContent sx={{ pt: '8px !important' }}>
          <Box sx={{ display: 'grid', gap: 2, mt: 1 }}>
            <TextField label="Full Name" value={nu.name} onChange={(e) => setNu({ ...nu, name: e.target.value })} />
            <TextField label="Username" value={nu.username} onChange={(e) => setNu({ ...nu, username: e.target.value })} />
            <TextField label="Password" type="password" value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} />
            <TextField select label="Role" value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value })}>
              <MenuItem value="employee">Employee — billing & purchases</MenuItem>
              <MenuItem value="owner">Owner — full access</MenuItem>
            </TextField>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setUserDialog(false)}>Cancel</Button>
          <Button variant="contained" onClick={addUser} disabled={!nu.name.trim() || !nu.username.trim() || nu.password.length < 5}>
            Add User
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={!!snack} autoHideDuration={4000} onClose={() => setSnack(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        {snack && <Alert severity={snack.severity} onClose={() => setSnack(null)} sx={{ width: '100%' }}>{snack.message}</Alert>}
      </Snackbar>
    </Box>
  );
}
