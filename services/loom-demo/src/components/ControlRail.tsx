import { useState } from 'react';
import type { Die } from '../types/kd';
import { kappaHint } from '../constants/caps';
import { InkFrame } from '../landing/system/InkFrame';
import { InkButton } from '../landing/system/InkButton';
import css from './ControlRail.module.css';

const DICE: Die[] = ['d6', 'd20', 'd100'];

const KAPPA_TICKS = [-1, -0.5, 0, 0.5, 1] as const;

/** Snap to a tick when the dragged value lands close to it (esp. zero). */
function snapKappa(v: number): number {
  for (const t of KAPPA_TICKS) {
    if (Math.abs(v - t) < 0.03) return t;
  }
  return v;
}

interface Props {
  die: Die;
  kappa: number;
  mock: boolean;
  /** API unreachable and nothing simulated (production builds). */
  unavailable?: boolean;
  onDieChange: (d: Die) => void;
  onKappaChange: (k: number) => void;
}

export function ControlRail({ die, kappa, mock, unavailable = false, onDieChange, onKappaChange }: Props) {
  const hint = kappaHint(kappa);
  const [showKappaHelp, setShowKappaHelp] = useState(false);

  return (
    <aside className={css.rail}>
      <div className={css.section}>
        <span className={css.label}>Die</span>
        <div className={css.dieGroup} role="group" aria-label="Die">
          {DICE.map((d, i) => (
            <InkButton
              key={d}
              inline={false}
              seed={70 + i}
              frameClassName={`${css.dieBtnWrap} ${d === die ? css.dieBtnWrapActive : ''}`}
              className={`${css.dieBtn} ${d === die ? css.dieBtnActive : ''}`}
              aria-pressed={d === die}
              onClick={() => onDieChange(d)}
            >
              {d}
            </InkButton>
          ))}
        </div>
      </div>

      <div className={css.section}>
        <div className={css.labelRow}>
          <span className={css.label}>Karma (κ)</span>
          <InkButton
            seed={73}
            className={css.helpBtn}
            onClick={() => setShowKappaHelp((s) => !s)}
            aria-label="What is Karma?"
            aria-expanded={showKappaHelp}
            aria-controls="kappa-help"
          >
            ?
          </InkButton>
        </div>
        {showKappaHelp && (
          <div id="kappa-help" className={css.helpText} role="note">
            <strong>Karma (κ)</strong> tilts the die within bounded, auditable caps.
            At κ=0 the die is perfectly uniform. Positive values tilt toward high
            faces. Negative values tilt toward low faces. Guards ensure the tilt
            never exceeds the KL-divergence and expected-value caps.
          </div>
        )}
        <div className={css.sliderWrap}>
          <div className={css.sliderRow}>
            <div className={css.sliderTrack}>
              <input
                type="range"
                className={css.slider}
                min={-1}
                max={1}
                step={0.01}
                value={kappa}
                aria-label="Karma value"
                aria-valuemin={-1}
                aria-valuemax={1}
                aria-valuenow={kappa}
                aria-valuetext={`${kappa.toFixed(2)}, ${hint}`}
                onChange={(e) => onKappaChange(snapKappa(parseFloat(e.target.value)))}
                onDoubleClick={() => onKappaChange(0)}
                title="Double-click to reset to neutral"
              />
              {/* Tick marks are drawn under the track and never take a pointer, so a
                  drag that starts near one still moves the slider. */}
              <div className={css.ticks} aria-hidden="true">
                {KAPPA_TICKS.map((t) => (
                  <span
                    key={t}
                    className={[
                      css.tick,
                      t === 0 ? css.tickZero : '',
                      Math.abs(kappa - t) < 0.02 ? css.tickActive : '',
                    ].join(' ')}
                    style={{ left: `calc(${((t + 1) / 2) * 100}% + ${(0.5 - (t + 1) / 2) * 16}px)` }}
                  />
                ))}
              </div>
            </div>
            <span className={css.kappaValue} aria-hidden="true">{kappa.toFixed(2)}</span>
          </div>
          <div className={css.presets} role="group" aria-label="Karma presets">
            {KAPPA_TICKS.map((t) => (
              <button
                key={t}
                type="button"
                className={`${css.preset} ${Math.abs(kappa - t) < 0.02 ? css.presetActive : ''}`}
                aria-pressed={Math.abs(kappa - t) < 0.02}
                aria-label={t === 0 ? 'Set karma to 0, uniform' : `Set karma to ${t > 0 ? '+' : ''}${t}`}
                onClick={() => onKappaChange(t)}
              >
                {t === 0 ? '0' : `${t > 0 ? '+' : '−'}${Math.abs(t)}`}
              </button>
            ))}
          </div>
          <span className={css.kappaHint}>{hint}</span>
        </div>
      </div>

      <div className={css.section}>
        <span className={css.label}>Connection</span>
        <InkFrame inline seed={74} className={`${css.badge} ${mock || unavailable ? css.badgeMock : css.badgeLive}`}>
          <span className={`${css.dot} ${mock || unavailable ? css.dotMock : css.dotLive}`} />
          {mock ? 'Demo mode' : unavailable ? 'API unavailable' : 'API live'}
        </InkFrame>
      </div>

    </aside>
  );
}
