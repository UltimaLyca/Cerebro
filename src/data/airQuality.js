/**
 * @module airQuality
 * @description Modelled air quality (US AQI, PM2.5, PM10) for Malaysian cities
 * and the regional haze-source cities, from Open-Meteo's free, keyless
 * air-quality API (CAMS model). The server proxy (`/api/air-quality/summary`)
 * batches one request for all cities. Values are coarse-grid MODEL output, not
 * station readings, and the selection card says so.
 */

import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';

const ENDPOINT = '/api/air-quality/summary';
const REFRESH_INTERVAL_MS = 30 * 60_000;
export const AIR_QUALITY_OVERLAY_SOURCE_ID = 'air-quality-selected';
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

const AQI_BANDS = [
  [50, '#3ddc84', 'Good'],
  [100, '#ffd84d', 'Moderate'],
  [150, '#ff9a3c', 'Unhealthy for sensitive groups'],
  [200, '#ff4d4d', 'Unhealthy'],
  [300, '#b04dff', 'Very unhealthy'],
  [Infinity, '#7a1f3d', 'Hazardous'],
];

function aqiBand(aqi) {
  return AQI_BANDS.find(([max]) => aqi <= max);
}

function aqiColor(aqi) {
  return Cesium.Color.fromCssColorString(aqiBand(aqi)[1]);
}

function aqiSize(aqi) {
  return Math.max(8, Math.min(22, Math.round(8 + aqi / 25)));
}

function buildSelectionEntry(city) {
  const band = aqiBand(city.usAqi);
  const details = [band[2]];
  if (Number.isFinite(city.pm25)) details.push(`PM2.5 ${city.pm25} µg/m³`);
  if (Number.isFinite(city.pm10)) details.push(`PM10 ${city.pm10} µg/m³`);
  details.push('Modelled value, not a station reading');
  return {
    id: String(city.id),
    position: Cesium.Cartesian3.fromDegrees(city.lon, city.lat, 0),
    variant: 'selected',
    selected: true,
    protected: true,
    paintLane: 'selected',
    collisionGroup: 'ambient-card',
    priority: Number.MAX_SAFE_INTEGER,
    title: `${city.name} · US AQI ${city.usAqi}`,
    details,
    accent: band[1],
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
  _overlayHost.clearSource(AIR_QUALITY_OVERLAY_SOURCE_ID);
}

function selectCity(key) {
  clearSelection();
  const record = _records.get(key);
  if (!record) return;
  _selectedKey = key;
  _overlayHost.setEntries(
    AIR_QUALITY_OVERLAY_SOURCE_ID,
    [buildSelectionEntry(record.city)],
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
      selectCity(picked.primitive.id);
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

function render(cities) {
  governorRequestRender('air-quality');
  clearSelection();
  _points.removeAll();
  _records.clear();
  for (const city of cities) {
    if (!Number.isFinite(city.lat) || !Number.isFinite(city.lon)) continue;
    _points.add({
      position: Cesium.Cartesian3.fromDegrees(city.lon, city.lat, 0),
      pixelSize: aqiSize(city.usAqi),
      color: aqiColor(city.usAqi).withAlpha(0.9),
      outlineColor: OUTLINE,
      outlineWidth: 1,
      disableDepthTestDistance: 2500,
      id: city.id,
    });
    _records.set(city.id, { city });
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
    render(Array.isArray(payload?.cities) ? payload.cities : []);
    _lastUpdate = Date.now();
    _error = null;
  } catch (error) {
    if (error?.name === 'AbortError') return;
    console.warn('[Data:AirQuality] refresh error:', error);
    _error = 'Open-Meteo air quality fetch error';
  } finally {
    _loading = false;
  }
}

function clearAll() {
  clearSelection();
  _points?.removeAll();
  _records.clear();
}

export default {
  id: 'air-quality',
  name: 'Air Quality (modelled)',
  icon: '😷',
  source: 'Open-Meteo · CAMS model',
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
  },

  getStats() {
    return {
      count: _records.size,
      lastUpdate: _lastUpdate,
      loading: _loading,
      error: _error,
      model: 'Open-Meteo / CAMS (modelled)',
    };
  },
};
