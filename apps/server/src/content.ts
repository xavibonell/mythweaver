/** Loads SRD-safe scenario seed data and validates it against the domain types. */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CharacterSheet, StatBlock } from '@mythweaver/shared';

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
