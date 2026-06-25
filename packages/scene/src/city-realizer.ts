/**
 * City realizer — rasterizes a float CityMesh onto the 16px tile grid (Stage G). The mesh is the
 * organic plan; this is the single place we cross from continuous geometry to tiles.
 *
 * This pass (the rasterization falsification) lays the STRUCTURE only — no buildings yet:
 *   - ground by zone: core = packed earth (dirt), extramural/rural = grass (fields / country).
 *   - streets: the seam between two adjacent core cells becomes cobble (`road`) — organic-width lanes
 *     that follow the Voronoi borders exactly, no line-drawing, no stair-step artefacts.
 *   - wall (optional): the smoothed core ring traced as `wall` tiles, with carved walkable gates.
 * Buildings, ward terrain, and outer-zone flavour (farms/vendors/camps) arrive in M3+.
 */
import { Canvas, finalize } from './primitives.js';
import { buildCityMesh, type CityMeshOpts, type Vec2, type Zone } from './citymesh.js';
import type { SceneMap } from '@mythweaver/shared';

const ZONE_GROUND: Record<Zone, string> = { core: 'dirt', extramural: 'grass', rural: 'grass' };

/** Bresenham line of a terrain tag (used to trace the wall ring tile-by-tile). */
function lineTiles(cv: Canvas, a: { c: number; r: number }, b: { c: number; r: number }, tag: string, walk: boolean) {
  let x0 = a.c, y0 = a.r;
  const x1 = b.c, y1 = b.r, dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    cv.set(x0, y0, tag, walk);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

/** Build a tiled SceneMap from the block-centric mesh (structure only — no buildings yet). */
export function realizeCityMesh(seed: number, opts: CityMeshOpts = {}): SceneMap {
  const m = buildCityMesh(seed, opts);
  const half = m.viewExtent * 1.1; // a little country around the city
  const GRID = Math.max(60, Math.min(160, Math.round(2 * half * 0.9)));
  const SCALE = GRID / (2 * half); // tiles per world unit
  const cv = new Canvas(GRID, GRID, seed, 'grass');
  const tileWorld = (c: number, r: number) => ({ wx: m.center.x - half + (c + 0.5) / SCALE, wy: m.center.y + half - (r + 0.5) / SCALE });
  const toTile = (p: Vec2) => ({ c: Math.round((p.x - (m.center.x - half)) * SCALE - 0.5), r: Math.round(((m.center.y + half) - p.y) * SCALE - 0.5) });
  const zoneOf = (id: number): Zone => m.patches[id]?.zone ?? 'rural';

  // 1. Nearest core/zone patch per tile (closest-seed) — drives ground + street seams.
  const nid: number[][] = Array.from({ length: GRID }, () => new Array<number>(GRID));
  for (let r = 0; r < GRID; r++) for (let c = 0; c < GRID; c++) { const { wx, wy } = tileWorld(c, r); nid[r]![c] = m.find(wx, wy); }

  // 2. Ground by zone.
  for (let r = 0; r < GRID; r++) for (let c = 0; c < GRID; c++) cv.set(c, r, ZONE_GROUND[zoneOf(nid[r]![c]!)]);

  // 3. Streets — a core tile adjacent to a DIFFERENT core cell sits on a cell seam → cobble. Both sides
  //    of a seam qualify, so lanes come out ~2 tiles wide and follow the organic borders.
  for (let r = 0; r < GRID; r++) for (let c = 0; c < GRID; c++) {
    const id = nid[r]![c]!;
    if (zoneOf(id) !== 'core') continue;
    let seam = false;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const c2 = c + dc, r2 = r + dr;
      if (c2 < 0 || r2 < 0 || c2 >= GRID || r2 >= GRID) continue;
      const id2 = nid[r2]![c2]!;
      if (id2 !== id && zoneOf(id2) === 'core') { seam = true; break; }
    }
    if (seam) cv.set(c, r, 'road', true);
  }

  // 4. Curtain wall (if any) — trace the smoothed ring as wall tiles, then carve walkable gates.
  if (m.wall) {
    const ring = m.wall.ring.map(toTile);
    for (let i = 0; i < ring.length; i++) lineTiles(cv, ring[i]!, ring[(i + 1) % ring.length]!, 'wall', false);
    for (const g of m.wall.gates) {
      const t = toTile(g);
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (cv.inB(t.c + dc, t.r + dr)) cv.set(t.c + dc, t.r + dr, 'road', true);
    }
  }

  return finalize(cv, { locationId: `loc:lab-citymesh-${seed}`, biome: 'village', lighting: 'day', grammar: 'town-square', outdoor: true, skipReachability: true, skipDecals: true });
}
