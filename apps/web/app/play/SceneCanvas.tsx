'use client';

/**
 * SceneCanvas — the shared Phaser renderer for a frozen SceneMap. Used by both the live
 * session (/play) and the Scene Lab (/lab). Boots Phaser once, fills the art tables from the
 * server's asset library (assets/library.json, fetched), and re-renders whenever `data` changes.
 * Draws the per-cell terrain, the object_map (fixtures/props as art, actors as sprites, hidden
 * objects skipped), seed-scattered ambiance, and a dusk/night tint. Art resolves by tag.
 */

import { useEffect, useRef } from 'react';
import { TILE, MAX_ZOOM, PROP_ART, SPRITES, DEFAULT_SPRITE, terrainSrcs, terrainTileVariant, loadAssetLibrary } from './manifest';

const SERVER = process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://localhost:6984';

/* eslint-disable @typescript-eslint/no-explicit-any */

// --- Phaser asset loading + draw helpers (operate on the live scene) ---
//
// The library now contains 1,800+ assets. Preloading the WHOLE catalog made Phaser sit on a black
// canvas for minutes (and could stall entirely). Queue only the tags the current SceneMap needs;
// later scene snapshots and spawn deltas lazily load any newly introduced art before rendering.

function queueTexture(scene: any, key: string, load: () => void): number {
  scene.queuedAssetKeys ??= new Set<string>();
  if (scene.textures.exists(key) || scene.queuedAssetKeys.has(key)) return 0;
  scene.queuedAssetKeys.add(key);
  load();
  return 1;
}

function queueTerrain(scene: any, tag: string): number {
  let n = 0;
  for (const src of terrainSrcs(tag)) n += queueTexture(scene, src, () => scene.load.image(src, src));
  return n;
}

function queueProp(scene: any, tag: string): number {
  const p = PROP_ART[tag];
  if (!p) return 0;
  const key = `prop_${tag}`;
  return queueTexture(scene, key, () => {
    if (p.frames > 1) scene.load.spritesheet(key, p.src, { frameWidth: p.frameW, frameHeight: p.frameH });
    else scene.load.image(key, p.src);
  });
}

function queueCharacter(scene: any, requestedTag: string): number {
  const tag = SPRITES[requestedTag] ? requestedTag : DEFAULT_SPRITE;
  const s = SPRITES[tag];
  if (!s) return 0;
  return queueTexture(scene, tag, () => scene.load.spritesheet(tag, s.src, { frameWidth: s.frameW, frameHeight: s.frameH }));
}

function queueSceneAssets(scene: any, data: any): number {
  let n = 0;
  const terrainTags = new Set<string>((data.tiles ?? []).flat());
  for (const tag of terrainTags) n += queueTerrain(scene, tag);
  for (const o of data.objects ?? []) n += o.kind === 'actor' ? queueCharacter(scene, o.tag) : queueProp(scene, o.tag);
  for (const a of data.ambiance ?? []) n += queueProp(scene, a.tag);
  for (const roof of data.roofs ?? []) for (const s of roof.sprites ?? []) n += queueProp(scene, s.tag);
  n += queueProp(scene, 'light_pool'); // used by interior light sources when present
  n += queueCharacter(scene, DEFAULT_SPRITE);
  return n;
}

function queueDeltaAssets(scene: any, deltas: any[]): number {
  let n = 0;
  for (const d of deltas ?? []) {
    if (d.op !== 'spawn' || !d.tag) continue;
    n += d.kind === 'actor' ? queueCharacter(scene, d.tag) : queueProp(scene, d.tag);
  }
  return n;
}

function afterAssetsLoaded(scene: any, queue: () => number, done: () => void): void {
  const queued = queue();
  if (scene.load.isLoading()) {
    scene.load.once('complete', () => afterAssetsLoaded(scene, queue, done));
    return;
  }
  if (!queued) {
    ensureAnims(scene);
    done();
    return;
  }
  scene.load.once('complete', () => {
    ensureAnims(scene);
    done();
  });
  scene.load.start();
}

function ensureAnims(scene: any): void {
  for (const [tag, s] of Object.entries(SPRITES)) {
    if (!scene.textures.exists(tag)) continue;
    const k = `${tag}-idle`;
    if (!scene.anims.exists(k)) scene.anims.create({ key: k, frames: scene.anims.generateFrameNumbers(tag, { start: 0, end: s.idleFrames - 1 }), frameRate: s.fps, repeat: -1 });
  }
  for (const [tag, p] of Object.entries(PROP_ART)) {
    if (p.frames <= 1) continue;
    if (!scene.textures.exists(`prop_${tag}`)) continue;
    const k = `prop_${tag}-anim`;
    if (!scene.anims.exists(k)) scene.anims.create({ key: k, frames: scene.anims.generateFrameNumbers(`prop_${tag}`, { start: 0, end: p.frames - 1 }), frameRate: p.fps, repeat: -1 });
  }
}

function actorXY(col: number, row: number): { x: number; y: number } {
  return { x: (col + 0.5) * TILE, y: (row + 1) * TILE }; // feet at the tile's bottom edge
}

// PLAYER VIEW (the live table's around-the-party experience): distinct ring colours per PC, in
// join order — stable for a whole session because actorObjs insertion follows the object_map.
const PC_RING_COLORS = [0x57d98a, 0x5aa9ff, 0xffc14d, 0xff7d9c, 0xb08cff, 0x6ee7d8];
function pcRingColor(scene: any, id: string): number {
  scene.pcColors ??= new Map();
  if (!scene.pcColors.has(id)) scene.pcColors.set(id, PC_RING_COLORS[scene.pcColors.size % PC_RING_COLORS.length]);
  return scene.pcColors.get(id);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

/** UI labels (name-tags, story pings) live in a real DOM overlay ABOVE the pixel-art canvas — NOT as
 *  Phaser Text. Canvas text inherits the game's pixelArt (NEAREST) filter and looks chunky at any
 *  zoom; browser-rendered HTML is crisp, antialiased, sized in CSS px, and readable. Each label is
 *  anchored to a WORLD point and re-projected to screen every frame by updateDomLabels(). */
function ensureOverlay(scene: any): HTMLElement | null {
  if (scene.domOverlay) return scene.domOverlay;
  const parent = scene.game?.canvas?.parentNode as HTMLElement | null;
  if (!parent) return null;
  const el = document.createElement('div');
  el.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;overflow:hidden;z-index:3;';
  parent.appendChild(el);
  scene.domOverlay = el;
  scene.domLabels = [];
  return el;
}
function domLabel(scene: any, str: string, accent: number, wx: number, wy: number): any {
  const overlay = ensureOverlay(scene);
  if (!overlay) return null;
  const hex = '#' + (accent & 0xffffff).toString(16).padStart(6, '0');
  const el = document.createElement('div');
  el.style.cssText =
    'position:absolute;left:0;top:0;will-change:transform;white-space:nowrap;display:flex;align-items:center;gap:7px;' +
    `padding:5px 12px;border-radius:9px;background:rgba(17,19,25,0.95);border:1.5px solid ${hex};` +
    'color:#f6eedd;font:600 16px/1.15 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;' +
    'letter-spacing:0.01em;box-shadow:0 2px 12px rgba(0,0,0,0.55);opacity:0;transition:opacity 150ms ease;';
  el.innerHTML = `<span style="width:9px;height:9px;border-radius:50%;background:${hex};flex:0 0 auto"></span><span>${escapeHtml(str)}</span>`;
  overlay.appendChild(el);
  const rec = { el, wx, wy };
  scene.domLabels.push(rec);
  requestAnimationFrame(() => { el.style.opacity = '1'; });
  return rec;
}
function removeDomLabel(scene: any, rec: any): void {
  if (!rec) return;
  rec.el?.remove();
  if (scene.domLabels) scene.domLabels = scene.domLabels.filter((r: any) => r !== rec);
}
/** Re-project every DOM label from its world anchor to a screen position over the canvas. Runs each
 *  frame (scene.update) so labels track the camera and any tweening/panning. */
function updateDomLabels(scene: any): void {
  const labels = scene.domLabels;
  if (!labels?.length) return;
  const canvas = scene.game?.canvas;
  if (!canvas) return;
  const cam = scene.cameras.main;
  const kx = canvas.clientWidth / canvas.width, ky = canvas.clientHeight / canvas.height;
  const ox = canvas.offsetLeft, oy = canvas.offsetTop, wv = cam.worldView;
  for (const rec of labels) {
    const sx = ox + (rec.wx - wv.x) * cam.zoom * kx;
    const sy = oy + (rec.wy - wv.y) * cam.zoom * ky;
    rec.el.style.transform = `translate(${sx}px,${sy}px) translate(-50%,-118%)`; // centred, floating above the anchor
  }
}
function clearDomLabels(scene: any): void {
  if (scene.domLabels) for (const r of scene.domLabels) r.el?.remove();
  scene.domLabels = [];
  scene.nameTag = null;
}

/** The hover name-tag (player view): one crisp DOM plaque above the head, replaced on each hover. */
function showNameTag(scene: any, x: number, headY: number, label: string, accent: number): void {
  hideNameTag(scene);
  scene.nameTag = domLabel(scene, label, accent, x, headY);
}
function hideNameTag(scene: any): void {
  if (scene.nameTag) { removeDomLabel(scene, scene.nameTag); scene.nameTag = null; }
}

/** "a drowned corpse", "a stone weir" — the player's right to know what a sprite IS. */
function identifyLabel(o: { name?: string; tag: string; role?: string }): string {
  const name = o.name?.trim();
  // A PROPER name (has a capital, no slug underscores) shows verbatim — "Mother Sedge". A slug like
  // "anchor_ring" / "weir1" is a filename, not a name → fall through to the common-noun form.
  if (name && /[A-Z]/.test(name) && !/_/.test(name)) return name;
  const src = name && !/[_\d]/.test(name) ? name : o.tag; // a clean lowercase name ("nets") is fine too
  const words = src.replace(/[_-]+/g, ' ').replace(/\d+/g, '').replace(/\s+/g, ' ').trim();
  return /^[aeiou]/i.test(words) ? `an ${words}` : `a ${words}`;
}

/** STORY PINGS: pulse + label every map object the DM's narration just mentioned, so players can
 *  connect the fiction's nouns to pixels ("Mother Sedge counts softly" → HER token pulses with her
 *  name). Pings pulse IN PLACE — no camera move. (An earlier "glance at the first off-frame mention"
 *  kept yanking the camera to a distant duplicate the narration didn't really point at — e.g. a second
 *  "rope" prop across the map — so it was removed; the focus-framing already keeps the subject in view.) */
function showStoryPings(scene: any, ids: string[]): void {
  const data = scene.lastData;
  if (!data || !ids?.length) return;
  for (const id of ids.slice(0, 6)) {
    const rec = (data.objects ?? []).find((o: any) => o.id === id);
    if (!rec || rec.visible === false) continue;
    const a = scene.actorObjs?.get(id);
    const p = scene.propObjs?.get(id);
    const x = a ? a.container.x : p ? p.obj.x : (rec.col + 0.5) * TILE;
    const y = a ? a.container.y : p ? p.obj.y : (rec.row + 1) * TILE;
    // pulse ring (a canvas shape — fine as pixels)
    const ring = scene.add.ellipse(x, y, TILE * 1.3, TILE * 0.62).setStrokeStyle(2, 0xc9a227, 0.95).setDepth(190000);
    scene.tweens.add({ targets: ring, scaleX: 1.7, scaleY: 1.7, alpha: 0, duration: 700, repeat: 2, onComplete: () => ring.destroy() });
    // floating label — crisp DOM, anchored above the pinged thing, auto-fades
    const lab = domLabel(scene, identifyLabel(rec), 0xc9a227, x, y - TILE * 0.8);
    if (lab) scene.time.delayedCall(2600, () => { if (lab.el) { lab.el.style.opacity = '0'; scene.time.delayedCall(400, () => removeDomLabel(scene, lab)); } });
  }
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
  const parts: any[] = [shadow, sprite];
  if (scene.playerView && a.role === 'pc') {
    // The PC marker: a coloured ground-ring under the token (stroke + a faint fill glow), so real
    // players can always find THEIR character at a glance. Distinct colour per PC.
    const accent = pcRingColor(scene, a.id);
    const glow = scene.add.ellipse(0, 0, TILE * 1.15, TILE * 0.55, accent, 0.16);
    const ring = scene.add.ellipse(0, 0, TILE * 1.15, TILE * 0.55).setStrokeStyle(1.6, accent, 0.95);
    parts.splice(1, 0, glow, ring); // beneath the sprite, above the shadow
  }
  container.add(parts);
  container.setDepth(a.row + 0.5); // actors sort above same-row props
  if (scene.playerView) {
    // Hover-identify EVERYTHING: named characters show their name (colour accent); anonymous actors
    // show what they LOOK like ("a villager", "a drowned corpse") in grey — players always get to
    // know what they're looking at, while secret identities stay secret until the DM names them.
    const accent = a.role === 'pc' ? pcRingColor(scene, a.id) : a.name ? 0xc9a227 : 0x9a8f7d;
    const label = a.name ?? identifyLabel(a);
    sprite.setInteractive({ useHandCursor: true });
    sprite.on('pointerover', () => { if (!coveredByShownRoof(scene, container.x, container.y)) showNameTag(scene, container.x, container.y - sprite.displayHeight * (sd.anchorY ?? 1), label, accent); });
    sprite.on('pointerout', () => hideNameTag(scene));
  }
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
        // WALK, don't teleport: a travel delta carries the actual path (`via`) — chain short tweens
        // through the waypoints at a constant per-tile pace so a long walk LOOKS like walking.
        const via: { col: number; row: number }[] = Array.isArray((d as { via?: { col: number; row: number }[] }).via) ? (d as { via: { col: number; row: number }[] }).via : [];
        if (via.length > 1) {
          const steps = via.map((c) => actorXY(c.col, c.row));
          // A steady, readable pace: ~160 ms/tile (a walking gait, not a blur), capped so a very long
          // crossing still finishes in a few seconds. 90 ms/tile read as teleport-fast on a 14-tile swim.
          const per = Math.max(90, Math.min(165, Math.round(2600 / steps.length)));
          const walkOne = (i: number) => {
            if (i >= steps.length) { a.container.setPosition(x, y); a.container.setDepth(d.to.row + 0.5); return; }
            scene.tweens.add({
              targets: a.container, x: steps[i]!.x, y: steps[i]!.y, duration: per, ease: 'Linear',
              onComplete: () => { a.container.setDepth(via[i]!.row + 0.5); walkOne(i + 1); },
            });
          };
          walkOne(0);
        } else {
          scene.tweens.add({ targets: a.container, x, y, duration: 300, ease: 'Sine.easeInOut', onComplete: () => a.container.setDepth(d.to.row + 0.5) });
        }
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
  // Player view: glide the locked camera after tokens move, so the frame keeps the party centred
  // (deltas already mutated lastData, so the PC centroid is the post-move one).
  if (scene.playerView && deltas?.some((d: any) => d.op === 'move' || d.op === 'spawn' || d.op === 'despawn')) {
    hideNameTag(scene); // the hovered token may have moved out from under the cursor
    playerCameraImpl(scene, data, true);
  }
  updateRoofReveal(scene); // a PC that moved under (or out from under) a roof reveals/re-covers it
}

/** Reveal a building's roof when a PC stands within its footprint — a player whose character is inside
 *  (or among the interior) should see the ROOM, not a lid. Per-roof, re-checked whenever a token moves.
 *  Footprint = the roof faces' bounding box (forgiving: a PC anywhere under the building rectangle lifts
 *  it, not only dead-centre — matches how a player reads "I'm at/in that building"). */
function updateRoofReveal(scene: any): void {
  const groups = scene.roofGroups;
  if (!groups?.length) return;
  const pcs = (scene.lastData?.objects ?? []).filter((o: any) => o.kind === 'actor' && o.role === 'pc' && o.visible !== false);
  const M = TILE * 1.5; // reveal when a PC is INSIDE or AT the building (doorway/wall), not only dead-centre
  for (const rg of groups) {
    const b = rg.bbox;
    const covered = pcs.some((pc: any) => {
      const px = (pc.col + 0.5) * TILE, py = (pc.row + 0.5) * TILE;
      return px >= b.minX - M && px <= b.maxX + M && py >= b.minY - M && py <= b.maxY + M;
    });
    for (const o of rg.objs) o.setVisible(!covered);
  }
}

/** True if a map point sits under a roof that is CURRENTLY drawn (not lifted) — the party can't see
 *  what's inside, so it must not be hoverable/identifiable. A lifted roof (PC inside) exposes it. */
function coveredByShownRoof(scene: any, px: number, py: number): boolean {
  for (const rg of scene.roofGroups ?? []) {
    if (rg.objs?.[0]?.visible === false) continue; // this roof is lifted → its interior IS visible
    const b = rg.bbox;
    if (px >= b.minX && px <= b.maxX && py >= b.minY && py <= b.maxY) return true;
  }
  return false;
}

/** Full rebuild: terrain + props + actors + lighting + camera. */
function renderFullImpl(scene: any, data: any): void {
  if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') (window as any).__mwScene = scene; // dev hook: inspect the live scene (anims/objects) from the console
  for (const o of scene.sceneObjs ?? []) o.destroy();
  scene.sceneObjs = [];
  scene.actorObjs = new Map();
  scene.propObjs = new Map(); // id-addressed props/fixtures (the delta path repositions/toggles them)
  clearDomLabels(scene); // drop any name-tag / ping labels from the previous scene
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
      if (obj) {
        scene.propObjs.set(o.id, { obj, footW: o.footprint?.w ?? 1, footH: o.footprint?.h ?? 1 });
        if (scene.playerView) {
          obj.setInteractive({ useHandCursor: true });
          obj.on('pointerover', () => {
            if (coveredByShownRoof(scene, obj.x, obj.y)) return;
            const lbl = identifyLabel(o);
            showNameTag(scene, obj.x, obj.y - obj.displayHeight, lbl, /^an? /.test(lbl) ? 0x9a8f7d : 0xc9a227); // grey for a common noun, gold for a proper name
          });
          obj.on('pointerout', () => hideNameTag(scene));
        }
      }
    }
  }

  // ROOFS — the closed-building cover as VECTOR geometry (gradient polygon faces + hip/ridge/rim lines +
  // chimney/dormer sprites), drawn ABOVE walls/props so a player sees only rooftops. Hidden when the operator
  // flips the lab switch (or a building is revealed in play). Depth 90000 sits above every row-depth object,
  // below the fog wash. Colours are multiplied by the day/night tint.
  scene.roofGroups = []; // per-roof draw groups + footprint bbox, so a roof can lift when a PC is under it
  if (scene.showRoofs !== false && (data.roofs?.length ?? 0) > 0) {
    const lit = (c: number): number => {
      if (!tint) return c;
      const tr = (tint >> 16) & 0xff, tg = (tint >> 8) & 0xff, tb = tint & 0xff;
      return (Math.round(((c >> 16) & 0xff) * tr / 255) << 16) | (Math.round(((c >> 8) & 0xff) * tg / 255) << 8) | Math.round((c & 0xff) * tb / 255);
    };
    for (const rb of data.roofs) {
      const objs: any[] = [];
      const g = scene.add.graphics().setDepth(90000);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const f of rb.faces) {
        const top = lit(f.top), bot = lit(f.bot);
        g.fillGradientStyle(top, top, bot, bot, 1);
        const pts: { x: number; y: number }[] = [];
        for (let i = 0; i < f.pts.length; i += 2) { pts.push({ x: f.pts[i], y: f.pts[i + 1] }); minX = Math.min(minX, f.pts[i]); maxX = Math.max(maxX, f.pts[i]); minY = Math.min(minY, f.pts[i + 1]); maxY = Math.max(maxY, f.pts[i + 1]); }
        g.fillPoints(pts, true);
      }
      for (const ln of rb.lines) { g.lineStyle(ln.w, lit(ln.c), 1); g.lineBetween(ln.x1, ln.y1, ln.x2, ln.y2); }
      objs.push(g); scene.sceneObjs.push(g);
      for (const sp of rb.sprites) {
        if (!PROP_ART[sp.tag]) continue;
        const img = scene.add.image(sp.x, sp.y, `prop_${sp.tag}`).setOrigin(0.5, 0.5).setDepth(90001);
        if (tint) img.setTint(tint);
        objs.push(img); scene.sceneObjs.push(img);
      }
      scene.roofGroups.push({ objs, bbox: { minX, minY, maxX, maxY } });
    }
    updateRoofReveal(scene); // a PC already standing inside a building opens its roof from the first frame
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

  if (scene.playerView) playerCameraImpl(scene, data);
  else fitCamera(scene, data);
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

/** PLAYER VIEW camera: locked close on the party — REAL players never see the whole map. An intimate
 *  ~PLAYER_VIEW_TILES-across frame centred on the PC centroid, following as tokens move. No pan, no
 *  zoom (the component simply attaches no input handlers in player view); bounds still clamp so the
 *  frame never slides off the world. A tiny room falls back to the (tighter) fit zoom.
 *
 *  FOCUS FRAMING: a map is data-rich but the beat has a SUBJECT — the NPC you're told to talk to, the
 *  boathouse you arrive at. When a DM-named NPC stands within FOCUS_MAX tiles of the party, the frame
 *  GROWS to include them (so the subject is on screen, not off the corner) — but never past a hard
 *  zoom-out cap: a subject beyond the cap is "elsewhere", so we keep the intimate party frame and let
 *  the story-ping glance sweep to it instead. Anonymous villagers (no DM name) never pull the camera. */
const PLAYER_VIEW_TILES = 32; // intimate baseline (tiles across the width)
const PLAYER_VIEW_MAX_TILES = 48; // never zoom out past this to chase a focus
const FOCUS_MAX_TILES = 16; // a named subject beyond this is "elsewhere" — glance, don't reframe

function playerFocusCells(data: any, cxTile: number, cyTile: number): { col: number; row: number }[] {
  const out: { col: number; row: number }[] = [];
  for (const o of data.objects ?? []) {
    if (o.visible === false) continue;
    // a DM-NAMED non-PC actor is a story subject; anonymous mobs/keepers (name '') are not.
    if (!(o.kind === 'actor' && o.role !== 'pc' && typeof o.name === 'string' && o.name.trim().length > 0)) continue;
    if (Math.max(Math.abs((o.col ?? 0) - cxTile), Math.abs((o.row ?? 0) - cyTile)) <= FOCUS_MAX_TILES) out.push({ col: o.col, row: o.row });
  }
  return out;
}

function playerCameraImpl(scene: any, data: any, animate = false): void {
  const cam = scene.cameras.main;
  const box = worldBox(data);
  cam.setBounds(box.x, box.y, box.w, box.h);
  const W = scene.scale.width, H = scene.scale.height;
  const fit = Math.min(W / box.w, H / box.h); // whole-scene floor (tiny rooms)
  const baseZoom = Math.max(W / (PLAYER_VIEW_TILES * TILE), fit); // intimate frame
  const minZoom = Math.max(W / (PLAYER_VIEW_MAX_TILES * TILE), fit); // hard zoom-out cap
  const pcs = (data.objects ?? []).filter((o: any) => o.kind === 'actor' && o.role === 'pc' && o.visible !== false);
  const cxTile = pcs.length ? pcs.reduce((s: number, p: any) => s + p.col, 0) / pcs.length : (box.x + box.w / 2) / TILE - 0.5;
  const cyTile = pcs.length ? pcs.reduce((s: number, p: any) => s + p.row, 0) / pcs.length : (box.y + box.h / 2) / TILE - 0.5;

  // Default: the intimate party frame.
  let zoom = baseZoom;
  let cx = (cxTile + 0.5) * TILE, cy = (cyTile + 0.5) * TILE;

  // Widen to keep the beat's focus (a named NPC nearby) in view — bounded by the zoom-out cap.
  const focus = pcs.length ? playerFocusCells(data, cxTile, cyTile) : [];
  if (focus.length) {
    const cells = [...pcs.map((p: any) => ({ col: p.col, row: p.row })), ...focus];
    let minC = Infinity, minR = Infinity, maxC = -Infinity, maxR = -Infinity;
    for (const c of cells) { minC = Math.min(minC, c.col); minR = Math.min(minR, c.row); maxC = Math.max(maxC, c.col); maxR = Math.max(maxR, c.row); }
    const pad = 2; // tiles of breathing room around the union
    const bw = (maxC - minC + 1 + 2 * pad) * TILE, bh = (maxR - minR + 1 + 2 * pad) * TILE;
    const fitFocus = Math.min(W / bw, H / bh);
    if (fitFocus >= minZoom) { // the union fits within the cap → frame party + subject together
      zoom = Math.min(baseZoom, fitFocus); // never TIGHTER than baseline; zoom out only as needed
      cx = ((minC + maxC) / 2 + 0.5) * TILE;
      cy = ((minR + maxR) / 2 + 0.5) * TILE;
    }
    // else: the subject needs more than the cap — keep the party frame; the ping glance covers it.
  }

  cam.setZoom(zoom);
  if (animate) cam.pan(cx, cy, 450, 'Sine.easeInOut', true);
  else cam.centerOn(cx, cy);
}

interface Bridge {
  scene: any;
  pending: any;
  game: any;
}

/** A self-contained Phaser surface that renders the SceneMap passed as `data` (null = nothing yet).
 *  `freeCamera` (Lab) enables drag-pan + wheel-zoom; bumping `fitNonce` re-frames the whole scene.
 *  `playerView` (the LIVE TABLE) is the real-players experience: camera locked close on the party
 *  (never the whole map), NO pan/zoom inputs, coloured rings under the PCs, and hover name-tags on
 *  PCs + DM-named NPCs. Wins over freeCamera.
 *  INCREMENTAL updates: bump `deltaNonce` with a fresh `deltas` array to tween tokens (move/spawn/
 *  reveal/…) without a full rebuild — pass a NEW `data` reference only when the location changes. */
export default function SceneCanvas({ data, freeCamera = false, playerView = false, fitNonce = 0, showRoofs = true, deltas = null, deltaNonce = 0, pings = null, pingNonce = 0 }: { data: any; freeCamera?: boolean; playerView?: boolean; fitNonce?: number; showRoofs?: boolean; deltas?: any[] | null; deltaNonce?: number; pings?: string[] | null; pingNonce?: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bridgeRef = useRef<Bridge>({ scene: null, pending: null, game: null });

  useEffect(() => {
    let cancelled = false;
    const bridge = bridgeRef.current;
    (async () => {
      const Phaser: any = await import('phaser');
      await loadAssetLibrary(SERVER); // fill art tables BEFORE Phaser preloads
      if (cancelled || !containerRef.current) return;
      // Render at the container's DEVICE resolution instead of a fixed 1024×576 that FIT then CSS-upscales
      // ~1.5× into blur (that upscale — not the pixelArt filter — was what pixelated EVERYTHING, labels
      // worst). Native backing store → crisp sprites AND crisp text. FIT still letterboxes if aspect drifts.
      const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);
      const cw = containerRef.current.clientWidth || 1024;
      const ch = containerRef.current.clientHeight || 576;
      bridge.game = new Phaser.Game({
        type: Phaser.AUTO,
        parent: containerRef.current,
        width: Math.round(cw * dpr),
        height: Math.round(ch * dpr),
        backgroundColor: '#0d0b0a',
        pixelArt: true,
        roundPixels: true,
        render: { preserveDrawingBuffer: true }, // keep the WebGL buffer so canvas.toDataURL() captures real pixels (visual-judge pipeline)
        loader: { maxParallelDownloads: 256 }, // load all tiles in one batch (Phaser refill stalls otherwise)
        scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
        scene: {
          preload() {},
          update(this: any) { updateDomLabels(this); }, // keep DOM labels glued to their world anchors each frame
          create(this: any) {
            const scene = this;
            scene.sceneObjs = [];
            scene.actorObjs = new Map();
            scene.BLEND = Phaser.BlendModes; // ADD/MULTIPLY for the interior torch-pool lighting
            scene.renderVersion = 0;
            scene.renderFull = (d: any) => {
              const version = ++scene.renderVersion;
              afterAssetsLoaded(scene, () => queueSceneAssets(scene, d), () => {
                if (version === scene.renderVersion) renderFullImpl(scene, d);
              });
            };
            scene.applyDeltas = (ds: any[]) =>
              afterAssetsLoaded(scene, () => queueDeltaAssets(scene, ds), () => applyDeltasImpl(scene, ds));
            scene.fit = () => { if (scene.lastData) fitCamera(scene, scene.lastData); };
            scene.playerView = playerView; // player view: locked party camera + rings + name-tags
            // /play keeps auto-fit on resize; player view re-locks on the party; the Lab free-camera
            // leaves the tester's view alone.
            scene.scale.on('resize', () => {
              if (!scene.lastData) return;
              if (playerView) playerCameraImpl(scene, scene.lastData);
              else if (!freeCamera) fitCamera(scene, scene.lastData);
            });
            if (freeCamera && !playerView) {
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
  // Ignored in player view: real players are never allowed to see the whole map.
  useEffect(() => {
    if (fitNonce && !playerView) bridgeRef.current.scene?.fit?.();
  }, [fitNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // Incremental deltas: tween tokens on the LIVE scene (no rebuild). Fired by bumping deltaNonce.
  useEffect(() => {
    if (deltaNonce && deltas?.length) bridgeRef.current.scene?.applyDeltas?.(deltas);
  }, [deltaNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // STORY PINGS: pulse+label the objects the narration just mentioned (bump pingNonce per turn).
  useEffect(() => {
    if (pingNonce && pings?.length) {
      const sc = bridgeRef.current.scene;
      if (sc) showStoryPings(sc, pings);
    }
  }, [pingNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={containerRef} style={{ position: 'relative', overflow: 'hidden', width: '100%', height: '100%', background: '#0d0b0a' }} />;
}
