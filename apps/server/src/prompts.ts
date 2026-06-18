/**
 * DM playbook as editable data (spec §6). Loaded from a file so the persona can be
 * tweaked without recompiling, and swapped via env for A/B tests. Falls back to the
 * built-in default if the file is missing.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DM_PLAYBOOK } from './orchestrator.js';

export const PLAYBOOK_PATH =
  process.env.MYTHWEAVER_PLAYBOOK_PATH ??
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../prompts/dm-playbook.md');

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
