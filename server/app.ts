import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { MOOD_IDS, TAG_IDS } from '../shared/moods';
import { FINEST_RES, RESOLUTIONS, cellIdFor, snapToFinest } from '../shared/grid';
import { DEFAULT_WINDOW_MINS, K_ANONYMITY, RETENTION_HOURS } from '../shared/types';
import type {
  ApiError,
  GeoResponse,
  HealthResponse,
  MetaResponse,
  ReportAccepted,
  ReportStore,
  StoredReport,
} from '../shared/types';
import { aggregates, insights, nearestCityLabel, trendsCell, trendsGlobal } from './aggregator';
import { resolveGeo } from './geo';
import { renderOgPng } from './og';
import { rateLimit } from './rateLimit';
import { SseHub } from './sse';

const reportSchema = z
  .object({
    mood: z.enum(MOOD_IDS),
    lat: z.number().finite().min(-90).max(90).optional(),
    lng: z.number().finite().min(-180).max(180).optional(),
    tag: z.enum(TAG_IDS).optional(),
  })
  .strict()
  // lat/lng travel as a pair: both present (client picked a spot) or both
  // absent (server resolves a coarse location from the connection).
  .refine((b) => (b.lat === undefined) === (b.lng === undefined), {
    message: 'lat and lng must be provided together or omitted together',
  });

/**
 * CSP: the frontend loads the Carto dark-matter basemap (style JSON, tiles,
 * glyphs, sprites — all fetched, hence connect-src) with the MapLibre
 * demotiles style as fallback. img-src keeps raster sprite/image loading
 * working if MapLibre ever uses an <img> for Carto assets.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.basemaps.cartocdn.com",
  "connect-src 'self' https://basemaps.cartocdn.com https://*.basemaps.cartocdn.com https://demotiles.maplibre.org",
  "worker-src 'self' blob:",
  'child-src blob:',
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Vite emits content-hashed filenames under dist/assets — cache forever. */
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

function badRequest(res: Response, error: string): void {
  const body: ApiError = { ok: false, error };
  res.status(400).json(body);
}

/**
 * Defensive integer query param parsing: absent → default, anything that
 * is not an in-range integer → null (route responds 400).
 */
function intParam(raw: unknown, def: number, min: number, max: number): number | null {
  if (raw === undefined) return def;
  if (typeof raw !== 'string') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

/**
 * `at` query param (epoch ms): absent → now, non-finite → null (route
 * responds 400), otherwise clamped into [now - retention, now]. Shared by
 * /api/aggregates and /api/og.png so the two validate identically.
 */
function atParam(raw: unknown, now: number): number | null {
  if (raw === undefined) return now;
  const n = typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(now, Math.max(n, now - RETENTION_HOURS * 3_600_000));
}

/**
 * `at` value for OG *titles* only: a syntactically valid epoch ms that
 * Date can represent, unclamped (the shared card should say the time the
 * link points at, even if the data has since aged out). Otherwise null.
 */
function atForTitle(raw: unknown): number | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const n = Number(raw);
  // 8.64e15 is the ECMAScript Date range bound — beyond it toISOString throws.
  if (!Number.isFinite(n) || Math.abs(n) > 8.64e15) return null;
  return n;
}

const DEFAULT_OG_TITLE = 'Global Mood Map — how the world feels right now';

function ogTitleFor(at: number | null): string {
  if (at === null) return DEFAULT_OG_TITLE;
  const iso = new Date(at).toISOString(); // e.g. 2026-07-16T12:34:56.000Z
  return `How the world felt — ${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** Minimal escaping for text interpolated into HTML attribute values. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function createApp(
  store: ReportStore,
  opts?: {
    simulated?: boolean;
    now?: () => number;
    trustProxy?: boolean | number;
    /** SUPPORT_URL env — surfaced in /api/meta; null/absent when unset. */
    supportUrl?: string | null;
  }
): Express {
  const now = opts?.now ?? Date.now;
  const startedAt = now();
  const app = express();
  app.disable('x-powered-by');
  // Behind Fly/Render/Cloudflare the LB terminates the connection; trust
  // proxy makes req.ip the client address (rate limiting + geo lookup).
  if (opts?.trustProxy !== undefined) app.set('trust proxy', opts.trustProxy);

  // Security headers on EVERY response — API, static files, SSE, errors.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'geolocation=(self)');
    // Browsers ignore HSTS over plain http, so this is safe to send always;
    // it only takes effect once the site is reached over https.
    res.setHeader('Strict-Transport-Security', 'max-age=63072000');
    next();
  });

  // Compress everything EXCEPT the SSE stream — buffering breaks it.
  app.use(
    compression({
      filter: (req: Request, res: Response) =>
        req.path === '/api/stream' ? false : compression.filter(req, res),
    })
  );

  app.use(express.json({ limit: '2kb' }));

  const hub = new SseHub(store);
  // Exposed so index.ts can close the hub on graceful shutdown.
  app.locals.sseHub = hub;

  app.post('/api/report', rateLimit({ now }), (req: Request, res: Response) => {
    const parsed = reportSchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      badRequest(res, `invalid report: ${issue.path.join('.') || 'body'} ${issue.message}`);
      return;
    }
    const { mood, tag } = parsed.data;

    let lat: number;
    let lng: number;
    if (parsed.data.lat !== undefined && parsed.data.lng !== undefined) {
      lat = parsed.data.lat;
      lng = parsed.data.lng;
    } else {
      // No coordinates supplied — estimate from the connection (in memory
      // only; the raw result is snapped below, never stored as-is).
      const geo = resolveGeo(req);
      if (geo === null) {
        const body: ApiError = {
          ok: false,
          error: 'could not estimate a location — pick a spot on the map instead',
        };
        res.status(422).json(body);
        return;
      }
      lat = geo.lat;
      lng = geo.lng;
    }

    // Snap BEFORE storing — raw coordinates never touch the store.
    const snapped = snapToFinest(lat, lng);
    const report: StoredReport = { t: now(), mood, lat: snapped.lat, lng: snapped.lng, sim: false };
    if (tag !== undefined) report.tag = tag;
    store.insert(report);
    const body: ReportAccepted = { ok: true, cellId: cellIdFor(snapped.lat, snapped.lng, FINEST_RES) };
    res.status(201).json(body);
  });

  app.get('/api/geo', (req: Request, res: Response) => {
    // Per-connection response — must never land in a shared cache, or one
    // client's coarse location could be served to another.
    res.setHeader('Cache-Control', 'no-store');
    const geo = resolveGeo(req);
    if (geo === null) {
      const body: ApiError = { ok: false, error: 'could not estimate a location for this connection' };
      res.status(404).json(body);
      return;
    }
    // Snap before anything leaves this handler — the raw lookup result is
    // never returned to the client.
    const snapped = snapToFinest(geo.lat, geo.lng);
    const cellId = cellIdFor(snapped.lat, snapped.lng, FINEST_RES);
    const label = nearestCityLabel(cellId);
    const body: GeoResponse = {
      ok: true,
      cellId,
      lat: snapped.lat,
      lng: snapped.lng,
      // nearestCityLabel falls back to the cellId when the city list is
      // empty — that is not a human label, so surface null instead.
      label: label.startsWith('near ') ? label : null,
    };
    res.json(body);
  });

  app.get('/api/health', (_req: Request, res: Response) => {
    const body: HealthResponse = {
      ok: true,
      uptimeSec: Math.floor((now() - startedAt) / 1000),
      reports: store.count(),
      simulated: opts?.simulated ?? false,
    };
    res.setHeader('Cache-Control', 'no-store');
    res.json(body);
  });

  app.get('/api/aggregates', (req: Request, res: Response) => {
    const resParam = intParam(req.query.res, 0, 0, RESOLUTIONS.length - 1);
    if (resParam === null) {
      badRequest(res, `invalid res: expected integer 0..${RESOLUTIONS.length - 1}`);
      return;
    }
    const windowMins = intParam(req.query.windowMins, DEFAULT_WINDOW_MINS, 5, 1440);
    if (windowMins === null) {
      badRequest(res, 'invalid windowMins: expected integer 5..1440');
      return;
    }
    const at = atParam(req.query.at, now());
    if (at === null) {
      badRequest(res, 'invalid at: expected epoch milliseconds');
      return;
    }
    res.json(aggregates(store, { res: resParam, windowMins, at }));
  });

  // Open Graph card image: the res-2 world mood grid at `at` (default now),
  // rendered server-side. aggregates() already applies k-anonymity — the
  // renderer draws only what it returns.
  app.get('/api/og.png', (req: Request, res: Response) => {
    const at = atParam(req.query.at, now());
    if (at === null) {
      badRequest(res, 'invalid at: expected epoch milliseconds');
      return;
    }
    const { cells } = aggregates(store, { res: 2, windowMins: DEFAULT_WINDOW_MINS, at });
    res.type('png');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.send(renderOgPng(cells));
  });

  app.get('/api/trends/global', (req: Request, res: Response) => {
    const hours = intParam(req.query.hours, 24, 1, 48);
    if (hours === null) {
      badRequest(res, 'invalid hours: expected integer 1..48');
      return;
    }
    res.json(trendsGlobal(store, { hours, now: now() }));
  });

  app.get('/api/trends/cell', (req: Request, res: Response) => {
    const hours = intParam(req.query.hours, 24, 1, 48);
    if (hours === null) {
      badRequest(res, 'invalid hours: expected integer 1..48');
      return;
    }
    const cellId = req.query.cellId;
    if (typeof cellId !== 'string') {
      badRequest(res, 'missing cellId');
      return;
    }
    let trends;
    try {
      trends = trendsCell(store, { cellId, hours, now: now() });
    } catch {
      badRequest(res, `invalid cellId: ${cellId}`);
      return;
    }
    if (trends === null) {
      const body: ApiError = { ok: false, error: 'not enough data' };
      res.status(404).json(body);
      return;
    }
    res.json(trends);
  });

  app.get('/api/insights', (_req: Request, res: Response) => {
    res.json(insights(store, { now: now() }));
  });

  app.get('/api/meta', (_req: Request, res: Response) => {
    const body: MetaResponse = {
      k: K_ANONYMITY,
      windowMins: DEFAULT_WINDOW_MINS,
      retentionHours: RETENTION_HOURS,
      resolutions: RESOLUTIONS,
      startedAt,
      simulated: opts?.simulated ?? false,
      supportUrl: opts?.supportUrl ?? null,
    };
    res.json(body);
  });

  app.get('/api/stream', (req: Request, res: Response) => {
    hub.attach(req, res);
  });

  // Unknown /api paths → JSON 404 (never the SPA fallback).
  app.use('/api', (_req: Request, res: Response) => {
    const body: ApiError = { ok: false, error: 'not found' };
    res.status(404).json(body);
  });

  // Static frontend + SPA fallback, only when a build exists.
  const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  if (fs.existsSync(distDir)) {
    // Every route that would serve index.html goes through this helper so
    // the __OG_TITLE__ / __OG_URL__ / __OG_IMAGE__ placeholders are always
    // rewritten with per-request absolute URLs (crawlers require absolute
    // og: URLs). The file is read once and cached for the app's lifetime —
    // index.html only changes on deploy, which restarts the process.
    let indexHtml: string | null = null;
    const sendIndex = (req: Request, res: Response): void => {
      if (indexHtml === null) indexHtml = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
      const proto = req.protocol;
      const host = req.get('host') ?? 'localhost';
      const at = atForTitle(req.query.at);
      const image = `${proto}://${host}/api/og.png${at === null ? '' : `?at=${at}`}`;
      const url = `${proto}://${host}${req.originalUrl}`;
      const html = indexHtml
        .replaceAll('__OG_TITLE__', escapeHtml(ogTitleFor(at)))
        .replaceAll('__OG_URL__', escapeHtml(url))
        .replaceAll('__OG_IMAGE__', escapeHtml(image));
      // Always revalidate the entry point so deploys are picked up.
      res.setHeader('Cache-Control', 'no-cache');
      res.type('html').send(html);
    };

    // Direct hits on the entry point must also get the OG rewrite — keep
    // them out of express.static (which would stream the raw file).
    app.get('/index.html', sendIndex);
    app.use(
      // index: false → '/' falls through to the SPA fallback (sendIndex)
      // instead of express.static streaming index.html verbatim.
      express.static(distDir, {
        index: false,
        setHeaders: (res, filePath) => {
          if (path.relative(distDir, filePath).startsWith(`assets${path.sep}`)) {
            res.setHeader('Cache-Control', IMMUTABLE_CACHE);
          }
        },
      })
    );
    app.get('*', (req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith('/api') || !req.accepts('html')) {
        next();
        return;
      }
      sendIndex(req, res);
    });
  }

  // Central error handler: ApiError JSON, never a stack trace.
  // Must keep the 4-arg signature for Express to treat it as error middleware.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const status =
      typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number'
        ? err.status
        : 500;
    let message = 'internal server error';
    if (status >= 400 && status < 500) {
      message = err instanceof SyntaxError ? 'invalid JSON body' : status === 413 ? 'request body too large' : 'bad request';
    }
    const body: ApiError = { ok: false, error: message };
    res.status(status >= 400 && status < 600 ? status : 500).json(body);
  });

  return app;
}
