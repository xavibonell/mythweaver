/**
 * PRECINCT VAULT — the pattern layer for believable town COMPOSITION.
 *
 * v7 — GRASS-BASE + COBBLED ROADS (the reference model). The world is GRASS; a homogeneous grey cobbled `road`
 * network is laid ON TOP, with an EARTHEN (dirt) rim where stone meets grass (the transition that sells it). The
 * roads frame a central PLAZA holding a sunken WATER BASIN (water with a dark rim shadow + a stone-brick lip — a
 * filled hole, not a flat blob; no fountain icon). Large IRREGULAR compound buildings (L/T/U/cross/compose) are
 * packed into the grass blocks FRONTING the roads; trees, fenced gardens and flower beds landscape the grass
 * between them, and the town fades into wooded countryside at the edges.
 *
 * `road` is a single clean tile (DawnLike `stone` has blue-tinted accent variants that scatter as visual noise —
 * we never use `stone`/`stone_brick` for open paving except the basin lip).
 */

import { Canvas, compound, fill, place, type Rect } from './primitives.js';
import { SHAPE_MIN, type ShapeKind } from './footprint.js';
import type { BuildingType } from '@mythweaver/shared';

const slug = (s: string) => (s || 'x').replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '') || 'x';

export function precinctSquare(cv: Canvas, region: Rect, locationId: string): void {
  const R = region;
  if (R.w < 44 || R.h < 40) { fill(cv, R, 'grass', true); return; }
  const rng = () => cv.rng();
  const loc = slug(locationId);
  const PAVE = 'road';       // homogeneous grey cobble (single tile)
  const RIM = 'stone_brick'; // the basin lip
  const DIRT = 'dirt';
  let pid = 0, bi = 0;
  const prop = (tag: string, c: number, r: number) => { if (cv.inB(c, r) && cv.isFree(c, r)) place(cv, { id: `prop:${loc}-p${pid++}`, tag, kind: 'prop', at: { c, r } }); };
  const carve = (x: number, y: number, w: number, h: number, tag: string, walk = true) => { if (w > 0 && h > 0) fill(cv, { x, y, w, h }, tag, walk); };
  const isGrass = (c: number, r: number) => cv.inB(c, r) && cv.tileAt(c, r) === 'grass';
  const isRoad = (c: number, r: number) => cv.inB(c, r) && cv.tileAt(c, r) === PAVE;

  fill(cv, R, 'grass', true);

  // ── COBBLED ROAD GRID (straight, homogeneous) laid on the grass. Two verticals + two horizontals (jittered,
  //    uneven spacing) bound a central plaza block; all four run off-frame like real streets.
  const jit = () => Math.floor((rng() - 0.5) * 5);
  const RW = 2; // thinner roads — the reference is a GRASS world with cobble laid on top, not a stone slab
  const vx1 = R.x + Math.floor(R.w * 0.30) + jit(), vx2 = R.x + Math.floor(R.w * 0.64) + jit();
  const hy1 = R.y + Math.floor(R.h * 0.30) + jit(), hy2 = R.y + Math.floor(R.h * 0.64) + jit();
  carve(vx1, R.y, RW, R.h, PAVE); carve(vx2, R.y, RW, R.h, PAVE);
  carve(R.x, hy1, R.w, RW, PAVE); carve(R.x, hy2, R.w, RW, PAVE);

  // ── PLAZA: the central block, with a sunken water basin (no fountain icon).
  const Pl: Rect = { x: vx1 + RW, y: hy1 + RW, w: vx2 - (vx1 + RW), h: hy2 - (hy1 + RW) };
  carve(Pl.x, Pl.y, Pl.w, Pl.h, PAVE);
  const cc = Pl.x + Math.floor(Pl.w / 2), cr = Pl.y + Math.floor(Pl.h / 2);
  const PW = Math.max(10, Math.min(14, Pl.w - 6)), PH = Math.max(7, Math.min(10, Pl.h - 6));
  const px = cc - Math.floor(PW / 2), py = cr - Math.floor(PH / 2);
  carve(px - 2, py - 2, PW + 4, PH + 4, RIM);   // a 2-cell brick lip frames the basin
  carve(px, py, PW, PH, 'water', false);         // the basin — deep water + dark rim shadow reads as a filled hole
  for (const [tx, ty] of [[Pl.x + 1, Pl.y + 1], [Pl.x + Pl.w - 2, Pl.y + 1], [Pl.x + 1, Pl.y + Pl.h - 2], [Pl.x + Pl.w - 2, Pl.y + Pl.h - 2]] as const) prop('tree_oak', tx, ty); // corner trees
  for (let c = px; c < px + PW; c += 3) { prop('stone_bench', c, py - 3); prop('stone_bench', c, py + PH + 2); } // benches face the basin
  for (let k = 0; k < 4; k++) prop('market_stall', px - 3, py + k); // a tidy market-stall row just west of the basin

  // ── BUILDINGS: large irregular compounds packed into the grass blocks, FRONTING the roads.
  const GRAND: BuildingType[] = ['manor', 'manor', 'cathedral', 'guildhall'];
  const TRADE: BuildingType[] = ['shop', 'general_store', 'tavern', 'curio', 'smithy', 'inn', 'workshop', 'library', 'shop', 'tavern'];
  const HOUSES: BuildingType[] = ['house', 'house', 'house', 'shop', 'tavern', 'curio', 'general_store'];
  const pick = (pool: BuildingType[]) => pool[Math.floor(rng() * pool.length)]!;
  const SHAPES: ShapeKind[] = ['compose', 'ell', 'tee', 'you', 'plus', 'ell', 'compose', 'tee'];
  const chooseShape = (w: number, h: number): ShapeKind => {
    const fits = SHAPES.filter((s) => w >= SHAPE_MIN[s].w && h >= SHAPE_MIN[s].h);
    if (!fits.length || rng() < 0.08) return 'rect';
    return fits[Math.floor(rng() * fits.length)]!;
  };
  const lotGrass = (lot: Rect) => {
    if (lot.x < R.x + 1 || lot.y < R.y + 1 || lot.x + lot.w > R.x + R.w - 1 || lot.y + lot.h > R.y + R.h - 1) return false;
    for (let r = lot.y; r < lot.y + lot.h; r++) for (let c = lot.x; c < lot.x + lot.w; c++) if (!isGrass(c, r)) return false;
    return true;
  };
  const frontRoad = (lot: Rect): 'north' | 'south' | 'east' | 'west' | null => {
    let n = 0, s = 0, e = 0, w = 0;
    for (let c = lot.x; c < lot.x + lot.w; c++) { if (isRoad(c, lot.y - 1)) n++; if (isRoad(c, lot.y + lot.h)) s++; }
    for (let r = lot.y; r < lot.y + lot.h; r++) { if (isRoad(lot.x - 1, r)) w++; if (isRoad(lot.x + lot.w, r)) e++; }
    const best = Math.max(n, s, e, w); if (best === 0) return null;
    return n === best ? 'north' : s === best ? 'south' : e === best ? 'east' : 'west';
  };
  const nearPlaza = Math.max(R.w, R.h) * 0.30;
  const typeFor = (dist: number, dim: number): BuildingType => {
    if (dist < nearPlaza) return dim >= 12 ? pick(GRAND) : pick(TRADE);
    return dim >= 11 ? pick(TRADE) : pick(HOUSES);
  };
  const CAP = Math.round((R.w * R.h) / 320); // ~19 large buildings on an 82×74 precinct → grass-dominant but with real frontage
  const packPass = (lo: number, hi: number) => {
    for (let r = R.y + 1; r < R.y + R.h - 1; r += 2) for (let c = R.x + 1; c < R.x + R.w - 1; c += 2) { // step 2 → roomier, more grass for landscaping
      if (bi >= CAP) return;
      if (!isGrass(c, r)) continue;
      const w = lo + Math.floor(rng() * (hi - lo + 1)), h = lo + Math.floor(rng() * (hi - lo + 1));
      const lot: Rect = { x: c, y: r, w, h };
      if (!lotGrass(lot)) continue;
      const door = frontRoad(lot); if (!door) continue; // must address a road — no isolated boxes in grass moats
      const dist = Math.hypot(c + w / 2 - cc, r + h / 2 - cr);
      compound(cv, lot, typeFor(dist, Math.max(w, h)), { door, shape: chooseShape(w, h), locationId, id: `bldg:${loc}-${bi++}` });
    }
  };
  for (const [lo, hi] of [[15, 19], [11, 15], [9, 11]] as const) packPass(lo, hi); // only LARGE buildings (capped) → spaced on grass like the reference, not packed

  // ── DIRT RIM: a BROKEN earthen border where open cobble meets grass (the reference's thin "stone on soil"
  //    transition — sparse, not a solid orange apron).
  const rim: [number, number][] = [];
  for (let r = R.y; r < R.y + R.h; r++) for (let c = R.x; c < R.x + R.w; c++) {
    if (cv.tileAt(c, r) !== 'grass') continue;
    if (isRoad(c - 1, r) || isRoad(c + 1, r) || isRoad(c, r - 1) || isRoad(c, r + 1)) rim.push([c, r]);
  }
  for (const [c, r] of rim) if (rng() < 0.6) carve(c, r, 1, 1, DIRT, true);

  // ── LANDSCAPE the grass: fenced garden parks fronting the roads + tree groves; the edges go wooded countryside.
  const gardens: Rect[] = [];
  for (let g = 0; g < 9; g++) { // more fenced garden parks — the most clearly "deliberate" greenery
    const sz = rng() < 0.5 ? 7 : 5;
    let gx = 0, gy = 0, ok = false;
    for (let t = 0; t < 40 && !ok; t++) {
      gx = R.x + 2 + Math.floor(rng() * (R.w - sz - 4)); gy = R.y + 2 + Math.floor(rng() * (R.h - sz - 4));
      ok = true;
      for (let r = gy - 1; r <= gy + sz && ok; r++) for (let c = gx - 1; c <= gx + sz; c++) if (!isGrass(c, r)) { ok = false; break; }
      if (ok) { ok = false; for (let c = gx; c < gx + sz; c++) if (isRoad(c, gy - 1) || isRoad(c, gy + sz)) ok = true; for (let r = gy; r < gy + sz; r++) if (isRoad(gx - 1, r) || isRoad(gx + sz, r)) ok = true; } // must front a road
    }
    if (ok) gardens.push({ x: gx, y: gy, w: sz, h: sz });
  }
  for (const gd of gardens) {
    const gap = gd.x + 1 + Math.floor(rng() * (gd.w - 2));
    for (let r = gd.y; r < gd.y + gd.h; r++) for (let c = gd.x; c < gd.x + gd.w; c++) {
      if (!isGrass(c, r)) continue;
      const edge = r === gd.y || r === gd.y + gd.h - 1 || c === gd.x || c === gd.x + gd.w - 1;
      if (edge) { if (!(r === gd.y + gd.h - 1 && c === gap)) prop('fence', c, r); }
      else if (rng() < 0.78) prop((['tree_oak', 'tree', 'tree_pine'] as const)[Math.floor(rng() * 3)]!, c, r);
      else prop((['flowers', 'flowers_blue', 'bush'] as const)[Math.floor(rng() * 3)]!, c, r);
    }
    prop('statue', gd.x + Math.floor(gd.w / 2), gd.y + Math.floor(gd.h / 2));
  }
  // TREE GROVES: a few SOLID tree masses (trees only — flowers read as speckle) in open grass, leaving bare grass
  // between them. Seeded only where a full grass disc fits, so a grove is a clear clump, never a sprinkle.
  for (let g = 0; g < 9; g++) {
    const rad = 3 + Math.floor(rng() * 3);
    let gx = 0, gy = 0, ok = false;
    for (let t = 0; t < 50 && !ok; t++) {
      gx = R.x + rad + Math.floor(rng() * (R.w - 2 * rad)); gy = R.y + rad + Math.floor(rng() * (R.h - 2 * rad));
      let g2 = 0;
      for (let r = gy - rad; r <= gy + rad; r++) for (let c = gx - rad; c <= gx + rad; c++) if (isGrass(c, r)) g2++;
      ok = g2 > rad * rad * 2.6;
    }
    if (!ok) continue;
    for (let r = gy - rad; r <= gy + rad; r++) for (let c = gx - rad; c <= gx + rad; c++) {
      if (!isGrass(c, r)) continue;
      if (rng() < 1.0 - Math.hypot(c - gx, r - gy) * 0.13) prop((['tree_oak', 'tree', 'tree_pine', 'tree_dark'] as const)[Math.floor(rng() * 4)]!, c, r);
    }
  }

  // Safety net: drop any station-keeper compound rarely seated on a wall, so the scene validates.
  for (let i = cv.objects.length - 1; i >= 0; i--) {
    const o = cv.objects[i]!;
    if (o.kind === 'actor' && !(cv.inB(o.col, o.row) && cv.walkable[o.row]![o.col])) cv.objects.splice(i, 1);
  }
}
