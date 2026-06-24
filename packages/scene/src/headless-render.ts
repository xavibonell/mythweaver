/**
 * Headless SceneMap → PNG renderer — a pure-Node, browser-free compositor that blits the SAME 16×16
 * DawnLike PNGs the web app loads, so the visual judge (apps/server/src/scene-eval) can score real pixels
 * automatically (no Phaser, no headless browser). It replicates apps/web/app/play/manifest.ts +
 * SceneCanvas.tsx exactly: the per-cell seeded terrain variant pick, the auto-tile suffix fallback chain,
 * frame-0 sprite slicing, feet-bottom anchoring, and the ambiance→props→actors painter's-depth order — so
 * a headless render matches the browser cell-for-cell. Layout/composition fidelity (what the judge grades),
 * not WebGL lighting (the dusk/night tint is intentionally NOT applied).
 */

import { PNG } from 'pngjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SceneMap } from '@mythweaver/shared';
import { loadAssetLibrary, type AssetEntry } from './asset-library.js';

const TILE = 16;
const BG = { r: 0x0d, g: 0x0b, b: 0x0a }; // SceneCanvas backgroundColor #0d0b0a

// ── Art tables, built once from assets/library.json (mirrors manifest.ts loadAssetLibrary). ──
interface ArtTables { terrain: Record<string, string[]>; prop: Map<string, AssetEntry>; char: Map<string, AssetEntry>; }
let tables: ArtTables | undefined;
function artTables(): ArtTables {
  if (tables) return tables;
  const lib = loadAssetLibrary();
  const terrain: Record<string, string[]> = {};
  const prop = new Map<string, AssetEntry>();
  const char = new Map<string, AssetEntry>();
  for (const a of lib.assets) {
    if (a.kind === 'terrain') {
      const srcs = (a.variants ?? []).map((v) => v.art).filter(Boolean);
      if (srcs.length) terrain[a.tag] = srcs;
    } else if (a.kind === 'prop' && a.art) prop.set(a.tag, a);
    else if (a.kind === 'character' && a.art) char.set(a.tag, a);
  }
  tables = { terrain, prop, char };
  return tables;
}

// ── Seeded per-cell terrain variant (verbatim from manifest.ts so headless == browser). ──
function cellHash(c: number, r: number, seed: number): number {
  let h = (Math.imul(c, 73856093) ^ Math.imul(r, 19349663) ^ Math.imul(seed, 83492791)) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}
const ACCENT_SHARE = 0.22;
function terrainSrcs(terrain: Record<string, string[]>, tag: string): string[] {
  const base = tag.replace(/_(tl|tr|bl|br|t|b|l|r)$/, '');
  return terrain[tag] ?? terrain[base] ?? terrain['grass'] ?? Object.values(terrain)[0] ?? [];
}
function terrainVariant(terrain: Record<string, string[]>, tag: string, col: number, row: number, seed: number): string {
  const srcs = terrainSrcs(terrain, tag);
  if (!srcs.length) return '';
  if (srcs.length === 1) return srcs[0]!;
  const h = cellHash(col, row, seed);
  if ((h % 1000) / 1000 >= ACCENT_SHARE) return srcs[0]!;
  return srcs[1 + ((h >>> 10) % (srcs.length - 1))]!;
}

// ── PNG decode cache (one art file is reused across hundreds of cells). ──
const pngCache = new Map<string, PNG | null>();
function loadPng(assetsRoot: string, art: string): PNG | null {
  const rel = art.replace(/\?.*$/, '').replace(/^\//, ''); // strip any cache-bust query + leading slash
  const abs = join(assetsRoot, rel);
  if (pngCache.has(abs)) return pngCache.get(abs)!;
  let p: PNG | null = null;
  try { p = PNG.sync.read(readFileSync(abs)); } catch { p = null; }
  pngCache.set(abs, p);
  return p;
}

/** Render a SceneMap to a PNG Buffer (cols·16 × rows·16). `assetsRoot` is the absolute path to apps/web/public. */
export function renderSceneMapToPng(scene: SceneMap, opts: { assetsRoot: string }): Buffer {
  const { assetsRoot } = opts;
  const { cols, rows } = scene.grid;
  const seed = scene.seed ?? 0;
  const out = new PNG({ width: cols * TILE, height: rows * TILE });
  for (let i = 0; i < out.data.length; i += 4) { out.data[i] = BG.r; out.data[i + 1] = BG.g; out.data[i + 2] = BG.b; out.data[i + 3] = 255; }
  const { terrain, prop, char } = artTables();

  // Alpha-over blit of frame 0 (the top-left frameW×frameH slice of a sheet) at (dstX,dstY).
  const blit = (src: PNG, dstX: number, dstY: number, frameW: number, frameH: number) => {
    const fw = Math.min(frameW, src.width), fh = Math.min(frameH, src.height);
    for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) {
      const dx = dstX + x, dy = dstY + y;
      if (dx < 0 || dy < 0 || dx >= out.width || dy >= out.height) continue;
      const si = (y * src.width + x) << 2;
      const a = src.data[si + 3]! / 255; if (a === 0) continue;
      const di = (dy * out.width + dx) << 2;
      out.data[di] = Math.round(src.data[si]! * a + out.data[di]! * (1 - a));
      out.data[di + 1] = Math.round(src.data[si + 1]! * a + out.data[di + 1]! * (1 - a));
      out.data[di + 2] = Math.round(src.data[si + 2]! * a + out.data[di + 2]! * (1 - a));
      out.data[di + 3] = 255;
    }
  };

  // Pass 1 — terrain.
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const tag = scene.tiles[r]?.[c]; if (!tag) continue;
    const art = terrainVariant(terrain, tag, c, r, seed); if (!art) continue;
    const png = loadPng(assetsRoot, art); if (png) blit(png, c * TILE, r * TILE, TILE, TILE);
  }

  // Pass 2 — ambiance + objects, painter's order (ambiance behind, props, actors on top).
  interface Draw { asset: AssetEntry | undefined; col: number; row: number; depth: number; footW: number; footH: number; actor: boolean; }
  const items: Draw[] = [];
  for (const a of scene.ambiance ?? []) items.push({ asset: prop.get(a.tag), col: a.col, row: a.row, depth: a.row - 0.1, footW: 1, footH: 1, actor: false });
  for (const o of scene.objects ?? []) {
    if (o.visible === false) continue;
    const actor = o.kind === 'actor';
    const asset = actor ? (char.get(o.tag) ?? char.get('villager')) : prop.get(o.tag);
    items.push({ asset, col: o.col, row: o.row, depth: o.row + (actor ? 0.5 : 0.1), footW: actor ? 1 : (o.footprint?.w ?? 1), footH: actor ? 1 : (o.footprint?.h ?? 1), actor });
  }
  items.sort((p, q) => p.depth - q.depth);
  for (const it of items) {
    const asset = it.asset; if (!asset?.art) continue;
    const png = loadPng(assetsRoot, asset.art); if (!png) continue;
    const fw = asset.frameW ?? TILE, fh = asset.frameH ?? TILE;
    const anchorY = it.actor ? (asset.anchorY ?? 1) : 1; // props anchor center-bottom; actors by anchorY
    const dstX = Math.round((it.col + it.footW / 2) * TILE - fw / 2);
    const dstY = Math.round((it.row + it.footH) * TILE - fh * anchorY);
    blit(png, dstX, dstY, fw, fh);
  }

  return PNG.sync.write(out);
}
