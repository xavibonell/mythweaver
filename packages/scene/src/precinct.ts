/**
 * PRECINCT VAULT — the pattern layer for believable town COMPOSITION. Where townGen subdivides land and floats
 * one building per parcel (isolated boxes in grass moats), a precinct is a hand-DESIGNED "place": buildings are
 * PACKED onto street frontage around a composed centre, the way a real quarter reads. Each precinct is a small
 * coherent composition of primitives + the 21 furnished building types; the town/city generator will later stitch
 * precincts along an organic street skeleton. This file starts the vault with the CENTRAL SQUARE.
 *
 * The headline mechanism is FRONTAGE PACKING: a building sits flush to the square/street with its door opening
 * straight onto the cobbles, and its neighbours abut it — so the open space is WALLED by buildings (an outdoor
 * room), not dotted with them. Varied building depths + occasional alley gaps give the irregular, explorable
 * back-lanes; the region corners stay green as parks.
 */

import { Canvas, compound, fill, place, plaza, poissonScatter, clumpScatter, type Pt, type Rect } from './primitives.js';
import type { BuildingType } from '@mythweaver/shared';

const slug = (s: string) => (s || 'x').replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '') || 'x';
const rc = (r: Rect): Pt => ({ c: r.x + Math.floor(r.w / 2), r: r.y + Math.floor(r.h / 2) });

/**
 * CENTRAL SQUARE precinct — a big cobbled plaza (fountain + benches at the heart) PACKED around by grand manors
 * (the prestige north frontage) and popular shops, all facing IN; irregular alley gaps cut through the belt to
 * the outside; green parks in the corners. Everything paved is cobblestone. Deterministic from cv's seed.
 */
export function precinctSquare(cv: Canvas, region: Rect, locationId: string): void {
  const R = region;
  if (R.w < 24 || R.h < 22) { fill(cv, R, 'grass', true); return; } // too small to compose — just green it
  const rng = () => cv.rng();
  const loc = slug(locationId);
  const COBBLE = 'cobblestone';
  let pid = 0;
  const prop = (tag: string, c: number, r: number) => { if (cv.inB(c, r) && cv.isFree(c, r)) place(cv, { id: `prop:${loc}-p${pid++}`, tag, kind: 'prop', at: { c, r } }); };
  const carve = (x: number, y: number, w: number, h: number) => { if (w > 0 && h > 0) fill(cv, { x, y, w, h }, COBBLE, true); };

  fill(cv, R, 'grass', true);

  // 1) CENTRAL SQUARE — a big cobbled plaza, centred, leaving a margin for the building belt + corner parks.
  const SW = Math.max(12, Math.min(Math.floor(R.w * 0.42), R.w - 20));
  const SH = Math.max(10, Math.min(Math.floor(R.h * 0.42), R.h - 18));
  const S: Rect = { x: R.x + Math.floor((R.w - SW) / 2), y: R.y + Math.floor((R.h - SH) / 2), w: SW, h: SH };
  plaza(cv, S, COBBLE);
  const ctr = rc(S);
  prop('fountain', ctr.c, ctr.r);                                                        // the heart
  for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2], [-3, -3], [3, 3], [-3, 3], [3, -3]] as const) prop('stone_bench', ctr.c + dx, ctr.r + dy);
  prop('statue', S.x + 2, S.y + 2);                                                       // a corner monument
  for (let k = 0; k < 3; k++) prop('market_stall', S.x + S.w - 2, S.y + 2 + k * 2);       // a row of market stalls

  // 2) BUILDING BELT — frontage packed flush to the square, facing IN. North = the grand manor frontage; the
  // other three sides = popular shops & trades. Buildings ABUT (party walls); a gap every few = a back alley.
  const GRAND: BuildingType[] = ['manor', 'manor', 'cathedral', 'guildhall'];
  const TRADE: BuildingType[] = ['shop', 'general_store', 'tavern', 'curio', 'smithy', 'inn', 'workshop', 'library', 'shop', 'tavern'];
  let bi = 0;
  const gaps: { side: 'north' | 'south' | 'east' | 'west'; a0: number }[] = [];
  const pack = (side: 'north' | 'south' | 'east' | 'west') => {
    const horiz = side === 'north' || side === 'south';
    const aEnd = horiz ? S.x + S.w : S.y + S.h;
    const pool = side === 'north' ? GRAND : TRADE;
    const maxDepth = side === 'north' ? S.y - (R.y + 1) : side === 'south' ? (R.y + R.h - 1) - (S.y + S.h) : side === 'west' ? S.x - (R.x + 1) : (R.x + R.w - 1) - (S.x + S.w);
    let a = horiz ? S.x : S.y, since = 0;
    while (a < aEnd - 3) {
      let len = 4 + Math.floor(rng() * 4);                                 // extent ALONG the square edge
      if (a + len > aEnd) len = aEnd - a;                                  // clamp the last lot to FILL the edge (continuous frontage, no end-gap)
      if (len < 4) break;
      const depth = Math.min(maxDepth, (side === 'north' ? 6 : 5) + Math.floor(rng() * 3)); // depth AWAY from the square (manors deeper), clamped to the region
      if (depth < 4) { a += len; continue; }
      const fp: Rect = side === 'north' ? { x: a, y: S.y - depth, w: len, h: depth }
        : side === 'south' ? { x: a, y: S.y + S.h, w: len, h: depth }
        : side === 'west' ? { x: S.x - depth, y: a, w: depth, h: len }
        : { x: S.x + S.w, y: a, w: depth, h: len };
      const door = side === 'north' ? 'south' : side === 'south' ? 'north' : side === 'west' ? 'east' : 'west';
      compound(cv, fp, pool[Math.floor(rng() * pool.length)]!, { door, locationId, id: `bldg:${loc}-${bi++}` });
      a += len; since++;
      if (since >= 3 && rng() < 0.35) { gaps.push({ side, a0: a }); a += 1; since = 0; }  // a rare 1-wide alley gap (continuous frontage otherwise)
    }
  };
  pack('north'); pack('south'); pack('west'); pack('east');

  // 3) BACK ALLEYS — carve a 2-wide cobbled lane through each gap, from the square out to the region edge, so the
  // belt is threaded by irregular lanes that connect the square to the wider map and invite exploration.
  for (const g of gaps) {
    if (g.side === 'north') carve(g.a0 - 1, R.y + 1, 1, S.y - R.y - 1);
    else if (g.side === 'south') carve(g.a0 - 1, S.y + S.h, 1, R.y + R.h - 1 - (S.y + S.h));
    else if (g.side === 'west') carve(R.x + 1, g.a0 - 1, S.x - R.x - 1, 1);
    else carve(S.x + S.w, g.a0 - 1, R.x + R.w - 1 - (S.x + S.w), 1);
  }

  // 4) PARKS + LANDSCAPING — the corners (and the irregular nooks behind shallow buildings) stay green: trees +
  // flower beds + a corner bench. Trees/flowers only land on grass, so the cobbles + frontage stay clear.
  const onGrass = (c: number, r: number) => cv.tileAt(c, r) === 'grass';
  poissonScatter(cv, R, { tags: ['tree_oak', 'tree_oak', 'tree', 'tree_pine', 'tree_dark', 'bush'], r: 2, blocks: true, max: 70, filter: onGrass });
  clumpScatter(cv, R, { tags: ['flowers', 'flowers_blue', 'flowers_yellow', 'flowers_red', 'grass_tuft', 'mushroom'], freq: 0.16, threshold: 0.48, seedOffset: 0x9e37, blocks: false, max: 140, filter: onGrass });
  for (const [cx, cy] of [[R.x + 3, R.y + 3], [R.x + R.w - 4, R.y + 3], [R.x + 3, R.y + R.h - 4], [R.x + R.w - 4, R.y + R.h - 4]] as const) prop('stone_bench', cx, cy);
}
