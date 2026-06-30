import { useState, useCallback, useEffect, useRef } from 'react';
import type { Die, ReceiptVerifyResponse, TranscriptEntry, VerifyCheckRow, VerifyStatus } from '../types/kd';
import { initClient, isMockMode, postRoll, postVerify, postVerifyReceipt } from '../api/client';
import { buildReceiptBody, hasDrandProof } from '../api/receipt';

const STORAGE_KEY = 'kd-rolls';

/** Guard against corrupt / hand-edited / legacy sessionStorage entries: a
 * shape-wrong entry would crash the transcript list on the first .toFixed(). */
function isValidEntry(r: unknown): r is TranscriptEntry {
  if (typeof r !== 'object' || r === null) return false;
  const e = r as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    typeof e.die === 'string' &&
    typeof e.localId === 'number' &&
    typeof e.kappa === 'number' &&
    typeof e.face === 'number' &&
    typeof e.alpha === 'number' &&
    typeof e.kl === 'number' &&
    typeof e.ev === 'number'
  );
}

function loadRolls(): TranscriptEntry[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed.filter(isValidEntry);
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

export function useKarmaState() {
  const [die, setDie] = useState<Die>('d20');
  // Uniform by default: TrueRolls leads with a verifiable, fair (kappa = 0) die.
  // kappa is an advanced/educational stance, not the default impression.
  const [kappa, setKappa] = useState(0);
  const [rolls, setRolls] = useState<TranscriptEntry[]>(loadRolls);
  const [isRolling, setIsRolling] = useState(false);
  const [rollStatus, setRollStatus] = useState<string | null>(null);
  const [mock, setMock] = useState(false);
  const [ready, setReady] = useState(false);
  const [rollError, setRollError] = useState<string | null>(null);
  const nextId = useRef(initialNextId(loadRolls()));

  // Persist rolls to sessionStorage on change
  useEffect(() => {
    saveRolls(rolls);
  }, [rolls]);

  useEffect(() => {
    initClient().then((live) => {
      setMock(!live);
      setReady(true);
    });
  }, []);

  // A fresh roll is a new entry. It never alters earlier dice. A die broken by a
  // tamper stays broken (its `tampered` artifact lives on its own entry).
  const roll = useCallback(async () => {
    setIsRolling(true);
    setRollStatus('Fetching public drand beacon…');
    setRollError(null);
    try {
      setRollStatus('Waiting for verified drand target round…');
      const res = await postRoll(die, kappa);
      const entry: TranscriptEntry = {
        ...res,
        localId: nextId.current++,
        verifyStatus: 'not_checked',
      };
      setRolls((prev) => [entry, ...prev]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Roll failed';
      console.error('[kd] roll error:', err);
      setRollError(msg);
      setTimeout(() => setRollError(null), 3000);
    } finally {
      setIsRolling(false);
      setRollStatus(null);
    }
  }, [die, kappa]);

  const verify = useCallback(async (localId: number) => {
    setRolls((prev) =>
      prev.map((r) =>
        r.localId === localId ? { ...r, verifyStatus: 'pending' as const } : r,
      ),
    );

    try {
      const entry = rolls.find((r) => r.localId === localId);
      if (!entry) return;

      const isMock = isMockMode();
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
        const allOk =
          res.valid_signature &&
          entryHasDrandProof &&
          res.valid_drand &&
          res.valid_sampling &&
          res.face_ok &&
          res.metrics_ok;
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
        const allOk =
          res.valid_signature && res.valid_sampling && res.face_ok && res.metrics_ok;
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
        // Mock mode: no verifier ran. No check rows, demo labeling only.
        await postVerify(entry.id);
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

  const clearHistory = useCallback(() => {
    setRolls([]);
    nextId.current = 1;
  }, []);

  // Record that a die was broken by a tamper: store the forged body + the verifier's
  // real failing result ON the entry, so every surface (hero, seed, transcript, modal)
  // renders the same broken artifact AND it survives re-rolls and reloads. The roll's
  // pristine fields are untouched. Reverting the edit clears `tampered`.
  const markTampered = useCallback(
    (localId: number, body: Record<string, unknown>, result: ReceiptVerifyResponse) => {
      setRolls((prev) =>
        prev.map((r) => (r.localId === localId ? { ...r, tampered: { body, result } } : r)),
      );
    },
    [],
  );

  // Reverting a tamper back to a passing receipt restores that one die.
  const clearTamper = useCallback((localId: number) => {
    setRolls((prev) =>
      prev.map((r) => {
        if (r.localId !== localId) return r;
        const next = { ...r };
        delete next.tampered;
        return next;
      }),
    );
  }, []);

  return {
    die, setDie,
    kappa, setKappa,
    rolls,
    isRolling,
    rollStatus,
    mock: mock || isMockMode(),
    ready,
    roll,
    rollError,
    verify,
    clearHistory,
    markTampered,
    clearTamper,
  };
}
