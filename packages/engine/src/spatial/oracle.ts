/**
 * SPATIAL TRUTH R1 — the oracle (docs/SPATIAL-TRUTH.md).
 *
 * A SpatialIndex DERIVED from frozen SceneMap bytes (never persisted, rebuilt on a version bump —
 * derive-don't-store, zero SceneMap schema changes): per-cell medium, walkable-region rooms with
 * indoor/outdoor from roof rasterization, opacity for line-of-sight, occupancy. Pure, RNG-free
 * queries answer distance / path / sight / where-is in FEET, so the DM narrates from truth instead
 * of inventing geography. Passability = walkable[][] (the published collision layer); swimming
 * EXTENDS passability over water tags at PHB double cost (p.182) — with caps.swim='none' the
 * traversable set is bit-identical to walkable[][] (the R0 parity clause).
 */

import type { EntityId, MapObject, SceneMap } from '@mythweaver/shared';

export type Medium = 'ground' | 'difficult' | 'water-shallow' | 'water-deep' | 'wall' | 'void';

/** Tag-prefix → medium. First matching prefix wins; unknown tags fall back to ground when walkable
 *  (safe default — a fidelity ticket, not a refusal) and void when not. Order matters. */
const TERRAIN_MEDIUM: [prefix: string, medium: Medium][] = [
  ['water_deep', 'water-deep'],
  ['water', 'water-shallow'],
  ['wall', 'wall'],
  ['swamp', 'difficult'],
  ['mud', 'difficult'],
  ['rubble', 'difficult'],
  ['snow_deep', 'difficult'],
  ['undergrowth', 'difficult'],
];

export interface RoomInfo {
  id: number;
  indoor: boolean;
  buildingId?: EntityId; // majority roof owner when indoor
  cells: number;
}

export interface SpatialIndex {
  locationId: string;
  cols: number;
  rows: number;
  feetPerTile: number;
  medium: Uint8Array; // Medium encoded (MEDIUM_CODE)
  opaque: Uint8Array; // 1 = blocks sight (wall tiles; doors/tall props join in later rungs)
  roomId: Int16Array; // walkable-region id, -1 = not walkable
  rooms: RoomInfo[];
  /** cell key (row*cols+col) → visible actor occupying it. */
  occupied: Map<number, EntityId>;
  /** cell key → owning building id, from roof-polygon rasterization. INDOOR IS CELL-GRAINED: a room
   *  connected to the outdoors through an open door would dilute any region-majority vote (the
   *  leaky-room failure), but a cell under a roof is indoors no matter what it connects to. */
  roofAt: Map<number, EntityId>;
  /** Unknown terrain tags encountered (fidelity tickets — safe-defaulted, never fatal). */
  unknownTags: string[];
}

export const MEDIUM_CODE: Record<Medium, number> = { ground: 0, difficult: 1, 'water-shallow': 2, 'water-deep': 3, wall: 4, void: 5 };
const CODE_MEDIUM: Medium[] = ['ground', 'difficult', 'water-shallow', 'water-deep', 'wall', 'void'];

export interface MoveCaps {
  speedFt: number;
  /** 'none' = water impassable (parity with walkable[][]); 'double-cost' = PHB swim (default for
   *  creatures without a swim speed); 'native' = swim speed (no penalty). */
  swim: 'none' | 'double-cost' | 'native';
  waterWalk?: boolean; // water priced as ground (spell effect — wired in R2)
  fly?: boolean; // v1: water priced as ground (full elevation is a later, whole-mechanic rung)
}
export const DEFAULT_CAPS: MoveCaps = { speedFt: 30, swim: 'double-cost' };

// --- build ------------------------------------------------------------------------------------

const RENDER_TILE_PX = 16; // roof polygons are authored in render pixels (16px tiles)

function mediumForTag(tag: string): Medium | undefined {
  for (const [prefix, m] of TERRAIN_MEDIUM) if (tag.startsWith(prefix)) return m;
  return undefined;
}

/** Point-in-polygon (ray cast) over a flat [x0,y0,x1,y1,...] ring. */
function inPoly(pts: number[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const xi = pts[i]!, yi = pts[i + 1]!, xj = pts[j]!, yj = pts[j + 1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function buildSpatialIndex(map: SceneMap): SpatialIndex {
  const { cols, rows } = map.grid;
  const n = cols * rows;
  const medium = new Uint8Array(n);
  const opaque = new Uint8Array(n);
  const roomId = new Int16Array(n).fill(-1);
  const unknown = new Set<string>();
  const walkableTags = new Set<string>(); // tags seen walkable ANYWHERE are known ground — their
  const memo = new Map<string, Medium | undefined>(); // blocked instances are object/wall-blocked, not unknown terrain
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (map.walkable?.[r]?.[c] === true) walkableTags.add(map.tiles?.[r]?.[c] ?? '');

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      const tag = map.tiles?.[r]?.[c] ?? '';
      const walk = map.walkable?.[r]?.[c] === true;
      let m = memo.has(tag) ? memo.get(tag) : (memo.set(tag, mediumForTag(tag)), memo.get(tag));
      if (m === undefined) {
        if (tag && !walk && !walkableTags.has(tag)) unknown.add(tag); // fidelity ticket: a tag that ONLY ever blocks
        m = walk ? 'ground' : tag.includes('water') ? 'water-deep' : 'void';
      }
      // A walkable cell is traversable GROUND regardless of its art (planks over water, a weir
      // walkway, a ford): walkable[][] is the published collision truth and we never contradict it.
      if (walk && (m === 'water-deep' || m === 'water-shallow' || m === 'wall' || m === 'void')) m = 'ground';
      medium[k] = MEDIUM_CODE[m];
      if (m === 'wall') opaque[k] = 1;
    }
  }

  // Rooms: connected components (4-neigh) of walkable cells. Water/walls break connectivity, so
  // each bank/room is its own region; indoor = majority roof coverage (rasterized cell centers).
  const roofOwner = new Map<number, string>(); // cell → building id
  for (const rb of map.roofs ?? []) {
    for (const f of rb.faces ?? []) {
      // bbox in cells to bound the scan
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < f.pts.length; i += 2) {
        minX = Math.min(minX, f.pts[i]!); maxX = Math.max(maxX, f.pts[i]!);
        minY = Math.min(minY, f.pts[i + 1]!); maxY = Math.max(maxY, f.pts[i + 1]!);
      }
      const c0 = Math.max(0, Math.floor(minX / RENDER_TILE_PX)), c1 = Math.min(cols - 1, Math.ceil(maxX / RENDER_TILE_PX));
      const r0 = Math.max(0, Math.floor(minY / RENDER_TILE_PX)), r1 = Math.min(rows - 1, Math.ceil(maxY / RENDER_TILE_PX));
      for (let r = r0; r <= r1; r++)
        for (let c = c0; c <= c1; c++)
          if (inPoly(f.pts, (c + 0.5) * RENDER_TILE_PX, (r + 0.5) * RENDER_TILE_PX)) roofOwner.set(r * cols + c, rb.id);
    }
  }
  const rooms: RoomInfo[] = [];
  const stack: number[] = [];
  for (let seed = 0; seed < n; seed++) {
    if (roomId[seed] !== -1) continue;
    const sr = Math.floor(seed / cols), sc = seed % cols;
    if (map.walkable?.[sr]?.[sc] !== true) continue;
    const id = rooms.length;
    let cells = 0;
    let roofed = 0;
    const owners = new Map<string, number>();
    stack.push(seed);
    roomId[seed] = id;
    while (stack.length) {
      const k = stack.pop()!;
      cells++;
      if (roofOwner.has(k)) {
        roofed++;
        const o = roofOwner.get(k)!;
        owners.set(o, (owners.get(o) ?? 0) + 1);
      }
      const r = Math.floor(k / cols), c = k % cols;
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        const nk = nr * cols + nc;
        if (roomId[nk] !== -1 || map.walkable?.[nr]?.[nc] !== true) continue;
        roomId[nk] = id;
        stack.push(nk);
      }
    }
    const indoor = roofed / cells >= 0.5;
    let buildingId: string | undefined;
    if (indoor && owners.size) buildingId = [...owners.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    rooms.push({ id, indoor, ...(buildingId ? { buildingId } : {}), cells });
  }

  const occupied = new Map<number, EntityId>();
  for (const o of map.objects ?? []) if (o.kind === 'actor' && o.visible !== false) occupied.set(o.row * cols + o.col, o.id);

  return { locationId: map.locationId, cols, rows, feetPerTile: map.grid.feetPerTile || 5, medium, opaque, roomId, rooms, occupied, roofAt: roofOwner, unknownTags: [...unknown] };
}

// --- cache (derive-don't-store: WeakMap keyed by the frozen map, version bumped by the engine) --

const versions = new WeakMap<SceneMap, number>();
const cache = new WeakMap<SceneMap, { v: number; idx: SpatialIndex }>();

/** Called by Engine.applySceneDeltas after any applied batch — full rebuild next read (<1ms). */
export function bumpSpatialVersion(map: SceneMap): void {
  versions.set(map, (versions.get(map) ?? 0) + 1);
}

export function spatialIndex(map: SceneMap): SpatialIndex {
  const v = versions.get(map) ?? 0;
  const hit = cache.get(map);
  if (hit && hit.v === v) return hit.idx;
  const idx = buildSpatialIndex(map);
  cache.set(map, { v, idx });
  return idx;
}

// --- queries ----------------------------------------------------------------------------------

export interface Cell { col: number; row: number }

export function distanceFt(idx: SpatialIndex, a: Cell, b: Cell): number {
  return Math.max(Math.abs(a.col - b.col), Math.abs(a.row - b.row)) * idx.feetPerTile; // Chebyshev ×5 (5e simple diagonals)
}

/** Can the actor ENTER this cell? walkable ground network, extended over water by swim caps. */
function enterCostHalfFt(idx: SpatialIndex, k: number, caps: MoveCaps): number | null {
  const m = CODE_MEDIUM[idx.medium[k]!]!;
  if (idx.roomId[k] !== -1) return m === 'difficult' ? 20 : 10; // walkable cell (5 ft; difficult ×2 PHB p.190)
  if (m === 'water-deep' || m === 'water-shallow') {
    if (caps.waterWalk || caps.fly) return 10; // priced as ground
    if (caps.swim === 'native') return 10;
    if (caps.swim === 'double-cost') return 20; // PHB p.182: each foot costs 2 without a swim speed
    return null;
  }
  return null; // wall/void — never
}

export interface PathOk {
  ok: true;
  cells: Cell[];
  totalFt: number;
  /** contiguous media legs, e.g. [{medium:'ground',ft:15},{medium:'water-deep',ft:20,swim:true}] */
  segments: { medium: Medium; ft: number; swimming?: boolean }[];
}
export interface PathBlocked {
  ok: false;
  blockedBy: 'deep-water' | 'no-route' | 'not-walkable-target';
  /** Farthest reachable cell toward the target — the frontier degrade (the actor can move THERE). */
  frontier?: Cell;
}
export type PathResult = PathOk | PathBlocked;

/** A* (octile-admissible: uniform Chebyshev heuristic at min cost) from a to NEAR b: the goal is b's
 *  cell if enterable+free, else any free enterable cell adjacent to b. Occupied cells are pass-through
 *  (5e allies) but not a destination. */
export function findPath(idx: SpatialIndex, from: Cell, to: Cell, caps: MoveCaps = DEFAULT_CAPS): PathResult {
  const { cols, rows } = idx;
  const key = (c: Cell) => c.row * cols + c.col;
  const goalKeys = new Set<number>();
  const toK = key(to);
  if (enterCostHalfFt(idx, toK, caps) !== null && !idx.occupied.has(toK)) goalKeys.add(toK);
  for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
    const r = to.row + dr, c = to.col + dc;
    if (r < 0 || r >= rows || c < 0 || c >= cols) continue;
    const k = r * cols + c;
    if (enterCostHalfFt(idx, k, caps) !== null && !idx.occupied.has(k)) goalKeys.add(k);
  }
  if (goalKeys.size === 0) return { ok: false, blockedBy: 'not-walkable-target' };

  const start = key(from);
  const g = new Map<number, number>([[start, 0]]);
  const cameFrom = new Map<number, number>();
  const open: [number, number][] = [[0, start]]; // [f, key] — small grids: array-heap is fine
  const h = (k: number) => Math.max(Math.abs((k % cols) - to.col), Math.abs(Math.floor(k / cols) - to.row)) * 10;
  let bestTowards = start;
  let bestH = h(start);

  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i]![0] < open[bi]![0]) bi = i;
    const [, cur] = open.splice(bi, 1)[0]!;
    if (goalKeys.has(cur)) {
      const cells: Cell[] = [];
      let k: number | undefined = cur;
      while (k !== undefined && k !== start) {
        cells.unshift({ col: k % cols, row: Math.floor(k / cols) });
        k = cameFrom.get(k);
      }
      const segments: PathOk['segments'] = [];
      let totalHalf = 0;
      for (const cell of cells) {
        const ck = key(cell);
        const cost = enterCostHalfFt(idx, ck, caps)!;
        totalHalf += cost;
        const m = idx.roomId[ck] !== -1 ? (CODE_MEDIUM[idx.medium[ck]!] === 'difficult' ? 'difficult' : 'ground') : CODE_MEDIUM[idx.medium[ck]!]!;
        const swimming = idx.roomId[ck] === -1 && (m === 'water-deep' || m === 'water-shallow') && !caps.waterWalk && !caps.fly;
        const last = segments[segments.length - 1];
        if (last && last.medium === m && !!last.swimming === swimming) last.ft += idx.feetPerTile;
        else segments.push({ medium: m as Medium, ft: idx.feetPerTile, ...(swimming ? { swimming: true } : {}) });
      }
      return { ok: true, cells, totalFt: (totalHalf / 10) * idx.feetPerTile, segments };
    }
    const cr = Math.floor(cur / cols), cc = cur % cols;
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      const nr = cr + dr, nc = cc + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const nk = nr * cols + nc;
      const cost = enterCostHalfFt(idx, nk, caps);
      if (cost === null) continue;
      const ng = g.get(cur)! + cost;
      if (ng < (g.get(nk) ?? Infinity)) {
        g.set(nk, ng);
        cameFrom.set(nk, cur);
        open.push([ng + h(nk), nk]);
        if (h(nk) < bestH) { bestH = h(nk); bestTowards = nk; }
      }
    }
  }
  // No route: report whether water was the wall, and hand back the frontier (closest approach).
  const frontier: Cell = { col: bestTowards % cols, row: Math.floor(bestTowards / cols) };
  const wouldSwim = caps.swim === 'none' && isReachable(idx, from, to, { ...caps, swim: 'double-cost' });
  return { ok: false, blockedBy: wouldSwim ? 'deep-water' : 'no-route', ...(bestTowards !== start ? { frontier } : {}) };
}

/** Cheap reachability probe (BFS, no path reconstruction) used only to classify a blockage. */
function isReachable(idx: SpatialIndex, from: Cell, to: Cell, caps: MoveCaps): boolean {
  const { cols, rows } = idx;
  const seen = new Uint8Array(cols * rows);
  const q: number[] = [from.row * cols + from.col];
  seen[q[0]!] = 1;
  const goal = to.row * cols + to.col;
  while (q.length) {
    const cur = q.shift()!;
    if (Math.max(Math.abs((cur % cols) - to.col), Math.abs(Math.floor(cur / cols) - to.row)) <= 1) return true;
    if (cur === goal) return true;
    const cr = Math.floor(cur / cols), cc = cur % cols;
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      const nr = cr + dr, nc = cc + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const nk = nr * cols + nc;
      if (seen[nk]) continue;
      if (enterCostHalfFt(idx, nk, caps) === null) continue;
      seen[nk] = 1;
      q.push(nk);
    }
  }
  return false;
}

/** Supercover Bresenham over the opacity mask. */
export function hasLineOfSight(idx: SpatialIndex, a: Cell, b: Cell): { clear: boolean; blockedAt?: Cell } {
  let x0 = a.col, y0 = a.row;
  const x1 = b.col, y1 = b.row;
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    if (!(x0 === a.col && y0 === a.row) && !(x0 === x1 && y0 === y1)) {
      if (idx.opaque[y0 * idx.cols + x0]) return { clear: false, blockedAt: { col: x0, row: y0 } };
    }
    if (x0 === x1 && y0 === y1) return { clear: true };
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
}

export interface WhereIs {
  cell: Cell;
  medium: Medium;
  indoor: boolean;
  buildingId?: EntityId;
  /** entity ids on the 8 neighboring cells (visible actors). */
  adjacent: EntityId[];
}

export function whereIs(idx: SpatialIndex, obj: Pick<MapObject, 'col' | 'row'>): WhereIs {
  const k = obj.row * idx.cols + obj.col;
  const buildingId = idx.roofAt.get(k);
  const adjacent: EntityId[] = [];
  for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
    const id = idx.occupied.get((obj.row + dr) * idx.cols + (obj.col + dc));
    if (id) adjacent.push(id);
  }
  return {
    cell: { col: obj.col, row: obj.row },
    medium: CODE_MEDIUM[idx.medium[k]!]!,
    indoor: buildingId !== undefined,
    ...(buildingId ? { buildingId } : {}),
    adjacent,
  };
}

/** In-scene rounds (6s) at effective speed; overland minutes at PHB travel pace. */
export function travelTime(totalFt: number, speedFt: number): { rounds: number; minutes: number } {
  const s = Math.max(5, speedFt);
  return { rounds: Math.ceil(totalFt / s), minutes: Math.round((totalFt / (s * 10)) * 10) / 10 };
}
