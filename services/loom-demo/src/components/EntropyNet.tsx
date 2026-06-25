import { useEffect, useRef } from 'react';
import css from './EntropyNet.module.css';

/**
 * Ambient "entropy net" — a calm, very-low-presence fractal mesh painted behind
 * the whole site. It is a standing design reminder that TrueRolls rolls are not
 * yet bound to a true, unpredictable entropy source (commit-reveal + client seed
 * → drand beacon — the roadmap). Purely decorative:
 *
 * - fixed, pointer-events: none, z-index below all content (shows through the
 *   transparent page surfaces, hidden behind opaque cards);
 * - multi-scale nodes (fractal density) with gentle signals that cascade between
 *   neighbours and fade;
 * - throttled to ~30fps, paused when the tab is hidden, and rendered as a single
 *   static frame under prefers-reduced-motion.
 *
 * Presence stays low — felt, not seen — but each ignition detonates as a bright
 * core flash that swells the ball, chaining down the cascade, with a rare
 * ominous red one. Nudge PRESENCE (cap ~0.2) to shift the ambient floor.
 */
const PRESENCE = 0.06;

type Node = { x: number; y: number; r: number; lit: number };
type Edge = [number, number];
type Pulse = { e: Edge; p: number; from: number; depth: number };
type Burst = { x: number; y: number; age: number; strength: number; hot: boolean };

export function EntropyNet() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    let W = 0;
    let H = 0;
    let raf = 0;
    let t = 0;
    let last = 0;
    let resizeTimer = 0;
    let nodes: Node[] = [];
    let edges: Edge[] = [];
    let pulses: Pulse[] = [];
    let bursts: Burst[] = [];

    const rnd = (a: number, b: number) => a + Math.random() * (b - a);

    const build = () => {
      nodes = [];
      edges = [];
      pulses = [];
      bursts = [];
      // Node density scales with viewport area, clamped for perf. Three tiers
      // (hubs → branches → leaves) give the mesh a self-similar, fractal feel.
      const scale = Math.max(0.6, Math.min(1.7, (W * H) / (1280 * 800)));
      const tiers = [
        { n: Math.round(5 * scale), r: 3.8 },
        { n: Math.round(14 * scale), r: 2.3 },
        { n: Math.round(52 * scale), r: 1.2 },
      ];
      for (const tier of tiers) {
        for (let i = 0; i < tier.n; i++) {
          nodes.push({ x: rnd(0, W), y: rnd(0, H), r: tier.r, lit: 0 });
        }
      }
      for (let a = 0; a < nodes.length; a++) {
        const d: [number, number][] = [];
        for (let b = 0; b < nodes.length; b++) {
          if (a === b) continue;
          const dx = nodes[a].x - nodes[b].x;
          const dy = nodes[a].y - nodes[b].y;
          d.push([dx * dx + dy * dy, b]);
        }
        d.sort((p, q) => p[0] - q[0]);
        const k = nodes[a].r > 2.0 ? 3 : 2;
        for (let m = 0; m < k; m++) {
          const j = d[m][1];
          const lo = Math.min(a, j);
          const hi = Math.max(a, j);
          if (!edges.some((e) => e[0] === lo && e[1] === hi)) edges.push([lo, hi]);
        }
      }
    };

    const resize = () => {
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      build();
    };

    const burst = (x: number, y: number, strength: number, hot: boolean) => {
      bursts.push({ x, y, age: 0, strength, hot });
    };

    const ignite = () => {
      if (!nodes.length) return;
      const idx = (Math.random() * nodes.length) | 0;
      const n = nodes[idx];
      n.lit = 1;
      // Detonate. Rare ignitions are "hot" — ominous red.
      const hot = Math.random() < 0.16;
      burst(n.x, n.y, 1, hot);
      for (const e of edges) {
        if (e[0] === idx || e[1] === idx) pulses.push({ e, p: 0, from: idx, depth: 0 });
      }
    };

    const draw = (animate: boolean) => {
      t += 1;
      ctx.clearRect(0, 0, W, H);
      const breath = 0.85 + 0.15 * Math.sin(t * 0.01);
      const base = PRESENCE * breath;

      ctx.lineWidth = 0.6;
      for (const [a, b] of edges) {
        const na = nodes[a];
        const nb = nodes[b];
        ctx.strokeStyle = `rgba(92,108,100,${(base * 0.5).toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(na.x, na.y);
        ctx.lineTo(nb.x, nb.y);
        ctx.stroke();
      }

      for (const n of nodes) {
        const a = Math.min(0.9, base * (0.7 + n.r * 0.22) + n.lit * 0.5);
        // Lit balls swell as they charge / detonate.
        const rr = n.r * (1 + n.lit * 2.2);
        ctx.fillStyle = `rgba(120,138,128,${a.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(n.x, n.y, rr, 0, 6.2832);
        ctx.fill();
        n.lit *= 0.94;
      }

      if (!animate) return;

      // Detonations — a bright core flash only (no shockwave rings).
      const liveBursts: Burst[] = [];
      for (const bu of bursts) {
        bu.age += 0.045;
        if (bu.age >= 1) continue;
        const coreA = Math.min(0.72, base * 12 * Math.pow(1 - bu.age, 2.5) * bu.strength);
        ctx.fillStyle = `rgba(${bu.hot ? '200,130,70' : '180,190,170'},${coreA.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(bu.x, bu.y, (bu.hot ? 4.5 : 3) * (1 - bu.age) + 0.6, 0, 6.2832);
        ctx.fill();
        liveBursts.push(bu);
      }
      bursts = liveBursts.slice(0, 70);

      const speed = 0.013;
      const next: Pulse[] = [];
      for (const pu of pulses) {
        const ea = nodes[pu.e[0]];
        const eb = nodes[pu.e[1]];
        const fa = pu.from === pu.e[0];
        const sx = fa ? ea.x : eb.x;
        const sy = fa ? ea.y : eb.y;
        const ex = fa ? eb.x : ea.x;
        const ey = fa ? eb.y : ea.y;
        pu.p += speed;
        const px = sx + (ex - sx) * pu.p;
        const py = sy + (ey - sy) * pu.p;
        const g = Math.min(0.65, base * 4 * (1 - pu.depth * 0.3));
        ctx.fillStyle = `rgba(130,150,138,${g.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(px, py, 1.4, 0, 6.2832);
        ctx.fill();
        if (pu.p >= 1) {
          const tgt = fa ? pu.e[1] : pu.e[0];
          const tn = nodes[tgt];
          tn.lit = Math.max(tn.lit, 0.85);
          // A smaller secondary detonation where the signal lands.
          burst(tn.x, tn.y, 0.55, false);
          if (pu.depth < 2 && Math.random() < 0.5) {
            for (const e of edges) {
              if (e[0] === tgt || e[1] === tgt) next.push({ e, p: 0, from: tgt, depth: pu.depth + 1 });
            }
          }
        } else {
          next.push(pu);
        }
      }
      pulses = next.slice(0, 140);
      if (Math.random() < 0.024) ignite();
    };

    const FRAME = 1000 / 30;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - last < FRAME) return;
      last = now;
      if (document.hidden) return;
      draw(true);
    };

    const onResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resize();
        if (reduce) draw(false);
      }, 200);
    };

    resize();
    // Paint the static mesh immediately so there is never a blank first frame
    // (and so the net is present even if rAF is throttled while backgrounded).
    draw(false);
    window.addEventListener('resize', onResize);

    if (!reduce) {
      raf = requestAnimationFrame(loop);
    }

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(resizeTimer);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  return <canvas ref={canvasRef} className={css.net} aria-hidden="true" />;
}
