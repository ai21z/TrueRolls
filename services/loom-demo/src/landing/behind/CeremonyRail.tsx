import { useEffect, useMemo, useRef, useState } from 'react';
import { asRecord, hasBeacon, readField, shorten } from './receiptFields';
import css from './CeremonyRail.module.css';

/**
 * CeremonyRail - surface A of Behind a TrueRoll (docs/design/behind-a-roll.md).
 *
 * A presentational walkthrough of the protocol the roll takes: an artifact
 * travels nine stations - a die rolls 01..03 and parks (the cast is fixed
 * client-side), an UNSEALED DRAFT crosses 04..08 (the record being built, not a
 * receipt yet), the Ed25519 stamp at 08 turns it into a SEALED RECEIPT that
 * rides into the browser at 09. A station only seals behind the artifact.
 *
 * Version-aware: a legacy truerolls-1 receipt has no drand beacon, so the
 * beacon stations (01/02/03/05) are marked ABSENT - they never seal and their
 * copy never asserts a verification that did not happen (design note Part 6).
 *
 * Honesty: this is ceremony, not verification. It is choreography over the real
 * receipt's fields; the actual pass/fail recompute is surface B (the Specimen
 * Plate) below, which station 09 hands off to. Motion is gated by
 * prefers-reduced-motion; the static end-state is fully legible without it.
 */

type Zone = 'client' | 'server' | 'browser';

interface Station {
  n: string;
  zone: Zone;
  field: string;
  what: string;
  absent?: boolean;
}

function buildStations(parsed: Record<string, unknown> | null, beacon: boolean): Station[] {
  const proof = asRecord(parsed?.proof);
  const rng = asRecord(proof.rng);
  const drand = asRecord(proof.drand);
  const sig = asRecord(parsed?.sig);
  const dash = (s: string) => s || '-';

  const seed: Station = {
    n: '06 · Seed forged',
    zone: 'server',
    field: `drbg ${dash(shorten(readField(rng, 'drbg_key_hex'), 8, 4))}`,
    what: beacon
      ? 'HKDF derives the seed from the verified pulse.'
      : 'The published seed re-seeds ChaCha20 (no drand derivation).',
  };
  const sample: Station = {
    n: '07 · Outcome sampled',
    zone: 'server',
    field: `${dash(readField(parsed ?? {}, 'die'))} → face ${dash(readField(parsed ?? {}, 'face'))}`,
    what: 'kd-core samples the face under the κ guards.',
  };
  const seal: Station = {
    n: '08 · Seal pressed',
    zone: 'server',
    field: `Ed25519 · ${dash(readField(sig, 'kid'))}`,
    what: 'The body is signed - the draft becomes a receipt.',
  };
  const custody: Station = {
    n: '04 · Custody opened',
    zone: 'server',
    field: 'POST /v1/roll',
    what: 'The server validates the request and opens a record.',
  };
  // Station 09 describes the ACTION, never a guaranteed pass - the rail does not
  // read the verdict, so it must not assert "matches it" for a tampered receipt.
  const reexamine: Station = {
    n: '09 · Re-examined',
    zone: 'browser',
    field: 'verifyReceiptJson()',
    what: 'Your browser re-runs every field check - the result is on the plate below.',
  };

  if (beacon) {
    return [
      { n: '01 · Nonce cast', zone: 'client', field: `nonce ${dash(shorten(readField(drand, 'client_nonce'), 8, 4))}`, what: 'A fresh private nonce is bound into the seed.' },
      { n: '02 · Beacon observed', zone: 'client', field: `round ${dash(readField(drand, 'client_observed_round'))}`, what: 'The latest public drand pulse is read and verified.' },
      { n: '03 · Target locked', zone: 'client', field: `target ${dash(readField(drand, 'target_round'))} = obs + 2`, what: 'The seed is bound to a pulse that does not exist yet.' },
      custody,
      { n: '05 · Beacon revealed', zone: 'server', field: `round ${dash(readField(drand, 'target_round'))} · BLS`, what: 'The target pulse publishes and is BLS-verified.' },
      seed,
      sample,
      seal,
      reexamine,
    ];
  }
  // Legacy truerolls-1: no beacon. The drand stations are ABSENT, not narrated.
  return [
    { n: '01 · Nonce cast', zone: 'client', absent: true, field: '(no client nonce)', what: 'Legacy receipt: no client nonce was bound into the seed.' },
    { n: '02 · Beacon observed', zone: 'client', absent: true, field: '(no beacon)', what: 'Not present - this legacy receipt has no drand beacon.' },
    { n: '03 · Target locked', zone: 'client', absent: true, field: '(no target)', what: 'Not present - no future-beacon target binding.' },
    custody,
    { n: '05 · Beacon revealed', zone: 'server', absent: true, field: '(no beacon)', what: 'Not present - there is no drand pulse to verify.' },
    seed,
    sample,
    seal,
    reexamine,
  ];
}

// Geometry + timeline.
const N = 9;
const X0 = 70;
const X1 = 970;
const NODE_XS = Array.from({ length: N }, (_, i) => X0 + ((X1 - X0) * i) / (N - 1));
const Y_RAIL = 118;
const Y_ART = 58;

type Phase = 'die' | 'birth' | 'draft' | 'seal' | 'sealed' | 'hold';
interface Seg {
  f: number;
  t: number;
  d: number;
  p: Phase;
}
const SEG: Seg[] = [
  { f: 0, t: 1, d: 1000, p: 'die' },
  { f: 1, t: 2, d: 1000, p: 'die' },
  { f: 2, t: 2, d: 1100, p: 'birth' },
  { f: 2, t: 3, d: 780, p: 'draft' },
  { f: 3, t: 4, d: 780, p: 'draft' },
  { f: 4, t: 5, d: 780, p: 'draft' },
  { f: 5, t: 6, d: 780, p: 'draft' },
  { f: 6, t: 7, d: 780, p: 'draft' },
  { f: 7, t: 7, d: 950, p: 'seal' },
  { f: 7, t: 8, d: 1100, p: 'sealed' },
  { f: 8, t: 8, d: 1300, p: 'hold' },
];
const TOTAL = SEG.reduce((s, g) => s + g.d, 0);
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const PHASE_LABEL: Record<Phase, string> = {
  die: 'Casting',
  birth: 'Cast · building the record',
  draft: 'Unsealed draft - not a receipt yet',
  seal: 'Sealing',
  sealed: 'Sealed receipt',
  hold: 'Re-examining - result on the plate',
};

const ZONES: { a: number; b: number; t: string }[] = [
  { a: 0, b: 2, t: 'CLIENT' },
  { a: 3, b: 7, t: 'SERVER' },
  { a: 8, b: 8, t: 'YOUR BROWSER' },
];
// Beacon-derived stations (drand-specific) - marked absent for a legacy receipt.
const BEACON_STATIONS = [0, 1, 2, 4];

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return reduced;
}

interface CeremonyRailProps {
  parsed: Record<string, unknown> | null;
  onReExamine?: () => void;
}

export function CeremonyRail({ parsed, onReExamine }: CeremonyRailProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const beacon = hasBeacon(parsed);
  const stations = useMemo(() => buildStations(parsed, beacon), [parsed, beacon]);
  const reduced = usePrefersReducedMotion();
  const [playing, setPlaying] = useState(true);
  const [active, setActive] = useState(0);
  const [phase, setPhase] = useState<Phase>('die');

  // The RAF loop reads NO station text (the readout below renders from `stations`
  // on every commit), so the only animation-relevant input is `beacon` - which
  // flips the absent-node set. Keep `parsed` OUT of the deps: adding it would
  // restart the animation on every textarea keystroke.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const die = svg.querySelector<SVGGElement>('#cr-die');
    const doc = svg.querySelector<SVGGElement>('#cr-doc');
    const docPage = svg.querySelector<SVGRectElement>('#cr-doc-page');
    const docSeal = svg.querySelector<SVGGElement>('#cr-doc-seal');
    const loupe = svg.querySelector<SVGGElement>('#cr-loupe');
    const wake = svg.querySelector<SVGLineElement>('#cr-wake');
    const drop = svg.querySelector<SVGLineElement>('#cr-drop');
    const nodes = Array.from(svg.querySelectorAll<SVGCircleElement>('[data-node]'));
    if (!die || !doc || !docPage || !docSeal || !loupe || !wake || !drop) return;

    const absent = new Set<number>(beacon ? [] : BEACON_STATIONS);
    let lastIdx = -1;
    let lastPhase: Phase | null = null;

    const paint = (elapsed: number) => {
      const tline = elapsed % TOTAL;
      let acc = 0;
      let seg = SEG[0];
      let lt = 0;
      for (const s of SEG) {
        if (tline < acc + s.d) {
          seg = s;
          lt = (tline - acc) / s.d;
          break;
        }
        acc += s.d;
      }
      const k = ease(Math.min(1, Math.max(0, lt)));
      const moverX = NODE_XS[seg.f] + (NODE_XS[seg.t] - NODE_XS[seg.f]) * k;
      const p = seg.p;

      const dieMoving = p === 'die';
      const dieX = dieMoving ? moverX : NODE_XS[2];
      const dieAngle = dieMoving ? ((elapsed / 1000) * 200) % 360 : 0;
      die.setAttribute('transform', `translate(${dieX.toFixed(1)},${Y_ART}) rotate(${dieAngle.toFixed(1)})`);
      die.setAttribute('opacity', dieMoving ? '1' : '0.5');

      let docX = NODE_XS[2];
      let docOpacity = 0;
      let mover = dieX;
      if (p === 'birth') {
        docOpacity = k * 0.85;
        mover = NODE_XS[2];
      } else if (p !== 'die') {
        docX = moverX;
        docOpacity = 1;
        mover = moverX;
      }
      doc.setAttribute('opacity', docOpacity.toFixed(2));
      doc.setAttribute('transform', `translate(${docX.toFixed(1)},${Y_ART})`);
      const isSealed = p === 'seal' || p === 'sealed' || p === 'hold';
      docPage.setAttribute('stroke', isSealed ? '#c9c2b3' : '#6e8478');
      docPage.setAttribute('stroke-dasharray', isSealed ? '0' : '3 2');
      docSeal.setAttribute('opacity', p === 'seal' ? k.toFixed(2) : isSealed ? '1' : '0');

      loupe.setAttribute('transform', `translate(${mover.toFixed(1)},${Y_ART})`);
      loupe.setAttribute('opacity', p === 'hold' ? '0.3' : '0.55');
      drop.setAttribute('x1', mover.toFixed(1));
      drop.setAttribute('x2', mover.toFixed(1));
      wake.setAttribute('x2', mover.toFixed(1));

      let near = 0;
      let best = Infinity;
      for (let i = 0; i < N; i++) {
        const passed = i <= 2 ? dieX >= NODE_XS[i] - 4 : docOpacity > 0.2 && docX >= NODE_XS[i] - 4;
        const isCur = Math.abs(mover - NODE_XS[i]) < (X1 - X0) / (N - 1) / 2;
        const dist = Math.abs(mover - NODE_XS[i]);
        if (dist < best) {
          best = dist;
          near = i;
        }
        const c = nodes[i];
        if (absent.has(i)) {
          // Beacon station on a legacy receipt: never seals, always reads absent.
          c.setAttribute('r', '8.4');
          c.setAttribute('fill', '#090a0c');
          c.setAttribute('stroke', '#6e8478');
          c.setAttribute('stroke-width', '1');
          c.setAttribute('stroke-dasharray', '2 3');
          c.setAttribute('opacity', '0.32');
        } else if (isCur) {
          c.setAttribute('r', '10');
          c.setAttribute('fill', '#090a0c');
          c.setAttribute('stroke', '#7E9488');
          c.setAttribute('stroke-width', '1.4');
          c.setAttribute('stroke-dasharray', '0');
          c.setAttribute('opacity', '1');
        } else if (passed) {
          c.setAttribute('r', '8.6');
          c.setAttribute('fill', 'rgba(143,170,138,0.14)');
          c.setAttribute('stroke', '#8FAA8A');
          c.setAttribute('stroke-width', '1.2');
          c.setAttribute('stroke-dasharray', '0');
          c.setAttribute('opacity', '1');
        } else {
          c.setAttribute('r', '8.4');
          c.setAttribute('fill', '#090a0c');
          c.setAttribute('stroke', '#6e8478');
          c.setAttribute('stroke-width', '1');
          c.setAttribute('stroke-dasharray', '2 3');
          c.setAttribute('opacity', '0.6');
        }
      }
      if (near !== lastIdx) {
        lastIdx = near;
        setActive(near);
      }
      if (p !== lastPhase) {
        lastPhase = p;
        setPhase(p);
      }
    };

    if (reduced) {
      paint(TOTAL - 1);
      return;
    }
    let raf = 0;
    let start: number | null = null;
    const loop = (ts: number) => {
      if (start === null) start = ts;
      paint(ts - start);
      raf = requestAnimationFrame(loop);
    };
    if (playing) raf = requestAnimationFrame(loop);
    else paint(TOTAL - 1);
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [playing, reduced, beacon]);

  const current = stations[active] ?? stations[0];

  return (
    <figure className={css.rail}>
      <div className={css.head}>
        <span className={css.eyebrow}>The ceremony</span>
        {!beacon && <span className={css.legacyTag}>legacy · no drand beacon</span>}
        {!reduced && (
          <div className={css.ctrls}>
            <button
              type="button"
              className={css.btn}
              aria-pressed={playing}
              onClick={() => setPlaying((p) => !p)}
            >
              {playing ? '❚❚ Pause' : '▶ Play'}
            </button>
          </div>
        )}
      </div>

      <svg
        ref={svgRef}
        className={css.svg}
        viewBox="0 0 1040 214"
        role="img"
        aria-labelledby="cr-title cr-desc"
        xmlns="http://www.w3.org/2000/svg"
      >
        <title id="cr-title">Behind a roll: the custody ceremony</title>
        <desc id="cr-desc">
          A roll travelling nine stations - a die over the client stations, an unsealed draft over the
          server, a sealed receipt into the browser. Beacon stations are marked absent for a legacy
          receipt.
        </desc>
        <defs>
          <radialGradient id="cr-loupe-g" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#7E9488" stopOpacity="0.10" />
            <stop offset="70%" stopColor="#7E9488" stopOpacity="0.03" />
            <stop offset="100%" stopColor="#7E9488" stopOpacity="0" />
          </radialGradient>
        </defs>

        {ZONES.map((z) => {
          const lx = NODE_XS[z.a] - 22;
          const rx = NODE_XS[z.b] + 22;
          const by = 160;
          return (
            <g key={z.t}>
              <path
                d={`M${lx},${by - 5} L${lx},${by} L${rx},${by} L${rx},${by - 5}`}
                fill="none"
                stroke="#c9c2b3"
                strokeOpacity="0.12"
              />
              <text
                x={(lx + rx) / 2}
                y={by + 16}
                textAnchor="middle"
                fill="#8C8676"
                fontFamily="var(--kd-font-mono)"
                fontSize="10.5"
                letterSpacing="0.14em"
              >
                {z.t}
              </text>
            </g>
          );
        })}

        <line x1={X0} y1={Y_RAIL} x2={X1} y2={Y_RAIL} stroke="#6e8478" strokeWidth="1.2" strokeDasharray="2 6" opacity="0.4" />
        <line id="cr-wake" x1={X0} y1={Y_RAIL} x2={X0} y2={Y_RAIL} stroke="#3c5249" strokeWidth="2" opacity="0.8" />

        {NODE_XS.map((x, i) => (
          <g key={i}>
            <circle data-node data-i={i} cx={x} cy={Y_RAIL} r="8.4" fill="#090a0c" stroke="#6e8478" strokeWidth="1" strokeDasharray="2 3" opacity="0.6" />
            <text x={x} y={Y_RAIL - 17} textAnchor="middle" fill="#8C8676" fontFamily="var(--kd-font-mono)" fontSize="10">
              {String(i + 1).padStart(2, '0')}
            </text>
          </g>
        ))}

        <line id="cr-drop" x1={X0} y1={Y_ART + 4} x2={X0} y2={Y_RAIL - 10} stroke="#7E9488" strokeWidth="1" strokeDasharray="2 3" opacity="0.5" />
        <g id="cr-die" transform={`translate(${X0},${Y_ART})`}>
          <rect x="-12" y="-12" width="24" height="24" rx="4" fill="#1A1A16" stroke="#c9c2b3" strokeWidth="1.3" />
          <circle cx="-6" cy="-6" r="1.7" fill="#E8E2D2" />
          <circle cx="6" cy="-6" r="1.7" fill="#E8E2D2" />
          <circle cx="0" cy="0" r="1.7" fill="#E8E2D2" />
          <circle cx="-6" cy="6" r="1.7" fill="#E8E2D2" />
          <circle cx="6" cy="6" r="1.7" fill="#E8E2D2" />
        </g>
        <g id="cr-doc" transform={`translate(${NODE_XS[2]},${Y_ART})`} opacity="0">
          <rect id="cr-doc-page" x="-11" y="-14" width="22" height="28" rx="2" fill="#131311" stroke="#6e8478" strokeWidth="1.2" strokeDasharray="3 2" />
          <path d="M4,-14 L11,-7 L4,-7 Z" fill="#0A0A0B" stroke="#6e8478" strokeWidth="0.7" />
          <line x1="-6" y1="-3" x2="6" y2="-3" stroke="#8C8676" strokeWidth="1" />
          <line x1="-6" y1="1" x2="6" y2="1" stroke="#8C8676" strokeWidth="1" />
          <line x1="-6" y1="5" x2="2" y2="5" stroke="#8C8676" strokeWidth="1" />
          <g id="cr-doc-seal" opacity="0">
            <circle cx="5" cy="9" r="5.4" fill="rgba(143,170,138,0.18)" stroke="#8FAA8A" strokeWidth="1" />
            <circle cx="5" cy="9" r="2" fill="#c9c2b3" />
          </g>
        </g>
        <g id="cr-loupe" transform={`translate(${X0},${Y_ART})`} opacity="0.55">
          <circle cx="0" cy="0" r="26" fill="url(#cr-loupe-g)" />
          <circle cx="0" cy="0" r="20" fill="none" stroke="#7E9488" strokeWidth="1" opacity="0.6" />
          <line x1="14.1" y1="14.1" x2="24" y2="24" stroke="#7E9488" strokeWidth="1.6" opacity="0.6" />
        </g>
      </svg>

      <div className={css.readout} role="status" aria-live="off">
        <span className={css.phase}>{PHASE_LABEL[phase]}</span>
        <span className={css.station}>{current.n}</span>
        <span className={css.field}>{current.field}</span>
        <span className={css.what}>{current.what}</span>
      </div>

      <div className={css.footer}>
        <span className={css.note}>
          This is the path every roll takes. Whether <b>this</b> receipt holds is recomputed on the
          plate below.
        </span>
        {onReExamine && (
          <button type="button" className={css.toPlate} onClick={onReExamine}>
            Re-examine on the plate ↓
          </button>
        )}
      </div>
    </figure>
  );
}
