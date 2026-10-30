import type { Die, ReceiptVerifyResponse, RollRequest, RollResponse, VerifyResponse } from '../types/kd';
import { mockRoll, mockVerify } from './mock';
import { parseTruerollsKeys } from './keys';
import { fetchLatestDrandPulse } from './drandClient';
const BASE = import.meta.env.VITE_API_URL ?? '/api';
const TARGET_DELAY_ROUNDS = 2;
// drand quicknet schedule (kd-drand QUICKNET_GENESIS_TIME / QUICKNET_PERIOD_SECONDS).
// Used only to estimate when the target round is due; it proves nothing.
export const QUICKNET_GENESIS_SECONDS = 1_692_803_367;
export const QUICKNET_PERIOD_SECONDS = 3;
// Simulated receipts are a local-development and test affordance. A production build
// never falls back to them unless VITE_DEMO_FALLBACK=1 was set at build time.
const DEMO_FALLBACK_ENABLED =
  import.meta.env.DEV || import.meta.env.VITE_DEMO_FALLBACK === '1';
// Only claim nothing was minted when the roll request was never sent. Once it may have
// reached the API, a lost response or a 5xx (even a lost commit ack) can follow a stored receipt.
export const ROLL_NOT_SENT_MESSAGE =
  'The TrueRolls API is unavailable right now. No roll request was sent.';
export const ROLL_OUTCOME_UNKNOWN_MESSAGE = 'The roll outcome could not be confirmed.';
export const BEACON_UNAVAILABLE_MESSAGE =
  'The public drand beacon could not be reached. No roll request was sent.';

/** live: real API; demo: simulated receipts; unavailable: API unreachable, nothing simulated. */
export type ClientMode = 'live' | 'demo' | 'unavailable';
/** 'checking' until the first liveness probe answers. */
export type ConnectionState = 'checking' | ClientMode;
export function resolveClientMode(apiReachable: boolean, demoFallback: boolean): ClientMode {
  if (apiReachable) return 'live';
  return demoFallback ? 'demo' : 'unavailable';
}

/**
 * Why a roll did not produce a receipt in this tab. `not_sent` and
 * `beacon_unavailable` mean the roll request never left the browser; `outcome_unknown`
 * means it may have reached the API and a receipt may exist; `refused` and
 * `rate_limited` are definite refusals from a reachable API.
 */
export type RollFailureKind =
  | 'not_sent'
  | 'beacon_unavailable'
  | 'outcome_unknown'
  | 'rate_limited'
  | 'refused';

export class RollFailure extends Error {
  readonly kind: RollFailureKind;
  readonly status: number | null;
  constructor(kind: RollFailureKind, message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'RollFailure';
    this.kind = kind;
    this.status = options.status ?? null;
  }
}

/** Real request phases of one roll, reported as they happen. */
export type RollProgress =
  | { phase: 'connecting' }
  | { phase: 'pulse' }
  | {
      phase: 'submitted';
      observedRound: number;
      targetRound: number;
      /** Scheduled publication time of the target round (an estimate, not a proof). */
      targetDueAtMs: number;
    };

export function quicknetRoundDueAtMs(round: number): number {
  return (QUICKNET_GENESIS_SECONDS + (round - 1) * QUICKNET_PERIOD_SECONDS) * 1000;
}

let _mode: ConnectionState = 'checking';
const modeListeners = new Set<() => void>();
function setMode(next: ConnectionState) {
  if (_mode === next) return;
  _mode = next;
  for (const listener of modeListeners) listener();
}
export function subscribeClientMode(listener: () => void): () => void {
  modeListeners.add(listener);
  return () => {
    modeListeners.delete(listener);
  };
}
export function isMockMode(): boolean {
  return _mode === 'demo';
}
export function getClientMode(): ConnectionState {
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

let initPromise: Promise<ClientMode> | null = null;

/**
 * Probe the API once and settle the connection state. It does not wait for the
 * wasm engine: pages render while either dependency loads, and each operation
 * gates only on what it actually needs.
 */
export function initClient(): Promise<ClientMode> {
  if (!initPromise) {
    initPromise = (async () => {
      const mode = resolveClientMode(await probeApi(), DEMO_FALLBACK_ENABLED);
      setMode(mode);
      if (mode === 'demo') console.warn('[kd] API unreachable, mock mode');
      if (mode === 'unavailable') console.warn('[kd] API unreachable, live rolling unavailable');
      return mode;
    })();
  }
  return initPromise;
}

export async function postRoll(
  die: Die,
  kappa: number,
  onProgress?: (progress: RollProgress) => void,
): Promise<RollResponse> {
  if (_mode === 'checking') {
    onProgress?.({ phase: 'connecting' });
    await initClient();
  }
  if (_mode === 'demo') return mockRoll(die, kappa);
  if (_mode === 'unavailable') {
    // Re-probe so a cold start or brief outage recovers without a page reload.
    onProgress?.({ phase: 'connecting' });
    if (!(await probeApi())) throw new RollFailure('not_sent', ROLL_NOT_SENT_MESSAGE);
    setMode('live');
  }
  const clientNonce = randomHex32();
  onProgress?.({ phase: 'pulse' });
  let observed: Awaited<ReturnType<typeof fetchLatestDrandPulse>>;
  try {
    observed = await fetchLatestDrandPulse();
  } catch (err) {
    // The pulse is fetched before the roll request exists, so nothing was sent.
    throw new RollFailure('beacon_unavailable', BEACON_UNAVAILABLE_MESSAGE, { cause: err });
  }
  const targetRound = observed.round + TARGET_DELAY_ROUNDS;
  const body: RollRequest = {
    die,
    kappa,
    client_nonce: clientNonce,
    drand: {
      client_observed_round: observed.round,
      client_observed_signature_hex: observed.signature,
      client_observed_randomness_hex: observed.randomness,
      target_round: targetRound,
    },
  };
  onProgress?.({
    phase: 'submitted',
    observedRound: observed.round,
    targetRound,
    targetDueAtMs: quicknetRoundDueAtMs(targetRound),
  });
  let res: Response;
  try {
    res = await fetch(BASE + '/v1/roll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // No HTTP response at all. The request may still have been stored, so the outcome is
    // unknown; liveness only decides the connection state.
    await markUnavailableIfApiDown();
    throw new RollFailure('outcome_unknown', ROLL_OUTCOME_UNKNOWN_MESSAGE, { cause: err });
  }
  if (res.status >= 500) {
    // A 5xx can come from the edge or tunnel, or from the API after a commit whose ack was
    // lost. Either way the receipt may exist.
    await markUnavailableIfApiDown();
    throw new RollFailure('outcome_unknown', ROLL_OUTCOME_UNKNOWN_MESSAGE, {
      status: res.status,
      cause: new Error('HTTP ' + res.status),
    });
  }
  if (!res.ok) {
    // A 4xx (400, 409, 429) is a definite refusal from a reachable API and never changes
    // the connection state.
    throw new RollFailure(
      res.status === 429 ? 'rate_limited' : 'refused',
      'Roll failed (' + res.status + '): ' + (await res.text()),
      { status: res.status },
    );
  }
  try {
    return (await res.json()) as RollResponse;
  } catch (err) {
    // The API answered success but the body was lost or truncated: the receipt exists.
    throw new RollFailure('outcome_unknown', ROLL_OUTCOME_UNKNOWN_MESSAGE, { cause: err });
  }
}

// After a failed live call, re-probe liveness. A down API becomes 'unavailable', never
// 'demo': simulated receipts are only ever chosen at startup.
async function markUnavailableIfApiDown(): Promise<void> {
  if (!(await probeApi())) setMode('unavailable');
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
export async function getTruerollsKeys(
  options: { signal?: AbortSignal } = {},
): Promise<TruerollsKeys> {
  if (_mode === 'demo') {
    throw new Error('key fetch requires live API');
  }
  const res = await fetch(BASE + '/.well-known/truerolls-keys.json', { signal: options.signal });
  if (!res.ok) {
    throw new Error(`Key fetch failed (${res.status}): ${await res.text()}`);
  }
  const body: unknown = await res.json();
  return parseTruerollsKeys(body);
}
