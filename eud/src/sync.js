// Server link: REST + WebSocket with an offline outbox.
//
// The EUD never depends on the link being up: all data is read from the
// local store, the server only feeds it. Changes made while offline go into
// the outbox and are replayed in order once the server is reachable again.

import * as store from './store.js';
import { ensureTrusted } from './trust.js';

const bus = new EventTarget();
export const on = (type, fn) => bus.addEventListener(type, (e) => fn(e.detail));
const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));

export const state = {
  server: '',
  token: '',
  user: null,
  link: 'offline', // 'online' | 'degraded' | 'offline'
  lastSync: null,
  outbox: 0,
};

let ws = null;
let wsRetry = 0;
let wsTimer = null;
let pingTimer = null;
let flushing = false;
let lastPositionSent = 0;

const WS_CHANNELS = ['markers', 'symbols', 'overlays', 'drawings', 'chat', 'video_analytics', 'radio'];

export async function init() {
  const auth = (await store.get('kv', 'auth')) || {};
  state.server = auth.server || '';
  state.token = auth.token || '';
  state.user = auth.user || null;
  state.lastSync = (await store.get('kv', 'lastSync')) || null;
  state.outbox = await store.count('outbox');
  window.addEventListener('online', () => reconnect());
  window.addEventListener('offline', () => setLink('offline'));
}

export const isLoggedIn = () => Boolean(state.server && state.token);

function setLink(link) {
  if (state.link === link) return;
  state.link = link;
  emit('link', link);
}

function apiUrl(path) {
  return state.server.replace(/\/+$/, '') + path;
}

async function api(path, { method = 'GET', body, timeout = 10000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(apiUrl(path), {
      method,
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) { emit('auth-expired'); throw Object.assign(new Error('Nicht angemeldet'), { status: 401 }); }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).detail || ''; } catch (_) { /* ignore */ }
      throw Object.assign(new Error(detail || `HTTP ${res.status}`), { status: res.status });
    }
    return res.status === 204 ? null : res.json();
  } finally {
    clearTimeout(t);
  }
}

export async function login(server, username, password) {
  state.server = server.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(state.server)) state.server = `https://${state.server}`;
  state.token = '';
  // First connect: fetch and confirm the server certificate (native app).
  await ensureTrusted(state.server);
  const r = await api('/api/login_user', { method: 'POST', body: { username, password } });
  state.token = r.token;
  state.user = r.user;
  await store.put('kv', { server: state.server, token: state.token, user: state.user }, 'auth');
  await reconnect();
  return r.user;
}

export async function logout() {
  try { if (state.token) await api('/api/logout', { method: 'POST', body: { token: state.token } }); } catch (_) { /* offline */ }
  state.token = '';
  state.user = null;
  await store.del('kv', 'auth');
  if (ws) ws.close();
  setLink('offline');
}

export function callsign() {
  const u = state.user || {};
  return u.callsign || u.username || 'EUD';
}

// ---- Full pull --------------------------------------------------------------

export async function pullAll() {
  const [markers, overlays, drawings] = await Promise.all([
    api('/api/map_markers'),
    api('/api/overlays').catch(() => []),
    api('/api/drawings').catch(() => []),
  ]);
  // Keep local, not-yet-sent items so they don't vanish from the map.
  // Keep mesh contacts (received over BLE) as well – the server does not know them.
  const pendingMarkers = (await store.all('markers')).filter((m) => m._pending || m._mesh);
  await store.replaceAll('markers', [...markers.map(normaliseMarker), ...pendingMarkers]);
  await store.replaceAll('overlays', [
    ...overlays.map((o) => ({ ...o, source: 'server' })),
    ...(await store.all('overlays')).filter((o) => o.source === 'local'),
  ]);
  await store.replaceAll('drawings', drawings);
  state.lastSync = Date.now();
  await store.put('kv', state.lastSync, 'lastSync');
  cacheOverlayImages(overlays);
  emit('data', { full: true });
}

function normaliseMarker(m) {
  return { ...m, name: m.name || m.callsign || m.label || m.type, updated: Date.now() };
}

// Server image overlays reference a URL; keep the image itself offline.
async function cacheOverlayImages(overlays) {
  for (const o of overlays) {
    if (!o.imageUrl || o.imageUrl.startsWith('data:')) continue;
    const key = `ovimg:${o.imageUrl}`;
    if (await store.get('kv', key)) continue;
    try {
      const url = o.imageUrl.startsWith('http') ? o.imageUrl : apiUrl(o.imageUrl);
      const blob = await (await fetch(url)).blob();
      await store.put('kv', blob, key);
      emit('data', { overlays: true });
    } catch (_) { /* retry next sync */ }
  }
}

export async function overlayImage(imageUrl) {
  if (!imageUrl) return null;
  if (imageUrl.startsWith('data:')) return imageUrl;
  const blob = await store.get('kv', `ovimg:${imageUrl}`);
  if (blob) return URL.createObjectURL(blob);
  return imageUrl.startsWith('http') ? imageUrl : apiUrl(imageUrl);
}

// ---- WebSocket ------------------------------------------------------------

let reconnecting = null;

export function reconnect() {
  // Single flight: login, app resume and the online event can all trigger it.
  if (!reconnecting) reconnecting = doReconnect().finally(() => { reconnecting = null; });
  return reconnecting;
}

async function doReconnect() {
  if (!isLoggedIn()) return;
  clearTimeout(wsTimer);
  try {
    await api('/api/me', { timeout: 6000 });
    if (state.link !== 'online') setLink('degraded');
    await flushOutbox();
    await pullAll();
  } catch (e) {
    if (e.status === 401) return;
    setLink('offline');
    scheduleReconnect();
    return;
  }
  openSocket();
}

function scheduleReconnect() {
  clearTimeout(wsTimer);
  const delay = Math.min(30000, 2000 * 2 ** wsRetry++);
  wsTimer = setTimeout(reconnect, delay);
}

function openSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const url = apiUrl(`/ws?token=${encodeURIComponent(state.token)}`).replace(/^http/, 'ws');
  try { ws = new WebSocket(url); } catch (_) { scheduleReconnect(); return; }
  ws.onopen = () => {
    wsRetry = 0;
    for (const channel of WS_CHANNELS) ws.send(JSON.stringify({ type: 'subscribe', channel }));
    setLink('online');
    clearInterval(pingTimer);
    pingTimer = setInterval(() => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' })); }, 20000);
    flushOutbox();
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    handleMessage(msg).catch((e) => console.warn('ws message', e));
  };
  ws.onclose = () => {
    clearInterval(pingTimer);
    ws = null;
    if (!isLoggedIn()) return;
    setLink(navigator.onLine === false ? 'offline' : 'degraded');
    scheduleReconnect();
  };
  ws.onerror = () => { try { ws.close(); } catch (_) { /* ignore */ } };
}

async function handleMessage(msg) {
  const d = msg.data || {};
  switch (msg.type) {
    case 'marker_created':
    case 'marker_updated':
    case 'symbol_created':
    case 'symbol_updated':
    case 'tak_maker_update':
      if (d.id && d.lat != null) {
        const prev = (await store.get('markers', d.id)) || {};
        await store.put('markers', normaliseMarker({ ...prev, ...d }));
        emit('data', { marker: d.id });
      }
      break;
    case 'marker_deleted':
    case 'symbol_deleted':
      if (d.id) { await store.del('markers', d.id); emit('data', { marker: d.id }); }
      break;
    case 'markers_sync':
    case 'markers_update':
      for (const m of d.markers || []) if (m.id) await store.put('markers', normaliseMarker(m));
      emit('data', { markers: true });
      break;
    case 'overlay_created':
    case 'overlay_updated':
      if (d.id) { await store.put('overlays', { ...d, source: 'server' }); cacheOverlayImages([d]); emit('data', { overlays: true }); }
      break;
    case 'overlay_deleted':
      if (d.id) { await store.del('overlays', d.id); emit('data', { overlays: true }); }
      break;
    case 'drawing_created':
    case 'drawing_updated':
      if (d.id) { await store.put('drawings', d); emit('data', { drawings: true }); }
      break;
    case 'drawing_deleted':
      if (d.id) { await store.del('drawings', d.id); emit('data', { drawings: true }); }
      break;
    case 'new_message':
      emit('chat', d);
      break;
    case 'radio_transcript':
      emit('radio', d);
      break;
    case 'detection':
    case 'video_detection':
      emit('detection', d);
      break;
    default:
      break;
  }
}

// ---- Outbox ---------------------------------------------------------------

export async function enqueue(op) {
  await store.put('outbox', { ...op, queuedAt: Date.now() });
  state.outbox = await store.count('outbox');
  emit('outbox', state.outbox);
  if (state.link !== 'offline') flushOutbox();
}

export async function flushOutbox() {
  if (flushing || !isLoggedIn()) return;
  flushing = true;
  try {
    const items = await store.all('outbox');
    for (const item of items) {
      try {
        await sendOp(item);
        await store.del('outbox', item.seq);
      } catch (e) {
        // 4xx (except auth/timeouts) will never succeed – drop instead of blocking the queue.
        if (e.status && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 408) {
          console.warn('outbox: dropping rejected op', item, e.message);
          await store.del('outbox', item.seq);
          continue;
        }
        break; // link problem: keep order, retry later
      }
    }
  } finally {
    flushing = false;
    state.outbox = await store.count('outbox');
    emit('outbox', state.outbox);
  }
}

async function sendOp(item) {
  switch (item.op) {
    case 'createMarker': {
      const r = await api('/api/map_markers', { method: 'POST', body: item.payload });
      await store.del('markers', item.localId);
      if (r && r.marker) await store.put('markers', normaliseMarker(r.marker));
      emit('data', { marker: item.localId });
      return;
    }
    case 'updateMarker':
      await api(`/api/map_markers/${encodeURIComponent(item.id)}`, { method: 'PUT', body: item.payload });
      return;
    case 'deleteMarker':
      await api(`/api/map_markers/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      return;
    case 'chat':
      await api('/api/chat/message', { method: 'POST', body: item.payload });
      return;
    default:
      throw Object.assign(new Error(`unknown op ${item.op}`), { status: 400 });
  }
}

// ---- High level actions ---------------------------------------------------

export async function createMarker(marker) {
  const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const record = { ...marker, id: localId, created_by: state.user?.username || 'local', _pending: true, timestamp: new Date().toISOString() };
  await store.put('markers', record);
  emit('data', { marker: localId });
  await enqueue({ op: 'createMarker', localId, payload: marker });
  return record;
}

export async function updateMarker(id, changes) {
  const prev = await store.get('markers', id);
  if (!prev) return;
  const next = { ...prev, ...changes };
  await store.put('markers', next);
  emit('data', { marker: id });
  if (prev._pending) {
    // Not on the server yet: patch the queued create instead.
    const items = await store.all('outbox');
    const q = items.find((i) => i.op === 'createMarker' && i.localId === id);
    if (q) { q.payload = { ...q.payload, ...changes }; await store.put('outbox', q); }
    return;
  }
  await enqueue({ op: 'updateMarker', id, payload: changes });
}

export async function deleteMarker(id) {
  const prev = await store.get('markers', id);
  await store.del('markers', id);
  emit('data', { marker: id });
  if (prev && prev._pending) {
    const items = await store.all('outbox');
    for (const i of items) if (i.localId === id) await store.del('outbox', i.seq);
    state.outbox = await store.count('outbox');
    emit('outbox', state.outbox);
    return;
  }
  await enqueue({ op: 'deleteMarker', id });
}

export async function sendChat(channelId, text) {
  await enqueue({ op: 'chat', payload: { channel_id: channelId, text } });
}

export async function chatHistory(channelId) {
  try {
    const r = await api(`/api/chat/messages/${encodeURIComponent(channelId)}?limit=100`);
    await store.put('kv', r.messages, `chat:${channelId}`);
    return r.messages;
  } catch (_) {
    return (await store.get('kv', `chat:${channelId}`)) || [];
  }
}

/**
 * Report own position (PLI). Only the newest position matters, so it is never
 * queued: if the link is down, the next fix after reconnect is sent instead.
 */
export async function reportPosition(fix, { force = false } = {}) {
  if (!isLoggedIn() || state.link === 'offline') return false;
  const interval = (store.setting('pliInterval', 10)) * 1000;
  if (!force && Date.now() - lastPositionSent < interval) return false;
  lastPositionSent = Date.now();
  try {
    await api('/api/map/symbols', {
      method: 'POST',
      body: { type: 'gps_position', lat: fix.lat, lng: fix.lng, label: callsign(), source_page: 'eud', accuracy: fix.accuracy },
      timeout: 8000,
    });
    return true;
  } catch (_) {
    lastPositionSent = 0;
    return false;
  }
}

export async function videoStreams() {
  try {
    const r = await api('/api/video/streams', { timeout: 6000 });
    await store.put('kv', r.streams, 'videoStreams');
    return r.streams;
  } catch (_) {
    return (await store.get('kv', 'videoStreams')) || [];
  }
}

export function videoUrl(path) {
  const sep = path.includes('?') ? '&' : '?';
  return `${apiUrl(path)}${sep}token=${encodeURIComponent(state.token)}`;
}

/** Send a raw message over the WebSocket (used for camera frames). */
export function sendWs(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  if (ws.bufferedAmount > 2_000_000) return false; // slow link: drop frames instead of queueing
  ws.send(JSON.stringify(msg));
  return true;
}

/** Radio transcripts (Whisper) from the server; cached for offline reading. */
export async function radioTranscripts() {
  try {
    const r = await api('/api/radio/transcripts?limit=200', { timeout: 6000 });
    await store.put('kv', r.entries, 'radioLog');
    return r.entries;
  } catch (_) {
    return (await store.get('kv', 'radioLog')) || [];
  }
}
