import { Capacitor } from '@capacitor/core';
import { getCachedData, setCachedData, invalidateCache, clearApiCache } from './cache';

export { getCachedData, setCachedData, invalidateCache, clearApiCache };

// Read-heavy endpoints that benefit from SWR caching for instant cold-start & offline viewing
const CACHEABLE_READ_PREFIXES = [
  '/api/reports',
  '/api/medicines',
  '/api/alerts',
  '/api/settings',
  '/api/companies',
  '/api/khata',
  '/api/billing/plans',
  '/api/purchases',
];

function isCacheableReadPath(path) {
  return CACHEABLE_READ_PREFIXES.some((p) => path.startsWith(p));
}

function invalidateRelatedCache(path) {
  if (path.startsWith('/api/sales') || path.startsWith('/api/purchases') || path.startsWith('/api/medicines')) {
    invalidateCache('/api/reports');
    invalidateCache('/api/alerts');
    invalidateCache('/api/medicines');
    invalidateCache('/api/purchases');
  }
  if (path.startsWith('/api/khata')) {
    invalidateCache('/api/khata');
  }
  if (path.startsWith('/api/settings')) {
    invalidateCache('/api/settings');
  }
  if (path.startsWith('/api/companies')) {
    invalidateCache('/api/companies');
  }
}

// Native detection MUST use the Capacitor SDK — Android's WebView origin is
// https://localhost (not capacitor://), so protocol sniffing misses it and
// API calls would hit the app's own local server instead of the real API.
const isNative = Capacitor.isNativePlatform();
// Use VITE_API_BASE for native (Capacitor) builds, relative for web (same-origin via Vercel rewrites)
const API_BASE = isNative
  ? (import.meta.env.VITE_API_BASE || 'https://medistock-api.vercel.app')
  : '';

export async function api(path, { method = 'GET', body } = {}) {
  const token = localStorage.getItem('medistock_token');
  const fullUrl = path.startsWith('http') ? path : (API_BASE + path);
  let res;
  try {
    res = await fetch(fullUrl, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (netErr) {
    // Offline resilience: if network fetch fails on a cacheable GET, return cached data if present
    if (method === 'GET' && isCacheableReadPath(path)) {
      const cached = getCachedData(path);
      if (cached !== null) return cached;
    }
    throw netErr;
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    // Only a genuinely invalid session should sign the user out. A 401 from a
    // form check (e.g. wrong current password) must leave the session alone.
    if (res.status === 401 && token && data?.code === 'session_invalid') {
      clearApiCache();
      localStorage.removeItem('medistock_token');
      localStorage.removeItem('medistock_user');
      if (!window.location.pathname.startsWith('/login')) {
        window.location.replace('/login?expired=1');
      }
    }
    // Store locked by the founder (kill-switch) or trial/subscription over —
    // send the user to the paywall where they can renew and unlock instantly.
    if (res.status === 403 && data?.code === 'subscription_locked' && !window.location.pathname.startsWith('/subscription')) {
      window.location.replace('/subscription?locked=1');
    }
    const err = new Error((data && data.error) || 'Request failed');
    err.status = res.status;
    err.code = data && data.code;
    err.existing_purchase_id = data && data.existing_purchase_id;
    err.existing_medicine_id = data && data.existing_medicine_id;
    err.data = data;
    throw err;
  }
  // A 2xx with an unparseable body (e.g. an HTML fallback page) must never
  // bubble up as null — callers do data.token and would crash obscurely.
  if (data === null) {
    throw new Error('The server sent an invalid response. Check your internet connection and try again.');
  }

  // Update read cache on successful GET
  if (method === 'GET' && isCacheableReadPath(path)) {
    setCachedData(path, data);
  } else if (method !== 'GET') {
    // Invalidate stale caches on successful mutations
    invalidateRelatedCache(path);
  }

  return data;
}
