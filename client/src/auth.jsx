import { createContext, useContext, useState } from 'react';
import { Navigate, Outlet } from 'react-router-dom';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('medistock_user'));
    } catch {
      return null;
    }
  });

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
