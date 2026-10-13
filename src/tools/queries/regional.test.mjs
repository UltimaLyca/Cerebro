import assert from 'node:assert/strict';
import test from 'node:test';
import {
  composeCatalog,
  coreTools,
  getInvestigation,
  investigateTarget,
} from '../index.js';
import { createInvestigationSource } from '../sources/regional.js';

const NOW = Date.parse('2026-10-13T08:00:00Z');
const metSummary = {
  earthquakes: [
    { id: 'a', lat: 1, lon: 2, magnitude: 5.1, place: 'Sulawesi', timeMs: NOW },
    {
      id: 'b',
      lat: 3,
      lon: 4,
      magnitude: 6.2,
      place: 'Mid-Atlantic',
      timeMs: NOW,
    },
  ],
  warnings: [
    {
      title: 'Thunderstorms Warning',
      validFromMs: NOW,
      validToMs: NOW + 3600_000,
      text: 'storms',
      instruction: 'stay in',
    },
  ],
};
const city = (id, group, usAqi) => ({
  id,
  name: id.toUpperCase(),
  group,
  lat: 3,
  lon: 101,
  usAqi,
  pm25: 10,
  pm10: 12,
  timeMs: NOW,
});

test('Malaysia alerts list the strongest quakes first and the warnings in force', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: { malaysiaMet: { getSummary: async () => metSummary } },
  });
  const result = await catalog.call('get_malaysia_alerts', {
    min_magnitude: 5.5,
  });
  assert.equal(result.data.rows.length, 1);
  assert.equal(result.data.rows[0].magnitude, 6.2);
  assert.equal(result.data.warnings[0].title, 'Thunderstorms Warning');
  assert.match(result.summary, /1 MET-reported earthquake.*1 weather warning/);
  const all = await catalog.call('get_malaysia_alerts', {});
  assert.deepEqual(
    all.data.rows.map((row) => row.id),
    ['b', 'a'],
  );
});

test('air quality is filtered by group and AQI, worst first, and says it is modelled', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: {
      airQuality: {
        getSummary: async () => ({
          model: 'modelled',
          cities: [
            city('kl', 'malaysia', 207),
            city('jb', 'malaysia', 80),
            city('pku', 'region', 300),
          ],
        }),
      },
    },
  });
  const malaysia = await catalog.call('get_air_quality', {});
  assert.deepEqual(
    malaysia.data.rows.map((row) => row.id),
    ['kl', 'jb'],
  );
  assert.match(malaysia.summary, /Modelled values, not station readings/);
  const bad = await catalog.call('get_air_quality', {
    group: 'all',
    min_aqi: 150,
  });
  assert.deepEqual(
    bad.data.rows.map((row) => row.id),
    ['pku', 'kl'],
  );
});

test('investigation tools are left out unless the bridge service is supplied', () => {
  const without = composeCatalog({
    tools: [...coreTools, investigateTarget, getInvestigation],
    services: {},
  });
  assert.ok(
    !without.has?.('investigate_target') &&
      !without.list().some((t) => t.name === 'investigate_target'),
  );
  const withBridge = composeCatalog({
    tools: [...coreTools, investigateTarget, getInvestigation],
    services: { investigate: {} },
  });
  const names = withBridge.list().map((tool) => tool.name);
  assert.ok(names.includes('investigate_target'));
  assert.ok(names.includes('get_investigation'));
  assert.equal(
    coreTools.some((tool) => tool.name === 'investigate_target'),
    false,
  );
  const start = withBridge
    .list()
    .find((tool) => tool.name === 'investigate_target');
  assert.equal(start.annotations.readOnlyHint, false);
});

test('investigate_target starts a scan and maps bridge refusals to tool errors', async () => {
  const calls = [];
  const bridge = {
    async start(args) {
      calls.push(args);
      if (args.target === 'a@b.com')
        throw Object.assign(new Error('e-mail addresses are not accepted'), {
          status: 400,
        });
      if (args.target === 'busy.com')
        throw Object.assign(new Error('At most 3 scans'), { status: 429 });
      return {
        scanId: 'AB12',
        target: { kind: 'domain', value: args.target },
        mode: 'passive',
      };
    },
  };
  const catalog = composeCatalog({
    tools: [...coreTools, investigateTarget, getInvestigation],
    services: { investigate: bridge },
  });
  const ok = await catalog.call('investigate_target', {
    target: 'example.com',
  });
  assert.equal(ok.data.scan_id, 'AB12');
  await assert.rejects(
    catalog.call('investigate_target', { target: 'a@b.com' }),
    (error) =>
      error.code === 'invalid_arguments' && /e-mail/.test(error.message),
  );
  await assert.rejects(
    catalog.call('investigate_target', { target: 'busy.com' }),
    (error) => error.code === 'retry_later',
  );
});

test('get_investigation reads status or one event type', async () => {
  const bridge = {
    async status({ id }) {
      return {
        id,
        target: 'example.com',
        status: 'RUNNING',
        finished: false,
        summary: [{ type: 'IP_ADDRESS', total: 3 }],
      };
    },
    async results({ id, type }) {
      return { id, type, events: [{ data: '1.2.3.4' }, { data: '5.6.7.8' }] };
    },
  };
  const catalog = composeCatalog({
    tools: [...coreTools, investigateTarget, getInvestigation],
    services: { investigate: bridge },
  });
  const status = await catalog.call('get_investigation', { scan_id: 'AB12' });
  assert.match(status.summary, /RUNNING \(still running\)/);
  const found = await catalog.call('get_investigation', {
    scan_id: 'AB12',
    event_type: 'IP_ADDRESS',
  });
  assert.equal(found.data.total, 2);
  assert.equal(found.data.rows[0].data, '1.2.3.4');
});

test('the investigation source sends the secret only as a header', async () => {
  const seen = [];
  const source = createInvestigationSource({
    token: 'sekret',
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), init });
      return new Response(
        JSON.stringify({ scanId: 'X', target: {}, mode: 'passive' }),
        {
          status: 202,
        },
      );
    },
  });
  await source.start({ target: 'example.com' });
  await source.status({ id: 'AB12' }).catch(() => {});
  assert.equal(seen[0].init.headers['x-investigate-token'], 'sekret');
  assert.ok(!seen.some((call) => call.url.includes('sekret')));
  assert.ok(!seen[0].init.body.includes('sekret'));
});
