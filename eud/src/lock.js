// App PIN lock and local data wipe (lost / captured device).
//
// * PIN stored only as salted PBKDF2 hash (WebCrypto).
// * Locks on start and after the app was in the background longer than the
//   configured time.
// * After 10 wrong PINs, or when the server requests a remote wipe, all
//   offline data (map tiles, situation, chat, outbox, credentials) is erased.

import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import * as store from './store.js';

const MAX_TRIES = 10;
let hiddenAt = 0;
let locked = false;

const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

export function supported() {
  return Boolean(window.crypto && crypto.subtle && window.isSecureContext);
}

async function derive(pin, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return b64(bits);
}

export async function hasPin() {
  return Boolean(await store.get('kv', 'pin'));
}

export async function setPin(pin) {
  if (!/^\d{4,8}$/.test(pin)) throw new Error('PIN muss aus 4 bis 8 Ziffern bestehen');
  if (!supported()) throw new Error('PIN benötigt eine sichere Verbindung (App oder HTTPS)');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = 150000;
  await store.put('kv', { salt: b64(salt), iterations, hash: await derive(pin, salt, iterations) }, 'pin');
  await store.put('kv', 0, 'pinFails');
}

export async function removePin() {
  await store.del('kv', 'pin');
}

async function verify(pin) {
  const rec = await store.get('kv', 'pin');
  if (!rec) return true;
  const salt = Uint8Array.from(atob(rec.salt), (c) => c.charCodeAt(0));
  return (await derive(pin, salt, rec.iterations)) === rec.hash;
}

/** Erase everything this device stored. Reloads the app afterwards. */
export async function wipeLocal(reason = '') {
  try { localStorage.clear(); sessionStorage.clear(); } catch (_) { /* ignore */ }
  try {
    if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
  } catch (_) { /* ignore */ }
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase('lpu5-eud');
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
  document.body.innerHTML = `<div class="screen"><div class="login-box"><h1>Daten gelöscht</h1><p class="muted">${reason || 'Alle lokalen Daten wurden entfernt.'}</p></div></div>`;
  setTimeout(() => location.reload(), 2500);
}

function render() {
  let el = document.getElementById('pin-lock');
  if (!el) {
    el = document.createElement('div');
    el.id = 'pin-lock';
    el.className = 'screen';
    el.style.zIndex = '4000';
    el.innerHTML = `<div class="login-box pin-box">
      <h1>GESPERRT</h1><p class="muted" id="pin-msg">PIN eingeben</p>
      <div class="pin-dots" id="pin-dots"></div>
      <div class="pin-pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9, '⌫', 0, '✓'].map((k) => `<button class="btn" data-k="${k}">${k}</button>`).join('')}</div>
    </div>`;
    document.body.appendChild(el);
  }
  return el;
}

export async function lock() {
  if (locked || !(await hasPin())) return;
  locked = true;
  const el = render();
  el.classList.remove('hidden');
  let entry = '';
  const dots = el.querySelector('#pin-dots');
  const msg = el.querySelector('#pin-msg');
  const draw = () => { dots.textContent = '●'.repeat(entry.length) || ' '; };
  draw();
  await new Promise((resolve) => {
    el.querySelector('.pin-pad').onclick = async (e) => {
      const k = e.target.closest('[data-k]')?.dataset.k;
      if (k === undefined) return;
      if (k === '⌫') { entry = entry.slice(0, -1); draw(); return; }
      if (k !== '✓') { if (entry.length < 8) entry += k; draw(); return; }
      if (entry.length < 4) return;
      if (await verify(entry)) {
        await store.put('kv', 0, 'pinFails');
        resolve();
        return;
      }
      const fails = ((await store.get('kv', 'pinFails')) || 0) + 1;
      await store.put('kv', fails, 'pinFails');
      entry = '';
      draw();
      if (fails >= MAX_TRIES) { await wipeLocal(`${MAX_TRIES} falsche PIN-Eingaben – Daten aus Sicherheitsgründen gelöscht.`); return; }
      msg.textContent = `Falsche PIN – noch ${MAX_TRIES - fails} Versuche bis zur Löschung`;
      if (navigator.vibrate) navigator.vibrate(200);
    };
  });
  el.classList.add('hidden');
  locked = false;
}

/** Lock again after the app was in the background for `minutes`. */
export function installAutoLock() {
  const away = () => { hiddenAt = Date.now(); };
  const back = () => {
    const minutes = store.setting('lockAfterMinutes', 5);
    if (hiddenAt && Date.now() - hiddenAt >= minutes * 60000) lock();
    hiddenAt = 0;
  };
  if (Capacitor.isNativePlatform()) {
    App.addListener('appStateChange', ({ isActive }) => (isActive ? back() : away()));
  } else {
    document.addEventListener('visibilitychange', () => (document.hidden ? away() : back()));
  }
}
