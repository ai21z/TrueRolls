import { useEffect, useState } from 'react';
import {
  computeGuardedDistributionWasm,
  isKdCoreWasmReady,
  type KdCoreWasmDistribution,
} from '../../api/wasmEngine';
import type { Die } from '../../types/kd';
import css from './KappaBaseline.module.css';

/**
 * KappaBaseline - the "two readings of the die" (design note Part 5).
 *
 * Computes the receipt's die at kappa = 0 (flat, uniform by construction) and at
 * its actual kappa, both via the REAL kd-core WASM engine - the same math the
 * verifier recomputes. Shown side by side so anyone can see the neutral die is
 * flat and the stance only bends within the caps.
 *
 * Honesty: this is a transparency aid, NOT a fairness proof. It renders only when
 * the die is supported and kappa is a finite non-zero value (a kappa = 0 receipt
 * IS the baseline, so there is nothing to compare).
 */

const DICE = new Set<string>(['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100']);

interface KappaBaselineProps {
  die: string;
  kappa: number;
  ready: boolean;
}

interface Pair {
  flat: KdCoreWasmDistribution;
  stance: KdCoreWasmDistribution;
}

interface ReadingProps {
  title: string;
  name: string;
  caption: string;
  probs: number[];
  maxP: number;
  stance?: boolean;
}

function Reading({ title, name, caption, probs, maxP, stance }: ReadingProps) {
  return (
    <div className={`${css.panel} ${stance ? css.stancePanel : ''}`}>
      <div className={css.tag}>
        <span className={css.k}>{title}</span>
        <span className={css.name}>{name}</span>
      </div>
      <div className={css.caption}>{caption}</div>
      <div className={css.chart} role="img" aria-label={`${title}: ${probs.length}-face distribution`}>
        {probs.map((p, i) => (
          <div key={i} className={css.bar} title={`face ${i + 1}: ${(p * 100).toFixed(1)}%`}>
            <div
              className={stance ? css.fillStance : css.fillFlat}
              style={{ height: `${maxP > 0 ? (p / maxP) * 100 : 0}%` }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export function KappaBaseline({ die, kappa, ready }: KappaBaselineProps) {
  const supported = DICE.has(die) && Number.isFinite(kappa) && kappa !== 0;
  const [pair, setPair] = useState<Pair | null>(null);

  useEffect(() => {
    if (!ready || !supported || !isKdCoreWasmReady()) {
      setPair(null);
      return;
    }
    try {
      const flat = computeGuardedDistributionWasm(die as Die, 0);
      const stance = computeGuardedDistributionWasm(die as Die, kappa);
      setPair({ flat, stance });
    } catch {
      setPair(null);
    }
  }, [die, kappa, ready, supported]);

  if (!pair) return null;
  const maxP = Math.max(...pair.flat.probs, ...pair.stance.probs);

  return (
    <section className={css.wrap} aria-label="Two readings of the die">
      <div className={css.head}>
        <span className={css.eyebrow}>Two readings of the die</span>
        <span className={css.sub}>{die} - the neutral baseline vs this receipt&apos;s stance</span>
      </div>
      <div className={css.cols}>
        <Reading
          title="κ = 0"
          name="the original die"
          caption="neutral - uniform by construction"
          probs={pair.flat.probs}
          maxP={maxP}
        />
        <Reading
          title={`κ = ${kappa}`}
          name="this receipt's stance"
          caption={`α ${pair.stance.alpha.toFixed(2)} · KL ${pair.stance.kl.toFixed(2)} · EV ${pair.stance.ev.toFixed(1)}`}
          probs={pair.stance.probs}
          maxP={maxP}
          stance
        />
      </div>
      <div className={css.honest}>
        <span className={css.honestKey}>Educational, not proof of fairness</span>
        <span className={css.honestVal}>
          The seed is fixed <b>before</b> κ is applied; κ only widens or narrows the buckets within
          the KL/EV caps, and at κ = 0 it does nothing at all. The receipt carries the signed κ, and
          the verifier recomputes these exact bars. It does <b>not</b> prove the operator could not
          suppress an attempt.
        </span>
      </div>
    </section>
  );
}
