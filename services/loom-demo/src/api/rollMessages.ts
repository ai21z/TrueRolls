import { RollFailure, type RollProgress } from './client';

/** Where a roll was started, so its outcome is announced once, at that control. */
export type RollOrigin = 'hero' | 'playground';

export interface RollErrorView {
  origin: RollOrigin;
  /** What happened, in one or two plain sentences. */
  message: string;
  /** Technical detail for the curious, never secrets. */
  detail: string | null;
  /** True when the roll request may have reached the API. */
  outcomeUnknown: boolean;
}

export function describeRollFailure(err: unknown, origin: RollOrigin): RollErrorView {
  // Detail only when it adds something beyond the plain message: the underlying
  // cause, or the API's own refusal text.
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : null;
  const detail =
    err instanceof RollFailure
      ? err.kind === 'refused' || err.kind === 'rate_limited'
        ? err.message
        : cause
      : err instanceof Error
        ? err.message
        : null;
  if (err instanceof RollFailure) {
    switch (err.kind) {
      case 'not_sent':
      case 'beacon_unavailable':
        return { origin, message: err.message, detail, outcomeUnknown: false };
      case 'outcome_unknown':
        return {
          origin,
          message:
            'The roll outcome could not be confirmed. A receipt may exist on the server, but this page did not receive it. Rolling again creates a new, separate roll.',
          detail,
          outcomeUnknown: true,
        };
      case 'rate_limited':
        return {
          origin,
          message:
            'Too many rolls right now. The API refused this one, so no receipt was created. Wait a moment before rolling again.',
          detail,
          outcomeUnknown: false,
        };
      case 'refused':
        return {
          origin,
          message: `The API refused this roll${err.status ? ` (HTTP ${err.status})` : ''}. No receipt was created.`,
          detail,
          outcomeUnknown: false,
        };
    }
  }
  return { origin, message: 'The roll could not be completed.', detail, outcomeUnknown: false };
}

/**
 * What the roll status region says while a roll is pending, one sentence per real
 * phase. The countdown is left out: a region whose text changed every second
 * would be read out every second.
 */
export function rollPhaseAnnouncement(progress: RollProgress | null): string {
  switch (progress?.phase) {
    case 'connecting':
      return 'Rolling. Checking that the TrueRolls API is reachable.';
    case 'pulse':
      return 'Rolling. Reading the latest public drand round.';
    case 'submitted':
      return `Rolling. Requested drand round ${progress.targetRound}; waiting for the signed receipt.`;
    default:
      return 'Rolling.';
  }
}
