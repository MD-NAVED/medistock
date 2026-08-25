const isNative = window.location.protocol === 'capacitor:' || window.location.protocol === 'file:';
// Use VITE_API_BASE for native (Capacitor) builds, relative for web (same-origin via Vercel rewrites)
const API_BASE = isNative
  ? (import.meta.env.VITE_API_BASE || '')
  : '';

export async function api(path, { method = 'GET', body } = {}) {
  const token = localStorage.getItem('medistock_token');
  const fullUrl = path.startsWith('http') ? path : (API_BASE + path);
  const res = await fetch(fullUrl, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
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
      localStorage.removeItem('medistock_token');
      localStorage.removeItem('medistock_user');
      if (!window.location.pathname.startsWith('/login')) {
        window.location.replace('/login?expired=1');
      }
    }
    const err = new Error((data && data.error) || 'Request failed');
    err.status = res.status;
    throw err;
  }
  return data;
}
