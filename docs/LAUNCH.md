# Launch Plan

Go-live plan for Global Mood Map. Deployment mechanics live in [DEPLOYMENT.md](DEPLOYMENT.md); this is the checklist and sequencing.

## Pre-launch checklist

- [ ] **Privacy policy page.** Short and true beats long and defensive. The app stores no personal data, so the policy is mostly a list of things that don't happen. Template bullets:
  - No accounts, no cookies, no tracking identifiers, no analytics SDKs.
  - A mood report is `{time, mood, ~55 km grid cell, optional tag}` — nothing else. Coordinates are coarsened server-side before storage; precise location is never written anywhere.
  - Your IP address is processed transiently, in memory only, for two purposes: deriving a coarse (≥55 km) location when you don't share one, and rate limiting. It is never stored, logged, or linked to a report. Legal basis under GDPR: legitimate interest; no consent banner is needed because nothing is persisted or tracked.
  - No regional data is shown until at least 5 people in a region have reported (k-anonymity, k=5).
  - Your personal mood history lives only in your browser's localStorage; clearing site data deletes it. We can't see it.
  - Third parties: basemap tiles are loaded from Carto (their privacy policy applies to tile requests); if Carto is unreachable the map falls back to tiles from demotiles.maplibre.org. IP geolocation uses a local GeoLite2 database on our server — your IP is never sent to MaxMind or anyone else.
  - Contact address and effective date.
- [ ] **Decide: simulator on or off at launch.** Recommended: **ON**. Tradeoff:
  - ON — the map is alive from the first visitor, which is the whole pitch; the UI's SIMULATED DATA badge (driven by `simulated` in `/api/meta`) keeps it honest. Risk: some visitors discount the demo data.
  - OFF — everything shown is real, but a new community-data app faces a brutally empty planet; k=5 means early reports are invisible. Cold start kills these apps.
  - Plan: launch with `SIM=on`, then flip to `SIM=off` (edit `[env]` in `fly.toml`, `fly deploy`) once real report volume sustains the map on its own.
- [ ] **Custom domain + certs** (`fly certs add`, see DEPLOYMENT.md).
- [ ] **OG/social meta preview** in `index.html`: `og:title`, `og:description`, `og:image` (a real screenshot of the live map — this is what sells the click), plus Twitter card tags. Verify with an OG preview checker before posting anywhere.
- [ ] **Verify link unfurl** of the deployed URL (and a `/?at=<epochMs>` deep link) in the Slack, Discord, and X card validators — the card image should be the live `/api/og.png` mood grid, not a broken placeholder.
- [ ] **Create a Bluesky account for the bot** (e.g. `moodmap.bsky.social`), generate an app password (Settings → App Passwords), and set the `BSKY_HANDLE` / `BSKY_APP_PASSWORD` secrets for the daily forecast cron ([STRATEGY.md](STRATEGY.md) → Automation cadence). Dry-run first: `npx tsx scripts/forecast.ts` with no creds prints the post without publishing.
- [ ] **Create a Ko-fi or GitHub Sponsors page** and set `SUPPORT_URL` so the app can surface the donations link (`/api/meta` → `supportUrl`).
- [ ] **Full test suite green**: `npm test` and `npm run typecheck` on the exact commit you deploy.
- [ ] **Load sanity.** SSE connections are capped at 500 concurrent clients per process by design. A few hundred simultaneous viewers is comfortably inside that; beyond the cap, new visitors still get the full map (regular fetches) but no live push until slots free up. If a launch spike sustains >500 concurrent, that's a great problem — see the scale path in DEPLOYMENT.md.
- [ ] **Attributions visible**: MaxMind GeoLite2 line in the About modal, Carto/OpenStreetMap credit in the map's attribution control.
- [ ] **Monitoring armed**: external uptime check on `/api/health` (DEPLOYMENT.md → Monitoring).

## Soft launch

Friends, group chats, one or two small communities you're already part of. Goals, in order:

1. **Stability**: watch `/api/health` and `fly logs` for a few days. `uptimeSec` should climb without resets.
2. **Real data flows**: confirm real (non-simulated) reports appear and persist across a deploy (they're the only thing in `reports.jsonl`).
3. **Tune k-anonymity messaging.** The #1 confusion to expect: someone reports from a sparse region and their cell doesn't light up (k=5). That's the privacy model working, but it looks broken. Make sure the post-report UI copy says something like "your report is counted — this region appears once 5+ people report" and that the About modal explains why. Iterate on this copy before going wide.

## Public launch

The story is **"privacy-first emotional weather"** — a live map of how the planet feels that structurally cannot leak anything about you. Lead with the privacy engineering; it's the differentiator, not a disclaimer.

Channels and angles:

- **Show HN** — "Show HN: A live map of the world's mood (k-anonymous, no accounts, no tracking)". HN will care about the write-path privacy design, the SSE architecture, and the honest SIMULATED DATA badge. Be in the comments for the first few hours.
- **Product Hunt** — lead with the 3-second reporting flow and the living map; the privacy model is the twist.
- **r/InternetIsBeautiful** — the map sells itself; post when it looks alive.
- **r/dataisbeautiful** — angle: the circadian mood rhythm visible in the time scrubber (mornings vs. Friday nights across timezones).

Press blurb template (2 sentences):

> Global Mood Map is a live "emotional weather" map of the planet: anyone can anonymously report how they feel in three seconds and watch it blend into their region's mood. There are no accounts and no tracking — locations are blurred to ~55 km cells before anything is stored, and no region is shown until at least five people have reported.

## Post-launch routine

- **Weekly**: refresh the GeoLite2 snapshot (`npm update geoip-lite` or the `updatedb` script — DEPLOYMENT.md → IP geolocation operations) and redeploy.
- **Weekly-ish**: dependency updates (`npm outdated`, `npm audit`); it's a small dep tree on purpose.
- **Moderation**: essentially none needed, by design — there is no free text anywhere (fixed mood and tag allowlists in `shared/moods.ts`), so there is nothing to moderate. The only lever that exists is the per-IP rate limit.
- **Watch**: `/api/health`, the external uptime monitor, and whether real volume is approaching the point where `SIM=off` makes sense.
- **Roadmap pointers** (when the above is boring): optional accounts with end-to-end-encrypted mood history sync, event overlays (elections, matches, holidays), and a public read-only API with differential-privacy noise — in that order, per the README roadmap.
