import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Card, CardContent, Typography, TextField, Button, InputAdornment,
  Avatar, Alert,
} from '@mui/material';
import LocalPharmacyIcon from '@mui/icons-material/LocalPharmacy';
import PersonIcon from '@mui/icons-material/Person';
import LockIcon from '@mui/icons-material/Lock';
import LoginIcon from '@mui/icons-material/Login';
import { api } from '../api';
import { useAuth } from '../auth';

export default function SignUp() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
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
        body: { name, username, password }
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
      <Card sx={{ width: 400, maxWidth: '100%', p: 1 }}>
        <CardContent sx={{ p: 3 }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', mb: 3 }}>
            <Avatar sx={{ bgcolor: 'primary.main', width: 64, height: 64, mb: 1.5 }}>
              <LocalPharmacyIcon sx={{ fontSize: 34 }} />
            </Avatar>
            <Typography variant="h5">MediStock</Typography>
            <Typography variant="body2" color="text.secondary">Create Admin Account</Typography>
          </Box>

          {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

          <form onSubmit={submit}>
            <TextField
              label="Store Owner Name" fullWidth required autoFocus
              value={name} onChange={(e) => setName(e.target.value)}
              InputProps={{ startAdornment: (<InputAdornment position="start"><PersonIcon /></InputAdornment>) }}
              sx={{ mb: 2 }}
            />
            <TextField
              label="Username" fullWidth required
              value={username} onChange={(e) => setUsername(e.target.value)}
              InputProps={{ startAdornment: (<InputAdornment position="start"><PersonIcon /></InputAdornment>) }}
              sx={{ mb: 2 }}
            />
            <TextField
              label="Password" type="password" fullWidth required
              value={password} onChange={(e) => setPassword(e.target.value)}
              InputProps={{ startAdornment: (<InputAdornment position="start"><LockIcon /></InputAdornment>) }}
              sx={{ mb: 3 }}
            />
            <Button type="submit" variant="contained" size="large" fullWidth startIcon={<LoginIcon />} disabled={busy}>
              {busy ? 'Creating Account…' : 'Create Admin Account'}
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