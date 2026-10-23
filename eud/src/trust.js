// Server certificate handling when a connection is set up.
//
// Native app: the server's CA is fetched automatically on the first connect,
// the user confirms its fingerprint once (trust on first use) and the app
// trusts that server from then on. A changed certificate is reported as a
// possible attack and needs a new confirmation.
// PWA: browsers cannot be told to trust a certificate, so the CA is
// downloaded for the user and the remaining OS steps are shown.

import { Capacitor, registerPlugin } from '@capacitor/core';
import * as store from './store.js';

const LpuTrust = registerPlugin('LpuTrust');
const $ = (id) => document.getElementById(id);

function ask({ title, text, fingerprint, danger }) {
  return new Promise((resolve) => {
    const dlg = $('trust-dialog');
    $('trust-title').textContent = title;
    $('trust-text').textContent = text;
    $('trust-fp').textContent = fingerprint || '';
    $('trust-ok').classList.toggle('danger', Boolean(danger));
    $('trust-ok').classList.toggle('primary', !danger);
    dlg.classList.remove('hidden');
    const done = (v) => { dlg.classList.add('hidden'); resolve(v); };
    $('trust-ok').onclick = () => done(true);
    $('trust-cancel').onclick = () => done(false);
  });
}

/**
 * Make sure `server` can be reached over TLS. Resolves when the connection
 * may proceed, rejects when the user declined or the server is unreachable.
 */
export async function ensureTrusted(server) {
  if (!Capacitor.isNativePlatform() || !server.startsWith('https://')) return { mode: 'none' };
  const info = await LpuTrust.probe({ url: server });
  if (!info.https || info.systemTrusted) return { mode: 'system' };
  if (info.pinnedFingerprint === info.fingerprint) return { mode: 'pinned', fingerprint: info.fingerprint };

  const changed = Boolean(info.pinnedFingerprint);
  const ok = await ask(changed ? {
    title: '⚠ Zertifikat hat sich geändert',
    text: `Der Server ${info.hostPort} meldet ein anderes Zertifikat als beim letzten Mal („${info.subject}“). `
      + 'Das passiert, wenn die Server-CA neu erzeugt wurde – oder bei einem Angriff. Nur bestätigen, wenn der Fingerabdruck '
      + 'mit dem in der Serverkonsole übereinstimmt.',
    fingerprint: info.fingerprint,
    danger: true,
  } : {
    title: 'Server-Zertifikat übernehmen',
    text: `Erste Verbindung zu ${info.hostPort}. Der Server nutzt das Zertifikat „${info.subject}“. `
      + 'Es wird in der App gespeichert, damit Verbindung, Kamera und Live-Daten ohne Warnung funktionieren. '
      + 'Der Fingerabdruck wird beim Serverstart in der Konsole angezeigt.',
    fingerprint: info.fingerprint,
  });
  if (!ok) throw Object.assign(new Error('Zertifikat nicht bestätigt – keine Verbindung'), { status: 495 });
  await LpuTrust.pin({ hostPort: info.hostPort, pem: info.pem });
  return { mode: 'pinned', fingerprint: info.fingerprint, newlyPinned: true };
}

export async function pinnedServers() {
  if (!Capacitor.isNativePlatform()) return {};
  try { return (await LpuTrust.list()).pinned || {}; } catch (_) { return {}; }
}

export async function forget(hostPort) {
  if (Capacitor.isNativePlatform()) await LpuTrust.unpin({ hostPort });
}

// ---- PWA ------------------------------------------------------------------

let swCertError = false;
export function noteServiceWorkerError(err) {
  if (/ssl|certificate|security/i.test(String(err && (err.message || err)))) swCertError = true;
}

const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/**
 * In the browser: if the page came from an untrusted HTTPS server, download
 * the server CA once on first connect and show the steps to trust it.
 */
export async function offerBrowserInstall(server, { force = false } = {}) {
  if (Capacitor.isNativePlatform() || !server.startsWith('https://')) return;
  const key = `caOffered:${server}`;
  if (!force && (!swCertError || (await store.get('kv', key)))) return;
  await store.put('kv', Date.now(), key);
  const ios = isIOS();
  const url = `${server}/${ios ? 'lpu5-ca.mobileconfig' : 'lpu5-ca.crt'}`;
  if (!ios) {
    // Android/desktop: start the download right away.
    const a = document.createElement('a');
    a.href = url;
    a.download = 'lpu5-ca.crt';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  let fp = '';
  try { fp = (await (await fetch(`${server}/api/tls/info`)).json()).fingerprint || ''; } catch (_) { /* optional */ }
  const steps = ios
    ? 'Tippe auf „Herunterladen“ und erlaube das Profil. Dann: Einstellungen → „Profil geladen“ → Installieren, '
      + 'danach Allgemein → Info → Zertifikatsvertrauenseinstellungen → „LPU5 Tactical Root CA“ einschalten.'
    : 'Die Datei lpu5-ca.crt wurde heruntergeladen. Einstellungen → Sicherheit → Verschlüsselung & Anmeldedaten → '
      + 'Zertifikat installieren → CA-Zertifikat → lpu5-ca.crt wählen. Danach die App neu laden.';
  const ok = await ask({
    title: 'Server-Zertifikat installieren',
    text: `Der Browser vertraut dem LPU5-Server noch nicht – dadurch funktionieren Offline-Modus, Kamera und Bluetooth nicht zuverlässig. ${steps}`,
    fingerprint: fp,
  });
  if (ok && ios) window.location.href = url;
}
