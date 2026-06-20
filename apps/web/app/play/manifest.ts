/**
 * Asset manifest — the renderer's art tables, BUILT AT RUNTIME from the server's asset library
 * (assets/library.json, fetched via GET /assets/library). No hand-maintained tag list: the same
 * library that gives the Scene Director its vocabulary fills these maps, so they can't drift.
 * Call loadAssetLibrary() once before the Phaser game boots.
 *
 *   - TERRAIN_SRCS : terrain tag -> list of interchangeable tile images (variation per cell)
 *   - PROP_ART     : prop tag    -> image (or animated spritesheet) drawn on the grid
 *   - SPRITES      : character tag -> sprite image
 *
 * Interim art: CC0 Kenney "Tiny" trio + Tiny Creatures — every tile is an individual 16x16 PNG,
 * so terrain is image-based (no packed tilesets). Swappable for a paid pack with no contract change.
 */

export const TILE = 16; // native pixel-art tile size (1 tile = 5 ft)
export const MAX_ZOOM = 4; // cap so tiny scenes don't render giant

export interface PropArt {
  src: string;
  frameW: number;
  frameH: number;
  frames: number; // 1 = static image; >1 = animated spritesheet
  fps: number;
  footW?: number; // footprint width in tiles, for horizontal centering (default 1)
  light?: boolean; // a light source — exempt from the night tint so it glows
}
export interface SpriteDef {
  src: string;
  frameW: number;
  frameH: number;
  idleFrames: number;
  fps: number;
  /** Vertical origin (feet position) as a fraction of frameH (default 1 = feet at tile bottom). */
  anchorY?: number;
}

// Populated by loadAssetLibrary() before the renderer boots. Empty until then.
export const TERRAIN_SRCS: Record<string, string[]> = {};
export const PROP_ART: Record<string, PropArt> = {};
export const SPRITES: Record<string, SpriteDef> = {};

/** Fallback when an actor carries an unknown sprite tag. */
export const DEFAULT_SPRITE = 'villager';

interface LibAsset {
  kind: 'tileset' | 'terrain' | 'prop' | 'character';
  tag: string;
  art?: string;
  frameW?: number;
  frameH?: number;
  frames?: number;
  fps?: number;
  footW?: number;
  light?: boolean;
  idleFrames?: number;
  anchorY?: number;
  variants?: { art: string }[]; // terrain: interchangeable tile images
}

let loaded = false;

// Cache-bust for served art. Browsers cache PNGs by URL; when we re-extract a tile in place the
// URL is unchanged, so the stale cached image is served and asset swaps appear to do nothing.
// Bump this whenever the extracted art changes to force a fresh fetch.
const ASSET_VER = '12-shore-decals';
const bust = (u: string): string => `${u}?v=${ASSET_VER}`;

/** Fetch assets/library.json from the server and fill the art tables. Idempotent. */
export async function loadAssetLibrary(serverUrl: string): Promise<void> {
  if (loaded) return;
  const res = await fetch(`${serverUrl}/assets/library?v=${ASSET_VER}`);
  if (!res.ok) throw new Error(`asset library fetch failed: ${res.status}`);
  const lib = (await res.json()) as { assets: LibAsset[] };
  for (const a of lib.assets) {
    if (a.kind === 'terrain') {
      const srcs = (a.variants ?? []).map((v) => v.art).filter(Boolean).map(bust);
      if (srcs.length) TERRAIN_SRCS[a.tag] = srcs;
    } else if (a.kind === 'prop' && a.art) {
      PROP_ART[a.tag] = { src: bust(a.art), frameW: a.frameW ?? 16, frameH: a.frameH ?? 16, frames: a.frames ?? 1, fps: a.fps ?? 0, ...(a.footW ? { footW: a.footW } : {}), ...(a.light ? { light: true } : {}) };
    } else if (a.kind === 'character' && a.art) {
      SPRITES[a.tag] = { src: bust(a.art), frameW: a.frameW ?? 16, frameH: a.frameH ?? 16, idleFrames: a.idleFrames ?? 1, fps: a.fps ?? 1, ...(a.anchorY ? { anchorY: a.anchorY } : {}) };
    }
  }
  loaded = true;
}

// Cheap, stable per-cell hash (no Math.random — same scene seed → same map every render).
function cellHash(c: number, r: number, seed: number): number {
  let h = (Math.imul(c, 73856093) ^ Math.imul(r, 19349663) ^ Math.imul(seed, 83492791)) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}

/** All tile-image keys for a terrain tag. An auto-tile edge tag (e.g. grass_tl) degrades to its base
 *  terrain if its art is missing, then to grass, then anything — so a baked edge never renders blank. */
export function terrainSrcs(tag: string): string[] {
  const base = tag.replace(/_(tl|tr|bl|br|t|b|l|r)$/, '');
  return TERRAIN_SRCS[tag] ?? TERRAIN_SRCS[base] ?? TERRAIN_SRCS['grass'] ?? Object.values(TERRAIN_SRCS)[0] ?? [];
}

/** The terrain tile image (texture key) for a cell, chosen among VARIANTS by seeded noise so a
 *  field of grass isn't one frame repeated (the checkerboard). The key IS the art src path. */
export function terrainTileVariant(tag: string, col: number, row: number, seed: number): string {
  const srcs = terrainSrcs(tag);
  if (!srcs.length) {
    if (typeof console !== 'undefined') console.warn(`[manifest] no art for terrain '${tag}'`);
    return '';
  }
  return srcs[cellHash(col, row, seed) % srcs.length]!;
}
