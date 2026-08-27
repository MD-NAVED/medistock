import { useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  AppBar, Toolbar, Typography, IconButton, Box, Chip, Badge, Drawer, Divider,
  List, ListItemButton, ListItemIcon, ListItemText, Tooltip, Avatar,
  Dialog, DialogTitle, DialogContent, DialogActions, Button,
} from '@mui/material';
import MenuIcon from '@mui/icons-material/Menu';
import LocalPharmacyIcon from '@mui/icons-material/LocalPharmacy';
import LogoutIcon from '@mui/icons-material/Logout';
import SpaceDashboardIcon from '@mui/icons-material/SpaceDashboard';
import PointOfSaleIcon from '@mui/icons-material/PointOfSale';
import MedicationIcon from '@mui/icons-material/Medication';
import FactoryIcon from '@mui/icons-material/Factory';
import ShoppingCartIcon from '@mui/icons-material/ShoppingCart';
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive';
import BarChartIcon from '@mui/icons-material/BarChart';
import SettingsIcon from '@mui/icons-material/Settings';
import InstallMobileIcon from '@mui/icons-material/InstallMobile';
import MenuBookIcon from '@mui/icons-material/MenuBook';
import { api } from '../api';
import { useAuth } from '../auth';

const DRAWER_WIDTH = 248;

export default function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [storeName, setStoreName] = useState('');
  const [alertCount, setAlertCount] = useState(0);
  const [installEvt, setInstallEvt] = useState(null);
  const [isStandalone, setIsStandalone] = useState(false);
  const [showInstallGuide, setShowInstallGuide] = useState(false);

  // PWA install: detect standalone mode and capture install prompt event.
  useEffect(() => {
    const standalone = window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
    setIsStandalone(standalone);
    if (standalone) return undefined;

    const onPrompt = (e) => { e.preventDefault(); setInstallEvt(e); };
    const onInstalled = () => { setInstallEvt(null); setIsStandalone(true); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const handleInstallClick = async () => {
    if (installEvt) {
      installEvt.prompt();
      const choice = await installEvt.userChoice;
      if (choice?.outcome === 'accepted') {
        setInstallEvt(null);
        setIsStandalone(true);
      }
    } else {
      setShowInstallGuide(true);
    }
  };

  useEffect(() => {
    api('/api/settings').then((s) => setStoreName(s.store_name)).catch(() => {});
    api('/api/alerts').then((a) => setAlertCount(a.counts.low + a.counts.expiring)).catch(() => {});
  }, [location.pathname]);

  const nav = [
    { label: 'Dashboard', icon: <SpaceDashboardIcon />, to: '/' },
    { label: 'Billing (New Sale)', icon: <PointOfSaleIcon />, to: '/billing' },
    { label: 'Credit Book (Khata)', icon: <MenuBookIcon />, to: '/khata' },
    { label: 'Medicines', icon: <MedicationIcon />, to: '/medicines' },
    ...(user.role === 'owner' ? [{ label: 'Companies', icon: <FactoryIcon />, to: '/companies' }] : []),
    { label: 'Purchases (Stock In)', icon: <ShoppingCartIcon />, to: '/purchases' },
    { label: 'Alerts', icon: <NotificationsActiveIcon />, to: '/alerts', badge: alertCount },
    { label: 'Reports', icon: <BarChartIcon />, to: '/reports' },
    ...(user.role === 'owner' ? [{ label: 'Settings', icon: <SettingsIcon />, to: '/settings' }] : []),
  ];

  const doLogout = async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    logout();
    navigate('/login');
  };

  const drawer = (
    <Box>
      <Toolbar sx={{ px: 2 }}>
        <LocalPharmacyIcon sx={{ color: 'primary.main', mr: 1, fontSize: 30 }} />
        <Box>
          <Typography sx={{ fontWeight: 800, letterSpacing: 0.5, lineHeight: 1.1 }}>MediStock</Typography>
          <Typography variant="caption" color="text.secondary">Pharmacy Manager</Typography>
        </Box>
      </Toolbar>
      <Divider />
      <List sx={{ px: 1.5, py: 1 }}>
        {nav.map((item) => {
          const active = location.pathname === item.to;
          const button = (
            <ListItemButton
              key={item.to}
              onClick={() => { navigate(item.to); setMobileOpen(false); }}
              selected={active}
              sx={{ borderRadius: 2, mb: 0.5, '&.Mui-selected': { bgcolor: 'primary.main', color: '#fff', '&:hover': { bgcolor: 'primary.dark' }, '& .MuiListItemIcon-root': { color: '#fff' } } }}
            >
              <ListItemIcon sx={{ minWidth: 40 }}>
                {item.badge
                  ? <Badge badgeContent={item.badge} color="error"><NotificationsActiveIcon /></Badge>
                  : item.icon}
              </ListItemIcon>
              <ListItemText primary={item.label} primaryTypographyProps={{ fontSize: 14, fontWeight: active ? 700 : 500 }} />
            </ListItemButton>
          );
          return button;
        })}

        {!isStandalone && (
          <>
            <Divider sx={{ my: 1 }} />
            <ListItemButton
              onClick={() => { setMobileOpen(false); handleInstallClick(); }}
              sx={{ borderRadius: 2, bgcolor: '#e0f2f1', color: '#004d40', '&:hover': { bgcolor: '#b2dfdb' } }}
            >
              <ListItemIcon sx={{ minWidth: 40, color: '#004d40' }}>
                <InstallMobileIcon />
              </ListItemIcon>
              <ListItemText primary="Install App (Download)" primaryTypographyProps={{ fontSize: 14, fontWeight: 700 }} />
            </ListItemButton>
          </>
        )}
      </List>
    </Box>
  );

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
      <AppBar position="fixed" color="inherit" sx={{ zIndex: (t) => t.zIndex.drawer + 1, borderBottom: '1px solid #e0e6e4' }}>
        <Toolbar>
          <IconButton edge="start" sx={{ mr: 1, display: { sm: 'none' } }} onClick={() => setMobileOpen(!mobileOpen)}>
            <MenuIcon />
          </IconButton>
          <LocalPharmacyIcon sx={{ display: { xs: 'none', sm: 'block' }, color: 'primary.main', mr: 1 }} />
          <Typography variant="h6" sx={{ flexGrow: 1, fontSize: { xs: 16, sm: 20 } }}>
            {storeName || 'MediStock'}
          </Typography>
          {!isStandalone && (
            <Tooltip title="Install MediStock as an App on this device">
              <IconButton
                color="primary"
                onClick={handleInstallClick}
                sx={{ mr: 1, bgcolor: '#e0f2f1', color: '#004d40', '&:hover': { bgcolor: '#b2dfdb' } }}
              >
                <InstallMobileIcon />
              </IconButton>
            </Tooltip>
          )}
          <Chip
            size="small"
            color={user.role === 'owner' ? 'primary' : 'default'}
            variant={user.role === 'owner' ? 'filled' : 'outlined'}
            label={user.role === 'owner' ? 'Owner' : 'Staff'}
            sx={{ mr: 1.5 }}
          />
          <Tooltip title={user.name}>
            <Avatar sx={{ width: 32, height: 32, bgcolor: 'primary.main', fontSize: 14, mr: 1 }}>
              {user.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()}
            </Avatar>
          </Tooltip>
          <Tooltip title="Logout">
            <IconButton onClick={doLogout} color="error"><LogoutIcon /></IconButton>
          </Tooltip>
        </Toolbar>
      </AppBar>

      <Drawer
        variant="temporary"
        open={mobileOpen}
        onClose={() => setMobileOpen(false)}
        ModalProps={{ keepMounted: true }}
        sx={{ display: { xs: 'block', sm: 'none' }, '& .MuiDrawer-paper': { width: DRAWER_WIDTH } }}
      >
        {drawer}
      </Drawer>
      <Drawer
        variant="permanent"
        sx={{ display: { xs: 'none', sm: 'block' }, width: DRAWER_WIDTH, flexShrink: 0, '& .MuiDrawer-paper': { width: DRAWER_WIDTH, borderRight: '1px solid #e0e6e4' } }}
      >
        {drawer}
      </Drawer>

      <Box component="main" sx={{ flexGrow: 1, p: { xs: 2, md: 3 }, width: { sm: `calc(100% - ${DRAWER_WIDTH}px)` } }}>
        <Toolbar />
        <Outlet />
      </Box>

      {/* PWA Install Instructions Modal */}
      <Dialog open={showInstallGuide} onClose={() => setShowInstallGuide(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 800, display: 'flex', alignItems: 'center', gap: 1 }}>
          <InstallMobileIcon color="primary" /> Install MediStock App
        </DialogTitle>
        <DialogContent dividers>
          <Box sx={{ mb: 2, p: 2, bgcolor: '#e8f5e9', borderRadius: 2, border: '1px solid #c8e6c9', textAlign: 'center' }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 800, color: 'success.dark', mb: 1 }}>
              📦 Direct Android APK File Download
            </Typography>
            <a
              href="/MediStock.apk"
              download="MediStock.apk"
              style={{
                display: 'block',
                width: '100%',
                textDecoration: 'none',
              }}
            >
              <Button
                variant="contained"
                color="success"
                startIcon={<InstallMobileIcon />}
                fullWidth
                sx={{ fontWeight: 700, py: 1 }}
                component="span"
              >
                Download MediStock.apk (4.4 MB)
              </Button>
            </a>
          </Box>

          <Divider sx={{ my: 1.5 }} />

          <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5, color: 'primary.main' }}>
            🤖 Android Chrome PWA Install:
          </Typography>
          <Typography variant="body2" paragraph>
            1. Tap browser menu (<b>3 dots ⋮</b> at top right).<br />
            2. Tap <b>"Add to Home screen"</b> or <b>"Install App"</b>.<br />
            3. Confirm <b>Add/Install</b> — MediStock will open as an app!
          </Typography>

          <Divider sx={{ my: 1.5 }} />

          <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5, color: 'primary.main' }}>
            🍎 iPhone / iPad (Safari):
          </Typography>
          <Typography variant="body2" paragraph>
            1. Tap the <b>Share button ⎋</b> at the bottom of Safari.<br />
            2. Scroll down and tap <b>"Add to Home Screen"</b>.<br />
            3. Tap <b>Add</b> at top right.
          </Typography>

          <Divider sx={{ my: 1.5 }} />

          <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5, color: 'primary.main' }}>
            💻 Desktop (Chrome / Edge):
          </Typography>
          <Typography variant="body2">
            Click the <b>Install icon</b> in the top right browser address bar.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowInstallGuide(false)} variant="contained">Got it!</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
