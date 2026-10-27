/**
 * kd-core wasm engine boundary for the loom demo.
 *
 * All demo math (guarded distribution, KL/EV metrics, alpha solving,
 * prefix-CDF face replay) comes from `packages/kd-core-wasm`, the wasm-pack
 * build of `crates/kd-core-wasm` (a thin wasm-bindgen wrapper over the pure
 * `kd-core` Rust crate). No math is duplicated in TypeScript.
 *
 * The wasm module needs async initialization, so this module owns a
 * module-scoped singleton:
 * - `initKdCoreWasm()` is idempotent and must complete before any math call.
 *   The wasm asset URL is resolved by Vite via an explicit `?url` import and
 *   fetched by the wasm-bindgen glue.
 * - The sync wrappers throw 'kd-core wasm engine not initialized' if called
 *   before initialization resolves. There is no silent fallback engine.
 */
import init, {
  computeDistributionJson,
  computeRollReplayJson,
  engineLabel,
  verifyReceiptJson,
  verifyReceiptJsonWithKeySet,
} from 'kd-core-wasm';
import kdCoreWasmUrl from 'kd-core-wasm/kd_core_wasm_bg.wasm?url';
import type { Die } from '../types/kd';

export interface KdCoreWasmDistribution {
  probs: number[];
  alpha: number;
  kl: number;
  ev: number;
}

export interface KdCoreWasmRollReplay extends KdCoreWasmDistribution {
  face: number;
  drawU64: string;
}

interface WasmDistributionPayload {
  engine: string;
  param_version: string;
  probs: number[];
  alpha: number;
  kl: number;
  ev: number;
  guards_applied: boolean;
}

interface WasmRollReplayPayload extends WasmDistributionPayload {
  face: number;
  draw_u64: string;
}

let ready = false;
let initPromise: Promise<void> | null = null;

export function isKdCoreWasmReady(): boolean {
  return ready;
}

/**
 * Idempotent async initialization of the kd-core wasm engine.
 * Rejects (and allows retry) if the wasm asset cannot be loaded. Callers must
 * surface that failure honestly instead of falling back to other math.
 */
export async function initKdCoreWasm(): Promise<void> {
  if (ready) {
    return;
  }
  if (!initPromise) {
    initPromise = init({ module_or_path: kdCoreWasmUrl })
      .then(() => {
        ready = true;
      })
      .catch((error: unknown) => {
        initPromise = null;
        throw error;
      });
  }
  return initPromise;
}

function assertKdCoreWasmReady(): void {
  if (!ready) {
    throw new Error('kd-core wasm engine not initialized; await initKdCoreWasm() first');
  }
}

/** Runtime engine label from the wasm module (e.g. "kd-core-wasm-roll.math.v1"). */
export function kdCoreWasmEngineLabel(): string {
  assertKdCoreWasmReady();
  return engineLabel();
}

/**
 * Guarded distribution for `die` at stance `kappa` from kd-core (wasm).
 * Throws if the engine is not initialized or if kd-core rejects the input
 * (unsupported die, non-finite kappa, guard solve failure).
 */
export function computeGuardedDistributionWasm(die: Die, kappa: number): KdCoreWasmDistribution {
  assertKdCoreWasmReady();
  const payload = JSON.parse(computeDistributionJson(die, kappa)) as WasmDistributionPayload;
  return {
    probs: payload.probs,
    alpha: payload.alpha,
    kl: payload.kl,
    ev: payload.ev,
  };
}

/**
 * Guarded distribution plus deterministic prefix-CDF face replay for a
 * 64-bit draw, all computed by kd-core (wasm).
 */
export function computeRollReplayWasm(die: Die, kappa: number, draw: bigint): KdCoreWasmRollReplay {
  assertKdCoreWasmReady();
  const payload = JSON.parse(computeRollReplayJson(die, kappa, draw)) as WasmRollReplayPayload;
  return {
    probs: payload.probs,
    alpha: payload.alpha,
    kl: payload.kl,
    ev: payload.ev,
    face: payload.face,
    drawU64: payload.draw_u64,
  };
}

export type ReceiptVerdict = 'VALID' | 'INVALID' | 'ERROR';

/**
 * Result of {@link verifyReceiptWasm}. Mirrors the `kd_receipt` engine output,
 * the *same* verification the CLI runs (`kd verify --receipt`). On `ERROR`
 * (structurally unverifiable input) only `verdict` and `error` are meaningful.
 */
export interface WasmVerifyReport {
  verdict: ReceiptVerdict;
  valid_signature?: boolean;
  valid_drand?: boolean;
  valid_sampling?: boolean;
  face_ok?: boolean;
  metrics_ok?: boolean;
  details?: {
    recomputed_face: number;
    recomputed_alpha: number;
    recomputed_kl: number;
    recomputed_ev: number;
    tol: number;
  };
  errors?: string[];
  error?: string;
}

/**
 * Verify a signed TrueRolls receipt entirely in the browser via the shared
 * `kd_receipt` engine (Ed25519 signature + JCS canon + DRBG replay + metric
 * caps). No network call to the minting server, the verdict is computed locally.
 * Never throws: unverifiable input returns `{ verdict: 'ERROR', error }`.
 */
export function verifyReceiptWasm(receiptJson: string, publicKeyB64: string): WasmVerifyReport {
  assertKdCoreWasmReady();
  return JSON.parse(verifyReceiptJson(receiptJson, publicKeyB64)) as WasmVerifyReport;
}

export function verifyReceiptWasmWithKeySet(
  receiptJson: string,
  keySetJson: string,
): WasmVerifyReport {
  assertKdCoreWasmReady();
  return JSON.parse(verifyReceiptJsonWithKeySet(receiptJson, keySetJson)) as WasmVerifyReport;
}
