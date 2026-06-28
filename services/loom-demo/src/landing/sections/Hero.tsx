import { lazy, Suspense, useState } from 'react';
import { motion, useReducedMotion, useTransform } from 'framer-motion';
import type { useKarmaState } from '../../hooks/useKarmaState';
import type { HeroPhase } from '../three/HeroCanvas';
import { HeroCredential } from './HeroCredential';
import { usePageScrollProgress } from '../useScrollMotion';
import { InkButton } from '../system/InkButton';
import css from './Hero.module.css';

const enter = {
  initial: { opacity: 0, y: 18 },
  animate: { opacity: 1, y: 0 },
};

const HeroCanvas = lazy(() =>
  import('../three/HeroCanvas').then((m) => ({ default: m.HeroCanvas })),
);

interface Props {
  state: ReturnType<typeof useKarmaState>;
  onSeeProof: () => void;
  onOpenPlayground: () => void;
}

export function Hero({ state, onSeeProof, onOpenPlayground }: Props) {
  // The credential drives idle/settled/sealed; rolling overrides live. The header
  // die is roll-agnostic until a roll is recorded - but if THAT roll is broken by a
  // tamper anywhere on the page, the die shatters here too (shared tamper state).
  const [credPhase, setCredPhase] = useState<HeroPhase>('idle');
  const latestRoll = state.rolls.length > 0 ? state.rolls[0] : null;
  const broken = latestRoll?.tampered != null;
  const phase: HeroPhase = state.isRolling ? 'rolling' : broken ? 'tampered' : credPhase;

  const reduce = useReducedMotion();
  const progress = usePageScrollProgress();
  // The hero is the first viewport; parallax the die over the early scroll range.
  const dieY = useTransform(progress, [0, 0.16], ['0%', '-24%']);
  const dieOpacity = useTransform(progress, [0, 0.15], [1, 0.3]);

  return (
    <section className={css.hero} aria-label="TrueRolls">
      <div className={css.inner}>
        <motion.div
          className={css.copy}
          {...enter}
          transition={{ duration: 0.7, ease: [0.32, 0.72, 0, 1] }}
        >
          <span className={css.eyebrow}>Verifiable dice · TrueRolls</span>
          <h1 className={css.title}>
            Roll. Sign.<br />
            <span className={css.titleAccent}>Try to fake it.</span>
          </h1>
          <p className={css.lead}>
            Every roll returns an Ed25519-signed receipt. Change a single byte and the
            signature shatters. And you can verify it yourself, offline.
          </p>
          <div className={css.ctaRow}>
            <InkButton
              seed={61}
              frameClassName={css.inkDark}
              className={css.ctaPrimary}
              onClick={() => state.roll()}
              disabled={state.isRolling}
            >
              {state.isRolling ? (state.rollStatus ?? 'Rolling…') : 'Roll a die'}
            </InkButton>
            <InkButton seed={62} className={css.ctaSecondary} onClick={onSeeProof}>
              See the proof
            </InkButton>
          </div>
          <p className={css.trust}>
            Bounded by KL + EV caps · deterministic replay · in-browser verifier.
            <br className={css.trustBreak} />
            Not a fairness claim, yet, and we say so.
          </p>
        </motion.div>

        <motion.div
          className={css.visual}
          {...enter}
          transition={{ duration: 0.7, ease: [0.32, 0.72, 0, 1], delay: 0.12 }}
        >
          <motion.div
            className={css.canvasWrap}
            aria-hidden="true"
            style={reduce ? undefined : { y: dieY, opacity: dieOpacity }}
          >
            <Suspense
              fallback={
                <div className={css.visualPlaceholder}>
                  <div className={css.placeholderDie} />
                </div>
              }
            >
              <HeroCanvas phase={phase} kappa={Math.abs(state.kappa)} face={latestRoll?.face ?? null} />
            </Suspense>
          </motion.div>
          <HeroCredential state={state} onPhase={setCredPhase} />
        </motion.div>
      </div>

      <button className={css.scrollHint} onClick={onOpenPlayground} aria-label="Scroll to playground">
        <span>Open the playground</span>
        <span className={css.scrollChevron} aria-hidden="true">↓</span>
      </button>
    </section>
  );
}
