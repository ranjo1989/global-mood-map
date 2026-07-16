import geoip from 'geoip-lite';

/**
 * IP → coarse location resolution, used by GET /api/geo and by
 * POST /api/report when the client omits lat/lng.
 *
 * Resolution order (first hit wins):
 *   1. Proxy geo headers: cf-iplatitude/cf-iplongitude (Cloudflare), then
 *      x-vercel-ip-latitude/x-vercel-ip-longitude (Vercel). Values must be
 *      finite and in range; an invalid or partial pair falls through.
 *   2. Local GeoLite2 lookup (geoip-lite) of the connection IP, with any
 *      '::ffff:' IPv4-mapped prefix stripped. Private/loopback → no result.
 *   3. GEO_FALLBACK env ('lat,lng'), read lazily on every call so tests
 *      and operators can change it without re-importing the module.
 *
 * Privacy: the raw IP and the raw lookup coordinates exist only in memory
 * for the duration of the request. Everything that is stored or returned
 * to a client is snapped via snapToFinest first (see server/app.ts).
 */

export interface GeoPoint {
  lat: number;
  lng: number;
}

/**
 * Minimal structural view of an Express Request — every real Request
 * satisfies it, and unit tests can pass plain `{ headers, ip }` objects.
 */
export interface GeoRequestLike {
  headers: Record<string, string | string[] | undefined>;
  ip?: string | undefined;
}

/** Parse one coordinate: non-empty numeric string, finite, within [min, max]. */
function parseCoord(raw: string | string[] | undefined, min: number, max: number): number | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (trimmed === '') return null; // Number('') is 0 — never treat empty as a coordinate
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

function fromHeaderPair(
  headers: GeoRequestLike['headers'],
  latName: string,
  lngName: string
): GeoPoint | null {
  const lat = parseCoord(headers[latName], -90, 90);
  const lng = parseCoord(headers[lngName], -180, 180);
  if (lat === null || lng === null) return null;
  return { lat, lng };
}

/** Loopback / private / link-local addresses can never geolocate. */
function isPrivateOrLoopback(ip: string): boolean {
  if (ip === '::1' || ip.startsWith('127.')) return true;
  if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('169.254.')) return true;
  const m172 = /^172\.(\d{1,3})\./.exec(ip);
  if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return true;
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  const low = ip.toLowerCase();
  if (low.startsWith('fc') || low.startsWith('fd') || low.startsWith('fe80')) return true;
  return false;
}

/** GEO_FALLBACK env: 'lat,lng'. Invalid or absent → null, never an error. */
function fromFallbackEnv(): GeoPoint | null {
  const raw = process.env.GEO_FALLBACK;
  if (!raw) return null;
  const parts = raw.split(',');
  if (parts.length !== 2) return null;
  const lat = parseCoord(parts[0], -90, 90);
  const lng = parseCoord(parts[1], -180, 180);
  if (lat === null || lng === null) return null;
  return { lat, lng };
}

/**
 * Best-effort coarse location for a request. Returns RAW coordinates —
 * callers MUST snap (snapToFinest) before storing or responding.
 */
export function resolveGeo(req: GeoRequestLike): GeoPoint | null {
  // 1) Proxy geo headers — Cloudflare wins over Vercel.
  const cf = fromHeaderPair(req.headers, 'cf-iplatitude', 'cf-iplongitude');
  if (cf) return cf;
  const vercel = fromHeaderPair(req.headers, 'x-vercel-ip-latitude', 'x-vercel-ip-longitude');
  if (vercel) return vercel;

  // 2) Local GeoLite2 lookup of the connection IP.
  const ip = (req.ip ?? '').replace(/^::ffff:/i, '');
  if (ip !== '' && !isPrivateOrLoopback(ip)) {
    const ll = geoip.lookup(ip)?.ll;
    if (ll) {
      const [lat, lng] = ll;
      if (
        Number.isFinite(lat) &&
        Number.isFinite(lng) &&
        lat >= -90 &&
        lat <= 90 &&
        lng >= -180 &&
        lng <= 180
      ) {
        return { lat, lng };
      }
    }
  }

  // 3) Operator-provided fallback (dev/demo convenience).
  return fromFallbackEnv();
}
