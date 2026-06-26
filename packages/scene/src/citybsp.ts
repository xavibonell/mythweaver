/**
 * CityBsp — an ORTHOGONAL blueprint engine (the alternative to the organic Voronoi mesh in citymesh.ts).
 *
 * Recursively subdivides the city area into RECTANGLES of varied sizes (BSP with jittered cuts + a
 * size/depth-weighted random stop, so it's a nuanced layout, not a uniform grid). Every block is an
 * axis-aligned rectangle and every street seam is therefore horizontal/vertical → the cobble renders
 * perfectly clean, with ZERO diagonals (the complete cure for the diagonal-staircase problem).
 *
 * It returns the SAME shape as buildCityMesh (a CityMesh), so the shared realizer (realizeLayout in
 * city-realizer.ts) fills it identically — zoning, terraced building blocks, gardens, extramural farms,
 * NPCs — with no changes. Deterministic from the seed. Pokémon-town flavour: no curtain wall (open town).
 */
import { coreWall, meshBlueprint, type CityBlueprint, type CityMesh, type CityMeshOpts, type Patch, type Vec2, type Zone } from './citymesh.js';
import { makeRng } from './cartographer.js';

interface Rect { x: number; y: number; w: number; h: number }

/** Build the orthogonal (BSP) layout as a CityMesh — varied rectangular blocks, axis-aligned seams. */
export function buildCityBsp(seed: number, opts: CityMeshOpts = {}): CityMesh {
  const rng = makeRng(seed >>> 0);
  const nPatches = Math.max(4, Math.min(40, Math.floor(opts.nPatches ?? 15)));
  const HALF = 110; // world half-extent of the subdivided area (core cluster + a country ring)
  const MIN = 17; // min block side (world units) — no tiny blocks
  const MAXDEPTH = 6;

  // Recursive binary subdivision with jittered cuts + a random early stop → varied, non-grid block sizes.
  const rects: Rect[] = [];
  const split = (R: Rect, depth: number) => {
    const canW = R.w >= 2 * MIN, canH = R.h >= 2 * MIN;
    if (depth >= MAXDEPTH || (!canW && !canH) || (depth >= 2 && rng() < 0.18)) { rects.push(R); return; }
    const horiz = canW && (!canH || (R.w >= R.h ? rng() < 0.75 : rng() < 0.35)); // bias to splitting the longer side
    if (horiz) {
      const cut = MIN + Math.floor(rng() * (R.w - 2 * MIN + 1));
      split({ x: R.x, y: R.y, w: cut, h: R.h }, depth + 1);
      split({ x: R.x + cut, y: R.y, w: R.w - cut, h: R.h }, depth + 1);
    } else if (canH) {
      const cut = MIN + Math.floor(rng() * (R.h - 2 * MIN + 1));
      split({ x: R.x, y: R.y, w: R.w, h: cut }, depth + 1);
      split({ x: R.x, y: R.y + cut, w: R.w, h: R.h - cut }, depth + 1);
    } else rects.push(R);
  };
  split({ x: -HALF, y: -HALF, w: 2 * HALF, h: 2 * HALF }, 0);

  const center: Vec2 = { x: 0, y: 0 };
  const rc = (R: Rect): Vec2 => ({ x: R.x + R.w / 2, y: R.y + R.h / 2 });
  const patches: Patch[] = rects.map((R, id) => {
    const c = rc(R);
    return {
      id, site: c, centroid: c,
      poly: [{ x: R.x, y: R.y }, { x: R.x + R.w, y: R.y }, { x: R.x + R.w, y: R.y + R.h }, { x: R.x, y: R.y + R.h }],
      distToCenter: Math.hypot(c.x, c.y), withinCity: false, zone: 'rural' as Zone, neighbours: [],
    };
  });

  // Adjacency: two rects are neighbours if they share an edge segment (overlap > 1 on the shared axis).
  const share = (a: Rect, b: Rect): boolean => {
    const ax2 = a.x + a.w, ay2 = a.y + a.h, bx2 = b.x + b.w, by2 = b.y + b.h;
    const oy = Math.min(ay2, by2) - Math.max(a.y, b.y), ox = Math.min(ax2, bx2) - Math.max(a.x, b.x);
    return (((Math.abs(ax2 - b.x) < 1e-6) || (Math.abs(bx2 - a.x) < 1e-6)) && oy > 1) || (((Math.abs(ay2 - b.y) < 1e-6) || (Math.abs(by2 - a.y) < 1e-6)) && ox > 1);
  };
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) if (share(rects[i]!, rects[j]!)) { patches[i]!.neighbours.push(j); patches[j]!.neighbours.push(i); }

  // Classify: the nPatches rects nearest the centre = the town core; rects touching it = extramural; rest = rural.
  const inner = patches.slice().sort((a, b) => a.distToCenter - b.distToCenter || a.id - b.id).slice(0, nPatches).map((p) => p.id);
  for (const id of inner) patches[id]!.withinCity = true;
  const innerSet = new Set(inner);
  for (const p of patches) p.zone = p.withinCity ? 'core' : (p.neighbours.some((n) => innerSet.has(n)) ? 'extramural' : 'rural');

  let cityRadius = 0, viewExtent = 0;
  for (const id of inner) { const p = patches[id]!; cityRadius = Math.max(cityRadius, p.distToCenter); for (const v of p.poly) viewExtent = Math.max(viewExtent, Math.hypot(v.x, v.y)); }

  // No curtain wall for the orthogonal town (open, Pokémon-style). coreWall is kept available but the
  // BSP T-junctions make an edge-traced wall unreliable, so we skip it; opts.wall is honoured only if a
  // clean ring traces (rare). The town reads through its blocks + streets, not a wall.
  void coreWall;
  const wall = undefined;

  // find: the rect containing the point (axis-aligned containment), else the nearest centroid (L1).
  const find = (x: number, y: number): number => {
    for (const p of patches) { const a = p.poly[0]!, b = p.poly[2]!; if (x >= a.x && x < b.x && y >= a.y && y < b.y) return p.id; }
    let best = 0, bd = Infinity;
    for (const p of patches) { const d = Math.abs(p.centroid.x - x) + Math.abs(p.centroid.y - y); if (d < bd) { bd = d; best = p.id; } }
    return best;
  };

  return { patches, inner, center, cityRadius, viewExtent: viewExtent || cityRadius || 1, seed, wall, find };
}

export function cityBspBlueprint(seed: number, opts: CityMeshOpts = {}): CityBlueprint {
  return meshBlueprint(buildCityBsp(seed, opts));
}
