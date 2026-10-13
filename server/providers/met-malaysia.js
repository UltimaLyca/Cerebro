import {
  readResponseBytesCapped,
  coalesceProxyRequest,
} from '../../src/sources/httpBody.js';

const QUAKE_WINDOW_MS = 30 * 24 * 3600_000;

/** The earthquake feed's `utcdatetime` is UTC without a zone suffix. */
function parseUtc(value) {
  const ms = Date.parse(`${value}Z`);
  return Number.isFinite(ms) ? ms : null;
}

export function normalizeQuakes(rows, now) {
  const quakes = [];
  for (const row of rows) {
    const timeMs = parseUtc(row.utcdatetime);
    if (
      timeMs === null ||
      !Number.isFinite(row.lat) ||
      !Number.isFinite(row.lon) ||
      now - timeMs > QUAKE_WINDOW_MS ||
      row.visible === false
    )
      continue;
    quakes.push({
      id: `met-${row.utcdatetime}-${row.lat}-${row.lon}`,
      lat: row.lat,
      lon: row.lon,
      depthKm: Number.isFinite(row.depth) ? row.depth : null,
      magnitude: Number.isFinite(row.magdefault) ? row.magdefault : null,
      magnitudeType: row.magtypedefault || null,
      place: row.location_original || row.location || null,
      distanceFromMalaysia: row.n_distancemas || null,
      timeMs,
    });
  }
  return quakes;
}

export function normalizeWarnings(rows, now) {
  const warnings = [];
  for (const row of rows) {
    const fromMs = row.valid_from ? Date.parse(`${row.valid_from}+08:00`) : NaN;
    const toMs = row.valid_to ? Date.parse(`${row.valid_to}+08:00`) : NaN;
    // "No Advisory" rows carry no validity window.
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) continue;
    if (toMs < now) continue;
    warnings.push({
      title: row.warning_issue?.title_en || row.heading_en || 'Warning',
      heading: row.heading_en || null,
      text: row.text_en || null,
      instruction: row.instruction_en || null,
      validFromMs: fromMs,
      validToMs: toMs,
    });
  }
  return warnings;
}

/**
 * MET Malaysia alerts proxy — recent MET-reported earthquakes and active
 * weather warnings from data.gov.my's free, keyless Open API
 * (developer.data.gov.my/realtime-api/weather).
 *
 * Upstream:
 *   GET https://api.data.gov.my/weather/warning/earthquake/?sort=-utcdatetime
 *   GET https://api.data.gov.my/weather/warning/
 *
 * GET /api/malaysia-met/summary →
 *   { fetchedAt, sources: [{ id, ok, count, error? }], earthquakes: [...],
 *     warnings: [...] }
 * Earthquakes carry the feed's own coordinates and magnitude. Warnings have
 * no geometry upstream (free-text areas), so they are returned as text only.
 *
 * @returns {import('vite').Plugin}
 */
export function malaysiaMetProxy() {
  const TTL_MS = 5 * 60_000;
  const UPSTREAM_TIMEOUT_MS = 12_000;
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const QUAKE_LIMIT = 50;

  let cache = null; // { at, body }
  const inFlight = new Map();

  async function getJson(url) {
    const upstream = await fetch(url, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
    if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
    const bytes = await readResponseBytesCapped(upstream, MAX_RESPONSE_BYTES);
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(parsed)) throw new Error('unexpected payload');
    return parsed;
  }

  async function settle(id, promise) {
    try {
      const rows = await promise;
      return { id, ok: true, rows };
    } catch (error) {
      return {
        id,
        ok: false,
        rows: [],
        error: error?.message || String(error),
      };
    }
  }

  async function refresh() {
    const now = Date.now();
    const [quakes, warnings] = await Promise.all([
      settle(
        'earthquakes',
        getJson(
          `https://api.data.gov.my/weather/warning/earthquake/?limit=${QUAKE_LIMIT}&sort=-utcdatetime`,
        ),
      ),
      settle('warnings', getJson('https://api.data.gov.my/weather/warning/')),
    ]);
    if (!quakes.ok && !warnings.ok) throw new Error('both MET feeds failed');
    const earthquakes = normalizeQuakes(quakes.rows, now);
    const activeWarnings = normalizeWarnings(warnings.rows, now);
    const sources = [
      {
        id: 'earthquakes',
        ok: quakes.ok,
        count: earthquakes.length,
        error: quakes.error,
      },
      {
        id: 'warnings',
        ok: warnings.ok,
        count: activeWarnings.length,
        error: warnings.error,
      },
    ];
    const body = JSON.stringify({
      fetchedAt: now,
      sources,
      earthquakes,
      warnings: activeWarnings,
    });
    cache = { at: now, body };
    return cache;
  }

  function send(res, status, body, tag) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...(tag ? { 'X-GEV-Cache': tag } : {}),
    });
    res.end(body);
  }

  function install(middlewares) {
    middlewares.use('/api/malaysia-met/summary', async (req, res) => {
      if (req.method !== 'GET') {
        send(res, 405, JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }
      if (cache && Date.now() - cache.at < TTL_MS) {
        send(res, 200, cache.body, 'HIT');
        return;
      }
      const stale = cache;
      const request = coalesceProxyRequest(inFlight, 'refresh', refresh);
      try {
        const fresh = await request.promise;
        send(res, 200, fresh.body, request.shared ? 'INFLIGHT' : 'MISS');
      } catch (error) {
        if (stale) {
          console.warn(
            `[malaysia-met-proxy] refresh failed (${error?.message || error}) — serving stale`,
          );
          send(res, 200, stale.body, 'STALE-ERROR');
          return;
        }
        send(res, 502, JSON.stringify({ error: 'MET Malaysia unavailable' }));
      }
    });
  }

  return {
    name: 'malaysia-met-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
