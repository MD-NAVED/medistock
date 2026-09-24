import { createContext, useContext, useEffect, useState } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { api } from './api';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try {
      const cached = JSON.parse(localStorage.getItem('medistock_user'));
      if (cached?.id) {
        Sentry.setUser({ id: String(cached.id), username: cached.username });
      }
      return cached;
    } catch {
      return null;
    }
  });

  // Keep Sentry user context in sync with user state
  useEffect(() => {
    if (user?.id) {
      Sentry.setUser({ id: String(user.id), username: user.username });
    } else {
      Sentry.setUser(null);
    }
  }, [user]);

  // Keep the cached user fresh — the plan tier can change after a payment
  // while the session token stays the same, so re-sync on every app load.
  useEffect(() => {
    if (!localStorage.getItem('medistock_token')) return;
    api('/api/auth/me')
      .then((u) => {
        localStorage.setItem('medistock_user', JSON.stringify(u));
        if (u?.id) {
          Sentry.setUser({ id: String(u.id), username: u.username });
        }
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
        if (u?.id) {
          Sentry.setUser({ id: String(u.id), username: u.username });
        }
        setUser(u);
      })
      .catch(() => localStorage.removeItem('medistock_token'));
  }, []);

  const login = (token, user) => {
    localStorage.setItem('medistock_token', token);
    localStorage.setItem('medistock_user', JSON.stringify(user));
    if (user?.id) {
      Sentry.setUser({ id: String(user.id), username: user.username });
    }
    setUser(user);
  };

  const logout = () => {
    localStorage.removeItem('medistock_token');
    localStorage.removeItem('medistock_user');
    Sentry.setUser(null);
    setUser(null);
  };

  return <AuthCtx.Provider value={{ user, login, logout }}>{children}</AuthCtx.Provider>;
}

export const useAuth = () => useContext(AuthCtx);

export function RequireAuth() {
  const { user } = useAuth();
  return user ? <Outlet /> : <Navigate to="/login" replace />;
}
