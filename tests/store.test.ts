import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../server/store';
import type { StoredReport } from '../shared/types';

function report(t: number, overrides: Partial<StoredReport> = {}): StoredReport {
  return { t, mood: 'happy', lat: 51.75, lng: -0.25, sim: false, ...overrides };
}

describe('MemoryStore (in-memory)', () => {
  it('query window is fromT-inclusive, toT-exclusive', () => {
    const store = new MemoryStore();
    store.insert(report(99));
    store.insert(report(100));
    store.insert(report(200));
    store.insert(report(300));
    const got = store.query(100, 300).map((r) => r.t);
    expect(got).toEqual([100, 200]);
  });

  it('query returns everything in a wide-open window, unordered inserts intact', () => {
    const store = new MemoryStore();
    store.insert(report(500));
    store.insert(report(100));
    expect(store.query(0, 1000)).toHaveLength(2);
    expect(store.query(0, 100)).toHaveLength(0);
  });

  it('count tracks inserts', () => {
    const store = new MemoryStore();
    expect(store.count()).toBe(0);
    store.insert(report(1));
    store.insert(report(2));
    expect(store.count()).toBe(2);
  });

  it('onInsert fires with the inserted report; unsubscribe stops it', () => {
    const store = new MemoryStore();
    const seen: StoredReport[] = [];
    const unsubscribe = store.onInsert((r) => seen.push(r));
    const first = report(10, { mood: 'angry', tag: 'news' });
    store.insert(first);
    expect(seen).toEqual([first]);
    unsubscribe();
    store.insert(report(20));
    expect(seen).toHaveLength(1);
    // Unsubscribing twice is harmless.
    expect(() => unsubscribe()).not.toThrow();
  });

  it('prune removes reports strictly older than the horizon and returns the removed count', () => {
    const store = new MemoryStore();
    store.insert(report(50));
    store.insert(report(99));
    store.insert(report(100));
    store.insert(report(150));
    expect(store.prune(100)).toBe(2);
    expect(store.count()).toBe(2);
    expect(store.query(0, 1000).map((r) => r.t)).toEqual([100, 150]);
    expect(store.prune(100)).toBe(0);
  });
});

describe('MemoryStore (JSONL persistence)', () => {
  let tmpDir: string | undefined;

  function tmpFile(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmm-store-test-'));
    return path.join(tmpDir, 'reports.jsonl');
  }

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('real reports persist and reload across instances; sim reports do not', () => {
    const file = tmpFile();
    const now = Date.now();
    const real = report(now - 1000, { mood: 'calm', tag: 'weather' });
    const simmed = report(now - 500, { mood: 'sad', sim: true });

    const a = new MemoryStore(file);
    a.insert(real);
    a.insert(simmed);
    expect(a.count()).toBe(2);

    const b = new MemoryStore(file);
    expect(b.count()).toBe(1);
    const loaded = b.query(0, now + 1)[0];
    expect(loaded).toEqual(real);
    expect(loaded.sim).toBe(false);
  });

  it('creates the parent directory on first append', () => {
    const file = tmpFile();
    const nested = path.join(path.dirname(file), 'deep', 'er', 'reports.jsonl');
    const store = new MemoryStore(nested);
    store.insert(report(Date.now()));
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('skips corrupt, foreign, and expired lines without crashing', () => {
    const file = tmpFile();
    const now = Date.now();
    const good = report(now - 2000, { mood: 'excited' });
    const lines = [
      JSON.stringify(good),
      '{not json at all',
      '"just a string"',
      'null',
      JSON.stringify({ t: now, mood: 'joyful', lat: 0, lng: 0 }), // unknown mood
      JSON.stringify({ t: 'yesterday', mood: 'happy', lat: 0, lng: 0 }), // non-numeric t
      JSON.stringify({ t: now, mood: 'happy', lat: Infinity, lng: 0 }), // non-finite (JSON null) lat
      JSON.stringify(report(now - 49 * 3_600_000)), // beyond retention horizon
      '',
    ];
    fs.writeFileSync(file, lines.join('\n') + '\n');

    const store = new MemoryStore(file);
    expect(store.count()).toBe(1);
    expect(store.query(0, now + 1)[0]).toEqual(good);
  });

  it('compacts the log on boot: dropped lines are rewritten out of the file', () => {
    const file = tmpFile();
    const now = Date.now();
    const good = report(now - 2000, { mood: 'excited' });
    fs.writeFileSync(
      file,
      [JSON.stringify(good), '{corrupt', JSON.stringify(report(now - 49 * 3_600_000))].join('\n') + '\n',
    );

    new MemoryStore(file);
    const rewritten = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim());
    expect(rewritten).toHaveLength(1);
    expect(JSON.parse(rewritten[0])).toEqual(good);
  });

  it('prune rewrites the log so expired real reports also leave the disk', () => {
    const file = tmpFile();
    const now = Date.now();
    const old = report(now - 10_000, { mood: 'sad' });
    const fresh = report(now - 1000, { mood: 'happy' });
    const store = new MemoryStore(file);
    store.insert(old);
    store.insert(fresh);
    store.insert(report(now - 500, { sim: true })); // never persisted anyway

    expect(store.prune(now - 5000)).toBe(1);
    const rewritten = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim());
    expect(rewritten).toHaveLength(1);
    expect(JSON.parse(rewritten[0])).toEqual(fresh);
  });

  it('forces sim:false and drops invalid tags on loaded lines', () => {
    const file = tmpFile();
    const now = Date.now();
    fs.writeFileSync(
      file,
      JSON.stringify({ t: now - 100, mood: 'tired', lat: 1.25, lng: 2.25, sim: true, tag: 'nonsense' }) + '\n'
    );
    const store = new MemoryStore(file);
    expect(store.count()).toBe(1);
    const r = store.query(0, now + 1)[0];
    expect(r.sim).toBe(false);
    expect(r.tag).toBeUndefined();
  });

  it('a missing file is treated as an empty store', () => {
    const file = tmpFile();
    const store = new MemoryStore(path.join(path.dirname(file), 'never-written.jsonl'));
    expect(store.count()).toBe(0);
  });
});
