/**
 * DM playbook as editable data (spec §6). Loaded from a file so the persona can be
 * tweaked without recompiling, and swapped via env for A/B tests. Falls back to the
 * built-in default if the file is missing.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DM_PLAYBOOK } from './orchestrator.js';
import { ARCHITECT_SYSTEM, ARC_SYSTEM } from './arc-planner.js';
import { DEFAULT_COMPOSER_SYSTEM } from './arc-composer.js';

const PROMPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../prompts');

export const PLAYBOOK_PATH = process.env.MYTHWEAVER_PLAYBOOK_PATH ?? resolve(PROMPTS_DIR, 'dm-playbook.md');

export function loadPlaybook(): string {
  try {
    return readFileSync(PLAYBOOK_PATH, 'utf8');
  } catch {
    return DEFAULT_DM_PLAYBOOK;
  }
}

/** Persist an edited playbook to disk (DM Lab "Save"). */
export function savePlaybook(text: string): void {
  writeFileSync(PLAYBOOK_PATH, text);
}

// --- Game Director prompts (editable data, hot-reloaded — same seam as the playbook) -----------
// Each loader reads the file fresh so an edit + Save applies to the next session-create/generate,
// and falls back to the in-code default constant when the file is missing.

export const DIRECTOR_ARCHITECT_PATH = process.env.MYTHWEAVER_DIRECTOR_ARCHITECT_PATH ?? resolve(PROMPTS_DIR, 'director-architect.md');
export const DIRECTOR_PLANNER_PATH = process.env.MYTHWEAVER_DIRECTOR_PLANNER_PATH ?? resolve(PROMPTS_DIR, 'director-planner.md');
export const DIRECTOR_COMPOSER_PATH = process.env.MYTHWEAVER_DIRECTOR_COMPOSER_PATH ?? resolve(PROMPTS_DIR, 'director-composer.md');

function loadOr(path: string, fallback: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return fallback;
  }
}

export const loadDirectorArchitect = (): string => loadOr(DIRECTOR_ARCHITECT_PATH, ARCHITECT_SYSTEM);
export const loadDirectorPlanner = (): string => loadOr(DIRECTOR_PLANNER_PATH, ARC_SYSTEM);
export const loadDirectorComposer = (): string => loadOr(DIRECTOR_COMPOSER_PATH, DEFAULT_COMPOSER_SYSTEM);

export const saveDirectorArchitect = (text: string): void => writeFileSync(DIRECTOR_ARCHITECT_PATH, text);
export const saveDirectorPlanner = (text: string): void => writeFileSync(DIRECTOR_PLANNER_PATH, text);
export const saveDirectorComposer = (text: string): void => writeFileSync(DIRECTOR_COMPOSER_PATH, text);
