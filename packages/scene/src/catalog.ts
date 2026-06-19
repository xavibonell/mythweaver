/**
 * Asset catalog — the vocabulary the Scene Director composes with. It is DERIVED from the
 * single asset library (assets/library.json, via ./asset-library) so there is exactly one
 * place to register art: a new record there flows to the Director's prompt here AND to the
 * renderer (which fetches the same library). The Director may only emit tags listed here.
 */

import { loadAssetLibrary, type AssetEntry } from './asset-library.js';

export interface TerrainDef {
  tag: string;
  desc: string;
  walkable: boolean;
}
export interface PropDef {
  tag: string;
  desc: string;
  /** Collision footprint in tiles (small — usually the base/trunk). Art may render larger. */
  w: number;
  h: number;
  blocks: boolean;
}
export interface CharDef {
  tag: string;
  desc: string;
  biomes?: string[];
}

const LIB = loadAssetLibrary();
const byKind = (k: AssetEntry['kind']): AssetEntry[] => LIB.assets.filter((a) => a.kind === k);

export const TERRAINS: TerrainDef[] = byKind('terrain').map((a) => ({ tag: a.tag, desc: a.desc ?? a.tag, walkable: a.walkable ?? true }));

export const PROPS: PropDef[] = byKind('prop').map((a) => ({ tag: a.tag, desc: a.desc ?? a.tag, w: a.footW ?? 1, h: a.footH ?? 1, blocks: a.blocks ?? true }));

/** Internal props (e.g. the no-art placeholder) — renderable + resolvable, but NEVER offered to the LLM. */
const INTERNAL_PROP_TAGS = new Set(byKind('prop').filter((a) => a.internal).map((a) => a.tag));
/** The prop vocabulary advertised to the Director/DM (excludes internal fallbacks). */
export const PROMPT_PROPS: PropDef[] = PROPS.filter((p) => !INTERNAL_PROP_TAGS.has(p.tag));

export const CHARACTERS: CharDef[] = byKind('character').map((a) => ({ tag: a.tag, desc: a.desc ?? a.tag, ...(a.biomes ? { biomes: a.biomes } : {}) }));

/** Biome hints per tag (for a richer Director prompt), keyed from the library. */
const BIOMES_BY_TAG = new Map<string, string[]>(LIB.assets.filter((a) => a.biomes?.length).map((a) => [a.tag, a.biomes!]));

const TERRAIN_TAGS = new Set(TERRAINS.map((t) => t.tag));
const PROP_TAGS = new Set(PROPS.map((p) => p.tag));
const CHAR_TAGS = new Set(CHARACTERS.map((c) => c.tag));

export function isTerrain(tag: string): boolean {
  return TERRAIN_TAGS.has(tag);
}
export function isProp(tag: string): boolean {
  return PROP_TAGS.has(tag);
}
export function isCharacter(tag: string): boolean {
  return CHAR_TAGS.has(tag);
}
export function propDef(tag: string): PropDef | undefined {
  return PROPS.find((p) => p.tag === tag);
}
export function terrainWalkable(tag: string): boolean {
  return TERRAINS.find((t) => t.tag === tag)?.walkable ?? true;
}

/** Render the catalog as a compact block for the Director's prompt (with biome hints). */
export function catalogPrompt(): string {
  const hint = (tag: string): string => {
    const b = BIOMES_BY_TAG.get(tag);
    return b ? `  [${b.join('/')}]` : '';
  };
  const line = (x: { tag: string; desc: string }): string => `  ${x.tag} — ${x.desc}${hint(x.tag)}`;
  const t = TERRAINS.map(line).join('\n');
  const p = PROMPT_PROPS.map(line).join('\n');
  const c = CHARACTERS.map(line).join('\n');
  return `TERRAINS (floor):\n${t}\n\nPROPS (placed objects):\n${p}\n\nCHARACTER SPRITES (for actors):\n${c}`;
}
