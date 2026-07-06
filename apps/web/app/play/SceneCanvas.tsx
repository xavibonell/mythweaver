'use client';

/**
 * SceneCanvas — the shared Phaser renderer for a frozen SceneMap. Used by both the live
 * session (/play) and the Scene Lab (/lab). Boots Phaser once, fills the art tables from the
 * server's asset library (assets/library.json, fetched), and re-renders whenever `data` changes.
 * Draws the per-cell terrain, the object_map (fixtures/props as art, actors as sprites, hidden
 * objects skipped), seed-scattered ambiance, and a dusk/night tint. Art resolves by tag.
 */

import { useEffect, useRef } from 'react';
import { TILE, MAX_ZOOM, TERRAIN_SRCS, PROP_ART, SPRITES, DEFAULT_SPRITE, terrainTileVariant, loadAssetLibrary } from './manifest';

const SERVER = process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://localhost:6984';

/* eslint-disable @typescript-eslint/no-explicit-any */

// --- Phaser asset loading + draw helpers (operate on the live scene) ---

function preloadAssets(scene: any): void {
  // Terrain tiles are individual images, keyed by their src path.
  for (const srcs of Object.values(TERRAIN_SRCS)) for (const src of srcs) if (!scene.textures.exists(src)) scene.load.image(src, src);
  for (const [tag, p] of Object.entries(PROP_ART)) {
    if (p.frames > 1) scene.load.spritesheet(`prop_${tag}`, p.src, { frameWidth: p.frameW, frameHeight: p.frameH });
    else scene.load.image(`prop_${tag}`, p.src);
  }
  for (const [tag, s] of Object.entries(SPRITES)) scene.load.spritesheet(tag, s.src, { frameWidth: s.frameW, frameHeight: s.frameH });
}

function ensureAnims(scene: any): void {
  for (const [tag, s] of Object.entries(SPRITES)) {
    const k = `${tag}-idle`;
    if (!scene.anims.exists(k)) scene.anims.create({ key: k, frames: scene.anims.generateFrameNumbers(tag, { start: 0, end: s.idleFrames - 1 }), frameRate: s.fps, repeat: -1 });
  }
  for (const [tag, p] of Object.entries(PROP_ART)) {
    if (p.frames <= 1) continue;
    const k = `prop_${tag}-anim`;
    if (!scene.anims.exists(k)) scene.anims.create({ key: k, frames: scene.anims.generateFrameNumbers(`prop_${tag}`, { start: 0, end: p.frames - 1 }), frameRate: p.fps, repeat: -1 });
  }
}

function actorXY(col: number, row: number): { x: number; y: number } {
  return { x: (col + 0.5) * TILE, y: (row + 1) * TILE }; // feet at the tile's bottom edge
}

function createActor(scene: any, a: any, tint: number | null): void {
  if (!SPRITES[a.tag] && typeof console !== 'undefined') console.warn(`[renderer] no sprite for '${a.tag}', using ${DEFAULT_SPRITE}`);
  const tag = SPRITES[a.tag] ? a.tag : DEFAULT_SPRITE;
  const sd = SPRITES[tag]!;
  // Native scale (the character art is ~30px tall in every sheet); the feet anchor handles
  // sheets with empty space below the character (e.g. the 64px villager: feet at 0.73).
  const { x, y } = actorXY(a.col, a.row);
  const container = scene.add.container(x, y);
  const shadow = scene.add.ellipse(0, 0, TILE * 0.8, 5, 0x000000, 0.3);
  const sprite = scene.add.sprite(0, 0, tag).setOrigin(0.5, sd.anchorY ?? 1);
  sprite.play(`${tag}-idle`);
  if (tint) sprite.setTint(tint); // dusk/night mood; labels stay untinted + readable
  if (a.facing === 'left') sprite.setFlipX(true);
  // No name labels — keep the screen clean (names were noise; identity lives in the SceneMap).
  container.add([shadow, sprite]);
  container.setDepth(a.row + 0.5); // actors sort above same-row props
  scene.actorObjs.set(a.id, { container, sprite, col: a.col, row: a.row });
  scene.sceneObjs.push(container);
}

/** Draw a static/animated prop (declared fixture, prop, or seed ambiance), anchored at the bottom
 *  of its footprint so flat multi-tile props (a 2x2 fountain) sit on their ground, while tall props
 *  (trees, cottages) with a 1-tile base overhang upward. */
function drawProp(scene: any, tag: string, col: number, row: number, footW: number, footH: number, depth: number, tint: number | null): void {
  const art = PROP_ART[tag];
  if (!art) {
    if (typeof console !== 'undefined') console.warn(`[renderer] no prop art for '${tag}'`);
    return;
  }
  // A boat lies ON the water: CENTRE it on its cell (it isn't "standing" on the ground), so a boat moored
  // alongside a pier floats in the water instead of extending up onto the planks. Everything else is feet-bottom.
  const float = tag.startsWith('boat');
  const x = (col + footW / 2) * TILE; // center on the footprint, not the origin tile
  const y = float ? (row + 0.5) * TILE : (row + footH) * TILE; // boats centred; else feet at the footprint bottom
  const originY = float ? 0.5 : 1;
  const key = `prop_${tag}`;
  const obj = art.frames > 1 ? scene.add.sprite(x, y, key).setOrigin(0.5, originY) : scene.add.image(x, y, key).setOrigin(0.5, originY);
  if (art.frames > 1) obj.play(`prop_${tag}-anim`);
  if (tint && !art.light) obj.setTint(tint); // light sources keep their glow under a night tint
  obj.setDepth(depth);
  scene.sceneObjs.push(obj);
}

/** Full rebuild: terrain + props + actors + lighting + camera. */
function renderFullImpl(scene: any, data: any): void {
  if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') (window as any).__mwScene = scene; // dev hook: inspect the live scene (anims/objects) from the console
  for (const o of scene.sceneObjs ?? []) o.destroy();
  scene.sceneObjs = [];
  scene.actorObjs = new Map();
  scene.lastData = data;

  // Lighting = a per-object color multiply (tint), NOT a flat overlay, so name labels stay
  // readable and light sources keep glowing. Interiors are torch-lit (warm, never the cold-blue
  // moonlight that turns a crypt's grey stone into invisible navy), and every tint is kept light
  // enough that detail survives — a dim scene must still be legible.
  const interior = data.grammar === 'enclosed-interior';
  const tint =
    data.lighting === 'night'
      ? interior
        ? 0xc2a886 // warm torchlight
        : 0x7e8cc0 // cool moonlight
      : data.lighting === 'dusk'
        ? interior
          ? 0xd2c0a0
          : 0xb2b6da
        : null;

  const { rows, cols } = data.grid;
  // Terrain is baked into ONE RenderTexture (a single Game Object / draw call) instead of cols×rows
  // individual Images — so a city-scale grid (10k+ tiles) renders without thousands of objects. The
  // per-scene tint multiplies the whole texture (cheap per-tile retint isn't needed; lighting is
  // fixed per scene). batchDraw stamps each 16×16 tile at its grid position.
  const terrainRT = scene.add.renderTexture(0, 0, cols * TILE, rows * TILE).setOrigin(0, 0).setDepth(-10000);
  terrainRT.beginDraw();
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const key = terrainTileVariant(data.tiles?.[r]?.[c] ?? 'grass', c, r, data.seed ?? 0); // texture key = art src path
      if (key) terrainRT.batchDraw(key, c * TILE, r * TILE);
    }
  terrainRT.endDraw();
  if (tint) terrainRT.setTint(tint);
  scene.sceneObjs.push(terrainRT);

  // Seed-scattered ambiance (decor) sits just behind the placed objects on its row. Mist CLOUDS (`mist_*`)
  // are drawn separately as a top layer (see the fog block below), so they drift OVER the scene, not behind props.
  for (const a of data.ambiance ?? []) if (!a.tag.startsWith('mist')) drawProp(scene, a.tag, a.col, a.row, 1, 1, a.row - 0.1, tint);

  // The object_map: fixtures/props are drawn as art; actors as sprites. Hidden objects are NOT drawn.
  for (const o of data.objects ?? []) {
    if (o.visible === false) continue;
    if (o.kind === 'actor') createActor(scene, o, tint);
    else drawProp(scene, o.tag, o.col, o.row, o.footprint?.w ?? 1, o.footprint?.h ?? 1, o.row + 0.1, tint);
  }

  // FOG = a LIGHT pale haze laid over the WHOLE scene (a soft overlay, NOT a darkening multiply tint) —
  // reads as a cold sea-fog. Kept light so the scene stays legible; the real sense of fog comes from the
  // scattered mist CLOUDS (`mist_*`) drifting above the scene — drawn on TOP of the thin wash so they read
  // as visible, translucent drifting cloud.
  if (data.lighting === 'fog') {
    scene.add.rectangle(0, 0, cols * TILE, rows * TILE, 0xb2bcc6, 0.24).setOrigin(0, 0).setDepth(100000);
    for (const a of data.ambiance ?? []) if (a.tag.startsWith('mist')) drawProp(scene, a.tag, a.col, a.row, 1, 1, 100001 + a.row * 0.001, null);
  }

  fitCamera(scene, data);
}

/**
 * The world bounding box INCLUDING tall/wide sprite overhang. Props are base-anchored, so a
 * 160px tree rises ~9 tiles above its base and a 144px-wide tree bleeds sideways past its
 * footprint; the camera must frame all of that or it clips. Measured from real art, not a guess.
 */
function worldBox(data: any): { x: number; y: number; w: number; h: number } {
  const gw = data.grid.cols * TILE;
  const gh = data.grid.rows * TILE;
  let minX = 0;
  let minY = 0;
  let maxX = gw;
  let maxY = gh;
  const consider = (tag: string, col: number, row: number, footW: number, footH: number) => {
    const art = PROP_ART[tag];
    if (!art) return;
    const cx = (col + footW / 2) * TILE; // sprite is centered on its footprint
    const baseY = (row + footH) * TILE; // feet at the bottom of the footprint
    minX = Math.min(minX, cx - art.frameW / 2);
    maxX = Math.max(maxX, cx + art.frameW / 2);
    minY = Math.min(minY, baseY - art.frameH); // canopy rises above the base
  };
  for (const o of data.objects ?? []) if (o.visible !== false && o.kind !== 'actor') consider(o.tag, o.col, o.row, o.footprint?.w ?? 1, o.footprint?.h ?? 1);
  for (const a of data.ambiance ?? []) consider(a.tag, a.col, a.row, 1, 1);
  const m = TILE; // a little breathing room (also covers short actor sprites)
  return { x: minX - m, y: minY - m, w: maxX - minX + 2 * m, h: maxY - minY + 2 * m };
}

function fitCamera(scene: any, data: any): void {
  const cw = scene.scale.width;
  const ch = scene.scale.height;
  const box = worldBox(data);
  // ONE box drives both axes — no asymmetric top-only padding, so the scene fills the canvas
  // without a black band, and tall/wide sprites stay inside the frame instead of clipping.
  const zoom = Math.min(cw / box.w, ch / box.h, MAX_ZOOM);
  const cam = scene.cameras.main;
  scene.fitZoom = zoom > 0 ? zoom : 1; // floor for the free-camera wheel-out (can't shrink past the whole scene)
  cam.setBounds(box.x, box.y, box.w, box.h); // clamp panning to the world bounds
  cam.setZoom(scene.fitZoom);
  cam.centerOn(box.x + box.w / 2, box.y + box.h / 2);
}

interface Bridge {
  scene: any;
  pending: any;
  game: any;
}

/** A self-contained Phaser surface that renders the SceneMap passed as `data` (null = nothing yet).
 *  `freeCamera` (Lab) enables drag-pan + wheel-zoom; bumping `fitNonce` re-frames the whole scene. */
export default function SceneCanvas({ data, freeCamera = false, fitNonce = 0 }: { data: any; freeCamera?: boolean; fitNonce?: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bridgeRef = useRef<Bridge>({ scene: null, pending: null, game: null });

  useEffect(() => {
    let cancelled = false;
    const bridge = bridgeRef.current;
    (async () => {
      const Phaser: any = await import('phaser');
      await loadAssetLibrary(SERVER); // fill art tables BEFORE Phaser preloads
      if (cancelled || !containerRef.current) return;
      bridge.game = new Phaser.Game({
        type: Phaser.AUTO,
        parent: containerRef.current,
        width: 1024,
        height: 576,
        backgroundColor: '#0d0b0a',
        pixelArt: true,
        roundPixels: true,
        render: { preserveDrawingBuffer: true }, // keep the WebGL buffer so canvas.toDataURL() captures real pixels (visual-judge pipeline)
        loader: { maxParallelDownloads: 256 }, // load all tiles in one batch (Phaser refill stalls otherwise)
        scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
        scene: {
          preload(this: any) {
            preloadAssets(this);
          },
          create(this: any) {
            const scene = this;
            scene.sceneObjs = [];
            scene.actorObjs = new Map();
            ensureAnims(scene);
            scene.renderFull = (d: any) => renderFullImpl(scene, d);
            scene.fit = () => { if (scene.lastData) fitCamera(scene, scene.lastData); };
            // /play keeps auto-fit on resize; the Lab free-camera leaves the tester's view alone.
            scene.scale.on('resize', () => { if (!freeCamera && scene.lastData) fitCamera(scene, scene.lastData); });
            if (freeCamera) {
              // LAB-ONLY: drag to pan, wheel to zoom toward the cursor (clamped to [fit .. LAB_MAX_ZOOM],
              // pan clamped to world bounds via fitCamera's setBounds). Lets the tester inspect a big scene.
              const LAB_MAX_ZOOM = 3; // cap — one building fills the view; no pixel-peeping past this
              const cam = scene.cameras.main;
              scene.input.on('pointermove', (p: any) => {
                if (!p.isDown) return;
                cam.scrollX -= (p.x - p.prevPosition.x) / cam.zoom;
                cam.scrollY -= (p.y - p.prevPosition.y) / cam.zoom;
              });
              scene.input.on('wheel', (p: any, _over: any, _dx: number, dy: number) => {
                const before = cam.getWorldPoint(p.x, p.y);
                const factor = dy > 0 ? 0.85 : 1.18;
                cam.setZoom(Math.min(LAB_MAX_ZOOM, Math.max(scene.fitZoom ?? 0.2, cam.zoom * factor)));
                const after = cam.getWorldPoint(p.x, p.y);
                cam.scrollX += before.x - after.x;
                cam.scrollY += before.y - after.y;
              });
            }
            bridge.scene = scene;
            if (bridge.pending) {
              scene.renderFull(bridge.pending);
              bridge.pending = null;
            }
          },
        },
      });
      // Expose a real pixel capture for the visual-judge pipeline. Phaser's renderer.snapshot() reads the
      // framebuffer reliably (canvas.toDataURL() returns black on the WebGL canvas), giving the PNG the judge scores.
      (window as unknown as { __captureScene?: () => Promise<string> }).__captureScene = () =>
        new Promise((resolve) => { const g = bridge.game; if (!g) return resolve(''); g.renderer.snapshot((img: HTMLImageElement) => resolve(img.src)); });
    })();
    return () => {
      cancelled = true;
      bridge.scene = null;
      bridge.game?.destroy(true);
      bridge.game = null;
    };
  }, []);

  // Re-render whenever the SceneMap changes (queue it if Phaser isn't ready yet).
  useEffect(() => {
    if (!data) return;
    const b = bridgeRef.current;
    if (b.scene) b.scene.renderFull(data);
    else b.pending = data;
  }, [data]);

  // "Fit/Reset" — the Lab bumps fitNonce to re-frame the whole scene after free-panning/zooming.
  useEffect(() => {
    if (fitNonce) bridgeRef.current.scene?.fit?.();
  }, [fitNonce]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%', background: '#0d0b0a' }} />;
}
