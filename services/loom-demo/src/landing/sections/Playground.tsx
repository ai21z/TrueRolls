import { forwardRef } from 'react';
import { ControlRail } from '../../components/ControlRail';
import { Stage } from '../../components/Stage';
import { TranscriptList } from '../../components/TranscriptList';
import { tamperedView } from '../../api/receipt';
import type { useKarmaState } from '../../hooks/useKarmaState';
import css from './Playground.module.css';

interface Props {
  state: ReturnType<typeof useKarmaState>;
}

export const Playground = forwardRef<HTMLElement, Props>(function Playground({ state }, ref) {
  const latestRoll = state.rolls.length > 0 ? state.rolls[0] : null;
  const broken = latestRoll?.tampered != null;
  // When broken, the seed shows the forged face the tampered receipt carries.
  const brokenFace =
    broken && latestRoll?.tampered
      ? tamperedView(latestRoll.tampered.body, { face: latestRoll.face, kappa: latestRoll.kappa, die: latestRoll.die }).face
      : null;

  return (
    <section className={css.section} aria-label="Playground" ref={ref}>
      <div className={css.inner}>
        <div className={css.head}>
          <span className={css.eyebrow}>Playground</span>
          <h2 className={css.title}>Roll it, verify it, try to break it.</h2>
        </div>

        <div className={css.frame}>
          <ControlRail
            die={state.die}
            kappa={state.kappa}
            mock={state.mock}
            onDieChange={state.setDie}
            onKappaChange={state.setKappa}
          />
          <Stage
            latestRoll={latestRoll}
            isRolling={state.isRolling}
            rollStatus={state.rollStatus}
            onRoll={state.roll}
            rollError={state.rollError}
            onDismissError={state.clearRollError}
            die={state.die}
            kappa={state.kappa}
            broken={broken}
            brokenFace={brokenFace}
          />
          <TranscriptList
            rolls={state.rolls}
            onVerify={state.verify}
            onClear={state.clearHistory}
            onBreak={state.markTampered}
            onUnbreak={state.clearTamper}
            mock={state.mock}
          />
        </div>
      </div>
    </section>
  );
});
