/**
 * Generates the PWA icons programmatically — no text, no emoji, no
 * binary assets in the repo. Each icon is a dark #0b1020 square (full
 * bleed, safe for maskable) with a centered stylized "mood globe": a
 * circle built from small grid squares colored along the app's
 * indigo → gray → amber valence ramp (shared/moods), plus a soft
 * alpha halo behind the globe.
 *
 * Usage: npx tsx scripts/generate-icons.ts
 * Output: public/icons/icon-192.png, public/icons/icon-512.png
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { valenceColor } from '../shared/moods';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const BG: readonly [number, number, number] = [0x0b, 0x10, 0x20];
/** Halo tint — warm amber pulled from the positive end of the ramp. */
const GLOW: readonly [number, number, number] = [0xf5, 0xb3, 0x4a];

function parseRgb(rgb: string): [number, number, number] {
  const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(rgb);
  if (!m) throw new Error(`unexpected color format: ${rgb}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Deterministic hash noise in [0, 1) — keeps output byte-stable. */
function noise(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function setPixel(png: PNG, x: number, y: number, r: number, g: number, b: number): void {
  const i = (png.width * y + x) << 2;
  png.data[i] = r;
  png.data[i + 1] = g;
  png.data[i + 2] = b;
  png.data[i + 3] = 255;
}

function renderIcon(size: number): PNG {
  const png = new PNG({ width: size, height: size });
  const cx = size / 2;
  const cy = size / 2;
  const R = size * 0.34; // globe radius — comfortably inside the maskable safe zone
  const halo = R * 1.45;

  // Background with a soft alpha halo around (and faintly inside) the globe.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx + 0.5, y - cy + 0.5);
      let [r, g, b] = BG;
      if (d < halo) {
        const t = d <= R ? 1 - ((R - d) / R) * 0.5 : 1 - (d - R) / (halo - R);
        const a = Math.max(0, t) ** 2 * 0.16;
        r = Math.round(r + (GLOW[0] - r) * a);
        g = Math.round(g + (GLOW[1] - g) * a);
        b = Math.round(b + (GLOW[2] - b) * a);
      }
      setPixel(png, x, y, r, g, b);
    }
  }

  // The globe: small grid squares inside the circle, valence ramping
  // west → east (indigo → gray → amber) with deterministic jitter, and
  // rim shading for a spherical feel.
  const cells = 14; // grid squares across the globe's diameter
  const cell = (R * 2) / cells;
  const pad = Math.max(1, Math.round(cell * 0.14));
  for (let gy = 0; gy < cells; gy++) {
    for (let gx = 0; gx < cells; gx++) {
      const x0 = cx - R + gx * cell;
      const y0 = cy - R + gy * cell;
      const ccx = x0 + cell / 2;
      const ccy = y0 + cell / 2;
      const d = Math.hypot(ccx - cx, ccy - cy);
      if (d > R - cell * 0.4) continue; // keep squares inside the circle
      const v = Math.max(-1, Math.min(1, ((ccx - cx) / R) * 0.95 + (noise(gx, gy) - 0.5) * 0.6));
      const [r, g, b] = parseRgb(valenceColor(v));
      const shade = 1 - (d / R) ** 2 * 0.45; // darker toward the rim
      const sr = Math.round(r * shade);
      const sg = Math.round(g * shade);
      const sb = Math.round(b * shade);
      const px0 = Math.round(x0) + pad;
      const py0 = Math.round(y0) + pad;
      const px1 = Math.round(x0 + cell) - pad;
      const py1 = Math.round(y0 + cell) - pad;
      for (let py = py0; py < py1; py++) {
        for (let px = px0; px < px1; px++) {
          if (px >= 0 && px < size && py >= 0 && py < size) setPixel(png, px, py, sr, sg, sb);
        }
      }
    }
  }
  return png;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [192, 512]) {
  const png = renderIcon(size);
  const file = join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, PNG.sync.write(png));
  console.log(`wrote ${file}`);
}
