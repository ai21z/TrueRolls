import type { ReceiptVerifyResponse, TranscriptEntry } from '../types/kd';
import { TranscriptRow } from './TranscriptRow';
import css from './TranscriptList.module.css';

interface Props {
  rolls: TranscriptEntry[];
  onVerify: (localId: number) => void;
  onClear: () => void;
  onBreak?: (localId: number, body: Record<string, unknown>, result: ReceiptVerifyResponse) => void;
  onUnbreak?: (localId: number) => void;
  mock: boolean;
}

export function TranscriptList({ rolls, onVerify, onClear, onBreak, onUnbreak, mock }: Props) {
  const uncheckedCount = rolls.filter((r) => r.verifyStatus === 'not_checked').length;

  const verifyAll = () => {
    for (const r of rolls) {
      if (r.verifyStatus === 'not_checked') {
        onVerify(r.localId);
      }
    }
  };

  return (
    <aside className={css.panel}>
      <div className={css.header}>
        <span className={css.title}>Transcripts</span>
        <div className={css.headerActions}>
          {uncheckedCount > 0 && (
            <button className={css.verifyAllBtn} onClick={verifyAll}>
              Verify all ({uncheckedCount})
            </button>
          )}
          {rolls.length > 0 && (
            <button
              className={css.clearBtn}
              onClick={onClear}
              aria-label="Clear all transcripts"
              title="Clear all transcripts"
            >
              Clear
            </button>
          )}
          <span className={css.count}>{rolls.length}</span>
        </div>
      </div>

      {rolls.length === 0 ? (
        <div className={css.empty}>
          No rolls yet.<br />
          Roll to mint your first signed receipt.
        </div>
      ) : (
        <div className={css.list}>
          {rolls.map((entry) => (
            <TranscriptRow
              key={entry.localId}
              entry={entry}
              onVerify={onVerify}
              onBreak={onBreak}
              onUnbreak={onUnbreak}
              mock={mock}
            />
          ))}
        </div>
      )}
    </aside>
  );
}

