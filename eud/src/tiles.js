// Offline-capable map tiles.
//
// OfflineTileLayer serves every tile cache-first from IndexedDB. Tiles that
// are viewed online are cached automatically, whole areas can be downloaded
// ahead of a mission, and MBTiles packages can be imported. When a tile is
// missing offline, the nearest cached parent tile is upscaled so the map
// never turns grey when zooming in past the downloaded levels.

import L from 'leaflet';
import * as store from './store.js';

export const BASEMAPS = [
  {
    id: 'osm', name: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxNativeZoom: 19,
    attribution: '&copy; OpenStreetMap',
  },
  {
    id: 'topo', name: 'OpenTopoMap',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', maxNativeZoom: 17, subdomains: 'abc',
    attribution: '&copy; OpenTopoMap (CC-BY-SA)',
  },
  {
    id: 'sat', name: 'Satellit (Esri)',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', maxNativeZoom: 19,
    attribution: 'Esri World Imagery',
  },
];

export function tileKey(layerId, z, x, y) {
  return `${layerId}/${z}/${x}/${y}`;
}

function fillUrl(tpl, z, x, y, subdomains) {
  const s = subdomains ? subdomains[(x + y) % subdomains.length] : '';
  return tpl.replace('{s}', s).replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{-y}', (1 << z) - 1 - y);
}

async function fetchTile(def, z, x, y, signal) {
  const res = await fetch(fillUrl(def.url, z, x, y, def.subdomains), { signal, mode: 'cors', credentials: 'omit' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

const stats = { hits: 0, misses: 0, fallbacks: 0 };
export function tileStats() { return { ...stats }; }

export const OfflineTileLayer = L.TileLayer.extend({
  initialize(def, options) {
    this._def = def;
    L.TileLayer.prototype.initialize.call(this, def.url, {
      maxNativeZoom: def.maxNativeZoom,
      maxZoom: 22,
      subdomains: def.subdomains || 'abc',
      attribution: def.attribution,
      crossOrigin: true,
      ...options,
    });
  },

  createTile(coords, done) {
    const img = document.createElement('img');
    img.alt = '';
    img.setAttribute('role', 'presentation');
    const z = this._getZoomForUrl();
    this._loadTile(this._def, z, coords.x, coords.y)
      .then((url) => {
        img.onload = () => { if (url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), 1000); done(null, img); };
        img.onerror = () => done(new Error('tile decode failed'), img);
        img.src = url;
      })
      .catch((err) => done(err, img));
    return img;
  },

  async _loadTile(def, z, x, y) {
    const key = tileKey(def.id, z, x, y);
    const cached = await store.get('tiles', key).catch(() => null);
    if (cached) { stats.hits++; return URL.createObjectURL(cached); }
    stats.misses++;
    if (def.url && navigator.onLine !== false) {
      try {
        const blob = await fetchTile(def, z, x, y);
        if (store.setting('autoCache', true)) store.put('tiles', blob, key).catch(() => {});
        return URL.createObjectURL(blob);
      } catch (_) { /* fall through to parent tile */ }
    }
    const fallback = await parentTileFallback(def.id, z, x, y);
    if (fallback) { stats.fallbacks++; return fallback; }
    throw new Error('tile unavailable offline');
  },
});

// Crop and upscale the closest cached ancestor tile (up to 6 levels up).
async function parentTileFallback(layerId, z, x, y) {
  for (let d = 1; d <= 6 && z - d >= 0; d++) {
    const pz = z - d, px = x >> d, py = y >> d;
    const blob = await store.get('tiles', tileKey(layerId, pz, px, py)).catch(() => null);
    if (!blob) continue;
    let bmp;
    try { bmp = await createImageBitmap(blob); } catch (_) { continue; }
    const n = 1 << d;
    const sub = bmp.width / n;
    const sx = (x - px * n) * sub, sy = (y - py * n) * sub;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = d <= 2;
    ctx.drawImage(bmp, sx, sy, sub, sub, 0, 0, 256, 256);
    bmp.close && bmp.close();
    return canvas.toDataURL('image/png');
  }
  return null;
}

// ---- Area download -------------------------------------------------------

function lon2tile(lon, z) { return Math.floor(((lon + 180) / 360) * (1 << z)); }
function lat2tile(lat, z) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * (1 << z));
}

export function tilesInBounds(bounds, minZ, maxZ) {
  const list = [];
  for (let z = minZ; z <= maxZ; z++) {
    const x0 = lon2tile(bounds.getWest(), z), x1 = lon2tile(bounds.getEast(), z);
    const y0 = lat2tile(bounds.getNorth(), z), y1 = lat2tile(bounds.getSouth(), z);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) list.push([z, x, y]);
  }
  return list;
}

export function countTiles(bounds, minZ, maxZ) {
  let n = 0;
  for (let z = minZ; z <= maxZ; z++) {
    const dx = lon2tile(bounds.getEast(), z) - lon2tile(bounds.getWest(), z) + 1;
    const dy = lat2tile(bounds.getSouth(), z) - lat2tile(bounds.getNorth(), z) + 1;
    n += dx * dy;
  }
  return n;
}

/**
 * Download all tiles of `def` inside `bounds` for zoom minZ..maxZ.
 * onProgress({done, total, failed, skipped}); returns the final counters.
 */
export async function downloadArea(def, bounds, minZ, maxZ, onProgress, signal) {
  const tiles = tilesInBounds(bounds, minZ, Math.min(maxZ, def.maxNativeZoom || 19));
  const st = { done: 0, total: tiles.length, failed: 0, skipped: 0 };
  let i = 0;
  const worker = async () => {
    while (i < tiles.length) {
      if (signal && signal.aborted) return;
      const [z, x, y] = tiles[i++];
      const key = tileKey(def.id, z, x, y);
      try {
        if (await store.hasKey('tiles', key)) st.skipped++;
        else await store.put('tiles', await fetchTile(def, z, x, y, signal), key);
      } catch (_) {
        st.failed++;
      }
      st.done++;
      if (st.done % 10 === 0 || st.done === st.total) onProgress && onProgress({ ...st });
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  onProgress && onProgress({ ...st });
  // Remember the downloaded area so the user can see what is available offline.
  const areas = (await store.get('kv', 'offlineAreas')) || [];
  areas.push({
    layer: def.id, minZ, maxZ, tiles: st.total - st.failed, at: Date.now(),
    bounds: [[bounds.getSouth(), bounds.getWest()], [bounds.getNorth(), bounds.getEast()]],
  });
  await store.put('kv', areas, 'offlineAreas');
  return st;
}

// ---- MBTiles import --------------------------------------------------------

/**
 * Import an .mbtiles file (SQLite) into the tile cache under layer `layerId`.
 * MBTiles uses TMS row order, so rows are flipped to XYZ.
 */
export async function importMBTiles(file, layerId, onProgress) {
  const [{ default: initSqlJs }, { default: wasmUrl }] = await Promise.all([
    import('sql.js'),
    import('sql.js/dist/sql-wasm-browser.wasm?url'),
  ]);
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const db = new SQL.Database(new Uint8Array(await file.arrayBuffer()));
  const meta = {};
  try {
    const r = db.exec('SELECT name, value FROM metadata');
    if (r[0]) for (const [k, v] of r[0].values) meta[k] = v;
  } catch (_) { /* metadata table is optional */ }
  const fmt = (meta.format || 'png').toLowerCase();
  const mime = fmt === 'jpg' || fmt === 'jpeg' ? 'image/jpeg' : fmt === 'webp' ? 'image/webp' : 'image/png';
  const total = db.exec('SELECT COUNT(*) FROM tiles')[0].values[0][0];
  const stmt = db.prepare('SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles');
  let batch = [], done = 0;
  while (stmt.step()) {
    const [z, x, tmsY, data] = stmt.get();
    const y = (1 << z) - 1 - tmsY;
    batch.push([tileKey(layerId, z, x, y), new Blob([data], { type: mime })]);
    if (batch.length >= 500) {
      await store.putMany('tiles', batch);
      done += batch.length; batch = [];
      onProgress && onProgress({ done, total });
    }
  }
  if (batch.length) { await store.putMany('tiles', batch); done += batch.length; }
  stmt.free();
  db.close();
  onProgress && onProgress({ done, total });
  let bounds = null;
  if (meta.bounds) {
    const [w, s, e, n] = meta.bounds.split(',').map(Number);
    bounds = [[s, w], [n, e]];
  }
  return {
    id: layerId,
    name: meta.name || file.name.replace(/\.mbtiles$/i, ''),
    minZoom: Number(meta.minzoom) || 0,
    maxNativeZoom: Number(meta.maxzoom) || 18,
    bounds,
    tiles: done,
    url: '', // served from cache only
    attribution: meta.attribution || 'MBTiles',
  };
}

export async function clearTiles() {
  await store.clear('tiles');
  await store.put('kv', [], 'offlineAreas');
}
