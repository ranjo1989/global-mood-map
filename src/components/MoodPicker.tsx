import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { MOOD_LIST, TAG_IDS, type MoodId, type TagId } from '@shared/moods';
import type { GeoResponse, MoodReportInput } from '@shared/types';
import { ApiRequestError, fetchGeo, postReport } from '../api';
import { getLastReportAt, setLastReportAt } from '../localHistory';

const COOLDOWN_MS = 30_000;

/**
 * Location modes:
 * - auto:   server estimates a coarse area from the connection (no coords sent)
 * - device: browser geolocation, coarsened on-device before sending
 * - center: current map center
 * - map:    explicit pick on the map
 */
type LocMode = 'auto' | 'device' | 'center' | 'map';

type GeoState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; geo: GeoResponse }
  | { status: 'none' };

interface Props {
  getDefaultLocation: () => { lat: number; lng: number };
  picking: boolean;
  pickedLocation: { lat: number; lng: number } | null;
  onRequestPick: () => void;
  onCancelPick: () => void;
  onReported: (r: { cellId: string; mood: MoodId; tag?: TagId }) => void;
  onToast: (msg: string, kind?: 'ok' | 'warn' | 'err') => void;
}

function remainingCooldown(): number {
  const last = getLastReportAt();
  if (last === null) return 0;
  return Math.max(0, Math.ceil((last + COOLDOWN_MS - Date.now()) / 1000));
}

/** Round to 1 decimal (~11 km) so precise coordinates never leave the device. */
function coarsen(loc: { lat: number; lng: number }): { lat: number; lng: number } {
  const lat = Math.max(-90, Math.min(90, Math.round(loc.lat * 10) / 10));
  const wrapped = ((((loc.lng + 180) % 360) + 360) % 360) - 180;
  return { lat, lng: Math.round(wrapped * 10) / 10 };
}

function devicePosition(): Promise<{ lat: number; lng: number }> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('geolocation unavailable'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => reject(new Error(err.message || 'location denied')),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 600_000 },
    );
  });
}

export function MoodPicker({
  getDefaultLocation,
  picking,
  pickedLocation,
  onRequestPick,
  onCancelPick,
  onReported,
  onToast,
}: Props) {
  const [open, setOpen] = useState(false);
  const [mood, setMood] = useState<MoodId | null>(null);
  const [tag, setTag] = useState<TagId | null>(null);
  const [locMode, setLocMode] = useState<LocMode>('auto');
  const [geoState, setGeoState] = useState<GeoState>({ status: 'idle' });
  const [submitting, setSubmitting] = useState(false);
  const [cooldownLeft, setCooldownLeft] = useState(() => remainingCooldown());

  // Live values for async handlers — a submit can resolve after the panel
  // was closed or the mode was switched, and must not act on stale state.
  const openRef = useRef(open);
  openRef.current = open;
  const locModeRef = useRef(locMode);
  locModeRef.current = locMode;

  const coolingDown = cooldownLeft > 0;
  useEffect(() => {
    if (!coolingDown) return;
    const id = window.setInterval(() => setCooldownLeft(remainingCooldown()), 1000);
    return () => window.clearInterval(id);
  }, [coolingDown]);

  // On open, ask the server what coarse area it would assign this
  // connection. null (404) → fall back to map center with a hint.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setGeoState({ status: 'loading' });
    fetchGeo()
      .then((geo) => {
        if (cancelled) return;
        if (geo) {
          setGeoState({ status: 'ok', geo });
        } else {
          setGeoState({ status: 'none' });
          setLocMode((m) => (m === 'auto' ? 'center' : m));
        }
      })
      .catch(() => {
        if (cancelled) return;
        setGeoState({ status: 'none' });
        setLocMode((m) => (m === 'auto' ? 'center' : m));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    if (locMode === 'map') onCancelPick();
  };

  const submit = async () => {
    if (!mood || submitting || cooldownLeft > 0) return;
    setSubmitting(true);
    try {
      let body: MoodReportInput;
      if (locMode === 'auto') {
        // No coordinates at all — the server derives a snapped cell from
        // the connection, in memory only.
        body = tag ? { mood, tag } : { mood };
      } else {
        let loc: { lat: number; lng: number };
        if (locMode === 'device') {
          try {
            loc = await devicePosition();
          } catch {
            onToast('Couldn’t get your device location — using the map center instead.', 'warn');
            loc = getDefaultLocation();
          }
        } else if (locMode === 'map') {
          if (!pickedLocation) {
            onToast('Click a spot on the map first.', 'warn');
            return;
          }
          loc = pickedLocation;
        } else {
          loc = getDefaultLocation();
        }
        const { lat, lng } = coarsen(loc);
        body = tag ? { mood, lat, lng, tag } : { mood, lat, lng };
      }
      const res = await postReport(body);
      setLastReportAt(Date.now());
      setCooldownLeft(remainingCooldown());
      onReported(tag ? { cellId: res.cellId, mood, tag } : { cellId: res.cellId, mood });
      setMood(null);
      setTag(null);
      setOpen(false);
      if (locMode === 'map') onCancelPick();
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 422) {
        onToast('We couldn’t estimate your location — pick a spot on the map instead.', 'warn');
        // Only steer into pick-on-map mode if the panel is still open and
        // still in auto mode — otherwise the app would enter pick mode
        // with no picker visible.
        if (openRef.current && locModeRef.current === 'auto') {
          setLocMode('map');
          onRequestPick();
        }
      } else if (err instanceof ApiRequestError && err.status === 429) {
        onToast('Easy there — try again in a minute.', 'warn');
      } else {
        onToast(err instanceof Error ? err.message : 'Something went wrong.', 'err');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const autoSub =
    geoState.status === 'ok'
      ? geoState.geo.label
        ? `reporting ${geoState.geo.label}`
        : `reporting near ${geoState.geo.lat.toFixed(1)}, ${geoState.geo.lng.toFixed(1)}`
      : geoState.status === 'loading'
        ? 'estimating your area…'
        : geoState.status === 'none'
          ? 'couldn’t estimate your location'
          : undefined;

  const locBtn = (mode: LocMode, icon: string, label: string, sub?: string, onSelect?: () => void) => (
    <button
      type="button"
      className={`loc-btn${locMode === mode ? ' loc-btn-on' : ''}`}
      onClick={() => {
        setLocMode(mode);
        if (mode !== 'map') onCancelPick();
        onSelect?.();
      }}
    >
      <span className="loc-btn-main">
        <span aria-hidden="true">{icon}</span> {label}
      </span>
      {sub && <span className="loc-sub">{sub}</span>}
    </button>
  );

  const disabled = !mood || submitting || cooldownLeft > 0;

  return (
    <>
      {open && (
        <div className="mood-panel glass">
          <div className="panel-section-head">
            <h2>How do you feel?</h2>
            <button type="button" className="icon-btn" onClick={close} aria-label="close mood picker">
              ✕
            </button>
          </div>

          <div className="mood-grid">
            {MOOD_LIST.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`mood-btn${mood === m.id ? ' mood-btn-on' : ''}`}
                style={{ '--mood-color': m.color } as CSSProperties}
                onClick={() => setMood(mood === m.id ? null : m.id)}
              >
                <span className="mood-btn-emoji">{m.emoji}</span>
                <span className="mood-btn-label">{m.label}</span>
              </button>
            ))}
          </div>

          <div className="picker-label">
            What’s it about? <span className="muted">(optional)</span>
          </div>
          <div className="tag-row">
            {TAG_IDS.map((t) => (
              <button
                key={t}
                type="button"
                className={`tag-chip${tag === t ? ' tag-chip-on' : ''}`}
                onClick={() => setTag(tag === t ? null : t)}
              >
                #{t}
              </button>
            ))}
          </div>

          <div className="picker-label">Location</div>
          <div className="loc-options">
            {locBtn('auto', '📡', 'Approximate (auto)', autoSub)}
            {locBtn('device', '📍', 'Device location')}
            {locBtn('center', '🗺️', 'Map center')}
            {locBtn('map', '🎯', 'Pick on map', undefined, onRequestPick)}
          </div>
          {locMode === 'auto' && (
            <div className="loc-status muted">no coordinates sent — the server estimates a ~55 km area</div>
          )}
          {locMode === 'center' && geoState.status === 'none' && (
            <div className="loc-status muted">couldn’t estimate your location — using the map center</div>
          )}
          {locMode === 'device' && <div className="loc-status muted">rounded to ~10 km before sending</div>}
          {locMode === 'map' && (
            <div className="loc-status muted">
              {pickedLocation
                ? `picked ${pickedLocation.lat.toFixed(1)}, ${pickedLocation.lng.toFixed(1)}`
                : picking
                  ? 'now click anywhere on the map…'
                  : 'select “Pick on map” again to choose a spot'}
            </div>
          )}

          <button type="button" className="submit-btn" disabled={disabled} onClick={() => void submit()}>
            {cooldownLeft > 0
              ? `Wait ${cooldownLeft}s`
              : submitting
                ? 'Sending…'
                : 'Send anonymous report'}
          </button>
          <p className="privacy-note">
            Anonymous — locations are snapped to a ~55 km grid before storage. In auto mode your IP is used
            once, in memory only, to estimate a coarse area. Nothing else is stored.
          </p>
        </div>
      )}

      <button
        type="button"
        className="mood-fab"
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
      >
        <span className="mood-fab-emoji" aria-hidden="true">
          😊
        </span>
        How do you feel?
      </button>
    </>
  );
}
