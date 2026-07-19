import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp, parseSupportCrypto } from '../server/app';
import { MemoryStore } from '../server/store';
import type { SseHub } from '../server/sse';
import { FINEST_RES, RESOLUTIONS, cellIdFor, snapToFinest } from '../shared/grid';
import { DEFAULT_WINDOW_MINS, K_ANONYMITY, RETENTION_HOURS } from '../shared/types';
import type { CryptoAddress, StoredReport } from '../shared/types';
import type { MoodId } from '../shared/moods';

const MIN = 60_000;
const HOUR = 3_600_000;
// Fixed fake clock: far from wall-clock now, so the aggregates memo cache
// (only active when at is now-ish) never interferes with assertions.
const START = 1_750_000_000_000;

const LONDON = { lat: 51.5, lng: -0.12 };
const TOKYO = { lat: 35.7, lng: 139.7 };

interface TestApp {
  app: Express;
  store: MemoryStore;
  clock: { now: () => number; advance: (ms: number) => void };
}

const hubs: SseHub[] = [];

function makeApp(extra?: { supportUrl?: string | null; supportCrypto?: CryptoAddress[] }): TestApp {
  const store = new MemoryStore();
  let t = START;
  const clock = {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
  const app = createApp(store, { simulated: true, now: clock.now, ...extra });
  hubs.push(app.locals.sseHub as SseHub);
  return { app, store, clock };
}

// Timers are unref'd, but close hubs anyway so nothing outlives the suite.
afterAll(() => {
  for (const hub of hubs) hub.close();
});

function seed(store: MemoryStore, n: number, t: number, mood: MoodId, loc: { lat: number; lng: number }): void {
  const s = snapToFinest(loc.lat, loc.lng);
  for (let i = 0; i < n; i++) {
    const r: StoredReport = { t, mood, lat: s.lat, lng: s.lng, sim: true };
    store.insert(r);
  }
}

describe('POST /api/report', () => {
  const { app, store, clock } = makeApp();

  // Refill the rate-limit bucket so validation tests never trip 429.
  beforeEach(() => clock.advance(2 * MIN));

  it('accepts a valid report, snaps it, and returns the finest cellId', async () => {
    const before = store.count();
    const res = await request(app)
      .post('/api/report')
      .send({ mood: 'happy', lat: LONDON.lat, lng: LONDON.lng, tag: 'work' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true, cellId: cellIdFor(LONDON.lat, LONDON.lng, FINEST_RES) });

    expect(store.count()).toBe(before + 1);
    const stored = store.query(0, Number.MAX_SAFE_INTEGER).at(-1)!;
    // Raw coordinates never reach the store — only the snapped cell center.
    expect({ lat: stored.lat, lng: stored.lng }).toEqual(snapToFinest(LONDON.lat, LONDON.lng));
    expect(stored.lat).not.toBe(LONDON.lat);
    expect(stored.t).toBe(clock.now());
    expect(stored.mood).toBe('happy');
    expect(stored.tag).toBe('work');
    expect(stored.sim).toBe(false);
  });

  it('tag is optional', async () => {
    const res = await request(app).post('/api/report').send({ mood: 'calm', lat: 0, lng: 0 });
    expect(res.status).toBe(201);
  });

  const badBodies: Array<[string, unknown]> = [
    ['unknown mood', { mood: 'joyful', lat: 0, lng: 0 }],
    ['lat out of range', { mood: 'happy', lat: 91, lng: 0 }],
    ['lng out of range', { mood: 'happy', lat: 0, lng: -180.5 }],
    ['non-numeric lat', { mood: 'happy', lat: '51.5', lng: 0 }],
    ['unknown key', { mood: 'happy', lat: 0, lng: 0, userId: 'abc' }],
    ['unknown tag', { mood: 'happy', lat: 0, lng: 0, tag: 'crypto' }],
    ['missing lng', { mood: 'happy', lat: 0 }],
  ];
  for (const [label, body] of badBodies) {
    it(`rejects ${label} with a 400 ApiError`, async () => {
      const res = await request(app).post('/api/report').send(body as object);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ ok: false, error: expect.any(String) });
    });
  }

  it('rejects a missing body with a 400 ApiError', async () => {
    const res = await request(app).post('/api/report');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: expect.any(String) });
  });

  it('rejects malformed JSON with 400 invalid JSON body', async () => {
    const res = await request(app)
      .post('/api/report')
      .set('Content-Type', 'application/json')
      .send('{"mood": "happy",');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'invalid JSON body' });
  });

  it('rejects an oversized body with 413', async () => {
    const res = await request(app)
      .post('/api/report')
      .send({ mood: 'happy', lat: 0, lng: 0, pad: 'x'.repeat(3000) });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ ok: false, error: 'request body too large' });
  });

  it('invalid reports are never stored', () => {
    // Only the two valid POSTs above should have landed.
    expect(store.count()).toBe(2);
  });
});

describe('POST /api/report rate limiting', () => {
  it('allows 10 rapid reports per IP, rejects the 11th with 429, refills over time', async () => {
    const { app, clock } = makeApp();
    const body = { mood: 'tired', lat: 40.7, lng: -74.0 };
    for (let i = 0; i < 10; i++) {
      const res = await request(app).post('/api/report').send(body);
      expect(res.status).toBe(201);
    }
    const eleventh = await request(app).post('/api/report').send(body);
    expect(eleventh.status).toBe(429);
    expect(eleventh.body).toEqual({ ok: false, error: expect.any(String) });

    // 6 fake seconds refills exactly one token.
    clock.advance(6_000);
    expect((await request(app).post('/api/report').send(body)).status).toBe(201);
    expect((await request(app).post('/api/report').send(body)).status).toBe(429);
  });
});

describe('GET /api/aggregates', () => {
  const { app, store } = makeApp();
  seed(store, K_ANONYMITY, START - 10 * MIN, 'happy', LONDON);
  seed(store, K_ANONYMITY - 1, START - 10 * MIN, 'sad', TOKYO);

  it('returns only cells meeting the k-threshold; totalReports is pre-threshold', async () => {
    const res = await request(app).get('/api/aggregates').query({ res: 1 });
    expect(res.status).toBe(200);
    expect(res.body.res).toBe(1);
    expect(res.body.windowMins).toBe(DEFAULT_WINDOW_MINS);
    expect(res.body.at).toBe(START);
    expect(res.body.k).toBe(K_ANONYMITY);
    expect(res.body.totalReports).toBe(2 * K_ANONYMITY - 1);
    expect(res.body.cells).toHaveLength(1);
    const cell = res.body.cells[0];
    expect(cell.cellId).toBe(cellIdFor(LONDON.lat, LONDON.lng, 1));
    expect(cell.count).toBe(K_ANONYMITY);
    expect(cell.topMood).toBe('happy');
    expect(cell.moods).toEqual({ happy: K_ANONYMITY });
  });

  it('missing res defaults to 0', async () => {
    const res = await request(app).get('/api/aggregates');
    expect(res.status).toBe(200);
    expect(res.body.res).toBe(0);
  });

  const badQueries: Array<[string, Record<string, string>]> = [
    ['res=9', { res: '9' }],
    ['res=-1', { res: '-1' }],
    ['res=1.5', { res: '1.5' }],
    ['res=abc', { res: 'abc' }],
    ['windowMins=4', { windowMins: '4' }],
    ['windowMins=1441', { windowMins: '1441' }],
    ['windowMins=abc', { windowMins: 'abc' }],
    ['at=abc', { at: 'abc' }],
  ];
  for (const [label, query] of badQueries) {
    it(`rejects ${label} with 400`, async () => {
      const res = await request(app).get('/api/aggregates').query(query);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ ok: false, error: expect.any(String) });
    });
  }

  it('honors a historical at (time scrubber)', async () => {
    const res = await request(app)
      .get('/api/aggregates')
      .query({ res: 1, at: String(START - 3 * HOUR) });
    expect(res.status).toBe(200);
    expect(res.body.at).toBe(START - 3 * HOUR);
    expect(res.body.totalReports).toBe(0);
    expect(res.body.cells).toEqual([]);
  });

  it('clamps at into [now - retention, now]', async () => {
    const future = await request(app).get('/api/aggregates').query({ at: String(START + 999 * HOUR) });
    expect(future.body.at).toBe(START);
    const ancient = await request(app).get('/api/aggregates').query({ at: '0' });
    expect(ancient.body.at).toBe(START - RETENTION_HOURS * HOUR);
  });
});

describe('GET /api/trends/global', () => {
  const { app, store } = makeApp();
  seed(store, 2, START - 90 * MIN, 'happy', TOKYO); // bucket 1 of 3
  seed(store, 1, START - 30 * MIN, 'sad', LONDON); // bucket 2 of 3

  it('returns zero-filled hourly buckets, oldest first', async () => {
    const res = await request(app).get('/api/trends/global').query({ hours: 3 });
    expect(res.status).toBe(200);
    expect(res.body.bucketMins).toBe(60);
    expect(res.body.points).toHaveLength(3);
    const fromT = START - 3 * HOUR;
    expect(res.body.points.map((p: { t: number }) => p.t)).toEqual([fromT, fromT + HOUR, fromT + 2 * HOUR]);
    expect(res.body.points.map((p: { count: number }) => p.count)).toEqual([0, 2, 1]);
    expect(res.body.points[0].moods).toEqual({});
    expect(res.body.points[1].moods).toEqual({ happy: 2 });
  });

  it('validates hours', async () => {
    for (const hours of ['0', '49', 'abc', '1.5']) {
      const res = await request(app).get('/api/trends/global').query({ hours });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    }
  });
});

describe('GET /api/trends/cell', () => {
  const { app, store } = makeApp();
  const tokyoCell = cellIdFor(TOKYO.lat, TOKYO.lng, 1);
  seed(store, K_ANONYMITY, START - 30 * MIN, 'calm', TOKYO);

  it('returns buckets for a cell with at least k reports in range', async () => {
    const res = await request(app).get('/api/trends/cell').query({ cellId: tokyoCell, hours: 24 });
    expect(res.status).toBe(200);
    expect(res.body.bucketMins).toBe(60);
    expect(res.body.points).toHaveLength(24);
    const total = res.body.points.reduce((s: number, p: { count: number }) => s + p.count, 0);
    expect(total).toBe(K_ANONYMITY);
  });

  it('404s when the cell total is under k', async () => {
    const res = await request(app).get('/api/trends/cell').query({ cellId: 'r1:22:37', hours: 24 });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, error: 'not enough data' });
  });

  it('400s on a malformed or out-of-range cellId', async () => {
    for (const cellId of ['banana', 'r9:0:0', 'r1:0']) {
      const res = await request(app).get('/api/trends/cell').query({ cellId });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    }
  });

  it('400s when cellId is missing', async () => {
    const res = await request(app).get('/api/trends/cell');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });
});

describe('GET /api/insights', () => {
  const { app, store } = makeApp();
  seed(store, 5, START - 30 * MIN, 'happy', LONDON); // current window
  seed(store, 5, START - 90 * MIN, 'sad', LONDON); // previous window

  it('returns global stats and movers with city labels', async () => {
    const res = await request(app).get('/api/insights');
    expect(res.status).toBe(200);
    expect(res.body.at).toBe(START);
    expect(res.body.global.count).toBe(5);
    expect(res.body.global.topMoods).toEqual([{ mood: 'happy', count: 5 }]);
    expect(res.body.global.valence).toBeCloseTo(0.8, 12);

    expect(res.body.movers).toHaveLength(1);
    const mover = res.body.movers[0];
    expect(mover.cellId).toBe(cellIdFor(LONDON.lat, LONDON.lng, 1));
    expect(mover.label).toMatch(/^near .+, [A-Z]{2}$/);
    expect(mover.count).toBe(5);
    expect(mover.deltaValence).toBeCloseTo(1.5, 12);
  });
});

describe('GET /api/meta and unknown routes', () => {
  const { app } = makeApp();

  it('returns the meta contract', async () => {
    const res = await request(app).get('/api/meta');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      k: K_ANONYMITY,
      windowMins: DEFAULT_WINDOW_MINS,
      retentionHours: RETENTION_HOURS,
      resolutions: [...RESOLUTIONS],
      startedAt: START,
      simulated: true,
      supportUrl: null,
      supportCrypto: [],
    });
  });

  it('echoes the configured supportUrl', async () => {
    const custom = makeApp({ supportUrl: 'https://example.com/support' });
    const res = await request(custom.app).get('/api/meta');
    expect(res.status).toBe(200);
    expect(res.body.supportUrl).toBe('https://example.com/support');
  });

  it('echoes configured crypto donation addresses', async () => {
    const entry = { label: 'ETH', address: '0xF34Dc4adA642C70d811138467D11C6aED379D320' };
    const custom = makeApp({ supportCrypto: [entry] });
    const res = await request(custom.app).get('/api/meta');
    expect(res.status).toBe(200);
    expect(res.body.supportCrypto).toEqual([entry]);
  });

  it('parseSupportCrypto accepts valid entries and skips malformed ones', () => {
    const addr = '0xF34Dc4adA642C70d811138467D11C6aED379D320';
    expect(parseSupportCrypto(undefined)).toEqual([]);
    expect(parseSupportCrypto('')).toEqual([]);
    expect(parseSupportCrypto(`ETH & USDT ERC-20:${addr}`)).toEqual([
      { label: 'ETH & USDT ERC-20', address: addr },
    ]);
    // Two entries, one malformed (address too short) — bad one is skipped.
    expect(parseSupportCrypto(`ETH:${addr},BTC:short`)).toEqual([{ label: 'ETH', address: addr }]);
    // Missing separator, empty label, and non-alphanumeric addresses are skipped.
    expect(parseSupportCrypto('no-separator')).toEqual([]);
    expect(parseSupportCrypto(`:${addr}`)).toEqual([]);
    expect(parseSupportCrypto('ETH:<script>alert(1)</script>aaaaaaaaaaaaa')).toEqual([]);
  });

  it('serves the privacy policy at /privacy as HTML', async () => {
    const res = await request(app).get('/privacy');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('Privacy Policy');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('unknown /api paths return JSON 404, any method', async () => {
    const get = await request(app).get('/api/nope');
    expect(get.status).toBe(404);
    expect(get.body).toEqual({ ok: false, error: 'not found' });
    const post = await request(app).post('/api/definitely/not/here');
    expect(post.status).toBe(404);
    expect(post.body).toEqual({ ok: false, error: 'not found' });
  });
});

// ---------------------------------------------------------------------------
// v2: geo-resolved reports, /api/geo, /api/health, security headers
// ---------------------------------------------------------------------------

// The geo tests below rely on the connection IP being loopback (supertest
// connects to 127.0.0.1), which never geolocates — so the only resolvable
// source is proxy headers. GEO_FALLBACK must not leak in from the host env.
const savedGeoFallback = process.env.GEO_FALLBACK;
function isolateGeoFallback(): void {
  beforeEach(() => {
    delete process.env.GEO_FALLBACK;
  });
  afterAll(() => {
    if (savedGeoFallback === undefined) delete process.env.GEO_FALLBACK;
    else process.env.GEO_FALLBACK = savedGeoFallback;
  });
}

describe('POST /api/report without coordinates (v2 geo)', () => {
  isolateGeoFallback();

  it('rejects lat without lng (and lng without lat) with 400', async () => {
    const { app } = makeApp();
    const onlyLat = await request(app).post('/api/report').send({ mood: 'happy', lat: 10 });
    expect(onlyLat.status).toBe(400);
    expect(onlyLat.body).toEqual({ ok: false, error: expect.any(String) });
    const onlyLng = await request(app).post('/api/report').send({ mood: 'happy', lng: 10 });
    expect(onlyLng.status).toBe(400);
    expect(onlyLng.body).toEqual({ ok: false, error: expect.any(String) });
  });

  it('201s using proxy geo headers when lat/lng are omitted', async () => {
    const { app, store, clock } = makeApp();
    const res = await request(app)
      .post('/api/report')
      .set('cf-iplatitude', String(TOKYO.lat))
      .set('cf-iplongitude', String(TOKYO.lng))
      .send({ mood: 'excited' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true, cellId: cellIdFor(TOKYO.lat, TOKYO.lng, FINEST_RES) });

    const stored = store.query(0, Number.MAX_SAFE_INTEGER).at(-1)!;
    // The resolved location is snapped before storage, like a client-picked one.
    expect({ lat: stored.lat, lng: stored.lng }).toEqual(snapToFinest(TOKYO.lat, TOKYO.lng));
    expect(stored.t).toBe(clock.now());
    expect(stored.sim).toBe(false);
  });

  it('422s when no location can be resolved for the connection', async () => {
    const { app, store } = makeApp();
    const before = store.count();
    const res = await request(app).post('/api/report').send({ mood: 'sad' });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      ok: false,
      error: 'could not estimate a location — pick a spot on the map instead',
    });
    expect(store.count()).toBe(before);
  });
});

describe('GET /api/geo', () => {
  isolateGeoFallback();

  it('returns the snapped cell center and a city label for proxy geo headers', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .get('/api/geo')
      .set('x-vercel-ip-latitude', String(LONDON.lat))
      .set('x-vercel-ip-longitude', String(LONDON.lng));
    expect(res.status).toBe(200);

    const snapped = snapToFinest(LONDON.lat, LONDON.lng);
    const { label, ...rest } = res.body as { label: string | null } & Record<string, unknown>;
    expect(rest).toEqual({
      ok: true,
      cellId: cellIdFor(LONDON.lat, LONDON.lng, FINEST_RES),
      lat: snapped.lat,
      lng: snapped.lng,
    });
    // The raw request coordinates must never come back verbatim.
    expect(rest.lat).not.toBe(LONDON.lat);
    expect(label === null || /^near .+/.test(label)).toBe(true);
  });

  it('404s when nothing resolves (loopback, no headers, no fallback)', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/geo');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, error: 'could not estimate a location for this connection' });
  });
});

describe('GET /api/health', () => {
  it('returns the health contract with no-store caching', async () => {
    const { app, store, clock } = makeApp();
    clock.advance(5_000);
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      uptimeSec: 5,
      reports: store.count(),
      simulated: true,
    });
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('security headers', () => {
  it('are present on API responses', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/meta');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['permissions-policy']).toBe('geolocation=(self)');

    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain('https://*.basemaps.cartocdn.com');
    expect(csp).toContain('https://demotiles.maplibre.org');
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});

// ---------------------------------------------------------------------------
// Growth layer: OG card image + per-request OG meta rewriting
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe('GET /api/og.png', () => {
  const { app, store } = makeApp();
  seed(store, 25, START - 10 * MIN, 'happy', LONDON);
  seed(store, K_ANONYMITY, START - 10 * MIN, 'sad', TOKYO);

  it('returns a PNG with a 60s public cache', async () => {
    const res = await request(app).get('/api/og.png');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    expect([...(res.body as Buffer).subarray(0, 8)]).toEqual(PNG_SIGNATURE);
  });

  it('accepts a historical at (same clamp/validation as /api/aggregates)', async () => {
    const res = await request(app).get('/api/og.png').query({ at: String(START - 3 * HOUR) });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect([...(res.body as Buffer).subarray(0, 8)]).toEqual(PNG_SIGNATURE);
  });

  it('rejects a non-numeric at with a 400 ApiError', async () => {
    const res = await request(app).get('/api/og.png').query({ at: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: expect.any(String) });
  });
});

describe('OG meta rewriting on index.html (real dist build)', () => {
  const { app } = makeApp();

  it('GET / serves index.html with every placeholder replaced', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.text).not.toContain('__OG_');
    expect(res.text).toContain('Global Mood Map — how the world feels right now');
    // og:image and og:url must be absolute for crawlers.
    expect(res.text).toMatch(/property="og:image" content="http[^"]*\/api\/og\.png"/);
    expect(res.text).toMatch(/property="og:url" content="http/);
  });

  it('a valid ?at= deep link changes og:title and og:image', async () => {
    const res = await request(app).get('/').query({ at: '1700000000000' });
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('__OG_');
    expect(res.text).not.toContain('Global Mood Map — how the world feels right now');
    expect(res.text).toMatch(/property="og:title" content="How the world felt — [^"]*UTC"/);
    expect(res.text).toMatch(/property="og:image" content="http[^"]*\/api\/og\.png\?at=1700000000000"/);
    expect(res.text).toMatch(/property="og:url" content="http[^"]*\/\?at=1700000000000"/);
  });

  it('an invalid ?at= falls back to the default OG title', async () => {
    const res = await request(app).get('/').query({ at: 'banana' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Global Mood Map — how the world feels right now');
    expect(res.text).toMatch(/property="og:image" content="http[^"]*\/api\/og\.png"/);
  });

  it('the SPA fallback rewrites placeholders on deep paths too', async () => {
    const res = await request(app).get('/some/client/route');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).not.toContain('__OG_');
    expect(res.text).toMatch(/property="og:url" content="http[^"]*\/some\/client\/route"/);
  });
});
