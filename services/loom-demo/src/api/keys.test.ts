import { describe, expect, it } from 'vitest';
import { DEMO_TEST_KEY, parseTruerollsKeys, resolveReceiptKey } from './keys';

const receiptForKid = (kid: string) => JSON.stringify({ sig: { kid } });

describe('receipt key resolution', () => {
  it('resolves an active fetched issuer key by kid', () => {
    const resolved = resolveReceiptKey(
      receiptForKid('issuer-1'),
      [{ kid: 'issuer-1', alg: 'Ed25519', public_key: 'issuer-key', status: 'active' }],
      null,
    );
    expect(resolved).toMatchObject({
      kind: 'key-set',
      source: 'well-known',
      publicKey: 'issuer-key',
      kid: 'issuer-1',
      status: 'active',
    });
  });

  it('preserves revoked status for verifier enforcement', () => {
    const resolved = resolveReceiptKey(
      receiptForKid('issuer-revoked'),
      [{
        kid: 'issuer-revoked',
        alg: 'Ed25519',
        public_key: 'revoked-key',
        status: 'revoked',
      }],
      null,
    );
    expect(resolved).toMatchObject({ source: 'well-known', status: 'revoked' });
  });

  it('fails closed when no fetched key matches the receipt kid', () => {
    const resolved = resolveReceiptKey(receiptForKid('unknown'), [], null);
    expect(resolved).toMatchObject({
      kind: 'key-set',
      source: 'unresolved',
      publicKey: '',
      kid: 'unknown',
    });
  });

  it('fails closed when the issuer key set repeats the receipt kid', () => {
    const keys = [
      { kid: 'issuer-1', alg: 'Ed25519', public_key: 'key-a', status: 'active' },
      { kid: 'issuer-1', alg: 'Ed25519', public_key: 'key-b', status: 'retired' },
    ];
    const resolved = resolveReceiptKey(receiptForKid('issuer-1'), keys, null);

    expect(resolved).toMatchObject({
      kind: 'key-set',
      source: 'unresolved',
      publicKey: '',
      kid: 'issuer-1',
    });
    expect(JSON.parse(resolved.keySetJson ?? '{}').keys).toHaveLength(2);
  });

  it('parses the envelope defensively and skips malformed entries', () => {
    expect(parseTruerollsKeys({
      keys: [
        null,
        { kid: 'missing-key', alg: 'Ed25519' },
        { kid: 'bad-status', alg: 'Ed25519', public_key: 'key', status: 1 },
        { kid: 'issuer-1', alg: 'Ed25519', public_key: 'key', status: 'future-status' },
      ],
    })).toEqual({
      keys: [
        { kid: 'issuer-1', alg: 'Ed25519', public_key: 'key', status: 'future-status' },
      ],
    });
    expect(() => parseTruerollsKeys({ keys: null })).toThrow('invalid TrueRolls key-set envelope');
  });

  it('uses a supplied manual key and marks status semantics unavailable', () => {
    const resolved = resolveReceiptKey(receiptForKid('issuer-1'), [], ' manual-key ');
    expect(resolved).toMatchObject({
      kind: 'manual',
      source: 'manual',
      publicKey: ' manual-key ',
      status: null,
    });
  });

  it('uses the public demo key only in an explicit sample context', () => {
    const receipt = receiptForKid('test-kid-1');
    expect(resolveReceiptKey(receipt, [], null).source).toBe('unresolved');
    expect(resolveReceiptKey(receipt, [], null, { allowDemoFallback: true }))
      .toMatchObject({ source: 'demo', publicKey: DEMO_TEST_KEY });
  });
});
