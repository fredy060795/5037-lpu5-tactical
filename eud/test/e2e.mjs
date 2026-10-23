// End-to-end test against a running LPU5 server (see README):
//   EUD_URL=http://127.0.0.1:8101/eud/ LPU5_SERVER=http://127.0.0.1:8101 node test/e2e.mjs
import { chromium } from 'playwright';
// Top-bar buttons are clicked directly, everything else through the ☰ command menu.
const act = async (pg, a) => {
  const top = pg.locator(`#top-status-bar [data-action=${a}], #map-quick [data-action=${a}]`);
  if (await top.count()) return top.first().click();
  await pg.click('#top-status-bar [data-action=menu]');
  await pg.click(`#sidebar-tile-grid [data-action=${a}]`);
};

const EUD = process.env.EUD_URL || 'http://127.0.0.1:4173/';
const SERVER = process.env.LPU5_SERVER || 'http://127.0.0.1:8101';
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const ctx = await browser.newContext({ geolocation: { latitude: 52.52, longitude: 13.405, accuracy: 8 }, permissions: ['geolocation', 'camera'], viewport: { width: 400, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); else console.log('C>', m.text()); });
const sb = async () => (await page.locator('#top-status-bar').innerText()).replace(/\n/g, ' | ');
await page.goto(EUD);
await page.fill('#login-server', SERVER);
await page.fill('#login-user', process.env.LPU5_USER || 'administrator');
await page.fill('#login-pass', process.env.LPU5_PASS || 'password');
await page.click('#login-submit');
await page.waitForSelector('#sb-link.online', { timeout: 15000 });
console.log('after login:', await sb());
await page.waitForTimeout(1500);
console.log('self coord:', await page.locator('#coord-self').innerText());
// add marker online
await act(page, 'add');
await page.click('[data-aff=hostile]');
await page.click('[data-fn=armor]');
await page.fill('#mk-name', 'Feind Panzer A');
await page.click('#mk-save');
await page.waitForTimeout(2000);
let srv = await (await fetch(`${SERVER}/api/map_markers`)).json();
console.log('server markers:', srv.map(m => `${m.name}|${m.type}|${m.data?.sidc}`).join(', '));
console.log('rendered mil icons:', await page.locator('.mil-icon').count());
// go offline
await ctx.setOffline(true);
await page.waitForTimeout(500);
await act(page, 'add');
await page.fill('#mk-name', 'Offline Marker B');
await page.click('#mk-save');
await page.waitForTimeout(1000);
console.log('offline statusbar:', await sb());
// reload while offline (service worker + IndexedDB)
await page.reload();
await page.waitForTimeout(2500);
console.log('after offline reload:', await sb(), '| login visible:', await page.locator('#login').isVisible());
console.log('self coord after reload:', await page.locator('#coord-self').innerText(), '| icons:', await page.locator('.mil-icon').count());
// back online
await ctx.setOffline(false);
await page.evaluate(() => window.dispatchEvent(new Event('online')));
await page.waitForSelector('#sb-link.online', { timeout: 40000 });
await page.waitForTimeout(2500);
srv = await (await fetch(`${SERVER}/api/map_markers`)).json();
console.log('server markers after reconnect:', srv.map(m => m.name).join(', '));
console.log('statusbar:', await sb());
// position reported?
const sym = await (await fetch(`${SERVER}/api/map/symbols`)).json();
console.log('gps symbols:', JSON.stringify(sym).match(/gps_position/g)?.length);
// panels
for (const p of ['layers', 'offline', 'contacts', 'chat', 'mesh', 'video', 'settings']) {
  await act(page, p); await page.waitForTimeout(700);
  console.log(p, '=>', (await page.locator('#sheet-title').innerText()), (await page.locator('#sheet-body').innerText()).slice(0, 80).replace(/\n/g, ' / '));
  await page.click('#sheet-close');
}
// camera share -> server video analytics relay stream
await act(page, 'video');
await page.waitForSelector('#cam-toggle:not([disabled])');
await page.click('#cam-toggle');
await page.waitForTimeout(4000);
console.log('cam info:', await page.locator('#cam-info').innerText());
const token = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('lpu5-eud'); r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get('auth'); g.onsuccess = () => res(g.result.token); }; }));
const vs = await (await fetch(`${SERVER}/api/video/streams?token=${token}`)).json();
console.log('video streams:', vs.streams.map((s) => `${s.id}:${s.status}:${s.fps}fps`).join(', '));
const snap = await fetch(`${SERVER}/api/video/streams/relay-eud-administrator/snapshot.jpg?token=${token}`);
console.log('snapshot:', snap.status, snap.headers.get('content-type'), (await snap.arrayBuffer()).byteLength, 'bytes');
await page.click('#sheet-close');
await act(page, 'mesh');
await page.waitForTimeout(300);
console.log('mesh =>', (await page.locator('#sheet-body').innerText()).slice(0, 160).replace(/\n/g, ' / '));
await page.click('#sheet-close');
await act(page, 'chat');
await page.waitForTimeout(500);
await page.click('[data-tab=funk]');
await page.waitForTimeout(1000);
console.log('funk tab =>', (await page.locator('#chat-log').innerText()).slice(0, 200).replace(/\n/g, ' / '));
await page.click('#sheet-close');
await page.screenshot({ path: '/tmp/claude-0/eud.png' });
console.log('ERRORS:', errors.filter(e => !/tile|ERR_INTERNET_DISCONNECTED|Failed to load resource|ERR_TUNNEL|net::/.test(e)));
await browser.close();
