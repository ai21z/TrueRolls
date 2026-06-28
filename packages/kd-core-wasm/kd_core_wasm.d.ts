/* tslint:disable */
/* eslint-disable */
/**
 * Compute the distribution and replay the face for a 64-bit draw (JS BigInt).
 * Returns the `computeDistributionJson` payload plus `"face"` and `"draw_u64"`
 * (draw stringified).
 */
export function computeRollReplayJson(die: string, kappa: number, draw: bigint): string;
/**
 * Verify a signed TrueRolls receipt entirely client-side - Ed25519 signature,
 * DRBG sampling replay, face, and metric caps - using the shared `kd_receipt`
 * engine (identical to `kd verify --receipt`).
 *
 * - `receiptJson`: the raw receipt JSON string.
 * - `publicKeyB64`: base64 of the 32-byte Ed25519 verifying key (from
 *   `/.well-known/truerolls-keys.json`).
 *
 * Returns a JSON string:
 * `{"verdict": "VALID"|"INVALID"|"ERROR", "valid_signature", "valid_sampling",
 *   "face_ok", "metrics_ok", "details", "errors"}`. `ERROR` (with an `error`
 * field) is returned for structurally unverifiable input. Never throws.
 */
export function verifyReceiptJson(receipt_json: string, public_key_b64: string): string;
/**
 * Map a 64-bit draw (JS BigInt) onto `probs` via prefix-CDF; returns the 1-based face.
 * `probs.length` must equal the die size.
 */
export function faceFromDraw(die: string, probs: Float64Array, draw: bigint): number;
/**
 * Returns [`ENGINE_LABEL`].
 */
export function engineLabel(): string;
/**
 * Returns `kd_core::PARAM_VERSION` ("roll.math.v1").
 */
export function paramVersion(): string;
/**
 * Compute the guarded distribution for `die` ("d4".."d100") at stance `kappa`.
 * Returns a JSON string:
 * `{"engine", "param_version", "probs", "alpha", "kl", "ev", "guards_applied"}`.
 */
export function computeDistributionJson(die: string, kappa: number): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly computeDistributionJson: (a: number, b: number, c: number) => [number, number, number, number];
  readonly computeRollReplayJson: (a: number, b: number, c: number, d: bigint) => [number, number, number, number];
  readonly engineLabel: () => [number, number];
  readonly faceFromDraw: (a: number, b: number, c: number, d: number, e: bigint) => [number, number, number];
  readonly paramVersion: () => [number, number];
  readonly verifyReceiptJson: (a: number, b: number, c: number, d: number) => [number, number];
  readonly __wbindgen_export_0: WebAssembly.Table;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
