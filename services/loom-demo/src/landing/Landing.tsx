import { useEffect, useRef } from 'react';
import { MotionConfig } from 'framer-motion';
import type { useKarmaState } from '../hooks/useKarmaState';
import { Hero } from './sections/Hero';
import { Playground } from './sections/Playground';
import { SeedSocket } from './sections/SeedSocket';
import { Reveal } from './Reveal';
import { ScrollAtmosphere } from './ScrollAtmosphere';
import { hyphaePath } from './system/hyphae';
import { seedRng } from './system/seed';
import { InkFrame } from './system/InkFrame';
import { InkButton } from './system/InkButton';
import { SiteSignature } from './system/SiteSignature';
import css from './Landing.module.css';

// ── d20 (icosahedron, face-on) for the how-it-works diagram ──────────────────
// The labelled front face is the Roll/Sign/Verify triangle. The rest of the die is
// drawn around it at the same scale. Face-on projection: the front + back faces are
// an inner hexagon (radius RA). The equatorial belt is the outer hull (radius RA·φ),
// at the same six angles. Static geometry. The apex (Roll) carries the lone ember.
type Pt = { x: number; y: number };
const TRI_O = { x: 300, y: 317 };
const RA = 240;
const RB = 388; // RA · φ, the icosahedron's projected radius ratio

function vert(deg: number, r: number): Pt {
  const a = (deg * Math.PI) / 180;
  return { x: +(TRI_O.x + r * Math.cos(a)).toFixed(1), y: +(TRI_O.y - r * Math.sin(a)).toFixed(1) };
}

// front face (90/210/330), the labelled triangle the boxes hang off
const A = vert(90, RA);
const B = vert(210, RA);
const C = vert(330, RA);
// outer hull (the silhouette), same six angles at radius RB
const O90 = vert(90, RB);
const O30 = vert(30, RB);
const O330 = vert(330, RB);
const O270 = vert(270, RB);
const O210 = vert(210, RB);
const O150 = vert(150, RB);

const APEX = A;

// Deterministic spark dust at the roll vertex, engraving grain, not confetti.
function makeSparks(cx: number, cy: number, n = 20, seed = 71) {
  const rand = seedRng(seed);
  const out: { x: number; y: number; r: number; op: number }[] = [];
  for (let i = 0; i < n; i++) {
    const ang = rand() * Math.PI * 2;
    const rad = 14 + rand() * 120;
    out.push({
      x: +(cx + Math.cos(ang) * rad).toFixed(1),
      y: +(cy - 8 + Math.sin(ang) * rad * 0.7).toFixed(1),
      r: +(0.5 + rand() * 1.2).toFixed(2),
      op: +(0.1 + rand() * 0.36).toFixed(2),
    });
  }
  return out;
}

const triPts = (p: Pt, q: Pt, s: Pt) => `${p.x},${p.y} ${q.x},${q.y} ${s.x},${s.y}`;

const D20 = {
  // faceted shading on the die's other front faces (higher = catches more light)
  facets: [
    { d: triPts(A, O30, O90), op: 0.07 },
    { d: triPts(A, O90, O150), op: 0.06 },
    { d: triPts(A, C, O30), op: 0.05 },
    { d: triPts(A, B, O150), op: 0.045 },
    { d: triPts(C, O330, O30), op: 0.035 },
    { d: triPts(B, O150, O210), op: 0.03 },
    { d: triPts(C, O270, O330), op: 0.022 },
    { d: triPts(B, O210, O270), op: 0.02 },
    { d: triPts(B, C, O270), op: 0.016 },
  ],
  // the outer hull (silhouette)
  hull: [
    hyphaePath(O90, O30, 6),
    hyphaePath(O30, O330, 8),
    hyphaePath(O330, O270, 6),
    hyphaePath(O270, O210, 6),
    hyphaePath(O210, O150, 8),
    hyphaePath(O150, O90, 6),
  ],
  // spokes: each front-face corner out to the hull
  spokes: [
    hyphaePath(A, O90, 4),
    hyphaePath(A, O30, -6),
    hyphaePath(A, O150, 6),
    hyphaePath(B, O210, 4),
    hyphaePath(B, O150, -6),
    hyphaePath(B, O270, 6),
    hyphaePath(C, O330, 4),
    hyphaePath(C, O270, -6),
    hyphaePath(C, O30, 6),
  ],
  // the labelled front face (bright), base forks + rejoins (anastomosis)
  central: [
    hyphaePath(C, A, -14),
    hyphaePath(A, B, -14),
    hyphaePath(B, C, 12),
    hyphaePath(B, C, -8),
  ],
  nodes: [B, C],
  hullNodes: [O90, O210, O330],
  sparks: makeSparks(A.x, A.y),
};

interface Props {
  state: ReturnType<typeof useKarmaState>;
}

const STEPS = [
  {
    n: '01',
    title: 'Roll',
    body: 'A uniform roll by default, seeded from a public drand beacon. An optional, signed κ stance can tilt the odds. KL and EV caps bound exactly how far.',
  },
  {
    n: '02',
    title: 'Sign',
    body: 'The server returns an Ed25519-signed receipt, the draw, the math, and the face, sealed against any later edit.',
  },
  {
    n: '03',
    title: 'Verify',
    body: 'Recompute the distribution and check the signature anywhere, offline. The receipt carries its own proof.',
  },
];

export function Landing({ state }: Props) {
  const proofRef = useRef<HTMLDivElement>(null);
  const playRef = useRef<HTMLElement>(null);

  const scrollTo = (el: HTMLElement | null) =>
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Deep-link: arriving with #play (e.g. the Verify page's Playground link)
  // scrolls to the playground once layout has settled.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.location.hash === '#play' || window.location.hash === '#playground') {
      const t = setTimeout(() => {
        playRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 80);
      return () => clearTimeout(t);
    }
  }, []);

  return (
    <MotionConfig reducedMotion="user">
    <main className={css.page}>
      <ScrollAtmosphere />
      {state.mock && (
        <div className={css.mockBanner}>
          Demo mode, receipts are simulated. Start the API for real Ed25519 signing.
        </div>
      )}

      <header className={css.nav}>
        <div className={css.navLeft}>
          <span className={css.navAccession} aria-hidden="true">REC · LIVE</span>
          <span className={css.brand}>
            true<span className={css.brandAccent}>rolls</span>
          </span>
        </div>
        <div className={css.navLinks}>
          <a className={css.navLink} href="#verify">
            Verify
          </a>
          <a className={css.navLink} href="#behind-a-roll">
            Behind a roll
          </a>
          <a className={css.navLink} href="#docs">
            Docs
          </a>
          <InkButton seed={51} className={css.navCta} onClick={() => scrollTo(playRef.current)}>
            Open playground
          </InkButton>
        </div>
      </header>

      <Hero
        state={state}
        onSeeProof={() => scrollTo(proofRef.current)}
        onOpenPlayground={() => scrollTo(playRef.current)}
      />

      <div ref={proofRef}>
        <section className={css.section} aria-label="How it works">
          <div className={css.inner}>
            <Reveal>
              <span className={css.eyebrow}>How it works</span>
              <h2 className={css.h2}>Three steps. Every one of them checkable.</h2>
            </Reveal>
            <div className={css.triad}>
              <svg
                className={css.triadFrame}
                viewBox="-60 -100 720 840"
                preserveAspectRatio="xMidYMid meet"
                aria-hidden="true"
                xmlns="http://www.w3.org/2000/svg"
              >
                <defs>
                  <radialGradient id="triad-ember" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor="#e6a064" stopOpacity="0.8" />
                    <stop offset="60%" stopColor="#b87242" stopOpacity="0.18" />
                    <stop offset="100%" stopColor="#b87242" stopOpacity="0" />
                  </radialGradient>
                </defs>
                {/* faceted shading, the die's other front faces */}
                {D20.facets.map((f, i) => (
                  <polygon key={`fc-${i}`} className={css.triadFacet} points={f.d} style={{ opacity: f.op }} />
                ))}
                {/* outer hull silhouette */}
                {D20.hull.map((d, i) => (
                  <path
                    key={`hl-${i}`}
                    className={`${css.triadHull} ${css.triadDraw}`}
                    d={d}
                    pathLength={1}
                    style={{ animationDelay: `${0.1 + i * 0.06}s` }}
                  />
                ))}
                {/* spokes, front-face corners out to the hull */}
                {D20.spokes.map((d, i) => (
                  <path
                    key={`sk-${i}`}
                    className={`${css.triadSpoke} ${css.triadDraw}`}
                    d={d}
                    pathLength={1}
                    style={{ animationDelay: `${0.22 + i * 0.04}s` }}
                  />
                ))}
                {/* entropy sparks at the roll vertex */}
                {D20.sparks.map((s, i) => (
                  <circle key={`sp-${i}`} className={css.triadSpark} cx={s.x} cy={s.y} r={s.r} style={{ opacity: s.op }} />
                ))}
                {/* the labelled front face (the verify face) */}
                {D20.central.map((d, i) => (
                  <path
                    key={`ce-${i}`}
                    className={`${css.triadEdge} ${css.triadDraw}`}
                    d={d}
                    pathLength={1}
                    style={{ animationDelay: `${0.45 + i * 0.1}s` }}
                  />
                ))}
                <circle cx={APEX.x} cy={APEX.y} r="13" fill="url(#triad-ember)" />
                <circle className={css.triadNodeEmber} cx={APEX.x} cy={APEX.y} r="3.6" />
                {D20.nodes.map((n, i) => (
                  <circle key={`nd-${i}`} className={css.triadNode} cx={n.x} cy={n.y} r="3" />
                ))}
                {D20.hullNodes.map((n, i) => (
                  <circle key={`hn-${i}`} className={css.triadNode} cx={n.x} cy={n.y} r="2.4" style={{ opacity: 0.5 }} />
                ))}
              </svg>

              {STEPS.map((s, i) => (
                <div
                  key={s.n}
                  className={`${css.triadStep} ${[css.triadStepTop, css.triadStepLeft, css.triadStepRight][i]}`}
                >
                  <Reveal delay={i * 0.1}>
                    <InkFrame seed={40 + i * 4} className={css.stepCard}>
                      <span className={css.stepNum}>{s.n}</span>
                      <span className={css.stepTitle}>{s.title}</span>
                      <span className={css.stepBody}>{s.body}</span>
                    </InkFrame>
                  </Reveal>
                </div>
              ))}

              <a className={css.triadCenter} href="#behind-a-roll">
                Behind a roll →
              </a>
            </div>
          </div>
        </section>

        <section className={css.section} aria-label="Verify it yourself">
          <div className={css.inner}>
            <Reveal>
              <span className={css.eyebrow}>Don't trust. Verify.</span>
              <h2 className={css.h2}>Verify any receipt yourself.</h2>
              <p className={css.lead}>
                The receipt is self-contained and the signing key is published. Check a receipt
                right in your browser, locally, with nothing to install, and confirm the
                signature and the math yourself. No server, no account, no leap of faith.
              </p>
              <InkFrame inline seed={52} className={css.verifyCtaWrap}>
                <a className={css.verifyCta} href="#verify">
                  Verify in your browser →
                </a>
              </InkFrame>
            </Reveal>

            <Reveal delay={0.05} className={css.verifyGrid}>
              <InkFrame seed={50} className={css.codeCard}>
                <div className={css.codeHead}>
                  <span>verify</span>
                  <span>in your browser · wasm</span>
                </div>
                <pre className={css.codeBody}>
{`receipt.json  →  checked locally, no server

`}<span className={css.codeOk}>{`✓ VALID
  signature  OK   (Ed25519)
  sampling   OK   (draw_u64 replayed)
  face       OK
  metrics    OK   (α · KL · EV)`}</span>
                </pre>
              </InkFrame>

              <div className={css.trustList}>
                <div className={css.trustItem}>
                  <span className={css.trustDot} />
                  <span className={css.trustText}>
                    <b>Public drand seed.</b> The seed is tied to a client nonce and a verified
                    future drand quicknet round. The verifier checks that source, not a
                    server-made random value.
                  </span>
                </div>
                <div className={css.trustItem}>
                  <span className={css.trustDot} />
                  <span className={css.trustText}>
                    <b>One verifier.</b> The same kd-core engine in Rust, CLI, and WASM,
                    one path, bit-for-bit.
                  </span>
                </div>
                <div className={css.trustItem}>
                  <span className={css.trustDot} />
                  <span className={css.trustText}>
                    <b>Published key.</b> The Ed25519 public key lives at{' '}
                    <code>/.well-known/truerolls-keys.json</code>.
                  </span>
                </div>
                <div className={css.trustItem}>
                  <span className={css.trustDot} />
                  <span className={css.trustText}>
                    <b>Uniform by default.</b> At κ 0 the die is uniform, and the receipt proves
                    κ 0 was used. A signed stance is bounded by the KL and EV caps, with no hidden
                    weighting.
                  </span>
                </div>
                <p className={css.honest}>
                  This proves the seed&apos;s public provenance and that the outcome replays from
                  it. It does <b>not yet</b> prove the operator could not privately discard an
                  unfavourable completed roll and publish only this one. Strict witnessed fairness
                  is the v2 protocol, not this per-roll receipt.
                </p>
              </div>
            </Reveal>

            <Reveal delay={0.08}>
              <SeedSocket />
            </Reveal>
          </div>
        </section>
      </div>

      <Playground state={state} ref={playRef} />

      <footer className={css.footer}>
        <div className={css.footerInner}>
          <div className={css.colophonBrand}>
            <span className={css.brandDisplay}>
              true<span className={css.brandAccent}>rolls</span>
            </span>
            <span className={css.footerNote}>
              <span className={css.footerField} aria-hidden="true">Field record · </span>
              Deterministic, signed, independently replayable dice.
            </span>
          </div>
          <div className={css.colophonStamps} aria-hidden="true">
            <span className={css.footerStamp}>Engine · kd-core</span>
            <span className={css.footerStamp}>Edition · 2026</span>
            <span className={css.emberTick} />
          </div>
        </div>
        <div className={css.footerSignature}>
          <SiteSignature />
        </div>
      </footer>
    </main>
    </MotionConfig>
  );
}
