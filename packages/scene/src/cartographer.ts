/**
 * The Cartographer (docs/SCENE-CONTRACTS.md, surface C) — the deterministic resolver that
 * turns a Director's semantic `SceneComposition` into a concrete, frozen `SceneMap`.
 *
 * Pure + seed-stable: same composition → byte-identical map. This is the consistency
 * guarantor — it owns ALL geometry (zones→tiles, anchors→positions, footprints, snapping,
 * ambiance scatter) so the LLMs never touch a coordinate. Output satisfies validateSceneMap
 * by construction (actors land on walkable tiles, fixtures never overlap, all in-bounds).
 */

import {
  FEET_PER_TILE,
  type AmbianceItem,
  type LayoutGrammar,
  type MapObject,
  type Placement,
  type SceneComposition,
  type SceneMap,
} from '@mythweaver/shared';
import { propDef, terrainWalkable } from './catalog.js';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Deterministic PRNG (mulberry32) — reproducible from the scene seed. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Map each grammar zone to a grid rectangle. Simple + deterministic; refine per grammar later. */
function zoneRects(grammar: LayoutGrammar, cols: number, rows: number): Record<string, Rect> {
  if (grammar === 'enclosed-interior') {
    return {
      wall: { x: 0, y: 0, w: cols, h: rows },
      floor: { x: 1, y: 1, w: cols - 2, h: rows - 2 },
      back: { x: 1, y: 1, w: cols - 2, h: Math.max(1, Math.floor((rows - 2) * 0.4)) },
      entrance: { x: Math.max(1, Math.floor(cols / 2) - 1), y: rows - 2, w: 3, h: 1 },
    };
  }
  if (grammar === 'town-square') {
    const waterH = Math.max(2, Math.floor(rows * 0.16)); // the sea along the bottom
    const topH = Math.max(2, Math.floor(rows * 0.16)); // a band where houses line the back
    const plazaY = topH + 1;
    const plazaH = Math.max(2, rows - waterH - topH - 2);
    const plaza: Rect = { x: 2, y: plazaY, w: cols - 4, h: plazaH };
    const cx = Math.floor(cols / 2);
    const cy = plazaY + Math.floor(plazaH / 2);
    return {
      perimeter: { x: 0, y: 0, w: cols, h: rows },
      'building-row': { x: 1, y: 1, w: cols - 2, h: topH }, // houses along the top
      plaza,
      commons: plaza,
      center: { x: cx - 1, y: cy - 1, w: 2, h: 2 }, // fountain / landmark slot
      'market-row': { x: plaza.x + 1, y: plaza.y + plaza.h - 1, w: plaza.w - 2, h: 1 }, // a line of stalls
      street: { x: cx - 1, y: 0, w: 3, h: rows - waterH }, // a road through the square
      waterside: { x: 0, y: rows - waterH, w: cols, h: waterH },
    };
  }
  // open-outdoor
  const waterH = Math.max(2, Math.floor(rows * 0.22));
  const topH = Math.max(2, Math.floor(rows * 0.18));
  return {
    waterside: { x: 0, y: rows - waterH, w: cols, h: waterH },
    'building-row': { x: 1, y: 1, w: cols - 2, h: topH },
    path: { x: Math.max(1, Math.floor(cols / 2) - 1), y: 0, w: 3, h: rows - waterH },
    commons: { x: 2, y: topH + 1, w: cols - 4, h: Math.max(1, rows - waterH - topH - 2) },
    perimeter: { x: 0, y: 0, w: cols, h: topH },
  };
}

/** Blockout region char → terrain tag (+ whether it's a dense-forest cell). Unknown → grass. */
const BLOCKOUT_REGION: Record<string, { terrain: string; forest?: boolean }> = {
  G: { terrain: 'grass' },
  P: { terrain: 'dirt' },
  W: { terrain: 'water' },
  T: { terrain: 'grass', forest: true },
  S: { terrain: 'stone' },
  '#': { terrain: 'wall' },
};
/** Trees that fill a forest cell — weighted to full trees so a treeline reads as a solid mass. */
const FOREST_TREE_TAGS = ['tree', 'tree', 'tree_pine', 'tree_pine', 'tree_autumn', 'bush'] as const;

export function buildSceneMap(comp: SceneComposition): SceneMap {
  const cols = Math.max(1, comp.grid.cols);
  const rows = Math.max(1, comp.grid.rows);
  const rand = makeRng(comp.seed);
  const zones = zoneRects(comp.grammar, cols, rows);
  // The Director painted a coarse map — render FROM it (orientation, treelines, sides, rooms)
  // instead of the semantic zones, which can't carry composition. Every scene kind can be painted.
  const useBlockout = !!comp.blockout && comp.blockout.grid.length > 0;
  const isInterior = comp.grammar === 'enclosed-interior';

  // 1) Terrain layer.
  let tiles: string[][];
  const forestCells: { c: number; r: number }[] = [];
  if (useBlockout) {
    const bg = comp.blockout!.grid;
    tiles = Array.from({ length: rows }, (_, y) =>
      Array.from({ length: cols }, (_, x) => {
        const ch = (bg[y]?.[x] ?? 'G').toUpperCase();
        const reg = BLOCKOUT_REGION[ch] ?? BLOCKOUT_REGION['G']!;
        if (reg.forest && !isInterior) forestCells.push({ c: x, r: y });
        return reg.terrain;
      }),
    );
    // Interior safety: a roofed room must be a CLOSED box. Force the outer ring to wall (the Director
    // sometimes leaves a gap) and normalise interior ground to stone floor — keeping any walls/pillars
    // it painted, but never grass/water/trees indoors.
    if (isInterior) {
      for (let y = 0; y < rows; y++)
        for (let x = 0; x < cols; x++) {
          const border = x === 0 || y === 0 || x === cols - 1 || y === rows - 1;
          if (border) tiles[y]![x] = 'wall';
          else if (tiles[y]![x] !== 'wall') tiles[y]![x] = 'stone';
        }
      if (rows > 2 && cols > 2) tiles[Math.floor(rows / 2)]![Math.floor(cols / 2)] = 'stone'; // guarantee floor
    }
  } else {
    // base everywhere, then paint each region's zone rect (in order).
    tiles = Array.from({ length: rows }, () => Array.from({ length: cols }, () => comp.terrain.base));
    for (const region of comp.terrain.regions) {
      const r = zones[region.zone];
      if (!r) continue;
      for (let y = r.y; y < r.y + r.h; y++)
        for (let x = r.x; x < r.x + r.w; x++) {
          const row = tiles[y];
          if (row && x >= 0 && x < cols && y >= 0 && y < rows) row[x] = region.tag;
        }
    }
    // An enclosed interior is a walled room: force a non-walkable border ring and a WALKABLE floor
    // inside — regardless of the order the Director sent terrain regions. (The 'wall' zone spans the
    // whole grid, so a late wall paint would otherwise bury the floor and leave nowhere to stand,
    // collapsing every placement onto one cell.)
    if (comp.grammar === 'enclosed-interior') {
      const floorTag = terrainWalkable(comp.terrain.base) ? comp.terrain.base : 'stone';
      for (let y = 0; y < rows; y++)
        for (let x = 0; x < cols; x++) {
          const border = x === 0 || y === 0 || x === cols - 1 || y === rows - 1;
          if (border) tiles[y]![x] = 'wall';
          else if (!terrainWalkable(tiles[y]![x]!)) tiles[y]![x] = floorTag;
        }
    }
  }
  const walkable: boolean[][] = tiles.map((row) => row.map((t) => terrainWalkable(t)));
  const occ: boolean[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => false));

  // Dense-fill forest cells with trees (a treeline is a BARRIER, so tree'd cells are non-walkable).
  // This is what makes "thick lines of trees" actually read as a wall of forest.
  const forestAmbiance: AmbianceItem[] = [];
  if (useBlockout) {
    for (const fc of forestCells) {
      if (rand() >= 0.85) continue; // a few gaps so the line isn't a perfect rectangle
      const tag = FOREST_TREE_TAGS[Math.floor(rand() * FOREST_TREE_TAGS.length)]!;
      forestAmbiance.push({ tag, col: fc.c, row: fc.r });
      walkable[fc.r]![fc.c] = false;
    }
  }

  const inB = (c: number, r: number) => c >= 0 && c < cols && r >= 0 && r < rows;
  const free = (c: number, r: number) => inB(c, r) && walkable[r]![c] === true && occ[r]![c] === false;
  const footFits = (c: number, r: number, w: number, h: number) => {
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) if (!free(c + dx, r + dy)) return false;
    return true;
  };

  /** Cells of a rect, shuffled by seed (so placement is varied but reproducible). */
  const cellsOf = (rect: Rect): { c: number; r: number }[] => {
    const cells: { c: number; r: number }[] = [];
    for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) if (inB(x, y)) cells.push({ c: x, r: y });
    for (let i = cells.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = cells[i]!;
      cells[i] = cells[j]!;
      cells[j] = tmp;
    }
    return cells;
  };

  const footprintOf = (tag: string, kind: string): { w: number; h: number } => {
    if (kind === 'fixture') {
      const d = propDef(tag);
      return { w: d?.w ?? 1, h: d?.h ?? 1 };
    }
    return { w: 1, h: 1 }; // props + actors are 1x1 for now
  };

  const placedPos = new Map<string, { c: number; r: number }>();
  const placedCells: { c: number; r: number; kind: string }[] = []; // for anti-cluster spacing
  const ADJ = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [-1, -1],
    [1, -1],
    [-1, 1],
  ] as const;

  // Nearest in-bounds cell that fits the footprint to a target point — resolve OUTWARD from the
  // ideal, so an absolute anchor like 'center' lands at the center even when the exact cell is taken.
  const nearestFit = (tc: number, tr: number, fp: { w: number; h: number }): { c: number; r: number } | null => {
    let best: { c: number; r: number } | null = null;
    let bestD = Infinity;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        if (!footFits(c, r, fp.w, fp.h)) continue;
        const d = (c - tc) * (c - tc) + (r - tr) * (r - tr);
        if (d < bestD) {
          bestD = d;
          best = { c, r };
        }
      }
    return best;
  };

  const cxC = (cols - 1) / 2;
  const cyC = (rows - 1) / 2;
  // Edge/zone anchors resolve to a BAND, so many props sharing 'north-edge' spread into a LINE
  // along the edge instead of piling on one point. ('center' is handled separately as a point —
  // the single centrepiece.) Returns null for an unknown anchor.
  const anchorBand = (a: string): Rect | null => {
    const tb = Math.max(2, Math.floor(rows * 0.2)); // top/bottom band thickness
    const sb = Math.max(2, Math.floor(cols * 0.16)); // left/right band thickness
    switch (a) {
      case 'north':
      case 'north-edge':
        return { x: 0, y: 0, w: cols, h: tb };
      case 'south':
      case 'south-edge':
        return { x: 0, y: rows - tb, w: cols, h: tb };
      case 'west':
      case 'west-edge':
        return { x: 0, y: 0, w: sb, h: rows };
      case 'east':
      case 'east-edge':
        return { x: cols - sb, y: 0, w: sb, h: rows };
      case 'waterside':
        return zones['waterside'] ?? { x: 0, y: rows - tb, w: cols, h: tb };
      case 'entrance':
        return zones['entrance'] ?? { x: Math.max(0, Math.floor(cols / 2) - 1), y: rows - 2, w: 3, h: 2 };
      default:
        return null;
    }
  };

  // Pick a fitting cell in `rect` that stays AWAY from already-placed objects of the same kind.
  // cellsOf is seed-shuffled; we then choose the best-spread candidate so actors/fixtures don't bunch.
  const pickSpread = (rect: Rect, fp: { w: number; h: number }, kind: string): { c: number; r: number } | null => {
    let best: { c: number; r: number } | null = null;
    let bestScore = -1;
    let scanned = 0;
    for (const cell of cellsOf(rect)) {
      if (!footFits(cell.c, cell.r, fp.w, fp.h)) continue;
      let md = Infinity;
      for (const q of placedCells) if (q.kind === kind) md = Math.min(md, Math.max(Math.abs(q.c - cell.c), Math.abs(q.r - cell.r)));
      const score = md === Infinity ? 999 : md;
      if (score > bestScore) {
        bestScore = score;
        best = cell;
      }
      if (bestScore >= 3 || ++scanned > 80) break; // well-spread enough / bounded scan
    }
    return best;
  };

  const resolve = (p: Placement, fp: { w: number; h: number }): { c: number; r: number } => {
    // near:<id> → an open cell adjacent to the (already-placed) referent.
    if (p.anchor?.startsWith('near:')) {
      const ref = placedPos.get(p.anchor.slice(5));
      if (ref) for (const [dc, dr] of ADJ) if (footFits(ref.c + dc, ref.r + dr, fp.w, fp.h)) return { c: ref.c + dc, r: ref.r + dr };
    }
    // Absolute base anchor. 'center' → the single nearest cell (the centrepiece); edge/zone
    // anchors → spread along a BAND so a shared anchor forms a line, not a pile.
    if (p.anchor && !p.anchor.startsWith('in:') && !p.anchor.startsWith('near:')) {
      if (p.anchor === 'center') {
        const hit = nearestFit(cxC, cyC, fp);
        if (hit) return hit;
      } else {
        const band = anchorBand(p.anchor);
        if (band) {
          const hit = pickSpread(band, fp, p.kind);
          if (hit) return hit;
        }
      }
    }
    // Otherwise place within the zone, spread away from same-kind neighbors.
    const zoneName = p.anchor?.startsWith('in:') ? p.anchor.slice(3) : p.zone;
    const rect = zones[zoneName] ?? zones[p.zone] ?? { x: 0, y: 0, w: cols, h: rows };
    return (
      pickSpread(rect, fp, p.kind) ??
      pickSpread({ x: 0, y: 0, w: cols, h: rows }, fp, p.kind) ?? // fallback: anywhere walkable
      { c: Math.floor(cols / 2), r: Math.floor(rows / 2) } // degenerate last resort — center, not a pile at the origin
    );
  };

  // Blockout placement: snap each entity to the nearest walkable cell to the coordinate the Director
  // painted for it (ignores semantic anchors — the painted cell IS the intent). No cell → centre.
  const cellById = new Map((comp.blockout?.cells ?? []).map((c) => [c.id, c]));
  const resolveBlockout = (p: Placement, fp: { w: number; h: number }): { c: number; r: number } => {
    const cell = cellById.get(p.id);
    // A fountain/well is the centrepiece of a settlement square — keep it centred even when painted
    // off-centre, so the town-square's read survives. Everything else honours its painted cell.
    const centrepiece = comp.grammar === 'town-square' && /fountain|well/.test(p.tag);
    const tc = centrepiece ? cxC : cell ? cell.col : Math.round(cxC);
    const tr = centrepiece ? cyC : cell ? cell.row : Math.round(cyC);
    return (
      nearestFit(tc, tr, fp) ??
      pickSpread({ x: 0, y: 0, w: cols, h: rows }, fp, p.kind) ??
      { c: Math.floor(cols / 2), r: Math.floor(rows / 2) }
    );
  };

  // Place non-near first (fixtures → props → actors), then near-anchored ones.
  const rank = (k: string) => (k === 'fixture' ? 0 : k === 'prop' ? 1 : 2);
  const order = [...comp.placements].sort((a, b) => {
    const na = a.anchor?.startsWith('near:') ? 1 : 0;
    const nb = b.anchor?.startsWith('near:') ? 1 : 0;
    return na !== nb ? na - nb : rank(a.kind) - rank(b.kind);
  });

  const objects: MapObject[] = [];
  for (const p of order) {
    const fp = footprintOf(p.tag, p.kind);
    const pos = useBlockout ? resolveBlockout(p, fp) : resolve(p, fp);
    for (let dy = 0; dy < fp.h; dy++)
      for (let dx = 0; dx < fp.w; dx++) {
        const cc = pos.c + dx;
        const rr = pos.r + dy;
        if (inB(cc, rr)) {
          occ[rr]![cc] = true;
          if (p.kind === 'fixture') walkable[rr]![cc] = false; // a building blocks the tiles it sits on
        }
      }
    placedPos.set(p.id, pos);
    placedCells.push({ c: pos.c, r: pos.r, kind: p.kind });
    objects.push({
      id: p.id,
      kind: p.kind,
      ...(p.role ? { role: p.role } : {}),
      tag: p.tag,
      ...(p.name ? { name: p.name } : {}),
      col: pos.c,
      row: pos.r,
      footprint: fp,
      facing: p.facing ?? 'down',
      visible: p.visible,
      zone: p.zone,
      ...(p.anchor ? { anchorRef: p.anchor } : {}),
    });
  }

  // Ambiance. In blockout mode the forest fill IS the ambiance (already placed, intentionally dense);
  // otherwise seed-scatter decor biased to the PERIMETER so the playable middle stays legible, and
  // hard-capped so a village never reads as a forest. Tree sprites are tall/wide, so a little goes far.
  const ambiance: AmbianceItem[] = useBlockout ? forestAmbiance : [];
  const tags = comp.ambiance.tags;
  if (!useBlockout && tags.length > 0 && comp.ambiance.density > 0) {
    const AMBIANCE_CAP = 12;
    const band = 3; // cells from the edge counted as "perimeter"
    const candidates = cellsOf({ x: 0, y: 0, w: cols, h: rows }).filter((c) => free(c.c, c.r));
    const edge = candidates.filter((c) => c.c < band || c.c >= cols - band || c.r < band || c.r >= rows - band);
    const pool = edge.length >= 8 ? edge : candidates; // frame the scene; fall back if there's no room
    const count = Math.min(pool.length, AMBIANCE_CAP, Math.floor(pool.length * comp.ambiance.density));
    for (let i = 0; i < count; i++) {
      const cell = pool[i]!;
      const tag = tags[Math.floor(rand() * tags.length)]!;
      occ[cell.r]![cell.c] = true;
      ambiance.push({ tag, col: cell.c, row: cell.r });
    }
  }

  return {
    locationId: comp.locationId,
    seed: comp.seed,
    biome: comp.biome,
    lighting: comp.lighting,
    grammar: comp.grammar,
    grid: { cols, rows, feetPerTile: FEET_PER_TILE },
    tiles,
    walkable,
    objects,
    ambiance,
    entrances: [], // building entrances arrive with the buildings/interiors phase
  };
}
