import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Card, CardContent, Typography, TextField, Button, InputAdornment,
  Avatar, Alert, MenuItem,
} from '@mui/material';
import LocalPharmacyIcon from '@mui/icons-material/LocalPharmacy';
import StorefrontIcon from '@mui/icons-material/Storefront';
import PersonIcon from '@mui/icons-material/Person';
import PhoneIcon from '@mui/icons-material/Phone';
import LockIcon from '@mui/icons-material/Lock';
import LoginIcon from '@mui/icons-material/Login';
import { api } from '../api';
import { useAuth } from '../auth';

/**
 * Self-service store registration — anyone can register a NEW pharmacy and
 * get their own fully isolated store space (own medicines, bills, khata,
 * users) with a 30-day free trial. Store owners then create staff logins
 * from Settings → Users inside the app.
 */
export default function SignUp() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [storeName, setStoreName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [phone, setPhone] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const data = await api('/api/auth/signup', {
        method: 'POST',
        body: { store_name: storeName, name: ownerName, username, password, phone },
      });
      login(data.token, data.user);
      navigate('/');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        p: 2,
        background: 'linear-gradient(135deg, #00695c 0%, #004d40 60%, #00251a 100%)',
      }}
    >
      <Card sx={{ width: 420, maxWidth: '100%', p: 1 }}>
        <CardContent sx={{ p: 3 }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', mb: 2.5 }}>
            <Avatar sx={{ bgcolor: 'primary.main', width: 64, height: 64, mb: 1.5 }}>
              <LocalPharmacyIcon sx={{ fontSize: 34 }} />
            </Avatar>
            <Typography variant="h5">MediStock</Typography>
            <Typography variant="body2" color="text.secondary">
              Register your store — free 14-day trial
            </Typography>
          </Box>

          {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

          <form onSubmit={submit}>
            <TextField
              label="Medical Store Name" fullWidth required
              value={storeName} onChange={(e) => setStoreName(e.target.value)}
              InputProps={{ startAdornment: (<InputAdornment position="start"><StorefrontIcon /></InputAdornment>) }}
              sx={{ mb: 2 }}
            />
            <TextField
              label="Owner Name" fullWidth required
              value={ownerName} onChange={(e) => setOwnerName(e.target.value)}
              InputProps={{ startAdornment: (<InputAdornment position="start"><PersonIcon /></InputAdornment>) }}
              sx={{ mb: 2 }}
            />
            <TextField
              label="Mobile Number" fullWidth
              value={phone} onChange={(e) => setPhone(e.target.value)}
              InputProps={{ startAdornment: (<InputAdornment position="start"><PhoneIcon /></InputAdornment>) }}
              sx={{ mb: 2 }}
            />
            <TextField
              label="Username (login id)" fullWidth required
              value={username} onChange={(e) => setUsername(e.target.value)}
              helperText="Pick a unique username for yourself"
              sx={{ mb: 2 }}
            />
            <TextField
              label="Password" type="password" fullWidth required
              value={password} onChange={(e) => setPassword(e.target.value)}
              helperText="At least 6 characters"
              sx={{ mb: 3 }}
            />
            <Button type="submit" variant="contained" size="large" fullWidth startIcon={<LoginIcon />} disabled={busy}>
              {busy ? 'Creating Your Store…' : 'Create Store & Start Free Trial'}
            </Button>
          </form>

          <Box sx={{ mt: 3, textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary">
              Already have an account?{' '}
            </Typography>
            <Button component="a" href="/login" variant="text" size="small">
              Sign In
            </Button>
          </Box>
        </CardContent>
      </Card>
    </Box>
  );
}
