import { useEffect, useState } from 'react';
import type { RollProgress } from '../api/client';
import type { RollErrorView } from '../hooks/useKarmaState';
import css from './RollProgressLine.module.css';

/**
 * The real request phases of one roll, as the browser knows them. Before the
 * receipt arrives the browser cannot see the server's BLS check, seed derivation,
 * storage or signing, so none of those are staged here. The countdown is the
 * drand schedule for the requested round, labelled as an estimate: reaching zero
 * is not a receipt and proves nothing.
 */
export function RollProgressLine({ progress }: { progress: RollProgress | null }) {
  const [now, setNow] = useState(() => Date.now());
  const dueAt = progress?.phase === 'submitted' ? progress.targetDueAtMs : null;

  useEffect(() => {
    if (dueAt === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [dueAt]);

  let step = 0;
  let line = 'Starting the roll.';
  let sub: string | null = null;
  if (progress?.phase === 'connecting') {
    step = 1;
    line = 'Checking that the TrueRolls API is reachable.';
  } else if (progress?.phase === 'pulse') {
    step = 1;
    line = 'Reading the latest public drand round.';
  } else if (progress?.phase === 'submitted') {
    step = 2;
    const seconds = Math.max(0, Math.ceil((progress.targetDueAtMs - now) / 1000));
    line = `Requested drand round ${progress.targetRound} (observed ${progress.observedRound}).`;
    sub =
      seconds > 0
        ? `Scheduled in about ${seconds}s (estimate). The API verifies that round, then signs the receipt.`
        : 'The round should be published by now. Waiting for the receipt from the API.';
  }

  return (
    <div className={css.root} data-roll-phase={progress?.phase ?? 'starting'}>
      <ol className={css.steps} aria-hidden="true">
        <li className={step >= 1 ? css.on : ''}>pulse</li>
        <li className={step >= 2 ? css.on : ''}>target round</li>
        <li>receipt</li>
      </ol>
      <p className={css.line}>{line}</p>
      <p className={css.sub}>{sub ?? ' '}</p>
    </div>
  );
}

export function RollErrorNotice({
  error,
  onDismiss,
}: {
  error: RollErrorView;
  onDismiss: () => void;
}) {
  return (
    <div className={css.error} role="alert">
      <p className={css.errorText}>{error.message}</p>
      {error.detail && (
        <details className={css.detail}>
          <summary>Technical detail</summary>
          <code>{error.detail}</code>
        </details>
      )}
      <button type="button" className={css.dismiss} onClick={onDismiss} aria-label="Dismiss roll error">
        Dismiss
      </button>
    </div>
  );
}
