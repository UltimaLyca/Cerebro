/**
 * @module rainRadar
 * @description Live global precipitation radar overlay from RainViewer's free,
 * keyless public API — https://www.rainviewer.com/api.html.
 *
 * RainViewer publishes a rolling window of recent radar composite frames as
 * standard XYZ raster tiles. This layer fetches the current frame index,
 * renders the most recent frame as a Cesium imagery layer, and re-checks for
 * a newer frame on a timer (radar composites refresh roughly every 10
 * minutes upstream).
 *
 * Free for personal/non-commercial use; RainViewer asks that its API be
 * credited as the data source (see DATA_SOURCES.md and dataCredits.js).
 */

import * as Cesium from 'cesium';

/** RainViewer's public, keyless frame-index endpoint. */
const WEATHER_MAPS_URL = 'https://api.rainviewer.com/public/weather-maps.json';
/** How often to re-check for a newer radar frame (ms). Upstream refreshes ~every 10 min. */
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
/** Tile pixel size RainViewer serves. */
const TILE_SIZE = 256;
/** RainViewer color scheme id 2 = "Universal Blue", the commonly used default. */
const COLOR_SCHEME = 2;
/** Tile rendering options: smooth=1 (blurred edges), snow=1 (distinct snow color). */
const TILE_OPTIONS = '1_1';
/** Layer opacity over the base globe imagery. */
const LAYER_ALPHA = 0.6;

let _viewer = null;
let _enabled = false;
let _imageryLayer = null;
let _currentFramePath = null;
let _loading = false;
let _lastUpdate = null;
let _error = null;

/**
 * Fetch RainViewer's current frame index and return the most recent past
 * radar frame, or null if none is available.
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ host: string, path: string, time: number }|null>}
 */
async function fetchLatestFrame(signal) {
  const response = await fetch(WEATHER_MAPS_URL, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  const host = String(payload?.host || '').trim();
  const past = Array.isArray(payload?.radar?.past) ? payload.radar.past : [];
  const latest = past[past.length - 1];
  if (!host || !latest?.path) return null;
  return { host, path: String(latest.path), time: Number(latest.time) || null };
}

/**
 * Build a Cesium UrlTemplateImageryProvider for a given radar frame.
 * @param {{ host: string, path: string }} frame
 * @returns {Cesium.UrlTemplateImageryProvider}
 */
function buildProvider(frame) {
  const template = `${frame.host}${frame.path}/${TILE_SIZE}/{z}/{x}/{y}/${COLOR_SCHEME}/${TILE_OPTIONS}.png`;
  return new Cesium.UrlTemplateImageryProvider({
    url: template,
    credit: new Cesium.Credit('RainViewer', false),
  });
}

/**
 * Swap in a new imagery layer for the given frame, removing any prior one.
 * No-ops if the frame path hasn't changed since the layer currently shown.
 * @param {Cesium.Viewer} viewer
 * @param {{ host: string, path: string, time: number }} frame
 */
function applyFrame(viewer, frame) {
  if (frame.path === _currentFramePath && _imageryLayer) return;
  const nextLayer = new Cesium.ImageryLayer(buildProvider(frame));
  nextLayer.alpha = LAYER_ALPHA;
  viewer.imageryLayers.add(nextLayer);
  if (_imageryLayer) viewer.imageryLayers.remove(_imageryLayer, true);
  _imageryLayer = nextLayer;
  _currentFramePath = frame.path;
  _lastUpdate = frame.time ? frame.time * 1000 : Date.now();
}

/** Remove the current imagery layer, if any. */
function removeLayer(viewer) {
  if (_imageryLayer && viewer) {
    viewer.imageryLayers.remove(_imageryLayer, true);
  }
  _imageryLayer = null;
  _currentFramePath = null;
}

async function refresh(viewer, signal) {
  _loading = true;
  try {
    const frame = await fetchLatestFrame(signal);
    if (!frame) throw new Error('No radar frames available');
    if (!_enabled) return; // Disabled while the fetch was in flight.
    applyFrame(viewer, frame);
    _error = null;
  } catch (error) {
    if (error?.name === 'AbortError') return;
    console.warn('[Data:RainRadar] refresh error:', error);
    _error = 'RainViewer fetch error';
  } finally {
    _loading = false;
  }
}

export default {
  id: 'rain-radar',
  name: 'Rain Radar',
  icon: '🌧️',
  source: 'RainViewer',
  updateInterval: REFRESH_INTERVAL_MS,
  statsRefreshInterval: 1000,

  init(viewer) {
    _viewer = viewer;
  },

  async enable(viewer, { signal } = {}) {
    _enabled = true;
    await refresh(viewer || _viewer, signal);
  },

  disable(viewer) {
    _enabled = false;
    removeLayer(viewer || _viewer);
  },

  async update(viewer, { signal } = {}) {
    if (!_enabled) return;
    await refresh(viewer || _viewer, signal);
  },

  destroy(viewer) {
    removeLayer(viewer || _viewer);
    _viewer = null;
    _enabled = false;
    _loading = false;
    _lastUpdate = null;
    _error = null;
  },

  getStats() {
    return {
      count: _imageryLayer ? 1 : 0,
      lastUpdate: _lastUpdate,
      loading: _loading,
      error: _error,
    };
  },
};
