/**
 * The Cartographer (docs/SCENE-CONTRACTS.md, surface C) — the deterministic resolver that
 * turns a Director's semantic `SceneComposition` into a concrete, frozen `SceneMap`.
 *
 * Pure + seed-stable: same composition → byte-identical map. This is the consistency
 * guarantor — it owns ALL geometry (zones→tiles, anchors→positions, footprints, snapping,
 * ambiance scatter) so the LLMs never touch a coordinate. Output satisfies validateSceneMap
 * by construction (actors land on walkable tiles, fixtures never overlap, all in-bounds).
 */

import {
  FEET_PER_TILE,
  FIELD_LIMITS,
  type AmbianceItem,
  type Building,
  type BuildingType,
  type Entrance,
  type LayoutGrammar,
  type MapObject,
  type ObjectField,
  type Placement,
  type SceneComposition,
  type SceneMap,
} from '@mythweaver/shared';
import { isCharacter, propDef, terrainWalkable } from './catalog.js';

/**
 * Per-type interior furniture + an occupant. DawnLike decor is mostly 1×1, so a "counter" is a row
 * of tables — the engine places each as a single prop. `where`: back = top interior row; corner =
 * the interior corners; center = the middle; scatter = random free floor. Tags are catalog props;
 * occupants are catalog characters. This is what makes a room read as a lived-in shop/home/temple.
 */
interface FurnSpec {
  tag: string;
  where: 'back' | 'corner' | 'center' | 'scatter' | 'wall' | 'around';
  count?: number;
}
/**
 * Per-type room recipe: the floor + wall MATERIAL (warm wood for lived-in homes/shops/taverns, cold
 * stone for temples/smithies) + an occupant + a furniture list placed POSITION-AWARELY so the room
 * reads as authored: 'back' = a counter/altar along the back wall, 'wall' = goods hugging the walls,
 * 'around' = chairs ringing the central table, 'center'/'corner'/'scatter' as before. Items are
 * placed in order, so a 'center' table is laid before the chairs that ring it.
 */
export type RoomTemplate = { floor: string; wall: 'wood' | 'stone'; occupant: string; carpet?: boolean; items: FurnSpec[] };
export const BUILDING_TEMPLATES: Record<BuildingType, RoomTemplate> = {
  tavern: { floor: 'wood_floor', wall: 'wood', occupant: 'villager_woman', carpet: true, items: [{ tag: 'table', where: 'back', count: 3 }, { tag: 'table', where: 'center' }, { tag: 'chair', where: 'around', count: 3 }, { tag: 'barrel', where: 'corner', count: 2 }, { tag: 'candelabra', where: 'wall' }] },
  shop: { floor: 'wood_floor', wall: 'wood', occupant: 'villager', items: [{ tag: 'table', where: 'back', count: 2 }, { tag: 'shelf', where: 'wall', count: 3 }, { tag: 'crate', where: 'corner', count: 2 }, { tag: 'pot', where: 'wall' }] },
  temple: { floor: 'stone', wall: 'stone', occupant: 'wizard', carpet: true, items: [{ tag: 'altar', where: 'back' }, { tag: 'candelabra', where: 'back', count: 2 }, { tag: 'chair', where: 'around', count: 4 }, { tag: 'bookshelf', where: 'wall' }] },
  smithy: { floor: 'stone', wall: 'stone', occupant: 'dwarf', items: [{ tag: 'brazier', where: 'back' }, { tag: 'table', where: 'center' }, { tag: 'barrel', where: 'corner' }, { tag: 'crate', where: 'corner' }] },
  house: { floor: 'wood_floor', wall: 'wood', occupant: 'villager', items: [{ tag: 'bed', where: 'corner' }, { tag: 'table', where: 'center' }, { tag: 'chair', where: 'around', count: 2 }, { tag: 'pot', where: 'wall' }] },
};

/**
 * Per-ROOM-FUNCTION furniture recipes — the unit a multi-room building (`compound`) is composed from.
 * A building is no longer ONE open furnished box; its footprint is subdivided into rooms, each FURNISHED
 * BY FUNCTION so the interior reads as a real home/shop: a bedroom has beds, a kitchen has shelves +
 * barrels, a tavern bar has a back-wall counter, a temple nave has an altar + pews. floor/wall/occupant
 * are OVERRIDDEN per-building by `compound` (one material for the whole building, one keeper in the
 * primary room); only `carpet` + `items` are function-specific. Reuses the same FurnSpec selectors as
 * BUILDING_TEMPLATES (back = counter/altar along the back wall, around = seating ringing the centre).
 */
export type RoomFunction = 'bar' | 'dining' | 'kitchen' | 'bedroom' | 'storeroom' | 'shopfront' | 'parlor' | 'nave' | 'vestry' | 'forge';
export const ROOM_TEMPLATES: Record<RoomFunction, RoomTemplate> = {
  bar: { floor: 'wood_floor', wall: 'wood', occupant: 'villager_woman', items: [{ tag: 'table', where: 'back', count: 4 }, { tag: 'shelf_wares', where: 'back' }, { tag: 'barrel', where: 'corner', count: 2 }, { tag: 'crate', where: 'corner' }, { tag: 'candelabra', where: 'wall' }, { tag: 'chair', where: 'around', count: 2 }] },
  dining: { floor: 'wood_floor', wall: 'wood', occupant: '', carpet: true, items: [{ tag: 'table', where: 'center' }, { tag: 'chair', where: 'around', count: 4 }, { tag: 'candelabra', where: 'wall' }, { tag: 'barrel', where: 'corner' }] },
  kitchen: { floor: 'wood_floor', wall: 'wood', occupant: '', items: [{ tag: 'shelf_food', where: 'wall', count: 2 }, { tag: 'barrel', where: 'corner' }, { tag: 'sack', where: 'corner' }, { tag: 'pot', where: 'wall' }, { tag: 'woodpile', where: 'corner' }, { tag: 'table', where: 'center' }] },
  bedroom: { floor: 'wood_floor', wall: 'wood', occupant: '', items: [{ tag: 'bed', where: 'corner' }, { tag: 'bed_blue', where: 'corner' }, { tag: 'chair', where: 'around' }, { tag: 'shelf', where: 'wall' }, { tag: 'pot', where: 'wall' }] },
  storeroom: { floor: 'wood_floor', wall: 'wood', occupant: '', items: [{ tag: 'crate', where: 'corner', count: 2 }, { tag: 'barrel', where: 'corner', count: 2 }, { tag: 'sack', where: 'wall', count: 2 }, { tag: 'shelf', where: 'wall' }, { tag: 'woodpile', where: 'corner' }] },
  shopfront: { floor: 'wood_floor', wall: 'wood', occupant: 'villager', items: [{ tag: 'table', where: 'back', count: 2 }, { tag: 'shelf_wares', where: 'wall', count: 2 }, { tag: 'shelf_food', where: 'wall' }, { tag: 'crate', where: 'corner' }, { tag: 'pot', where: 'wall' }] },
  parlor: { floor: 'wood_floor', wall: 'wood', occupant: 'villager', carpet: true, items: [{ tag: 'table', where: 'center' }, { tag: 'chair', where: 'around', count: 2 }, { tag: 'bookshelf', where: 'wall' }, { tag: 'pot', where: 'wall' }, { tag: 'candelabra', where: 'wall' }] },
  nave: { floor: 'stone', wall: 'stone', occupant: 'wizard', carpet: true, items: [{ tag: 'altar', where: 'back' }, { tag: 'candelabra', where: 'back', count: 2 }, { tag: 'stone_bench', where: 'around', count: 4 }, { tag: 'bookshelf', where: 'wall' }] },
  vestry: { floor: 'stone', wall: 'stone', occupant: '', items: [{ tag: 'bookshelf', where: 'wall', count: 2 }, { tag: 'desk', where: 'center' }, { tag: 'chair', where: 'around' }, { tag: 'candle', where: 'wall' }] },
  forge: { floor: 'stone', wall: 'stone', occupant: 'dwarf', items: [{ tag: 'brazier', where: 'back' }, { tag: 'table', where: 'center' }, { tag: 'weapon_rack', where: 'wall' }, { tag: 'barrel', where: 'corner' }, { tag: 'crate', where: 'corner' }, { tag: 'woodpile', where: 'corner' }] },
};

/** Per-building-type ROOM PROGRAM: the ordered room functions a compound contains. Index 0 is the
 *  PRIMARY (front) room — it gets the keeper + the entrance. Truncated to however many rooms the
 *  footprint subdivides into (a small cottage = just its primary room). */
export const ROOM_PROGRAMS: Record<BuildingType, RoomFunction[]> = {
  tavern: ['bar', 'dining', 'kitchen', 'bedroom'],
  shop: ['shopfront', 'storeroom', 'kitchen'],
  temple: ['nave', 'vestry', 'bedroom'],
  smithy: ['forge', 'storeroom', 'kitchen'],
  house: ['parlor', 'bedroom', 'kitchen'],
};

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Pick a faced wall AUTO-TILE by which edges of a rectangular wall border this cell sits on (top/
 *  bottom/left/right). A 1-cell wall ring has floor on both sides, so neighbour-connectivity alone
 *  can't tell interior from exterior — but the Cartographer knows the rect, so it assigns the right
 *  faced tile directly. Falls back to the plain fill 'wall' for non-border / interior-pillar cells. */
export function wallTagFor(top: boolean, bot: boolean, left: boolean, right: boolean, mat: 'wood' | 'stone' = 'stone'): string {
  const b = mat === 'wood' ? 'wall_wood' : 'wall';
  if (top && left) return `${b}_tl`;
  if (top && right) return `${b}_tr`;
  if (bot && left) return `${b}_bl`;
  if (bot && right) return `${b}_br`;
  if (top) return `${b}_t`;
  if (bot) return `${b}_b`;
  if (left) return `${b}_l`;
  if (right) return `${b}_r`;
  return b;
}

/** C1 terrain auto-tile: the faithful DawnLike 9-tile OUTER set, keyed by which sides are EXPOSED
 *  (border a different terrain family). One exposed side → that edge; two ADJACENT → that corner;
 *  surrounded, an opposite-pair strip, or 3+ exposed → '' (centre — DawnLike ships no inner corners). */
function edgeSuffix(eN: boolean, eE: boolean, eS: boolean, eW: boolean): string {
  const n = (eN ? 1 : 0) + (eE ? 1 : 0) + (eS ? 1 : 0) + (eW ? 1 : 0);
  if (n === 1) return eN ? '_t' : eS ? '_b' : eW ? '_l' : '_r';
  if (n === 2) {
    if (eN && eW) return '_tl';
    if (eN && eE) return '_tr';
    if (eS && eW) return '_bl';
    if (eS && eE) return '_br';
  }
  return '';
}

/** Deterministic PRNG (mulberry32) — reproducible from the scene seed. */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Reusable post-processing passes — extracted from buildSceneMap (which still calls them, behavior
// unchanged) so the city stitcher (city.ts) can run them ONCE on an ASSEMBLED multi-district grid.
// Each MUTATES its array args in place.
// ---------------------------------------------------------------------------

/** C1 terrain auto-tile bake: give every EDGED-family cell (grass / water / water_deep) the right
 *  DawnLike edge tile for which sides border a DIFFERENT family. Off-grid neighbours count as SAME
 *  (the screen border doesn't fringe). Pure read of a snapshot → writes `${base}${suffix}`; never
 *  touches walkable (an *_edge tile shares its base's walkability). Idempotent on already-baked tags
 *  only insofar as *_edge tags aren't EDGED — so re-baking a stitched grid needs base tags (see
 *  city.ts, which strips suffixes before calling this). */
export function bakeAutoTiles(tiles: string[][], cols: number, rows: number): void {
  const FAMILY: Record<string, string> = { grass: 'grass', water: 'water', water_deep: 'water', lava: 'lava' };
  const EDGED = new Set(['grass', 'water', 'water_deep', 'lava']);
  const orig = tiles.map((row) => row.slice());
  const famOf = (t: string) => FAMILY[t] ?? t;
  const sameFam = (c: number, r: number, f: string) => c < 0 || r < 0 || c >= cols || r >= rows || famOf(orig[r]![c]!) === f;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const base = orig[r]![c]!;
      if (!EDGED.has(base)) continue;
      const f = famOf(base);
      const suf = edgeSuffix(!sameFam(c, r - 1, f), !sameFam(c + 1, r, f), !sameFam(c, r + 1, f), !sameFam(c - 1, r, f));
      if (suf) tiles[r]![c] = `${base}${suf}`;
    }
}

/** WOOD-WALL autotile: re-tile every `wall_wood*` cell from its 4-neighbour wall mask (N=1,E=2,S=4,W=8)
 *  using the VERIFIED DawnLike block — so edges, corners, interior partitions AND L-shaped footprints all
 *  get the right faced tile by construction (not a rect-edge guess). Reads a snapshot; idempotent. */
export function bakeWoodWalls(tiles: string[][], cols: number, rows: number): void {
  const orig = tiles.map((row) => row.slice());
  const wall = (c: number, r: number) => c >= 0 && r >= 0 && c < cols && r < rows && (orig[r]![c] ?? '').startsWith('wall_wood');
  const TAG: Record<number, string> = {
    6: 'wall_wood_tl', 12: 'wall_wood_tr', 3: 'wall_wood_bl', 9: 'wall_wood_br', // corners: E+S, S+W, N+E, N+W
    5: 'wall_wood_l', 1: 'wall_wood_l', 4: 'wall_wood_l', 7: 'wall_wood_l', 13: 'wall_wood_l', // vertical runs
    10: 'wall_wood_t', 2: 'wall_wood_t', 8: 'wall_wood_t', 11: 'wall_wood_t', 14: 'wall_wood_t', // horizontal runs
  };
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      if (!wall(c, r)) continue;
      const mask = (wall(c, r - 1) ? 1 : 0) | (wall(c + 1, r) ? 2 : 0) | (wall(c, r + 1) ? 4 : 0) | (wall(c - 1, r) ? 8 : 0);
      tiles[r]![c] = TAG[mask] ?? 'wall_wood'; // 0 (isolated) / 15 (surrounded) → solid fill
    }
}

/** C2 ground decals: a light, NON-blocking scatter of pebbles + grass tufts on free open natural
 *  ground (grass/dirt/sand). Reserves each chosen cell in `occ`; leaves walkable untouched (decals
 *  are walkable). Pushes AmbianceItems. Seed via `rand` so it's reproducible. */
export function scatterGroundDecals(tiles: string[][], walkable: boolean[][], occ: boolean[][], cols: number, rows: number, ambiance: AmbianceItem[], rand: () => number): void {
  const open: { c: number; r: number }[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (walkable[r]![c] === true && occ[r]![c] === false && /^(grass|dirt|sand)$/.test(tiles[r]![c]!)) open.push({ c, r });
  for (let i = open.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = open[i]!; open[i] = open[j]!; open[j] = t; }
  const DECALS = ['pebble', 'pebble', 'grass_tuft'] as const;
  const cap = Math.min(open.length, 60, Math.max(4, Math.floor(open.length * 0.08)));
  for (let i = 0; i < cap; i++) {
    const cell = open[i]!;
    occ[cell.r]![cell.c] = true; // reserve; decals are walkable (blocks:false) so DON'T clear walkable
    ambiance.push({ tag: DECALS[Math.floor(rand() * DECALS.length)]!, col: cell.c, row: cell.r });
  }
}

/** Global reachability guard: BFS the walkable graph from a PC (or the bottom-left open cell); for any
 *  actor/entrance cut off from it, carve an L-shaped corridor (opening walls → dirt) to the nearest
 *  reachable cell. UNCONDITIONAL — the caller decides whether it's needed (buildSceneMap gates it on
 *  buildings existing; the city always has cross-district gaps to bridge). */
export function reachabilityCarve(tiles: string[][], walkable: boolean[][], cols: number, rows: number, objects: MapObject[], entrances: Entrance[]): void {
  const ORTH4 = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  const inB = (c: number, r: number) => c >= 0 && c < cols && r >= 0 && r < rows;
  const idx = (c: number, r: number) => r * cols + c;
  const bfs = (start: { c: number; r: number }): Set<number> => {
    const seen = new Set<number>();
    if (!inB(start.c, start.r) || !walkable[start.r]![start.c]) return seen;
    const q = [start];
    seen.add(idx(start.c, start.r));
    while (q.length) {
      const cur = q.shift()!;
      for (const [dx, dy] of ORTH4) {
        const cc = cur.c + dx, rr = cur.r + dy;
        if (inB(cc, rr) && walkable[rr]![cc] && !seen.has(idx(cc, rr))) { seen.add(idx(cc, rr)); q.push({ c: cc, r: rr }); }
      }
    }
    return seen;
  };
  let start: { c: number; r: number } | null = null;
  for (const o of objects) if (o.role === 'pc' && walkable[o.row]?.[o.col]) { start = { c: o.col, r: o.row }; break; }
  if (!start) for (let r = rows - 1; r >= 0 && !start; r--) for (let c = 0; c < cols && !start; c++) if (walkable[r]![c]) start = { c, r };
  if (!start) return;
  let reach = bfs(start);
  const carve = (from: { c: number; r: number }, to: { c: number; r: number }): void => {
    let c = from.c, r = from.r;
    const open = (): void => { if (inB(c, r)) { walkable[r]![c] = true; if (tiles[r]![c]!.startsWith('wall')) tiles[r]![c] = 'dirt'; } };
    open();
    while (c !== to.c) { c += c < to.c ? 1 : -1; open(); }
    while (r !== to.r) { r += r < to.r ? 1 : -1; open(); }
  };
  const targets = [...objects.filter((o) => o.kind === 'actor').map((o) => ({ c: o.col, r: o.row })), ...entrances.map((e2) => ({ c: e2.col, r: e2.row }))];
  for (const t of targets) {
    if (reach.has(idx(t.c, t.r))) continue;
    let best: { c: number; r: number } | null = null;
    let bestD = Infinity;
    for (const k of reach) { const c = k % cols, r = (k - c) / cols; const d = Math.abs(c - t.c) + Math.abs(r - t.r); if (d < bestD) { bestD = d; best = { c, r }; } }
    if (best) { carve(t, best); reach = bfs(start); }
  }
}

/**
 * Furnish a carved room's interior from a per-type template: an optional carpet centrepiece, position-
 * aware furniture (back/corner/center/wall/around), and a seated keeper — keeping the door's inner cell
 * clear and ≥half the floor walkable. MUTATES the arrays; returns the updated furniture sequence so ids
 * stay globally unique. Extracted from carveBuildings so BOTH the classic path AND the primitive engine
 * furnish rooms IDENTICALLY (the module-engine restore). `door` is a cell on the rect border (keepClear
 * derives the inner-door cell from it); pass a cell outside the rect to skip the forced clear. */
export function furnishRoom(
  tiles: string[][],
  walkable: boolean[][],
  occ: boolean[][],
  objects: MapObject[],
  rect: Rect,
  tmpl: RoomTemplate,
  door: { c: number; r: number },
  rand: () => number,
  cols: number,
  safe: string,
  groupId: string,
  seqStart: number,
  name?: string,
): number {
  let furnSeq = seqStart;
  const { x: rx, y: ry, w: rw, h: rh } = rect;
  const midX = rx + Math.floor(rw / 2);
  const midY = ry + Math.floor(rh / 2);
  const ix = rx + 1, iy = ry + 1, iw = rw - 2, ih = rh - 2;
  if (iw < 1 || ih < 1) return furnSeq;
  const inB = (c: number, r: number) => r >= 0 && r < tiles.length && c >= 0 && c < (tiles[0]?.length ?? 0);
  const interior: { c: number; r: number }[] = [];
  for (let y = iy; y < iy + ih; y++) for (let x = ix; x < ix + iw; x++) interior.push({ c: x, r: y });
  for (let i = interior.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = interior[i]!; interior[i] = interior[j]!; interior[j] = t; }
  // CARPET centrepiece (tavern/temple): a 3×3 rug centred in the interior, laid AS TERRAIN so it renders UNDER the furniture/keeper.
  if (tmpl.carpet && iw >= 3 && ih >= 3) {
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const cc = midX + dx, rr = midY + dy;
        if (cc < ix || cc > ix + iw - 1 || rr < iy || rr > iy + ih - 1) continue;
        const vparts = dy < 0 ? 't' : dy > 0 ? 'b' : '';
        const hparts = dx < 0 ? 'l' : dx > 0 ? 'r' : '';
        tiles[rr]![cc] = vparts || hparts ? `carpet_${vparts}${hparts}` : 'carpet_c';
      }
  }
  const dR = door.r, dC = door.c;
  const innerDoor = dR === ry ? { c: dC, r: dR + 1 } : dR === ry + rh - 1 ? { c: dC, r: dR - 1 } : dC === rx ? { c: dC + 1, r: dR } : { c: dC - 1, r: dR };
  const keepClear = innerDoor.r * cols + innerDoor.c;
  const budget = Math.max(1, Math.floor((iw * ih) / 2)); // leave ≥half the floor walkable
  const byBack = (cells: { c: number; r: number }[]) => cells.filter((c) => c.r === iy);
  const byCorner = (cells: { c: number; r: number }[]) => cells.filter((c) => (c.c === ix || c.c === ix + iw - 1) && (c.r === iy || c.r === iy + ih - 1));
  const byCenter = (cells: { c: number; r: number }[]) => [...cells].sort((a, z) => Math.abs(a.c - midX) + Math.abs(a.r - midY) - (Math.abs(z.c - midX) + Math.abs(z.r - midY)));
  const byWall = (cells: { c: number; r: number }[]) => cells.filter((c) => c.r === iy || c.r === iy + ih - 1 || c.c === ix || c.c === ix + iw - 1);
  const around = (cells: { c: number; r: number }[]) => cells.filter((c) => Math.max(Math.abs(c.c - midX), Math.abs(c.r - midY)) === 1);
  const takeCell = (pref?: (cells: { c: number; r: number }[]) => { c: number; r: number }[]): { c: number; r: number } | null => {
    for (const cell of pref ? pref(interior) : interior) {
      if (cell.r * cols + cell.c === keepClear) continue;
      if (!inB(cell.c, cell.r) || occ[cell.r]![cell.c] || !walkable[cell.r]![cell.c]) continue;
      return cell;
    }
    return null;
  };
  // Placement FALLBACK CHAINS — a wall-hugging item that can't get its preferred slot falls back to
  // OTHER WALL cells, never to the middle of the room (that was the "beds in the middle of nowhere" /
  // "bookshelf anywhere" bug). Only center/around/scatter items may sit out in the floor.
  const CHAINS: Record<string, ((cells: { c: number; r: number }[]) => { c: number; r: number }[])[]> = {
    back: [byBack, byWall],
    corner: [byCorner, byWall],
    wall: [byWall],
    around: [around, byCenter],
    center: [byCenter],
    scatter: [],
  };
  const freeFloor = (item: FurnSpec): boolean => item.where === 'center' || item.where === 'around' || item.where === 'scatter';
  let placedFurn = 0;
  for (const item of tmpl.items) {
    for (let k = 0; k < (item.count ?? 1); k++) {
      if (placedFurn >= budget) break;
      let cell: { c: number; r: number } | null = null;
      for (const sel of CHAINS[item.where] ?? []) { cell = takeCell(sel); if (cell) break; }
      if (!cell && freeFloor(item)) cell = takeCell(); // tables/chairs/clutter may use open floor; wall items may NOT
      if (!cell) break;
      occ[cell.r]![cell.c] = true; // reserve so nothing else lands here
      if (propDef(item.tag)?.blocks ?? true) walkable[cell.r]![cell.c] = false; // only blocking furniture blocks pathing
      objects.push({ id: `prop:${safe}#${(furnSeq++).toString().padStart(2, '0')}`, kind: 'prop', tag: item.tag, col: cell.c, row: cell.r, footprint: { w: 1, h: 1 }, facing: 'down', visible: true, group: groupId });
      placedFurn++;
    }
  }
  const occCell = tmpl.occupant ? takeCell(byCenter) : null; // empty occupant → no keeper (multi-room compounds put ONE keeper in the primary room only)
  if (occCell) {
    occ[occCell.r]![occCell.c] = true; // reserve (actor doesn't block walkable)
    // The keeper is an individually-addressable NPC (NOT grouped) so the DM digest keeps its id/name/position.
    objects.push({ id: `npc:${safe}-keeper`, kind: 'actor', role: 'npc', tag: isCharacter(tmpl.occupant) ? tmpl.occupant : 'villager', ...(name ? { name } : {}), col: occCell.c, row: occCell.r, footprint: { w: 1, h: 1 }, facing: 'down', visible: true });
  }
  return furnSeq;
}

/** Map each grammar zone to a grid rectangle. Simple + deterministic; refine per grammar later. */
function zoneRects(grammar: LayoutGrammar, cols: number, rows: number): Record<string, Rect> {
  if (grammar === 'enclosed-interior') {
    return {
      wall: { x: 0, y: 0, w: cols, h: rows },
      floor: { x: 1, y: 1, w: cols - 2, h: rows - 2 },
      back: { x: 1, y: 1, w: cols - 2, h: Math.max(1, Math.floor((rows - 2) * 0.4)) },
      entrance: { x: Math.max(1, Math.floor(cols / 2) - 1), y: rows - 2, w: 3, h: 1 },
    };
  }
  if (grammar === 'town-square') {
    const waterH = Math.max(2, Math.floor(rows * 0.16)); // the sea along the bottom
    const topH = Math.max(2, Math.floor(rows * 0.16)); // a band where houses line the back
    const plazaY = topH + 1;
    const plazaH = Math.max(2, rows - waterH - topH - 2);
    const plaza: Rect = { x: 2, y: plazaY, w: cols - 4, h: plazaH };
    const cx = Math.floor(cols / 2);
    const cy = plazaY + Math.floor(plazaH / 2);
    return {
      perimeter: { x: 0, y: 0, w: cols, h: rows },
      'building-row': { x: 1, y: 1, w: cols - 2, h: topH }, // houses along the top
      plaza,
      commons: plaza,
      center: { x: cx - 1, y: cy - 1, w: 2, h: 2 }, // fountain / landmark slot
      'market-row': { x: plaza.x + 1, y: plaza.y + plaza.h - 1, w: plaza.w - 2, h: 1 }, // a line of stalls
      street: { x: cx - 1, y: 0, w: 3, h: rows - waterH }, // a road through the square
      waterside: { x: 0, y: rows - waterH, w: cols, h: waterH },
    };
  }
  // open-outdoor
  const waterH = Math.max(2, Math.floor(rows * 0.22));
  const topH = Math.max(2, Math.floor(rows * 0.18));
  return {
    waterside: { x: 0, y: rows - waterH, w: cols, h: waterH },
    'building-row': { x: 1, y: 1, w: cols - 2, h: topH },
    path: { x: Math.max(1, Math.floor(cols / 2) - 1), y: 0, w: 3, h: rows - waterH },
    commons: { x: 2, y: topH + 1, w: cols - 4, h: Math.max(1, rows - waterH - topH - 2) },
    perimeter: { x: 0, y: 0, w: cols, h: topH },
  };
}

/** Blockout region char → terrain tag (+ whether it's a dense-forest cell). Unknown → grass. */
const BLOCKOUT_REGION: Record<string, { terrain: string; forest?: boolean }> = {
  G: { terrain: 'grass' },
  P: { terrain: 'dirt' },
  W: { terrain: 'water' },
  D: { terrain: 'water_deep' },
  A: { terrain: 'sand' },
  T: { terrain: 'grass', forest: true },
  S: { terrain: 'stone' },
  '#': { terrain: 'wall' },
};
export function buildSceneMap(comp: SceneComposition): SceneMap {
  const cols = Math.max(1, comp.grid.cols);
  const rows = Math.max(1, comp.grid.rows);
  const rand = makeRng(comp.seed);
  const zones = zoneRects(comp.grammar, cols, rows);
  // The Director painted a coarse map — render FROM it (orientation, treelines, sides, rooms)
  // instead of the semantic zones, which can't carry composition. Every scene kind can be painted.
  const useBlockout = !!comp.blockout && comp.blockout.grid.length > 0;
  const isInterior = comp.grammar === 'enclosed-interior';

  // 1) Terrain layer.
  let tiles: string[][];
  const forestCells: { c: number; r: number }[] = [];
  if (useBlockout) {
    const bg = comp.blockout!.grid;
    tiles = Array.from({ length: rows }, (_, y) =>
      Array.from({ length: cols }, (_, x) => {
        const ch = (bg[y]?.[x] ?? 'G').toUpperCase();
        const reg = BLOCKOUT_REGION[ch] ?? BLOCKOUT_REGION['G']!;
        if (reg.forest && !isInterior) forestCells.push({ c: x, r: y });
        return reg.terrain;
      }),
    );
    // Interior safety: a roofed room must be a CLOSED box. Force the outer ring to wall (the Director
    // sometimes leaves a gap) and normalise interior ground to stone floor — keeping any walls/pillars
    // it painted, but never grass/water/trees indoors.
    if (isInterior) {
      for (let y = 0; y < rows; y++)
        for (let x = 0; x < cols; x++) {
          if (x === 0 || y === 0 || x === cols - 1 || y === rows - 1) tiles[y]![x] = wallTagFor(y === 0, y === rows - 1, x === 0, x === cols - 1);
          else if (tiles[y]![x] !== 'wall') tiles[y]![x] = 'stone';
        }
      if (rows > 2 && cols > 2) tiles[Math.floor(rows / 2)]![Math.floor(cols / 2)] = 'stone'; // guarantee floor
    }
  } else {
    // base everywhere, then paint each region's zone rect (in order).
    tiles = Array.from({ length: rows }, () => Array.from({ length: cols }, () => comp.terrain.base));
    for (const region of comp.terrain.regions) {
      const r = zones[region.zone];
      if (!r) continue;
      for (let y = r.y; y < r.y + r.h; y++)
        for (let x = r.x; x < r.x + r.w; x++) {
          const row = tiles[y];
          if (row && x >= 0 && x < cols && y >= 0 && y < rows) row[x] = region.tag;
        }
    }
    // An enclosed interior is a walled room: force a non-walkable border ring and a WALKABLE floor
    // inside — regardless of the order the Director sent terrain regions. (The 'wall' zone spans the
    // whole grid, so a late wall paint would otherwise bury the floor and leave nowhere to stand,
    // collapsing every placement onto one cell.)
    if (comp.grammar === 'enclosed-interior') {
      const floorTag = terrainWalkable(comp.terrain.base) ? comp.terrain.base : 'stone';
      for (let y = 0; y < rows; y++)
        for (let x = 0; x < cols; x++) {
          if (x === 0 || y === 0 || x === cols - 1 || y === rows - 1) tiles[y]![x] = wallTagFor(y === 0, y === rows - 1, x === 0, x === cols - 1);
          else if (!terrainWalkable(tiles[y]![x]!)) tiles[y]![x] = floorTag;
        }
    }
  }
  // Index forest cells for boundary-aware effects (feathering + shoreline).
  const fkey = (c: number, r: number) => r * cols + c;
  const forestSet = new Set(forestCells.map((c) => fkey(c.c, c.r)));

  // Shoreline: where open LAND meets water, lay a 1-tile SAND strip so the waterline reads as a real
  // beach instead of a hard grass↔water seam. Also CAPTURE those cells as the `shore` region so object
  // fields ("crates along the sandy shore") can bind to the true waterline — which RINGS an island, not
  // just the bottom edge. Existing tiles only (sand is a flat gen tile).
  const shoreCells: { c: number; r: number }[] = [];
  const isWaterTile = (t: string | undefined): boolean => t === 'water' || t === 'water_deep';
  if (!isInterior) {
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++) {
        if (tiles[y]![x] !== 'grass' || forestSet.has(fkey(x, y))) continue;
        const nearWater = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).some(([dx, dy]) => isWaterTile(tiles[y + dy]?.[x + dx]));
        if (nearWater) shoreCells.push({ c: x, r: y });
      }
    for (const { c, r } of shoreCells) tiles[r]![c] = 'sand';
  }

  const walkable: boolean[][] = tiles.map((row) => row.map((t) => terrainWalkable(t)));
  const occ: boolean[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => false));

  // Forest fill with FEATHERED density: dense at the forest's core, thinning toward the clearing, with
  // bushy undergrowth at the fringe + a little spill into the open — so a treeline reads as a natural
  // mass, not a flat rectangle. depth = steps from the nearest OPEN (non-forest) cell; the map border
  // does NOT count as open, so a treeline at the screen edge stays dense there.
  const forestAmbiance: AmbianceItem[] = [];
  if (useBlockout && forestCells.length) {
    const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
    const depth = new Map<number, number>();
    let frontier: { c: number; r: number }[] = [];
    for (const fc of forestCells) {
      let fringe = false;
      for (let dy = -1; dy <= 1 && !fringe; dy++)
        for (let dx = -1; dx <= 1 && !fringe; dx++) {
          if (!dx && !dy) continue;
          const nx = fc.c + dx, ny = fc.r + dy;
          if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && !forestSet.has(fkey(nx, ny))) fringe = true; // touches open ground
        }
      if (fringe) { depth.set(fkey(fc.c, fc.r), 1); frontier.push(fc); }
    }
    for (let d = 1; frontier.length; d++) {
      const next: { c: number; r: number }[] = [];
      for (const fc of frontier)
        for (const [dx, dy] of ORTH) {
          const nx = fc.c + dx, ny = fc.r + dy, k = fkey(nx, ny);
          if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && forestSet.has(k) && !depth.has(k)) { depth.set(k, d + 1); next.push({ c: nx, r: ny }); }
        }
      frontier = next;
    }
    const CORE = ['tree', 'tree', 'tree_pine', 'tree_pine', 'tree_autumn'] as const;
    const FRINGE = ['bush', 'bush', 'tree', 'tree_autumn'] as const;
    for (const fc of forestCells) {
      const dep = depth.get(fkey(fc.c, fc.r)) ?? 3;
      const density = dep >= 3 ? 0.95 : dep === 2 ? 0.8 : 0.4; // feather toward the clearing
      if (rand() >= density) continue;
      const pool = dep <= 1 ? FRINGE : CORE;
      forestAmbiance.push({ tag: pool[Math.floor(rand() * pool.length)]!, col: fc.c, row: fc.r });
      walkable[fc.r]![fc.c] = false; // forest is a barrier
    }
    // A little undergrowth creeps from the treeline into the open, softening the hard edge. Decorative
    // (the tile stays walkable for pathing) but reserved from entity placement so no one stands in a bush.
    const spilled = new Set<number>();
    for (const fc of forestCells)
      for (const [dx, dy] of ORTH) {
        const nx = fc.c + dx, ny = fc.r + dy, k = fkey(nx, ny);
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        if (forestSet.has(k) || spilled.has(k) || tiles[ny]![nx] !== 'grass') continue;
        if (rand() < 0.15) { forestAmbiance.push({ tag: 'bush', col: nx, row: ny }); occ[ny]![nx] = true; spilled.add(k); }
      }
  }

  const inB = (c: number, r: number) => c >= 0 && c < cols && r >= 0 && r < rows;
  const free = (c: number, r: number) => inB(c, r) && walkable[r]![c] === true && occ[r]![c] === false;
  const footFits = (c: number, r: number, w: number, h: number) => {
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) if (!free(c + dx, r + dy)) return false;
    return true;
  };

  /** Cells of a rect, shuffled by seed (so placement is varied but reproducible). */
  const cellsOf = (rect: Rect): { c: number; r: number }[] => {
    const cells: { c: number; r: number }[] = [];
    for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) if (inB(x, y)) cells.push({ c: x, r: y });
    for (let i = cells.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = cells[i]!;
      cells[i] = cells[j]!;
      cells[j] = tmp;
    }
    return cells;
  };

  const footprintOf = (tag: string, kind: string): { w: number; h: number } => {
    if (kind === 'fixture') {
      const d = propDef(tag);
      return { w: d?.w ?? 1, h: d?.h ?? 1 };
    }
    return { w: 1, h: 1 }; // props + actors are 1x1 for now
  };

  const placedPos = new Map<string, { c: number; r: number }>();
  const placedCells: { c: number; r: number; kind: string }[] = []; // for anti-cluster spacing
  const ADJ = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [-1, -1],
    [1, -1],
    [-1, 1],
  ] as const;

  // Nearest in-bounds cell that fits the footprint to a target point — resolve OUTWARD from the
  // ideal, so an absolute anchor like 'center' lands at the center even when the exact cell is taken.
  const nearestFit = (tc: number, tr: number, fp: { w: number; h: number }): { c: number; r: number } | null => {
    let best: { c: number; r: number } | null = null;
    let bestD = Infinity;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        if (!footFits(c, r, fp.w, fp.h)) continue;
        const d = (c - tc) * (c - tc) + (r - tr) * (r - tr);
        if (d < bestD) {
          bestD = d;
          best = { c, r };
        }
      }
    return best;
  };

  const cxC = (cols - 1) / 2;
  const cyC = (rows - 1) / 2;

  // A cell that is GUARANTEED placeable: the nearest free walkable fit; or, only if the map is
  // genuinely full (no free fitting cell anywhere), carve a walkable spot at the target so an actor
  // never lands inside a wall/fixture. The carve is a last-resort for a degenerate, over-full scene.
  const guaranteedCell = (tc: number, tr: number, fp: { w: number; h: number }): { c: number; r: number } => {
    const hit = nearestFit(tc, tr, fp);
    if (hit) return hit;
    // No free fitting cell anywhere. Carve the nearest UNOCCUPIED cell walkable — never an occupied one,
    // so we don't stack two objects on a tile (degenerate, only when the map is essentially full).
    let best: { c: number; r: number } | null = null;
    let bestD = Infinity;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        if (occ[r]![c]) continue;
        const d = (c - tc) * (c - tc) + (r - tr) * (r - tr);
        if (d < bestD) { bestD = d; best = { c, r }; }
      }
    const cell = best ?? { c: Math.max(0, Math.min(cols - 1, Math.round(tc))), r: Math.max(0, Math.min(rows - 1, Math.round(tr))) };
    if (inB(cell.c, cell.r)) walkable[cell.r]![cell.c] = true;
    return cell;
  };
  // Edge/zone anchors resolve to a BAND, so many props sharing 'north-edge' spread into a LINE
  // along the edge instead of piling on one point. ('center' is handled separately as a point —
  // the single centrepiece.) Returns null for an unknown anchor.
  const anchorBand = (a: string): Rect | null => {
    const tb = Math.max(2, Math.floor(rows * 0.2)); // top/bottom band thickness
    const sb = Math.max(2, Math.floor(cols * 0.16)); // left/right band thickness
    switch (a) {
      case 'north':
      case 'north-edge':
        return { x: 0, y: 0, w: cols, h: tb };
      case 'south':
      case 'south-edge':
        return { x: 0, y: rows - tb, w: cols, h: tb };
      case 'west':
      case 'west-edge':
        return { x: 0, y: 0, w: sb, h: rows };
      case 'east':
      case 'east-edge':
        return { x: cols - sb, y: 0, w: sb, h: rows };
      case 'waterside':
        return zones['waterside'] ?? { x: 0, y: rows - tb, w: cols, h: tb };
      case 'entrance':
        return zones['entrance'] ?? { x: Math.max(0, Math.floor(cols / 2) - 1), y: rows - 2, w: 3, h: 2 };
      default:
        return null;
    }
  };

  // Pick a fitting cell in `rect` that stays AWAY from already-placed objects of the same kind.
  // cellsOf is seed-shuffled; we then choose the best-spread candidate so actors/fixtures don't bunch.
  const pickSpread = (rect: Rect, fp: { w: number; h: number }, kind: string): { c: number; r: number } | null => {
    let best: { c: number; r: number } | null = null;
    let bestScore = -1;
    let scanned = 0;
    for (const cell of cellsOf(rect)) {
      if (!footFits(cell.c, cell.r, fp.w, fp.h)) continue;
      let md = Infinity;
      for (const q of placedCells) if (q.kind === kind) md = Math.min(md, Math.max(Math.abs(q.c - cell.c), Math.abs(q.r - cell.r)));
      const score = md === Infinity ? 999 : md;
      if (score > bestScore) {
        bestScore = score;
        best = cell;
      }
      if (bestScore >= 3 || ++scanned > 80) break; // well-spread enough / bounded scan
    }
    return best;
  };

  const resolve = (p: Placement, fp: { w: number; h: number }): { c: number; r: number } => {
    // near:<id> → an open cell adjacent to the (already-placed) referent.
    if (p.anchor?.startsWith('near:')) {
      const ref = placedPos.get(p.anchor.slice(5));
      if (ref) for (const [dc, dr] of ADJ) if (footFits(ref.c + dc, ref.r + dr, fp.w, fp.h)) return { c: ref.c + dc, r: ref.r + dr };
    }
    // Absolute base anchor. 'center' → the single nearest cell (the centrepiece); edge/zone
    // anchors → spread along a BAND so a shared anchor forms a line, not a pile.
    if (p.anchor && !p.anchor.startsWith('in:') && !p.anchor.startsWith('near:')) {
      if (p.anchor === 'center') {
        const hit = nearestFit(cxC, cyC, fp);
        if (hit) return hit;
      } else {
        const band = anchorBand(p.anchor);
        if (band) {
          const hit = pickSpread(band, fp, p.kind);
          if (hit) return hit;
        }
      }
    }
    // Otherwise place within the zone, spread away from same-kind neighbors.
    const zoneName = p.anchor?.startsWith('in:') ? p.anchor.slice(3) : p.zone;
    const rect = zones[zoneName] ?? zones[p.zone] ?? { x: 0, y: 0, w: cols, h: rows };
    return (
      pickSpread(rect, fp, p.kind) ??
      pickSpread({ x: 0, y: 0, w: cols, h: rows }, fp, p.kind) ?? // fallback: anywhere walkable
      guaranteedCell(cxC, cyC, fp) // degenerate last resort — always a WALKABLE cell, never inside a wall
    );
  };

  // Blockout placement: snap each entity to the nearest walkable cell to the coordinate the Director
  // painted for it (ignores semantic anchors — the painted cell IS the intent). No cell → centre.
  const cellById = new Map((comp.blockout?.cells ?? []).map((c) => [c.id, c]));
  const resolveBlockout = (p: Placement, fp: { w: number; h: number }): { c: number; r: number } => {
    const cell = cellById.get(p.id);
    // A fountain/well is the centrepiece of a settlement square — keep it centred even when painted
    // off-centre, so the town-square's read survives. Everything else honours its painted cell.
    const centrepiece = comp.grammar === 'town-square' && /fountain|well/.test(p.tag);
    const tc = centrepiece ? cxC : cell ? cell.col : Math.round(cxC);
    const tr = centrepiece ? cyC : cell ? cell.row : Math.round(cyC);
    return nearestFit(tc, tr, fp) ?? pickSpread({ x: 0, y: 0, w: cols, h: rows }, fp, p.kind) ?? guaranteedCell(cxC, cyC, fp);
  };

  // Place non-near first (fixtures → props → actors), then near-anchored ones.
  const rank = (k: string) => (k === 'fixture' ? 0 : k === 'prop' ? 1 : 2);
  const order = [...comp.placements].sort((a, b) => {
    const na = a.anchor?.startsWith('near:') ? 1 : 0;
    const nb = b.anchor?.startsWith('near:') ? 1 : 0;
    return na !== nb ? na - nb : rank(a.kind) - rank(b.kind);
  });

  const objects: MapObject[] = [];
  const entrances: Entrance[] = [];

  // BUILDINGS → roofless WALLED ROOMS. Carve each plot into a wall ring + stone floor, punch ONE
  // door (connecting interior↔outside), record an Entrance, furnish the interior from the per-type
  // template, and seat an occupant. Runs BEFORE entity placement so the floors/plaza are correct
  // when declared entities snap, and so furniture cells are reserved (occ) against overlap.
  let furnSeq = 0;
  const carvedRects: Rect[] = [];
  for (const b of comp.buildings ?? []) {
    const rx = Math.max(0, Math.min(cols - 1, b.rect.x));
    const ry = Math.max(0, Math.min(rows - 1, b.rect.y));
    const rw = Math.min(cols - rx, b.rect.w);
    const rh = Math.min(rows - ry, b.rect.h);
    if (rw < 3 || rh < 3) continue; // too small to be a room
    // Skip a building whose plot overlaps an already-carved one — carving it would reset the prior
    // room's reserved cells and stack two objects on a tile. (The composer emits non-overlapping
    // plots; this guards external callers / Director-authored rects.)
    if (carvedRects.some((q) => rx < q.x + q.w && rx + rw > q.x && ry < q.y + q.h && ry + rh > q.y)) continue;
    carvedRects.push({ x: rx, y: ry, w: rw, h: rh });
    // Child ids carry a kind-correct prefix (prop:/npc:) so they pass validation; `group` keeps the
    // building link. `safe` = the building id minus its prefix, sanitized.
    const safe = (b.id.includes(':') ? b.id.slice(b.id.indexOf(':') + 1) : b.id).replace(/[^a-z0-9_-]/gi, '-').toLowerCase() || 'bldg';
    const tmpl = BUILDING_TEMPLATES[b.type];
    for (let y = ry; y < ry + rh; y++)
      for (let x = rx; x < rx + rw; x++) {
        const top = y === ry, bot = y === ry + rh - 1, left = x === rx, right = x === rx + rw - 1;
        if (top || bot || left || right) { tiles[y]![x] = wallTagFor(top, bot, left, right, tmpl.wall); walkable[y]![x] = false; occ[y]![x] = true; }
        else { tiles[y]![x] = tmpl.floor; walkable[y]![x] = true; occ[y]![x] = false; }
      }
    // Door: the middle of a wall → floor + walkable, with the cell just OUTSIDE open. Try the declared
    // side first, then fall back to any side whose outside cell is on-grid (an edge-flush rect would
    // otherwise punch a door to nowhere).
    const midX = rx + Math.floor(rw / 2);
    const midY = ry + Math.floor(rh / 2);
    const doorFor = (side: string): { dC: number; dR: number; oC: number; oR: number } =>
      side === 'north' ? { dC: midX, dR: ry, oC: midX, oR: ry - 1 }
      : side === 'east' ? { dC: rx + rw - 1, dR: midY, oC: rx + rw, oR: midY }
      : side === 'west' ? { dC: rx, dR: midY, oC: rx - 1, oR: midY }
      : { dC: midX, dR: ry + rh - 1, oC: midX, oR: ry + rh }; // south
    let door = doorFor(b.door);
    if (!inB(door.oC, door.oR)) door = [b.door, 'south', 'north', 'east', 'west'].map(doorFor).find((d) => inB(d.oC, d.oR)) ?? door;
    const { dC, dR, oC, oR } = door;
    tiles[dR]![dC] = tmpl.floor; walkable[dR]![dC] = true; occ[dR]![dC] = false;
    if (inB(oC, oR)) { walkable[oR]![oC] = true; occ[oR]![oC] = false; if (tiles[oR]![oC]!.startsWith('wall')) tiles[oR]![oC] = 'dirt'; }
    entrances.push({ toLocationId: comp.locationId, col: dC, row: dR, ...(b.id ? { fixtureId: b.id } : {}) });

    // FURNISH the interior from the per-type template (shared helper — the primitive engine uses the
    // SAME furnishRoom so both paths furnish identically). Keeps the door's inner cell clear.
    furnSeq = furnishRoom(tiles, walkable, occ, objects, { x: rx, y: ry, w: rw, h: rh }, tmpl, { c: dC, r: dR }, rand, cols, safe, b.id, furnSeq, b.name);
  }

  for (const p of order) {
    // PLATFORM (boat/raft/bridge): may sit ON water — anchor at its painted cell (or the nearest water
    // tile) WITHOUT snapping to land, and make its whole footprint walkable so the party can board it.
    const pdef = p.kind !== 'actor' ? propDef(p.tag) : undefined;
    if (pdef?.platform) {
      const pw = Math.max(1, pdef.w), ph = Math.max(1, pdef.h);
      const cell = cellById.get(p.id);
      let ac: number, ar: number;
      if (cell) { ac = cell.col; ar = cell.row; }
      else {
        let found: { c: number; r: number } | null = null;
        for (let r = 0; r < rows && !found; r++) for (let c = 0; c < cols && !found; c++) if (isWaterTile(tiles[r]![c])) found = { c, r };
        ac = found?.c ?? Math.round(cxC); ar = found?.r ?? Math.round(cyC);
      }
      ac = Math.max(0, Math.min(cols - pw, ac)); ar = Math.max(0, Math.min(rows - ph, ar));
      for (let dy = 0; dy < ph; dy++) for (let dx = 0; dx < pw; dx++) { const cc = ac + dx, rr = ar + dy; if (inB(cc, rr)) { walkable[rr]![cc] = true; occ[rr]![cc] = false; } }
      occ[ar]![ac] = true; // the hull's own origin cell (so an actor doesn't overlap the boat object)
      placedPos.set(p.id, { c: ac, r: ar });
      placedCells.push({ c: ac, r: ar, kind: p.kind });
      objects.push({ id: p.id, kind: p.kind, ...(p.role ? { role: p.role } : {}), tag: p.tag, ...(p.name ? { name: p.name } : {}), col: ac, row: ar, footprint: { w: pw, h: ph }, facing: p.facing ?? 'down', visible: p.visible, zone: p.zone, ...(p.anchor ? { anchorRef: p.anchor } : {}) });
      continue;
    }
    const fp = footprintOf(p.tag, p.kind);
    const pos = useBlockout ? resolveBlockout(p, fp) : resolve(p, fp);
    for (let dy = 0; dy < fp.h; dy++)
      for (let dx = 0; dx < fp.w; dx++) {
        const cc = pos.c + dx;
        const rr = pos.r + dy;
        if (inB(cc, rr)) {
          occ[rr]![cc] = true;
          if (p.kind === 'fixture') walkable[rr]![cc] = false; // a building blocks the tiles it sits on
        }
      }
    placedPos.set(p.id, pos);
    placedCells.push({ c: pos.c, r: pos.r, kind: p.kind });
    objects.push({
      id: p.id,
      kind: p.kind,
      ...(p.role ? { role: p.role } : {}),
      tag: p.tag,
      ...(p.name ? { name: p.name } : {}),
      col: pos.c,
      row: pos.r,
      footprint: fp,
      facing: p.facing ?? 'down',
      visible: p.visible,
      zone: p.zone,
      ...(p.anchor ? { anchorRef: p.anchor } : {}),
    });
  }

  // OBJECT FIELDS: expand each into N concrete, id-addressed children (idBase#NN). Runs AFTER point
  // placement so point actors keep first pick of walkable cells, and field `spacing` leaves lanes.
  const clampRect = (r: Rect): Rect => {
    const x = Math.max(0, Math.min(cols - 1, r.x));
    const y = Math.max(0, Math.min(rows - 1, r.y));
    return { x, y, w: Math.max(1, Math.min(cols - x, r.w)), h: Math.max(1, Math.min(rows - y, r.h)) };
  };
  const BAND_ALIAS: Record<string, string> = { left: 'west', right: 'east', top: 'north', bottom: 'south', north: 'north', south: 'south', east: 'east', west: 'west' };
  const regionRect = (field: ObjectField): Rect => {
    // `near:<id>` → a box centred on that placed landmark (flank/ring/cluster around it).
    if (field.region.near) {
      const ref = placedPos.get(field.region.near);
      if (ref) {
        const half = field.arrangement === 'flank' ? 1 : field.arrangement === 'ring' ? 2 : Math.max(2, Math.ceil(Math.sqrt(field.count ?? 6)));
        return clampRect({ x: ref.c - half, y: ref.r - half, w: 2 * half + 1, h: 2 * half + 1 });
      }
      // unresolvable ref → fall through to band/rect/centre
    }
    if (field.region.rect) return clampRect(field.region.rect);
    const b = field.region.band ?? 'all';
    const aliased = BAND_ALIAS[b];
    if (aliased) {
      const band = anchorBand(aliased);
      if (band) return clampRect(band);
    }
    if (b === 'center') return clampRect({ x: 2, y: 2, w: cols - 4, h: rows - 4 });
    return clampRect({ x: 1, y: 1, w: cols - 2, h: rows - 2 }); // 'all'
  };
  /** Ordered target cells for an arrangement within a rect (deterministic; scatter is seed-shuffled).
   *  `aisle` carves a clear central lane (a column or row left empty) through a row/grid. */
  const fieldTargets = (rect: Rect, arr: ObjectField['arrangement'], spacing: number, aisle?: 'vertical' | 'horizontal'): { c: number; r: number }[] => {
    const s = Math.max(1, spacing);
    const x0 = rect.x, y0 = rect.y, x1 = rect.x + rect.w - 1, y1 = rect.y + rect.h - 1;
    const midR = y0 + Math.floor(rect.h / 2), midC = x0 + Math.floor(rect.w / 2);
    const out: { c: number; r: number }[] = [];
    if (arr === 'grid') for (let r = y0; r <= y1; r += s) for (let c = x0; c <= x1; c += s) out.push({ c, r });
    else if (arr === 'row') for (let c = x0; c <= x1; c += s) out.push({ c, r: midR });
    else if (arr === 'line') {
      if (rect.w >= rect.h) for (let c = x0; c <= x1; c += s) out.push({ c, r: midR });
      else for (let r = y0; r <= y1; r += s) out.push({ c: midC, r });
    } else if (arr === 'ring' && rect.w >= 3 && rect.h >= 3) {
      for (let c = x0; c <= x1; c += s) { out.push({ c, r: y0 }); if (y1 !== y0) out.push({ c, r: y1 }); }
      for (let r = y0 + s; r < y1; r += s) { out.push({ c: x0, r }); if (x1 !== x0) out.push({ c: x1, r }); }
    } else if (arr === 'ring') {
      // A ring needs a 3×3+ rect to read as a perimeter; on a thin band it degenerates to a line.
      if (rect.w >= rect.h) for (let c = x0; c <= x1; c += s) out.push({ c, r: midR });
      else for (let r = y0; r <= y1; r += s) out.push({ c: midC, r });
    } else if (arr === 'flank') {
      out.push({ c: x0, r: midR });
      if (x1 !== x0) out.push({ c: x1, r: midR });
    } else {
      for (let r = y0; r <= y1; r++) for (let c = x0; c <= x1; c++) out.push({ c, r });
      for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = out[i]!; out[i] = out[j]!; out[j] = t; }
    }
    // Carve a central lane — but if the filter would remove EVERY target (a too-narrow region), keep the
    // unfiltered targets so the field still places (and an absorbed entity never lands in the empty aisle).
    if (aisle === 'vertical') { const f = out.filter((t) => t.c !== midC); return f.length ? f : out; }
    if (aisle === 'horizontal') { const f = out.filter((t) => t.r !== midR); return f.length ? f : out; }
    return out;
  };
  for (const field of comp.fields ?? []) {
    const d = propDef(field.tag);
    const fp = field.kind === 'actor' ? { w: 1, h: 1 } : { w: d?.w ?? 1, h: d?.h ?? 1 };
    const blocks = field.kind !== 'actor' && (d?.blocks ?? true);
    const spacing = field.spacing ?? (field.arrangement === 'scatter' ? 1 : 2);
    // `shore` is a special region: the computed waterline cells (a ring on an island), not a rect.
    const onShore = field.region.band === 'shore';
    const rect = regionRect(field);
    let targets: { c: number; r: number }[];
    if (onShore) {
      targets = [...shoreCells];
      for (let i = targets.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = targets[i]!; targets[i] = targets[j]!; targets[j] = t; }
    } else {
      targets = fieldTargets(rect, field.arrangement, spacing, field.aisle);
    }
    const defaultCount = field.arrangement === 'scatter' || onShore ? 6 : field.arrangement === 'flank' ? 2 : targets.length;
    const cap = Math.min(FIELD_LIMITS.maxCount, field.count ?? defaultCount);
    const snapMax = Math.max(2, spacing); // a child may snap up to ~one spacing-step toward a free cell
    const midR2 = onShore && shoreCells.length ? shoreCells[0]!.r : rect.y + Math.floor(rect.h / 2);
    const midC2 = onShore && shoreCells.length ? shoreCells[0]!.c : rect.x + Math.floor(rect.w / 2);
    const place = (pos: { c: number; r: number }, n: number): void => {
      for (let dy = 0; dy < fp.h; dy++)
        for (let dx = 0; dx < fp.w; dx++) {
          const cc = pos.c + dx, rr = pos.r + dy;
          if (inB(cc, rr)) { occ[rr]![cc] = true; if (blocks) walkable[rr]![cc] = false; }
        }
      objects.push({ id: `${field.idBase}#${n.toString().padStart(2, '0')}`, kind: field.kind, ...(field.role ? { role: field.role } : {}), tag: field.tag, ...(field.name ? { name: field.name } : {}), col: pos.c, row: pos.r, footprint: fp, facing: field.facing ?? 'down', visible: field.visible ?? true, group: field.idBase });
    };
    let n = 0;
    for (const t of targets) {
      if (n >= cap) break;
      let pos: { c: number; r: number } | null = footFits(t.c, t.r, fp.w, fp.h) ? { c: t.c, r: t.r } : null;
      if (!pos) {
        const hit = nearestFit(t.c, t.r, fp); // snap to a nearby free cell, but don't teleport across the map
        if (hit && Math.max(Math.abs(hit.c - t.c), Math.abs(hit.r - t.r)) <= snapMax) pos = hit;
      }
      if (!pos) continue;
      place(pos, n);
      n++;
    }
    // An ABSORBED declared entity must appear — guarantee at least one child even if every target was
    // skipped (e.g. a tiny/crowded region), so the entity never silently vanishes from the scene.
    if (n === 0) place(guaranteedCell(midC2, midR2, fp), 0);
  }

  // Reachability guard: a dense field must never TRAP an actor. If any actor has no walkable orthogonal
  // neighbour (boxed in by field props), open one adjacent cell so it can always step out.
  const ORTH4 = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  for (const o of objects) {
    if (o.kind !== 'actor') continue;
    if (ORTH4.some(([dx, dy]) => walkable[o.row + dy]?.[o.col + dx] === true)) continue;
    // Open an UNOCCUPIED neighbour (don't make an occupied cell walkable — that would invite an overlap);
    // if every neighbour is occupied the actor is genuinely packed in, leave it rather than stack.
    for (const [dx, dy] of ORTH4) { const cc = o.col + dx, rr = o.row + dy; if (inB(cc, rr) && !occ[rr]![cc]) { walkable[rr]![cc] = true; break; } }
  }

  // GLOBAL REACHABILITY: a walled settlement must never seal off an actor or a door. Only needed when
  // buildings exist (the carved walls are the only thing that can isolate a cell). Extracted helper —
  // the city stitcher reuses it on the assembled grid.
  if ((comp.buildings?.length ?? 0) > 0) reachabilityCarve(tiles, walkable, cols, rows, objects, entrances);

  // Ambiance. In blockout mode the forest fill IS the ambiance (already placed, intentionally dense);
  // otherwise seed-scatter decor biased to the PERIMETER so the playable middle stays legible, and
  // hard-capped so a village never reads as a forest. Tree sprites are tall/wide, so a little goes far.
  const ambiance: AmbianceItem[] = useBlockout ? forestAmbiance : [];
  const tags = comp.ambiance.tags;
  if (!useBlockout && tags.length > 0 && comp.ambiance.density > 0) {
    const AMBIANCE_CAP = 12;
    const band = 3; // cells from the edge counted as "perimeter"
    const candidates = cellsOf({ x: 0, y: 0, w: cols, h: rows }).filter((c) => free(c.c, c.r));
    const edge = candidates.filter((c) => c.c < band || c.c >= cols - band || c.r < band || c.r >= rows - band);
    const pool = edge.length >= 8 ? edge : candidates; // frame the scene; fall back if there's no room
    const count = Math.min(pool.length, AMBIANCE_CAP, Math.floor(pool.length * comp.ambiance.density));
    for (let i = 0; i < count; i++) {
      const cell = pool[i]!;
      const tag = tags[Math.floor(rand() * tags.length)]!;
      occ[cell.r]![cell.c] = true;
      ambiance.push({ tag, col: cell.c, row: cell.r });
    }
  }

  // SETTLEMENT GREENERY: a town shouldn't sit on a bare lot. Scatter trees/bushes (blocking) +
  // wildflowers (walkable decals) across the GRASS margins between/around the carved buildings, so it
  // reads like the reference's leafy village. Seed-stable; only touches free grass, so streets,
  // plazas, buildings and entities are untouched and reachability holds.
  if (useBlockout && comp.grammar === 'town-square') {
    const grass: { c: number; r: number }[] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (tiles[r]![c] === 'grass' && free(c, r)) grass.push({ c, r });
    for (let i = grass.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = grass[i]!; grass[i] = grass[j]!; grass[j] = t; }
    const TREES = ['tree', 'tree', 'tree_pine', 'bush'] as const;
    let gi = 0;
    const trees = Math.min(grass.length, 70, Math.max(6, Math.floor(grass.length * 0.2))); // abs cap so big maps don't explode the prop count
    for (let n = 0; n < trees && gi < grass.length; n++, gi++) {
      const cell = grass[gi]!;
      occ[cell.r]![cell.c] = true;
      walkable[cell.r]![cell.c] = false; // trees block
      ambiance.push({ tag: TREES[Math.floor(rand() * TREES.length)]!, col: cell.c, row: cell.r });
    }
    const flowers = Math.min(grass.length - gi, 50, Math.max(4, Math.floor(grass.length * 0.15)));
    for (let n = 0; n < flowers && gi < grass.length; n++, gi++) {
      const cell = grass[gi]!;
      occ[cell.r]![cell.c] = true; // a walkable decal — DON'T clear walkable
      ambiance.push({ tag: 'flowers', col: cell.c, row: cell.r });
    }
  }

  // C2 GROUND DECALS: a light, NON-BLOCKING scatter of pebbles + grass tufts on open natural ground
  // (grass/dirt/sand — not stone plaza/interiors/water) for lived-in floor detail. Extracted helper —
  // runs before the auto-tile bake (decals are objects, not tiles, so the bake is unaffected).
  if (!isInterior) scatterGroundDecals(tiles, walkable, occ, cols, rows, ambiance, rand);

  // TERRAIN AUTO-TILING (C1): edge cells of an EDGED terrain so boundaries read with real DawnLike
  // edge tiles instead of a hard rectangular seam. Baked LAST — reads the FINAL tiles grid (after
  // building-carve, reachability dirt-carving, the shoreline sand strip), so it edges against whatever
  // ended up adjacent. Off-grid neighbours count as same (the screen border doesn't fringe, matching
  // the forest-feather rule). GRASS owns its boundaries (grass-on-dirt fade — looks right vs dirt/
  // sand/stone/wall); WATER (incl. water_deep, same family) owns the SHORELINE (a brown shore rim,
  // which the sand-strip puts against sand). dirt/sand need no own edge set — grass+water already own
  // every boundary they touch (a standalone set would just double-edge). `walkable` was computed from
  // the base terrain and each *_edge shares its base's walkability, so it stays consistent.
  if (!isInterior) bakeAutoTiles(tiles, cols, rows);

  return {
    locationId: comp.locationId,
    seed: comp.seed,
    biome: comp.biome,
    lighting: comp.lighting,
    grammar: comp.grammar,
    grid: { cols, rows, feetPerTile: FEET_PER_TILE },
    tiles,
    walkable,
    objects,
    ambiance,
    entrances,
  };
}
