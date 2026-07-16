import { describe, expect, it } from 'vitest';
import {
  FINEST_RES,
  RESOLUTIONS,
  cellIdFor,
  cellPolygon,
  parseCellId,
  resForZoom,
  snapToFinest,
} from '../shared/grid';

describe('cellIdFor boundaries', () => {
  it('lat +90 lands in the top row (never one past it)', () => {
    for (let res = 0; res < RESOLUTIONS.length; res++) {
      const size = RESOLUTIONS[res];
      const topRow = Math.ceil(180 / size) - 1;
      expect(cellIdFor(90, 0, res)).toBe(`r${res}:${topRow}:${Math.floor(180 / size)}`);
      // Same cell as a point just below the pole.
      expect(cellIdFor(90, 0, res)).toBe(cellIdFor(89.999, 0, res));
    }
  });

  it('lat -90 lands in row 0', () => {
    for (let res = 0; res < RESOLUTIONS.length; res++) {
      const info = parseCellId(cellIdFor(-90, 0, res));
      expect(info.latIdx).toBe(0);
      expect(info.lat0).toBe(-90);
    }
  });

  it('out-of-range latitudes are clamped', () => {
    expect(cellIdFor(95, 10, 0)).toBe(cellIdFor(90, 10, 0));
    expect(cellIdFor(-123, 10, 0)).toBe(cellIdFor(-90, 10, 0));
  });

  it('lng -180 and +180 map to the same (first) column', () => {
    expect(cellIdFor(0, 180, 0)).toBe(cellIdFor(0, -180, 0));
    expect(parseCellId(cellIdFor(0, -180, 0)).lngIdx).toBe(0);
  });

  it('longitudes beyond 180 wrap around', () => {
    expect(cellIdFor(0, 190, 0)).toBe(cellIdFor(0, -170, 0));
    expect(cellIdFor(0, 540, 0)).toBe(cellIdFor(0, 180, 0));
    expect(cellIdFor(0, -190, 0)).toBe(cellIdFor(0, 170, 0));
    expect(cellIdFor(45, 361, 2)).toBe(cellIdFor(45, 1, 2));
  });

  it('throws on an invalid resolution', () => {
    expect(() => cellIdFor(0, 0, 4)).toThrow(RangeError);
    expect(() => cellIdFor(0, 0, -1)).toThrow(RangeError);
  });
});

describe('parseCellId <-> cellIdFor roundtrip', () => {
  const samples: Array<[number, number]> = [
    [0, 0],
    [51.5, -0.12],
    [35.7, 139.7],
    [-33.9, 18.4],
    [89.999, 179.999],
    [-90, -180],
    [90, 180],
    [-0.001, 0.001],
    [67.3, -152.8],
  ];

  it('re-formatting parsed indices reproduces the id', () => {
    for (const [lat, lng] of samples) {
      for (let res = 0; res < RESOLUTIONS.length; res++) {
        const id = cellIdFor(lat, lng, res);
        const info = parseCellId(id);
        expect(`r${info.res}:${info.latIdx}:${info.lngIdx}`).toBe(id);
      }
    }
  });

  it('the source point lies inside the parsed cell bounds', () => {
    for (const [lat, lng] of samples) {
      for (let res = 0; res < RESOLUTIONS.length; res++) {
        const info = parseCellId(cellIdFor(lat, lng, res));
        const clampedLat = Math.max(-90, Math.min(90, lat));
        const wrappedLng = ((((lng + 180) % 360) + 360) % 360) - 180;
        expect(clampedLat).toBeGreaterThanOrEqual(info.lat0);
        expect(clampedLat).toBeLessThanOrEqual(info.lat1);
        expect(wrappedLng).toBeGreaterThanOrEqual(info.lng0);
        expect(wrappedLng).toBeLessThan(info.lng1);
        // The cell's own center must be inside the cell too.
        expect(info.centerLat).toBeGreaterThanOrEqual(info.lat0);
        expect(info.centerLat).toBeLessThanOrEqual(info.lat1);
        expect(info.centerLng).toBeGreaterThan(info.lng0);
        expect(info.centerLng).toBeLessThan(info.lng1);
      }
    }
  });

  it('rejects malformed or out-of-range ids', () => {
    expect(() => parseCellId('banana')).toThrow();
    expect(() => parseCellId('r1:0')).toThrow();
    expect(() => parseCellId('r4:0:0')).toThrow(RangeError);
    expect(() => parseCellId('r1:0:0:0')).toThrow();
    expect(() => parseCellId('1:0:0')).toThrow();
  });
});

describe('snapToFinest', () => {
  const samples: Array<[number, number]> = [
    [0, 0],
    [51.5, -0.12],
    [35.71, 139.73],
    [-33.9, 18.4],
    [90, 0],
    [-90, 0],
    [12.34, -180],
    [45.6, 179.99],
    [89.99, -179.99],
  ];

  it('lands inside the same finest-res cell as the input', () => {
    for (const [lat, lng] of samples) {
      const snapped = snapToFinest(lat, lng);
      expect(cellIdFor(snapped.lat, snapped.lng, FINEST_RES)).toBe(cellIdFor(lat, lng, FINEST_RES));
    }
  });

  it('is idempotent (a snapped point snaps to itself)', () => {
    for (const [lat, lng] of samples) {
      const once = snapToFinest(lat, lng);
      expect(snapToFinest(once.lat, once.lng)).toEqual(once);
    }
  });
});

describe('cellPolygon', () => {
  it('is a closed 5-point ring matching the cell corners', () => {
    for (const id of ['r0:17:18', 'r3:283:359', 'r1:0:0', 'r2:44:179']) {
      const ring = cellPolygon(id);
      const c = parseCellId(id);
      expect(ring).toHaveLength(5);
      expect(ring[0]).toEqual(ring[4]);
      expect(ring[0]).toEqual([c.lng0, c.lat0]);
      expect(ring[1]).toEqual([c.lng1, c.lat0]);
      expect(ring[2]).toEqual([c.lng1, c.lat1]);
      expect(ring[3]).toEqual([c.lng0, c.lat1]);
    }
  });

  it('winds counter-clockwise (positive shoelace area)', () => {
    const ring = cellPolygon('r1:20:30');
    let area = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    }
    expect(area).toBeGreaterThan(0);
  });
});

describe('resForZoom bands', () => {
  it('maps zoom levels to the documented resolutions', () => {
    expect(resForZoom(0)).toBe(0);
    expect(resForZoom(2.99)).toBe(0);
    expect(resForZoom(3)).toBe(1);
    expect(resForZoom(4.49)).toBe(1);
    expect(resForZoom(4.5)).toBe(2);
    expect(resForZoom(6.49)).toBe(2);
    expect(resForZoom(6.5)).toBe(3);
    expect(resForZoom(22)).toBe(3);
  });

  it('only ever returns a valid resolution index', () => {
    for (let z = 0; z <= 22; z += 0.25) {
      const r = resForZoom(z);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(FINEST_RES);
      expect(Number.isInteger(r)).toBe(true);
    }
  });
});
