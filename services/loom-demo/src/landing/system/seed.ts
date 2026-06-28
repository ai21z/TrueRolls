/**
 * seed.ts - deterministic geometry of the rooting-seed glyph.
 *
 * Two glyphs share this file:
 *  • The SOCKET aura rings used by the playground result well (Stage): `makeAura`.
 *  • The germinating SEED glyph used by the "seed honesty" specimen (SeedSocket):
 *    `makeSeed` (hatched reniform testa + hilum + cracked pole) + `makeFeederRoots`
 *    (the present roots) + `makeGhostTaproot` (the MISSING deep anchor).
 *
 * Every generator is seeded (mulberry32), so the same inputs always draw the same
 * engraving - no runtime randomness.
 */

export function seedRng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface AuraRing {
  cx: number;
  cy: number;
  r: number;
  op: number;
  col: string;
  sw: number;
}

/** Concentric engraved aura around the socket - the carved register lines (legacy). */
export function makeAura(cx: number, cy: number, vr: number, rings = 36, seed = 13): AuraRing[] {
  const rand = seedRng(seed);
  const out: AuraRing[] = [];
  let x = cx;
  let y = cy;
  for (let i = 0; i < rings; i++) {
    const r = vr + 2 + i * 2.5;
    x += rand() - 0.5;
    y += rand() - 0.5;
    out.push({
      cx: +x.toFixed(1),
      cy: +y.toFixed(1),
      r: +r.toFixed(1),
      op: +Math.max(0.03, 0.45 * (1 - i / rings)).toFixed(2),
      col: i < 5 ? '#6a4a32' : i < 13 ? '#3a342a' : '#2a2a26',
      sw: i < 6 ? 0.8 : 0.5,
    });
  }
  return out;
}

export interface RootSeg {
  d: string;
  w: number;
  op: number;
}

// ───────────────────────── the germinating SEED glyph ─────────────────────────

export interface SeedGlyph {
  /** The reniform testa outline (the seed body). */
  body: string;
  /** Curved hatch strokes following the coat - clip to `body`. */
  hatch: string[];
  /** The oval hilum scar (the "eye"), on the concave side by the rooting pole. */
  hilum: { cx: number; cy: number; rx: number; ry: number; rot: number };
  /** The micropyle: the pore the radicle exits, at the rooting pole. */
  micropyle: { cx: number; cy: number; r: number };
  /** Cracked-coat marks at the rooting pole: a lifted lip + split lines. */
  crack: string[];
  /** The rooting pole - where the coat splits and roots emerge. */
  pole: { x: number; y: number };
}

/**
 * A germinating kidney seed centred at (cx, cy). The concave hilum notch sits on
 * the lower-left and is the rooting pole - the coat cracks there and roots descend,
 * so the pole faces the feeding fact-cells to its left.
 */
export function makeSeed(cx: number, cy: number, hw = 46, hh = 52, seed = 7): SeedGlyph {
  // Reniform body, clockwise from the top. The concave (inward) segment on the
  // lower-left is the kidney notch where the hilum/micropyle sit.
  const body = [
    `M${cx + 4},${cy - hh}`,
    `C${cx + hw + 7},${cy - hh + 6} ${cx + hw + 5},${cy + hh * 0.5} ${cx + 8},${cy + hh}`,
    `C${cx - hw * 0.45},${cy + hh + 3} ${cx - hw + 2},${cy + hh * 0.62} ${cx - hw * 0.8},${cy + hh * 0.28}`,
    `C${cx - hw * 0.42},${cy + hh * 0.12} ${cx - hw * 0.42},${cy - hh * 0.06} ${cx - hw * 0.82},${cy - hh * 0.22}`,
    `C${cx - hw - 1},${cy - hh * 0.56} ${cx - hw * 0.4},${cy - hh} ${cx + 4},${cy - hh}`,
    'Z',
  ].join(' ');

  const pole = { x: +(cx - hw * 0.5).toFixed(1), y: +(cy + hh * 0.74).toFixed(1) };

  const rand = seedRng(seed);
  const hatch: string[] = [];
  for (let i = 0; i < 12; i++) {
    const t = i / 11;
    const y = cy - hh * 0.84 + t * hh * 1.66;
    const bow = 5 + rand() * 5;
    hatch.push(
      `M${(cx - hw * 0.72).toFixed(1)},${y.toFixed(1)} Q${cx.toFixed(1)},${(y - bow).toFixed(1)} ${(cx + hw * 0.86).toFixed(1)},${(y + 2).toFixed(1)}`,
    );
  }

  const hilum = {
    cx: +(cx - hw * 0.64).toFixed(1),
    cy: +(cy + hh * 0.06).toFixed(1),
    rx: 3.6,
    ry: 9,
    rot: -18,
  };
  const micropyle = { cx: +(pole.x + 3).toFixed(1), cy: +(pole.y - 4).toFixed(1), r: 1.8 };

  const crack: string[] = [
    `M${(cx - hw * 0.86).toFixed(1)},${(cy + hh * 0.14).toFixed(1)} Q${(pole.x - 6).toFixed(1)},${(pole.y + 7).toFixed(1)} ${(cx - hw * 0.22).toFixed(1)},${(cy + hh * 0.58).toFixed(1)}`,
  ];
  for (let k = 0; k < 3; k++) {
    const ang = -2.35 + k * 0.42;
    const len = 11 + k * 2;
    crack.push(
      `M${pole.x},${pole.y} L${(pole.x + Math.cos(ang) * len).toFixed(1)},${(pole.y + Math.sin(ang) * len).toFixed(1)}`,
    );
  }

  return { body, hatch, hilum, micropyle, crack, pole };
}

/**
 * Present feeder roots descending from the rooting pole (sx, sy): primary roots
 * that fork and rejoin (anastomosis), tapering via per-segment width decay and
 * curving downward (gravitropic). These are what the seed HAS grown.
 */
export function makeFeederRoots(sx: number, sy: number, seed = 29, count = 5): RootSeg[] {
  const rand = seedRng(seed);
  const out: RootSeg[] = [];
  function root(x: number, y: number, ang: number, len: number, depth: number, w: number) {
    if (depth <= 0 || len < 4) return;
    const bend = (rand() - 0.5) * 0.7;
    const ex = x + Math.cos(ang) * len;
    const ey = y + Math.sin(ang) * len;
    const mx = x + Math.cos(ang + bend) * len * 0.5;
    const my = y + Math.sin(ang + bend) * len * 0.5;
    out.push({
      d: `M${x.toFixed(1)},${y.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}`,
      w: +w.toFixed(2),
      op: +Math.max(0.12, 0.58 * (depth / 4)).toFixed(2),
    });
    const n = rand() < 0.5 ? 2 : 3;
    for (let k = 0; k < n; k++) {
      const spread = (rand() - 0.5) * 0.7 + (k - (n - 1) / 2) * 0.5;
      root(ex, ey, ang + spread, len * (0.6 + rand() * 0.2), depth - 1, w * 0.74);
    }
  }
  for (let m = 0; m < count; m++) {
    const ang = Math.PI / 2 + (m - (count - 1) / 2) * 0.34 + (rand() - 0.5) * 0.18;
    root(sx + (m - (count - 1) / 2) * 5, sy, ang, 24 + rand() * 11, 4, 3.0);
  }
  return out;
}

/**
 * The MISSING dominant taproot: a single deep root the seed has NOT grown - drawn
 * as a faint dotted reach straight down from the pole, ending in an unfilled tip.
 * This is seed honesty: the anchor the proof cannot yet certify.
 */
export function makeGhostTaproot(sx: number, sy: number): { d: string; tip: { x: number; y: number } } {
  const tip = { x: +(sx - 3).toFixed(1), y: +(sy + 120).toFixed(1) };
  const d = `M${sx},${sy} C${(sx - 7).toFixed(1)},${(sy + 42).toFixed(1)} ${(sx + 9).toFixed(1)},${(sy + 80).toFixed(1)} ${tip.x},${tip.y}`;
  return { d, tip };
}
