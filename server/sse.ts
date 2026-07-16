import type { Request, Response } from 'express';
import { cellIdFor } from '../shared/grid';
import type { PulseEvent, ReportStore, StoredReport, UpdateEvent } from '../shared/types';

const UPDATE_EVERY_MS = 2_000; // max 1 update event per 2 s
const PULSE_EVERY_MS = 1_000; // max ~1 pulse event per s
const PING_EVERY_MS = 25_000;
const MAX_CLIENTS = 500; // hard cap on concurrent streams
// A healthy client drains instantly; a stalled TCP connection never fires
// 'close', so cap its user-space buffer and evict instead of growing RSS.
const MAX_BUFFERED_BYTES = 64 * 1024;

/**
 * SSE fan-out for /api/stream.
 *
 * Privacy constraints: pulses are coarsened to resolution 0 (continent
 * scale) before broadcast, and no client identifier is ever logged.
 */
export class SseHub {
  private clients = new Set<Response>();
  private dirty = false; // reports arrived since the last update event
  private latestPulse: StoredReport | null = null; // sample: keep newest, drop rest
  private readonly unsubscribe: () => void;
  private readonly timers: NodeJS.Timeout[];

  constructor(private readonly store: ReportStore) {
    this.unsubscribe = store.onInsert((r) => {
      this.dirty = true;
      this.latestPulse = r;
    });
    this.timers = [
      setInterval(() => this.flushUpdate(), UPDATE_EVERY_MS),
      setInterval(() => this.flushPulse(), PULSE_EVERY_MS),
      setInterval(() => this.broadcastRaw(': ping\n\n'), PING_EVERY_MS),
    ];
    // Never hold the process open (tests, graceful shutdown).
    for (const t of this.timers) t.unref?.();
  }

  attach(req: Request, res: Response): void {
    if (this.clients.size >= MAX_CLIENTS) {
      res.status(503).json({ ok: false, error: 'too many open streams — try again shortly' });
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(': connected\n\n');
    this.clients.add(res);
    req.on('close', () => {
      this.clients.delete(res);
    });
  }

  /** Stop timers, unsubscribe from the store, and end open streams. */
  close(): void {
    this.unsubscribe();
    for (const t of this.timers) clearInterval(t);
    for (const res of this.clients) {
      try {
        res.end();
      } catch {
        // already gone
      }
    }
    this.clients.clear();
  }

  private flushUpdate(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const payload: UpdateEvent = { at: Date.now(), totalReports: this.store.count() };
    this.broadcast('update', payload);
  }

  private flushPulse(): void {
    const r = this.latestPulse;
    if (!r) return;
    this.latestPulse = null;
    const payload: PulseEvent = {
      mood: r.mood,
      cellId: cellIdFor(r.lat, r.lng, 0), // ALWAYS resolution 0
      at: r.t,
    };
    this.broadcast('pulse', payload);
  }

  private broadcast(event: string, data: unknown): void {
    this.broadcastRaw(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private broadcastRaw(frame: string): void {
    for (const res of this.clients) {
      try {
        res.write(frame);
        if (res.writableLength > MAX_BUFFERED_BYTES) {
          // Stalled reader (writes to a backed-up socket buffer silently,
          // they never throw) — evict before it exhausts memory.
          this.clients.delete(res);
          res.destroy();
        }
      } catch {
        this.clients.delete(res);
      }
    }
  }
}
