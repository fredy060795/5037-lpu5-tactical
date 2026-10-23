// Needs a running LPU5 server with user 'feld1' (password Start1234, must change) – see README.
import { chromium } from 'playwright';
const S = process.env.LPU5_SERVER || 'http://127.0.0.1:8101';
const b = await chromium.launch();
const ctx = await b.newContext({ geolocation: { latitude: 52.52, longitude: 13.405, accuracy: 5 }, permissions: ['geolocation'], viewport: { width: 420, height: 900 } });
const p = await ctx.newPage();
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
p.on('dialog', async (d) => { const m = d.message(); if (d.type() === 'prompt') await d.accept('4711'); else await d.accept(); });
const adm = (await (await fetch(`${S}/api/login_user`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'administrator', password: process.env.LPU5_ADMIN_PASS || 'Lage-Nord-2026' }) })).json()).token;
const A = { Authorization: `Bearer ${adm}`, 'Content-Type': 'application/json' };
await p.goto(`${S}/eud/`);
await p.fill('#login-server', S); await p.fill('#login-user', 'feld1'); await p.fill('#login-pass', 'Start1234');
await p.click('#login-submit');
await p.waitForSelector('#pw-dialog:not(.hidden)', { timeout: 10000 });
console.log('forced password dialog shown');
await p.fill('#pw-new', 'Feld-Alpha-77'); await p.fill('#pw-new2', 'Feld-Alpha-77'); await p.click('#pw-form button');
await p.waitForSelector('#sb-link.online', { timeout: 15000 });
console.log('online after password change; basemap:', await p.evaluate(() => document.querySelector('.leaflet-tile-pane img')?.src?.replace(/\/\d+\/\d+\/\d+$/, '/z/x/y')));
// SOS hold 1.5 s
await p.click('[data-action=sos]');
const btn = p.locator('[data-kind="911"]'); const box = await btn.boundingBox();
await p.mouse.move(box.x + 20, box.y + 20); await p.mouse.down(); await p.waitForTimeout(1800); await p.mouse.up();
await p.waitForTimeout(1500);
const alerts = (await (await fetch(`${S}/api/tak/alerts`, { headers: A })).json()).alerts;
console.log('server alerts:', alerts.map((a) => `${a.kind}:${a.callsign}`));
console.log('alert banner:', await p.locator('#alert-banner').isVisible(), (await p.locator('#alert-banner').innerText().catch(() => '')).slice(0, 60));
// MEDEVAC
await p.click('[data-action=report]');
await p.fill('[data-f=freq]', '45.250'); await p.fill('[data-f=urgent]', '2'); await p.fill('[data-f=litter]', '1');
await p.fill('[data-f=medline_remarks]', 'Splitterverletzung Arm');
await p.click('#rp-send'); await p.waitForTimeout(1500);
const reps = (await (await fetch(`${S}/api/tak/reports`, { headers: A })).json()).reports;
console.log('server reports:', reps.slice(0, 1).map((r) => `${r.kind} urgent=${r.fields.urgent} freq=${r.fields.freq} mgrs=${r.fields.mgrs}`));
// Route
await p.click('[data-action=draw]'); await p.fill('#dr-name', 'Route Test'); await p.click('[data-tool=route]');
for (const [x, y] of [[100, 300], [200, 350], [300, 300]]) { await p.mouse.click(x, y); await p.waitForTimeout(150); }
await p.click('#draw-done'); await p.waitForTimeout(1500);
// Rings
await p.click('[data-action=draw]'); await p.fill('#dr-rings', '500, 1000'); await p.click('[data-tool=rings]'); await p.waitForTimeout(2000);
const dr = await (await fetch(`${S}/api/drawings`)).json();
console.log('server drawings:', dr.filter((d) => /Route Test|Ring/.test(d.name)).map((d) => `${d.type}:${d.name}:${(d.data || {}).radius || (d.coordinates || []).length}`));
// Packages panel
await p.click('[data-action=packages]'); await p.waitForTimeout(1500);
console.log('packages:', (await p.locator('#sheet-body').innerText()).split('\n').slice(1, 3).join(' | '));
await p.click('#sheet-close');
// PIN
await p.click('[data-action=settings]'); await p.click('#st-pin'); await p.waitForTimeout(800);
console.log('pin set:', await p.evaluate(() => new Promise((r) => { const q = indexedDB.open('lpu5-eud'); q.onsuccess = () => { const g = q.result.transaction('kv').objectStore('kv').get('pin'); g.onsuccess = () => r(!!g.result); }; })));
await p.reload(); await p.waitForTimeout(1500);
console.log('lock screen after reload:', await p.locator('#pin-lock').isVisible());
for (const k of ['4', '7', '1', '1', '✓']) await p.click(`#pin-lock [data-k="${k}"]`);
await p.waitForTimeout(800);
console.log('unlocked:', !(await p.locator('#pin-lock').isVisible()));
// Remote wipe
await fetch(`${S}/api/eud/wipe`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'feld1' }) });
await p.evaluate(() => window.dispatchEvent(new Event('online')));
await p.waitForTimeout(4000);
console.log('after remote wipe:', (await p.locator('body').innerText()).slice(0, 60).replace(/\n/g, ' '));
const me = await (await fetch(`${S}/api/users`, { headers: A })).json();
console.log('wipe confirmed server-side:', (me.find((u) => u.username === 'feld1')?.data || {}).wipe_confirmed_at ? 'yes' : 'no');
console.log('errors:', errs);
await b.close();
