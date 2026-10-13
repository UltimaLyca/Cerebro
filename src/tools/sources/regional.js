/**
 * Portable sources for the Malaysia alerts, modelled air quality and the
 * investigation bridge. They request the app's own `/api/...` paths through
 * the injected fetch, like the layers' source factories.
 */

async function getJson(fetchImpl, path, { signal, init } = {}) {
  const response = await fetchImpl(path, { ...init, signal });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(
      body?.error || `Request failed with HTTP ${response.status}`,
    );
    error.status = response.status;
    throw error;
  }
  return body;
}

export function createMalaysiaMetSource({ fetchImpl }) {
  return {
    getSummary: ({ signal } = {}) =>
      getJson(fetchImpl, '/api/malaysia-met/summary', { signal }),
  };
}

export function createAirQualitySource({ fetchImpl }) {
  return {
    getSummary: ({ signal } = {}) =>
      getJson(fetchImpl, '/api/air-quality/summary', { signal }),
  };
}

/**
 * The investigation bridge client. `token` is the shared secret the server
 * requires; it is sent only in a header and never appears in results.
 */
export function createInvestigationSource({ fetchImpl, token }) {
  const headers = { 'x-investigate-token': token };
  return {
    start: ({ target, mode, signal }) =>
      getJson(fetchImpl, '/api/investigate/scan', {
        signal,
        init: {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify(mode ? { target, mode } : { target }),
        },
      }),
    status: ({ id, signal }) =>
      getJson(fetchImpl, `/api/investigate/scan?id=${encodeURIComponent(id)}`, {
        signal,
        init: { headers },
      }),
    results: ({ id, type, signal }) =>
      getJson(
        fetchImpl,
        `/api/investigate/results?id=${encodeURIComponent(id)}&type=${encodeURIComponent(type || 'ALL')}`,
        { signal, init: { headers } },
      ),
  };
}
