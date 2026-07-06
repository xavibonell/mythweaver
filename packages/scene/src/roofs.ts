/**
 * VECTOR ROOF BUILDER — turns each building footprint into drawable roof GEOMETRY (gradient polygon faces +
 * crisp hip/ridge/rim lines + chimney/dormer sprites), the reference-quality approach that per-cell tiles
 * couldn't reach. Both renderers rasterise the same ops, so a clean 45° hip and a solid rim are actually
 * drawn. Per building: solid mask (courtyards filled → no holes) → decompose into rectangular room-BLOCKS →
 * a hip (square-ish) or gable (long/narrow) per block → a crafted 2-tone rim → a chimney + dormers.
 *
 * Coordinates are SCENE PIXELS (tile*16). Colours are packed 0xRRGGBB; the builder does all the shading so
 * the renderers stay dumb (fill a gradient poly, stroke a line, blit a sprite) and only apply the day/night tint.
 */
import type { RoofBuilding } from '@mythweaver/shared';
import type { BuildingFootprint, Canvas } from './primitives.js';

const T = 16;
type RGB = [number, number, number];
const MAT: Record<string, RGB> = {
  thatch: [0xc6, 0xa2, 0x62],
  tile: [0xba, 0x54, 0x3a],
  slate: [0x78, 0x80, 0x90],
  wood: [0x9c, 0x70, 0x44],
};

/** Lerp a base colour toward white (t>0) or black (t<0), packed to 0xRRGGBB. */
function shade(base: RGB, t: number): number {
  const to = t >= 0 ? 255 : 0, a = Math.abs(t);
  const r = Math.round(base[0] + (to - base[0]) * a);
  const g = Math.round(base[1] + (to - base[1]) * a);
  const b = Math.round(base[2] + (to - base[2]) * a);
  return (r << 16) | (g << 8) | b;
}

// ── Rectangle decomposition (so a building's WINGS become their own hip sections — L/T/cross roofs). ──
interface IRect { x: number; y: number; w: number; h: number }
/** Largest all-1 rectangle in a 0/1 grid (histogram method). */
function maxRect(g: Uint8Array, W: number, H: number): IRect & { area: number } {
  const height = new Int32Array(W);
  let best = { x: 0, y: 0, w: 0, h: 0, area: 0 };
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) height[c] = g[r * W + c] ? height[c]! + 1 : 0;
    const stack: number[] = [];
    for (let c = 0; c <= W; c++) {
      const cur = c < W ? height[c]! : 0;
      while (stack.length && height[stack[stack.length - 1]!]! >= cur) {
        const hgt = height[stack.pop()!]!;
        const left = stack.length ? stack[stack.length - 1]! + 1 : 0;
        const wdt = c - left, area = hgt * wdt;
        if (area > best.area) best = { x: left, y: r - hgt + 1, w: wdt, h: hgt, area };
      }
      stack.push(c);
    }
  }
  return best;
}
function decompose(grid: Uint8Array, W: number, H: number): IRect[] {
  const g = grid.slice(), rects: IRect[] = [];
  for (let it = 0; it < 8; it++) {
    const best = maxRect(g, W, H);
    if (best.area < 4) break;
    rects.push({ x: best.x, y: best.y, w: best.w, h: best.h });
    for (let r = best.y; r < best.y + best.h; r++) for (let c = best.x; c < best.x + best.w; c++) g[r * W + c] = 0;
  }
  return rects;
}

// ── Per-block roof geometry (ported from the approved prototype). ──
function hipInto(rb: RoofBuilding, r: IRect, base: RGB): void {
  const X = r.x * T, Y = r.y * T, W = r.w * T, H = r.h * T;
  const horiz = W >= H, inset = Math.min(W, H) / 2;
  const TL = [X, Y], TR = [X + W, Y], BR = [X + W, Y + H], BL = [X, Y + H];
  const F = (pts: number[], tt: number, bt: number) => rb.faces.push({ pts, top: shade(base, tt), bot: shade(base, bt) });
  const L = (a: number[], b: number[], t: number, w = 1) => rb.lines.push({ x1: a[0]!, y1: a[1]!, x2: b[0]!, y2: b[1]!, c: shade(base, t), w });
  if (horiz) {
    const r1 = [X + inset, Y + H / 2], r2 = [X + W - inset, Y + H / 2];
    F([...TL, ...TR, ...r2, ...r1], 0.32, 0.24);   // N face (lit)
    F([...BL, ...BR, ...r2, ...r1], -0.06, -0.32);  // S face (shadow)
    F([...TL, ...BL, ...r1], 0.08, -0.10);          // W triangle
    F([...TR, ...BR, ...r2], -0.04, -0.24);         // E triangle
    L(TL, r1, -0.42); L(BL, r1, -0.42); L(TR, r2, -0.42); L(BR, r2, -0.42);
    L(r1, r2, 0.40, 2);
  } else {
    const r1 = [X + W / 2, Y + inset], r2 = [X + W / 2, Y + H - inset]; // top / bottom ridge ends
    F([...TL, ...BL, ...r2, ...r1], 0.20, 0.08);    // W trapezoid (lit)
    F([...TR, ...BR, ...r2, ...r1], -0.06, -0.28);  // E trapezoid (shadow)
    F([...TL, ...TR, ...r1], 0.30, 0.24);           // N triangle
    F([...BL, ...BR, ...r2], -0.10, -0.28);         // S triangle
    L(TL, r1, -0.42); L(TR, r1, -0.42); L(BL, r2, -0.42); L(BR, r2, -0.42);
    L(r1, r2, 0.40, 2);
  }
}
function gableInto(rb: RoofBuilding, r: IRect, base: RGB): void {
  const X = r.x * T, Y = r.y * T, W = r.w * T, H = r.h * T;
  const F = (pts: number[], tt: number, bt: number) => rb.faces.push({ pts, top: shade(base, tt), bot: shade(base, bt) });
  const L = (a: number[], b: number[], t: number, w = 1) => rb.lines.push({ x1: a[0]!, y1: a[1]!, x2: b[0]!, y2: b[1]!, c: shade(base, t), w });
  if (W >= H) {
    const m1 = [X, Y + H / 2], m2 = [X + W, Y + H / 2];
    F([X, Y, X + W, Y, ...m2, ...m1], 0.32, 0.14);
    F([...m1, ...m2, X + W, Y + H, X, Y + H], -0.08, -0.34);
    L(m1, m2, 0.40, 2);
  } else {
    const m1 = [X + W / 2, Y], m2 = [X + W / 2, Y + H];
    F([X, Y, ...m1, ...m2, X, Y + H], 0.24, 0.10);
    F([...m1, X + W, Y, X + W, Y + H, ...m2], -0.06, -0.30);
    L(m1, m2, 0.40, 2);
  }
}
function rimInto(rb: RoofBuilding, r: IRect, base: RGB): void {
  const X = r.x * T, Y = r.y * T, W = r.w * T, H = r.h * T;
  const pts = [[X, Y], [X + W, Y], [X + W, Y + H], [X, Y + H]];
  const fascia = shade(base, 0.28), edge = shade(base, -0.55);
  for (let i = 0; i < 4; i++) {
    const a = pts[i]!, b = pts[(i + 1) % 4]!;
    rb.lines.push({ x1: a[0]!, y1: a[1]!, x2: b[0]!, y2: b[1]!, c: fascia, w: 3 }); // lighter fascia band
    rb.lines.push({ x1: a[0]!, y1: a[1]!, x2: b[0]!, y2: b[1]!, c: edge, w: 1 });   // crisp dark centre-edge
  }
}

/** Build vector roof geometry for every recorded building. */
export function buildRoofs(cv: Canvas): RoofBuilding[] {
  const out: RoofBuilding[] = [];
  const isB = (c: number, r: number): boolean => { const t = cv.tiles[r]?.[c] ?? ''; return t.startsWith('wall') || t === 'stone' || t === 'wood_floor'; };
  for (const b of cv.buildings as BuildingFootprint[]) {
    const { x, y, w, h } = b.rect;
    if (w < 3 || h < 3) continue;
    // Solid mask + fill enclosed courtyards (flood the exterior; anything unreached is walled in → fill).
    const GW = w + 2, GH = h + 2, N = GW * GH, li = (cc: number, rr: number) => rr * GW + cc;
    const mask = new Uint8Array(N);
    for (let rr = 1; rr <= h; rr++) for (let cc = 1; cc <= w; cc++) if (isB(x - 1 + cc, y - 1 + rr)) mask[li(cc, rr)] = 1;
    const ext = new Uint8Array(N), st: number[] = [];
    for (let cc = 0; cc < GW; cc++) { st.push(li(cc, 0), li(cc, GH - 1)); }
    for (let rr = 0; rr < GH; rr++) { st.push(li(0, rr), li(GW - 1, rr)); }
    while (st.length) {
      const i = st.pop()!; if (ext[i] || mask[i]) continue; ext[i] = 1;
      const cc = i % GW, rr = (i / GW) | 0;
      if (cc > 0) st.push(li(cc - 1, rr)); if (cc < GW - 1) st.push(li(cc + 1, rr));
      if (rr > 0) st.push(li(cc, rr - 1)); if (rr < GH - 1) st.push(li(cc, rr + 1));
    }
    for (let i = 0; i < N; i++) if (!mask[i] && !ext[i]) mask[i] = 1;
    // Local w×h grid → decompose into rectangular blocks (world tile coords).
    const grid = new Uint8Array(w * h);
    for (let rr = 0; rr < h; rr++) for (let cc = 0; cc < w; cc++) grid[rr * w + cc] = mask[li(cc + 1, rr + 1)]!;
    const rects = decompose(grid, w, h).map((r) => ({ x: x + r.x, y: y + r.y, w: r.w, h: r.h }));
    if (!rects.length) continue;
    const base: RGB = MAT[b.roof] ?? [0xc6, 0xa2, 0x62];
    const rb: RoofBuilding = { id: b.id, faces: [], lines: [], sprites: [] };
    let big = rects[0]!, bigA = 0;
    for (const r of rects) {
      const long = Math.max(r.w, r.h), short = Math.min(r.w, r.h);
      if (long / short >= 2.3 && short <= 4) gableInto(rb, r, base); else hipInto(rb, r, base);
      rimInto(rb, r, base);
      if (r.w * r.h > bigA) { bigA = r.w * r.h; big = r; }
    }
    // A chimney near the biggest block's ridge; a pair of dormers if that block is roomy.
    rb.sprites.push({ x: (big.x + big.w * 0.32) * T, y: (big.y + big.h * 0.30) * T, tag: 'roof_chimney' });
    if (big.w >= 6 && big.h >= 5) {
      rb.sprites.push({ x: (big.x + big.w * 0.34) * T, y: (big.y + big.h * 0.72) * T, tag: 'roof_dormer' });
      rb.sprites.push({ x: (big.x + big.w * 0.66) * T, y: (big.y + big.h * 0.72) * T, tag: 'roof_dormer' });
    }
    out.push(rb);
  }
  return out;
}
