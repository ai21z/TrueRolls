/**
 * Shared receipt-field readers + the version-aware proof model for the Behind a
 * TrueRoll surfaces (A/B/C).
 *
 * One copy so the ceremony rail (A), the specimen plate (B) and the contact
 * sheet (C) can never disagree about what counts as an object, how a field is
 * stringified, whether a receipt is beacon-backed (drand version + drand proof
 * present, NOT a verification verdict), or what its version actually proves.
 * Pure, defensive, no throw.
 */

import type { ReceiptVerdict } from '../../api/wasmEngine';

/** Receipt versions, mirrored from `kd-receipt` (RECEIPT_VERSION / DRAND_RECEIPT_VERSION). */
export const DRAND_VERSION = 'truerolls-drand-1';
export const LEGACY_VERSION = 'truerolls-1';

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function readField(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

export function shorten(s: string, head = 10, tail = 6): string {
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/** The declared receipt version (`receipt.v`), or null if absent/non-string. */
export function receiptVersion(parsed: Record<string, unknown> | null): string | null {
  if (!parsed) return null;
  return typeof parsed.v === 'string' ? parsed.v : null;
}

export function isDrandReceipt(parsed: Record<string, unknown> | null): boolean {
  return receiptVersion(parsed) === DRAND_VERSION;
}

export function isLegacyReceipt(parsed: Record<string, unknown> | null): boolean {
  return receiptVersion(parsed) === LEGACY_VERSION;
}

/**
 * The single legacy/drand predicate. A receipt is beacon-backed iff it DECLARES
 * the drand version AND carries a `proof.drand` block. This mirrors the verifier
 * exactly: `kd-receipt` only runs drand BLS/HKDF checks when
 * `receipt.v == "truerolls-drand-1"` and otherwise leaves `valid_drand=true` by
 * default. Keying on field-presence alone would let a legacy receipt carrying a
 * stray `proof.drand` block be narrated as beacon-backed across A/B/C even though
 * the engine never verified it, a false provenance surface. Surfaces A, B and C
 * all derive their drand presentation from THIS so they can never disagree.
 */
export function hasBeacon(parsed: Record<string, unknown> | null): boolean {
  if (!parsed) return false;
  return isDrandReceipt(parsed) && asRecord(parsed.proof).drand != null;
}

/**
 * Canonical, version-aware proof-scope line, the single source of truth for
 * "what this receipt's version proves", consumed by the verdict pill (B), the
 * contact-sheet pill (C) and the closing prose so they can never drift. Returns
 * null unless the receipt verified VALID (an INVALID/UNVERIFIABLE receipt makes
 * no positive claim).
 */
export function proofScope(
  parsed: Record<string, unknown> | null,
  report: { verdict?: ReceiptVerdict } | null,
): string | null {
  if (report?.verdict !== 'VALID') return null;
  return hasBeacon(parsed) ? 'drand seed provenance + replay' : 'signed replay + bounded math only';
}
