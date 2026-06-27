import { useState, useEffect, useMemo, useId } from 'react';
import type { Die, TranscriptEntry } from '../types/kd';
import { KL_CAPS, EV_CAP_SIGMA } from '../constants/caps';
import { computeGuardedDistributionWasm } from '../api/wasmEngine';
import { InkFrame } from '../landing/system/InkFrame';
import { InkButton } from '../landing/system/InkButton';
import { makeAura } from '../landing/system/seed';
import css from './Stage.module.css';

// The filled seed-socket: the SAME rooting-seed specimen as the trust panel's empty
// socket, but here the live result lands in it. Off-axis so it reads as excavated.
const SK = { cx: 130, cy: 104, r: 46 };
const SEED_AURA = makeAura(SK.cx, SK.cy, SK.r, 22);

/** Format small numbers so they don't display as "0.0000" when non-zero. */
function formatSmall(value: number, digits: number): string {
  if (value === 0) return '0';
  const fixed = value.toFixed(digits);
  // If toFixed rounds to all zeros but value isn't zero, show scientific
  if (parseFloat(fixed) === 0) return value.toExponential(1);
  return fixed;
}

interface BarData {
  value: number;     // normalized probability (or sum for bins)
  label: string;     // tooltip text
  isRolled: boolean;  // highlight this bar?
}

/** Bin probabilities for large die sizes so bars remain readable. */
function buildBars(probs: number[], rolledFace: number | null): BarData[] {
  // d6/d20: one bar per face
  if (probs.length <= 20) {
    const max = Math.max(...probs);
    return probs.map((p, i) => ({
      value: max > 0 ? p / max : 0,
      label: `Face ${i + 1}: ${(p * 100).toFixed(1)}%`,
      isRolled: rolledFace === i + 1,
    }));
  }

  // d100+: bin into groups of 5 → 20 bars
  const binSize = 5;
  const bins: BarData[] = [];
  let maxBin = 0;
  for (let b = 0; b < probs.length; b += binSize) {
    const end = Math.min(b + binSize, probs.length);
    let sum = 0;
    let rolled = false;
    for (let i = b; i < end; i++) {
      sum += probs[i];
      if (rolledFace === i + 1) rolled = true;
    }
    if (sum > maxBin) maxBin = sum;
    bins.push({
      value: sum,
      label: `Faces ${b + 1} to ${end}: ${(sum * 100).toFixed(1)}%`,
      isRolled: rolled,
    });
  }
  // Normalize
  for (const bin of bins) {
    bin.value = maxBin > 0 ? bin.value / maxBin : 0;
  }
  return bins;
}

interface Props {
  latestRoll: TranscriptEntry | null;
  isRolling: boolean;
  rollStatus: string | null;
  onRoll: () => void;
  rollError: string | null;
  die: Die;
  kappa: number;
  /** The latest die has been broken by a tamper anywhere on the page. */
  broken: boolean;
  /** The forged face the tampered receipt carries — shown in place of the roll when broken. */
  brokenFace: number | null;
}

export function Stage({ latestRoll, isRolling, rollStatus, onRoll, rollError, die, kappa, broken, brokenFace }: Props) {
  const [animKey, setAnimKey] = useState(0);
  const uid = useId().replace(/[:]/g, '');
  const voidId = `seed-void-${uid}`;
  const emberId = `seed-ember-${uid}`;

  const latestLocalId = latestRoll?.localId;
  // The face shown in the socket: the roll, or the forged value when broken.
  const faceShown = broken && brokenFace != null ? brokenFace : latestRoll?.face;

  useEffect(() => {
    if (latestLocalId != null) setAnimKey((k) => k + 1);
  }, [latestLocalId]);

  const klCap = KL_CAPS[die];

  // Bars always live-track the current slider for visual feedback.
  // The preview shows the GUARDED distribution from kd-core (wasm) — the
  // same caps-applied probabilities the server samples from — not the raw
  // softmax, which would overstate the tilt once guards engage.
  const probs = useMemo(() => {
    try {
      return computeGuardedDistributionWasm(die, kappa).probs;
    } catch (err) {
      // Engine not initialized (init failure) — render no bars rather than
      // falling back to duplicated TS math.
      console.error('[kd] distribution preview unavailable:', err);
      return [];
    }
  }, [die, kappa]);

  // Only highlight the rolled face when the current slider matches the roll's params.
  // When broken, highlight the forged face the tampered receipt claims, so the bar
  // and the socket agree.
  const rollMatchesSlider = latestRoll
    && latestRoll.die === die
    && Math.abs(latestRoll.kappa - kappa) < 0.02;
  const highlightFace = rollMatchesSlider ? (faceShown ?? null) : null;

  const bars = useMemo(
    () => buildBars(probs, highlightFace),
    [probs, highlightFace],
  );
  const isNeutral = latestRoll ? latestRoll.alpha > 0.99 : Math.abs(kappa) < 0.05;

  return (
    <section className={css.stage}>
      <div className={css.faceWrap}>
        <svg
          className={`${css.seed} ${isRolling ? css.seedRolling : ''} ${broken ? css.seedBroken : ''}`}
          viewBox="0 0 260 248"
          role="img"
          aria-label={
            broken && latestRoll
              ? `Tampered: ${latestRoll.die} shows ${faceShown}. The receipt no longer matches its signature.`
              : latestRoll
                ? `Result ${latestRoll.face} on ${latestRoll.die}`
                : 'No roll yet'
          }
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <radialGradient id={voidId} cx="50%" cy="52%" r="58%">
              <stop offset="0%" stopColor="#050505" />
              <stop offset="74%" stopColor="#08070a" />
              <stop offset="100%" stopColor="#100c08" />
            </radialGradient>
            <radialGradient id={emberId} cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor={broken ? '#d65a5f' : '#e6a064'} stopOpacity={latestRoll ? 0.85 : 0.16} />
              <stop offset="48%" stopColor={broken ? '#b5474d' : '#b87242'} stopOpacity={latestRoll ? 0.28 : 0.05} />
              <stop offset="100%" stopColor={broken ? '#b5474d' : '#b87242'} stopOpacity="0" />
            </radialGradient>
          </defs>

          <text className={css.seedEyebrow} x="18" y="22">{broken ? 'Tampered' : 'Result'}</text>

          {/* concentric engraved aura */}
          <g aria-hidden="true">
            {SEED_AURA.map((a, i) => (
              <circle key={`a-${i}`} cx={a.cx} cy={a.cy} r={a.r} fill="none" stroke={a.col} strokeWidth={a.sw} opacity={a.op} />
            ))}
          </g>

          {/* the socket: void backdrop, ember glow, live face */}
          <circle cx={SK.cx} cy={SK.cy} r={SK.r} fill={`url(#${voidId})`} />
          <circle className={css.seedRim} cx={SK.cx} cy={SK.cy} r={SK.r} />
          <circle cx={SK.cx} cy={SK.cy} r={SK.r - 9} fill={`url(#${emberId})`} />

          {/* broken: a blood-red scar cracks the socket */}
          {broken && (
            <path
              className={css.seedScar}
              d={`M${SK.cx - 30},${SK.cy - 24} L${SK.cx - 6},${SK.cy + 4} L${SK.cx - 18},${SK.cy + 12} L${SK.cx + 14},${SK.cy + 34}`}
            />
          )}

          {latestRoll ? (
            <text
              key={animKey}
              className={`${css.seedFace} ${css.seedFaceNew} ${broken ? css.seedFaceBroken : ''}`}
              x={SK.cx}
              y={SK.cy}
              textAnchor="middle"
              dominantBaseline="central"
            >
              {faceShown}
            </text>
          ) : (
            <text
              className={css.seedPlaceholder}
              x={SK.cx}
              y={SK.cy}
              textAnchor="middle"
              dominantBaseline="central"
            >
              —
            </text>
          )}
        </svg>
      </div>

      {/* Visually-hidden live status: announces each roll to screen readers. */}
      {latestRoll && (
        <div className={css.srOnly} role="status" aria-live="polite">
          {`Rolled ${latestRoll.face} on ${latestRoll.die}. Alpha ${formatSmall(latestRoll.alpha, 4)}, ` +
            `KL ${formatSmall(latestRoll.kl, 5)}, expected value ${latestRoll.ev.toFixed(3)}.`}
        </div>
      )}

      {/* Distribution preview bars */}
      <div className={css.distBars} aria-label="Probability distribution preview">
        {bars.map((bar, i) => (
          <div
            key={i}
            className={`${css.distBar} ${bar.isRolled ? css.distBarRolled : ''}`}
            style={{ height: `${bar.value * 100}%` }}
            title={bar.label}
          />
        ))}
      </div>

      <div className={`${css.meta} ${latestRoll ? css.metaVisible : ''}`}>
        {latestRoll && (
          <>
            <InkFrame seed={91} className={css.metaItem}>
              <span className={css.metaLabel}>Die</span>
              <span className={css.metaValue}>{latestRoll.die}</span>
            </InkFrame>
            <InkFrame seed={92} className={css.metaItem}>
              <span className={css.metaLabel}>Alpha (mix)</span>
              <span className={css.metaValue}>{formatSmall(latestRoll.alpha, 4)}</span>
            </InkFrame>
            <InkFrame seed={93} className={css.metaItem}>
              <span className={css.metaLabel}>KL divergence</span>
              <span className={css.metaValue}>{formatSmall(latestRoll.kl, 5)}</span>
            </InkFrame>
            <InkFrame seed={94} className={css.metaItem}>
              <span className={css.metaLabel}>Expected value</span>
              <span className={css.metaValue}>{latestRoll.ev.toFixed(3)}</span>
            </InkFrame>
          </>
        )}
      </div>

      {/* Fairness contract badge */}
      <div className={`${css.fairnessBadge} ${latestRoll ? css.fairnessBadgeVisible : ''}`}>
        {isNeutral ? (
          <InkFrame inline seed={95} className={css.fairnessNeutral}>Neutral</InkFrame>
        ) : (
          <InkFrame inline seed={96} className={css.fairnessShaped}>
            Shaped (bounded) · KL ≤ {klCap} · EV ≤ {EV_CAP_SIGMA}σ
          </InkFrame>
        )}
      </div>

      <InkButton
        seed={97}
        frameClassName={css.inkDark}
        className={`${css.rollBtn} ${isRolling ? css.rollBtnRolling : ''}`}
        onClick={onRoll}
        disabled={isRolling}
      >
        {isRolling ? (rollStatus ?? 'Rolling…') : 'Roll'}
      </InkButton>

      {rollError && (
        <div className={css.rollError} role="alert" aria-live="assertive">
          {rollError}
        </div>
      )}
    </section>
  );
}
