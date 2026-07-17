import { describe, expect, it } from 'vitest';
import type { CharacterSheet, GameState, MapObject, SceneDelta, SceneMap } from '@mythweaver/shared';
import { Engine, createInitialState } from '@mythweaver/engine';
import { resolveReactions, specForArchetype, type DisturbanceEvent } from './reactions.js';

// A 20×20 grass village fixture. All ground/walkable, plus ONE roofed shed over cells (5-7)×(5-7) so the
// zone-occlusion rule has a building to hide a witness behind (roof polygons are authored in 16px tiles:
// cells 5-7 have centers 88/104/120 px, inside the 80..128 px square). Aldric (a PC) is the aggressor;
// Bram (a merchant) the victim. Bystanders are placed to exercise each disposition.
const COLS = 30, ROWS = 30;
function villageMap(extra: MapObject[] = []): SceneMap {
  const tiles = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => 'grass'));
  const walkable = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => true));
  return {
    locationId: 'loc:green', seed: 1, biome: 'village', lighting: 'day', grammar: 'town-square',
    grid: { cols: COLS, rows: ROWS, feetPerTile: 5 }, tiles, walkable,
    objects: [
      { id: 'pc:aldric', kind: 'actor', role: 'pc', tag: 'knight', name: 'Aldric', col: 10, row: 10, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
      { id: 'npc:bram', kind: 'actor', role: 'npc', tag: 'villager', name: 'Bram', col: 10, row: 11, footprint: { w: 1, h: 1 }, facing: 'down', visible: true }, // the victim (adjacent)
      { id: 'npc:town-knight', kind: 'actor', role: 'npc', tag: 'knight', name: 'Ser Kael', col: 13, row: 10, footprint: { w: 1, h: 1 }, facing: 'down', visible: true }, // authority → confront
      { id: 'npc:store-keeper', kind: 'actor', role: 'npc', tag: 'villager', name: 'Hobb', col: 8, row: 10, footprint: { w: 1, h: 1 }, facing: 'down', visible: true }, // keeper → brace
      { id: 'npc:bystander-1', kind: 'actor', role: 'npc', tag: 'villager', col: 12, row: 11, footprint: { w: 1, h: 1 }, facing: 'down', visible: true }, // anon → timid → flee
      { id: 'npc:shed-hand', kind: 'actor', role: 'npc', tag: 'villager', name: 'Mott', col: 6, row: 6, footprint: { w: 1, h: 1 }, facing: 'down', visible: true }, // inside the shed → alerted
      { id: 'npc:far-fisher', kind: 'actor', role: 'npc', tag: 'villager', name: 'Del', col: 10, row: 28, footprint: { w: 1, h: 1 }, facing: 'down', visible: true }, // 85ft > earshot → oblivious
      ...extra,
    ],
    ambiance: [], entrances: [],
    roofs: [{ id: 'bldg:shed', faces: [{ pts: [80, 80, 128, 80, 128, 128, 80, 128], top: 0, bot: 0 }] }],
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

function makeEngine(extra: MapObject[] = []): { engine: Engine; state: GameState; map: SceneMap } {
  const state = createInitialState({ sessionId: 's', scenarioId: 't', startSceneId: 'x', party: [sheet('aldric', 'Aldric')] });
  const map = villageMap(extra);
  state.world = { currentLocationId: 'loc:green', locations: { 'loc:green': map }, links: [] } as GameState['world'];
  return { engine: new Engine(state, () => 0.5), state, map };
}

const obj = (map: SceneMap, id: string) => map.objects.find((o) => o.id === id)!;
const ev = (map: SceneMap): DisturbanceEvent => ({ aggressor: obj(map, 'pc:aldric'), target: obj(map, 'npc:bram'), kind: 'attack' });

describe('resolveReactions — the living-world reaction resolver (P3)', () => {
  it('grades witnesses by disposition + perception and produces a verdict fact for each', () => {
    const { engine, map } = makeEngine();
    const deltas: SceneDelta[] = [];
    const out = resolveReactions(engine, map, ev(map), deltas, undefined, 'on');
    const joined = out.facts.join(' | ');
    expect(joined).toMatch(/Ser Kael.*(closes|challenge)/); // authority confronts the attacker
    expect(joined).toMatch(/Hobb.*(plants their feet|holding)/); // keeper braces at post
    expect(joined).toMatch(/villager.*(bolts|runs)/); // the anonymous bystander flees
    expect(joined).toMatch(/Mott.*doorway/); // shed-hand walled off → alerted, comes to a door next beat
    expect(joined).not.toMatch(/Del/); // far fisher is beyond earshot → oblivious, no reaction
  });

  it('excludes the aggressor and the victim from the crowd', () => {
    const { engine, map } = makeEngine();
    const out = resolveReactions(engine, map, ev(map), [], undefined, 'on');
    expect(out.facts.some((f) => f.startsWith('Aldric'))).toBe(false);
    expect(out.facts.some((f) => f.startsWith('Bram'))).toBe(false);
  });

  it('WALKS the movers (confront/flee) on the real map and stamps engine-owned rx:* state', () => {
    const { engine, map } = makeEngine();
    const deltas: SceneDelta[] = [];
    resolveReactions(engine, map, ev(map), deltas, undefined, 'on');
    // the knight closed the distance toward Aldric; the bystander bolted away from the strike
    expect(obj(map, 'npc:town-knight').col).toBeLessThan(13);
    expect(obj(map, 'npc:bystander-1').col).toBeGreaterThan(12);
    // a keeper braces — it does NOT move
    expect(obj(map, 'npc:store-keeper')).toMatchObject({ col: 8, row: 10 });
    // rx:* reaction state is written on every reactor
    expect(obj(map, 'npc:town-knight').state?.['rx:verb']).toBe('confront');
    expect(obj(map, 'npc:bystander-1').state?.['rx:verb']).toBe('flee');
    expect(obj(map, 'npc:store-keeper').state?.['rx:verb']).toBe('brace');
    expect(obj(map, 'npc:shed-hand').state?.['rx:verb']).toBe('emerge');
    // move deltas carry a `via` path so tokens WALK (mover count = knight + bystander)
    const moves = deltas.filter((d) => d.op === 'move');
    expect(moves.length).toBe(2);
    expect(moves.every((m) => Array.isArray((m as { via?: unknown[] }).via) && (m as { via: unknown[] }).via.length > 0)).toBe(true);
  });

  it('dry mode: computes the same verdict but MOVES nothing and writes no state (soak)', () => {
    const { engine, map } = makeEngine();
    const deltas: SceneDelta[] = [];
    const out = resolveReactions(engine, map, ev(map), deltas, undefined, 'dry');
    expect(out.facts.length).toBeGreaterThan(0); // still tells you what WOULD happen
    expect(deltas.length).toBe(0); // …but pushes no deltas
    expect(obj(map, 'npc:town-knight')).toMatchObject({ col: 13, row: 10 }); // nobody moved
    expect(obj(map, 'npc:town-knight').state?.['rx:verb']).toBeUndefined(); // no rx:* written
  });

  it('caps individual reactors and folds the rest into an aggregate line', () => {
    // 14 anonymous villagers packed around the strike — more than MAX_REACTORS (10).
    const crowd: MapObject[] = Array.from({ length: 14 }, (_, i) => ({
      id: `npc:crowd-${i}`, kind: 'actor', role: 'npc', tag: 'villager',
      col: 9 + (i % 3), row: 12 + Math.floor(i / 3), footprint: { w: 1, h: 1 }, facing: 'down', visible: true,
    })) as MapObject[];
    const { engine, map } = makeEngine(crowd);
    const out = resolveReactions(engine, map, ev(map), [], undefined, 'on');
    expect(out.reactors).toBeLessThanOrEqual(10);
    expect(out.overflow).toBeGreaterThan(0);
    expect(out.facts.some((f) => /more onlookers? react/.test(f))).toBe(true); // disposition-neutral, no movement claim
  });

  it('degrades to silence when no one is in earshot', () => {
    const { engine, map } = makeEngine();
    // strip the map down to just the attacker + victim — no bystanders to witness anything
    map.objects = map.objects.filter((o) => o.id === 'pc:aldric' || o.id === 'npc:bram');
    const out = resolveReactions(engine, map, ev(map), [], undefined, 'on');
    expect(out.facts).toEqual([]);
    expect(out.witnesses).toBe(0);
  });

  it('authored persona colour rides through: an allegiance/stake shows in the verdict line', () => {
    const { engine, state, map } = makeEngine();
    engine.upsertEntity({ id: 'npc:kael', kind: 'npc', name: 'Ser Kael', persona: { allegiance: 'the town', stake: 'the green' } });
    const out = resolveReactions(engine, map, ev(map), [], state.ledger, 'on');
    expect(out.facts.some((f) => /Ser Kael.*loyal to the town/.test(f))).toBe(true);
  });

  it('never leaks the internal persona taxonomy (archetype/temper) into a read-aloud fact', () => {
    const { engine, map } = makeEngine();
    const out = resolveReactions(engine, map, ev(map), [], undefined, 'on');
    for (const f of out.facts) {
      expect(f).not.toMatch(/\b(commoner|keeper|authority|cleric|beast|monster),\s*(timid|steady|bold|brave|territorial|feral)\b/);
    }
  });

  it('a cleric witness of a TARGETLESS menace does not fabricate a victim to shield', () => {
    const cleric: MapObject = { id: 'npc:brother-cael', kind: 'actor', role: 'npc', tag: 'monk', name: 'Cael', col: 11, row: 10, footprint: { w: 1, h: 1 }, facing: 'down', visible: true } as MapObject;
    const { engine, map } = makeEngine([cleric]);
    const out = resolveReactions(engine, map, { aggressor: obj(map, 'pc:aldric'), kind: 'threaten' }, [], undefined, 'on'); // no target
    const caelFact = out.facts.find((f) => f.startsWith('Cael'))!;
    expect(caelFact).toBeDefined();
    expect(caelFact).not.toMatch(/the one under attack|between the attacker and/); // no invented victim
    expect(caelFact).toMatch(/shield whoever/);
  });

  it('a mover with nowhere to go is narrated recoiling in place, never "bolts away" (no phantom movement)', () => {
    // a lone timid villager jammed into the (0,0) corner: the away-vector points off-grid, so no walk happens
    const cornered: MapObject = { id: 'npc:corner', kind: 'actor', role: 'npc', tag: 'villager', col: 0, row: 0, footprint: { w: 1, h: 1 }, facing: 'down', visible: true } as MapObject;
    const { engine, map } = makeEngine([cornered]);
    map.objects = map.objects.filter((o) => o.id === 'pc:aldric' || o.id === 'npc:corner');
    obj(map, 'pc:aldric').col = 2; obj(map, 'pc:aldric').row = 2;
    const deltas: SceneDelta[] = [];
    const out = resolveReactions(engine, map, { aggressor: obj(map, 'pc:aldric'), kind: 'attack' }, deltas, undefined, 'on');
    expect(obj(map, 'npc:corner')).toMatchObject({ col: 0, row: 0 }); // did NOT move
    expect(deltas.filter((d) => d.op === 'move').length).toBe(0); // no phantom move delta
    expect(out.facts.join(' ')).toMatch(/hemmed in|can't get clear/);
    expect(out.facts.join(' ')).not.toMatch(/bolts away/);
  });

  it('flees AWAY FROM THE AGGRESSOR, not the victim (a ranged strike between wielder and target)', () => {
    // aggressor at 10,10; victim far at 20,10; a timid bystander between them at 14,10 must run past the victim,
    // away from the wielder — not back toward the drawn weapon.
    const victim: MapObject = { id: 'npc:mark', kind: 'actor', role: 'npc', tag: 'villager', name: 'Mark', col: 20, row: 10, footprint: { w: 1, h: 1 }, facing: 'down', visible: true } as MapObject;
    const between: MapObject = { id: 'npc:tween', kind: 'actor', role: 'npc', tag: 'villager', col: 14, row: 10, footprint: { w: 1, h: 1 }, facing: 'down', visible: true } as MapObject;
    const { engine, map } = makeEngine([victim, between]);
    map.objects = map.objects.filter((o) => ['pc:aldric', 'npc:mark', 'npc:tween'].includes(o.id));
    obj(map, 'pc:aldric').col = 10; obj(map, 'pc:aldric').row = 10;
    resolveReactions(engine, map, { aggressor: obj(map, 'pc:aldric'), target: obj(map, 'npc:mark'), kind: 'attack' }, [], undefined, 'on');
    expect(obj(map, 'npc:tween').col).toBeGreaterThan(14); // fled away from the aggressor at col 10, not toward it
  });

  it('a second disturbance in the same turn does not re-move a bystander who already reacted', () => {
    const { engine, map } = makeEngine();
    const reacted = new Set<string>();
    const first = resolveReactions(engine, map, ev(map), [], undefined, 'on', reacted);
    expect(first.reactors).toBeGreaterThan(0);
    const second = resolveReactions(engine, map, ev(map), [], undefined, 'on', reacted); // same crowd, shared set
    expect(second.reactors).toBe(0); // everyone already reacted this turn
    expect(second.witnesses).toBe(0);
  });
});

describe('specForArchetype — promotion statblock per disposition', () => {
  it('scales the CR by archetype', () => {
    expect(specForArchetype('authority', 'Ser Kael').challengeRating).toBe(2);
    expect(specForArchetype('monster', 'Raider').challengeRating).toBe(1);
    expect(specForArchetype('commoner', 'Wil').challengeRating).toBe(0);
    expect(specForArchetype('keeper', 'Hobb').challengeRating).toBe(0);
  });
});

describe('Engine.promoteToken — the promotion lane', () => {
  it('binds a combatant to the existing token id so applyDamage resolves, and is idempotent', () => {
    const { engine, map } = makeEngine();
    const c = engine.promoteToken('npc:bram', specForArchetype('commoner', 'Bram'))!;
    expect(c.id).toBe('npc:bram'); // combatant id === map token id
    const hp0 = c.currentHitPoints;
    // damage now resolves against the promoted token (would throw "Unknown combatant" before promotion)
    const r = engine.applyDamage({ targetId: 'npc:bram', amount: 3, type: 'slashing' });
    expect(r.remaining).toBe(Math.max(0, hp0 - 3));
    // a second promotion is a no-op — it must NOT heal the wounded villager back to full
    const c2 = engine.promoteToken('npc:bram', specForArchetype('commoner', 'Bram'))!;
    expect(c2.currentHitPoints).toBe(hp0 - 3);
    expect(engine.promoteToken('pc:aldric')).toBeUndefined(); // never promote a PC
    expect(engine.promoteToken('npc:nobody')).toBeUndefined(); // missing token → undefined
  });
});
