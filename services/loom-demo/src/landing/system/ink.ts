/**
 * inkRect — a hand-drawn rectangle border, the rectangle twin of hyphaePath.
 *
 * Bakes the pen quality (corner overshoot, a wavering edge) into the path itself,
 * seeded deterministically so a given box is stable but no two are quite identical.
 * No runtime SVG filter, so it stays cheap across the dozens of boxes on the site.
 *
 * Render two passes (seed, seed+1) at different opacities for the "drawn twice"
 * look of a real pen. Used by the SVG surfaces directly and by <InkFrame> for HTML.
 */

const round = (n: number) => Math.round(n * 10) / 10;

function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function inkEdge(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  rand: () => number,
  overshoot: number,
  jitter: number,
): string {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy; // perpendicular
  const py = ux;
  // extend each end a touch past the corner so strokes cross (the pen overshoot)
  const oa = overshoot * (0.4 + rand() * 0.7);
  const ob = overshoot * (0.4 + rand() * 0.7);
  const a0x = ax - ux * oa;
  const a0y = ay - uy * oa;
  const b0x = bx + ux * ob;
  const b0y = by + uy * ob;
  // two control points wandered off the line, so the edge wavers like a drawn line
  const j1 = (rand() - 0.5) * jitter;
  const j2 = (rand() - 0.5) * jitter;
  const c1x = a0x + (b0x - a0x) * 0.33 + px * j1;
  const c1y = a0y + (b0y - a0y) * 0.33 + py * j1;
  const c2x = a0x + (b0x - a0x) * 0.66 + px * j2;
  const c2y = a0y + (b0y - a0y) * 0.66 + py * j2;
  return `M${round(a0x)},${round(a0y)} C${round(c1x)},${round(c1y)} ${round(c2x)},${round(c2y)} ${round(b0x)},${round(b0y)}`;
}

export interface InkRectOpts {
  overshoot?: number;
  jitter?: number;
  inset?: number;
}

export function inkRect(w: number, h: number, seed = 1, opts: InkRectOpts = {}): string {
  const overshoot = opts.overshoot ?? 4;
  const jitter = opts.jitter ?? 2.2;
  const inset = opts.inset ?? 0.5;
  const rand = rng(seed);
  const x0 = inset;
  const y0 = inset;
  const x1 = w - inset;
  const y1 = h - inset;
  return [
    inkEdge(x0, y0, x1, y0, rand, overshoot, jitter), // top
    inkEdge(x1, y0, x1, y1, rand, overshoot, jitter), // right
    inkEdge(x1, y1, x0, y1, rand, overshoot, jitter), // bottom
    inkEdge(x0, y1, x0, y0, rand, overshoot, jitter), // left
  ].join(' ');
}
