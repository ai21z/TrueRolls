import { useCallback, useEffect, useRef } from 'react';
import type { useKarmaState } from '../../hooks/useKarmaState';
import type { HeroPhase } from '../three/HeroCanvas';
import type { Die, VerifyCheckRow } from '../../types/kd';
import {
  buildReceiptBody,
  hasDrandProof as receiptHasDrandProof,
  receiptVerifierAccepts,
} from '../../api/receipt';
import {
  heroReceiptPill,
  invalidSummary,
  isMockArtifact,
  statusPillForArtifact,
} from '../../api/trustPresentation';
import { FACES } from '../../constants/caps';
import { InkFrame } from '../system/InkFrame';
import { InkButton } from '../system/InkButton';
import css from './HeroCredential.module.css';

// Hero rows, keyed by the shared check-row ids the roll's API check records.
const ROW_LABELS: ReadonlyArray<[string, string]> = [
  ['signature', 'Signature'],
  ['drand', 'Drand proof'],
  ['rng', 'Seed replay'],
  ['face', 'Face recompute'],
  ['metrics', 'Metrics'],
];

export const HERO_RECEIPT_ID = 'hero-receipt';

interface Props {
  state: ReturnType<typeof useKarmaState>;
  onPhase: (p: HeroPhase) => void;
}

function CheckRows({ rows, drand }: { rows: VerifyCheckRow[] | null; drand: boolean }) {
  return (
    <div className={css.checks}>
      {ROW_LABELS.filter(([key]) => key !== 'drand' || drand).map(([key, label]) => {
        const ok = rows?.find((r) => r.id === key)?.ok ?? null;
        const word = ok == null ? 'not run' : ok ? 'pass' : 'fail';
        const cls = ok == null ? css.pending : ok ? css.ok : css.fail;
        return (
          <div
            key={key}
            className={`${css.checkRow} ${cls}`}
            data-check-id={key}
            data-check-state={word}
          >
            <span className={css.pip} aria-hidden="true" />
            <span>{label}</span>
            <span className={css.checkWord}>{word}</span>
          </div>
        );
      })}
    </div>
  );
}

export function HeroCredential({ state, onPhase }: Props) {
  const entry = state.rolls.length > 0 ? state.rolls[0] : null;
  const mockArtifact = isMockArtifact(entry);
  const signed = !!entry?.sig && !mockArtifact && !state.mock;
  const hasDrandProof = entry ? receiptHasDrandProof(entry) : false;
  const localId = entry?.localId ?? null;
  const status = entry?.verifyStatus ?? null;
  const editedCopy =
    state.editedCopy && entry && state.editedCopy.localId === entry.localId ? state.editedCopy : null;
  const { verify } = state;
  // One automatic check per roll per mount, even under StrictMode effect replay.
  const autoChecked = useRef<number | null>(null);

  // The latest roll's original receipt is checked once with the API through the
  // shared per-roll status, so the hero, its transcript row and its modal always
  // agree. After a reload that status is 'not_checked' again and re-runs.
  useEffect(() => {
    if (localId === null || !signed || status !== 'not_checked') return;
    if (autoChecked.current === localId) return;
    autoChecked.current = localId;
    void verify(localId);
  }, [localId, signed, status, verify]);

  // The seal follows the reported result, never a timer.
  useEffect(() => {
    if (localId === null) onPhase('idle');
    else onPhase(status === 'verified_server' ? 'sealed' : 'settled');
  }, [localId, status, onPhase]);

  const makeEditedCopy = useCallback(() => {
    if (!entry?.sig) return;
    const body = buildReceiptBody(entry) as Record<string, unknown>;
    const faces = FACES[entry.die as Die] ?? 20;
    body.face = (entry.face % faces) + 1; // alter a signed result value; signature unchanged
    void state.verifyEditedCopy(entry.localId, body);
  }, [entry, state]);

  if (!entry) {
    return (
      <InkFrame seed={64} className={`${css.card} ${css.empty}`} aria-hidden="true">
        <span className={css.emptyText}>Roll to mint a signed receipt</span>
      </InkFrame>
    );
  }

  const kappaText = `${entry.kappa >= 0 ? '+' : ''}${entry.kappa.toFixed(2)}`;
  const trustPill =
    entry.verifyStatus === 'not_checked'
      ? heroReceiptPill({ entry, verify: null, tampered: false, verifiedOk: false })
      : statusPillForArtifact(entry.verifyStatus, mockArtifact);
  const rows = Array.isArray(entry.verifyChecks) ? entry.verifyChecks : null;
  const pillTone =
    trustPill.tone === 'fail' ? css.toneFail : trustPill.tone === 'ok' ? css.toneOk : css.toneNeutral;
  const copyFace = typeof editedCopy?.body.face === 'number' ? editedCopy.body.face : null;
  const copyAccepted =
    editedCopy?.result != null ? receiptVerifierAccepts(editedCopy.body, editedCopy.result) : null;

  return (
    <InkFrame seed={65} className={css.card} id={HERO_RECEIPT_ID} tabIndex={-1} aria-label="Latest receipt">
      <div className={css.head}>
        <span className={css.brand}>Receipt</span>
        <span className={`${css.pill} ${pillTone}`} data-trust-label={trustPill.label}>
          {trustPill.label}
        </span>
      </div>

      <div className={css.result}>
        <span className={css.face}>{entry.face}</span>
        <span className={css.meta}>{entry.die} · κ {kappaText}</span>
      </div>

      <CheckRows rows={rows} drand={hasDrandProof} />
      <p className={css.origin}>
        {!signed
          ? 'No signature to check.'
          : entry.verifyStatus === 'error'
            ? 'The API check did not answer. The receipt is unchanged; check it on the Verify page.'
            : entry.verifyStatus === 'pending' || entry.verifyStatus === 'not_checked'
              ? 'Checking with the TrueRolls API…'
              : 'Checked by the TrueRolls API. Verify it yourself in the browser from the receipt.'}
      </p>

      {editedCopy ? (
        <section className={css.copy} aria-label="Edited copy" data-edited-copy={editedCopy.status}>
          <div className={css.copyHead}>
            <span className={css.copyTitle}>
              Edited copy · face {entry.face} → {copyFace ?? '?'}
            </span>
            <span
              className={`${css.pill} ${copyAccepted === false ? css.toneFail : css.toneNeutral}`}
              data-copy-label={
                editedCopy.status === 'verifying'
                  ? 'checking'
                  : copyAccepted === false
                    ? 'invalid'
                    : copyAccepted
                      ? 'valid'
                      : 'unchecked'
              }
            >
              {editedCopy.status === 'verifying'
                ? 'Checking…'
                : copyAccepted === false
                  ? 'INVALID'
                  : copyAccepted
                    ? 'VALID'
                    : 'Not checked'}
            </span>
          </div>
          <p className={css.copyNote} role="status" aria-live="polite">
            {editedCopy.status === 'verifying'
              ? 'Checking the edited copy with the API.'
              : editedCopy.status === 'error'
                ? editedCopy.error
                : editedCopy.result && copyAccepted === false
                  ? `${invalidSummary({ verdict: 'INVALID', ...editedCopy.result }, editedCopy.body)} The original receipt above is unchanged.`
                  : ''}
          </p>
          <button type="button" className={css.copyDiscard} onClick={state.discardEditedCopy}>
            Discard edited copy
          </button>
        </section>
      ) : (
        <InkButton
          inline={false}
          seed={66}
          frameClassName={css.tamperBtnWrap}
          className={css.tamperBtn}
          onClick={makeEditedCopy}
          disabled={!signed}
          title={signed ? 'Edit a copy of the signed face and check that copy' : 'Start the API for real signing'}
        >
          Edit a copy &amp; re-verify
        </InkButton>
      )}
    </InkFrame>
  );
}
