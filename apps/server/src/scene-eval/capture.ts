/**
 * Visual-eval capture sink (strategy A — judge the REAL render).
 *
 * The renderer (Scene Lab / Phaser) snapshots its WebGL framebuffer to a PNG data URL and POSTs it
 * here; we persist it under captures/ so the visual judge scores the exact pixels the player sees.
 * Dev tool only. Pairs with visual-judge.ts (the judge) the way runner.ts pairs with rubric.ts.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// Anchor to the SRC tree so the writer (backend via tsx → src) and reader (judge CLI via dist)
// always agree on one captures dir. From src/scene-eval and from dist/scene-eval this resolves to
// the same apps/server/src/scene-eval/captures. Dev-tool only.
export const CAPTURES_DIR = resolve(HERE, '..', '..', 'src', 'scene-eval', 'captures');

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/i;

/** Absolute path for a capture by name (no extension). Throws on an unsafe name. */
export function capturePath(name: string): string {
  if (!NAME_RE.test(name)) throw new Error(`invalid capture name "${name}" (use letters, digits, dashes)`);
  return join(CAPTURES_DIR, `${name}.png`);
}

/** Decode a base64 PNG (no `data:` prefix) and write captures/<name>.png; returns the absolute path. */
export async function saveSceneCapture(name: string, base64Png: string): Promise<string> {
  const path = capturePath(name);
  await mkdir(CAPTURES_DIR, { recursive: true });
  await writeFile(path, Buffer.from(base64Png, 'base64'));
  return path;
}
