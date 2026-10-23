// Meshtastic over Bluetooth LE – works without any server or internet.
//
// Transport:
//  * native app (Android/iOS): @capacitor-community/bluetooth-le
//  * PWA in Chrome/Edge on Android, desktop: Web Bluetooth (HTTPS required)
//  * iOS Safari has no Web Bluetooth – use the native iOS app there.
//
// Protocol: ToRadio/FromRadio protobufs on the Meshtastic GATT service.
// Received nodes, positions, texts and ATAK plugin packets (TAKPacket PLI +
// GeoChat) become contacts/messages in the EUD; the own position is sent as
// ATAK PLI so ATAK/WinTAK users on the same mesh see this device.

import { Capacitor } from '@capacitor/core';
import { BleClient } from '@capacitor-community/bluetooth-le';
import { create, toBinary, fromBinary } from '@bufbuild/protobuf';
import { Mesh, Portnums, ATAK } from '@meshtastic/protobufs';
import * as store from './store.js';

export const SERVICE = '6ba1b218-15a8-461f-9fa8-5dcae273eafd';
const TORADIO = 'f75c76d2-129e-4dad-a1dd-7866124401e7';
const FROMRADIO = '2c55e69e-4993-11ed-b878-0242ac120002';
const FROMNUM = 'ed9da18b-a800-4f66-a670-aa48ac36e4d0';
const BROADCAST = 0xffffffff;
const PortNum = Portnums.PortNum;

const bus = new EventTarget();
export const on = (type, fn) => bus.addEventListener(type, (e) => fn(e.detail));
const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));

export const state = {
  status: 'disconnected', // disconnected | connecting | configuring | connected
  deviceName: '',
  myNodeNum: null,
  nodes: new Map(), // num -> {num, longName, shortName, lat, lng, lastHeard}
  error: '',
};

let transport = null;
let draining = false;
let pollTimer = null;

export function support() {
  if (Capacitor.isNativePlatform()) return { ok: true, via: 'native' };
  if (!window.isSecureContext) return { ok: false, reason: 'Bluetooth im Browser nur über HTTPS (oder die native App) möglich.' };
  if (!navigator.bluetooth) {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    return { ok: false, reason: ios ? 'iOS Safari unterstützt kein Web Bluetooth – bitte die LPU5 iOS-App verwenden.' : 'Dieser Browser unterstützt kein Web Bluetooth (Chrome/Edge verwenden).' };
  }
  return { ok: true, via: 'web' };
}

function setStatus(s, error = '') {
  state.status = s;
  state.error = error;
  emit('status', { ...state });
}

// ---- Transports ----------------------------------------------------------------

class WebBleTransport {
  async connect() {
    const device = await navigator.bluetooth.requestDevice({ filters: [{ services: [SERVICE] }] });
    this.device = device;
    device.addEventListener('gattserverdisconnected', () => onDisconnected());
    const server = await device.gatt.connect();
    const svc = await server.getPrimaryService(SERVICE);
    this.to = await svc.getCharacteristic(TORADIO);
    this.from = await svc.getCharacteristic(FROMRADIO);
    this.num = await svc.getCharacteristic(FROMNUM);
    await this.num.startNotifications();
    this.num.addEventListener('characteristicvaluechanged', () => drain());
    return device.name || 'Meshtastic';
  }
  async read() { const v = await this.from.readValue(); return new Uint8Array(v.buffer, v.byteOffset, v.byteLength); }
  async write(bytes) { await this.to.writeValueWithResponse(bytes); }
  async disconnect() { try { this.device?.gatt?.disconnect(); } catch (_) { /* ignore */ } }
}

class NativeBleTransport {
  async connect() {
    await BleClient.initialize({ androidNeverForLocation: true });
    const device = await BleClient.requestDevice({ services: [SERVICE] });
    this.id = device.deviceId;
    await BleClient.connect(this.id, () => onDisconnected());
    await BleClient.startNotifications(this.id, SERVICE, FROMNUM, () => drain());
    return device.name || 'Meshtastic';
  }
  async read() { const v = await BleClient.read(this.id, SERVICE, FROMRADIO); return new Uint8Array(v.buffer, v.byteOffset, v.byteLength); }
  async write(bytes) { await BleClient.write(this.id, SERVICE, TORADIO, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)); }
  async disconnect() { try { await BleClient.disconnect(this.id); } catch (_) { /* ignore */ } }
}

// ---- Connection --------------------------------------------------------------

export async function connect() {
  const sup = support();
  if (!sup.ok) throw new Error(sup.reason);
  if (transport) await disconnect();
  setStatus('connecting');
  transport = sup.via === 'native' ? new NativeBleTransport() : new WebBleTransport();
  try {
    state.deviceName = await transport.connect();
    setStatus('configuring');
    await sendToRadio(create(Mesh.ToRadioSchema, { payloadVariant: { case: 'wantConfigId', value: randomId() } }));
    await drain();
    clearInterval(pollTimer);
    pollTimer = setInterval(drain, 5000); // safety net if a notification is missed
  } catch (e) {
    transport = null;
    setStatus('disconnected', e.message || String(e));
    throw e;
  }
}

export async function disconnect() {
  clearInterval(pollTimer);
  const t = transport;
  transport = null;
  if (t) await t.disconnect();
  setStatus('disconnected');
}

function onDisconnected() {
  clearInterval(pollTimer);
  transport = null;
  setStatus('disconnected', 'Verbindung zum Funkgerät verloren');
}

async function sendToRadio(msg) {
  if (!transport) throw new Error('Kein Meshtastic-Gerät verbunden');
  await transport.write(toBinary(Mesh.ToRadioSchema, msg));
}

async function drain() {
  if (draining || !transport) return;
  draining = true;
  try {
    for (let i = 0; i < 500; i++) {
      const bytes = await transport.read();
      if (!bytes.length) break;
      try { handleFromRadio(fromBinary(Mesh.FromRadioSchema, bytes)); } catch (e) { console.warn('mesh decode', e); }
    }
  } catch (e) {
    console.warn('mesh read', e);
  } finally {
    draining = false;
  }
}

// ---- Incoming ------------------------------------------------------------------

function node(num) {
  let n = state.nodes.get(num);
  if (!n) { n = { num, longName: '', shortName: '', lat: null, lng: null, lastHeard: null }; state.nodes.set(num, n); }
  return n;
}

function handleFromRadio(fr) {
  const v = fr.payloadVariant;
  switch (v.case) {
    case 'myInfo':
      state.myNodeNum = v.value.myNodeNum;
      break;
    case 'nodeInfo': {
      const ni = v.value;
      const n = node(ni.num);
      if (ni.user) { n.longName = ni.user.longName; n.shortName = ni.user.shortName; }
      if (ni.position && ni.position.latitudeI) { n.lat = ni.position.latitudeI / 1e7; n.lng = ni.position.longitudeI / 1e7; }
      if (ni.lastHeard) n.lastHeard = ni.lastHeard * 1000;
      saveNode(n);
      break;
    }
    case 'configCompleteId':
      setStatus('connected');
      break;
    case 'packet':
      handlePacket(v.value);
      break;
    default:
      break;
  }
}

function handlePacket(p) {
  if (p.payloadVariant.case !== 'decoded') return; // encrypted for another channel
  const d = p.payloadVariant.value;
  const n = node(p.from);
  n.lastHeard = Date.now();
  try {
    switch (d.portnum) {
      case PortNum.TEXT_MESSAGE_APP: {
        const text = new TextDecoder().decode(d.payload);
        emit('text', { from: p.from, username: n.longName || n.shortName || hex(p.from), text, timestamp: new Date().toISOString(), mine: p.from === state.myNodeNum });
        break;
      }
      case PortNum.POSITION_APP: {
        const pos = fromBinary(Mesh.PositionSchema, d.payload);
        if (pos.latitudeI) { n.lat = pos.latitudeI / 1e7; n.lng = pos.longitudeI / 1e7; }
        break;
      }
      case PortNum.NODEINFO_APP: {
        const u = fromBinary(Mesh.UserSchema, d.payload);
        n.longName = u.longName; n.shortName = u.shortName;
        break;
      }
      case PortNum.ATAK_PLUGIN:
        handleTak(fromBinary(ATAK.TAKPacketSchema, d.payload), p.from);
        break;
      default:
        break;
    }
  } catch (e) {
    console.warn('mesh packet', e);
  }
  if (p.from !== state.myNodeNum) saveNode(n);
}

function handleTak(tak, from) {
  if (tak.isCompressed) return; // compressed TAK packets need the unishox2 dictionary – not supported
  const callsign = tak.contact?.callsign || hex(from);
  const pv = tak.payloadVariant;
  if (pv.case === 'pli') {
    store.put('markers', {
      id: `meshtak-${callsign}`,
      name: callsign,
      callsign,
      lat: pv.value.latitudeI / 1e7,
      lng: pv.value.longitudeI / 1e7,
      type: 'tak_maker',
      created_by: 'mesh',
      timestamp: new Date().toISOString(),
      data: { timestamp: new Date().toISOString(), source: 'meshtastic-atak', course: pv.value.course, speed: pv.value.speed },
      _mesh: true,
    }).then(() => emit('data'));
  } else if (pv.case === 'chat') {
    emit('text', { from, username: callsign, text: pv.value.message, timestamp: new Date().toISOString(), tak: true });
  }
}

let saveTimer = null;
const dirty = new Set();
function saveNode(n) {
  dirty.add(n.num);
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    for (const num of dirty) {
      const x = state.nodes.get(num);
      if (!x || x.lat == null || num === state.myNodeNum) continue;
      await store.put('markers', {
        id: `mesh-${hex(num)}`,
        name: x.longName || x.shortName || hex(num),
        shortName: x.shortName,
        lat: x.lat, lng: x.lng,
        type: 'meshtastic_node',
        created_by: 'mesh',
        timestamp: new Date(x.lastHeard || Date.now()).toISOString(),
        data: { timestamp: new Date(x.lastHeard || Date.now()).toISOString(), source: 'meshtastic-ble', nodeNum: num },
        _mesh: true,
      });
    }
    dirty.clear();
    emit('data');
    emit('status', { ...state });
  }, 500);
}

// ---- Outgoing --------------------------------------------------------------------

function packet(portnum, payload, wantAck = false) {
  return create(Mesh.ToRadioSchema, {
    payloadVariant: {
      case: 'packet',
      value: create(Mesh.MeshPacketSchema, {
        to: BROADCAST,
        channel: store.setting('meshChannel', 0),
        id: randomId(),
        wantAck,
        payloadVariant: { case: 'decoded', value: create(Mesh.DataSchema, { portnum, payload }) },
      }),
    },
  });
}

export async function sendText(text) {
  await sendToRadio(packet(PortNum.TEXT_MESSAGE_APP, new TextEncoder().encode(text), true));
}

/** Broadcast own position as ATAK PLI (seen by ATAK/WinTAK Meshtastic plugin users). */
export async function sendPli(fix, callsign) {
  const tak = create(ATAK.TAKPacketSchema, {
    isCompressed: false,
    contact: create(ATAK.ContactSchema, { callsign, deviceCallsign: callsign }),
    group: create(ATAK.GroupSchema, { team: ATAK.Team.Cyan, role: ATAK.MemberRole.TeamMember }),
    payloadVariant: {
      case: 'pli',
      value: create(ATAK.PLISchema, {
        latitudeI: Math.round(fix.lat * 1e7),
        longitudeI: Math.round(fix.lng * 1e7),
        altitude: Math.round(fix.altitude || 0),
        speed: Math.max(0, Math.round(fix.speed || 0)),
        course: Math.round(fix.course || 0),
      }),
    },
  });
  await sendToRadio(packet(PortNum.ATAK_PLUGIN, toBinary(ATAK.TAKPacketSchema, tak)));
}

let lastPli = 0;
export async function maybeSendPli(fix, callsign) {
  if (state.status !== 'connected' || !store.setting('meshPli', true)) return;
  const interval = store.setting('meshPliInterval', 120) * 1000;
  if (Date.now() - lastPli < interval) return;
  lastPli = Date.now();
  try { await sendPli(fix, callsign); } catch (e) { console.warn('mesh PLI', e); lastPli = 0; }
}

function randomId() { return Math.floor(Math.random() * 0x7fffffff) >>> 0; }
function hex(num) { return `!${(num >>> 0).toString(16).padStart(8, '0')}`; }
