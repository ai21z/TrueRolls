import { describe, expect, it } from 'vitest';
import { isBoundResult, verificationContextId, verificationRequestKey } from './verificationContext';
import { diagnoseReceiptInput } from './receiptInput';
import { failingChecks, invalidSummary } from './trustPresentation';

const SAMPLE = '{"v":"truerolls-drand-1","proof":{"drand":{}},"sig":{"kid":"test-kid-1"}}';

describe('verification context identity', () => {
  const base = { text: SAMPLE, allowDemoFallback: true, manualKey: null };

  it('changes with the receipt text, the origin policy and the manual key', () => {
    const key = verificationRequestKey(base);
    expect(verificationRequestKey({ ...base, text: '{broken' })).not.toBe(key);
    expect(verificationRequestKey({ ...base, allowDemoFallback: false })).not.toBe(key);
    expect(verificationRequestKey({ ...base, manualKey: 'AAAA' })).not.toBe(key);
  });

  it('treats surrounding whitespace on a manual key as the same key', () => {
    expect(verificationRequestKey({ ...base, manualKey: ' AAAA ' })).toBe(
      verificationRequestKey({ ...base, manualKey: 'AAAA' }),
    );
  });

  it('binds an issuer-key verdict to the key-set revision and the engine state', () => {
    const requestKey = verificationRequestKey(base);
    const a = verificationContextId({ requestKey, inputOk: true, manual: false, keysRevision: 1, engine: 'ready' });
    expect(verificationContextId({ requestKey, inputOk: true, manual: false, keysRevision: 2, engine: 'ready' })).not.toBe(a);
    expect(verificationContextId({ requestKey, inputOk: true, manual: false, keysRevision: null, engine: 'ready' })).not.toBe(a);
    expect(verificationContextId({ requestKey, inputOk: true, manual: false, keysRevision: 1, engine: 'failed' })).not.toBe(a);
  });

  it('does not tie a manual-key verdict to the issuer key set', () => {
    const requestKey = verificationRequestKey({ ...base, manualKey: 'AAAA' });
    expect(verificationContextId({ requestKey, inputOk: true, manual: true, keysRevision: 1, engine: 'ready' })).toBe(
      verificationContextId({ requestKey, inputOk: true, manual: true, keysRevision: 9, engine: 'ready' }),
    );
  });

  it('exposes a result only for the exact current request and context', () => {
    const requestKey = verificationRequestKey(base);
    const contextId = verificationContextId({ requestKey, inputOk: true, manual: false, keysRevision: 1, engine: 'ready' });
    const result = { contextId };
    expect(isBoundResult(result, requestKey, requestKey, contextId)).toBe(true);
    expect(isBoundResult(result, null, requestKey, contextId)).toBe(false);
    const edited = verificationRequestKey({ ...base, text: '{broken' });
    expect(isBoundResult(result, requestKey, edited, contextId)).toBe(false);
    expect(isBoundResult(result, requestKey, requestKey, `${contextId}x`)).toBe(false);
    expect(isBoundResult(null, requestKey, requestKey, contextId)).toBe(false);
  });
});

describe('receipt input diagnosis', () => {
  it.each([
    ['', 'empty'],
    ['   \n', 'empty'],
    ['{broken', 'invalid_json'],
    ['[1,2]', 'not_object'],
    ['"text"', 'not_object'],
    ['null', 'not_object'],
    ['{"v":"truerolls-9"}', 'unsupported_version'],
    ['{"id":"x"}', 'unsupported_version'],
  ])('classifies %j as %s', (text, code) => {
    const d = diagnoseReceiptInput(text);
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.code).toBe(code);
      expect(d.message).not.toMatch(/kid/);
    }
  });

  it('accepts both supported versions', () => {
    expect(diagnoseReceiptInput('{"v":"truerolls-drand-1"}').ok).toBe(true);
    expect(diagnoseReceiptInput('{"v":"truerolls-1"}').ok).toBe(true);
  });
});

describe('invalid summaries come from the failing checks', () => {
  const drand = { v: 'truerolls-drand-1', proof: { drand: {} } };
  const legacy = { v: 'truerolls-1', proof: { drand: {} } };
  const allPass = {
    verdict: 'INVALID' as const,
    valid_signature: true,
    valid_drand: true,
    valid_sampling: true,
    face_ok: true,
    metrics_ok: true,
  };

  it('does not blame the signature when only the drand proof fails', () => {
    const report = { ...allPass, valid_drand: false };
    expect(failingChecks(report, drand)).toEqual(['drand']);
    expect(invalidSummary(report, drand)).toMatch(/^The signature holds, but the drand beacon proof does not verify/);
  });

  it('never judges a stray drand proof on a legacy receipt', () => {
    expect(failingChecks({ ...allPass, valid_drand: false }, legacy)).toEqual([]);
  });

  it('names a signature failure and every other failed check', () => {
    const report = { ...allPass, valid_signature: false, face_ok: false };
    expect(failingChecks(report, drand)).toEqual(['signature', 'face']);
    expect(invalidSummary(report, drand)).toContain('Failed: Signature, Face.');
  });

  it('reports a revoked key as a key-status refusal', () => {
    const report = { ...allPass, valid_signature: false, errors: ["signing key 'k' is revoked"] };
    expect(invalidSummary(report, drand)).toMatch(/revoked/);
  });
});
