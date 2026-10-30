import { useState, useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { Die, EditedCopy, TranscriptEntry, VerifyCheckRow, VerifyStatus } from '../types/kd';
import {
  getClientMode,
  initClient,
  isMockMode,
  postRoll,
  postVerify,
  postVerifyReceipt,
  subscribeClientMode,
  type RollProgress,
} from '../api/client';
import { describeRollFailure, type RollErrorView, type RollOrigin } from '../api/rollMessages';

export type { RollErrorView, RollOrigin } from '../api/rollMessages';
import {
  getKdCoreWasmStatus,
  initKdCoreWasm,
  subscribeKdCoreWasm,
} from '../api/wasmEngine';
import { buildReceiptBody, hasDrandProof, receiptVerifierAccepts } from '../api/receipt';
import { isMockArtifact, normalizePersistedVerifyStatus } from '../api/trustPresentation';

const STORAGE_KEY = 'kd-rolls';

/** Guard against corrupt / hand-edited / legacy sessionStorage entries: a
 * shape-wrong entry would crash the transcript list on the first .toFixed(). */
function isRecord(r: unknown): r is Record<string, unknown> {
  return typeof r === 'object' && r !== null && !Array.isArray(r);
}

function isValidSig(sig: unknown): boolean {
  if (sig == null) return true;
  if (!isRecord(sig)) return false;
  return (
    typeof sig.alg === 'string' &&
    typeof sig.kid === 'string' &&
    typeof sig.signature_b64 === 'string' &&
    typeof sig.canon === 'string'
  );
}

function normalizeEntry(r: unknown): TranscriptEntry | null {
  if (!isRecord(r)) return null;
  const e = r as Record<string, unknown>;
  const proof = e.proof;
  if (!isRecord(proof) || !isRecord(proof.rng)) return null;
  if (typeof proof.draw_u64 !== 'string') return null;
  if (!isValidSig(e.sig)) return null;
  if (typeof e.deduplicated !== 'boolean') return null;

  if (
    typeof e.id === 'string' &&
    typeof e.die === 'string' &&
    typeof e.localId === 'number' &&
    typeof e.kappa === 'number' &&
    typeof e.face === 'number' &&
    typeof e.alpha === 'number' &&
    typeof e.kl === 'number' &&
    typeof e.ev === 'number'
  ) {
    // Older sessions stored an edited demonstration copy on the entry itself
    // (`tampered`). The original fields were never changed, so keep them and drop
    // the copy; the original is re-verified before it shows a positive status.
    const entry = { ...(r as unknown as TranscriptEntry & { tampered?: unknown }) };
    delete entry.tampered;
    const verifyStatus = normalizePersistedVerifyStatus(entry.verifyStatus);
    return {
      ...entry,
      verifyStatus,
      verifyDetail: verifyStatus === 'not_checked' ? undefined : entry.verifyDetail,
      verifyChecks: verifyStatus === 'not_checked' ? undefined : entry.verifyChecks,
    };
  }
  return null;
}

function loadRolls(): TranscriptEntry[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .map(normalizeEntry)
          .filter((entry): entry is TranscriptEntry => entry !== null);
      }
    }
  } catch { /* corrupt data, ignore */ }
  return [];
}

function saveRolls(rolls: TranscriptEntry[]) {
  try {
    // Keep at most 100 rolls in storage
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(rolls.slice(0, 100)));
  } catch { /* quota exceeded, ignore */ }
}

function initialNextId(rolls: TranscriptEntry[]): number {
  if (rolls.length === 0) return 1;
  return Math.max(...rolls.map((r) => r.localId)) + 1;
}

function clientModeSnapshot() {
  return getClientMode();
}

function engineSnapshot() {
  return getKdCoreWasmStatus();
}

export function useKarmaState() {
  const [die, setDie] = useState<Die>('d20');
  // Uniform by default: TrueRolls leads with a verifiable, fair (kappa = 0) die.
  // kappa is an advanced/educational stance, not the default impression.
  const [kappa, setKappa] = useState(0);
  const [rolls, setRolls] = useState<TranscriptEntry[]>(loadRolls);
  const [isRolling, setIsRolling] = useState(false);
  const [rollProgress, setRollProgress] = useState<RollProgress | null>(null);
  const [rollOrigin, setRollOrigin] = useState<RollOrigin | null>(null);
  const [rollError, setRollError] = useState<RollErrorView | null>(null);
  // The roll the latest successful request produced, and which button asked for it.
  const [lastRoll, setLastRoll] = useState<{ localId: number; origin: RollOrigin } | null>(null);
  const rollInFlight = useRef(false);
  const mode = useSyncExternalStore(subscribeClientMode, clientModeSnapshot, clientModeSnapshot);
  const engine = useSyncExternalStore(subscribeKdCoreWasm, engineSnapshot, engineSnapshot);
  const [editedCopy, setEditedCopy] = useState<EditedCopy | null>(null);
  const editedCopyRequest = useRef(0);
  const nextId = useRef(initialNextId(loadRolls()));

  // Persist rolls to sessionStorage on change
  useEffect(() => {
    saveRolls(rolls);
  }, [rolls]);

  // Both dependencies start loading at once; neither blocks the page shell.
  useEffect(() => {
    void initClient();
    initKdCoreWasm().catch((err: unknown) => {
      console.error('[kd] kd-core wasm engine failed to initialize:', err);
    });
  }, []);

  const retryEngine = useCallback(() => {
    initKdCoreWasm().catch((err: unknown) => {
      console.error('[kd] kd-core wasm engine failed to initialize:', err);
    });
  }, []);

  // A fresh roll is a new entry. It never alters earlier dice. One roll at a time:
  // a second activation while one is pending (from either button) is ignored, so a
  // double click can never send a hidden second request.
  const roll = useCallback(
    async (origin: RollOrigin = 'playground') => {
      if (rollInFlight.current) return;
      rollInFlight.current = true;
      setIsRolling(true);
      setRollOrigin(origin);
      setRollProgress(null);
      setRollError(null);
      // The last roll is the one the latest request returned: none until this one
      // does, so a failure never brings back an earlier result as its outcome.
      setLastRoll(null);
      try {
        const res = await postRoll(die, kappa, setRollProgress);
        const entry: TranscriptEntry = {
          ...res,
          localId: nextId.current++,
          verifyStatus: 'not_checked',
        };
        setRolls((prev) => [entry, ...prev]);
        setLastRoll({ localId: entry.localId, origin });
      } catch (err) {
        const view = describeRollFailure(err, origin);
        console.warn('[kd] roll failed:', view.detail ?? view.message);
        setRollError(view);
      } finally {
        rollInFlight.current = false;
        setIsRolling(false);
        setRollProgress(null);
      }
    },
    [die, kappa],
  );

  const verify = useCallback(async (localId: number) => {
    setRolls((prev) =>
      prev.map((r) =>
        r.localId === localId ? { ...r, verifyStatus: 'pending' as const } : r,
      ),
    );

    try {
      const entry = rolls.find((r) => r.localId === localId);
      if (!entry) return;

      // A mock-minted artifact (unsigned, id prefixed `mock-`) is a demo receipt
      // the live server never knew. Treat it as demo regardless of the current
      // session mode, so it is not sent to GET /v1/verify/:id (which would 404).
      const isMockEntry = isMockArtifact(entry);
      const isMock = isMockMode() || isMockEntry;
      let status: VerifyStatus;
      let checks: VerifyCheckRow[];
      let detail: string;

      if (!isMock && entry.v === 'truerolls-drand-1' && entry.sig) {
        const entryHasDrandProof = hasDrandProof(entry);
        const res = await postVerifyReceipt(buildReceiptBody(entry));
        checks = [
          { id: 'signature', label: 'Signature (Ed25519)', ok: res.valid_signature },
          { id: 'rng', label: 'Seed replay (draw_u64)', ok: res.valid_sampling },
          { id: 'face', label: 'Face recompute', ok: res.face_ok },
          { id: 'metrics', label: 'Metrics match (α/KL/EV)', ok: res.metrics_ok },
        ];
        if (entryHasDrandProof) {
          checks.splice(1, 0, { id: 'drand', label: 'Drand beacon proof', ok: res.valid_drand });
        }
        const allOk = receiptVerifierAccepts(entry, res);
        status = allOk ? 'verified_server' : 'mismatch';
        detail = allOk
          ? 'VALID: signed, the drand seed provenance verifies, and the outcome replays from that seed. It does not yet prove an unfavourable completed roll could not have been withheld. Strict witnessed fairness is the v2 protocol.'
          : (res.errors ?? []).join('; ');
      } else if (!isMock && entry.v === 'truerolls-1' && entry.sig) {
        // Signed live receipt → POST /v1/verify with the full ReceiptV2 body.
        // Check rows are derived 1:1 from the server response, never fabricated.
        const res = await postVerifyReceipt(buildReceiptBody(entry));
        checks = [
          { id: 'signature', label: 'Signature (Ed25519)', ok: res.valid_signature },
          { id: 'rng', label: 'RNG replay (draw_u64)', ok: res.valid_sampling },
          { id: 'face', label: 'Face recompute', ok: res.face_ok },
          { id: 'metrics', label: 'Metrics match (α/KL/EV)', ok: res.metrics_ok },
        ];
        const allOk = receiptVerifierAccepts(entry, res);
        status = allOk ? 'verified_server' : 'mismatch';
        detail = allOk
          ? 'Ed25519 signature verification + deterministic replay passed'
          : (res.errors ?? []).join('; ');
      } else if (!isMock) {
        // Unsigned/legacy entry, live API → GET /v1/verify/:id.
        // This path recomputes the math only. It performs NO signature check,
        // so no signature row is shown.
        const res = await postVerify(entry.id);
        checks = [
          {
            id: 'math',
            label: 'Math recompute (α/KL/EV/probs/face)',
            ok: res.verdict === 'OK',
          },
        ];
        status = res.verdict === 'OK' ? 'verified_server' : 'mismatch';
        detail =
          res.verdict === 'OK'
            ? 'Math recompute passed (no signature checked on this path)'
            : (res.mismatches ?? []).join('; ');
      } else {
        // Mock mode (or a mock-minted artifact viewed later in a live session):
        // no verifier ran. No check rows, demo labeling only. Only call the mock
        // client in a real mock session; never send a `mock-` id to the live server.
        if (isMockMode()) await postVerify(entry.id);
        checks = [];
        status = 'verified_local';
        detail = 'DEMO, no cryptographic verification performed';
      }

      setRolls((prev) =>
        prev.map((r) =>
          r.localId === localId
            ? {
                ...r,
                verifyStatus: status,
                verifyChecks: checks,
                verifyDetail: detail,
              }
            : r,
        ),
      );
    } catch {
      setRolls((prev) =>
        prev.map((r) =>
          r.localId === localId
            ? { ...r, verifyStatus: 'error' as const, verifyDetail: 'Verification request failed' }
            : r,
        ),
      );
    }
  }, [rolls]);

  // Clears this tab's local list only. Receipts the API stored, and files the user
  // downloaded, are unaffected.
  const clearHistory = useCallback(() => {
    editedCopyRequest.current += 1;
    setEditedCopy(null);
    setRolls([]);
  }, []);

  const clearRollError = useCallback(() => {
    setRollError(null);
  }, []);

  // Verify an edited demonstration copy of one receipt. The original entry is never
  // touched. Only the newest request may land, and only while its copy is still the
  // one on screen, so a late response cannot attach to a newer copy or roll.
  const verifyEditedCopy = useCallback(async (localId: number, body: Record<string, unknown>) => {
    const requestId = ++editedCopyRequest.current;
    setEditedCopy({ localId, body, requestId, status: 'verifying', result: null, error: null });
    let next: Pick<EditedCopy, 'status' | 'result' | 'error'>;
    try {
      const result = await postVerifyReceipt(body);
      next = { status: 'checked', result, error: null };
    } catch {
      next = {
        status: 'error',
        result: null,
        error: 'The edited copy could not be checked because the verification request failed.',
      };
    }
    setEditedCopy((prev) => (prev && prev.requestId === requestId ? { ...prev, ...next } : prev));
  }, []);

  const discardEditedCopy = useCallback(() => {
    editedCopyRequest.current += 1;
    setEditedCopy(null);
  }, []);

  return {
    die, setDie,
    kappa, setKappa,
    rolls,
    isRolling,
    rollProgress,
    rollOrigin,
    lastRoll,
    connection: mode,
    engine,
    retryEngine,
    mock: mode === 'demo' || isMockMode(),
    apiUnavailable: mode === 'unavailable',
    roll,
    rollError,
    clearRollError,
    verify,
    clearHistory,
    editedCopy,
    verifyEditedCopy,
    discardEditedCopy,
  };
}
