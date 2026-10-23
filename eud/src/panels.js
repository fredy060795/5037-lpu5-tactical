// Bottom-sheet panels of the EUD.

import L from 'leaflet';
import * as store from './store.js';
import * as sync from './sync.js';
import * as geo from './geo.js';
import * as overlays from './overlays.js';
import * as mesh from './mesh.js';
import * as camera from './camera.js';
import * as ops from './ops.js';
import * as lockMod from './lock.js';
import { BASEMAPS, countTiles, downloadArea, importMBTiles, clearTiles, tileStats } from './tiles.js';
import { AFFILIATIONS, FUNCTIONS, buildSidc, sidcFor, symbolPreview, escapeHtml } from './symbols.js';
import { distance, bearing, formatDistance, formatBearing, formatCoord, ago } from './geoutil.js';
import { app, toast, setBasemap, availableBasemaps, renderOverlays, renderTrack, clearTrack, navigateTo, showLogin, centerReadout, forcePasswordChange } from './main.js';

const $ = (id) => document.getElementById(id);
let current = null;
let unread = 0;
const chatChannel = 'all';

export function open(name) {
  if (current === name) { close(); return; }
  current = name;
  if (OPS[name]) { markActive(name); OPS[name](); return; }
  document.querySelectorAll('#toolbar button').forEach((b) => b.classList.toggle('active', b.dataset.action === name || (b.dataset.action === 'locate' && app.follow)));
  const fn = PANELS[name];
  if (fn) fn();
}

export function close() {
  current = null;
  $('sheet').classList.add('hidden');
  document.querySelectorAll('#toolbar button').forEach((b) => {
    if (!['locate', 'north', 'measure'].includes(b.dataset.action)) b.classList.remove('active');
  });
  if (videoTimer) { clearInterval(videoTimer); videoTimer = null; }
  const img = document.querySelector('#sheet-body img.video-frame');
  if (img) img.src = ''; // stop MJPEG download
}

export function sheet(title, html) {
  $('sheet-title').textContent = title;
  $('sheet-body').innerHTML = html;
  $('sheet').classList.remove('hidden');
  return $('sheet-body');
}

const OPS = {
  sos: () => ops.sosPanel(),
  report: () => ops.reportPanel(),
  draw: () => ops.drawPanel(),
  packages: () => ops.packagesPanel(),
};

function markActive(name) {
  document.querySelectorAll('#toolbar button').forEach((b) => b.classList.toggle('active', b.dataset.action === name));
}

export function isOpen(name) { return current === name; }

const PANELS = {
  layers: layersPanel,
  offline: offlinePanel,
  contacts: contactsPanel,
  chat: chatPanel,
  video: videoPanel,
  mesh: meshPanel,
  settings: settingsPanel,
};

// ---- Add / edit marker --------------------------------------------------------

export function addMarker(latlng, existing = null) {
  current = 'add';
  let aff = existing?.type && AFFILIATIONS.some((a) => a.id === existing.type) ? existing.type : 'hostile';
  let fnId = existing?.data?.function || 'unit';
  const fmt = store.setting('coordFormat', 'mgrs');
  const body = sheet(existing ? 'Marker bearbeiten' : 'Marker setzen', `
    <div class="muted">${escapeHtml(formatCoord(latlng.lat, latlng.lng, fmt))}</div>
    <h3>Zugehörigkeit</h3>
    <div class="chips" id="aff-chips">${AFFILIATIONS.map((a) => `<button class="chip" data-aff="${a.id}">${symbolPreview(buildSidc(a.id, 'unit'), 22)}${a.label}</button>`).join('')}</div>
    <h3>Typ</h3>
    <div class="chips" id="fn-chips"></div>
    <label>Bezeichnung<input id="mk-name" value="${escapeHtml(existing?.name || '')}" placeholder="z. B. Feind-Trupp 1"></label>
    <label>Bemerkung<textarea id="mk-desc">${escapeHtml(existing?.description || '')}</textarea></label>
    <div class="row"><button class="btn primary grow" id="mk-save">${existing ? 'Speichern' : 'Setzen'}</button></div>
  `);
  const renderFns = () => {
    body.querySelector('#fn-chips').innerHTML = FUNCTIONS.map((f) => `<button class="chip${f.id === fnId ? ' selected' : ''}" data-fn="${f.id}">${symbolPreview(buildSidc(aff, f.id), 22)}${f.label}</button>`).join('');
    body.querySelectorAll('#aff-chips .chip').forEach((c) => c.classList.toggle('selected', c.dataset.aff === aff));
  };
  renderFns();
  body.querySelector('#aff-chips').onclick = (e) => { const c = e.target.closest('[data-aff]'); if (c) { aff = c.dataset.aff; renderFns(); } };
  body.querySelector('#fn-chips').onclick = (e) => { const c = e.target.closest('[data-fn]'); if (c) { fnId = c.dataset.fn; renderFns(); } };
  body.querySelector('#mk-save').onclick = async () => {
    const name = body.querySelector('#mk-name').value.trim() || `${AFFILIATIONS.find((a) => a.id === aff).label} ${FUNCTIONS.find((f) => f.id === fnId).label}`;
    const description = body.querySelector('#mk-desc').value.trim();
    const sidc = buildSidc(aff, fnId);
    const color = AFFILIATIONS.find((a) => a.id === aff).color;
    if (existing) {
      await sync.updateMarker(existing.id, { name, description, type: aff, color, data: { ...(existing.data || {}), sidc, function: fnId } });
    } else {
      await sync.createMarker({
        lat: latlng.lat, lng: latlng.lng, name, description, type: aff, color, icon: 'milsymbol',
        sidc, function: fnId, source_page: 'eud',
      });
    }
    toast(sync.state.link === 'offline' ? 'Gespeichert – wird bei Verbindung gesendet' : 'Gesendet');
    close();
  };
}

export function markerDetails(m) {
  current = 'marker';
  const fix = geo.getLastFix();
  const fmt = store.setting('coordFormat', 'mgrs');
  const sidc = sidcFor(m);
  const rel = fix ? `<b>Entf.</b><span>${formatDistance(distance(fix, m))}</span><b>Richtung</b><span>${formatBearing(bearing(fix, m))}</span>` : '';
  const body = sheet(m.name || m.type || 'Marker', `
    <div class="row">${sidc ? symbolPreview(sidc, 34) : ''}<div class="grow"><strong>${escapeHtml(m.name || '')}</strong>
      <div class="muted">${escapeHtml(m.type || '')}${m._pending ? ' · nicht gesendet' : ''}</div></div></div>
    <div class="pop-grid">
      <b>Position</b><span>${escapeHtml(formatCoord(m.lat, m.lng, fmt))}</span>
      ${rel}
      <b>Von</b><span>${escapeHtml(m.created_by || '–')}</span>
      <b>Stand</b><span>${escapeHtml(ago(m.data?.timestamp || m.timestamp || m.created_at))}</span>
    </div>
    ${m.description ? `<div class="pop-desc">${escapeHtml(m.description)}</div>` : ''}
    <div class="pop-actions">
      <button class="btn small" id="md-nav">Navigieren</button>
      <button class="btn small" id="md-center">Zentrieren</button>
      <button class="btn small" id="md-edit">Bearbeiten</button>
      <button class="btn small danger" id="md-del">Löschen</button>
    </div>
  `);
  body.querySelector('#md-nav').onclick = () => { navigateTo(m); close(); };
  body.querySelector('#md-center').onclick = () => { app.map.setView([m.lat, m.lng], Math.max(app.map.getZoom(), 15)); };
  body.querySelector('#md-edit').onclick = () => addMarker(L.latLng(m.lat, m.lng), m);
  body.querySelector('#md-del').onclick = async () => {
    if (!confirm(`„${m.name}" löschen?`)) return;
    await sync.deleteMarker(m.id);
    close();
  };
}

// ---- Layers & overlays ------------------------------------------------------------------

async function layersPanel() {
  const maps = await availableBasemaps();
  const ovs = await store.all('overlays');
  const cur = store.setting('basemap', 'osm');
  const body = sheet('Karten & Overlays', `
    <h3>Grundkarte</h3>
    <ul class="list">${maps.map((b) => `<li><label class="check grow"><input type="radio" name="bm" value="${escapeHtml(b.id)}" ${b.id === cur ? 'checked' : ''}> ${escapeHtml(b.name)}</label>
      ${b.id.startsWith('mbt-') ? `<button class="btn small" data-rm-mbt="${escapeHtml(b.id)}">✕</button>` : ''}</li>`).join('')}</ul>
    <h3>Overlays</h3>
    <ul class="list">${ovs.length ? ovs.map((o) => `<li><label class="check grow"><input type="checkbox" data-ov="${escapeHtml(o.id)}" ${overlays.isVisible(o.id) ? 'checked' : ''}>
      <span class="grow">${escapeHtml(o.name)}<div class="sub">${o.source === 'local' ? 'Lokal importiert' : 'Server'}</div></span></label>
      ${o.source === 'local' ? `<button class="btn small" data-zoom="${escapeHtml(o.id)}">⌖</button><button class="btn small" data-rm="${escapeHtml(o.id)}">✕</button>` : ''}</li>`).join('') : '<li class="muted">Keine Overlays</li>'}</ul>
    <label class="check"><input type="checkbox" id="ly-drawings" ${store.setting('showDrawings', true) ? 'checked' : ''}> Zeichnungen vom Server</label>
    <label class="check"><input type="checkbox" id="ly-track" ${store.setting('showTrack', true) ? 'checked' : ''}> Eigene Spur anzeigen</label>
    <div class="row"><button class="btn primary grow" id="ly-import">Datei importieren (KML/KMZ/GPX/GeoJSON/MBTiles)</button></div>
  `);
  body.querySelectorAll('input[name=bm]').forEach((r) => { r.onchange = () => { store.saveSetting('basemapChosen', true); setBasemap(r.value); }; });
  body.querySelectorAll('[data-ov]').forEach((c) => { c.onchange = async () => { await overlays.setVisible(c.dataset.ov, c.checked); renderOverlays(); }; });
  body.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = async () => { await overlays.removeLocal(b.dataset.rm); renderOverlays(); layersPanel(); }; });
  body.querySelectorAll('[data-zoom]').forEach((b) => {
    b.onclick = async () => {
      const o = await store.get('overlays', b.dataset.zoom);
      const bounds = L.geoJSON(o.geojson).getBounds();
      if (bounds.isValid()) app.map.fitBounds(bounds, { padding: [30, 30] });
    };
  });
  body.querySelectorAll('[data-rm-mbt]').forEach((b) => {
    b.onclick = async () => {
      const list = ((await store.get('kv', 'mbtilesLayers')) || []).filter((l) => l.id !== b.dataset.rmMbt);
      await store.put('kv', list, 'mbtilesLayers');
      if (store.setting('basemap') === b.dataset.rmMbt) setBasemap('osm');
      layersPanel();
    };
  });
  body.querySelector('#ly-drawings').onchange = async (e) => { await store.saveSetting('showDrawings', e.target.checked); renderOverlays(); };
  body.querySelector('#ly-track').onchange = async (e) => { await store.saveSetting('showTrack', e.target.checked); renderTrack(); };
  body.querySelector('#ly-import').onclick = () => pickFile(handleImport);
}

function pickFile(handler) {
  const input = $('file-input');
  input.value = '';
  input.onchange = () => { if (input.files[0]) handler(input.files[0]); };
  input.click();
}

async function handleImport(file) {
  try {
    if (file.name.toLowerCase().endsWith('.mbtiles')) {
      toast('MBTiles wird importiert…', 60000);
      const id = `mbt-${Date.now()}`;
      const layer = await importMBTiles(file, id, ({ done, total }) => toast(`MBTiles: ${done}/${total} Kacheln`, 60000));
      const list = (await store.get('kv', 'mbtilesLayers')) || [];
      list.push(layer);
      await store.put('kv', list, 'mbtilesLayers');
      await setBasemap(id);
      if (layer.bounds) app.map.fitBounds(layer.bounds);
      toast(`${layer.name}: ${layer.tiles} Kacheln offline verfügbar`);
    } else {
      const o = await overlays.importFile(file);
      await renderOverlays();
      const b = L.geoJSON(o.geojson).getBounds();
      if (b.isValid()) app.map.fitBounds(b, { padding: [30, 30] });
      toast(`Overlay „${o.name}" importiert (${o.geojson.features.length} Objekte)`);
    }
    if (current === 'layers') layersPanel();
  } catch (e) {
    toast(`Import fehlgeschlagen: ${e.message || e}`, 6000);
  }
}

// ---- Offline maps ----------------------------------------------------------------------

let downloadCtrl = null;

async function offlinePanel() {
  const est = await store.storageEstimate();
  const areas = (await store.get('kv', 'offlineAreas')) || [];
  const tileCount = await store.count('tiles');
  const z = app.map.getZoom();
  const def = app.baseDef || BASEMAPS[0];
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted().catch(() => false) : false;
  const body = sheet('Offline-Karten', `
    <div class="muted">Grundkarte: <b>${escapeHtml(def.name)}</b> · ${tileCount} Kacheln gespeichert
      ${est ? ` · ${(est.usage / 1048576).toFixed(0)} MB von ${(est.quota / 1048576).toFixed(0)} MB` : ''}
      · Speicher ${persisted ? 'dauerhaft' : '<span style="color:var(--warn)">nicht garantiert</span>'}</div>
    <h3>Aktuellen Ausschnitt laden</h3>
    <div class="row">
      <label class="grow">Von Zoom<input type="number" id="dl-min" min="1" max="19" value="${Math.max(1, z - 2)}"></label>
      <label class="grow">Bis Zoom<input type="number" id="dl-max" min="1" max="19" value="${Math.min(def.maxNativeZoom || 18, z + 3)}"></label>
    </div>
    <div class="muted" id="dl-count"></div>
    <div class="progress"><div id="dl-bar"></div></div>
    <div class="row">
      <button class="btn primary grow" id="dl-start" ${def.url ? '' : 'disabled'}>Herunterladen</button>
      <button class="btn" id="dl-stop" disabled>Stopp</button>
    </div>
    <label class="check"><input type="checkbox" id="dl-auto" ${store.setting('autoCache', true) ? 'checked' : ''}> Angesehene Kacheln automatisch speichern</label>
    <h3>Gespeicherte Gebiete</h3>
    <ul class="list">${areas.length ? areas.map((a, i) => `<li><span class="grow">${escapeHtml(a.layer)} · Z${a.minZ}–${a.maxZ}<div class="sub">${a.tiles} Kacheln · ${new Date(a.at).toLocaleString()}</div></span>
      <button class="btn small" data-area="${i}">⌖</button></li>`).join('') : '<li class="muted">Noch keine Gebiete geladen</li>'}</ul>
    <div class="row"><button class="btn danger" id="dl-clear">Alle Kacheln löschen</button></div>
    <p class="muted">Tipp: Für größere Gebiete eine MBTiles-Datei über „Karten &amp; Overlays → Datei importieren" laden. Kartendienste wie OSM erlauben keinen Massendownload.</p>
  `);
  const minI = body.querySelector('#dl-min'), maxI = body.querySelector('#dl-max');
  const recount = () => {
    const n = countTiles(app.map.getBounds(), +minI.value, +maxI.value);
    body.querySelector('#dl-count').textContent = `${n.toLocaleString()} Kacheln (≈ ${(n * 0.02).toFixed(0)} MB)`;
    return n;
  };
  minI.oninput = maxI.oninput = recount;
  recount();
  body.querySelector('#dl-auto').onchange = (e) => store.saveSetting('autoCache', e.target.checked);
  body.querySelector('#dl-start').onclick = async () => {
    const n = recount();
    if (n > 30000) { toast('Zu viele Kacheln – Ausschnitt verkleinern oder Zoombereich reduzieren', 5000); return; }
    downloadCtrl = new AbortController();
    body.querySelector('#dl-start').disabled = true;
    body.querySelector('#dl-stop').disabled = false;
    const st = await downloadArea(def, app.map.getBounds(), +minI.value, +maxI.value, (p) => {
      const bar = $('dl-bar');
      if (bar) bar.style.width = `${(100 * p.done) / p.total}%`;
      const c = $('dl-count');
      if (c) c.textContent = `${p.done}/${p.total} · ${p.skipped} vorhanden · ${p.failed} Fehler`;
    }, downloadCtrl.signal);
    downloadCtrl = null;
    toast(`Download fertig: ${st.done - st.failed} Kacheln, ${st.failed} Fehler`);
    if (current === 'offline') offlinePanel();
  };
  body.querySelector('#dl-stop').onclick = () => downloadCtrl && downloadCtrl.abort();
  body.querySelectorAll('[data-area]').forEach((b) => { b.onclick = () => app.map.fitBounds(areas[+b.dataset.area].bounds); });
  body.querySelector('#dl-clear').onclick = async () => {
    if (!confirm('Alle offline gespeicherten Kartenkacheln löschen?')) return;
    await clearTiles();
    offlinePanel();
  };
}

// ---- Contacts --------------------------------------------------------------------

async function contactsPanel() {
  const fix = geo.getLastFix();
  const me = sync.state.user?.username;
  const list = (await store.all('markers')).filter((m) => m.lat != null && !(m.type === 'gps_position' && m.created_by === me));
  const withDist = list.map((m) => ({ m, d: fix ? distance(fix, m) : null }));
  withDist.sort((a, b) => (a.d ?? 1e12) - (b.d ?? 1e12));
  const body = sheet('Kontakte & Marker', `
    <input id="ct-filter" placeholder="Suchen…">
    <ul class="list" id="ct-list"></ul>
  `);
  const render = (q = '') => {
    const ql = q.toLowerCase();
    body.querySelector('#ct-list').innerHTML = withDist
      .filter(({ m }) => !ql || `${m.name} ${m.type} ${m.created_by}`.toLowerCase().includes(ql))
      .slice(0, 300)
      .map(({ m, d }) => {
        const sidc = sidcFor(m);
        return `<li data-id="${escapeHtml(m.id)}">${sidc ? symbolPreview(sidc, 20) : '<span class="dot" style="width:14px;height:14px;border-radius:50%;background:' + escapeHtml(m.color || '#fc0') + '"></span>'}
          <span class="grow">${escapeHtml(m.name || m.type)}<div class="sub">${escapeHtml(m.type || '')} · ${d != null ? formatDistance(d) + ' · ' + formatBearing(bearing(fix, m)) : ''} · ${ago(m.data?.timestamp || m.timestamp || m.created_at)}</div></span></li>`;
      }).join('') || '<li class="muted">Keine Einträge</li>';
  };
  render();
  body.querySelector('#ct-filter').oninput = (e) => render(e.target.value);
  body.querySelector('#ct-list').onclick = async (e) => {
    const li = e.target.closest('[data-id]');
    if (!li) return;
    const m = await store.get('markers', li.dataset.id);
    if (m) { app.map.setView([m.lat, m.lng], Math.max(app.map.getZoom(), 15)); markerDetails(m); }
  };
}

// ---- Chat (server + mesh) ------------------------------------------------------------

let chatTab = 'server';
const meshLog = [];

function notifyChat(msg) {
  unread++;
  $('chat-badge').textContent = unread;
  $('chat-badge').classList.remove('hidden');
  toast(`✉ ${msg.username}: ${String(msg.text).slice(0, 80)}`, 5000);
}

export function onChat(msg) {
  if (current === 'chat' && chatTab === 'server') { appendChat(msg); return; }
  notifyChat(msg);
}

export function onMeshText(msg) {
  meshLog.push(msg);
  if (meshLog.length > 200) meshLog.shift();
  store.put('kv', meshLog, 'meshChat').catch(() => {});
  if (current === 'chat' && chatTab === 'mesh') { appendChat(msg); return; }
  if (!msg.mine) notifyChat({ ...msg, username: `📡 ${msg.username}` });
}

function appendChat(msg, pending = false) {
  const log = document.querySelector('#chat-log');
  if (!log) return;
  if (log.dataset.empty) { log.innerHTML = ''; delete log.dataset.empty; }
  const mine = msg.mine || msg.username === sync.state.user?.username;
  log.insertAdjacentHTML('beforeend', `<div class="msg${mine ? ' mine' : ''}${pending ? ' pending' : ''}"><div class="meta">${escapeHtml(msg.username || '')} · ${msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : 'ausstehend'}</div>${escapeHtml(msg.text)}</div>`);
  log.scrollTop = log.scrollHeight;
}

async function chatPanel() {
  unread = 0;
  $('chat-badge').classList.add('hidden');
  const body = sheet('Chat', `
    <div class="tabs"><button class="btn small" data-tab="server">Server – Alle</button><button class="btn small" data-tab="mesh">📡 Mesh (LoRa)</button><button class="btn small" data-tab="funk">🎙 Funk</button></div>
    <div class="chat-log" id="chat-log" data-empty="1"><div class="muted">Lade…</div></div>
    <form class="row" id="chat-form"><input id="chat-text" class="grow" placeholder="Nachricht" autocomplete="off"><button class="btn primary">Senden</button></form>
  `);
  body.querySelectorAll('[data-tab]').forEach((b) => {
    b.classList.toggle('selected', b.dataset.tab === chatTab);
    b.onclick = () => { chatTab = b.dataset.tab; chatPanel(); };
  });
  const log = body.querySelector('#chat-log');
  let history;
  if (chatTab === 'funk') {
    body.querySelector('#chat-form').classList.add('hidden');
    const entries = sync.isLoggedIn() ? await sync.radioTranscripts() : [];
    if (!document.body.contains(log)) return;
    log.innerHTML = entries.length ? '' : '<div class="muted">Keine Funksprüche protokolliert (Mitschrift im Funk-Bereich des Servers starten).</div>';
    entries.forEach((e) => appendRadio(e));
    return;
  }
  if (chatTab === 'mesh') {
    if (!meshLog.length) meshLog.push(...((await store.get('kv', 'meshChat')) || []));
    history = meshLog;
    if (mesh.state.status !== 'connected') log.insertAdjacentHTML('beforebegin', '<div class="notice">Kein Meshtastic-Gerät verbunden – über 📡 verbinden.</div>');
  } else {
    history = sync.isLoggedIn() ? await sync.chatHistory(chatChannel) : [];
  }
  if (!document.body.contains(log)) return;
  log.innerHTML = history.length ? '' : '<div class="muted">Keine Nachrichten</div>';
  if (!history.length) log.dataset.empty = '1'; else delete log.dataset.empty;
  history.forEach((m) => appendChat(m));
  body.querySelector('#chat-form').onsubmit = async (e) => {
    e.preventDefault();
    const input = body.querySelector('#chat-text');
    const text = input.value.trim();
    if (!text) return;
    if (chatTab === 'funk') {
    body.querySelector('#chat-form').classList.add('hidden');
    const entries = sync.isLoggedIn() ? await sync.radioTranscripts() : [];
    if (!document.body.contains(log)) return;
    log.innerHTML = entries.length ? '' : '<div class="muted">Keine Funksprüche protokolliert (Mitschrift im Funk-Bereich des Servers starten).</div>';
    entries.forEach((e) => appendRadio(e));
    return;
  }
  if (chatTab === 'mesh') {
      try {
        await mesh.sendText(text);
        input.value = '';
        onMeshText({ username: sync.callsign(), text, timestamp: new Date().toISOString(), mine: true });
      } catch (err) { toast(err.message || String(err)); }
      return;
    }
    input.value = '';
    await sync.sendChat(chatChannel, text);
    if (sync.state.link !== 'online') appendChat({ username: sync.state.user?.username, text }, true);
  };
}

function appendRadio(e) {
  const log = document.querySelector('#chat-log');
  if (!log) return;
  if (log.dataset.empty) { log.innerHTML = ''; delete log.dataset.empty; }
  log.insertAdjacentHTML('beforeend', `<div class="msg"><div class="meta">🎙 ${escapeHtml(e.source)} · ${new Date(e.started).toLocaleTimeString()}</div>${escapeHtml(e.text)}</div>`);
  log.scrollTop = log.scrollHeight;
}

export function onRadio(e) {
  if (current === 'chat' && chatTab === 'funk') { appendRadio(e); return; }
  if (store.setting('radioToasts', true)) toast(`🎙 ${e.source}: ${String(e.text).slice(0, 90)}`, 5000);
}

// ---- Meshtastic --------------------------------------------------------------------------

export function onMeshStatus() {
  if (current === 'mesh') meshPanel();
}

function meshPanel() {
  const sup = mesh.support();
  const st = mesh.state;
  const nodes = [...st.nodes.values()].filter((n) => n.num !== st.myNodeNum)
    .sort((a, b) => (b.lastHeard || 0) - (a.lastHeard || 0));
  const fix = geo.getLastFix();
  const statusText = { disconnected: 'Nicht verbunden', connecting: 'Verbinde…', configuring: 'Lade Konfiguration…', connected: `Verbunden mit ${st.deviceName}` }[st.status];
  const body = sheet('Meshtastic (Bluetooth)', `
    ${sup.ok ? '' : `<div class="notice">${escapeHtml(sup.reason)}</div>`}
    <div class="row"><span class="grow"><b>${escapeHtml(statusText)}</b>${st.error ? `<div class="error">${escapeHtml(st.error)}</div>` : ''}</span>
      ${st.status === 'disconnected'
        ? `<button class="btn primary" id="mesh-connect" ${sup.ok ? '' : 'disabled'}>Gerät suchen</button>`
        : '<button class="btn" id="mesh-disconnect">Trennen</button>'}</div>
    <p class="muted">Funktioniert ohne Server und Internet. Kontakte, Positionen, Textnachrichten und ATAK-PLI/GeoChat werden direkt über LoRa ausgetauscht.</p>
    <h3>Eigene Position über Mesh</h3>
    <label class="check"><input type="checkbox" id="mesh-pli" ${store.setting('meshPli', true) ? 'checked' : ''}> Als ATAK-PLI senden (sichtbar in ATAK/WinTAK)</label>
    <label>Intervall (Sekunden, LoRa schonen)<input type="number" id="mesh-int" min="30" max="3600" value="${store.setting('meshPliInterval', 120)}"></label>
    <label>Kanal-Index<input type="number" id="mesh-ch" min="0" max="7" value="${store.setting('meshChannel', 0)}"></label>
    <h3>Knoten (${nodes.length})</h3>
    <ul class="list">${nodes.length ? nodes.slice(0, 200).map((n) => `<li data-num="${n.num}"><span class="grow">${escapeHtml(n.longName || n.shortName || n.num)} <span class="muted">${escapeHtml(n.shortName || '')}</span>
      <div class="sub">${n.lat != null ? (fix ? `${formatDistance(distance(fix, n))} · ${formatBearing(bearing(fix, n))}` : formatCoord(n.lat, n.lng, store.setting('coordFormat', 'mgrs'))) : 'keine Position'} · ${ago(n.lastHeard)}</div></span></li>`).join('') : '<li class="muted">Noch keine Knoten</li>'}</ul>
  `);
  const c = body.querySelector('#mesh-connect');
  if (c) c.onclick = async () => { try { await mesh.connect(); } catch (e) { if (e.name !== 'NotFoundError') toast(`Mesh: ${e.message || e}`, 5000); } };
  const d = body.querySelector('#mesh-disconnect');
  if (d) d.onclick = () => mesh.disconnect();
  body.querySelector('#mesh-pli').onchange = (e) => store.saveSetting('meshPli', e.target.checked);
  body.querySelector('#mesh-int').onchange = (e) => store.saveSetting('meshPliInterval', Math.max(30, +e.target.value || 120));
  body.querySelector('#mesh-ch').onchange = (e) => store.saveSetting('meshChannel', Math.min(7, Math.max(0, +e.target.value || 0)));
  body.querySelector('.list').onclick = (e) => {
    const li = e.target.closest('[data-num]');
    const n = li && st.nodes.get(+li.dataset.num);
    if (n && n.lat != null) app.map.setView([n.lat, n.lng], Math.max(app.map.getZoom(), 14));
  };
}

// ---- Video / analytics --------------------------------------------------------------------

let videoTimer = null;
const recentDetections = [];

export function onDetection(d) {
  recentDetections.unshift({ ...d, at: Date.now() });
  recentDetections.length = Math.min(recentDetections.length, 50);
  if (d.lat != null && d.lng != null) {
    const icon = L.divIcon({ className: 'det-icon', html: escapeHtml(`${d.label} ${Math.round((d.confidence || 0) * 100)}%`) });
    const mk = L.marker([d.lat, d.lng], { icon, interactive: false }).addTo(app.detectionLayer);
    setTimeout(() => app.detectionLayer.removeLayer(mk), 60000);
  }
  if (d.alert) toast(`⚠ ${d.stream_name || 'Video'}: ${d.label} erkannt`, 5000);
  if (current === 'video') renderDetections();
}

function renderDetections() {
  const el = document.querySelector('#det-list');
  if (!el) return;
  el.innerHTML = recentDetections.length
    ? recentDetections.map((d) => `<div>${new Date(d.at).toLocaleTimeString()} · <b>${escapeHtml(d.stream_name || d.stream_id || '')}</b> · ${escapeHtml(d.label)} ${Math.round((d.confidence || 0) * 100)}%</div>`).join('')
    : '<div class="muted">Keine Erkennungen</div>';
}

async function videoPanel() {
  const body = sheet('Video & Analyse', '<div class="muted">Lade Streams…</div>');
  const streams = sync.isLoggedIn() ? await sync.videoStreams() : [];
  if (current !== 'video') return;
  const camSup = camera.cameraSupport();
  const cams = camSup.ok ? await camera.listCameras() : [];
  if (current !== 'video') return;
  body.innerHTML = `
    <h3>Server-Streams (mit KI-Analyse)</h3>
    ${!sync.isLoggedIn() ? '<p class="muted">Video benötigt eine Serververbindung.</p>'
      : streams.length ? `<select id="vid-sel">${streams.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}${s.analytics ? ' · KI' : ''}${s.running ? '' : ' (aus)'}</option>`).join('')}</select>
        <img class="video-frame" id="vid-img" alt=""><div class="muted" id="vid-info"></div>`
      : '<p class="muted">Keine Videoquellen auf dem Server konfiguriert.</p>'}
    <h3>Erkennungen</h3>
    <div class="det-list" id="det-list"></div>
    <h3>Eigene Kamera teilen</h3>
    ${camSup.ok ? '' : `<div class="notice">${escapeHtml(camSup.reason)}</div>`}
    <select id="cam-sel" ${camSup.ok ? '' : 'disabled'}><option value="">Rückkamera (Standard)</option>${cams.map((c) => `<option value="${escapeHtml(c.id)}" ${c.id === camera.camState.deviceId ? 'selected' : ''}>${escapeHtml(c.label)}</option>`).join('')}</select>
    <video class="preview ${camera.camState.active ? '' : 'hidden'}" id="cam-prev" autoplay muted playsinline></video>
    <div class="row">
      <button class="btn ${camera.camState.active ? 'danger' : 'primary'} grow" id="cam-toggle" ${camSup.ok && sync.isLoggedIn() ? '' : 'disabled'}>${camera.camState.active ? 'Teilen beenden' : 'Kamera teilen'}</button>
    </div>
    <div class="muted" id="cam-info">${camera.camState.active ? `Sende als „${escapeHtml(camera.streamId())}" · ${camera.camState.sent} Bilder` : 'Externe USB-Kameras erscheinen in der Liste, sobald der Kamerazugriff erlaubt wurde.'}</div>
  `;
  renderDetections();
  camera.attachPreview(body.querySelector('#cam-prev'));
  body.querySelector('#cam-toggle').onclick = async () => {
    try {
      if (camera.camState.active) await camera.stop();
      else await camera.start(body.querySelector('#cam-sel').value || null, body.querySelector('#cam-prev'));
      videoPanel();
    } catch (e) { toast(e.message || String(e), 6000); }
  };
  if (!streams.length) return;
  const sel = body.querySelector('#vid-sel');
  const show = () => {
    const s = streams.find((x) => x.id === sel.value);
    const img = body.querySelector('#vid-img');
    sync.mediaUrl(`/api/video/streams/${encodeURIComponent(s.id)}/mjpeg`).then((u) => { img.src = u; }).catch(() => img.onerror());
    img.onerror = () => { body.querySelector('#vid-info').textContent = sync.state.link === 'offline' ? 'Offline – kein Video' : 'Stream nicht verfügbar'; };
    body.querySelector('#vid-info').textContent = `${s.source_type || ''} · ${s.analytics ? `KI: ${s.model || 'YOLO'} (${(s.classes || []).join(', ') || 'alle Klassen'})` : 'ohne Analyse'}`;
  };
  sel.onchange = show;
  show();
}

// ---- Settings --------------------------------------------------------------------------------

function settingsPanel() {
  const u = sync.state.user;
  const s = (k, d) => store.setting(k, d);
  const st = tileStats();
  const body = sheet('Einstellungen', `
    <h3>Konto</h3>
    <div>${u ? `${escapeHtml(u.callsign || u.username)} <span class="muted">(${escapeHtml(u.username)}${u.unit ? ', ' + escapeHtml(u.unit) : ''})</span><div class="muted">${escapeHtml(sync.state.server)}</div>` : '<span class="muted">Nicht angemeldet (Offline-Modus)</span>'}</div>
    <div class="row">${u ? '<button class="btn" id="st-logout">Abmelden</button>' : '<button class="btn primary" id="st-login">Anmelden</button>'}
      <button class="btn" id="st-sync" ${u ? '' : 'disabled'}>Jetzt synchronisieren</button></div>
    <div class="muted">Letzte Synchronisierung: ${sync.state.lastSync ? new Date(sync.state.lastSync).toLocaleString() : '–'} · Ausstehend: ${sync.state.outbox}</div>
    ${sync.isAdmin() ? `<div class="row"><a class="btn grow" id="st-hq" href="${escapeHtml(sync.hqUrl())}" target="_blank" rel="noopener">⇦ Hauptansicht (HQ) öffnen</a></div>` : ''}
    <h3>Sicherheit</h3>
    <div class="row">
      <button class="btn" id="st-pw" ${u ? '' : 'disabled'}>Passwort ändern</button>
      <button class="btn" id="st-pin">PIN festlegen</button>
      <button class="btn" id="st-pin-off">PIN entfernen</button>
    </div>
    <label>Sperren nach Hintergrund (Minuten, 0 = sofort)<input type="number" id="st-lock" min="0" max="240" value="${s('lockAfterMinutes', 5)}"></label>
    <div class="muted">Nach 10 falschen PIN-Eingaben werden alle Daten auf diesem Gerät gelöscht. Administratoren können ein verlorenes Gerät aus der Ferne löschen.</div>
    <h3>Standort (PLI)</h3>
    <label>Sendeintervall (Sekunden)<input type="number" id="st-pli" min="2" max="600" value="${s('pliInterval', 10)}"></label>
    <label>Mindestbewegung GPS (Meter, nach Neustart)<input type="number" id="st-dist" min="0" max="500" value="${s('distanceFilter', 5)}"></label>
    <label class="check"><input type="checkbox" id="st-track" ${s('recordTrack', true) ? 'checked' : ''}> Eigene Spur aufzeichnen</label>
    <div class="row"><button class="btn" id="st-cleartrack">Spur löschen</button></div>
    <h3>Anzeige</h3>
    <label>Koordinatenformat<select id="st-fmt">
      ${[['mgrs', 'MGRS / UTMREF'], ['dd', 'Dezimalgrad'], ['dms', 'Grad Min Sek']].map(([v, l]) => `<option value="${v}" ${s('coordFormat', 'mgrs') === v ? 'selected' : ''}>${l}</option>`).join('')}
    </select></label>
    <label class="check"><input type="checkbox" id="st-cross" ${s('crosshair', true) ? 'checked' : ''}> Fadenkreuz in Kartenmitte</label>
    <label class="check"><input type="checkbox" id="st-awake" ${s('keepAwake', true) ? 'checked' : ''}> Bildschirm anlassen</label>
    <h3>Eigener Kartenserver (XYZ)</h3>
    <label>URL-Vorlage<input id="st-tiles" placeholder="https://server/tiles/{z}/{x}/{y}.png" value="${escapeHtml(s('customTiles', null)?.url || '')}"></label>
    <div class="row"><button class="btn" id="st-tiles-save">Übernehmen</button></div>
    <h3>Diagnose</h3>
    <div class="muted">Kacheln: ${st.hits} aus Cache, ${st.misses} geladen, ${st.fallbacks} hochskaliert</div>
  `);
  const bindNum = (id, key) => { body.querySelector(id).onchange = (e) => store.saveSetting(key, Math.max(+e.target.min, +e.target.value || 0)); };
  bindNum('#st-pli', 'pliInterval');
  bindNum('#st-lock', 'lockAfterMinutes');
  const pwBtn = body.querySelector('#st-pw');
  if (pwBtn) pwBtn.onclick = () => { close(); forcePasswordChange(); };
  lockMod.hasPin().then((has) => {
    const off = body.querySelector('#st-pin-off');
    if (off) off.disabled = !has;
    const on = body.querySelector('#st-pin');
    if (on) on.textContent = has ? 'PIN ändern' : 'PIN festlegen';
  });
  body.querySelector('#st-pin').onclick = async () => {
    const pin = prompt('Neue PIN (4–8 Ziffern):');
    if (pin === null) return;
    if (pin !== prompt('PIN wiederholen:')) { toast('PINs stimmen nicht überein'); return; }
    try { await lockMod.setPin(pin); toast('PIN gesetzt'); settingsPanel(); } catch (e) { toast(e.message, 5000); }
  };
  body.querySelector('#st-pin-off').onclick = async () => {
    if (!confirm('PIN-Sperre entfernen?')) return;
    await lockMod.removePin(); toast('PIN entfernt'); settingsPanel();
  };
  bindNum('#st-dist', 'distanceFilter');
  body.querySelector('#st-track').onchange = (e) => store.saveSetting('recordTrack', e.target.checked);
  body.querySelector('#st-cleartrack').onclick = async () => { if (confirm('Aufgezeichnete Spur löschen?')) { await clearTrack(); toast('Spur gelöscht'); } };
  body.querySelector('#st-fmt').onchange = async (e) => { await store.saveSetting('coordFormat', e.target.value); centerReadout(); };
  body.querySelector('#st-cross').onchange = (e) => { store.saveSetting('crosshair', e.target.checked); $('crosshair').classList.toggle('hidden', !e.target.checked); };
  body.querySelector('#st-awake').onchange = (e) => store.saveSetting('keepAwake', e.target.checked);
  body.querySelector('#st-tiles-save').onclick = async () => {
    const url = body.querySelector('#st-tiles').value.trim();
    if (url && !/\{z\}.*\{x\}.*\{y\}|\{z\}.*\{y\}.*\{x\}/.test(url)) { toast('URL muss {z}, {x} und {y} enthalten'); return; }
    await store.saveSetting('customTiles', url ? { id: 'custom', name: 'Eigener Kartenserver', url, maxNativeZoom: 19, attribution: '' } : null);
    if (url) await setBasemap('custom');
    toast(url ? 'Kartenserver übernommen' : 'Kartenserver entfernt');
  };
  const syncBtn = body.querySelector('#st-sync');
  syncBtn.onclick = async () => { syncBtn.disabled = true; await sync.reconnect(); toast(`Status: ${sync.state.link}`); settingsPanel(); };
  const lo = body.querySelector('#st-logout');
  if (lo) lo.onclick = async () => {
    if (sync.state.outbox && !confirm(`${sync.state.outbox} Meldungen wurden noch nicht gesendet und gehen verloren. Trotzdem abmelden?`)) return;
    await store.saveSetting('lastServer', sync.state.server);
    await store.clear('outbox');
    await sync.logout();
    close();
    showLogin();
  };
  const li = body.querySelector('#st-login');
  if (li) li.onclick = () => { close(); showLogin(); };
}
