import { K_ANONYMITY } from '@shared/types';

export function Legend() {
  return (
    <div className="legend glass">
      <div className="legend-bar" aria-hidden="true" />
      <div className="legend-row">
        <span>gloomy</span>
        <span>sunny</span>
      </div>
      <div className="legend-note">regions with &lt;{K_ANONYMITY} reports stay hidden</div>
    </div>
  );
}
