# Deployment

Global Mood Map deploys as **one Docker image running one Node process**: Express serves the API, the built frontend (`dist/`), and the SSE stream; reports live in memory with a JSONL append log at `DATA_DIR`. That single-process design is deliberate (see [ARCHITECTURE.md](ARCHITECTURE.md)) and it constrains hosting: you need **exactly one always-on instance with a persistent disk**. This guide is honest about that, and about what changes when you outgrow it.

## Configuration (env contract)

| Var | Default | Behavior |
|---|---|---|
| `PORT` | `8787` | HTTP listen port. |
| `DATA_DIR` | `./data` | Directory for `reports.jsonl` (real reports only — simulated reports are never persisted). |
| `SIM` | `on` | `on` / `off`. Seeds 48 h of history and runs the live world simulator (`server/sim/`). |
| `TRUST_PROXY` | unset (off) | Express `trust proxy` value: unset/`''` = off, `'1'` = trust first hop, `'true'` = trust all. Required behind Fly/Render/Cloudflare so `req.ip` is the client, not the load balancer — rate limiting and IP geolocation depend on it. |
| `GEO_FALLBACK` | unset | Optional `'lat,lng'` used when IP geolocation fails (dev/demo convenience). |
| `SUPPORT_URL` | unset | Optional donations page URL (Ko-fi / GitHub Sponsors). Exposed to the frontend as `supportUrl` in `/api/meta` (`null` when unset). |

### Growth surface (no extra config)

Everything the growth layer needs is served automatically by the same process:

- **`GET /api/og.png`** — the live social-card image (1200×630 world mood grid) is rendered by the server per request; deep links (`/?at=<epochMs>`) get per-request OG meta rewrites in `index.html`.
- **PWA files** — `manifest.webmanifest`, `sw.js`, and `icons/icon-{192,512}.png` live in `public/` and are copied by Vite into the `dist/` root at build, so the normal static serving picks them up. Regenerate icons with `npx tsx scripts/generate-icons.ts`.
- **Forecast bot** — `scripts/forecast.ts` runs anywhere with network access to the API (see [STRATEGY.md](STRATEGY.md) for the cron setup); it is not part of the server process.

## Where to host

| Host | Verdict | Why |
|---|---|---|
| **Fly.io** | ✅ Recommended | Persistent volumes, always-on machines, first-class Dockerfile deploys, ~$3–7/mo total. This repo ships a ready `fly.toml`. |
| **Railway** | ✅ Fine | Volumes + always-on services; comparable, slightly pricier at the low end. Set `TRUST_PROXY=1` and attach a volume at your `DATA_DIR`. |
| **Render** | ✅ Fine | Needs a paid instance for a persistent disk; the free tier sleeps, which kills SSE and the in-memory store. Same env vars apply. |
| **Vercel / Netlify / Lambda (serverless)** | ❌ No | Functions are stateless and short-lived. This app needs one long-running process: in-memory store, in-process SSE fan-out, long-lived streaming responses. Serverless breaks all three. |

## Fly.io walkthrough

1. **Install flyctl and sign in**

   ```bash
   # macOS
   brew install flyctl
   # Linux
   curl -L https://fly.io/install.sh | sh
   # Windows (PowerShell)
   pwsh -Command "iwr https://fly.io/install.ps1 -useb | iex"

   fly auth login   # or: fly auth signup
   ```

2. **Create the app (no deploy yet)** — uses the checked-in `fly.toml`; pick a unique app name and a region near your users when prompted:

   ```bash
   fly launch --no-deploy
   ```

   Answer "yes" to copying the existing `fly.toml` configuration. If `fly launch` rewrote anything, make sure the `[env]`, `[http_service]`, `[mounts]`, and check sections from the repo version survived.

3. **Create the volume** (same region as the app):

   ```bash
   fly volumes create gmm_data --size 1
   ```

4. **Deploy**:

   ```bash
   fly deploy
   fly logs        # watch boot: "Global Mood Map listening on ... | config: ..."
   fly status
   ```

   Open `https://<your-app>.fly.dev` — with `SIM=on` the map is alive immediately.

5. **Exactly one machine.** The store is in-memory and SSE fan-out is in-process, so two machines means two different maps and split streams. One volume can only mount on one machine, which helps enforce this, but verify:

   ```bash
   fly scale count 1
   ```

   Do not enable more machines until you've done the [scale path](#scale-path-when-one-instance-isnt-enough) work.

6. **Custom domain + TLS**:

   ```bash
   fly certs add mood.example.com
   ```

   Add the DNS records `fly certs add` prints (A/AAAA to the app's IPs, or a CNAME to `<your-app>.fly.dev`), then check issuance with `fly certs show mood.example.com`.

## Optional: Cloudflare in front

Not required, but useful for caching static assets and DDoS shrugging:

- Point the DNS record at Fly with the proxy (orange cloud) **on**.
- **SSE survives**: the server sends a `: ping` comment every 25 s on `/api/stream` (see [API.md](API.md)), comfortably inside Cloudflare's ~100 s proxied idle timeout.
- **Enable "Add visitor location headers"** (Dashboard → Rules → Settings/Managed Transforms). Requests then carry `cf-iplatitude`/`cf-iplongitude`, which the server prefers over its local IP database — geo accuracy improves to Cloudflare's own geolocation for free.
- **Proxy hops**: with Cloudflare → Fly there are two hops. `TRUST_PROXY=1` resolves `req.ip` to Cloudflare's edge (fine for geo, since the `cf-*` headers win, but bad for rate limiting — many users share an edge IP). `TRUST_PROXY` accepts `true` (trust all hops) or an integer hop count — nothing else (see [API.md](API.md)); set `TRUST_PROXY=2` in `fly.toml`'s `[env]` to trust both hops and get the real client IP back.

## IP geolocation operations

When a report arrives without coordinates, the server resolves a coarse location in this order (raw IP and raw lookup coordinates are used **only in memory**; everything stored or returned is snapped to a ≥55 km grid cell first):

1. Proxy geo headers: `cf-iplatitude`/`cf-iplongitude`, then `x-vercel-ip-latitude`/`x-vercel-ip-longitude` (validated finite and in-range).
2. Local `geoip-lite` lookup on `req.ip` (`::ffff:` prefix stripped; private/loopback addresses yield nothing).
3. `GEO_FALLBACK` env, if set. Otherwise: no location.

**Accuracy expectations.** `geoip-lite` ships a bundled GeoLite2 snapshot that runs entirely on your server (no IP ever leaves it). Expect city/metro accuracy at best, often just a country-level centroid; VPNs and mobile carriers lie freely. **That's fine by design** — every location is coarsened to ≥55 km cells anyway, and users who care can share device location instead.

**Refreshing the database.** The snapshot is frozen at whatever `geoip-lite` release you installed. Two options:

- Easiest: `npm update geoip-lite` and redeploy — new package releases ship newer snapshots.
- Freshest: run geoip-lite's update script with a free MaxMind license key (create one at maxmind.com → GeoLite2), then redeploy:

  ```bash
  cd node_modules/geoip-lite
  npm run updatedb license_key=YOUR_LICENSE_KEY
  ```

  To bake this into the image, run it in the Dockerfile's build stage after `npm ci`, passing the key as a build secret — never commit it.

**Attribution (required by the GeoLite2 license):** the app must display
*"This product includes GeoLite2 data created by MaxMind, available from https://www.maxmind.com".*
It lives in the app's About modal — keep it there.

## Basemap operations

- The map uses the **Carto dark-matter** basemap, free within Carto's usage terms for small projects. The required Carto + © OpenStreetMap contributors credit is shown by the map's attribution control — never remove or hide it.
- When traffic outgrows the free tier, switch to self-hosted **Protomaps** pmtiles (one static file on any CDN) or **MapTiler** (generous free tier). Two edits: the `PRIMARY_STYLE_URL` constant in `src/components/MoodMap.tsx`, **and** the CSP host allowlist in `server/app.ts` (`connect-src`/`img-src`) — the server blocks any basemap host it doesn't know about.

## Data & backups

- Everything durable is one file: `$DATA_DIR/reports.jsonl` (`/app/data/reports.jsonl` on the Fly volume). It holds **real reports only** — simulated reports are regenerated at boot, never persisted.
- Retention is 48 h by design, so the live dataset stays tiny; backups are trivial.
- Fly volumes get automatic daily snapshots (kept 5 days): `fly volumes list`, then `fly volumes snapshots list <volume-id>`.
- Manual backup any time:

  ```bash
  fly ssh sftp get /app/data/reports.jsonl ./reports-backup.jsonl
  ```

## Monitoring

- **`GET /api/health`** returns `HealthResponse` (`shared/types.ts`): `{ ok: true, uptimeSec, reports, simulated }`.
- **Healthy looks like**: HTTP 200 with `ok: true`; `uptimeSec` steadily climbing (resets indicate crash loops — check `fly logs`); `reports` nonzero and moving (with `SIM=on` it's large immediately; with `SIM=off` it tracks real traffic); `simulated` matching what you set.
- Fly runs the `fly.toml` check against `/api/health` every 30 s: `fly checks list`.
- Add an external monitor (UptimeRobot free tier is plenty) on `https://<your-app>.fly.dev/api/health`.
- `fly logs` for the live tail; the server logs pruning activity and shutdown signals, and never logs IPs or client identifiers.

## Scale path (when one instance isn't enough)

Do these in order, and only then raise the machine count — pointers, not a design doc:

1. **Postgres** implementing the existing `ReportStore` interface (`shared/types.ts`) — the swap point was designed in from day one; `server/store.ts` is the reference implementation.
2. **Redis pub/sub** to fan out report-insert events to every instance's SSE hub (`server/sse.ts`) so all clients see all pulses regardless of which instance they're pinned to.
3. **Drop the per-process aggregate response cache** (or move it to Redis) so instances don't serve divergent snapshots.

After that, `fly scale count N` behind Fly's proxy just works. Before that, N > 1 gives users N different planets.

## Cost estimate

| Item | Cost |
|---|---|
| Fly shared-cpu-1x machine (always-on) + 1 GB volume | ≈ **$3–7/mo** |
| Domain | ≈ $10/yr |
| Carto basemap (free tier) | $0 |
| GeoLite2 data (bundled; free MaxMind account for refreshes) | $0 |
| Cloudflare (optional, free plan) | $0 |
| UptimeRobot (free tier) | $0 |
