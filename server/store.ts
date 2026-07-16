import fs from 'node:fs';
import path from 'node:path';
import { isMoodId, isTagId } from '../shared/moods';
import { RETENTION_HOURS } from '../shared/types';
import type { ReportStore, StoredReport } from '../shared/types';

/**
 * Best-effort validation of a JSONL line loaded from disk. Corrupt or
 * foreign lines are skipped rather than crashing boot.
 */
function toStoredReport(x: unknown): StoredReport | null {
  if (typeof x !== 'object' || x === null) return null;
  const o = x as Record<string, unknown>;
  if (typeof o.t !== 'number' || !Number.isFinite(o.t)) return null;
  if (!isMoodId(o.mood)) return null;
  if (typeof o.lat !== 'number' || !Number.isFinite(o.lat)) return null;
  if (typeof o.lng !== 'number' || !Number.isFinite(o.lng)) return null;
  const r: StoredReport = {
    t: o.t,
    mood: o.mood,
    lat: o.lat,
    lng: o.lng,
    // Only real reports are ever persisted, so anything loaded is real.
    sim: false,
  };
  if (isTagId(o.tag)) r.tag = o.tag;
  return r;
}

export class MemoryStore implements ReportStore {
  private reports: StoredReport[] = [];
  private listeners = new Set<(r: StoredReport) => void>();
  private readonly filePath?: string;
  private dirReady = false;

  /** Omit filePath for a purely in-memory store (tests): no disk IO at all. */
  constructor(filePath?: string) {
    this.filePath = filePath;
    if (filePath) this.loadFromDisk(filePath);
  }

  insert(r: StoredReport): void {
    this.reports.push(r);
    // Simulated reports are regenerated each boot and must never persist.
    if (!r.sim && this.filePath) this.append(r);
    for (const cb of this.listeners) cb(r);
  }

  query(fromT: number, toT: number): StoredReport[] {
    return this.reports.filter((r) => r.t >= fromT && r.t < toT);
  }

  count(): number {
    return this.reports.length;
  }

  onInsert(cb: (r: StoredReport) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  prune(olderThanT: number): number {
    const before = this.reports.length;
    this.reports = this.reports.filter((r) => r.t >= olderThanT);
    const removed = before - this.reports.length;
    // Retention must hold on disk too, not just in memory — rewrite the
    // append log so expired real reports actually disappear.
    if (removed > 0) this.compact();
    return removed;
  }

  private loadFromDisk(filePath: string): void {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      return; // no file yet — nothing persisted
    }
    const horizon = Date.now() - RETENTION_HOURS * 3_600_000;
    let seen = 0;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      seen++;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue; // corrupt line — skip
      }
      const r = toStoredReport(parsed);
      if (r && r.t >= horizon) this.reports.push(r);
    }
    // Dropped expired/corrupt lines: rewrite so the log never grows forever.
    if (seen > this.reports.length) this.compact();
  }

  /** Atomically rewrite the log with only the retained real reports. */
  private compact(): void {
    if (!this.filePath) return;
    try {
      if (!this.dirReady) {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        this.dirReady = true;
      }
      const lines = this.reports.filter((r) => !r.sim).map((r) => JSON.stringify(r));
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, lines.length > 0 ? lines.join('\n') + '\n' : '');
      fs.renameSync(tmp, this.filePath);
    } catch {
      // Best-effort, like append — never fail the caller over disk IO.
    }
  }

  private append(r: StoredReport): void {
    try {
      if (!this.dirReady) {
        fs.mkdirSync(path.dirname(this.filePath!), { recursive: true });
        this.dirReady = true;
      }
      fs.appendFileSync(this.filePath!, JSON.stringify(r) + '\n');
    } catch {
      // Persistence is best-effort; never fail the request over disk IO.
    }
  }
}
