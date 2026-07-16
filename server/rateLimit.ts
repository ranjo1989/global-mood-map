import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ApiError } from '../shared/types';

const CAPACITY = 10; // tokens
const REFILL_PER_MS = CAPACITY / 60_000; // 10 tokens per minute
const CLEANUP_EVERY_MS = 5 * 60_000;

interface Bucket {
  tokens: number;
  last: number; // epoch ms of last refill
}

/**
 * Token-bucket rate limiter: 10 requests/minute per IP.
 *
 * Privacy constraint: req.ip is used ONLY as a transient in-memory Map
 * key. It is never logged and never attached to a report or response.
 */
export function rateLimit(opts?: { now?: () => number }): RequestHandler {
  const now = opts?.now ?? Date.now;
  const buckets = new Map<string, Bucket>();
  let lastCleanup = now();

  return (req: Request, res: Response, next: NextFunction) => {
    const t = now();

    // Opportunistic sweep of stale (fully refilled) buckets so the Map
    // does not grow unboundedly; avoids a timer that outlives tests.
    if (t - lastCleanup >= CLEANUP_EVERY_MS) {
      lastCleanup = t;
      for (const [key, b] of buckets) {
        if (b.tokens + (t - b.last) * REFILL_PER_MS >= CAPACITY) buckets.delete(key);
      }
    }

    const key = req.ip ?? 'unknown';
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: CAPACITY, last: t };
      buckets.set(key, bucket);
    } else {
      bucket.tokens = Math.min(CAPACITY, bucket.tokens + (t - bucket.last) * REFILL_PER_MS);
      bucket.last = t;
    }

    if (bucket.tokens < 1) {
      const body: ApiError = { ok: false, error: 'rate limit exceeded: max 10 reports per minute' };
      res.status(429).json(body);
      return;
    }

    bucket.tokens -= 1;
    next();
  };
}
