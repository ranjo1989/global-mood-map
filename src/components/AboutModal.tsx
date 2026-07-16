import { useEffect, useRef } from 'react';
import { K_ANONYMITY } from '@shared/types';

interface Props {
  open: boolean;
  /** Whether the world simulator is currently feeding the map. */
  simulated: boolean;
  /** Donations page from MetaResponse.supportUrl; null hides the link. */
  supportUrl: string | null;
  onClose: () => void;
}

/**
 * About / privacy dialog. Focus moves to the close button on open and is
 * restored to the previously focused element on close. Esc, backdrop
 * click, and the ✕ button all dismiss it.
 */
export function AboutModal({ open, simulated, supportUrl, onClose }: Props) {
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Backdrop dismissal must only fire when the press STARTED on the
  // backdrop — otherwise a text-selection drag out of the dialog closes it
  // (the browser fires click on the mousedown/mouseup common ancestor).
  const pressStartedOnBackdrop = useRef(false);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      // aria-modal promises focus containment — deliver it: wrap Tab
      // within the dialog's focusable elements.
      if (e.key === 'Tab' && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        const inside = active instanceof HTMLElement && dialogRef.current.contains(active);
        if (!inside) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      restoreRef.current?.focus();
      restoreRef.current = null;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        pressStartedOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && pressStartedOnBackdrop.current) onClose();
        pressStartedOnBackdrop.current = false;
      }}
    >
      <div
        ref={dialogRef}
        className="about-modal glass"
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-section-head">
          <h2 id="about-title">🌍 Global Mood Map</h2>
          <button
            type="button"
            ref={closeBtnRef}
            className="icon-btn"
            onClick={onClose}
            aria-label="close about dialog"
          >
            ✕
          </button>
        </div>

        <p className="about-blurb">
          A live, anonymous picture of how the planet feels. Anyone can drop a one-tap mood report; the map
          aggregates them into regional “emotional weather” — indigo where it’s gloomy, amber where it’s
          sunny — updated in real time, with a 24-hour scrubber to replay the day.
        </p>

        <h3 className="about-subhead">Privacy, by design</h3>
        <ul className="about-list">
          <li>
            Your location is snapped to a ~55 km grid cell <b>before</b> anything is stored — raw coordinates
            never touch the database.
          </li>
          <li>Regions with fewer than {K_ANONYMITY} reports are never shown, so no one can be singled out.</li>
          <li>
            Your IP address is used only in-memory — to estimate a coarse location and to rate-limit. It is
            never stored, logged, or linked to a report.
          </li>
          <li>Your personal mood log lives in this browser only and never leaves this device.</li>
          <li>
            The <span className="about-badge">SIMULATED DATA</span> badge means the reports on the map come
            from a built-in world simulator rather than real people
            {simulated ? ' — that’s what you’re seeing right now.' : '.'}
          </li>
        </ul>

        {supportUrl && (
          <a className="support-link" href={supportUrl} target="_blank" rel="noreferrer">
            <span className="support-heart" aria-hidden="true">
              ♥
            </span>{' '}
            Support this project
          </a>
        )}

        <p className="about-credits">
          Basemap © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>{' '}
          contributors, © <a href="https://carto.com/attributions" target="_blank" rel="noreferrer">CARTO</a>. This
          product includes GeoLite2 data created by MaxMind, available from{' '}
          <a href="https://www.maxmind.com" target="_blank" rel="noreferrer">maxmind.com</a>. Open source under MIT.
        </p>
      </div>
    </div>
  );
}
