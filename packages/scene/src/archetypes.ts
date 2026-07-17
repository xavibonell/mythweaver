/**
 * ARCHETYPE GENERATORS — the layout fix. The LLM is DEMOTED from layout artist (placing building
 * rectangles, which it does in a boring even grid) to an archetype + CONTENTS picker; a deterministic
 * generator owns the organic spatial composition. This is the lever the reference tools (Watabou's
 * Medieval Fantasy City Generator, Parish-Müller) actually use: the magic is a layout ALGORITHM, not a
 * smarter prompt.
 *
 * A generator MUTATES a Canvas exactly like a primitive (it calls fill/plaza/building/scatter/…), so
 * finalize() and everything below it (renderer, validators, combat) are unchanged. Five archetypes sit
 * behind one registry; the program selects ONE via the `{op:'archetype'}` op.
 *
 * The TOWN generator is the centrepiece — recursive-bisection street network (irregular blocks) → OBB
 * recursive parcel subdivision with a soft random stop (varied footprints) → buildings that ADDRESS the
 * nearest street, a central plaza + landmark, and two-texture density (blue-noise spread + noise clumps).
 * The other four are thin wrappers over existing topology primitives (bspRooms/cave/clearing/island),
 * proving the seam generalizes. Honest ceiling: this reaches Watabou "Toy-Town" / Zelda-roguelike-SCREEN
 * quality (organic streets, varied lots, density) — NOT a hand-authored artist map's bespoke set-pieces.
 */

import type { BuildingType } from '@mythweaver/shared';
import {
  building, bspRooms, Canvas, cave, clumpScatter, compound, entrance, fill, island, noiseField, path, place, plaza, poissonScatter, scatter, vignette, wallRing,
  type Pt, type Rect,
} from './primitives.js';
import { SHAPE_MIN, type ShapeKind } from './footprint.js';
import { carveCanal, routeSeam, type MaterialProfile } from './networks.js';
import { wallBaseOf, type Theme } from './themes.js';

/** The semantic cast the LLM (or a completeness net) supplies — names + which things exist, NO geometry. */
export interface Contents {
  buildings: { type: BuildingType; name?: string; waterfront?: boolean }[];
  landmarks: { tag: string; name?: string }[];
  /** `anchor` = the character's STATION from the fiction ("near:forge", "at the well") — the cast
   *  contract: an anchored NPC stands AT their post, never round-robined onto a street cell. */
  npcs: { tag: string; name?: string; anchor?: string }[];
  mobs: { tag: string; count: number }[];
  wall?: boolean;
  entranceSide?: 'north' | 'south' | 'east' | 'west';
  /** A CANAL threads the town (Weave L1 — the main artery becomes a water seam with bridges). */
  canal?: boolean;
  /** A COAST — the sea takes a map edge (deep water · shallows · beach), the town sits inland. */
  coast?: boolean;
  /** MOUNTAINS — a rock massif takes a map edge; the town sits on the land beside it. */
  mountain?: boolean;
  /** A PORT — piers + boats + dockworkers attached to the coast frontier (implies `coast`). */
  port?: boolean;
  /** A MINE — a cave mouth + ore + miners attached to the mountain frontier (implies `mountain`). */
  mine?: boolean;
  /** The town's CHARACTER — drives context-appropriate furnishing (centerpiece, park) so a mining camp
   *  doesn't get a genteel fountain. Derived from the brief + buildings in harvestTownContents. */
  character?: 'mining' | 'port' | 'market' | 'civic' | 'rough' | 'grim';
}
export interface GenContext {
  theme: Theme;
  contents: Contents;
  bounds: Rect;
  locationId: string;
}
export type ArchetypeGenerator = (cv: Canvas, ctx: GenContext) => void;
export type ArchetypeKind = 'town' | 'dungeon' | 'cave' | 'wilderness' | 'coast' | 'forest';

const slug = (s: string, i: number) => (s || 'x').replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '') + (i ? `-${i}` : '');

/** Resolve a cast anchor ("near:forge", "at the well", "in:the inn") against the map's REAL objects:
 *  a named object first, then a signature tag (forge/anvil/well/altar/bar…), then an id fragment.
 *  Returns the free cell nearest the match (the person stands AT the thing) + the match's building
 *  keeper when one exists (so `in:` anchors can merge identity onto the keeper). Null = no match —
 *  the caller REPORTS it; we never guess a wrong post silently. */
export function resolveCastStation(cv: Canvas, anchor: string): { at: Pt; what: string; keeper?: { id: string; name?: string } } | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const word = anchor.toLowerCase().replace(/^(near|at|in|by|outside|beside)\s*[:\s]\s*/, '').replace(/^(the|a|an)\s+/, '').trim();
  const nw = norm(word);
  if (!nw) return null;
  const objs = cv.objects;
  const target =
    objs.find((o) => o.name && (norm(o.name).includes(nw) || nw.includes(norm(o.name)))) ??
    objs.find((o) => o.kind !== 'actor' && (norm(o.tag) === nw || (nw.length > 3 && (norm(o.tag).includes(nw) || nw.includes(norm(o.tag)))))) ??
    objs.find((o) => nw.length > 3 && norm(o.id).includes(nw));
  if (!target) return null;
  // Nearest free cell to the match, radius ≤ 4 — the post, not a random street.
  let at: Pt | null = null;
  let bestD = Infinity;
  for (let dr = -4; dr <= 4; dr++) for (let dc = -4; dc <= 4; dc++) {
    const c = target.col + dc, r = target.row + dr;
    if (!cv.isFree(c, r) || !cv.walkable[r]?.[c]) continue;
    const d = dc * dc + dr * dr;
    if (d < bestD) { bestD = d; at = { c, r }; }
  }
  if (!at) return null;
  // The match's building keeper (id convention: prop:<loc>-bN#k ↔ npc:<loc>-bN[-rX]-keeper).
  const bpref = target.id.replace(/^(prop|fixture|bldg):/, '').replace(/#\d+$/, '');
  const keeper = bpref ? objs.find((o) => o.role === 'npc' && o.id.endsWith('-keeper') && o.id.includes(bpref)) : undefined;
  return { at, what: target.name ?? target.tag, ...(keeper ? { keeper } : {}) };
}
const wmatOf = (t: Theme): string => wallBaseOf(t.wallMat);
const edgePt = (B: Rect, side: 'north' | 'south' | 'east' | 'west'): Pt => {
  const mc = B.x + Math.floor(B.w / 2), mr = B.y + Math.floor(B.h / 2);
  return side === 'north' ? { c: mc, r: B.y } : side === 'south' ? { c: mc, r: B.y + B.h - 1 } : side === 'west' ? { c: B.x, r: mr } : { c: B.x + B.w - 1, r: mr };
};
const rectCenter = (r: Rect): Pt => ({ c: r.x + Math.floor(r.w / 2), r: r.y + Math.floor(r.h / 2) });

type FieldSide = 'north' | 'south' | 'east' | 'west';
/** Reserve an edge BAND of the bounds as a terrain FIELD (Weave field primitive) and shrink `interior`
 *  off it, so the settlement lays out on land and the field forms a coherent frontier (autotiled at
 *  bake) — the same `fill`+autotile machinery that makes lakes, now triggered from the fiction. coast =
 *  a beach → shallows → deep-water gradient; mountain = an impassable rock massif. No-op if the band
 *  would starve the buildable interior. Mutates `interior`. */
function reserveEdgeField(cv: Canvas, B: Rect, interior: Rect, kind: 'coast' | 'mountain', avoid?: FieldSide): { edge: FieldSide; band: Rect } | null {
  const opp: Record<FieldSide, FieldSide> = { north: 'south', south: 'north', east: 'west', west: 'east' };
  let edge: FieldSide = kind === 'coast' ? 'east' : 'west';
  if (edge === avoid) edge = opp[edge];
  const horiz = edge === 'east' || edge === 'west';
  const band = Math.max(5, Math.floor((horiz ? B.w : B.h) * 0.26));
  const cut = band + 1;
  if (horiz ? interior.w - cut < 16 : interior.h - cut < 16) return null; // don't starve the town
  const full: Rect = edge === 'west' ? { x: B.x, y: B.y, w: band, h: B.h }
    : edge === 'east' ? { x: B.x + B.w - band, y: B.y, w: band, h: B.h }
    : edge === 'north' ? { x: B.x, y: B.y, w: B.w, h: band }
    : { x: B.x, y: B.y + B.h - band, w: B.w, h: band };
  // a strip `w` tiles wide, `offset` in from the LAND-facing side of the band, running seaward.
  const strip = (offset: number, w: number): Rect =>
    edge === 'east' ? { x: full.x + offset, y: B.y, w, h: B.h }
    : edge === 'west' ? { x: full.x + band - offset - w, y: B.y, w, h: B.h }
    : edge === 'south' ? { x: B.x, y: full.y + offset, w: B.w, h: w }
    : { x: B.x, y: full.y + band - offset - w, w: B.w, h: w };
  if (kind === 'mountain') {
    // A CLIFF, not a flat fill: a JAGGED body of dark rock (bakeRockMass gives it a town-facing vertical
    // FACE), a cast SHADOW on the grass at its foot (the top-down depth cue), and boulder scree — so it
    // reads as impassable high ground, not a desert texture. Rock cells set directly (non-walkable).
    const g = frontierGeom(full, edge);
    const depth = edge === 'east' || edge === 'west' ? full.w : full.h;
    const scree = ['boulder', 'rocks_grey', 'rocks_brown', 'stone_pile'];
    for (let a = 0; a < g.len; a++) {
      const jit = Math.floor(cv.rng() * 4); // pull the face back 0–3 tiles → irregular silhouette
      for (let d = jit; d < depth; d++) {
        const c = g.sx + g.ax * a + g.ix * d, r = g.sy + g.ay * a + g.iy * d;
        if (cv.inB(c, r)) { cv.tiles[r]![c] = 'rock_wall'; cv.walkable[r]![c] = false; }
      }
      const fc = g.sx + g.ax * a + g.ix * (jit - 1), fr = g.sy + g.ay * a + g.iy * (jit - 1); // grass foot, in front of the face
      if (cv.inB(fc, fr) && cv.walkable[fr]?.[fc]) {
        cv.ambiance.push({ tag: 'cliff_shadow', col: fc, row: fr });
        if (a % 3 === 1) cv.ambiance.push({ tag: scree[Math.floor(cv.rng() * scree.length)]!, col: fc, row: fr });
      }
    }
    // OVERWORLD PEAKS: a dense cluster of grey stone mountain-peak icons over the rock builds a legible
    // mountain-RANGE silhouette (the top-down convention that reads as "mountains"). Weighted toward BARE
    // stone (peak_a), with snow-capped summits (peak_b/c) sprinkled in — a rugged range, not a snowfield.
    const peaks = ['peak_a', 'peak_a', 'peak_a', 'peak_b', 'peak_c'];
    for (let a = 0; a < g.len; a++)
      for (let d = 1; d < depth; d++) {
        const c = g.sx + g.ax * a + g.ix * d, r = g.sy + g.ay * a + g.iy * d;
        if (cv.inB(c, r) && (cv.tiles[r]?.[c] ?? '').startsWith('rock_wall') && cv.rng() < 0.34)
          cv.ambiance.push({ tag: peaks[Math.floor(cv.rng() * peaks.length)]!, col: c, row: r });
      }
  } else {
    fill(cv, full, 'water_deep', false); // open sea
    fill(cv, strip(1, 2), 'water', false); // shallows
    fill(cv, strip(0, 1), 'sand', true); // beach (walkable)
  }
  if (edge === 'west') { interior.x += cut; interior.w -= cut; }
  else if (edge === 'east') { interior.w -= cut; }
  else if (edge === 'north') { interior.y += cut; interior.h -= cut; }
  else { interior.h -= cut; }
  return { edge, band: full };
}

/** Frontier geometry: a point on the field's LAND-facing edge + a unit vector INTO the field + a unit
 *  vector ALONG the frontier + the frontier length. Lets a frontier FEATURE be placed by (along, depth)
 *  offsets regardless of which edge the field took. */
function frontierGeom(band: Rect, edge: FieldSide): { sx: number; sy: number; ix: number; iy: number; ax: number; ay: number; len: number } {
  switch (edge) {
    case 'east': return { sx: band.x, sy: band.y, ix: 1, iy: 0, ax: 0, ay: 1, len: band.h };
    case 'west': return { sx: band.x + band.w - 1, sy: band.y, ix: -1, iy: 0, ax: 0, ay: 1, len: band.h };
    case 'north': return { sx: band.x, sy: band.y + band.h - 1, ix: 0, iy: -1, ax: 1, ay: 0, len: band.w };
    default: return { sx: band.x, sy: band.y, ix: 0, iy: 1, ax: 1, ay: 0, len: band.w }; // south
  }
}

/** FRONTIER FEATURE (Weave L3 seed): attach a COMPOSITE (structure + props + cast) at a field's frontier,
 *  facing the town. A PORT reaches piers into the sea; a MINE opens a mouth in the rock face. Both are the
 *  SAME move — differ only in the data below — so lighthouse/quarry/fishing-hut/shrine are future rows, not
 *  new code. Placed straight into the decorative layer + walkability (the field cells aren't place()-able). */
function placeFrontierFeature(cv: Canvas, band: Rect, edge: FieldSide, kind: 'port' | 'mine', locationId: string): void {
  const g = frontierGeom(band, edge);
  if (g.len < 5) return;
  const mid = Math.floor(g.len / 2);
  const cellAt = (a: number, d: number): Pt => ({ c: g.sx + g.ax * a + g.ix * d, r: g.sy + g.ay * a + g.iy * d });
  const deco = (tag: string, p: Pt, walk = false): void => { if (cv.inB(p.c, p.r)) { cv.ambiance.push({ tag, col: p.c, row: p.r }); if (walk) cv.walkable[p.r]![p.c] = true; } };
  const put = (tag: string, p: Pt, kindOf: 'prop' | 'actor', role?: 'npc'): void => { if (cv.inB(p.c, p.r)) place(cv, { id: `${kindOf}:frontier-${slug(locationId, 0)}-${p.c}-${p.r}`, tag, kind: kindOf, ...(role ? { role } : {}), at: p }); };

  if (kind === 'port') {
    // A real WHARF, not a rope-bridge: a wooden QUAY (plank boardwalk) along the shore + a plank PIER
    // finger reaching into the water, both painted as `wood_floor` terrain (proper planks) and made
    // walkable. Mooring pilings line the pier, boats lie alongside, crates/rope/workers clutter the quay.
    const along = g.len;
    const maxDepth = edge === 'east' || edge === 'west' ? band.w : band.h;
    const pierLen = Math.max(4, Math.min(7, maxDepth - 1));
    const inAlong = (a: number) => a >= 0 && a < along;
    const plank = (a: number, d: number): void => { const p = cellAt(a, d); if (cv.inB(p.c, p.r)) { cv.tiles[p.r]![p.c] = 'wood_floor'; cv.walkable[p.r]![p.c] = true; } };
    const moor = (tag: string, a: number, d: number): void => { if (inAlong(a)) deco(tag, cellAt(a, d)); };
    // (1) QUAY — a plank boardwalk hugging the shore (d = 0..1), a few tiles either side of the pier.
    const quayHalf = Math.max(1, Math.min(4, Math.floor(along / 2) - 1));
    for (let a = mid - quayHalf; a <= mid + quayHalf; a++) if (inAlong(a)) { plank(a, 0); plank(a, 1); }
    // (2) PIER — a 2-wide plank finger out into the water.
    for (let d = 1; d <= pierLen; d++) { plank(mid, d); plank(mid + 1, d); }
    // (3) PILINGS — mooring posts down the pier edges + a pair at the head (decorative, in the water).
    for (let d = 2; d <= pierLen; d += 2) { moor('piling', mid - 1, d); moor('piling', mid + 2, d); }
    moor('piling', mid, pierLen + 1); moor('piling', mid + 1, pierLen + 1);
    // (4) BOATS moored ALONGSIDE the pier — floating in the water off each flank, hull PARALLEL to the pier
    // (long axis = the pier's inward axis), bow pointing out to open sea. The oriented sprite (n/e/s/w) is
    // chosen so the boat lies alongside, never bow-on and never on top of the planks.
    const SEA_DIR = { east: 'e', west: 'w', north: 'n', south: 's' } as const;
    const bd = SEA_DIR[edge];
    moor(`boat_sail_${bd}`, mid - 3, Math.max(2, pierLen - 2)); // port side — a boat-length off, clear of the piling rail
    moor(`boat_${bd}`, mid + 3, Math.max(2, pierLen - 2));      // starboard side, out in the water (clear of planks)
    // (5) QUAY CLUTTER — crates/barrels/rope + a couple of dockworkers on the planks.
    put('crate', cellAt(mid - quayHalf, 0), 'prop'); put('barrel', cellAt(mid + quayHalf, 0), 'prop');
    moor('rope_coil', mid - 1, 1); moor('crate', mid + quayHalf - 1, 1);
    for (let i = 0; i < 2; i++) put('villager', cellAt(mid + i, 2 + i), 'actor', 'npc');
  } else {
    // MINE: a mouth in the rock face (frontier cell, made walkable so it reads as an opening), an ore
    // vein glinting deeper in the rock, cargo + dwarf miners on the land apron just outside.
    deco('mine_entrance', cellAt(mid, 0), true);
    deco('ore_vein', cellAt(mid - 1, 1)); deco('ore_vein', cellAt(mid + 1, 1)); deco('ore_vein', cellAt(mid, 2));
    // land apron just outside the mouth: an ore cart + crate + dwarf miners (the "this is a working mine" cast)
    put('minecart', cellAt(mid + 2, -1), 'prop'); put('crate', cellAt(mid - 2, -1), 'prop');
    for (let i = 0; i < 2; i++) put('dwarf', cellAt(mid - i, -1), 'actor', 'npc');
  }
}

// ---------------------------------------------------------------------------
// TOWN — the real procedural-settlement algorithm.
// ---------------------------------------------------------------------------

const TOWN_VIGNETTES = new Set(['well', 'market', 'shrine', 'graveyard', 'forge']);

/** "Stone laid on soil": paint a 1-tile DIRT rim on the grass immediately around PAVED areas (plaza +
 *  cobble arteries), so stone meets earth then grass instead of an abrupt cobble↔grass cut — the
 *  hand-crafted transition the credibility judge flagged as missing in every scene. Only repaints plain
 *  grass (never buildings / the rock or water fields / alleys, which are already dirt). Runs before the
 *  autotile bake, so the road curb + grass fringe then form around the new dirt band automatically. */
function dirtRimPaving(cv: Canvas): void {
  const PAVED = new Set(['road', 'flagstone', 'cobblestone']);
  const orig = cv.tiles.map((row) => row.slice());
  const paved = (c: number, r: number) => c >= 0 && r >= 0 && c < cv.cols && r < cv.rows && PAVED.has(orig[r]![c] ?? '');
  for (let r = 0; r < cv.rows; r++)
    for (let c = 0; c < cv.cols; c++) {
      if (orig[r]![c] !== 'grass') continue;
      // a WORN rim (probabilistic), not a solid dirt band — so grass stays the dominant ground and the
      // paving reads as "stone laid on soil", never "the town sits on bare dirt".
      if ((paved(c, r - 1) || paved(c + 1, r) || paved(c, r + 1) || paved(c - 1, r)) && cv.rng() < 0.5) cv.tiles[r]![c] = 'dirt';
    }
}

function townGen(cv: Canvas, ctx: GenContext): void {
  const { theme, contents, locationId } = ctx;
  const B = ctx.bounds;
  const path = theme.path, ground = theme.ground;
  const ARTERY = 'road'; // main streets are paved cobble (the unified `road` cobble + curb autotile); alleys stay dirt

  // STAGE 0 — BOUNDARY. Ground the whole bounds, then work inside an IRREGULARLY inset interior (a
  // per-edge jittered margin) so the town is not a full rectangle. A wall ring (if asked) takes the rim.
  fill(cv, B, ground, true);
  const jm = () => 2 + Math.floor(cv.rng() * 3);
  let inset = contents.wall ? 1 : 0;
  if (contents.wall) wallRing(cv, theme.wallMat, locationId);
  const ix = B.x + inset + jm(), iy = B.y + inset + jm();
  const interior: Rect = { x: ix, y: iy, w: B.x + B.w - inset - jm() - ix, h: B.y + B.h - inset - jm() - iy };
  if (interior.w < 12 || interior.h < 12) { interior.x = B.x + 1; interior.y = B.y + 1; interior.w = B.w - 2; interior.h = B.h - 2; }

  // STAGE 0b — TERRAIN FIELD (Weave field primitive): a coast/mountains brief reserves an edge band as a
  // water/rock field and shrinks the interior off it, so the town sits on land and the field forms a
  // coherent frontier at bake. Applied before streets/parcels so buildings never land in the sea/cliffs.
  if (contents.mountain) { const f = reserveEdgeField(cv, B, interior, 'mountain', contents.entranceSide); if (f && contents.mine) placeFrontierFeature(cv, f.band, f.edge, 'mine', locationId); }
  // The coast field is remembered — STAGE 4 gives waterfront-flagged buildings the lots nearest it
  // (the spec relation near(building, dock/water) compiled into geometry).
  let coastField: { edge: FieldSide; band: Rect } | null = null;
  if (contents.coast) { coastField = reserveEdgeField(cv, B, interior, 'coast', contents.entranceSide); if (coastField && contents.port) placeFrontierFeature(cv, coastField.band, coastField.edge, 'port', locationId); }

  // STAGE 1 — ORGANIC STREET NETWORK via the LOOM (routeSeam, Weave L1). Recursive bisection carves a
  // material-typed seam at each cut (2-wide cobble arteries near the top, 1-wide dirt alleys deeper), and
  // returns the block partition — connected BY CONSTRUCTION. Street = material profile #1; a canal is the
  // SAME engine with a water profile (see networks.ts). This is a byte-identical lift of the old inline loop.
  const streetProfile: MaterialProfile = { id: 'street', bedAt: (d) => ({ tag: d <= 1 ? ARTERY : path, walkable: true, width: d === 0 ? 2 : 1 }) };
  const { blocks, seams } = routeSeam(cv, interior, streetProfile, { minBlock: 15, gridChaos: 0.42, maxDepth: 5 });
  // A CANAL (when the brief asks) reprofiles the main artery as water + quays + derived bridges — the same
  // seam engine, a water material. The first proof that features are DATA over one network engine (Weave L1).
  if (contents.canal) carveCanal(cv, seams);

  // STAGE 2 — PLAZA. The block nearest the centroid becomes the town square (capped to a centred sub-rect
  // so a big block doesn't swallow the map), with the main landmark at its centre.
  const cen = rectCenter(interior);
  let pIdx = 0, pBest = Infinity;
  blocks.forEach((b, i) => { const c = rectCenter(b); const dd = (c.c - cen.c) ** 2 + (c.r - cen.r) ** 2; if (dd < pBest) { pBest = dd; pIdx = i; } });
  const pBlock = blocks.splice(pIdx, 1)[0]!;
  const pw = Math.min(pBlock.w, 12), ph = Math.min(pBlock.h, 9);
  const pRect: Rect = { x: pBlock.x + Math.floor((pBlock.w - pw) / 2), y: pBlock.y + Math.floor((pBlock.h - ph) / 2), w: pw, h: ph };
  plaza(cv, pRect, theme.plaza);
  const plazaCtr = rectCenter(pRect);
  // CENTERPIECE by town CHARACTER (not an unconditional well): a genteel village gets a well, a mining
  // town an anvil/forge, a market its stalls; a rough camp gets nothing but a firepit. A vignette the DM
  // explicitly named still wins.
  const CENTERPIECE: Record<NonNullable<Contents['character']>, string | undefined> = { mining: 'forge', port: 'market', market: 'market', civic: 'well', rough: undefined, grim: undefined };
  // A fountain (the 'well' vignette) belongs ONLY on a civic plaza — a mining/port/rough/grim town never
  // gets one even if the DM's landmarks name a "well". This is the single choke-point: every other fountain
  // placement (garden, yard, park) has been removed, so gating 'well' here means the fountain can appear in
  // exactly one place in the whole town, and never in a horror village or a working dock.
  const civic = (contents.character ?? 'civic') === 'civic';
  const namedVig = contents.landmarks.map((l) => l.tag).find((t) => TOWN_VIGNETTES.has(t) && !(t === 'well' && !civic));
  const vig = namedVig ?? CENTERPIECE[contents.character ?? 'civic'];
  if (vig) vignette(cv, plazaCtr, vig, `plaza-${slug(locationId, 0)}`);
  else place(cv, { id: `prop:plaza-centre-${slug(locationId, 0)}`, tag: contents.character === 'grim' ? 'gravestone' : 'brazier', kind: 'prop', at: plazaCtr }); // grim: a graveyard marker; rough: a firepit — never a fountain
  // benches at the square's corners — somewhere to sit by the market/well.
  for (const [cx, cy] of [[pRect.x + 1, pRect.y + 1], [pRect.x + pRect.w - 2, pRect.y + 1], [pRect.x + 1, pRect.y + pRect.h - 2], [pRect.x + pRect.w - 2, pRect.y + pRect.h - 2]] as const)
    if (cv.inB(cx, cy) && cv.isFree(cx, cy)) place(cv, { id: `prop:plaza-bench-${cx}-${cy}`, tag: 'stone_bench', kind: 'prop', at: { c: cx, r: cy } });

  // STAGE 2b — PARK. A green neighbourhood square (a fountain + benches on grass, no buildings), placed on the
  // FAR side of town from the paved plaza, so a settlement has a breathing space distinct from the market square.
  // When the spec claims WATERFRONT lots, the shore block is spoken for — "far from the plaza" is often exactly
  // the block behind the beach, and a park there starves the boathouse off the waterline (the b1 drop).
  const reserveShore = !!coastField && contents.buildings.some((x) => x.waterfront);
  const coastAdjacent = (b: Rect): boolean => {
    if (!coastField) return false;
    switch (coastField.edge) {
      case 'west': return b.x <= interior.x + 2;
      case 'east': return b.x + b.w >= interior.x + interior.w - 2;
      case 'north': return b.y <= interior.y + 2;
      default: return b.y + b.h >= interior.y + interior.h - 2;
    }
  };
  if (blocks.length >= 4) {
    let kIdx = -1, kBest = -1;
    blocks.forEach((b, i) => { if (Math.min(b.w, b.h) < 6 || (reserveShore && coastAdjacent(b))) return; const c = rectCenter(b); const dd = (c.c - plazaCtr.c) ** 2 + (c.r - plazaCtr.r) ** 2; if (dd > kBest) { kBest = dd; kIdx = i; } });
    if (kIdx >= 0) {
      const park = blocks.splice(kIdx, 1)[0]!;
      const parkCtr = rectCenter(park);
      // a fountain only befits a genteel town; a working/rough town gets a firepit gathering-spot instead.
      const genteel = !contents.character || contents.character === 'civic' || contents.character === 'market';
      // the PARK gets a statue/monument (or a grim/rough marker) — the fountain is reserved for the ONE
      // civic PLAZA square, so it stops appearing in every green corner of town.
      const parkTag = genteel ? 'statue' : contents.character === 'grim' ? 'gravestone' : 'brazier';
      place(cv, { id: `prop:park-centre-${slug(locationId, 0)}`, tag: parkTag, kind: 'prop', at: parkCtr });
      for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2]] as const) { const bc = parkCtr.c + dx, br = parkCtr.r + dy; if (cv.inB(bc, br) && cv.isFree(bc, br)) place(cv, { id: `prop:park-bench-${bc}-${br}`, tag: 'stone_bench', kind: 'prop', at: { c: bc, r: br } }); }
    }
  }

  // STAGE 3 — PARCEL SUBDIVISION (OBB recursive split, soft probabilistic stop). Each block is inset off
  // its streets, then split along the SHORTER axis at a jittered ratio (1-tile alley between halves) until
  // lots are house-sized — with a depth-rising random early stop so footprints VARY (no two identical).
  const minLot = 6, maxLot = 18, SIZE_CHAOS = 0.5;
  const lots: Rect[] = [];
  const subdivide = (rect: Rect, depth: number): void => {
    const fits = rect.w <= maxLot && rect.h <= maxLot;
    const splitH = rect.w >= rect.h; // split the longer axis
    const len = splitH ? rect.w : rect.h;
    const canSplit = len >= minLot * 2 + 1;
    if (depth >= 4 || !canSplit || (fits && cv.rng() < 0.45 + 0.18 * depth)) { lots.push(rect); return; }
    let cut = Math.floor(len * (0.5 + (cv.rng() - 0.5) * SIZE_CHAOS));
    cut = Math.max(minLot, Math.min(len - minLot - 1, cut));
    if (cut < minLot || len - cut - 1 < minLot) { lots.push(rect); return; }
    if (splitH) { subdivide({ x: rect.x, y: rect.y, w: cut, h: rect.h }, depth + 1); subdivide({ x: rect.x + cut + 1, y: rect.y, w: rect.w - cut - 1, h: rect.h }, depth + 1); }
    else { subdivide({ x: rect.x, y: rect.y, w: rect.w, h: cut }, depth + 1); subdivide({ x: rect.x, y: rect.y + cut + 1, w: rect.w, h: rect.h - cut - 1 }, depth + 1); }
  };
  for (const b of blocks) {
    const inb: Rect = { x: b.x + 1, y: b.y + 1, w: b.w - 2, h: b.h - 2 };
    if (inb.w >= minLot && inb.h >= minLot) subdivide(inb, 0);
  }

  // STAGE 4 — FOOTPRINTS that ADDRESS the street. Sort lots by distance from the plaza so named/commerce
  // buildings land in the inner ring (ward zoning). Inset each lot by a JITTERED, asymmetric setback (a
  // front yard at a varied offset — this breaks the even-grid tell), face the door at the nearest street.
  const isStreet = (c: number, r: number) => { const t = cv.tileAt(c, r); return t === path || t === ARTERY; };
  const doorToward = (fp: Rect): 'north' | 'south' | 'east' | 'west' => {
    const score = (cells: Pt[]) => cells.reduce((n, p) => n + (cv.inB(p.c, p.r) && isStreet(p.c, p.r) ? 1 : 0), 0);
    const sides: Record<'north' | 'south' | 'east' | 'west', Pt[]> = {
      north: Array.from({ length: fp.w }, (_, i) => ({ c: fp.x + i, r: fp.y - 1 })),
      south: Array.from({ length: fp.w }, (_, i) => ({ c: fp.x + i, r: fp.y + fp.h })),
      west: Array.from({ length: fp.h }, (_, i) => ({ c: fp.x - 1, r: fp.y + i })),
      east: Array.from({ length: fp.h }, (_, i) => ({ c: fp.x + fp.w, r: fp.y + i })),
    };
    let best: 'north' | 'south' | 'east' | 'west' = 'south', bestN = -1;
    for (const s of ['south', 'north', 'east', 'west'] as const) { const n = score(sides[s]); if (n > bestN) { bestN = n; best = s; } }
    return best;
  };
  // NAMED buildings go to the FRONT of the queue (stable within each half): the fiction leans on them
  // by id ("Mother Sedge's boathouse"), so when parcels are scarce an anonymous count-expanded run
  // ("7× house") must never starve the one named building out of a lot — that silently dropped a
  // spec'd boathouse whose door the arc's narration depends on.
  const named = [...contents.buildings].sort((a, b) => Number(!!b.name) - Number(!!a.name));
  const lotD = (l: Rect) => Math.hypot(rectCenter(l).c - plazaCtr.c, rectCenter(l).r - plazaCtr.r);
  lots.sort((a, b) => lotD(a) - lotD(b));
  // WATERFRONT bias (S4 — spec relation near(building, dock/water) as GEOMETRY): flagged buildings
  // pre-claim the lots nearest the coast band, so "the boathouse beside the dock" is placement, not luck.
  const lotAssign = new Map<Rect, { type: BuildingType; name?: string }>();
  if (coastField) {
    const bandCtr = rectCenter(coastField.band);
    const onCoastAxis = coastField.edge === 'east' || coastField.edge === 'west';
    const coastD = (l: Rect) => {
      const c = rectCenter(l);
      return onCoastAxis ? Math.abs(c.c - bandCtr.c) : Math.abs(c.r - bandCtr.r);
    };
    // Order ALONG the shore toward the band centre too — the pier roots there, so the first claim
    // (a named boathouse) takes the waterline lot nearest the jetties, not just any waterline lot.
    // coastD is BANDED by a lot-depth (≈minLot) before along-shore distance: an exact-tie tie-break
    // never fires (lot centres differ by a tile), but lots in the same shore column should compete
    // on pier proximity, not centre jitter.
    const alongD = (l: Rect) => {
      const c = rectCenter(l);
      return onCoastAxis ? Math.abs(c.r - bandCtr.r) : Math.abs(c.c - bandCtr.c);
    };
    const byCoast = [...lots].sort((a, b) => Math.floor(coastD(a) / 6) - Math.floor(coastD(b) / 6) || alongD(a) - alongD(b) || coastD(a) - coastD(b));
    for (const b of named.filter((x) => x.waterfront)) {
      const lot = byCoast.find((l) => !lotAssign.has(l) && (l.w - 2 >= 4 && l.h - 2 >= 4));
      if (lot) lotAssign.set(lot, b);
    }
  }
  const namedQueue = named.filter((b) => !b.waterfront || ![...lotAssign.values()].includes(b));
  let bi = 0, ni = 0;
  // Footprint variety: when a lot is big enough for a silhouette, ~40% of the time give it a clean L/T/U/
  // cross (derived as a watertight ring — never a carved-out notch). Always falls back to rect.
  const chooseShape = (w: number, h: number): ShapeKind => {
    const fits = (['ell', 'tee', 'you', 'plus'] as ShapeKind[]).filter((s) => w >= SHAPE_MIN[s].w && h >= SHAPE_MIN[s].h);
    return !fits.length || cv.rng() < 0.6 ? 'rect' : fits[Math.floor(cv.rng() * fits.length)]!;
  };
  const landed = new Set<{ type: BuildingType; name?: string }>();
  for (const lot of lots) {
    const sb = (dim: number) => (dim >= 8 ? Math.floor(cv.rng() * 2) : 0);
    const ox = sb(lot.w), oy = sb(lot.h);
    const fp: Rect = { x: lot.x + ox, y: lot.y + oy, w: lot.w - ox - sb(lot.w), h: lot.h - oy - sb(lot.h) };
    if (fp.w < 4 || fp.h < 4) continue;
    let type: BuildingType, name: string | undefined;
    const assigned = lotAssign.get(lot) ?? (ni < namedQueue.length ? namedQueue[ni++]! : undefined);
    if (assigned) { type = assigned.type; name = assigned.name; } // a waterfront claim / the declared queue — this lot is spoken for
    else { const big = fp.w * fp.h >= 72; type = big ? (cv.rng() < 0.3 ? 'shop' : 'house') : 'house'; } // procedural fill = mostly homes (big lots → manors/shops)
    const dside = doorToward(fp);
    const door = compound(cv, fp, type, { door: dside, shape: chooseShape(fp.w, fp.h), locationId, ...(name ? { name } : {}), id: `bldg:${slug(locationId, 0)}-b${bi++}` });
    if (assigned) {
      if (door) landed.add(assigned);
      else if (assigned.name) namedQueue.push(assigned); // a NAMED building whose lot failed gets another lot, not a silent drop
    }
    // ENTRANCE PATH — a short dirt path from the door OUT across the front-yard grass to the nearest street, so
    // every building has a deliberate, hand-placed approach instead of a door opening onto bare ground.
    const dir = dside === 'north' ? { c: 0, r: -1 } : dside === 'south' ? { c: 0, r: 1 } : dside === 'west' ? { c: -1, r: 0 } : { c: 1, r: 0 };
    let pc = dside === 'east' ? fp.x + fp.w : dside === 'west' ? fp.x - 1 : fp.x + Math.floor(fp.w / 2);
    let pr = dside === 'south' ? fp.y + fp.h : dside === 'north' ? fp.y - 1 : fp.y + Math.floor(fp.h / 2);
    for (let step = 0; step < 5 && cv.inB(pc, pr); step++) {
      if (isStreet(pc, pr)) break;                              // reached the road — done
      if (cv.tileAt(pc, pr) === ground) cv.set(pc, pr, path, true); // pave the front path
      pc += dir.c; pr += dir.r;
    }
  }
  // HONESTY: anything declared that found no parcel is REPORTED (never silently dropped) — the DM
  // must know a building didn't land, so the fiction re-narrates instead of pointing at a phantom.
  const droppedBldgs = named.filter((b) => !landed.has(b));
  if (droppedBldgs.length) cv.notes.push(`town: ${droppedBldgs.length}/${named.length} declared building(s) found no lot (${droppedBldgs.map((b) => b.name ?? b.type).join(', ')})`);

  // STAGE 5 — DENSITY (two deliberate textures, region-masked, depth-ordered). Trees/bushes spread by
  // BLUE noise on grass margins; flower beds + groundcover CLUMP via noise-threshold; street furniture
  // lines the lanes; flower beds hug building walls. All on theme.ground only (so streets/plaza/floors
  // stay clear), all seeded → deterministic. This replaces the old white-noise scatter.
  const onGround = (c: number, r: number) => cv.tileAt(c, r) === ground;
  const nearTile = (c: number, r: number, pred: (c: number, r: number) => boolean) =>
    pred(c, r - 1) || pred(c, r + 1) || pred(c - 1, r) || pred(c + 1, r);
  const isWall = (c: number, r: number) => (cv.tileAt(c, r) ?? '').startsWith('wall');
  // structural trees — blue-noise spread across grass margins
  poissonScatter(cv, interior, { tags: ['tree_oak', 'tree_oak', 'tree', 'tree_pine', 'tree_dark', 'bush'], r: 3, blocks: true, max: 90, filter: onGround });
  // tree GROVES — noise clumps for leafy copses (denser than the spread)
  clumpScatter(cv, interior, { tags: ['tree_oak', 'tree_dark', 'tree_autumn', 'tree_pine'], freq: 0.2, threshold: 0.68, seedOffset: 0x51ed, blocks: true, max: 40, filter: onGround });
  // groundcover — flower beds (varied colours) + tufts clump (lusher: lower threshold, higher cap)
  clumpScatter(cv, interior, { tags: ['flowers', 'flowers_blue', 'flowers_yellow', 'flowers_red', 'grass_tuft', 'mushroom'], freq: 0.14, threshold: 0.52, seedOffset: 0x9e37, blocks: false, max: 170, filter: onGround });
  // street furniture lining the lanes (signposts handled separately — they belong at junctions, not at random)
  poissonScatter(cv, interior, { tags: ['fence', 'woodpile', 'barrel', 'crate', 'market_stall'], r: 6, blocks: true, max: 16, filter: (c, r) => onGround(c, r) && nearTile(c, r, isStreet) });
  // SIGNPOSTS at street JUNCTIONS — where lanes cross/branch (≥3 street neighbours), plant a sign on a free
  // grass corner. Min-spaced so a dense crossing doesn't sprout a thicket of signs.
  const signs: Pt[] = [];
  for (let r = interior.y + 1; r < interior.y + interior.h - 1 && signs.length < 8; r++)
    for (let c = interior.x + 1; c < interior.x + interior.w - 1 && signs.length < 8; c++) {
      if (!isStreet(c, r)) continue;
      const sn = (isStreet(c, r - 1) ? 1 : 0) + (isStreet(c, r + 1) ? 1 : 0) + (isStreet(c - 1, r) ? 1 : 0) + (isStreet(c + 1, r) ? 1 : 0);
      if (sn < 3 || signs.some((p) => Math.abs(p.c - c) + Math.abs(p.r - r) < 9)) continue;
      const corner = ([[1, 1], [-1, 1], [1, -1], [-1, -1]] as const).map(([dx, dy]) => ({ c: c + dx, r: r + dy })).find((p) => cv.inB(p.c, p.r) && cv.isFree(p.c, p.r) && onGround(p.c, p.r));
      if (corner) { place(cv, { id: `prop:signpost-${c}-${r}`, tag: 'signpost', kind: 'prop', at: corner }); signs.push({ c, r }); }
    }
  // flower beds hugging building walls
  clumpScatter(cv, interior, { tags: ['flowers', 'flowers_red', 'flowers_yellow', 'bush'], freq: 0.32, threshold: 0.4, seedOffset: 0x85eb, blocks: false, max: 80, filter: (c, r) => onGround(c, r) && nearTile(c, r, isWall) });

  // STAGE 6 — CAST. The cast-station CONTRACT: an anchored NPC ("Hobb, near:forge") stands AT their
  // post — resolved against the map's real objects — and an `in:` anchor whose station has a keeper
  // NAMES the keeper (one identity = one token) instead of spawning a duplicate villager. Only
  // unanchored extras take round-robin street/plaza cells. An unresolvable anchor is REPORTED (the
  // honesty rule buildings already have): the DM re-narrates rather than pointing at a phantom post.
  const streetCells = cv.shuffle((() => { const out: Pt[] = []; for (let r = interior.y; r < interior.y + interior.h; r++) for (let c = interior.x; c < interior.x + interior.w; c++) if (cv.isFree(c, r) && (isStreet(c, r) || cv.tileAt(c, r) === theme.plaza)) out.push({ c, r }); return out; })());
  const loc = slug(locationId, 0); // namespace the cast by location so two towns on one canvas don't share ids
  let si = 0; // street cursor — anchored cast don't consume street slots
  contents.npcs.forEach((npc, i) => {
    const id = `npc:${loc}-${slug(npc.tag, i)}`;
    const who = npc.name ?? npc.tag;
    if (npc.anchor) {
      const st = resolveCastStation(cv, npc.anchor);
      if (st) {
        if (st.keeper && /^in\b/.test(npc.anchor.trim().toLowerCase())) {
          st.keeper.name = who; // the station's keeper IS this person — name rides the keeper
          cv.notes.push(`cast-station: ${who} IS the keeper of ${st.what} (${st.keeper.id})`);
          return;
        }
        place(cv, { id, tag: npc.tag, kind: 'actor', role: 'npc', at: st.at, ...(npc.name ? { name: npc.name } : {}) });
        cv.notes.push(`cast-station: ${who} posted at ${st.what}`);
        return;
      }
      cv.notes.push(`cast-station: ${who} anchor "${npc.anchor}" matched nothing on the map — placed on the street (re-narrate or re-anchor)`);
    }
    place(cv, { id, tag: npc.tag, kind: 'actor', role: 'npc', at: streetCells[si++ % Math.max(1, streetCells.length)] ?? plazaCtr, ...(npc.name ? { name: npc.name } : {}) });
  });
  contents.mobs.forEach((mob, i) => scatter(cv, { idBase: `mob:${loc}-${slug(mob.tag, i)}`, tags: [mob.tag], kind: 'actor', role: 'mob', region: interior, count: Math.max(1, Math.min(20, mob.count)) }));
  dirtRimPaving(cv); // "stone on soil" — a dirt rim around the paving (broad credibility polish)
  if (!contents.wall) entrance(cv, edgePt(B, contents.entranceSide ?? 'south'), locationId);
}

// ---------------------------------------------------------------------------
// The other four — thin wrappers over existing topology primitives (the seam generalizes).
// ---------------------------------------------------------------------------

function placeCast(cv: Canvas, ctx: GenContext, spots: Pt[], region: Rect): void {
  ctx.contents.landmarks.forEach((l, i) => place(cv, { id: `prop:${slug(l.tag, i)}`, tag: l.tag, kind: 'prop', at: spots[i % Math.max(1, spots.length)] ?? rectCenter(region), ...(l.name ? { name: l.name } : {}) }));
  ctx.contents.npcs.forEach((n, i) => place(cv, { id: `npc:${slug(n.tag, i)}`, tag: n.tag, kind: 'actor', role: 'npc', at: spots[(i + 1) % Math.max(1, spots.length)] ?? rectCenter(region), ...(n.name ? { name: n.name } : {}) }));
  ctx.contents.mobs.forEach((m, i) => scatter(cv, { idBase: `mob:${slug(m.tag, i)}`, tags: [m.tag], kind: 'actor', role: 'mob', region, count: Math.max(1, Math.min(20, m.count)) }));
}

const dungeonGen: ArchetypeGenerator = (cv, ctx) => {
  const count = Math.max(4, Math.min(10, ctx.contents.buildings.length || 6));
  const centres = bspRooms(cv, ctx.bounds, count, wmatOf(ctx.theme), ctx.theme.plaza);
  placeCast(cv, ctx, centres, ctx.bounds);
  entrance(cv, edgePt(ctx.bounds, ctx.contents.entranceSide ?? 'south'), ctx.locationId);
};

const caveGen: ArchetypeGenerator = (cv, ctx) => {
  cave(cv, ctx.bounds, wmatOf(ctx.theme), ctx.theme.plaza);
  clumpScatter(cv, ctx.bounds, { tags: ['rubble', 'bones', 'mushroom'], freq: 0.22, threshold: 0.6, seedOffset: 0x1234, blocks: false, max: 50 });
  placeCast(cv, ctx, [rectCenter(ctx.bounds)], ctx.bounds);
  entrance(cv, edgePt(ctx.bounds, ctx.contents.entranceSide ?? 'south'), ctx.locationId);
};

const wildernessGen: ArchetypeGenerator = (cv, ctx) => {
  const B = ctx.bounds;
  fill(cv, B, ctx.theme.ground, true);
  const ctr = rectCenter(B);
  const gladeR = Math.max(4, Math.min(B.w, B.h) / 4);
  // a forest with an OPEN central glade: dense trees everywhere EXCEPT a clearing around the centre.
  poissonScatter(cv, B, { tags: ['tree', 'tree', 'tree_pine', 'tree_autumn'], r: 3, blocks: true, filter: (c, r) => Math.hypot(c - ctr.c, r - ctr.r) > gladeR });
  clumpScatter(cv, B, { tags: ['bush', 'flowers', 'mushroom', 'grass_tuft'], freq: 0.16, threshold: 0.55, seedOffset: 0x77, blocks: false, max: 90, filter: (c, r) => Math.hypot(c - ctr.c, r - ctr.r) > gladeR * 0.7 });
  if (ctx.contents.landmarks.length || ctx.contents.npcs.length) vignette(cv, ctr, 'camp', `camp-${slug(ctx.locationId, 0)}`);
  placeCast(cv, ctx, [ctr, { c: ctr.c + 2, r: ctr.r }, { c: ctr.c - 2, r: ctr.r }], B);
  entrance(cv, edgePt(B, ctx.contents.entranceSide ?? 'south'), ctx.locationId);
};

/**
 * FOREST generator — the biome analogue of townGen: a COMPOSED forest, not flat grass + random trees.
 * The four moves that lift it out of "sprinkled on a field" (mirrors the town's greenery step):
 *   1. COMPOSED GROUND — grass base, dirt/leaf-litter patches under the dense canopy (nothing grows in
 *      deep shade), a noise-mottled floor. No flat green.
 *   2. DENSITY-GRADIENT canopy — a density field = edge-bias (forest is thick at the borders) × noise,
 *      minus the clearings. Dense poisson in the thick zones, sparse in the open. Multi-species.
 *   3. GENUINE CLEARINGS — 1-2 open glades (sunlit: flowers + grass tufts, the party arrives here) with
 *      a trail threading from the entrance edge through a glade — structure, not a random void.
 *   4. UNDERSTORY + DEADFALL — ferns/bushes clumped UNDER the canopy (not in glades), mushrooms by the
 *      deadfall, a few fallen logs/stumps. Ecology, not confetti.
 */
const forestGen: ArchetypeGenerator = (cv, ctx) => {
  const B = ctx.bounds;
  const inB = (c: number, r: number) => c >= B.x && r >= B.y && c < B.x + B.w && r < B.y + B.h;
  fill(cv, B, ctx.theme.ground, true);

  // 1-2 clearings: discs of open ground the canopy avoids. One holds the party/entrance trail.
  const nClear = 1 + (cv.rng() < 0.5 ? 1 : 0);
  const clearings: { c: number; r: number; rad: number }[] = [];
  for (let i = 0; i < nClear; i++) {
    const rad = Math.max(3, Math.min(B.w, B.h) * (0.14 + cv.rng() * 0.08));
    clearings.push({
      c: B.x + Math.floor(B.w * (0.3 + cv.rng() * 0.4)),
      r: B.y + Math.floor(B.h * (0.3 + cv.rng() * 0.4)),
      rad,
    });
  }
  const glade = clearings[0]!;
  const inClearing = (c: number, r: number) => clearings.some((g) => Math.hypot(c - g.c, r - g.r) < g.rad);
  const clearingEdge = (c: number, r: number) => clearings.some((g) => { const d = Math.hypot(c - g.c, r - g.r); return d >= g.rad * 0.7 && d < g.rad * 1.25; });

  // NOTE ON GROUND: the floor stays GRASS. The town greenery taught this — richness comes from SCATTER
  // density (tufts / flowers / undergrowth), never from painting the ground another material. An earlier
  // pass mottled bare `dirt` under the canopy and it read as ugly orange blocks; the only earth here is
  // the trail. Grass autotile + ground decals + the understory below carry the floor texture.

  // 2b. A TRAIL from the entrance edge, through the glade, to the far edge — structure + a walk line.
  const SIDES = ['north', 'south', 'east', 'west'] as const;
  const entSide: 'north' | 'south' | 'east' | 'west' = ctx.contents.entranceSide ?? SIDES[Math.floor(cv.rng() * 4)]!;
  const ent = edgePt(B, entSide);
  const far = edgePt(B, entSide === 'north' ? 'south' : entSide === 'south' ? 'north' : entSide === 'east' ? 'west' : 'east');
  path(cv, ent, { c: glade.c, r: glade.r }, 'trail');
  path(cv, { c: glade.c, r: glade.r }, far, 'trail');
  const isTrail = (c: number, r: number) => inB(c, r) && cv.tileAt(c, r) === 'trail' && cv.walkable[r]![c] === true;
  const nearTrail = (c: number, r: number) => isTrail(c, r - 1) || isTrail(c, r + 1) || isTrail(c - 1, r) || isTrail(c + 1, r);

  // 2. THE CANOPY AS MASS — the classic `clearing` primitive's lesson, at Story scale. Statistical
  // scatter (blue-noise + edge-bias) reads as uniform porridge: evenly-spaced lone trees, species
  // shuffled per cell, no negative space — "AI slop". A real forest reads as FIGURE-GROUND: a SOLID
  // feathered treeline mass at the border, species in coherent STANDS, interior copse blobs, and a
  // genuinely OPEN glade. Deterministic per-cell planting, not statistics.
  const treeCells = new Set<string>();
  const plant = (c: number, r: number, tag: string, blocks = true): void => {
    if (!cv.isFree(c, r) || cv.claimed(c, r) || inClearing(c, r) || isTrail(c, r) || nearTrail(c, r)) return;
    cv.reserve(c, r);
    if (blocks) cv.walkable[r]![c] = false;
    cv.ambiance.push({ tag, col: c, row: r });
    if (blocks) treeCells.add(`${c},${r}`);
  };
  // SPECIES STANDS — a coarse field assigns each REGION one palette (pines here, oaks there), the way
  // real woods grow. Within a stand, small variation; across the map, coherent patches.
  const standF = noiseField(cv.cols, cv.rows, 0.05, (cv.seed ^ 0xabc7) >>> 0);
  const STANDS: string[][] = [
    ['tree_pine', 'tree_pine', 'tree_pine', 'tree_dark'],
    ['tree_oak', 'tree_oak', 'tree_oak', 'oak_ancient'],
    ['tree_dark', 'tree_oak', 'tree_pine', 'tree_oak'],
    ['birch', 'birch', 'tree_oak', 'tree_autumn'],
  ];
  const standAt = (c: number, r: number): string[] => STANDS[Math.min(3, Math.floor(standF[r]![c]! * 4))]!;
  const pick = (pool: string[]): string => pool[Math.floor(cv.rng() * pool.length)]!;

  // 2a. TREELINE MASS: a noise-wobbled border band (2–5 deep), planted nearly SOLID (small gaps for
  // air). This is the single move that makes it read as "a forest with an inside".
  const depthF = noiseField(cv.cols, cv.rows, 0.18, (cv.seed ^ 0x333) >>> 0);
  for (let r = B.y; r < B.y + B.h; r++)
    for (let c = B.x; c < B.x + B.w; c++) {
      const d = Math.min(c - B.x, r - B.y, B.x + B.w - 1 - c, B.y + B.h - 1 - r);
      const band = 2 + Math.floor(depthF[r]![c]! * 3.6); // 2..5 deep, wobbling along the border
      if (d < band && cv.rng() > 0.1) plant(c, r, pick(standAt(c, r)));
    }
  // 2b. INTERIOR COPSES: connected blobs of trees (one stand each), not scattered singles.
  const copseF = noiseField(cv.cols, cv.rows, 0.085, (cv.seed ^ 0x777) >>> 0);
  for (let r = B.y; r < B.y + B.h; r++)
    for (let c = B.x; c < B.x + B.w; c++)
      if (copseF[r]![c]! > 0.7 && cv.rng() > 0.15) plant(c, r, pick(standAt(c, r)));
  // 2c. A few LONE trees breathing in the open mid-ground — sparse, so the space stays open.
  poissonScatter(cv, B, { tags: ['tree_oak', 'birch', 'tree_dead'], r: 6, blocks: true, max: 10, filter: (c, r) => !inClearing(c, r) && !isTrail(c, r) && !nearTrail(c, r) });

  // 3. GROUPED VIGNETTES, not confetti — a deadfall site is a log WITH its mushrooms; a stump stands
  // at the treeline base. Props travel in meaningful clusters.
  const near = (c: number, r: number, set: Set<string>): boolean => {
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (set.has(`${c + dc},${r + dr}`)) return true;
    return false;
  };
  const deadfall: Pt[] = [];
  for (let tries = 0; tries < 200 && deadfall.length < 4; tries++) {
    const c = B.x + 2 + Math.floor(cv.rng() * (B.w - 4));
    const r = B.y + 2 + Math.floor(cv.rng() * (B.h - 4));
    if (!cv.isFree(c, r) || inClearing(c, r) || isTrail(c, r) || nearTrail(c, r)) continue;
    if (deadfall.some((p) => Math.hypot(p.c - c, p.r - r) < 8)) continue;
    plant(c, r, cv.rng() < 0.6 ? 'log_fallen' : 'log_rotten');
    // its mushrooms, huddled against the log
    const spots = cv.shuffle([{ c: c + 1, r }, { c: c - 1, r }, { c, r: r + 1 }, { c: c + 1, r: r + 1 }]);
    for (const s of spots.slice(0, 1 + Math.floor(cv.rng() * 2))) plant(s.c, s.r, cv.rng() < 0.7 ? 'mushroom' : 'mushroom_shelf', false);
    deadfall.push({ c, r });
  }
  // stumps at the treeline base (someone felled these, at the wood's edge)
  poissonScatter(cv, B, { tags: ['stump'], r: 11, blocks: true, max: 3, filter: (c, r) => !inClearing(c, r) && !isTrail(c, r) && near(c, r, treeCells) });

  // 4. UNDERSTORY hugs the canopy FRINGE only (ferns/bushes live in tree shade) — the open mid-ground
  // and the glade stay CLEAN. Restraint is what makes the clearing read.
  const underF = noiseField(cv.cols, cv.rows, 0.2, (cv.seed ^ 0x5a5a) >>> 0);
  let under = 0;
  for (let r = B.y; r < B.y + B.h && under < 80; r++)
    for (let c = B.x; c < B.x + B.w && under < 80; c++)
      if (cv.isFree(c, r) && !inClearing(c, r) && !isTrail(c, r) && near(c, r, treeCells) && underF[r]![c]! > 0.52) {
        plant(c, r, pick(['fern_giant', 'bush', 'bush_berry', 'fern_giant']), false);
        under++;
      }
  // 3b. the SUNLIT glade ring: a modest ring of wildflowers at the clearing edge — the one flourish.
  let bloom = 0;
  for (let r = B.y; r < B.y + B.h && bloom < 14; r++)
    for (let c = B.x; c < B.x + B.w && bloom < 14; c++)
      if (cv.isFree(c, r) && clearingEdge(c, r) && !isTrail(c, r) && cv.rng() < 0.22) { plant(c, r, pick(['wildflowers', 'flowers']), false); bloom++; }
  // faint floor texture in the mid-ground — sparse tufts, nothing more.
  poissonScatter(cv, B, { tags: ['grass_tuft'], r: 5, blocks: false, max: 26, filter: (c, r) => !inClearing(c, r) && !isTrail(c, r) });

  // cast arrives in the glade; wildlife roams the mid forest.
  const gladeSpots: Pt[] = [{ c: glade.c, r: glade.r }, { c: glade.c + 2, r: glade.r + 1 }, { c: glade.c - 2, r: glade.r }, { c: glade.c + 1, r: glade.r - 2 }, { c: glade.c - 1, r: glade.r + 2 }, { c: glade.c + 3, r: glade.r }];
  placeCast(cv, ctx, gladeSpots, B);
  entrance(cv, ent, ctx.locationId);
};

const coastGen: ArchetypeGenerator = (cv, ctx) => {
  // PLACEHOLDER coast (P3 will replace with an fBm domain-warped shoreline + beach bands). For now: a
  // water expanse with an organic land blob + a couple of huts, so the seam is complete and valid.
  const B = ctx.bounds;
  fill(cv, B, 'water', false);
  island(cv, { x: B.x + 2, y: B.y + 2, w: Math.floor(B.w * 0.66), h: Math.floor(B.h * 0.66) }, ctx.theme.ground);
  island(cv, { x: B.x + Math.floor(B.w * 0.45), y: B.y + Math.floor(B.h * 0.4), w: Math.floor(B.w * 0.5), h: Math.floor(B.h * 0.55) }, ctx.theme.ground);
  const land: Pt[] = [];
  for (let r = B.y; r < B.y + B.h; r++) for (let c = B.x; c < B.x + B.w; c++) if (cv.isFree(c, r) && cv.tileAt(c, r) === ctx.theme.ground) land.push({ c, r });
  const spots = cv.shuffle(land);
  ctx.contents.buildings.slice(0, 3).forEach((b, i) => { const s = spots[i * 7]; if (s) building(cv, { x: s.c - 2, y: s.r - 2, w: 6, h: 6 }, b.type, { locationId: ctx.locationId, ...(b.name ? { name: b.name } : {}), id: `bldg:c${i}` }); });
  poissonScatter(cv, B, { tags: ['bush', 'tree', 'flowers'], r: 3, blocks: false, max: 40, filter: (c, r) => cv.tileAt(c, r) === ctx.theme.ground });
  placeCast(cv, ctx, spots.slice(0, 6), B);
  entrance(cv, edgePt(B, ctx.contents.entranceSide ?? 'north'), ctx.locationId);
};

export const GENERATORS: Record<ArchetypeKind, ArchetypeGenerator> = {
  town: townGen,
  dungeon: dungeonGen,
  cave: caveGen,
  wilderness: wildernessGen,
  coast: coastGen,
  forest: forestGen,
};
export const ARCHETYPE_KINDS = Object.keys(GENERATORS) as ArchetypeKind[];
