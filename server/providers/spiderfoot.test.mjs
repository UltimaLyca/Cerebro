import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spiderFootProxy } from './spiderfoot.js';
import {
  parseEvents,
  parseStartResponse,
  parseStatus,
  parseSummary,
} from './spiderfoot/client.js';

/** Fake SpiderFoot 4.x web API with the response shapes of sfwebui.py. */
function fakeSpiderFoot(state) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      state.calls.push({
        path: url.pathname,
        query: url.search,
        body,
        accept: req.headers.accept,
      });
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/startscan')
        return res.end(JSON.stringify(['SUCCESS', state.nextId]));
      if (url.pathname === '/scanstatus')
        return res.end(
          JSON.stringify(
            state.finished
              ? ['n', 'example.com', 'c', 's', 'e', 'FINISHED', { HIGH: 0 }]
              : ['n', 'example.com', 'c', 's', '0', 'RUNNING', {}],
          ),
        );
      if (url.pathname === '/scansummary')
        return res.end(
          JSON.stringify([
            ['INTERNET_NAME', 'Internet Name', 't', 4, 3, 'FINISHED'],
            ['IP_ADDRESS', 'IP Address', 't', 9, 2, 'FINISHED'],
          ]),
        );
      if (url.pathname === '/scaneventresults')
        return res.end(
          JSON.stringify([
            [
              't',
              'a'.repeat(1000),
              'example.com',
              'sfp_dnsresolve',
              'INTERNET_NAME',
            ],
          ]),
        );
      if (url.pathname === '/stopscan') return res.end('[]');
      res.statusCode = 404;
      res.end('{}');
    });
  });
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function harness(t, env = {}) {
  const state = { calls: [], nextId: 'AB12CD34', finished: false };
  const sf = fakeSpiderFoot(state);
  const sfPort = await listen(sf);
  const plugin = spiderFootProxy({
    env: {
      SPIDERFOOT_URL: `http://127.0.0.1:${sfPort}`,
      INVESTIGATE_TOKEN: 'secret',
      ...env,
    },
  });
  let handler;
  plugin.configureServer({
    middlewares: { use: (_path, fn) => (handler = fn) },
  });
  const app = http.createServer((req, res) => {
    // Connect strips the mount path before calling the middleware.
    req.url = req.url.replace(/^\/api\/investigate/, '') || '/';
    handler(req, res, () => res.end());
  });
  const port = await listen(app);
  t.after(() => {
    sf.close();
    app.close();
  });
  const call = async (
    path,
    { method = 'GET', body, token = 'secret' } = {},
  ) => {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/investigate${path}`,
      {
        method,
        headers: {
          ...(token ? { 'x-investigate-token': token } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      },
    );
    return { status: response.status, json: await response.json() };
  };
  return { state, call };
}

test('parsers follow the SpiderFoot response shapes', () => {
  assert.deepEqual(parseStartResponse(['SUCCESS', 'ID1']), {
    ok: true,
    scanId: 'ID1',
  });
  assert.equal(
    parseStartResponse(['ERROR', 'Unrecognised target type.']).ok,
    false,
  );
  assert.equal(parseStatus([]), null);
  assert.equal(
    parseStatus(['n', 't', 'c', 's', 'e', 'RUNNING']).finished,
    false,
  );
  assert.equal(
    parseStatus(['n', 't', 'c', 's', 'e', 'ABORTED']).finished,
    true,
  );
  assert.equal(
    parseSummary([
      ['A', 'a', 't', 1, 1],
      ['B', 'b', 't', 5, 2],
    ])[0].type,
    'B',
  );
  assert.equal(
    parseEvents([['t', 'x'.repeat(500), 's', 'm', 'T']])[0].data.length,
    301,
  );
});

test('disabled and unauthenticated requests are refused', async (t) => {
  const plugin = spiderFootProxy({ env: {} });
  let handler;
  plugin.configureServer({ middlewares: { use: (_p, fn) => (handler = fn) } });
  const app = http.createServer((req, res) => handler(req, res, () => {}));
  const port = await listen(app);
  t.after(() => app.close());
  const off = await fetch(`http://127.0.0.1:${port}/scan?id=ABCD`);
  assert.equal(off.status, 503);

  const { call, state } = await harness(t);
  assert.equal((await call('/scan?id=AB12CD34', { token: '' })).status, 401);
  assert.equal(
    (await call('/scan?id=AB12CD34', { token: 'wrong' })).status,
    401,
  );
  assert.equal(
    state.calls.length,
    0,
    'nothing reaches SpiderFoot unauthenticated',
  );
});

test('a person-identifying or unsafe target never reaches SpiderFoot', async (t) => {
  const { call, state } = await harness(t);
  for (const target of [
    'a@b.com',
    '+60123456789',
    '"Jane Doe"',
    '127.0.0.1',
    '10.0.0.0/8',
  ])
    assert.equal(
      (await call('/scan', { method: 'POST', body: { target } })).status,
      400,
      target,
    );
  assert.equal(state.calls.length, 0);
});

test('a domain scan is passive by default, then read back', async (t) => {
  const { call, state } = await harness(t);
  const started = await call('/scan', {
    method: 'POST',
    body: { target: 'Example.com' },
  });
  assert.equal(started.status, 202);
  assert.equal(started.json.scanId, 'AB12CD34');
  const form = new URLSearchParams(state.calls[0].body);
  assert.equal(form.get('scantarget'), 'example.com');
  assert.equal(form.get('usecase'), 'passive');
  assert.equal(state.calls[0].accept, 'application/json');

  const running = await call('/scan?id=AB12CD34');
  assert.equal(running.json.status, 'RUNNING');
  state.finished = true;
  const done = await call('/scan?id=AB12CD34');
  assert.equal(done.json.finished, true);
  assert.deepEqual(
    done.json.summary.map((row) => row.type),
    ['IP_ADDRESS', 'INTERNET_NAME'],
  );

  const results = await call('/results?id=AB12CD34&type=INTERNET_NAME');
  assert.equal(results.json.events.length, 1);
  assert.equal(results.json.events[0].data.length, 301);
  assert.equal(
    (await call('/results?id=AB12CD34&type=bad%20type')).status,
    400,
  );
  assert.equal((await call('/scan?id=../etc')).status, 400);
});

test('active modes need explicit opt-in and concurrent scans are capped', async (t) => {
  const locked = await harness(t);
  const refused = await locked.call('/scan', {
    method: 'POST',
    body: { target: 'example.com', mode: 'footprint' },
  });
  assert.equal(refused.status, 403);
  assert.equal(
    (
      await locked.call('/scan', {
        method: 'POST',
        body: { target: 'example.com', mode: 'bogus' },
      })
    ).status,
    400,
  );

  const { call, state } = await harness(t, { SPIDERFOOT_ALLOW_ACTIVE: '1' });
  const active = await call('/scan', {
    method: 'POST',
    body: { target: 'example.com', mode: 'footprint' },
  });
  assert.equal(active.status, 202);
  for (const id of ['AAAA0001', 'AAAA0002']) {
    state.nextId = id;
    assert.equal(
      (await call('/scan', { method: 'POST', body: { target: 'example.com' } }))
        .status,
      202,
    );
  }
  state.nextId = 'AAAA0003';
  const capped = await call('/scan', {
    method: 'POST',
    body: { target: 'example.com' },
  });
  assert.equal(capped.status, 429);
});
