import { describe, expect, it } from 'vitest';
import {
  drandSummaryForReceipt,
  heroReceiptPill,
  isMockArtifact,
  keyTrustExplanation,
  normalizePersistedVerifyStatus,
  receiptHasVersionedDrandProof,
  statusPillForArtifact,
  transcriptRowVerdict,
  verificationState,
  verificationStateLabel,
} from './trustPresentation';

describe('trust presentation helpers', () => {
  it('identifies demo mints by their mock- id, not by missing signature', () => {
    expect(isMockArtifact({ id: 'mock-1', sig: null })).toBe(true);
    // An UNSIGNED LIVE roll (real id, no signer configured) is NOT a demo mint.
    // it must still reach the server math-recompute verify path.
    expect(isMockArtifact({ id: 'live-looking', sig: null })).toBe(false);
    expect(isMockArtifact({ id: 'mock-legacy', sig: { kid: 'k' } })).toBe(true);
    expect(isMockArtifact({ id: 'live-1', sig: { kid: 'k' } })).toBe(false);
  });

  it('never presents verified_local (demo, no crypto) as Verified', () => {
    // Regression: a signed live receipt "verified" in a reloaded offline (mock)
    // session gets verifyStatus verified_local with NO mock-artifact flag; it must
    // still read Demo, never a green Verified.
    expect(statusPillForArtifact('verified_local', false)).toEqual({
      label: 'Demo',
      tone: 'neutral',
    });
    expect(transcriptRowVerdict('verified_local', false)).toEqual({
      text: 'Demo',
      kind: 'demo',
    });
  });

  it('requires persisted positive states to be verified again after reload', () => {
    expect(normalizePersistedVerifyStatus('verified_server')).toBe('not_checked');
    expect(normalizePersistedVerifyStatus('verified_local')).toBe('not_checked');
    expect(normalizePersistedVerifyStatus('pending')).toBe('not_checked');
    expect(normalizePersistedVerifyStatus('mismatch')).toBe('mismatch');
    expect(normalizePersistedVerifyStatus('error')).toBe('error');
  });

  it('never labels mock artifacts as verified or signed', () => {
    expect(statusPillForArtifact('verified_local', true)).toEqual({
      label: 'Demo',
      tone: 'neutral',
    });
    expect(transcriptRowVerdict('verified_server', true)).toEqual({
      text: 'Demo',
      kind: 'demo',
    });
    expect(heroReceiptPill({
      entry: { id: 'mock-1', sig: null },
      verify: null,
      tampered: false,
      verifiedOk: false,
    })).toEqual({ label: 'Demo', tone: 'neutral' });
  });

  it('labels an unsigned live entry Unsigned, not Signed', () => {
    expect(heroReceiptPill({
      entry: { id: 'live-unsigned', sig: null },
      verify: null,
      tampered: false,
      verifiedOk: false,
    })).toEqual({ label: 'Unsigned', tone: 'neutral' });
  });

  it('allows signed receipts to advance from signed to verified', () => {
    const entry = { id: 'live-1', sig: { kid: 'k' } };
    expect(heroReceiptPill({
      entry,
      verify: null,
      tampered: false,
      verifiedOk: false,
    })).toEqual({ label: 'Signed', tone: 'neutral' });
    expect(heroReceiptPill({
      entry,
      verify: { verdict: 'VALID' } as never,
      tampered: false,
      verifiedOk: true,
    })).toEqual({ label: 'Verified', tone: 'ok' });
  });

  it('version-gates drand proof language and rows', () => {
    const legacyWithStrayDrand = {
      v: 'truerolls-1',
      proof: { drand: { target_round: 10 } },
    };
    const drandReceipt = {
      v: 'truerolls-drand-1',
      proof: { drand: { target_round: 10 } },
    };

    expect(receiptHasVersionedDrandProof(legacyWithStrayDrand)).toBe(false);
    expect(drandSummaryForReceipt(legacyWithStrayDrand)).toContain('legacy truerolls-1');
    expect(receiptHasVersionedDrandProof(drandReceipt)).toBe(true);
    expect(drandSummaryForReceipt(drandReceipt)).toContain('truerolls-drand-1');
  });

  it('keeps progress and final verdict states distinct', () => {
    expect(verificationState({ phase: 'not_checked', report: null, keySource: 'demo' }))
      .toBe('not_checked');
    expect(verificationState({ phase: 'loading', report: null, keySource: 'demo' }))
      .toBe('loading');
    expect(verificationState({ phase: 'verifying', report: null, keySource: 'demo' }))
      .toBe('verifying');
    expect(verificationState({
      phase: 'complete',
      report: { verdict: 'VALID' },
      keySource: 'well-known',
    })).toBe('valid');
    expect(verificationState({
      phase: 'complete',
      report: { verdict: 'INVALID' },
      keySource: 'well-known',
    })).toBe('invalid');
    expect(verificationState({
      phase: 'complete',
      report: { verdict: 'INVALID' },
      keySource: 'unresolved',
    })).toBe('unverifiable');
    expect(verificationState({
      phase: 'complete',
      report: { verdict: 'ERROR' },
      keySource: 'manual',
    })).toBe('unverifiable');
  });

  it('does not relabel a revoked-key rejection as missing trust', () => {
    const state = verificationState({
      phase: 'complete',
      report: { verdict: 'INVALID' },
      keySource: 'well-known',
    });
    expect(state).toBe('invalid');
    expect(verificationStateLabel(state)).toBe('INVALID');
  });

  it('labels manual and fetched key trust boundaries explicitly', () => {
    expect(keyTrustExplanation('manual')).toContain('status checks bypassed');
    expect(keyTrustExplanation('well-known')).toContain('does not remove issuer trust');
  });
});
