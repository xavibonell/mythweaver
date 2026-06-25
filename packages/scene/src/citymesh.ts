/**
 * CityMesh — the block-centric layout core (Stage A of the town/city generator).
 *
 * The big inversion that fixes the "reads as a grid" problem: we build the BLOCKS (cells) first and
 * let roads/walls/zoning derive from them, instead of laying an axis-aligned street grid and chopping
 * rectangles out of it. Districts ARE the cells of a Voronoi mesh; everything downstream (wall =
 * circumference of the core, streets = cell edges, wards = cell types, lots = cell subdivisions) is a
 * function of this mesh. Reimplemented clean from watabou's published Medieval Fantasy City Generator
 * algorithm (GPL-3.0 source studied, no code copied).
 *
 * This module is pure float geometry (world units ≈ tiles); the rasterizer (city-realizer.ts) maps it
 * onto the 16px tile grid as a final step. Deterministic: one `makeRng(seed)` stream, fixed call order.
 */
import { Delaunay } from 'd3-delaunay';
import { makeRng } from './cartographer.js';

export interface Vec2 { x: number; y: number; }

/** One Voronoi cell = one ward/block — the atomic unit (mirrors watabou's Patch). */
export interface Patch {
  id: number;
  site: Vec2; // the (relaxed) seed point
  poly: Vec2[]; // cell boundary ring (CCW, no closing dup)
  centroid: Vec2;
  distToCenter: number;
  withinCity: boolean; // one of the nPatches central patches (the urban core)
  neighbours: number[]; // adjacent patch ids (shared Voronoi edge)
}

/** The whole settlement layout, in float world units. */
export interface CityMesh {
  patches: Patch[];
  inner: number[]; // ids of the in-city core patches, nearest-first
  center: Vec2;
  cityRadius: number; // farthest inner centroid from center
  viewExtent: number; // world half-extent that contains the whole city (for rasterizing to a tile rect)
  seed: number;
  /** Nearest patch id to a world point (for closest-seed rasterization). */
  find: (x: number, y: number) => number;
}

export interface CityMeshOpts {
  nPatches?: number; // target # of in-city patches (~6 hamlet · 10 town · 15 city · 24 large city)
}

/** Area-weighted polygon centroid (falls back to vertex mean for degenerate cells). */
function centroidOf(poly: Vec2[]): Vec2 {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!, q = poly[(i + 1) % poly.length]!;
    const cross = p.x * q.y - q.x * p.y;
    a += cross; cx += (p.x + q.x) * cross; cy += (p.y + q.y) * cross;
  }
  if (Math.abs(a) < 1e-9) {
    const n = poly.length || 1;
    return { x: poly.reduce((s, p) => s + p.x, 0) / n, y: poly.reduce((s, p) => s + p.y, 0) / n };
  }
  a *= 0.5;
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
const polyOf = (cell: Delaunay.Polygon | null, fallback: Vec2): Vec2[] =>
  cell ? cell.slice(0, -1).map(([x, y]) => ({ x, y })) : [fallback];

/**
 * Build the layout mesh: spiral-seed a point field (dense center, loose fringe), Voronoi it, relax the
 * central cells (3 Lloyd passes) so they read hand-placed, then classify the nPatches nearest cells as
 * the urban core. The spiral + relaxation is the single biggest anti-grid lever.
 */
export function buildCityMesh(seed: number, opts: CityMeshOpts = {}): CityMesh {
  const rng = makeRng(seed >>> 0);
  const nPatches = Math.max(4, Math.min(40, Math.floor(opts.nPatches ?? 15)));
  const nSeeds = nPatches * 8; // a field much larger than the core → the city sits in open country

  // Spiral seed field: angle accrues by a shrinking step (√i), radius grows ~linearly → density falls
  // off from the center (old dense core, sprawling outskirts).
  const sa = rng() * Math.PI * 2;
  let sites: Vec2[] = [];
  for (let i = 0; i < nSeeds; i++) {
    const a = sa + Math.sqrt(i) * 5;
    const r = 10 + i * (2 + rng());
    sites.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  let maxR = 0;
  for (const s of sites) maxR = Math.max(maxR, Math.hypot(s.x, s.y));
  const bound: [number, number, number, number] = [-maxR * 1.2, -maxR * 1.2, maxR * 1.2, maxR * 1.2];

  // 3 Lloyd passes on the CENTRAL sites only — keep the outer field loose so the fringe stays organic.
  const relaxCount = Math.min(nSeeds, nPatches * 3);
  for (let pass = 0; pass < 3; pass++) {
    const del = Delaunay.from(sites, (s) => s.x, (s) => s.y);
    const vor = del.voronoi(bound);
    const next = sites.slice();
    for (let i = 0; i < relaxCount; i++) {
      const poly = polyOf(vor.cellPolygon(i), sites[i]!);
      if (poly.length >= 3) next[i] = centroidOf(poly);
    }
    sites = next;
  }

  // Final mesh.
  const del = Delaunay.from(sites, (s) => s.x, (s) => s.y);
  const vor = del.voronoi(bound);
  const patches: Patch[] = sites.map((site, id) => {
    const poly = polyOf(vor.cellPolygon(id), site);
    return { id, site, poly, centroid: poly.length >= 3 ? centroidOf(poly) : site, distToCenter: 0, withinCity: false, neighbours: [...del.neighbors(id)] };
  });

  // Center = centroid of the most-central patch (provisional center = origin); then re-measure from it.
  for (const p of patches) p.distToCenter = Math.hypot(p.centroid.x, p.centroid.y);
  const center = patches.slice().sort((a, b) => a.distToCenter - b.distToCenter || a.id - b.id)[0]!.centroid;
  for (const p of patches) p.distToCenter = dist(p.centroid, center);
  const inner = patches.slice().sort((a, b) => a.distToCenter - b.distToCenter || a.id - b.id).slice(0, nPatches).map((p) => p.id);
  for (const id of inner) patches[id]!.withinCity = true;

  let cityRadius = 0, viewExtent = 0;
  for (const id of inner) {
    const p = patches[id]!;
    cityRadius = Math.max(cityRadius, p.distToCenter);
    for (const v of p.poly) viewExtent = Math.max(viewExtent, dist(v, center));
  }

  return { patches, inner, center, cityRadius, viewExtent: viewExtent || cityRadius || 1, seed, find: (x, y) => del.find(x, y) };
}
