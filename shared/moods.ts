/**
 * The mood model. Based on the circumplex model of affect:
 * every mood has a valence (unpleasant -1 .. +1 pleasant) and an
 * energy/arousal level (0 low .. 1 high). Regional aggregates are
 * report-count-weighted means of these two dimensions.
 */

export const MOOD_IDS = [
  'excited',
  'happy',
  'calm',
  'tired',
  'sad',
  'anxious',
  'stressed',
  'angry',
] as const;

export type MoodId = (typeof MOOD_IDS)[number];

export interface MoodDef {
  id: MoodId;
  emoji: string;
  label: string;
  valence: number; // -1 (unpleasant) .. +1 (pleasant)
  energy: number; // 0 (low arousal) .. 1 (high arousal)
  color: string; // used in the picker, breakdown bars, and pulses
}

export const MOODS: Record<MoodId, MoodDef> = {
  excited: { id: 'excited', emoji: '🤩', label: 'Excited', valence: 0.9, energy: 0.9, color: '#ff9f1c' },
  happy: { id: 'happy', emoji: '😊', label: 'Happy', valence: 0.8, energy: 0.6, color: '#ffd166' },
  calm: { id: 'calm', emoji: '😌', label: 'Calm', valence: 0.6, energy: 0.2, color: '#06d6a0' },
  tired: { id: 'tired', emoji: '🥱', label: 'Tired', valence: -0.1, energy: 0.1, color: '#94a3b8' },
  sad: { id: 'sad', emoji: '😢', label: 'Sad', valence: -0.7, energy: 0.25, color: '#5b8dbf' },
  anxious: { id: 'anxious', emoji: '😟', label: 'Anxious', valence: -0.5, energy: 0.65, color: '#8b5cf6' },
  stressed: { id: 'stressed', emoji: '😰', label: 'Stressed', valence: -0.65, energy: 0.8, color: '#d1495b' },
  angry: { id: 'angry', emoji: '😠', label: 'Angry', valence: -0.85, energy: 0.9, color: '#9b2226' },
};

export const MOOD_LIST: MoodDef[] = MOOD_IDS.map((id) => MOODS[id]);

export function isMoodId(x: unknown): x is MoodId {
  return typeof x === 'string' && (MOOD_IDS as readonly string[]).includes(x);
}

/** Optional context tags. Fixed allowlist — free text is never accepted. */
export const TAG_IDS = [
  'work',
  'school',
  'family',
  'friends',
  'health',
  'money',
  'news',
  'weather',
  'travel',
  'other',
] as const;

export type TagId = (typeof TAG_IDS)[number];

export function isTagId(x: unknown): x is TagId {
  return typeof x === 'string' && (TAG_IDS as readonly string[]).includes(x);
}

/**
 * Valence → color scale for the map ("emotional weather").
 * Colorblind-safe diverging scale: gloomy indigo (negative) → neutral
 * gray → sunny amber (positive). Deliberately avoids red↔green.
 */
export const VALENCE_STOPS: Array<[number, string]> = [
  [-1, '#4453c4'],
  [0, '#8a8f98'],
  [1, '#f5b31d'],
];

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Interpolate the diverging valence scale. Input clamped to [-1, 1]. */
export function valenceColor(valence: number): string {
  const v = Math.max(-1, Math.min(1, valence));
  const [lo, hi] = v <= 0 ? [VALENCE_STOPS[0], VALENCE_STOPS[1]] : [VALENCE_STOPS[1], VALENCE_STOPS[2]];
  const t = (v - lo[0]) / (hi[0] - lo[0]);
  const [r1, g1, b1] = hexToRgb(lo[1]);
  const [r2, g2, b2] = hexToRgb(hi[1]);
  const r = Math.round(lerp(r1, r2, t));
  const g = Math.round(lerp(g1, g2, t));
  const b = Math.round(lerp(b1, b2, t));
  return `rgb(${r}, ${g}, ${b})`;
}
