# Growth & Sustainability Strategy

Decision record for how Global Mood Map grows and pays for itself. Opinionated on purpose — this doc exists so future choices get tested against it, not relitigated from scratch.

## The decision: indie-sustainable

Global Mood Map runs as an **indie-sustainable** project: one operator, ~$5/mo infrastructure ([DEPLOYMENT.md](DEPLOYMENT.md) → cost estimate), growth funded by patience instead of capital.

Rationale:

1. **Costs are trivially coverable.** One Fly machine plus a volume is $3–7/mo. A donations link clears that bar on day one; there is no burn rate forcing growth-at-any-cost decisions.
2. **Trust is the asset.** The entire pitch is "a mood map that structurally cannot leak anything about you." Every monetization path that erodes that (ads, tracking, engagement mechanics) destroys the only durable differentiator. Indie-sustainable means never being forced into that trade.
3. **It keeps the data-licensing option open.** Aggregated, differential-privacy-noised planetary mood data has real value to researchers and media — but only if the collection pipeline stays credibly clean. Taking VC-shaped shortcuts now forecloses the highest-integrity revenue line later.

## Growth playbook

In rough order of effort-to-payoff:

1. **Moments-based launches.** The map is most shareable when the planet is feeling something together. **New Year's Eve is the marquee moment** — midnight sweeping across timezones as a visible wave of 🤩 is the single best demo the product will ever give for free. Plan launches and posts around moments (NYE, elections, World Cup finals, solstices), not around arbitrary marketing dates.
2. **Snapshot cards + OG unfurls** *(built)*. Every deep link (`/?at=<epochMs>`) unfurls with a live-rendered `/api/og.png` — the actual world mood grid at that moment. Sharing "look at Europe right now" into Slack/Discord/X shows the map, not a logo. Zero-effort distribution on every share.
3. **Daily forecast bot** *(built — `scripts/forecast.ts`)*. A deadpan planetary weather report posted to Bluesky daily: current conditions, report volume, top movers, link. Owner's step: create a Bluesky account for the bot and generate an app password (Settings → App Passwords); then it's two secrets and a cron (snippet below).
4. **PWA habit loop** *(built)*. Installable app (manifest + icons + minimal service worker) turns "that site I saw once" into an icon on the home screen. Checking the planet's mood with your morning coffee is the retention loop — no notifications, no streaks, no guilt mechanics. If it doesn't become a habit on its own merits, we don't manufacture one.
5. **Timelapse content** *(later)*. Rendered 24 h/7 d mood timelapses (the scrubber data is already there) as short videos — the circadian wave and weekend effect are hypnotic and inherently shareable.
6. **Programmatic city pages** *(later — needs SSR)*. `/city/tokyo` pages with local mood trends would earn long-tail search traffic, but they need server-side rendering to be indexable. Not worth distorting the architecture for until organic demand shows up.

## Monetization ladder

Each rung has an explicit trigger. Don't climb early.

| Rung | What | Trigger |
|---|---|---|
| 1 | **Donations** via `SUPPORT_URL` (Ko-fi or GitHub Sponsors). Owner creates the page, sets the env var, done — the app surfaces the link via `/api/meta`. | **Now.** |
| 2 | **Snapshot posters** — print-on-demand prints of memorable planetary moments (NYE 2027, your city's best day). The OG renderer is 80% of the pipeline. | First organic traction (people sharing snapshots unprompted). |
| 3 | **Premium personal analytics** — paid tier on your *own* localStorage mood history (patterns, correlations, exports). Your data, your device, your call. | ~10k MAU. |
| 4 | **Context-blind sponsorship** — a single "supported by X" line, sold on traffic volume only, never on mood targeting of any kind. | Sustained meaningful traffic. |
| 5 | **Aggregated data licensing** — k-anonymous, DP-noised regional aggregates for research/media under ethical-use terms. | Real report volume (data is worthless before then anyway). |

### Hard lines

These are policy, not preferences. They hold at every rung and every scale:

**No emotion-targeted advertising, no individual-level data sales (none exists), no workplace mood surveillance, no engagement-bait mechanics.**

Any partnership, feature, or revenue idea that requires crossing one of these is declined without negotiation. If the project can't survive without crossing them, it shuts down with its dataset intact rather than pivoting into the thing it was built against.

## Automation cadence

The forecast bot runs once daily at 14:00 UTC (planet is broadly awake; movers from the last 24 h are meaningful). Recommended: GitHub Actions cron with repo secrets `BSKY_HANDLE`, `BSKY_APP_PASSWORD`, and `API_URL` — documented here as a snippet; add it as `.github/workflows/forecast.yml` when the Bluesky account exists:

```yaml
name: daily-forecast
on:
  schedule:
    - cron: '0 14 * * *'   # 14:00 UTC daily
  workflow_dispatch: {}     # manual runs for testing
jobs:
  post:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npx tsx scripts/forecast.ts
        env:
          API_URL: ${{ secrets.API_URL }}
          SITE_URL: ${{ secrets.API_URL }}
          BSKY_HANDLE: ${{ secrets.BSKY_HANDLE }}
          BSKY_APP_PASSWORD: ${{ secrets.BSKY_APP_PASSWORD }}
```

Without creds the script is a safe dry run (prints the post, exits 0), so it can be tested locally against any running instance: `npx tsx scripts/forecast.ts`.
