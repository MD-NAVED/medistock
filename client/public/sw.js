// Minimal service worker for MediStock PWA installability + offline shell.
// API calls always go to the network; only the static app shell is cached.
const CACHE = 'medistock-shell-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // live data only

  // network-first; cache what succeeds, fall back to cache when offline
  event.respondWith(
    fetch(req).then((res) => {
      if (res.ok && (url.pathname.startsWith('/assets/') || SHELL.includes(url.pathname))) {
        const copy = res.clone();
        event.waitUntil(caches.open(CACHE).then((cache) => cache.put(req, copy)));
      }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || caches.match('/')))
  );
});
