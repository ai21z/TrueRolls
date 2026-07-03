import type { TruerollsKey, TruerollsKeys } from './client';

// PUBLIC test verifying key (base64, kid test-kid-1). Derived from the
// published test seed. It signs the bundled samples and goldens only.
export const DEMO_TEST_KID = 'test-kid-1';
export const DEMO_TEST_KEY = 'IHoGeJKCHiXXcPH7oMR8Ef9LgT5UFi7Onrg54HYjGrY=';

export type KeySource = 'well-known' | 'demo' | 'manual';

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
      source: 'well-known' | 'demo';
      publicKey: string;
      kid: string | null;
      status: TruerollsKey['status'] | null;
      keySetJson: string;
    };

export interface ResolveReceiptKeyOptions {
  allowDemoFallback?: boolean;
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
  if (manualPublicKey != null) {
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
  const match = sigKid ? wellKnownKeys.find((k) => k.kid === sigKid) : undefined;
  if (match?.public_key) {
    return {
      kind: 'key-set',
      source: 'well-known',
      publicKey: match.public_key,
      kid: match.kid,
      status: match.status,
      keySetJson: JSON.stringify({ keys: wellKnownKeys }),
    };
  }

  if (!options.allowDemoFallback) {
    // Fail closed for pasted/uploaded receipts. The wasm verifier receives the real
    // key set, so an unknown kid returns INVALID instead of silently trying the
    // public demo key.
    return {
      kind: 'key-set',
      source: 'well-known',
      publicKey: '',
      kid: sigKid,
      status: null,
      keySetJson: JSON.stringify({ keys: wellKnownKeys }),
    };
  }

  const fallback = demoKeySet();
  return {
    kind: 'key-set',
    source: 'demo',
    publicKey: DEMO_TEST_KEY,
    kid: DEMO_TEST_KID,
    status: 'active',
    keySetJson: JSON.stringify(fallback),
  };
}
