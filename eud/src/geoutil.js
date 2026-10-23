// Coordinate formatting and simple geodesy for the EUD.

import { forward as mgrsForward } from 'mgrs/dist/mgrs.esm.js';

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function distance(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearing(a, b) {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

export function formatDistance(m) {
  if (m == null || Number.isNaN(m)) return '–';
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
}

export function formatBearing(b) {
  // Degrees and NATO mils (6400).
  return `${Math.round(b).toString().padStart(3, '0')}° / ${Math.round((b * 6400) / 360).toString().padStart(4, '0')} mil`;
}

export function toMgrs(lat, lng, precision = 5) {
  try {
    const s = mgrsForward([lng, lat], precision);
    // "32UNA1234567890" -> "32U NA 12345 67890"
    const m = s.match(/^(\d{1,2}[A-Z])([A-Z]{2})(\d+)$/);
    if (!m) return s;
    const half = m[3].length / 2;
    return `${m[1]} ${m[2]} ${m[3].slice(0, half)} ${m[3].slice(half)}`;
  } catch (_) {
    return '–';
  }
}

function dms(v, pos, neg) {
  const h = v >= 0 ? pos : neg;
  v = Math.abs(v);
  const d = Math.floor(v), mFloat = (v - d) * 60, m = Math.floor(mFloat), s = ((mFloat - m) * 60).toFixed(1);
  return `${d}°${String(m).padStart(2, '0')}'${String(s).padStart(4, '0')}"${h}`;
}

export function formatCoord(lat, lng, fmt = 'mgrs') {
  if (lat == null || lng == null) return '–';
  if (fmt === 'dd') return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  if (fmt === 'dms') return `${dms(lat, 'N', 'S')} ${dms(lng, 'E', 'W')}`;
  return toMgrs(lat, lng);
}

export function ago(ts) {
  if (!ts) return '–';
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (Number.isNaN(t)) return '–';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}
