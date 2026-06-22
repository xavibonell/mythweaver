/**
 * FOOTPRINT MASKS — a building's shape is an arbitrary set of interior-FLOOR cells; the wall ring is
 * DERIVED from it (see buildMasked in primitives.ts), never drawn-then-mutated. That single inversion is
 * what makes ANY footprint — rect, L, T, U, cross (and later corridors/organic) — come out with a clean,
 * watertight, correctly-cornered 1-tile wall ring, because the autotiler and the structural passes are
 * all neighbour-based.
 *
 * A mask is just a list of DISJOINT, edge-adjacent rectangles that PARTITION the floor. Two payoffs:
 *  - the union of axis-aligned edge-adjacent rects is always 4-connected and pinch-free (clean ring), and
 *  - every "part" is a true rectangle, so room subdivision bisects parts and furnishRoom is reused as-is.
 *
 * "LLM picks the NAME, code owns the geometry": the Director/town chooses a ShapeKind + size; these pure
 * functions own every coordinate.
 */

import type { Rect } from './primitives.js';

export type ShapeKind = 'rect' | 'ell' | 'tee' | 'you' | 'plus';

export interface FootprintMask {
  /** Bounding box of the floor region (the wall ring sits in the 1-cell margin around it). */
  bbox: Rect;
  /** Disjoint, edge-adjacent rectangles whose union IS the interior floor. */
  parts: Rect[];
}

const ri = (rng: () => number, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1)); // inclusive

/** Is (c,r) an interior floor cell? (member of any part) */
export function inside(m: FootprintMask, c: number, r: number): boolean {
  for (const p of m.parts) if (c >= p.x && c < p.x + p.w && r >= p.y && r < p.y + p.h) return true;
  return false;
}

/** The WALL RING: cells N8-adjacent to interior floor that are NOT themselves interior. N8 (not N4) so a
 *  convex corner's diagonal is sealed — no pinhole. Returned as a "c,r" string set. */
export function ringCells(m: FootprintMask): Set<string> {
  const ring = new Set<string>();
  const N8 = [-1, 0, 1];
  for (const p of m.parts)
    for (let r = p.y - 1; r <= p.y + p.h; r++)
      for (let c = p.x - 1; c <= p.x + p.w; c++) {
        if (inside(m, c, r)) continue;
        for (const dr of N8) for (const dc of N8) if ((dc || dr) && inside(m, c + dc, r + dr)) { ring.add(`${c},${r}`); break; }
      }
  return ring;
}

/** The total footprint (floor + derived ring) bounding box — for placement/overlap tests. */
export function footprintBox(m: FootprintMask): Rect {
  return { x: m.bbox.x - 1, y: m.bbox.y - 1, w: m.bbox.w + 2, h: m.bbox.h + 2 };
}

/** Validate: parts non-empty, the union is 4-connected (no corner-only touches), every part ≥3×3. The
 *  hand-built shapes below satisfy this by construction; this is the backstop (and the gate for any
 *  future organic generator). */
export function validateMask(m: FootprintMask): boolean {
  if (!m.parts.length) return false;
  for (const p of m.parts) if (p.w < 3 || p.h < 3) return false;
  // 4-connectivity of the floor via flood over interior cells.
  const start = m.parts[0]!;
  const seen = new Set<string>([`${start.x},${start.y}`]);
  const stack = [[start.x, start.y] as [number, number]];
  let n = 0;
  while (stack.length) {
    const [c, r] = stack.pop()!; n++;
    for (const [dc, dr] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
      const nc = c + dc, nr = r + dr, k = `${nc},${nr}`;
      if (!seen.has(k) && inside(m, nc, nr)) { seen.add(k); stack.push([nc, nr]); }
    }
  }
  let total = 0;
  for (const p of m.parts) total += p.w * p.h; // parts are disjoint → exact area
  return n === total; // every interior cell reached ⇒ one 4-connected region, no diagonal pinch
}

// ── Shape generators — each takes the LOT rect, returns a mask whose floor+ring fits inside it. ───────
// Floor is inset 1 from the lot so the derived wall ring lands on the lot's edge. Parts are disjoint and
// share full edges (4-connected). A jittered dim is clamped so each part stays ≥3 and the shape is legible.

function rectMask(lot: Rect): FootprintMask {
  const x = lot.x + 1, y = lot.y + 1, w = lot.w - 2, h = lot.h - 2;
  return { bbox: { x, y, w, h }, parts: [{ x, y, w, h }] };
}

/** L — full floor minus one corner quadrant. Two edge-adjacent rects (full-width bottom + a top stub). */
function ellMask(lot: Rect, rng: () => number): FootprintMask {
  const x = lot.x + 1, y = lot.y + 1, w = lot.w - 2, h = lot.h - 2;
  const cutW = ri(rng, 3, w - 3), cutH = ri(rng, 3, h - 3); // removed quadrant size (both sides keep ≥3)
  const corner = Math.floor(rng() * 4); // which corner to cut: 0 TL,1 TR,2 BL,3 BR
  const left = corner === 0 || corner === 2; // cut on the left?
  const top = corner === 0 || corner === 1; // cut on the top?
  const stubX = left ? x + cutW : x;
  const barRow = top ? { x, y: y + cutH, w, h: h - cutH } : { x, y, w, h: h - cutH }; // full-width bar away from the cut
  const stubY = top ? y : y + (h - cutH);
  const stub = { x: stubX, y: stubY, w: w - cutW, h: cutH }; // the remaining part of the cut row
  return { bbox: { x, y, w, h }, parts: [barRow, stub] };
}

/** T — a full-width bar on one edge + a centred stem off it. */
function teeMask(lot: Rect, rng: () => number): FootprintMask {
  const x = lot.x + 1, y = lot.y + 1, w = lot.w - 2, h = lot.h - 2;
  const barH = ri(rng, 3, h - 3);
  const stemW = Math.max(3, Math.min(w - 4, Math.round(w * (0.4 + rng() * 0.2))));
  const stemX = x + Math.floor((w - stemW) / 2);
  const top = rng() < 0.5;
  const bar = top ? { x, y, w, h: barH } : { x, y: y + h - barH, w, h: barH };
  const stem = top ? { x: stemX, y: y + barH, w: stemW, h: h - barH } : { x: stemX, y, w: stemW, h: h - barH };
  return { bbox: { x, y, w, h }, parts: [bar, stem] };
}

/** U — two arms + a connecting bar on one edge (the opening faces the opposite edge). */
function youMask(lot: Rect, rng: () => number): FootprintMask {
  const x = lot.x + 1, y = lot.y + 1, w = lot.w - 2, h = lot.h - 2;
  const armW = Math.max(3, Math.min(Math.floor((w - 3) / 2), 3 + Math.floor(rng() * 2)));
  const barH = ri(rng, 3, h - 3);
  const bottom = rng() < 0.5; // bar on the bottom (opening up) or top
  const arms = [{ x, y, w: armW, h }, { x: x + w - armW, y, w: armW, h }];
  const bar = bottom ? { x: x + armW, y: y + h - barH, w: w - 2 * armW, h: barH } : { x: x + armW, y, w: w - 2 * armW, h: barH };
  return { bbox: { x, y, w, h }, parts: [...arms, bar] };
}

/** Plus / cross — a full-height central column + two side arms (disjoint: column owns the centre). */
function plusMask(lot: Rect, rng: () => number): FootprintMask {
  const x = lot.x + 1, y = lot.y + 1, w = lot.w - 2, h = lot.h - 2;
  const colW = Math.max(3, Math.min(w - 4, Math.round(w * (0.34 + rng() * 0.12))));
  const colX = x + Math.floor((w - colW) / 2);
  const armH = Math.max(3, Math.min(h - 4, Math.round(h * (0.34 + rng() * 0.12))));
  const armY = y + Math.floor((h - armH) / 2);
  const col = { x: colX, y, w: colW, h };
  const leftArm = { x, y: armY, w: colX - x, h: armH };
  const rightArm = { x: colX + colW, y: armY, w: x + w - (colX + colW), h: armH };
  return { bbox: { x, y, w, h }, parts: [col, leftArm, rightArm].filter((p) => p.w >= 3 && p.h >= 3) };
}

export const SHAPE_GENS: Record<ShapeKind, (lot: Rect, rng: () => number) => FootprintMask> = {
  rect: (lot) => rectMask(lot),
  ell: ellMask,
  tee: teeMask,
  you: youMask,
  plus: plusMask,
};

/** Smallest lot (w×h incl. the wall ring) each shape needs to be legible; below this, fall back to rect. */
export const SHAPE_MIN: Record<ShapeKind, { w: number; h: number }> = {
  rect: { w: 7, h: 7 },
  ell: { w: 11, h: 11 },
  tee: { w: 11, h: 11 },
  you: { w: 13, h: 11 },
  plus: { w: 13, h: 13 },
};

/** Build a validated mask for a shape on a lot, falling back to rect if the shape doesn't fit or fails. */
export function maskFor(kind: ShapeKind, lot: Rect, rng: () => number): FootprintMask {
  const min = SHAPE_MIN[kind];
  if (lot.w >= min.w && lot.h >= min.h) {
    const m = SHAPE_GENS[kind](lot, rng);
    if (validateMask(m)) return m;
  }
  return rectMask(lot);
}
