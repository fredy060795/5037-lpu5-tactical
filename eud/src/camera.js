// Share the device camera (built-in or external USB/UVC) with the LPU5
// server, where it is shown to the HQ and analysed by the YOLO pipeline.
// Frames go over the existing WebSocket as `camera_frame` messages.

import * as sync from './sync.js';
import * as geo from './geo.js';
import * as store from './store.js';

let stream = null;
let timer = null;
let video = null;
let canvas = null;
export const camState = { active: false, sent: 0, dropped: 0, deviceId: null };

export function cameraSupport() {
  if (!window.isSecureContext) return { ok: false, reason: 'Kamera im Browser nur über HTTPS (oder die native App) möglich. Server mit HTTPS aufrufen und Zertifikat vertrauen.' };
  if (!navigator.mediaDevices?.getUserMedia) return { ok: false, reason: 'Dieser Browser unterstützt keinen Kamerazugriff.' };
  return { ok: true };
}

export async function listCameras() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter((d) => d.kind === 'videoinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Kamera ${i + 1}` }));
  } catch (_) {
    return [];
  }
}

export function streamId() {
  const u = sync.state.user?.username || 'eud';
  return `eud-${u.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

export async function start(deviceId, previewEl) {
  const sup = cameraSupport();
  if (!sup.ok) throw new Error(sup.reason);
  await stop();
  const constraints = {
    audio: false,
    video: deviceId ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
      : { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
  };
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    if (e.name === 'NotAllowedError') throw new Error('Kamerazugriff verweigert – in den Geräte-/Browser-Einstellungen für LPU5 erlauben.');
    if (e.name === 'NotFoundError' || e.name === 'OverconstrainedError') throw new Error('Keine passende Kamera gefunden.');
    if (e.name === 'NotReadableError') throw new Error('Kamera wird von einer anderen App benutzt.');
    throw e;
  }
  video = previewEl || document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play().catch(() => {});
  canvas = canvas || document.createElement('canvas');
  camState.active = true;
  camState.deviceId = deviceId || null;
  const fps = store.setting('camFps', 3);
  timer = setInterval(sendFrame, 1000 / fps);
  stream.getVideoTracks()[0].addEventListener('ended', () => stop());
}

function sendFrame() {
  if (!video || !video.videoWidth) return;
  const scale = Math.min(1, 960 / video.videoWidth);
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  const fix = geo.getLastFix();
  const ok = sync.sendWs({
    type: 'camera_frame',
    frame: canvas.toDataURL('image/jpeg', 0.6),
    streamId: streamId(),
    target_units: [],
    meta: { name: `Kamera ${sync.callsign()}`, lat: fix?.lat, lng: fix?.lng, heading: geo.getHeading() ?? fix?.course ?? null },
  });
  if (ok) camState.sent++; else camState.dropped++;
}

export async function stop() {
  clearInterval(timer);
  timer = null;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  if (video) video.srcObject = null;
  camState.active = false;
}

/** Keep the preview attached when the panel is re-rendered. */
export function attachPreview(el) {
  if (!stream || !el) return;
  el.srcObject = stream;
  el.muted = true;
  el.playsInline = true;
  el.play().catch(() => {});
  video = el;
}
