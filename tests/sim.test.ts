import { describe, expect, it } from 'vitest';
import { CITIES, seedHistory } from '../server/sim/index';
import { MemoryStore } from '../server/store';
import { isMoodId, isTagId } from '../shared/moods';
import { snapToFinest } from '../shared/grid';
import type { StoredReport } from '../shared/types';

const HOUR = 3_600_000;
// Fixed "now" so seeding never races the wall clock.
const NOW = 1_750_000_000_000;

function allReports(store: MemoryStore): StoredReport[] {
  return store.query(0, Number.MAX_SAFE_INTEGER);
}

describe('seedHistory determinism', () => {
  it('same {now, seed} on two fresh stores produces identical output (48h default)', () => {
    const a = new MemoryStore();
    const b = new MemoryStore();
    const countA = seedHistory(a, { now: NOW, seed: 7 });
    // hours omitted on one side: the default must equal an explicit 48.
    const countB = seedHistory(b, { now: NOW, hours: 48, seed: 7 });

    expect(countA).toBe(countB);
    expect(a.count()).toBe(countA);
    expect(b.count()).toBe(countB);

    const ra = allReports(a);
    const rb = allReports(b);
    expect(ra.slice(0, 10)).toEqual(rb.slice(0, 10));
    expect(ra.slice(-10)).toEqual(rb.slice(-10));
    // Spot-check the whole stream, not just the ends.
    for (let i = 0; i < ra.length; i += 997) {
      expect(ra[i]).toEqual(rb[i]);
    }
  });

  it('48h volume lands in a plausible global band', () => {
    const store = new MemoryStore();
    const inserted = seedHistory(store, { now: NOW, seed: 7 });
    // TARGET_PER_HOUR = 4000 → ~192k over 48h; wide band to allow model drift.
    expect(inserted).toBeGreaterThanOrEqual(150_000);
    expect(inserted).toBeLessThanOrEqual(250_000);
  });

  it('different seeds produce different streams', () => {
    const a = new MemoryStore();
    const b = new MemoryStore();
    seedHistory(a, { now: NOW, hours: 2, seed: 1 });
    seedHistory(b, { now: NOW, hours: 2, seed: 2 });
    const headA = JSON.stringify(allReports(a).slice(0, 100));
    const headB = JSON.stringify(allReports(b).slice(0, 100));
    expect(headA).not.toBe(headB);
  });
});

describe('seedHistory report invariants', () => {
  const hours = 3;
  const store = new MemoryStore();
  seedHistory(store, { now: NOW, hours, seed: 42 });
  const reports = allReports(store);

  it('produces a meaningful number of reports even for a short window', () => {
    expect(reports.length).toBeGreaterThan(1_000);
  });

  it('every report is sim:true with t inside [now - hours, now)', () => {
    for (const r of reports) {
      expect(r.sim).toBe(true);
      expect(r.t).toBeGreaterThanOrEqual(NOW - hours * HOUR);
      expect(r.t).toBeLessThan(NOW);
    }
  });

  it('every report has a valid mood and (optional) valid tag', () => {
    let tagged = 0;
    for (const r of reports) {
      expect(isMoodId(r.mood)).toBe(true);
      if (r.tag !== undefined) {
        tagged++;
        expect(isTagId(r.tag)).toBe(true);
      }
    }
    // ~25% carry a tag; assert a generous band around that.
    const ratio = tagged / reports.length;
    expect(ratio).toBeGreaterThan(0.1);
    expect(ratio).toBeLessThan(0.5);
  });

  it('every report is snapped to a finest-cell center', () => {
    for (let i = 0; i < reports.length; i += 101) {
      const r = reports[i];
      expect(snapToFinest(r.lat, r.lng)).toEqual({ lat: r.lat, lng: r.lng });
    }
  });
});

describe('CITIES', () => {
  it('is a substantial, well-formed city list', () => {
    expect(CITIES.length).toBeGreaterThanOrEqual(200);
    for (const c of CITIES) {
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.country).toMatch(/^[A-Z]{2}$/);
      expect(c.lat).toBeGreaterThanOrEqual(-90);
      expect(c.lat).toBeLessThanOrEqual(90);
      expect(c.lng).toBeGreaterThanOrEqual(-180);
      expect(c.lng).toBeLessThanOrEqual(180);
      expect(c.pop).toBeGreaterThan(0);
    }
  });
});
