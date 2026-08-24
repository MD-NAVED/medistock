// Minimal service worker for MediStock PWA installability + offline shell.
// API calls and index.html always go to the network; only static assets are cached.
const CACHE = 'medistock-shell-v2';
const SHELL = ['/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // live data only
  if (url.pathname === '/' || url.pathname.endsWith('.html')) return; // never cache HTML

  // network-first; cache what succeeds, fall back to cache when offline
  event.respondWith(
    fetch(req).then((res) => {
      if (res.ok && url.pathname.startsWith('/assets/')) {
        const copy = res.clone();
        event.waitUntil(caches.open(CACHE).then((cache) => cache.put(req, copy)));
      }
      return res;
    }).catch(() => caches.match(req))
  );
});
