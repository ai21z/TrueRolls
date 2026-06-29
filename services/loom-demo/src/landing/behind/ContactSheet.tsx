import css from './ContactSheet.module.css';

/**
 * ContactSheet - surface C of Behind a TrueRoll (docs/design/behind-a-roll.md).
 *
 * The verification chain compressed: a verdict pill plus one carved cell per
 * stratum, showing the real state from the verifier. It is the page index -
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
  verdict?: 'VALID' | 'INVALID' | 'ERROR';
  onSelect: (index: number) => void;
}

const VERDICT_LABEL: Record<string, string> = {
  VALID: 'VALID',
  INVALID: 'INVALID',
  ERROR: 'UNVERIFIABLE',
};

export function ContactSheet({ cells, active, verdict, onSelect }: ContactSheetProps) {
  const vClass =
    verdict === 'VALID' ? css.vValid : verdict === 'INVALID' ? css.vInvalid : css.vNeutral;
  return (
    <section className={css.sheet} aria-label="Custody index">
      <div className={css.head}>
        <span className={css.eyebrow}>The chain at a glance</span>
        {verdict && (
          <span className={`${css.verdict} ${vClass}`}>{VERDICT_LABEL[verdict] ?? verdict}</span>
        )}
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
