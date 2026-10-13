/**
 * Minimal SpiderFoot 4.x web-API client (the CherryPy endpoints of
 * `sf.py -l host:port`). Parsing is split from transport so the response
 * shapes can be tested without a running SpiderFoot.
 */

const SCAN_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Statuses SpiderFoot reports once a scan is no longer working. */
const FINISHED = new Set(['FINISHED', 'ABORTED', 'ERROR-FAILED']);

export function parseStartResponse(payload) {
  if (Array.isArray(payload) && payload[0] === 'SUCCESS' && payload[1])
    return { ok: true, scanId: String(payload[1]) };
  const message =
    Array.isArray(payload) && payload[1]
      ? String(payload[1])
      : 'unexpected response';
  return { ok: false, error: message };
}

/** scanstatus → [name, target, created, started, ended, status, riskmatrix] */
export function parseStatus(payload) {
  if (!Array.isArray(payload) || payload.length < 6) return null;
  const status = String(payload[5]);
  return {
    name: String(payload[0]),
    target: String(payload[1]),
    created: payload[2],
    started: payload[3],
    ended: payload[4],
    status,
    finished: FINISHED.has(status),
    risk: payload[6] && typeof payload[6] === 'object' ? payload[6] : null,
  };
}

/** scansummary rows → [type, description, lastSeen, total, unique, status] */
export function parseSummary(payload) {
  if (!Array.isArray(payload)) return [];
  return payload
    .filter((row) => Array.isArray(row) && row.length >= 5)
    .map((row) => ({
      type: String(row[0]),
      description: String(row[1]),
      lastSeen: row[2],
      total: Number(row[3]) || 0,
      unique: Number(row[4]) || 0,
    }))
    .sort((a, b) => b.total - a.total);
}

/**
 * scaneventresults rows → [time, data, source, module, type, confidence,
 * visibility, risk, hash, sourceHash, sourceType...]. Only the first fields
 * are used, and data is capped so a single huge record cannot flood a client.
 */
export function parseEvents(payload, { limit = 500, maxData = 300 } = {}) {
  if (!Array.isArray(payload)) return [];
  const events = [];
  for (const row of payload) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const data = String(row[1] ?? '');
    events.push({
      time: row[0],
      data: data.length > maxData ? `${data.slice(0, maxData)}…` : data,
      source: String(row[2] ?? ''),
      module: String(row[3] ?? ''),
      type: String(row[4] ?? ''),
    });
    if (events.length >= limit) break;
  }
  return events;
}

export function createSpiderFootClient({ baseUrl, fetchImpl = fetch }) {
  const base = String(baseUrl).replace(/\/+$/, '');

  async function request(path, { method = 'GET', form, query } = {}) {
    const url = new URL(base + path);
    for (const [key, value] of Object.entries(query || {}))
      url.searchParams.set(key, value);
    const response = await fetchImpl(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(form
          ? { 'Content-Type': 'application/x-www-form-urlencoded' }
          : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(SCAN_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`SpiderFoot HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > MAX_BODY_BYTES)
      throw new Error('SpiderFoot response too large');
    return JSON.parse(text);
  }

  return {
    async startScan({ name, target, usecase }) {
      return parseStartResponse(
        await request('/startscan', {
          method: 'POST',
          form: {
            scanname: name,
            scantarget: target,
            usecase,
            modulelist: '',
            typelist: '',
          },
        }),
      );
    },
    async status(id) {
      return parseStatus(await request('/scanstatus', { query: { id } }));
    },
    async summary(id) {
      return parseSummary(
        await request('/scansummary', { query: { id, by: 'type' } }),
      );
    },
    async events(id, eventType = 'ALL', options) {
      return parseEvents(
        await request('/scaneventresults', { query: { id, eventType } }),
        options,
      );
    },
    async stop(id) {
      await request('/stopscan', { query: { id } });
    },
  };
}
