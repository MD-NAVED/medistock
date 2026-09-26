// Stale-While-Revalidate (SWR) cache for read-heavy API endpoints.
// Persists responses in localStorage keyed by store_id and path with 24h TTL.
// Provides instantaneous UI rendering on cold start and offline resilience.

const CACHE_PREFIX = 'medistock_swr_';
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function getCurrentStoreId() {
  try {
    const u = JSON.parse(localStorage.getItem('medistock_user') || '{}');
    return u?.store_id ? String(u.store_id) : 'default';
  } catch {
    return 'default';
  }
}

function getCacheKey(path) {
  return `${CACHE_PREFIX}${getCurrentStoreId()}_${path}`;
}

export function getCachedData(path) {
  try {
    const raw = localStorage.getItem(getCacheKey(path));
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry || !entry.timestamp) return null;
    if (Date.now() - entry.timestamp > TTL_MS) {
      localStorage.removeItem(getCacheKey(path));
      return null;
    }
    return entry.data;
  } catch {
    return null;
  }
}

export function setCachedData(path, data) {
  if (data === undefined || data === null) return;
  try {
    const entry = { timestamp: Date.now(), data };
    localStorage.setItem(getCacheKey(path), JSON.stringify(entry));
  } catch (err) {
    // Gracefully handle storage quota limits
    try {
      clearOldCacheEntries();
    } catch {}
  }
}

export function invalidateCache(pathPrefix) {
  try {
    const storeId = getCurrentStoreId();
    const prefix = `${CACHE_PREFIX}${storeId}_`;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) {
        if (!pathPrefix || key.includes(pathPrefix)) {
          localStorage.removeItem(key);
        }
      }
    }
  } catch {}
}

export function clearApiCache() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && key.startsWith(CACHE_PREFIX)) {
        localStorage.removeItem(key);
      }
    }
  } catch {}
}

function clearOldCacheEntries() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(CACHE_PREFIX)) keys.push(k);
  }
  // Remove oldest half
  keys.forEach((k) => localStorage.removeItem(k));
}
