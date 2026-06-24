/**
 * BLOCK VAULT — hand-authored town COMPOSITIONS (picks-not-paints at the town scale).
 *
 * The procedural precinct generator nailed structure but plateaued at a generic look: it PAINTS (scatters
 * buildings on a grid, sprinkles trees). This is the lever that took building INTERIORS to 9/10 instead — a
 * small set of complete, HAND-TUNED compositions. A "block" is one finished unit (a building + its yard +
 * entry path + planting + street life), composed to read like the reference. A precinct STITCHES blocks along
 * a street; each block is reference-quality by construction, so the whole town is.
 *
 * Each block fills `region` and fronts a street it carves on its SOUTH edge (the stitcher aligns these into a
 * continuous road). Deterministic from cv's seed.
 */

import { Canvas, compound, fill, place, type Rect } from './primitives.js';
import { wallTagFor } from './cartographer.js';
import { SHAPE_MIN, type ShapeKind } from './footprint.js';
import type { BuildingType } from '@mythweaver/shared';

const slug = (s: string) => (s || 'x').replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '') || 'x';
const TREES = ['tree_oak', 'tree', 'tree_pine', 'tree_dark', 'tree_autumn'] as const;
const FLOWERS = ['flowers', 'flowers_blue', 'flowers_yellow', 'flowers_red'] as const;
const SHAPES: ShapeKind[] = ['compose', 'ell', 'tee', 'you', 'rect', 'ell', 'compose'];
const pickShape = (rng: () => number, w: number, h: number): ShapeKind => {
  const fits = SHAPES.filter((s) => w >= SHAPE_MIN[s].w && h >= SHAPE_MIN[s].h);
  return fits.length ? fits[Math.floor(rng() * fits.length)]! : 'rect';
};

/** A residential block: a cottage set back in green, a fenced flower garden, a dirt path to the street, a wooded
 *  backdrop, and a little life (a gardener, a hen). `type` lets the same composition host any house-like building. */
export function blockCottage(cv: Canvas, region: Rect, locationId: string, type: BuildingType = 'house'): void {
  const R = region;
  const rng = () => cv.rng();
  const loc = slug(locationId);
  let pid = 0;
  const prop = (tag: string, c: number, r: number) => { if (cv.inB(c, r) && cv.isFree(c, r)) place(cv, { id: `prop:${loc}-p${pid++}`, tag, kind: 'prop', at: { c, r } }); };
  const actor = (tag: string, c: number, r: number) => { if (cv.inB(c, r) && cv.isFree(c, r)) place(cv, { id: `npc:${loc}-${pid++}`, tag, kind: 'actor', role: 'npc', at: { c, r } }); };
  const carve = (x: number, y: number, w: number, h: number, tag: string, walk = true) => { if (w > 0 && h > 0) fill(cv, { x, y, w, h }, tag, walk); };
  const isGrass = (c: number, r: number) => cv.inB(c, r) && cv.tileAt(c, r) === 'grass';
  const clump = (cx: number, cy: number, rad: number) => { for (let r = cy - rad; r <= cy + rad; r++) for (let c = cx - rad; c <= cx + rad; c++) if (isGrass(c, r) && Math.hypot(c - cx, r - cy) <= rad - 0.2) prop(TREES[Math.floor(rng() * TREES.length)]!, c, r); };

  fill(cv, R, 'grass', true);

  // STREET along the south edge (the stitcher aligns these into one road) + a broken earthen rim.
  const roadY = R.y + R.h - 2;
  carve(R.x, roadY, R.w, 2, 'road', true);
  for (let c = R.x; c < R.x + R.w; c++) if (isGrass(c, roadY - 1) && rng() < 0.7) carve(c, roadY - 1, 1, 1, 'dirt', true);

  // COTTAGE: set back, upper-centre, door to the street. Size + silhouette VARY per block (a manor fills its plot,
  // a cottage leaves a big garden) so a street of blocks reads varied, not a grid of clones.
  const scale = 0.55 + rng() * 0.45;
  const hw = Math.max(6, Math.min(Math.round((R.w - 3) * scale), R.w - 3));
  const hh = Math.max(5, Math.min(Math.round((R.h - 6) * scale), R.h - 6));
  const hx = R.x + Math.floor((R.w - hw) / 2), hy = R.y + 2;
  compound(cv, { x: hx, y: hy, w: hw, h: hh }, type, { door: 'south', shape: pickShape(rng, hw, hh), locationId, id: `bldg:${loc}-0` });
  const doorC = hx + Math.floor(hw / 2);

  // ENTRY PATH: a 2-wide dirt walkway from the door down to the street.
  for (let r = hy + hh; r < roadY; r++) for (const pc of [doorC - 1, doorC]) { const t = cv.tileAt(pc, r); if (t === 'grass' || t === 'dirt') carve(pc, r, 1, 1, 'dirt', true); }

  // FRONT GARDEN (left of the path): a fenced flower plot with a tree + a gardener.
  const gx = R.x + 1, gy = hy + hh + 1, gw = doorC - 2 - (R.x + 1), gh = roadY - 1 - gy;
  if (gw >= 3 && gh >= 3) {
    for (let r = gy; r < gy + gh; r++) { prop('fence', gx, r); prop('fence', gx + gw - 1, r); }
    for (let c = gx; c < gx + gw; c++) prop('fence', c, gy + gh - 1);
    for (let r = gy + 1; r < gy + gh - 1; r++) for (let c = gx + 1; c < gx + gw - 1; c++) if (isGrass(c, r) && rng() < 0.55) prop(FLOWERS[Math.floor(rng() * FLOWERS.length)]!, c, r);
    prop('tree_oak', gx + 1, gy + 1);
    actor('villager_woman', gx + gw - 2, gy + 1);
  }
  // RIGHT of the path: homestead props + a roadside bench + a signpost.
  prop('barrel', doorC + 2, hy + hh + 1);
  prop('stone_bench', doorC + 2, roadY - 2);
  prop('signpost', doorC + 2, roadY - 1);

  // BACKYARD: a wooded backdrop (solid tree clumps) wrapping the house + a hen and a dog for life.
  clump(R.x + 2, R.y + 2, 2); clump(R.x + R.w - 3, R.y + 2, 2); clump(R.x + R.w - 3, R.y + Math.floor(R.h / 2) + 1, 2);
  actor('chicken', doorC + 3, hy + hh + 2);
  actor('dog', gx + 1, gy + gh);

  // Safety: drop any keeper compound seated on a wall, so the scene validates.
  for (let i = cv.objects.length - 1; i >= 0; i--) { const o = cv.objects[i]!; if (o.kind === 'actor' && !(cv.inB(o.col, o.row) && cv.walkable[o.row]![o.col])) cv.objects.splice(i, 1); }
}

/** The civic-centre block: an open cobbled plaza with the walled WATER BASIN, benches, a market row, trees + life. */
export function blockPlaza(cv: Canvas, region: Rect, locationId: string): void {
  const R = region;
  const rng = () => cv.rng();
  const loc = slug(locationId);
  let pid = 0;
  const prop = (tag: string, c: number, r: number) => { if (cv.inB(c, r) && cv.isFree(c, r)) place(cv, { id: `prop:${loc}-p${pid++}`, tag, kind: 'prop', at: { c, r } }); };
  const propOn = (tag: string, c: number, r: number) => { if (cv.inB(c, r)) place(cv, { id: `prop:${loc}-p${pid++}`, tag, kind: 'prop', at: { c, r } }); };
  const actor = (tag: string, c: number, r: number) => { if (cv.inB(c, r) && cv.isFree(c, r)) place(cv, { id: `npc:${loc}-${pid++}`, tag, kind: 'actor', role: 'npc', at: { c, r } }); };
  const carve = (x: number, y: number, w: number, h: number, tag: string, walk = true) => { if (w > 0 && h > 0) fill(cv, { x, y, w, h }, tag, walk); };
  fill(cv, R, 'grass', true);
  carve(R.x + 1, R.y + 1, R.w - 2, R.h - 2, 'road', true);                                   // the paved square
  const cc = R.x + Math.floor(R.w / 2), cr = R.y + Math.floor(R.h / 2);
  const BW = Math.min(12, R.w - 6), BH = Math.min(8, R.h - 6);
  const bx = cc - Math.floor(BW / 2), by = cr - Math.floor(BH / 2);
  carve(bx, by, BW, BH, 'water', false);                                                      // the basin, filled
  for (let c = bx; c < bx + BW; c++) { cv.set(c, by, wallTagFor(true, false, c === bx, c === bx + BW - 1, 'stone'), false); cv.set(c, by + BH - 1, wallTagFor(false, true, c === bx, c === bx + BW - 1, 'stone'), false); }
  for (let r = by; r < by + BH; r++) { cv.set(bx, r, wallTagFor(r === by, r === by + BH - 1, true, false, 'stone'), false); cv.set(bx + BW - 1, r, wallTagFor(r === by, r === by + BH - 1, false, true, 'stone'), false); }
  carve(cc - 1, cr - 1, 3, 2, 'stone_brick', false);                                          // pedestal
  propOn('fountain', cc, cr);
  for (let c = bx; c < bx + BW; c += 3) { prop('stone_bench', c, by - 2); prop('stone_bench', c, by + BH + 1); }
  for (let k = 0; k < 3; k++) prop('market_stall', bx - 2, by + 1 + k);
  for (const [tx, ty] of [[R.x + 2, R.y + 2], [R.x + R.w - 3, R.y + 2], [R.x + 2, R.y + R.h - 3], [R.x + R.w - 3, R.y + R.h - 3]] as const) prop('tree_oak', tx, ty);
  actor('villager', cc - 2, by + BH + 2); actor('villager_woman', cc + 2, by - 3);
}

const BLOCK_TYPES: BuildingType[] = ['house', 'house', 'shop', 'tavern', 'curio', 'general_store', 'workshop', 'smithy', 'manor', 'library', 'inn', 'house'];

/** A NEIGHBOURHOOD: stitch hand-authored blocks into a grid with a shared cobbled road network — each block is
 *  reference-quality by construction, so the assembled town inherits it. The proof that the block vault scales. */
export function blockTown(cv: Canvas, region: Rect, locationId: string): void {
  const R = region;
  const loc = slug(locationId);
  fill(cv, R, 'grass', true);
  const BW = 21, BH = 18; // a block plot (incl. its own south street) + a 2-wide vertical street between columns
  const cols = Math.max(1, Math.floor((R.w - 1) / BW)), rows = Math.max(1, Math.floor((R.h - 1) / BH));
  const midx = Math.floor(cols / 2), midy = Math.floor(rows / 2);
  let i = 0;
  for (let gy = 0; gy < rows; gy++) for (let gx = 0; gx < cols; gx++) {
    const x = R.x + gx * BW, y = R.y + gy * BH, plot: Rect = { x, y, w: BW - 2, h: BH };
    // pass a VALID "loc:<slug>" id through (building entrances copy it; a bare slug fails validation)
    const id = `loc:${loc}-${gx}-${gy}`;
    if (gx === midx && gy === midy) blockPlaza(cv, plot, `loc:${loc}-plaza`);             // civic centre
    else blockCottage(cv, plot, id, BLOCK_TYPES[i++ % BLOCK_TYPES.length]!);
  }
  // VERTICAL streets in the 2-wide gaps between block columns (the blocks' south edges give the horizontal streets).
  for (let gx = 1; gx < cols; gx++) fill(cv, { x: R.x + gx * BW - 2, y: R.y, w: 2, h: rows * BH }, 'road', true);
}
