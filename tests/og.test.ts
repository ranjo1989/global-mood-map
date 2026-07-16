import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { renderOgPng, OG_HEIGHT, OG_WIDTH } from '../server/og';
import { K_ANONYMITY } from '../shared/types';
import type { AggregateCell } from '../shared/types';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Background is #0b1020. */
const BG = [0x0b, 0x10, 0x20];

function makeCell(cellId: string, count: number, valence: number): AggregateCell {
  return { cellId, count, valence, energy: 0.5, topMood: 'happy', moods: { happy: count } };
}

function pixel(png: PNG, x: number, y: number): [number, number, number, number] {
  const i = (y * png.width + x) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
}

// Cell r2:45:90 spans lat 0..2, lng 0..2 → on the 1160×580 map area
// (offset 20,25) that is roughly x 600..606, y 309..315. (602, 311) is an
// interior (non-edge) pixel of that rect.
const CELL_A = 'r2:45:90';
const CELL_A_PX = { x: 602, y: 311 };
// Cell r2:45:100 spans lat 0..2, lng 20..22 → x 664..671, same rows.
const CELL_B = 'r2:45:100';
const CELL_B_PX = { x: 666, y: 311 };

describe('renderOgPng', () => {
  it('returns a valid PNG with the OG card dimensions', () => {
    const buf = renderOgPng([makeCell(CELL_A, 25, 0.5)]);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect([...buf.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    const png = PNG.sync.read(buf);
    expect(png.width).toBe(OG_WIDTH);
    expect(png.height).toBe(OG_HEIGHT);
    expect(OG_WIDTH).toBe(1200);
    expect(OG_HEIGHT).toBe(630);
  });

  it('is deterministic: same cells → byte-identical output', () => {
    const cells = [makeCell(CELL_A, 12, -0.4), makeCell(CELL_B, 300, 0.9)];
    const a = renderOgPng(cells);
    const b = renderOgPng(cells.map((c) => ({ ...c })));
    expect(a.equals(b)).toBe(true);
  });

  it('renders an empty cells array as a valid dark image', () => {
    const buf = renderOgPng([]);
    expect([...buf.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    const png = PNG.sync.read(buf);
    expect(png.width).toBe(OG_WIDTH);
    expect(png.height).toBe(OG_HEIGHT);
    // Center is outside the vignette ramp → exactly the background color.
    expect(pixel(png, 600, 315)).toEqual([...BG, 255]);
    // A corner pixel is vignetted — darker than (or equal channel-wise to)
    // the background, never brighter, and fully opaque.
    const [r, g, b, a] = pixel(png, 0, 0);
    expect(r).toBeLessThanOrEqual(BG[0]);
    expect(g).toBeLessThanOrEqual(BG[1]);
    expect(b).toBeLessThan(BG[2]);
    expect(a).toBe(255);
  });

  it('paints a cell over the background at its equirectangular position', () => {
    const png = PNG.sync.read(renderOgPng([makeCell(CELL_A, 50, 1)]));
    const [r, , b] = pixel(png, CELL_A_PX.x, CELL_A_PX.y);
    // Positive valence → amber-ish: clearly warmer than the dark blue bg.
    expect(r).toBeGreaterThan(BG[0]);
    expect(r).toBeGreaterThan(b);
    // Just outside the cell rect it is still pure background.
    expect(pixel(png, CELL_A_PX.x - 30, CELL_A_PX.y)).toEqual([...BG, 255]);
  });

  it('scales cell opacity with report count (k faint, 300+ near-solid)', () => {
    const png = PNG.sync.read(
      renderOgPng([makeCell(CELL_A, K_ANONYMITY, 1), makeCell(CELL_B, 400, 1)])
    );
    const [rLow] = pixel(png, CELL_A_PX.x, CELL_A_PX.y);
    const [rHigh] = pixel(png, CELL_B_PX.x, CELL_B_PX.y);
    // Same valence color, so the red channel tracks alpha directly.
    expect(rHigh).toBeGreaterThan(rLow);
  });

  it('darkens the 1px inset edge relative to the cell interior', () => {
    const png = PNG.sync.read(renderOgPng([makeCell(CELL_A, 300, 1)]));
    const [rInterior] = pixel(png, CELL_A_PX.x, CELL_A_PX.y);
    // Cells are inflated (CELL_INFLATE), so locate the west edge by
    // scanning the interior row for the first non-background pixel
    // instead of hardcoding the un-inflated rect boundary.
    let edgeX = -1;
    // Start well inside the map area (past the border vignette, which also
    // tints background pixels) but left of the inflated cell.
    for (let x = CELL_A_PX.x - 40; x < CELL_A_PX.x; x++) {
      const [r, g, b] = pixel(png, x, CELL_A_PX.y);
      if (r !== BG[0] || g !== BG[1] || b !== BG[2]) {
        edgeX = x;
        break;
      }
    }
    expect(edgeX).toBeGreaterThan(-1);
    const [rEdge] = pixel(png, edgeX, CELL_A_PX.y);
    expect(rEdge).toBeLessThan(rInterior);
  });
});
