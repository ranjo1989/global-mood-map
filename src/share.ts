import { compactCount } from './format';
import { moodWord } from './moodWord';

/**
 * Snapshot cards: compose a 1200×630 share image entirely client-side on
 * a 2D canvas — the live map pixels (MoodMap creates its Map with
 * preserveDrawingBuffer and parks it on window.__moodMap), a dark scrim,
 * and the current global mood — then hand it to the native share sheet
 * when available, else download it and copy a deep link.
 *
 * Everything here is local: no network, no external fonts, CSP-safe.
 */

const W = 1200;
const H = 630;
const BG = '#0b1020';
const MARGIN = 48;
const FONT_STACK =
  "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, " +
  "'Apple Color Emoji', 'Segoe UI Emoji', sans-serif";

export interface SnapshotInput {
  /** The moment the card depicts, epoch ms (scrubbed moment, or now when live). */
  at: number;
  /** Global mean valence (-1..1); null when insights haven't loaded. */
  valence: number | null;
  /** Reports in the last hour; null when insights haven't loaded. */
  reportsLastHour: number | null;
}

export type ShareOutcome =
  | 'shared' // native share sheet completed
  | 'cancelled' // user dismissed the native share sheet
  | 'saved-link-copied' // PNG downloaded + deep link on the clipboard
  | 'saved'; // PNG downloaded, clipboard unavailable

/** Minimal structural view of the MapLibre map MoodMap exposes. */
interface MapHandle {
  getCanvas(): HTMLCanvasElement;
}

function liveMapCanvas(): HTMLCanvasElement | null {
  const map = (window as unknown as { __moodMap?: MapHandle }).__moodMap;
  if (!map || typeof map.getCanvas !== 'function') return null;
  try {
    const canvas = map.getCanvas();
    return canvas.width > 0 && canvas.height > 0 ? canvas : null;
  } catch {
    return null;
  }
}

/** Current URL with ?at=<moment> — the deep link the server turns into OG tags. */
export function deepLinkFor(at: number): string {
  const url = new URL(window.location.href);
  url.searchParams.set('at', String(Math.round(at)));
  return url.toString();
}

function composeCard(input: SnapshotInput): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.');

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  // Map pixels, cover-fit and centered.
  const src = liveMapCanvas();
  if (src) {
    const scale = Math.max(W / src.width, H / src.height);
    const dw = src.width * scale;
    const dh = src.height * scale;
    ctx.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }

  // Dark gradient scrim over the bottom third so the overlay text reads.
  const scrim = ctx.createLinearGradient(0, H * 0.52, 0, H);
  scrim.addColorStop(0, 'rgba(4, 7, 17, 0)');
  scrim.addColorStop(0.5, 'rgba(4, 7, 17, 0.55)');
  scrim.addColorStop(1, 'rgba(4, 7, 17, 0.92)');
  ctx.fillStyle = scrim;
  ctx.fillRect(0, H * 0.52, W, H * 0.48);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.shadowColor = 'rgba(2, 6, 18, 0.85)';
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 2;

  // Brand, top-left.
  ctx.fillStyle = '#e6ebf5';
  ctx.font = `600 34px ${FONT_STACK}`;
  ctx.fillText('🌍 Global Mood Map', MARGIN, 82);

  // Big mood word + emoji.
  if (input.valence !== null) {
    const gm = moodWord(input.valence);
    ctx.fillStyle = '#f5f7ff';
    ctx.font = `700 92px ${FONT_STACK}`;
    ctx.fillText(`${gm.word} ${gm.emoji}`, MARGIN, H - 168);
  }

  // Reports-per-hour subline.
  if (input.reportsLastHour !== null) {
    ctx.fillStyle = '#c7d0e0';
    ctx.font = `500 32px ${FONT_STACK}`;
    ctx.fillText(`${compactCount(input.reportsLastHour)} reports/hr`, MARGIN, H - 104);
  }

  // Timestamp (local date + time of the depicted moment).
  ctx.fillStyle = '#94a3b8';
  ctx.font = `400 26px ${FONT_STACK}`;
  const stamp = new Date(input.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  ctx.fillText(stamp, MARGIN, H - 52);

  // Site URL, bottom-right.
  ctx.textAlign = 'right';
  ctx.fillStyle = '#c7d0e0';
  ctx.font = `600 26px ${FONT_STACK}`;
  ctx.fillText(window.location.host, W - MARGIN, H - 52);
  ctx.textAlign = 'left';

  return canvas;
}

function encodePng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the snapshot PNG.'))),
      'image/png',
    );
  });
}

function downloadBlob(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a); // Firefox requires the anchor in the DOM
  a.click();
  a.remove();
  // Revoke after the download has had a chance to start.
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
}

/**
 * Compose the card and hand it off: native share sheet with the file when
 * supported (mobile), else download the PNG and copy the deep link.
 */
export async function shareSnapshot(input: SnapshotInput): Promise<ShareOutcome> {
  const blob = await encodePng(composeCard(input));
  const filename = `global-mood-${new Date(input.at).toISOString().slice(0, 10)}.png`;
  const deepLink = deepLinkFor(input.at);

  if (typeof navigator.share === 'function' && typeof navigator.canShare === 'function') {
    const file = new File([blob], filename, { type: 'image/png' });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Global Mood Map', url: deepLink });
        return 'shared';
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
        // Share sheet failed for another reason — fall through to download.
      }
    }
  }

  downloadBlob(blob, filename);
  try {
    await navigator.clipboard.writeText(deepLink);
    return 'saved-link-copied';
  } catch {
    return 'saved'; // clipboard blocked (permissions / insecure context)
  }
}
