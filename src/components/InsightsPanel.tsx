import { MOODS } from '@shared/moods';
import { parseCellId } from '@shared/grid';
import type { InsightsResponse, TrendsResponse } from '@shared/types';
import { TrendsChart } from './TrendsChart';
import { MyHistory } from './MyHistory';
import { continentName } from '../continents';
import { signedPct } from '../format';
import type { LocalHistoryEntry } from '../localHistory';

export type CellTrendState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; data: TrendsResponse }
  | { status: 'notfound' }
  | { status: 'error'; message: string };

interface Props {
  insights: InsightsResponse | null;
  globalTrends: TrendsResponse | null;
  selectedCell: string | null;
  cellTrend: CellTrendState;
  history: LocalHistoryEntry[];
  onClearSelection: () => void;
  onClearHistory: () => void;
}

function cellLabel(cellId: string): string {
  try {
    const c = parseCellId(cellId);
    return `${continentName(c.centerLat, c.centerLng)} · ${cellId}`;
  } catch {
    return cellId;
  }
}

export function InsightsPanel({
  insights,
  globalTrends,
  selectedCell,
  cellTrend,
  history,
  onClearSelection,
  onClearHistory,
}: Props) {
  const topMoods = insights?.global.topMoods ?? [];
  const movers = insights?.movers ?? [];
  const maxCount = topMoods.reduce((m, t) => Math.max(m, t.count), 1);

  return (
    <div className="insights">
      {selectedCell && (
        <section className="panel-section selected-section">
          <div className="panel-section-head">
            <h3>Selected region · 24 h</h3>
            <button type="button" className="link-btn" onClick={onClearSelection}>
              close
            </button>
          </div>
          <div className="cell-id-label">{cellLabel(selectedCell)}</div>
          {cellTrend.status === 'loading' && <p className="muted">loading trend…</p>}
          {cellTrend.status === 'notfound' && <p className="muted">not enough data for this region</p>}
          {cellTrend.status === 'error' && <p className="muted">couldn’t load this region’s trend</p>}
          {cellTrend.status === 'ok' && <TrendsChart points={cellTrend.data.points} id="cell" />}
        </section>
      )}

      <section className="panel-section">
        <h3>Planet · last 24 h</h3>
        {globalTrends ? (
          <TrendsChart points={globalTrends.points} id="global" />
        ) : (
          <div className="chart-empty">loading…</div>
        )}
      </section>

      <section className="panel-section">
        <h3>Top moods now</h3>
        {topMoods.length === 0 ? (
          <p className="muted">no data yet</p>
        ) : (
          <ul className="mood-bars">
            {topMoods.map((t) => {
              const def = MOODS[t.mood];
              if (!def) return null;
              return (
                <li key={t.mood} className="mood-bar-row">
                  <span className="mood-bar-emoji">{def.emoji}</span>
                  <span className="mood-bar-name">{def.label}</span>
                  <span className="mood-bar-track">
                    <span
                      className="mood-bar-fill"
                      style={{ width: `${(t.count / maxCount) * 100}%`, background: def.color }}
                    />
                  </span>
                  <span className="mood-bar-count">{t.count}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="panel-section">
        <h3>Top movers</h3>
        {movers.length === 0 ? (
          <p className="muted">nothing shifting right now</p>
        ) : (
          <ul className="movers">
            {movers.map((m) => (
              <li key={m.cellId} className="mover-row">
                <span className="mover-label" title={`${m.count} reports`}>
                  {m.label}
                </span>
                <span className={`mover-delta ${m.deltaValence >= 0 ? 'up' : 'down'}`}>
                  {m.deltaValence >= 0 ? '↑' : '↓'} {signedPct(m.deltaValence)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <MyHistory entries={history} onClear={onClearHistory} />
    </div>
  );
}
