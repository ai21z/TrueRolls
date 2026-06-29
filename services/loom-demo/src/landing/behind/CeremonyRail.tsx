import { useEffect, useMemo, useRef, useState } from 'react';
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
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function field(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function short(s: string, head = 8, tail = 4): string {
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function buildStations(parsed: Record<string, unknown> | null): Station[] {
  const proof = asRecord(parsed?.proof);
  const rng = asRecord(proof.rng);
  const drand = asRecord(proof.drand);
  const sig = asRecord(parsed?.sig);
  const dash = (s: string) => s || '-';
  return [
    { n: '01 · Nonce cast', zone: 'client', field: `nonce ${dash(short(field(drand, 'client_nonce')))}`, what: 'A fresh private nonce is bound into the seed.' },
    { n: '02 · Beacon observed', zone: 'client', field: `round ${dash(field(drand, 'client_observed_round'))}`, what: 'The latest public drand pulse is read and verified.' },
    { n: '03 · Target locked', zone: 'client', field: `target ${dash(field(drand, 'target_round'))} = obs + 2`, what: 'The seed is bound to a pulse that does not exist yet.' },
    { n: '04 · Custody opened', zone: 'server', field: 'POST /v1/roll', what: 'The server validates the proof and opens a record.' },
    { n: '05 · Beacon revealed', zone: 'server', field: `round ${dash(field(drand, 'target_round'))} · BLS`, what: 'The target pulse publishes and is BLS-verified.' },
    { n: '06 · Seed forged', zone: 'server', field: `drbg ${dash(short(field(rng, 'drbg_key_hex')))}`, what: 'HKDF derives the seed from the verified pulse.' },
    { n: '07 · Outcome sampled', zone: 'server', field: `${dash(field(parsed ?? {}, 'die'))} → face ${dash(field(parsed ?? {}, 'face'))}`, what: 'kd-core samples the face under the κ guards.' },
    { n: '08 · Seal pressed', zone: 'server', field: `Ed25519 · ${dash(field(sig, 'kid'))}`, what: 'The body is signed - the draft becomes a receipt.' },
    { n: '09 · Re-examined', zone: 'browser', field: 'verifyReceiptJson()', what: 'Your browser replays every field and matches it - on the plate below.' },
  ];
}

// Geometry + timeline (ported from the design mockup).
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
  hold: 'Re-examined',
};

const ZONES: { a: number; b: number; t: string }[] = [
  { a: 0, b: 2, t: 'CLIENT' },
  { a: 3, b: 7, t: 'SERVER' },
  { a: 8, b: 8, t: 'YOUR BROWSER' },
];

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
  const stations = useMemo(() => buildStations(parsed), [parsed]);
  const reduced = usePrefersReducedMotion();
  const [playing, setPlaying] = useState(true);
  const [active, setActive] = useState(0);
  const [phase, setPhase] = useState<Phase>('die');

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
        if (isCur) {
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
  }, [playing, reduced]);

  const current = stations[active] ?? stations[0];

  return (
    <figure className={css.rail}>
      <div className={css.head}>
        <span className={css.eyebrow}>The ceremony</span>
        {!reduced && (
          <div className={css.ctrls}>
            <button type="button" className={css.btn} onClick={() => setPlaying((p) => !p)}>
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
        aria-label="A roll travelling nine stations: a die over the client stations, an unsealed draft over the server, a sealed receipt into the browser."
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <radialGradient id="cr-loupe-g" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#7E9488" stopOpacity="0.10" />
            <stop offset="70%" stopColor="#7E9488" stopOpacity="0.03" />
            <stop offset="100%" stopColor="#7E9488" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* zones */}
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

        {/* strand */}
        <line x1={X0} y1={Y_RAIL} x2={X1} y2={Y_RAIL} stroke="#6e8478" strokeWidth="1.2" strokeDasharray="2 6" opacity="0.4" />
        <line id="cr-wake" x1={X0} y1={Y_RAIL} x2={X0} y2={Y_RAIL} stroke="#3c5249" strokeWidth="2" opacity="0.8" />

        {/* nodes */}
        {NODE_XS.map((x, i) => (
          <g key={i}>
            <circle data-node data-i={i} cx={x} cy={Y_RAIL} r="8.4" fill="#090a0c" stroke="#6e8478" strokeWidth="1" strokeDasharray="2 3" opacity="0.6" />
            <text x={x} y={Y_RAIL - 17} textAnchor="middle" fill="#8C8676" fontFamily="var(--kd-font-mono)" fontSize="10">
              {String(i + 1).padStart(2, '0')}
            </text>
          </g>
        ))}

        {/* artifact */}
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
