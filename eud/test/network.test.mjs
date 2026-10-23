import { test } from 'node:test';
import assert from 'node:assert/strict';

// network.js imports browser-only modules; the QR parser is pure, so load it in isolation.
const src = (await import('node:fs')).readFileSync(new URL('../src/network.js', import.meta.url), 'utf8');
const pure = src.slice(src.indexOf('export function normaliseUrl'), src.indexOf('// ---- Saved servers (no'));
const mod = await import(`data:text/javascript,${encodeURIComponent(pure)}`);
const { parseServerQr, normaliseUrl, passwordProblem } = mod;

test('join QR from the LPU5 main view', () => {
  const r = parseServerQr(JSON.stringify({ type: 'join', protocol: 'https', host: '192.168.8.10', port: 8101, ssl: true }));
  assert.equal(r.kind, 'join');
  assert.equal(r.url, 'https://192.168.8.10:8101');
});

test('team QR with server and COT-only team', () => {
  const r = parseServerQr(JSON.stringify({ type: 'cot_team', team_id: 't1', team_name: 'Alpha', host: '10.0.0.5', port: 8101, protocol: 'https' }));
  assert.equal(r.url, 'https://10.0.0.5:8101');
  assert.match(r.name, /Alpha/);
  assert.throws(() => parseServerQr(JSON.stringify({ type: 'cot_team', team_id: 't2', team_name: 'Bravo' })), /nur COT/);
});

test('COT mesh login QR keeps no master key', () => {
  const r = parseServerQr(JSON.stringify({ type: 'cot_mesh_login', host: '10.0.0.5', master_key: 'secret', name: 'Mesh' }));
  assert.equal(r.url, 'https://10.0.0.5:8101');
  assert.equal(JSON.stringify(r).includes('secret'), false);
});

test('standard server QR with user', () => {
  const r = parseServerQr(JSON.stringify({ name: 'TOC', url: 'https://10.1.1.1:8101/overview.html', username: 'feld1' }));
  assert.equal(r.url, 'https://10.1.1.1:8101');
  assert.equal(r.user, 'feld1');
});

test('invitation link and registration link', () => {
  const inv = parseServerQr('https://10.0.0.5:8101/qr/abc-123');
  assert.equal(inv.kind, 'invite');
  assert.equal(inv.qrToken, 'abc-123');
  const reg = parseServerQr('https://10.0.0.5:8101/register.html?qr_token=xyz');
  assert.equal(reg.kind, 'register');
  assert.equal(reg.qrToken, 'xyz');
});

test('garbage is rejected, URLs are normalised', () => {
  assert.throws(() => parseServerQr('hello'), /Kein LPU5/);
  assert.equal(normaliseUrl('10.0.0.5:8101/'), 'https://10.0.0.5:8101');
});

test('registration password rules match the server', () => {
  assert.match(passwordProblem('kurz'), /8 Zeichen/);
  assert.match(passwordProblem('password'), /leicht/);
  assert.match(passwordProblem('feldwebel1', 'Feldwebel1'), /leicht/);
  assert.equal(passwordProblem('Bravo-Sieben-77', 'feld2'), null);
});
