/*
 * Global Mood Map service worker.
 *
 * Scope is deliberately tiny: cache-first for immutable static assets
 * (/assets/* is content-hashed by Vite, /icons/* changes only with a
 * cache-name bump). EVERYTHING else — /api/* and especially the SSE
 * stream at /api/stream — is never touched: the fetch handler returns
 * without calling respondWith, so the browser talks to the network
 * natively and nothing is ever buffered. No offline page.
 */
const CACHE = 'gmm-static-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith('/assets/') && !url.pathname.startsWith('/icons/')) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })()
  );
});
