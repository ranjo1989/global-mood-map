import { describe, expect, it } from 'vitest';
import {
  MOODS,
  MOOD_IDS,
  MOOD_LIST,
  TAG_IDS,
  VALENCE_STOPS,
  isMoodId,
  isTagId,
  valenceColor,
} from '../shared/moods';

function hexToRgbString(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff})`;
}

describe('valenceColor', () => {
  it('clamps inputs outside [-1, 1]', () => {
    expect(valenceColor(-5)).toBe(valenceColor(-1));
    expect(valenceColor(-1.0001)).toBe(valenceColor(-1));
    expect(valenceColor(1.0001)).toBe(valenceColor(1));
    expect(valenceColor(99)).toBe(valenceColor(1));
  });

  it('endpoints match VALENCE_STOPS exactly', () => {
    expect(valenceColor(-1)).toBe(hexToRgbString(VALENCE_STOPS[0][1]));
    expect(valenceColor(1)).toBe(hexToRgbString(VALENCE_STOPS[2][1]));
  });

  it('midpoint is the neutral gray stop', () => {
    expect(valenceColor(0)).toBe(hexToRgbString(VALENCE_STOPS[1][1]));
    // Sanity against the literal stop values in shared/moods.ts.
    expect(valenceColor(0)).toBe('rgb(138, 143, 152)');
    expect(valenceColor(-1)).toBe('rgb(68, 83, 196)');
    expect(valenceColor(1)).toBe('rgb(245, 179, 29)');
  });

  it('interpolates between stops (interior values differ from all stops)', () => {
    for (const v of [-0.5, 0.5]) {
      const c = valenceColor(v);
      expect(c).not.toBe(valenceColor(-1));
      expect(c).not.toBe(valenceColor(0));
      expect(c).not.toBe(valenceColor(1));
      expect(c).toMatch(/^rgb\(\d{1,3}, \d{1,3}, \d{1,3}\)$/);
    }
  });
});

describe('mood definitions', () => {
  it('has a complete, well-formed def for every MOOD_ID', () => {
    expect(MOOD_IDS.length).toBeGreaterThan(0);
    for (const id of MOOD_IDS) {
      const def = MOODS[id];
      expect(def).toBeDefined();
      expect(def.id).toBe(id);
      expect(def.valence).toBeGreaterThanOrEqual(-1);
      expect(def.valence).toBeLessThanOrEqual(1);
      expect(def.energy).toBeGreaterThanOrEqual(0);
      expect(def.energy).toBeLessThanOrEqual(1);
      expect(def.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.emoji.length).toBeGreaterThan(0);
    }
  });

  it('MOOD_LIST mirrors MOOD_IDS in order', () => {
    expect(MOOD_LIST.map((d) => d.id)).toEqual([...MOOD_IDS]);
  });

  it('mood ids are unique', () => {
    expect(new Set(MOOD_IDS).size).toBe(MOOD_IDS.length);
  });
});

describe('id guards', () => {
  it('isMoodId accepts every mood and rejects everything else', () => {
    for (const id of MOOD_IDS) expect(isMoodId(id)).toBe(true);
    expect(isMoodId('joyful')).toBe(false);
    expect(isMoodId('')).toBe(false);
    expect(isMoodId(42)).toBe(false);
    expect(isMoodId(undefined)).toBe(false);
  });

  it('isTagId accepts every tag and rejects everything else', () => {
    for (const id of TAG_IDS) expect(isTagId(id)).toBe(true);
    expect(isTagId('crypto')).toBe(false);
    expect(isTagId(null)).toBe(false);
  });
});
