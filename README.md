# 🌍 Global Mood Map — Real-Time Emotional Weather for the Planet

> See how the world feels, right now.

A live world map that visualizes the collective emotional state of people around the planet — like a weather map, but for moods. People anonymously report how they feel in a 3-second interaction; the map aggregates and anonymizes those reports into regional "emotional weather" in real time.

## 🚀 Quickstart

```bash
npm install
npm run dev        # dev: Vite on :5173 + API on :8787
# or production-style:
npm run build && npm start   # everything on http://localhost:8787
```

The app boots with a built-in **world simulator** (~250 major cities, population-weighted report rates, circadian mood rhythms), so the map is fully alive without real traffic. Your own reports blend into the same pipeline.

```bash
npm test           # unit + API integration tests
npm run typecheck  # strict TS across server, shared, and frontend
```

## ✨ What's implemented (MVP)

- **Live mood map** — world map with color-coded emotional weather per region; colorblind-safe gloomy-indigo → sunny-amber valence scale; zoom in for finer regions (10° → 0.5° cells).
- **3-second reporting** — pick an emoji, optionally a context tag (work, family, news, …), optionally share coarse location. Done.
- **Real-time updates** — Server-Sent Events push changes to every open map within seconds, plus a live anonymized pulse ticker ("😊 near a 10° region of East Asia · just now").
- **Time scrubber** — replay the last 24 hours of planetary mood.
- **Trends & insights** — global mood index, 24 h sparklines, "top movers" (regions whose mood shifted most in the last hour).
- **Personal history that never leaves your device** — your own mood log lives in localStorage only. No account, no server-side identity, nothing to breach.

## 🔒 Privacy model (the important part)

Privacy is enforced at the **write path**, not promised at the read path:

1. **Coordinates are destroyed on arrival.** Reports are snapped to a ~55 km grid cell center *before* storage. Precise location never touches disk, memory beyond the request, or logs.
2. **k-anonymity on every regional read.** No regional aggregate is rendered or returned with fewer than **k = 5** reports — on the map, in movers, and in per-region trends (hours with fewer than k reports are suppressed from a region's timeline). One deliberate, documented exception: the live pulse ticker shows single reports, but only after their location has been coarsened to a 10° (~1,000 km) continent-scale cell.
3. **No identity.** No accounts, no cookies, no stored IPs. Your IP is used only in-memory — to derive a coarse location when you don't share one, and for rate limiting — and is never stored, logged, or linked to a report. A report is `{time, mood, cell, tag?}` — nothing else exists to leak.
4. **Fixed tag allowlist.** No free-text is accepted anywhere, so nothing personally identifying can be smuggled into the dataset.
5. **Roadmap:** differential-privacy noise on published aggregates before any public/research API launches.

All of this is explained to users in the in-app **About modal**, alongside the required GeoLite2 (MaxMind) and basemap attributions.

## 🛠️ Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | React + TypeScript + MapLibre GL | open-source map rendering, no API keys |
| API | Express + zod + SSE | boring, battle-tested, one process |
| Store | In-memory + JSONL append log | zero native deps; `ReportStore` interface is the Postgres swap point |
| Simulator | Seeded, deterministic world model | solves cold start; makes demos and tests reproducible |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the reasoning and the scale path (Postgres → rollups → shards), and [docs/API.md](docs/API.md) for the full API contract.

## 🌐 Deploy

One Docker image, one process, one small always-on VM. Fly.io quickstart:

```bash
fly launch --no-deploy                  # uses the checked-in Dockerfile + fly.toml
fly volumes create gmm_data --size 1
fly deploy
```

Full guide — hosting choices, Cloudflare, GeoLite2 ops, backups, monitoring, costs — in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md); go-live checklist in [docs/LAUNCH.md](docs/LAUNCH.md).

### Configuration

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP listen port |
| `DATA_DIR` | `./data` | Directory for the `reports.jsonl` append log (real reports only) |
| `SIM` | `on` | `on` / `off` — seed 48 h of history and run the live world simulator |
| `TRUST_PROXY` | unset (off) | Express `trust proxy` value: unset/`''` = off, `'1'` = trust first hop, `'true'` = trust all. Set it behind Fly/Render/Cloudflare so `req.ip` is the client, not the load balancer |
| `GEO_FALLBACK` | unset | Optional `lat,lng` used when IP geolocation fails (dev/demo convenience) |
| `SUPPORT_URL` | unset | Optional donations page URL (Ko-fi / GitHub Sponsors), surfaced via `/api/meta` |

## 📣 Growth toolkit

Privacy-first growth, built in — see [docs/STRATEGY.md](docs/STRATEGY.md) for the full playbook and monetization ladder:

- **Snapshot cards & OG unfurls** — every share of the site (including `/?at=<epochMs>` deep links into the last 24 h) unfurls with a live-rendered `/api/og.png` of the actual world mood grid at that moment.
- **Daily forecast bot** — `npx tsx scripts/forecast.ts` composes a deadpan planetary weather report from the live API and posts it to Bluesky (dry run without credentials).
- **PWA** — installable app (manifest + programmatically generated icons + a minimal cache-first service worker that never touches `/api`).

## 🗺️ Roadmap

**Phase 1 — MVP (this repo)**: web reporting, live map, simulator, trends, time scrubber, k-anonymity.

**Phase 2 — Growth**: optional accounts with end-to-end-encrypted mood history sync, mobile apps, city-level density where k allows, public read-only API with differential privacy, event annotations (elections, matches, holidays).

**Phase 3 — Advanced**: anomaly detection ("mood spike in region X"), mood stories & shareable snapshots, wearable/messaging integrations, research partnerships.

## 💰 Sustainability (user-aligned)

Freemium personal analytics · anonymized aggregate API for research/media with ethical-use terms · grants & donations. **Never:** selling individual-level data (none exists to sell), engagement-bait dark patterns, or emotion-targeted advertising.

## 🧩 Contributing

- **Developers** — aggregation engine, map rendering, new visualizations. Start with `npm test`; the `ReportStore` interface and `docs/API.md` are the contracts.
- **Designers** — mood palettes (must stay colorblind-safe), reporting flow, data storytelling.
- **Researchers** — anonymization review, differential-privacy design, affect-model critique (we use the circumplex model: valence × energy).
- **Community** — localization: emotion words don't translate 1:1; we need cultural review, not just translation.

## 📜 License

MIT — see [LICENSE](LICENSE).

*"Sometimes, just knowing you're not alone in how you feel changes everything."*
