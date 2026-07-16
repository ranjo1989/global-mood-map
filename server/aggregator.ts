import { MOODS } from '../shared/moods';
import type { MoodId } from '../shared/moods';
import { cellIdFor, parseCellId } from '../shared/grid';
import type { CellId } from '../shared/grid';
import { DEFAULT_WINDOW_MINS, K_ANONYMITY } from '../shared/types';
import type {
  AggregateCell,
  AggregatesResponse,
  InsightsResponse,
  Mover,
  ReportStore,
  StoredReport,
  TrendPoint,
  TrendsResponse,
} from '../shared/types';
import { CITIES } from './sim/cities';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

// ---------------------------------------------------------------------------
// Shared accumulation helpers
// ---------------------------------------------------------------------------

interface Acc {
  count: number;
  valenceSum: number;
  energySum: number;
  moods: Partial<Record<MoodId, number>>;
}

function newAcc(): Acc {
  return { count: 0, valenceSum: 0, energySum: 0, moods: {} };
}

function accumulate(acc: Acc, r: StoredReport): void {
  const def = MOODS[r.mood];
  acc.count += 1;
  acc.valenceSum += def.valence;
  acc.energySum += def.energy;
  acc.moods[r.mood] = (acc.moods[r.mood] ?? 0) + 1;
}

function topMoodOf(moods: Partial<Record<MoodId, number>>): MoodId {
  let best: MoodId = 'calm';
  let bestCount = -1;
  for (const [mood, count] of Object.entries(moods) as Array<[MoodId, number]>) {
    if (count > bestCount) {
      best = mood;
      bestCount = count;
    }
  }
  return best;
}

function groupByCell(reports: StoredReport[], res: number): Map<CellId, Acc> {
  const byCell = new Map<CellId, Acc>();
  for (const r of reports) {
    const id = cellIdFor(r.lat, r.lng, res);
    let acc = byCell.get(id);
    if (!acc) {
      acc = newAcc();
      byCell.set(id, acc);
    }
    accumulate(acc, r);
  }
  return byCell;
}

// ---------------------------------------------------------------------------
// Aggregates (map view)
// ---------------------------------------------------------------------------

interface CacheEntry {
  computedAt: number; // real wall-clock ms when computed
  response: AggregatesResponse;
}

// Cache is per-store so parallel tests with separate stores never collide.
const cacheByStore = new WeakMap<ReportStore, Map<string, CacheEntry>>();

const CACHE_TTL_MS = 2_000;
const NOWISH_MS = 5_000;

export interface AggregatesOpts {
  res: number;
  windowMins?: number;
  /** Window end, epoch ms. Default: now. */
  at?: number;
}

export function aggregates(store: ReportStore, opts: AggregatesOpts): AggregatesResponse {
  const windowMins = opts.windowMins ?? DEFAULT_WINDOW_MINS;
  const wallNow = Date.now();
  const at = opts.at ?? wallNow;

  // Memoize only when the window ends "now-ish" — a scrubber query for a
  // historical `at` must never be served a cached now-window (or vice versa).
  const nowish = Math.abs(at - wallNow) <= NOWISH_MS;
  const key = `${opts.res}:${windowMins}`;
  let cache = cacheByStore.get(store);
  if (nowish) {
    const hit = cache?.get(key);
    if (hit && wallNow - hit.computedAt < CACHE_TTL_MS) return hit.response;
  }

  const reports = store.query(at - windowMins * MINUTE_MS, at);
  const byCell = groupByCell(reports, opts.res);

  const cells: AggregateCell[] = [];
  for (const [cellId, acc] of byCell) {
    if (acc.count < K_ANONYMITY) continue; // k-anonymity boundary
    cells.push({
      cellId,
      count: acc.count,
      valence: acc.valenceSum / acc.count,
      energy: acc.energySum / acc.count,
      topMood: topMoodOf(acc.moods),
      moods: acc.moods,
    });
  }

  const response: AggregatesResponse = {
    res: opts.res,
    windowMins,
    at,
    k: K_ANONYMITY,
    cells,
    totalReports: reports.length,
  };

  if (nowish) {
    if (!cache) {
      cache = new Map();
      cacheByStore.set(store, cache);
    }
    cache.set(key, { computedAt: wallNow, response });
  }
  return response;
}

// ---------------------------------------------------------------------------
// Trends
// ---------------------------------------------------------------------------

function bucketize(reports: StoredReport[], hours: number, now: number): TrendPoint[] {
  const fromT = now - hours * HOUR_MS;
  const accs: Acc[] = Array.from({ length: hours }, newAcc);
  for (const r of reports) {
    const idx = Math.floor((r.t - fromT) / HOUR_MS);
    if (idx < 0 || idx >= hours) continue;
    accumulate(accs[idx], r);
  }
  return accs.map((acc, i) => ({
    t: fromT + i * HOUR_MS,
    count: acc.count,
    valence: acc.count > 0 ? acc.valenceSum / acc.count : 0,
    moods: acc.moods,
  }));
}

export function trendsGlobal(store: ReportStore, opts: { hours: number; now: number }): TrendsResponse {
  const reports = store.query(opts.now - opts.hours * HOUR_MS, opts.now);
  return { bucketMins: 60, points: bucketize(reports, opts.hours, opts.now) };
}

/**
 * Returns null (route → 404) when the cell's total over the range is below
 * K_ANONYMITY, so sparse regions cannot be dissected hour by hour. On top
 * of that, individual buckets with 0 < count < K_ANONYMITY are suppressed
 * (returned as empty) — otherwise a cell with exactly k reports spread over
 * k hours would expose each report's mood and hour one by one.
 * Throws on an invalid cellId (route → 400).
 */
export function trendsCell(
  store: ReportStore,
  opts: { cellId: CellId; hours: number; now: number }
): TrendsResponse | null {
  const info = parseCellId(opts.cellId); // throws on invalid format/res
  const inRange = store.query(opts.now - opts.hours * HOUR_MS, opts.now);
  const inCell = inRange.filter((r) => cellIdFor(r.lat, r.lng, info.res) === opts.cellId);
  if (inCell.length < K_ANONYMITY) return null;
  const points = bucketize(inCell, opts.hours, opts.now).map((p) =>
    p.count > 0 && p.count < K_ANONYMITY ? { t: p.t, count: 0, valence: 0, moods: {} } : p,
  );
  return { bucketMins: 60, points };
}

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------

const MOVERS_RES = 1;
const MOVERS_MAX = 5;

/** Wrap-aware squared angular distance, longitude scaled by cos(lat). */
function distSq(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = lat1 - lat2;
  let dLng = Math.abs(lng1 - lng2) % 360;
  if (dLng > 180) dLng = 360 - dLng;
  const scale = Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  const x = dLng * scale;
  return dLat * dLat + x * x;
}

/**
 * Human hint for a cell: nearest major city from the sim's city list,
 * formatted "near {name}, {country}". Reused by GET /api/geo (server/app.ts).
 */
export function nearestCityLabel(cellId: CellId): string {
  const { centerLat, centerLng } = parseCellId(cellId);
  let bestLabel = cellId; // fallback if city list is empty
  let bestD = Infinity;
  for (const city of CITIES) {
    const d = distSq(centerLat, centerLng, city.lat, city.lng);
    if (d < bestD) {
      bestD = d;
      bestLabel = `near ${city.name}, ${city.country}`;
    }
  }
  return bestLabel;
}

export function insights(store: ReportStore, opts: { now: number }): InsightsResponse {
  const { now } = opts;
  const windowMs = DEFAULT_WINDOW_MINS * MINUTE_MS;
  const current = store.query(now - windowMs, now);
  const previous = store.query(now - 2 * windowMs, now - windowMs);

  const globalAcc = newAcc();
  for (const r of current) accumulate(globalAcc, r);
  const topMoods = (Object.entries(globalAcc.moods) as Array<[MoodId, number]>)
    .sort((a, b) => b[1] - a[1])
    .map(([mood, count]) => ({ mood, count }));

  const currCells = groupByCell(current, MOVERS_RES);
  const prevCells = groupByCell(previous, MOVERS_RES);

  const movers: Mover[] = [];
  for (const [cellId, curr] of currCells) {
    if (curr.count < K_ANONYMITY) continue;
    const prev = prevCells.get(cellId);
    if (!prev || prev.count < K_ANONYMITY) continue;
    const valence = curr.valenceSum / curr.count;
    movers.push({
      cellId,
      label: nearestCityLabel(cellId),
      deltaValence: valence - prev.valenceSum / prev.count,
      valence,
      count: curr.count,
    });
  }
  movers.sort((a, b) => Math.abs(b.deltaValence) - Math.abs(a.deltaValence));

  return {
    at: now,
    global: {
      count: globalAcc.count,
      valence: globalAcc.count > 0 ? globalAcc.valenceSum / globalAcc.count : 0,
      energy: globalAcc.count > 0 ? globalAcc.energySum / globalAcc.count : 0,
      topMoods,
    },
    movers: movers.slice(0, MOVERS_MAX),
  };
}
