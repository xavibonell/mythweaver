/**
 * City realizer — rasterizes a float CityMesh onto the 16px tile grid (Stage G) AND fills it (M3).
 * The mesh is the organic plan; this is the single place we cross from continuous geometry to a lived-in
 * tiled SceneMap.
 *
 * Structure (M0–M2): ground by zone, cobble street seams between core cells, an optional curtain wall.
 * Fill (M3): an inside-out zoning gradient assigns each core cell a WARD (plaza at the heart; cathedral /
 * keep / manor / guild as signature landmarks; commercial inner; craft mid; residential/slum outskirts).
 * Each cell's largest inscribed rectangle becomes the ward's building (compound() furnishes it + drops an
 * occupant), with ward-appropriate props scattered around. The preserved extramural ring gets flavour —
 * farmsteads, a camp by a gate, a roadside vendor — and a few NPCs (gate guards, folk) bring it alive.
 * Deterministic from the seed.
 */
import { Canvas, building, compound, finalize, place, poissonScatter, vignette } from './primitives.js';
import { buildCityMesh, type CityMeshOpts, type Vec2, type Zone } from './citymesh.js';
import type { ShapeKind } from './footprint.js';
import type { BuildingType, SceneMap } from '@mythweaver/shared';

// Grass-first: the whole settlement sits on grass (like the cottage examples) — the city reads through
// its cobble streets, buildings, and wall, NOT a dirt footprint. Buildings get a thin earthen apron.
const ZONE_GROUND: Record<Zone, string> = { core: 'grass', extramural: 'grass', rural: 'grass' };

interface CellInfo { id: number; x0: number; y0: number; x1: number; y1: number; area: number; cc: number; cr: number; d: number; wallAdj: boolean; nearGate: number }
type Ward = 'plaza' | 'park' | BuildingType;

// Ward → a prop palette that dresses the cell's leftover ground so a block feels inhabited, not bare.
const WARD_PROPS: Record<string, string[]> = {
  market: ['market_stall', 'crate', 'barrel', 'sack'],
  craft: ['woodpile', 'crate', 'barrel', 'sack'],
  grand: ['statue', 'stone_bench', 'tree'],
  residential: ['tree', 'bush', 'flowers', 'fence', 'woodpile'],
  civic: ['stone_bench', 'tree', 'signpost'],
  default: ['barrel', 'crate', 'bush'],
};
function propClass(w: Ward): keyof typeof WARD_PROPS {
  if (['shop', 'general_store', 'inn', 'tavern'].includes(w)) return 'market';
  if (['smithy', 'workshop', 'guildhall', 'armory', 'barracks'].includes(w)) return 'craft';
  if (['cathedral', 'temple', 'keep', 'manor'].includes(w)) return 'grand';
  if (['courthouse', 'library', 'jail'].includes(w)) return 'civic';
  if (w === 'house') return 'residential';
  return 'default';
}

// --- tile helpers -----------------------------------------------------------

function lineTiles(cv: Canvas, a: { c: number; r: number }, b: { c: number; r: number }, tag: string, walk: boolean) {
  let x0 = a.c, y0 = a.r;
  const x1 = b.c, y1 = b.r, dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    cv.set(x0, y0, tag, walk);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

/** Largest all-true axis-aligned rectangle in a region (histogram method) — the building footprint that
 *  fits an irregular cell without crossing its streets. */
function maxRect(test: (c: number, r: number) => boolean, x0: number, y0: number, x1: number, y1: number): { x: number; y: number; w: number; h: number } | null {
  const W = x1 - x0 + 1;
  if (W < 1) return null;
  const h = new Array<number>(W).fill(0);
  let best: { x: number; y: number; w: number; h: number } | null = null, bestArea = 0;
  for (let r = y0; r <= y1; r++) {
    for (let i = 0; i < W; i++) h[i] = test(x0 + i, r) ? h[i]! + 1 : 0;
    const st: number[] = [];
    for (let i = 0; i <= W; i++) {
      const cur = i < W ? h[i]! : 0;
      while (st.length && h[st[st.length - 1]!]! >= cur) {
        const ht = h[st.pop()!]!;
        const left = st.length ? st[st.length - 1]! + 1 : 0;
        const area = ht * (i - left);
        if (area > bestArea) { bestArea = area; best = { x: x0 + left, y: r - ht + 1, w: i - left, h: ht }; }
      }
      st.push(i);
    }
  }
  return best;
}

/** Face the door toward whichever side of the rect borders the most cobble. */
function pickDoor(cv: Canvas, r: { x: number; y: number; w: number; h: number }): 'north' | 'south' | 'east' | 'west' {
  const s = { north: 0, south: 0, east: 0, west: 0 };
  for (let x = r.x; x < r.x + r.w; x++) { if (cv.tileAt(x, r.y - 1) === 'road') s.north++; if (cv.tileAt(x, r.y + r.h) === 'road') s.south++; }
  for (let y = r.y; y < r.y + r.h; y++) { if (cv.tileAt(r.x - 1, y) === 'road') s.west++; if (cv.tileAt(r.x + r.w, y) === 'road') s.east++; }
  return (Object.entries(s).sort((a, b) => b[1] - a[1])[0]![0] as 'north' | 'south' | 'east' | 'west');
}

/** Per-cell bbox / centroid / area + planning attributes (distance, wall-adjacency, gate proximity). */
function cellInfos(m: ReturnType<typeof buildCityMesh>, nid: number[][], GRID: number, zone: Zone): Map<number, CellInfo> {
  const acc = new Map<number, { x0: number; y0: number; x1: number; y1: number; area: number; sc: number; sr: number }>();
  for (let r = 0; r < GRID; r++) for (let c = 0; c < GRID; c++) {
    const id = nid[r]![c]!;
    if (m.patches[id]?.zone !== zone) continue;
    const a = acc.get(id);
    if (a) { a.x0 = Math.min(a.x0, c); a.y0 = Math.min(a.y0, r); a.x1 = Math.max(a.x1, c); a.y1 = Math.max(a.y1, r); a.area++; a.sc += c; a.sr += r; }
    else acc.set(id, { x0: c, y0: r, x1: c, y1: r, area: 1, sc: c, sr: r });
  }
  const gates = m.wall?.gates ?? [];
  const out = new Map<number, CellInfo>();
  for (const [id, a] of acc) {
    const p = m.patches[id]!;
    const d = m.cityRadius ? p.distToCenter / m.cityRadius : 0;
    const wallAdj = p.neighbours.some((n) => m.patches[n]?.zone === 'extramural');
    let nearGate = 1;
    for (const g of gates) nearGate = Math.min(nearGate, Math.hypot(p.centroid.x - g.x, p.centroid.y - g.y) / (m.cityRadius || 1));
    out.set(id, { id, x0: a.x0, y0: a.y0, x1: a.x1, y1: a.y1, area: a.area, cc: Math.round(a.sc / a.area), cr: Math.round(a.sr / a.area), d, wallAdj, nearGate });
  }
  return out;
}

/** Inside-out zoning: a plaza at the heart, signature landmarks on the best-fit cells, then a gradient
 *  from grand/commercial centre to craft mid to residential/slum outskirts. */
function assignWards(m: ReturnType<typeof buildCityMesh>, infos: Map<number, CellInfo>, rng: () => number): Map<number, Ward> {
  const ward = new Map<number, Ward>();
  const ids = [...infos.keys()].sort((a, b) => m.patches[a]!.distToCenter - m.patches[b]!.distToCenter);
  if (!ids.length) return ward;
  ward.set(ids[0]!, 'plaza');
  const free = new Set(ids.slice(1));
  const pick = (pred: (i: CellInfo) => boolean, score: (i: CellInfo) => number): number | undefined => {
    let best = -1, bs = -Infinity;
    for (const id of free) { const i = infos.get(id)!; if (!pred(i)) continue; const s = score(i); if (s > bs) { bs = s; best = id; } }
    if (best >= 0) { free.delete(best); return best; }
    return undefined;
  };
  const sig = (id: number | undefined, w: Ward) => { if (id !== undefined) ward.set(id, w); };
  sig(pick((i) => i.d < 0.6, (i) => i.area), 'cathedral'); // grand temple, central + large
  sig(pick((i) => i.wallAdj, (i) => i.area), 'keep'); // citadel on the wall
  sig(pick((i) => i.d < 0.55, (i) => i.area), 'manor'); // a noble's seat near the centre
  sig(pick((i) => i.d < 0.65, (i) => i.area), 'guildhall');
  sig(pick((i) => i.d < 0.5, (i) => i.area), 'courthouse');
  sig(pick((i) => i.d > 0.38 && i.d < 0.72, () => rng()), 'park'); // a green square mid-town
  if (free.size > 9) sig(pick((i) => i.d > 0.45, () => rng()), 'park'); // a second park in bigger cities
  for (const id of free) {
    const i = infos.get(id)!;
    const pool: BuildingType[] = i.nearGate < 0.22 ? ['smithy', 'tavern', 'general_store', 'inn']
      : i.d < 0.45 ? ['shop', 'inn', 'tavern', 'library', 'general_store', 'manor', 'temple']
        : i.d < 0.72 ? ['smithy', 'workshop', 'shop', 'house', 'inn', 'tavern']
          : ['house', 'house', 'house', 'workshop', 'smithy'];
    ward.set(id, pool[Math.floor(rng() * pool.length)]!);
  }
  return ward;
}

/** Drop N npc actors on free tiles of a given terrain inside a cell (seed-shuffled). */
function placeActors(cv: Canvas, info: CellInfo, inCell: (c: number, r: number) => boolean, terr: string, tags: string[], n: number, idBase: string) {
  const cand: { c: number; r: number }[] = [];
  for (let r = info.y0; r <= info.y1; r++) for (let c = info.x0; c <= info.x1; c++) if (inCell(c, r) && cv.tileAt(c, r) === terr && cv.isFree(c, r)) cand.push({ c, r });
  for (let i = cand.length - 1; i > 0; i--) { const j = Math.floor(cv.rng() * (i + 1)); [cand[i], cand[j]] = [cand[j]!, cand[i]!]; }
  for (let k = 0; k < Math.min(n, cand.length); k++) place(cv, { id: `${idBase}-${k}`, tag: tags[k % tags.length]!, kind: 'actor', role: 'npc', at: cand[k]! });
}

function rectOf(i: CellInfo) { return { x: i.x0, y: i.y0, w: i.x1 - i.x0 + 1, h: i.y1 - i.y0 + 1 }; }

/** A footprint shape sized to the lot. Any lot roomy enough (≥11) gets an irregular L/T/U/+ silhouette —
 *  we WANT shaped buildings, not squares; only genuinely small lots (<11, maskFor would fall back) stay
 *  rectangular. The occasional small rect is fine; the norm should be shaped. */
function pickShape(rect: { w: number; h: number }, _primary: boolean, rng: () => number): ShapeKind {
  const m = Math.min(rect.w, rect.h);
  if (m < 11) return 'rect';
  const pool: ShapeKind[] = m >= 13 ? ['plus', 'compose', 'you', 'tee', 'ell', 'ell', 'tee'] : ['tee', 'ell', 'ell'];
  return pool[Math.floor(rng() * pool.length)]!;
}

/** A short earthen apron from a building's door side out to the nearest cobble — so a house on grass
 *  reads as connected to the street (the cottage's entry-path trick), not marooned in a moat. */
function carveFront(cv: Canvas, rect: { x: number; y: number; w: number; h: number }, side: 'north' | 'south' | 'east' | 'west') {
  let c = rect.x + Math.floor(rect.w / 2), r = rect.y + Math.floor(rect.h / 2), dc = 0, dr = 0;
  if (side === 'north') { r = rect.y - 1; dr = -1; } else if (side === 'south') { r = rect.y + rect.h; dr = 1; } else if (side === 'west') { c = rect.x - 1; dc = -1; } else { c = rect.x + rect.w; dc = 1; }
  for (let i = 0; i < 4; i++) {
    if (!cv.inB(c, r)) break;
    const t = cv.tileAt(c, r);
    if (t === 'road') break; // reached the street
    if (t === 'grass') cv.set(c, r, 'dirt', true);
    c += dc; r += dr;
  }
}

function fillCoreCell(cv: Canvas, w: Ward, info: CellInfo, nid: number[][], loc: string) {
  const id = info.id;
  const inCell = (c: number, r: number) => cv.inB(c, r) && nid[r]?.[c] === id;
  if (w === 'plaza') {
    for (let r = info.y0; r <= info.y1; r++) for (let c = info.x0; c <= info.x1; c++) if (inCell(c, r) && cv.tileAt(c, r) === 'grass') cv.set(c, r, 'road', true);
    if (cv.inB(info.cc, info.cr)) place(cv, { id: `prop:${loc}-fountain`, tag: 'fountain', kind: 'prop', at: { c: info.cc, r: info.cr } });
    poissonScatter(cv, rectOf(info), { tags: ['market_stall', 'crate', 'barrel', 'sack'], r: 2, max: 6, blocks: true, filter: (c, r) => inCell(c, r) && cv.tileAt(c, r) === 'road' && cv.isFree(c, r) });
    placeActors(cv, info, inCell, 'road', ['villager', 'villager_woman', 'dog'], 3, `npc:${loc}-plaza`);
    return;
  }
  if (w === 'park') {
    // a DESIGNED green: a fountain/statue centrepiece, benches around it, framing trees + flower beds and
    // a couple of strollers — a town park, never bare grass.
    const cc = info.cc, cr = info.cr;
    if (cv.inB(cc, cr) && cv.isFree(cc, cr)) place(cv, { id: `prop:${loc}-park-${id}`, tag: cv.rng() < 0.5 ? 'fountain' : 'statue', kind: 'prop', at: { c: cc, r: cr } });
    for (const [dc, dr] of [[-2, 0], [2, 0], [0, -2], [0, 2]] as const) { const c = cc + dc, r = cr + dr; if (cv.inB(c, r) && inCell(c, r) && cv.tileAt(c, r) === 'grass' && cv.isFree(c, r)) place(cv, { id: `prop:${loc}-pb-${id}-${c}-${r}`, tag: 'stone_bench', kind: 'prop', at: { c, r } }); }
    poissonScatter(cv, rectOf(info), { tags: ['tree', 'tree_autumn', 'tree_pine', 'bush'], r: 2, max: 10, blocks: true, filter: (c, r) => inCell(c, r) && cv.tileAt(c, r) === 'grass' && cv.isFree(c, r) });
    poissonScatter(cv, rectOf(info), { tags: ['flowers', 'flowers_blue', 'flowers_yellow', 'flowers_red', 'grass_tuft'], r: 1, max: 16, blocks: false, filter: (c, r) => inCell(c, r) && cv.tileAt(c, r) === 'grass' && cv.isFree(c, r) });
    placeActors(cv, info, inCell, 'grass', ['villager', 'villager_woman', 'dog'], 2, `npc:${loc}-park`);
    return;
  }
  // Fill a node with a FEW big, irregular-shaped buildings (fewer-but-bigger, not many tiny squares):
  // reserve a 1-tile setback against the cobble seams (apron room), then greedily take the fattest
  // buildable rect, clamp it to a sensible footprint anchored to its street side, and drop a SHAPED
  // compound (L/T/U/+ whenever ≥11). Repeat for the next big rect, capped at MAXB. The leftover (arms,
  // rear, slivers, the courtyard) becomes the tended garden. Doors face the street.
  const MIN = 7, MAXW = 16, MAXH = 14, MAXB = 3;
  const grand = propClass(w) === 'grand';
  const used = new Set<string>();
  const k = (c: number, r: number) => `${c},${r}`;
  const streetAdj = (c: number, r: number) => cv.tileAt(c, r - 1) === 'road' || cv.tileAt(c, r + 1) === 'road' || cv.tileAt(c - 1, r) === 'road' || cv.tileAt(c + 1, r) === 'road';
  const buildable = (c: number, r: number) => inCell(c, r) && cv.tileAt(c, r) === 'grass' && !used.has(k(c, r));
  const claim = (R: { x: number; y: number; w: number; h: number }) => { for (let r = R.y - 1; r <= R.y + R.h; r++) for (let c = R.x - 1; c <= R.x + R.w; c++) used.add(k(c, r)); };
  const secondary: BuildingType[] = grand || propClass(w) === 'craft' ? ['house', 'workshop'] : ['house', 'house'];
  for (let r = info.y0; r <= info.y1; r++) for (let c = info.x0; c <= info.x1; c++) if (inCell(c, r) && cv.tileAt(c, r) === 'grass' && streetAdj(c, r)) used.add(k(c, r)); // setback ring
  const bestSide = (R: { x: number; y: number; w: number; h: number }): 'north' | 'south' | 'east' | 'west' | null => {
    const s = { north: 0, south: 0, east: 0, west: 0 };
    for (let x = R.x; x < R.x + R.w; x++) for (let d = 1; d <= 2; d++) { if (cv.tileAt(x, R.y - d) === 'road') s.north++; if (cv.tileAt(x, R.y + R.h - 1 + d) === 'road') s.south++; }
    for (let y = R.y; y < R.y + R.h; y++) for (let d = 1; d <= 2; d++) { if (cv.tileAt(R.x - d, y) === 'road') s.west++; if (cv.tileAt(R.x + R.w - 1 + d, y) === 'road') s.east++; }
    const [side, v] = Object.entries(s).sort((a, b) => b[1] - a[1])[0]!;
    return v > 0 ? (side as 'north' | 'south' | 'east' | 'west') : null;
  };
  // Clamp a big rect to a building footprint, anchored to its street side (centred on the other axis).
  const clampLot = (big: { x: number; y: number; w: number; h: number }, side: 'north' | 'south' | 'east' | 'west') => {
    const W = Math.min(big.w, MAXW), H = Math.min(big.h, MAXH);
    let x = big.x + ((big.w - W) >> 1), y = big.y + ((big.h - H) >> 1);
    if (side === 'north') y = big.y; else if (side === 'south') y = big.y + big.h - H; else if (side === 'west') x = big.x; else x = big.x + big.w - W;
    return { x, y, w: W, h: H };
  };
  let n = 0;
  const emit = (lot: { x: number; y: number; w: number; h: number }, door: 'north' | 'south' | 'east' | 'west') => {
    if (lot.w < 5 || lot.h < 5) { claim(lot); return; }
    const type: BuildingType = n === 0 ? (w as BuildingType) : (secondary[(n - 1) % secondary.length] ?? 'house');
    compound(cv, lot, type, { shape: pickShape(lot, true, cv.rng), door, locationId: loc, id: `bldg:${loc}-${id}-${n}` });
    carveFront(cv, lot, door);
    claim(lot); n++;
  };
  for (let guard = 0; guard < 8 && n < MAXB; guard++) {
    const big = maxRect(buildable, info.x0, info.y0, info.x1, info.y1);
    if (!big || big.w < MIN || big.h < MIN) break;
    const side = bestSide(big);
    if (!side) { claim(big); continue; } // interior rect → tended garden
    emit(clampLot(big, side), side); // one big shaped building; leftover re-picked for the next or a garden
  }
  if (n === 0) { // small-cell fallback: one cottage on the largest grass rect
    const r2 = maxRect((c, r) => inCell(c, r) && cv.tileAt(c, r) === 'grass', info.x0, info.y0, info.x1, info.y1);
    if (r2 && r2.w >= 4 && r2.h >= 4) building(cv, { x: r2.x, y: r2.y, w: Math.min(6, r2.w), h: Math.min(6, r2.h) }, 'house', { door: pickDoor(cv, r2), locationId: loc, id: `bldg:${loc}-${id}-0` });
  }
  // TENDED courtyard/garden on the leftover grass (block interiors, rear slabs, arms, the setback band) —
  // a kitchen-garden so a node never reads as bare grass: a well/fountain focal point, then dense planting
  // (bushes/crops/fences/a few trees) + flower beds.
  if (cv.inB(info.cc, info.cr) && cv.isFree(info.cc, info.cr) && cv.tileAt(info.cc, info.cr) === 'grass' && cv.rng() < 0.45)
    place(cv, { id: `prop:${loc}-yard-${id}`, tag: 'fountain', kind: 'prop', at: { c: info.cc, r: info.cr } });
  poissonScatter(cv, rectOf(info), { tags: ['bush', 'bush', 'fence', 'woodpile', 'tree', ...WARD_PROPS[propClass(w)]!], r: 2, max: 9, blocks: true, filter: (c, r) => inCell(c, r) && cv.tileAt(c, r) === 'grass' && cv.isFree(c, r) });
  poissonScatter(cv, rectOf(info), { tags: ['flowers', 'flowers_blue', 'flowers_yellow', 'grass_tuft', 'mushroom'], r: 1, max: 14, blocks: false, filter: (c, r) => inCell(c, r) && cv.tileAt(c, r) === 'grass' && cv.isFree(c, r) });
}

/** The preserved extramural ring → flavour: farmsteads, a camp by a gate, a roadside vendor. */
function fillExtramural(cv: Canvas, m: ReturnType<typeof buildCityMesh>, nid: number[][], GRID: number, loc: string, rng: () => number) {
  const ext = cellInfos(m, nid, GRID, 'extramural');
  if (!ext.size) return;
  let campId = -1, campBest = Infinity;
  for (const [id, i] of ext) if (i.nearGate < campBest) { campBest = i.nearGate; campId = id; }
  for (const [id, info] of ext) {
    const inCell = (c: number, r: number) => cv.inB(c, r) && nid[r]?.[c] === id;
    if (id === campId && m.wall) { if (cv.inB(info.cc, info.cr)) vignette(cv, { c: info.cc, r: info.cr }, 'camp', `camp-${loc}-${id}`); continue; }
    if (rng() < 0.5) {
      // farmstead: a cottage + an orchard + a couple of fences
      const rect = maxRect((c, r) => inCell(c, r) && cv.tileAt(c, r) === 'grass', info.x0, info.y0, info.x1, info.y1);
      if (rect && rect.w >= 4 && rect.h >= 4) building(cv, { x: rect.x, y: rect.y, w: Math.min(6, rect.w), h: Math.min(6, rect.h) }, 'house', { door: 'south', locationId: loc, id: `bldg:${loc}-farm-${id}` });
      poissonScatter(cv, rectOf(info), { tags: ['tree', 'bush', 'fence'], r: 2, max: 7, blocks: true, filter: (c, r) => inCell(c, r) && cv.tileAt(c, r) === 'grass' && cv.isFree(c, r) });
    } else {
      poissonScatter(cv, rectOf(info), { tags: ['grass_tuft', 'bush', 'flowers', 'tree'], r: 3, max: 4, blocks: false, filter: (c, r) => inCell(c, r) && cv.tileAt(c, r) === 'grass' && cv.isFree(c, r) });
    }
  }
  // roadside vendor just outside a gate
  const gates = m.wall?.gates ?? [];
  if (gates.length) {
    const half = cellMapHalf(m);
    const toTile = (p: Vec2) => ({ c: Math.round((p.x - (m.center.x - half)) * (GRID / (2 * half)) - 0.5), r: Math.round(((m.center.y + half) - p.y) * (GRID / (2 * half)) - 0.5) });
    const g = toTile(gates[0]!);
    for (const [dc, dr] of [[0, 2], [2, 0], [0, -2], [-2, 0], [2, 2]] as const) {
      const c = g.c + dc, r = g.r + dr;
      if (cv.inB(c, r) && cv.tileAt(c, r) === 'grass' && cv.isFree(c, r)) { place(cv, { id: `prop:${loc}-vendor`, tag: 'market_stall', kind: 'prop', at: { c, r } }); if (cv.inB(c + 1, r) && cv.isFree(c + 1, r)) place(cv, { id: `npc:${loc}-vendor`, tag: 'villager', kind: 'actor', role: 'npc', at: { c: c + 1, r } }); break; }
    }
  }
  // a forest framing the countryside (dense at the rural edge — deliberate, not a uniform field scatter)
  poissonScatter(cv, { x: 0, y: 0, w: GRID, h: GRID }, { tags: ['tree', 'tree_pine', 'tree_autumn', 'bush'], r: 2, max: 400, blocks: true, filter: (c, r) => m.patches[nid[r]?.[c] ?? -1]?.zone === 'rural' && cv.tileAt(c, r) === 'grass' && cv.isFree(c, r) });
}

const cellMapHalf = (m: ReturnType<typeof buildCityMesh>) => m.viewExtent * 1.1;

/** Build a tiled, lived-in SceneMap from the block-centric mesh. */
export function realizeCityMesh(seed: number, opts: CityMeshOpts = {}): SceneMap {
  const m = buildCityMesh(seed, opts);
  const half = cellMapHalf(m);
  const GRID = Math.max(60, Math.min(160, Math.round(2 * half * 0.9)));
  const SCALE = GRID / (2 * half);
  const cv = new Canvas(GRID, GRID, seed, 'grass');
  const loc = `loc:lab-citymesh-${seed}`;
  const tileWorld = (c: number, r: number) => ({ wx: m.center.x - half + (c + 0.5) / SCALE, wy: m.center.y + half - (r + 0.5) / SCALE });
  const toTile = (p: Vec2) => ({ c: Math.round((p.x - (m.center.x - half)) * SCALE - 0.5), r: Math.round(((m.center.y + half) - p.y) * SCALE - 0.5) });
  const zoneOf = (id: number): Zone => m.patches[id]?.zone ?? 'rural';

  // 1. Nearest patch per tile → ground + street seams.
  const nid: number[][] = Array.from({ length: GRID }, () => new Array<number>(GRID));
  for (let r = 0; r < GRID; r++) for (let c = 0; c < GRID; c++) { const { wx, wy } = tileWorld(c, r); nid[r]![c] = m.find(wx, wy); }
  for (let r = 0; r < GRID; r++) for (let c = 0; c < GRID; c++) cv.set(c, r, ZONE_GROUND[zoneOf(nid[r]![c]!)]);

  // 2. Streets: a core tile on a seam between two core cells → cobble.
  for (let r = 0; r < GRID; r++) for (let c = 0; c < GRID; c++) {
    const id = nid[r]![c]!;
    if (zoneOf(id) !== 'core') continue;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const c2 = c + dc, r2 = r + dr;
      if (c2 < 0 || r2 < 0 || c2 >= GRID || r2 >= GRID) continue;
      const id2 = nid[r2]![c2]!;
      if (id2 !== id && zoneOf(id2) === 'core') { cv.set(c, r, 'road', true); break; }
    }
  }

  // 3. Curtain wall + carved gates (+ a guard just inside each gate).
  if (m.wall) {
    const ring = m.wall.ring.map(toTile);
    for (let i = 0; i < ring.length; i++) lineTiles(cv, ring[i]!, ring[(i + 1) % ring.length]!, 'wall', false);
    const ctr = toTile(m.center);
    m.wall.gates.forEach((gate, gi) => {
      const t = toTile(gate);
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (cv.inB(t.c + dc, t.r + dr)) cv.set(t.c + dc, t.r + dr, 'road', true);
      const ic = Math.sign(ctr.c - t.c), ir = Math.sign(ctr.r - t.r); // one step inward
      const gc = t.c + ic, gr = t.r + ir;
      if (cv.inB(gc, gr) && cv.isFree(gc, gr)) place(cv, { id: `npc:${loc}-gate-${gi}`, tag: 'knight', kind: 'actor', role: 'npc', at: { c: gc, r: gr } });
    });
  }

  // 4. Zone the core into wards and fill each cell.
  const core = cellInfos(m, nid, GRID, 'core');
  const wards = assignWards(m, core, cv.rng);
  for (const [id, info] of core) fillCoreCell(cv, wards.get(id) ?? 'house', info, nid, loc);

  // 5. Extramural flavour (farms, camp, vendor) + the rural treeline.
  fillExtramural(cv, m, nid, GRID, loc, cv.rng);

  // 5b. Tree-lined lanes: a sparse row of trees on the grass beside core streets.
  poissonScatter(cv, { x: 0, y: 0, w: GRID, h: GRID }, { tags: ['tree', 'tree_autumn', 'bush'], r: 4, max: 50, blocks: true, filter: (c, r) => zoneOf(nid[r]![c]!) === 'core' && cv.tileAt(c, r) === 'grass' && cv.isFree(c, r) && ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).some(([dc, dr]) => cv.tileAt(c + dc, r + dr) === 'road') });

  // 6. A few folk wandering the streets.
  const roads: { c: number; r: number }[] = [];
  for (let r = 0; r < GRID; r++) for (let c = 0; c < GRID; c++) if (cv.tileAt(c, r) === 'road' && zoneOf(nid[r]![c]!) === 'core' && cv.isFree(c, r)) roads.push({ c, r });
  for (let i = roads.length - 1; i > 0; i--) { const j = Math.floor(cv.rng() * (i + 1)); [roads[i], roads[j]] = [roads[j]!, roads[i]!]; }
  const folk = ['villager', 'villager_woman', 'ranger', 'dog'];
  for (let k = 0; k < Math.min(6, roads.length); k++) place(cv, { id: `npc:${loc}-folk-${k}`, tag: folk[k % folk.length]!, kind: 'actor', role: 'npc', at: roads[k]! });

  return finalize(cv, { locationId: loc, biome: 'village', lighting: 'day', grammar: 'town-square', outdoor: true, skipReachability: true, skipDecals: true });
}
