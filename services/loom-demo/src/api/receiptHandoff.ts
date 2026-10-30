/**
 * One-shot, same-tab hand-off of one exact receipt from the playground to the
 * Verify page. sessionStorage only: nothing goes into the URL, nothing leaves
 * the browser, and it confers no key trust. Verify still resolves the issuer
 * key by its normal policy.
 */

const HANDOFF_KEY = 'tr-verify-handoff';
export const HANDOFF_MAX_AGE_MS = 10 * 60 * 1000;

export interface ReceiptHandoff {
  token: string;
  receiptJson: string;
  /** Roll id of the handed-off receipt, shown so the user can match it. */
  rollId: string | null;
  /** 'original' for the issued receipt, 'edited-copy' for a tamper demonstration copy. */
  kind: 'original' | 'edited-copy';
  createdAt: number;
}

export type HandoffRead =
  | { status: 'none' }
  | { status: 'ok'; handoff: ReceiptHandoff }
  | { status: 'expired'; token: string }
  | { status: 'malformed'; token: string | null };

function randomToken(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Store a receipt for the next Verify mount. Returns false if storage is blocked. */
export function stashReceiptForVerify(
  receiptJson: string,
  meta: { rollId: string | null; kind: ReceiptHandoff['kind'] },
  now: number = Date.now(),
): boolean {
  const handoff: ReceiptHandoff = {
    token: randomToken(),
    receiptJson,
    rollId: meta.rollId,
    kind: meta.kind,
    createdAt: now,
  };
  try {
    sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(handoff));
    return true;
  } catch {
    return false;
  }
}

/** Read the pending hand-off without consuming it (safe to call during render). */
export function peekReceiptHandoff(now: number = Date.now()): HandoffRead {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(HANDOFF_KEY);
  } catch {
    return { status: 'none' };
  }
  if (raw === null) return { status: 'none' };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { status: 'malformed', token: null };
  }
  const v = value as Partial<ReceiptHandoff> | null;
  if (
    v === null ||
    typeof v !== 'object' ||
    typeof v.token !== 'string' ||
    typeof v.receiptJson !== 'string' ||
    typeof v.createdAt !== 'number' ||
    (v.kind !== 'original' && v.kind !== 'edited-copy') ||
    (v.rollId !== null && typeof v.rollId !== 'string')
  ) {
    return { status: 'malformed', token: typeof v?.token === 'string' ? v.token : null };
  }
  if (now - v.createdAt > HANDOFF_MAX_AGE_MS || now < v.createdAt - 60_000) {
    return { status: 'expired', token: v.token };
  }
  return { status: 'ok', handoff: v as ReceiptHandoff };
}

/** Consume the hand-off identified by `token`. A different (newer) hand-off is left alone. */
export function consumeReceiptHandoff(token: string | null): void {
  try {
    const raw = sessionStorage.getItem(HANDOFF_KEY);
    if (raw === null) return;
    if (token === null) {
      sessionStorage.removeItem(HANDOFF_KEY);
      return;
    }
    const parsed = JSON.parse(raw) as { token?: unknown };
    if (parsed.token === token) sessionStorage.removeItem(HANDOFF_KEY);
  } catch {
    try {
      sessionStorage.removeItem(HANDOFF_KEY);
    } catch {
      /* storage blocked */
    }
  }
}
