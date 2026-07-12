import { describe, expect, it } from 'vitest';
import type { CharacterSheet, SceneMap } from '@mythweaver/shared';
import { Engine, createInitialState } from '../index.js';

/** The wild-caught staging disaster: pc1 on a one-cell ISLET (sane but roomless — the case that
 *  fooled anchor-by-first-sane-PC), pc2 indoors under a roof, pc3 on walkable water-art. A big
 *  grass field sits south. The guard must regroup all three there — outdoors, dry-looking, adjacent. */
function brokenStagingMap(): SceneMap {
  const cols = 14, rows = 10;
  const tiles = Array.from({ length: rows }, () => Array.from({ length: cols }, () => 'water_deep'));
  const walkable = Array.from({ length: rows }, () => Array.from({ length: cols }, () => false));
  // grass field rows 6-9
  for (let r = 6; r < 10; r++) for (let c = 0; c < cols; c++) { tiles[r]![c] = 'grass'; walkable[r]![c] = true; }
  // islet at (12,1)
  tiles[1]![12] = 'dirt'; walkable[1]![12] = true;
  // hut floor at (2,2)-(3,2) (roofed below)
  for (const c of [2, 3]) { tiles[2]![c] = 'wood_floor'; walkable[2]![c] = true; }
  // dock band with water-art but walkable at (7,3)
  tiles[3]![7] = 'water_deep_t'; walkable[3]![7] = true;
  return {
    locationId: 'loc:broken', seed: 1, biome: 'village', lighting: 'day', grammar: 'open-outdoor',
    grid: { cols, rows, feetPerTile: 5 }, tiles, walkable,
    objects: [
      { id: 'pc:a', kind: 'actor', role: 'pc', tag: 'knight', name: 'A', col: 12, row: 1, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
      { id: 'pc:b', kind: 'actor', role: 'pc', tag: 'mage', name: 'B', col: 2, row: 2, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
      { id: 'pc:c', kind: 'actor', role: 'pc', tag: 'rogue', name: 'C', col: 7, row: 3, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
    ],
    ambiance: [], entrances: [],
    roofs: [{ id: 'bldg:hut', faces: [{ pts: [32, 32, 64, 32, 64, 48, 32, 48], top: 0, bot: 0 }], lines: [], sprites: [] }],
  } as unknown as SceneMap;
}

function sheet(id: string): CharacterSheet {
  return { id, name: id.toUpperCase(), ancestry: 'Human', className: 'Fighter', level: 1, abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, proficiencyBonus: 2, armorClass: 10, maxHitPoints: 8, speedFt: 30, skillProficiencies: [], savingThrowProficiencies: [], attacks: [] };
}

describe('sanitizePartyStaging (the frozen-session load guard)', () => {
  it('islet anchor + indoor PC + water-art PC → all regrouped on open grass, adjacent', () => {
    const state = createInitialState({ sessionId: 's', scenarioId: 't', startSceneId: 'x', party: [sheet('a'), sheet('b'), sheet('c')] });
    state.world = { currentLocationId: 'loc:broken', locations: { 'loc:broken': brokenStagingMap() }, links: [] };
    const engine = new Engine(state, () => 0.5);
    const facts = engine.sanitizePartyStaging();
    expect(facts.length).toBeGreaterThanOrEqual(3); // anchor moved off the islet + two regroups
    const map = state.world.locations['loc:broken']!;
    const pcs = map.objects.filter((o) => o.role === 'pc');
    for (const p of pcs) {
      expect(map.tiles[p.row]![p.col]!.startsWith('water')).toBe(false);
      expect(p.row).toBeGreaterThanOrEqual(6); // on the grass field
    }
    const [a, b, c] = pcs;
    const cheb = (x: typeof a, y: typeof a) => Math.max(Math.abs(x!.col - y!.col), Math.abs(x!.row - y!.row));
    expect(cheb(a!, b!)).toBeLessThanOrEqual(3);
    expect(cheb(a!, c!)).toBeLessThanOrEqual(3);
  });

  it('an already-sane clustered party is left untouched', () => {
    const state = createInitialState({ sessionId: 's', scenarioId: 't', startSceneId: 'x', party: [sheet('a'), sheet('b')] });
    const map = brokenStagingMap();
    map.objects = map.objects.slice(0, 2);
    map.objects[0]!.col = 5; map.objects[0]!.row = 7;
    map.objects[1]!.col = 6; map.objects[1]!.row = 7;
    state.world = { currentLocationId: 'loc:broken', locations: { 'loc:broken': map }, links: [] };
    const engine = new Engine(state, () => 0.5);
    expect(engine.sanitizePartyStaging()).toEqual([]);
    expect(map.objects[0]).toMatchObject({ col: 5, row: 7 });
  });
});
