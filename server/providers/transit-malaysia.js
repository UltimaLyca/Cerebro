import { createRequire } from 'node:module';
import { readResponseBytesCapped, coalesceProxyRequest } from '../../src/sources/httpBody.js';

/**
 * Malaysia GTFS-Realtime vehicle-position proxy — live train/bus positions
 * from data.gov.my's free, keyless Open API (developer.data.gov.my).
 *
 * Upstream: GET https://api.data.gov.my/gtfs-realtime/vehicle-position/{agency}/
 * (?category=... for prasarana), one call per configured feed, each returning
 * a GTFS-realtime `FeedMessage` protobuf. No API key. Feeds refresh upstream
 * every ~30 s, so this proxy caches the merged result for 25 s, coalesces
 * concurrent client requests, and serves the last-good merge if a refresh
 * fails (some feeds are known to be intermittently empty/erroring per the
 * upstream docs — a single bad feed must not blank the whole layer).
 *
 * GET /api/malaysia-transit/vehicles →
 *   { fetchedAt, sources: [{ id, label, ok, count, error? }], vehicles: [...] }
 * Each vehicle carries the feed's own real vehicle id/label and trip/route
 * id — there is no synthetic per-vehicle numbering.
 *
 * @returns {import('vite').Plugin}
 */
export function malaysiaTransitProxy() {
  const TTL_MS = 25_000;
  const UPSTREAM_TIMEOUT_MS = 12_000;
  const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
  const GtfsRealtimeBindings = createRequire(import.meta.url)('gtfs-realtime-bindings');

  /** All feeds documented at developer.data.gov.my/realtime-api/gtfs-realtime. */
  const FEEDS = Object.freeze([
    { id: 'ktmb', label: 'KTMB' },
    { id: 'prasarana', category: 'rapid-bus-kl', label: 'Rapid Bus KL' },
    { id: 'prasarana', category: 'rapid-bus-mrtfeeder', label: 'MRT Feeder' },
    { id: 'prasarana', category: 'rapid-bus-kuantan', label: 'Rapid Bus Kuantan' },
    { id: 'prasarana', category: 'rapid-bus-penang', label: 'Rapid Bus Penang' },
    { id: 'mybas-kangar', label: 'myBAS Kangar' },
    { id: 'mybas-alor-setar', label: 'myBAS Alor Setar' },
    { id: 'mybas-kota-bharu', label: 'myBAS Kota Bharu' },
    { id: 'mybas-kuala-terengganu', label: 'myBAS Kuala Terengganu' },
    { id: 'mybas-ipoh', label: 'myBAS Ipoh' },
    { id: 'mybas-seremban-a', label: 'myBAS Seremban A' },
    { id: 'mybas-seremban-b', label: 'myBAS Seremban B' },
    { id: 'mybas-melaka', label: 'myBAS Melaka' },
    { id: 'mybas-johor', label: 'myBAS Johor Bahru' },
    { id: 'mybas-kuching', label: 'myBAS Kuching' },
  ]);

  let cache = null; // { at, body }
  const inFlight = new Map();

  function feedUrl(feed) {
    const url = new URL(`https://api.data.gov.my/gtfs-realtime/vehicle-position/${feed.id}/`);
    if (feed.category) url.searchParams.set('category', feed.category);
    return url;
  }

  async function fetchOneFeed(feed) {
    const sourceKey = feed.category ? `${feed.id}:${feed.category}` : feed.id;
    try {
      const upstream = await fetch(feedUrl(feed), { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
      if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
      const bytes = await readResponseBytesCapped(upstream, MAX_RESPONSE_BYTES);
      const parsed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(bytes);
      const vehicles = [];
      for (const entity of parsed.entity || []) {
        const v = entity.vehicle;
        const pos = v?.position;
        if (!v || !pos || !Number.isFinite(pos.latitude) || !Number.isFinite(pos.longitude)) continue;
        vehicles.push({
          id: `${sourceKey}-${v.vehicle?.id || entity.id}`,
          source: feed.label,
          vehicleLabel: v.vehicle?.label || v.vehicle?.id || null,
          routeId: v.trip?.routeId || null,
          tripId: v.trip?.tripId || null,
          lat: pos.latitude,
          lon: pos.longitude,
          bearingDeg: Number.isFinite(pos.bearing) ? pos.bearing : null,
          speedMps: Number.isFinite(pos.speed) ? pos.speed : null,
          timestamp: Number(v.timestamp) > 0 ? Number(v.timestamp) * 1000 : null,
        });
      }
      return { id: sourceKey, label: feed.label, ok: true, count: vehicles.length, vehicles };
    } catch (error) {
      return { id: sourceKey, label: feed.label, ok: false, count: 0, error: error?.message || String(error), vehicles: [] };
    }
  }

  async function refresh() {
    const results = await Promise.all(FEEDS.map(fetchOneFeed));
    const vehicles = results.flatMap((r) => r.vehicles);
    const sources = results.map(({ vehicles: _v, ...rest }) => rest);
    const body = JSON.stringify({ fetchedAt: Date.now(), sources, vehicles });
    const fresh = { at: Date.now(), body };
    cache = fresh;
    return fresh;
  }

  function install(middlewares) {
    middlewares.use('/api/malaysia-transit/vehicles', async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }
      if (cache && Date.now() - cache.at < TTL_MS) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-GEV-Cache': 'HIT' });
        res.end(cache.body);
        return;
      }
      const stale = cache;
      const request = coalesceProxyRequest(inFlight, 'refresh', refresh);
      try {
        const fresh = await request.promise;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-GEV-Cache': request.shared ? 'INFLIGHT' : 'MISS' });
        res.end(fresh.body);
      } catch (error) {
        if (stale) {
          console.warn(`[malaysia-transit-proxy] refresh failed (${error?.message || error}) — serving stale`);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-GEV-Cache': 'STALE-ERROR' });
          res.end(stale.body);
          return;
        }
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Malaysia GTFS-Realtime unavailable' }));
      }
    });
  }

  return {
    name: 'malaysia-transit-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
