import type { Die, ReceiptVerifyResponse, RollRequest, RollResponse, VerifyResponse } from '../types/kd';
import { mockRoll, mockVerify } from './mock';
import { initKdCoreWasm } from './wasmEngine';
import { parseTruerollsKeys } from './keys';
import { fetchLatestDrandPulse } from './drandClient';
const BASE = import.meta.env.VITE_API_URL ?? '/api';
const TARGET_DELAY_ROUNDS = 2;
// Simulated receipts are a local-development and test affordance. A production build
// never falls back to them unless VITE_DEMO_FALLBACK=1 was set at build time.
const DEMO_FALLBACK_ENABLED =
  import.meta.env.DEV || import.meta.env.VITE_DEMO_FALLBACK === '1';
export const API_UNAVAILABLE_MESSAGE =
  'The TrueRolls API is unavailable right now. No receipt was created.';

/** live: real API; demo: simulated receipts; unavailable: API unreachable, nothing simulated. */
export type ClientMode = 'live' | 'demo' | 'unavailable';
export function resolveClientMode(apiReachable: boolean, demoFallback: boolean): ClientMode {
  if (apiReachable) return 'live';
  return demoFallback ? 'demo' : 'unavailable';
}

let _mode: ClientMode = 'live';
export function isMockMode(): boolean {
  return _mode === 'demo';
}
export function getClientMode(): ClientMode {
  return _mode;
}
export interface TruerollsKey {
  kid: string;
  alg: string;
  public_key: string;
  status?: string;
}
export interface TruerollsKeys {
  keys: TruerollsKey[];
}

// Absolute base the copied `kd verify --server <base>` command targets. It is the
// same base the browser uses for every API call (`/v1/*` AND `/.well-known/*`), so
// the CLI command reaches the key set wherever the browser's own calls already do.
// When VITE_API_URL is an absolute URL it is used verbatim (the real API origin);
// otherwise the relative dev-proxy base (`/api`) resolves against the page origin
// and must be proxied to kd-api consistently for both path prefixes.
export function getApiBaseForCli(): string {
  if (typeof window === 'undefined') return BASE;
  return new URL(BASE, window.location.origin).toString().replace(/\/$/, '');
}

// Liveness only: /livez does no backend I/O, so every page load does not touch the
// database, Redis, or object storage.
async function probeApi(): Promise<boolean> {
  try {
    const res = await fetch(BASE + '/livez', { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function initClient(): Promise<ClientMode> {
  // Kick off the kd-core wasm engine alongside the liveness probe. The engine
  // is required for the distribution preview and for mock-mode rolls. An init
  // failure is surfaced (not silently swallowed into fallback math).
  const wasmInit = initKdCoreWasm().catch((err: unknown) => {
    console.error('[kd] kd-core wasm engine failed to initialize:', err);
  });
  _mode = resolveClientMode(await probeApi(), DEMO_FALLBACK_ENABLED);
  if (_mode === 'demo') console.warn('[kd] API unreachable, mock mode');
  if (_mode === 'unavailable') console.warn('[kd] API unreachable, live rolling unavailable');
  await wasmInit;
  return _mode;
}
export async function postRoll(die: Die, kappa: number): Promise<RollResponse> {
  if (_mode === 'demo') return mockRoll(die, kappa);
  if (_mode === 'unavailable') {
    // Re-probe so a cold start or brief outage recovers without a page reload.
    if (!(await probeApi())) throw new Error(API_UNAVAILABLE_MESSAGE);
    _mode = 'live';
  }
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
  let res: Response;
  try {
    res = await fetch(BASE + '/v1/roll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // No HTTP response at all: let liveness decide whether the API is gone.
    if (await markUnavailableIfApiDown()) throw new Error(API_UNAVAILABLE_MESSAGE);
    throw err;
  }
  if (!res.ok && res.status !== 201) {
    // A 5xx can come from the edge or tunnel rather than the API. A 4xx (400, 409, 429)
    // is an answer from a reachable API and never changes the connection state.
    if (res.status >= 500 && (await markUnavailableIfApiDown())) {
      throw new Error(API_UNAVAILABLE_MESSAGE);
    }
    throw new Error('Roll failed (' + res.status + '): ' + (await res.text()));
  }
  return res.json() as Promise<RollResponse>;
}

// After a failed live call, re-probe liveness. A down API becomes 'unavailable', never
// 'demo': simulated receipts are only ever chosen at startup.
async function markUnavailableIfApiDown(): Promise<boolean> {
  if (await probeApi()) return false;
  _mode = 'unavailable';
  return true;
}

function randomHex32(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
export async function postVerify(rollId: string): Promise<VerifyResponse> {
  if (_mode === 'demo') return mockVerify();
  // GET /v1/verify/:id, server fetches transcript from S3 and re-verifies
  // (legacy math-only path, performs NO signature checking)
  const res = await fetch(BASE + `/v1/verify/${rollId}`, { method: 'GET' });
  if (res.ok) {
    return res.json() as Promise<VerifyResponse>;
  }
  // 422 = MISMATCH, the body is still a valid VerifyResponse
  if (res.status === 422) {
    return res.json() as Promise<VerifyResponse>;
  }
  throw new Error(`Verify failed (${res.status}): ${await res.text()}`);
}
/**
 * POST /v1/verify with a full ReceiptV2 body ("v":"truerolls-1" or "truerolls-drand-1").
 * The server verifies the Ed25519 signature, replays the RNG draw, and
 * recomputes face/metrics. Failed checks still return HTTP 200 with false
 * flags. Only malformed bodies return 400.
 */
export async function postVerifyReceipt(receipt: unknown): Promise<ReceiptVerifyResponse> {
  if (_mode === 'demo') {
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
/** GET /.well-known/truerolls-keys.json, published Ed25519 verification keys. */
export async function getTruerollsKeys(): Promise<TruerollsKeys> {
  if (_mode === 'demo') {
    throw new Error('key fetch requires live API');
  }
  const res = await fetch(BASE + '/.well-known/truerolls-keys.json');
  if (!res.ok) {
    throw new Error(`Key fetch failed (${res.status}): ${await res.text()}`);
  }
  const body: unknown = await res.json();
  return parseTruerollsKeys(body);
}
