import { describe, expect, it } from 'vitest';
import { parseDrandApiPulse, selectFreshestDrandPulse } from './drandClient';

const signature = 'ab'.repeat(48);
const randomness = 'cd'.repeat(32);

describe('drand client frontier selection', () => {
  it('selects the highest valid relay frontier', () => {
    expect(selectFreshestDrandPulse([
      { round: 10, signature, randomness },
      { round: 12, signature, randomness },
      { round: 11, signature, randomness },
    ]).round).toBe(12);
  });

  it('validates pulse shape and exact hex lengths', () => {
    expect(parseDrandApiPulse({ round: 12, signature, randomness })).toEqual({
      round: 12,
      signature,
      randomness,
    });
    expect(() => parseDrandApiPulse({ round: 12, signature: 'ab', randomness }))
      .toThrow('malformed');
    expect(() => parseDrandApiPulse({ round: 0, signature, randomness }))
      .toThrow('malformed');
  });

  it('fails when no relay produced a valid pulse', () => {
    expect(() => selectFreshestDrandPulse([])).toThrow('no valid drand relay response');
  });
});
