import type { ReceiptVerifyResponse, RollResponse, TranscriptEntry } from '../types/kd';

export const DRAND_RECEIPT_VERSION = 'truerolls-drand-1';

/**
 * The canonical ReceiptV2 body for POST /v1/verify.
 *
 * Constructed explicitly (no spread) so the POST body never carries the
 * envelope field `deduplicated` or local-only UI fields (localId,
 * verifyStatus, verifyDetail, verifyChecks). Optional fields
 * are included only when present, matching the server's
 * `skip_serializing_if = Option::is_none` serialization of ReceiptV2.
 */
export type ReceiptBody = Omit<RollResponse, 'deduplicated'>;

export function buildReceiptBody(entry: TranscriptEntry): ReceiptBody {
  const body: ReceiptBody = {
    v: entry.v,
    id: entry.id,
    die: entry.die,
    kappa: entry.kappa,
    face: entry.face,
    alpha: entry.alpha,
    kl: entry.kl,
    ev: entry.ev,
    created_at: entry.created_at,
    transcript_url: entry.transcript_url,
    proof: entry.proof,
  };
  if (entry.transcript_key != null) body.transcript_key = entry.transcript_key;
  if (entry.receipt_hash != null) body.receipt_hash = entry.receipt_hash;
  if (entry.sig != null) body.sig = entry.sig;
  return body;
}

export function hasDrandProof(value: { v?: unknown; proof?: unknown }): boolean {
  if (value.v !== DRAND_RECEIPT_VERSION) return false;
  const proof = value.proof;
  if (proof === null || typeof proof !== 'object') return false;
  return (proof as { drand?: unknown }).drand != null;
}

export function receiptVerifierAccepts(
  value: { v?: unknown; proof?: unknown },
  res: ReceiptVerifyResponse,
): boolean {
  const isDrandReceipt = value.v === DRAND_RECEIPT_VERSION;
  return (
    res.valid_signature &&
    (!isDrandReceipt || (hasDrandProof(value) && res.valid_drand)) &&
    res.valid_sampling &&
    res.face_ok &&
    res.metrics_ok
  );
}

export type OfflineVerifyCommandOptions =
  | { kind: 'server'; server: string }
  | { kind: 'public-key'; publicKey: string };

function psArg(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * PowerShell-friendly CLI verification snippet: save the receipt JSON to
 * receipt.json via a here-string, then run the shared verifier. Issuer-backed
 * receipts should use `--server` so kd-cli fetches the key set and applies
 * active/retired/revoked status. Manual/demo receipts use `--public-key`.
 */
export function offlineVerifyCommand(
  receiptJson: string,
  options: OfflineVerifyCommandOptions,
): string {
  const verifyArgs =
    options.kind === 'server'
      ? `--server ${psArg(options.server)}`
      : `--public-key ${psArg(options.publicKey)}`;
  return [
    "@'",
    receiptJson,
    "'@ | Set-Content -Path receipt.json",
    `kd verify --receipt receipt.json ${verifyArgs}`,
  ].join('\n');
}
