import type { Die } from '../types/kd';

/**
 * Display constants only. All math (softmax, guard solving, KL/EV,
 * prefix-CDF sampling) lives in kd-core and is consumed through the
 * kd-core-wasm engine (see src/api/wasmEngine.ts), no math duplication here.
 */

/** KL divergence caps (nats) per die size, from spec v1.3.1. */
export const KL_CAPS: Record<Die, number> = {
  d6: 0.060,
  d20: 0.035,
  d100: 0.025,
};

/** EV cap expressed as fraction of uniform SD, from spec v1.3.1. */
export const EV_CAP_SIGMA = 0.20;

/** Face count per die. */
export const FACES: Record<Die, number> = { d6: 6, d20: 20, d100: 100 };

/**
 * Human-readable hint for κ ∈ [-1, 1].
 * Negative κ tilts toward LOW faces, positive κ toward HIGH faces.
 * Guards cap the tilt either way.
 */
export function kappaHint(kappa: number): string {
  const mag = Math.abs(kappa);
  if (mag < 0.05) return 'Neutral';
  const dir = kappa > 0 ? 'high faces' : 'low faces';
  if (mag < 0.2) return `Slight tilt → ${dir}`;
  if (mag < 0.5) return `Mild tilt → ${dir}`;
  if (mag < 0.8) return `Strong tilt → ${dir}`;
  return `Maximum tilt → ${dir}`;
}
