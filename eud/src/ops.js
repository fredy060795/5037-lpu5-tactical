// Operational functions of the EUD: emergency alerts, reports (9-line
// MEDEVAC, SALUTE, SITREP, spot report), drawing routes / lines / areas /
// range rings, and ATAK data packages. Everything is exchanged with
// ATAK/WinTAK through the LPU5 server (tak_integration.py); alerts and reports
// also go out over the mesh radio when the server is unreachable.

import L from 'leaflet';
import * as store from './store.js';
import * as sync from './sync.js';
import * as geo from './geo.js';
import * as mesh from './mesh.js';
import { sheet, close, isOpen } from './panels.js';
import { app, toast, renderOverlays } from './main.js';
import { escapeHtml } from './symbols.js';
import { distance, bearing, formatDistance, formatBearing, formatCoord } from './geoutil.js';

const $ = (id) => document.getElementById(id);

function here() {
  const fix = geo.getLastFix();
  if (fix) return { lat: fix.lat, lng: fix.lng, source: 'GPS' };
  const c = app.map.getCenter();
  return { lat: c.lat, lng: c.lng, source: 'Kartenmitte' };
}

function fmt(p) { return formatCoord(p.lat, p.lng, store.setting('coordFormat', 'mgrs')); }

async function viaMesh(text) {
  if (mesh.state.status !== 'connected') return false;
  try { await mesh.sendText(text.slice(0, 220)); return true; } catch (_) { return false; }
}

// ---- Emergency alerts ---------------------------------------------------------

const ALERTS = [
  { kind: '911', label: '911 – NOTRUF', cls: 'danger', desc: 'Lebensgefahr, sofortige Hilfe' },
  { kind: 'in_contact', label: 'FEINDKONTAKT (TIC)', cls: 'danger', desc: 'Troops in Contact' },
  { kind: 'ring_the_bell', label: 'RING THE BELL', cls: 'warn', desc: 'Alle sofort aufmerksam machen' },
  { kind: 'cancel', label: 'Alarm aufheben', cls: '', desc: 'Eigenen Alarm beenden' },
];

export function sosPanel() {
  const p = here();
  const body = sheet('Notruf / Alarm', `
    <p class="muted">Gedrückt halten (1,5 s) zum Auslösen. Position: ${escapeHtml(fmt(p))} (${p.source}).
      Geht an LPU5, ATAK/WinTAK und – ohne Server – über das Mesh-Funkgerät.</p>
    <div class="sos-grid">${ALERTS.map((a) => `<button class="btn sos ${a.cls}" data-kind="${a.kind}"><b>${a.label}</b><span>${a.desc}</span><i class="hold"></i></button>`).join('')}</div>
    <h3>Aktive Alarme</h3><ul class="list" id="sos-active"><li class="muted">Lade…</li></ul>
  `);
  body.querySelectorAll('.sos').forEach((btn) => {
    let timer = null;
    const start = (e) => {
      e.preventDefault();
      btn.classList.add('holding');
      timer = setTimeout(() => { btn.classList.remove('holding'); fire(btn.dataset.kind); }, 1500);
    };
    const stop = () => { clearTimeout(timer); btn.classList.remove('holding'); };
    btn.addEventListener('pointerdown', start);
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointerleave', stop);
    btn.addEventListener('pointercancel', stop);
  });
  sync.activeAlerts().then((list) => {
    const el = $('sos-active');
    if (!el) return;
    el.innerHTML = list.length ? list.map((a) => `<li><span class="grow"><b>${escapeHtml(a.label)}</b> · ${escapeHtml(a.callsign || '')}<div class="sub">${escapeHtml(fmt(a))}</div></span></li>`).join('') : '<li class="muted">Keine</li>';
  });
}

async function fire(kind) {
  const p = here();
  const a = ALERTS.find((x) => x.kind === kind);
  await sync.raiseAlert(kind, p);
  const meshSent = await viaMesh(`⚠ ${a.label} ${sync.callsign()} ${fmt(p)}`);
  if (navigator.vibrate) navigator.vibrate([300, 100, 300]);
  toast(`${a.label} ausgelöst${sync.state.link === 'offline' ? (meshSent ? ' – über Mesh gesendet, Server folgt' : ' – wird bei Verbindung gesendet') : ''}`, 5000);
  close();
}

const activeAlerts = new Map();
let alertLayer = null;

export function onAlert(a) {
  alertLayer = alertLayer || L.layerGroup().addTo(app.map);
  const key = a.sender_uid || a.callsign || a.id;
  const prev = activeAlerts.get(key);
  if (prev) { alertLayer.removeLayer(prev.marker); activeAlerts.delete(key); }
  if (a.kind !== 'cancel') {
    const marker = L.marker([a.lat, a.lng], {
      icon: L.divIcon({ className: 'alert-icon', html: `<span>⚠ ${escapeHtml(a.callsign || '')}</span>`, iconSize: [24, 24], iconAnchor: [12, 12] }),
      zIndexOffset: 2000,
    }).addTo(alertLayer);
    activeAlerts.set(key, { ...a, marker });
    if (navigator.vibrate) navigator.vibrate([600, 200, 600, 200, 600]);
  }
  renderBanner();
}

function renderBanner() {
  let el = $('alert-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'alert-banner';
    document.body.appendChild(el);
    el.onclick = () => {
      const first = [...activeAlerts.values()][0];
      if (first) app.map.setView([first.lat, first.lng], Math.max(app.map.getZoom(), 15));
    };
  }
  const list = [...activeAlerts.values()];
  el.classList.toggle('hidden', list.length === 0);
  const fix = geo.getLastFix();
  el.innerHTML = list.map((a) => `⚠ ${escapeHtml(a.label || a.kind)} · ${escapeHtml(a.callsign || '')}${fix ? ` · ${formatDistance(distance(fix, a))} ${Math.round(bearing(fix, a))}°` : ''}`).join('<br>');
}

// ---- Reports ----------------------------------------------------------------------

const REPORTS = {
  medevac: {
    title: 'MEDEVAC 9-Liner',
    fields: [
      ['title', 'Rufname / Bezeichnung', 'text'],
      ['freq', 'Zeile 2: Frequenz', 'text'],
      ['urgent', 'Zeile 3: A – Dringend (Anzahl)', 'number'],
      ['priority', 'Zeile 3: B – Vorrangig (Anzahl)', 'number'],
      ['routine', 'Zeile 3: C – Routine (Anzahl)', 'number'],
      ['equipment', 'Zeile 4: Sonderausrüstung', ['Keine', 'Winde', 'Bergegerät', 'Beatmung']],
      ['litter', 'Zeile 5: Liegend (Anzahl)', 'number'],
      ['ambulatory', 'Zeile 5: Gehfähig (Anzahl)', 'number'],
      ['security', 'Zeile 6: Lage am LZ', ['N – Kein Feind', 'P – Feind möglich', 'E – Feind im Gebiet', 'X – Bewaffnete Eskorte nötig']],
      ['hlz_marking', 'Zeile 7: Markierung', ['Panels', 'Pyrotechnik', 'Rauch', 'Keine', 'Sonstige']],
      ['nationality', 'Zeile 8: Patienten', ['Eigene Kräfte', 'Verbündete', 'Zivilisten', 'Gegner (EPW)']],
      ['medline_remarks', 'Zeile 9: Gelände / Hindernisse / Verletzungen', 'textarea'],
    ],
  },
  salute: {
    title: 'SALUTE-Meldung',
    fields: [
      ['size', 'S – Stärke', 'text'],
      ['activity', 'A – Tätigkeit', 'text'],
      ['location_note', 'L – Ort (Zusatz)', 'text'],
      ['unit', 'U – Einheit / Kennzeichen', 'text'],
      ['time', 'T – Zeit', 'datetime'],
      ['equipment', 'E – Ausrüstung / Fahrzeuge', 'text'],
    ],
  },
  sitrep: {
    title: 'Lagemeldung (SITREP)',
    fields: [
      ['status', 'Eigener Status', ['Einsatzbereit', 'Eingeschränkt', 'Nicht einsatzbereit']],
      ['situation', 'Lage', 'textarea'],
      ['actions', 'Eigene Maßnahmen', 'textarea'],
      ['needs', 'Bedarf / Unterstützung', 'textarea'],
    ],
  },
  spot: {
    title: 'Spot-Meldung',
    fields: [['what', 'Was wurde beobachtet?', 'textarea'], ['time', 'Zeit', 'datetime']],
  },
};

let reportKind = 'medevac';

function fieldHtml([key, label, type]) {
  if (Array.isArray(type)) {
    return `<label>${label}<select data-f="${key}">${type.map((o, i) => `<option value="${i}">${escapeHtml(o)}</option>`).join('')}</select></label>`;
  }
  if (type === 'textarea') return `<label>${label}<textarea data-f="${key}"></textarea></label>`;
  if (type === 'datetime') {
    const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    return `<label>${label}<input type="datetime-local" data-f="${key}" value="${now}"></label>`;
  }
  return `<label>${label}<input type="${type}" ${type === 'number' ? 'min="0" inputmode="numeric"' : ''} data-f="${key}"></label>`;
}

export function reportPanel() {
  const def = REPORTS[reportKind];
  const p = here();
  const body = sheet('Meldung', `
    <div class="tabs">${Object.entries(REPORTS).map(([k, r]) => `<button class="btn small${k === reportKind ? ' selected' : ''}" data-rk="${k}">${r.title.split(' ')[0]}</button>`).join('')}</div>
    <h3>${def.title}</h3>
    <div class="muted">Zeile 1 / Ort: <b id="rp-pos">${escapeHtml(fmt(p))}</b> (${p.source}) <button class="btn small" id="rp-center">Kartenmitte nehmen</button></div>
    ${def.fields.map(fieldHtml).join('')}
    <label>Bemerkung<textarea id="rp-remarks"></textarea></label>
    <div class="row"><button class="btn primary grow" id="rp-send">Meldung senden</button></div>
  `);
  let pos = p;
  body.querySelectorAll('[data-rk]').forEach((b) => { b.onclick = () => { reportKind = b.dataset.rk; reportPanel(); }; });
  body.querySelector('#rp-center').onclick = () => {
    const c = app.map.getCenter();
    pos = { lat: c.lat, lng: c.lng, source: 'Kartenmitte' };
    body.querySelector('#rp-pos').textContent = fmt(pos);
  };
  if (reportKind === 'medevac') body.querySelector('[data-f=title]').value = sync.callsign();
  body.querySelector('#rp-send').onclick = async () => {
    const fields = {};
    for (const [key, , type] of def.fields) {
      const el = body.querySelector(`[data-f="${key}"]`);
      fields[key] = Array.isArray(type) ? type[+el.value] : el.value.trim();
      if (Array.isArray(type) && reportKind === 'medevac' && ['security', 'hlz_marking'].includes(key)) fields[key] = el.value;
    }
    if (reportKind === 'medevac') {
      const eq = body.querySelector('[data-f=equipment]').value;
      fields.hoist = eq === '1' ? 'true' : 'false';
      fields.extraction_equipment = eq === '2' ? 'true' : 'false';
      fields.ventilator = eq === '3' ? 'true' : 'false';
      delete fields.equipment;
    }
    fields.mgrs = formatCoord(pos.lat, pos.lng, 'mgrs');
    const remarks = body.querySelector('#rp-remarks').value.trim();
    await sync.submitReport({ kind: reportKind, fields, remarks, lat: pos.lat, lng: pos.lng });
    const summary = `${def.title} ${sync.callsign()} ${fields.mgrs}: ${Object.entries(fields).filter(([k, v]) => v && k !== 'mgrs').map(([k, v]) => `${k}=${v}`).join(' ')}`;
    const meshSent = sync.state.link === 'offline' ? await viaMesh(summary) : false;
    toast(sync.state.link === 'offline' ? (meshSent ? 'Über Mesh gesendet – Server folgt' : 'Gespeichert – wird bei Verbindung gesendet') : 'Meldung gesendet', 4000);
    close();
  };
}

export function onReport(r) {
  if (r.source === 'lpu5' && r.author === sync.state.user?.username) return;
  const title = REPORTS[r.kind]?.title || r.kind;
  toast(`📝 ${title} von ${r.callsign || '?'}`, 6000);
  if (r.lat && r.lng) {
    L.circleMarker([r.lat, r.lng], { radius: 9, color: r.kind === 'medevac' ? '#ff4d4d' : '#ffd24d', weight: 3, fillOpacity: 0.3 })
      .bindPopup(`<b>${escapeHtml(title)}</b><br>${escapeHtml(r.callsign || '')}<div class="pop-desc">${escapeHtml(Object.entries(r.fields || {}).map(([k, v]) => `${k}: ${v}`).join('\n'))}${r.remarks ? '\n' + escapeHtml(r.remarks) : ''}</div>`)
      .addTo(app.map);
  }
}

// ---- Drawing: routes, lines, areas, range rings -------------------------------------

let drawState = null;

export function drawPanel() {
  const body = sheet('Zeichnen', `
    <p class="muted">Wird mit dem Lagebild und ATAK/WinTAK synchronisiert (auch offline erstellt, später gesendet).</p>
    <div class="chips">
      <button class="chip" data-tool="route">↝<span>Route</span></button>
      <button class="chip" data-tool="polyline">╱<span>Linie</span></button>
      <button class="chip" data-tool="polygon">⬠<span>Fläche</span></button>
      <button class="chip" data-tool="rings">◎<span>Entfernungsringe</span></button>
    </div>
    <label>Name<input id="dr-name" placeholder="z. B. Route Alpha"></label>
    <label>Farbe<input id="dr-color" type="color" value="#ffcc00"></label>
    <label id="dr-rings-wrap">Ringe (Meter, Komma)<input id="dr-rings" value="500, 1000, 2000"></label>
    <h3>Zeichnungen</h3><ul class="list" id="dr-list"></ul>
  `);
  body.querySelectorAll('[data-tool]').forEach((b) => {
    b.onclick = () => startDraw(b.dataset.tool, body.querySelector('#dr-name').value.trim(), body.querySelector('#dr-color').value,
      body.querySelector('#dr-rings').value);
  });
  store.all('drawings').then((list) => {
    const el = $('dr-list');
    if (!el) return;
    el.innerHTML = list.length ? list.slice(-50).reverse().map((d) => `<li><span class="grow">${escapeHtml(d.name || d.type)}<div class="sub">${escapeHtml(d.type)} · ${escapeHtml(d.created_by || '')}${d._pending ? ' · nicht gesendet' : ''}</div></span>
      <button class="btn small" data-zoom="${escapeHtml(d.id)}">⌖</button><button class="btn small" data-del="${escapeHtml(d.id)}">✕</button></li>`).join('') : '<li class="muted">Keine Zeichnungen</li>';
    el.onclick = async (e) => {
      const z = e.target.closest('[data-zoom]');
      const del = e.target.closest('[data-del]');
      if (z) {
        const d = await store.get('drawings', z.dataset.zoom);
        const pts = (d.coordinates || []).map((c) => (Array.isArray(c) ? c : [c.lat, c.lng]));
        if (pts.length) app.map.fitBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 16 });
      }
      if (del && confirm('Zeichnung löschen?')) { await sync.deleteDrawing(del.dataset.del); drawPanel(); }
    };
  });
}

function startDraw(tool, name, color, ringsText) {
  close();
  if (tool === 'rings') {
    const c = app.map.getCenter();
    const radii = ringsText.split(/[,; ]+/).map(Number).filter((r) => r > 0).slice(0, 8);
    if (!radii.length) { toast('Radien angeben, z. B. 500, 1000'); return; }
    (async () => {
      for (const r of radii) {
        await sync.createDrawing({ name: `${name || 'Ring'} ${formatDistance(r)}`, type: 'circle', coordinates: [[c.lat, c.lng]],
          color, weight: 2, radius: r, data: { radius: r, kind: 'range_ring' } });
      }
      renderOverlays();
      toast(`${radii.length} Entfernungsringe um die Kartenmitte gesetzt`);
    })();
    return;
  }
  drawState = { tool, name, color, pts: [], line: L.polyline([], { color, weight: 4, dashArray: tool === 'route' ? '10 6' : null }).addTo(app.map), dots: L.layerGroup().addTo(app.map) };
  let bar = $('draw-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'draw-bar';
    bar.innerHTML = '<span id="draw-text"></span><button class="btn small" id="draw-undo">↶</button><button class="btn small" id="draw-cancel">✕</button><button class="btn small primary" id="draw-done">Speichern</button>';
    document.body.appendChild(bar);
  }
  bar.classList.remove('hidden');
  const update = () => {
    const pts = drawState.pts;
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += distance(pts[i - 1], pts[i]);
    $('draw-text').textContent = `${{ route: 'Route', polyline: 'Linie', polygon: 'Fläche' }[tool]}: ${pts.length} Punkte${len ? ' · ' + formatDistance(len) : ''} – auf die Karte tippen`;
    drawState.line.setLatLngs(tool === 'polygon' && pts.length > 2 ? [...pts, pts[0]] : pts);
  };
  const onClick = (e) => {
    drawState.pts.push(e.latlng);
    L.circleMarker(e.latlng, { radius: 5, color, fillOpacity: 1 }).addTo(drawState.dots);
    update();
  };
  const finish = async (save) => {
    app.map.off('click', onClick);
    app.drawing = false;
    const st = drawState;
    drawState = null;
    app.map.removeLayer(st.line);
    app.map.removeLayer(st.dots);
    bar.classList.add('hidden');
    if (!save) return;
    const min = tool === 'polygon' ? 3 : 2;
    if (st.pts.length < min) { toast(`Mindestens ${min} Punkte nötig`); return; }
    const coords = st.pts.map((p) => [p.lat, p.lng]);
    const d = { name: st.name || { route: 'Route', polyline: 'Linie', polygon: 'Fläche' }[tool], type: tool, coordinates: coords, color, weight: 4 };
    if (tool === 'route') {
      // Top level: the server stores the whole payload as drawing.data, which
      // tak_integration reads when sending the route to ATAK (b-m-r).
      d.waypoints = coords.map((_, i) => ({ name: i === 0 ? 'SP' : i === coords.length - 1 ? 'ZIEL' : `CP${i}` }));
      d.route = { method: 'Walking', prefix: 'CP' };
    }
    await sync.createDrawing(d);
    renderOverlays();
    toast(`${d.name} gespeichert`);
  };
  app.drawing = true;
  app.map.on('click', onClick);
  $('draw-undo').onclick = () => {
    if (!drawState || !drawState.pts.length) return;
    drawState.pts.pop();
    const dots = drawState.dots.getLayers();
    drawState.dots.removeLayer(dots[dots.length - 1]);
    update();
  };
  $('draw-cancel').onclick = () => finish(false);
  $('draw-done').onclick = () => finish(true);
  update();
}

// ---- Data packages (ATAK) ---------------------------------------------------------------

export async function packagesPanel() {
  const body = sheet('Data Packages (ATAK)', '<div class="muted">Lade…</div>');
  if (!sync.isLoggedIn()) { body.innerHTML = '<p class="muted">Benötigt eine Serververbindung.</p>'; return; }
  const list = await sync.packages();
  if (!isOpen('packages')) return;
  body.innerHTML = `
    <p class="muted">Pakete von ATAK/WinTAK („An Server senden“) und LPU5. Importieren übernimmt enthaltene Marker, Zeichnungen und KML/GPX ins Lagebild.</p>
    <ul class="list">${list.length ? list.map((p) => `<li><span class="grow">${escapeHtml(p.name)}<div class="sub">${(p.size / 1024).toFixed(0)} KB · ${escapeHtml(p.creator || '')} · ${escapeHtml((p.submitted || '').slice(0, 16).replace('T', ' '))}</div></span>
      <button class="btn small" data-imp="${p.hash}">Import</button><button class="btn small" data-dl="${p.hash}">⬇</button></li>`).join('') : '<li class="muted">Keine Pakete</li>'}</ul>
    <div class="row"><button class="btn grow" id="pk-upload">Datei hochladen</button><button class="btn grow" id="pk-export">Lage exportieren</button></div>
    <div class="row"><button class="btn grow" id="pk-conn">ATAK-Verbindungspaket</button></div>
    <input type="file" id="pk-file" class="hidden" accept=".zip,.dpk,.kml,.kmz,.gpx,.geojson">
  `;
  const openMedia = async (path) => {
    try { window.open(await sync.mediaUrl(path), '_blank'); } catch (e) { toast(e.message); }
  };
  body.onclick = async (e) => {
    const imp = e.target.closest('[data-imp]');
    const dl = e.target.closest('[data-dl]');
    if (imp) {
      imp.disabled = true;
      try {
        const r = await sync.importPackage(imp.dataset.imp);
        toast(`Importiert: ${r.cot} Objekte, ${r.overlays} Overlays`);
        await sync.pullAll();
      } catch (err) { toast(`Import fehlgeschlagen: ${err.message}`); }
      imp.disabled = false;
    }
    if (dl) openMedia(`/api/tak/packages/${dl.dataset.dl}`);
  };
  body.querySelector('#pk-export').onclick = () => openMedia('/api/tak/export.zip');
  body.querySelector('#pk-conn').onclick = () => openMedia('/api/tak/connection-package?protocol=tcp');
  const input = body.querySelector('#pk-file');
  body.querySelector('#pk-upload').onclick = () => input.click();
  input.onchange = async () => {
    const f = input.files[0];
    if (!f) return;
    try { await sync.uploadPackage(f); toast('Hochgeladen'); packagesPanel(); } catch (err) { toast(`Upload fehlgeschlagen: ${err.message}`); }
  };
}

export function onPackage(p) {
  toast(`📦 Neues Data Package: ${p.name}`, 5000);
}
