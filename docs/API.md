# API Contract

Base URL: same origin, prefix `/api`. All responses are JSON unless noted.
Types referenced here are defined in [`shared/types.ts`](../shared/types.ts) — that file is the source of truth.

## POST /api/report

Submit one anonymous mood report.

Request body (validated with zod, unknown keys rejected, body limit 2 KB):

```json
{ "mood": "happy", "lat": 51.5, "lng": -0.12, "tag": "work" }
```

- `mood`: one of `MOOD_IDS` (shared/moods.ts)
- `lat` / `lng`: optional **as a pair** — either both present (finite numbers, -90..90 / -180..180) or both absent. One without the other → 400.
- `tag`: optional, one of `TAG_IDS`

Behavior:
- When `lat`/`lng` are **omitted**, the server estimates a coarse location for the connection (see [Location resolution](#location-resolution-order)). If nothing resolves → `422 ApiError` (`"could not estimate a location — pick a spot on the map instead"`); the client should fall back to map-tap placement.
- Coordinates — supplied or resolved — are snapped with `snapToFinest()` **before** the report is stored. Raw coordinates never touch the store or the log.
- Rate limit: 10 reports/minute per IP (in-memory token bucket). The IP is used only as the bucket key in memory and is never stored with, or derivable from, a report.
- Responses: `201 ReportAccepted` · `400 ApiError` (validation / malformed JSON) · `413 ApiError` (body over 2 KB) · `422 ApiError` (no resolvable location) · `429 ApiError` (rate limit).

## GET /api/geo

The coarse location the server would assign to this connection — lets the frontend pre-select "your area" without prompting for browser geolocation.

Returns `GeoResponse`:

```json
{ "ok": true, "cellId": "r3:283:359", "lat": 51.75, "lng": -0.25, "label": "near London, GB" }
```

- `cellId`: the **finest-resolution** grid cell.
- `lat`/`lng`: the **snapped cell center** — never the raw lookup result.
- `label`: nearest major city hint (`"near {name}, {country}"`), or `null` if unknown.
- No source resolves → `404 ApiError` (`"could not estimate a location for this connection"`).

### Location resolution (order)

Implemented in [`server/geo.ts`](../server/geo.ts); first hit wins:

1. **Proxy geo headers**: `cf-iplatitude`/`cf-iplongitude` (Cloudflare), then `x-vercel-ip-latitude`/`x-vercel-ip-longitude` (Vercel). Values must be finite and in range; an invalid or partial pair falls through to the next source.
2. **Local GeoLite2 lookup** (`geoip-lite`, data bundled — no network call) of `req.ip`, with any `::ffff:` IPv4-mapped prefix stripped. Private/loopback/link-local addresses never resolve.
3. **`GEO_FALLBACK` env** (`"lat,lng"`), if set and valid — dev/demo convenience.
4. Otherwise: no location (`404` on `/api/geo`, `422` on coordinate-less reports).

Privacy: the raw IP and the raw lookup coordinates are used **only in memory** for the duration of the request. Everything stored or returned to a client is snapped via `snapToFinest()` first. For `req.ip` to be the client (not the load balancer) behind a proxy, set `TRUST_PROXY` (below) — this also matters for rate limiting.

## GET /api/health

Liveness/readiness endpoint for deploy platforms. Always `200` while the process is serving, with `Cache-Control: no-store`. Returns `HealthResponse`:

```json
{ "ok": true, "uptimeSec": 4211, "reports": 187345, "simulated": true }
```

`uptimeSec` counts from app creation; `reports` is the current store size; `simulated` mirrors the `SIM` env.

## GET /api/aggregates?res=0&windowMins=60&at=<epochMs>

Regional aggregates for the map.

- `res`: 0..3, default chosen by client via `resForZoom()`. Invalid → 400.
- `windowMins`: 5..1440, default `DEFAULT_WINDOW_MINS` (60).
- `at`: optional epoch ms — window **ends** at this time (enables the 24 h time scrubber). Default: now. Clamped to retention.
- Returns `AggregatesResponse`. **Cells with `count < K_ANONYMITY` are omitted** — this is the k-anonymity boundary and must be enforced here, not in the client.
- `totalReports` counts all in-window reports before thresholding.
- Server may cache responses per (res, windowMins, at≈now) for ~2 s.

## GET /api/trends/global?hours=24

Hourly buckets over the whole planet. Returns `TrendsResponse` with `bucketMins: 60`, one point per hour (oldest first), zero-filled. `hours`: 1..48, default 24.

## GET /api/trends/cell?cellId=r1:22:37&hours=24

Same shape, restricted to one cell (any resolution). k-anonymity is enforced twice: if the *total* across the requested range is `< K_ANONYMITY`, return 404 `ApiError` ("not enough data"); and any individual bucket with `0 < count < K_ANONYMITY` is suppressed (returned as `count: 0`, `valence: 0`, empty `moods`) so a sparse region can never be dissected report by report. Invalid cellId → 400.

## GET /api/insights

Returns `InsightsResponse`: global mood (current 60-min window) plus up to 5 "movers" — resolution-1 cells whose valence changed most vs the previous 60-min window. Only cells with `count >= K_ANONYMITY` in **both** windows qualify. `label` = nearest city from the sim's city list to the cell center, formatted `"near {name}, {country}"`.

## GET /api/meta

Returns `MetaResponse`. `simulated: true` while the world simulator is running. `supportUrl` mirrors the `SUPPORT_URL` env (donations page) — `null` when unset.

## GET /api/og.png?at=<epochMs>

Server-rendered Open Graph card image: the world mood grid as a 1200×630 PNG (`image/png`, `Cache-Control: public, max-age=60`).

- `at`: optional epoch ms — same validation and retention clamping as `/api/aggregates` (non-numeric → `400 ApiError`). Default: now.
- Renders the **resolution-2** aggregates for the default 60-minute window ending at `at`, drawn as equirectangular colored cells on a `#0b1020` background: each cell is filled with its `valenceColor()` at an opacity that scales with report count (~0.45 at `k` → ~0.95 at 300+), with a 1 px darker inset edge and a subtle vignette toward the borders.
- **Privacy:** the image is generated from `aggregates()` output, so k-anonymity is enforced before rendering — cells under the threshold never appear.
- Deliberately contains **no text**: crawlers display `og:title` alongside the image (see below).

## GET /api/stream  (Server-Sent Events)

Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`. Flush headers immediately; send a `: ping` comment every 25 s to keep proxies happy. The stream is **excluded from compression** (see below) so events are never buffered.

Events:
- `update` — `UpdateEvent`, throttled to at most 1 per 2 s, only when new reports arrived. Client refetches aggregates on receipt.
- `pulse` — `PulseEvent` for a sample of incoming reports (max ~1/s; sample, don't queue). `cellId` is **always resolution 0**.

Clean up subscribers on `close`. No client identifier is logged.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Listen port. |
| `DATA_DIR` | `./data` | Directory holding `reports.jsonl` (real reports only — sim reports are never persisted). Resolved relative to the working directory. |
| `SIM` | `on` | `on` seeds 48 h of history and runs the live world simulator; `off` disables both (`simulated: false` in `/api/meta` and `/api/health`). |
| `TRUST_PROXY` | unset (off) | Express `trust proxy` value: unset/`''` = off, `'1'` = trust the first hop, `'true'` = trust all hops. Required behind Fly/Render/Cloudflare so `req.ip` is the client address (rate limiting + geo lookup), not the load balancer. |
| `GEO_FALLBACK` | unset | Optional `"lat,lng"` used when IP geolocation fails — dev/demo convenience. Invalid values are ignored. |
| `SUPPORT_URL` | unset | Optional donations/support page URL, surfaced to clients as `supportUrl` in `/api/meta` (`null` when unset). |
| `SUPPORT_CRYPTO` | unset | Optional comma-separated `Label:address` list of **public** crypto donation addresses (e.g. `ETH & USDT ERC-20:0xF34D…`), surfaced as `supportCrypto` in `/api/meta` and shown in the About modal. Labels ≤32 chars; addresses must be 20–100 alphanumeric chars; malformed entries are silently skipped. |

The server logs one boot line with the effective config (values only, no secrets; `GEO_FALLBACK` and `SUPPORT_URL` are reported as set/unset).

## Security headers

Every response (API, static, SSE, errors) carries:

- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `X-Frame-Options: DENY`
- `Permissions-Policy: geolocation=(self)`
- `Strict-Transport-Security: max-age=63072000` (ignored by browsers over plain http; effective once served via https)
- `Content-Security-Policy`:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.basemaps.cartocdn.com; connect-src 'self' https://basemaps.cartocdn.com https://*.basemaps.cartocdn.com https://demotiles.maplibre.org; worker-src 'self' blob:; child-src blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'
```

The CSP allows exactly the map assets the frontend needs: the Carto dark-matter basemap (style JSON, tiles, glyphs, sprites — all fetched, hence `connect-src`) plus the MapLibre demotiles fallback, and blob workers for MapLibre.

## Compression

`compression()` gzips API and static responses, **except** `GET /api/stream` — SSE must never be buffered by a compressor.

## Static serving & caching

In production/preview the same Express server serves `dist/` (if present) with an SPA fallback: any GET that doesn't start with `/api` and accepts HTML returns `dist/index.html`.

Caching:
- Hashed build assets under `dist/assets/` → `Cache-Control: public, max-age=31536000, immutable` (Vite content-hashes the filenames).
- `index.html` — served directly or via the SPA fallback → `Cache-Control: no-cache` (always revalidated, so deploys are picked up immediately).

### OG meta rewriting

`index.html` contains `__OG_TITLE__`, `__OG_URL__`, and `__OG_IMAGE__` placeholders (harmless in vite dev). Every route that serves it — `/`, `/index.html`, and the SPA fallback — goes through one helper that reads the file once (cached for the process lifetime; deploys restart the process) and rewrites the placeholders per request:

- `__OG_TITLE__` → `Global Mood Map — how the world feels right now`, or, when a valid `?at=<epochMs>` deep link is present, `How the world felt — <YYYY-MM-DD HH:MM> UTC`.
- `__OG_URL__` → absolute `proto://host` + the request's original URL (deep links keep their `?at=`).
- `__OG_IMAGE__` → absolute `proto://host/api/og.png`, with `?at=<epochMs>` appended for deep links.

`proto`/`host` come from `req.protocol` + the `Host` header (correct behind a proxy when `TRUST_PROXY` is set). Substituted values are HTML-escaped. Deep link contract: **`/?at=<epochMs>`** — the frontend opens with the time scrubber at that moment, and crawlers get a card whose image and title match it. `express.static` is configured with `index: false` so `/` always reaches the rewriting helper; the image itself stays text-free because crawlers render `og:title` next to it.

## Error shape

All errors: `{ "ok": false, "error": "human-readable message" }` with an appropriate 4xx/5xx status. Unhandled errors → 500 with a generic message (never leak stack traces).
