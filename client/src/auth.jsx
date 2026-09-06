import { createContext, useContext, useEffect, useState } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { api } from './api';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('medistock_user'));
    } catch {
      return null;
    }
  });

  // Keep the cached user fresh — the plan tier can change after a payment
  // while the session token stays the same, so re-sync on every app load.
  useEffect(() => {
    if (!localStorage.getItem('medistock_token')) return;
    api('/api/auth/me')
      .then((u) => {
        localStorage.setItem('medistock_user', JSON.stringify(u));
        setUser(u);
      })
      .catch(() => { /* 401 handling lives inside api() */ });
  }, []);

  // Founder impersonation: the admin panel opens the client app with
  // #impersonate_token=<session>. Swap it for a real logged-in session.
  useEffect(() => {
    const m = /impersonate_token=([a-f0-9]+)/.exec(window.location.hash || '');
    if (!m) return;
    localStorage.setItem('medistock_token', m[1]);
    history.replaceState(null, '', window.location.pathname + window.location.search);
    api('/api/auth/me')
      .then((u) => {
        localStorage.setItem('medistock_user', JSON.stringify(u));
        setUser(u);
      })
      .catch(() => localStorage.removeItem('medistock_token'));
  }, []);

  const login = (token, user) => {
    localStorage.setItem('medistock_token', token);
    localStorage.setItem('medistock_user', JSON.stringify(user));
    setUser(user);
  };

  const logout = () => {
    localStorage.removeItem('medistock_token');
    localStorage.removeItem('medistock_user');
    setUser(null);
  };

  return <AuthCtx.Provider value={{ user, login, logout }}>{children}</AuthCtx.Provider>;
}

export const useAuth = () => useContext(AuthCtx);

export function RequireAuth() {
  const { user } = useAuth();
  return user ? <Outlet /> : <Navigate to="/login" replace />;
}
