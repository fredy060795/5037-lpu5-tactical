// LPU5 EUD – entry point.
// Startup order matters for offline use: restore view, position and all
// cached data from IndexedDB first and render them, then try the server.

import 'leaflet/dist/leaflet.css';
import './style.css';
import L from 'leaflet';
import { Capacitor } from '@capacitor/core';
import { KeepAwake } from '@capacitor-community/keep-awake';
import { App } from '@capacitor/app';

import * as store from './store.js';
import * as sync from './sync.js';
import * as geo from './geo.js';
import { BASEMAPS, OfflineTileLayer } from './tiles.js';
import { markerIcon, escapeHtml } from './symbols.js';
import * as overlays from './overlays.js';
import { distance, bearing, formatDistance, formatBearing, formatCoord, ago } from './geoutil.js';
import * as panels from './panels.js';
import * as mesh from './mesh.js';
import * as trust from './trust.js';
import * as ops from './ops.js';
import * as lockMod from './lock.js';

const $ = (id) => document.getElementById(id);
const STALE_MS = 5 * 60 * 1000;

export const app = {
  map: null,
  baseLayer: null,
  markerLayer: L.layerGroup(),
  overlayLayer: L.layerGroup(),
  drawingLayer: L.layerGroup(),
  trackLayer: L.polyline([], { color: '#2f80ed', weight: 3, opacity: 0.6, dashArray: '4 6' }),
  detectionLayer: L.layerGroup(),
  markers: new Map(), // id -> L.Marker
  selfMarker: null,
  selfAccuracy: null,
  follow: false,
  navTarget: null,
  navLine: null,
  measure: null,
};

// ---- Bootstrap ------------------------------------------------------------

async function boot() {
  await store.loadSettings();
  store.requestPersistence();
  await sync.init();
  await geo.restoreLastFix();

  initMap();
  await lockMod.lock();          // PIN before anything is shown
  lockMod.installAutoLock();
  await renderAll();
  updateSelf(geo.getLastFix(), true);
  bindUi();
  bindSync();

  if (sync.isLoggedIn()) {
    afterLogin();
  } else if (store.setting('offlineMode', false)) {
    startTracking();
  } else {
    showLogin();
  }

  if (Capacitor.isNativePlatform()) {
    App.addListener('appStateChange', ({ isActive }) => { if (isActive) sync.reconnect(); });
  }
  if ('serviceWorker' in navigator && !Capacitor.isNativePlatform() && import.meta.env.PROD) {
    navigator.serviceWorker.register('./sw.js').catch((e) => { console.warn('SW', e); trust.noteServiceWorkerError(e); });
  }
}

function afterLogin() {
  $('login').classList.add('hidden');
  $('sb-callsign').textContent = sync.callsign();
  startTracking();
  sync.reconnect();
}

function startTracking() {
  geo.start().catch((e) => toast(`GPS: ${e.message || e}`));
  if (store.setting('keepAwake', true)) KeepAwake.keepAwake().catch(() => {});
}

// ---- Map --------------------------------------------------------------------

function initMap() {
  const view = store.setting('view', { center: [51.1657, 10.4515], zoom: 6 });
  const map = L.map('map', {
    center: view.center,
    zoom: view.zoom,
    zoomControl: false,
    attributionControl: true,
    preferCanvas: false,
    maxZoom: 21,
    tap: true,
  });
  app.map = map;
  L.control.scale({ imperial: false, position: 'bottomright' }).addTo(map);
  setBasemap(store.setting('basemap', 'osm'));
  app.overlayLayer.addTo(map);
  app.drawingLayer.addTo(map);
  app.trackLayer.addTo(map);
  app.markerLayer.addTo(map);
  app.detectionLayer.addTo(map);

  let saveTimer;
  map.on('moveend', () => {
    updateCenterReadout();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const c = map.getCenter();
      store.saveSetting('view', { center: [c.lat, c.lng], zoom: map.getZoom() });
    }, 500);
  });
  map.on('dragstart', () => setFollow(false));
  map.on('contextmenu', (e) => panels.addMarker(e.latlng));
  map.on('click', (e) => { if (app.measure && !app.drawing) measureAdd(e.latlng); });
  updateCenterReadout();
}

export async function availableBasemaps() {
  const imported = (await store.get('kv', 'mbtilesLayers')) || [];
  const custom = store.setting('customTiles', null);
  return [...(await serverBasemaps()), ...BASEMAPS, ...(custom ? [custom] : []), ...imported];
}

// Map tiles via the LPU5 server (tile_server.py): works in a TOC without
// internet, and every tile is also cached on this device.
async function serverBasemaps() {
  if (!sync.state.server) return [];
  let sources = (await store.get('kv', 'serverTileSources')) || null;
  if (sync.state.link !== 'offline' || !sources) {
    try {
      const r = await fetch(sync.serverUrl('/api/tiles/sources'));
      if (r.ok) {
        sources = (await r.json()).sources;
        await store.put('kv', sources, 'serverTileSources');
      }
    } catch (_) { /* keep cached list */ }
  }
  return (sources || [{ id: 'osm', name: 'OpenStreetMap', max_zoom: 19 }]).map((src) => ({
    id: `srv-${src.id}`,
    name: `LPU5-Server: ${src.name}`,
    url: sync.serverUrl(`/tiles/${src.id}/{z}/{x}/{y}`),
    maxNativeZoom: src.max_zoom || 19,
    attribution: 'LPU5',
  }));
}

export async function setBasemap(id) {
  const all = await availableBasemaps();
  const def = all.find((b) => b.id === id) || BASEMAPS[0];
  if (app.baseLayer) app.map.removeLayer(app.baseLayer);
  app.baseLayer = new OfflineTileLayer(def).addTo(app.map);
  app.baseLayer.bringToBack();
  app.baseDef = def;
  store.saveSetting('basemap', def.id);
}

function updateCenterReadout() {
  const c = app.map.getCenter();
  const fmt = store.setting('coordFormat', 'mgrs');
  $('coord-center').textContent = formatCoord(c.lat, c.lng, fmt);
}

// ---- Rendering ----------------------------------------------------------------

function isStale(m) {
  if (!['gps_position', 'tak_maker', 'node', 'meshtastic_node'].includes(m.type)) return false;
  const ts = Date.parse(m.data?.timestamp || m.timestamp || m.created_at || '');
  return !Number.isNaN(ts) && Date.now() - ts > STALE_MS;
}

function isOwnPosition(m) {
  return m.type === 'gps_position' && sync.state.user && m.created_by === sync.state.user.username;
}

export async function renderMarkers() {
  const list = await store.all('markers');
  const seen = new Set();
  for (const m of list) {
    if (m.lat == null || m.lng == null || isOwnPosition(m)) continue;
    seen.add(m.id);
    const icon = markerIcon(m, { stale: isStale(m), pending: m._pending });
    let lm = app.markers.get(m.id);
    if (!lm) {
      lm = L.marker([m.lat, m.lng], { icon, keyboard: false });
      lm.on('click', () => panels.markerDetails(lm._data));
      lm.addTo(app.markerLayer);
      app.markers.set(m.id, lm);
    } else {
      lm.setLatLng([m.lat, m.lng]);
      if (lm.options.icon !== icon) lm.setIcon(icon);
    }
    lm._data = m;
  }
  for (const [id, lm] of app.markers) {
    if (!seen.has(id)) { app.markerLayer.removeLayer(lm); app.markers.delete(id); }
  }
  if (app.navTarget) {
    const t = list.find((m) => m.id === app.navTarget.id);
    if (t) app.navTarget = t;
    updateNav();
  }
}

export async function renderOverlays() {
  app.overlayLayer.clearLayers();
  for (const o of await store.all('overlays')) {
    if (!overlays.isVisible(o.id)) continue;
    try {
      const layer = await overlays.layerFor(o);
      if (layer) app.overlayLayer.addLayer(layer);
    } catch (e) { console.warn('overlay', o.name, e); }
  }
  app.drawingLayer.clearLayers();
  if (store.setting('showDrawings', true)) {
    for (const d of await store.all('drawings')) {
      const layer = overlays.drawingLayer(d);
      if (layer) app.drawingLayer.addLayer(layer);
    }
  }
}

async function renderTrack() {
  const pts = await store.all('track');
  app.trackLayer.setLatLngs(store.setting('showTrack', true) ? pts.map((p) => [p.lat, p.lng]) : []);
}

async function renderAll() {
  await Promise.all([renderMarkers(), renderOverlays(), renderTrack()]);
}

// ---- Own position -----------------------------------------------------------------

function selfIcon(stale, course) {
  const rot = course == null ? '' : `<div class="cone" style="transform:rotate(${course}deg)"></div>`;
  return L.divIcon({ className: `self-icon${stale ? ' stale' : ''}`, html: `<div class="self">${course == null ? '' : rot}<div class="core"></div></div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
}

let lastTrackPoint = null;

function updateSelf(fix, initial = false) {
  if (!fix) return;
  const stale = Date.now() - fix.time > 60000;
  const course = geo.getHeading() ?? fix.course;
  const ll = [fix.lat, fix.lng];
  if (!app.selfMarker) {
    app.selfMarker = L.marker(ll, { icon: selfIcon(stale, course), interactive: false, zIndexOffset: 1000 }).addTo(app.map);
    app.selfAccuracy = L.circle(ll, { radius: fix.accuracy || 0, color: '#2f80ed', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(app.map);
  } else {
    app.selfMarker.setLatLng(ll).setIcon(selfIcon(stale, course));
    app.selfAccuracy.setLatLng(ll).setRadius(fix.accuracy || 0);
  }
  const fmt = store.setting('coordFormat', 'mgrs');
  $('coord-self').textContent = formatCoord(fix.lat, fix.lng, fmt);
  $('sb-gps').textContent = stale ? `GPS alt (${ago(fix.time)})` : `GPS ±${Math.round(fix.accuracy || 0)} m`;
  $('sb-gps').style.color = stale ? 'var(--warn)' : '';
  if (initial) return;
  if (app.follow) app.map.panTo(ll, { animate: true });
  updateNav();
  recordTrack(fix);
}

async function recordTrack(fix) {
  if (!store.setting('recordTrack', true)) return;
  if (lastTrackPoint && distance(lastTrackPoint, fix) < 15) return;
  lastTrackPoint = fix;
  await store.put('track', { lat: fix.lat, lng: fix.lng, time: fix.time });
  if (store.setting('showTrack', true)) app.trackLayer.addLatLng([fix.lat, fix.lng]);
  if (Math.random() < 0.02) { // occasional trim to keep the track bounded
    const pts = await store.all('track');
    if (pts.length > 5000) for (const p of pts.slice(0, pts.length - 5000)) await store.del('track', p.seq);
  }
}

export async function clearTrack() {
  await store.clear('track');
  lastTrackPoint = null;
  app.trackLayer.setLatLngs([]);
}

export function setFollow(on) {
  app.follow = on;
  document.querySelector('[data-action=locate]').classList.toggle('active', on);
  if (on) {
    const fix = geo.getLastFix();
    if (fix) app.map.setView([fix.lat, fix.lng], Math.max(app.map.getZoom(), 15));
    else toast('Noch kein GPS-Fix');
  }
}

// ---- Navigation to a target --------------------------------------------------------

export function navigateTo(m) {
  app.navTarget = m;
  updateNav();
}

export function stopNav() {
  app.navTarget = null;
  updateNav();
}

function updateNav() {
  const el = $('sb-nav');
  const fix = geo.getLastFix();
  if (!app.navTarget || !fix) {
    el.classList.add('hidden');
    if (app.navLine) { app.map.removeLayer(app.navLine); app.navLine = null; }
    if (app.navTarget && !fix) { el.textContent = 'Kein GPS'; el.classList.remove('hidden'); }
    return;
  }
  const t = app.navTarget;
  const pts = [[fix.lat, fix.lng], [t.lat, t.lng]];
  if (!app.navLine) app.navLine = L.polyline(pts, { color: '#9fd3ff', weight: 2, dashArray: '8 6', interactive: false }).addTo(app.map);
  else app.navLine.setLatLngs(pts);
  el.textContent = `→ ${t.name || 'Ziel'}: ${formatDistance(distance(fix, t))} · ${formatBearing(bearing(fix, t))}`;
  el.classList.remove('hidden');
  el.onclick = () => { if (confirm('Navigation beenden?')) stopNav(); };
}

// ---- Measure tool ---------------------------------------------------------------------

function startMeasure() {
  app.measure = { pts: [], line: L.polyline([], { color: '#ff3b3b', weight: 3 }).addTo(app.map), dots: L.layerGroup().addTo(app.map) };
  $('measure-bar').classList.remove('hidden');
  document.querySelector('[data-action=measure]').classList.add('active');
  updateMeasure();
}

function stopMeasure() {
  if (!app.measure) return;
  app.map.removeLayer(app.measure.line);
  app.map.removeLayer(app.measure.dots);
  app.measure = null;
  $('measure-bar').classList.add('hidden');
  document.querySelector('[data-action=measure]').classList.remove('active');
}

function measureAdd(ll) {
  app.measure.pts.push(ll);
  L.circleMarker(ll, { radius: 4, color: '#ff3b3b', fillOpacity: 1 }).addTo(app.measure.dots);
  updateMeasure();
}

function updateMeasure() {
  const pts = app.measure.pts;
  app.measure.line.setLatLngs(pts);
  if (pts.length < 2) { $('measure-text').textContent = 'Punkte auf die Karte tippen'; return; }
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += distance(pts[i - 1], pts[i]);
  const last = bearing(pts[pts.length - 2], pts[pts.length - 1]);
  $('measure-text').textContent = `Σ ${formatDistance(total)} · Az ${formatBearing(last)}`;
}

// ---- UI wiring ---------------------------------------------------------------------------

function bindUi() {
  $('toolbar').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action !== 'measure' && app.measure) stopMeasure();
    switch (action) {
      case 'locate': setFollow(!app.follow); break;
      case 'north': toggleCompass(btn); break;
      case 'add': panels.addMarker(app.map.getCenter()); break;
      case 'measure': app.measure ? stopMeasure() : startMeasure(); break;
      default: panels.open(action);
    }
  });
  $('measure-undo').onclick = () => {
    if (!app.measure || !app.measure.pts.length) return;
    app.measure.pts.pop();
    const dots = app.measure.dots.getLayers();
    app.measure.dots.removeLayer(dots[dots.length - 1]);
    updateMeasure();
  };
  $('measure-done').onclick = stopMeasure;
  $('sheet-close').onclick = panels.close;
  $('crosshair').classList.toggle('hidden', !store.setting('crosshair', true));

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('login-error').textContent = '';
    $('login-submit').disabled = true;
    try {
      const u = await sync.login($('login-server').value, $('login-user').value, $('login-pass').value);
      await store.saveSetting('offlineMode', false);
      if (u.mustChangePassword) {
        await forcePasswordChange($('login-pass').value);
      }
      if (!store.setting('basemapChosen', false)) setBasemap('srv-osm');
      afterLogin();
      trust.offerBrowserInstall(sync.state.server).catch(() => {});
    } catch (err) {
      $('login-error').textContent = loginErrorText(err);
    } finally {
      $('login-submit').disabled = false;
    }
  });
  $('login-offline').onclick = async () => {
    await store.saveSetting('offlineMode', true);
    $('login').classList.add('hidden');
    startTracking();
  };
}

/** Forced password change (default or admin-assigned password). */
export async function forcePasswordChange(oldPassword = '') {
  const dlg = $('pw-dialog');
  dlg.classList.remove('hidden');
  $('pw-old').value = oldPassword;
  $('pw-old').closest('label').classList.toggle('hidden', Boolean(oldPassword));
  $('pw-error').textContent = '';
  await new Promise((resolve) => {
    $('pw-form').onsubmit = async (e) => {
      e.preventDefault();
      if ($('pw-new').value !== $('pw-new2').value) { $('pw-error').textContent = 'Passwörter stimmen nicht überein'; return; }
      try {
        await sync.changePassword($('pw-old').value, $('pw-new').value);
        resolve();
      } catch (err) {
        $('pw-error').textContent = err.message;
      }
    };
  });
  dlg.classList.add('hidden');
  toast('Passwort geändert');
  sync.reconnect();
}

function loginErrorText(err) {
  if (err.status === 401) return 'Benutzername oder Passwort falsch';
  if (err.status === 495) return err.message;
  if (err.name === 'AbortError' || err instanceof TypeError) {
    const srv = ($('login-server').value || '').trim().replace(/\/+$/, '');
    return `Server nicht erreichbar. Adresse und WLAN prüfen. Bei HTTPS einmalig die LPU5-CA installieren: ${srv.startsWith('http') ? srv : 'https://' + srv}/lpu5-ca.crt (siehe Anleitung).`;
  }
  return err.message || String(err);
}

export function showLogin() {
  const auth = sync.state;
  $('login-server').value = auth.server || store.setting('lastServer', '');
  $('login-user').value = auth.user?.username || '';
  $('login').classList.remove('hidden');
}

async function toggleCompass(btn) {
  if (btn.classList.contains('active')) { btn.classList.remove('active'); return; }
  const ok = await geo.startCompass();
  if (!ok) { toast('Kompass nicht verfügbar'); return; }
  btn.classList.add('active');
}

function bindSync() {
  sync.on('link', (link) => {
    const el = $('sb-link');
    el.className = `sb-item link ${link}`;
    el.textContent = { online: 'ONLINE', degraded: 'VERBINDE…', offline: 'OFFLINE' }[link];
    if (link === 'online') {
      const fix = geo.getLastFix();
      if (fix) sync.reportPosition(fix, { force: true });
    }
  });
  let renderQueued = false;
  sync.on('data', (d) => {
    if (d.overlays || d.drawings || d.full) renderOverlays();
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; renderMarkers(); });
  });
  sync.on('outbox', (n) => {
    $('sb-outbox').textContent = `⇪ ${n}`;
    $('sb-outbox').classList.toggle('hidden', n === 0);
  });
  sync.on('auth-expired', () => { toast('Sitzung abgelaufen – bitte neu anmelden'); showLogin(); });
  sync.on('chat', (msg) => panels.onChat(msg));
  sync.on('radio', (e) => panels.onRadio(e));
  sync.on('detection', (d) => panels.onDetection(d));
  sync.on('alert', (a) => ops.onAlert(a));
  sync.on('report', (r) => ops.onReport(r));
  sync.on('package', (p) => ops.onPackage(p));
  sync.on('password-required', () => { if ($('pw-dialog').classList.contains('hidden')) forcePasswordChange(); });
  sync.on('wipe', async () => {
    // Remote wipe requested by an administrator (lost or captured device).
    await sync.confirmWipe();
    await lockMod.wipeLocal('Die Einsatzzentrale hat die Löschung dieses Geräts angeordnet.');
  });

  geo.onFix((fix) => { updateSelf(fix); sync.reportPosition(fix); mesh.maybeSendPli(fix, sync.callsign()); });
  mesh.on('data', () => renderMarkers());
  mesh.on('text', (msg) => panels.onMeshText(msg));
  mesh.on('status', (st) => {
    const el = $('sb-mesh');
    el.classList.toggle('hidden', st.status === 'disconnected');
    el.textContent = st.status === 'connected' ? `MESH ${st.nodes.size}` : 'MESH …';
    $('mesh-dot').classList.toggle('hidden', st.status !== 'connected');
    if (st.status === 'disconnected' && st.error) toast(`Mesh: ${st.error}`, 5000);
    panels.onMeshStatus();
  });
  geo.onHeading(() => { const f = geo.getLastFix(); if (f && app.selfMarker) app.selfMarker.setIcon(selfIcon(Date.now() - f.time > 60000, geo.getHeading())); });

  // Re-evaluate staleness of contacts and own fix periodically.
  setInterval(() => { renderMarkers(); updateSelf(geo.getLastFix(), true); }, 30000);
  $('sb-outbox').textContent = `⇪ ${sync.state.outbox}`;
  $('sb-outbox').classList.toggle('hidden', !sync.state.outbox);
}

let toastTimer;
export function toast(text, ms = 3000) {
  const el = $('toast');
  if (!el) return; // e.g. after a local wipe replaced the page
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

export function centerReadout() { updateCenterReadout(); }
export { renderTrack, escapeHtml };

boot().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<div class="screen"><div class="login-box"><h1>Startfehler</h1><p class="error">${escapeHtml(e.message || e)}</p></div></div>`);
});
