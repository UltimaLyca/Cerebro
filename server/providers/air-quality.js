import {
  readResponseBytesCapped,
  coalesceProxyRequest,
} from '../../src/sources/httpBody.js';

/**
 * Air-quality proxy — modelled current US AQI / PM2.5 / PM10 for Malaysian
 * cities and the regional haze-source cities (Sumatra, Borneo), from
 * Open-Meteo's free, keyless air-quality API (CAMS atmospheric-composition
 * model). These are MODEL values on a coarse grid, not station readings, and
 * the payload says so.
 *
 * GET /api/air-quality/summary →
 *   { fetchedAt, model, cities: [{ id, name, group, lat, lon, usAqi, pm25,
 *     pm10, timeMs }] }
 */

export const AIR_QUALITY_CITIES = Object.freeze([
  ['kuala-lumpur', 'Kuala Lumpur', 'malaysia', 3.139, 101.687],
  ['putrajaya', 'Putrajaya', 'malaysia', 2.9264, 101.6964],
  ['shah-alam', 'Shah Alam', 'malaysia', 3.0733, 101.5185],
  ['george-town', 'George Town', 'malaysia', 5.4164, 100.3327],
  ['johor-bahru', 'Johor Bahru', 'malaysia', 1.4927, 103.7414],
  ['ipoh', 'Ipoh', 'malaysia', 4.5975, 101.0901],
  ['kuantan', 'Kuantan', 'malaysia', 3.8077, 103.326],
  ['kota-bharu', 'Kota Bharu', 'malaysia', 6.1254, 102.2381],
  ['kuala-terengganu', 'Kuala Terengganu', 'malaysia', 5.3296, 103.137],
  ['seremban', 'Seremban', 'malaysia', 2.7259, 101.9378],
  ['melaka', 'Melaka', 'malaysia', 2.1896, 102.2501],
  ['alor-setar', 'Alor Setar', 'malaysia', 6.1248, 100.3678],
  ['kangar', 'Kangar', 'malaysia', 6.4414, 100.1986],
  ['kuching', 'Kuching', 'malaysia', 1.5535, 110.3593],
  ['sibu', 'Sibu', 'malaysia', 2.2873, 111.8305],
  ['bintulu', 'Bintulu', 'malaysia', 3.1739, 113.0428],
  ['miri', 'Miri', 'malaysia', 4.3995, 113.9914],
  ['kota-kinabalu', 'Kota Kinabalu', 'malaysia', 5.9804, 116.0735],
  ['sandakan', 'Sandakan', 'malaysia', 5.8394, 118.1172],
  ['tawau', 'Tawau', 'malaysia', 4.2447, 117.8914],
  ['labuan', 'Labuan', 'malaysia', 5.2831, 115.2308],
  ['singapore', 'Singapore', 'region', 1.3521, 103.8198],
  ['bandar-seri-begawan', 'Bandar Seri Begawan', 'region', 4.9031, 114.9398],
  ['bangkok', 'Bangkok', 'region', 13.7563, 100.5018],
  ['medan', 'Medan', 'region', 3.5952, 98.6722],
  ['pekanbaru', 'Pekanbaru', 'region', 0.5071, 101.4478],
  ['jambi', 'Jambi', 'region', -1.6101, 103.6131],
  ['palembang', 'Palembang', 'region', -2.9761, 104.7754],
  ['pontianak', 'Pontianak', 'region', -0.0263, 109.3425],
  ['palangkaraya', 'Palangka Raya', 'region', -2.2161, 113.9135],
  ['banjarmasin', 'Banjarmasin', 'region', -3.3194, 114.5908],
]);

const OPEN_METEO_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const MODEL = 'Open-Meteo / CAMS (modelled, not station readings)';

/**
 * Turn Open-Meteo's multi-location array into city records, matched by
 * position. Entries with a missing or non-numeric AQI are dropped.
 */
export function normalizeAirQuality(payload, cities = AIR_QUALITY_CITIES) {
  if (!Array.isArray(payload) || payload.length !== cities.length)
    throw new Error('unexpected air-quality payload');
  const out = [];
  cities.forEach(([id, name, group, lat, lon], index) => {
    const current = payload[index]?.current;
    if (!current || !Number.isFinite(current.us_aqi)) return;
    const timeMs = Date.parse(`${current.time}Z`);
    out.push({
      id,
      name,
      group,
      lat,
      lon,
      usAqi: current.us_aqi,
      pm25: Number.isFinite(current.pm2_5) ? current.pm2_5 : null,
      pm10: Number.isFinite(current.pm10) ? current.pm10 : null,
      timeMs: Number.isFinite(timeMs) ? timeMs : null,
    });
  });
  return out;
}

export function airQualityProxy() {
  const TTL_MS = 30 * 60_000;
  const UPSTREAM_TIMEOUT_MS = 15_000;
  const MAX_RESPONSE_BYTES = 1024 * 1024;
  let cache = null;
  const inFlight = new Map();

  async function refresh() {
    const url = new URL(OPEN_METEO_URL);
    url.searchParams.set(
      'latitude',
      AIR_QUALITY_CITIES.map((c) => c[3]).join(','),
    );
    url.searchParams.set(
      'longitude',
      AIR_QUALITY_CITIES.map((c) => c[4]).join(','),
    );
    url.searchParams.set('current', 'us_aqi,pm2_5,pm10');
    url.searchParams.set('timezone', 'GMT');
    const upstream = await fetch(url, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
    if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
    const bytes = await readResponseBytesCapped(upstream, MAX_RESPONSE_BYTES);
    const cities = normalizeAirQuality(
      JSON.parse(new TextDecoder().decode(bytes)),
    );
    cache = {
      at: Date.now(),
      body: JSON.stringify({ fetchedAt: Date.now(), model: MODEL, cities }),
    };
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
    middlewares.use('/api/air-quality/summary', async (req, res) => {
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
            `[air-quality-proxy] refresh failed (${error?.message || error}) — serving stale`,
          );
          send(res, 200, stale.body, 'STALE-ERROR');
          return;
        }
        send(res, 502, JSON.stringify({ error: 'Air quality unavailable' }));
      }
    });
  }

  return {
    name: 'air-quality-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
