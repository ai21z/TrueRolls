import { useEffect, useState } from 'react';
import {
  computeGuardedDistributionWasm,
  isKdCoreWasmReady,
  type KdCoreWasmDistribution,
} from '../../api/wasmEngine';
import type { Die } from '../../types/kd';
import css from './KappaBaseline.module.css';

/**
 * KappaBaseline, the "two readings of the die" (design note Part 5).
 *
 * Computes the receipt's die at kappa = 0 (flat, uniform by construction) and at
 * its actual kappa, both via the REAL kd-core WASM engine, the same math the
 * verifier recomputes. Shown side by side so anyone can see the neutral die is
 * flat and the stance only bends within the caps.
 *
 * Honesty: this is a transparency aid, NOT a fairness proof, and NOT a same-roll
 * counterfactual. kappa is bound into the seed derivation (kd-drand `hkdf_info`),
 * so a different kappa would yield a different seed and draw entirely, these two
 * bars are a property-of-the-die distribution comparison, not "this roll with the
 * stance removed". It renders only when the receipt verified VALID, the die is
 * supported, and kappa is a finite non-zero value (a kappa = 0 receipt IS the
 * baseline, so there is nothing to compare).
 */

const DICE = new Set<string>(['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100']);

interface KappaBaselineProps {
  die: string;
  kappa: number;
  /** Render only when the receipt verified VALID, never present a rejected receipt's stance. */
  valid: boolean;
  /** Beacon-backed (drand) receipt, gates the seed-binding claim (legacy has no drand-seed check). */
  beacon: boolean;
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
  const lo = Math.min(...probs);
  const hi = Math.max(...probs);
  const shape =
    hi - lo < 1e-9
      ? `uniform, each face ${(hi * 100).toFixed(1)}%`
      : `from ${(lo * 100).toFixed(1)}% (lowest face) to ${(hi * 100).toFixed(1)}% (highest)`;
  return (
    <div className={`${css.panel} ${stance ? css.stancePanel : ''}`}>
      <div className={css.tag}>
        <span className={css.k}>{title}</span>
        <span className={css.name}>{name}</span>
      </div>
      <div className={css.caption}>{caption}</div>
      <div
        className={css.chart}
        role="img"
        aria-label={`${title}: ${probs.length}-face distribution, ${shape}`}
      >
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

export function KappaBaseline({ die, kappa, valid, beacon }: KappaBaselineProps) {
  const supported = DICE.has(die) && Number.isFinite(kappa) && kappa !== 0;
  const [pair, setPair] = useState<Pair | null>(null);

  useEffect(() => {
    if (!valid || !supported || !isKdCoreWasmReady()) {
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
  }, [die, kappa, valid, supported]);

  if (!pair) return null;
  const maxP = Math.max(...pair.flat.probs, ...pair.stance.probs);

  return (
    <section className={css.wrap} aria-label="Two distributions for this die">
      <div className={css.head}>
        <span className={css.eyebrow}>Two distributions for this die</span>
        <span className={css.sub}>{die}, the neutral baseline (κ = 0) vs this receipt&apos;s signed stance</span>
      </div>
      <div className={css.cols}>
        <Reading
          title="κ = 0"
          name="the original die"
          caption="neutral, uniform by construction"
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
        <span className={css.honestKey}>What κ does, in the open</span>
        <span className={css.honestVal}>
          {beacon ? (
            <>
              κ is a <b>signed, public</b> input bound into the seed derivation <b>and</b> the guarded
              distribution, so it cannot be retuned after the beacon without breaking both the
              signature and the drand-seed check.
            </>
          ) : (
            <>
              κ is a <b>signed, public</b> input to the guarded distribution, carried in the signed
              receipt body, so it cannot be changed without breaking the signature.
            </>
          )}{' '}
          These are the two distributions the engine produces for this die: flat at κ = 0, bent within
          the KL/EV caps at this κ. The verifier recomputes these exact bars. It is a property of the
          die, <b>not</b> a re-draw of this roll.
        </span>
      </div>
    </section>
  );
}
