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
import { isCharacter, isProp } from './catalog.js';
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
 *  concept with no real art falls through to UNREPRESENTED (honest) instead of a broken tag.
 *  (Most values below landed with the ASSET FORGE — the ART WALL list turned into sprites.) */
const PROP_SYNONYMS: Record<string, string> = {
  rowboat: 'boat', boat: 'boat', skiff: 'boat', dinghy: 'boat', 'boat-overturned': 'boat', 'overturned-boat': 'boat',
  'lamp-post': 'lamp_post', lamppost: 'lamp_post', 'lantern-post': 'lamp_post', streetlamp: 'lamp_post', lantern: 'lamp_post', torch: 'torch_wall',
  barrel: 'barrel', crate: 'crate', chest: 'chest', strongbox: 'chest',
  rope: 'rope_coil', 'tarred-rope': 'rope_coil', 'bell-rope': 'rope_coil', chain: 'rope_coil',
  bell: 'bell_great', 'great-bell': 'bell_great', clapper: 'bell_clapper', 'bell-clapper': 'bell_clapper',
  weir: 'weir', 'iron-ring': 'iron_ring', ring: 'iron_ring', anchor: 'anchor', buoy: 'buoy',
  net: 'net_drying', 'fishing-net': 'net_drying', 'drying-rack': 'net_drying',
  tomb: 'tomb_door', 'sealed-tomb': 'tomb_door', 'tomb-door': 'tomb_door',
  well: 'well', pillar: 'pillar', column: 'pillar', 'broken-pillar': 'pillar_broken',
  lever: 'lever', portcullis: 'portcullis', 'spike-trap': 'spike_trap', shackles: 'shackles',
  coffin: 'coffin_wood', sarcophagus: 'sarcophagus', grave: 'gravestone', gravestone: 'gravestone', tombstone: 'tombstone',
  'ritual-circle': 'ritual_circle', pentagram: 'ritual_circle', crystal: 'crystal_glow', rune: 'rune_stone', 'rune-stone': 'rune_stone',
  altar: 'altar', throne: 'throne', fountain: 'fountain', statue: 'statue',
  mirror: 'mirror_standing', clock: 'clock_grandfather', fireplace: 'fireplace', hearth: 'fireplace',
  campfire: 'campfire', bonfire: 'bonfire', brazier: 'brazier', candle: 'candle',
  cart: 'minecart', 'ore-cart': 'minecart', minecart: 'minecart', sign: 'signpost', signpost: 'signpost',
  pot: 'pot', cauldron: 'cauldron', corpse: 'bones', body: 'bones', bones: 'bones', skull: 'skull',
  tent: 'tent', bedroll: 'tent', 'standing-stone': 'standing_stone', menhir: 'standing_stone', cairn: 'cairn',
  treehouse: 'treehouse', 'tree-house': 'treehouse', scarecrow: 'scarecrow', ladder: 'rope_ladder', 'rope-ladder': 'rope_ladder',
  blood: 'blood_pool', 'blood-pool': 'blood_pool', web: 'web_floor', cobweb: 'cobweb',
  'magic-circle': 'magic_circle', 'summoning-circle': 'magic_circle', smoke: 'smoke_plume', fire: 'fire_small',
  // ---- batch-2 biome kits (direct tag forms like 'lily-pad'→lily_pad resolve automatically) ----
  'palm-tree': 'palm', cactus: 'cactus_saguaro', saguaro: 'cactus_saguaro', 'barrel-cactus': 'cactus_barrel',
  dune: 'dune_crest', amphora: 'urn_clay', tumbleweed: 'tumbleweed',
  willow: 'willow_weeping', 'weeping-willow': 'willow_weeping', 'jungle-tree': 'jungle_canopy', canopy: 'jungle_canopy', kapok: 'jungle_canopy',
  lily: 'lily_pad', 'water-lily': 'lily_pad_flower', reed: 'reeds', rushes: 'reeds', cattail: 'cattails',
  fern: 'fern_giant', vine: 'vine_curtain', vines: 'vine_curtain', 'hanging-vines': 'vine_curtain',
  toadstool: 'shroom_cluster', 'giant-mushroom': 'mushroom_glowcap', glowcap: 'mushroom_glowcap',
  idol: 'idol_moss', 'stone-idol': 'idol_moss', 'rotten-log': 'log_rotten', 'fallen-log': 'log_fallen', miasma: 'swamp_gas',
  icicle: 'ice_spike', 'ice-shard': 'ice_spikes', iceberg: 'ice_boulder', 'whale-bones': 'whale_ribs', 'whale-skeleton': 'whale_ribs', ribcage: 'whale_ribs',
  sled: 'sled_wood', sledge: 'sled_wood', sleigh: 'sled_wood',
  obsidian: 'obsidian_shard', 'volcanic-glass': 'obsidian_shard', basalt: 'basalt_column', fumarole: 'vent_volcanic', vent: 'vent_volcanic', geyser: 'geyser_sulfur',
  stalagmite: 'stalagmite_tall', geode: 'geode_open', sulfur: 'sulfur_mound', 'blue-crystal': 'crystal_blue', 'purple-crystal': 'crystal_purple',
  oak: 'oak_ancient', 'ancient-oak': 'oak_ancient', 'great-oak': 'oak_ancient', 'dead-tree': 'tree_dead', 'bare-tree': 'tree_dead',
  'berry-bush': 'bush_berry', haystack: 'hay_bale', wheat: 'wheat_shock', sheaf: 'wheat_shock', hive: 'beehive',
  arch: 'arch_stone', archway: 'arch_stone', 'stone-arch': 'arch_stone', 'ruined-wall': 'wall_ruin_stub', 'broken-wall': 'wall_ruin_stub',
  bridge: 'bridge_plank_h', 'plank-bridge': 'bridge_plank_h', footbridge: 'bridge_plank_h',
  gate: 'gate_wood', platform: 'platform_wood', 'wooden-platform': 'platform_wood', 'weathered-statue': 'statue_weathered',
};

/** kinds whose realization is a HOSTILE actor. */
const HOSTILE = /\b(undead|dead|zombie|ghoul|skeleton|revenant|wight|wraith|ghost|spectre|specter|bandit|wolf|goblin|orc|rat|spider|cultist|crocodile|scorpion|salamander)\b/;

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

/** The concepts in a spec that the FAST PATH (synonym tables + direct forms) cannot resolve —
 *  the server pre-binds exactly these via retrieval (one batched embed call), then hands the
 *  result to compileSpec as opts.bindings. Mirrors compileSpec's branch order. */
export function unresolvedSpecConcepts(spec: SceneSpec): { props: string[]; actors: string[] } {
  const props = new Set<string>();
  const actors = new Set<string>();
  for (const f of spec.features ?? []) {
    const t = tail(f.kind);
    if (/^(dock|pier|jetty|wharf|quay|harbou?r)/.test(t) || f.kind.startsWith('dock.')) continue;
    if (/^(mine|adit|shaft)/.test(t) || /canal/.test(t) || /^(wall|palisade|rampart)$/.test(t)) continue;
    if (f.kind.startsWith('building.') || (BUILDING_SYNONYMS[clean(t)] && !f.kind.startsWith('prop.'))) continue;
    if (f.kind.startsWith('terrain.')) continue; // base topology — honest note, NEVER a prop binding
    if (f.kind.startsWith('actor.') || HOSTILE.test(t)) {
      const direct = clean(t).replace(/-/g, '_'); // mirror compileSpec's direct tag-form hit
      if (!isCharacter(direct) && lookToSprite(t.replace(/-/g, ' ')) === 'villager' && !/villager|peasant|towns/.test(t)) actors.add(clean(t));
      continue;
    }
    if (!resolvePropTag(t)) props.add(clean(t));
  }
  return { props: [...props], actors: [...actors] };
}

/** Semantic bindings (concept → verified tag) from the retrieval layer — the LONG-TAIL FALLBACK
 *  consulted only AFTER the exact/synonym fast path misses. Keys are clean() concepts. */
export interface SpecBindings {
  props?: Record<string, string>;
  actors?: Record<string, string>;
}

export function compileSpec(spec: SceneSpec, opts: { settlement: boolean; bindings?: SpecBindings; ambientHostiles?: boolean }): SpecCompileResult {
  const contents: SpecCompileResult['contents'] = { buildings: [], landmarks: [], npcs: [], mobs: [] };
  const postOps: SceneOp[] = [];
  const notes: string[] = [];
  const unrepresented: string[] = [];

  // Which features are constrained INTO the water ("in: water") — realized as in-water scatters.
  const inWater = new Set(
    (spec.constraints ?? []).filter((c) => c.c === 'in' && c.region === 'water' && (c.a || c.f)).map((c) => (c.a ?? c.f)!),
  );
  // CAST STATIONS: a named actor's near/in constraint to another feature IS their post — carried as
  // an anchor so the generator stands them AT it (the fiction's "Hobb the smith" belongs at his forge).
  // The anchor word is the FEATURE ID: realized objects carry it as their name (a named building's id
  // rides its keeper; a single landmark keeps it as `name`), so the station resolver finds it directly.
  const stationOf = (fid: string): string | undefined => {
    const c = (spec.constraints ?? []).find((c) => c.a === fid && (c.c === 'near' || c.c === 'in' || c.c === 'at-edge-of') && c.b && c.b !== 'PARTY' && c.region !== 'water');
    if (!c?.b) return undefined;
    return `${c.c === 'in' ? 'in' : 'near'}:${c.b}`;
  };
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
      const direct = t.replace(/-/g, '_');
      let sprite = isCharacter(direct) ? direct : lookToSprite(t.replace(/-/g, ' '));
      // The synonym table's miss value is the generic 'villager' — only THEN may a semantic
      // binding (retrieval) speak; a specific table hit is never overridden.
      const bound = opts.bindings?.actors?.[clean(t)];
      if (sprite === 'villager' && !/villager|peasant|towns/.test(t) && bound && isCharacter(bound)) {
        sprite = bound;
        notes.push(`spec: ${f.id} — '${t}' bound semantically → ${bound}`);
      }
      const hostile = HOSTILE.test(t);
      // ESTABLISH GATE: spec hostiles are the beat's LOOMING threat, not pre-placed combatants — the
      // authored encounter (startEncounter) owns combat creatures. With ambientHostiles:false we HOLD
      // them (reported, never scattered): a pre-combat opening must not show a roaming horde that both
      // contradicts the beat's dread and duplicates the encounter the engine will spawn.
      if (hostile && opts.ambientHostiles === false) {
        notes.push(`spec: ${f.id} → ${count}× ${sprite} HELD (authored encounter owns combat creatures — not pre-scattered)`);
        continue;
      }
      if (inWater.has(f.id)) {
        postOps.push({ op: 'scatter', idBase: `mob:${f.id}`, tags: [sprite], kind: 'actor', role: hostile ? 'mob' : 'npc', region: 'all', count, on: 'water' });
        notes.push(`spec: ${f.id} → ${count}× ${sprite} IN the water`);
      } else if (opts.settlement) {
        if (hostile) contents.mobs.push({ tag: sprite, count });
        else {
          const anchor = count === 1 ? stationOf(f.id) : undefined;
          for (let i = 0; i < count; i++) contents.npcs.push({ tag: sprite, ...(count === 1 ? { name: f.id } : {}), ...(anchor ? { anchor } : {}) });
          if (anchor) notes.push(`spec: ${f.id} station → ${anchor}`);
        }
        notes.push(`spec: ${f.id} → ${count}× ${sprite}${hostile ? ' (hostile)' : ''}`);
      } else {
        postOps.push({ op: 'scatter', idBase: `${hostile ? 'mob' : 'npc'}:${f.id}`, tags: [sprite], kind: 'actor', role: hostile ? 'mob' : 'npc', region: 'all', count });
        notes.push(`spec: ${f.id} → ${count}× ${sprite}${hostile ? ' (hostile)' : ''}`);
      }
      continue;
    }

    // PROPS / DECOR / LANDMARKS — catalog tag via synonyms, then the SEMANTIC BINDING fallback
    // (retrieval); in-water props float; still-unresolvable is REPORTED.
    let tag = resolvePropTag(t);
    if (!tag && !f.kind.startsWith('terrain.')) {
      const bound = opts.bindings?.props?.[clean(t)];
      if (bound && isProp(bound)) {
        tag = bound;
        notes.push(`spec: ${f.id} — '${t}' bound semantically → ${bound}`);
      }
    }
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

/** The subject's movable OBJECTS (never buildings/terrain — those were placed structurally). A named
 *  BUILDING's identity rides its keeper NPC (`npc:…-keeper`), and the keeper stays at their station:
 *  the building's relations were satisfied at LOT time (waterfront bias), so a `near(boathouse, dock)`
 *  must not drag Mother Sedge out of her boathouse onto the quay. */
function movableObjects(map: SceneMap, fid: string): MapObject[] {
  if (fid === 'PARTY') return map.objects.filter((o) => o.role === 'pc');
  const ids = [`prop:${fid}`, `mob:${fid}`, `npc:${fid}`];
  return map.objects.filter((o) => !o.id.endsWith('-keeper') && (ids.includes(o.id) || (o.group && ids.includes(o.group)) || o.name === fid));
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
    // in:water was compiled pre-map (scatter on:'water') — VERIFY it landed: a waterless scene
    // silently drops the scatter, and the DM must re-narrate that.
    if (c.c === 'in' && c.region === 'water') {
      const fid = c.a ?? c.f;
      if (fid) {
        const got = movableObjects(map, fid).length;
        const want = (spec.features ?? []).find((f) => f.id === fid)?.count ?? 1;
        notes.push(got === 0
          ? `placement: in(${fid},water) → 0/${want} realized — the scene has no water; re-narrate`
          : `placement: in(${fid},water) → ${got}/${want} in the water`);
      }
      continue;
    }

    if (c.c === 'near' || c.c === 'along' || c.c === 'at-edge-of') {
      const subj = c.a ?? c.f;
      const refId = c.b ?? c.region ?? c.of ?? 'PARTY';
      if (!subj) continue;
      const movers = movableObjects(map, subj);
      if (!movers.length) {
        // A named BUILDING realizes as walls + a name-carrying keeper — its relation was satisfied
        // at LOT time (the waterfront bias), so say that instead of implying it went unrealized.
        // Match by keeper name (archetype path) OR keeper-id slug (loose `building` op path).
        const slugged = subj.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const asBuilding = map.objects.some((o) => o.id.endsWith('-keeper') && (o.name === subj || o.id.includes(slugged)));
        notes.push(asBuilding
          ? `placement: ${c.c}(${subj},${refId}) — a building: placed at lot time (waterfront bias), not moved post-hoc`
          : `placement: ${c.c}(${subj},${refId}) — subject not movable (structural or unrealized)`);
        continue;
      }
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
