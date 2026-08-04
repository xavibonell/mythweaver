import { describe, expect, it } from 'vitest';
import type { CharacterSheet, GameState, MapObject, SceneMap } from '@mythweaver/shared';
import { Engine, createInitialState } from '../index.js';
import { spatialIndex } from './oracle.js';
import { classifyReach, planApproach, reachRequiredFt, type ReachRequirement } from './reach.js';

// A 40×40 open green. Aldric (PC) and Tessa (NPC) are placed per test.
const COLS = 40, ROWS = 40;
function greenMap(extra: MapObject[] = [], walls: { col: number; row: number }[] = []): SceneMap {
  const tiles = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => 'grass'));
  const walkable = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => true));
  for (const w of walls) walkable[w.row]![w.col] = false;
  return {
    locationId: 'loc:green', seed: 1, biome: 'village', lighting: 'day', grammar: 'town-square',
    grid: { cols: COLS, rows: ROWS, feetPerTile: 5 }, tiles, walkable,
    objects: [
      { id: 'pc:aldric', kind: 'actor', role: 'pc', tag: 'knight', name: 'Aldric', col: 29, row: 22, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
      { id: 'npc:tessa', kind: 'actor', role: 'npc', tag: 'villager', name: 'Tessa Reed', col: 24, row: 18, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
      ...extra,
    ],
    ambiance: [], entrances: [], roofs: [],
  } as unknown as SceneMap;
}

function sheet(id: string, name: string): CharacterSheet {
  return {
    id, name, ancestry: 'Human', className: 'Fighter', level: 1,
    abilities: { str: 16, dex: 14, con: 15, int: 11, wis: 13, cha: 9 },
    proficiencyBonus: 2, armorClass: 16, maxHitPoints: 12, speedFt: 30,
    skillProficiencies: [], savingThrowProficiencies: ['str'], attacks: [],
  };
}

function makeEngine(map: SceneMap): { engine: Engine; state: GameState; map: SceneMap } {
  const state = createInitialState({ sessionId: 's', scenarioId: 't', startSceneId: 'x', party: [sheet('aldric', 'Aldric')] });
  state.world = { currentLocationId: 'loc:green', locations: { 'loc:green': map }, links: [] } as GameState['world'];
  return { engine: new Engine(state, () => 0.5), state, map };
}

const obj = (m: SceneMap, id: string) => m.objects.find((o) => o.id === id)!;
const MELEE: ReachRequirement = { reachFt: 5, source: 'test melee' };
const caps30 = { speedFt: 30, swim: 'double-cost' } as const;

describe('reachRequiredFt — the first reader of weapon geometry', () => {
  it('defaults to PHB 5 ft melee when nothing is equipped', () => {
    const { state } = makeEngine(greenMap());
    expect(reachRequiredFt(state, 'aldric', 'melee')).toMatchObject({ reachFt: 5 });
  });

  it('reads an equipped weapon: a reach weapon extends melee, a bow sets the ranged bands', () => {
    const { state } = makeEngine(greenMap());
    state.itemCatalog = {
      pike: { id: 'pike', name: 'Pike', category: 'weapon', weightLb: 18, slot: 'mainHand', reachFt: 10 },
      shortbow: { id: 'shortbow', name: 'Shortbow', category: 'weapon', weightLb: 2, slot: 'ranged', rangeFt: 80, longRangeFt: 320 },
    } as GameState['itemCatalog'];
    state.characters = {
      aldric: { items: [{ defId: 'pike', instanceId: 'i1' }, { defId: 'shortbow', instanceId: 'i2' }], equipped: { mainHand: 'i1', ranged: 'i2' } },
    } as unknown as GameState['characters'];
    expect(reachRequiredFt(state, 'aldric', 'melee')).toMatchObject({ reachFt: 10, source: 'Pike' });
    expect(reachRequiredFt(state, 'aldric', 'ranged')).toMatchObject({ reachFt: 80, longFt: 320 });
  });

  it('falls back to a monster stat block’s printed reach', () => {
    const { state } = makeEngine(greenMap());
    state.combatants['npc:ogre'] = { id: 'npc:ogre', name: 'Ogre', refId: 'ogre' } as GameState['combatants'][string];
    state.bestiary = { ogre: { attacks: [{ name: 'Greatclub', attackBonus: 6, damage: '2d8+4', damageType: 'bludgeoning', reachOrRangeFt: 10 }] } } as unknown as GameState['bestiary'];
    expect(reachRequiredFt(state, 'npc:ogre', 'melee')).toMatchObject({ reachFt: 10, source: 'statblock' });
  });
});

describe('classifyReach — the pure legality decision', () => {
  const idx = () => spatialIndex(greenMap());
  const args = (attacker: { col: number; row: number }, target: { col: number; row: number }, over: Partial<Parameters<typeof classifyReach>[0]> = {}) => ({
    idx: idx(), attacker, target, attackerName: 'Aldric', targetName: 'Tessa Reed',
    mode: 'melee' as const, req: MELEE, caps: caps30, ...over,
  });

  it('adjacent: in reach, no approach, no fuss', () => {
    const v = classifyReach(args({ col: 10, row: 10 }, { col: 11, row: 10 }));
    expect(v).toMatchObject({ ok: true, reason: 'in-reach', distanceFt: 5 });
    expect(v.approach).toBeUndefined();
  });

  it('THE TESSA CASE: 25 ft away is NOT in reach — it plans an approach instead of landing the blow', () => {
    const v = classifyReach(args({ col: 29, row: 22 }, { col: 24, row: 18 }));
    expect(v.distanceFt).toBe(25); // Chebyshev ×5 — the engine's own metric
    expect(v.reason).toBe('closed-to-reach'); // legal only BECAUSE the engine closes the gap
    expect(v.ok).toBe(true);
    expect(v.approach!.ft).toBeLessThanOrEqual(30); // within one move
    expect(v.facts.join(' ')).toMatch(/closes \d+ ft/);
  });

  it('beyond one move: REFUSED — no damage, and the DM is told to let the player decide', () => {
    const v = classifyReach(args({ col: 5, row: 5 }, { col: 30, row: 5 }));
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('too-far-to-close');
    expect(v.corrective).toMatch(/does NOT land/);
  });

  it('a slow attacker (speed 0 — grappled/restrained) cannot close at all', () => {
    const v = classifyReach(args({ col: 10, row: 10 }, { col: 14, row: 10 }, { caps: { speedFt: 0, swim: 'double-cost' } }));
    expect(v.ok).toBe(false);
  });

  it('RANGED: inside the normal band is clean; the long band is allowed at DISADVANTAGE; past it is refused', () => {
    const ranged: ReachRequirement = { reachFt: 80, longFt: 320, source: 'Shortbow' };
    const near = classifyReach(args({ col: 5, row: 5 }, { col: 15, row: 5 }, { mode: 'ranged', req: ranged }));
    expect(near).toMatchObject({ ok: true, reason: 'in-reach', band: 'normal' });
    const long = classifyReach(args({ col: 0, row: 5 }, { col: 30, row: 5 }, { mode: 'ranged', req: ranged }));
    expect(long).toMatchObject({ ok: true, reason: 'long-range', band: 'long' });
    expect(long.facts.join(' ')).toMatch(/DISADVANTAGE/);
    const tooFar: ReachRequirement = { reachFt: 20, longFt: 60, source: 'Dagger (thrown)' };
    const past = classifyReach(args({ col: 0, row: 5 }, { col: 30, row: 5 }, { mode: 'ranged', req: tooFar }));
    expect(past).toMatchObject({ ok: false, reason: 'out-of-range' });
  });

  it('SPELL stays advisory — no spell-range table exists, so it must not false-refuse', () => {
    const v = classifyReach(args({ col: 0, row: 0 }, { col: 30, row: 30 }, { mode: 'spell' }));
    expect(v).toMatchObject({ ok: true, reason: 'spell-advisory' });
  });
});

describe('planApproach — walks a real path, never a straight line through walls', () => {
  it('refuses when a wall seals the target off (no route), even at point-blank distance', () => {
    // Box Tessa in completely: a 1-cell moat of unwalkable tiles around (24,18).
    const walls: { col: number; row: number }[] = [];
    for (let dc = -1; dc <= 1; dc++) for (let dr = -1; dr <= 1; dr++) if (dc || dr) walls.push({ col: 24 + dc, row: 18 + dr });
    const map = greenMap([], walls);
    const plan = planApproach(spatialIndex(map), { col: 29, row: 22 }, { col: 24, row: 18 }, caps30, 5, 30);
    expect(plan).toBeUndefined();
  });
});

describe('Engine.attackReach — the gate that fires, with the approach as its only side effect', () => {
  it('THE REGRESSION: Aldric at (29,22) cannot simply strike Tessa at (24,18) — the engine WALKS him in', () => {
    const map = greenMap();
    const { engine } = makeEngine(map);
    const before = { ...obj(map, 'pc:aldric') };
    const v = engine.attackReach({ attackerId: 'pc:aldric', targetId: 'npc:tessa', mode: 'melee' });
    expect(v.ok).toBe(true);
    expect(v.reason).toBe('closed-to-reach');
    const after = obj(map, 'pc:aldric');
    expect(after.col === before.col && after.row === before.row).toBe(false); // he MOVED — no phantom strike
    const idx = spatialIndex(map);
    const gap = Math.max(Math.abs(after.col - 24), Math.abs(after.row - 18)) * idx.feetPerTile;
    expect(gap).toBeLessThanOrEqual(5); // and he ended up genuinely adjacent
    expect(v.approach?.actorId).toBe('pc:aldric'); // the delta targets the map token
  });

  it('refuses a blow from across the map and moves NO ONE', () => {
    const map = greenMap();
    obj(map, 'npc:tessa').col = 2; obj(map, 'npc:tessa').row = 2;
    const { engine } = makeEngine(map);
    const v = engine.attackReach({ attackerId: 'pc:aldric', targetId: 'npc:tessa', mode: 'melee' });
    expect(v.ok).toBe(false);
    expect(obj(map, 'pc:aldric')).toMatchObject({ col: 29, row: 22 });
    expect(v.corrective).toBeTruthy();
  });

  it('degrades OPEN: an unknown/unpositioned participant never blocks the blow', () => {
    const { engine } = makeEngine(greenMap());
    expect(engine.attackReach({ attackerId: 'pc:aldric', targetId: 'npc:ghost' })).toMatchObject({ ok: true, reason: 'unpositioned' });
  });

  it('degrades OPEN with no scene established at all', () => {
    const state = createInitialState({ sessionId: 's', scenarioId: 't', startSceneId: 'x', party: [sheet('aldric', 'Aldric')] });
    const engine = new Engine(state, () => 0.5);
    expect(engine.attackReach({ attackerId: 'aldric', targetId: 'anyone' })).toMatchObject({ ok: true, reason: 'unpositioned' });
  });
});
