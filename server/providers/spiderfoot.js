import { readRequestBody } from './common/request.js';
import { classifyTarget } from './spiderfoot/target.js';
import { createSpiderFootClient } from './spiderfoot/client.js';
import { timingSafeEqual } from 'node:crypto';

/**
 * Investigation bridge — starts and reads SpiderFoot scans of infrastructure
 * targets (domains, public IPs, small netblocks, ASNs). Disabled unless
 * SPIDERFOOT_URL is set, and then every request must carry the shared secret
 * in INVESTIGATE_TOKEN (header `x-investigate-token`), because a public
 * deployment would otherwise let anyone start scans through it.
 *
 * Scans run SpiderFoot's `passive` use case, which collects from third-party
 * sources without touching the target. Active use cases (`footprint`,
 * `investigate`) are only offered when SPIDERFOOT_ALLOW_ACTIVE=1, and the
 * operator is then responsible for being authorised to scan the target.
 *
 *   POST /api/investigate/scan     {target, mode?}  → {scanId, target, mode}
 *   GET  /api/investigate/scan?id=                  → status + type summary
 *   GET  /api/investigate/results?id=&type=         → condensed events
 *   POST /api/investigate/stop     {id}             → {stopped}
 *
 * @param {{ env?: Record<string,string|undefined>, fetchImpl?: typeof fetch }} [options]
 * @returns {import('vite').Plugin}
 */
export function spiderFootProxy({ env = process.env, fetchImpl } = {}) {
  const MAX_RUNNING = 3;
  const SCAN_ID = /^[A-Za-z0-9_-]{4,64}$/;
  const EVENT_TYPE = /^[A-Z0-9_]{2,64}$/;
  const running = new Map(); // scanId -> startedAt
  const baseUrl = env.SPIDERFOOT_URL;
  const token = env.INVESTIGATE_TOKEN || '';
  const allowActive = env.SPIDERFOOT_ALLOW_ACTIVE === '1';
  const client = baseUrl
    ? createSpiderFootClient({ baseUrl, fetchImpl })
    : null;

  function send(res, status, body) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(body));
  }

  function authorised(req) {
    if (!token) return false;
    const given = String(req.headers['x-investigate-token'] || '');
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async function readJson(req) {
    const text = await readRequestBody(req, 4096);
    const parsed = text ? JSON.parse(text) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('expected a JSON object');
    return parsed;
  }

  async function refreshRunning() {
    for (const id of [...running.keys()]) {
      try {
        const status = await client.status(id);
        if (!status || status.finished) running.delete(id);
      } catch {
        // Leave it counted; the next successful status call clears it.
      }
    }
  }

  async function handle(req, res, next) {
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '') || '/';
    if (!client || !token) {
      send(res, 503, {
        error:
          'Investigation is not enabled. Set SPIDERFOOT_URL and INVESTIGATE_TOKEN.',
      });
      return;
    }
    if (!authorised(req)) {
      send(res, 401, { error: 'Missing or invalid investigation token' });
      return;
    }
    try {
      if (req.method === 'POST' && route === '/scan') {
        const body = await readJson(req);
        const target = classifyTarget(body.target);
        if (!target.ok) {
          send(res, 400, { error: target.reason });
          return;
        }
        const mode = body.mode === undefined ? 'passive' : String(body.mode);
        if (!['passive', 'footprint', 'investigate'].includes(mode)) {
          send(res, 400, {
            error: 'mode must be passive, footprint or investigate',
          });
          return;
        }
        if (mode !== 'passive' && !allowActive) {
          send(res, 403, {
            error: 'Active scan modes are disabled on this server',
          });
          return;
        }
        await refreshRunning();
        if (running.size >= MAX_RUNNING) {
          send(res, 429, {
            error: `At most ${MAX_RUNNING} scans can run at once`,
          });
          return;
        }
        const started = await client.startScan({
          name: `cerebro-${target.kind}-${Date.now()}`,
          target: target.value,
          usecase: mode,
        });
        if (!started.ok) {
          send(res, 502, { error: started.error });
          return;
        }
        running.set(started.scanId, Date.now());
        send(res, 202, { scanId: started.scanId, target, mode });
        return;
      }
      if (req.method === 'POST' && route === '/stop') {
        const body = await readJson(req);
        if (!SCAN_ID.test(String(body.id))) {
          send(res, 400, { error: 'invalid scan id' });
          return;
        }
        await client.stop(String(body.id));
        send(res, 200, { stopped: true });
        return;
      }
      if (req.method === 'GET' && (route === '/scan' || route === '/results')) {
        const id = url.searchParams.get('id') || '';
        if (!SCAN_ID.test(id)) {
          send(res, 400, { error: 'invalid scan id' });
          return;
        }
        if (route === '/scan') {
          const status = await client.status(id);
          if (!status) {
            send(res, 404, { error: 'unknown scan' });
            return;
          }
          if (status.finished) running.delete(id);
          send(res, 200, { id, ...status, summary: await client.summary(id) });
          return;
        }
        const type = url.searchParams.get('type') || 'ALL';
        if (type !== 'ALL' && !EVENT_TYPE.test(type)) {
          send(res, 400, { error: 'invalid event type' });
          return;
        }
        send(res, 200, { id, type, events: await client.events(id, type) });
        return;
      }
      send(res, 405, { error: 'Method Not Allowed' });
    } catch (error) {
      if (error?.code === 'BODY_TOO_LARGE') {
        send(res, 413, { error: 'Request body too large' });
        return;
      }
      if (
        error instanceof SyntaxError ||
        /expected a JSON/.test(error?.message)
      ) {
        send(res, 400, { error: 'Invalid JSON body' });
        return;
      }
      console.warn(`[investigate] ${error?.message || error}`);
      send(res, 502, { error: 'SpiderFoot unavailable' });
    }
  }

  function install(middlewares) {
    middlewares.use('/api/investigate', (req, res, next) => {
      handle(req, res, next);
    });
  }

  return {
    name: 'spiderfoot-investigate-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
