/**
 * Deterministic PRNG utilities for the world simulator.
 * mulberry32: fast 32-bit generator with identical output for identical
 * seeds on every platform — the whole sim's determinism rests on it.
 */

export type Rng = () => number;

/** Seeded uniform [0, 1) generator (mulberry32). */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform integer in [min, max], inclusive on both ends. */
export function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

/**
 * Weighted pick. Weights must be non-negative with a positive sum;
 * they do not need to sum to 1.
 */
export function pickWeighted<T>(rng: Rng, items: readonly T[], weights: readonly number[]): T {
  let total = 0;
  for (const w of weights) total += w;
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r < 0) return items[i];
  }
  return items[items.length - 1];
}

/**
 * Poisson sample. Knuth's product method for small lambda; gaussian
 * approximation (12-uniform sum) above 30, where Knuth gets slow.
 */
export function poisson(rng: Rng, lambda: number): number {
  if (!(lambda > 0)) return 0;
  if (lambda > 30) {
    let s = -6;
    for (let i = 0; i < 12; i++) s += rng();
    return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * s));
  }
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > limit);
  return k - 1;
}

/** Gaussian-ish jitter: triangular distribution on [-halfWidth, +halfWidth]. */
export function triangular(rng: Rng, halfWidth: number): number {
  return (rng() + rng() - 1) * halfWidth;
}
