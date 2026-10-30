import { useState } from 'react';
import type { Die, EditedCopy, TranscriptEntry } from '../types/kd';
import { KL_CAPS } from '../constants/caps';
import { isMockArtifact, transcriptRowVerdict } from '../api/trustPresentation';
import { TranscriptReceipt } from './TranscriptReceipt';
import css from './TranscriptRow.module.css';

interface Props {
  entry: TranscriptEntry;
  onVerify: (localId: number) => void;
  editedCopy: EditedCopy | null;
  onVerifyEditedCopy?: (localId: number, body: Record<string, unknown>) => void;
  onDiscardEditedCopy?: () => void;
  mock: boolean;
}

function verdictClass(kind: ReturnType<typeof transcriptRowVerdict>['kind']): string {
  switch (kind) {
    case 'demo':
      return css.verdictDemo;
    case 'ok':
      return css.verdictOk;
    case 'pending':
      return css.verdictPending;
    case 'mismatch':
      return css.verdictMismatch;
    case 'error':
      return css.verdictError;
    case 'none':
    default:
      return '';
  }
}

function ReceiptIcon() {
  return (
    <svg
      className={css.receiptIcon}
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 2h8v12l-1.3-1-1.35 1L8 13l-1.35 1L5.3 13 4 14z" />
      <line x1="6" y1="5.5" x2="10" y2="5.5" />
      <line x1="6" y1="8" x2="10" y2="8" />
    </svg>
  );
}

export function TranscriptRow({
  entry,
  onVerify,
  editedCopy,
  onVerifyEditedCopy,
  onDiscardEditedCopy,
  mock,
}: Props) {
  const [showReceipt, setShowReceipt] = useState(false);

  // The row always describes the original receipt. An edited demonstration copy
  // is a separate artifact and never changes this row's value or status.
  const view = { face: entry.face, kappa: entry.kappa, die: entry.die };
  const hasEditedCopy = editedCopy?.localId === entry.localId;

  const mockArtifact = isMockArtifact(entry);
  const isVerified = !mockArtifact && entry.verifyStatus === 'verified_server';
  const isFailed = entry.verifyStatus === 'mismatch' || entry.verifyStatus === 'error';

  const rowClass = [
    css.row,
    isVerified ? css.rowVerified : '',
    isFailed ? css.rowMismatch : '',
  ].join(' ');

  const klCap = KL_CAPS[entry.die as Die] ?? KL_CAPS.d20;
  const rowVerdict = transcriptRowVerdict(entry.verifyStatus, mockArtifact);
  const verdict = { text: rowVerdict.text, cls: verdictClass(rowVerdict.kind) };
  const kappaText = `${view.kappa >= 0 ? '+' : ''}${view.kappa.toFixed(2)}`;

  return (
    <>
      <div className={rowClass}>
        <div className={css.header}>
          <div className={css.idLeft}>
            <span className={css.face}>{view.face}</span>
            <div className={css.idMeta}>
              <span className={css.die}>{view.die}</span>
              <span className={css.kappa}>κ {kappaText}</span>
            </div>
          </div>
          {verdict.text && (
            <span
              className={`${css.verdict} ${verdict.cls}`}
              title={entry.verifyDetail}
              data-row-status={rowVerdict.kind}
            >
              {verdict.text}
            </span>
          )}
        </div>

        <div className={css.metrics}>
          <span>α {entry.alpha.toFixed(3)}</span>
          <span>KL {entry.kl.toFixed(4)}/{klCap}</span>
          <span>EV {entry.ev.toFixed(2)}</span>
        </div>

        <div className={css.rowActions}>
          <button
            className={css.receiptBtn}
            onClick={() => setShowReceipt(true)}
            aria-label="View receipt"
          >
            <ReceiptIcon />
            View receipt
          </button>

          {(entry.verifyStatus === 'not_checked' || entry.verifyStatus === 'error') && (
            <button className={css.verifyBtn} onClick={() => onVerify(entry.localId)}>
              {entry.verifyStatus === 'error' ? 'Check again' : 'Check with API'}
            </button>
          )}
          {hasEditedCopy && <span className={css.copyTag}>edited copy open</span>}
        </div>
      </div>

      {showReceipt && (
        <TranscriptReceipt
          entry={entry}
          onClose={() => setShowReceipt(false)}
          editedCopy={editedCopy}
          onVerifyEditedCopy={onVerifyEditedCopy}
          onDiscardEditedCopy={onDiscardEditedCopy}
          mock={mock}
        />
      )}
    </>
  );
}
