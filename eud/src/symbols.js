// MIL-STD-2525C symbology for map markers (rendered offline with milsymbol).

import ms from 'milsymbol';
import L from 'leaflet';

export const AFFILIATIONS = [
  { id: 'friendly', code: 'F', label: 'Freund', color: '#80e0ff' },
  { id: 'hostile', code: 'H', label: 'Feind', color: '#ff8080' },
  { id: 'neutral', code: 'N', label: 'Neutral', color: '#aaffaa' },
  { id: 'unknown', code: 'U', label: 'Unbekannt', color: '#ffff80' },
];

// Dimension + function id (2525C positions 3 and 5-10).
export const FUNCTIONS = [
  { id: 'unit', label: 'Einheit', dim: 'G', fn: 'U-----' },
  { id: 'infantry', label: 'Infanterie', dim: 'G', fn: 'UCI---' },
  { id: 'armor', label: 'Panzer', dim: 'G', fn: 'UCA---' },
  { id: 'recon', label: 'Aufklärung', dim: 'G', fn: 'UCR---' },
  { id: 'artillery', label: 'Artillerie', dim: 'G', fn: 'UCF---' },
  { id: 'engineer', label: 'Pioniere', dim: 'G', fn: 'UCE---' },
  { id: 'medical', label: 'Sanität', dim: 'G', fn: 'USM---' },
  { id: 'hq', label: 'Gefechtsstand', dim: 'G', fn: 'UH----' },
  { id: 'vehicle', label: 'Fahrzeug', dim: 'G', fn: 'EV----' },
  { id: 'sensor', label: 'Sensor', dim: 'G', fn: 'ES----' },
  { id: 'heli', label: 'Hubschrauber', dim: 'A', fn: 'MH----' },
  { id: 'uav', label: 'Drohne (UAV)', dim: 'A', fn: 'MFQ---' },
];

export function buildSidc(affiliation, functionId) {
  const aff = AFFILIATIONS.find((a) => a.id === affiliation) || AFFILIATIONS[3];
  const f = FUNCTIONS.find((x) => x.id === functionId) || FUNCTIONS[0];
  return `S${aff.code}${f.dim}P${f.fn}-----`.slice(0, 15);
}

const TYPE_TO_SIDC = {
  friendly: 'SFGPU----------',
  hostile: 'SHGPU----------',
  neutral: 'SNGPU----------',
  unknown: 'SUGPU----------',
  pending: 'SPGPU----------',
  cbt_friendly: 'SFGPU----------',
  cbt_hostile: 'SHGPU----------',
  cbt_neutral: 'SNGPU----------',
  cbt_unknown: 'SUGPU----------',
  gps_position: 'SFGPUCI--------',
  tak_maker: 'SFGPUCI--------',
  node: 'SFGPES---------',
  meshtastic_node: 'SFGPES---------',
  gateway: 'SFGPES---------',
};

export function sidcFor(marker) {
  const d = marker.data || {};
  return d.sidc || marker.sidc || TYPE_TO_SIDC[(marker.type || '').toLowerCase()] || null;
}

const iconCache = new Map();

export function markerIcon(marker, { stale = false, pending = false } = {}) {
  const sidc = sidcFor(marker);
  const label = marker.callsign || marker.name || '';
  const key = `${sidc || marker.color || 'x'}|${label}|${stale}|${pending}`;
  if (iconCache.has(key)) return iconCache.get(key);
  let icon;
  if (sidc) {
    const sym = new ms.Symbol(sidc, {
      size: 26,
      uniqueDesignation: label.slice(0, 18),
      infoColor: '#fff',
      outlineColor: '#000',
      outlineWidth: 3,
      ...(stale ? { colorMode: 'Light', fillOpacity: 0.4 } : {}),
    });
    const a = sym.getAnchor();
    const s = sym.getSize();
    icon = L.divIcon({
      className: `mil-icon${pending ? ' pending' : ''}${stale ? ' stale' : ''}`,
      html: sym.asSVG(),
      iconSize: [s.width, s.height],
      iconAnchor: [a.x, a.y],
    });
  } else {
    const color = marker.color || '#ffcc00';
    icon = L.divIcon({
      className: `dot-icon${pending ? ' pending' : ''}`,
      html: `<span class="dot" style="background:${escapeAttr(color)}"></span><span class="dot-label">${escapeHtml(label.slice(0, 18))}</span>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });
  }
  if (iconCache.size > 500) iconCache.clear();
  iconCache.set(key, icon);
  return icon;
}

export function symbolPreview(sidc, size = 30) {
  return new ms.Symbol(sidc, { size }).asSVG();
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const escapeAttr = escapeHtml;
