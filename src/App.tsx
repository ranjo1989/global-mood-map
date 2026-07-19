import { useCallback, useEffect, useRef, useState } from 'react';
import type { MoodId, TagId } from '@shared/moods';
import { DEFAULT_WINDOW_MINS, RETENTION_HOURS } from '@shared/types';
import type { AggregatesResponse, InsightsResponse, MetaResponse, TrendsResponse } from '@shared/types';
import {
  ApiRequestError,
  fetchAggregates,
  fetchCellTrends,
  fetchGlobalTrends,
  fetchInsights,
  fetchMeta,
} from './api';
import { useStream } from './useStream';
import { addHistoryEntry, clearHistory, loadHistory, type LocalHistoryEntry } from './localHistory';
import { MoodMap, type LivePulse } from './components/MoodMap';
import { MoodPicker } from './components/MoodPicker';
import { AboutModal } from './components/AboutModal';
import { InsightsPanel, type CellTrendState } from './components/InsightsPanel';
import { TimeScrubber } from './components/TimeScrubber';
import { PulseTicker, type PulseChip } from './components/PulseTicker';
import { Legend } from './components/Legend';
import { compactCount } from './format';
import { moodWord } from './moodWord';
import { shareSnapshot } from './share';

interface Toast {
  key: number;
  msg: string;
  kind: 'ok' | 'warn' | 'err';
}

/**
 * Deep links: /?at=<epochMs> opens with the scrubber AT that moment.
 * Anything unparsable, in the future, or beyond retention falls back to
 * live mode (and the URL-sync effect below scrubs the bad param away).
 */
function initialScrubAt(): number | null {
  const raw = new URLSearchParams(window.location.search).get('at');
  if (raw === null || raw === '') return null;
  const at = Number(raw);
  if (!Number.isFinite(at)) return null;
  const now = Date.now();
  if (at >= now || at < now - RETENTION_HOURS * 3_600_000) return null;
  return Math.round(at);
}

export function App() {
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [insights, setInsights] = useState<InsightsResponse | null>(null);
  const [aggregates, setAggregates] = useState<AggregatesResponse | null>(null);
  const [globalTrends, setGlobalTrends] = useState<TrendsResponse | null>(null);
  const [res, setRes] = useState(0);
  /** null = live mode; otherwise the epoch ms the scrubber points at */
  const [scrubAt, setScrubAt] = useState<number | null>(initialScrubAt);
  const [sharing, setSharing] = useState(false);
  const [selectedCell, setSelectedCell] = useState<string | null>(null);
  const [cellTrend, setCellTrend] = useState<CellTrendState>({ status: 'idle' });
  const [pulses, setPulses] = useState<PulseChip[]>([]);
  const [history, setHistory] = useState<LocalHistoryEntry[]>(() => loadHistory());
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth > 920);
  const [picking, setPicking] = useState(false);
  const [pickedLocation, setPickedLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [reportPulse, setReportPulse] = useState<{ cellId: string; key: number } | null>(null);
  const [livePulse, setLivePulse] = useState<LivePulse | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);

  const mapCenterRef = useRef({ lat: 25, lng: 10 });
  const resRef = useRef(res);
  const scrubRef = useRef(scrubAt);
  const selectedCellRef = useRef(selectedCell);
  const metaRef = useRef(meta);
  metaRef.current = meta;
  const aggSeq = useRef(0);
  const insSeq = useRef(0);
  const trendSeq = useRef(0);
  const pulseKey = useRef(1);
  const updateTimer = useRef<number | null>(null);
  const toastTimer = useRef<number | null>(null);

  const showToast = useCallback((msg: string, kind: 'ok' | 'warn' | 'err' = 'ok') => {
    setToast({ key: Date.now(), msg, kind });
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4200);
  }, []);

  const refreshAggregates = useCallback(async () => {
    const seq = ++aggSeq.current;
    try {
      const data = await fetchAggregates(resRef.current, DEFAULT_WINDOW_MINS, scrubRef.current ?? undefined);
      if (seq === aggSeq.current) setAggregates(data);
    } catch {
      // transient failure — keep the last good aggregates on screen
    }
  }, []);

  const refreshInsights = useCallback(async () => {
    const seq = ++insSeq.current;
    try {
      const data = await fetchInsights();
      if (seq === insSeq.current) setInsights(data);
    } catch {
      // keep the last good insights
    }
  }, []);

  const refreshGlobalTrends = useCallback(async () => {
    const seq = trendSeq.current + 1;
    trendSeq.current = seq;
    try {
      const data = await fetchGlobalTrends(24);
      if (seq === trendSeq.current) setGlobalTrends(data);
    } catch {
      // keep the last good trends
    }
  }, []);

  const refreshCellTrend = useCallback(async (cellId: string, silent = false) => {
    if (!silent) setCellTrend({ status: 'loading' });
    try {
      const data = await fetchCellTrends(cellId, 24);
      if (selectedCellRef.current === cellId) setCellTrend({ status: 'ok', data });
    } catch (err) {
      if (selectedCellRef.current !== cellId) return;
      // A background refresh must never replace a rendered chart with an
      // error state — keep the last good data like the other refreshers.
      if (silent) return;
      if (err instanceof ApiRequestError && err.status === 404) {
        setCellTrend({ status: 'notfound' });
      } else {
        setCellTrend({ status: 'error', message: err instanceof Error ? err.message : 'failed' });
      }
    }
  }, []);

  // Initial data.
  useEffect(() => {
    fetchMeta()
      .then(setMeta)
      .catch(() => {});
    void refreshInsights();
    void refreshGlobalTrends();
  }, [refreshInsights, refreshGlobalTrends]);

  // Aggregates: on load, on zoom-res change, and on scrubber moves
  // (debounced a little while dragging through history).
  useEffect(() => {
    resRef.current = res;
    scrubRef.current = scrubAt;
    const delay = scrubAt === null ? 0 : 250;
    const id = window.setTimeout(() => void refreshAggregates(), delay);
    return () => window.clearTimeout(id);
  }, [res, scrubAt, refreshAggregates]);

  // Keep the URL shareable: ?at=<epochMs> while scrubbed, clean when live.
  // replaceState so scrubbing never pollutes the back-button history.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (scrubAt === null) {
      if (!url.searchParams.has('at')) return;
      url.searchParams.delete('at');
    } else {
      url.searchParams.set('at', String(Math.round(scrubAt)));
    }
    window.history.replaceState(window.history.state, '', url);
  }, [scrubAt]);

  // Selected cell → fetch its 24h trend.
  useEffect(() => {
    selectedCellRef.current = selectedCell;
    if (!selectedCell) {
      setCellTrend({ status: 'idle' });
      return;
    }
    void refreshCellTrend(selectedCell);
  }, [selectedCell, refreshCellTrend]);

  // Live stream: 'update' triggers a debounced refetch (live mode only),
  // 'pulse' feeds the ticker.
  const { connected } = useStream({
    onUpdate: () => {
      if (scrubRef.current !== null) return; // paused while viewing history
      if (updateTimer.current !== null) return; // ~1s debounce
      updateTimer.current = window.setTimeout(() => {
        updateTimer.current = null;
        if (scrubRef.current !== null) return;
        void refreshAggregates();
        void refreshInsights();
        void refreshGlobalTrends();
        // Self-heal a failed initial meta fetch, else the "SIMULATED DATA"
        // disclosure could silently stay hidden for the whole session.
        if (!metaRef.current) fetchMeta().then(setMeta).catch(() => {});
        const sel = selectedCellRef.current;
        if (sel) void refreshCellTrend(sel, true);
      }, 1000);
    },
    onPulse: (p) => {
      const key = pulseKey.current++;
      setPulses((prev) => [{ ...p, key }, ...prev].slice(0, 5));
      // Map ripples are skipped while scrubbing history.
      if (scrubRef.current === null) setLivePulse({ cellId: p.cellId, mood: p.mood, key });
    },
  });

  // Clear pending timers on unmount.
  useEffect(
    () => () => {
      if (updateTimer.current !== null) window.clearTimeout(updateTimer.current);
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    },
    [],
  );

  const handleResChange = useCallback((r: number) => setRes((prev) => (prev === r ? prev : r)), []);
  const handleSelectCell = useCallback((cellId: string | null) => setSelectedCell(cellId), []);
  const handleCenterChange = useCallback((c: { lat: number; lng: number }) => {
    mapCenterRef.current = c;
  }, []);
  const handlePick = useCallback((lat: number, lng: number) => {
    setPickedLocation({ lat: Math.round(lat * 10) / 10, lng: Math.round(lng * 10) / 10 });
    setPicking(false);
  }, []);
  const handleReported = useCallback(
    (r: { cellId: string; mood: MoodId; tag?: TagId }) => {
      const entry: LocalHistoryEntry = { t: Date.now(), mood: r.mood, cellId: r.cellId };
      if (r.tag) entry.tag = r.tag;
      setHistory(addHistoryEntry(entry));
      setReportPulse({ cellId: r.cellId, key: Date.now() });
      showToast('Thanks — you’re part of the weather now', 'ok');
    },
    [showToast],
  );
  const handleClearHistory = useCallback(() => {
    clearHistory();
    setHistory([]);
  }, []);
  const handleScrub = useCallback((at: number) => setScrubAt(at), []);
  const handleLive = useCallback(() => setScrubAt(null), []);
  const handleCloseAbout = useCallback(() => setAboutOpen(false), []);

  // Snapshot card: compose the share PNG from the live map pixels plus the
  // current global mood, at the scrubbed moment (or now when live).
  const handleShare = useCallback(async () => {
    if (sharing) return;
    setSharing(true);
    try {
      const outcome = await shareSnapshot({
        at: scrubAt ?? Date.now(),
        valence: insights ? insights.global.valence : null,
        reportsLastHour: insights ? insights.global.count : null,
      });
      if (outcome === 'saved-link-copied') showToast('Snapshot saved — link copied', 'ok');
      else if (outcome === 'saved') showToast('Snapshot saved', 'ok');
      // 'shared' and 'cancelled' surface through the native share sheet.
    } catch {
      showToast('Could not create the snapshot — try again once the map has loaded.', 'err');
    } finally {
      setSharing(false);
    }
  }, [sharing, scrubAt, insights, showToast]);

  const gm = insights ? moodWord(insights.global.valence) : null;

  return (
    <div className={`app${panelOpen ? ' panel-open' : ''}`}>
      <MoodMap
        cells={aggregates?.cells ?? []}
        selectedCellId={selectedCell}
        picking={picking}
        reportPulse={reportPulse}
        livePulse={livePulse}
        onResChange={handleResChange}
        onSelectCell={handleSelectCell}
        onPick={handlePick}
        onCenterChange={handleCenterChange}
      />

      <header className="topbar glass">
        <h1 className="app-title">🌍 Global Mood Map</h1>
        {gm && insights && (
          <span className="mood-chip" title="planet-wide average mood over the last hour">
            <b>
              {gm.word} {gm.emoji}
            </b>
            <span className="mood-chip-count">{compactCount(insights.global.count)} reports/hr</span>
          </span>
        )}
        {meta?.simulated && (
          <span
            className="sim-badge"
            title="All reports currently on the map come from a built-in world simulator, not real people."
          >
            SIMULATED DATA
          </span>
        )}
        <span className="topbar-spacer" />
        <button type="button" className="panel-toggle" onClick={() => setAboutOpen(true)}>
          About
        </button>
        <button type="button" className="panel-toggle" onClick={() => setPanelOpen((v) => !v)}>
          {panelOpen ? 'Hide insights' : 'Insights'}
        </button>
      </header>

      <Legend />

      <aside className={`side-panel glass${panelOpen ? '' : ' side-panel-closed'}`} aria-hidden={!panelOpen}>
        <InsightsPanel
          insights={insights}
          globalTrends={globalTrends}
          selectedCell={selectedCell}
          cellTrend={cellTrend}
          history={history}
          onClearSelection={() => setSelectedCell(null)}
          onClearHistory={handleClearHistory}
        />
      </aside>

      <MoodPicker
        getDefaultLocation={() => mapCenterRef.current}
        picking={picking}
        pickedLocation={pickedLocation}
        onRequestPick={() => {
          setPickedLocation(null);
          setPicking(true);
        }}
        onCancelPick={() => setPicking(false)}
        onReported={handleReported}
        onToast={showToast}
      />

      <div className="bottombar glass">
        <TimeScrubber
          live={scrubAt === null}
          at={scrubAt}
          connected={connected}
          onScrub={handleScrub}
          onLive={handleLive}
        />
        <button
          type="button"
          className="share-btn"
          onClick={() => void handleShare()}
          disabled={sharing}
          aria-label="share a snapshot of the map"
          title="Save a snapshot card of this moment"
        >
          <span className="share-btn-emoji" aria-hidden="true">
            📸
          </span>
          <span className="share-btn-label">{sharing ? 'Sharing…' : 'Share'}</span>
        </button>
        <PulseTicker pulses={pulses} />
      </div>

      {picking && (
        <div className="pick-hint glass">
          Click anywhere on the map to set your location ·{' '}
          <button type="button" className="link-btn" onClick={() => setPicking(false)}>
            cancel
          </button>
        </div>
      )}

      {toast && (
        <div key={toast.key} className={`toast toast-${toast.kind}`} role="status">
          {toast.msg}
        </div>
      )}

      <AboutModal
        open={aboutOpen}
        simulated={!!meta?.simulated}
        supportUrl={meta?.supportUrl ?? null}
        supportCrypto={meta?.supportCrypto ?? []}
        onClose={handleCloseAbout}
      />
    </div>
  );
}
