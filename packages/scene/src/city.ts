/**
 * City stitcher (city-scope V2) — assemble N town "districts" into ONE big frozen SceneMap, at
 * ZERO model cost. This proves the whole city GEOMETRY (districts, avenues, walls, gates, cross-
 * district autotiling + reachability) deterministically; V3 layers two-tier LLM generation on top.
 *
 *   N CityDistrictSpec ──FakeSceneComposer──► SceneComposition ──buildSceneMap──► district SceneMap
 *                                                                                      │  (×N)
 *                          ┌───────────────────────────────────────────────────────────┘
 *                          ▼
 *   blit each at an (offsetCol,offsetRow) on one merged grid → carve dirt avenues in the gutters →
 *   wrap in an optional walled ring with gates → run reachability + decal scatter + the terrain
 *   auto-tile bake ONCE on the assembled grid → ONE plain SceneMap (same shape buildSceneMap returns).
 *
 * Each district is just a normal town built by the EXISTING machinery, placed at an offset — so the
 * renderer and validateSceneMap accept the result UNCHANGED (the merged grid intentionally exceeds
 * GRID_LIMITS, which validateSceneMap does NOT enforce — only validateComposition does, and we never
 * build a composition for the merged map).
 *
 * Pure + deterministic: same CityRequest → byte-identical SceneMap. District seeds derive from their
 * ids (distinct per district); the single merged decal scatter is seeded from the city seed.
 */

import {
  FEET_PER_TILE,
  type AmbianceItem,
  type EstablishScene,
  type Entrance,
  type Lighting,
  type LocationId,
  type MapObject,
  type SceneMap,
} from '@mythweaver/shared';
import { bakeAutoTiles, buildSceneMap, makeRng, reachabilityCarve, scatterGroundDecals, wallTagFor } from './cartographer.js';
import { terrainWalkable } from './catalog.js';
import { FakeSceneComposer } from './composer.js';

/** One district = a small self-contained town. `builds` are building tags (tavern/smithy/cottage…);
 *  the Cartographer carves each as a walled room. `setting` must read as a settlement (it drives the
 *  town-square grammar) and must NOT mention water (a per-district pond reads wrong in a city). */
export interface CityDistrictSpec {
  setting: string;
  builds: string[];
  npcs?: { name: string; look: string }[];
  /** Optional flavour label folded into the district id slug for a distinct, stable seed. */
  key?: string;
}

export interface CityRequest {
  /** City-wide location id, e.g. "loc:highcrest". Used for the returned SceneMap + every entrance. */
  locationId: LocationId;
  districts: CityDistrictSpec[]; // N >= 1
  biome?: string; // city-wide biome for the SceneMap (default "village")
  lighting?: Lighting; // default "day"
  /** District grid width in #districts (default ceil(sqrt(N)), clamped to [1, N]). */
  cols?: number;
  /** Gutter width (tiles) between districts AND the perimeter margin (default 3). */
  streetWidth?: number;
  /** Wrap the city in an outer wall ring with one gate per side (default true). */
  wall?: boolean;
}

const composer = new FakeSceneComposer();

/** FNV-1a — a small stable string→u32 hash, so district seeds are deterministic without importing
 *  the orchestrator's seedFor (which lives in apps/server and can't be imported here). */
function districtSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Namespace a per-district id so it's unique across the merged map: `prop:well#03` → `prop:well-d2#03`,
 *  `npc:b0-keeper` → `npc:b0-keeper-d2`. Preserves the kind prefix + the `#NN` field-child tail, both of
 *  which the validator cross-checks. The inserted `-d<i>` segment is valid slug (a `[a-z0-9]+` segment). */
function nsId(id: string, i: number): string {
  const colon = id.indexOf(':');
  if (colon < 0) return `${id}-d${i}`;
  const prefix = id.slice(0, colon);
  let slug = id.slice(colon + 1);
  let tail = '';
  const hash = slug.indexOf('#');
  if (hash >= 0) {
    tail = slug.slice(hash);
    slug = slug.slice(0, hash);
  }
  return `${prefix}:${slug}-d${i}${tail}`;
}

const EDGE_BASES = ['water_deep', 'water', 'grass'] as const; // most-specific first
const EDGE_SUFFIXES = new Set(['t', 'b', 'l', 'r', 'tl', 'tr', 'bl', 'br']);
/** Reduce an already-baked EDGED terrain tag back to its base family ('grass_tl' → 'grass',
 *  'water_deep_b' → 'water_deep') so the single merged bake re-derives every seam from the assembled
 *  neighbourhood. Non-EDGED tags (wall_*, carpet_*, wood_floor, …) pass through untouched. */
function stripEdge(tag: string): string {
  for (const b of EDGE_BASES) {
    if (tag === b) return b;
    if (tag.startsWith(`${b}_`) && EDGE_SUFFIXES.has(tag.slice(b.length + 1))) return b;
  }
  return tag;
}

/** Build the small EstablishScene a single district is composed from (no LLM). */
function districtEstablish(cityId: LocationId, i: number, spec: CityDistrictSpec, lighting: Lighting): EstablishScene {
  return {
    // biome 'forest' (not 'village'/'coast') keeps the deterministic composer from laying a water band
    // along each district's south edge — a per-district pond reads wrong inside a city.
    locationId: `${cityId}-d${i}`,
    brief: { setting: spec.setting, biome: 'forest', timeOfDay: lighting },
    fixtures: spec.builds.map((tag, j) => ({ id: `bldg:b${j}`, kind: 'fixture' as const, tag })),
    npcs: (spec.npcs ?? []).map((n, j) => ({ id: `npc:n${j}`, name: n.name, look: n.look, visible: true })),
  };
}

export async function buildCityScene(req: CityRequest): Promise<SceneMap> {
  const districts = req.districts.length ? req.districts : [{ setting: 'a small market square with a tavern and cottages', builds: ['tavern', 'cottage', 'cottage'] }];
  const lighting: Lighting = req.lighting ?? 'day';
  // Coordinates MUST stay integers: a fractional gutter/offset would put an actor/entrance on a
  // fractional cell, and reachabilityCarve's integer-stepping L-carve would never reach it (it would
  // spin forever). Floor/validate streetWidth + cols here so no caller (the HTTP route already rounds,
  // but a direct/programmatic caller might not) can trip that.
  const sw = req.streetWidth;
  const STREET = typeof sw === 'number' && Number.isFinite(sw) ? Math.max(2, Math.floor(sw)) : 3;
  const WALL = req.wall === false ? 0 : 1;

  // 1) Build every district independently (deterministic, no LLM).
  const maps: SceneMap[] = [];
  for (let i = 0; i < districts.length; i++) {
    const est = districtEstablish(req.locationId, i, districts[i]!, lighting);
    const seed = districtSeed(est.locationId);
    const comp = await composer.compose({ establish: est, party: [], seed });
    maps.push(buildSceneMap(comp));
  }

  // 2) District grid layout (per-column widths / per-row heights → continuous gutters).
  const N = maps.length;
  const colsReq = typeof req.cols === 'number' && Number.isFinite(req.cols) ? Math.floor(req.cols) : Math.ceil(Math.sqrt(N));
  const nCols = Math.max(1, Math.min(colsReq, N));
  const nRows = Math.ceil(N / nCols);
  const gridColOf = (d: number) => d % nCols;
  const gridRowOf = (d: number) => Math.floor(d / nCols);
  const colWidths = Array.from({ length: nCols }, (_, gc) => Math.max(1, ...maps.filter((_, d) => gridColOf(d) === gc).map((m) => m.grid.cols)));
  const rowHeights = Array.from({ length: nRows }, (_, gr) => Math.max(1, ...maps.filter((_, d) => gridRowOf(d) === gr).map((m) => m.grid.rows)));
  const sum = (arr: number[], end: number) => arr.slice(0, end).reduce((a, b) => a + b, 0);

  const cols = WALL * 2 + STREET * 2 + sum(colWidths, nCols) + (nCols - 1) * STREET;
  const rows = WALL * 2 + STREET * 2 + sum(rowHeights, nRows) + (nRows - 1) * STREET;
  const offColOf = (gc: number) => WALL + STREET + sum(colWidths, gc) + gc * STREET;
  const offRowOf = (gr: number) => WALL + STREET + sum(rowHeights, gr) + gr * STREET;

  // 3) Allocate the merged grid: base grass everywhere; districtMask marks blitted cells.
  const grassWalk = terrainWalkable('grass');
  const tiles: string[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => 'grass'));
  const walkable: boolean[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => grassWalk));
  const inDistrict: boolean[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => false));
  const objects: MapObject[] = [];
  const ambiance: AmbianceItem[] = [];
  const entrances: Entrance[] = [];

  // 4) Blit each district (tiles + walkable), translate its objects/ambiance/entrances by the offset.
  for (let d = 0; d < N; d++) {
    const m = maps[d]!;
    const offC = offColOf(gridColOf(d));
    const offR = offRowOf(gridRowOf(d));
    for (let r = 0; r < m.grid.rows; r++)
      for (let c = 0; c < m.grid.cols; c++) {
        tiles[offR + r]![offC + c] = stripEdge(m.tiles[r]![c]!);
        walkable[offR + r]![offC + c] = m.walkable[r]![c]!;
        inDistrict[offR + r]![offC + c] = true;
      }
    for (const o of m.objects) objects.push({ ...o, id: nsId(o.id, d), col: o.col + offC, row: o.row + offR, ...(o.group ? { group: nsId(o.group, d) } : {}) });
    for (const a of m.ambiance) ambiance.push({ tag: a.tag, col: a.col + offC, row: a.row + offR });
    for (const e of m.entrances) entrances.push({ toLocationId: req.locationId, col: e.col + offC, row: e.row + offR, ...(e.fixtureId ? { fixtureId: nsId(e.fixtureId, d) } : {}) });
  }

  // 5) AVENUES: every cell NOT inside a district (the gutters + perimeter margin) becomes a walkable
  // dirt street — a continuous plaza/avenue network that touches every district's walkable border.
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      if (!inDistrict[r]![c]) {
        tiles[r]![c] = 'dirt';
        walkable[r]![c] = true;
      }

  // 6) OUTER WALL + GATES: a 1-cell ring at the grid border, one gate per side on the centre axis.
  if (WALL) {
    for (let c = 0; c < cols; c++) {
      tiles[0]![c] = wallTagFor(true, false, c === 0, c === cols - 1, 'stone');
      walkable[0]![c] = false;
      tiles[rows - 1]![c] = wallTagFor(false, true, c === 0, c === cols - 1, 'stone');
      walkable[rows - 1]![c] = false;
    }
    for (let r = 0; r < rows; r++) {
      tiles[r]![0] = wallTagFor(r === 0, r === rows - 1, true, false, 'stone');
      walkable[r]![0] = false;
      tiles[r]![cols - 1] = wallTagFor(r === 0, r === rows - 1, false, true, 'stone');
      walkable[r]![cols - 1] = false;
    }
    const midC = Math.floor(cols / 2);
    const midR = Math.floor(rows / 2);
    const gate = (c: number, r: number) => {
      tiles[r]![c] = 'dirt';
      walkable[r]![c] = true;
      entrances.push({ toLocationId: req.locationId, col: c, row: r });
    };
    gate(midC, 0);
    gate(midC, rows - 1);
    gate(0, midR);
    gate(cols - 1, midR);
  }

  // 7) Connect everything: BFS the assembled street/district graph and carve corridors to any actor or
  // entrance cut off from it (a district whose border happened to be ringed off, a sealed gate, …).
  reachabilityCarve(tiles, walkable, cols, rows, objects, entrances);

  // 8) Ground decals over the whole city — seed from the stable city seed; reserve occupied cells
  // (objects, ambiance, non-walkable) so nothing stacks. Then the single terrain auto-tile bake LAST.
  const citySeed = districtSeed(req.locationId);
  const occ: boolean[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => false));
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (!walkable[r]![c]) occ[r]![c] = true;
  for (const o of objects) for (let dy = 0; dy < o.footprint.h; dy++) for (let dx = 0; dx < o.footprint.w; dx++) { const rr = o.row + dy, cc = o.col + dx; if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) occ[rr]![cc] = true; }
  for (const a of ambiance) if (a.row >= 0 && a.row < rows && a.col >= 0 && a.col < cols) occ[a.row]![a.col] = true;
  scatterGroundDecals(tiles, walkable, occ, cols, rows, ambiance, makeRng(citySeed));
  bakeAutoTiles(tiles, cols, rows);

  return {
    locationId: req.locationId,
    seed: citySeed,
    biome: req.biome ?? 'village',
    lighting,
    grammar: 'town-square',
    grid: { cols, rows, feetPerTile: FEET_PER_TILE },
    tiles,
    walkable,
    objects,
    ambiance,
    entrances,
  };
}
