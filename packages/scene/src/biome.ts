/**
 * BIOME COMPOSITOR — the reusable engine extracted from forestGen (which won a 5-way render-off).
 *
 * The forest saga taught durable, biome-AGNOSTIC lessons; this module turns them into shared machinery so a
 * new biome is a ~30-line DATA spec, not another bespoke generator:
 *   1. SUB-CELL JITTER (`jitterPlant`) — a sprite owns its INTEGER cell (walkability stays exact) but renders
 *      at a FRACTIONAL col/row. This alone breaks the tiled-grid "orchard" lattice into an organic canopy.
 *   2. WARPED-VORONOI STANDS (`makeStands`) — a few seeds, each ONE dominant species; domain-warp noise
 *      wiggles the seams → coherent single-species MASSES, never a per-cell species salad.
 *   3. FIGURE-GROUND (`composeBiome`) — mass vs negative space, NEVER a uniform statistical scatter. Two mass
 *      shapes so far: `radial` (open focal glade ↔ dense surround — forest) and `patchy` (walkable ground
 *      broken by water pools — swamp). A `mass.shape` is the only thing a genuinely different biome adds.
 *
 * A generator becomes: `const forestGen = (cv, ctx) => composeBiome(cv, ctx, FOREST_SPEC)`.
 */
import { Canvas, entrance, fill, noiseField, place, type Pt, type Rect } from './primitives.js';
import { isTerrain } from './catalog.js';
import type { Contents, GenContext } from './archetypes.js';

// ── small local helpers (kept here so biome.ts is self-contained; siblings of archetypes.ts's copies) ──
const slug = (s: string, i: number) => (s || 'x').replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '') + (i ? `-${i}` : '');
const edgePt = (B: Rect, side: 'north' | 'south' | 'east' | 'west'): Pt => {
  const mc = B.x + Math.floor(B.w / 2), mr = B.y + Math.floor(B.h / 2);
  return side === 'north' ? { c: mc, r: B.y } : side === 'south' ? { c: mc, r: B.y + B.h - 1 } : side === 'west' ? { c: B.x, r: mr } : { c: B.x + B.w - 1, r: mr };
};
const inRect = (B: Rect, c: number, r: number) => c >= B.x && r >= B.y && c < B.x + B.w && r < B.y + B.h;
const pick = (cv: Canvas, tags: string[]): string => tags[Math.floor(cv.rng() * tags.length)] ?? tags[0] ?? 'bush';

// ── 1. SUB-CELL JITTER PLANTER — the single biggest lever against the grid-lattice look ──────────────
/** Reserve the integer cell (walkability stays exact) but push the sprite at a fractional, CLAMPED offset. */
export function jitterPlant(cv: Canvas, c: number, r: number, tag: string, opts?: { block?: boolean; amp?: number }): boolean {
  const block = opts?.block ?? false, amp = opts?.amp ?? 0.7;
  if (!cv.inB(c, r) || cv.occ[r]![c] || (block && !cv.walkable[r]![c])) return false;
  cv.occ[r]![c] = true;
  if (block) cv.walkable[r]![c] = false;
  const j = () => (cv.rng() - 0.5) * amp;
  const jc = Math.max(0, Math.min(cv.cols - 1, c + j())), jr = Math.max(0, Math.min(cv.rows - 1, r + j()));
  cv.ambiance.push({ tag, col: jc, row: jr });
  return true;
}

// ── 2. WARPED-VORONOI STANDS — coherent single-species masses ────────────────────────────────────────
export interface Stand { prim: string; min: string; p: number }
/** Build a `(c,r) → Stand` classifier: a handful of Voronoi seeds (one per palette entry, shuffled),
 *  with the query point domain-warped by noise so the stand seams wiggle instead of forming polygons. */
export function makeStands(cv: Canvas, region: Rect, palette: Stand[], opts?: { warpFreq?: number; warpAmp?: number; salt?: number }): (c: number, r: number) => Stand {
  const warpFreq = opts?.warpFreq ?? 0.09, warpAmp = opts?.warpAmp ?? 7, salt = opts?.salt ?? 0;
  const warpX = noiseField(cv.cols, cv.rows, warpFreq, (cv.seed ^ (0x1111 ^ salt)) >>> 0);
  const warpY = noiseField(cv.cols, cv.rows, warpFreq, (cv.seed ^ (0x2222 ^ salt)) >>> 0);
  const order = cv.shuffle(palette.map((_, i) => i));
  const seeds = order.map((k) => ({
    c: region.x + 3 + Math.floor(cv.rng() * Math.max(1, region.w - 6)),
    r: region.y + 3 + Math.floor(cv.rng() * Math.max(1, region.h - 6)),
    st: palette[k]!,
  }));
  return (c, r) => {
    const wc = c + (warpX[r]![c]! - 0.5) * warpAmp, wr = r + (warpY[r]![c]! - 0.5) * warpAmp;
    let best = 0, bd = Infinity;
    for (let i = 0; i < seeds.length; i++) { const dc = wc - seeds[i]!.c, dr = wr - seeds[i]!.r, dd = dc * dc + dr * dr; if (dd < bd) { bd = dd; best = i; } }
    return seeds[best]!.st;
  };
}
/** Draw the dominant species most of the time, the quiet minority for texture. */
export const pickSpecies = (cv: Canvas, st: Stand): string => (cv.rng() < st.p ? st.prim : st.min);

// ── 3. RADIAL FIELD — a distance-from-centre field + a noise-wobbled core radius ─────────────────────
export interface RadialField { cx: number; cy: number; maxd: number; center: Pt; distOf: (c: number, r: number) => number; coreAt: (c: number, r: number) => number }
export function radialField(cv: Canvas, region: Rect, opts?: { coreR?: number; wobFreq?: number; wobAmp?: number; salt?: number }): RadialField {
  const cx = region.x + (region.w - 1) / 2, cy = region.y + (region.h - 1) / 2, maxd = Math.min(region.w, region.h) / 2;
  const coreR = opts?.coreR ?? 0.32, wobAmp = opts?.wobAmp ?? 0.1;
  const wob = noiseField(cv.cols, cv.rows, opts?.wobFreq ?? 0.16, (cv.seed ^ (0x9a1c ^ (opts?.salt ?? 0))) >>> 0);
  return {
    cx, cy, maxd, center: { c: Math.round(cx), r: Math.round(cy) },
    distOf: (c, r) => Math.hypot((c - cx) / maxd, (r - cy) / maxd),
    coreAt: (c, r) => coreR + (inRect(region, c, r) ? wob[r]![c]! : 0.5) * wobAmp,
  };
}

// ── 4. CARVE A TRAIL — a walkable corridor threaded from an edge to a point (2-wide L-path by default) ─
export function carveTrail(cv: Canvas, from: Pt, to: Pt, opts?: { tag?: string; width?: number }): void {
  const tag = opts?.tag ?? 'trail', w = Math.max(1, opts?.width ?? 2);
  const set = (c: number, r: number) => { if (cv.inB(c, r)) { cv.tiles[r]![c] = tag; cv.walkable[r]![c] = true; cv.occ[r]![c] = true; } };
  let c = from.c, r = from.r;
  for (let k = 0; k < w; k++) set(c + k, r);
  while (r !== to.r) { r += r < to.r ? 1 : -1; for (let k = 0; k < w; k++) set(c + k, r); }
  while (c !== to.c) { c += c < to.c ? 1 : -1; for (let k = 0; k < w; k++) set(c, r + k); }
}

// ── 5. GROUPED VIGNETTE CLUSTERS — a core prop WITH correlated satellites (deadfall = log + toadstools) ─
export function scatterClusters(cv: Canvas, rf: RadialField, o: { core: string[]; satellites: string[]; count: number; satP: number; band: [number, number] }): void {
  const [lo, hi] = o.band;
  for (let n = 0, t = 0; n < o.count && t < o.count * 80; t++) {
    const ang = cv.rng() * Math.PI * 2, rad = lo + cv.rng() * (hi - lo);
    const c = Math.round(rf.cx + Math.cos(ang) * rad * rf.maxd), r = Math.round(rf.cy + Math.sin(ang) * rad * rf.maxd);
    if (!cv.inB(c, r) || cv.occ[r]![c] || !cv.walkable[r]![c]) continue;
    jitterPlant(cv, c, r, pick(cv, o.core), { block: false });
    for (const s of [{ c: c + 1, r }, { c: c - 1, r }, { c, r: r + 1 }]) if (cv.inB(s.c, s.r) && !cv.occ[s.r]![s.c] && cv.rng() < o.satP) jitterPlant(cv, s.c, s.r, pick(cv, o.satellites), { block: false });
    n++;
  }
}

// ── THE SPEC ─────────────────────────────────────────────────────────────────────────────────────────
interface RadialMass {
  shape: 'radial';
  coreR?: number;       // glade fraction of the half-size (small → the mass dominates)   [0.32]
  fringeBand?: number;  // understory ring width just outside the core                     [0.15]
  ramp?: number;        // treeline probability ramp width                                 [0.16]
  clusterBias?: number; // density-noise amplitude (organic knots in the canopy)           [0.34]
  floorFar?: number;    // min density in the deep mass (d>0.95) — never goes sparse        [0.86]
  floorMid?: number;    // min density in the mid mass (d>0.7)                              [0.66]
}
interface PatchyMass {
  shape: 'patchy';
  coreR?: number;         // central dry clearing fraction (kept open for the camp)         [0.24]
  poolFreq?: number;      // noise frequency for the water pools                            [0.16]
  poolThreshold?: number; // noise above this → a water pool                                [0.58]
  deepThreshold?: number; // noise above this → DEEP water                                  [0.72]
  treeP?: number;         // stand (mangrove/dead-tree) density on the mossy ground         [0.16]
  underP?: number;        // understory (fern/vine) density on the ground                   [0.14]
}
export interface BiomeSpec {
  ground?: string;                                     // base terrain (falls back to theme.ground)
  groundWalkable?: boolean;                            // base walkability (default per terrain catalog)
  stands: Stand[];                                     // the species-mass palette
  mass: RadialMass | PatchyMass;                       // the figure-ground shape
  trail?: { tag?: string; width?: number };            // the corridor threaded in from the entrance
  fringe?: { tags: string[]; p: number };              // radial: understory ring · patchy: ground understory
  accent?: { tag: string; p: number; max: number; band: number }; // rare emergent (oak_ancient)
  clusters?: { core: string[]; satellites: string[]; count: number; satP: number; band: [number, number] }; // deadfall
  poolFringe?: { tags: string[]; p: number };          // patchy: reeds/cattails at the water's edge
  waterDecor?: { tags: string[]; p: number };          // patchy: lily pads etc ON the water
  camp?: { trigger: RegExp; tent?: string; fire?: string }; // cast fallback: pitch a camp for a lone NPC
  decor?: { tags: string[]; count: number };           // a few restrained tufts in the focal clearing
}

// ── THE COMPOSER ─────────────────────────────────────────────────────────────────────────────────────
export function composeBiome(cv: Canvas, ctx: GenContext, spec: BiomeSpec): void {
  const B = ctx.bounds;
  fill(cv, B, spec.ground ?? ctx.theme.ground, spec.groundWalkable);
  const rf = radialField(cv, B, { coreR: spec.mass.coreR });

  // TRAIL first — carved BEFORE the mass so the mass opens for it (the mass paint skips reserved cells).
  const ent = edgePt(B, ctx.contents.entranceSide ?? 'south');
  const trailTo = spec.mass.shape === 'patchy'
    ? rf.center
    : { c: Math.round(rf.cx + (ent.c - rf.cx) * 0.4), r: Math.round(rf.cy + (ent.r - rf.cy) * 0.4) };
  if (spec.trail) {
    // A trail tag MUST be a TERRAIN — a prop tag (e.g. 'wooden_board_slats') written into the terrain grid
    // can't be resolved by the renderer and silently falls back to grass (a green scar). Guard it: degrade to
    // a plain dirt path + a provenance note rather than paint grass across the biome.
    const want = spec.trail.tag ?? 'trail';
    const tag = isTerrain(want) ? want : 'dirt';
    if (!isTerrain(want)) cv.notes.push(`biome: trail tag '${want}' is not a terrain (a boardwalk/path must be a TERRAIN, not a prop) → fell back to 'dirt'`);
    carveTrail(cv, ent, trailTo, { ...spec.trail, tag });
  } else {
    // No trail — a walkable-ground biome (a swamp's mossy floor) lets the party ROAM the whole scene; a
    // forced path would read as a scar. Just guarantee the ARRIVAL cell is solid ground (a pool may form on
    // the edge) so the entrance is never stranded in water — a small reserved apron, NOT a corridor.
    const g = spec.ground ?? ctx.theme.ground;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) { const c = ent.c + dc, r = ent.r + dr; if (cv.inB(c, r)) { cv.set(c, r, g, true); cv.occ[r]![c] = true; } }
  }

  const standAt = makeStands(cv, B, spec.stands);
  if (spec.mass.shape === 'patchy') paintPatchy(cv, B, rf, spec, spec.mass, standAt);
  else paintRadial(cv, B, rf, spec, spec.mass, standAt);

  if (spec.clusters) scatterClusters(cv, rf, spec.clusters);
  placeFocalCast(cv, ctx, spec, rf);
  entrance(cv, ent, ctx.locationId);
}

// RADIAL (forest): open glade → bushy fringe → a treeline ramping to a solid, never-sparse wall.
function paintRadial(cv: Canvas, B: Rect, rf: RadialField, spec: BiomeSpec, m: RadialMass, standAt: (c: number, r: number) => Stand): void {
  const fringeBand = m.fringeBand ?? 0.15, ramp = m.ramp ?? 0.16, bias = m.clusterBias ?? 0.34;
  const floorFar = m.floorFar ?? 0.86, floorMid = m.floorMid ?? 0.66;
  const densF = noiseField(cv.cols, cv.rows, 0.13, (cv.seed ^ 0x33cd) >>> 0);
  let accents = 0;
  for (let r = B.y; r < B.y + B.h; r++)
    for (let c = B.x; c < B.x + B.w; c++) {
      if (cv.occ[r]![c]) continue; // trail
      const d = rf.distOf(c, r), gr = rf.coreAt(c, r);
      if (d < gr) continue; // open glade
      if (d < gr + fringeBand) { if (spec.fringe && cv.rng() < spec.fringe.p) jitterPlant(cv, c, r, pick(cv, spec.fringe.tags), { block: false }); continue; }
      let prob = d > 0.9 ? 1 : Math.min(0.97, (d - gr - fringeBand) / ramp);
      prob *= 1 - bias / 2 + densF[r]![c]! * bias;
      prob = Math.max(prob, d > 0.95 ? floorFar : d > 0.7 ? floorMid : 0); // deep mass never sparse
      if (cv.rng() >= prob) continue;
      let tag: string;
      if (spec.accent && accents < spec.accent.max && cv.rng() < spec.accent.p && d > gr + spec.accent.band) { tag = spec.accent.tag; accents++; }
      else tag = pickSpecies(cv, standAt(c, r));
      jitterPlant(cv, c, r, tag, { block: true });
    }
}

// PATCHY (swamp): a walkable mossy ground broken by noise-carved water pools; sparse stands + reed shores;
// a central dry clearing (radial core) kept open for the camp. Base ground stays walkable → connected.
function paintPatchy(cv: Canvas, B: Rect, rf: RadialField, spec: BiomeSpec, m: PatchyMass, standAt: (c: number, r: number) => Stand): void {
  const poolT = m.poolThreshold ?? 0.58, deepT = m.deepThreshold ?? 0.72, treeP = m.treeP ?? 0.16, underP = m.underP ?? 0.14;
  const pf = noiseField(cv.cols, cv.rows, m.poolFreq ?? 0.16, (cv.seed ^ 0x51af) >>> 0);
  const at = (c: number, r: number) => (inRect(B, c, r) ? pf[r]![c]! : 0);
  for (let r = B.y; r < B.y + B.h; r++)
    for (let c = B.x; c < B.x + B.w; c++) {
      if (cv.occ[r]![c]) continue; // boardwalk
      const d = rf.distOf(c, r), gr = rf.coreAt(c, r);
      if (d < gr) continue; // central dry clearing — kept open for the cast
      const pv = at(c, r);
      if (pv > poolT) { // a water pool
        cv.set(c, r, pv > deepT ? 'deep_water' : 'shallow_water', false);
        if (spec.waterDecor && cv.rng() < spec.waterDecor.p) jitterPlant(cv, c, r, pick(cv, spec.waterDecor.tags), { block: false });
        continue;
      }
      // mossy ground: reeds at a pool shore, else a sparse mangrove stand, else understory.
      const shore = at(c - 1, r) > poolT || at(c + 1, r) > poolT || at(c, r - 1) > poolT || at(c, r + 1) > poolT;
      if (shore && spec.poolFringe && cv.rng() < spec.poolFringe.p) { jitterPlant(cv, c, r, pick(cv, spec.poolFringe.tags), { block: false }); continue; }
      if (cv.rng() < treeP) jitterPlant(cv, c, r, pickSpecies(cv, standAt(c, r)), { block: true });
      else if (spec.fringe && cv.rng() < underP) jitterPlant(cv, c, r, pick(cv, spec.fringe.tags), { block: false });
    }
}

// The focal cast — landmarks + NPCs in the clearing, a camp fallback for a lone NPC, mobs prowling the ring,
// restrained decor. Shared by every biome: the mass strategy already laid the walkable clearing under it.
function placeFocalCast(cv: Canvas, ctx: GenContext, spec: BiomeSpec, rf: RadialField): void {
  const c: Contents = ctx.contents;
  const ctr = rf.center;
  const spots: Pt[] = [ctr, { c: ctr.c - 1, r: ctr.r - 1 }, { c: ctr.c + 1, r: ctr.r }, { c: ctr.c, r: ctr.r + 1 }, { c: ctr.c + 2, r: ctr.r }, { c: ctr.c - 1, r: ctr.r + 1 }, { c: ctr.c + 1, r: ctr.r - 1 }];
  // a small dirt/earth pad under the camp so it reads as a made clearing (skip for water-based biomes).
  if (spec.mass.shape === 'radial') for (const [dc, dr] of [[0, 0], [1, 0], [0, 1], [1, 1], [-1, 0], [0, -1], [2, 0], [1, -1]] as [number, number][]) { const cc = ctr.c + dc, rr = ctr.r + dr; if (cv.inB(cc, rr) && !cv.occ[rr]![cc]) cv.set(cc, rr, 'dirt', true); }

  c.landmarks.forEach((l, i) => place(cv, { id: `prop:${slug(l.tag, i)}`, tag: l.tag, kind: 'prop', at: spots[i % spots.length] ?? ctr, ...(l.name ? { name: l.name } : {}) }));
  c.npcs.forEach((n, i) => place(cv, { id: `npc:${slug(n.tag, i)}`, tag: n.tag, kind: 'actor', role: 'npc', at: spots[(i + 3) % spots.length] ?? ctr, ...(n.name ? { name: n.name } : {}) }));

  // CAMP FALLBACK — a lone NPC with no camp prop still gets a pitched camp.
  if (spec.camp && c.npcs.length && !c.landmarks.some((l) => spec.camp!.trigger.test(l.tag))) {
    place(cv, { id: 'prop:camp-tent', tag: spec.camp.tent ?? 'tent', kind: 'prop', at: { c: ctr.c - 1, r: ctr.r - 1 } });
    place(cv, { id: 'prop:camp-fire', tag: spec.camp.fire ?? 'fire_small', kind: 'prop', at: { c: ctr.c + 1, r: ctr.r } });
  }

  // MOBS prowl the clearing-edge ring (place() snaps/carves to a reachable walkable cell).
  let wi = 0;
  for (const m of c.mobs)
    for (let k = 0; k < Math.max(1, Math.min(12, m.count)); k++, wi++) {
      const ang = (wi / 6) * Math.PI * 2 + cv.rng() * 0.6, rad = rf.coreAt(ctr.c, ctr.r) * (0.8 + cv.rng() * 0.3);
      const mc = Math.max(1, Math.min(cv.cols - 2, Math.round(rf.cx + Math.cos(ang) * rad * rf.maxd)));
      const mr = Math.max(1, Math.min(cv.rows - 2, Math.round(rf.cy + Math.sin(ang) * rad * rf.maxd)));
      place(cv, { id: `mob:${slug(m.tag, wi)}`, tag: m.tag, kind: 'actor', role: 'mob', at: { c: mc, r: mr } });
    }

  // restrained decor in the open clearing.
  if (spec.decor) for (let i = 0; i < spec.decor.count; i++) {
    const dc = ctr.c + Math.round((cv.rng() - 0.5) * 7), dr = ctr.r + Math.round((cv.rng() - 0.5) * 5);
    if (cv.inB(dc, dr) && !cv.occ[dr]![dc] && cv.walkable[dr]![dc] && rf.distOf(dc, dr) < rf.coreAt(dc, dr)) jitterPlant(cv, dc, dr, pick(cv, spec.decor.tags), { block: false });
  }
}
