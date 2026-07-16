/**
 * Multi-resolution lat/lng grid.
 *
 * Reports are snapped to grid cells server-side the moment they arrive;
 * raw coordinates are never stored. Resolution 0 is coarse (10°,
 * continent-scale) and resolution 3 is the finest the system ever
 * retains (0.5° ≈ 55 km — metro area, never street level).
 */

/** Cell edge length in degrees, indexed by resolution. */
export const RESOLUTIONS = [10, 5, 2, 0.5] as const;

export const FINEST_RES = RESOLUTIONS.length - 1;

export type CellId = string; // format: r{res}:{latIdx}:{lngIdx}

function clampLat(lat: number): number {
  return Math.max(-90, Math.min(90, lat));
}

/** Normalize longitude into [-180, 180). */
function wrapLng(lng: number): number {
  const w = ((((lng + 180) % 360) + 360) % 360) - 180;
  return w;
}

export function cellIdFor(lat: number, lng: number, res: number): CellId {
  const size = RESOLUTIONS[res];
  if (size === undefined) throw new RangeError(`invalid resolution ${res}`);
  const la = clampLat(lat);
  const lo = wrapLng(lng);
  // Clamp latIdx so lat=90 lands in the top row instead of one past it.
  const latIdx = Math.min(Math.floor((la + 90) / size), Math.ceil(180 / size) - 1);
  const lngIdx = Math.floor((lo + 180) / size);
  return `r${res}:${latIdx}:${lngIdx}`;
}

export interface CellInfo {
  res: number;
  latIdx: number;
  lngIdx: number;
  /** south-west corner */
  lat0: number;
  lng0: number;
  /** north-east corner */
  lat1: number;
  lng1: number;
  centerLat: number;
  centerLng: number;
}

export function parseCellId(cellId: CellId): CellInfo {
  const m = /^r(\d+):(-?\d+):(-?\d+)$/.exec(cellId);
  if (!m) throw new Error(`invalid cellId: ${cellId}`);
  const res = Number(m[1]);
  const size = RESOLUTIONS[res];
  if (size === undefined) throw new RangeError(`invalid resolution in cellId: ${cellId}`);
  const latIdx = Number(m[2]);
  const lngIdx = Number(m[3]);
  const lat0 = latIdx * size - 90;
  const lng0 = lngIdx * size - 180;
  return {
    res,
    latIdx,
    lngIdx,
    lat0,
    lng0,
    lat1: Math.min(lat0 + size, 90),
    lng1: lng0 + size,
    centerLat: Math.min(lat0 + size / 2, 90),
    centerLng: lng0 + size / 2,
  };
}

/** Snap a coordinate to the center of its finest-resolution cell. */
export function snapToFinest(lat: number, lng: number): { lat: number; lng: number } {
  const info = parseCellId(cellIdFor(lat, lng, FINEST_RES));
  return { lat: info.centerLat, lng: info.centerLng };
}

/**
 * GeoJSON polygon ring (closed, counter-clockwise) for a cell,
 * ready to drop into a MapLibre fill layer.
 */
export function cellPolygon(cellId: CellId): number[][] {
  const c = parseCellId(cellId);
  return [
    [c.lng0, c.lat0],
    [c.lng1, c.lat0],
    [c.lng1, c.lat1],
    [c.lng0, c.lat1],
    [c.lng0, c.lat0],
  ];
}

/** Pick a sensible grid resolution for a map zoom level. */
export function resForZoom(zoom: number): number {
  if (zoom < 3) return 0;
  if (zoom < 4.5) return 1;
  if (zoom < 6.5) return 2;
  return 3;
}
