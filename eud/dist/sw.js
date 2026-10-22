// LPU5 EUD service worker (PWA / iOS home-screen app).
// App shell is cached so the EUD starts without a link; map tiles and data
// live in IndexedDB and are handled by the app itself.
// The precache list and version are injected at build time (vite.config.js).
const PRECACHE = ["./","./index.html","./manifest.webmanifest","./icon-192.png","./icon-512.png","./assets/index-D8sRo2YY.js","./assets/sql-wasm-browser-Bu6DMMRk.js","./assets/sql-wasm-browser-DZtZWWRE.js","./assets/web-4K9cDhH6.js","./assets/web-C2f9eJiZ.js","./assets/web-uzqLvYfT.js","./assets/index-pBRg-lEy.css","./assets/sql-wasm-browser-C1D_RJuy.wasm"];
const CACHE = `lpu5-eud-${"aa63bab6c1"}`;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.includes('/api/') || url.pathname.endsWith('/ws')) return;

  if (req.mode === 'navigate') {
    // Network first so updates arrive, cached shell when offline.
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put('./index.html', copy));
        return res;
      }).catch(() => caches.match('./index.html')),
    );
    return;
  }
  // Hashed build assets never change: cache first.
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    })),
  );
});
