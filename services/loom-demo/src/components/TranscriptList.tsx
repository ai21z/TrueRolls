import { useState } from 'react';
import type { EditedCopy, TranscriptEntry } from '../types/kd';
import { TranscriptRow } from './TranscriptRow';
import css from './TranscriptList.module.css';

interface Props {
  rolls: TranscriptEntry[];
  onVerify: (localId: number) => void;
  onClear: () => void;
  editedCopy: EditedCopy | null;
  onVerifyEditedCopy?: (localId: number, body: Record<string, unknown>) => void;
  onDiscardEditedCopy?: () => void;
  mock: boolean;
}

export function TranscriptList({
  rolls,
  onVerify,
  onClear,
  editedCopy,
  onVerifyEditedCopy,
  onDiscardEditedCopy,
  mock,
}: Props) {
  const [confirmingClear, setConfirmingClear] = useState(false);
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
              Check all ({uncheckedCount})
            </button>
          )}
          {rolls.length > 0 && !confirmingClear && (
            <button
              className={css.clearBtn}
              onClick={() => setConfirmingClear(true)}
              title="Clear this tab's local history"
            >
              Clear local history
            </button>
          )}
          <span className={css.count}>{rolls.length}</span>
        </div>
      </div>

      {confirmingClear && rolls.length > 0 && (
        <div className={css.confirm} role="group" aria-label="Confirm clearing local history">
          <p className={css.confirmText}>
            Remove {rolls.length === 1 ? 'this receipt' : `these ${rolls.length} receipts`} from this
            tab's list? Receipts the API stored and files you downloaded are not affected, but this
            page cannot bring the list back.
          </p>
          <div className={css.confirmActions}>
            <button
              className={css.confirmDanger}
              onClick={() => {
                setConfirmingClear(false);
                onClear();
              }}
            >
              Clear local history
            </button>
            <button className={css.confirmCancel} onClick={() => setConfirmingClear(false)} autoFocus>
              Keep the list
            </button>
          </div>
        </div>
      )}

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
              editedCopy={editedCopy}
              onVerifyEditedCopy={onVerifyEditedCopy}
              onDiscardEditedCopy={onDiscardEditedCopy}
              mock={mock}
            />
          ))}
        </div>
      )}
    </aside>
  );
}

