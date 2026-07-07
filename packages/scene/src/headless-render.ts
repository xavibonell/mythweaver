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

// ── Vector rasterisers for the roof geometry (mirror the Phaser Graphics draw). ──
function setPx(out: PNG, x: number, y: number, r: number, g: number, b: number): void {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= out.width || y >= out.height) return;
  const i = ((y * out.width) + x) << 2;
  out.data[i] = r; out.data[i + 1] = g; out.data[i + 2] = b; out.data[i + 3] = 255;
}
/** Scanline-fill a polygon with a vertical gradient (top colour at the poly's top → bot at its bottom). */
function fillGradPoly(out: PNG, pts: number[], top: number, bot: number): void {
  const tr = (top >> 16) & 255, tg = (top >> 8) & 255, tb = top & 255;
  const br = (bot >> 16) & 255, bg = (bot >> 8) & 255, bb = bot & 255;
  const n = pts.length / 2; if (n < 3) return;
  let ymin = Infinity, ymax = -Infinity;
  for (let i = 1; i < pts.length; i += 2) { ymin = Math.min(ymin, pts[i]!); ymax = Math.max(ymax, pts[i]!); }
  ymin = Math.floor(ymin); ymax = Math.ceil(ymax);
  for (let y = ymin; y <= ymax; y++) {
    const xs: number[] = [];
    for (let i = 0; i < n; i++) {
      const ax = pts[i * 2]!, ay = pts[i * 2 + 1]!, j = (i + 1) % n, bx = pts[j * 2]!, by = pts[j * 2 + 1]!;
      if ((ay <= y && by > y) || (by <= y && ay > y)) xs.push(ax + (bx - ax) * (y - ay) / (by - ay));
    }
    xs.sort((a, b) => a - b);
    const t = ymax > ymin ? (y - ymin) / (ymax - ymin) : 0;
    const r = Math.round(tr + (br - tr) * t), g = Math.round(tg + (bg - tg) * t), b = Math.round(tb + (bb - tb) * t);
    for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.round(xs[k]!); x < Math.round(xs[k + 1]!); x++) setPx(out, x, y, r, g, b);
  }
}
/** Stroke a line of pixel width `w`. */
function strokeLine(out: PNG, x1: number, y1: number, x2: number, y2: number, c: number, w: number): void {
  const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
  const dx = x2 - x1, dy = y2 - y1, steps = Math.max(1, Math.ceil(Math.hypot(dx, dy)));
  const lo = Math.floor((w - 1) / 2), hi = Math.ceil((w - 1) / 2);
  for (let s = 0; s <= steps; s++) {
    const px = x1 + dx * s / steps, py = y1 + dy * s / steps;
    for (let oy = -lo; oy <= hi; oy++) for (let ox = -lo; ox <= hi; ox++) setPx(out, px + ox, py + oy, r, g, b);
  }
}

/** Render a SceneMap to a PNG Buffer (cols·16 × rows·16). `assetsRoot` is the absolute path to apps/web/public. */
export function renderSceneMapToPng(scene: SceneMap, opts: { assetsRoot: string; showRoofs?: boolean }): Buffer {
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
  interface Draw { asset: AssetEntry | undefined; col: number; row: number; depth: number; footW: number; footH: number; actor: boolean; float: boolean; }
  const items: Draw[] = [];
  // `float` = a boat lying ON the water: it is CENTRED on its cell, not feet-bottom anchored (a boat isn't
  // "standing" on the ground), so a boat moored alongside a pier sits IN the water instead of extending up onto the planks.
  for (const a of scene.ambiance ?? []) { if (a.tag.startsWith('mist')) continue; items.push({ asset: prop.get(a.tag), col: a.col, row: a.row, depth: a.row - 0.1, footW: 1, footH: 1, actor: false, float: a.tag.startsWith('boat') }); }
  for (const o of scene.objects ?? []) {
    if (o.visible === false) continue;
    const actor = o.kind === 'actor';
    const asset = actor ? (char.get(o.tag) ?? char.get('villager')) : prop.get(o.tag);
    items.push({ asset, col: o.col, row: o.row, depth: o.row + (actor ? 0.5 : 0.1), footW: actor ? 1 : (o.footprint?.w ?? 1), footH: actor ? 1 : (o.footprint?.h ?? 1), actor, float: !actor && o.tag.startsWith('boat') });
  }
  items.sort((p, q) => p.depth - q.depth);
  for (const it of items) {
    const asset = it.asset; if (!asset?.art) continue;
    const png = loadPng(assetsRoot, asset.art); if (!png) continue;
    const fw = asset.frameW ?? TILE, fh = asset.frameH ?? TILE;
    const anchorY = it.actor ? (asset.anchorY ?? 1) : 1; // props anchor center-bottom; actors by anchorY
    const dstX = Math.round((it.col + it.footW / 2) * TILE - fw / 2);
    const dstY = it.float ? Math.round((it.row + 0.5) * TILE - fh / 2) // floating boats: centred on the cell
      : Math.round((it.row + it.footH) * TILE - fh * anchorY);
    blit(png, dstX, dstY, fw, fh);
  }

  // Pass 3 — ROOFS: the closed-building cover, drawn as VECTOR geometry (gradient polygon faces + hip/ridge/
  // rim lines + chimney/dormer sprites) ON TOP of walls + interior. Hidden when `showRoofs === false`.
  if (opts.showRoofs !== false) for (const rb of scene.roofs ?? []) {
    for (const f of rb.faces) fillGradPoly(out, f.pts, f.top, f.bot);
    for (const ln of rb.lines) strokeLine(out, ln.x1, ln.y1, ln.x2, ln.y2, ln.c, ln.w);
    for (const sp of rb.sprites) {
      const asset = prop.get(sp.tag); if (!asset?.art) continue;
      const png = loadPng(assetsRoot, asset.art); if (!png) continue;
      const fw = asset.frameW ?? TILE, fh = asset.frameH ?? TILE;
      blit(png, Math.round(sp.x - fw / 2), Math.round(sp.y - fh / 2), fw, fh);
    }
  }

  // TIME-OF-DAY tint — a global colour MULTIPLY matching the Phaser renderer (SceneCanvas), so headless
  // proof renders carry the same dusk/night mood. (The Phaser nicety of exempting light sources so they
  // glow is skipped here — this is a proof render, not the live game.)
  const interior = scene.grammar === 'enclosed-interior';
  // WEATHER composes with time (S3): "dusk + fog" = the dusk tint THEN the haze wash + mist on top.
  // The legacy lighting value 'fog' still means "day + fog".
  const foggy = !interior && (scene.weather === 'fog' || scene.lighting === 'fog');
  if (interior) {
    applyInteriorLighting(out, scene); // dark underground + warm torch pools + a vignette (not a flat tint)
  } else {
    const tint = scene.lighting === 'night' ? 0x7e8cc0 : scene.lighting === 'dusk' ? 0xb2b6da : 0;
    if (tint) {
      const tr = (tint >> 16) & 0xff, tg = (tint >> 8) & 0xff, tb = tint & 0xff;
      for (let i = 0; i < out.data.length; i += 4) {
        out.data[i] = Math.round(out.data[i]! * tr / 255);
        out.data[i + 1] = Math.round(out.data[i + 1]! * tg / 255);
        out.data[i + 2] = Math.round(out.data[i + 2]! * tb / 255);
      }
    }
  }
  if (foggy) {
    // FOG = desaturate toward luminance + blend toward a pale cool grey (a washed-out, low-contrast HAZE,
    // the opposite of a darkening multiply). Reads as a cold sea-fog. Kept LIGHT — the scene must stay
    // legible; the sense of "fog" comes mostly from the scattered mist wisps (a prop), not this wash.
    const FR = 178, FG = 188, FB = 198, DESAT = 0.38, A = 0.26;
    for (let i = 0; i < out.data.length; i += 4) {
      const r = out.data[i]!, g = out.data[i + 1]!, b = out.data[i + 2]!;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const dr = r + (lum - r) * DESAT, dg = g + (lum - g) * DESAT, db = b + (lum - b) * DESAT;
      out.data[i] = Math.round(dr + (FR - dr) * A);
      out.data[i + 1] = Math.round(dg + (FG - dg) * A);
      out.data[i + 2] = Math.round(db + (FB - db) * A);
    }
    // Mist CLOUDS drift ON TOP of the haze (a floating translucent decal layer), so fog reads as patchy
    // drifting mist, not just a flat wash. Blitted last, after the wash, at their own grid cells.
    for (const a of scene.ambiance ?? []) {
      if (!a.tag.startsWith('mist')) continue;
      const asset = prop.get(a.tag); if (!asset?.art) continue;
      const png = loadPng(assetsRoot, asset.art); if (!png) continue;
      const fw = asset.frameW ?? TILE, fh = asset.frameH ?? TILE;
      blit(png, Math.round((a.col + 0.5) * TILE - fw / 2), Math.round((a.row + 0.5) * TILE - fh / 2), fw, fh);
    }
  }
  return PNG.sync.write(out);
}

/** Tags that emit light (a warm pool around them) — mirrors the library `light:true` props. */
const LIGHT_TAGS = new Set(['forge', 'candelabra', 'candelabra_large', 'brazier', 'candle', 'torch_wall', 'campfire', 'bonfire', 'fire_pit', 'lantern']);
/** INTERIOR LIGHTING — an enclosed scene is DARK, lit only in warm pools around braziers/torches/forges, with
 *  an edge vignette. This is the single biggest cue that says "underground", replacing the old flat beige tint. */
function applyInteriorLighting(out: PNG, scene: SceneMap): void {
  const W = out.width, H = out.height;
  const lights: Array<{ x: number; y: number; r: number }> = [];
  const push = (col: number, row: number, r: number) => lights.push({ x: (col + 0.5) * TILE, y: (row + 0.5) * TILE, r });
  for (const o of scene.objects ?? []) if (LIGHT_TAGS.has(o.tag)) push(o.col, o.row, o.tag === 'forge' ? 108 : 84);
  for (const a of scene.ambiance ?? []) if (LIGHT_TAGS.has(a.tag)) push(a.col, a.row, 84);
  const AMBIENT = 0.30, GLOW = 1.0, WR = 255, WG = 216, WB = 150; // warm torch tone
  const cx = W / 2, cy = H / 2, maxD = Math.hypot(cx, cy) || 1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let L = AMBIENT;
    for (const li of lights) { const d = Math.hypot(x - li.x, y - li.y); if (d < li.r) { const f = 1 - d / li.r; L += GLOW * f * f; } }
    if (L > 1.25) L = 1.25;
    L *= 1 - 0.5 * (Math.hypot(x - cx, y - cy) / maxD) ** 2; // vignette
    const i = ((y * W) + x) << 2;
    const warm = Math.max(0, Math.min(0.5, (L - AMBIENT) * 0.6)); // lit → warm; dark → neutral
    out.data[i] = Math.min(255, Math.round((out.data[i]! * (1 - warm) + WR * warm) * L));
    out.data[i + 1] = Math.min(255, Math.round((out.data[i + 1]! * (1 - warm) + WG * warm) * L));
    out.data[i + 2] = Math.min(255, Math.round((out.data[i + 2]! * (1 - warm) + WB * warm) * L));
  }
}
