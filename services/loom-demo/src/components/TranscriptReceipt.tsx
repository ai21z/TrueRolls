import { useEffect, useRef, useState } from 'react';
import type { Die, ReceiptVerifyResponse, TranscriptEntry, VerifyCheckRow } from '../types/kd';
import { KL_CAPS, FACES } from '../constants/caps';
import { getTruerollsKeys, postVerifyReceipt } from '../api/client';
import { buildReceiptBody, hasDrandProof as receiptHasDrandProof, offlineVerifyCommand, tamperedView } from '../api/receipt';
import css from './TranscriptReceipt.module.css';

interface Props {
  entry: TranscriptEntry;
  onClose: () => void;
  onBreak?: (localId: number, body: Record<string, unknown>, result: ReceiptVerifyResponse) => void;
  onUnbreak?: (localId: number) => void;
  mock: boolean;
}

const PUBKEY_PLACEHOLDER = '<public-key-from-/.well-known/truerolls-keys.json>';

type PillTone = 'ok' | 'fail' | 'pending' | 'neutral';

function statusPill(entry: TranscriptEntry, mock: boolean): { label: string; tone: PillTone } {
  switch (entry.verifyStatus) {
    case 'verified_local':
      return mock
        ? { label: 'Demo', tone: 'neutral' }
        : { label: 'Verified · local', tone: 'ok' };
    case 'verified_server':
      return { label: 'Verified · server', tone: 'ok' };
    case 'mismatch':
      return { label: 'Mismatch', tone: 'fail' };
    case 'pending':
      return { label: 'Verifying…', tone: 'pending' };
    case 'error':
      return { label: 'Error', tone: 'fail' };
    case 'not_checked':
    default:
      return { label: 'Not verified', tone: 'neutral' };
  }
}

/** Check rows derived 1:1 from a ReceiptVerifyResponse, never fabricated. */
function receiptCheckRows(res: ReceiptVerifyResponse, hasDrandProof: boolean): VerifyCheckRow[] {
  const rows = [
    { id: 'signature', label: 'Signature (Ed25519)', ok: res.valid_signature },
    { id: 'rng', label: 'Seed replay (draw_u64)', ok: res.valid_sampling },
    { id: 'face', label: 'Face recompute', ok: res.face_ok },
    { id: 'metrics', label: 'Metrics match (α/KL/EV)', ok: res.metrics_ok },
  ];
  if (hasDrandProof && typeof res.valid_drand === 'boolean') {
    rows.splice(1, 0, { id: 'drand', label: 'Drand beacon proof', ok: res.valid_drand });
  }
  return rows;
}

function tamperSummary(res: ReceiptVerifyResponse, hasDrandProof: boolean): string {
  const allOk =
    res.valid_signature &&
    res.valid_drand !== false &&
    res.valid_sampling &&
    res.face_ok &&
    res.metrics_ok;
  if (allOk) {
    return hasDrandProof
      ? 'VALID: signed, the drand seed provenance verifies, and the outcome replays from that seed. It does not yet prove an unfavourable completed roll could not have been withheld. Strict witnessed fairness is the v2 protocol.'
      : 'VALID proves the signed receipt replays deterministically. This legacy receipt has no drand proof.';
  }
  if (!res.valid_signature) {
    return 'Ed25519 signature verification failed. The receipt was modified after signing.';
  }
  return 'Deterministic replay mismatch. The recomputed values do not match the receipt fields.';
}

function Pip({ ok }: { ok: boolean }) {
  return (
    <span className={`${css.pip} ${ok ? css.pipOk : css.pipFail}`} aria-hidden="true">
      {ok ? '✓' : '✕'}
    </span>
  );
}

export function TranscriptReceipt({ entry, onClose, onBreak, onUnbreak, mock }: Props) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const credentialRef = useRef<HTMLDivElement>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // A broken die reads broken here too: forged values, failed checks, and a
  // copy/verify that uses the tampered body, never the pristine receipt. The break
  // lives on the entry, so it persists across re-rolls and reloads.
  const tampered = entry.tampered ?? null;
  const broken = !!tampered;
  const view = tampered
    ? tamperedView(tampered.body, { face: entry.face, kappa: entry.kappa, die: entry.die })
    : { face: entry.face, kappa: entry.kappa, die: entry.die };

  // Tamper demo is only shown for signed receipts from the live API. Mock
  // receipts have no signature and nothing real to verify against.
  const isReceiptVersion = entry.v === 'truerolls-1' || entry.v === 'truerolls-drand-1';
  const isSignedLive = isReceiptVersion && !!entry.sig && !mock;
  const hasDrandProof = receiptHasDrandProof(entry);

  // ── Tamper editor state. Seeded from the tampered body when already broken,
  // so re-verifying continues from the current broken artifact. ──
  const [tamperJson, setTamperJson] = useState<string>(() =>
    JSON.stringify(tampered?.body ?? buildReceiptBody(entry), null, 2),
  );
  const [editorOpen, setEditorOpen] = useState(false);
  const [tamperResult, setTamperResult] = useState<ReceiptVerifyResponse | null>(null);
  const [tamperError, setTamperError] = useState<string | null>(null);
  const [tamperBusy, setTamperBusy] = useState(false);
  const [publicKey, setPublicKey] = useState<string | null>(null);

  const sigKid = entry.sig?.kid ?? null;

  // Modal focus contract: move focus into the dialog, trap Tab/Shift+Tab inside
  // it, and restore focus to the opener on close (Esc, overlay click, or ✕).
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    credentialRef.current?.focus();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = credentialRef.current;
      if (!root) return;
      const focusable = root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  // Fetch the published Ed25519 key once for the offline-verify snippet.
  useEffect(() => {
    if (!isSignedLive) return;
    let cancelled = false;
    getTruerollsKeys()
      .then((res) => {
        if (cancelled) return;
        const match = res.keys.find((k) => k.kid === sigKid) ?? res.keys[0];
        if (match) setPublicKey(match.public_key);
      })
      .catch(() => {
        /* key fetch failed, the snippet keeps the placeholder */
      });
    return () => {
      cancelled = true;
    };
  }, [isSignedLive, sigKid]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopiedField(label);
      setTimeout(() => setCopiedField(null), 1500);
    }).catch(() => {});
  };

  const mutateTamperJson = (mutator: (obj: Record<string, unknown>) => void) => {
    try {
      const obj = JSON.parse(tamperJson) as Record<string, unknown>;
      mutator(obj);
      setTamperJson(JSON.stringify(obj, null, 2));
      setTamperError(null);
    } catch {
      setTamperError('Tampered JSON is not valid JSON. Fix it before applying a mutation.');
    }
  };

  const flipFace = () =>
    mutateTamperJson((obj) => {
      const faces = FACES[entry.die as Die] ?? 20;
      const face = typeof obj.face === 'number' ? obj.face : entry.face;
      obj.face = (face % faces) + 1;
    });

  const bumpKappa = () =>
    mutateTamperJson((obj) => {
      const kappa = typeof obj.kappa === 'number' ? obj.kappa : entry.kappa;
      obj.kappa = kappa > 0.9 ? kappa - 0.1 : Math.min(1, kappa + 0.1);
    });

  const reverifyTampered = async () => {
    setTamperBusy(true);
    setTamperResult(null);
    setTamperError(null);
    try {
      const parsed = JSON.parse(tamperJson) as Record<string, unknown>;
      const res = await postVerifyReceipt(parsed);
      setTamperResult(res);
      // Lift the result into shared state so the hero die, the seed, this row and
      // modal all agree. A failing edit breaks the die everywhere. Reverting it back
      // to a passing receipt restores the valid die. The stored receipt is untouched.
      const allOk =
        res.valid_signature &&
        res.valid_drand !== false &&
        res.valid_sampling &&
        res.face_ok &&
        res.metrics_ok;
      if (allOk) onUnbreak?.(entry.localId);
      else onBreak?.(entry.localId, parsed, res);
    } catch (err) {
      setTamperError(
        err instanceof Error ? err.message : 'Receipt verification request failed',
      );
    } finally {
      setTamperBusy(false);
    }
  };

  const ts = entry.created_at
    ? new Date(entry.created_at).toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '-';

  const klCap = KL_CAPS[entry.die as Die] ?? KL_CAPS.d20;
  // When broken, the verification block, the pill and the verdict all read the
  // shared tamper result, never the stored (valid) checks. Old sessions may have
  // persisted the pre-KD-029 object shape. Only render response-derived rows.
  const storedChecks = Array.isArray(entry.verifyChecks)
    ? entry.verifyChecks.filter((row) => hasDrandProof || row.id !== 'drand')
    : null;
  const checks = broken && tampered ? receiptCheckRows(tampered.result, hasDrandProof) : storedChecks;
  const pill = broken
    ? { label: 'Tampered', tone: 'fail' as PillTone }
    : statusPill(entry, mock);
  const verifyDetailText = broken && tampered
    ? tamperSummary(tampered.result, hasDrandProof)
    : entry.verifyDetail;
  const kappaText = `${view.kappa >= 0 ? '+' : ''}${view.kappa.toFixed(2)}`;
  const signedKid = entry.sig?.kid ?? null;

  // Shareable receipt JSON, the tampered body when broken (so copy/verify genuinely
  // fail), else the canonical ReceiptV2 body, else the legacy subset.
  const receiptJson = broken && tampered
    ? JSON.stringify(tampered.body, null, 2)
    : isReceiptVersion
    ? JSON.stringify(buildReceiptBody(entry), null, 2)
    : JSON.stringify({
        id: entry.id,
        die: entry.die,
        kappa: entry.kappa,
        face: entry.face,
        alpha: entry.alpha,
        kl: entry.kl,
        ev: entry.ev,
        created_at: entry.created_at,
        transcript_key: entry.transcript_key ?? '',
      }, null, 2);

  const keyForSnippet = publicKey ?? PUBKEY_PLACEHOLDER;
  const tamperRows = tamperResult ? receiptCheckRows(tamperResult, hasDrandProof) : null;

  return (
    <div
      className={css.overlay}
      ref={overlayRef}
      onClick={handleOverlayClick}
      role="dialog"
      aria-modal="true"
      aria-label="Receipt"
    >
      <div className={css.credential} ref={credentialRef} tabIndex={-1}>
        <header className={css.header}>
          <div className={css.brand}>
            <span className={css.brandMark}>truerolls</span>
            <span className={css.brandSub}>Receipt · {entry.v}</span>
          </div>
          <div className={css.headerRight}>
            <span className={`${css.pillStatus} ${css[`tone_${pill.tone}`]}`}>{pill.label}</span>
            <button className={css.closeX} onClick={onClose} aria-label="Close receipt">✕</button>
          </div>
        </header>

        <div className={css.result}>
          <span className={css.bigFace}>{view.face}</span>
          <div className={css.resultMeta}>
            <span className={css.dieKappa}>
              {view.die} · κ {kappaText}
            </span>
            <span className={css.subtle}>{broken ? 'tampered value' : 'face value'}</span>
          </div>
        </div>

        {/* Verifier checks, rendered 1:1 from the verifier response. */}
        {checks && checks.length > 0 && (
          <section className={css.section}>
            <div className={css.sectionLabel}>Verification</div>
            <div className={css.checkList}>
              {checks.map((row) => (
                <div key={row.id} className={css.checkRow}>
                  <Pip ok={row.ok} />
                  <span className={css.checkLabel}>{row.label}</span>
                </div>
              ))}
            </div>
            {verifyDetailText && <div className={css.verifyDetail}>{verifyDetailText}</div>}
          </section>
        )}

        {/* Bounded-math chips */}
        <div className={css.metrics}>
          <div className={css.metricChip}>
            <span className={css.metricLabel}>alpha</span>
            <span className={css.metricValue}>{entry.alpha.toFixed(3)}</span>
          </div>
          <div className={css.metricChip}>
            <span className={css.metricLabel}>KL ≤ {klCap}</span>
            <span className={css.metricValue}>{entry.kl.toFixed(4)}</span>
          </div>
          <div className={css.metricChip}>
            <span className={css.metricLabel}>EV</span>
            <span className={css.metricValue}>{entry.ev.toFixed(2)}</span>
          </div>
        </div>

        {/* Provenance */}
        <dl className={css.metaList}>
          <div className={css.metaRow}>
            <dt>Roll id</dt>
            <dd className={css.mono}>{entry.id.slice(0, 18)}…</dd>
          </div>
          <div className={css.metaRow}>
            <dt>Issued</dt>
            <dd>{ts}</dd>
          </div>
          <div className={css.metaRow}>
            <dt>Signature</dt>
            <dd className={`${css.mono} ${css.truncate}`}>
              {signedKid ? `Ed25519 · ${signedKid}` : 'unsigned'}
            </dd>
          </div>
          {entry.proof.drand && (
            <div className={css.metaRow}>
              <dt>Drand</dt>
              <dd className={`${css.mono} ${css.truncate}`}>
                quicknet · round {entry.proof.drand.target_round}
              </dd>
            </div>
          )}
          {(entry.transcript_url || entry.transcript_key) && (
            <div className={css.metaRow}>
              <dt>Transcript</dt>
              <dd className={`${css.mono} ${css.truncate}`}>
                {entry.transcript_url ?? entry.transcript_key}
              </dd>
            </div>
          )}
          {entry.deduplicated && (
            <div className={css.metaRow}>
              <dt>Note</dt>
              <dd>Deduplicated</dd>
            </div>
          )}
        </dl>

        {!checks && verifyDetailText && (
          <div className={css.verifyDetail}>{verifyDetailText}</div>
        )}

        {/* Actions */}
        <div className={css.actions}>
          <button className={css.actionBtn} onClick={() => copyToClipboard(receiptJson, 'json')}>
            {copiedField === 'json' ? 'Copied' : 'Copy receipt'}
          </button>
          <button
            className={css.actionBtn}
            onClick={() => {
              const cmd = isReceiptVersion
                ? offlineVerifyCommand(receiptJson, keyForSnippet)
                : 'kd verify --input receipt.json';
              copyToClipboard(cmd, 'cli');
            }}
          >
            {copiedField === 'cli' ? 'Copied' : 'Copy verify command'}
          </button>
          <button
            className={css.actionBtn}
            onClick={() => copyToClipboard(`${location.origin}/#verify`, 'link')}
          >
            {copiedField === 'link' ? 'Copied' : 'Copy link'}
          </button>
        </div>

        {/* ── Tamper demo, signed live receipts only ── */}
        {isSignedLive && (
          <section className={css.tamperSection}>
            <div className={css.tamperTitle}>Tamper demo</div>
            <p className={css.tamperNote}>
              Edit a copy of this signed receipt and re-verify it against the server.
              Ed25519 signature verification catches any post-signing edit. Deterministic
              replay recomputes draw, face and metrics. For drand receipts, VALID also verifies
              the public drand seed provenance and the replay from that seed. (It does not yet
              prove an unfavourable completed roll could not have been withheld. That is the v2
              protocol.) The original roll's status is never changed by this demo.
            </p>

            <div className={css.tamperBtnRow}>
              <button className={css.tamperBtn} onClick={flipFace}>Flip face</button>
              <button className={css.tamperBtn} onClick={bumpKappa}>Bump kappa</button>
              <button
                className={css.tamperBtn}
                onClick={() => setEditorOpen((o) => !o)}
                aria-expanded={editorOpen}
              >
                {editorOpen ? 'Hide JSON' : 'Edit JSON'}
              </button>
            </div>

            {editorOpen && (
              <textarea
                className={css.tamperEditor}
                value={tamperJson}
                onChange={(e) => setTamperJson(e.target.value)}
                spellCheck={false}
                aria-label="Tampered receipt JSON"
                rows={10}
              />
            )}

            <button
              className={css.tamperVerifyBtn}
              onClick={reverifyTampered}
              disabled={tamperBusy}
            >
              {tamperBusy ? 'Verifying…' : 'Re-verify tampered receipt'}
            </button>

            {tamperError && <div className={css.tamperErrorBox}>{tamperError}</div>}

            {tamperResult && tamperRows && (
              <div className={css.tamperResult}>
                <div className={css.checkList}>
                  {tamperRows.map((row) => (
                    <div key={row.id} className={css.checkRow}>
                      <Pip ok={row.ok} />
                      <span className={css.checkLabel}>{row.label}</span>
                    </div>
                  ))}
                </div>
                {(tamperResult.errors ?? []).length > 0 && (
                  <ul className={css.tamperErrors}>
                    {(tamperResult.errors ?? []).map((err, i) => (
                      <li key={i}>{err}</li>
                    ))}
                  </ul>
                )}
                <div className={css.tamperSummary}>{tamperSummary(tamperResult, hasDrandProof)}</div>
              </div>
            )}

            <div className={css.tamperBtnRow}>
              <button
                className={css.actionBtn}
                onClick={() => copyToClipboard(tamperJson, 'tamper-json')}
              >
                {copiedField === 'tamper-json' ? 'Copied' : 'Copy tampered JSON'}
              </button>
              <button
                className={css.actionBtn}
                onClick={() =>
                  copyToClipboard(offlineVerifyCommand(tamperJson, keyForSnippet), 'tamper-cli')
                }
              >
                {copiedField === 'tamper-cli' ? 'Copied' : 'Copy offline command'}
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
