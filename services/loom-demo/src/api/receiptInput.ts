import { DRAND_RECEIPT_VERSION } from './receipt';

export const LEGACY_RECEIPT_VERSION = 'truerolls-1';

export type ReceiptInputProblem =
  | { code: 'empty'; message: string }
  | { code: 'invalid_json'; message: string }
  | { code: 'not_object'; message: string }
  | { code: 'unsupported_version'; message: string };

export type ReceiptInputDiagnosis =
  | { ok: true; receipt: Record<string, unknown>; version: string }
  | ({ ok: false } & ReceiptInputProblem);

/**
 * Classify pasted or uploaded receipt text before any key lookup or verifier
 * call, so an input problem is reported as an input problem. Without this, a
 * broken paste reaches key resolution with no kid and reads as a missing key.
 * It never judges signatures or math; those stay with the shared verifier.
 */
export function diagnoseReceiptInput(text: string): ReceiptInputDiagnosis {
  if (text.trim() === '') {
    return { ok: false, code: 'empty', message: 'Paste a receipt, upload a .json file, or load a sample.' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      code: 'invalid_json',
      message: 'This is not valid JSON. Check that the whole receipt was copied, including the outer braces.',
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      code: 'not_object',
      message: 'A receipt is a single JSON object. This input is a different JSON value.',
    };
  }
  const receipt = parsed as Record<string, unknown>;
  const version = receipt.v;
  if (version !== DRAND_RECEIPT_VERSION && version !== LEGACY_RECEIPT_VERSION) {
    return {
      ok: false,
      code: 'unsupported_version',
      message:
        typeof version === 'string'
          ? `Receipt version "${version}" is not supported. This verifier reads ${DRAND_RECEIPT_VERSION} and ${LEGACY_RECEIPT_VERSION}.`
          : `This JSON has no receipt version field "v". This verifier reads ${DRAND_RECEIPT_VERSION} and ${LEGACY_RECEIPT_VERSION}.`,
    };
  }
  return { ok: true, receipt, version };
}
