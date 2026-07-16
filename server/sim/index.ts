/**
 * World simulator: a deterministic, plausible "emotional weather" world
 * so the map looks alive with zero real users.
 *
 * Every random draw flows through one seeded mulberry32 stream in a fixed
 * iteration order, so seedHistory with the same (now, seed) produces
 * byte-identical output. No Math.random anywhere in this subtree.
 */

import { MOOD_IDS, type MoodId, type TagId } from '../../shared/moods';
import { snapToFinest } from '../../shared/grid';
import {
  RETENTION_HOURS,
  type City,
  type ReportStore,
  type SimOptions,
  type StoredReport,
} from '../../shared/types';
import { makeRng, pickWeighted, poisson, triangular, type Rng } from './rng';
import { CITIES } from './cities';

export { CITIES } from './cities';

const HOUR_MS = 3_600_000;
const STEP_MS = 5 * 60_000; // seeding advances in 5-minute steps
const TARGET_PER_HOUR = 4_000; // global average; diurnal swing keeps it ~3000-5000
const TARGET_PER_STEP = TARGET_PER_HOUR * (STEP_MS / HOUR_MS);
const LIVE_TICK_MS = 800;
const TAG_PROBABILITY = 0.25;
const JITTER_HALF_DEG = 0.4; // spreads reports over several finest-res cells per metro
const CITY_BIAS_MAX = 0.2; // persistent sunnier/gloomier tilt per city
const TAU = Math.PI * 2;
// Incommensurate periods so global mood drift never visibly repeats.
const DRIFT_PERIOD_1_MS = 6 * HOUR_MS;
const DRIFT_PERIOD_2_MS = 26 * HOUR_MS;
const WOBBLE_PERIOD_MS = 7 * HOUR_MS; // per-city report-rate wobble

// ---------------------------------------------------------------------------
// Diurnal activity (relative report volume by local hour)
// ---------------------------------------------------------------------------

// Index = local hour. Quiet 1am-6am, morning peak 8-10, evening peak 19-22.
const HOUR_ACTIVITY = [
  0.35, 0.15, 0.08, 0.06, 0.08, 0.15, // 00-05
  0.4, 0.7, 1.0, 1.05, 0.95, 0.85, // 06-11
  0.9, 0.85, 0.8, 0.8, 0.85, 0.95, // 12-17
  1.0, 1.15, 1.25, 1.3, 1.15, 0.85, // 18-23
];
const ACTIVITY_MEAN = HOUR_ACTIVITY.reduce((a, b) => a + b, 0) / 24;

/** Longitude-only local time approximation — fine for a simulation. */
function localHourAt(t: number, lng: number): number {
  return (((t / HOUR_MS + lng / 15) % 24) + 24) % 24;
}

function activityAt(localHour: number): number {
  const i = Math.floor(localHour);
  const f = localHour - i;
  return HOUR_ACTIVITY[i % 24] * (1 - f) + HOUR_ACTIVITY[(i + 1) % 24] * f;
}

// ---------------------------------------------------------------------------
// Mood model
// ---------------------------------------------------------------------------

type MoodWeights = Record<MoodId, number>;

// Base distributions per local-time band; each sums to 100.
const NIGHT: MoodWeights = { excited: 5, happy: 5, calm: 15, tired: 45, sad: 10, anxious: 10, stressed: 5, angry: 5 };
const MORNING: MoodWeights = { excited: 6, happy: 15, calm: 12, tired: 18, sad: 6, anxious: 15, stressed: 22, angry: 6 };
const MIDDAY: MoodWeights = { excited: 7, happy: 25, calm: 20, tired: 12, sad: 7, anxious: 7, stressed: 15, angry: 7 };
const EVENING: MoodWeights = { excited: 15, happy: 28, calm: 18, tired: 14, sad: 6.25, anxious: 6.25, stressed: 6.25, angry: 6.25 };

const POSITIVE_MOODS: readonly MoodId[] = ['excited', 'happy', 'calm'];
const NEGATIVE_MOODS: readonly MoodId[] = ['sad', 'anxious', 'stressed', 'angry'];

/** Days since epoch; Jan 1 1970 was a Thursday (day 4). UTC weekday is fine here. */
function isWeekend(t: number): boolean {
  const day = (Math.floor(t / 86_400_000) + 4) % 7;
  return day === 0 || day === 6;
}

/** Shift up to ~9 points from stressed/anxious toward happy/excited/calm. */
function applyWeekendShift(w: MoodWeights): void {
  const fromStressed = Math.min(5, Math.max(0, w.stressed - 2));
  const fromAnxious = Math.min(4, Math.max(0, w.anxious - 2));
  w.stressed -= fromStressed;
  w.anxious -= fromAnxious;
  const moved = fromStressed + fromAnxious;
  w.happy += moved * 0.4;
  w.excited += moved * 0.3;
  w.calm += moved * 0.3;
}

/**
 * Mood weights (aligned with MOOD_IDS) for a place and moment.
 * tilt > 0 favors pleasant moods, < 0 unpleasant ones.
 */
function moodWeightsAt(t: number, lng: number, bias: number, drift: number): number[] {
  const lh = localHourAt(t, lng);
  const base = lh < 6 ? NIGHT : lh < 11 ? MORNING : lh < 17 ? MIDDAY : EVENING;
  const w: MoodWeights = { ...base };
  if (isWeekend(t)) applyWeekendShift(w);
  const tilt = Math.max(-0.45, Math.min(0.45, bias + drift));
  for (const m of POSITIVE_MOODS) w[m] *= 1 + tilt;
  for (const m of NEGATIVE_MOODS) w[m] *= 1 - tilt;
  return MOOD_IDS.map((m) => w[m]);
}

// Plausible context tags per mood; ~25% of reports carry one.
interface TagDist {
  tags: readonly TagId[];
  weights: readonly number[];
}

const TAGS_BY_MOOD: Record<MoodId, TagDist> = {
  excited: { tags: ['friends', 'travel', 'work', 'other'], weights: [3, 3, 1, 2] },
  happy: { tags: ['friends', 'family', 'weather', 'travel', 'other'], weights: [3, 3, 2, 1, 1] },
  calm: { tags: ['weather', 'family', 'health', 'other'], weights: [3, 2, 1, 2] },
  tired: { tags: ['work', 'school', 'health', 'family', 'other'], weights: [4, 2, 2, 1, 1] },
  sad: { tags: ['family', 'news', 'health', 'money', 'other'], weights: [2, 2, 2, 1, 2] },
  anxious: { tags: ['work', 'money', 'news', 'health', 'school'], weights: [3, 2, 2, 2, 1] },
  stressed: { tags: ['work', 'money', 'school', 'family', 'news'], weights: [4, 2, 2, 1, 1] },
  angry: { tags: ['news', 'work', 'money', 'family', 'other'], weights: [3, 2, 1, 1, 1] },
};

// ---------------------------------------------------------------------------
// World state (precomputed per seed)
// ---------------------------------------------------------------------------

interface CityState {
  city: City;
  weight: number; // sqrt(pop) — dampens megacity dominance
  bias: number; // persistent valence tilt, [-CITY_BIAS_MAX, +CITY_BIAS_MAX]
  phase: number; // phase of this city's slow rate wobble
}

interface World {
  cities: CityState[];
  totalWeight: number;
  driftPhases: [number, number];
}

/**
 * Derived from the seed alone (never from the RNG stream used for
 * sampling), so seedHistory and startLive agree on each city's character.
 */
function buildWorld(seed: number): World {
  const r = makeRng((seed ^ 0x9e3779b9) >>> 0);
  const driftPhases: [number, number] = [r() * TAU, r() * TAU];
  const cities: CityState[] = CITIES.map((city) => ({
    city,
    weight: Math.sqrt(city.pop),
    bias: (r() * 2 - 1) * CITY_BIAS_MAX,
    phase: r() * TAU,
  }));
  const totalWeight = cities.reduce((sum, c) => sum + c.weight, 0);
  return { cities, totalWeight, driftPhases };
}

/** Slow, smooth global mood drift so the whole map breathes over hours. */
function globalDrift(t: number, world: World): number {
  const [p1, p2] = world.driftPhases;
  return 0.06 * Math.sin((t / DRIFT_PERIOD_1_MS) * TAU + p1) + 0.05 * Math.sin((t / DRIFT_PERIOD_2_MS) * TAU + p2);
}

/** Expected reports from one city in one 5-minute step. */
function expectedPerStep(c: CityState, t: number, world: World): number {
  const act = activityAt(localHourAt(t, c.city.lng));
  const wobble = 1 + 0.15 * Math.sin((t / WOBBLE_PERIOD_MS) * TAU + c.phase);
  return TARGET_PER_STEP * (c.weight / world.totalWeight) * (act / ACTIVITY_MEAN) * wobble;
}

function buildReport(rng: Rng, c: CityState, t: number, moodWeights: number[]): StoredReport {
  const mood = pickWeighted(rng, MOOD_IDS, moodWeights);
  // Jitter spreads a metro over nearby finest-res cells; snapToFinest is
  // mandatory — the store expects pre-snapped coordinates.
  const snapped = snapToFinest(
    c.city.lat + triangular(rng, JITTER_HALF_DEG),
    c.city.lng + triangular(rng, JITTER_HALF_DEG),
  );
  const report: StoredReport = { t, mood, lat: snapped.lat, lng: snapped.lng, sim: true };
  if (rng() < TAG_PROBABILITY) {
    const dist = TAGS_BY_MOOD[mood];
    report.tag = pickWeighted(rng, dist.tags, dist.weights);
  }
  return report;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Backfill opts.hours (default RETENTION_HOURS) of history ending at
 * opts.now. Deterministic for a given (now, hours, seed). Returns the
 * number of reports inserted.
 */
export function seedHistory(store: ReportStore, opts: SimOptions): number {
  const hours = opts.hours ?? RETENTION_HOURS;
  const seed = opts.seed ?? 42;
  const world = buildWorld(seed);
  const rng = makeRng(seed);
  const start = opts.now - hours * HOUR_MS;
  let inserted = 0;
  for (let stepT = start; stepT < opts.now; stepT += STEP_MS) {
    const stepEnd = Math.min(stepT + STEP_MS, opts.now);
    const drift = globalDrift(stepT, world);
    for (const c of world.cities) {
      const n = poisson(rng, expectedPerStep(c, stepT, world));
      if (n === 0) continue;
      const weights = moodWeightsAt(stepT, c.city.lng, c.bias, drift);
      for (let k = 0; k < n; k++) {
        const t = stepT + Math.floor(rng() * (stepEnd - stepT));
        store.insert(buildReport(rng, c, t, weights));
        inserted++;
      }
    }
  }
  return inserted;
}

/**
 * Keep the world ticking: each ~800ms tick draws from the SAME rate model
 * as seedHistory (scaled to tick length), so live volume continues the
 * seeded diurnal curve with no cliff at boot. Returns a stop function.
 */
export function startLive(store: ReportStore, opts?: { seed?: number }): () => void {
  const seed = opts?.seed ?? 42;
  // Different stream than seeding so live traffic doesn't replay history.
  const rng = makeRng((seed ^ 0x51ab_c0de) >>> 0);
  const world = buildWorld(seed);
  const tickScale = LIVE_TICK_MS / STEP_MS;
  const timer = setInterval(() => {
    const t = Date.now();
    const drift = globalDrift(t, world);
    // Same per-city expectation the seeder uses, scaled to one tick.
    const rates = world.cities.map((c) => expectedPerStep(c, t, world) * tickScale);
    const expected = rates.reduce((a, b) => a + b, 0);
    const n = poisson(rng, expected);
    for (let i = 0; i < n; i++) {
      const c = pickWeighted(rng, world.cities, rates);
      store.insert(buildReport(rng, c, t, moodWeightsAt(t, c.city.lng, c.bias, drift)));
    }
  }, LIVE_TICK_MS);
  return () => clearInterval(timer);
}
