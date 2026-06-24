/**
 * PRECINCT VAULT — the pattern layer for believable town COMPOSITION. Where townGen subdivides land and floats
 * one building per parcel (isolated boxes in grass moats), a precinct is a hand-DESIGNED dense "place".
 *
 * v6 — PAVE-THEN-PACK (the inversion). The town CORE is paved stone first; then irregular compound buildings
 * (L/T/U/cross/compose, biggest first) are packed densely ONTO the pavement. The leftover stone between their
 * irregular masses IS the street/alley network — winding because the buildings are irregular — so nothing can
 * sit in a "grass moat" and the streets are defined BY the buildings. A central plaza (blue water pool framed by
 * brick) and a few winding main streets are kept open; a handful of grass GARDEN pockets and a grassy COUNTRYSIDE
 * edge (clustered groves) supply greenery without uniform scatter. Grand houses cluster by the plaza (uptown).
 */

import { Canvas, compound, fill, place, type Rect } from './primitives.js';
import { SHAPE_MIN, type ShapeKind } from './footprint.js';
import type { BuildingType } from '@mythweaver/shared';

const slug = (s: string) => (s || 'x').replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '') || 'x';

export function precinctSquare(cv: Canvas, region: Rect, locationId: string): void {
  const R = region;
  if (R.w < 40 || R.h < 36) { fill(cv, R, 'grass', true); return; }
  const rng = () => cv.rng();
  const loc = slug(locationId);
  const PAVE = 'stone';
  const RIM = 'stone_brick';
  let pid = 0, bi = 0;
  const prop = (tag: string, c: number, r: number) => { if (cv.inB(c, r) && cv.isFree(c, r)) place(cv, { id: `prop:${loc}-p${pid++}`, tag, kind: 'prop', at: { c, r } }); };
  const propOn = (tag: string, c: number, r: number) => { if (cv.inB(c, r)) place(cv, { id: `prop:${loc}-p${pid++}`, tag, kind: 'prop', at: { c, r } }); };
  const carve = (x: number, y: number, w: number, h: number, tag = PAVE, walk = true) => { if (w > 0 && h > 0) fill(cv, { x, y, w, h }, tag, walk); };

  fill(cv, R, 'grass', true);

  // ── PAVE THE CORE (the town); a grassy countryside margin rings it.
  const M = 4;
  const core: Rect = { x: R.x + M, y: R.y + M, w: R.w - 2 * M, h: R.h - 2 * M };
  carve(core.x, core.y, core.w, core.h, PAVE, true);

  // `protect` = paved cells that must stay OPEN (plaza + main streets) — the packer never builds on them.
  const protect = new Set<string>();
  const protectBlob = (x: number, y: number, w: number) => {
    for (let r = Math.round(y - w / 2); r < Math.round(y - w / 2) + w; r++) for (let c = Math.round(x - w / 2); c < Math.round(x - w / 2) + w; c++)
      if (cv.inB(c, r) && cv.tileAt(c, r) === PAVE) protect.add(`${c},${r}`);
  };

  // ── CENTRAL PLAZA (kept open) with a blue water pool framed by brick, stalls + planted beds.
  const PWd = Math.max(16, Math.floor(core.w * 0.24)), PHd = Math.max(14, Math.floor(core.h * 0.24));
  const Pl: Rect = { x: core.x + Math.floor((core.w - PWd) / 2), y: core.y + Math.floor((core.h - PHd) / 2), w: PWd, h: PHd };
  carve(Pl.x, Pl.y, Pl.w, Pl.h, RIM, true); // a distinct stone-BRICK floor sets the civic square apart from the stone alleys
  for (let r = Pl.y; r < Pl.y + Pl.h; r++) for (let c = Pl.x; c < Pl.x + Pl.w; c++) protect.add(`${c},${r}`);
  const cc = Pl.x + Math.floor(Pl.w / 2), cr = Pl.y + Math.floor(Pl.h / 2);
  const PW = Math.max(5, Math.min(8, Pl.w - 10)), PH = Math.max(4, Math.min(6, Pl.h - 10));
  const px = cc - Math.floor(PW / 2), py = cr - Math.floor(PH / 2);
  carve(px - 1, py - 1, PW + 2, PH + 2, RIM, true);
  carve(px, py, PW, PH, 'water', false);
  carve(cc, cr, 1, 1, RIM, true);
  propOn('fountain', cc, cr);
  for (const [bx, by] of [[px - 3, cr], [px + PW + 2, cr], [cc, py - 3], [cc, py + PH + 2]] as const) prop('stone_bench', bx, by);
  for (const bx of [Pl.x + 2, Pl.x + Pl.w - 4]) { carve(bx, cr - 1, 2, 2, 'grass', true); prop('tree_oak', bx, cr - 1); prop('flowers', bx + 1, cr); }
  for (let k = 0; k < 3; k++) prop('market_stall', Pl.x + 1, Pl.y + 3 + k * 2); // stalls on the WEST edge — clear of the pool↔south flow
  // FRAME the square: trees lining the N/S edges + benches on the E/W edges, so it reads as a designed civic space.
  for (let c = Pl.x + 2; c < Pl.x + Pl.w - 2; c += 3) { prop('tree_oak', c, Pl.y + 1); prop('tree_oak', c, Pl.y + Pl.h - 2); }
  for (let r = Pl.y + 3; r < Pl.y + Pl.h - 3; r += 4) prop('stone_bench', Pl.x + Pl.w - 2, r);

  // ── MAIN STREETS (kept open): a few winding corridors from the plaza out to the core edge.
  const carveStreet = (sx: number, sy: number, dx: number, dy: number, w: number) => {
    let x = sx, y = sy;
    for (let s = 0; s < Math.max(R.w, R.h); s++) {
      protectBlob(x, y, w);
      x += dx; y += dy;
      if (rng() < 0.5) { const j = rng() < 0.5 ? 1 : -1; x += -dy * j; y += dx * j; } // serpentine
      if (x < core.x || x > core.x + core.w || y < core.y || y > core.y + core.h) break;
    }
  };
  carveStreet(cc, Pl.y, 0, -1, 3); carveStreet(cc, Pl.y + Pl.h, 0, 1, 3);
  carveStreet(Pl.x, cr, -1, 0, 3); carveStreet(Pl.x + Pl.w, cr, 1, 0, 3);
  carveStreet(Pl.x + Math.floor(Pl.w * 0.3), Pl.y, -0.5, -1, 2); carveStreet(Pl.x + Math.floor(Pl.w * 0.7), Pl.y + Pl.h, 0.5, 1, 2);

  // ── GARDEN POCKETS (kept open as grass): a few small planted plots inside the town.
  const gardens: { x: number; y: number; w: number; h: number }[] = [];
  for (let g = 0; g < 6; g++) { // a FEW big, deliberate garden parks in the town core (not many small sprinkles)
    const sz = rng() < 0.5 ? 8 : 6;
    let gx = 0, gy = 0, ok = false;
    for (let t = 0; t < 36 && !ok; t++) {
      gx = core.x + 2 + Math.floor(rng() * (core.w - sz - 4)); gy = core.y + 2 + Math.floor(rng() * (core.h - sz - 4));
      ok = true;
      for (let r = gy - 1; r <= gy + sz && ok; r++) for (let c = gx - 1; c <= gx + sz; c++) if (cv.tileAt(c, r) !== PAVE || protect.has(`${c},${r}`)) { ok = false; break; }
    }
    if (ok) { carve(gx, gy, sz, sz, 'grass', true); gardens.push({ x: gx, y: gy, w: sz, h: sz }); }
  }

  // ── PACK irregular buildings ONTO the pavement (biggest first). The leftover stone is the alley network.
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
  // A lot is buildable iff every cell is plain pavement and none is protected (plaza/street) — so buildings
  // pack onto stone, never on the plaza/streets/gardens/pool, and the gaps between them stay paved = alleys.
  const clear = (lot: Rect) => {
    if (lot.x < core.x || lot.y < core.y || lot.x + lot.w > core.x + core.w || lot.y + lot.h > core.y + core.h) return false;
    for (let r = lot.y; r < lot.y + lot.h; r++) for (let c = lot.x; c < lot.x + lot.w; c++) {
      if (cv.tileAt(c, r) !== PAVE || protect.has(`${c},${r}`)) return false;
    }
    return true;
  };
  const nearPlaza = Math.min(core.w, core.h) * 0.34;
  const typeFor = (dist: number, dim: number): BuildingType => {
    if (dist < nearPlaza) return dim >= 11 ? pick(GRAND) : pick(TRADE);
    return dim >= 10 ? pick(TRADE) : pick(HOUSES);
  };
  const packPass = (lo: number, hi: number) => {
    for (let r = core.y; r < core.y + core.h; r += 1) for (let c = core.x; c < core.x + core.w; c += 1) {
      if (cv.tileAt(c, r) !== PAVE || protect.has(`${c},${r}`)) continue;
      const w = lo + Math.floor(rng() * (hi - lo + 1)), h = lo + Math.floor(rng() * (hi - lo + 1));
      const lot: Rect = { x: c, y: r, w, h };
      if (!clear(lot)) continue;
      const dist = Math.hypot(c + w / 2 - cc, r + h / 2 - cr);
      compound(cv, lot, typeFor(dist, Math.max(w, h)), { door: (['north', 'south', 'east', 'west'] as const)[Math.floor(rng() * 4)], shape: chooseShape(w, h), locationId, id: `bldg:${loc}-${bi++}` });
    }
  };
  // FRAME the plaza first: a tight ring of grand buildings facing it (gaps only where the main streets cross),
  // so the civic square reads as one BOUNDED space, not paving that bleeds into the alleys.
  const framePlaza = () => {
    const d = 8;
    for (const side of ['north', 'south', 'west', 'east'] as const) {
      const horiz = side === 'north' || side === 'south';
      const aEnd = horiz ? Pl.x + Pl.w : Pl.y + Pl.h;
      let a = horiz ? Pl.x : Pl.y;
      while (a < aEnd - 4) {
        const len = Math.min(5 + Math.floor(rng() * 5), aEnd - a);
        const lot: Rect = side === 'north' ? { x: a, y: Pl.y - d, w: len, h: d }
          : side === 'south' ? { x: a, y: Pl.y + Pl.h, w: len, h: d }
          : side === 'west' ? { x: Pl.x - d, y: a, w: d, h: len }
          : { x: Pl.x + Pl.w, y: a, w: d, h: len };
        const door = side === 'north' ? 'south' : side === 'south' ? 'north' : side === 'west' ? 'east' : 'west';
        if (len >= 4 && clear(lot)) compound(cv, lot, rng() < 0.5 ? pick(GRAND) : pick(TRADE), { door, shape: chooseShape(lot.w, lot.h), locationId, id: `bldg:${loc}-${bi++}` });
        a += len + 1;
      }
    }
  };
  framePlaza();
  for (const [lo, hi] of [[16, 20], [12, 16], [9, 12], [7, 9], [6, 7]] as const) packPass(lo, hi); // a few big civic blocks → many small infill → wide massing range (min 6 so a keeper always fits)

  // ── GREENERY: dense in the garden pockets; clustered groves in the grassy countryside margin. No field scatter.
  const isGrass = (c: number, r: number) => cv.inB(c, r) && cv.tileAt(c, r) === 'grass';
  for (const gd of gardens) {
    // A deliberate fenced garden: a fence border (with one gap for an entrance), densely planted inside.
    const gap = gd.x + 1 + Math.floor(rng() * (gd.w - 2)); // entrance column on the south fence
    for (let r = gd.y; r < gd.y + gd.h; r++) for (let c = gd.x; c < gd.x + gd.w; c++) {
      if (!isGrass(c, r)) continue;
      const edge = r === gd.y || r === gd.y + gd.h - 1 || c === gd.x || c === gd.x + gd.w - 1;
      if (edge) { if (!(r === gd.y + gd.h - 1 && c === gap)) prop('fence', c, r); }
      else if (rng() < 0.8) prop((['tree_oak', 'tree', 'tree_pine', 'tree_dark'] as const)[Math.floor(rng() * 4)]!, c, r);
      else prop((['flowers', 'flowers_blue', 'bush'] as const)[Math.floor(rng() * 3)]!, c, r);
    }
    prop('statue', gd.x + Math.floor(gd.w / 2), gd.y + Math.floor(gd.h / 2)); // a centrepiece reads as designed
  }
  for (let g = 0; g < 13; g++) { // DENSE groves ringing the town like parkland/forest (clustered, not sprinkled)
    let gx = 0, gy = 0, ok = false;
    for (let t = 0; t < 40 && !ok; t++) { gx = R.x + 1 + Math.floor(rng() * (R.w - 2)); gy = R.y + 1 + Math.floor(rng() * (R.h - 2)); ok = isGrass(gx, gy); }
    if (!ok) continue;
    const rad = 3 + Math.floor(rng() * 3);
    for (let r = gy - rad; r <= gy + rad; r++) for (let c = gx - rad; c <= gx + rad; c++) {
      if (!isGrass(c, r)) continue;
      if (rng() < 0.9 - Math.hypot(c - gx, r - gy) * 0.13) prop(rng() < 0.8 ? (['tree_oak', 'tree', 'tree_pine', 'tree_dark'] as const)[Math.floor(rng() * 4)]! : (['flowers', 'bush', 'grass_tuft'] as const)[Math.floor(rng() * 3)]!, c, r);
    }
  }

  // Safety net: across hundreds of packed buildings, compound can rarely seat a station-keeper on a wall in an
  // odd shape/door combo. Drop any actor left on a non-walkable cell so the scene validates (one missing keeper
  // among ~hundreds of buildings is invisible).
  for (let i = cv.objects.length - 1; i >= 0; i--) {
    const o = cv.objects[i]!;
    if (o.kind === 'actor' && !(cv.inB(o.col, o.row) && cv.walkable[o.row]![o.col])) cv.objects.splice(i, 1);
  }
}
