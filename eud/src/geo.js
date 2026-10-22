// Own position (PLI) tracking.
//
// Native (Android/iOS): background geolocation watcher with a foreground
// service notification, so the position keeps updating with the screen off.
// Browser/PWA: navigator.geolocation.watchPosition.
// The last fix is persisted, so after a restart or link loss the own
// position is shown immediately (marked as stale) instead of disappearing.

import { Capacitor, registerPlugin } from '@capacitor/core';
import * as store from './store.js';

const BackgroundGeolocation = registerPlugin('BackgroundGeolocation');

const listeners = new Set();
let lastFix = null;
let watchId = null;
let heading = null;
const headingListeners = new Set();

export function onFix(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function onHeading(fn) { headingListeners.add(fn); return () => headingListeners.delete(fn); }
export function getLastFix() { return lastFix; }
export function getHeading() { return heading; }

export async function restoreLastFix() {
  lastFix = (await store.get('kv', 'lastFix')) || null;
  return lastFix;
}

function emit(fix) {
  lastFix = fix;
  store.put('kv', fix, 'lastFix').catch(() => {});
  for (const fn of listeners) { try { fn(fix); } catch (e) { console.error(e); } }
}

function normalise(lat, lng, extra) {
  return {
    lat, lng,
    accuracy: extra.accuracy ?? null,
    altitude: extra.altitude ?? null,
    speed: extra.speed ?? null,
    course: extra.bearing ?? extra.heading ?? null,
    time: extra.time || Date.now(),
  };
}

export async function start() {
  if (watchId !== null) return;
  if (Capacitor.isNativePlatform()) {
    watchId = await BackgroundGeolocation.addWatcher(
      {
        backgroundTitle: 'LPU5 Tactical',
        backgroundMessage: 'Standortübertragung (PLI) aktiv',
        requestPermissions: true,
        stale: false,
        distanceFilter: store.setting('distanceFilter', 5),
      },
      (loc, err) => {
        if (err) {
          console.warn('GPS error', err);
          if (err.code === 'NOT_AUTHORIZED' && confirm('LPU5 benötigt die Standortberechtigung. Einstellungen öffnen?')) {
            BackgroundGeolocation.openSettings();
          }
          return;
        }
        emit(normalise(loc.latitude, loc.longitude, loc));
      },
    );
  } else if ('geolocation' in navigator) {
    watchId = navigator.geolocation.watchPosition(
      (p) => emit(normalise(p.coords.latitude, p.coords.longitude, { ...p.coords, time: p.timestamp })),
      (e) => console.warn('GPS error', e.message),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 },
    );
  }
}

export async function stop() {
  if (watchId === null) return;
  if (Capacitor.isNativePlatform()) await BackgroundGeolocation.removeWatcher({ id: watchId });
  else navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

export function isRunning() { return watchId !== null; }

// ---- Compass --------------------------------------------------------------

function onOrientation(e) {
  let h = null;
  if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading; // iOS
  else if (e.absolute && typeof e.alpha === 'number') h = (360 - e.alpha) % 360;
  if (h === null) return;
  heading = h;
  for (const fn of headingListeners) fn(h);
}

export async function startCompass() {
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== 'granted') return false;
    }
    window.addEventListener('deviceorientationabsolute', onOrientation);
    window.addEventListener('deviceorientation', onOrientation);
    return true;
  } catch (_) {
    return false;
  }
}
