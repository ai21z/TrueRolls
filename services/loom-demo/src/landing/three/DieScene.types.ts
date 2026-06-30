/**
 * Shared prop types for the TrueRolls hero 3D scene.
 *
 * `HeroCanvas` is the public component the landing hero mounts. `DieScene`
 * is the inner R3F scene rendered as a child of <Canvas>. Both are driven by
 * the same `phase` flow so the hero can mirror its roll/verify/tamper state.
 */

/**
 * The hero's high-level state, driven by the roll/verify/tamper flow.
 *
 * - `idle`     - at rest. Die floats and slowly rotates.
 * - `rolling`  - die tumbles fast across multiple axes.
 * - `settled`  - tumble decays to a fixed resting orientation.
 * - `sealed`   - a glowing credential ring forms around the calm die.
 * - `tampered` - the seal + die shatter into shards. Accent flips to danger red.
 */
export type HeroPhase = 'idle' | 'rolling' | 'settled' | 'sealed' | 'tampered';

/** Public prop contract for the hero's marquee 3D visual. */
export interface HeroCanvasProps {
  /** Driven by the hero's roll/verify/tamper flow. */
  phase: HeroPhase;
  /**
   * Optional 0..1 stance. Tilts lighting / accent intensity slightly so the
   * scene can echo the κ slider. Clamped internally. Default 0.
   */
  kappa?: number;
  /**
   * The rolled face (1..20). When set, the die settles showing this face toward
   * the camera. Null/undefined or out of range → a generic resting pose.
   */
  face?: number | null;
  /** Host sizing comes from CSS, the canvas fills its container. */
  className?: string;
}

/** Props for the inner scene (everything below the <Canvas>). */
export interface DieSceneProps {
  phase: HeroPhase;
  /** Already clamped to 0..1 by the host. */
  kappa: number;
  /** The rolled face (1..20). The die settles showing it toward the camera. */
  face?: number | null;
  /**
   * When true, render a single static composed frame (settled die + seal,
   * no float/tumble/shatter loops) for `prefers-reduced-motion`.
   */
  reducedMotion: boolean;
}
