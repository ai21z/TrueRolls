export type Die = 'd6' | 'd20' | 'd100';

export interface RollRequest {
  die: Die;
  kappa: number;
  client_nonce: string;
  drand: RollDrandRequest;
}

export interface RollDrandRequest {
  client_observed_round: number;
  client_observed_signature_hex: string;
  client_observed_randomness_hex: string;
  target_round: number;
}

/** ReceiptV2 proof block */
export interface ReceiptProof {
  math_param_version: string;
  rng: {
    drbg_key_hex: string;
    algo: string;
  };
  draw_u64: string;
  drand?: ReceiptDrandProof;
}

export interface ReceiptDrandProof {
  chain_hash: string;
  scheme: string;
  public_key: string;
  period_seconds: number;
  genesis_time: number;
  target_delay_rounds: number;
  client_nonce: string;
  client_observed_round: number;
  client_observed_signature_hex: string;
  client_observed_randomness_hex: string;
  target_round: number;
  target_signature_hex: string;
  target_randomness_hex: string;
  idem_payload_sha256_hex: string;
}

/** ReceiptV2 signature block */
export interface ReceiptSignature {
  alg: string;
  kid: string;
  signature_b64: string;
  canon: string;
}

/** ReceiptV2 response from POST /v1/roll (201) */
export interface RollResponse {
  // Receipt fields
  v: string;              // "truerolls-1" | "truerolls-drand-1"
  id: string;
  die: string;
  kappa: number;
  face: number;
  alpha: number;
  kl: number;
  ev: number;
  created_at: string;
  transcript_url: string;
  transcript_key?: string | null;
  proof: ReceiptProof;
  receipt_hash?: string | null;
  sig?: ReceiptSignature | null;
  // Envelope field
  deduplicated: boolean;
}

export interface VerifyResponse {
  verdict: 'OK' | 'MISMATCH';
  // The server omits these (serde skip_serializing_if empty) on the OK path.
  mismatches?: string[];
  warnings?: string[];
  recomputed: {
    face: number;
    alpha: number;
    kl: number;
    ev: number;
  };
}

/** Details block of POST /v1/verify (receipt body) - mirrors kd-api ReceiptVerifyDetails. */
export interface ReceiptVerifyDetails {
  sig: string; // "valid" | "invalid"
  recomputed_face: number;
  recomputed_ev: number;
  recomputed_kl: number;
  recomputed_alpha: number;
  tol: number;
}

/**
 * Response of POST /v1/verify with a ReceiptV2 body ("v":"truerolls-1" or "truerolls-drand-1") -
 * mirrors kd-api ReceiptVerifyResponse. Failed checks still return HTTP 200
 * with false flags; `errors` is omitted when empty.
 */
export interface ReceiptVerifyResponse {
  valid_signature: boolean;
  valid_drand: boolean;
  valid_sampling: boolean;
  face_ok: boolean;
  metrics_ok: boolean;
  details: ReceiptVerifyDetails;
  errors?: string[];
}

export type VerifyStatus =
  | 'not_checked'
  | 'pending'
  | 'verified_local'
  | 'verified_server'
  | 'mismatch'
  | 'error';

/**
 * One verification check row, derived 1:1 from an actual verifier response.
 * Rows must never be fabricated client-side: no response field → no row.
 */
export interface VerifyCheckRow {
  id: string;
  label: string;
  ok: boolean;
}

/** The forged artifact for a tampered die: the edited receipt body + the verifier's
 * real failing response. Stored ON the entry it broke (and persisted with it), so a
 * tampered die stays broken across re-rolls and reloads - a tampered receipt is
 * permanently invalid. */
export interface EntryTamper {
  body: Record<string, unknown>;
  result: ReceiptVerifyResponse;
}

export interface TranscriptEntry extends RollResponse {
  localId: number;
  verifyStatus: VerifyStatus;
  verifyDetail?: string;
  verifyChecks?: VerifyCheckRow[];
  /** Present iff this die was broken by a tamper (see EntryTamper). Cleared by
   * reverting the edit; a fresh roll is a new entry and is never auto-broken. */
  tampered?: EntryTamper;
}
