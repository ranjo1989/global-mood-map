import { describe, expect, it } from 'vitest';
import { aggregates, insights, trendsCell, trendsGlobal } from '../server/aggregator';
import { MemoryStore } from '../server/store';
import { MOODS } from '../shared/moods';
import type { MoodId } from '../shared/moods';
import { cellIdFor, snapToFinest } from '../shared/grid';
import { K_ANONYMITY } from '../shared/types';
import type { StoredReport } from '../shared/types';

const MIN = 60_000;
const HOUR = 3_600_000;
// Fixed historical epoch, far from wall-clock "now" so the aggregates
// memo cache (which only engages when at is now-ish) stays disabled.
const NOW = 1_700_000_000_000;

const LONDON = { lat: 51.5, lng: -0.12 };
const TOKYO = { lat: 35.7, lng: 139.7 };
const SYDNEY = { lat: -33.87, lng: 151.2 };
const NAIROBI = { lat: -1.3, lng: 36.8 };
const CAPE_TOWN = { lat: -33.9, lng: 18.4 };

function mk(t: number, mood: MoodId, loc: { lat: number; lng: number }): StoredReport {
  const s = snapToFinest(loc.lat, loc.lng);
  return { t, mood, lat: s.lat, lng: s.lng, sim: true };
}

function insertMany(
  store: MemoryStore,
  n: number,
  t: number,
  mood: MoodId,
  loc: { lat: number; lng: number }
): void {
  for (let i = 0; i < n; i++) store.insert(mk(t, mood, loc));
}

function meanValence(entries: Array<[MoodId, number]>): number {
  let sum = 0;
  let count = 0;
  for (const [mood, n] of entries) {
    sum += MOODS[mood].valence * n;
    count += n;
  }
  return sum / count;
}

function meanEnergy(entries: Array<[MoodId, number]>): number {
  let sum = 0;
  let count = 0;
  for (const [mood, n] of entries) {
    sum += MOODS[mood].energy * n;
    count += n;
  }
  return sum / count;
}

describe('aggregates', () => {
  it('omits cells below K_ANONYMITY but keeps them in totalReports', () => {
    const store = new MemoryStore();
    insertMany(store, K_ANONYMITY, NOW - 10 * MIN, 'happy', LONDON);
    insertMany(store, K_ANONYMITY - 1, NOW - 10 * MIN, 'sad', TOKYO);

    const res = aggregates(store, { res: 1, windowMins: 60, at: NOW });
    expect(res.k).toBe(K_ANONYMITY);
    expect(res.cells.map((c) => c.cellId)).toEqual([cellIdFor(LONDON.lat, LONDON.lng, 1)]);
    expect(res.totalReports).toBe(2 * K_ANONYMITY - 1);
    expect(res.res).toBe(1);
    expect(res.windowMins).toBe(60);
    expect(res.at).toBe(NOW);
  });

  it('a cell with exactly K_ANONYMITY reports is returned', () => {
    const store = new MemoryStore();
    insertMany(store, K_ANONYMITY, NOW - 5 * MIN, 'calm', NAIROBI);
    const res = aggregates(store, { res: 2, windowMins: 60, at: NOW });
    expect(res.cells).toHaveLength(1);
    expect(res.cells[0].count).toBe(K_ANONYMITY);
  });

  it('valence/energy are count-weighted means of the MOODS constants', () => {
    const store = new MemoryStore();
    insertMany(store, 3, NOW - 10 * MIN, 'happy', LONDON);
    insertMany(store, 2, NOW - 20 * MIN, 'sad', LONDON);

    const res = aggregates(store, { res: 1, windowMins: 60, at: NOW });
    expect(res.cells).toHaveLength(1);
    const cell = res.cells[0];
    expect(cell.count).toBe(5);
    expect(cell.valence).toBeCloseTo(meanValence([['happy', 3], ['sad', 2]]), 12);
    expect(cell.energy).toBeCloseTo(meanEnergy([['happy', 3], ['sad', 2]]), 12);
    // (3*0.8 + 2*-0.7)/5 and (3*0.6 + 2*0.25)/5 from shared/moods.ts.
    expect(cell.valence).toBeCloseTo(0.2, 12);
    expect(cell.energy).toBeCloseTo(0.46, 12);
    expect(cell.topMood).toBe('happy');
    expect(cell.moods).toEqual({ happy: 3, sad: 2 });
  });

  it('window is [at - windowMins, at): start inclusive, end exclusive', () => {
    const store = new MemoryStore();
    const windowMins = 30;
    insertMany(store, 5, NOW - windowMins * MIN, 'happy', LONDON); // exactly at start → in
    insertMany(store, 5, NOW, 'sad', LONDON); // exactly at end → out
    insertMany(store, 5, NOW - windowMins * MIN - 1, 'angry', LONDON); // 1ms before start → out

    const res = aggregates(store, { res: 1, windowMins, at: NOW });
    expect(res.totalReports).toBe(5);
    expect(res.cells).toHaveLength(1);
    expect(res.cells[0].moods).toEqual({ happy: 5 });
  });

  it('moving `at` back reveals the earlier window', () => {
    const store = new MemoryStore();
    insertMany(store, 5, NOW - 3 * HOUR, 'calm', TOKYO);
    const atNow = aggregates(store, { res: 1, windowMins: 60, at: NOW });
    expect(atNow.totalReports).toBe(0);
    expect(atNow.cells).toHaveLength(0);
    const scrubbed = aggregates(store, { res: 1, windowMins: 60, at: NOW - 3 * HOUR + MIN });
    expect(scrubbed.totalReports).toBe(5);
    expect(scrubbed.cells[0].cellId).toBe(cellIdFor(TOKYO.lat, TOKYO.lng, 1));
  });
});

describe('trendsGlobal', () => {
  it('zero-fills empty buckets and orders points oldest-first', () => {
    const store = new MemoryStore();
    const hours = 4;
    const fromT = NOW - hours * HOUR;
    store.insert(mk(fromT, 'excited', LONDON)); // exactly at range start → bucket 0
    store.insert(mk(NOW - 2 * HOUR + 5 * MIN, 'happy', TOKYO)); // bucket 2
    store.insert(mk(NOW - 2 * HOUR + 6 * MIN, 'happy', TOKYO)); // bucket 2
    store.insert(mk(NOW - 1, 'sad', SYDNEY)); // bucket 3
    store.insert(mk(NOW, 'angry', SYDNEY)); // exactly at range end → excluded

    const res = trendsGlobal(store, { hours, now: NOW });
    expect(res.bucketMins).toBe(60);
    expect(res.points).toHaveLength(hours);
    expect(res.points.map((p) => p.t)).toEqual([fromT, fromT + HOUR, fromT + 2 * HOUR, fromT + 3 * HOUR]);
    expect(res.points.map((p) => p.count)).toEqual([1, 0, 2, 1]);

    expect(res.points[0].valence).toBeCloseTo(MOODS.excited.valence, 12);
    expect(res.points[0].moods).toEqual({ excited: 1 });
    // Zero-filled bucket: count 0, neutral valence, empty moods.
    expect(res.points[1]).toEqual({ t: fromT + HOUR, count: 0, valence: 0, moods: {} });
    expect(res.points[2].valence).toBeCloseTo(MOODS.happy.valence, 12);
    expect(res.points[3].moods).toEqual({ sad: 1 });
  });
});

describe('trendsCell', () => {
  it('returns null when the cell total over the range is below K_ANONYMITY', () => {
    const store = new MemoryStore();
    const cellId = cellIdFor(TOKYO.lat, TOKYO.lng, 1);
    // Spread K-1 reports across hours; other cells must not count toward this one.
    for (let i = 0; i < K_ANONYMITY - 1; i++) store.insert(mk(NOW - (i + 1) * HOUR, 'happy', TOKYO));
    insertMany(store, 20, NOW - 2 * HOUR, 'sad', LONDON);
    expect(trendsCell(store, { cellId, hours: 24, now: NOW })).toBeNull();
  });

  it('suppresses individual sub-k buckets so a sparse cell cannot be dissected report by report', () => {
    const store = new MemoryStore();
    const cellId = cellIdFor(TOKYO.lat, TOKYO.lng, 1);
    // Exactly k reports spread over k different hours: total passes the k
    // gate, but every single bucket is 0 < count < k and must come back empty.
    for (let i = 0; i < K_ANONYMITY; i++) store.insert(mk(NOW - (i + 1) * HOUR, 'happy', TOKYO));

    const res = trendsCell(store, { cellId, hours: 24, now: NOW });
    expect(res).not.toBeNull();
    expect(res!.bucketMins).toBe(60);
    expect(res!.points).toHaveLength(24);
    for (const p of res!.points) {
      expect(p.count).toBe(0);
      expect(p.valence).toBe(0);
      expect(Object.keys(p.moods)).toHaveLength(0);
    }
  });

  it('keeps buckets at or above k, restricted to the cell', () => {
    const store = new MemoryStore();
    const cellId = cellIdFor(TOKYO.lat, TOKYO.lng, 1);
    insertMany(store, K_ANONYMITY, NOW - 90 * MIN, 'happy', TOKYO); // one busy hour
    store.insert(mk(NOW - 5 * HOUR, 'calm', TOKYO)); // lone straggler → suppressed
    insertMany(store, 20, NOW - 2 * HOUR, 'sad', LONDON);

    const res = trendsCell(store, { cellId, hours: 24, now: NOW });
    expect(res).not.toBeNull();
    const total = res!.points.reduce((sum, p) => sum + p.count, 0);
    expect(total).toBe(K_ANONYMITY); // straggler suppressed, busy hour intact
    const busy = res!.points.find((p) => p.count > 0)!;
    expect(busy.count).toBe(K_ANONYMITY);
    expect(busy.moods.happy).toBe(K_ANONYMITY);
    // London's sad reports never leak into Tokyo's buckets.
    for (const p of res!.points) expect(p.moods.sad).toBeUndefined();
  });

  it('works for any resolution cellId and throws on an invalid one', () => {
    const store = new MemoryStore();
    insertMany(store, K_ANONYMITY, NOW - HOUR, 'calm', CAPE_TOWN);
    const coarse = trendsCell(store, { cellId: cellIdFor(CAPE_TOWN.lat, CAPE_TOWN.lng, 0), hours: 6, now: NOW });
    expect(coarse!.points.reduce((s, p) => s + p.count, 0)).toBe(K_ANONYMITY);
    expect(() => trendsCell(store, { cellId: 'banana', hours: 6, now: NOW })).toThrow();
  });
});

describe('insights', () => {
  it('computes global stats and movers that pass k in BOTH windows', () => {
    const store = new MemoryStore();
    const curr = NOW - 30 * MIN; // inside current 60-min window
    const prev = NOW - 90 * MIN; // inside previous 60-min window

    // Qualifies: k in both windows, big positive swing.
    insertMany(store, 5, curr, 'happy', LONDON);
    insertMany(store, 5, prev, 'sad', LONDON);
    // Qualifies: k in both windows, small negative swing.
    insertMany(store, 5, curr, 'calm', SYDNEY);
    insertMany(store, 5, prev, 'happy', SYDNEY);
    // Excluded: previous window below k.
    insertMany(store, 6, curr, 'calm', TOKYO);
    insertMany(store, 4, prev, 'calm', TOKYO);
    // Excluded: current window below k.
    insertMany(store, 4, curr, 'angry', CAPE_TOWN);
    insertMany(store, 5, prev, 'angry', CAPE_TOWN);
    // Excluded: no previous-window data at all.
    insertMany(store, 7, curr, 'stressed', NAIROBI);

    const res = insights(store, { now: NOW });
    expect(res.at).toBe(NOW);

    const entries: Array<[MoodId, number]> = [['happy', 5], ['calm', 11], ['angry', 4], ['stressed', 7]];
    expect(res.global.count).toBe(27);
    expect(res.global.valence).toBeCloseTo(meanValence(entries), 12);
    expect(res.global.energy).toBeCloseTo(meanEnergy(entries), 12);

    // All nonzero moods, sorted by count descending (counts chosen distinct).
    expect(res.global.topMoods).toEqual([
      { mood: 'calm', count: 11 },
      { mood: 'stressed', count: 7 },
      { mood: 'happy', count: 5 },
      { mood: 'angry', count: 4 },
    ]);

    expect(res.movers.map((m) => m.cellId)).toEqual([
      cellIdFor(LONDON.lat, LONDON.lng, 1),
      cellIdFor(SYDNEY.lat, SYDNEY.lng, 1),
    ]);
    const london = res.movers[0];
    expect(london.deltaValence).toBeCloseTo(MOODS.happy.valence - MOODS.sad.valence, 12);
    expect(london.valence).toBeCloseTo(MOODS.happy.valence, 12);
    expect(london.count).toBe(5);
    expect(london.label).toMatch(/^near .+, [A-Z]{2}$/);
    expect(res.movers[1].deltaValence).toBeCloseTo(MOODS.calm.valence - MOODS.happy.valence, 12);
  });

  it('handles an empty store without dividing by zero', () => {
    const res = insights(new MemoryStore(), { now: NOW });
    expect(res.global).toEqual({ count: 0, valence: 0, energy: 0, topMoods: [] });
    expect(res.movers).toEqual([]);
  });

  it('caps movers at 5, sorted by |deltaValence|', () => {
    const store = new MemoryStore();
    const curr = NOW - 30 * MIN;
    const prev = NOW - 90 * MIN;
    // Seven distinct res-1 cells along the equator, swings of varying size.
    const swings: Array<[MoodId, MoodId]> = [
      ['excited', 'angry'], // delta 1.75
      ['happy', 'sad'], // 1.5
      ['excited', 'sad'], // 1.6
      ['calm', 'sad'], // 1.3
      ['happy', 'calm'], // 0.2
      ['calm', 'happy'], // -0.2
      ['happy', 'happy'], // 0
    ];
    swings.forEach(([currMood, prevMood], i) => {
      const loc = { lat: 2.5, lng: i * 10 }; // 10 deg apart → distinct res-1 cells
      insertMany(store, 5, curr, currMood, loc);
      insertMany(store, 5, prev, prevMood, loc);
    });

    const res = insights(store, { now: NOW });
    expect(res.movers).toHaveLength(5);
    const deltas = res.movers.map((m) => Math.abs(m.deltaValence));
    for (let i = 1; i < deltas.length; i++) expect(deltas[i]).toBeLessThanOrEqual(deltas[i - 1]);
    expect(deltas[0]).toBeCloseTo(1.75, 12);
  });
});
