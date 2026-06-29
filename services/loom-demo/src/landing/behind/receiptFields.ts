/**
 * Shared receipt-field readers for the Behind a TrueRoll surfaces (A/B/C).
 *
 * One copy so the ceremony rail (A) and the specimen plate (B) can never disagree
 * about what counts as an object, how a field is stringified, or whether a
 * receipt carries a drand beacon. Pure, defensive, no throw.
 */

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

/**
 * The single legacy/drand predicate. A receipt is beacon-backed iff it carries a
 * `proof.drand` block. Surfaces A, B and C all derive their legacy degradation
 * from THIS so they can never disagree (e.g. B showing the drand stratum absent
 * while A narrates a BLS verification).
 */
export function hasBeacon(parsed: Record<string, unknown> | null): boolean {
  if (!parsed) return false;
  return asRecord(parsed.proof).drand != null;
}
