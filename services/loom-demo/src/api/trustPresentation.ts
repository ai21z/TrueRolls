import { DRAND_RECEIPT_VERSION, hasDrandProof } from './receipt';
import type { KeySource } from './keys';
import type { ReceiptVerifyResponse, VerifyStatus } from '../types/kd';

export type TrustTone = 'ok' | 'fail' | 'pending' | 'neutral';

export interface TrustPill {
  label: string;
  tone: TrustTone;
}

export type VerificationPhase = 'not_checked' | 'loading' | 'verifying' | 'complete';
export type VerificationState =
  | 'not_checked'
  | 'loading'
  | 'verifying'
  | 'valid'
  | 'invalid'
  | 'unverifiable';

export function normalizePersistedVerifyStatus(value: unknown): VerifyStatus {
  // Positive and in-progress states are runtime evidence, not durable facts.
  // A reload must re-run verification before presenting either as trusted.
  if (value === 'mismatch' || value === 'error') return value;
  return 'not_checked';
}

interface VerificationReportLike {
  verdict: 'VALID' | 'INVALID' | 'ERROR';
}

export function verificationState(args: {
  phase: VerificationPhase;
  report: VerificationReportLike | null;
  keySource: KeySource;
}): VerificationState {
  if (args.phase !== 'complete') return args.phase;
  if (!args.report || args.report.verdict === 'ERROR') return 'unverifiable';
  if (args.report.verdict === 'VALID') return 'valid';
  return args.keySource === 'unresolved' ? 'unverifiable' : 'invalid';
}

export function verificationStateLabel(state: VerificationState): string {
  switch (state) {
    case 'not_checked':
      return 'NOT CHECKED';
    case 'loading':
      return 'LOADING';
    case 'verifying':
      return 'VERIFYING';
    case 'valid':
      return 'VALID';
    case 'invalid':
      return 'INVALID';
    case 'unverifiable':
      return 'UNVERIFIABLE';
  }
}

export type CheckName = 'signature' | 'drand' | 'sampling' | 'face' | 'metrics';

interface CheckReportLike {
  verdict: 'VALID' | 'INVALID' | 'ERROR';
  valid_signature?: boolean;
  valid_drand?: boolean;
  valid_sampling?: boolean;
  face_ok?: boolean;
  metrics_ok?: boolean;
  errors?: string[];
}

const CHECK_TITLES: Record<CheckName, string> = {
  signature: 'Signature',
  drand: 'Drand',
  sampling: 'Seed replay',
  face: 'Face',
  metrics: 'Metrics',
};

/** The checks a report says failed, in verifier order. The drand check only
 * counts for a drand-versioned receipt; the shared verifier leaves it true for
 * other versions, and a stray proof.drand on a legacy receipt is never judged. */
export function failingChecks(
  report: CheckReportLike,
  receipt: { v?: unknown; proof?: unknown },
): CheckName[] {
  const out: CheckName[] = [];
  if (report.valid_signature === false) out.push('signature');
  if (receiptHasVersionedDrandProof(receipt) && report.valid_drand === false) out.push('drand');
  if (report.valid_sampling === false) out.push('sampling');
  if (report.face_ok === false) out.push('face');
  if (report.metrics_ok === false) out.push('metrics');
  return out;
}

/** One sentence explaining an INVALID verdict from the checks that actually
 * failed, never from how the receipt was produced. */
export function invalidSummary(
  report: CheckReportLike,
  receipt: { v?: unknown; proof?: unknown },
): string {
  const failed = failingChecks(report, receipt);
  const errors = report.errors ?? [];
  const named = failed.map((c) => CHECK_TITLES[c]).join(', ');
  if (errors.some((e) => e.includes('revoked'))) {
    return 'The signing key is revoked by the issuer, so this receipt is not accepted.';
  }
  if (failed.length === 0) {
    return 'The verifier rejected this receipt. See the reasons below.';
  }
  if (failed[0] === 'signature') {
    return failed.length === 1
      ? 'The signature does not match these bytes. A signed value changed, or another key signed it.'
      : `Failed: ${named}. The signature does not match these bytes, so no other check can rescue it.`;
  }
  const lead =
    failed[0] === 'drand'
      ? 'The signature holds, but the drand beacon proof does not verify.'
      : failed[0] === 'sampling'
        ? 'The signature holds, but the seed replay does not reproduce the signed draw.'
        : 'The signature holds, but the recomputed outcome does not match the receipt.';
  return failed.length === 1 ? lead : `${lead} Failed: ${named}.`;
}

export function keyTrustExplanation(source: KeySource): string {
  switch (source) {
    case 'well-known':
      return 'Issuer key discovered from /.well-known. It authenticates the named issuer; it does not remove issuer trust.';
    case 'demo':
      return 'Public demo key. It demonstrates verification mechanics but is not issuer-backed evidence.';
    case 'manual':
      return 'Manual key, published key-status checks bypassed.';
    case 'unresolved':
      return 'No issuer trust root matched this receipt.';
  }
}

/// A demo/mock-minted artifact, a receipt the live server never issued. It is
/// identified by its `mock-` id prefix, which live rolls (real UUIDs) never
/// carry. This is the ONE marker used for both verify routing and demo labeling,
/// so an *unsigned live* roll (real id, no signer configured) is NOT mistaken for
/// a demo mint and still reaches the server math-recompute path.
export function isMockArtifact(entry: { id: string; sig?: unknown | null } | null | undefined): boolean {
  if (!entry) return false;
  return entry.id.startsWith('mock-');
}

export function statusPillForArtifact(
  verifyStatus: VerifyStatus,
  mockArtifact: boolean,
): TrustPill {
  if (mockArtifact) return { label: 'Demo', tone: 'neutral' };

  switch (verifyStatus) {
    case 'verified_local':
      // Only ever set by the demo branch where no cryptographic check ran, so it
      // is never presented as a completed verification.
      return { label: 'Demo', tone: 'neutral' };
    case 'verified_server':
      return { label: 'Verified', tone: 'ok' };
    case 'mismatch':
      return { label: 'Mismatch', tone: 'fail' };
    case 'pending':
      return { label: 'Verifying...', tone: 'pending' };
    case 'error':
      return { label: 'Error', tone: 'fail' };
    case 'not_checked':
    default:
      return { label: 'Not verified', tone: 'neutral' };
  }
}

export function transcriptRowVerdict(
  verifyStatus: VerifyStatus,
  mockArtifact: boolean,
): { text: string; kind: 'none' | 'demo' | 'ok' | 'pending' | 'mismatch' | 'error' } {
  if (mockArtifact) return { text: 'Demo', kind: 'demo' };

  switch (verifyStatus) {
    case 'not_checked':
      return { text: '', kind: 'none' };
    case 'pending':
      return { text: 'Verifying...', kind: 'pending' };
    case 'verified_local':
      // Demo branch, no crypto ran. Never label it Verified.
      return { text: 'Demo', kind: 'demo' };
    case 'verified_server':
      return { text: 'Verified', kind: 'ok' };
    case 'mismatch':
      return { text: 'Mismatch', kind: 'mismatch' };
    case 'error':
      return { text: 'Error', kind: 'error' };
  }
}

export function heroReceiptPill(args: {
  entry: { id: string; sig?: unknown | null } | null;
  verify: ReceiptVerifyResponse | null;
  tampered: boolean;
  verifiedOk: boolean;
}): TrustPill {
  if (!args.entry || isMockArtifact(args.entry)) return { label: 'Demo', tone: 'neutral' };
  if (args.tampered) return { label: 'Tampered', tone: 'fail' };
  if (args.verify) {
    return args.verifiedOk
      ? { label: 'Verified', tone: 'ok' }
      : { label: 'Invalid', tone: 'fail' };
  }
  // Only claim "Signed" when a signature is actually present; an unsigned live
  // roll (no signer configured) must not read as signed.
  return { label: args.entry.sig != null ? 'Signed' : 'Unsigned', tone: 'neutral' };
}

export function drandSummaryForReceipt(value: { v?: unknown; proof?: unknown }): string {
  if (value.v === DRAND_RECEIPT_VERSION && hasDrandProof(value)) {
    return 'For truerolls-drand-1, VALID proves the seed came from a verified public drand beacon and the outcome replays from that seed.';
  }
  return 'For legacy truerolls-1, VALID proves signed replay and bounded math only.';
}

export function receiptHasVersionedDrandProof(value: { v?: unknown; proof?: unknown }): boolean {
  return value.v === DRAND_RECEIPT_VERSION && hasDrandProof(value);
}
