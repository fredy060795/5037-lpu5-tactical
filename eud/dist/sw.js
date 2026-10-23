// LPU5 EUD service worker (PWA / iOS home-screen app).
// App shell is cached so the EUD starts without a link; map tiles and data
// live in IndexedDB and are handled by the app itself.
// The precache list and version are injected at build time (vite.config.js).
const PRECACHE = ["./","./index.html","./manifest.webmanifest","./icon-192.png","./icon-512.png","./assets/index-BHWhHmOH.js","./assets/sql-wasm-browser-Bu6DMMRk.js","./assets/sql-wasm-browser-CoxsaOU3.js","./assets/web-5u_DcjEy.js","./assets/web-BWkE60Ok.js","./assets/web-CWL0Rq_U.js","./assets/fa-brands-400-C99Yv4gD.woff2","./assets/fa-brands-400-DtZKBM2a.ttf","./assets/fa-regular-400-BMFokQJ2.ttf","./assets/fa-regular-400-OOsPf1xj.woff2","./assets/fa-solid-900-DAI24fNt.woff2","./assets/fa-solid-900-DM0teJdg.ttf","./assets/fa-v4compatibility-F0dlVTLQ.ttf","./assets/fa-v4compatibility-aR9vOKaP.woff2","./assets/index-FSNUqwaD.css","./assets/sql-wasm-browser-C1D_RJuy.wasm"];
const CACHE = `lpu5-eud-${"7d3365326a"}`;

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
