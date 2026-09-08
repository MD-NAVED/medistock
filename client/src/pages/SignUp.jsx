import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Card, CardContent, Typography, TextField, Button, InputAdornment,
  Avatar, Alert, IconButton, Chip,
} from '@mui/material';
import LocalPharmacyIcon from '@mui/icons-material/LocalPharmacy';
import StorefrontIcon from '@mui/icons-material/Storefront';
import PersonIcon from '@mui/icons-material/Person';
import PhoneIcon from '@mui/icons-material/Phone';
import LockIcon from '@mui/icons-material/Lock';
import LoginIcon from '@mui/icons-material/Login';
import CardGiftcardIcon from '@mui/icons-material/CardGiftcard';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import { api } from '../api';
import { useAuth } from '../auth';

/**
 * Self-service store registration — anyone can register a NEW pharmacy and
 * get their own fully isolated store space (own medicines, bills, khata,
 * users) with a 14-day free trial (21 days with referral code). Store owners
 * then create staff logins from Settings → Users inside the app.
 */
export default function SignUp() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const urlRef = new URLSearchParams(window.location.search).get('ref') || '';
  const [storeName, setStoreName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [phone, setPhone] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [referralCode, setReferralCode] = useState(urlRef);
  const [refInfo, setRefInfo] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const checkCode = (code) => {
    const clean = String(code || '').trim().toUpperCase();
    if (!clean) { setRefInfo(null); return; }
    api(`/api/public/referral-check?code=${encodeURIComponent(clean)}`)
      .then((r) => { if (r.valid) setRefInfo(r); else setRefInfo(null); })
      .catch(() => setRefInfo(null));
  };

  useEffect(() => {
    if (urlRef) checkCode(urlRef);
  }, [urlRef]);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const data = await api('/api/auth/signup', {
        method: 'POST',
        body: { store_name: storeName, name: ownerName, username, password, phone, referral_code: referralCode },
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
      <Card sx={{ width: 440, maxWidth: '100%', p: 1 }}>
        <CardContent sx={{ p: 3 }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', mb: 2.5 }}>
            <Avatar sx={{ bgcolor: 'primary.main', width: 64, height: 64, mb: 1.5 }}>
              <LocalPharmacyIcon sx={{ fontSize: 34 }} />
            </Avatar>
            <Typography variant="h5">MediStock</Typography>
            <Typography variant="body2" color="text.secondary">
              Register your store — {refInfo ? '🎁 21-Day Extended Free Trial' : '14-Day Free Trial'}
            </Typography>
          </Box>

          {refInfo && (
            <Alert severity="success" icon={<CardGiftcardIcon />} sx={{ mb: 2 }}>
              🎉 <b>Referral Bonus Active!</b> Invited by <b>{refInfo.store_name}</b>. You get an extended <b>21-Day Free Trial</b>!
            </Alert>
          )}

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
              label="Password" type={showPassword ? 'text' : 'password'} fullWidth required
              value={password} onChange={(e) => setPassword(e.target.value)}
              helperText="At least 6 characters"
              InputProps={{
                startAdornment: (<InputAdornment position="start"><LockIcon /></InputAdornment>),
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton onClick={() => setShowPassword(!showPassword)} edge="end">
                      {showPassword ? <VisibilityOffIcon /> : <VisibilityIcon />}
                    </IconButton>
                  </InputAdornment>
                ),
              }}
              sx={{ mb: 2 }}
            />
            <TextField
              label="Referral Code (optional)" fullWidth
              value={referralCode}
              onChange={(e) => {
                const c = e.target.value.toUpperCase();
                setReferralCode(c);
                checkCode(c);
              }}
              placeholder="e.g. APOLLO1"
              helperText={refInfo ? `✅ Valid code from ${refInfo.store_name} (+7 bonus trial days)` : 'Got an invite from a chemist friend? Enter their code here'}
              InputProps={{ startAdornment: (<InputAdornment position="start"><CardGiftcardIcon color={refInfo ? 'success' : 'action'} /></InputAdornment>) }}
              sx={{ mb: 3 }}
            />
            <Button type="submit" variant="contained" size="large" fullWidth startIcon={<LoginIcon />} disabled={busy}>
              {busy ? 'Creating Your Store…' : `Create Store & Start Free ${refInfo ? '21-Day' : '14-Day'} Trial`}
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
