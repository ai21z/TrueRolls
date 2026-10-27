import { verificationStateLabel, type VerificationState } from '../../api/trustPresentation';
import css from './ContactSheet.module.css';

/**
 * ContactSheet, surface C of Behind a TrueRoll (docs/design/behind-a-roll.md).
 *
 * The verification chain compressed: a verdict pill plus one carved cell per
 * stratum, showing the real state from the verifier. It is the page index,
 * clicking a cell focuses that stratum on the Specimen Plate (B) and scrolls to
 * it. Purely presentational: every state/word is passed in from B's real report.
 */

export type CellStatus = 'pass' | 'fail' | 'absent' | 'pending';

export interface Cell {
  key: string;
  label: string;
  status: CellStatus;
  word: string;
}

interface ContactSheetProps {
  cells: Cell[];
  active: number;
  verificationState: VerificationState;
  /** Version-aware proof scope from B's proof model. Null unless VALID. */
  scope?: string | null;
  onSelect: (index: number) => void;
}

export function ContactSheet({ cells, active, verificationState, scope, onSelect }: ContactSheetProps) {
  const vClass =
    verificationState === 'valid'
      ? css.vValid
      : verificationState === 'invalid'
        ? css.vInvalid
        : css.vNeutral;
  return (
    <section className={css.sheet} aria-label="Custody index">
      <div className={css.head}>
        <span className={css.eyebrow}>The chain at a glance</span>
        <span className={`${css.verdict} ${vClass}`}>
          {verificationStateLabel(verificationState)}
        </span>
        {scope && <span className={css.scope}>{scope}</span>}
      </div>
      <div className={css.grid}>
        {cells.map((c, i) => (
          <button
            key={c.key}
            type="button"
            className={`${css.cell} ${css[c.status]} ${i === active ? css.on : ''}`}
            aria-label={`${c.label}: ${c.word}. Open on the plate below.`}
            onClick={() => onSelect(i)}
          >
            <span className={`${css.assay} ${css[c.status]}`} aria-hidden="true" />
            <span className={css.label}>{c.label}</span>
            <span className={css.state}>{c.word}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
