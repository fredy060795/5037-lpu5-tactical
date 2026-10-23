// Overlays: KML/KMZ/GPX/GeoJSON files imported on the device, image overlays
// and drawings from the server. All of them are kept in IndexedDB and drawn
// from there, so they stay on the map without a link.

import L from 'leaflet';
import { kml, gpx } from '@tmcw/togeojson';
import JSZip from 'jszip';
import * as store from './store.js';
import { overlayImage, overlayFile } from './sync.js';
import { escapeHtml } from './symbols.js';

/** KML/KMZ/GPX/GeoJSON file (File or Blob + name) -> GeoJSON FeatureCollection. */
export async function parseFile(file, name = file.name) {
  const ext = name.split('.').pop().toLowerCase();
  let geojson;
  if (ext === 'kmz') {
    const zip = await JSZip.loadAsync(file);
    const kmlEntry = Object.values(zip.files).find((f) => f.name.toLowerCase().endsWith('.kml'));
    if (!kmlEntry) throw new Error('KMZ enthält keine KML-Datei');
    geojson = kml(parseXml(await kmlEntry.async('text')));
  } else if (ext === 'kml') {
    geojson = kml(parseXml(await file.text()));
  } else if (ext === 'gpx') {
    geojson = gpx(parseXml(await file.text()));
  } else if (ext === 'geojson' || ext === 'json') {
    geojson = JSON.parse(await file.text());
    if (geojson.type === 'Feature') geojson = { type: 'FeatureCollection', features: [geojson] };
  } else {
    throw new Error(`Format .${ext} wird nicht unterstützt (KML, KMZ, GPX, GeoJSON)`);
  }
  if (!geojson || !Array.isArray(geojson.features) || geojson.features.length === 0) {
    throw new Error('Datei enthält keine Geometrien');
  }
  return geojson;
}

export async function importFile(file) {
  const name = file.name;
  const geojson = await parseFile(file);
  const overlay = {
    id: `local-ov-${Date.now()}`,
    name: name.replace(/\.[^.]+$/, ''),
    source: 'local',
    kind: 'geojson',
    geojson,
    importedAt: Date.now(),
  };
  await store.put('overlays', overlay);
  return overlay;
}

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Ungültige XML-Datei');
  return doc;
}

function featureStyle(f) {
  const p = f.properties || {};
  return {
    color: p.stroke || p.color || '#ffcc00',
    weight: p['stroke-width'] || 3,
    opacity: p['stroke-opacity'] ?? 0.9,
    fillColor: p.fill || p.stroke || '#ffcc00',
    fillOpacity: p['fill-opacity'] ?? 0.2,
  };
}

function popupFor(f) {
  const p = f.properties || {};
  const title = p.name || p.title || '';
  const desc = p.description || p.desc || '';
  if (!title && !desc) return null;
  return `<strong>${escapeHtml(title)}</strong>${desc ? `<div class="pop-desc">${escapeHtml(typeof desc === 'string' ? desc : JSON.stringify(desc))}</div>` : ''}`;
}

/** Build a Leaflet layer for a stored overlay record. */
const fileGeoCache = new Map();

export async function layerFor(o) {
  if (o.data && o.data.kind === 'file' && o.data.fileUrl) {
    // Overlay file shared via the server (e.g. from an ATAK data package)
    let geo = fileGeoCache.get(o.data.fileUrl);
    if (!geo) {
      const blob = await overlayFile(o.data.fileUrl);
      geo = await parseFile(blob, `${o.name || 'overlay'}.${o.data.format || 'kml'}`);
      fileGeoCache.set(o.data.fileUrl, geo);
    }
    o = { ...o, geojson: geo };
  }
  if (o.kind === 'geojson' || o.geojson) {
    return L.geoJSON(o.geojson, {
      style: featureStyle,
      pointToLayer: (f, latlng) => L.circleMarker(latlng, { radius: 6, ...featureStyle(f), fillOpacity: 0.8 }),
      onEachFeature: (f, layer) => { const html = popupFor(f); if (html) layer.bindPopup(html); },
    });
  }
  if (o.imageUrl && o.bounds) {
    const b = normaliseBounds(o.bounds);
    if (!b) return null;
    const url = await overlayImage(o.imageUrl);
    return L.imageOverlay(url, b, { opacity: o.opacity ?? 0.8, interactive: false });
  }
  return null;
}

function normaliseBounds(b) {
  if (Array.isArray(b) && b.length === 2) return b;
  if (b && b.south != null) return [[b.south, b.west], [b.north, b.east]];
  if (b && b._southWest) return [[b._southWest.lat, b._southWest.lng], [b._northEast.lat, b._northEast.lng]];
  return null;
}

export function drawingLayer(d) {
  const coords = (d.coordinates || []).map((c) => (Array.isArray(c) ? c : [c.lat, c.lng]));
  const style = { color: d.color || '#3388ff', weight: d.weight || 3 };
  let layer = null;
  const t = (d.type || 'polyline').toLowerCase();
  if (t === 'circle' && coords.length && (d.data?.radius || d.radius)) {
    layer = L.circle(coords[0], { radius: d.data?.radius || d.radius, ...style, fillOpacity: 0.1 });
  } else if ((t === 'polygon' || t === 'rectangle') && coords.length > 2) {
    layer = L.polygon(coords, { ...style, fillOpacity: 0.15 });
  } else if (coords.length > 1) {
    layer = L.polyline(coords, t === 'route' ? { ...style, dashArray: '10 6' } : style);
  }
  if (layer && d.name) layer.bindPopup(`<strong>${escapeHtml(d.name)}</strong><div class="pop-desc">${escapeHtml(d.created_by || '')}</div>`);
  return layer;
}

// Visibility is a device preference, kept apart from the overlay records so a
// server re-sync does not reset it.
export function isVisible(id) {
  return !store.setting('hiddenOverlays', []).includes(id);
}

export async function setVisible(id, visible) {
  const hidden = new Set(store.setting('hiddenOverlays', []));
  if (visible) hidden.delete(id); else hidden.add(id);
  await store.saveSetting('hiddenOverlays', [...hidden]);
}

export async function removeLocal(id) {
  await store.del('overlays', id);
}
