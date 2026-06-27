import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { InkFrame } from '../system/InkFrame';
import { makeFeederRoots, makeGhostTaproot, makeSeed } from '../system/seed';
import css from './SeedSocket.module.css';

/**
 * SeedSocket — the honesty paragraph as an interactive specimen, drawn by hand.
 *
 * TrueRolls proves each live roll seed came from verified drand and that the outcome
 * replays from it. The one thing it cannot prove yet is that the published outcome was
 * unbiased — the operator can still grind by failing/suppressing unfavorable attempts.
 * So six re-derivable facts are carved as labelled cells,
 * wired to a germinating seed where they enter the cracked coat as FEEDER roots —
 * and the seventh fact, strict fairness, is the seed's MISSING taproot: a deep
 * anchor left ungrown. The seed is a forensic herbarium plate: a hatched reniform
 * testa, an oval hilum scar, the coat split at the rooting pole.
 *
 * Layout mirrors the verify grid above it: the specimen sits in its own inked box the
 * width of the offline-verify card; the explanation is an unboxed column the width of
 * the trust text. Every part explains itself — hover, tap, or keyboard-focus a cell, the
 * seed, or the roots and a plain-English explanation appears in the text column.
 */

// Geometry: a compact, boxed composition. Cells sit at the left (short feeder wires);
// the seed sits right-of-centre with its rooting pole (cracked coat) facing the cells,
// roots and the ghosted missing taproot descending below the ground register.
const VB_W = 580;
const VB_H = 372;
const SX = 356; // seed centre x (off-centre right — a specimen, not a centred seal)
const SY = 150; // seed centre y
const HW = 46; // seed half-width
const HH = 52; // seed half-height
const CELL = { x: 20, w: 150, h: 30 };
const ROWS = [40, 82, 124, 166, 208, 250];

const SEED = makeSeed(SX, SY, HW, HH);
const ROOTS = makeFeederRoots(SEED.pole.x, SEED.pole.y);
const TAP = makeGhostTaproot(SEED.pole.x, SEED.pole.y);
const SOIL_Y = SEED.pole.y + 14;

type Key = 'intro' | 'draw_u64' | 'face' | 'kappa' | 'metrics' | 'hash' | 'sig' | 'seed' | 'roadmap';

const INFO: Record<Key, { eyebrow: string; body: ReactNode }> = {
  intro: {
    eyebrow: 'Seed honesty',
    body: (
      <>
        TrueRolls proves each live roll seed came from a verified public drand beacon, and you
        can replay the outcome yourself. The one thing it cannot prove yet is whether the
        published outcome was unbiased — the operator can still grind, failing unfavorable
        attempts and publishing only favorable ones. The cells re-derive straight from the receipt
        and feed the seed as roots. The seventh, <b>strict fairness</b>, still waits for witnesses.
      </>
    ),
  },
  draw_u64: {
    eyebrow: 'draw_u64',
    body: 'The raw 64-bit random draw the result came from. The receipt publishes it, so anyone can replay the roll bit-for-bit.',
  },
  face: {
    eyebrow: 'face',
    body: 'The number that was rolled. Recomputed from the draw and the guarded distribution, so it cannot be forged.',
  },
  kappa: {
    eyebrow: 'κ · karma',
    body: 'How far the odds were tilted from fair. Always bounded by the KL and EV caps.',
  },
  metrics: {
    eyebrow: 'α · KL · EV',
    body: 'The guard metrics. Alpha is the mix back toward fair, KL the divergence, EV the expected value. The receipt proves they stayed inside the caps.',
  },
  hash: {
    eyebrow: 'hash',
    body: 'The receipt hash. Change any single field and it no longer matches.',
  },
  sig: {
    eyebrow: 'sig',
    body: 'The Ed25519 signature. Proves the published key signed this exact receipt.',
  },
  seed: {
    eyebrow: 'seed honesty',
    body: (
      <>
        Did the operator publicly bind the roll before it could see the outcome, or could it
        privately fail unfavorable attempts and publish only a favorable one (grinding)? Per-roll
        drand provenance cannot certify that — so strict witnessed fairness remains the seed's <b>missing taproot</b>.
      </>
    ),
  },
  roadmap: {
    eyebrow: 'Roadmap, the fix',
    body: (
      <>
        Per-roll drand is built. The next step is witnessed batching: public manifests,
        independently cosigned log checkpoints, and an upper-bound rule that proves the commitment
        existed before the target beacon. These roots reach for that stricter claim.
      </>
    ),
  },
};

const CELLS: { key: Key; label: string }[] = [
  { key: 'draw_u64', label: 'draw_u64' },
  { key: 'face', label: 'face' },
  { key: 'kappa', label: 'κ' },
  { key: 'metrics', label: 'α · KL · EV' },
  { key: 'hash', label: 'hash' },
  { key: 'sig', label: 'sig' },
];

export function SeedSocket() {
  const uid = useId().replace(/[:]/g, '');
  const emberId = `seed-ember-${uid}`;
  const clipId = `seed-clip-${uid}`;

  const [hover, setHover] = useState<Key | null>(null);
  const [pin, setPin] = useState<Key | null>(null);
  const active: Key = hover ?? pin ?? 'intro';
  const info = INFO[active];

  const itemProps = (key: Key) => ({
    tabIndex: 0,
    role: 'button',
    'aria-label': INFO[key].eyebrow,
    'aria-pressed': pin === key,
    className: `${css.item} ${active === key ? css.itemActive : ''}`,
    onMouseEnter: () => setHover(key),
    onMouseLeave: () => setHover(null),
    onFocus: () => setHover(key),
    onBlur: () => setHover(null),
    onClick: () => setPin((p) => (p === key ? null : key)),
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setPin((p) => (p === key ? null : key));
      }
    },
  });

  return (
    <figure className={css.root}>
      <div className={css.grid}>
        {/* The specimen, in its own inked box the width of the offline-verify card */}
        <InkFrame seed={53} className={css.specimen}>
          <svg
            className={css.svg}
            viewBox={`0 0 ${VB_W} ${VB_H}`}
            role="img"
            aria-label="Seed honesty specimen: a germinating seed whose six re-derivable facts feed it as roots, with the seventh — seed honesty — left as a missing taproot. Use the cells, or read the explanation."
            xmlns="http://www.w3.org/2000/svg"
          >
            <defs>
              <radialGradient id={emberId} cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#e6a064" stopOpacity="0.85" />
                <stop offset="55%" stopColor="#b87242" stopOpacity="0.22" />
                <stop offset="100%" stopColor="#b87242" stopOpacity="0" />
              </radialGradient>
              <clipPath id={clipId}>
                <path d={SEED.body} />
              </clipPath>
            </defs>

            {/* ground/soil register at rooting depth — forensic notation, not decoration */}
            <line className={css.soil} x1="18" y1={SOIL_Y} x2={VB_W - 18} y2={SOIL_Y} aria-hidden="true" />

            {/* the six facts converge at the rooting pole as feeder roots into the crack */}
            <g className={css.wires}>
              {CELLS.map((c, i) => {
                const y = ROWS[i] + CELL.h / 2;
                return (
                  <path
                    key={`w-${c.key}`}
                    className={active === c.key ? css.wireActive : ''}
                    d={`M${CELL.x + CELL.w},${y} C${CELL.x + CELL.w + 64},${y} ${SEED.pole.x - 54},${SEED.pole.y} ${SEED.pole.x},${SEED.pole.y}`}
                  />
                );
              })}
            </g>

            {/* present feeder roots reaching down = the roadmap (the fix, in progress) */}
            <g {...itemProps('roadmap')}>
              <rect x={SEED.pole.x - 76} y={SEED.pole.y - 4} width="170" height="150" fill="transparent" />
              {ROOTS.map((r, i) => (
                <path
                  key={`r-${i}`}
                  d={r.d}
                  fill="none"
                  stroke="var(--nec-hypha)"
                  strokeWidth={r.w}
                  strokeLinecap="round"
                  opacity={r.op}
                />
              ))}
            </g>

            {/* the assay register: labelled cells, each a focusable button */}
            {CELLS.map((c, i) => {
              const y = ROWS[i];
              return (
                <g key={`c-${c.key}`} {...itemProps(c.key)}>
                  <rect className={css.cell} x={CELL.x} y={y} width={CELL.w} height={CELL.h} rx="1.5" />
                  <rect className={css.cellMark} x={CELL.x + 10} y={y + CELL.h / 2 - 2.5} width="8" height="5" />
                  <text className={css.cellLabel} x={CELL.x + 26} y={y + CELL.h / 2 + 4}>
                    {c.label}
                  </text>
                </g>
              );
            })}

            {/* THE SEED = seed honesty: hatched testa, hilum, cracked coat, faint germination
                ember, and the MISSING dominant taproot (ghosted, unfilled) */}
            <g {...itemProps('seed')}>
              <path className={css.testa} d={SEED.body} />
              <g clipPath={`url(#${clipId})`} className={css.hatch} aria-hidden="true">
                {SEED.hatch.map((h, i) => (
                  <path key={`h-${i}`} d={h} />
                ))}
              </g>
              <ellipse
                className={css.hilum}
                cx={SEED.hilum.cx}
                cy={SEED.hilum.cy}
                rx={SEED.hilum.rx}
                ry={SEED.hilum.ry}
                transform={`rotate(${SEED.hilum.rot} ${SEED.hilum.cx} ${SEED.hilum.cy})`}
              />
              <circle className={css.micropyle} cx={SEED.micropyle.cx} cy={SEED.micropyle.cy} r={SEED.micropyle.r} />
              <g className={css.crack} aria-hidden="true">
                {SEED.crack.map((d, i) => (
                  <path key={`k-${i}`} d={d} />
                ))}
              </g>
              <circle cx={SEED.pole.x} cy={SEED.pole.y} r="12" fill={`url(#${emberId})`} />
              <ellipse className={css.emberCore} cx={SEED.pole.x} cy={SEED.pole.y} rx="4.5" ry="2.2" />
              {/* the missing taproot — a faint dotted reach ending in an unfilled anchor */}
              <path className={css.ghostTap} d={TAP.d} />
              <circle className={css.ghostTip} cx={TAP.tip.x} cy={TAP.tip.y} r="4.5" />
              <text className={css.socketLabel} x={TAP.tip.x + 11} y={TAP.tip.y + 4}>
                seed honesty
              </text>
            </g>
          </svg>
        </InkFrame>

        {/* The explanation, unboxed, the width of the trust text */}
        <div className={css.info}>
          <div className={css.infoEye}>{info.eyebrow}</div>
          <p className={css.infoBody} aria-live="polite">
            {info.body}
          </p>
          <div className={css.infoHint}>hover, tap, or focus an item</div>
        </div>
      </div>
    </figure>
  );
}
