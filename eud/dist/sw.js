// LPU5 EUD service worker (PWA / iOS home-screen app).
// App shell is cached so the EUD starts without a link; map tiles and data
// live in IndexedDB and are handled by the app itself.
// The precache list and version are injected at build time (vite.config.js).
const PRECACHE = ["./","./index.html","./manifest.webmanifest","./icon-192.png","./icon-512.png","./assets/index-CcRCSbf1.js","./assets/sql-wasm-browser-Bu6DMMRk.js","./assets/sql-wasm-browser-CgmOfcvJ.js","./assets/web-DPs1kbnF.js","./assets/web-EchCHYDf.js","./assets/web-MA2I3K56.js","./assets/fa-brands-400-C99Yv4gD.woff2","./assets/fa-brands-400-DtZKBM2a.ttf","./assets/fa-regular-400-BMFokQJ2.ttf","./assets/fa-regular-400-OOsPf1xj.woff2","./assets/fa-solid-900-DAI24fNt.woff2","./assets/fa-solid-900-DM0teJdg.ttf","./assets/fa-v4compatibility-F0dlVTLQ.ttf","./assets/fa-v4compatibility-aR9vOKaP.woff2","./assets/index-Q_phCzuK.css","./assets/sql-wasm-browser-C1D_RJuy.wasm"];
const CACHE = `lpu5-eud-${"f08f828456"}`;

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
