import { describe, expect, it } from 'vitest';
import type { CharacterSheet, GameState, SceneMap } from '@mythweaver/shared';
import { Engine, createInitialState } from '../index.js';

/** 16x5 pool fixture: ground | 4-col deep-water band (cols 6-9) | ground. */
function poolMap(weather?: 'storm'): SceneMap {
  const cols = 16, rows = 5;
  const tiles = Array.from({ length: rows }, () => Array.from({ length: cols }, () => 'grass'));
  const walkable = Array.from({ length: rows }, () => Array.from({ length: cols }, () => true));
  for (let r = 0; r < rows; r++) for (let c = 6; c <= 9; c++) { tiles[r]![c] = 'water_deep'; walkable[r]![c] = false; }
  return {
    locationId: 'loc:pool', seed: 1, biome: 'village', lighting: 'day', ...(weather ? { weather: weather as 'fog' } : {}), grammar: 'open-outdoor',
    grid: { cols, rows, feetPerTile: 5 }, tiles, walkable,
    objects: [
      { id: 'pc:rogue', kind: 'actor', role: 'pc', tag: 'rogue', name: 'Pip', col: 2, row: 2, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
      { id: 'pc:wizard', kind: 'actor', role: 'pc', tag: 'mage', name: 'Elara', col: 2, row: 1, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
      { id: 'npc:hermit', kind: 'actor', role: 'npc', tag: 'villager', name: 'Hermit', col: 13, row: 2, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
    ],
    ambiance: [], entrances: [],
  } as unknown as SceneMap;
}

function sheet(id: string, name: string): CharacterSheet {
  return {
    id, name, ancestry: 'Human', className: 'Fighter', level: 1,
    abilities: { str: 16, dex: 14, con: 15, int: 11, wis: 13, cha: 9 },
    proficiencyBonus: 2, armorClass: 16, maxHitPoints: 12, speedFt: 30,
    skillProficiencies: ['athletics'], savingThrowProficiencies: ['str'],
    attacks: [{ name: 'Sword', attackBonus: 5, damage: '1d8+3', damageType: 'slashing' }],
  };
}

function makeEngine(weather?: 'storm'): { engine: Engine; state: GameState } {
  const state = createInitialState({ sessionId: 's', scenarioId: 't', startSceneId: 'x', party: [sheet('rogue', 'Pip'), sheet('wizard', 'Elara')] });
  state.world = { currentLocationId: 'loc:pool', locations: { 'loc:pool': poolMap(weather) }, links: [] };
  return { engine: new Engine(state, () => 0.5), state };
}

const pcCell = (state: GameState, id: string) => {
  const o = state.world!.locations['loc:pool']!.objects.find((x) => x.id === id)!;
  return { col: o.col, row: o.row };
};

describe('travel (R2): the pool scenario, engine-owned', () => {
  it('calm water: the rogue swims across at double cost — no roll, no dialog (triviality)', () => {
    const { engine, state } = makeEngine();
    const v = engine.travel({ actorId: 'pc:rogue', to: { id: 'npc:hermit' } });
    expect(v.moved).toBe(true);
    expect(v.needsRoll).toBeUndefined();
    expect(v.legs.some((l) => l.swimming)).toBe(true);
    expect(v.ft).toBeGreaterThan(55); // 20 ft of water at double cost inflates the raw distance
    expect(pcCell(state, 'pc:rogue').col).toBeGreaterThanOrEqual(11); // across, near the hermit
    expect(v.facts[0]).toContain('swimming');
  });

  it('water walk (tracked via concentration): the wizard crosses with NO swimming leg', () => {
    const { engine, state } = makeEngine();
    engine.startConcentration({ combatantId: 'pc:wizard', spell: 'Water Walk' });
    const v = engine.travel({ actorId: 'pc:wizard', to: { id: 'npc:hermit' } });
    expect(v.moved).toBe(true);
    expect(v.legs.some((l) => l.swimming)).toBe(false);
    expect(v.facts.join(' ')).toContain('ON the water');
    expect(pcCell(state, 'pc:wizard').col).toBeGreaterThanOrEqual(11);
  });

  it('STORM: travel stops at the waterline and hands back ONE Athletics gate', () => {
    const { engine, state } = makeEngine('storm');
    const v = engine.travel({ actorId: 'pc:rogue', to: { id: 'npc:hermit' } });
    expect(v.stoppedAt).toBe('waterline');
    expect(v.needsRoll).toMatchObject({ skill: 'athletics', dc: 12 });
    expect(pcCell(state, 'pc:rogue').col).toBe(5); // walked the dry prefix to the bank
  });

  it('gatePassed resume completes the crossing without re-gating', () => {
    const { engine, state } = makeEngine('storm');
    engine.travel({ actorId: 'pc:rogue', to: { id: 'npc:hermit' } }); // to the bank
    const v = engine.travel({ actorId: 'pc:rogue', to: { id: 'npc:hermit' }, gatePassed: true });
    expect(v.moved).toBe(true);
    expect(v.needsRoll).toBeUndefined();
    expect(pcCell(state, 'pc:rogue').col).toBeGreaterThanOrEqual(11);
  });

  it('failed gate fail-forwards: still dry, displaced along the bank, a fact for the DM', () => {
    const { engine, state } = makeEngine('storm');
    engine.travel({ actorId: 'pc:rogue', to: { id: 'npc:hermit' } });
    const before = pcCell(state, 'pc:rogue');
    const facts = engine.swimGateFail('pc:rogue');
    const after = pcCell(state, 'pc:rogue');
    expect(facts[0]).toContain('current throws');
    expect(after.col).toBeLessThanOrEqual(5); // never in the deep
    expect(after).not.toEqual(before); // the world moved — no free retry from the same spot
  });

  it("mode:'auto' (backstop/reroute) NEVER suspends — hazardous water degrades to the waterline", () => {
    const { engine, state } = makeEngine('storm');
    const v = engine.travel({ actorId: 'pc:rogue', to: { id: 'npc:hermit' }, mode: 'auto' });
    expect(v.needsRoll).toBeUndefined();
    expect(v.stoppedAt).toBe('waterline');
    expect(pcCell(state, 'pc:rogue').col).toBe(5);
  });

  it('grappled: speed 0 refuses with a narratable fact', () => {
    const { engine } = makeEngine();
    engine.applyCondition({ combatantId: 'pc:rogue', condition: 'grappled', add: true });
    const v = engine.travel({ actorId: 'pc:rogue', to: { id: 'npc:hermit' } });
    expect(v.moved).toBe(false);
    expect(v.rejected).toBe('speed 0');
  });
});
