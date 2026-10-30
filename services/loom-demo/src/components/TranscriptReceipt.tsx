import { useEffect, useRef, useState } from 'react';
import type { Die, EditedCopy, ReceiptVerifyResponse, TranscriptEntry, VerifyCheckRow } from '../types/kd';
import { KL_CAPS, FACES } from '../constants/caps';
import { getApiBaseForCli } from '../api/client';
import { DEMO_TEST_KEY, DEMO_TEST_KID } from '../api/keys';
import {
  buildReceiptBody,
  hasDrandProof as receiptHasDrandProof,
  offlineVerifyCommand,
  receiptVerifierAccepts,
} from '../api/receipt';
import { downloadJson, receiptFilename } from '../api/download';
import { stashReceiptForVerify } from '../api/receiptHandoff';
import { invalidSummary, isMockArtifact, statusPillForArtifact } from '../api/trustPresentation';
import css from './TranscriptReceipt.module.css';

interface Props {
  entry: TranscriptEntry;
  onClose: () => void;
  editedCopy: EditedCopy | null;
  onVerifyEditedCopy?: (localId: number, body: Record<string, unknown>) => void;
  onDiscardEditedCopy?: () => void;
  mock: boolean;
}

const PUBKEY_PLACEHOLDER = '<public-key-from-/.well-known/truerolls-keys.json>';

/** Check rows derived 1:1 from a ReceiptVerifyResponse, never fabricated. */
function receiptCheckRows(
  res: ReceiptVerifyResponse,
  receipt: { v?: unknown; proof?: unknown },
): VerifyCheckRow[] {
  const hasDrandProof = receiptHasDrandProof(receipt);
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

function CheckList({ rows }: { rows: VerifyCheckRow[] }) {
  return (
    <div className={css.checkList}>
      {rows.map((row) => (
        <div
          key={row.id}
          className={`${css.checkRow} ${row.ok ? css.checkOk : css.checkFail}`}
          data-check-id={row.id}
          data-check-state={row.ok ? 'pass' : 'fail'}
        >
          <span className={`${css.pip} ${row.ok ? css.pipOk : css.pipFail}`} aria-hidden="true" />
          <span className={css.checkLabel}>{row.label}</span>
          <span className={css.checkWord}>{row.ok ? 'pass' : 'fail'}</span>
        </div>
      ))}
    </div>
  );
}

export function TranscriptReceipt({
  entry,
  onClose,
  editedCopy,
  onVerifyEditedCopy,
  onDiscardEditedCopy,
  mock,
}: Props) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const credentialRef = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState<{ text: string; tone: 'ok' | 'fail' } | null>(null);

  // Tamper demo is only shown for signed receipts from the live API. Mock
  // receipts have no signature and nothing real to verify against.
  const isReceiptVersion = entry.v === 'truerolls-1' || entry.v === 'truerolls-drand-1';
  const mockArtifact = isMockArtifact(entry);
  const isSignedLive = isReceiptVersion && !!entry.sig && !mockArtifact && !mock;
  const originalBody = buildReceiptBody(entry);
  const hasDrandProof = receiptHasDrandProof(originalBody);
  const ownCopy = editedCopy && editedCopy.localId === entry.localId ? editedCopy : null;

  // The edited copy's editor text. Seeded from an existing copy of this receipt,
  // else from the original body. The original itself is never edited.
  const [copyJson, setCopyJson] = useState<string>(() =>
    JSON.stringify(ownCopy?.body ?? originalBody, null, 2),
  );
  const [editorOpen, setEditorOpen] = useState(false);
  const [copyInputError, setCopyInputError] = useState<string | null>(null);

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

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  };

  const say = (text: string, tone: 'ok' | 'fail' = 'ok') => {
    setNotice({ text, tone });
    if (tone === 'ok') setTimeout(() => setNotice((n) => (n?.text === text ? null : n)), 2500);
  };

  const copyToClipboard = (text: string, what: string) => {
    if (!navigator.clipboard) {
      say(`Copy is blocked in this browser. Download the file instead.`, 'fail');
      return;
    }
    navigator.clipboard
      .writeText(text)
      .then(() => say(`${what} copied.`))
      .catch(() => say(`Copy failed. Download the file instead.`, 'fail'));
  };

  const download = (text: string, filename: string, what: string) => {
    if (downloadJson(filename, text)) say(`${what} saved as ${filename}.`);
    else say('The browser blocked the download. Copy the receipt instead.', 'fail');
  };

  const sendToVerify = (text: string, kind: 'original' | 'edited-copy') => {
    if (!stashReceiptForVerify(text, { rollId: entry.id, kind })) {
      say('This browser blocked the hand-off. Copy or download the receipt, then paste it on the Verify page.', 'fail');
      return;
    }
    onClose();
    window.location.hash = '#verify';
  };

  const parseCopy = (): Record<string, unknown> | null => {
    try {
      const value = JSON.parse(copyJson) as unknown;
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      setCopyInputError(null);
      return value as Record<string, unknown>;
    } catch {
      setCopyInputError('The edited copy is not a JSON object. Fix it before changing or checking it.');
      return null;
    }
  };

  const mutateCopy = (mutator: (obj: Record<string, unknown>) => void) => {
    const obj = parseCopy();
    if (!obj) return;
    mutator(obj);
    setCopyJson(JSON.stringify(obj, null, 2));
  };

  const flipFace = () =>
    mutateCopy((obj) => {
      const faces = FACES[entry.die as Die] ?? 20;
      const face = typeof obj.face === 'number' ? obj.face : entry.face;
      obj.face = (face % faces) + 1;
    });

  const bumpKappa = () =>
    mutateCopy((obj) => {
      const kappa = typeof obj.kappa === 'number' ? obj.kappa : entry.kappa;
      obj.kappa = kappa > 0.9 ? kappa - 0.1 : Math.min(1, kappa + 0.1);
    });

  const checkCopy = () => {
    const obj = parseCopy();
    if (obj) onVerifyEditedCopy?.(entry.localId, obj);
  };

  const discardCopy = () => {
    onDiscardEditedCopy?.();
    setCopyJson(JSON.stringify(originalBody, null, 2));
    setCopyInputError(null);
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
  // Old sessions may have persisted the pre-KD-029 object shape. Only render
  // response-derived rows, and never a drand row for a receipt without a drand proof.
  const storedChecks = Array.isArray(entry.verifyChecks)
    ? entry.verifyChecks.filter((row) => hasDrandProof || row.id !== 'drand')
    : null;
  const pill = statusPillForArtifact(entry.verifyStatus, mockArtifact);
  const kappaText = `${entry.kappa >= 0 ? '+' : ''}${entry.kappa.toFixed(2)}`;
  const signedKid = entry.sig?.kid ?? null;

  // The original receipt JSON: the canonical ReceiptV2 body, else the legacy subset.
  const receiptJson = isReceiptVersion
    ? JSON.stringify(originalBody, null, 2)
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

  // Signed-live receipts verify via --server (which fetches the issuer key set),
  // so no key is embedded. For the non-live public-key snippet we only ever fill
  // in the PUBLIC demo key for a demo-kid receipt (runnable offline); any other
  // kid keeps an explicit placeholder rather than guessing a wrong key.
  const keyForSnippet = sigKid === DEMO_TEST_KID ? DEMO_TEST_KEY : PUBKEY_PLACEHOLDER;
  const cliVerifyOptions = isSignedLive
    ? { kind: 'server' as const, server: getApiBaseForCli() }
    : { kind: 'public-key' as const, publicKey: keyForSnippet };

  // The copy's result is shown only while it still describes the text in the editor.
  const copyResultBound =
    ownCopy?.status === 'checked' && ownCopy.result && JSON.stringify(ownCopy.body, null, 2) === copyJson
      ? ownCopy.result
      : null;
  const copyEditedSinceCheck =
    ownCopy != null && ownCopy.status !== 'verifying' && JSON.stringify(ownCopy.body, null, 2) !== copyJson;
  const copyAccepted = copyResultBound ? receiptVerifierAccepts(ownCopy!.body, copyResultBound) : null;
  const copyIsUnchanged = copyJson === JSON.stringify(originalBody, null, 2);

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
            <span className={css.brandSub}>Original receipt · {entry.v}</span>
          </div>
          <div className={css.headerRight}>
            <span className={`${css.pillStatus} ${css[`tone_${pill.tone}`]}`} data-receipt-status={pill.label}>
              {pill.label}
            </span>
            <button className={css.closeX} onClick={onClose} aria-label="Close receipt">✕</button>
          </div>
        </header>

        <div className={css.result}>
          <span className={css.bigFace}>{entry.face}</span>
          <div className={css.resultMeta}>
            <span className={css.dieKappa}>
              {entry.die} · κ {kappaText}
            </span>
            <span className={css.subtle}>face value</span>
          </div>
        </div>

        {/* Verifier checks of the original, rendered 1:1 from the API response. */}
        {storedChecks && storedChecks.length > 0 && (
          <section className={css.section}>
            <div className={css.sectionLabel}>Checked by the TrueRolls API</div>
            <CheckList rows={storedChecks} />
            {entry.verifyDetail && <div className={css.verifyDetail}>{entry.verifyDetail}</div>}
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
          {hasDrandProof && entry.proof.drand && (
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

        {!storedChecks && entry.verifyDetail && (
          <div className={css.verifyDetail}>{entry.verifyDetail}</div>
        )}

        {/* Actions on the original receipt */}
        <div className={css.actions}>
          {isReceiptVersion && (
            <button className={`${css.actionBtn} ${css.actionPrimary}`} onClick={() => sendToVerify(receiptJson, 'original')}>
              Verify this receipt
            </button>
          )}
          <button
            className={css.actionBtn}
            onClick={() => download(receiptJson, receiptFilename(entry.id), 'Receipt')}
          >
            Download .json
          </button>
          <button className={css.actionBtn} onClick={() => copyToClipboard(receiptJson, 'Receipt')}>
            Copy receipt
          </button>
          <button
            className={css.actionBtn}
            onClick={() => {
              const cmd = isReceiptVersion
                ? offlineVerifyCommand(receiptJson, cliVerifyOptions)
                : 'kd verify --input receipt.json';
              copyToClipboard(cmd, 'Verify command');
            }}
          >
            Copy verify command
          </button>
        </div>
        <p
          className={`${css.notice} ${notice?.tone === 'fail' ? css.noticeFail : ''}`}
          role="status"
          aria-live="polite"
        >
          {notice?.text ?? ''}
        </p>

        {/* ── Edited copy (demonstration), signed live receipts only ── */}
        {isSignedLive && (
          <section className={css.tamperSection} aria-label="Edited copy demonstration">
            <div className={css.tamperTitle}>Edited copy (demonstration)</div>
            <p className={css.tamperNote}>
              Change a signed value in a separate copy and check that copy with the API. The
              signature is left as issued, so the edit should fail. The original receipt above,
              its signature and its status do not change. For drand receipts, VALID also verifies
              the public drand seed provenance and the replay from that seed. (It does not yet
              prove an unfavourable completed roll could not have been withheld. That is the v2
              protocol.)
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
                value={copyJson}
                onChange={(e) => setCopyJson(e.target.value)}
                spellCheck={false}
                aria-label="Edited copy JSON"
                rows={10}
              />
            )}

            <button
              className={css.tamperVerifyBtn}
              onClick={checkCopy}
              disabled={ownCopy?.status === 'verifying'}
            >
              {ownCopy?.status === 'verifying' ? 'Checking the edited copy…' : 'Check the edited copy'}
            </button>
            {copyIsUnchanged && !ownCopy && (
              <p className={css.tamperHint}>The copy is still identical to the original. Flip a value first.</p>
            )}

            {copyInputError && <div className={css.tamperErrorBox}>{copyInputError}</div>}
            {ownCopy?.status === 'error' && !copyEditedSinceCheck && (
              <div className={css.tamperErrorBox}>{ownCopy.error}</div>
            )}
            {copyEditedSinceCheck && (
              <p className={css.tamperHint}>The copy changed since its last check. Check it again.</p>
            )}

            {copyResultBound && (
              <div className={css.tamperResult} data-edited-copy-verdict={copyAccepted ? 'valid' : 'invalid'}>
                <div className={css.copyVerdict}>
                  Edited copy: {copyAccepted ? 'VALID' : 'INVALID'}
                </div>
                <CheckList rows={receiptCheckRows(copyResultBound, ownCopy!.body)} />
                {(copyResultBound.errors ?? []).length > 0 && (
                  <ul className={css.tamperErrors}>
                    {(copyResultBound.errors ?? []).map((err, i) => (
                      <li key={i}>{err}</li>
                    ))}
                  </ul>
                )}
                <div className={css.tamperSummary}>
                  {copyAccepted
                    ? 'This copy still verifies, so nothing signed was changed.'
                    : `${invalidSummary({ verdict: 'INVALID', ...copyResultBound }, ownCopy!.body)} This says nothing negative about the original receipt.`}
                </div>
              </div>
            )}

            {/* An unchanged copy is the original, so none of these hand it on as an
                edited copy. The original's own copy, download and command are above. */}
            <div className={css.tamperBtnRow}>
              <button
                className={css.actionBtn}
                onClick={() => copyToClipboard(copyJson, 'Edited copy')}
                disabled={copyIsUnchanged}
              >
                Copy edited copy
              </button>
              <button
                className={css.actionBtn}
                onClick={() => download(copyJson, receiptFilename(entry.id, '-edited-copy'), 'Edited copy')}
                disabled={copyIsUnchanged}
              >
                Download edited copy
              </button>
              <button
                className={css.actionBtn}
                onClick={() => sendToVerify(copyJson, 'edited-copy')}
                disabled={copyIsUnchanged}
              >
                Verify edited copy in the browser
              </button>
              <button
                className={css.actionBtn}
                onClick={() => copyToClipboard(offlineVerifyCommand(copyJson, cliVerifyOptions), 'Command for the edited copy')}
                disabled={copyIsUnchanged}
              >
                Copy command for the copy
              </button>
              {(ownCopy || !copyIsUnchanged) && (
                <button className={css.actionBtn} onClick={discardCopy}>
                  Discard edited copy
                </button>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
