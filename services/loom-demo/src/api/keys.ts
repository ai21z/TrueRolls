import type { TruerollsKey, TruerollsKeys } from './client';

// PUBLIC test verifying key (base64, kid test-kid-1). Derived from the
// published test seed. It signs the bundled samples and goldens only.
export const DEMO_TEST_KID = 'test-kid-1';
export const DEMO_TEST_KEY = 'IHoGeJKCHiXXcPH7oMR8Ef9LgT5UFi7Onrg54HYjGrY=';

// Key provenance of a resolution:
//  - 'well-known': matched a key published at the issuer's /.well-known set.
//  - 'demo': the PUBLIC test key (test-kid-1). Anyone can sign with it, so it
//    proves nothing about issuer trust. Used only so the bundled sample and its
//    tampered variants can demonstrate a signature passing/failing.
//  - 'manual': a key the user pasted by hand (status checks bypassed).
//  - 'unresolved': no published key matched this kid and no manual key was
//    supplied. Fail closed: we do NOT claim any provenance for the absent key.
export type KeySource = 'well-known' | 'demo' | 'manual' | 'unresolved';

export type ResolvedReceiptKey =
  | {
      kind: 'manual';
      source: 'manual';
      publicKey: string;
      kid: string | null;
      status: null;
      keySetJson: null;
    }
  | {
      kind: 'key-set';
      source: 'well-known' | 'demo' | 'unresolved';
      publicKey: string;
      kid: string | null;
      status: TruerollsKey['status'] | null;
      keySetJson: string;
    };

export interface ResolveReceiptKeyOptions {
  /** Allow resolving the PUBLIC demo key for a test-kid-1 receipt (the sample
   * and its tampered variants). Off by default so an arbitrary pasted receipt is
   * fail-closed, never silently checked against the world-known test key. */
  allowDemoFallback?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse the public key-set envelope with the same fail-closed posture as the
 * Rust verifier: a malformed envelope fails, while malformed individual entries
 * are skipped and therefore cannot verify a receipt. */
export function parseTruerollsKeys(value: unknown): TruerollsKeys {
  if (!isRecord(value) || !Array.isArray(value.keys)) {
    throw new Error('invalid TrueRolls key-set envelope');
  }

  const keys: TruerollsKey[] = [];
  for (const candidate of value.keys) {
    if (!isRecord(candidate)) continue;
    if (
      typeof candidate.kid !== 'string' ||
      typeof candidate.alg !== 'string' ||
      typeof candidate.public_key !== 'string' ||
      (candidate.status !== undefined && typeof candidate.status !== 'string')
    ) {
      continue;
    }
    keys.push({
      kid: candidate.kid,
      alg: candidate.alg,
      public_key: candidate.public_key,
      ...(candidate.status === undefined ? {} : { status: candidate.status }),
    });
  }
  return { keys };
}

export function parseSigKid(text: string): string | null {
  try {
    const obj = JSON.parse(text) as { sig?: { kid?: unknown } };
    return typeof obj.sig?.kid === 'string' ? obj.sig.kid : null;
  } catch {
    return null;
  }
}

export function demoKeySet(): TruerollsKeys {
  return {
    keys: [
      {
        kid: DEMO_TEST_KID,
        alg: 'Ed25519',
        public_key: DEMO_TEST_KEY,
        status: 'active',
      },
    ],
  };
}

export function resolveReceiptKey(
  receiptText: string,
  wellKnownKeys: TruerollsKey[],
  manualPublicKey: string | null,
  options: ResolveReceiptKeyOptions = {},
): ResolvedReceiptKey {
  // A blank manual key is NOT a key. Fall through to key-set resolution rather
  // than verifying against an empty string (which would report a false INVALID).
  if (manualPublicKey != null && manualPublicKey.trim() !== '') {
    return {
      kind: 'manual',
      source: 'manual',
      publicKey: manualPublicKey,
      kid: null,
      status: null,
      keySetJson: null,
    };
  }

  const sigKid = parseSigKid(receiptText);
  const matches = sigKid ? wellKnownKeys.filter((k) => k.kid === sigKid) : [];
  if (matches.length === 1) {
    const match = matches[0];
    return {
      kind: 'key-set',
      source: 'well-known',
      publicKey: match.public_key,
      kid: match.kid,
      status: match.status,
      keySetJson: JSON.stringify({ keys: wellKnownKeys }),
    };
  }

  // Demo/sample context only, and only for the demo kid: resolve the PUBLIC test
  // key so the sample and its tampered variants show the signature passing or
  // failing. Always labeled 'demo' so it can never be mistaken for issuer trust,
  // and it can never mask a real issuer key (that would have matched above).
  if (options.allowDemoFallback && matches.length === 0 && sigKid === DEMO_TEST_KID) {
    return {
      kind: 'key-set',
      source: 'demo',
      publicKey: DEMO_TEST_KEY,
      kid: DEMO_TEST_KID,
      status: 'active',
      keySetJson: JSON.stringify(demoKeySet()),
    };
  }

  // No trust root: no published key matched and no manual key. Fail closed. The
  // wasm verifier still receives the real key set, so an unknown kid returns
  // INVALID with an 'unknown signing kid' reason. We do NOT claim well-known
  // provenance for a key we could not resolve.
  return {
    kind: 'key-set',
    source: 'unresolved',
    publicKey: '',
    kid: sigKid,
    status: null,
    keySetJson: JSON.stringify({ keys: wellKnownKeys }),
  };
}
