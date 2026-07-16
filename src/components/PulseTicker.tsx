import { MOODS } from '@shared/moods';
import { parseCellId } from '@shared/grid';
import type { PulseEvent } from '@shared/types';
import { continentName } from '../continents';

export interface PulseChip extends PulseEvent {
  key: number;
}

function regionOf(cellId: string): string {
  try {
    const c = parseCellId(cellId); // pulse cellIds are always res 0
    return continentName(c.centerLat, c.centerLng);
  } catch {
    return 'somewhere';
  }
}

export function PulseTicker({ pulses }: { pulses: PulseChip[] }) {
  return (
    <div className="pulse-ticker" aria-label="latest mood pulses">
      {pulses.length === 0 ? (
        <span className="pulse-chip pulse-chip-empty">listening for pulses…</span>
      ) : (
        pulses.map((p, i) => {
          const mood = MOODS[p.mood];
          return (
            <span key={p.key} className="pulse-chip" style={{ opacity: 1 - i * 0.17 }}>
              <span className="pulse-emoji">{mood ? mood.emoji : '💭'}</span>
              {regionOf(p.cellId)}
            </span>
          );
        })
      )}
    </div>
  );
}
