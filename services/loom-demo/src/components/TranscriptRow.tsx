import { useState } from 'react';
import type { Die, ReceiptVerifyResponse, TranscriptEntry } from '../types/kd';
import { KL_CAPS } from '../constants/caps';
import { tamperedView } from '../api/receipt';
import { isMockArtifact, transcriptRowVerdict } from '../api/trustPresentation';
import { TranscriptReceipt } from './TranscriptReceipt';
import css from './TranscriptRow.module.css';

interface Props {
  entry: TranscriptEntry;
  onVerify: (localId: number) => void;
  onBreak?: (localId: number, body: Record<string, unknown>, result: ReceiptVerifyResponse) => void;
  onUnbreak?: (localId: number) => void;
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

export function TranscriptRow({ entry, onVerify, onBreak, onUnbreak, mock }: Props) {
  const [showReceipt, setShowReceipt] = useState(false);

  // A tampered die overrides the stored status everywhere: the break lives on the
  // entry, so this row reads broken and shows the forged value until the edit is
  // reverted. A tampered receipt stays broken, no path back to "Verified".
  const tampered = entry.tampered ?? null;
  const broken = !!tampered;
  const view = tampered
    ? tamperedView(tampered.body, { face: entry.face, kappa: entry.kappa, die: entry.die })
    : { face: entry.face, kappa: entry.kappa, die: entry.die };

  const mockArtifact = isMockArtifact(entry);
  const isVerified = !broken && !mockArtifact && entry.verifyStatus === 'verified_server';
  const isFailed = broken || entry.verifyStatus === 'mismatch' || entry.verifyStatus === 'error';

  const rowClass = [
    css.row,
    isVerified ? css.rowVerified : '',
    isFailed ? css.rowMismatch : '',
  ].join(' ');

  const klCap = KL_CAPS[entry.die as Die] ?? KL_CAPS.d20;
  const verdict = broken
    ? { text: '✕ Tampered', cls: css.verdictMismatch }
    : (() => {
        const v = transcriptRowVerdict(entry.verifyStatus, mockArtifact);
        return { text: v.text, cls: verdictClass(v.kind) };
      })();
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
              title={broken ? 'Tampered: the receipt no longer matches its signature' : entry.verifyDetail}
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

          {!broken &&
            (entry.verifyStatus === 'not_checked' || entry.verifyStatus === 'error') && (
              <button className={css.verifyBtn} onClick={() => onVerify(entry.localId)}>
                {entry.verifyStatus === 'error' ? 'Retry' : 'Verify'}
              </button>
            )}
        </div>
      </div>

      {showReceipt && (
        <TranscriptReceipt
          entry={entry}
          onClose={() => setShowReceipt(false)}
          onBreak={onBreak}
          onUnbreak={onUnbreak}
          mock={mock}
        />
      )}
    </>
  );
}
