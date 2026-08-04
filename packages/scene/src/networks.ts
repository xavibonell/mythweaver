/**
 * The LOOM — typed seam networks over a region partition (Weave architecture L1). The deep generalization
 * behind the "build anything" thesis: a town's STREET network is a network of MATERIAL-TYPED SEAMS between
 * blocks. A CANAL is the SAME network with a WATER material profile (a non-walkable bed + walkable banks +
 * bridges derived where a crossing is needed); rivers / walls / moats / aqueducts are the same engine with
 * other profiles — data rows, not new code. The recursive-bisection carver is lifted VERBATIM from townGen
 * STAGE 1 (byte-identical for the `street` profile — see networks.test.ts), so profile #1 is a pure refactor.
 *
 * The engine paints the seam bed + banks and records each seam; CROSSINGS (bridges) are derived afterward
 * where a barrier-profile seam meets a walkable one — exactly how door aprons derive from the claims grid.
 */
import { CLAIM_BARRIER, CLAIM_CIRCULATION, type Canvas, type Pt, fill } from './primitives.js';

export interface Rect { x: number; y: number; w: number; h: number }

/** A seam material profile. `bedAt(depth)` gives the bed tag/width per recursion depth (arteries wider than
 *  alleys). `banks` lays a walkable strip either side of a non-walkable bed (a canal towpath). `crossing`
 *  derives walkable bridges over a non-walkable bed where they're needed. Closed in code, OPEN in data. */
export interface MaterialProfile {
  id: string;
  /** Bed per depth: tag, walkability, and half-width in tiles (the seam is `2*half... ` no — `width` tiles). */
  bedAt: (depth: number) => { tag: string; walkable: boolean; width: number };
  /** Walkable bank strip either side of a non-walkable bed (canal towpath). */
  banks?: { tag: string; width: number };
  /** The claim bit a seam of this profile stamps (CIRCULATION for a street, BARRIER for water/wall). */
  claimBit?: number;
  /** Bridge derivation over a non-walkable bed. `spacingMin` = min tiles between bridges along the seam. */
  crossing?: { tag: string; walkable: boolean; spacingMin: number };
}

export interface Seam { rect: Rect; profile: string; depth: number; horiz: boolean }
export interface SeamResult { blocks: Rect[]; seams: Seam[] }

export interface RouteOpts { minBlock: number; gridChaos: number; maxDepth: number }

/** Paint one seam's bed (+ banks for a barrier profile) and stamp its claim (only when the profile sets
 *  `claimBit` — the street profile leaves it unset so lifting STAGE 1 stays a PURE fill refactor: claims
 *  would otherwise steer townGen's later claim-aware placement and break byte-identity). */
function paintSeam(cv: Canvas, seam: Rect, profile: MaterialProfile, depth: number): void {
  const bed = profile.bedAt(depth);
  fill(cv, seam, bed.tag, bed.walkable);
  if (profile.claimBit !== undefined) for (let r = seam.y; r < seam.y + seam.h; r++) for (let c = seam.x; c < seam.x + seam.w; c++) cv.stampClaim(c, r, profile.claimBit);
  if (profile.banks && !bed.walkable) {
    // a walkable towpath hugging each long side of the bed
    if (seam.h >= seam.w) { // vertical seam → banks on left/right
      for (let dw = 1; dw <= profile.banks.width; dw++) for (let r = seam.y; r < seam.y + seam.h; r++) {
        cv.set(seam.x - dw, r, profile.banks.tag, true); cv.set(seam.x + seam.w - 1 + dw, r, profile.banks.tag, true);
      }
    } else { // horizontal seam → banks on top/bottom
      for (let dw = 1; dw <= profile.banks.width; dw++) for (let c = seam.x; c < seam.x + seam.w; c++) {
        cv.set(c, seam.y - dw, profile.banks.tag, true); cv.set(c, seam.y + seam.h - 1 + dw, profile.banks.tag, true);
      }
    }
  }
}

/**
 * Recursively bisect `region` into blocks, carving a `profile` seam at each cut. Returns the block partition
 * (consumed by the fabric fillers) + the seams (for crossing derivation). Byte-identical to townGen STAGE 1
 * when `profile` is the street profile with the same opts — one `cv.rng()` per cut, same call order.
 */
export function routeSeam(cv: Canvas, region: Rect, profile: MaterialProfile, opts: RouteOpts): SeamResult {
  const { minBlock, gridChaos, maxDepth } = opts;
  const open: { r: Rect; d: number }[] = [{ r: region, d: 0 }];
  const blocks: Rect[] = [];
  const seams: Seam[] = [];
  let guard = 0;
  while (open.length && guard++ < 600) {
    open.sort((a, b) => b.r.w * b.r.h - a.r.w * a.r.h);
    const { r: R, d } = open.shift()!;
    if (Math.min(R.w, R.h) <= minBlock || d >= maxDepth) { blocks.push(R); continue; }
    const horiz = R.w >= R.h;
    const len = horiz ? R.w : R.h;
    const streetW = profile.bedAt(d).width;
    const lo = Math.floor(minBlock / 2), hi = len - Math.floor(minBlock / 2) - streetW;
    if (hi <= lo) { blocks.push(R); continue; }
    const cut = Math.max(lo, Math.min(hi, Math.floor(len * (0.5 + (cv.rng() - 0.5) * gridChaos))));
    const seam: Rect = horiz ? { x: R.x + cut, y: R.y, w: streetW, h: R.h } : { x: R.x, y: R.y + cut, w: R.w, h: streetW };
    paintSeam(cv, seam, profile, d);
    seams.push({ rect: seam, profile: profile.id, depth: d, horiz });
    if (horiz) open.push({ r: { x: R.x, y: R.y, w: cut, h: R.h }, d: d + 1 }, { r: { x: R.x + cut + streetW, y: R.y, w: R.w - cut - streetW, h: R.h }, d: d + 1 });
    else open.push({ r: { x: R.x, y: R.y, w: R.w, h: cut }, d: d + 1 }, { r: { x: R.x, y: R.y + cut + streetW, w: R.w, h: R.h - cut - streetW }, d: d + 1 });
  }
  return { blocks, seams };
}

/** A CANAL material profile — the proof that "canal" is data over the same seam engine: a non-walkable
 *  water bed, walkable stone quays either side, bridges derived at intervals. `road` = the grey fitted-stone
 *  quay/bridge tile; `water` = the blue water tile (generated set). */
export const CANAL_PROFILE: MaterialProfile = {
  id: 'water.canal',
  bedAt: () => ({ tag: 'water', walkable: false, width: 2 }),
  banks: { tag: 'road', width: 1 },
  claimBit: CLAIM_BARRIER,
  crossing: { tag: 'road', walkable: true, spacingMin: 14 },
};

/**
 * Convert the town's main artery seam into a CANAL: repaint its corridor as water + quays, then DERIVE
 * bridges spanning it at intervals so the two banks reconnect (a canal that severs the town without bridges
 * is a bug — connectivity by construction). Returns the canal spine + bridge centres (for staging/fidelity).
 * Runs AFTER routeSeam (the street network + blocks already exist); the canal reuses the main artery corridor.
 */
export function carveCanal(cv: Canvas, seams: Seam[], profile: MaterialProfile = CANAL_PROFILE): { spine: Rect; bridges: Pt[] } | null {
  // the longest shallow (artery) seam becomes the canal spine
  const spine = seams.filter((s) => s.depth <= 1).sort((a, b) => Math.max(b.rect.w, b.rect.h) - Math.max(a.rect.w, a.rect.h))[0];
  if (!spine) return null;
  const s = spine.rect;
  const bedW = profile.bedAt(0).width;
  const bankW = profile.banks?.width ?? 1;
  const vertical = s.h >= s.w; // the canal runs top-to-bottom
  // repaint the corridor (water bed + quay banks + BARRIER claim)
  const bed: Rect = vertical ? { x: s.x, y: s.y, w: bedW, h: s.h } : { x: s.x, y: s.y, w: s.w, h: bedW };
  paintSeam(cv, bed, profile, 0);
  // bridges span bed+both quays, 2 tiles thick, spaced along the length; every bridge stamps CIRCULATION
  const bridges: Pt[] = [];
  const length = vertical ? s.h : s.w;
  const bridgeTag = profile.crossing?.tag ?? 'road';
  const spacing = Math.max(profile.crossing?.spacingMin ?? 14, Math.floor(length / 3));
  for (let t = Math.floor(spacing / 2); t <= length - 3; t += spacing) {
    if (vertical) {
      for (let dr = 0; dr < 2; dr++) for (let c = s.x - bankW; c < s.x + bedW + bankW; c++) { cv.set(c, s.y + t + dr, bridgeTag, true); cv.stampClaim(c, s.y + t + dr, CLAIM_CIRCULATION); }
      bridges.push({ c: s.x + Math.floor(bedW / 2), r: s.y + t });
    } else {
      for (let dc = 0; dc < 2; dc++) for (let r = s.y - bankW; r < s.y + bedW + bankW; r++) { cv.set(s.x + t + dc, r, bridgeTag, true); cv.stampClaim(s.x + t + dc, r, CLAIM_CIRCULATION); }
      bridges.push({ c: s.x + t, r: s.y + Math.floor(bedW / 2) });
    }
  }
  return { spine: bed, bridges };
}
