// Geofences: zones defined in LPU5 (exclusion / safe / observation) are kept
// on the device, drawn on the map and checked against the own position
// locally – entering or leaving a zone alarms even without any link.
// Breaches are reported to LPU5 / ATAK as "geofence breached" alert.

import L from 'leaflet';
import * as store from './store.js';
import * as sync from './sync.js';
import { escapeHtml } from './symbols.js';
import { distance, formatDistance } from './geoutil.js';

const HYSTERESIS_M = 15;
const COLORS = { exclusion: '#ff4d4d', danger: '#ff4d4d', safe: '#4dff88', observation: '#ffd24d' };
let layer = null;
let fences = [];
let inside = {};

export async function init(map, onAlarm) {
  layer = L.layerGroup().addTo(map);
  fences = (await store.get('kv', 'geofences')) || [];
  inside = (await store.get('kv', 'geofenceState')) || {};
  render();
  init.onAlarm = onAlarm;
}

export async function refresh() {
  if (!sync.isLoggedIn()) return;
  try {
    const res = await fetch(sync.serverUrl('/api/geofence/list?enabled_only=true'), {
      headers: { Authorization: `Bearer ${sync.state.token}` },
    });
    if (!res.ok) return;
    fences = (await res.json()).geofences || [];
    await store.put('kv', fences, 'geofences');
    render();
  } catch (_) { /* offline: keep cached zones */ }
}

function render() {
  if (!layer) return;
  layer.clearLayers();
  if (!store.setting('showGeofences', true)) return;
  for (const f of fences) {
    if (f.enabled === false) continue;
    const color = COLORS[f.zone_type] || '#80e0ff';
    L.circle([f.center_lat, f.center_lon], {
      radius: f.radius_meters, color, weight: 2, dashArray: '6 6', fillOpacity: f.zone_type === 'exclusion' ? 0.12 : 0.05,
    }).bindPopup(`<b>${escapeHtml(f.name)}</b><div class="pop-desc">${escapeHtml(f.zone_type)} · ${formatDistance(f.radius_meters)}${f.alert_on_entry ? ' · Alarm bei Betreten' : ''}${f.alert_on_exit ? ' · Alarm bei Verlassen' : ''}</div>`)
      .addTo(layer);
  }
}

export function list() { return fences; }

/** Check the own position; returns the alarms raised. */
export async function check(fix) {
  if (!fix || !fences.length) return [];
  const alarms = [];
  let changed = false;
  for (const f of fences) {
    if (f.enabled === false) continue;
    const d = distance(fix, { lat: f.center_lat, lng: f.center_lon });
    const was = Boolean(inside[f.zone_id]);
    let now = was;
    if (!was && d <= f.radius_meters - HYSTERESIS_M) now = true;
    if (was && d >= f.radius_meters + HYSTERESIS_M) now = false;
    if (now === was) continue;
    inside[f.zone_id] = now;
    changed = true;
    if ((now && f.alert_on_entry) || (!now && f.alert_on_exit)) {
      const text = `${now ? 'Betreten' : 'Verlassen'}: ${f.name} (${f.zone_type})`;
      alarms.push({ fence: f, entered: now, text });
      await sync.raiseAlert('geofence_breached', fix, text);
      if (init.onAlarm) init.onAlarm(text, f, now);
    }
  }
  if (changed) await store.put('kv', inside, 'geofenceState');
  return alarms;
}

export function setVisible(v) {
  store.saveSetting('showGeofences', v);
  render();
}
