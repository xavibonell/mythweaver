/**
 * SPEC COMPILER v1 (S2 — the first real Weave rung): deterministically turn a validated SceneSpec
 * (features + relations + entry staging) into concrete generator inputs, replacing the lossy
 * prose-keyword harvest for spec'd beats. WHAT it consumes today:
 *   - feature kinds → archetype CONTENTS (buildings by type-map, cast, landmarks) + frontier flags
 *     (dock→coast+port, mine→mountain+mine, canal, wall) — lossless: nothing named is dropped silently
 *   - `in: water` constraints → in-water scatters (surfacing corpses, floating debris)
 *   - frame.entry.edge → party staging (the party arrives SOMEWHERE, never a center-stack)
 *   - everything else → honest notes: relations recorded for L1+ compilation, unrepresentable kinds
 *     reported (never silently dropped)
 * Geometry relations (near/along/across/facing/visible-from) are NOT yet compiled — they ride the
 * notes so the provenance panel shows exactly what was honored vs deferred.
 */

import { BUILDING_TYPES, type BuildingType, type MapObject, type SceneMap, type SceneSpec } from '@mythweaver/shared';
import type { Contents } from './archetypes.js';
import { isProp } from './catalog.js';
import { lookToSprite } from './composer.js';
import type { SceneOp } from './scene-program.js';

export interface SpecCompileResult {
  /** Archetype contents derived from the spec (settlements) — replaces the prose harvest. */
  contents: Pick<Contents, 'buildings' | 'landmarks' | 'npcs' | 'mobs'> & { coast?: boolean; port?: boolean; mountain?: boolean; mine?: boolean; canal?: boolean; wall?: boolean };
  /** Ops appended AFTER the base topology (in-water scatters, non-settlement cast/props, entrance). */
  postOps: SceneOp[];
  /** Party staging from frame.entry — the realizer places the party here instead of 'center'. */
  entryEdge?: 'north' | 'south' | 'east' | 'west';
  /** What the compiler DID (consumed) — joins the provenance notes. */
  notes: string[];
  /** What it could NOT represent — surfaced, never silently dropped. */
  unrepresented: string[];
}

/** building.* tails → the fixed BUILDING_TYPES vocabulary. */
const BUILDING_SYNONYMS: Record<string, BuildingType> = {
  house: 'house', home: 'house', hut: 'house', shack: 'house', cottage: 'house', dwelling: 'house',
  'stilt-house': 'house', 'stilted-shack': 'house', 'stilted-house': 'house', shanty: 'house',
  boathouse: 'workshop', workshop: 'workshop', mill: 'workshop',
  smithy: 'smithy', forge: 'smithy',
  chapel: 'temple', church: 'temple', temple: 'temple', 'chapel-hall': 'temple', shrine: 'temple', monastery: 'temple',
  cathedral: 'cathedral',
  shop: 'shop', store: 'shop', countinghouse: 'shop', market: 'shop', 'general-store': 'general_store',
  tavern: 'tavern', alehouse: 'tavern', inn: 'inn', lodge: 'inn',
  keep: 'keep', fort: 'keep', citadel: 'keep', jail: 'jail', prison: 'jail', vault: 'vault',
  library: 'library', armory: 'armory', barracks: 'barracks', guildhall: 'guildhall', manor: 'manor',
  tomb: 'tomb', crypt: 'tomb', mausoleum: 'tomb', courthouse: 'courthouse', curio: 'curio',
};

/** prop/decor tails → catalog tags. Every value is re-verified with isProp at resolve time, so a
 *  concept with no real art falls through to UNREPRESENTED (honest) instead of a broken tag. */
const PROP_SYNONYMS: Record<string, string> = {
  rowboat: 'boat', boat: 'boat', skiff: 'boat', dinghy: 'boat', 'boat-overturned': 'boat', 'overturned-boat': 'boat',
  'lamp-post': 'torch_wall', lamppost: 'torch_wall', 'lantern-post': 'torch_wall', streetlamp: 'torch_wall', lantern: 'torch_wall', torch: 'torch_wall',
  barrel: 'barrel', crate: 'crate', chest: 'chest', strongbox: 'chest',
  rope: 'rope_coil', 'tarred-rope': 'rope_coil', 'bell-rope': 'rope_coil', chain: 'rope_coil',
  coffin: 'sarcophagus', sarcophagus: 'sarcophagus', grave: 'gravestone', gravestone: 'gravestone', tombstone: 'tombstone',
  altar: 'altar', throne: 'throne', fountain: 'fountain', statue: 'statue',
  campfire: 'campfire', bonfire: 'bonfire', brazier: 'brazier', candle: 'candle',
  cart: 'minecart', 'ore-cart': 'minecart', minecart: 'minecart', sign: 'signpost', signpost: 'signpost',
  pot: 'pot', cauldron: 'pot', corpse: 'bones', body: 'bones', bones: 'bones', skull: 'skull',
};

/** kinds whose realization is a HOSTILE actor. */
const HOSTILE = /\b(undead|dead|zombie|ghoul|skeleton|revenant|wight|wraith|ghost|spectre|specter|bandit|wolf|goblin|orc|rat|spider|cultist)\b/;

const tail = (kind: string): string => kind.split('.').pop() ?? kind;
const clean = (s: string): string => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-');

/** Resolve a prop-ish concept to a catalog tag, trying the synonym table then direct/underscore forms. */
function resolvePropTag(concept: string): string | null {
  const t = clean(concept);
  for (const cand of [PROP_SYNONYMS[t], t, t.replace(/-/g, '_'), t.replace(/s$/, ''), PROP_SYNONYMS[t.replace(/s$/, '')]]) {
    if (cand && isProp(cand)) return cand;
  }
  return null;
}

export function compileSpec(spec: SceneSpec, opts: { settlement: boolean }): SpecCompileResult {
  const contents: SpecCompileResult['contents'] = { buildings: [], landmarks: [], npcs: [], mobs: [] };
  const postOps: SceneOp[] = [];
  const notes: string[] = [];
  const unrepresented: string[] = [];

  // Which features are constrained INTO the water ("in: water") — realized as in-water scatters.
  const inWater = new Set(
    (spec.constraints ?? []).filter((c) => c.c === 'in' && c.region === 'water' && (c.a || c.f)).map((c) => (c.a ?? c.f)!),
  );
  // Feature-id bookkeeping for relation compilation: which ids became buildings / frontiers.
  const buildingOf = new Map<string, { type: BuildingType; name?: string; waterfront?: boolean }[]>();
  const frontierIds = new Set<string>();

  for (const f of spec.features ?? []) {
    const t = tail(f.kind);
    const count = Math.max(1, Math.min(12, f.count ?? 1));

    // FRONTIER FLAGS — a named dock/mine/canal/wall becomes the matching frontier feature.
    if (/^(dock|pier|jetty|wharf|quay|harbou?r)/.test(t) || f.kind.startsWith('dock.')) {
      contents.coast = true;
      contents.port = true;
      frontierIds.add(f.id);
      notes.push(`spec: ${f.id} (${f.kind}) → coast+port frontier`);
      continue;
    }
    if (/^(mine|adit|shaft)/.test(t)) { contents.mountain = true; contents.mine = true; frontierIds.add(f.id); notes.push(`spec: ${f.id} → mountain+mine frontier`); continue; }
    if (/canal/.test(t)) { contents.canal = true; notes.push(`spec: ${f.id} → canal`); continue; }
    if (/^(wall|palisade|rampart)$/.test(t)) { contents.wall = true; notes.push(`spec: ${f.id} → town wall`); continue; }

    // BUILDINGS — the fixed type vocabulary, count-expanded. Nothing named is dropped.
    if (f.kind.startsWith('building.') || (BUILDING_SYNONYMS[clean(t)] && !f.kind.startsWith('prop.'))) {
      const type = BUILDING_SYNONYMS[clean(t)] ?? 'house';
      const mine: { type: BuildingType; name?: string; waterfront?: boolean }[] = [];
      for (let i = 0; i < Math.min(count, 8); i++) { const e = { type, ...(count === 1 ? { name: f.id } : {}) }; contents.buildings.push(e); mine.push(e); }
      buildingOf.set(f.id, mine);
      notes.push(`spec: ${f.id} → ${Math.min(count, 8)}× ${type}${BUILDING_SYNONYMS[clean(t)] ? '' : ' (no closer building type)'}`);
      continue;
    }

    // ACTORS — sprite from the concept; hostile tails are mobs; in-water actors scatter ON the water.
    if (f.kind.startsWith('actor.') || HOSTILE.test(t)) {
      const sprite = lookToSprite(t.replace(/-/g, ' '));
      const hostile = HOSTILE.test(t);
      if (inWater.has(f.id)) {
        postOps.push({ op: 'scatter', idBase: `mob:${f.id}`, tags: [sprite], kind: 'actor', role: hostile ? 'mob' : 'npc', region: 'all', count, on: 'water' });
        notes.push(`spec: ${f.id} → ${count}× ${sprite} IN the water`);
      } else if (opts.settlement) {
        if (hostile) contents.mobs.push({ tag: sprite, count });
        else for (let i = 0; i < count; i++) contents.npcs.push({ tag: sprite, ...(count === 1 ? { name: f.id } : {}) });
        notes.push(`spec: ${f.id} → ${count}× ${sprite}${hostile ? ' (hostile)' : ''}`);
      } else {
        postOps.push({ op: 'scatter', idBase: `${hostile ? 'mob' : 'npc'}:${f.id}`, tags: [sprite], kind: 'actor', role: hostile ? 'mob' : 'npc', region: 'all', count });
        notes.push(`spec: ${f.id} → ${count}× ${sprite}${hostile ? ' (hostile)' : ''}`);
      }
      continue;
    }

    // PROPS / DECOR / LANDMARKS — catalog tag via synonyms; in-water props float; unresolvable is REPORTED.
    const tag = resolvePropTag(t);
    if (tag) {
      if (inWater.has(f.id)) {
        postOps.push({ op: 'scatter', idBase: `prop:${f.id}`, tags: [tag], kind: 'prop', region: 'all', count, on: 'water' });
        notes.push(`spec: ${f.id} → ${count}× ${tag} IN the water`);
      } else if (count > 1) {
        postOps.push({ op: 'scatter', idBase: `prop:${f.id}`, tags: [tag], kind: 'prop', region: 'all', count });
        notes.push(`spec: ${f.id} → ${count}× ${tag}`);
      } else {
        // Always a concrete op with a deterministic id — towns DROP non-vignette landmark contents,
        // and the placement pass (S4) needs `prop:<fid>` addressable.
        postOps.push({ op: 'place', id: `prop:${f.id}`, tag, kind: 'prop', at: 'center', name: f.id });
        notes.push(`spec: ${f.id} → ${tag}`);
      }
      continue;
    }

    // terrain.* is the base-topology LLM's job (it reads the brief); everything else is unrepresented.
    if (f.kind.startsWith('terrain.')) notes.push(`spec: ${f.id} (${f.kind}) → base terrain (programmer's brief)`);
    else unrepresented.push(`${f.id} (${f.kind})`);
  }

  // WATERFRONT flags (S4): near/along/at-edge-of linking a BUILDING feature to a dock/water frontier
  // become lot bias in the town generator — the boathouse claims the shore lot.
  for (const c of spec.constraints ?? []) {
    if (!(c.c === 'near' || c.c === 'along' || c.c === 'at-edge-of')) continue;
    const subj = c.a ?? c.f;
    const obj = c.b ?? c.region ?? c.of;
    if (subj && buildingOf.has(subj) && (obj === 'water' || (obj && frontierIds.has(obj)))) {
      for (const e of buildingOf.get(subj)!) e.waterfront = true;
      notes.push(`spec: ${subj} → waterfront lot (near ${obj})`);
    }
  }
  // Relations beyond in:water are recorded for the provenance panel — L1+ territory, not silently eaten.
  const deferred = (spec.constraints ?? []).filter((c) => !(c.c === 'in' && c.region === 'water')).map((c) => c.c);
  if (deferred.length) notes.push(`spec: ${deferred.length} relation(s) queued for the placement pass (${[...new Set(deferred)].join(', ')})`);

  const edge = spec.frame?.entry?.edge;
  return {
    contents,
    postOps,
    ...(edge === 'north' || edge === 'south' || edge === 'east' || edge === 'west' ? { entryEdge: edge } : {}),
    notes,
    unrepresented,
  };
}

// ---------------------------------------------------------------------------
// S4 — RELATION PLACEMENT (the first geometry rung): after the map is built, move the spec's point
// realizations to SATISFY near / along / at-edge-of, and stage the party by its relations. Buildings
// can't move post-hoc (walls are baked) — they were biased at lot time (waterfront). Everything this
// pass can't resolve is returned as an honest note, never silently skipped.
// ---------------------------------------------------------------------------

type Cell = { c: number; r: number };

/** All cells realizing a feature id on the finished map: our emitted objects (`prop:<fid>` /
 *  `mob:<fid>` / `npc:<fid>` ids or groups, or name === fid), dock ambiance for frontier docks,
 *  PARTY = the pcs, 'water' = every water tile. */
function realizationCells(map: SceneMap, spec: SceneSpec, fid: string): Cell[] {
  if (fid === 'PARTY') return map.objects.filter((o) => o.role === 'pc').map((o) => ({ c: o.col, r: o.row }));
  if (fid === 'water') {
    const out: Cell[] = [];
    for (let r = 0; r < map.grid.rows; r++) for (let c = 0; c < map.grid.cols; c++) if (map.tiles[r]![c]!.startsWith('water')) out.push({ c, r });
    return out;
  }
  const ids = [`prop:${fid}`, `mob:${fid}`, `npc:${fid}`];
  const objs = map.objects.filter((o) => ids.includes(o.id) || (o.group && ids.includes(o.group)) || o.name === fid);
  if (objs.length) return objs.map((o) => ({ c: o.col, r: o.row }));
  // Frontier docks realize as ambiance planks — anchor on them when the feature is dock-ish.
  const feature = (spec.features ?? []).find((f) => f.id === fid);
  if (feature && (/^(dock|pier|jetty|wharf|quay)/.test(tail(feature.kind)) || feature.kind.startsWith('dock.'))) {
    return map.ambiance.filter((a) => a.tag.startsWith('dock')).map((a) => ({ c: a.col, r: a.row }));
  }
  return [];
}

/** The subject's movable OBJECTS (never buildings/terrain — those were placed structurally). */
function movableObjects(map: SceneMap, fid: string): MapObject[] {
  if (fid === 'PARTY') return map.objects.filter((o) => o.role === 'pc');
  const ids = [`prop:${fid}`, `mob:${fid}`, `npc:${fid}`];
  return map.objects.filter((o) => ids.includes(o.id) || (o.group && ids.includes(o.group)) || o.name === fid);
}

function occupied(map: SceneMap, c: number, r: number): boolean {
  return map.objects.some((o) => o.visible && o.col === c && o.row === r);
}

/** Nearest usable cell to (c,r): walkable land (or water when the mover lives in water), unoccupied. */
function nearestFree(map: SceneMap, c: number, r: number, radius: number, wantWater: boolean): Cell | null {
  for (let d = 0; d <= radius; d++)
    for (let dr = -d; dr <= d; dr++)
      for (let dc = -d; dc <= d; dc++) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== d) continue;
        const cc = c + dc, rr = r + dr;
        if (cc < 0 || rr < 0 || cc >= map.grid.cols || rr >= map.grid.rows) continue;
        const isWater = map.tiles[rr]![cc]!.startsWith('water');
        if (wantWater ? !isWater : !map.walkable[rr]![cc]) continue;
        if (occupied(map, cc, rr)) continue;
        return { c: cc, r: rr };
      }
  return null;
}

/** Apply the spec's placement relations to the finished map (in place). Returns provenance notes. */
export function applySpecPlacement(map: SceneMap, spec: SceneSpec): string[] {
  const notes: string[] = [];
  const cons = spec.constraints ?? [];
  for (const c of cons) {
    // in:water was compiled pre-map (scatter on:'water'); report the rest of `in` as deferred below.
    if (c.c === 'in' && c.region === 'water') continue;

    if (c.c === 'near' || c.c === 'along' || c.c === 'at-edge-of') {
      const subj = c.a ?? c.f;
      const refId = c.b ?? c.region ?? c.of ?? 'PARTY';
      if (!subj) continue;
      const movers = movableObjects(map, subj);
      if (!movers.length) { notes.push(`placement: ${c.c}(${subj},${refId}) — subject not movable (structural or unrealized)`); continue; }
      const anchors = realizationCells(map, spec, refId);
      if (!anchors.length) { notes.push(`placement: ${c.c}(${subj},${refId}) — referent has no realization`); continue; }
      // `at-edge-of water` wants the LAND cell touching water; near/along want the referent itself.
      const wantsWaterEdge = c.c === 'at-edge-of' && refId === 'water';
      let moved = 0;
      movers.forEach((o, i) => {
        // ALONG spreads the movers across the referent's extent; NEAR clusters them on its centroid side.
        const target = c.c === 'along' ? anchors[Math.floor((i + 0.5) * (anchors.length / movers.length))] ?? anchors[i % anchors.length]! : anchors[Math.floor(anchors.length / 2)]!;
        const inWaterMover = map.tiles[o.row]![o.col]!.startsWith('water');
        const cell = wantsWaterEdge
          ? nearestFree(map, target.c, target.r, 6, false)
          : nearestFree(map, target.c, target.r, 5, inWaterMover);
        if (cell) { o.col = cell.c; o.row = cell.r; moved++; }
      });
      notes.push(`placement: ${c.c}(${subj},${refId}) → moved ${moved}/${movers.length}`);
      continue;
    }

    // Everything else stays honest: recorded, visibly deferred.
    if (c.c !== 'through-fabric' && c.c !== 'crossable') {
      const subj = c.a ?? c.f ?? '?';
      notes.push(`placement: ${c.c}(${subj}${c.b ? `,${c.b}` : ''}) deferred (not yet compiled)`);
    }
  }
  return notes;
}
