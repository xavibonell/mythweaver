/**
 * Asset library loader — the single source of truth for the visual layer (assets/library.json).
 *
 * One JSON record per asset feeds three consumers:
 *   - the Scene Director's vocabulary  (catalog.ts derives TERRAINS/PROPS/CHARACTERS from it)
 *   - the renderer                     (the web app fetches it via GET /assets/library)
 *   - the extractor                    (scripts/extract-assets.py produces the PNG from `from`)
 *
 * Loaded once via fs (server-side) by walking up from this module to the repo's assets/ dir,
 * so it resolves whether we run from src (tsx) or dist (built). To ADD an asset, edit the JSON
 * and run `npm run assets:extract` — nothing here changes.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type AssetKind = 'tileset' | 'terrain' | 'prop' | 'character';

/** How the extractor produces a served PNG: copy/crop from a raw pack, or procedurally generate. */
export interface AssetFrom {
  pack?: string;
  copy?: string;
  crop?: string;
  rect?: [number, number, number, number];
  gen?: string;
}

export interface AssetEntry {
  kind: AssetKind;
  tag: string;
  desc?: string;
  /** Biome hints surfaced to the Director so it picks era/setting-appropriate art. */
  biomes?: string[];
  /** Served art path (web-root absolute, e.g. "/assets/pixelcrawler/props/well.png"). */
  art?: string;
  frameW?: number;
  frameH?: number;
  // terrain
  walkable?: boolean;
  /** Interchangeable tile images; the renderer picks one per cell by seeded noise (variation). */
  variants?: { art: string; from?: AssetFrom }[];
  // prop
  frames?: number;
  fps?: number;
  footW?: number;
  footH?: number;
  blocks?: boolean;
  light?: boolean;
  /** A platform (boat/raft/bridge): makes its footprint tiles WALKABLE (even over water) so actors stand on it. */
  platform?: boolean;
  /** Renderable + resolvable, but NOT advertised to the LLM (e.g. the no-art placeholder fallback). */
  internal?: boolean;
  /** Provenance for license hygiene. CC0 sources (Kenney) need none; CC-BY sources (DawnLike) require
   *  attribution — surfaced via GET /assets/library so a future build can render a credits screen. */
  license?: string;
  attribution?: string;
  // character
  idleFrames?: number;
  anchorY?: number;
  /** How the extractor produces `art` (omit for terrains, which use per-variant `from`). */
  from?: AssetFrom;
}

export interface AssetLibrary {
  tile: number;
  maxZoom: number;
  assets: AssetEntry[];
}

let cached: AssetLibrary | undefined;

/** Load assets/library.json once (cached). Throws if it can't be found. */
export function loadAssetLibrary(): AssetLibrary {
  if (cached) return cached;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    try {
      cached = JSON.parse(readFileSync(join(dir, 'assets', 'library.json'), 'utf8')) as AssetLibrary;
      return cached;
    } catch {
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  throw new Error('asset library not found: assets/library.json (searched up from ' + fileURLToPath(import.meta.url) + ')');
}
