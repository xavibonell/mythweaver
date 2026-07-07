/**
 * Scene PRIMITIVES (city-scope Phase G1 spike) — a small vocabulary of composable spatial operations
 * that REPLACE the 3 fixed layout grammars. A scene is a COMPOSITION of these, not a template, so a
 * small set yields unbounded scenes (maze + water + island + bridge + rooms + plaza + scatter …).
 *
 * Each primitive is pure-ish: it MUTATES a Canvas in place, is seeded (reproducible), region-scoped,
 * and — for the topology-makers (maze, rooms) — CONNECTIVITY-CORRECT BY CONSTRUCTION (it carves a
 * spanning tree as it builds), so we never rely on reachabilityCarve to bulldoze a path through them.
 *
 * This is the deterministic half of the G1 falsification spike: prove the vocabulary can EXPRESS
 * wildly different scenes (labyrinth / waterfall-lake / city / crypt) from ONE system, no per-scene
 * code. (Whether an LLM can COMPOSE them reliably is the second half — see scene-program.ts.)
 */

import { FEET_PER_TILE, type AmbianceItem, type BuildingType, type Entrance, type LayoutGrammar, type Lighting, type MapObject, type SceneMap } from '@mythweaver/shared';
import { buildRoofs } from './roofs.js';
import { bakeAutoTiles, bakeRockMass, bakeWoodWalls, BUILDING_TEMPLATES, furnishRoom, makeRng, reachabilityCarve, ROOM_PROGRAMS, ROOM_RECIPES, ROOM_TEMPLATES, scatterGroundDecals, wallTagFor, type RoomFunction, type RoomTemplate } from './cartographer.js';
import { isCharacter, propDef, terrainWalkable } from './catalog.js';
import { inside, maskFor, ringCells, type ShapeKind } from './footprint.js';

export interface Pt {
  c: number;
  r: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A placed building's footprint, recorded so `finalize` can lay a ROOF over it. `rect` is the wall-inclusive
 *  bounds; the roof covers only the WALL + interior-FLOOR cells inside it (so shaped footprints and open
 *  courtyards stay un-roofed). `roof` is the material style (thatch/tile/slate/wood). */
export interface BuildingFootprint { id: string; rect: Rect; roof: string; }

/** Map a building TYPE to a roof material — thatch cottages, tiled civic/faith, slate works, wood shops. */
export function roofStyleFor(type: BuildingType): string {
  const t = String(type);
  if (/temple|cathedral|chapel|church|shrine|keep|castle|manor|court|guild|library|town.?hall|inn|tavern/.test(t)) return 'tile';
  if (/smith|forge|foundry|workshop|armou?ry|barracks|jail|mine|warehouse|vault/.test(t)) return 'slate';
  if (/shop|store|market|curio|stall|trading/.test(t)) return 'wood';
  return 'thatch'; // house / cottage / default
}

/** The mutable scene under construction. Primitives read/write its grids + registries. */
// CLAIM bits (the Contract Layer, P1) — tile-level SEMANTIC reservations beyond walkable/occ. A claimed
// cell stays walk-THROUGH (characters pass) but is off-limits to BLOCKING placements: the door writer
// claims its approach, the street bake claims circulation, and every placer respects the claim. This is
// what breaks the "free apron cell attracts props into the doorway" trap: free-but-claimed.
export const CLAIM_CIRCULATION = 1; // streets, gate runways, door→street aprons
export const CLAIM_APPROACH = 2; // the immediate corridor of a specific door
export const CLAIM_STAGE = 4; // a vignette's composed interior (reserved for P3)
export const CLAIM_BARRIER = 8; // an impassable feature seam (canal bed, moat, wall) — bridges derive where it meets CIRCULATION (Weave L1)
const CLAIM_NOBUILD = CLAIM_CIRCULATION | CLAIM_APPROACH | CLAIM_STAGE | CLAIM_BARRIER;

export class Canvas {
  readonly tiles: string[][];
  readonly walkable: boolean[][];
  readonly occ: boolean[][]; // reserved cells (so later primitives don't stack placements)
  readonly claim: number[][]; // CLAIM_* bitmask per cell (semantic reservations; see above)
  readonly objects: MapObject[] = [];
  readonly ambiance: AmbianceItem[] = [];
  readonly entrances: Entrance[] = [];
  readonly buildings: BuildingFootprint[] = []; // footprints for the ROOF pass (finalize)
  readonly rng: () => number;

  constructor(readonly cols: number, readonly rows: number, readonly seed: number, base = 'grass') {
    this.tiles = Array.from({ length: rows }, () => Array.from({ length: cols }, () => base));
    this.walkable = Array.from({ length: rows }, () => Array.from({ length: cols }, () => terrainWalkable(base)));
    this.occ = Array.from({ length: rows }, () => Array.from({ length: cols }, () => false));
    this.claim = Array.from({ length: rows }, () => Array.from({ length: cols }, () => 0));
    this.rng = makeRng(seed);
  }

  inB(c: number, r: number): boolean {
    return c >= 0 && c < this.cols && r >= 0 && r < this.rows;
  }
  /** Set a cell's terrain (and walkability, defaulting to the tag's catalog value). */
  set(c: number, r: number, tag: string, walk?: boolean): void {
    if (!this.inB(c, r)) return;
    this.tiles[r]![c] = tag;
    this.walkable[r]![c] = walk ?? terrainWalkable(tag);
  }
  tileAt(c: number, r: number): string | undefined {
    return this.inB(c, r) ? this.tiles[r]![c] : undefined;
  }
  isWalk(c: number, r: number): boolean {
    return this.inB(c, r) && this.walkable[r]![c] === true;
  }
  isFree(c: number, r: number): boolean {
    return this.isWalk(c, r) && this.occ[r]![c] === false;
  }
  reserve(c: number, r: number): void {
    if (this.inB(c, r)) this.occ[r]![c] = true;
  }
  /** Stamp a semantic claim bit (rng-free by contract — claims must never consume the stream). */
  stampClaim(c: number, r: number, bit: number): void {
    if (this.inB(c, r)) this.claim[r]![c] = this.claim[r]![c]! | bit;
  }
  /** Is the cell claimed by any of the masked bits? (default: any claim that forbids blocking placements) */
  claimed(c: number, r: number, mask: number = CLAIM_NOBUILD): boolean {
    return this.inB(c, r) && (this.claim[r]![c]! & mask) !== 0;
  }
  center(): Pt {
    return { c: Math.floor(this.cols / 2), r: Math.floor(this.rows / 2) };
  }
  /** Seed-stable shuffle of a cell list. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      const t = arr[i]!;
      arr[i] = arr[j]!;
      arr[j] = t;
    }
    return arr;
  }
}

const clampRect = (cv: Canvas, r: Rect): Rect => {
  const x = Math.max(0, Math.min(cv.cols - 1, Math.floor(r.x)));
  const y = Math.max(0, Math.min(cv.rows - 1, Math.floor(r.y)));
  return { x, y, w: Math.max(1, Math.min(cv.cols - x, Math.floor(r.w))), h: Math.max(1, Math.min(cv.rows - y, Math.floor(r.h))) };
};
const cellsOf = (r: Rect): Pt[] => {
  const out: Pt[] = [];
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) out.push({ c: x, r: y });
  return out;
};

// --- terrain primitives -----------------------------------------------------

/** Flood a region with a terrain tag. */
export function fill(cv: Canvas, region: Rect, tag: string, walk?: boolean): void {
  for (const { c, r } of cellsOf(clampRect(cv, region))) cv.set(c, r, tag, walk);
}

/** Carve a rounded LAND blob inside a region (e.g. an island in water). Ellipse → organic, not square. */
export function island(cv: Canvas, region: Rect, tag = 'grass'): void {
  const r = clampRect(cv, region);
  const cx = r.x + (r.w - 1) / 2;
  const cy = r.y + (r.h - 1) / 2;
  const rx = r.w / 2;
  const ry = r.h / 2;
  for (const { c, r: rr } of cellsOf(r)) {
    const dx = (c - cx) / (rx || 1);
    const dy = (rr - cy) / (ry || 1);
    if (dx * dx + dy * dy <= 1) cv.set(c, rr, tag);
  }
}

/** A 2-wide walkable plank span between two points (over water/whatever). Connectivity by construction
 *  for the two things it links. */
export function bridge(cv: Canvas, a: Pt, b: Pt, tag = 'wood_floor'): void {
  let c = a.c;
  let r = a.r;
  const lay = () => {
    cv.set(c, r, tag, true);
    // 2 wide: also lay the perpendicular neighbour so the bridge reads as a real span
    if (Math.abs(b.c - a.c) >= Math.abs(b.r - a.r)) cv.set(c, r + 1, tag, true);
    else cv.set(c + 1, r, tag, true);
  };
  lay();
  while (c !== b.c) {
    c += c < b.c ? 1 : -1;
    lay();
  }
  while (r !== b.r) {
    r += r < b.r ? 1 : -1;
    lay();
  }
}

/** A walkable path (L-shaped) between two points. */
export function path(cv: Canvas, a: Pt, b: Pt, tag = 'dirt'): void {
  let c = a.c;
  let r = a.r;
  cv.set(c, r, tag, true);
  while (c !== b.c) {
    c += c < b.c ? 1 : -1;
    cv.set(c, r, tag, true);
  }
  while (r !== b.r) {
    r += r < b.r ? 1 : -1;
    cv.set(c, r, tag, true);
  }
}

/** Paved open square (walkable). */
export function plaza(cv: Canvas, region: Rect, tag = 'stone'): void {
  fill(cv, region, tag, true);
}

// --- topology primitives (connectivity-correct BY CONSTRUCTION) -------------

/**
 * A MAZE filling `region`: walls everywhere, then a randomized-DFS spanning tree carves corridors so
 * EVERY corridor cell is reachable from every other (no isolated pockets — connectivity by
 * construction, not by post-hoc carve). `wall` is non-walkable; `floor` is walkable.
 */
export function maze(cv: Canvas, region: Rect, wall = 'wall', floor = 'grass'): void {
  const R = clampRect(cv, region);
  for (const { c, r } of cellsOf(R)) cv.set(c, r, wall, false);
  const gw = Math.floor((R.w - 1) / 2); // # of cell-columns
  const gh = Math.floor((R.h - 1) / 2);
  if (gw < 1 || gh < 1) {
    fill(cv, R, floor, true); // too small to maze — just open it
    return;
  }
  const cellX = (i: number) => R.x + 1 + 2 * i;
  const cellY = (j: number) => R.y + 1 + 2 * j;
  const seen = Array.from({ length: gh }, () => Array.from({ length: gw }, () => false));
  const carveCell = (i: number, j: number) => cv.set(cellX(i), cellY(j), floor, true);
  const stack: { i: number; j: number }[] = [{ i: 0, j: 0 }];
  seen[0]![0] = true;
  carveCell(0, 0);
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  while (stack.length) {
    const cur = stack[stack.length - 1]!;
    const nbrs = cv.shuffle(
      DIRS.map(([di, dj]) => ({ i: cur.i + di, j: cur.j + dj, di, dj })).filter((n) => n.i >= 0 && n.i < gw && n.j >= 0 && n.j < gh && !seen[n.j]![n.i]),
    );
    if (!nbrs.length) {
      stack.pop();
      continue;
    }
    const n = nbrs[0]!;
    seen[n.j]![n.i] = true;
    // knock out the wall BETWEEN cur and n, and carve n itself
    cv.set(cellX(cur.i) + n.di, cellY(cur.j) + n.dj, floor, true);
    carveCell(n.i, n.j);
    stack.push({ i: n.i, j: n.j });
  }
}

/**
 * BSP ROOMS + corridors filling `region`: split into `count` rooms, carve each (floor + wall border),
 * then connect room centres in sequence with L-corridors → a connected dungeon (spanning chain). Walls
 * non-walkable, floor walkable. Returns the room centres (so the caller can place things in rooms).
 */
export function bspRooms(cv: Canvas, region: Rect, count = 5, wall = 'wall', floor = 'stone'): Pt[] {
  const R = clampRect(cv, region);
  for (const { c, r } of cellsOf(R)) cv.set(c, r, wall, false);
  // recursive split into leaves
  let leaves: Rect[] = [R];
  let guard = 0;
  while (leaves.length < count && guard++ < 50) {
    leaves.sort((a, b) => b.w * b.h - a.w * a.h);
    const big = leaves.shift()!;
    const horiz = big.w >= big.h;
    const min = 8;
    if (horiz && big.w >= 2 * min) {
      const cut = min + Math.floor(cv.rng() * (big.w - 2 * min + 1));
      leaves.push({ x: big.x, y: big.y, w: cut, h: big.h }, { x: big.x + cut, y: big.y, w: big.w - cut, h: big.h });
    } else if (!horiz && big.h >= 2 * min) {
      const cut = min + Math.floor(cv.rng() * (big.h - 2 * min + 1));
      leaves.push({ x: big.x, y: big.y, w: big.w, h: cut }, { x: big.x, y: big.y + cut, w: big.w, h: big.h - cut });
    } else {
      leaves.push(big); // can't split further
      break;
    }
  }
  const centres: Pt[] = [];
  for (const leaf of leaves) {
    // carve a LARGE room — inset just 1 from the leaf so the dungeon reads as mostly-floor chambers
    // separated by thin walls (the reference look), not a maze of thick wall bands.
    const rx = leaf.x + 1;
    const ry = leaf.y + 1;
    const rw = Math.max(3, leaf.w - 2);
    const rh = Math.max(3, leaf.h - 2);
    for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) cv.set(x, y, floor, true);
    centres.push({ c: rx + Math.floor(rw / 2), r: ry + Math.floor(rh / 2) });
  }
  // connect rooms in order (spanning chain → fully connected); corridors carve through walls
  for (let i = 1; i < centres.length; i++) {
    const a = centres[i - 1]!;
    const b = centres[i]!;
    let c = a.c;
    let r = a.r;
    cv.set(c, r, floor, true);
    while (c !== b.c) { c += c < b.c ? 1 : -1; cv.set(c, r, floor, true); }
    while (r !== b.r) { r += r < b.r ? 1 : -1; cv.set(c, r, floor, true); }
  }
  return centres;
}

/**
 * An ORGANIC CAVERN via cellular automata — irregular rock walls + open floor, NOT a rectangle. Seed
 * ~46% floor, smooth 5× (a cell is floor if <5 of its 8 neighbours are wall; off-grid = wall so the
 * cave closes at the region border), then keep the floor connected by carving each disconnected pocket
 * to the largest cavern. Floor walkable, wall not. The look the reference cave images have.
 */
export function cave(cv: Canvas, region: Rect, wall = 'rock_wall', floor = 'stone'): void {
  const R = clampRect(cv, region);
  const W = R.w, H = R.h;
  if (W < 5 || H < 5) { fill(cv, R, floor, true); return; }
  const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  let g: boolean[][] = Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => !(x === 0 || y === 0 || x === W - 1 || y === H - 1) && cv.rng() < 0.46));
  const wallsAround = (gr: boolean[][], x: number, y: number): number => {
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || !gr[ny]![nx]) n++;
    }
    return n;
  };
  for (let s = 0; s < 5; s++) {
    const ng: boolean[][] = Array.from({ length: H }, () => Array.from({ length: W }, () => false));
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) ng[y]![x] = wallsAround(g, x, y) < 5;
    g = ng;
  }
  // flood floor components
  const comp: number[][] = Array.from({ length: H }, () => Array.from({ length: W }, () => -1));
  const comps: [number, number][][] = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (g[y]![x] && comp[y]![x]! < 0) {
      const id = comps.length, cells: [number, number][] = [], q: [number, number][] = [[x, y]];
      comp[y]![x] = id;
      while (q.length) {
        const [cx, cy] = q.pop()!;
        cells.push([cx, cy]);
        for (const [dx, dy] of ORTH) { const nx = cx + dx, ny = cy + dy; if (nx >= 0 && ny >= 0 && nx < W && ny < H && g[ny]![nx] && comp[ny]![nx]! < 0) { comp[ny]![nx] = id; q.push([nx, ny]); } }
      }
      comps.push(cells);
    }
  }
  // write to canvas
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) cv.set(R.x + x, R.y + y, g[y]![x] ? floor : wall, g[y]![x] ? true : false);
  // connect every pocket to the largest cavern (carve a thin floor corridor)
  if (comps.length > 1) {
    comps.sort((a, b) => b.length - a.length);
    const mid = (cells: [number, number][]) => cells[Math.floor(cells.length / 2)]!;
    const mc = mid(comps[0]!);
    for (let i = 1; i < comps.length; i++) {
      let [x, y] = mid(comps[i]!);
      const lay = () => cv.set(R.x + x, R.y + y, floor, true);
      lay();
      while (x !== mc[0]) { x += x < mc[0] ? 1 : -1; lay(); }
      while (y !== mc[1]) { y += y < mc[1] ? 1 : -1; lay(); }
    }
  }
  // CAVE FORMATIONS — stalagmites + boulders scattered on the floor (non-blocking decor) so the cavern reads
  // as a natural space, not an empty room. Denser near the walls where formations gather.
  const FORM = ['stalagmite', 'stalagmite', 'boulder', 'rocks_grey', 'stone_pile'];
  const nearWall = (c: number, r: number) => (cv.tileAt(c, r - 1) ?? '').startsWith('rock_wall') || (cv.tileAt(c, r + 1) ?? '').startsWith('rock_wall') || (cv.tileAt(c - 1, r) ?? '').startsWith('rock_wall') || (cv.tileAt(c + 1, r) ?? '').startsWith('rock_wall');
  for (const { c, r } of cellsOf(R)) {
    if (cv.tileAt(c, r) !== floor || !cv.isFree(c, r)) continue;
    if (cv.rng() >= (nearWall(c, r) ? 0.14 : 0.03)) continue;
    cv.reserve(c, r);
    cv.ambiance.push({ tag: FORM[Math.floor(cv.rng() * FORM.length)]!, col: c, row: r });
  }
  // A few braziers — a playable cave is a lair, and without a light motivation the space reads as flat
  // pitch-black. These are LIGHT_TAGS, so the renderers pool warm light around them (the crypt/lair look).
  const open: Array<{ c: number; r: number }> = [];
  for (const { c, r } of cellsOf(R)) if (cv.tileAt(c, r) === floor && cv.isFree(c, r) && !nearWall(c, r)) open.push({ c, r });
  const nBraz = Math.min(4, Math.max(2, Math.floor(open.length / 90)));
  for (let i = 0, placed = 0; i < open.length && placed < nBraz; i++) {
    const j = Math.floor(cv.rng() * open.length), cell = open[j]!;
    if (!cv.isFree(cell.c, cell.r)) continue;
    if (cv.ambiance.some((a) => a.tag === 'brazier' && Math.abs(a.col - cell.c) + Math.abs(a.row - cell.r) < 8)) continue;
    cv.reserve(cell.c, cell.r);
    cv.ambiance.push({ tag: 'brazier', col: cell.c, row: cell.r });
    placed++;
  }
}

/**
 * A FOREST CLEARING — a feathered treeline that's DENSE toward the region edge and thins to an OPEN
 * centre (the clearing), with a bushy fringe. Trees block; bushes are walkable decor. This is the
 * "open glade ringed by woods" read (vs a uniform tree sprinkle). Trees are pushed as ambiance.
 */
export function clearing(cv: Canvas, region: Rect): void {
  const R = clampRect(cv, region);
  const cx = R.x + (R.w - 1) / 2, cy = R.y + (R.h - 1) / 2;
  const maxd = Math.max(1, Math.min(R.w, R.h) / 2);
  const CORE = ['tree', 'tree', 'tree_pine', 'tree_autumn'] as const;
  const FRINGE = ['bush', 'bush', 'tree'] as const;
  for (const { c, r } of cellsOf(R)) {
    if (!cv.isFree(c, r)) continue;
    const dx = (c - cx) / maxd, dy = (r - cy) / maxd;
    const dist = Math.sqrt(dx * dx + dy * dy); // 0 = centre, ~1 = edge
    const prob = dist < 0.5 ? 0 : Math.min(0.9, (dist - 0.5) / 0.55); // open centre, dense toward the edge
    if (cv.rng() >= prob) continue;
    const pool = dist < 0.72 ? FRINGE : CORE; // bushy fringe between clearing and dense wood
    const tag = pool[Math.floor(cv.rng() * pool.length)]!;
    cv.reserve(c, r);
    if (tag.startsWith('tree')) cv.walkable[r]![c] = false; // trees block; bushes stay walkable
    cv.ambiance.push({ tag, col: c, row: r });
  }
}

/** An outer wall ring with one walkable gate per side (+ an Entrance on each gate). */
export function wallRing(cv: Canvas, mat: 'wood' | 'stone' = 'stone', gateLocId?: string): void {
  const wt = wallTagFor;
  for (let c = 0; c < cv.cols; c++) {
    cv.set(c, 0, wt(true, false, c === 0, c === cv.cols - 1, mat), false);
    cv.set(c, cv.rows - 1, wt(false, true, c === 0, c === cv.cols - 1, mat), false);
  }
  for (let r = 0; r < cv.rows; r++) {
    cv.set(0, r, wt(r === 0, r === cv.rows - 1, true, false, mat), false);
    cv.set(cv.cols - 1, r, wt(r === 0, r === cv.rows - 1, false, true, mat), false);
  }
  const mc = Math.floor(cv.cols / 2);
  const mr = Math.floor(cv.rows / 2);
  for (const [c, r] of [[mc, 0], [mc, cv.rows - 1], [0, mr], [cv.cols - 1, mr]] as const) {
    cv.set(c, r, 'dirt', true);
    if (gateLocId) cv.entrances.push({ toLocationId: gateLocId, col: c, row: r });
  }
}

/** The FINAL (post-repair) exterior door of a building/compound: the door cell + its outside cell.
 *  Returned by building()/compound() so downstream passes (aprons, signatures) work from the REAL door,
 *  never a guess — the repair pass may have relocated it to a different side than requested. */
export interface RealizedDoor { c: number; r: number; oC: number; oR: number }
export const doorSideOf = (d: RealizedDoor): 'north' | 'south' | 'east' | 'west' =>
  d.oR < d.r ? 'north' : d.oR > d.r ? 'south' : d.oC < d.c ? 'west' : 'east';

/** Claim the door's APPROACH corridor at the source of truth: the door cell, one cell inside, and up to
 *  three cells straight outward (stopping at bounds). Walk-through, prop-blocking — the anti-fountain. */
function stampApproach(cv: Canvas, d: RealizedDoor): void {
  cv.stampClaim(d.c, d.r, CLAIM_APPROACH);
  cv.stampClaim(2 * d.c - d.oC, 2 * d.r - d.oR, CLAIM_APPROACH); // one inside
  const dc = d.oC - d.c, dr = d.oR - d.r;
  for (let i = 1; i <= 3; i++) cv.stampClaim(d.c + dc * i, d.r + dr * i, CLAIM_APPROACH);
}

/**
 * A FURNISHED walled building/room — the MODULE unit that restores rich interiors on the general path:
 * a wall ring + floor (ONE material, so it never reads noisy), one door, and interior furniture + a
 * seated keeper via the SHARED furnishRoom (identical to the classic carveBuildings). `id` must be
 * unique per call (it namespaces the furniture + keeper ids).
 * Returns the realized door (null when the region was too small to build a walled room).
 */
export function building(cv: Canvas, region: Rect, type: BuildingType, opts: { door?: 'north' | 'south' | 'east' | 'west'; locationId?: string; name?: string; id?: string } = {}): RealizedDoor | null {
  const tmpl = BUILDING_TEMPLATES[type] ?? BUILDING_TEMPLATES.house;
  const R = clampRect(cv, region);
  if (R.w < 4 || R.h < 4) {
    fill(cv, R, tmpl.floor, true); // too small to furnish — just a floor patch
    return null;
  }
  const { x: rx, y: ry, w: rw, h: rh } = R;
  for (let y = ry; y < ry + rh; y++)
    for (let x = rx; x < rx + rw; x++) {
      const top = y === ry, bot = y === ry + rh - 1, left = x === rx, right = x === rx + rw - 1;
      if (top || bot || left || right) {
        cv.set(x, y, wallTagFor(top, bot, left, right, tmpl.wall), false);
        cv.occ[y]![x] = true;
      } else cv.set(x, y, tmpl.floor, true);
    }
  // door on the requested side; fall back to any side whose outside cell is on-grid
  const midX = rx + Math.floor(rw / 2), midY = ry + Math.floor(rh / 2);
  const doorFor = (side: string) =>
    side === 'north' ? { dC: midX, dR: ry, oC: midX, oR: ry - 1 }
    : side === 'east' ? { dC: rx + rw - 1, dR: midY, oC: rx + rw, oR: midY }
    : side === 'west' ? { dC: rx, dR: midY, oC: rx - 1, oR: midY }
    : { dC: midX, dR: ry + rh - 1, oC: midX, oR: ry + rh };
  let door = doorFor(opts.door ?? 'south');
  if (!cv.inB(door.oC, door.oR)) door = [opts.door ?? 'south', 'south', 'north', 'east', 'west'].map(doorFor).find((d) => cv.inB(d.oC, d.oR)) ?? door;
  cv.set(door.dC, door.dR, tmpl.floor, true);
  cv.occ[door.dR]![door.dC] = false;
  if (cv.inB(door.oC, door.oR)) {
    if (cv.tileAt(door.oC, door.oR)!.startsWith('wall')) cv.set(door.oC, door.oR, 'dirt', true);
    else cv.walkable[door.oR]![door.oC] = true;
    cv.occ[door.oR]![door.oC] = false;
  }
  const safe = (opts.id && opts.id.includes(':') ? opts.id.slice(opts.id.indexOf(':') + 1) : opts.id ?? type).replace(/[^a-z0-9_-]/gi, '-').toLowerCase() || type;
  cv.buildings.push({ id: `bldg:${safe}`, rect: R, roof: roofStyleFor(type) }); // record for the roof pass
  if (opts.locationId) cv.entrances.push({ toLocationId: opts.locationId, col: door.dC, row: door.dR, ...(opts.id ? { fixtureId: opts.id } : {}) });
  furnishRoom(cv.tiles, cv.walkable, cv.occ, cv.objects, R, tmpl, { c: door.dC, r: door.dR }, cv.rng, cv.cols, safe, `bldg:${safe}`, 0, opts.name);
  const rd: RealizedDoor = { c: door.dC, r: door.dR, oC: door.oC, oR: door.oR };
  stampApproach(cv, rd); // claim the approach at the source of truth (the door is final here)
  return rd;
}

/**
 * A COMPOUND building — the multi-room upgrade over `building()`. The footprint is subdivided into
 * several rooms (recursive bisection with shared partition walls), each FURNISHED BY FUNCTION from the
 * type's ROOM_PROGRAM (tavern → bar + dining + kitchen + bedroom; temple → nave + vestry + bedroom),
 * connected by interior doors (a spanning tree BY CONSTRUCTION — each split carves a door joining its
 * two halves) with ONE keeper in the primary room and one faced exterior door. Small footprints fall
 * back to a single furnished room. This is what makes interiors read as real homes/shops (separate
 * rooms with the right furniture each) instead of one open box.
 */
export function compound(cv: Canvas, region: Rect, type: BuildingType, opts: { door?: 'north' | 'south' | 'east' | 'west'; locationId?: string; name?: string; id?: string; shape?: ShapeKind } = {}): RealizedDoor | null {
  const R = clampRect(cv, region);
  if (R.w < 7 || R.h < 7) return building(cv, R, type, opts); // too small to partition → single room
  const base = BUILDING_TEMPLATES[type] ?? BUILDING_TEMPLATES.house;
  const mat = base.wall;
  const wallBase = mat === 'wood' ? 'wall_wood' : 'wall';
  const floor = base.floor;
  const { x: rx, y: ry, w: rw, h: rh } = R;
  const N4: readonly [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]];

  // FOOTPRINT: the floor is an arbitrary cell MASK (rect by default; L/T/U/cross via opts.shape). Walls are
  // DERIVED as the N8 ring around it, so EVERY shape gets a clean, watertight, correctly-cornered 1-tile
  // boundary — no draw-then-mutate, hence no staircase. (footprint.ts; design: docs/SCENE-CONTRACTS / plan.)
  const mask = maskFor(opts.shape ?? 'rect', R, cv.rng);
  const ringSet = ringCells(mask);
  const onRing = (c: number, r: number) => ringSet.has(`${c},${r}`);
  const inMask = (c: number, r: number) => inside(mask, c, r);

  // 1. FLOOR every interior cell; DERIVE the wall ring around it.
  for (const p of mask.parts) for (let y = p.y; y < p.y + p.h; y++) for (let x = p.x; x < p.x + p.w; x++) { cv.set(x, y, floor, true); cv.occ[y]![x] = false; }
  for (const k of ringSet) { const [c, r] = k.split(',').map(Number) as [number, number]; if (cv.inB(c, r)) { cv.set(c, r, wallBase, false); cv.occ[r]![c] = true; } }

  // 2. SUBDIVIDE each part into rooms — recursive bisection (biggest-first); each split records a door.
  const minRoom = 5;
  let floorArea = 0; for (const p of mask.parts) floorArea += p.w * p.h;
  const target = Math.max(mask.parts.length, Math.min(ROOM_PROGRAMS[type]?.length ?? 3, Math.floor(floorArea / 20)));
  const leaves: Rect[] = [];
  const doors: { c: number; r: number; horiz: boolean }[] = [];
  const partCells = new Set<string>(); // the bisection CUT LINES only — NOT part seams (so wings stay open)
  const q: Rect[] = mask.parts.map((p) => ({ ...p }));
  let guard = 0;
  while (q.length && leaves.length + q.length < target && guard++ < 60) {
    q.sort((a, b) => b.w * b.h - a.w * a.h);
    const cur = q.shift()!;
    const canH = cur.w >= 2 * minRoom - 1, canV = cur.h >= 2 * minRoom - 1;
    if (!canH && !canV) { leaves.push(cur); continue; }
    const horiz = canH && (!canV || cur.w >= cur.h);
    if (horiz) {
      const cut = cur.x + minRoom - 1 + Math.floor(cv.rng() * (cur.w - 2 * minRoom + 2));
      for (let y = cur.y; y < cur.y + cur.h; y++) partCells.add(`${cut},${y}`); // vertical partition line
      doors.push({ c: cut, r: Math.max(cur.y + 1, Math.min(cur.y + cur.h - 2, cur.y + Math.floor(cur.h / 2) + (Math.floor(cv.rng() * 3) - 1))), horiz: true });
      q.push({ x: cur.x, y: cur.y, w: cut - cur.x + 1, h: cur.h }, { x: cut, y: cur.y, w: cur.x + cur.w - cut, h: cur.h });
    } else {
      const cut = cur.y + minRoom - 1 + Math.floor(cv.rng() * (cur.h - 2 * minRoom + 2));
      for (let x = cur.x; x < cur.x + cur.w; x++) partCells.add(`${x},${cut}`); // horizontal partition line
      doors.push({ c: Math.max(cur.x + 1, Math.min(cur.x + cur.w - 2, cur.x + Math.floor(cur.w / 2) + (Math.floor(cv.rng() * 3) - 1))), r: cut, horiz: false });
      q.push({ x: cur.x, y: cur.y, w: cur.w, h: cut - cur.y + 1 }, { x: cur.x, y: cut, w: cur.w, h: cur.y + cur.h - cut });
    }
  }
  leaves.push(...q);

  // 3. PARTITION walls = the bisection cut lines, then carve those doors.
  for (const k of partCells) { const [c, r] = k.split(',').map(Number) as [number, number]; if (inMask(c, r)) { cv.set(c, r, wallBase, false); cv.occ[r]![c] = true; } }
  for (const d of doors) {
    const pass = d.horiz ? [{ c: d.c, r: d.r }, { c: d.c - 1, r: d.r }, { c: d.c + 1, r: d.r }] : [{ c: d.c, r: d.r }, { c: d.c, r: d.r - 1 }, { c: d.c, r: d.r + 1 }];
    for (const p of pass) if (inMask(p.c, p.r)) { cv.set(p.c, p.r, floor, true); cv.occ[p.r]![p.c] = true; }
  }

  // 3b. PART-SEAM walls — make each part (an L/T/U/cross arm or bar) its OWN room. Wall the seam 1-tile
  //     thick on the HIGHER-index part's side (so it's never doubled), then CONNECT carves a door through
  //     it. Without this the parts merge into one open space (U/cross read as a single room).
  const partIdOf = (c: number, r: number) => { for (let i = 0; i < mask.parts.length; i++) { const p = mask.parts[i]!; if (c >= p.x && c < p.x + p.w && r >= p.y && r < p.y + p.h) return i; } return -1; };
  if (mask.parts.length > 1)
    for (let r = mask.bbox.y; r < mask.bbox.y + mask.bbox.h; r++)
      for (let c = mask.bbox.x; c < mask.bbox.x + mask.bbox.w; c++) {
        const pid = partIdOf(c, r);
        if (pid <= 0) continue; // part 0 keeps its full floor; higher parts wall their seam side
        if (N4.some(([dc, dr]) => { const np = partIdOf(c + dc, r + dr); return np >= 0 && np < pid; })) { cv.set(c, r, wallBase, false); cv.occ[r]![c] = true; }
      }

  // 4. EXTERIOR door — a clean RING FACE (a ring cell with exactly ONE interior neighbour, never a corner),
  //    preferring the requested side. Reused by the REPAIR pass below.
  const ringDoorCands = () => {
    const out: { side: string; dC: number; dR: number; oC: number; oR: number; iC: number; iR: number }[] = [];
    for (const k of ringSet) {
      const [c, r] = k.split(',').map(Number) as [number, number];
      const ins = N4.filter(([dc, dr]) => inMask(c + dc, r + dr));
      if (ins.length !== 1) continue; // a flat wall face — corners (≥2) never become doors
      const [idc, idr] = ins[0]!;
      const oC = c - idc, oR = r - idr; // the side OPPOSITE the interior must be genuine open exterior
      if (!cv.inB(oC, oR) || inMask(oC, oR) || (cv.tileAt(oC, oR) ?? '').startsWith('wall')) continue;
      out.push({ side: oR > r ? 'south' : oR < r ? 'north' : oC > c ? 'east' : 'west', dC: c, dR: r, oC, oR, iC: c + idc, iR: r + idr });
    }
    return out;
  };
  // The door prefers the requested side AND, on that side, the face opening into the LARGEST leaf — the
  // entrance room hosts the keeper + the type's focal station (bar RUN / altar / forge), which needs space;
  // entering into a sliver room starves the station (the F4/composed-footprint failure mode).
  const leafArea = (c: number, r: number) => { for (const lf of leaves) if (c >= lf.x && c < lf.x + lf.w && r >= lf.y && r < lf.y + lf.h) return lf.w * lf.h; return 0; };
  const pickDoor = (pref: string) => {
    const cs = ringDoorCands();
    if (!cs.length) return undefined;
    // The door opens into the LARGEST leaf, side preference only breaking ties among its faces: the entrance
    // room is the primary (keeper + focal station + stock) and starving it fails every semantic contract.
    // You enter the main hall; the street-facing side is honoured whenever the big room touches it.
    const globalBest = cs.reduce((m, e) => Math.max(m, leafArea(e.iC, e.iR)), 0);
    const into = cs.filter((e) => leafArea(e.iC, e.iR) === globalBest);
    for (const s of [pref, 'south', 'north', 'east', 'west']) { const d = into.find((e) => e.side === s); if (d) return d; }
    return into[0];
  };
  const pick0 = pickDoor(opts.door ?? 'south');
  let ed = pick0 ? { dC: pick0.dC, dR: pick0.dR, oC: pick0.oC, oR: pick0.oR } : { dC: rx + Math.floor(rw / 2), dR: ry + rh - 1, oC: rx + Math.floor(rw / 2), oR: ry + rh };
  cv.set(ed.dC, ed.dR, floor, true); cv.occ[ed.dR]![ed.dC] = true;
  if (cv.inB(ed.oC, ed.oR)) { if ((cv.tileAt(ed.oC, ed.oR) ?? '').startsWith('wall')) cv.set(ed.oC, ed.oR, 'dirt', true); else cv.walkable[ed.oR]![ed.oC] = true; cv.occ[ed.oR]![ed.oC] = false; }

  // 5. FURNISH each room BY FUNCTION. The leaf holding the exterior door is the PRIMARY (front) room →
  //    keeper + name + entrance; the rest get furniture only (occupant '' → furnishRoom skips a keeper).
  // PRIMARY room (index 0) = the LARGEST leaf — it hosts the keeper + the type's FOCAL station (altar / bar
  //   run / forge), which needs space; on a composed footprint a tiny primary leaf can't fit a focal RUN.
  //   Tie-broken toward the leaf holding the entrance, so you tend to enter into the main hall.
  const inLeaf = (lf: Rect, c: number, r: number) => c >= lf.x && c < lf.x + lf.w && r >= lf.y && r < lf.y + lf.h;
  const inIC0 = 2 * ed.dC - ed.oC, inIR0 = 2 * ed.dR - ed.oR; // the floor cell just inside the entrance
  // DEPTH-CAST (space-syntax privacy gradient): the ENTRANCE leaf is the primary/public room; every other
  // leaf is ranked by walking DEPTH from it over the leaf graph (BSP doorways + part seams, which CONNECT
  // will arch), and functions are dealt by PRIVACY RANK — service one step in, bedrooms in the DEEPEST
  // leaves. "You enter an inn through a bedroom" and "the bedroom opens off the taproom" both become
  // unrepresentable at assignment; the two-tier repair guard below keeps CONNECT from undoing it.
  const leafIdxAt = (c: number, r: number) => leaves.findIndex((lf) => inLeaf(lf, c, r));
  const ladj: Set<number>[] = leaves.map(() => new Set<number>());
  for (const dd of doors) {
    const [ac, ar, bc, br] = dd.horiz ? [dd.c - 1, dd.r, dd.c + 1, dd.r] : [dd.c, dd.r - 1, dd.c, dd.r + 1];
    const a = leafIdxAt(ac, ar), b = leafIdxAt(bc, br);
    if (a >= 0 && b >= 0 && a !== b) { ladj[a]!.add(b); ladj[b]!.add(a); }
  }
  if (mask.parts.length > 1) // cross-part seams: CONNECT arches wherever parts abut → potential edges
    for (let a = 0; a < leaves.length; a++) for (let b = a + 1; b < leaves.length; b++) {
      const la = leaves[a]!, lb = leaves[b]!;
      if (partIdOf(la.x, la.y) === partIdOf(lb.x, lb.y)) continue;
      if (la.x - 2 <= lb.x + lb.w - 1 && lb.x - 2 <= la.x + la.w - 1 && la.y - 2 <= lb.y + lb.h - 1 && lb.y - 2 <= la.y + la.h - 1) { ladj[a]!.add(b); ladj[b]!.add(a); }
    }
  let entLeaf = leafIdxAt(inIC0, inIR0);
  if (entLeaf < 0) { let ba = -1; entLeaf = 0; leaves.forEach((lf, i) => { const ar = lf.w * lf.h; if (ar > ba) { ba = ar; entLeaf = i; } }); }
  const ldepth = new Array<number>(leaves.length).fill(Infinity);
  ldepth[entLeaf] = 0;
  const dq = [entLeaf];
  while (dq.length) { const i = dq.shift()!; for (const j of ladj[i]!) if (ldepth[j]! > ldepth[i]! + 1) { ldepth[j] = ldepth[i]! + 1; dq.push(j); } }
  const maxLd = Math.max(0, ...ldepth.filter((d) => d !== Infinity));
  for (let i = 0; i < ldepth.length; i++) if (ldepth[i] === Infinity) ldepth[i] = maxLd + 1; // severed leaf → treat as deepest
  const order = leaves.map((_, i) => i).sort((a, b) => (a === entLeaf ? -1 : b === entLeaf ? 1 : ldepth[a]! - ldepth[b]! || leaves[b]!.w * leaves[b]!.h - leaves[a]!.w * leaves[a]!.h || a - b));
  const ordered = order.map((i) => leaves[i]!);
  leaves.length = 0; leaves.push(...ordered);
  const program = ROOM_PROGRAMS[type] ?? ROOM_PROGRAMS.house;
  // Privacy rank per room FUNCTION (0 = public front, 1 = service, 2 = private sleeping). The program still
  // decides WHICH rooms exist — the exact multiset the pre-depth-cast code produced (truncate/repeat-last),
  // so an inn with two rooms keeps its defining bedroom — and the rank sort only decides WHERE each goes:
  // service in the shallow leaves, bedrooms in the deepest.
  const PRIV: Record<string, number> = { dining: 1, kitchen: 1, storeroom: 1, vestry: 1, bedroom: 2 };
  const rest = leaves.slice(1).map((_, j) => program[Math.min(j + 1, program.length - 1)]!).sort((a, b) => (PRIV[a] ?? 0) - (PRIV[b] ?? 0));
  const fnForLeaf = (i: number): RoomFunction => (i === 0 ? program[0]! : (rest[i - 1] ?? program[0]!));
  const safe = (opts.id && opts.id.includes(':') ? opts.id.slice(opts.id.indexOf(':') + 1) : opts.id ?? type).replace(/[^a-z0-9_-]/gi, '-').toLowerCase() || type;
  cv.buildings.push({ id: `bldg:${safe}`, rect: R, roof: roofStyleFor(type) }); // record for the roof pass
  // (entrance record is pushed AFTER the repair pass, so it reflects the final door position.)
  const onBorder = (lf: Rect, p: { c: number; r: number }) => p.c >= lf.x && p.c <= lf.x + lf.w - 1 && p.r >= lf.y && p.r <= lf.y + lf.h - 1 && (p.c === lf.x || p.c === lf.x + lf.w - 1 || p.r === lf.y || p.r === lf.y + lf.h - 1);
  // COURTYARD: a big compound (any type) turns its biggest back room into an open inner garden (grass +
  // fountain + varied flowers) — the loved "inner garden". The room must be BIG (area ≥42 AND min dim ≥6)
  // so it reads as an unmistakable OPEN garden, never a fountain crammed in a small room ("fountain
  // indoors"). A fountain is ONLY ever placed here, on grass.
  const bigEnough = leaves.length >= 3 && rw * rh >= 110;
  // (Irregular SILHOUETTES are now first-class footprint shapes — opts.shape: L/T/U/cross — derived as a
  //  clean ring, NOT carved out of a rect. The old "notch a corner room to grass" hack is gone; it left the
  //  staircase/jog defect.) COURTYARD stays: a big back room becomes an open inner garden, fenced not walled.
  let courtyardIdx = -1;
  // A leaf fully surrounded by interior floor — a true INNER courtyard that can't open onto the street or
  // strand a wall arm when cleared to garden.
  const interiorLeaf = (lf: Rect) => {
    for (let x = lf.x; x < lf.x + lf.w; x++) if (!inMask(x, lf.y - 1) || !inMask(x, lf.y + lf.h)) return false;
    for (let y = lf.y; y < lf.y + lf.h; y++) if (!inMask(lf.x - 1, y) || !inMask(lf.x + lf.w, y)) return false;
    return true;
  };
  // Courtyard only on a plain RECT footprint (on a shaped one it can sever a wing) and only on an INTERIOR leaf.
  if (bigEnough && (opts.shape ?? 'rect') === 'rect' && cv.rng() < 0.55) {
    let bestA = 41;
    for (let i = 1; i < leaves.length; i++) { const lf = leaves[i]!; const a = lf.w * lf.h; if (a > bestA && Math.min(lf.w, lf.h) >= 6 && interiorLeaf(lf)) { bestA = a; courtyardIdx = i; } }
  }
  const GARDEN = ['flowers', 'flowers_blue', 'flowers_yellow', 'flowers_red', 'bush', 'grass_tuft', 'mushroom', 'tree_oak', 'tree_autumn']; // varied garden planting
  const roomFnRects: { lf: Rect; fn: RoomFunction }[] = []; // realized room functions — read by the repair guard
  leaves.forEach((lf, i) => {
    if (i === courtyardIdx) {
      // OPEN garden — clear the whole room (incl. its bounding walls) to grass and RING it with a low
      // FENCE (not a solid wall), leaving the doorway as the gate, so it reads as an open garden.
      // The garden is ringed by a low FENCE (open — you can see in), never a solid wall. A fence is a
      // non-walkable barrier, so it seals the building just like a wall (no leak) while reading as a garden.
      const isGate = (x: number, y: number) => doors.some((d) => d.c === x && d.r === y) || (x === ed.dC && y === ed.dR);
      for (let y = lf.y; y < lf.y + lf.h; y++) for (let x = lf.x; x < lf.x + lf.w; x++) { cv.set(x, y, 'grass', true); cv.occ[y]![x] = false; }
      for (let y = lf.y; y < lf.y + lf.h; y++) for (let x = lf.x; x < lf.x + lf.w; x++) {
        const border = x === lf.x || x === lf.x + lf.w - 1 || y === lf.y || y === lf.y + lf.h - 1;
        if (border && !isGate(x, y)) { cv.reserve(x, y); cv.walkable[y]![x] = false; cv.ambiance.push({ tag: 'fence', col: x, row: y }); }
      }
      // a GARDEN's centrepiece is greenery/a statue, NEVER a fountain (a fountain belongs on the civic
      // PLAZA square, not in every fenced building yard — the fountain-everywhere overuse).
      place(cv, { id: `prop:${safe}-garden`, tag: cv.rng() < 0.55 ? 'tree_oak' : 'statue', kind: 'prop', at: { c: lf.x + Math.floor(lf.w / 2), r: lf.y + Math.floor(lf.h / 2) } });
      for (let y = lf.y + 1; y < lf.y + lf.h - 1; y++) for (let x = lf.x + 1; x < lf.x + lf.w - 1; x++) if (cv.isFree(x, y) && cv.rng() < 0.45) { const tag = GARDEN[Math.floor(cv.rng() * GARDEN.length)]!; cv.reserve(x, y); if (tag.startsWith('tree')) cv.walkable[y]![x] = false; cv.ambiance.push({ tag, col: x, row: y }); }
      return;
    }
    const fn = fnForLeaf(i);
    roomFnRects.push({ lf, fn });
    // Context-aware innfront: with NO bedroom room anywhere (a single-hall inn), the front room doubles as
    // the sleeping hall (check-in + beds — the historical common room). With bedrooms present, the front
    // stays bed-free (beds beside the check-in counter is the beds-at-the-bar incoherence).
    const groups = fn === 'innfront' && !rest.includes('bedroom') ? ['checkin', 'bed', 'bed', 'shelf'] : ROOM_RECIPES[fn];
    const tmpl: RoomTemplate = { ...ROOM_TEMPLATES[fn], floor, wall: mat, occupant: i === 0 ? base.occupant : '', groups };
    // furnishRoom's contract is a WALL-INCLUSIVE rect (it insets 1 to find the interior). A leaf `lf` is pure
    // FLOOR (walls are the ring derived OUTSIDE the mask), so expand it by 1 to put the surrounding wall on the
    // rect border. Without this, furnishRoom double-insets: every wall-hugging item (beds, shelves, counters,
    // altars…) floats 1 cell off the wall AND the room furnishes 2 cells smaller than it really is.
    const room: Rect = { x: lf.x - 1, y: lf.y - 1, w: lf.w + 2, h: lf.h + 2 };
    const onRoomBorder = (p: { c: number; r: number }) => p.c >= room.x && p.c <= room.x + room.w - 1 && p.r >= room.y && p.r <= room.y + room.h - 1 && (p.c === room.x || p.c === room.x + room.w - 1 || p.r === room.y || p.r === room.y + room.h - 1);
    const d = doors.find(onRoomBorder) ?? (i === 0 ? { c: ed.dC, r: ed.dR } : { c: lf.x - 1, r: lf.y });
    furnishRoom(cv.tiles, cv.walkable, cv.occ, cv.objects, room, tmpl, d, cv.rng, cv.cols, `${safe}-r${i}`, `bldg:${safe}-r${i}`, 0, i === 0 ? opts.name : undefined);
  });

  // SEAL → CONNECT → REPAIR → FRAME: make the structural invariants hold BY CONSTRUCTION (structure-check.ts).
  // Runs after all mutations (notch/courtyard/furnish), so the wall/floor state is final.
  const INTERIOR_FLOORS = new Set([floor, 'wood_floor', 'stone', 'flagstone', 'stone_brick']);
  const roomFloor = (c: number, r: number) => { if (!cv.inB(c, r)) return false; const t = cv.tileAt(c, r) ?? ''; return INTERIOR_FLOORS.has(t) || t.startsWith('carpet'); };
  const grassWalk = (c: number, r: number) => cv.inB(c, r) && (cv.tileAt(c, r) ?? '') === 'grass' && cv.walkable[r]![c] === true;
  const sanctioned = new Set<string>();
  const archAt: { c: number; r: number }[] = [];

  // Sanction real interior connectors: room↔room doorways and room↔garden gates (so SEAL leaves them open).
  for (const dd of doors) {
    const [ac, ar, bc, br] = dd.horiz ? [dd.c - 1, dd.r, dd.c + 1, dd.r] : [dd.c, dd.r - 1, dd.c, dd.r + 1];
    const bothRooms = roomFloor(ac, ar) && roomFloor(bc, br);
    const gardenGate = (roomFloor(ac, ar) && grassWalk(bc, br)) || (roomFloor(bc, br) && grassWalk(ac, ar));
    if (bothRooms || gardenGate) { sanctioned.add(`${dd.c},${dd.r}`); if (bothRooms) archAt.push(dd); }
  }
  sanctioned.add(`${ed.dC},${ed.dR}`);

  // Exterior reach — the street plus any yard OPEN to it (a notch, or a courtyard that merged with one).
  // Flood walkable non-room ground inward from just outside the footprint.
  const extReach = new Set<string>();
  {
    const isYard = (c: number, r: number) => cv.inB(c, r) && cv.walkable[r]![c] === true && !roomFloor(c, r);
    const q: [number, number][] = [];
    const seedE = (c: number, r: number) => { const k = `${c},${r}`; if (isYard(c, r) && !extReach.has(k)) { extReach.add(k); q.push([c, r]); } };
    for (let c = rx - 1; c <= rx + rw; c++) { seedE(c, ry - 1); seedE(c, ry + rh); }
    for (let r = ry - 1; r <= ry + rh; r++) { seedE(rx - 1, r); seedE(rx + rw, r); }
    while (q.length) { const [c, r] = q.shift()!; for (const [dc, dr] of N4) seedE(c + dc, r + dr); }
  }

  // PASS A — SEAL: wall any EXTERIOR-REACHABLE yard cell inside the footprint that borders a room (a hole,
  //   a door-gap onto a notch, or a garden gate that merged with the street) — except the one real entrance.
  //   A gate into a truly ENCLOSED garden is not exterior-reachable, so it is left open (the garden stays).
  for (let r = ry; r < ry + rh; r++)
    for (let c = rx; c < rx + rw; c++) {
      // spare the entrance AND its approach cell (for a shaped footprint the approach can fall inside the
      // lot bounds — without this, SEAL would wall the door's path out and trap the building).
      if (roomFloor(c, r) || (c === ed.dC && r === ed.dR) || (c === ed.oC && r === ed.oR) || !extReach.has(`${c},${r}`)) continue;
      if (N4.some(([dc, dr]) => roomFloor(c + dc, r + dr))) { cv.set(c, r, wallBase, false); cv.occ[r]![c] = true; }
    }

  // PASS C — CONNECT every room into ONE component. Seed from ANY room (not the door, which a mutation may
  //   have blocked); carve a fresh arch through a partition wherever a room is left unreached.
  // Match the checker: a room counts as connected only through interior floor, doors, and ENCLOSED grass
  // (a courtyard) — never the exterior street (extReach), or a room "reachable" only by walking outside
  // and around would look connected here but sealed to the player.
  const reachPass = (c: number, r: number) => roomFloor(c, r) || sanctioned.has(`${c},${r}`) || (grassWalk(c, r) && !extReach.has(`${c},${r}`));
  const reached = new Set<string>();
  // Seed from the LARGEST room region — never a stray sliver, or the fill below would wall the real building.
  let firstRoom: [number, number] | null = null;
  {
    const visited = new Set<string>();
    let bestSize = 0;
    for (let r = ry; r < ry + rh; r++)
      for (let c = rx; c < rx + rw; c++) {
        if (!roomFloor(c, r) || visited.has(`${c},${r}`)) continue;
        const comp: [number, number][] = [[c, r]]; visited.add(`${c},${r}`);
        let roomCells = 0;
        for (let i = 0; i < comp.length; i++) { const [cc, cr] = comp[i]!; if (roomFloor(cc, cr)) roomCells++; for (const [dc, dr] of N4) { const nc = cc + dc, nr = cr + dr, k = `${nc},${nr}`; if (!visited.has(k) && reachPass(nc, nr)) { visited.add(k); comp.push([nc, nr]); } } }
        if (roomCells > bestSize) { bestSize = roomCells; firstRoom = [c, r]; }
      }
  }
  const runBfs = () => {
    reached.clear();
    const q: [number, number][] = [];
    const seed = (c: number, r: number) => { const k = `${c},${r}`; if (cv.inB(c, r) && reachPass(c, r) && !reached.has(k)) { reached.add(k); q.push([c, r]); } };
    if (firstRoom) seed(firstRoom[0], firstRoom[1]);
    while (q.length) { const [c, r] = q.shift()!; for (const [dc, dr] of N4) seed(c + dc, r + dr); }
  };
  // Reconnect any unreached room by carving a doorway through a partition between it and a reached region;
  //   if that leaves a degenerate room (a 1-wide protrusion) that shares no partition with anything reached,
  //   carve a minimal tunnel of doorways through interior walls to the nearest reached cell. Never the outer
  //   ring (can't breach the envelope). Repeat until every room is connected — no fill, so no orphan walls.
  const onOuterRingC = onRing; // never tunnel through the derived outer ring (can't breach the envelope)
  runBfs(); // seed the reached set before connecting
  // REPAIR GUARD: an arch must not void the privacy gradient — never carve a PUBLIC room (rank 0: the
  // bar/shopfront/nave...) straight into a BEDROOM while any function-compatible partition exists. Tier 1
  // carves compatible partitions only; tier 2 (last resort, so connectivity always wins) allows anything.
  const fnAt = (c: number, r: number): RoomFunction | null => { for (const rr of roomFnRects) if (inLeaf(rr.lf, c, r)) return rr.fn; return null; };
  const incompat = (a: RoomFunction | null, b: RoomFunction | null): boolean => !!a && !!b && ((a === 'bedroom' && (PRIV[b] ?? 0) === 0) || (b === 'bedroom' && (PRIV[a] ?? 0) === 0));
  // (a) cheap pass: carve a single partition wall wherever a reached region abuts an unreached room —
  // choosing, per iteration, the candidate whose flanking cells are FURNITURE-FREE (the door-clearance
  // pass deletes whatever flanks a new arch; carving beside a bed/shelf silently unfurnishes the room).
  for (const allowIncompat of [false, true] as const) {
    for (let guard2 = 0; guard2 < 40; guard2++) {
      let best: { c: number; r: number; score: number } | null = null;
      for (let r = ry + 1; r < ry + rh - 1; r++)
        for (let c = rx + 1; c < rx + rw - 1; c++) {
          if (!(cv.tileAt(c, r) ?? '').startsWith('wall')) continue;
          const pairs: [number, number, number, number][] = [[c - 1, r, c + 1, r], [c + 1, r, c - 1, r], [c, r - 1, c, r + 1], [c, r + 1, c, r - 1]];
          for (const [ac, ar, bc, br] of pairs)
            if (reached.has(`${ac},${ar}`) && roomFloor(bc, br) && !reached.has(`${bc},${br}`) && (allowIncompat || !incompat(fnAt(ac, ar), fnAt(bc, br)))) {
              const score = (cv.occ[ar]?.[ac] ? 0 : 1) + (cv.occ[br]?.[bc] ? 0 : 1); // prefer both flanks clear
              if (!best || score > best.score) best = { c, r, score };
              break;
            }
        }
      if (!best) break;
      cv.set(best.c, best.r, floor, true); cv.occ[best.r]![best.c] = true; sanctioned.add(`${best.c},${best.r}`); archAt.push({ c: best.c, r: best.r });
      runBfs();
    }
  }
  // (b) fallback: a room with no partition to a reached region (severed by a yard) gets a minimal tunnel
  //   of carved doorways along the shortest interior-wall path to the reached set.
  const tunnelConnect = (): boolean => {
    const seen = new Set(reached);
    const prev = new Map<string, string>();
    const q: [number, number][] = [...reached].map((k) => k.split(',').map(Number) as [number, number]);
    for (let head = 0; head < q.length; head++) {
      const [c, r] = q[head]!;
      if (roomFloor(c, r) && !reached.has(`${c},${r}`)) {
        for (let cur = `${c},${r}`; prev.has(cur); cur = prev.get(cur)!) { const [pc, pr] = cur.split(',').map(Number) as [number, number]; if ((cv.tileAt(pc, pr) ?? '').startsWith('wall')) { cv.set(pc, pr, floor, true); cv.occ[pr]![pc] = true; sanctioned.add(`${pc},${pr}`); archAt.push({ c: pc, r: pr }); } }
        return true;
      }
      for (const [dc, dr] of N4) {
        const nc = c + dc, nr = r + dr, k = `${nc},${nr}`;
        if (!cv.inB(nc, nr) || seen.has(k)) continue;
        const carvableWall = (cv.tileAt(nc, nr) ?? '').startsWith('wall') && !onOuterRingC(nc, nr);
        if (roomFloor(nc, nr) || (grassWalk(nc, nr) && !extReach.has(k)) || carvableWall) { seen.add(k); prev.set(k, `${c},${r}`); q.push([nc, nr]); }
      }
    }
    return false;
  };
  for (let guard3 = 0; guard3 < 40 && tunnelConnect(); guard3++) runBfs();

  // REPAIR the entrance: if the exterior door no longer opens into a room (a courtyard fence / notch
  //   overwrote its inside cell), wall it and relocate to an outer-ring cell that DOES have room floor
  //   inside — prefer the requested side. Guarantees door → room (no unreachable building, no door-to-wall).
  let inIC = 2 * ed.dC - ed.oC, inIR = 2 * ed.dR - ed.oR;
  if (!roomFloor(inIC, inIR)) {
    cv.set(ed.dC, ed.dR, wallBase, false); cv.occ[ed.dR]![ed.dC] = true; // remove the broken door
    const ring = ringDoorCands();
    let best: typeof ring[number] | undefined;
    for (const side of [opts.door ?? 'south', 'south', 'north', 'east', 'west']) { best = ring.find((e) => e.side === side && cv.inB(e.oC, e.oR) && roomFloor(e.iC, e.iR)); if (best) break; }
    if (!best) best = ring.find((e) => cv.inB(e.oC, e.oR) && roomFloor(e.iC, e.iR));
    if (best) {
      ed = { dC: best.dC, dR: best.dR, oC: best.oC, oR: best.oR };
      inIC = best.iC; inIR = best.iR;
      cv.set(ed.dC, ed.dR, floor, true); cv.occ[ed.dR]![ed.dC] = true;
      if (cv.inB(ed.oC, ed.oR)) { if ((cv.tileAt(ed.oC, ed.oR) ?? '').startsWith('wall')) cv.set(ed.oC, ed.oR, 'dirt', true); else cv.walkable[ed.oR]![ed.oC] = true; cv.occ[ed.oR]![ed.oC] = false; }
      sanctioned.add(`${ed.dC},${ed.dR}`);
    }
  }

  // Entrance record — pushed here so it reflects the final, repaired door position — and the APPROACH
  // claim, stamped at the source of truth (never a downstream guess of where the door ended up).
  if (opts.locationId) cv.entrances.push({ toLocationId: opts.locationId, col: ed.dC, row: ed.dR, ...(opts.id ? { fixtureId: opts.id } : {}) });
  const realized: RealizedDoor = { c: ed.dC, r: ed.dR, oC: ed.oC, oR: ed.oR };
  stampApproach(cv, realized);

  // PASS B — FRAME: a house door on the entrance, a wooden arch on every interior connector — but ONLY
  //   where it truly joins two passable spaces on OPPOSITE sides (a real doorway). A candidate that ended
  //   up at an interior corner (passable on adjacent sides only) gets no sprite — the cell just stays open.
  cv.ambiance.push({ tag: 'door_house', col: ed.dC, row: ed.dR });
  const framed = new Set<string>();
  const psbl = (c: number, r: number) => roomFloor(c, r) || grassWalk(c, r);
  for (const a of archAt) {
    const k = `${a.c},${a.r}`;
    if (framed.has(k) || !roomFloor(a.c, a.r)) continue;
    if ((psbl(a.c, a.r - 1) && psbl(a.c, a.r + 1)) || (psbl(a.c - 1, a.r) && psbl(a.c + 1, a.r))) { framed.add(k); cv.ambiance.push({ tag: 'arch', col: a.c, row: a.r }); }
  }

  // DOOR CLEARANCE — a building must be TRAVERSABLE: NO doorway may be blocked by furniture. Now that every
  //   door is final (the entrance + every carved arch), clear any blocking prop from the room cell(s)
  //   immediately inside each doorway, so a character can always step through. (furnishRoom keeps the door it
  //   was handed clear, but a room can border several doors and some arches are carved AFTER furnishing.)
  const doorList = [{ c: ed.dC, r: ed.dR }, ...archAt];
  const approachCells = new Set<string>(); // every room cell touching a door — must stay clear, and is no place to relocate a focal prop to
  for (const d of doorList) for (const [dc, dr] of N4) approachCells.add(`${d.c + dc},${d.r + dr}`);
  const FOCAL = new Set(['altar', 'forge', 'throne', 'banner']); // a type's wall-backed centrepiece (esp. the ones centred OPPOSITE the door, where arches get carved) must NEVER be deleted by clearance — relocate it instead
  const wallAdj = (c: number, r: number) => N4.some(([dc, dr]) => (cv.tileAt(c + dc, r + dr) ?? '').startsWith('wall'));
  const relocateFocal = (o: { col: number; row: number; tag?: string }): boolean => { // slide it to the nearest free wall cell that isn't a door approach
    // A bed keeps its ORIENTATION: it may only slide to a cell backing the SAME wall side (the one-orientation-
    // per-room invariant) — no legal same-side cell → report false and let clearance delete it instead.
    const sideOk = (nc: number, nr: number): boolean => {
      if (!o.tag?.startsWith('bed')) return true;
      const wl = (dc2: number, dr2: number) => (cv.tileAt(nc + dc2, nr + dr2) ?? '').startsWith('wall');
      return o.tag === 'bed' ? wl(0, -1) : o.tag === 'bed_down' ? wl(0, 1) : o.tag === 'bed_blue' ? wl(-1, 0) : wl(1, 0);
    };
    for (let rad = 1; rad <= 4; rad++) for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) {
      const nc = o.col + dc, nr = o.row + dr, k = `${nc},${nr}`;
      if (roomFloor(nc, nr) && cv.walkable[nr]![nc] === true && !cv.occ[nr]![nc] && wallAdj(nc, nr) && sideOk(nc, nr) && !approachCells.has(k)) {
        o.col = nc; o.row = nr; cv.occ[nr]![nc] = true; cv.walkable[nr]![nc] = false;
        return true;
      }
    }
    return false;
  };
  const clearApproach = (c: number, r: number) => {
    if (!roomFloor(c, r) || cv.walkable[r]![c] === true) return; // already a walkable interior cell → nothing to clear
    const idx = cv.objects.findIndex((o) => o.kind === 'prop' && o.col === c && o.row === r);
    // Beds are DEFINING STOCK (an inn without beds fails its contract) — relocate them like a focal, never delete.
    if (idx >= 0) { const o = cv.objects[idx]!; if (!((FOCAL.has(o.tag) || o.tag.startsWith('bed')) && relocateFocal(o))) cv.objects.splice(idx, 1); } // relocate a focal piece; else remove the furniture
    cv.occ[r]![c] = false; cv.walkable[r]![c] = true;
  };
  for (const d of doorList) for (const [dc, dr] of N4) clearApproach(d.c + dc, d.r + dr);

  // FURNITURE-AWARE REACHABILITY — a character entering must be able to WALK to every interior cell. Dissolve
  //   the MINIMAL furniture so no walkable floor is marooned (a sealed back room / corner pocket). Routes
  //   around counters (never punches a hole in a bar/shop counter); staff space behind a counter is left sealed.
  {
    // PROTECTED props are a type's focal/station/seating pieces — the carve routes AROUND them (never clears
    // them to make a path), so connecting a pocket can't break a forge/altar/bar/shop station.
    const PROTECT = new Set(['altar', 'forge', 'anvil', 'bar_counter', 'shelf_wares', 'stone_bench', 'candelabra', 'throne', 'banner']); // single-instance centrepieces; multi-instance stock (shelves/chests/racks/beds) is intentionally clearable (the carve removes one to open a path; the count still passes — protecting beds SEALS pockets the carve must clear)
    const isCounter = new Set(cv.objects.filter((o) => o.tag === 'bar_counter').map((o) => `${o.col},${o.row}`));
    const isProtected = new Set(cv.objects.filter((o) => o.kind === 'prop' && PROTECT.has(o.tag)).map((o) => `${o.col},${o.row}`));
    const staff = (c: number, r: number) => N4.some(([dc, dr]) => isCounter.has(`${c + dc},${r + dr}`) && (cv.tileAt(c - dc, r - dr) ?? '').startsWith('wall'));
    const flood = (): Set<string> => {
      const seen = new Set<string>(); const q: [number, number][] = [];
      const seed = (c: number, r: number) => { const k = `${c},${r}`; if (cv.inB(c, r) && cv.walkable[r]![c] === true && !seen.has(k)) { seen.add(k); q.push([c, r]); } };
      seed(inIC, inIR);
      while (q.length) { const [c, r] = q.shift()!; for (const [dc, dr] of N4) seed(c + dc, r + dr); }
      return seen;
    };
    // Shortest path from a stranded cell to the reached region over ORDINARY interior floor (clearable if an
    //   ordinary prop blocks it) + walkable openings — never through a PROTECTED station prop.
    const pathTo = (target: [number, number], reach: Set<string>): string[] | null => {
      const prev = new Map<string, string>(); const seen2 = new Set<string>([`${target[0]},${target[1]}`]); const q2: [number, number][] = [target]; let hit: string | null = null;
      while (q2.length && !hit) {
        const [c, r] = q2.shift()!;
        for (const [dc, dr] of N4) {
          const nc = c + dc, nr = r + dr, k = `${nc},${nr}`;
          if (seen2.has(k) || isProtected.has(k)) continue; // never route through a focal/station prop
          if (!roomFloor(nc, nr) && cv.walkable[nr]?.[nc] !== true) continue;
          seen2.add(k); prev.set(k, `${c},${r}`);
          if (reach.has(k)) { hit = k; break; }
          q2.push([nc, nr]);
        }
      }
      if (!hit) return null;
      const path: string[] = [];
      for (let cur = hit; cur && cur !== `${target[0]},${target[1]}`; cur = prev.get(cur)!) path.push(cur);
      return path;
    };
    const giveUp = new Set<string>();
    for (let pass = 0; pass < 400; pass++) {
      const reach = flood();
      let target: [number, number] | null = null;
      for (let r = ry; r < ry + rh && !target; r++) for (let c = rx; c < rx + rw; c++) if (roomFloor(c, r) && cv.walkable[r]![c] === true && !reach.has(`${c},${r}`) && !staff(c, r) && !giveUp.has(`${c},${r}`)) { target = [c, r]; break; }
      if (!target) break; // every interior cell reachable
      const path = pathTo(target, reach);
      if (!path) { giveUp.add(`${target[0]},${target[1]}`); continue; } // only reachable through a station → leave it
      for (const cur of path) { const [c, r] = cur.split(',').map(Number) as [number, number]; if (cv.walkable[r]![c] !== true) { const i = cv.objects.findIndex((o) => o.kind === 'prop' && o.col === c && o.row === r); if (i >= 0) cv.objects.splice(i, 1); cv.occ[r]![c] = false; cv.walkable[r]![c] = true; } }
    }
  }

  // PASS D — PRUNE: any wall cell with NO interior floor in its N8 neighbourhood is redundant — a stranded
  //   arm (e.g. a partition orphaned when a back room became a garden) or the outer cell of a 2-tile-thick
  //   wall. It encloses nothing, so drop it to exterior grass → the ring stays exactly 1 tile thick (the
  //   keystone). Iterate so a 3-thick wall fully peels. Doesn't expose interior (it bordered none).
  const N8: readonly [number, number][] = [...N4, [1, -1], [1, 1], [-1, 1], [-1, -1]];
  for (let pass = 0; pass < 3; pass++) {
    let pruned = false;
    for (let r = ry - 1; r <= ry + rh; r++)
      for (let c = rx - 1; c <= rx + rw; c++) {
        if (!cv.inB(c, r) || !(cv.tileAt(c, r) ?? '').startsWith('wall')) continue;
        if (!N8.some(([dc, dr]) => roomFloor(c + dc, r + dr))) { cv.set(c, r, 'grass', true); cv.occ[r]![c] = false; pruned = true; }
      }
    if (!pruned) break;
  }

  // WINDOWS — periodic, set into STRAIGHT mid-runs of the (wood) outer ring only (never a corner/end/door).
  // Ring-based so it works for any footprint shape. Decorative ambiance over the wall tile, non-blocking.
  const stillWall = (c: number, r: number) => (cv.tileAt(c, r) ?? '').startsWith('wall_wood');
  for (const k of ringSet) {
    const [c, r] = k.split(',').map(Number) as [number, number];
    if ((c + r) % 3 !== 0 || (c === ed.dC && r === ed.dR) || !stillWall(c, r)) continue;
    const straightH = stillWall(c - 1, r) && stillWall(c + 1, r) && !stillWall(c, r - 1) && !stillWall(c, r + 1);
    const straightV = stillWall(c, r - 1) && stillWall(c, r + 1) && !stillWall(c - 1, r) && !stillWall(c + 1, r);
    // A horizontal wall run (the top/bottom of a room) is seen FACE-ON → the frontal window; a vertical run
    // (a side wall) is seen edge-on → the side window. Using one sprite for both made it read as "stuck on".
    if (straightH) cv.ambiance.push({ tag: 'window_front', col: c, row: r });
    else if (straightV) cv.ambiance.push({ tag: 'window', col: c, row: r });
  }
  return realized;
}

// --- object primitives ------------------------------------------------------

const footprintOf = (tag: string, kind: string): { w: number; h: number } => {
  if (kind === 'actor') return { w: 1, h: 1 };
  const d = propDef(tag); // fixtures + props carry their catalog footprint (e.g. a 2×2 fountain)
  return { w: d?.w ?? 1, h: d?.h ?? 1 };
};

/** Place ONE object at-or-near a target cell. Fixtures/blocking props clear walkable under their
 *  footprint; actors stand on walkable floor. Snaps to the nearest free fit so it never lands in a wall. */
export function place(cv: Canvas, o: { id: string; tag: string; kind: 'fixture' | 'prop' | 'actor'; role?: 'pc' | 'npc' | 'mob'; at: Pt; name?: string; visible?: boolean }): Pt | null {
  const fp = footprintOf(o.tag, o.kind);
  const blocks = o.kind === 'fixture' || (o.kind === 'prop' && (propDef(o.tag)?.blocks ?? true));
  // A BLOCKING object must respect semantic claims (door approaches, circulation): a free-but-claimed cell
  // is not a legal site — this is what stops the nearest-free-cell snap from parking props in doorways.
  const fits = (c: number, r: number) => {
    for (let dy = 0; dy < fp.h; dy++) for (let dx = 0; dx < fp.w; dx++) {
      if (!cv.isFree(c + dx, r + dy)) return false;
      if (blocks && cv.claimed(c + dx, r + dy)) return false;
    }
    return true;
  };
  let best: Pt | null = null;
  if (fits(o.at.c, o.at.r)) best = o.at;
  else {
    let bestD = Infinity;
    for (let r = 0; r < cv.rows; r++) for (let c = 0; c < cv.cols; c++) {
      if (!fits(c, r)) continue;
      const d = (c - o.at.c) ** 2 + (r - o.at.r) ** 2;
      if (d < bestD) { bestD = d; best = { c, r }; }
    }
  }
  if (!best) {
    // Degenerate scene (e.g. an over-watered map with no free fit anywhere): carve the footprint
    // walkable at the clamped target so the object ALWAYS appears rather than silently vanishing.
    const cc = Math.max(0, Math.min(cv.cols - fp.w, o.at.c));
    const rr = Math.max(0, Math.min(cv.rows - fp.h, o.at.r));
    for (let dy = 0; dy < fp.h; dy++) for (let dx = 0; dx < fp.w; dx++) cv.set(cc + dx, rr + dy, 'dirt', true);
    best = { c: cc, r: rr };
  }
  for (let dy = 0; dy < fp.h; dy++) for (let dx = 0; dx < fp.w; dx++) {
    cv.reserve(best.c + dx, best.r + dy);
    if (blocks) cv.walkable[best.r + dy]![best.c + dx] = false;
  }
  cv.objects.push({ id: o.id, kind: o.kind, ...(o.role ? { role: o.role } : {}), tag: o.tag, ...(o.name ? { name: o.name } : {}), col: best.c, row: best.r, footprint: fp, facing: 'down', visible: o.visible ?? true });
  return best;
}

/** Scatter N props/actors across free cells in a region (seed-stable). Children share `idBase`.
 *  ACTORS must appear: if the region is dry of free cells (e.g. crocodiles "in" a mostly-water lake),
 *  top up from free walkable cells ANYWHERE on the map so the creatures never silently vanish. */
export function scatter(cv: Canvas, o: { idBase: string; tags: string[]; kind: 'prop' | 'actor'; role?: 'pc' | 'npc' | 'mob'; region: Rect; count: number; on?: 'water' }): void {
  // IN-WATER scatter (spec compiler: `in: water` — surfacing corpses, floating debris): place on
  // unoccupied WATER tiles instead of walkable ground. Non-blocking (water stays unwalkable anyway).
  if (o.on === 'water') {
    const wet = cv.shuffle(cellsOf(clampRect(cv, o.region)).filter((p) => (cv.tiles[p.r]?.[p.c] ?? '').startsWith('water') && cv.occ[p.r]![p.c] === false));
    const n = Math.min(o.count, wet.length);
    for (let i = 0; i < n; i++) {
      const cell = wet[i]!;
      const tag = o.tags[Math.floor(cv.rng() * o.tags.length)]!;
      cv.reserve(cell.c, cell.r);
      cv.objects.push({ id: `${o.idBase}#${i.toString().padStart(2, '0')}`, kind: o.kind, ...(o.role ? { role: o.role } : {}), tag, col: cell.c, row: cell.r, footprint: { w: 1, h: 1 }, facing: 'down', visible: true, group: o.idBase });
    }
    return;
  }
  // Props keep off claimed cells (door approaches / circulation); actors may stand anywhere walkable.
  let free = cv.shuffle(cellsOf(clampRect(cv, o.region)).filter((p) => cv.isFree(p.c, p.r) && (o.kind === 'actor' || !cv.claimed(p.c, p.r))));
  if (o.kind === 'actor' && free.length < o.count) {
    const seen = new Set(free.map((p) => p.r * cv.cols + p.c));
    const everywhere: Pt[] = [];
    for (let r = 0; r < cv.rows; r++) for (let c = 0; c < cv.cols; c++) if (cv.isFree(c, r) && !seen.has(r * cv.cols + c)) everywhere.push({ c, r });
    free = free.concat(cv.shuffle(everywhere));
    // Last resort (a near-all-hazard map with too little land): carve unoccupied cells walkable so the
    // creatures still appear. Rare — the prompt asks for majority-walkable maps; this is the safety net.
    for (let r = 0; r < cv.rows && free.length < o.count; r++)
      for (let c = 0; c < cv.cols && free.length < o.count; c++) {
        const k = r * cv.cols + c;
        if (seen.has(k) || cv.occ[r]![c]) continue;
        cv.set(c, r, 'dirt', true);
        free.push({ c, r });
        seen.add(k);
      }
  }
  const n = Math.min(o.count, free.length);
  for (let i = 0; i < n; i++) {
    const cell = free[i]!;
    const tag = o.tags[Math.floor(cv.rng() * o.tags.length)]!;
    const blocks = o.kind === 'prop' && (propDef(tag)?.blocks ?? true);
    cv.reserve(cell.c, cell.r);
    if (blocks) cv.walkable[cell.r]![cell.c] = false;
    cv.objects.push({ id: `${o.idBase}#${i.toString().padStart(2, '0')}`, kind: o.kind, ...(o.role ? { role: o.role } : {}), tag, col: cell.c, row: cell.r, footprint: { w: 1, h: 1 }, facing: 'down', visible: true, group: o.idBase });
  }
}

// --- distribution primitives (the "lived-in" density layer) -----------------
// Hand-crafted maps read as designed because decoration uses TWO deliberate textures, not one uniform
// percentage: BLUE noise (even-but-not-grid spread — trees, lamps) and CLUMPS (cohesive beds/thickets).
// Our old scatter() is WHITE noise (independent per-cell %), which accidentally clumps AND voids and
// reads as litter. These two primitives are that missing density layer.

/**
 * A seeded value-noise field over the whole grid, 0..1, SPATIALLY CORRELATED so a threshold cut carves
 * cohesive blobs (flower beds, thickets) — the inverse of white noise. `freq` sets clump SIZE (higher =
 * smaller patches; ~0.13 ≈ 8-tile blobs). Own RNG from `seed` so the field is independent of how many
 * cv.rng draws preceded it (determinism doesn't depend on call order). Bilinear-interpolated lattice.
 */
export function noiseField(cols: number, rows: number, freq: number, seed: number): number[][] {
  const rng = makeRng(seed);
  const gw = Math.max(2, Math.ceil(cols * freq) + 2);
  const gh = Math.max(2, Math.ceil(rows * freq) + 2);
  const lat: number[][] = Array.from({ length: gh }, () => Array.from({ length: gw }, () => rng()));
  const smooth = (t: number) => t * t * (3 - 2 * t); // smoothstep → no lattice creases
  const out: number[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: number[] = [];
    for (let c = 0; c < cols; c++) {
      const fx = c * freq, fy = r * freq;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = smooth(fx - x0), ty = smooth(fy - y0);
      const a = lat[y0]![x0]!, b = lat[y0]![x0 + 1]!, cc = lat[y0 + 1]![x0]!, d = lat[y0 + 1]![x0 + 1]!;
      const top = a + (b - a) * tx, bot = cc + (d - cc) * tx;
      row.push(top + (bot - top) * ty);
    }
    out.push(row);
  }
  return out;
}

/**
 * BLUE-NOISE scatter (Bridson fast Poisson-disk): place props with a guaranteed MIN SPACING `r` so they
 * spread evenly without a grid and without clumps/voids — how a person spaces trees/lamps/signposts.
 * Float dart-throwing, then snap to tile + reject non-free / filtered cells. `blocks` clears walkable
 * under each (trees block; flowers don't). Pushes AmbianceItems. Returns how many landed.
 */
export function poissonScatter(
  cv: Canvas,
  region: Rect,
  o: { tags: string[]; r: number; k?: number; max?: number; blocks?: boolean; filter?: (c: number, r: number) => boolean },
): number {
  const R = clampRect(cv, region);
  if (!o.tags.length || R.w < 1 || R.h < 1) return 0;
  const rad = Math.max(1, o.r);
  const k = o.k ?? 30;
  const cell = rad / Math.SQRT2;
  const gw = Math.max(1, Math.ceil(R.w / cell)), gh = Math.max(1, Math.ceil(R.h / cell));
  const grid: ({ x: number; y: number } | null)[] = new Array(gw * gh).fill(null);
  const gi = (x: number, y: number) => Math.min(gh - 1, Math.floor(y / cell)) * gw + Math.min(gw - 1, Math.floor(x / cell));
  const far = (x: number, y: number): boolean => {
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    for (let yy = Math.max(0, gy - 2); yy <= Math.min(gh - 1, gy + 2); yy++)
      for (let xx = Math.max(0, gx - 2); xx <= Math.min(gw - 1, gx + 2); xx++) {
        const p = grid[yy * gw + xx];
        if (p) { const dx = p.x - x, dy = p.y - y; if (dx * dx + dy * dy < rad * rad) return false; }
      }
    return true;
  };
  const samples: { x: number; y: number }[] = [];
  const seed = { x: cv.rng() * R.w, y: cv.rng() * R.h };
  const active = [seed];
  grid[gi(seed.x, seed.y)] = seed;
  samples.push(seed);
  let guard = 0;
  while (active.length && guard++ < 20000) {
    const i = Math.floor(cv.rng() * active.length);
    const a = active[i]!;
    let found = false;
    for (let t = 0; t < k; t++) {
      const ang = cv.rng() * Math.PI * 2;
      const dist = rad * (1 + cv.rng()); // annulus [r, 2r]
      const x = a.x + Math.cos(ang) * dist, y = a.y + Math.sin(ang) * dist;
      if (x < 0 || y < 0 || x >= R.w || y >= R.h || !far(x, y)) continue;
      const p = { x, y };
      active.push(p); grid[gi(x, y)] = p; samples.push(p); found = true; break;
    }
    if (!found) { active[i] = active[active.length - 1]!; active.pop(); }
  }
  let n = 0;
  for (const s of cv.shuffle(samples)) {
    if (o.max != null && n >= o.max) break;
    const c = R.x + Math.floor(s.x), r = R.y + Math.floor(s.y);
    if (!cv.isFree(c, r) || (o.blocks && cv.claimed(c, r)) || (o.filter && !o.filter(c, r))) continue; // blocking scatter respects claims (no props on aprons/streets)
    const tag = o.tags[Math.floor(cv.rng() * o.tags.length)]!;
    cv.reserve(c, r);
    if (o.blocks) cv.walkable[r]![c] = false;
    cv.ambiance.push({ tag, col: c, row: r });
    n++;
  }
  return n;
}

/**
 * CLUMP scatter (noise-threshold): place props on every free cell where a low-frequency noise field
 * exceeds `threshold` → cohesive patches (flower beds, bush thickets, undergrowth) that uniform scatter
 * never produces. `seedOffset` gives each element class its OWN field so beds/thickets don't coincide.
 * Pushes AmbianceItems; `blocks` clears walkable. Returns how many landed.
 */
export function clumpScatter(
  cv: Canvas,
  region: Rect,
  o: { tags: string[]; freq?: number; threshold?: number; seedOffset?: number; max?: number; blocks?: boolean; filter?: (c: number, r: number) => boolean },
): number {
  if (!o.tags.length) return 0;
  const field = noiseField(cv.cols, cv.rows, o.freq ?? 0.13, (cv.seed ^ (o.seedOffset ?? 0)) >>> 0);
  const th = o.threshold ?? 0.62;
  const cells = cv.shuffle(
    cellsOf(clampRect(cv, region)).filter((p) => cv.isFree(p.c, p.r) && !(o.blocks && cv.claimed(p.c, p.r)) && field[p.r]![p.c]! > th && (!o.filter || o.filter(p.c, p.r))),
  );
  const n = o.max != null ? Math.min(o.max, cells.length) : cells.length;
  for (let i = 0; i < n; i++) {
    const { c, r } = cells[i]!;
    const tag = o.tags[Math.floor(cv.rng() * o.tags.length)]!;
    cv.reserve(c, r);
    if (o.blocks) cv.walkable[r]![c] = false;
    cv.ambiance.push({ tag, col: c, row: r });
  }
  return n;
}

/**
 * A VIGNETTE — an authored SET-PIECE cluster placed as ONE unit around an anchor (the fix for "piled
 * assets" in open areas): a small list of props/actors at relative offsets that read as a coherent
 * mini-scene (a market stand, a forge, a camp, a shrine). Each piece snaps to the nearest free cell
 * via place(), so the cluster stays tight + valid.
 */
interface VignettePiece { dx: number; dy: number; tag: string; kind?: 'prop' | 'actor'; role?: 'npc' | 'mob' }
export const VIGNETTES: Record<string, VignettePiece[]> = {
  market: [{ dx: 0, dy: 0, tag: 'market_stall' }, { dx: 2, dy: 0, tag: 'market_stall' }, { dx: 0, dy: 1, tag: 'crate' }, { dx: 1, dy: 1, tag: 'barrel' }, { dx: 2, dy: 1, tag: 'sack' }, { dx: 1, dy: 0, tag: 'villager', kind: 'actor', role: 'npc' }],
  forge: [{ dx: 0, dy: 0, tag: 'brazier' }, { dx: 1, dy: 0, tag: 'table' }, { dx: -1, dy: 0, tag: 'barrel' }, { dx: 0, dy: 1, tag: 'weapon_rack' }, { dx: 1, dy: 1, tag: 'crate' }, { dx: -1, dy: 1, tag: 'dwarf', kind: 'actor', role: 'npc' }],
  camp: [{ dx: 0, dy: 0, tag: 'brazier' }, { dx: -2, dy: -1, tag: 'crate' }, { dx: 2, dy: -1, tag: 'barrel' }, { dx: -2, dy: 1, tag: 'bed' }, { dx: 2, dy: 1, tag: 'bed' }, { dx: 0, dy: 2, tag: 'woodpile' }],
  shrine: [{ dx: 0, dy: 0, tag: 'altar' }, { dx: -1, dy: 0, tag: 'candelabra' }, { dx: 1, dy: 0, tag: 'candelabra' }, { dx: 0, dy: 1, tag: 'rug' }, { dx: -2, dy: 0, tag: 'statue' }, { dx: 2, dy: 0, tag: 'statue' }],
  well: [{ dx: 0, dy: 0, tag: 'fountain' }, { dx: 3, dy: 0, tag: 'barrel' }, { dx: -2, dy: 0, tag: 'stone_bench' }, { dx: 0, dy: 2, tag: 'pot' }],
  graveyard: [{ dx: 0, dy: 0, tag: 'gravestone' }, { dx: 2, dy: 0, tag: 'tombstone' }, { dx: -2, dy: 0, tag: 'tombstone' }, { dx: 0, dy: 2, tag: 'sarcophagus' }, { dx: 1, dy: 1, tag: 'bones' }, { dx: -1, dy: 1, tag: 'skull' }],
};
export const VIGNETTE_NAMES = Object.keys(VIGNETTES);

export function vignette(cv: Canvas, anchor: Pt, type: string, idBase: string): void {
  const pieces = VIGNETTES[type] ?? VIGNETTES.market!;
  let i = 0;
  for (const pc of pieces) {
    const kind = pc.kind ?? 'prop';
    const role = kind === 'actor' ? pc.role ?? 'npc' : undefined;
    const prefix = kind === 'actor' ? (role === 'mob' ? 'mob' : 'npc') : 'prop';
    place(cv, { id: `${prefix}:${idBase}-${i++}`, tag: pc.tag, kind, ...(role ? { role } : {}), at: { c: anchor.c + pc.dx, r: anchor.r + pc.dy } });
  }
}

/** Open a walkable entrance at a cell (carving to it from the edge if needed) + record the Entrance. */
export function entrance(cv: Canvas, at: Pt, toLocationId: string): void {
  cv.set(at.c, at.r, 'dirt', true);
  cv.entrances.push({ toLocationId, col: at.c, row: at.r });
}

// --- finalize ---------------------------------------------------------------

/** Run the shared post-passes and emit a frozen SceneMap. `outdoor` gates the terrain auto-tile bake +
 *  decal scatter (interiors skip them). reachabilityCarve is the LAST-RESORT safety net only. */
/** Sparse drifting MIST — sprinkle `mist_wisp` decals across a fog scene on a coarse jittered grid, so
 *  fog reads as patchy drifting mist floating OVER the map (the renderer draws these on top of everything),
 *  not just a flat colour wash. Low density + grid spacing so it never obscures the scene. */
function scatterMist(cv: Canvas): void {
  const CLOUDS = ['mist_a', 'mist_b', 'mist_c'];
  const STEP = 8;
  for (let gy = 2; gy < cv.rows - 1; gy += STEP)
    for (let gx = 2; gx < cv.cols - 1; gx += STEP) {
      if (cv.rng() < 0.45) continue; // ~55% of grid cells get a cloud
      const c = Math.min(cv.cols - 1, gx + Math.floor(cv.rng() * STEP));
      const r = Math.min(cv.rows - 1, gy + Math.floor(cv.rng() * STEP));
      cv.ambiance.push({ tag: CLOUDS[Math.floor(cv.rng() * CLOUDS.length)]!, col: c, row: r });
    }
}


/** Sparse WALL TORCHES on an interior — floor cells that back onto a wall get a mounted torch (as non-blocking
 *  ambiance), spaced out, so a dark tomb/dungeon has pooled torchlight (the renderer glows a warm pool around
 *  each light source). Without these an interior renders uniformly dark. */
function scatterWallTorches(cv: Canvas): void {
  const wall = (c: number, r: number): boolean => (cv.tiles[r]?.[c] ?? '').startsWith('wall');
  const floor = (c: number, r: number): boolean => { const t = cv.tiles[r]?.[c] ?? ''; return t === 'stone' || t === 'stone_brick' || t === 'wood_floor' || t === 'flagstone' || t === 'dirt'; };
  const placed: Array<{ c: number; r: number }> = [];
  for (let r = 1; r < cv.rows - 1; r++)
    for (let c = 1; c < cv.cols - 1; c++) {
      if (!floor(c, r) || !cv.isFree(c, r)) continue;
      if (!(wall(c, r - 1) || wall(c, r + 1) || wall(c - 1, r) || wall(c + 1, r))) continue; // must back onto a wall
      if (placed.some((p) => Math.abs(p.c - c) + Math.abs(p.r - r) < 8)) continue; // keep torches spaced apart
      if (cv.rng() < 0.5) continue; // sparse
      cv.ambiance.push({ tag: 'torch_wall', col: c, row: r });
      placed.push({ c, r });
    }
}

export function finalize(
  cv: Canvas,
  meta: { locationId: string; biome: string; lighting: Lighting; weather?: 'fog' | 'clear'; grammar: LayoutGrammar; outdoor: boolean; skipReachability?: boolean; skipDecals?: boolean },
): SceneMap {
  // skipReachability: the component contact-sheet packs intentionally DISCONNECTED cells — carving
  // corridors between them would mangle the gallery. Real scenes leave it on (the rare safety net).
  if (!meta.skipReachability) reachabilityCarve(cv.tiles, cv.walkable, cv.cols, cv.rows, cv.objects, cv.entrances); // safety net; primitives are connectivity-correct so this rarely fires
  bakeWoodWalls(cv.tiles, cv.cols, cv.rows); // neighbour-autotile wood walls → correct edges/corners on any shape (incl. L-footprints + partitions)
  bakeRockMass(cv.tiles, cv.cols, cv.rows); // connectivity blob-autotile a rock_wall massif into cliff faces + rock top (mountains)
  if (meta.outdoor) {
    // skipDecals: a generator that does its OWN deliberate landscaping (e.g. the precinct) opts out of the
    // uniform ground-decal sprinkle, which otherwise reads as procedural speckle over its composed greenery.
    if (!meta.skipDecals) scatterGroundDecals(cv.tiles, cv.walkable, cv.occ, cv.cols, cv.rows, cv.ambiance, cv.rng);
    bakeAutoTiles(cv.tiles, cv.cols, cv.rows);
  } else if (meta.grammar === 'enclosed-interior') {
    scatterWallTorches(cv); // a dark interior needs light SOURCES → the renderer pools warm torchlight around them
  }
  if (meta.lighting === 'fog' || meta.weather === 'fog') scatterMist(cv); // weather composes with time (S3)
  return {
    locationId: meta.locationId,
    seed: cv.seed,
    biome: meta.biome,
    lighting: meta.lighting,
    ...(meta.weather ? { weather: meta.weather } : {}),
    grammar: meta.grammar,
    grid: { cols: cv.cols, rows: cv.rows, feetPerTile: FEET_PER_TILE },
    tiles: cv.tiles,
    walkable: cv.walkable,
    objects: cv.objects,
    ambiance: cv.ambiance,
    entrances: cv.entrances,
    roofs: buildRoofs(cv),
  };
}
