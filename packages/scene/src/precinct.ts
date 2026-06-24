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
import { wallTagFor } from './cartographer.js';
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
  const propOn = (tag: string, c: number, r: number) => { if (cv.inB(c, r)) place(cv, { id: `prop:${loc}-p${pid++}`, tag, kind: 'prop', at: { c, r } }); }; // place even on non-walkable (the fountain on the pedestal)
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

  // ── PLAZA: the central block, holding the WATER BASIN.
  const Pl: Rect = { x: vx1 + RW, y: hy1 + RW, w: vx2 - (vx1 + RW), h: hy2 - (hy1 + RW) };
  carve(Pl.x, Pl.y, Pl.w, Pl.h, PAVE);
  const cc = Pl.x + Math.floor(Pl.w / 2), cr = Pl.y + Math.floor(Pl.h / 2);
  // The reference's recessed framed PIT, now FILLED WITH WATER: a stone WALL ring (the raised rim that gives the
  // 3D "looking down a hole" depth) → blue water inside → a central stone pedestal carrying the fountain bowl.
  const BW = Math.max(12, Math.min(16, Pl.w - 4)), BH = Math.max(9, Math.min(12, Pl.h - 4));
  const bx = cc - Math.floor(BW / 2), by = cr - Math.floor(BH / 2);
  carve(bx, by, BW, BH, 'water', false);                                   // fill the pit with water
  for (let c = bx; c < bx + BW; c++) {                                     // stone wall ring = the recessed rim
    cv.set(c, by, wallTagFor(true, false, c === bx, c === bx + BW - 1, 'stone'), false);
    cv.set(c, by + BH - 1, wallTagFor(false, true, c === bx, c === bx + BW - 1, 'stone'), false);
  }
  for (let r = by; r < by + BH; r++) {
    cv.set(bx, r, wallTagFor(r === by, r === by + BH - 1, true, false, 'stone'), false);
    cv.set(bx + BW - 1, r, wallTagFor(r === by, r === by + BH - 1, false, true, 'stone'), false);
  }
  carve(cc - 1, cr - 1, 3, 2, RIM, false);                                 // a small central stone-brick pedestal island
  propOn('fountain', cc, cr);                                              // the fountain bowl rises from the pedestal
  for (const [tx, ty] of [[Pl.x + 1, Pl.y + 1], [Pl.x + Pl.w - 2, Pl.y + 1], [Pl.x + 1, Pl.y + Pl.h - 2], [Pl.x + Pl.w - 2, Pl.y + Pl.h - 2]] as const) prop('tree_oak', tx, ty); // corner trees
  for (let c = bx + 1; c < bx + BW - 1; c += 3) { prop('stone_bench', c, by - 2); prop('stone_bench', c, by + BH + 1); } // benches face the basin
  for (let k = 0; k < 3; k++) prop('market_stall', bx - 2, by + 1 + k); // a tidy market-stall row beside the basin

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
  const M2 = 6; // a green COUNTRYSIDE ring at the precinct edge (no buildings there → grass + groves frame the town)
  const lotGrass = (lot: Rect) => {
    if (lot.x < R.x + M2 || lot.y < R.y + M2 || lot.x + lot.w > R.x + R.w - M2 || lot.y + lot.h > R.y + R.h - M2) return false;
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
  // A short DIRT entry path from a building's door out to the road it fronts — so buildings read as CONNECTED to
  // the street (built together), not plopped on grass. 2 cells wide, only over grass/dirt, stops at the cobble.
  const entryPath = (lot: Rect, door: 'north' | 'south' | 'east' | 'west') => {
    let dc = door === 'east' ? lot.x + lot.w : door === 'west' ? lot.x - 1 : lot.x + Math.floor(lot.w / 2);
    let dr = door === 'south' ? lot.y + lot.h : door === 'north' ? lot.y - 1 : lot.y + Math.floor(lot.h / 2);
    const dx = door === 'east' ? 1 : door === 'west' ? -1 : 0, dy = door === 'south' ? 1 : door === 'north' ? -1 : 0;
    const px = dy !== 0 ? 1 : 0, py = dx !== 0 ? 1 : 0; // perpendicular → 2-wide
    for (let k = 0; k < 7; k++) {
      if (!cv.inB(dc, dr) || isRoad(dc, dr)) break;
      for (const [wc, wr] of [[dc, dr], [dc + px, dr + py]] as const) {
        const t = cv.tileAt(wc, wr);
        if (cv.inB(wc, wr) && (t === 'grass' || t === DIRT)) carve(wc, wr, 1, 1, DIRT, true);
      }
      dc += dx; dr += dy;
    }
  };
  // Pack DENSELY (step 1, no global cap) so buildings ABUT their neighbours and address the street — the reference
  // is tight terraced frontage, not boxes in moats. Green comes from the COUNTRYSIDE ring the road grid leaves
  // unbuilt at the edges + the garden parks, not from spacing every building apart.
  const packPass = (lo: number, hi: number) => {
    for (let r = R.y + 1; r < R.y + R.h - 1; r += 1) for (let c = R.x + 1; c < R.x + R.w - 1; c += 1) {
      if (!isGrass(c, r)) continue;
      const w = lo + Math.floor(rng() * (hi - lo + 1)), h = lo + Math.floor(rng() * (hi - lo + 1));
      const lot: Rect = { x: c, y: r, w, h };
      if (!lotGrass(lot)) continue;
      const door = frontRoad(lot); if (!door) continue; // must address a road — no isolated boxes in grass moats
      const dist = Math.hypot(c + w / 2 - cc, r + h / 2 - cr);
      compound(cv, lot, typeFor(dist, Math.max(w, h)), { door, shape: chooseShape(w, h), locationId, id: `bldg:${loc}-${bi++}` });
      entryPath(lot, door); // a dirt walkway from the door to the street
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
  for (let g = 0; g < 20; g++) {
    const rad = 2 + Math.floor(rng() * 3);
    let gx = 0, gy = 0, ok = false;
    for (let t = 0; t < 50 && !ok; t++) {
      gx = R.x + rad + Math.floor(rng() * (R.w - 2 * rad)); gy = R.y + rad + Math.floor(rng() * (R.h - 2 * rad));
      let g2 = 0;
      for (let r = gy - rad; r <= gy + rad; r++) for (let c = gx - rad; c <= gx + rad; c++) if (isGrass(c, r)) g2++;
      ok = g2 > rad * rad * 1.6; // more permissive → groves actually fill the countryside ring + gaps
    }
    if (!ok) continue;
    for (let r = gy - rad; r <= gy + rad; r++) for (let c = gx - rad; c <= gx + rad; c++) {
      if (!isGrass(c, r)) continue;
      if (rng() < 1.0 - Math.hypot(c - gx, r - gy) * 0.16) prop((['tree_oak', 'tree', 'tree_pine', 'tree_dark'] as const)[Math.floor(rng() * 4)]!, c, r);
    }
  }

  // Safety net: drop any station-keeper compound rarely seated on a wall, so the scene validates.
  for (let i = cv.objects.length - 1; i >= 0; i--) {
    const o = cv.objects[i]!;
    if (o.kind === 'actor' && !(cv.inB(o.col, o.row) && cv.walkable[o.row]![o.col])) cv.objects.splice(i, 1);
  }
}
