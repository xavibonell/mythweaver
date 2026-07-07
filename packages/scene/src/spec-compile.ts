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

import { BUILDING_TYPES, type BuildingType, type SceneSpec } from '@mythweaver/shared';
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

  for (const f of spec.features ?? []) {
    const t = tail(f.kind);
    const count = Math.max(1, Math.min(12, f.count ?? 1));

    // FRONTIER FLAGS — a named dock/mine/canal/wall becomes the matching frontier feature.
    if (/^(dock|pier|jetty|wharf|quay|harbou?r)/.test(t) || f.kind.startsWith('dock.')) {
      contents.coast = true;
      contents.port = true;
      notes.push(`spec: ${f.id} (${f.kind}) → coast+port frontier`);
      continue;
    }
    if (/^(mine|adit|shaft)/.test(t)) { contents.mountain = true; contents.mine = true; notes.push(`spec: ${f.id} → mountain+mine frontier`); continue; }
    if (/canal/.test(t)) { contents.canal = true; notes.push(`spec: ${f.id} → canal`); continue; }
    if (/^(wall|palisade|rampart)$/.test(t)) { contents.wall = true; notes.push(`spec: ${f.id} → town wall`); continue; }

    // BUILDINGS — the fixed type vocabulary, count-expanded. Nothing named is dropped.
    if (f.kind.startsWith('building.') || (BUILDING_SYNONYMS[clean(t)] && !f.kind.startsWith('prop.'))) {
      const type = BUILDING_SYNONYMS[clean(t)];
      if (type) {
        for (let i = 0; i < Math.min(count, 8); i++) contents.buildings.push({ type, ...(count === 1 ? { name: f.id } : {}) });
        notes.push(`spec: ${f.id} → ${Math.min(count, 8)}× ${type}`);
      } else {
        for (let i = 0; i < Math.min(count, 8); i++) contents.buildings.push({ type: 'house' });
        notes.push(`spec: ${f.id} (${f.kind}) → house (no closer building type)`);
      }
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
      } else if (opts.settlement) {
        contents.landmarks.push({ tag, name: f.id });
        notes.push(`spec: ${f.id} → landmark ${tag}`);
      } else {
        postOps.push({ op: 'place', id: `prop:${f.id}`, tag, kind: 'prop', at: 'center' });
        notes.push(`spec: ${f.id} → ${tag}`);
      }
      continue;
    }

    // terrain.* is the base-topology LLM's job (it reads the brief); everything else is unrepresented.
    if (f.kind.startsWith('terrain.')) notes.push(`spec: ${f.id} (${f.kind}) → base terrain (programmer's brief)`);
    else unrepresented.push(`${f.id} (${f.kind})`);
  }

  // Relations beyond in:water are recorded for the provenance panel — L1+ territory, not silently eaten.
  const deferred = (spec.constraints ?? []).filter((c) => !(c.c === 'in' && c.region === 'water')).map((c) => c.c);
  if (deferred.length) notes.push(`spec: ${deferred.length} relation(s) recorded, not yet compiled (${[...new Set(deferred)].join(', ')})`);

  const edge = spec.frame?.entry?.edge;
  return {
    contents,
    postOps,
    ...(edge === 'north' || edge === 'south' || edge === 'east' || edge === 'west' ? { entryEdge: edge } : {}),
    notes,
    unrepresented,
  };
}
