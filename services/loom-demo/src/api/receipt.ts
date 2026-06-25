import type { RollResponse, TranscriptEntry } from '../types/kd';

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

/**
 * The values a tampered receipt body claims — what every broken-die surface shows
 * (the forged face/κ), so the seed, the credential, the transcript row and the
 * receipt modal all display the same altered artifact instead of the pristine roll.
 */
export function tamperedView(
  body: Record<string, unknown>,
  fallback: { face: number; kappa: number; die: string },
): { face: number; kappa: number; die: string } {
  return {
    face: typeof body.face === 'number' ? body.face : fallback.face,
    kappa: typeof body.kappa === 'number' ? body.kappa : fallback.kappa,
    die: typeof body.die === 'string' ? body.die : fallback.die,
  };
}

/**
 * PowerShell-friendly offline verification snippet: save the receipt JSON to
 * receipt.json via a here-string, then run the shared CLI verifier. Shared by
 * the receipt card and the in-browser verify page so the printed command never
 * drifts between them.
 */
export function offlineVerifyCommand(receiptJson: string, publicKey: string): string {
  return [
    "@'",
    receiptJson,
    "'@ | Set-Content -Path receipt.json",
    `kd verify --receipt receipt.json --public-key ${publicKey}`,
  ].join('\n');
}
