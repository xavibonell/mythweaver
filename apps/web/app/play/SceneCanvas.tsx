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
 *  (trees, cottages) with a 1-tile base overhang upward. Returns the created object (or null). */
function drawProp(scene: any, tag: string, col: number, row: number, footW: number, footH: number, depth: number, tint: number | null): any {
  const art = PROP_ART[tag];
  if (!art) {
    if (typeof console !== 'undefined') console.warn(`[renderer] no prop art for '${tag}'`);
    return null;
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
  return obj;
}

/**
 * INCREMENTAL scene deltas (Contract 4 → the renderer): moves become ~300ms tweens, spawns pop in,
 * reveals/hides toggle visibility — with NO full rebuild (the terrain RenderTexture survives).
 * `scene.lastData` (the client's copy of the frozen map) is mutated in LOCKSTEP so a later full
 * render doesn't snap tokens back. Idempotent-ish: re-applying after a full render is harmless.
 */
function applyDeltasImpl(scene: any, deltas: any[]): void {
  const data = scene.lastData;
  if (!data) return;
  const interior = data.grammar === 'enclosed-interior';
  const tint = interior ? null : data.lighting === 'night' ? 0x7e8cc0 : data.lighting === 'dusk' ? 0xb2b6da : null;
  const record = (id: string) => (data.objects ?? []).find((o: any) => o.id === id);
  for (const d of deltas ?? []) {
    if (d.op === 'move' && d.to && Number.isInteger(d.to.col)) {
      const rec = record(d.id);
      if (rec) { rec.col = d.to.col; rec.row = d.to.row; }
      const a = scene.actorObjs.get(d.id);
      if (a) {
        const { x, y } = actorXY(d.to.col, d.to.row);
        a.col = d.to.col; a.row = d.to.row;
        scene.tweens.add({ targets: a.container, x, y, duration: 300, ease: 'Sine.easeInOut', onComplete: () => a.container.setDepth(d.to.row + 0.5) });
      } else {
        const p = scene.propObjs?.get(d.id);
        if (p) {
          const footW = p.footW ?? 1, footH = p.footH ?? 1;
          const x = (d.to.col + footW / 2) * TILE, y = (d.to.row + footH) * TILE;
          scene.tweens.add({ targets: p.obj, x, y, duration: 300, ease: 'Sine.easeInOut', onComplete: () => p.obj.setDepth(d.to.row + 0.1) });
        }
      }
    } else if (d.op === 'face') {
      const rec = record(d.id);
      if (rec) rec.facing = d.facing;
      const a = scene.actorObjs.get(d.id);
      if (a) a.sprite.setFlipX(d.facing === 'left');
    } else if (d.op === 'reveal') {
      const rec = record(d.id);
      if (rec) rec.visible = true;
      const a = scene.actorObjs.get(d.id);
      const p = scene.propObjs?.get(d.id);
      if (a) a.container.setVisible(true);
      else if (p) p.obj.setVisible(true);
      else if (rec) {
        // It was never drawn (hidden at render time) — create it now.
        if (rec.kind === 'actor') createActor(scene, rec, tint);
        else {
          const obj = drawProp(scene, rec.tag, rec.col, rec.row, rec.footprint?.w ?? 1, rec.footprint?.h ?? 1, rec.row + 0.1, tint);
          if (obj) scene.propObjs?.set(rec.id, { obj, footW: rec.footprint?.w ?? 1, footH: rec.footprint?.h ?? 1 });
        }
      }
    } else if (d.op === 'hide') {
      const rec = record(d.id);
      if (rec) rec.visible = false;
      scene.actorObjs.get(d.id)?.container.setVisible(false);
      scene.propObjs?.get(d.id)?.obj.setVisible(false);
    } else if (d.op === 'spawn' && d.at) {
      if (scene.actorObjs.has(d.id) || scene.propObjs?.has(d.id)) continue; // already present (full render beat us)
      if (!record(d.id)) (data.objects ??= []).push({ id: d.id, kind: d.kind, ...(d.role ? { role: d.role } : {}), tag: d.tag, ...(d.name ? { name: d.name } : {}), col: d.at.col, row: d.at.row, footprint: { w: 1, h: 1 }, facing: 'down', visible: d.visible !== false });
      if (d.visible === false) continue; // present but hidden — drawn on reveal
      if (d.kind === 'actor') {
        createActor(scene, { id: d.id, tag: d.tag, col: d.at.col, row: d.at.row, facing: 'down' }, tint);
        const a = scene.actorObjs.get(d.id);
        if (a) { a.container.setAlpha(0); scene.tweens.add({ targets: a.container, alpha: 1, duration: 250 }); } // pop-in
      } else {
        const obj = drawProp(scene, d.tag, d.at.col, d.at.row, 1, 1, d.at.row + 0.1, tint);
        if (obj) scene.propObjs?.set(d.id, { obj, footW: 1, footH: 1 });
      }
    } else if (d.op === 'despawn') {
      const idx = (data.objects ?? []).findIndex((o: any) => o.id === d.id);
      if (idx >= 0) data.objects.splice(idx, 1);
      const a = scene.actorObjs.get(d.id);
      if (a) { scene.tweens.add({ targets: a.container, alpha: 0, duration: 250, onComplete: () => a.container.destroy() }); scene.actorObjs.delete(d.id); }
      const p = scene.propObjs?.get(d.id);
      if (p) { p.obj.destroy(); scene.propObjs.delete(d.id); }
    } else if (d.op === 'setState') {
      const rec = record(d.id);
      if (rec) rec.state = { ...(rec.state ?? {}), ...d.state }; // data-only in v1 (no visual treatment yet)
    }
  }
}

/** Full rebuild: terrain + props + actors + lighting + camera. */
function renderFullImpl(scene: any, data: any): void {
  if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') (window as any).__mwScene = scene; // dev hook: inspect the live scene (anims/objects) from the console
  for (const o of scene.sceneObjs ?? []) o.destroy();
  scene.sceneObjs = [];
  scene.actorObjs = new Map();
  scene.propObjs = new Map(); // id-addressed props/fixtures (the delta path repositions/toggles them)
  scene.lastData = data;

  // Lighting = a per-object color multiply (tint), NOT a flat overlay, so name labels stay
  // readable and light sources keep glowing. Interiors are torch-lit (warm, never the cold-blue
  // moonlight that turns a crypt's grey stone into invisible navy), and every tint is kept light
  // enough that detail survives — a dim scene must still be legible.
  // Interiors are lit by a DARKNESS + torch-pool overlay (see the interior block below), so their objects draw
  // at full brightness (tint = null) and the overlay does the mood. Outdoors keep the per-object dusk/night tint.
  const interior = data.grammar === 'enclosed-interior';
  const tint = interior ? null
    : data.lighting === 'night' ? 0x7e8cc0
      : data.lighting === 'dusk' ? 0xb2b6da
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
    else {
      const obj = drawProp(scene, o.tag, o.col, o.row, o.footprint?.w ?? 1, o.footprint?.h ?? 1, o.row + 0.1, tint);
      if (obj) scene.propObjs.set(o.id, { obj, footW: o.footprint?.w ?? 1, footH: o.footprint?.h ?? 1 });
    }
  }

  // ROOFS — the closed-building cover as VECTOR geometry (gradient polygon faces + hip/ridge/rim lines +
  // chimney/dormer sprites), drawn ABOVE walls/props so a player sees only rooftops. Hidden when the operator
  // flips the lab switch (or a building is revealed in play). Depth 90000 sits above every row-depth object,
  // below the fog wash. Colours are multiplied by the day/night tint.
  if (scene.showRoofs !== false && (data.roofs?.length ?? 0) > 0) {
    const lit = (c: number): number => {
      if (!tint) return c;
      const tr = (tint >> 16) & 0xff, tg = (tint >> 8) & 0xff, tb = tint & 0xff;
      return (Math.round(((c >> 16) & 0xff) * tr / 255) << 16) | (Math.round(((c >> 8) & 0xff) * tg / 255) << 8) | Math.round((c & 0xff) * tb / 255);
    };
    const g = scene.add.graphics().setDepth(90000);
    for (const rb of data.roofs) {
      for (const f of rb.faces) {
        const top = lit(f.top), bot = lit(f.bot);
        g.fillGradientStyle(top, top, bot, bot, 1);
        const pts: { x: number; y: number }[] = [];
        for (let i = 0; i < f.pts.length; i += 2) pts.push({ x: f.pts[i], y: f.pts[i + 1] });
        g.fillPoints(pts, true);
      }
      for (const ln of rb.lines) { g.lineStyle(ln.w, lit(ln.c), 1); g.lineBetween(ln.x1, ln.y1, ln.x2, ln.y2); }
    }
    scene.sceneObjs.push(g);
    for (const rb of data.roofs) for (const sp of rb.sprites) {
      if (!PROP_ART[sp.tag]) continue;
      const img = scene.add.image(sp.x, sp.y, `prop_${sp.tag}`).setOrigin(0.5, 0.5).setDepth(90001);
      if (tint) img.setTint(tint);
      scene.sceneObjs.push(img);
    }
  }

  // INTERIOR LIGHTING — an enclosed scene is DARK (a multiply overlay) lit only in warm ADDITIVE pools around
  // braziers/torches/forges: the single biggest "this is underground" cue. Mirrors the headless renderer.
  if (interior) {
    const W = cols * TILE, H = rows * TILE;
    const dark = scene.add.rectangle(0, 0, W, H, 0x4a4236).setOrigin(0, 0).setDepth(95000);
    dark.setBlendMode(scene.BLEND?.MULTIPLY ?? 2);
    scene.sceneObjs.push(dark);
    const LIGHT_TAGS = new Set(['forge', 'candelabra', 'candelabra_large', 'brazier', 'candle', 'torch_wall', 'campfire', 'bonfire', 'fire_pit', 'lantern']);
    if (PROP_ART['light_pool']) for (const o of [...(data.objects ?? []), ...(data.ambiance ?? [])]) {
      if (!LIGHT_TAGS.has(o.tag) || o.visible === false) continue;
      const dia = o.tag === 'forge' ? 220 : 170;
      const pool = scene.add.image((o.col + 0.5) * TILE, (o.row + 0.5) * TILE, 'prop_light_pool').setDepth(95001).setDisplaySize(dia, dia);
      pool.setBlendMode(scene.BLEND?.ADD ?? 1);
      scene.sceneObjs.push(pool);
    }
  }

  // FOG = a LIGHT pale haze laid over the WHOLE scene (a soft overlay, NOT a darkening multiply tint) —
  // reads as a cold sea-fog. Kept light so the scene stays legible; the real sense of fog comes from the
  // scattered mist CLOUDS (`mist_*`) drifting above the scene — drawn on TOP of the thin wash so they read
  // as visible, translucent drifting cloud. WEATHER composes with time (S3): dusk tint + fog wash coexist;
  // the legacy lighting value 'fog' still means "day + fog".
  if (!interior && (data.weather === 'fog' || data.lighting === 'fog')) {
    const wash = scene.add.rectangle(0, 0, cols * TILE, rows * TILE, 0xb2bcc6, 0.24).setOrigin(0, 0).setDepth(100000);
    scene.sceneObjs.push(wash);
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
 *  `freeCamera` (Lab) enables drag-pan + wheel-zoom; bumping `fitNonce` re-frames the whole scene.
 *  INCREMENTAL updates: bump `deltaNonce` with a fresh `deltas` array to tween tokens (move/spawn/
 *  reveal/…) without a full rebuild — pass a NEW `data` reference only when the location changes. */
export default function SceneCanvas({ data, freeCamera = false, fitNonce = 0, showRoofs = true, deltas = null, deltaNonce = 0 }: { data: any; freeCamera?: boolean; fitNonce?: number; showRoofs?: boolean; deltas?: any[] | null; deltaNonce?: number }) {
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
            scene.BLEND = Phaser.BlendModes; // ADD/MULTIPLY for the interior torch-pool lighting
            ensureAnims(scene);
            scene.renderFull = (d: any) => renderFullImpl(scene, d);
            scene.applyDeltas = (ds: any[]) => applyDeltasImpl(scene, ds);
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
              scene.showRoofs = bridge.pendingShowRoofs ?? true;
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

  // Re-render whenever the SceneMap OR the roofs toggle changes (queue it if Phaser isn't ready yet).
  useEffect(() => {
    if (!data) return;
    const b = bridgeRef.current;
    if (b.scene) { b.scene.showRoofs = showRoofs; b.scene.renderFull(data); }
    else { b.pending = data; b.pendingShowRoofs = showRoofs; }
  }, [data, showRoofs]);

  // "Fit/Reset" — the Lab bumps fitNonce to re-frame the whole scene after free-panning/zooming.
  useEffect(() => {
    if (fitNonce) bridgeRef.current.scene?.fit?.();
  }, [fitNonce]);

  // Incremental deltas: tween tokens on the LIVE scene (no rebuild). Fired by bumping deltaNonce.
  useEffect(() => {
    if (deltaNonce && deltas?.length) bridgeRef.current.scene?.applyDeltas?.(deltas);
  }, [deltaNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={containerRef} style={{ width: '100%', height: '100%', background: '#0d0b0a' }} />;
}
