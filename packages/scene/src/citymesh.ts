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

/** A patch's place in the settlement: the walled/dense CORE, the EXTRAMURAL ring just outside it (kept
 *  for flavour — scattered farms, a roadside vendor, a camp), or open RURAL country beyond. */
export type Zone = 'core' | 'extramural' | 'rural';

/** One Voronoi cell = one ward/block — the atomic unit (mirrors watabou's Patch). */
export interface Patch {
  id: number;
  site: Vec2; // the (relaxed) seed point
  poly: Vec2[]; // cell boundary ring (CCW, no closing dup)
  centroid: Vec2;
  distToCenter: number;
  withinCity: boolean; // one of the nPatches central patches (the urban core)
  zone: Zone;
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
  wall?: { ring: Vec2[]; gates: Vec2[] }; // the curtain wall (only when walled) — traces the core only
  /** Nearest patch id to a world point (for closest-seed rasterization). */
  find: (x: number, y: number) => number;
}

export interface CityMeshOpts {
  nPatches?: number; // target # of in-city patches (~6 hamlet · 10 town · 15 city · 24 large city)
  wall?: boolean; // build a curtain wall around the core (default true). Not every settlement is walled.
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

// --- wall geometry (M1) -----------------------------------------------------

const qk = (v: Vec2) => `${Math.round(v.x * 4)},${Math.round(v.y * 4)}`; // quantize to weld shared vertices

/** Split the core's polygon edges into the outer BOUNDARY (an edge used by exactly one core cell → the
 *  wall runs here) and record interior JUNCTION vertices (shared edges → where a street meets the wall). */
function coreEdgeSets(patches: Patch[], inner: number[]): { boundary: [Vec2, Vec2][]; junctions: Set<string> } {
  const ek = (a: Vec2, b: Vec2) => { const ka = qk(a), kb = qk(b); return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`; };
  const m = new Map<string, { a: Vec2; b: Vec2; n: number }>();
  for (const id of inner) {
    const poly = patches[id]!.poly;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
      const k = ek(a, b), e = m.get(k);
      if (e) e.n++; else m.set(k, { a, b, n: 1 });
    }
  }
  const boundary: [Vec2, Vec2][] = [];
  const junctions = new Set<string>();
  for (const e of m.values()) {
    if (e.n === 1) boundary.push([e.a, e.b]);
    else { junctions.add(qk(e.a)); junctions.add(qk(e.b)); }
  }
  return { boundary, junctions };
}

/** Walk the boundary segments into one ordered closed loop of vertices. */
function orderRing(boundary: [Vec2, Vec2][]): Vec2[] {
  if (!boundary.length) return [];
  const nbr = new Map<string, string[]>();
  const pt = new Map<string, Vec2>();
  const pushN = (k: string, v: string) => { const a = nbr.get(k); if (a) a.push(v); else nbr.set(k, [v]); };
  for (const [a, b] of boundary) { const ka = qk(a), kb = qk(b); pt.set(ka, a); pt.set(kb, b); pushN(ka, kb); pushN(kb, ka); }
  const startK = qk(boundary[0]![0]);
  const ring: Vec2[] = [pt.get(startK)!];
  let prev = '', cur = startK;
  for (let g = 0; g < boundary.length + 4; g++) {
    const ns = nbr.get(cur) ?? [];
    const next = ns.find((k) => k !== prev) ?? ns[0];
    if (!next || next === startK) break;
    ring.push(pt.get(next)!);
    prev = cur; cur = next;
  }
  return ring;
}

/** Chaikin corner-cutting → a smooth, rounded, irregular wall (not a polygon template). */
function chaikin(loop: Vec2[], iters: number): Vec2[] {
  let r = loop;
  for (let it = 0; it < iters && r.length >= 3; it++) {
    const out: Vec2[] = [];
    for (let i = 0; i < r.length; i++) {
      const p = r[i]!, q = r[(i + 1) % r.length]!;
      out.push({ x: p.x * 0.75 + q.x * 0.25, y: p.y * 0.75 + q.y * 0.25 });
      out.push({ x: p.x * 0.25 + q.x * 0.75, y: p.y * 0.25 + q.y * 0.75 });
    }
    r = out;
  }
  return r;
}

/** Gates where streets meet the wall (boundary junction vertices), thinned so they're spaced apart. */
function gatesOf(ring: Vec2[], junctions: Set<string>): Vec2[] {
  const cand: number[] = [];
  for (let i = 0; i < ring.length; i++) if (junctions.has(qk(ring[i]!))) cand.push(i);
  if (!cand.length) return [];
  const minGap = Math.max(2, Math.floor(ring.length / 7));
  const keep: Vec2[] = [];
  let last = -1e9;
  for (const i of cand) if (i - last >= minGap) { keep.push(ring[i]!); last = i; }
  return keep;
}

/** A curtain wall traced around the union of the `inner` (core) patches: the boundary ordered into a
 *  loop, optionally Chaikin-smoothed (Voronoi → curved; BSP → keep rectilinear), with gates at junctions.
 *  Shared by both blueprint engines. */
export function coreWall(patches: Patch[], inner: number[], smooth: boolean): { ring: Vec2[]; gates: Vec2[] } | undefined {
  const { boundary, junctions } = coreEdgeSets(patches, inner);
  const raw = orderRing(boundary);
  if (raw.length < 3) return undefined;
  return { ring: smooth ? chaikin(raw, 2) : raw, gates: gatesOf(raw, junctions) };
}

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
    return { id, site, poly, centroid: poly.length >= 3 ? centroidOf(poly) : site, distToCenter: 0, withinCity: false, zone: 'rural' as Zone, neighbours: [...del.neighbors(id)] };
  });

  // Center = centroid of the most-central patch (provisional center = origin); then re-measure from it.
  for (const p of patches) p.distToCenter = Math.hypot(p.centroid.x, p.centroid.y);
  const center = patches.slice().sort((a, b) => a.distToCenter - b.distToCenter || a.id - b.id)[0]!.centroid;
  for (const p of patches) p.distToCenter = dist(p.centroid, center);
  const inner = patches.slice().sort((a, b) => a.distToCenter - b.distToCenter || a.id - b.id).slice(0, nPatches).map((p) => p.id);
  for (const id of inner) patches[id]!.withinCity = true;

  // Classify every patch: core (the city), extramural (touches the core → the kept flavour ring just
  // outside any wall), or rural (open country beyond). The extramural ring is preserved for later fills.
  const innerSet = new Set(inner);
  for (const p of patches) p.zone = p.withinCity ? 'core' : (p.neighbours.some((n) => innerSet.has(n)) ? 'extramural' : 'rural');

  let cityRadius = 0, viewExtent = 0;
  for (const id of inner) {
    const p = patches[id]!;
    cityRadius = Math.max(cityRadius, p.distToCenter);
    for (const v of p.poly) viewExtent = Math.max(viewExtent, dist(v, center));
  }

  // Curtain wall (optional) — a smoothed ring around the CORE ONLY, with gates where streets meet it.
  // Without a wall the extramural ring is just open outskirts; the zoning is unchanged either way.
  const wall = opts.wall !== false ? coreWall(patches, inner, true) : undefined;

  // Tile assignment uses the L1 / MANHATTAN metric (not Euclidean d3.find): under L1 the bisector between
  // two sites is axis-aligned + 45° only, so the rasterized cell seams collapse to H/V/45° runs and the
  // cobble streets render far cleaner than arbitrary-angle staircases.
  const find = (x: number, y: number) => {
    let best = 0, bd = Infinity;
    for (let i = 0; i < sites.length; i++) { const s = sites[i]!; const d = Math.abs(s.x - x) + Math.abs(s.y - y); if (d < bd) { bd = d; best = i; } }
    return best;
  };
  return { patches, inner, center, cityRadius, viewExtent: viewExtent || cityRadius || 1, seed, wall, find };
}

// --- blueprint payload (for the Scene Lab "Blueprint" tab) -------------------

export interface BlueprintPatch { z: Zone; poly: [number, number][]; st: [number, number] }
export interface CityBlueprint {
  seed: number;
  nPatches: number;
  center: [number, number];
  viewExtent: number;
  patches: BlueprintPatch[];
  adj: [[number, number], [number, number]][]; // core centroid↔centroid links (the street skeleton)
  wall?: { ring: [number, number][]; gates: [number, number][] };
}

/**
 * A compact, integer-rounded snapshot of the mesh for the Blueprint inspector: the cells near the city
 * (core flagged), the seed points, and the core adjacency graph. The client derives the wall (boundary
 * edges) and street corridors (shared edges) from the polygons — proving they fall out of the mesh.
 */
export function meshBlueprint(m: CityMesh): CityBlueprint {
  const R = Math.round;
  const innerSet = new Set(m.inner);
  const [cx, cy] = [m.center.x, m.center.y];
  const lim = m.viewExtent * 1.45; // core + one ring of countryside for context
  const patches: BlueprintPatch[] = m.patches
    .filter((p) => Math.hypot(p.centroid.x - cx, p.centroid.y - cy) <= lim)
    .map((p) => ({ z: p.zone, poly: p.poly.map((v) => [R(v.x), R(v.y)] as [number, number]), st: [R(p.site.x), R(p.site.y)] }));
  const adj: [[number, number], [number, number]][] = [];
  for (const id of m.inner) for (const nb of m.patches[id]!.neighbours)
    if (innerSet.has(nb) && id < nb) adj.push([[R(m.patches[id]!.centroid.x), R(m.patches[id]!.centroid.y)], [R(m.patches[nb]!.centroid.x), R(m.patches[nb]!.centroid.y)]]);
  const wall = m.wall ? { ring: m.wall.ring.map((v) => [R(v.x), R(v.y)] as [number, number]), gates: m.wall.gates.map((v) => [R(v.x), R(v.y)] as [number, number]) } : undefined;
  return { seed: m.seed, nPatches: m.inner.length, center: [R(cx), R(cy)], viewExtent: R(m.viewExtent), patches, adj, wall };
}

export function cityMeshBlueprint(seed: number, opts: CityMeshOpts = {}): CityBlueprint {
  return meshBlueprint(buildCityMesh(seed, opts));
}
