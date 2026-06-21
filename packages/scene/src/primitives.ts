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
import { bakeAutoTiles, BUILDING_TEMPLATES, furnishRoom, makeRng, reachabilityCarve, ROOM_PROGRAMS, ROOM_TEMPLATES, scatterGroundDecals, wallTagFor, type RoomTemplate } from './cartographer.js';
import { isCharacter, propDef, terrainWalkable } from './catalog.js';

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

/** The mutable scene under construction. Primitives read/write its grids + registries. */
export class Canvas {
  readonly tiles: string[][];
  readonly walkable: boolean[][];
  readonly occ: boolean[][]; // reserved cells (so later primitives don't stack placements)
  readonly objects: MapObject[] = [];
  readonly ambiance: AmbianceItem[] = [];
  readonly entrances: Entrance[] = [];
  readonly rng: () => number;

  constructor(readonly cols: number, readonly rows: number, readonly seed: number, base = 'grass') {
    this.tiles = Array.from({ length: rows }, () => Array.from({ length: cols }, () => base));
    this.walkable = Array.from({ length: rows }, () => Array.from({ length: cols }, () => terrainWalkable(base)));
    this.occ = Array.from({ length: rows }, () => Array.from({ length: cols }, () => false));
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
export function cave(cv: Canvas, region: Rect, wall = 'wall', floor = 'stone'): void {
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

/**
 * A FURNISHED walled building/room — the MODULE unit that restores rich interiors on the general path:
 * a wall ring + floor (ONE material, so it never reads noisy), one door, and interior furniture + a
 * seated keeper via the SHARED furnishRoom (identical to the classic carveBuildings). `id` must be
 * unique per call (it namespaces the furniture + keeper ids).
 */
export function building(cv: Canvas, region: Rect, type: BuildingType, opts: { door?: 'north' | 'south' | 'east' | 'west'; locationId?: string; name?: string; id?: string } = {}): void {
  const tmpl = BUILDING_TEMPLATES[type] ?? BUILDING_TEMPLATES.house;
  const R = clampRect(cv, region);
  if (R.w < 4 || R.h < 4) {
    fill(cv, R, tmpl.floor, true); // too small to furnish — just a floor patch
    return;
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
  if (opts.locationId) cv.entrances.push({ toLocationId: opts.locationId, col: door.dC, row: door.dR, ...(opts.id ? { fixtureId: opts.id } : {}) });
  furnishRoom(cv.tiles, cv.walkable, cv.occ, cv.objects, R, tmpl, { c: door.dC, r: door.dR }, cv.rng, cv.cols, safe, `bldg:${safe}`, 0, opts.name);
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
export function compound(cv: Canvas, region: Rect, type: BuildingType, opts: { door?: 'north' | 'south' | 'east' | 'west'; locationId?: string; name?: string; id?: string } = {}): void {
  const R = clampRect(cv, region);
  if (R.w < 7 || R.h < 7) { building(cv, R, type, opts); return; } // too small to partition → single room
  const base = BUILDING_TEMPLATES[type] ?? BUILDING_TEMPLATES.house;
  const mat = base.wall;
  const wallBase = mat === 'wood' ? 'wall_wood' : 'wall';
  const floor = base.floor;
  const { x: rx, y: ry, w: rw, h: rh } = R;

  // 1. OUTER faced wall ring + floor interior.
  for (let y = ry; y < ry + rh; y++)
    for (let x = rx; x < rx + rw; x++) {
      const top = y === ry, bot = y === ry + rh - 1, left = x === rx, right = x === rx + rw - 1;
      if (top || bot || left || right) { cv.set(x, y, wallTagFor(top, bot, left, right, mat), false); cv.occ[y]![x] = true; }
      else cv.set(x, y, floor, true);
    }

  // 2. SUBDIVIDE the interior into rooms — recursive bisection; each split records a connecting DOOR
  //    (with its passage orientation) so the room graph is a connected spanning tree by construction.
  const minRoom = 5;
  const target = Math.max(1, Math.min(ROOM_PROGRAMS[type]?.length ?? 3, Math.floor(((rw - 2) * (rh - 2)) / 20)));
  const leaves: Rect[] = [];
  const doors: { c: number; r: number; horiz: boolean }[] = [];
  const q: Rect[] = [R];
  let guard = 0;
  while (q.length && leaves.length + q.length < target && guard++ < 40) {
    q.sort((a, b) => b.w * b.h - a.w * a.h);
    const cur = q.shift()!;
    const canH = cur.w >= 2 * minRoom - 1, canV = cur.h >= 2 * minRoom - 1;
    if (!canH && !canV) { leaves.push(cur); continue; }
    const horiz = canH && (!canV || cur.w >= cur.h);
    if (horiz) {
      const cut = cur.x + minRoom - 1 + Math.floor(cv.rng() * (cur.w - 2 * minRoom + 2));
      doors.push({ c: cut, r: cur.y + 1 + Math.floor(cv.rng() * Math.max(1, cur.h - 2)), horiz: true });
      q.push({ x: cur.x, y: cur.y, w: cut - cur.x + 1, h: cur.h }, { x: cut, y: cur.y, w: cur.x + cur.w - cut, h: cur.h });
    } else {
      const cut = cur.y + minRoom - 1 + Math.floor(cv.rng() * (cur.h - 2 * minRoom + 2));
      doors.push({ c: cur.x + 1 + Math.floor(cv.rng() * Math.max(1, cur.w - 2)), r: cut, horiz: false });
      q.push({ x: cur.x, y: cur.y, w: cur.w, h: cut - cur.y + 1 }, { x: cur.x, y: cut, w: cur.w, h: cur.y + cur.h - cut });
    }
  }
  leaves.push(...q);

  // 3. PARTITION walls (interior leaf borders only — the outer ring is already faced), then carve the
  //    doors + RESERVE each doorway (cell + its two passage neighbours) so furniture never blocks it.
  const isOuter = (c: number, r: number) => c === rx || c === rx + rw - 1 || r === ry || r === ry + rh - 1;
  for (const lf of leaves) {
    for (let x = lf.x; x < lf.x + lf.w; x++) for (const yy of [lf.y, lf.y + lf.h - 1]) if (!isOuter(x, yy)) { cv.set(x, yy, wallBase, false); cv.occ[yy]![x] = true; }
    for (let y = lf.y; y < lf.y + lf.h; y++) for (const xx of [lf.x, lf.x + lf.w - 1]) if (!isOuter(xx, y)) { cv.set(xx, y, wallBase, false); cv.occ[y]![xx] = true; }
  }
  for (const d of doors) {
    const pass = d.horiz ? [{ c: d.c, r: d.r }, { c: d.c - 1, r: d.r }, { c: d.c + 1, r: d.r }] : [{ c: d.c, r: d.r }, { c: d.c, r: d.r - 1 }, { c: d.c, r: d.r + 1 }];
    for (const p of pass) if (cv.inB(p.c, p.r) && !isOuter(p.c, p.r)) { cv.set(p.c, p.r, floor, true); cv.occ[p.r]![p.c] = true; } // reserved-but-walkable: keeps the passage clear
  }

  // 4. EXTERIOR door on the requested side (faced ring → floor gap + outside walkable + Entrance).
  const midX = rx + Math.floor(rw / 2), midY = ry + Math.floor(rh / 2);
  const doorFor = (side: string) => side === 'north' ? { dC: midX, dR: ry, oC: midX, oR: ry - 1 } : side === 'east' ? { dC: rx + rw - 1, dR: midY, oC: rx + rw, oR: midY } : side === 'west' ? { dC: rx, dR: midY, oC: rx - 1, oR: midY } : { dC: midX, dR: ry + rh - 1, oC: midX, oR: ry + rh };
  let ed = doorFor(opts.door ?? 'south');
  if (!cv.inB(ed.oC, ed.oR)) ed = [opts.door ?? 'south', 'south', 'north', 'east', 'west'].map(doorFor).find((d) => cv.inB(d.oC, d.oR)) ?? ed;
  cv.set(ed.dC, ed.dR, floor, true); cv.occ[ed.dR]![ed.dC] = true; // reserve so furniture can't seal the entrance
  const inC = 2 * ed.dC - ed.oC, inR = 2 * ed.dR - ed.oR; // the cell one step INSIDE the entrance — reserve it too so furniture never blocks the doorway
  if (cv.inB(inC, inR)) { cv.set(inC, inR, floor, true); cv.occ[inR]![inC] = true; }
  if (cv.inB(ed.oC, ed.oR)) { if ((cv.tileAt(ed.oC, ed.oR) ?? '').startsWith('wall')) cv.set(ed.oC, ed.oR, 'dirt', true); else cv.walkable[ed.oR]![ed.oC] = true; cv.occ[ed.oR]![ed.oC] = false; }

  // 5. FURNISH each room BY FUNCTION. The leaf holding the exterior door is the PRIMARY (front) room →
  //    keeper + name + entrance; the rest get furniture only (occupant '' → furnishRoom skips a keeper).
  const inLeaf = (lf: Rect, c: number, r: number) => c >= lf.x && c < lf.x + lf.w && r >= lf.y && r < lf.y + lf.h;
  leaves.sort((a, b) => (inLeaf(b, ed.dC, ed.dR) ? 1 : 0) - (inLeaf(a, ed.dC, ed.dR) ? 1 : 0));
  const program = ROOM_PROGRAMS[type] ?? ROOM_PROGRAMS.house;
  const safe = (opts.id && opts.id.includes(':') ? opts.id.slice(opts.id.indexOf(':') + 1) : opts.id ?? type).replace(/[^a-z0-9_-]/gi, '-').toLowerCase() || type;
  if (opts.locationId) cv.entrances.push({ toLocationId: opts.locationId, col: ed.dC, row: ed.dR, ...(opts.id ? { fixtureId: opts.id } : {}) });
  const onBorder = (lf: Rect, p: { c: number; r: number }) => p.c >= lf.x && p.c <= lf.x + lf.w - 1 && p.r >= lf.y && p.r <= lf.y + lf.h - 1 && (p.c === lf.x || p.c === lf.x + lf.w - 1 || p.r === lf.y || p.r === lf.y + lf.h - 1);
  // COURTYARD: a big compound (any type) turns its biggest back room into an open inner garden (grass +
  // fountain + varied flowers) — the loved "inner garden". The room must be BIG (area ≥42 AND min dim ≥6)
  // so it reads as an unmistakable OPEN garden, never a fountain crammed in a small room ("fountain
  // indoors"). A fountain is ONLY ever placed here, on grass.
  let courtyardIdx = -1;
  if (leaves.length >= 3 && rw * rh >= 120 && cv.rng() < 0.6) {
    let bestA = 41;
    for (let i = 1; i < leaves.length; i++) { const lf = leaves[i]!; const a = lf.w * lf.h; if (a > bestA && Math.min(lf.w, lf.h) >= 6) { bestA = a; courtyardIdx = i; } }
  }
  // L-SHAPE: otherwise a big compound sometimes cuts a NON-front CORNER room out to the exterior (a side
  // yard) → an L/T silhouette instead of a plain rectangle (the "buildings are only squares" complaint).
  // Reuses the room leaves; the cut corner opens to the street and gets planted by the town greenery pass.
  let notchIdx = -1;
  if (courtyardIdx < 0 && leaves.length >= 3 && rw * rh >= 110 && cv.rng() < 0.5) {
    const atCorner = (lf: Rect) => (lf.x === rx || lf.x + lf.w - 1 === rx + rw - 1) && (lf.y === ry || lf.y + lf.h - 1 === ry + rh - 1);
    let best = rw * rh * 0.36; // a modest corner cut, not the whole building
    for (let i = 1; i < leaves.length; i++) { const lf = leaves[i]!; const a = lf.w * lf.h; if (atCorner(lf) && a <= best) { best = a; notchIdx = i; } }
  }
  // DOORS — a wooden door sprite at the exterior entrance + every interior doorway (decorative, walkable).
  cv.ambiance.push({ tag: 'door_house', col: ed.dC, row: ed.dR });
  for (const dd of doors) cv.ambiance.push({ tag: 'door_house', col: dd.c, row: dd.r });
  const GARDEN = ['flowers', 'flowers_blue', 'flowers_yellow', 'flowers_red', 'bush', 'grass_tuft', 'mushroom', 'tree_oak', 'tree_autumn']; // varied garden planting
  leaves.forEach((lf, i) => {
    if (i === courtyardIdx) {
      for (let y = lf.y + 1; y < lf.y + lf.h - 1; y++) for (let x = lf.x + 1; x < lf.x + lf.w - 1; x++) { cv.set(x, y, 'grass', true); cv.occ[y]![x] = false; }
      place(cv, { id: `prop:${safe}-garden`, tag: 'fountain', kind: 'prop', at: { c: lf.x + Math.floor(lf.w / 2), r: lf.y + Math.floor(lf.h / 2) } });
      for (let y = lf.y + 1; y < lf.y + lf.h - 1; y++) for (let x = lf.x + 1; x < lf.x + lf.w - 1; x++) if (cv.isFree(x, y) && cv.rng() < 0.5) { const tag = GARDEN[Math.floor(cv.rng() * GARDEN.length)]!; cv.reserve(x, y); if (tag.startsWith('tree')) cv.walkable[y]![x] = false; cv.ambiance.push({ tag, col: x, row: y }); }
      return;
    }
    if (i === notchIdx) {
      // open this corner room to the exterior: remove its outer-ring walls + clear to grass (the interior
      // partition walls stay, so the neighbouring rooms remain enclosed) → an L footprint + a side yard.
      for (let y = lf.y; y < lf.y + lf.h; y++) for (let x = lf.x; x < lf.x + lf.w; x++) {
        const onOuter = x === rx || x === rx + rw - 1 || y === ry || y === ry + rh - 1;
        const strictInner = x > lf.x && x < lf.x + lf.w - 1 && y > lf.y && y < lf.y + lf.h - 1;
        if (onOuter || strictInner) { cv.set(x, y, 'grass', true); cv.occ[y]![x] = false; }
      }
      return;
    }
    const fn = program[Math.min(i, program.length - 1)]!;
    const tmpl: RoomTemplate = { ...ROOM_TEMPLATES[fn], floor, wall: mat, occupant: i === 0 ? base.occupant : '' };
    const d = doors.find((dd) => onBorder(lf, dd)) ?? (i === 0 ? { c: ed.dC, r: ed.dR } : { c: lf.x, r: lf.y });
    furnishRoom(cv.tiles, cv.walkable, cv.occ, cv.objects, lf, tmpl, d, cv.rng, cv.cols, `${safe}-r${i}`, `bldg:${safe}-r${i}`, 0, i === 0 ? opts.name : undefined);
  });
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
  const fits = (c: number, r: number) => {
    for (let dy = 0; dy < fp.h; dy++) for (let dx = 0; dx < fp.w; dx++) if (!cv.isFree(c + dx, r + dy)) return false;
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
  const blocks = o.kind === 'fixture' || (o.kind === 'prop' && (propDef(o.tag)?.blocks ?? true));
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
export function scatter(cv: Canvas, o: { idBase: string; tags: string[]; kind: 'prop' | 'actor'; role?: 'pc' | 'npc' | 'mob'; region: Rect; count: number }): void {
  let free = cv.shuffle(cellsOf(clampRect(cv, o.region)).filter((p) => cv.isFree(p.c, p.r)));
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
    if (!cv.isFree(c, r) || (o.filter && !o.filter(c, r))) continue;
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
    cellsOf(clampRect(cv, region)).filter((p) => cv.isFree(p.c, p.r) && field[p.r]![p.c]! > th && (!o.filter || o.filter(p.c, p.r))),
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
export function finalize(
  cv: Canvas,
  meta: { locationId: string; biome: string; lighting: Lighting; grammar: LayoutGrammar; outdoor: boolean; skipReachability?: boolean },
): SceneMap {
  // skipReachability: the component contact-sheet packs intentionally DISCONNECTED cells — carving
  // corridors between them would mangle the gallery. Real scenes leave it on (the rare safety net).
  if (!meta.skipReachability) reachabilityCarve(cv.tiles, cv.walkable, cv.cols, cv.rows, cv.objects, cv.entrances); // safety net; primitives are connectivity-correct so this rarely fires
  if (meta.outdoor) {
    scatterGroundDecals(cv.tiles, cv.walkable, cv.occ, cv.cols, cv.rows, cv.ambiance, cv.rng);
    bakeAutoTiles(cv.tiles, cv.cols, cv.rows);
  }
  return {
    locationId: meta.locationId,
    seed: cv.seed,
    biome: meta.biome,
    lighting: meta.lighting,
    grammar: meta.grammar,
    grid: { cols: cv.cols, rows: cv.rows, feetPerTile: FEET_PER_TILE },
    tiles: cv.tiles,
    walkable: cv.walkable,
    objects: cv.objects,
    ambiance: cv.ambiance,
    entrances: cv.entrances,
  };
}
