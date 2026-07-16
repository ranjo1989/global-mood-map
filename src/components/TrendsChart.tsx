import { valenceColor } from '@shared/moods';
import type { TrendPoint } from '@shared/types';
import { signedPct } from '../format';

interface Props {
  points: TrendPoint[];
  /** unique per chart instance — SVG gradient ids are document-global */
  id: string;
  height?: number;
}

const W = 320;

/**
 * Pure inline-SVG valence sparkline: gradient-colored line + soft area.
 * Buckets with count 0 (no reports, or k-anonymity-suppressed) are gaps,
 * not data — plotting them as valence 0 would fabricate neutral plunges.
 */
export function TrendsChart({ points, id, height = 84 }: Props) {
  const active = points
    .map((p, i) => ({ i, valence: p.valence, count: p.count }))
    .filter((p) => p.count > 0);
  if (points.length < 2 || active.length === 0) {
    return <div className="chart-empty">not enough data yet</div>;
  }
  const H = height;
  const padX = 4;
  const padY = 8;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const p of active) {
    if (p.valence < minV) minV = p.valence;
    if (p.valence > maxV) maxV = p.valence;
  }
  if (maxV - minV < 0.05) {
    const mid = (maxV + minV) / 2;
    minV = mid - 0.05;
    maxV = mid + 0.05;
  }
  const x = (i: number) => padX + (i / (points.length - 1)) * (W - padX * 2);
  const y = (v: number) => padY + (1 - (v - minV) / (maxV - minV)) * (H - padY * 2);

  // Split into contiguous runs of buckets that actually have data.
  const segments: Array<Array<{ i: number; valence: number }>> = [];
  let run: Array<{ i: number; valence: number }> = [];
  for (const p of points.map((pt, i) => ({ i, valence: pt.valence, count: pt.count }))) {
    if (p.count > 0) {
      run.push(p);
    } else if (run.length > 0) {
      segments.push(run);
      run = [];
    }
  }
  if (run.length > 0) segments.push(run);

  const linePath = (seg: Array<{ i: number; valence: number }>) =>
    seg.map((p, j) => `${j === 0 ? 'M' : 'L'}${x(p.i).toFixed(1)},${y(p.valence).toFixed(1)}`).join(' ');
  const areaPath = (seg: Array<{ i: number; valence: number }>) =>
    `${linePath(seg)} L${x(seg[seg.length - 1].i).toFixed(1)},${H - 1} L${x(seg[0].i).toFixed(1)},${H - 1} Z`;

  const gradId = `trend-grad-${id}`;

  return (
    <div className="trends-chart-wrap" style={{ height }}>
      <svg
        className="trends-chart"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="valence trend over time"
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="0">
            {active.map((p) => (
              <stop
                key={p.i}
                offset={`${((p.i / (points.length - 1)) * 100).toFixed(2)}%`}
                stopColor={valenceColor(p.valence)}
              />
            ))}
          </linearGradient>
        </defs>
        {segments.map((seg) =>
          seg.length > 1 ? (
            <g key={seg[0].i}>
              <path d={areaPath(seg)} fill={`url(#${gradId})`} opacity={0.16} />
              <path
                d={linePath(seg)}
                fill="none"
                stroke={`url(#${gradId})`}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ) : (
            // An isolated bucket has no line to join — mark it with a dot.
            <circle
              key={seg[0].i}
              cx={x(seg[0].i)}
              cy={y(seg[0].valence)}
              r={2.4}
              fill={valenceColor(seg[0].valence)}
            />
          ),
        )}
      </svg>
      <span className="chart-label chart-label-max">{signedPct(maxV)}</span>
      <span className="chart-label chart-label-min">{signedPct(minV)}</span>
    </div>
  );
}
