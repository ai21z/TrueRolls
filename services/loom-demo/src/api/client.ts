import type { Die, ReceiptVerifyResponse, RollRequest, RollResponse, VerifyResponse } from '../types/kd';
import { mockRoll, mockVerify } from './mock';
import { initKdCoreWasm } from './wasmEngine';
const BASE = import.meta.env.VITE_API_URL ?? '/api';
const DRAND_CHAIN = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';
const DRAND_RELAY = 'https://api.drand.sh';
const TARGET_DELAY_ROUNDS = 2;
let _mockMode = false;
export function isMockMode(): boolean {
  return _mockMode;
}
export interface TruerollsKey {
  kid: string;
  alg: string;
  public_key: string;
}
export interface TruerollsKeys {
  keys: TruerollsKey[];
}
export async function initClient(): Promise<boolean> {
  // Kick off the kd-core wasm engine alongside the health probe. The engine
  // is required for the distribution preview and for mock-mode rolls; an init
  // failure is surfaced (not silently swallowed into fallback math).
  const wasmInit = initKdCoreWasm().catch((err: unknown) => {
    console.error('[kd] kd-core wasm engine failed to initialize:', err);
  });
  let live = false;
  try {
    const res = await fetch(BASE + '/healthz', { signal: AbortSignal.timeout(3000) });
    if (res.ok) live = true;
  } catch { /* unreachable */ }
  _mockMode = !live;
  if (!live) console.warn('[kd] API unreachable, mock mode');
  await wasmInit;
  return live;
}
export async function postRoll(die: Die, kappa: number): Promise<RollResponse> {
  if (_mockMode) return mockRoll(die, kappa);
  const clientNonce = randomHex32();
  const observed = await fetchLatestDrandPulse();
  const body: RollRequest = {
    die,
    kappa,
    client_nonce: clientNonce,
    drand: {
      client_observed_round: observed.round,
      client_observed_signature_hex: observed.signature,
      client_observed_randomness_hex: observed.randomness,
      target_round: observed.round + TARGET_DELAY_ROUNDS,
    },
  };
  const res = await fetch(BASE + '/v1/roll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 201) {
    throw new Error('Roll failed (' + res.status + '): ' + (await res.text()));
  }
  return res.json() as Promise<RollResponse>;
}

interface DrandApiPulse {
  round: number;
  signature: string;
  randomness: string;
}

async function fetchLatestDrandPulse(): Promise<DrandApiPulse> {
  const res = await fetch(`${DRAND_RELAY}/${DRAND_CHAIN}/public/latest`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) {
    throw new Error(`drand latest failed (${res.status}): ${await res.text()}`);
  }
  const pulse = (await res.json()) as DrandApiPulse;
  if (!Number.isSafeInteger(pulse.round) || !pulse.signature || !pulse.randomness) {
    throw new Error('drand latest response was malformed');
  }
  return pulse;
}

function randomHex32(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
export async function postVerify(rollId: string): Promise<VerifyResponse> {
  if (_mockMode) return mockVerify();
  // GET /v1/verify/:id — server fetches transcript from S3 and re-verifies
  // (legacy math-only path; performs NO signature checking)
  const res = await fetch(BASE + `/v1/verify/${rollId}`, { method: 'GET' });
  if (res.ok) {
    return res.json() as Promise<VerifyResponse>;
  }
  // 422 = MISMATCH — the body is still a valid VerifyResponse
  if (res.status === 422) {
    return res.json() as Promise<VerifyResponse>;
  }
  throw new Error(`Verify failed (${res.status}): ${await res.text()}`);
}
/**
 * POST /v1/verify with a full ReceiptV2 body ("v":"truerolls-1" or "truerolls-drand-1").
 * The server verifies the Ed25519 signature, replays the RNG draw, and
 * recomputes face/metrics. Failed checks still return HTTP 200 with false
 * flags; only malformed bodies return 400.
 */
export async function postVerifyReceipt(receipt: unknown): Promise<ReceiptVerifyResponse> {
  if (_mockMode) {
    throw new Error('receipt verification requires live API');
  }
  const res = await fetch(BASE + '/v1/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(receipt),
  });
  if (res.ok) {
    return res.json() as Promise<ReceiptVerifyResponse>;
  }
  throw new Error(`Receipt verify failed (${res.status}): ${await res.text()}`);
}
/** GET /.well-known/truerolls-keys.json — published Ed25519 verification keys. */
export async function getTruerollsKeys(): Promise<TruerollsKeys> {
  if (_mockMode) {
    throw new Error('key fetch requires live API');
  }
  const res = await fetch(BASE + '/.well-known/truerolls-keys.json');
  if (!res.ok) {
    throw new Error(`Key fetch failed (${res.status}): ${await res.text()}`);
  }
  return res.json() as Promise<TruerollsKeys>;
}
