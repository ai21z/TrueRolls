/**
 * hyphaePath - the one way to draw a Necrography filament.
 *
 * A bowed mycelial strand between two points. `bow` offsets the path's midline
 * perpendicular to the run; two calls with opposite bows between the same endpoints
 * read as an ANASTOMOSIS, a strand that splits and rejoins (the signature growth move).
 *
 * Centralizing this keeps the "use sparingly" discipline enforced by a single primitive
 * rather than re-derived bezier math scattered across surfaces (which tempts over-wiring,
 * the reverted dissected-specimen failure). Shared by RollSigil, SeedSocket, the
 * how-it-works thread, and the Playground.
 */

export interface Pt {
  x: number;
  y: number;
}

const r = (n: number) => Math.round(n * 10) / 10;

export function hyphaePath(a: Pt, b: Pt, bow = 0): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len; // unit perpendicular
  const py = dx / len;
  const c1x = a.x + dx * 0.33 + px * bow;
  const c1y = a.y + dy * 0.33 + py * bow;
  const c2x = a.x + dx * 0.66 + px * bow;
  const c2y = a.y + dy * 0.66 + py * bow;
  return `M${r(a.x)},${r(a.y)} C${r(c1x)},${r(c1y)} ${r(c2x)},${r(c2y)} ${r(b.x)},${r(b.y)}`;
}
