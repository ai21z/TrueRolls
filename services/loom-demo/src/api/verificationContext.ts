/**
 * Identity of a verification request and of the context a verdict was computed
 * in. A verdict is displayable only while its context id still equals the id
 * derived from the current inputs, so a late or superseded result can never be
 * shown against a different receipt, key, origin or key-set revision.
 */

export interface VerificationRequestInput {
  text: string;
  /** Only the labelled bundled sample may fall back to the public demo key. */
  allowDemoFallback: boolean;
  /** A non-blank key the user supplied by hand, or null for issuer resolution. */
  manualKey: string | null;
}

export function verificationRequestKey(input: VerificationRequestInput): string {
  return JSON.stringify([
    input.text,
    input.allowDemoFallback,
    input.manualKey === null ? null : input.manualKey.trim(),
  ]);
}

export interface VerificationContextInput {
  requestKey: string;
  /** False when the text fails input diagnosis; such a verdict needs no keys or engine. */
  inputOk: boolean;
  manual: boolean;
  /** Revision of the issuer key set the resolution used, or null while it is unknown. */
  keysRevision: number | null;
  engine: string;
}

export function verificationContextId(input: VerificationContextInput): string {
  if (!input.inputOk) return `${input.requestKey}|input`;
  const keys = input.manual ? 'manual' : `keys:${input.keysRevision ?? 'pending'}`;
  return `${input.requestKey}|${keys}|engine:${input.engine}`;
}

/** The single binding predicate: a stored result belongs to the current view. */
export function isBoundResult(
  result: { contextId: string } | null,
  requested: string | null,
  requestKey: string,
  contextId: string,
): boolean {
  return result !== null && requested === requestKey && result.contextId === contextId;
}
