import { forwardRef } from 'react';
import { rollPhaseAnnouncement } from '../../api/rollMessages';
import { ControlRail } from '../../components/ControlRail';
import { Stage } from '../../components/Stage';
import { TranscriptList } from '../../components/TranscriptList';
import type { useKarmaState } from '../../hooks/useKarmaState';
import css from './Playground.module.css';

interface Props {
  state: ReturnType<typeof useKarmaState>;
}

export const Playground = forwardRef<HTMLElement, Props>(function Playground({ state }, ref) {
  // The socket shows the original roll only. Edited demonstration copies are
  // separate artifacts and never replace the issued result here.
  const latestRoll = state.rolls.length > 0 ? state.rolls[0] : null;
  // The stage's status speaks for rolls from either button. After a failure it
  // stays quiet (the alert speaks), so an earlier face is never read out as new.
  const announcedRoll =
    !state.isRolling && latestRoll != null && state.lastRoll?.localId === latestRoll.localId ? latestRoll : null;

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
            unavailable={state.apiUnavailable}
            onDieChange={state.setDie}
            onKappaChange={state.setKappa}
          />
          <Stage
            latestRoll={latestRoll}
            isRolling={state.isRolling}
            rollProgress={state.rollOrigin === 'playground' ? state.rollProgress : null}
            showProgress={state.isRolling && state.rollOrigin === 'playground'}
            phaseAnnouncement={state.isRolling ? rollPhaseAnnouncement(state.rollProgress) : null}
            announcedRoll={announcedRoll}
            onRoll={() => void state.roll('playground')}
            rollError={state.rollError?.origin === 'playground' ? state.rollError : null}
            onDismissError={state.clearRollError}
            die={state.die}
            kappa={state.kappa}
            engine={state.engine}
            onRetryEngine={state.retryEngine}
          />
          <TranscriptList
            rolls={state.rolls}
            onVerify={state.verify}
            onClear={state.clearHistory}
            editedCopy={state.editedCopy}
            onVerifyEditedCopy={state.verifyEditedCopy}
            onDiscardEditedCopy={state.discardEditedCopy}
            mock={state.mock}
          />
        </div>
      </div>
    </section>
  );
});
