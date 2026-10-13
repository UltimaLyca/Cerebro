import test from 'node:test';
import assert from 'node:assert/strict';
import { AIR_QUALITY_CITIES, normalizeAirQuality } from './air-quality.js';

const row = (usAqi, extra = {}) => ({
  current: {
    time: '2026-10-13T08:00',
    us_aqi: usAqi,
    pm2_5: 12.5,
    pm10: 20,
    ...extra,
  },
});

test('city ids are unique and coordinates are plausible', () => {
  const ids = AIR_QUALITY_CITIES.map((c) => c[0]);
  assert.equal(new Set(ids).size, ids.length);
  for (const [, , , lat, lon] of AIR_QUALITY_CITIES) {
    assert.ok(Math.abs(lat) <= 90 && Math.abs(lon) <= 180);
  }
  assert.ok(AIR_QUALITY_CITIES.some((c) => c[2] === 'malaysia'));
});

test('results are matched to cities by position and keep our coordinates', () => {
  const cities = [
    ['a', 'A', 'malaysia', 1, 2],
    ['b', 'B', 'region', 3, 4],
  ];
  const out = normalizeAirQuality([row(207), row(55, { pm10: null })], cities);
  assert.deepEqual(
    out.map((c) => [c.id, c.usAqi, c.pm25, c.pm10, c.lat, c.lon]),
    [
      ['a', 207, 12.5, 20, 1, 2],
      ['b', 55, 12.5, null, 3, 4],
    ],
  );
  assert.equal(out[0].timeMs, Date.parse('2026-10-13T08:00:00Z'));
});

test('missing readings are dropped and a wrong-sized payload is rejected', () => {
  const cities = [
    ['a', 'A', 'malaysia', 1, 2],
    ['b', 'B', 'region', 3, 4],
  ];
  assert.deepEqual(
    normalizeAirQuality([row(null), row(40)], cities).map((c) => c.id),
    ['b'],
  );
  assert.throws(() => normalizeAirQuality([row(1)], cities), /unexpected/);
  assert.throws(
    () => normalizeAirQuality({ error: true }, cities),
    /unexpected/,
  );
});
