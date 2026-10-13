/**
 * @module malaysiaTransit
 * @description Live Malaysia public-transit vehicle positions — KTMB trains,
 * Prasarana Rapid Bus/MRT Feeder, and myBAS city bus fleets — from Malaysia's
 * free, keyless GTFS-Realtime Open API (developer.data.gov.my). Server-side
 * proxy (`/api/malaysia-transit/vehicles` in vite.config.js) fetches and
 * decodes each feed's protobuf and merges them into one JSON array.
 *
 * Every rendered vehicle carries its real feed-reported id/label and
 * trip/route id — there is no synthetic per-vehicle numbering.
 */

import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';

const ENDPOINT = '/api/malaysia-transit/vehicles';
export const MALAYSIA_TRANSIT_OVERLAY_SOURCE_ID = 'malaysia-transit-selected';

const COLOR_TRAIN = Cesium.Color.fromCssColorString('#7ad9ff').withAlpha(0.95);
const COLOR_BUS = Cesium.Color.fromCssColorString('#8dffb0').withAlpha(0.92);
const COLOR_OUTLINE = Cesium.Color.BLACK.withAlpha(0.3);
const POINT_HEIGHT_OFFSET_M = 30;

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});

let _viewer = null;
let _enabled = false;
let _pointCollection = null;
let _abort = null;
let _loading = false;
let _lastUpdate = null;
let _error = null;
let _sources = [];
/** @type {Map<string, Object>} vehicle id -> render record {point, vehicle} */
let _records = new Map();
let _clickHandler = null;
let _selectedKey = null;
let _overlayHost = DEFAULT_OVERLAY_HOST;

function isTrain(vehicle) {
  return vehicle.source === 'KTMB';
}

function buildSelectionEntry(key, vehicle) {
  const lines = [
    vehicle.vehicleLabel || vehicle.id,
    vehicle.source + (vehicle.routeId ? ` · route ${vehicle.routeId}` : ''),
  ];
  if (Number.isFinite(vehicle.speedMps))
    lines.push(`${Math.round(vehicle.speedMps * 3.6)} km/h`);
  const [title, ...details] = lines;
  return {
    id: String(key),
    position: Cesium.Cartesian3.fromDegrees(
      vehicle.lon,
      vehicle.lat,
      POINT_HEIGHT_OFFSET_M,
    ),
    variant: 'selected',
    selected: true,
    protected: true,
    paintLane: 'selected',
    collisionGroup: 'ambient-card',
    priority: Number.MAX_SAFE_INTEGER,
    title,
    details,
    accent: isTrain(vehicle) ? '#7ad9ff' : '#8dffb0',
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
  if (_selectedKey) {
    const record = _records.get(_selectedKey);
    if (record?.point) record.point.show = true;
  }
  _selectedKey = null;
  _overlayHost.clearSource(MALAYSIA_TRANSIT_OVERLAY_SOURCE_ID);
}

function selectVehicle(key) {
  clearSelection();
  const record = _records.get(key);
  if (!record?.point) return;
  _selectedKey = key;
  record.point.show = false;
  _overlayHost.setEntries(
    MALAYSIA_TRANSIT_OVERLAY_SOURCE_ID,
    [buildSelectionEntry(key, record.vehicle)],
    { cohortLimit: 1, collisionCapacity: 0, moving: true },
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
      selectVehicle(picked.primitive.id);
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

function renderVehicles(vehicles) {
  governorRequestRender('malaysia-transit');
  const seen = new Set();
  for (const vehicle of vehicles) {
    if (!Number.isFinite(vehicle.lat) || !Number.isFinite(vehicle.lon))
      continue;
    seen.add(vehicle.id);
    const position = Cesium.Cartesian3.fromDegrees(
      vehicle.lon,
      vehicle.lat,
      POINT_HEIGHT_OFFSET_M,
    );
    const existing = _records.get(vehicle.id);
    if (existing) {
      existing.point.position = position;
      existing.vehicle = vehicle;
      continue;
    }
    const point = _pointCollection.add({
      position,
      pixelSize: isTrain(vehicle) ? 8 : 5,
      color: isTrain(vehicle) ? COLOR_TRAIN : COLOR_BUS,
      outlineColor: COLOR_OUTLINE,
      outlineWidth: 1,
      scaleByDistance: new Cesium.NearFarScalar(1000, 1.3, 400000, 0.4),
      disableDepthTestDistance: 2500,
      id: vehicle.id,
    });
    _records.set(vehicle.id, { point, vehicle });
  }
  // Remove vehicles no longer present in this poll.
  for (const [id, record] of _records) {
    if (seen.has(id)) continue;
    if (id === _selectedKey) clearSelection();
    _pointCollection.remove(record.point);
    _records.delete(id);
  }
}

async function refresh(viewer) {
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
    renderVehicles(Array.isArray(payload?.vehicles) ? payload.vehicles : []);
    _lastUpdate = Date.now();
    _error = null;
  } catch (error) {
    if (error?.name === 'AbortError') return;
    console.warn('[Data:MalaysiaTransit] refresh error:', error);
    _error = 'GTFS-Realtime fetch error';
  } finally {
    _loading = false;
  }
}

function clearAll(viewer) {
  clearSelection();
  for (const record of _records.values())
    _pointCollection?.remove(record.point);
  _records.clear();
}

export default {
  id: 'malaysia-transit',
  name: 'Malaysia Transit',
  icon: '🚆',
  source: 'data.gov.my GTFS-Realtime',
  updateInterval: 30_000,
  statsRefreshInterval: 1000,

  init(viewer) {
    _viewer = viewer;
    _pointCollection = viewer.scene.primitives.add(
      new Cesium.PointPrimitiveCollection(),
    );
    installClickHandler(viewer);
  },

  async enable(viewer, { signal } = {}) {
    _enabled = true;
    if (_pointCollection) _pointCollection.show = true;
    await refresh(viewer || _viewer);
  },

  disable(viewer) {
    _enabled = false;
    if (_abort) _abort.abort();
    if (_pointCollection) _pointCollection.show = false;
    clearAll(viewer || _viewer);
  },

  async update(viewer) {
    if (!_enabled) return;
    await refresh(viewer || _viewer);
  },

  destroy(viewer) {
    this.disable(viewer);
    removeClickHandler();
    if (_pointCollection && (viewer || _viewer)) {
      (viewer || _viewer).scene.primitives.remove(_pointCollection);
    }
    _pointCollection = null;
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
    };
  },
};
