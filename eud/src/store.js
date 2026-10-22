// Persistent offline storage (IndexedDB).
// Everything the EUD needs to keep working without a link lives here:
// map tiles, markers, overlays, drawings, own position, settings and the
// outbox of changes that still have to be sent to the server.

const DB_NAME = 'lpu5-eud';
const DB_VERSION = 1;
export const STORES = ['kv', 'tiles', 'markers', 'overlays', 'drawings', 'outbox', 'track'];

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (db.objectStoreNames.contains(name)) continue;
        if (name === 'outbox' || name === 'track') {
          db.createObjectStore(name, { keyPath: 'seq', autoIncrement: true });
        } else if (name === 'kv' || name === 'tiles') {
          db.createObjectStore(name);
        } else {
          db.createObjectStore(name, { keyPath: 'id' });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(store, mode, fn) {
  const db = await open();
  const t = db.transaction(store, mode);
  const result = fn(t.objectStore(store));
  await new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
  return result instanceof IDBRequest ? result.result : result;
}

export const get = (store, key) => tx(store, 'readonly', (s) => s.get(key));
export const put = (store, value, key) => tx(store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key)));
export const del = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));
export const all = (store) => tx(store, 'readonly', (s) => s.getAll());
export const clear = (store) => tx(store, 'readwrite', (s) => s.clear());
export const count = (store) => tx(store, 'readonly', (s) => s.count());

/** Replace the full content of a keyPath store in one transaction. */
export function replaceAll(store, items) {
  return tx(store, 'readwrite', (s) => {
    s.clear();
    for (const item of items) s.put(item);
  });
}

export async function putMany(store, entries) {
  // entries: [[key, value], ...] for out-of-line stores
  return tx(store, 'readwrite', (s) => {
    for (const [k, v] of entries) s.put(v, k);
  });
}

export async function hasKey(store, key) {
  const db = await open();
  return wrap(db.transaction(store, 'readonly').objectStore(store).count(key)).then((n) => n > 0);
}

// Small synchronous settings cache backed by the kv store, so UI code can
// read settings without awaiting.
const settingsCache = {};
export async function loadSettings() {
  const s = (await get('kv', 'settings')) || {};
  Object.assign(settingsCache, s);
  return settingsCache;
}
export function setting(key, fallback) {
  return key in settingsCache ? settingsCache[key] : fallback;
}
export async function saveSetting(key, value) {
  settingsCache[key] = value;
  await put('kv', { ...settingsCache }, 'settings');
}

/** Ask the browser/WebView not to evict our data under storage pressure. */
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      const already = await navigator.storage.persisted();
      return already || (await navigator.storage.persist());
    }
  } catch (_) { /* not supported */ }
  return false;
}

export async function storageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate();
  } catch (_) { /* not supported */ }
  return null;
}
