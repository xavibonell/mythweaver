/**
 * PRECINCT VAULT — the pattern layer for believable town COMPOSITION. Where townGen subdivides land and floats
 * one building per parcel (isolated boxes in grass moats), a precinct is a hand-DESIGNED "place": buildings are
 * PACKED onto street frontage around a composed centre. Each precinct is a small coherent composition of
 * primitives + the 21 furnished building types; the town/city generator will later stitch precincts along an
 * organic street skeleton. This file starts the vault with the CENTRAL SQUARE.
 *
 * THE HEADLINE MECHANISM is FRONTAGE PACKING with IRREGULAR building silhouettes. Buildings are NOT squared
 * boxes — each is a real compound shape (L/T/U/cross/compose, via compound's opts.shape), big enough to be
 * legible (≥ SHAPE_MIN). Packed flush onto a side with their door on the paving, their irregular masses leave
 * irregular negative space, and the perpendicular gaps between them are carved as alleys — so the STREET network
 * is defined BY the buildings (an outdoor room walled by buildings), the whole reason the shape vocabulary exists.
 *
 * Paving is `stone` — grey fitted-brick (the same asset stone buildings use), which reads as a paved street/plaza.
 * (The tag named `cobblestone` is a tan/sandy sprite that reads as dirt, so we don't use it for paths.)
 */

import { Canvas, compound, fill, place, plaza, poissonScatter, clumpScatter, type Rect } from './primitives.js';
import { SHAPE_MIN, type ShapeKind } from './footprint.js';
import type { BuildingType } from '@mythweaver/shared';

const slug = (s: string) => (s || 'x').replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '') || 'x';

/**
 * CENTRAL SQUARE precinct — a paved plaza with a WATER POOL at its heart (water framed by a stone-brick rim, a
 * fountain on a centre pedestal, benches), broken by a lattice of green islands + a row of market stalls. Around
 * it, belts of IRREGULAR compound buildings (grand manors north, popular trades elsewhere) packed flush and
 * facing in; the gaps between their irregular masses are carved as alleys, and a paved BACK LANE rings the first
 * belt with a second belt of shops/houses fronting it. Green parks cluster in the corners. Deterministic from cv.
 */
export function precinctSquare(cv: Canvas, region: Rect, locationId: string): void {
  const R = region;
  if (R.w < 36 || R.h < 32) { fill(cv, R, 'grass', true); return; } // too small to compose — just green it
  const rng = () => cv.rng();
  const loc = slug(locationId);
  const PAVE = 'stone';   // grey fitted brick = the paved-street look
  const RIM = 'stone_brick';
  let pid = 0, bi = 0;
  const prop = (tag: string, c: number, r: number) => { if (cv.inB(c, r) && cv.isFree(c, r)) place(cv, { id: `prop:${loc}-p${pid++}`, tag, kind: 'prop', at: { c, r } }); };
  const propOn = (tag: string, c: number, r: number) => { if (cv.inB(c, r)) place(cv, { id: `prop:${loc}-p${pid++}`, tag, kind: 'prop', at: { c, r } }); };
  const carve = (x: number, y: number, w: number, h: number, tag = PAVE, walk = true) => { if (w > 0 && h > 0) fill(cv, { x, y, w, h }, tag, walk); };

  fill(cv, R, 'grass', true);

  // ── CENTRAL SQUARE (paved), sized to leave room for two building belts + corner parks.
  const SW = Math.max(18, Math.min(Math.floor(R.w * 0.30), R.w - 34));
  const SH = Math.max(16, Math.min(Math.floor(R.h * 0.30), R.h - 30));
  const S: Rect = { x: R.x + Math.floor((R.w - SW) / 2), y: R.y + Math.floor((R.h - SH) / 2), w: SW, h: SH };
  plaza(cv, S, PAVE);
  const cc = S.x + Math.floor(S.w / 2), cr = S.y + Math.floor(S.h / 2);

  // ── WATER POOL: a body of water FRAMED BY A STONE-BRICK RIM, fountain on a centre pedestal, benches around.
  const PW = Math.max(5, Math.min(8, S.w - 10)), PH = Math.max(4, Math.min(6, S.h - 10));
  const px = cc - Math.floor(PW / 2), py = cr - Math.floor(PH / 2);
  carve(px - 1, py - 1, PW + 2, PH + 2, RIM, true);            // brick rim around the pool
  carve(px, py, PW, PH, 'water', false);                       // the pool — auto-tiles into water with edges
  carve(cc, cr, 1, 1, RIM, true);                              // a brick pedestal at the centre
  propOn('fountain', cc, cr);
  for (const [bx, by] of [[px - 3, cr], [px + PW + 2, cr], [cc, py - 3], [cc, py + PH + 2]] as const) prop('stone_bench', bx, by);

  // ── GREEN ISLANDS: a sparse lattice of planted patches (grass + tree + flowers) breaking up the paving.
  for (let gy = S.y + 3; gy < S.y + S.h - 3; gy += 7) for (let gx = S.x + 3; gx < S.x + S.w - 3; gx += 7) {
    if (gx >= px - 2 && gx <= px + PW + 1 && gy >= py - 2 && gy <= py + PH + 1) continue; // not over the pool
    carve(gx, gy, 2, 2, 'grass', true);
    prop('tree_oak', gx, gy); prop('flowers', gx + 1, gy + 1);
  }
  for (let k = 0; k < 4; k++) prop('market_stall', S.x + 3 + k * 2, S.y + S.h - 2); // market row

  // ── BUILDING BELTS — IRREGULAR compound silhouettes packed onto frontage; the gaps become alleys.
  const GRAND: BuildingType[] = ['manor', 'manor', 'cathedral', 'guildhall'];
  const TRADE: BuildingType[] = ['shop', 'general_store', 'tavern', 'curio', 'smithy', 'inn', 'workshop', 'library', 'shop', 'tavern'];
  const HOUSES: BuildingType[] = ['house', 'house', 'shop', 'tavern', 'curio', 'general_store', 'workshop'];
  const pick = (pool: BuildingType[]) => pool[Math.floor(rng() * pool.length)]!;
  // Pick an irregular shape that FITS the lot (else rect). Bias toward compound silhouettes — that's the point.
  const SHAPES: ShapeKind[] = ['compose', 'ell', 'tee', 'you', 'plus', 'ell', 'compose'];
  const chooseShape = (w: number, h: number): ShapeKind => {
    const fits = SHAPES.filter((s) => w >= SHAPE_MIN[s].w && h >= SHAPE_MIN[s].h);
    if (!fits.length || rng() < 0.15) return 'rect'; // a few plain rects for solidity/variety
    return fits[Math.floor(rng() * fits.length)]!;
  };

  /** Pack one belt: fixed-depth lots flush to `inner`, irregular shapes, with carved perpendicular alleys at the
   *  gaps. `depth` fixed so the lane behind the belt is clean; irregularity comes from the SHAPES, not jitter. */
  const packBelt = (inner: Rect, depth: number, poolFor: (side: string) => BuildingType[]) => {
    for (const side of ['north', 'south', 'west', 'east'] as const) {
      const horiz = side === 'north' || side === 'south';
      const aStart = horiz ? inner.x : inner.y, aEnd = horiz ? inner.x + inner.w : inner.y + inner.h;
      const room = side === 'north' ? inner.y - (R.y + 1) : side === 'south' ? (R.y + R.h - 1) - (inner.y + inner.h)
        : side === 'west' ? inner.x - (R.x + 1) : (R.x + R.w - 1) - (inner.x + inner.w);
      const d = Math.min(depth, room);
      if (d < 8) continue; // not enough room for a legible compound — leave this side as park
      let a = aStart;
      while (a < aEnd - 9) {
        let len = 12 + Math.floor(rng() * 6); if (a + len > aEnd) len = aEnd - a; if (len < 10) break; // remnant → park
        const lot: Rect = side === 'north' ? { x: a, y: inner.y - d, w: len, h: d }
          : side === 'south' ? { x: a, y: inner.y + inner.h, w: len, h: d }
          : side === 'west' ? { x: inner.x - d, y: a, w: d, h: len }
          : { x: inner.x + inner.w, y: a, w: d, h: len };
        const door = side === 'north' ? 'south' : side === 'south' ? 'north' : side === 'west' ? 'east' : 'west';
        compound(cv, lot, pick(poolFor(side)), { door, shape: chooseShape(lot.w, lot.h), locationId, id: `bldg:${loc}-${bi++}` });
        a += len;
        // An alley in the gap to the next building — a paved slit perpendicular to the frontage, square↔lane.
        const aw = 1 + (rng() < 0.45 ? 1 : 0);
        const ax = horiz ? a : (side === 'west' ? inner.x - d : inner.x + inner.w);
        const ay = side === 'north' ? inner.y - d : side === 'south' ? inner.y + inner.h : a;
        carve(ax, ay, horiz ? aw : d, horiz ? d : aw);
        a += aw;
      }
    }
  };

  const D1 = Math.min(14, Math.floor((Math.min(R.w, R.h) - Math.max(SW, SH)) / 2) - 4);
  const AW = 2;
  packBelt(S, D1, (side) => (side === 'north' ? GRAND : TRADE));                 // belt 1 — fronts the square
  carve(S.x - D1 - AW, S.y - D1 - AW, S.w + 2 * (D1 + AW), AW);                  // back lane — top
  carve(S.x - D1 - AW, S.y + S.h + D1, S.w + 2 * (D1 + AW), AW);                 // back lane — bottom
  carve(S.x - D1 - AW, S.y - D1 - AW, AW, S.h + 2 * (D1 + AW));                  // back lane — left
  carve(S.x + S.w + D1, S.y - D1 - AW, AW, S.h + 2 * (D1 + AW));                 // back lane — right
  const outer1: Rect = { x: S.x - D1 - AW, y: S.y - D1 - AW, w: S.w + 2 * (D1 + AW), h: S.h + 2 * (D1 + AW) };
  packBelt(outer1, 12, () => HOUSES);                                           // belt 2 — fronts the back lane

  // ── PARKS + LANDSCAPING: corners cluster into groves (trees + flowers + a bench); the open grass stays sparse.
  const onGrass = (c: number, r: number) => cv.tileAt(c, r) === 'grass';
  poissonScatter(cv, R, { tags: ['tree_oak', 'tree', 'tree_pine', 'bush'], r: 3, blocks: true, max: 44, filter: onGrass });
  clumpScatter(cv, R, { tags: ['flowers', 'flowers_blue', 'flowers_yellow', 'grass_tuft'], freq: 0.12, threshold: 0.56, seedOffset: 0x9e37, blocks: false, max: 90, filter: onGrass });
  for (const [cx, cy] of [[R.x + 4, R.y + 4], [R.x + R.w - 5, R.y + 4], [R.x + 4, R.y + R.h - 5], [R.x + R.w - 5, R.y + R.h - 5]] as const) {
    clumpScatter(cv, { x: cx - 4, y: cy - 4, w: 9, h: 9 }, { tags: ['tree_oak', 'tree', 'tree_pine'], freq: 0.4, threshold: 0.35, seedOffset: 0x2545 + cx, blocks: true, max: 14, filter: onGrass });
    prop('stone_bench', cx, cy);
  }
}
