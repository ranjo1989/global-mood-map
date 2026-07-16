# Architecture

```
 browser ──POST /api/report──▶ Express API ──snapToFinest()──▶ ReportStore (memory)
    ▲                              │                               │  └─ JSONL append (real reports only)
    │◀──SSE /api/stream────────────┤                               │
    │◀──GET /api/aggregates────────┴── aggregator (k-anonymity) ◀──┘
    │
 MapLibre GL renders cells as GeoJSON fill layers, colored by valence

 server/sim: seeds RETENTION_HOURS of population-weighted, circadian-
 rhythm-driven reports at boot and drips live ones — so the map is alive
 without real traffic. Simulated reports are marked sim:true and are
 never persisted; they're regenerated deterministically each boot.
```

## Design decisions (and why)

- **Privacy at the write path, not the read path.** Coordinates are snapped to a ~55 km grid cell before storage. There is nothing precise to leak later, no matter what bug ships in a query. k-anonymity (k=5) is enforced in the aggregator as a second layer.
- **In-memory store + JSONL append log** instead of Postgres/Kafka for the MVP: zero native dependencies, boots anywhere Node 20+ runs, restart-safe for real reports. The `ReportStore` interface in `shared/types.ts` is the swap point for Postgres later. At MVP scale (hundreds of thousands of reports in the 48 h retention window) a full scan aggregation runs in milliseconds; a 2 s response cache covers burst traffic.
- **SSE over WebSockets**: one-directional fan-out is all we need; SSE survives proxies, needs no extra dependency, and reconnects natively via `EventSource`.
- **Simulator as a first-class module**: cold start kills community-data apps. The demo world (~250 cities, population-weighted rates, per-timezone circadian mood curves, weekend effects, seeded RNG) makes every feature demonstrable and testable deterministically.
- **Personal history stays in localStorage.** The strongest privacy guarantee is data that never leaves the device. Accounts/sync are a Phase 2 concern.

## Layout

```
shared/    moods.ts (mood model, colors) · grid.ts (cell math) · types.ts (contracts)
server/    index.ts (boot) · app.ts (Express app, exported for tests) · store.ts
           aggregator.ts · sse.ts · rateLimit.ts · sim/ (cities.ts, rng.ts, index.ts)
src/       React app: map, mood picker, trends, insights, time scrubber
tests/     vitest unit + supertest API tests
```

## Scale path (post-MVP)

memory+JSONL → Postgres (same `ReportStore` interface) → pre-aggregated
per-cell/per-bucket rollups → regional shards. Differential privacy noise
on published aggregates before any public API launch.
