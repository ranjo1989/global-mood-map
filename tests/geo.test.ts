import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import geoip from 'geoip-lite';
import { resolveGeo } from '../server/geo';
import type { GeoRequestLike } from '../server/geo';

// resolveGeo reads GEO_FALLBACK lazily per call — isolate every test from
// whatever the host environment has set, and restore it afterwards.
const savedFallback = process.env.GEO_FALLBACK;
beforeEach(() => {
  delete process.env.GEO_FALLBACK;
});
afterAll(() => {
  if (savedFallback === undefined) delete process.env.GEO_FALLBACK;
  else process.env.GEO_FALLBACK = savedFallback;
});

function fakeReq(headers: GeoRequestLike['headers'] = {}, ip?: string): GeoRequestLike {
  return { headers, ip };
}

const CF_TOKYO = { 'cf-iplatitude': '35.7', 'cf-iplongitude': '139.7' };
const VERCEL_LONDON = { 'x-vercel-ip-latitude': '51.5', 'x-vercel-ip-longitude': '-0.12' };

describe('resolveGeo — proxy geo headers', () => {
  it('uses cloudflare headers when present and valid', () => {
    expect(resolveGeo(fakeReq({ ...CF_TOKYO }, '127.0.0.1'))).toEqual({ lat: 35.7, lng: 139.7 });
  });

  it('cloudflare headers win over vercel headers', () => {
    const r = resolveGeo(fakeReq({ ...CF_TOKYO, ...VERCEL_LONDON }, '127.0.0.1'));
    expect(r).toEqual({ lat: 35.7, lng: 139.7 });
  });

  it('falls back to vercel headers when cloudflare headers are absent', () => {
    expect(resolveGeo(fakeReq({ ...VERCEL_LONDON }, '127.0.0.1'))).toEqual({ lat: 51.5, lng: -0.12 });
  });

  it('out-of-range cloudflare values fall through to vercel', () => {
    const headers = {
      'cf-iplatitude': '99', // > 90 — invalid
      'cf-iplongitude': '10',
      ...VERCEL_LONDON,
    };
    expect(resolveGeo(fakeReq(headers, '127.0.0.1'))).toEqual({ lat: 51.5, lng: -0.12 });
  });

  it('non-numeric header values fall through', () => {
    const headers = { 'cf-iplatitude': 'abc', 'cf-iplongitude': 'def' };
    expect(resolveGeo(fakeReq(headers, '127.0.0.1'))).toBeNull();
  });

  it('a partial pair (lat without lng) falls through', () => {
    expect(resolveGeo(fakeReq({ 'cf-iplatitude': '35.7' }, '127.0.0.1'))).toBeNull();
    expect(resolveGeo(fakeReq({ 'x-vercel-ip-longitude': '139.7' }, '127.0.0.1'))).toBeNull();
  });

  it('empty header strings are not treated as coordinate 0', () => {
    const headers = { 'cf-iplatitude': '', 'cf-iplongitude': '' };
    expect(resolveGeo(fakeReq(headers, '127.0.0.1'))).toBeNull();
  });

  it('out-of-range longitude falls through', () => {
    const headers = { 'cf-iplatitude': '10', 'cf-iplongitude': '181' };
    expect(resolveGeo(fakeReq(headers, '127.0.0.1'))).toBeNull();
  });
});

describe('resolveGeo — geoip-lite lookup', () => {
  it("resolves '::ffff:8.8.8.8' (IPv4-mapped) via the bundled GeoLite2 data", () => {
    // Sanity-check the bundled data first: 8.8.8.8 is Google public DNS,
    // stably geolocated to the USA.
    const direct = geoip.lookup('8.8.8.8');
    expect(direct).not.toBeNull();
    expect(direct!.country).toBe('US');

    const r = resolveGeo(fakeReq({}, '::ffff:8.8.8.8'));
    expect(r).not.toBeNull();
    expect(r!.lat).toBeGreaterThanOrEqual(-90);
    expect(r!.lat).toBeLessThanOrEqual(90);
    expect(r!.lng).toBeGreaterThanOrEqual(-180);
    expect(r!.lng).toBeLessThanOrEqual(180);
    expect(r).toEqual({ lat: direct!.ll[0], lng: direct!.ll[1] });
  });

  it('loopback and private addresses never resolve (no GEO_FALLBACK)', () => {
    for (const ip of [
      '127.0.0.1',
      '::1',
      '::ffff:127.0.0.1',
      '10.0.0.5',
      '192.168.1.10',
      '172.16.0.1',
      '172.31.255.1',
      '169.254.1.1',
    ]) {
      expect(resolveGeo(fakeReq({}, ip)), ip).toBeNull();
    }
  });

  it('a missing ip never resolves', () => {
    expect(resolveGeo(fakeReq({}))).toBeNull();
    expect(resolveGeo(fakeReq({}, ''))).toBeNull();
  });
});

describe('resolveGeo — GEO_FALLBACK env', () => {
  it('is used when headers and IP lookup both fail', () => {
    process.env.GEO_FALLBACK = '48.85,2.35';
    expect(resolveGeo(fakeReq({}, '127.0.0.1'))).toEqual({ lat: 48.85, lng: 2.35 });
  });

  it('tolerates whitespace around the coordinates', () => {
    process.env.GEO_FALLBACK = ' 48.85 , 2.35 ';
    expect(resolveGeo(fakeReq({}, '127.0.0.1'))).toEqual({ lat: 48.85, lng: 2.35 });
  });

  it('headers still win over the fallback', () => {
    process.env.GEO_FALLBACK = '48.85,2.35';
    expect(resolveGeo(fakeReq({ ...CF_TOKYO }, '127.0.0.1'))).toEqual({ lat: 35.7, lng: 139.7 });
  });

  it('invalid fallback values are ignored', () => {
    for (const bad of ['abc', '91,0', '0,181', '10', '10,20,30', '48.85,', ',2.35']) {
      process.env.GEO_FALLBACK = bad;
      expect(resolveGeo(fakeReq({}, '127.0.0.1')), bad).toBeNull();
    }
  });
});
