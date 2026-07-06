/** Loads SRD-safe scenario seed data and validates it against the domain types. */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CharacterSheet, ItemDef, StatBlock } from '@mythweaver/shared';

const CONTENT_DIR =
  process.env.MYTHWEAVER_CONTENT_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../content');

export interface ScenarioScene {
  id: string;
  title: string;
  summary: string;
  exits: string[];
}

export interface ScenarioEncounter {
  id: string;
  sceneId: string;
  monsters: { statBlockId: string; count: number }[];
}

export interface Scenario {
  id: string;
  title: string;
  pitch: string;
  startSceneId: string;
  scenes: ScenarioScene[];
  encounters: ScenarioEncounter[];
}

export interface ScenarioBundle {
  scenario: Scenario;
  pregens: CharacterSheet[];
  bestiary: StatBlock[];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** Absolute path to a scenario's scenario.json (used by the DM Lab read/save endpoints). */
export function scenarioJsonPath(slug: string): string {
  return resolve(CONTENT_DIR, 'scenarios', slug, 'scenario.json');
}

/** Raw scenario.json text, for editing in the DM Lab. */
export function readScenarioRaw(slug: string): string {
  return readFileSync(scenarioJsonPath(slug), 'utf8');
}

/** Validate the structural invariants of a scenario object (shared by load + override + save). */
export function validateScenario(scenario: Scenario, slug: string): void {
  if (!scenario || typeof scenario !== 'object') throw new Error(`Scenario "${slug}" is not an object.`);
  if (!scenario.id || !scenario.startSceneId || !Array.isArray(scenario.scenes) || scenario.scenes.length === 0) {
    throw new Error(`Scenario "${slug}" is missing an id, start scene, or scenes.`);
  }
  if (!scenario.scenes.some((s) => s.id === scenario.startSceneId)) {
    throw new Error(`Scenario "${slug}" startSceneId does not match any scene.`);
  }
}

/** Parse + validate a scenario JSON string (for the DM Lab override/save). Throws on bad JSON/shape. */
export function parseScenario(json: string, slug: string): Scenario {
  let parsed: Scenario;
  try {
    parsed = JSON.parse(json) as Scenario;
  } catch (err) {
    throw new Error(`Scenario "${slug}" is not valid JSON: ${(err as Error).message}`);
  }
  validateScenario(parsed, slug);
  return parsed;
}

/** Validate + persist edited scenario.json to disk (DM Lab "Save"). */
export function writeScenarioRaw(slug: string, json: string): void {
  parseScenario(json, slug); // validate before overwriting
  writeFileSync(scenarioJsonPath(slug), json.endsWith('\n') ? json : `${json}\n`);
}

// --- Shared libraries (Game Director generation) ------------------------------------------------
// Party archetypes + a game-wide bestiary live OUTSIDE any one scenario, so a generated campaign
// draws its mechanical pieces from a shared pool instead of being chained to an authored scenario.

const SHARED_DIR = resolve(CONTENT_DIR, 'shared');

/** The role archetypes a player can pick (Fighter, Rogue, …) — validated level-1 character sheets. */
export function loadSharedParty(): CharacterSheet[] {
  const party = readJson<CharacterSheet[]>(resolve(SHARED_DIR, 'party.json'));
  for (const p of party) {
    if (!p.id || !p.name || typeof p.maxHitPoints !== 'number' || typeof p.armorClass !== 'number') {
      throw new Error(`Shared party archetype is invalid (need id, name, numeric HP/AC): ${JSON.stringify(p).slice(0, 80)}`);
    }
  }
  return party;
}

/** The game-wide monster library the Director selects from (and the engine generates alongside). */
export function loadSharedBestiary(): StatBlock[] {
  const bestiary = readJson<StatBlock[]>(resolve(SHARED_DIR, 'bestiary.json'));
  for (const b of bestiary) {
    if (!b.id || !b.name || typeof b.armorClass !== 'number') {
      throw new Error(`Shared bestiary entry is invalid (need id, name, numeric AC): ${JSON.stringify(b).slice(0, 80)}`);
    }
  }
  return bestiary;
}

/** The game-wide item catalog (P3d): loaded on boot like the bestiary; ItemRefs on a character point into it. */
export function loadItemCatalog(): Record<string, ItemDef> {
  const items = readJson<ItemDef[]>(resolve(SHARED_DIR, 'items.json'));
  const catalog: Record<string, ItemDef> = {};
  for (const it of items) {
    if (!it.id || !it.name || !it.category || typeof it.weightLb !== 'number') {
      throw new Error(`Shared item is invalid (need id, name, category, numeric weightLb): ${JSON.stringify(it).slice(0, 80)}`);
    }
    catalog[it.id] = it;
  }
  return catalog;
}

/**
 * Resolve a hand-built party (Add player → pick role) into playable character sheets: each pick clones
 * its role archetype, with a unique id and the player's chosen name (falling back to the role label).
 * Unknown roles are dropped; an empty/garbage party falls back to a single Fighter so play never breaks.
 */
export function resolveParty(picks: { role: string; name?: string; backstory?: string }[]): CharacterSheet[] {
  const lib = loadSharedParty();
  const byId = new Map(lib.map((p) => [p.id, p]));
  const out: CharacterSheet[] = [];
  picks.forEach((pick, i) => {
    const archetype = byId.get(pick.role);
    if (!archetype) return;
    const name = (pick.name || '').trim() || `${archetype.name} ${out.filter((p) => p.className === archetype.className).length + 1}`;
    const backstory = (pick.backstory || '').trim();
    out.push({ ...archetype, id: `pc-${i + 1}-${archetype.id}`, name, ...(backstory ? { backstory } : {}) });
  });
  if (out.length === 0) {
    const fighter = byId.get('fighter') ?? lib[0]!;
    out.push({ ...fighter, id: 'pc-1-fighter', name: fighter.name });
  }
  return out;
}

export function loadScenario(slug: string): ScenarioBundle {
  const base = resolve(CONTENT_DIR, 'scenarios', slug);
  const scenario = readJson<Scenario>(resolve(base, 'scenario.json'));
  const pregens = readJson<CharacterSheet[]>(resolve(base, 'pregens.json'));
  const bestiary = readJson<StatBlock[]>(resolve(base, 'bestiary.json'));

  // Validation so bad seed data fails loudly at boot (build plan P0-9).
  validateScenario(scenario, slug);
  if (pregens.length === 0) throw new Error(`Scenario "${slug}" has no pre-gen characters.`);
  for (const p of pregens) {
    if (!p.id || !p.name || typeof p.maxHitPoints !== 'number' || typeof p.armorClass !== 'number') {
      throw new Error(`Scenario "${slug}" has an invalid pre-gen (need id, name, numeric HP/AC).`);
    }
  }
  for (const b of bestiary) {
    if (!b.id || !b.name || typeof b.armorClass !== 'number') {
      throw new Error(`Scenario "${slug}" has an invalid stat block (need id, name, numeric AC).`);
    }
  }

  return { scenario, pregens, bestiary };
}
