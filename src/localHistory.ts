import { isMoodId, isTagId, type MoodId, type TagId } from '@shared/moods';

/**
 * Personal mood log. Lives in localStorage ONLY — it is a privacy feature
 * and must never be sent to the server or any third party.
 */

export interface LocalHistoryEntry {
  t: number; // epoch ms
  mood: MoodId;
  tag?: TagId;
  cellId: string; // finest-res cell the server snapped the report to
}

const HISTORY_KEY = 'gmm.history.v1';
const LAST_REPORT_KEY = 'gmm.lastReportAt.v1';
const MAX_ENTRIES = 50;

function isEntry(x: unknown): x is LocalHistoryEntry {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.t === 'number' &&
    isMoodId(e.mood) &&
    typeof e.cellId === 'string' &&
    (e.tag === undefined || isTagId(e.tag))
  );
}

export function loadHistory(): LocalHistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry);
  } catch {
    return [];
  }
}

/** Prepend an entry, cap the log, persist, and return the new list. */
export function addHistoryEntry(entry: LocalHistoryEntry): LocalHistoryEntry[] {
  const next = [entry, ...loadHistory()].slice(0, MAX_ENTRIES);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    // storage full or blocked — the log is best-effort
  }
  return next;
}

export function clearHistory(): void {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    // ignore
  }
}

export function getLastReportAt(): number | null {
  try {
    const raw = localStorage.getItem(LAST_REPORT_KEY);
    const t = raw === null ? NaN : Number(raw);
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

export function setLastReportAt(t: number): void {
  try {
    localStorage.setItem(LAST_REPORT_KEY, String(t));
  } catch {
    // ignore
  }
}
