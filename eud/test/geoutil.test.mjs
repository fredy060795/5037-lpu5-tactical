import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMgrs, distance, bearing, formatBearing, formatDistance, formatCoord } from '../src/geoutil.js';

test('MGRS Berlin', () => {
  assert.equal(toMgrs(52.52, 13.405), '33U UU 91779 20072');
});

test('distance Berlin–Paris ≈ 877 km', () => {
  const d = distance({ lat: 52.52, lng: 13.405 }, { lat: 48.8566, lng: 2.3522 });
  assert.ok(Math.abs(d - 877_500) < 2000, String(d));
});

test('bearing east = 090° / 1600 mil', () => {
  assert.equal(formatBearing(bearing({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })), '090° / 1600 mil');
});

test('formats', () => {
  assert.equal(formatDistance(950), '950 m');
  assert.equal(formatDistance(12_340), '12.3 km');
  assert.equal(formatCoord(52.5, 13.4, 'dd'), '52.500000, 13.400000');
  assert.match(formatCoord(52.5, -13.4, 'dms'), /^52°30'00\.0"N 13°24'00\.0"W$/);
});
