import { clockTime } from '../format';

const WINDOW_MINS = 24 * 60;

interface Props {
  live: boolean;
  /** epoch ms of the scrubbed window end; null while live */
  at: number | null;
  connected: boolean;
  onScrub: (at: number) => void;
  onLive: () => void;
}

export function TimeScrubber({ live, at, connected, onScrub, onLive }: Props) {
  const now = Date.now();
  const value =
    live || at === null
      ? WINDOW_MINS
      : Math.max(0, Math.min(WINDOW_MINS, WINDOW_MINS - Math.round((now - at) / 60000)));
  const hoursAgo = at === null ? 0 : Math.round(((now - at) / 3600000) * 10) / 10;

  return (
    <div className="time-scrubber">
      <button
        type="button"
        className={`live-btn${live ? ' live-btn-on' : ''}`}
        onClick={onLive}
        title={connected ? 'streaming live updates' : 'reconnecting to the stream…'}
      >
        <span className={`live-dot${live && connected ? ' live-dot-on' : ''}`} />
        LIVE
      </button>
      <input
        className="scrub-range"
        type="range"
        min={0}
        max={WINDOW_MINS}
        step={5}
        value={value}
        onChange={(e) => {
          const v = Number(e.currentTarget.value);
          if (v >= WINDOW_MINS) onLive();
          else onScrub(Date.now() - (WINDOW_MINS - v) * 60000);
        }}
        aria-label="time scrubber over the last 24 hours"
      />
      <span className="scrub-label">
        {live || at === null ? 'now' : `${clockTime(at)} · ${hoursAgo}h ago`}
      </span>
    </div>
  );
}
