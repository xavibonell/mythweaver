import { describe, expect, it } from 'vitest';
import type { SceneMap } from '@mythweaver/shared';
import { buildSpatialIndex, distanceFt, findPath, hasLineOfSight, spatialIndex, bumpSpatialVersion, travelTime, whereIs } from './oracle.js';

/** 12x7 fixture: west bank | 3-col deep-water band | east bank; a roofed 3x2 hut on the west;
 *  a wall column with a gap for LOS tests. Legend: g grass, W water_deep, F wood_floor, w wall. */
function fixtureMap(): SceneMap {
  const rowsSpec = [
    'ggggwWWWgggg',
    'gFFgwWWWgggg',
    'gFFgwWWWgggg',
    'gggggWWWgggg', // wall gap at (4,3)
    'ggggwWWWgggg',
    'ggggwWWWgggg',
    'ggggwWWWgggg',
  ];
  const tiles = rowsSpec.map((r) => [...r].map((ch) => (ch === 'g' ? 'grass' : ch === 'W' ? 'water_deep' : ch === 'F' ? 'wood_floor' : 'wall_stone')));
  const walkable = rowsSpec.map((r) => [...r].map((ch) => ch === 'g' || ch === 'F'));
  return {
    locationId: 'loc:test',
    seed: 1,
    biome: 'village',
    lighting: 'day',
    grammar: 'open-outdoor',
    grid: { cols: 12, rows: 7, feetPerTile: 5 },
    tiles,
    walkable,
    objects: [
      { id: 'pc:a', kind: 'actor', role: 'pc', tag: 'knight', name: 'A', col: 1, row: 5, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
      { id: 'npc:b', kind: 'actor', role: 'npc', tag: 'villager', name: 'B', col: 10, row: 5, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
    ],
    ambiance: [],
    entrances: [],
    // Roof over the hut floor cells (cols 1-2, rows 1-2) in 16px render coords.
    roofs: [{ id: 'bldg:hut', faces: [{ pts: [16, 16, 48, 16, 48, 48, 16, 48], top: 0, bot: 0 }], lines: [], sprites: [] }],
  } as unknown as SceneMap;
}

describe('spatial oracle (R1)', () => {
  const map = fixtureMap();
  const idx = buildSpatialIndex(map);

  it('classifies media, keeps walkable[][] authoritative, and derives indoor rooms from roofs', () => {
    expect(idx.unknownTags).toEqual([]);
    const hut = whereIs(idx, { col: 1, row: 1 });
    expect(hut.indoor).toBe(true);
    expect(hut.buildingId).toBe('bldg:hut');
    expect(whereIs(idx, { col: 1, row: 5 }).indoor).toBe(false);
    expect(whereIs(idx, { col: 6, row: 3 }).medium).toBe('water-deep');
  });

  it('R0 bit-parity: with swim=none the traversable set IS walkable[][]', () => {
    // west→east requires crossing water; without swim there is no route and the wall is water.
    const r = findPath(idx, { col: 1, row: 5 }, { col: 10, row: 5 }, { speedFt: 30, swim: 'none' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.blockedBy).toBe('deep-water');
      expect(r.frontier).toBeTruthy(); // the bank — frontier degrade
      expect(r.frontier!.col).toBeLessThanOrEqual(4);
    }
  });

  it('swimming extends passability at PHB double cost; segments split by medium', () => {
    const r = findPath(idx, { col: 1, row: 5 }, { col: 10, row: 5 }, { speedFt: 30, swim: 'double-cost' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const swim = r.segments.find((s) => s.swimming);
      expect(swim?.medium).toBe('water-deep');
      expect(swim?.ft).toBe(15); // 3-tile band
      // total: ground legs at 5ft + 3 water tiles at 10ft each ⇒ strictly more than Chebyshev feet
      expect(r.totalFt).toBeGreaterThan(distanceFt(idx, { col: 1, row: 5 }, { col: 10, row: 5 }));
    }
  });

  it('water walk prices the pool as ground', () => {
    const r = findPath(idx, { col: 1, row: 5 }, { col: 10, row: 5 }, { speedFt: 30, swim: 'none', waterWalk: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.segments.every((s) => !s.swimming)).toBe(true);
  });

  it('LOS: walls block, the gap sees through', () => {
    expect(hasLineOfSight(idx, { col: 1, row: 5 }, { col: 3, row: 5 }).clear).toBe(true);
    expect(hasLineOfSight(idx, { col: 3, row: 5 }, { col: 10, row: 5 }).clear).toBe(false); // wall column
    expect(hasLineOfSight(idx, { col: 3, row: 3 }, { col: 10, row: 3 }).clear).toBe(true); // the gap row
  });

  it('cache: same index until a version bump', () => {
    const i1 = spatialIndex(map);
    expect(spatialIndex(map)).toBe(i1);
    bumpSpatialVersion(map);
    expect(spatialIndex(map)).not.toBe(i1);
  });

  it('travel time: rounds at speed, PHB pace minutes', () => {
    expect(travelTime(60, 30)).toEqual({ rounds: 2, minutes: 0.2 });
  });
});
