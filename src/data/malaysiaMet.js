/**
 * @module malaysiaMet
 * @description Earthquakes reported by MET Malaysia (last 30 days) and the
 * active MET weather warnings, from data.gov.my's free, keyless Open API
 * (developer.data.gov.my/realtime-api/weather). The server proxy
 * (`/api/malaysia-met/summary`) normalises both feeds.
 *
 * Earthquakes are drawn at the feed's own coordinates. Warnings have no
 * geometry upstream, so they are listed in the layer stats only; nothing is
 * drawn for them.
 */

import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';

const ENDPOINT = '/api/malaysia-met/summary';
const REFRESH_INTERVAL_MS = 5 * 60_000;
export const MALAYSIA_MET_OVERLAY_SOURCE_ID = 'malaysia-met-selected';
const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});
const OUTLINE = Cesium.Color.BLACK.withAlpha(0.4);

let _viewer = null;
let _enabled = false;
let _points = null;
let _records = new Map();
let _clickHandler = null;
let _selectedKey = null;
let _overlayHost = DEFAULT_OVERLAY_HOST;
let _abort = null;
let _loading = false;
let _lastUpdate = null;
let _error = null;
let _sources = [];
let _warnings = [];

function quakeColor(magnitude) {
  if (magnitude >= 6.5) return Cesium.Color.fromCssColorString('#ff4d4d');
  if (magnitude >= 5.5) return Cesium.Color.fromCssColorString('#ff9a3c');
  return Cesium.Color.fromCssColorString('#ffd84d');
}

function quakeSize(magnitude) {
  return Math.max(6, Math.min(22, Math.round((magnitude - 3) * 4)));
}

function buildSelectionEntry(quake) {
  const mag = Number.isFinite(quake.magnitude)
    ? `M${quake.magnitude.toFixed(1)}${quake.magnitudeType ? ` ${quake.magnitudeType}` : ''}`
    : 'Magnitude unknown';
  const details = [new Date(quake.timeMs).toISOString().replace('.000Z', 'Z')];
  if (quake.distanceFromMalaysia) details.push(quake.distanceFromMalaysia);
  if (Number.isFinite(quake.depthKm)) details.push(`${quake.depthKm} km deep`);
  return {
    id: String(quake.id),
    position: Cesium.Cartesian3.fromDegrees(quake.lon, quake.lat, 0),
    variant: 'selected',
    selected: true,
    protected: true,
    paintLane: 'selected',
    collisionGroup: 'ambient-card',
    priority: Number.MAX_SAFE_INTEGER,
    title: `${mag} · ${quake.place || 'Unnamed region'}`,
    details,
    accent: '#ff9a3c',
    interactive: false,
    anchorRadiusPx: 8,
    minAnchorGapPx: 10,
    verticalOnly: true,
    placement: 'above',
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
  };
}

function clearSelection() {
  _selectedKey = null;
  _overlayHost.clearSource(MALAYSIA_MET_OVERLAY_SOURCE_ID);
}

function selectQuake(key) {
  clearSelection();
  const record = _records.get(key);
  if (!record) return;
  _selectedKey = key;
  _overlayHost.setEntries(
    MALAYSIA_MET_OVERLAY_SOURCE_ID,
    [buildSelectionEntry(record.quake)],
    { cohortLimit: 1, collisionCapacity: 0, moving: false },
  );
}

function installClickHandler(viewer) {
  if (_clickHandler) return;
  _clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  _clickHandler.setInputAction((click) => {
    const picked = viewer.scene.pick(click.position);
    if (
      picked?.primitive &&
      typeof picked.primitive.id === 'string' &&
      _records.has(picked.primitive.id)
    ) {
      selectQuake(picked.primitive.id);
      return;
    }
    if (_selectedKey) clearSelection();
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

function removeClickHandler() {
  if (_clickHandler) {
    _clickHandler.destroy();
    _clickHandler = null;
  }
}

function render(quakes) {
  governorRequestRender('malaysia-met');
  clearSelection();
  _points.removeAll();
  _records.clear();
  for (const quake of quakes) {
    if (!Number.isFinite(quake.lat) || !Number.isFinite(quake.lon)) continue;
    _points.add({
      position: Cesium.Cartesian3.fromDegrees(quake.lon, quake.lat, 0),
      pixelSize: quakeSize(quake.magnitude ?? 0),
      color: quakeColor(quake.magnitude ?? 0).withAlpha(0.9),
      outlineColor: OUTLINE,
      outlineWidth: 1,
      disableDepthTestDistance: 2500,
      id: quake.id,
    });
    _records.set(quake.id, { quake });
  }
}

async function refresh() {
  if (!_enabled) return;
  _loading = true;
  const controller = new AbortController();
  _abort = controller;
  try {
    const response = await fetch(ENDPOINT, {
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (!_enabled) return;
    _sources = Array.isArray(payload?.sources) ? payload.sources : [];
    _warnings = Array.isArray(payload?.warnings) ? payload.warnings : [];
    render(Array.isArray(payload?.earthquakes) ? payload.earthquakes : []);
    _lastUpdate = Date.now();
    _error = null;
  } catch (error) {
    if (error?.name === 'AbortError') return;
    console.warn('[Data:MalaysiaMet] refresh error:', error);
    _error = 'MET Malaysia fetch error';
  } finally {
    _loading = false;
  }
}

function clearAll() {
  clearSelection();
  _points?.removeAll();
  _records.clear();
  _warnings = [];
}

export default {
  id: 'malaysia-met',
  name: 'Malaysia MET Alerts',
  icon: '🌋',
  source: 'MET Malaysia · data.gov.my',
  updateInterval: REFRESH_INTERVAL_MS,
  statsRefreshInterval: 1000,

  init(viewer) {
    _viewer = viewer;
    _points = viewer.scene.primitives.add(
      new Cesium.PointPrimitiveCollection(),
    );
    installClickHandler(viewer);
  },

  async enable() {
    _enabled = true;
    if (_points) _points.show = true;
    await refresh();
  },

  disable() {
    _enabled = false;
    if (_abort) _abort.abort();
    if (_points) _points.show = false;
    clearAll();
  },

  async update() {
    if (!_enabled) return;
    await refresh();
  },

  destroy(viewer) {
    this.disable();
    const v = viewer || _viewer;
    if (v && _points) v.scene.primitives.remove(_points);
    removeClickHandler();
    _points = null;
    _viewer = null;
    _lastUpdate = null;
    _error = null;
    _sources = [];
  },

  getStats() {
    return {
      count: _records.size,
      lastUpdate: _lastUpdate,
      loading: _loading,
      error: _error,
      sources: _sources,
      warnings: _warnings.map(({ title, validToMs }) => ({ title, validToMs })),
    };
  },
};
