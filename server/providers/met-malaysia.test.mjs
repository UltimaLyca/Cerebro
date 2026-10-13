import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuakes, normalizeWarnings } from './met-malaysia.js';

const NOW = Date.parse('2026-10-13T08:00:00Z');

test('earthquakes keep real coordinates and drop old, hidden or unlocated rows', () => {
  const rows = [
    {
      utcdatetime: '2026-10-13T05:44:49',
      lat: 1.5,
      lon: 110.2,
      depth: 10,
      magdefault: 6.2,
      magtypedefault: 'mb',
      location_original: 'Sarawak',
      n_distancemas: '40km NE Kuching',
      visible: true,
    },
    { utcdatetime: '2026-08-01T00:00:00', lat: 1, lon: 1, magdefault: 5 },
    { utcdatetime: '2026-10-12T00:00:00', lat: 1, lon: 1, visible: false },
    { utcdatetime: '2026-10-12T00:00:00', lat: null, lon: 1 },
    { utcdatetime: 'garbage', lat: 1, lon: 1 },
  ];
  const quakes = normalizeQuakes(rows, NOW);
  assert.equal(quakes.length, 1);
  assert.equal(quakes[0].magnitude, 6.2);
  assert.equal(quakes[0].timeMs, Date.parse('2026-10-13T05:44:49Z'));
  assert.equal(quakes[0].place, 'Sarawak');
});

test('warnings use Malaysia local validity and skip expired or advisory-free rows', () => {
  const rows = [
    {
      warning_issue: { title_en: 'Thunderstorms Warning' },
      valid_from: '2026-10-13T15:00:00',
      valid_to: '2026-10-13T18:00:00',
      text_en: 'storms',
    },
    {
      warning_issue: { title_en: 'Old' },
      valid_from: '2026-10-10T00:00:00',
      valid_to: '2026-10-12T00:00:00',
    },
    {
      warning_issue: { title_en: 'No Advisory' },
      valid_from: null,
      valid_to: null,
    },
  ];
  const warnings = normalizeWarnings(rows, NOW);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].title, 'Thunderstorms Warning');
  // 18:00 +08:00 is 10:00Z.
  assert.equal(warnings[0].validToMs, Date.parse('2026-10-13T10:00:00Z'));
});
