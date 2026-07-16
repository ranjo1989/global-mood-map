/**
 * Very rough continent lookup for coarse (res-0) cell centers, used by
 * the pulse ticker and the local history list. Boxes are checked in
 * order — first hit wins — so overlapping regions resolve predictably.
 */

interface Box {
  name: string;
  latMin: number;
  latMax: number;
  lngMin: number;
  lngMax: number;
}

const BOXES: Box[] = [
  { name: 'Antarctica', latMin: -90, latMax: -60, lngMin: -180, lngMax: 180 },
  { name: 'Middle East', latMin: 12, latMax: 42, lngMin: 34, lngMax: 60 },
  { name: 'SE Asia', latMin: -10, latMax: 25, lngMin: 92, lngMax: 141 },
  { name: 'Oceania', latMin: -50, latMax: 0, lngMin: 110, lngMax: 180 },
  { name: 'Europe', latMin: 36, latMax: 72, lngMin: -25, lngMax: 40 },
  { name: 'Africa', latMin: -35, latMax: 37, lngMin: -18, lngMax: 52 },
  { name: 'Asia', latMin: 0, latMax: 78, lngMin: 40, lngMax: 180 },
  { name: 'N America', latMin: 7, latMax: 85, lngMin: -170, lngMax: -50 },
  // Greenland sits east of -50, so it needs its own box.
  { name: 'N America', latMin: 58, latMax: 85, lngMin: -75, lngMax: -10 },
  { name: 'S America', latMin: -56, latMax: 13, lngMin: -82, lngMax: -34 },
];

export function continentName(lat: number, lng: number): string {
  for (const b of BOXES) {
    if (lat >= b.latMin && lat <= b.latMax && lng >= b.lngMin && lng <= b.lngMax) return b.name;
  }
  return 'Ocean';
}
