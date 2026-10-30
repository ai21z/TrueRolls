import { describe, expect, it } from 'vitest';
import { RollFailure, ROLL_NOT_SENT_MESSAGE } from './client';
import { describeRollFailure, rollPhaseAnnouncement } from './rollMessages';

describe('roll failure messages', () => {
  it('keeps "not sent" only for failures before the request existed', () => {
    const view = describeRollFailure(new RollFailure('not_sent', ROLL_NOT_SENT_MESSAGE), 'hero');
    expect(view.message).toBe(ROLL_NOT_SENT_MESSAGE);
    expect(view.outcomeUnknown).toBe(false);
    expect(view.detail).toBeNull();
  });

  it('says a receipt may exist when the outcome is unknown, and that rolling again is a new roll', () => {
    const view = describeRollFailure(
      new RollFailure('outcome_unknown', 'x', { cause: new TypeError('Failed to fetch') }),
      'playground',
    );
    expect(view.outcomeUnknown).toBe(true);
    expect(view.message).toMatch(/A receipt may exist on the server/);
    expect(view.message).toMatch(/creates a new, separate roll/);
    expect(view.message).not.toMatch(/TypeError/);
    expect(view.detail).toBe('Failed to fetch');
    expect(view.origin).toBe('playground');
  });

  it('maps 429 and other refusals to definite no-receipt messages', () => {
    expect(describeRollFailure(new RollFailure('rate_limited', 'Roll failed (429): slow', { status: 429 }), 'hero').message)
      .toMatch(/Too many rolls right now.*no receipt was created/);
    expect(describeRollFailure(new RollFailure('refused', 'Roll failed (409): x', { status: 409 }), 'hero').message)
      .toBe('The API refused this roll (HTTP 409). No receipt was created.');
  });
});

describe('roll phase announcements', () => {
  it('names each real phase once, without the ticking countdown', () => {
    expect(rollPhaseAnnouncement(null)).toBe('Rolling.');
    expect(rollPhaseAnnouncement({ phase: 'connecting' })).toMatch(/^Rolling\. Checking that the TrueRolls API/);
    expect(rollPhaseAnnouncement({ phase: 'pulse' })).toMatch(/^Rolling\. Reading the latest public drand round/);
    const submitted = { phase: 'submitted', observedRound: 9, targetRound: 10, targetDueAtMs: 0 } as const;
    expect(rollPhaseAnnouncement(submitted)).toBe(
      'Rolling. Requested drand round 10; waiting for the signed receipt.',
    );
    // The text depends only on the phase, so it does not change while the clock runs.
    expect(rollPhaseAnnouncement({ ...submitted, targetDueAtMs: 5_000 })).toBe(rollPhaseAnnouncement(submitted));
  });
});
