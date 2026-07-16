/**
 * THE DM'S EYE (P3 Stage 2) — an annotated, roofless render of the current map, built from ground
 * truth (docs/DM-GROUNDING.md). The probes were unambiguous: the DM model reads our scenes 7/7 WITH
 * identity anchors and is identity-blind without them (Set-of-Mark), so the picture carries its own
 * labels: name plaques for named actors, ring colours for the party (mirroring the live table's
 * conventions — same PC palette, in the same join order), building-type plaques at roof centres.
 * Roofs are OFF (the DM legitimately knows interiors); lighting is neutral (perception, not mood).
 * Hidden things (POIs, visible:false) are NOT drawn — the players' secrets stay out of the pixels.
 */
import { spatialIndex, whereIs } from '@mythweaver/engine';
import type { SceneMap } from '@mythweaver/shared';
import { renderSceneMapToPng, type LabelSpec, type RingSpec } from '@mythweaver/scene';
import { deriveBuildings } from './scene-graph.js';

const TILE = 16;
/** The live table's PC ring palette (SceneCanvas PC_RING_COLORS), assigned in object order — the DM's
 *  picture and the players' screen speak the same colour language. */
const PC_RING_COLORS = [0x57d98a, 0x5aa9ff, 0xffc14d, 0xff7d9c, 0xb08cff, 0x6ee7d8];
const NPC_GOLD = 0xc9a227; // named-NPC accent (the table's hover-tag gold)
const BUILDING_TAN = 0xd8c9a3;

export function dmViewAnnotations(map: SceneMap, actingPcName?: string): { labels: LabelSpec[]; rings: RingSpec[] } {
  const labels: LabelSpec[] = [];
  const rings: RingSpec[] = [];
  const acting = (actingPcName ?? '').trim().toLowerCase();
  const reveal = revealedBuildingIds(map);
  // A hidden actor is one standing inside a building the party is NOT in — under a closed roof, unseen.
  // Its plaque must NOT be drawn (a name floating over a closed lid leaks that someone's inside).
  let insideOf: (o: { col: number; row: number }) => string | undefined = () => undefined;
  // Building-type plaques FIRST (actor plaques win overlaps), at the footprint's TOP edge — a centroid
  // plaque covered a keeper (caught live). Type is visible from OUTSIDE, so it's labeled even when closed.
  try {
    const idx = spatialIndex(map);
    insideOf = (o) => { const w = whereIs(idx, o); return w.indoor ? w.buildingId : undefined; };
    const bbox = new Map<string, { minc: number; maxc: number; minr: number; maxr: number }>();
    for (const [k, bid] of idx.roofAt) {
      const c = k % idx.cols, r = (k - c) / idx.cols;
      const g = bbox.get(bid) ?? { minc: 1e9, maxc: -1, minr: 1e9, maxr: -1 };
      g.minc = Math.min(g.minc, c); g.maxc = Math.max(g.maxc, c); g.minr = Math.min(g.minr, r); g.maxr = Math.max(g.maxr, r);
      bbox.set(bid, g);
    }
    for (const b of deriveBuildings(map, idx)) {
      if (b.type === 'house') continue; // anonymous houses are noise, as in the digest
      const bb = bbox.get(b.id);
      if (!bb) continue;
      labels.push({ text: b.type, x: ((bb.minc + bb.maxc + 1) / 2) * TILE, y: (bb.minr + 1.6) * TILE, color: BUILDING_TAN });
    }
  } catch { /* oracle failure → actors-only annotations */ }
  let pcIdx = 0;
  for (const o of map.objects ?? []) {
    if (o.kind !== 'actor' || o.visible === false) continue;
    const building = insideOf(o);
    if (building && !reveal.has(building)) continue; // inside a closed building — unseen, so unlabeled
    const cx = (o.col + 0.5) * TILE, feetY = (o.row + 1) * TILE;
    if (o.role === 'pc') {
      const color = PC_RING_COLORS[pcIdx++ % PC_RING_COLORS.length]!;
      const isActing = !!acting && (o.name ?? '').toLowerCase() === acting;
      rings.push({ x: cx, y: feetY - TILE * 0.25, color, ...(isActing ? { double: true } : {}) });
      if (o.name) labels.push({ text: o.name.split(/\s+/)[0]!, x: cx, y: feetY - TILE * 1.4, color });
    } else if (o.name) {
      // Named NPCs get plaques; anonymous villagers/keepers stay unlabeled (the zone digest counts them).
      labels.push({ text: o.name.split(/\s+/)[0]!, x: cx, y: feetY - TILE * 1.4, color: NPC_GOLD });
    }
  }
  return { labels, rings };
}

/** Buildings the PARTY is INSIDE (a PC's cell under the roof). Only these interiors are revealed — the DM's
 *  eye shows what the characters can perceive, so a closed building the party is merely NEAR keeps its lid. */
export function revealedBuildingIds(map: SceneMap): Set<string> {
  const reveal = new Set<string>();
  try {
    const idx = spatialIndex(map);
    for (const o of map.objects ?? []) {
      if (o.kind !== 'actor' || o.role !== 'pc' || o.visible === false) continue;
      const w = whereIs(idx, o);
      if (w.indoor && w.buildingId) reveal.add(w.buildingId);
    }
  } catch { /* oracle failure → reveal nothing (all roofs closed — safe) */ }
  return reveal;
}

/** Render the annotated DM view → base64 PNG (undefined on any failure — vision must never break a turn).
 *  Roofs stay CLOSED except buildings the party is inside — the DM sees only what the party can perceive. */
export function renderDmView(map: SceneMap, assetsRoot: string, actingPcName?: string): string | undefined {
  try {
    const annotations = dmViewAnnotations(map, actingPcName);
    return renderSceneMapToPng(map, { assetsRoot, revealBuildingIds: revealedBuildingIds(map), neutralLighting: true, annotations }).toString('base64');
  } catch {
    return undefined;
  }
}
