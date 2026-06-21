import { describe, expect, it } from 'vitest';
import { type SceneMap, validateSceneMap } from '@mythweaver/shared';
import { buildCityScene, type CityDistrictSpec, type CityRequest } from './city.js';

const ROSTER: CityDistrictSpec[] = [
  { setting: 'a market square with a tavern and shops', builds: ['tavern', 'shop'], npcs: [{ name: 'Marta', look: 'a merchant' }] },
  { setting: 'a temple precinct with a shrine', builds: ['temple', 'house'], npcs: [{ name: 'Cael', look: 'a priest' }] },
  { setting: 'a residential quarter of cottages', builds: ['cottage', 'house'], npcs: [{ name: 'a goodwife', look: 'a villager woman' }] },
  { setting: 'a craftsmen quarter with a smithy', builds: ['smithy', 'shop'], npcs: [{ name: 'Borin', look: 'a dwarf smith' }] },
];

function cityReq(count: number, opts: Partial<CityRequest> = {}): CityRequest {
  return { locationId: 'loc:test-city', districts: Array.from({ length: count }, (_, i) => ROSTER[i % ROSTER.length]!), ...opts };
}

/** BFS the walkable graph from the same start reachabilityCarve picks (no PCs here → bottom-left
 *  walkable cell), returning the set of reachable flat indices. */
function reachableSet(m: SceneMap): Set<number> {
  const { cols, rows } = m.grid;
  const idx = (c: number, r: number) => r * cols + c;
  let start: { c: number; r: number } | null = null;
  for (let r = rows - 1; r >= 0 && !start; r--) for (let c = 0; c < cols && !start; c++) if (m.walkable[r]![c]) start = { c, r };
  const seen = new Set<number>();
  if (!start) return seen;
  const q = [start];
  seen.add(idx(start.c, start.r));
  const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  while (q.length) {
    const cur = q.shift()!;
    for (const [dx, dy] of ORTH) {
      const cc = cur.c + dx, rr = cur.r + dy;
      if (cc >= 0 && cc < cols && rr >= 0 && rr < rows && m.walkable[rr]![cc] && !seen.has(idx(cc, rr))) { seen.add(idx(cc, rr)); q.push({ c: cc, r: rr }); }
    }
  }
  return seen;
}

describe('city stitcher (V2)', () => {
  it('stitches districts into one valid SceneMap (the acceptance gate)', async () => {
    const m = await buildCityScene(cityReq(4, { cols: 2 }));
    expect(validateSceneMap(m)).toEqual({ ok: true, violations: [] });
    expect(m.grammar).toBe('town-square');
    expect(m.grid.feetPerTile).toBe(5);
    expect(m.locationId).toBe('loc:test-city');
  });

  it('produces a grid bigger than a single district, sized from the district packing', async () => {
    const m = await buildCityScene(cityReq(6, { cols: 3 }));
    // 3×2 districts of 24×16 each, with street gutters + margin + wall — comfortably bigger than one town.
    expect(m.grid.cols).toBeGreaterThan(24 * 3);
    expect(m.grid.rows).toBeGreaterThan(16 * 2);
  });

  it('has exact, hole-free tiles/walkable dimensions', async () => {
    const m = await buildCityScene(cityReq(5));
    const { cols, rows } = m.grid;
    expect(m.tiles.length).toBe(rows);
    expect(m.walkable.length).toBe(rows);
    for (let r = 0; r < rows; r++) {
      expect(m.tiles[r]!.length).toBe(cols);
      expect(m.walkable[r]!.length).toBe(cols);
      for (let c = 0; c < cols; c++) expect(typeof m.tiles[r]![c]).toBe('string');
      for (let c = 0; c < cols; c++) expect(m.tiles[r]![c]!.length).toBeGreaterThan(0);
    }
  });

  it('namespaces ids so the merged map has no duplicates, one set per district', async () => {
    const m = await buildCityScene(cityReq(4, { cols: 2 }));
    const ids = m.objects.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length); // no dup ids
    for (let i = 0; i < 4; i++) {
      const re = new RegExp(`-d${i}(#|$)`);
      expect(m.objects.some((o) => re.test(o.id))).toBe(true); // every district contributed objects
    }
  });

  it('keeps every object, ambiance and entrance in-bounds; actors on walkable tiles', async () => {
    const m = await buildCityScene(cityReq(6, { cols: 3 }));
    const { cols, rows } = m.grid;
    for (const o of m.objects) {
      expect(o.col).toBeGreaterThanOrEqual(0);
      expect(o.row).toBeGreaterThanOrEqual(0);
      expect(o.col + o.footprint.w - 1).toBeLessThan(cols);
      expect(o.row + o.footprint.h - 1).toBeLessThan(rows);
      if (o.kind === 'actor') expect(m.walkable[o.row]![o.col]).toBe(true);
    }
    for (const a of m.ambiance) expect(a.col >= 0 && a.col < cols && a.row >= 0 && a.row < rows).toBe(true);
    for (const e of m.entrances) expect(m.walkable[e.row]![e.col]).toBe(true);
  });

  it('connects every actor and entrance into one reachable street network', async () => {
    const m = await buildCityScene(cityReq(6, { cols: 3 }));
    const reach = reachableSet(m);
    const idx = (c: number, r: number) => r * m.grid.cols + c;
    for (const o of m.objects) if (o.kind === 'actor') expect(reach.has(idx(o.col, o.row))).toBe(true);
    for (const e of m.entrances) expect(reach.has(idx(e.col, e.row))).toBe(true);
  });

  it('wraps the city in a walled ring with one walkable gate per side', async () => {
    const m = await buildCityScene(cityReq(4, { cols: 2 })); // wall defaults on
    const { cols, rows } = m.grid;
    const midC = Math.floor(cols / 2), midR = Math.floor(rows / 2);
    // corners are wall (non-walkable)
    for (const [c, r] of [[0, 0], [cols - 1, 0], [0, rows - 1], [cols - 1, rows - 1]] as const) expect(m.walkable[r]![c]).toBe(false);
    // exactly the 4 gates are the walkable border cells, and each is an entrance
    const gates = [[midC, 0], [midC, rows - 1], [0, midR], [cols - 1, midR]] as const;
    for (const [c, r] of gates) {
      expect(m.walkable[r]![c]).toBe(true);
      expect(m.entrances.some((e) => e.col === c && e.row === r)).toBe(true);
    }
  });

  it('omits the wall ring when wall:false', async () => {
    const m = await buildCityScene(cityReq(4, { cols: 2, wall: false }));
    expect(validateSceneMap(m)).toEqual({ ok: true, violations: [] });
    expect(m.tiles[0]![0]!.startsWith('wall')).toBe(false); // perimeter is open street, not wall
  });

  it('coerces fractional/NaN cols + streetWidth to integers (no infinite carve)', async () => {
    // Regression: fractional offsets would put objects on fractional cells and reachabilityCarve's
    // integer-stepping L-carve would never terminate. Guarded inputs must produce a valid map quickly.
    for (const bad of [{ cols: 2.5 }, { streetWidth: 2.5 }, { streetWidth: Number.NaN }, { cols: Number.NaN }] as Partial<CityRequest>[]) {
      const m = await buildCityScene(cityReq(4, bad));
      expect(Number.isInteger(m.grid.cols) && Number.isInteger(m.grid.rows)).toBe(true);
      for (const o of m.objects) expect(Number.isInteger(o.col) && Number.isInteger(o.row)).toBe(true);
      expect(validateSceneMap(m)).toEqual({ ok: true, violations: [] });
    }
  });

  it('is fully deterministic — same request → byte-identical map', async () => {
    const a = await buildCityScene(cityReq(6, { cols: 3 }));
    const b = await buildCityScene(cityReq(6, { cols: 3 }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
