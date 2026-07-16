import { PNG } from 'pngjs';
import { parseCellId } from '../shared/grid';
import { valenceColor } from '../shared/moods';
import { K_ANONYMITY } from '../shared/types';
import type { AggregateCell } from '../shared/types';

/**
 * Server-rendered Open Graph card: the world mood grid as a 1200×630 PNG.
 *
 * Deliberately text-free — crawlers show og:title below the image, so the
 * picture only carries the map. Input is whatever aggregates() returned,
 * which means k-anonymity has already been enforced upstream; this module
 * renders exactly the cells it is given and nothing else.
 *
 * Pure: same cells in → byte-identical PNG out. No Date.now(), no I/O.
 */

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

/** Map plot area, centered inside the canvas. */
const MAP_W = 1160;
const MAP_H = 580;
const MAP_X = (OG_WIDTH - MAP_W) / 2;
const MAP_Y = (OG_HEIGHT - MAP_H) / 2;

/** Page background #0b1020 — matches the app's dark theme. */
const BG_R = 0x0b;
const BG_G = 0x10;
const BG_B = 0x20;

/** Cell alpha ramps with report count: faint at k, near-solid at 300+. */
const ALPHA_MIN = 0.7;
const ALPHA_MAX = 0.98;
const COUNT_SATURATION = 300;

/**
 * Cells are inflated around their center so the world reads instantly at
 * social-card thumbnail size — a 2° cell is only ~6px wide otherwise.
 */
const CELL_INFLATE = 1.8;

/** Vignette: linear darkening ramp within this many px of the canvas edge. */
const VIGNETTE_PX = 80;
const VIGNETTE_MAX_ALPHA = 0.4;

/** Factor applied to a cell's color for its 1px inset edge. */
const EDGE_DARKEN = 0.55;

function parseRgb(css: string): [number, number, number] {
  const m = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(css);
  if (!m) throw new Error(`unexpected color format: ${css}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Equirectangular projection into the map area. */
function projectX(lng: number): number {
  return MAP_X + ((lng + 180) / 360) * MAP_W;
}

function projectY(lat: number): number {
  return MAP_Y + ((90 - lat) / 180) * MAP_H;
}

/** Alpha for a cell given its report count (log ramp k → 300+). */
function cellAlpha(count: number): number {
  const lo = Math.log(K_ANONYMITY);
  const hi = Math.log(COUNT_SATURATION);
  const t = Math.max(0, Math.min(1, (Math.log(Math.max(count, 1)) - lo) / (hi - lo)));
  return ALPHA_MIN + (ALPHA_MAX - ALPHA_MIN) * t;
}

/** Manual source-over blend of (r,g,b,alpha) onto an opaque RGBA buffer. */
function blendPixel(data: Buffer, idx: number, r: number, g: number, b: number, alpha: number): void {
  data[idx] = Math.round(r * alpha + data[idx] * (1 - alpha));
  data[idx + 1] = Math.round(g * alpha + data[idx + 1] * (1 - alpha));
  data[idx + 2] = Math.round(b * alpha + data[idx + 2] * (1 - alpha));
  data[idx + 3] = 255;
}

export function renderOgPng(cells: AggregateCell[]): Buffer {
  const png = new PNG({ width: OG_WIDTH, height: OG_HEIGHT });
  const data = png.data;

  // 1. Background fill.
  for (let i = 0; i < data.length; i += 4) {
    data[i] = BG_R;
    data[i + 1] = BG_G;
    data[i + 2] = BG_B;
    data[i + 3] = 255;
  }

  // 2. Cells, quietest first so busy cells sit on top where they overlap
  //    at rounded pixel boundaries.
  const sorted = [...cells].sort((a, b) => a.count - b.count);
  for (const cell of sorted) {
    const info = parseCellId(cell.cellId);
    const [r, g, b] = parseRgb(valenceColor(cell.valence));
    const er = Math.round(r * EDGE_DARKEN);
    const eg = Math.round(g * EDGE_DARKEN);
    const eb = Math.round(b * EDGE_DARKEN);
    const alpha = cellAlpha(cell.count);

    const cx = projectX((info.lng0 + info.lng1) / 2);
    const cy = projectY((info.lat0 + info.lat1) / 2);
    const halfW = ((projectX(info.lng1) - projectX(info.lng0)) / 2) * CELL_INFLATE;
    const halfH = ((projectY(info.lat0) - projectY(info.lat1)) / 2) * CELL_INFLATE;
    const x0 = Math.max(Math.round(cx - halfW), 0);
    const x1 = Math.min(Math.round(cx + halfW), OG_WIDTH);
    const y0 = Math.max(Math.round(cy - halfH), 0); // north edge
    const y1 = Math.min(Math.round(cy + halfH), OG_HEIGHT); // south edge
    if (x1 <= x0 || y1 <= y0) continue;

    for (let y = y0; y < y1; y++) {
      const rowIdx = y * OG_WIDTH;
      for (let x = x0; x < x1; x++) {
        const idx = (rowIdx + x) * 4;
        // 1px inset edge in a darker shade for cell definition.
        const onEdge = x === x0 || x === x1 - 1 || y === y0 || y === y1 - 1;
        if (onEdge) blendPixel(data, idx, er, eg, eb, alpha);
        else blendPixel(data, idx, r, g, b, alpha);
      }
    }
  }

  // 3. Vignette: cheap linear black ramp toward the canvas borders.
  for (let y = 0; y < OG_HEIGHT; y++) {
    const dy = Math.min(y, OG_HEIGHT - 1 - y);
    const rowIdx = y * OG_WIDTH;
    for (let x = 0; x < OG_WIDTH; x++) {
      const d = Math.min(Math.min(x, OG_WIDTH - 1 - x), dy);
      if (d >= VIGNETTE_PX) {
        // Row interior is uniform once past the ramp — skip to the far side.
        x = OG_WIDTH - 1 - VIGNETTE_PX;
        continue;
      }
      const a = VIGNETTE_MAX_ALPHA * (1 - d / VIGNETTE_PX);
      blendPixel(data, (rowIdx + x) * 4, 0, 0, 0, a);
    }
  }

  return PNG.sync.write(png);
}
