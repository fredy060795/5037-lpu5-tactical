// Server network: saved LPU5 servers, QR onboarding and self-registration.
//
// Same idea as "Netzwerk" in the LPU5 field view: servers are kept in a list
// (no passwords stored), can be tested, switched and added by scanning a QR
// code (join, team, COT-mesh or server QR from the LPU5 main view).

import jsQR from 'jsqr';
import * as store from './store.js';
import { ensureTrusted } from './trust.js';

export function normaliseUrl(url) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

function buildUrl(protocol, host, port) {
  if (!host) return '';
  const proto = protocol === 'http' ? 'http' : 'https';
  return `${proto}://${host}${port ? `:${port}` : ''}`;
}

/**
 * Decode the text of an LPU5 QR code into a server entry.
 * Returns { name, url, user, qrToken, kind } or throws with a user message.
 */
export function parseServerQr(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('Leerer QR-Code');
  let data = null;
  try { data = JSON.parse(raw); } catch (_) { /* plain URL or token */ }

  if (data && typeof data === 'object') {
    const port = data.port ? String(data.port) : '';
    const protocol = data.protocol || (data.ssl === false ? 'http' : 'https');
    if (data.type === 'join') {
      if (!data.host) throw new Error('Join-QR ohne Serveradresse');
      return { kind: 'join', name: `LPU5 ${data.host}`, url: buildUrl(protocol, data.host, port || '8101'), user: '', qrToken: null };
    }
    if (data.type === 'cot_team') {
      if (!data.host) throw new Error(`Team „${data.team_name || ''}“ ohne Server (nur COT) – in der EUD-App nicht nutzbar`);
      return { kind: 'team', name: `Team ${data.team_name || data.team_id}`, url: buildUrl(protocol, data.host, port || '8101'), user: '', qrToken: null, team: data.team_name || '' };
    }
    if (data.type === 'cot_mesh_login') {
      if (!data.host) throw new Error('COT-Mesh-QR ohne Serveradresse');
      return { kind: 'cot_mesh', name: data.name || 'COT Mesh Server', url: buildUrl(protocol, data.host, port || '8101'), user: '', qrToken: null };
    }
    let url = data.url || data.server_url || '';
    if (!url && data.host) url = buildUrl(protocol, data.host, port);
    if (!url) throw new Error('QR-Code enthält keine Serveradresse');
    return {
      kind: 'server',
      name: data.name || data.server_name || data.hostname || 'Server',
      url: normaliseUrl(new URL(normaliseUrl(url)).origin),
      user: data.user || data.username || data.callsign || '',
      qrToken: data.qr_token || data.token || null,
    };
  }

  // Plain link, e.g. https://10.0.0.5:8101/register.html?qr_token=… or …/qr/<token>
  if (/^https?:\/\//i.test(raw)) {
    const u = new URL(raw);
    // /qr/<token> is an invitation QR of the LPU5 admin page (counts uses, may expire).
    const invite = u.pathname.match(/^\/qr\/([^/]+)$/);
    const token = invite ? decodeURIComponent(invite[1])
      : u.searchParams.get('qr_token') || u.searchParams.get('token') || u.searchParams.get('t') || null;
    const kind = invite ? 'invite' : /register\.html$/.test(u.pathname) ? 'register' : 'server';
    return { kind, name: `LPU5 ${u.hostname}`, url: u.origin, user: u.searchParams.get('user') || '', qrToken: token };
  }
  throw new Error('Kein LPU5-QR-Code');
}

const WEAK = ['password', 'admin', 'administrator', '123456', 'lpu5'];

/** Same rules as the server's password check (security.py); null when fine. */
export function passwordProblem(password, username = '') {
  if (!password || password.length < 8) return 'Passwort muss mindestens 8 Zeichen haben';
  const p = password.toLowerCase();
  if (WEAK.includes(p) || (username && p === username.toLowerCase())) return 'Dieses Passwort ist zu leicht zu erraten';
  return null;
}

// ---- Saved servers (no passwords) ------------------------------------------------

export async function list() {
  return (await store.get('kv', 'servers')) || [];
}

async function saveList(servers) {
  await store.put('kv', servers, 'servers');
}

/** Add or update an entry (matched by URL); returns the stored entry. */
export async function remember(entry) {
  const url = normaliseUrl(entry.url);
  const servers = await list();
  let s = servers.find((x) => x.url === url);
  if (!s) {
    s = { id: `srv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, url, name: '', user: '' };
    servers.push(s);
  }
  if (entry.name) s.name = entry.name;
  if (entry.user) s.user = entry.user;
  if (entry.team) s.team = entry.team;
  if (entry.lastOk) s.lastOk = entry.lastOk;
  if (!s.name) s.name = `LPU5 ${new URL(url).hostname}`;
  await saveList(servers);
  return s;
}

export async function remove(id) {
  await saveList((await list()).filter((s) => s.id !== id));
}

/** Reachability check – returns round-trip time in ms or throws. */
export async function test(url) {
  const base = normaliseUrl(url);
  await ensureTrusted(base);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  const t0 = performance.now();
  try {
    const res = await fetch(`${base}/api/tls/info`, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Math.round(performance.now() - t0);
  } finally {
    clearTimeout(t);
  }
}

// ---- Self-registration -----------------------------------------------------------------

export async function units(url) {
  try {
    const res = await fetch(`${normaliseUrl(url)}/api/units`, { cache: 'no-store' });
    if (!res.ok) return [];
    const data = await res.json();
    const arr = Array.isArray(data) ? data : data.units || [];
    return arr.map((u) => (typeof u === 'string' ? u : u.name)).filter(Boolean);
  } catch (_) {
    return [];
  }
}

/** Ask the server for an account; an admin approves it in the LPU5 admin page. */
export async function register(url, { username, password, callsign, unit, fullname }) {
  const base = normaliseUrl(url);
  await ensureTrusted(base);
  const res = await fetch(`${base}/api/register_user`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // The invitation token is not sent yet: the server compares its expiry date in a way that
    // fails (HTTP 500) – the registration endpoint is protected [#] and must not be changed
    // without approval. The admin still approves every registration.
    body: JSON.stringify({ username, password, callsign: callsign || username, unit: unit || null, fullname: fullname || '', qr_token: null, device: 'EUD' }),
  });
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = j.detail || j.message || ''; } catch (_) { /* ignore */ }
    const msg = {
      'Username already exists': 'Benutzername ist bereits vergeben',
      'Registration already pending': 'Für diesen Namen wartet schon eine Registrierung auf Freigabe',
      'Invalid QR token': 'QR-Code ungültig',
      'QR token max uses exceeded': 'QR-Code wurde schon zu oft benutzt',
      'QR token expired': 'QR-Code ist abgelaufen',
    }[detail] || detail || `HTTP ${res.status}`;
    throw Object.assign(new Error(msg), { status: res.status });
  }
  await remember({ url: base, user: username });
}

// ---- QR scanning ---------------------------------------------------------------------

function decodeCanvas(canvas, ctx) {
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
  return code ? code.data : null;
}

/** Decode a QR code from a picture file. */
export async function decodeImage(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const text = decodeCanvas(canvas, ctx);
  if (!text) throw new Error('Kein QR-Code im Bild erkannt');
  return text;
}

/** Scan with the rear camera into `video`; resolves with the QR text. Call stop() to cancel. */
export function scanCamera(video) {
  let stream = null;
  let timer = null;
  let stopped = false;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };
  const result = (async () => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Kein Kamerazugriff in diesem Browser – „QR aus Bild“ verwenden');
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    if (stopped) { stop(); throw new Error('abgebrochen'); }
    video.srcObject = stream;
    video.setAttribute('playsinline', '');
    await video.play();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (stopped) { reject(new Error('abgebrochen')); return; }
        if (video.videoWidth) {
          const scale = Math.min(1, 800 / video.videoWidth);
          canvas.width = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const text = decodeCanvas(canvas, ctx);
          if (text) { stop(); resolve(text); return; }
        }
        timer = setTimeout(tick, 200);
      };
      tick();
    });
  })();
  result.catch(() => stop());
  return { result, stop };
}
