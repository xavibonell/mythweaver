/**
 * PRECINCT VAULT — the pattern layer for believable town COMPOSITION. Where townGen subdivides land and floats
 * one building per parcel (isolated boxes in grass moats), a precinct is a hand-DESIGNED "place": buildings are
 * PACKED onto street frontage around a composed centre. Each precinct is a small coherent composition of
 * primitives + the 21 furnished building types; the town/city generator will later stitch precincts along an
 * organic street skeleton. This file starts the vault with the CENTRAL SQUARE.
 *
 * Paving is `stone` — the grey fitted-brick floor (the same asset stone buildings use), which reads as a paved
 * street/plaza. (The tag literally named `cobblestone` is a tan/sandy sprite that reads as dirt, so we don't use
 * it for paths.) The headline mechanism is FRONTAGE PACKING: buildings sit flush to the square/lane with their
 * door on the paving and abut their neighbours, so open space is WALLED by buildings (an outdoor room), not
 * dotted with them.
 */

import { Canvas, compound, fill, place, plaza, poissonScatter, clumpScatter, type Rect } from './primitives.js';
import type { BuildingType } from '@mythweaver/shared';

const slug = (s: string) => (s || 'x').replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '') || 'x';

/**
 * CENTRAL SQUARE precinct — a paved plaza with a WATER POOL at its heart (a body of water framed by the paving,
 * a fountain on a centre pedestal, benches around), broken up by a regular lattice of small green islands
 * (tree + flowers) and a row of market stalls. Around it: a frontage belt of grand manors (north) + popular
 * shops facing IN; behind that a paved BACK LANE; then a second belt of shops/houses facing the lane. Green
 * parks fill the corners. Deterministic from cv's seed.
 */
export function precinctSquare(cv: Canvas, region: Rect, locationId: string): void {
  const R = region;
  if (R.w < 30 || R.h < 26) { fill(cv, R, 'grass', true); return; } // too small to compose — just green it
  const rng = () => cv.rng();
  const loc = slug(locationId);
  const PAVE = 'stone'; // grey fitted brick = the paved-street look (NOT the tan 'cobblestone' sprite)
  let pid = 0, bi = 0;
  const prop = (tag: string, c: number, r: number) => { if (cv.inB(c, r) && cv.isFree(c, r)) place(cv, { id: `prop:${loc}-p${pid++}`, tag, kind: 'prop', at: { c, r } }); };
  const propOn = (tag: string, c: number, r: number) => { if (cv.inB(c, r)) place(cv, { id: `prop:${loc}-p${pid++}`, tag, kind: 'prop', at: { c, r } }); }; // place even on non-walkable (the fountain pedestal)
  const carve = (x: number, y: number, w: number, h: number, tag = PAVE, walk = true) => { if (w > 0 && h > 0) fill(cv, { x, y, w, h }, tag, walk); };

  fill(cv, R, 'grass', true);

  // ── CENTRAL SQUARE (paved), sized to leave room for two building rings + corner parks.
  const SW = Math.max(16, Math.min(Math.floor(R.w * 0.36), R.w - 28));
  const SH = Math.max(14, Math.min(Math.floor(R.h * 0.36), R.h - 24));
  const S: Rect = { x: R.x + Math.floor((R.w - SW) / 2), y: R.y + Math.floor((R.h - SH) / 2), w: SW, h: SH };
  plaza(cv, S, PAVE);
  const cc = S.x + Math.floor(S.w / 2), cr = S.y + Math.floor(S.h / 2);

  // ── WATER POOL at the heart: a framed body of water with a fountain on a centre pedestal + benches around.
  const PW = Math.max(4, Math.min(6, S.w - 10)), PH = Math.max(3, Math.min(5, S.h - 10));
  const px = cc - Math.floor(PW / 2), py = cr - Math.floor(PH / 2);
  carve(px, py, PW, PH, 'water', false);                       // the pool — auto-tiles into water with edges
  carve(cc, cr, 1, 1, PAVE, true);                             // a stone pedestal at the centre
  propOn('fountain', cc, cr);                                   // the fountain rises from the pedestal
  for (const [bx, by] of [[px - 2, cr], [px + PW + 1, cr], [cc, py - 2], [cc, py + PH + 1]] as const) prop('stone_bench', bx, by);

  // ── GREEN ISLANDS: a regular lattice of small planted patches (grass + tree + flowers) breaking up the paving.
  for (let gy = S.y + 2; gy < S.y + S.h - 3; gy += 6) for (let gx = S.x + 2; gx < S.x + S.w - 3; gx += 6) {
    if (gx >= px - 2 && gx <= px + PW + 1 && gy >= py - 2 && gy <= py + PH + 1) continue; // not over the pool
    carve(gx, gy, 2, 2, 'grass', true);
    prop('tree_oak', gx, gy); prop('flowers', gx + 1, gy + 1);
  }
  // ── MARKET STALLS along the square's lower edge.
  for (let k = 0; k < 4; k++) prop('market_stall', S.x + 2 + k * 2, S.y + S.h - 2);

  // ── BUILDING BELTS. Belt 1 fronts the square; a paved BACK LANE rings it; belt 2 fronts the lane (more
  // buildings behind the first line, with a street between). Belt 1 is a fixed depth for a clean lane behind it.
  const GRAND: BuildingType[] = ['manor', 'manor', 'cathedral', 'guildhall'];
  const TRADE: BuildingType[] = ['shop', 'general_store', 'tavern', 'curio', 'smithy', 'inn', 'workshop', 'library', 'shop', 'tavern'];
  const HOUSES: BuildingType[] = ['house', 'house', 'shop', 'tavern', 'curio', 'general_store', 'workshop'];
  const pick = (pool: BuildingType[]) => pool[Math.floor(rng() * pool.length)]!;
  const D1 = 6, AW = 2;
  const packRing = (inner: Rect, dlo: number, dhi: number, poolFor: (side: string) => BuildingType[]) => {
    for (const side of ['north', 'south', 'west', 'east'] as const) {
      const horiz = side === 'north' || side === 'south';
      const aEnd = horiz ? inner.x + inner.w : inner.y + inner.h;
      const maxD = side === 'north' ? inner.y - (R.y + 1) : side === 'south' ? (R.y + R.h - 1) - (inner.y + inner.h) : side === 'west' ? inner.x - (R.x + 1) : (R.x + R.w - 1) - (inner.x + inner.w);
      if (maxD < 4) continue;
      let a = horiz ? inner.x : inner.y, since = 0;
      while (a < aEnd - 3) {
        let len = 4 + Math.floor(rng() * 4); if (a + len > aEnd) len = aEnd - a; if (len < 4) break;
        const depth = Math.min(maxD, dlo + Math.floor(rng() * (dhi - dlo + 1)));
        if (depth < 4) { a += len; continue; }
        const fp: Rect = side === 'north' ? { x: a, y: inner.y - depth, w: len, h: depth }
          : side === 'south' ? { x: a, y: inner.y + inner.h, w: len, h: depth }
          : side === 'west' ? { x: inner.x - depth, y: a, w: depth, h: len }
          : { x: inner.x + inner.w, y: a, w: depth, h: len };
        const door = side === 'north' ? 'south' : side === 'south' ? 'north' : side === 'west' ? 'east' : 'west';
        compound(cv, fp, pick(poolFor(side)), { door, locationId, id: `bldg:${loc}-${bi++}` });
        a += len; since++;
        if (since >= 3 && rng() < 0.4) { a += 1; since = 0; } // a rare 1-wide alley gap in the frontage
      }
    }
  };
  packRing(S, D1, D1, (side) => (side === 'north' ? GRAND : TRADE));                 // belt 1 — fronts the square
  carve(S.x - D1 - AW, S.y - D1 - AW, S.w + 2 * (D1 + AW), AW);                       // back lane — top
  carve(S.x - D1 - AW, S.y + S.h + D1, S.w + 2 * (D1 + AW), AW);                      // back lane — bottom
  carve(S.x - D1 - AW, S.y - D1 - AW, AW, S.h + 2 * (D1 + AW));                       // back lane — left
  carve(S.x + S.w + D1, S.y - D1 - AW, AW, S.h + 2 * (D1 + AW));                      // back lane — right
  const outer1: Rect = { x: S.x - D1 - AW, y: S.y - D1 - AW, w: S.w + 2 * (D1 + AW), h: S.h + 2 * (D1 + AW) };
  packRing(outer1, 5, 6, () => HOUSES);                                              // belt 2 — fronts the back lane

  // ── PARKS + LANDSCAPING: the corners + nooks stay green (trees + flower beds + a corner bench).
  const onGrass = (c: number, r: number) => cv.tileAt(c, r) === 'grass';
  poissonScatter(cv, R, { tags: ['tree_oak', 'tree_oak', 'tree', 'tree_pine', 'tree_dark', 'bush'], r: 2, blocks: true, max: 90, filter: onGrass });
  clumpScatter(cv, R, { tags: ['flowers', 'flowers_blue', 'flowers_yellow', 'flowers_red', 'grass_tuft', 'mushroom'], freq: 0.16, threshold: 0.48, seedOffset: 0x9e37, blocks: false, max: 160, filter: onGrass });
  for (const [cx, cy] of [[R.x + 3, R.y + 3], [R.x + R.w - 4, R.y + 3], [R.x + 3, R.y + R.h - 4], [R.x + R.w - 4, R.y + R.h - 4]] as const) prop('stone_bench', cx, cy);
}
