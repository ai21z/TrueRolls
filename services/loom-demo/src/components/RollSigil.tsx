import { useId, useMemo } from 'react';
import type { WasmVerifyReport } from '../api/wasmEngine';
import { hyphaePath } from '../landing/system/hyphae';
import css from './RollSigil.module.css';

/**
 * RollSigil - a Necrography provenance graph of a TrueRolls receipt.
 *
 * A roll is a death: fixed the instant it is cast; the receipt is its residue. This
 * graph reads that residue as a forensic lineage - the facts of the roll (seed, die,
 * κ, face, hash, signature, metrics) as nodes, the derivations between them as mycelial
 * bonds. Four of those bonds are the verification checks (sampling, face, metrics,
 * signature): each that passes is tied into the central seal; each that fails is
 * severed with a blood-red tear. Grown deterministically from the receipt hash, so the
 * same receipt always draws the same map.
 *
 * NOT a force-directed physics graph - that mechanical bounce is the generic look this
 * style rejects. The layout is hand-excavated; the edges are grown, not sprung.
 *
 * The two real tamper levers - `face` and `κ` - are inline-editable. Editing one re-runs
 * the WASM verifier (via the parent's tamper path) and you watch the bonds sever live.
 * Every other node is derived or cryptographic, so it is read-only - editing a hash or a
 * signature would be a lie about how the system works. Motion is gated by
 * prefers-reduced-motion in the stylesheet.
 */

interface RollSigilProps {
  receiptText: string;
  report: WasmVerifyReport | null;
  editable?: boolean;
  onTamper?: (field: 'face' | 'kappa', value: number) => void;
}

const W = 420;
const H = 252;
const SEAL = { x: 212, y: 120 };

type Bond = 'signature' | 'drand' | 'sampling' | 'face' | 'metrics';

interface NodeDef {
  key: string;
  label: string;
  x: number;
  y: number;
  kind: 'seed' | 'ro' | 'edit';
  field?: 'face' | 'kappa';
}

interface EdgeDef {
  from: string;
  to: string;
  bond?: Bond;
}

const EDGES: EdgeDef[] = [
  { from: 'seed', to: 'seal', bond: 'sampling' },
  { from: 'beacon', to: 'seed', bond: 'drand' },
  { from: 'die', to: 'seal' },
  { from: 'kappa', to: 'seal' },
  { from: 'face', to: 'seal', bond: 'face' },
  { from: 'seal', to: 'hash' },
  { from: 'hash', to: 'sig', bond: 'signature' },
  { from: 'seal', to: 'metrics', bond: 'metrics' },
];

const f = (n: number) => n.toFixed(1);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Parsed {
  seedStr: string;
  face: number | null;
  kappa: number | null;
  die: string | null;
  hashShort: string | null;
  kid: string | null;
  hasDrandProof: boolean;
}

function parseReceipt(text: string): Parsed {
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    const hash = typeof o.receipt_hash === 'string' ? o.receipt_hash : null;
    const proof = (o.proof as Record<string, unknown> | undefined) ?? undefined;
    const rng = (proof?.rng as Record<string, unknown> | undefined) ?? undefined;
    const drand = proof?.drand;
    const drbg = typeof rng?.drbg_key_hex === 'string' ? rng.drbg_key_hex : undefined;
    const draw = typeof proof?.draw_u64 === 'string' ? proof.draw_u64 : undefined;
    const sig = (o.sig as Record<string, unknown> | undefined) ?? undefined;
    return {
      seedStr: String(hash ?? drbg ?? draw ?? text).slice(0, 96),
      face: typeof o.face === 'number' ? o.face : null,
      kappa: typeof o.kappa === 'number' ? o.kappa : null,
      die: typeof o.die === 'string' ? o.die : null,
      hashShort: hash ? hash.replace(/^sha256:/, '').slice(0, 12) : null,
      kid: typeof sig?.kid === 'string' ? sig.kid : null,
      hasDrandProof: drand != null,
    };
  } catch {
    return {
      seedStr: text.slice(0, 96) || 'void',
      face: null,
      kappa: null,
      die: null,
      hashShort: null,
      kid: null,
      hasDrandProof: false,
    };
  }
}

function edgeGeom(a: { x: number; y: number }, b: { x: number; y: number }, bow: number) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  const ax = a.x + ux * 8;
  const ay = a.y + uy * 8;
  const bx = b.x - ux * 8;
  const by = b.y - uy * 8;
  const c1x = ax + (bx - ax) * 0.34 + px * bow;
  const c1y = ay + (by - ay) * 0.34 + py * bow;
  const c2x = ax + (bx - ax) * 0.7 + px * bow * 0.7;
  const c2y = ay + (by - ay) * 0.7 + py * bow * 0.7;
  const d = `M${f(ax)},${f(ay)} C${f(c1x)},${f(c1y)} ${f(c2x)},${f(c2y)} ${f(bx)},${f(by)}`;
  const mx = (ax + bx) / 2 + px * bow * 0.5;
  const my = (ay + by) / 2 + py * bow * 0.5;
  const sx = bx - (bx - ax) * 0.16;
  const sy = by - (by - ay) * 0.16;
  return { d, mx, my, sx, sy };
}

export function RollSigil({ receiptText, report, editable, onTamper }: RollSigilProps) {
  const uid = useId().replace(/[:]/g, '');
  const etchId = `etch-${uid}`;
  const grainId = `grain-${uid}`;
  const emberId = `ember-${uid}`;

  const parsed = useMemo(() => parseReceipt(receiptText), [receiptText]);
  const seedNum = useMemo(() => hashSeed(parsed.seedStr), [parsed.seedStr]);

  const r = report != null && report.verdict !== 'ERROR' ? report : null;
  const cs: Record<Bond, boolean | undefined> = {
    signature: r?.valid_signature,
    drand: parsed.hasDrandProof ? r?.valid_drand : undefined,
    sampling: r?.valid_sampling,
    face: r?.face_ok,
    metrics: r?.metrics_ok,
  };
  const bondList: Bond[] = parsed.hasDrandProof
    ? ['signature', 'drand', 'sampling', 'face', 'metrics']
    : ['signature', 'sampling', 'face', 'metrics'];

  const allNodes: NodeDef[] = [
    { key: 'seed', label: 'seed', x: 50, y: 74, kind: 'seed' },
    { key: 'beacon', label: 'drand', x: 56, y: 20, kind: 'ro' },
    { key: 'die', label: parsed.die ?? 'die', x: 58, y: 166, kind: 'ro' },
    { key: 'kappa', label: 'κ', x: 114, y: 206, kind: 'edit', field: 'kappa' },
    { key: 'face', label: 'face', x: 160, y: 48, kind: 'edit', field: 'face' },
    { key: 'hash', label: 'hash', x: 324, y: 68, kind: 'ro' },
    { key: 'sig', label: parsed.kid ? `sig · ${parsed.kid}` : 'sig', x: 366, y: 138, kind: 'ro' },
    { key: 'metrics', label: 'α · KL · EV', x: 322, y: 204, kind: 'ro' },
  ];
  const nodes = allNodes.filter((node) => parsed.hasDrandProof || node.key !== 'beacon');
  const edgeDefs = parsed.hasDrandProof
    ? EDGES
    : EDGES.filter((edge) => edge.from !== 'beacon' && edge.to !== 'beacon');
  const pt = (key: string) => (key === 'seal' ? SEAL : nodes.find((n) => n.key === key)!);

  const rand = mulberry32(seedNum);
  const edges = edgeDefs.map((e) => {
    const bow = (rand() - 0.5) * 24;
    const g = edgeGeom(pt(e.from), pt(e.to), bow);
    // A bond forks once (anastomosis): a thin sub-strand bowed the other way,
    // so the strand visibly splits and rejoins on its way to the seal.
    const fork = e.bond ? hyphaePath(pt(e.from), pt(e.to), -bow * 0.55 - 6) : null;
    return { ...e, ...g, fork };
  });

  const nExpected = bondList.length;
  const nRun = bondList.filter((b) => cs[b] !== undefined).length;
  const nFail = bondList.filter((b) => cs[b] === false).length;
  const allPass = nRun === nExpected && nFail === 0;

  const state: 'intact' | 'broken' | 'unsealed' = nRun === 0 ? 'unsealed' : allPass ? 'intact' : 'broken';
  const word = state === 'unsealed' ? 'Unsealed' : state === 'intact' ? 'Intact' : 'Broken';
  const rolled = parsed.face != null && parsed.die ? `${parsed.die} rolled ${parsed.face}. ` : '';
  const sub =
    state === 'unsealed'
      ? 'Verify a receipt to read its seal.'
      : state === 'intact'
        ? `${rolled}All ${nExpected} bonds hold. The seal is whole.`
        : `${rolled}${nFail} of ${nExpected} bonds severed. The seal is cut.`;

  const kx = SEAL.x;
  const ky = SEAL.y;

  const sides = parsed.die ? parseInt(parsed.die.replace(/\D/g, ''), 10) || 20 : 20;

  const onEdit = (field: 'face' | 'kappa', raw: string) => {
    if (!onTamper || raw.trim() === '') return;
    const v = parseFloat(raw);
    if (!Number.isFinite(v)) return;
    onTamper(field, field === 'face' ? clamp(Math.round(v), 1, sides) : clamp(v, -0.9, 0.9));
  };

  const bondColor = (b: Bond | undefined) => {
    if (!b) return undefined;
    const ok = cs[b];
    return ok === false ? 'var(--nec-void)' : ok === true ? 'var(--nec-bone)' : 'var(--kd-text-muted, #8a909b)';
  };

  return (
    <figure className={css.root}>
      <div className={css.eyebrow}>Receipt seal{parsed.die ? ` · ${parsed.die}` : ''}</div>
      <div className={css.state}>
        <div className={`${css.word} ${css[state]}`}>{word}</div>
        <div className={css.sub}>{sub}</div>
      </div>

      <svg
        className={css.svg}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={
          nRun === 0
            ? 'Provenance graph of the receipt: facts of the roll bonded to a central seal, not yet verified.'
            : `Provenance graph: ${4 - nFail} of 4 verification bonds tied into the seal${nFail ? `, ${nFail} severed by tampering` : ', the seal is whole'}.`
        }
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <filter id={etchId} x="-15%" y="-15%" width="130%" height="130%">
            <feTurbulence type="fractalNoise" baseFrequency="0.013 0.02" numOctaves={2} seed={seedNum % 100} result="n" />
            <feDisplacementMap in="SourceGraphic" in2="n" scale={3.5} xChannelSelector="R" yChannelSelector="G" />
          </filter>
          <filter id={grainId} x="0%" y="0%" width="100%" height="100%">
            <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves={2} stitchTiles="stitch" result="g" />
            <feColorMatrix in="g" type="saturate" values="0" result="gs" />
            <feComponentTransfer in="gs">
              <feFuncA type="table" tableValues="0 0.05 0" />
            </feComponentTransfer>
          </filter>
          <radialGradient id={emberId} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#b87242" stopOpacity="0.34" />
            <stop offset="55%" stopColor="#b87242" stopOpacity="0.08" />
            <stop offset="100%" stopColor="#b87242" stopOpacity="0" />
          </radialGradient>
        </defs>

        <path
          className={css.plate}
          d="M12,14 L120,7 L250,12 L362,6 L410,20 L414,138 L404,224 L300,244 L150,248 L40,240 L8,168 L16,74 Z"
        />
        <rect x="0" y="0" width={W} height={H} filter={`url(#${grainId})`} opacity="0.5" />

        <g filter={`url(#${etchId})`}>
          {edges.map((e, i) => {
            const ok = e.bond ? cs[e.bond] : 'structural';
            const failed = ok === false;
            const passed = ok === true;
            const stroke = !e.bond ? 'var(--nec-hypha)' : failed ? 'var(--nec-void)' : 'var(--nec-hypha)';
            return (
              <g key={`${e.from}-${e.to}`}>
                {e.fork && (
                  <path
                    className={css.fork}
                    d={e.fork}
                    stroke={failed ? 'var(--nec-void)' : 'var(--nec-hypha)'}
                    pathLength={1}
                    style={{ opacity: failed ? 0.5 : passed ? 0.32 : 0.16 }}
                  />
                )}
                <path
                  className={`${css.strand} ${passed ? css.draw : ''}`}
                  d={e.d}
                  stroke={stroke}
                  strokeWidth={e.bond ? 1.4 : 1}
                  pathLength={1}
                  style={{
                    opacity: !e.bond ? 0.3 : failed ? 0.8 : passed ? 0.6 : 0.25,
                    strokeDasharray: failed ? '5 4' : ok === undefined ? '2 5' : undefined,
                    animationDelay: `${0.12 + i * 0.12}s`,
                  }}
                />
              </g>
            );
          })}

          {/* The pressed wax seal: whole when the bonds hold, an unsealed dry stamp
              before verification. A severed bond cracks it (rendered below, outside
              the etch group so the ember weep stays soft). */}
          {state === 'unsealed' ? (
            <ellipse className={css.sealOpen} cx={kx} cy={ky} rx="15" ry="14" />
          ) : (
            <g>
              <ellipse className={css.waxBody} cx={kx} cy={ky} rx="16" ry="15" />
              <ellipse className={css.waxRing} cx={kx} cy={ky} rx="10.5" ry="9.5" />
              <circle className={css.waxCore} cx={kx} cy={ky} r="4.5" />
            </g>
          )}
        </g>

        {edges
          .filter((e) => e.bond && cs[e.bond] === false)
          .map((e) => {
            // The located scar: a crack from this bond's seal-entry into the wax.
            const cmx = e.sx + (kx - e.sx) * 0.5 + 3;
            const cmy = e.sy + (ky - e.sy) * 0.5 - 2;
            return (
              <g key={`scar-${e.from}-${e.to}`}>
                {/* the lone warm focal: ember weeps from the cut, only on failure */}
                <circle cx={e.sx} cy={e.sy} r="11" fill={`url(#${emberId})`} />
                <path
                  className={css.scar}
                  d={`M${f(e.sx)},${f(e.sy)} L${f(cmx)},${f(cmy)} L${f(kx)},${f(ky)}`}
                />
              </g>
            );
          })}

        {edges
          .filter((e) => e.bond)
          .map((e) => {
            const b = e.bond as Bond;
            // No checkmark glyph: a bond's state is read from the strand itself
            // (drawn = held, cut with a tear = severed), not a ✓/✕ badge.
            return (
              <text
                key={`bl-${b}`}
                className={css.bondLabel}
                x={e.mx}
                y={e.my - 3}
                textAnchor="middle"
                style={{ fill: bondColor(b), opacity: 0.92 }}
              >
                {b}
              </text>
            );
          })}

        {nodes.map((n) => {
          if (n.kind === 'seed') {
            return (
              <g key={n.key}>
                <circle className={css.seedHalo} cx={n.x} cy={n.y} r="7" />
                <circle className={css.seedNode} cx={n.x} cy={n.y} r="3.6" />
                <text className={css.glabel} x={n.x} y={n.y + 18} textAnchor="middle">
                  {n.label}
                </text>
              </g>
            );
          }
          if (n.kind === 'edit' && editable && onTamper) {
            const value = n.field === 'face' ? parsed.face : parsed.kappa;
            return (
              <g key={n.key}>
                <text className={css.glabel} x={n.x} y={n.y - 13} textAnchor="middle">
                  {n.label}
                </text>
                <foreignObject x={n.x - 24} y={n.y - 10} width={48} height={22}>
                  <div className={css.valueWrap}>
                    <input
                      className={css.valueInput}
                      type="number"
                      value={value ?? ''}
                      min={n.field === 'face' ? 1 : -0.9}
                      max={n.field === 'face' ? sides : 0.9}
                      step={n.field === 'face' ? 1 : 0.1}
                      aria-label={`Tamper: edit ${n.field === 'face' ? 'face' : 'κ'} and re-verify`}
                      onChange={(ev) => onEdit(n.field!, ev.target.value)}
                    />
                  </div>
                </foreignObject>
              </g>
            );
          }
          // read-only fact node (including κ/face when not editable)
          const value = n.field === 'face' ? parsed.face : n.field === 'kappa' ? parsed.kappa : null;
          return (
            <g key={n.key}>
              <circle cx={n.x} cy={n.y} r="5.5" fill="var(--nec-ground, #090a0c)" stroke="var(--nec-node)" strokeWidth={0.8} opacity={0.85} />
              {value != null && (
                <text className={css.glyph} x={n.x} y={n.y + 4} textAnchor="middle" style={{ fontSize: '11px' }}>
                  {value}
                </text>
              )}
              <text className={css.glabel} x={n.x} y={n.y + 16} textAnchor="middle">
                {n.label}
              </text>
            </g>
          );
        })}

        <text className={css.glabel} x={SEAL.x} y={SEAL.y + 22} textAnchor="middle" style={{ opacity: 0.6 }}>
          seal
        </text>

        <text className={css.measure} x={16} y={H - 10}>
          bonds tie into the seal · tampering severs a bond{editable ? ' · edit face or κ to tamper' : ''}
        </text>
      </svg>
    </figure>
  );
}
