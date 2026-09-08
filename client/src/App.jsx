import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import theme from './theme';
import { AuthProvider, RequireAuth } from './auth';
import AppLayout from './layout/AppLayout';
import Login from './pages/Login';
import SignUp from './pages/SignUp';
import Dashboard from './pages/Dashboard';
import Medicines from './pages/Medicines';
import Billing from './pages/Billing';
import Khata from './pages/Khata';
import Purchases from './pages/Purchases';
import Alerts from './pages/Alerts';
import Reports from './pages/Reports';
import Settings from './pages/Settings';
import Companies from './pages/Companies';
import InvoiceView from './pages/InvoiceView';
import Subscription from './pages/Subscription';
import Referrals from './pages/Referrals';

export default function App() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/signup" element={<SignUp />} />
            <Route path="/invoice/:id" element={<InvoiceView />} />
            <Route element={<RequireAuth />}>
              <Route path="/" element={<AppLayout />}>
                <Route index element={<Dashboard />} />
                    <Route path="billing" element={<Billing />} />
                    <Route path="khata" element={<Khata />} />
                <Route path="medicines" element={<Medicines />} />
                <Route path="companies" element={<Companies />} />
                <Route path="purchases" element={<Purchases />} />
                <Route path="alerts" element={<Alerts />} />
                <Route path="reports" element={<Reports />} />
                <Route path="settings" element={<Settings />} />
                <Route path="subscription" element={<Subscription />} />
                <Route path="referrals" element={<Referrals />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Route>
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  );
}
