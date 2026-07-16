import { MOODS } from '@shared/moods';
import { parseCellId } from '@shared/grid';
import { continentName } from '../continents';
import { relativeTime } from '../format';
import type { LocalHistoryEntry } from '../localHistory';

interface Props {
  entries: LocalHistoryEntry[];
  onClear: () => void;
}

function regionOf(cellId: string): string {
  try {
    const c = parseCellId(cellId);
    return continentName(c.centerLat, c.centerLng);
  } catch {
    return '';
  }
}

export function MyHistory({ entries, onClear }: Props) {
  return (
    <section className="my-history">
      <div className="panel-section-head">
        <h3>My mood log</h3>
        {entries.length > 0 && (
          <button type="button" className="link-btn" onClick={onClear}>
            clear
          </button>
        )}
      </div>
      {entries.length === 0 ? (
        <p className="muted">No reports yet — tap “How do you feel?” to add one.</p>
      ) : (
        <ul className="history-list">
          {entries.slice(0, 8).map((e) => {
            const mood = MOODS[e.mood];
            const region = regionOf(e.cellId);
            return (
              <li key={e.t} className="history-item">
                <span className="history-emoji">{mood.emoji}</span>
                <span className="history-main">
                  {mood.label}
                  {e.tag ? <span className="history-tag">#{e.tag}</span> : null}
                </span>
                <span className="history-meta">
                  {region ? `${region} · ` : ''}
                  {relativeTime(e.t)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="privacy-note">🔒 stored only on this device</p>
    </section>
  );
}
