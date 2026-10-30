import { lazy, Suspense, useEffect, useState } from 'react';
import { m, useReducedMotion, useTransform } from 'framer-motion';
import type { useKarmaState } from '../../hooks/useKarmaState';
import type { HeroPhase } from '../three/HeroCanvas';
import { HERO_RECEIPT_ID, HeroCredential } from './HeroCredential';
import { RollErrorNotice, RollProgressLine } from '../../components/RollProgressLine';
import { receiptVerifierAccepts } from '../../api/receipt';
import { isMockArtifact } from '../../api/trustPresentation';
import type { TranscriptEntry } from '../../types/kd';
import { usePageScrollProgress } from '../useScrollMotion';
import { InkButton } from '../system/InkButton';
import { DecorBoundary } from '../DecorBoundary';
import css from './Hero.module.css';

// The copy is painted at full opacity from the first frame (it is the page's
// largest content); only a small slide plays. The visual column fades in.
const enterCopy = {
  initial: { y: 12 },
  animate: { y: 0 },
};
const enter = {
  initial: { opacity: 0, y: 18 },
  animate: { opacity: 1, y: 0 },
};

/**
 * The decorative 3D die is the largest download on the page. Start fetching it
 * only once the verifier engine has settled (it is needed for real checks) and
 * the browser is idle, so it never competes with the content or the engine.
 */
function useDeferredHeroCanvas(engine: string): boolean {
  const [go, setGo] = useState(false);
  useEffect(() => {
    if (go || (engine !== 'ready' && engine !== 'failed')) return;
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(() => setGo(true), { timeout: 1500 });
      return () => w.cancelIdleCallback?.(id);
    }
    const t = window.setTimeout(() => setGo(true), 200);
    return () => window.clearTimeout(t);
  }, [engine, go]);
  return go;
}

/** The API check of a just-completed roll, in words. The hero shows it next to the
 * button that asked for the roll; the browser verifier is a separate, explicit step. */
function apiCheckText(entry: TranscriptEntry, signed: boolean): string {
  if (!signed) return 'Demo receipt with no signature, so nothing was checked.';
  switch (entry.verifyStatus) {
    case 'verified_server':
      return 'Checked by the TrueRolls API: Verified.';
    case 'mismatch':
      return 'The TrueRolls API reported a mismatch for this receipt.';
    case 'error':
      return 'The API check did not answer. The receipt is unchanged.';
    default:
      return 'Checking the receipt with the TrueRolls API…';
  }
}

const HeroCanvas = lazy(() =>
  import('../three/HeroCanvas').then((m) => ({ default: m.HeroCanvas })),
);

// Shown until the die arrives, and for good if its code fails to download or render.
const placeholder = (
  <div className={css.visualPlaceholder} data-hero-placeholder>
    <div className={css.placeholderDie} />
  </div>
);

interface Props {
  state: ReturnType<typeof useKarmaState>;
  onSeeProof: () => void;
  onOpenPlayground: () => void;
}

export function Hero({ state, onSeeProof, onOpenPlayground }: Props) {
  // The credential drives idle/settled/sealed. Rolling overrides live. While an
  // edited copy of the latest receipt is on screen, the die shows that copy's
  // fracture; the original receipt keeps its own status in the credential, and
  // discarding the copy returns the die to the original's phase.
  const [credPhase, setCredPhase] = useState<HeroPhase>('idle');
  const latestRoll = state.rolls.length > 0 ? state.rolls[0] : null;
  // Only a copy the verifier actually rejected fractures the die; a copy that is
  // still being checked, or that failed to be checked, does not.
  const copy = latestRoll != null && state.editedCopy?.localId === latestRoll.localId ? state.editedCopy : null;
  const copyRejected =
    copy?.status === 'checked' && copy.result != null && !receiptVerifierAccepts(copy.body, copy.result);
  const phase: HeroPhase = state.isRolling ? 'rolling' : copyRejected ? 'tampered' : credPhase;
  const nonD20 = latestRoll != null && latestRoll.die !== 'd20';

  // The result of the roll this button asked for, while it is still the latest roll.
  const heroResult =
    !state.isRolling &&
    state.rollError?.origin !== 'hero' &&
    state.lastRoll?.origin === 'hero' &&
    latestRoll?.localId === state.lastRoll.localId
      ? latestRoll
      : null;
  const heroResultSigned = heroResult != null && !!heroResult.sig && !isMockArtifact(heroResult) && !state.mock;

  const reduce = useReducedMotion();
  const showReceipt = () => {
    const card = document.getElementById(HERO_RECEIPT_ID);
    if (!card) return;
    card.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    card.focus({ preventScroll: true });
  };
  const showCanvas = useDeferredHeroCanvas(state.engine);
  const progress = usePageScrollProgress();
  // The hero is the first viewport. Parallax the die over the early scroll range.
  const dieY = useTransform(progress, [0, 0.16], ['0%', '-24%']);
  const dieOpacity = useTransform(progress, [0, 0.15], [1, 0.3]);

  return (
    <section className={css.hero} aria-label="TrueRolls">
      <div className={css.inner}>
        <m.div
          className={css.copy}
          {...enterCopy}
          transition={{ duration: 0.7, ease: [0.32, 0.72, 0, 1] }}
        >
          <span className={css.eyebrow}>TrueRolls · verifiable dice receipts for games</span>
          <h1 className={css.title}>
            Roll. Sign.<br />
            <span className={css.titleAccent}>Try to fake it.</span>
          </h1>
          <p className={css.lead}>
            Every completed roll returns a signed, drand-backed receipt players can verify
            locally. Public beacon seed, Ed25519 signature, deterministic offline replay.
            Change a signed value and verification fails.
          </p>
          <div className={css.ctaRow}>
            <InkButton
              seed={61}
              frameClassName={css.inkDark}
              className={css.ctaPrimary}
              onClick={() => void state.roll('hero')}
              disabled={state.isRolling}
            >
              {state.isRolling ? 'Rolling…' : 'Roll a die'}
            </InkButton>
            <InkButton seed={62} className={css.ctaSecondary} onClick={onSeeProof}>
              See the proof
            </InkButton>
          </div>
          <div className={css.rollSlot}>
            {state.isRolling && state.rollOrigin === 'hero' ? (
              <RollProgressLine progress={state.rollProgress} />
            ) : state.rollError?.origin === 'hero' ? (
              <RollErrorNotice error={state.rollError} onDismiss={state.clearRollError} />
            ) : heroResult ? (
              <div className={css.rollResult} data-roll-result={heroResultSigned ? heroResult.verifyStatus : 'demo'}>
                <span className={css.rollResultFace}>
                  {heroResult.face} on {heroResult.die} · receipt received
                </span>
                <button type="button" className={css.rollResultLink} onClick={showReceipt}>
                  Show the receipt
                </button>
              </div>
            ) : null}
            {/* Always mounted so the API check result is announced when it lands. The
                face itself is announced once by the playground's roll status. */}
            <p className={css.rollStatus} role="status">
              {heroResult ? apiCheckText(heroResult, heroResultSigned) : ''}
            </p>
          </div>
          <p className={css.trust}>
            Public drand seed · deterministic offline replay · in-browser verifier.{' '}
            <br className={css.trustBreak} />
            Uniform at κ 0, bounded only when a stance is signed in the open.
          </p>
        </m.div>

        <m.div
          className={css.visual}
          {...enter}
          transition={{ duration: 0.7, ease: [0.32, 0.72, 0, 1], delay: 0.12 }}
        >
          <m.div
            className={css.canvasWrap}
            aria-hidden="true"
            style={reduce ? undefined : { y: dieY, opacity: dieOpacity }}
          >
            {showCanvas ? (
              <DecorBoundary fallback={placeholder}>
                <Suspense fallback={placeholder}>
                  <HeroCanvas
                    phase={phase}
                    kappa={Math.abs(state.kappa)}
                    face={latestRoll?.face ?? null}
                    die={latestRoll?.die ?? null}
                  />
                </Suspense>
              </DecorBoundary>
            ) : (
              placeholder
            )}
          </m.div>
          {(nonD20 || copyRejected) && (
            <p className={css.canvasCaption}>
              {copyRejected
                ? 'The fracture shows the edited copy failing. The original receipt is unchanged.'
                : `Decorative d20. Your ${latestRoll?.die} result is ${latestRoll?.face}.`}
            </p>
          )}
          <HeroCredential state={state} onPhase={setCredPhase} />
        </m.div>
      </div>

      <button className={css.scrollHint} onClick={onOpenPlayground} aria-label="Scroll to playground">
        <span>Open the playground</span>
        <span className={css.scrollChevron} aria-hidden="true">↓</span>
      </button>
    </section>
  );
}
