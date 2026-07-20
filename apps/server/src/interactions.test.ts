import { describe, expect, it } from 'vitest';
import type { CharacterSheet, GameState, MapObject, SceneDelta, SceneMap } from '@mythweaver/shared';
import { Engine, createInitialState } from '@mythweaver/engine';
import { advanceGoals, assessCommand, clampStanding, commandDC, commandFact, dispatchReinforcements, forbiddenCommand, narrationDefiesCommand, resolveInteraction, resolveReactions, setGoal, specForArchetype, standingOf, type DisturbanceEvent, type Stimulus } from './interactions.js';

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

describe('resolveInteraction — the broadcast DRAW lane (P4a: summon / perform)', () => {
  const summon = (map: SceneMap): Stimulus => ({ kind: 'summon', source: obj(map, 'pc:aldric'), locus: { col: 10, row: 10 } });

  it('a summons pulls the crowd by persona: the knight comes, the keeper holds post, the walled-off and far show nothing', () => {
    const { engine, map } = makeEngine();
    const deltas: SceneDelta[] = [];
    const out = resolveInteraction(engine, map, summon(map), deltas, undefined, 'on');
    const joined = out.facts.join(' | ');
    expect(joined).toMatch(/Ser Kael.*(comes over|attention)/); // authority answers the call
    expect(joined).toMatch(/Hobb.*(post|where they stand)/); // keeper looks up but holds
    expect(joined).not.toMatch(/Mott/); // inside the shed (alerted) → a draw shows nothing through a wall
    expect(joined).not.toMatch(/Del/); // beyond earshot → oblivious
    // Ser Kael physically walked toward the locus (started at 13,10; locus 10,10; stop ring 2)
    expect(obj(map, 'npc:town-knight').col).toBeLessThan(13);
    // the keeper did NOT move
    expect(obj(map, 'npc:store-keeper')).toMatchObject({ col: 8, row: 10 });
    // rx:* stamped with the draw verbs
    expect(obj(map, 'npc:town-knight').state?.['rx:verb']).toBe('approach');
    expect(obj(map, 'npc:store-keeper').state?.['rx:verb']).toBe('hold');
  });

  it('an already-close commoner turns their attention instead of shuffling a phantom step', () => {
    const { engine, map } = makeEngine();
    const out = resolveInteraction(engine, map, summon(map), [], undefined, 'on');
    // Bram stands 1 tile from the locus — inside every stop ring → no walk, attention fact instead
    expect(out.facts.find((f) => f.startsWith('Bram'))).toMatch(/already close|attention|stays where/);
    expect(obj(map, 'npc:bram')).toMatchObject({ col: 10, row: 11 });
  });

  it('a performance draws the curious but a beast shies from the noise', () => {
    const dog: MapObject = { id: 'npc:scrap', kind: 'actor', role: 'npc', tag: 'hound', name: 'Scrap', col: 13, row: 13, footprint: { w: 1, h: 1 }, facing: 'down', visible: true } as MapObject;
    const { engine, map } = makeEngine([dog]);
    const deltas: SceneDelta[] = [];
    const out = resolveInteraction(engine, map, { kind: 'perform', source: obj(map, 'pc:aldric'), locus: { col: 10, row: 10 } }, deltas, undefined, 'on');
    expect(out.facts.find((f) => f.startsWith('Scrap'))).toMatch(/shies away|tenses/);
    // the dog moved AWAY from the performer (started 13,13 — dist grows)
    const d0 = Math.hypot(13 - 10, 13 - 10);
    const s = obj(map, 'npc:scrap');
    expect(Math.hypot(s.col - 10, s.row - 10)).toBeGreaterThanOrEqual(d0);
  });

  it('dry mode computes the verdict but moves nothing and stamps nothing', () => {
    const { engine, map } = makeEngine();
    const deltas: SceneDelta[] = [];
    const out = resolveInteraction(engine, map, summon(map), deltas, undefined, 'dry');
    expect(out.facts.length).toBeGreaterThan(0);
    expect(deltas.length).toBe(0);
    expect(obj(map, 'npc:town-knight')).toMatchObject({ col: 13, row: 10 });
    expect(obj(map, 'npc:town-knight').state?.['rx:verb']).toBeUndefined();
  });

  it('shares the per-turn reacted set with the threat lane — a summons cannot re-move someone who already reacted', () => {
    const { engine, map } = makeEngine();
    const reacted = new Set<string>();
    resolveReactions(engine, map, ev(map), [], undefined, 'on', reacted); // the strike moves the crowd first
    const out = resolveInteraction(engine, map, summon(map), [], undefined, 'on', reacted);
    // Only Bram — the strike's VICTIM, handled directly and so never in the reacted set — may answer;
    // every crowd member who already scattered/braced stays put.
    expect(out.facts.every((f) => f.startsWith('Bram'))).toBe(true);
    expect(out.reactors).toBeLessThanOrEqual(1);
  });

  it('never leaks the persona taxonomy into a draw fact', () => {
    const { engine, map } = makeEngine();
    const out = resolveInteraction(engine, map, summon(map), [], undefined, 'on');
    for (const f of out.facts) {
      expect(f).not.toMatch(/\b(commoner|keeper|authority|cleric|beast|monster),\s*(timid|steady|bold|brave|territorial|feral)\b/);
    }
  });
});

describe('P4b command logic — assess / DC / forbidden / verdict / polarity', () => {
  const P = (archetype: any, temper: any, extra: any = {}): any => ({ archetype, temper, ...extra });
  const tessa = P('commoner', 'bold');
  const target = { id: 'npc:tessa', name: 'Tessa', tag: 'villager', role: 'npc', col: 5, row: 5 } as MapObject;

  it('standingOf seeds from allegiance (immutable in P4b): party > town > stranger > hostile', () => {
    expect(standingOf(P('commoner', 'bold', { allegiance: 'the party' }))).toBe(2);
    expect(standingOf(P('commoner', 'steady', { allegiance: 'the town' }))).toBe(1);
    expect(standingOf(P('commoner', 'bold'))).toBe(0);
    expect(standingOf(P('monster', 'feral'))).toBe(-2);
  });

  it('commandDC scales with cost, standing, and temper (clamped 5..25)', () => {
    // a bold stranger, operate (cost 2): 10 + 2 − 0 + 0 = 12
    expect(commandDC(tessa, 0, { verb: 'operate', anchorId: 'x' }, 0)).toBe(12);
    // sworn to the party (standing 2): 12 − 4 = 8
    expect(commandDC(tessa, 2, { verb: 'operate', anchorId: 'x' }, 0)).toBe(8);
    // a timid stranger asked to just hold (cost 0): 10 − 2 = 8
    expect(commandDC(P('commoner', 'timid'), 0, { verb: 'hold' }, 0)).toBe(8);
    // a feral thing asked to fight: 10 + 8(cost) + 5(feral) = 23 — near-impossible, still under the 25 clamp
    expect(commandDC(P('beast', 'feral'), 0, { verb: 'fight', anchorId: 'x' }, 0)).toBe(23);
    // an authority bonus (serving the commander) can drive it to the auto-obey floor
    expect(commandDC(P('commoner', 'timid'), 3, { verb: 'hold' }, 10)).toBe(5);
  });

  it('assessCommand bands: friendly favour auto-obeys, a stranger rolls, a hostile big ask auto-refuses', () => {
    expect(assessCommand(tessa, 3, { verb: 'hold' }, 'order').band).toBe('obey'); // DC 10+0−6 = 4 ≤5
    expect(assessCommand(tessa, 0, { verb: 'operate', anchorId: 'x' }, 'order').band).toBe('roll'); // DC 12
    expect(assessCommand(P('commoner', 'brave'), -2, { verb: 'fetch', anchorId: 'x' }, 'order').band).toMatch(/roll|refuse/);
  });

  it('the fear cap (invariant 9): a threat cannot compel a costly/dangerous deed — it hardens them', () => {
    const a = assessCommand(tessa, 0, { verb: 'fight', anchorId: 'foe' }, 'threat');
    expect(a.band).toBe('refuse');
    expect(a.fearCapped).toBe(true);
    // but a threat CAN still be rolled for a small ask
    expect(assessCommand(tessa, 0, { verb: 'operate', anchorId: 'x' }, 'threat').band).toBe('roll');
  });

  it('forbiddenCommand (invariant 5): cannot order an NPC to attack the commander or themselves — no roll', () => {
    expect(forbiddenCommand({ verb: 'fight', anchorId: 'pc:aldric' }, 'npc:tessa', 'pc:aldric')).toMatch(/turn on/);
    expect(forbiddenCommand({ verb: 'fight', anchorId: 'npc:tessa' }, 'npc:tessa', 'pc:aldric')).toMatch(/themselves/);
    expect(forbiddenCommand({ verb: 'operate', anchorId: 'lock' }, 'npc:tessa', 'pc:aldric')).toBeNull(); // a chore is fine
    expect(forbiddenCommand({ verb: 'fight', anchorId: 'mob:bandit' }, 'npc:tessa', 'pc:aldric')).toBeNull(); // fighting a foe is askable
    expect(forbiddenCommand({ verb: 'fight' }, 'npc:tessa', 'pc:aldric')).toBeNull(); // a missing foe is an INPUT error, not a refusal
  });

  it('commandFact is pure fiction, honest about movement, and leaks no taxonomy', () => {
    const obeyed = commandFact(target, tessa, { verb: 'operate', anchorId: 'x' }, 'order', 'obeyed', true, 'lock');
    expect(obeyed).toMatch(/Tessa.*(moves off|to see to the lock)/);
    const refused = commandFact(target, tessa, { verb: 'operate', anchorId: 'x' }, 'order', 'refused', false, 'lock');
    expect(refused).toMatch(/Tessa.*(refuses|folds their arms)/);
    const feared = commandFact(target, tessa, { verb: 'operate', anchorId: 'x' }, 'threat', 'feared-into-compliance', true, 'lock');
    expect(feared).toMatch(/warily/);
    for (const f of [obeyed, refused, feared]) expect(f).not.toMatch(/\bcommoner,\s*bold\b/);
  });

  it('narrationDefiesCommand (polarity gate): catches prose that reverses the verdict, ignores agreeing prose', () => {
    // engine said OBEYED, prose says she refuses → defies
    expect(narrationDefiesCommand('Tessa shakes her head and refuses to budge.', 'Tessa', 'obeyed')?.want).toBe('obeyed');
    // engine said REFUSED, prose says she heads off → defies
    expect(narrationDefiesCommand('Tessa nods and heads for the lock.', 'Tessa', 'refused')?.want).toBe('refused');
    // agreeing prose → no flag
    expect(narrationDefiesCommand('Tessa nods and heads for the lock.', 'Tessa', 'obeyed')).toBeNull();
    expect(narrationDefiesCommand('Tessa folds her arms and stays put.', 'Tessa', 'refused')).toBeNull();
    // a different NPC named → not this target's verdict
    expect(narrationDefiesCommand('Hobb refuses and walks off.', 'Tessa', 'obeyed')).toBeNull();
    // review-fix: everyday "won't move" refusal phrasings ARE caught over an obeyed token
    expect(narrationDefiesCommand("Tessa plants her feet and doesn't budge.", 'Tessa', 'obeyed')?.want).toBe('obeyed');
    expect(narrationDefiesCommand('Tessa stays rooted to the spot.', 'Tessa', 'obeyed')?.want).toBe('obeyed');
    // review-fix: bare demeanor on a feared-into-compliance verdict does NOT false-fire (she IS complying)
    expect(narrationDefiesCommand("Tessa moves off, though she won't take her eyes off you.", 'Tessa', 'feared-into-compliance')).toBeNull();
    expect(narrationDefiesCommand('Tessa complies, wary and defiant.', 'Tessa', 'feared-into-compliance')).toBeNull();
  });
});

describe('P4d standing — a mutable, ledger-owned scalar that feeds the command DC', () => {
  const P = (archetype: any, temper: any, extra: any = {}): any => ({ archetype, temper, ...extra });
  const ledgerWith = (subject: string, value: string, superseded = false): any => ({
    entities: {}, plants: {},
    facts: [{ id: 'fact:1', subject, attribute: 'standing:party', value, turn: 1, source: 'dm', ...(superseded ? { supersededBy: 'fact:2' } : {}) }],
  });

  it('reads the live standing fact, clamped to the band', () => {
    expect(standingOf(P('commoner', 'bold'), ledgerWith('npc:tessa', '2'), 'npc:tessa')).toBe(2);
    expect(standingOf(P('commoner', 'bold'), ledgerWith('npc:tessa', '-9'), 'npc:tessa')).toBe(-3); // clamped
  });

  it('ignores a superseded fact and falls back to the allegiance seed', () => {
    // the only fact is superseded → no live standing → seed from allegiance (none → 0)
    expect(standingOf(P('commoner', 'bold'), ledgerWith('npc:tessa', '2', true), 'npc:tessa')).toBe(0);
    // seed still honours authored allegiance when no fact applies
    expect(standingOf(P('commoner', 'steady', { allegiance: 'the party' }), ledgerWith('npc:x', '1', true), 'npc:tessa')).toBe(2);
  });

  it('with no ledger/cardId, returns the pure allegiance seed (a bare token has no standing)', () => {
    expect(standingOf(P('commoner', 'bold'))).toBe(0);
    expect(standingOf(P('monster', 'feral'))).toBe(-2);
  });

  it('a raised standing lowers the command DC (relationships make people help more readily)', () => {
    const p = P('commoner', 'bold');
    const stranger = standingOf(p); // 0
    const warmed = standingOf(p, ledgerWith('npc:tessa', '2'), 'npc:tessa'); // +2
    expect(commandDC(p, warmed, { verb: 'operate', anchorId: 'x' }, 0)).toBeLessThan(commandDC(p, stranger, { verb: 'operate', anchorId: 'x' }, 0));
  });

  it('clampStanding bounds to [-3, 3]', () => {
    expect(clampStanding(5)).toBe(3);
    expect(clampStanding(-5)).toBe(-3);
    expect(clampStanding(1)).toBe(1);
  });
});

describe('P4f multi-turn goals — advanceGoals + reinforcement dispatch', () => {
  const knightAt = (id: string, col: number, row: number): MapObject => ({ id, kind: 'actor', role: 'npc', tag: 'knight', name: id.replace('npc:', ''), col, row, footprint: { w: 1, h: 1 }, facing: 'down', visible: true } as MapObject);

  it('walks a goal-carrier ONE capped round toward its cell and emits an en-route fact (not a teleport)', () => {
    const far = knightAt('npc:warden', 28, 28);
    const { engine, state, map } = makeEngine([far]);
    const deltas: SceneDelta[] = [];
    setGoal(engine, 'npc:warden', { kind: 'reinforce', col: 10, row: 10, say: 'Hold!', ttl: 4 }, deltas);
    const d0 = Math.hypot(28 - 10, 28 - 10);
    const facts = advanceGoals(engine, map, state, deltas, new Set());
    const w = obj(map, 'npc:warden');
    const d1 = Math.hypot(w.col - 10, w.row - 10);
    expect(d1).toBeLessThan(d0); // moved closer
    expect(d1).toBeGreaterThan(2); // but did NOT teleport all the way (one round, capped by speed)
    expect(facts.join(' ')).toMatch(/crossing the ground|coming fast|closing|strides/); // a distance-aware ETA beat (far → "crossing the ground", not "a few strides out")
    expect(w.state?.['rx:goal']).toBeTruthy(); // goal persists (ttl decremented)
  });

  it('delivers the line and CLEARS the goal on arrival (a dumb waypoint that dies)', () => {
    const near = knightAt('npc:warden', 11, 10); // one tile from the goal
    const { engine, state, map } = makeEngine([near]);
    const deltas: SceneDelta[] = [];
    setGoal(engine, 'npc:warden', { kind: 'reinforce', col: 10, row: 10, say: 'Stand down!', ttl: 4 }, deltas);
    const facts = advanceGoals(engine, map, state, deltas, new Set());
    expect(facts.join(' ')).toMatch(/reaches the scene.*Stand down!/);
    expect(obj(map, 'npc:warden').state?.['rx:goal']).toBe(''); // goal cleared — it does not persist
  });

  it('expires a stuck goal after its ttl without inventing an arrival', () => {
    const far = knightAt('npc:warden', 28, 28);
    const { engine, state, map } = makeEngine([far]);
    const deltas: SceneDelta[] = [];
    setGoal(engine, 'npc:warden', { kind: 'reinforce', col: 10, row: 10, say: 'Hold!', ttl: 1 }, deltas); // last beat
    const facts = advanceGoals(engine, map, state, deltas, new Set());
    expect(obj(map, 'npc:warden').state?.['rx:goal']).toBe(''); // ttl hit 0 → cleared
    expect(facts.join(' ')).not.toMatch(/Hold!/); // gave up en route → no false arrival line
  });

  it('a goal-advanced token is added to `reacted` so a fresh reaction can not re-move it', () => {
    const far = knightAt('npc:warden', 28, 28);
    const { engine, state, map } = makeEngine([far]);
    const reacted = new Set<string>();
    setGoal(engine, 'npc:warden', { kind: 'reinforce', col: 10, row: 10, ttl: 4 }, []);
    advanceGoals(engine, map, state, [], reacted);
    expect(reacted.has('npc:warden')).toBe(true);
  });

  it('dispatchReinforcements sends distant AUTHORITY (not commoners) toward the disturbance with a goal', () => {
    const farKnight = knightAt('npc:warden', 27, 10); // ~85ft from event, beyond earshot, within alarm range
    const farVillager: MapObject = { id: 'npc:farmer', kind: 'actor', role: 'npc', tag: 'villager', name: 'Cob', col: 27, row: 12, footprint: { w: 1, h: 1 }, facing: 'down', visible: true } as MapObject;
    const { engine, map } = makeEngine([farKnight, farVillager]);
    const deltas: SceneDelta[] = [];
    const facts = dispatchReinforcements(engine, map, { col: 10, row: 11 }, 'pc:aldric', 'npc:bram', undefined, deltas, new Set());
    expect(obj(map, 'npc:warden').state?.['rx:goal']).toBeTruthy(); // the knight was dispatched
    expect(obj(map, 'npc:farmer').state?.['rx:goal']).toBeFalsy(); // a farmer is not the watch — not dispatched
    expect(facts.join(' ')).toMatch(/warden.*(run|coming)/i);
  });

  it('does not re-dispatch an authority that already has a goal', () => {
    const farKnight = knightAt('npc:warden', 27, 10);
    const { engine, map } = makeEngine([farKnight]);
    setGoal(engine, 'npc:warden', { kind: 'reinforce', col: 5, row: 5, ttl: 4 }, []);
    const facts = dispatchReinforcements(engine, map, { col: 10, row: 11 }, 'pc:aldric', undefined, undefined, [], new Set());
    expect(facts.length).toBe(0); // already on the way → not re-sent
  });
})

describe('P4f review fixes — ttl scaling, move-honesty, staleness', () => {
  const knightAt = (id: string, col: number, row: number): MapObject => ({ id, kind: 'actor', role: 'npc', tag: 'knight', name: id.replace('npc:', ''), col, row, footprint: { w: 1, h: 1 }, facing: 'down', visible: true } as MapObject);

  it('reinforcement ttl SCALES with distance so a far responder has beats enough to arrive', () => {
    const far = knightAt('npc:warden', 27, 10); // ~85ft from the event
    const { engine, map } = makeEngine([far]);
    dispatchReinforcements(engine, map, { col: 10, row: 11 }, 'pc:aldric', 'npc:bram', undefined, [], new Set());
    const g = JSON.parse(obj(map, 'npc:warden').state!['rx:goal'] as string);
    expect(g.ttl).toBeGreaterThan(4); // distance-scaled, not the old fixed 4
  });

  it('emits NO progress fact when the goal-carrier could not actually move (honesty: no phantom approach)', () => {
    const stuck = knightAt('npc:warden', 15, 15);
    const { engine, state, map } = makeEngine([stuck]);
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (dr || dc) map.walkable![15 + dr]![15 + dc] = false; // wall it in
    setGoal(engine, 'npc:warden', { kind: 'reinforce', col: 10, row: 10, ttl: 4, bornTurn: 0 }, []);
    state.turnCount = 1;
    const facts = advanceGoals(engine, map, state, [], new Set());
    expect(obj(map, 'npc:warden')).toMatchObject({ col: 15, row: 15 }); // boxed in → did not move
    expect(facts.join(' ')).not.toMatch(/closing|strides|crossing|moves toward/); // and did not CLAIM it moved
  });

  it('expires a stale goal on return (wall-clock age past the cap), silently', () => {
    const far = knightAt('npc:warden', 27, 10);
    const { engine, state, map } = makeEngine([far]);
    setGoal(engine, 'npc:warden', { kind: 'reinforce', col: 10, row: 11, say: 'Hold!', ttl: 6, bornTurn: 0 }, []);
    state.turnCount = 30; // the party wandered off and came back 30 turns later
    const facts = advanceGoals(engine, map, state, [], new Set());
    expect(obj(map, 'npc:warden').state?.['rx:goal']).toBe(''); // cold goal dropped, not resurrected
    expect(facts.join(' ')).not.toMatch(/Hold!|reaches the scene/); // no shouting at empty air
  });
})

describe('P4e transgress — a witnessed CRIME is outrage, not fear (theft/desecration)', () => {
  const theft = (map: SceneMap): DisturbanceEvent => ({ aggressor: obj(map, 'pc:aldric'), target: obj(map, 'npc:bram'), kind: 'transgress' });

  it('the crowd is SCANDALISED, not frightened: authority moves to apprehend, none flee', () => {
    const { engine, map } = makeEngine();
    const out = resolveReactions(engine, map, theft(map), [], undefined, 'on');
    const joined = out.facts.join(' | ');
    expect(joined).toMatch(/Ser Kael.*(moves to stop|calling them out|glaring)/); // authority apprehends
    expect(joined).toMatch(/Hobb.*(over their goods|glaring)/); // keeper stands over their goods
    expect(joined).toMatch(/scandalised|disapproval|glaring/); // outrage vocabulary
    expect(joined).not.toMatch(/bolts away|breaks and bolts|flee the danger/); // nobody FLEES a pickpocket
  });

  it('drops the party standing with every witness who has a ledger card', () => {
    const { engine, state, map } = makeEngine();
    engine.upsertEntity({ id: 'npc:kael', kind: 'npc', name: 'Ser Kael' }); // the town knight, now a card
    expect(standingOf({ archetype: 'authority', temper: 'brave' } as any, state.ledger, 'npc:kael')).toBe(0); // stranger, pre-crime
    resolveReactions(engine, map, theft(map), [], state.ledger, 'on');
    expect(standingOf({ archetype: 'authority', temper: 'brave' } as any, engine.getState().ledger, 'npc:kael')).toBe(-1); // saw the theft → −1
  });

  it('still sends the watch (a crime summons the law to apprehend)', () => {
    const farKnight: MapObject = { id: 'npc:warden', kind: 'actor', role: 'npc', tag: 'knight', name: 'Warden', col: 27, row: 10, footprint: { w: 1, h: 1 }, facing: 'down', visible: true } as MapObject;
    const { engine, map } = makeEngine([farKnight]);
    resolveReactions(engine, map, theft(map), [], undefined, 'on');
    expect(obj(map, 'npc:warden').state?.['rx:goal']).toBeTruthy(); // dispatched to apprehend
  });

  it('docks a shared ledger identity ONCE, even when two same-named tokens both witness it (no double-drop)', () => {
    // Two visible "Town Guard" tokens (distinct ids) both join to the ONE ledger card by name.
    const g1: MapObject = { id: 'npc:guard-a', kind: 'actor', role: 'npc', tag: 'knight', name: 'Town Guard', col: 12, row: 12, footprint: { w: 1, h: 1 }, facing: 'down', visible: true } as MapObject;
    const g2: MapObject = { id: 'npc:guard-b', kind: 'actor', role: 'npc', tag: 'knight', name: 'Town Guard', col: 13, row: 12, footprint: { w: 1, h: 1 }, facing: 'down', visible: true } as MapObject;
    const { engine, state, map } = makeEngine([g1, g2]);
    engine.upsertEntity({ id: 'npc:guard', kind: 'npc', name: 'Town Guard' }); // the one card both tokens resolve to
    resolveReactions(engine, map, theft(map), [], state.ledger, 'on');
    expect(standingOf({ archetype: 'authority', temper: 'brave' } as any, engine.getState().ledger, 'npc:guard')).toBe(-1); // −1, not −2
    // exactly one live standing fact for that identity
    const live = (engine.getState().ledger?.facts ?? []).filter((f: any) => f.subject === 'npc:guard' && f.attribute === 'standing:party' && !f.supersededBy);
    expect(live.length).toBe(1);
  });
});

describe('P4e hazard — an environmental danger: everyone recoils, nobody charges it', () => {
  // A fire at (10,12). The acting PC is only the nominal "aggressor" (nearest PC); the crowd flees the LOCUS.
  const fire = (map: SceneMap): DisturbanceEvent => ({ aggressor: obj(map, 'pc:aldric'), kind: 'hazard', at: { col: 10, row: 12 } });

  it('even an authority backs away from a hazard (it does not confront a fire)', () => {
    const { engine, map } = makeEngine();
    resolveReactions(engine, map, fire(map), [], undefined, 'on');
    expect(obj(map, 'npc:town-knight').state?.['rx:verb']).toBe('back-away'); // NOT 'confront'
    expect(obj(map, 'npc:bystander-1').state?.['rx:verb']).toBe('flee'); // the timid bolt
  });

  it('summons no watch — there is no offender to apprehend', () => {
    const farKnight: MapObject = { id: 'npc:warden', kind: 'actor', role: 'npc', tag: 'knight', name: 'Warden', col: 27, row: 10, footprint: { w: 1, h: 1 }, facing: 'down', visible: true } as MapObject;
    const { engine, map } = makeEngine([farKnight]);
    resolveReactions(engine, map, fire(map), [], undefined, 'on');
    expect(obj(map, 'npc:warden').state?.['rx:goal']).toBeFalsy(); // no dispatch for a fire
  });

  it('bystanders flee AWAY FROM THE LOCUS, not from the PC', () => {
    const between: MapObject = { id: 'npc:tween', kind: 'actor', role: 'npc', tag: 'villager', col: 15, row: 10, footprint: { w: 1, h: 1 }, facing: 'down', visible: true } as MapObject;
    const { engine, map } = makeEngine([between]);
    map.objects = map.objects.filter((o) => ['pc:aldric', 'npc:tween'].includes(o.id));
    obj(map, 'pc:aldric').col = 5; obj(map, 'pc:aldric').row = 10; // PC on the LEFT
    resolveReactions(engine, map, { aggressor: obj(map, 'pc:aldric'), kind: 'hazard', at: { col: 20, row: 10 } }, [], undefined, 'on'); // fire on the RIGHT
    expect(obj(map, 'npc:tween').col).toBeLessThan(15); // fled left, away from the fire — toward the PC, not away from it
  });
});

describe('P4g covert — a quiet, hidden act: only a close, clear-view onlooker notices', () => {
  // A pickpocket (covert transgress). Distances: a witness 1 tile away (~5ft) vs one 9 tiles away (~45ft).
  function twoWitnesses(): ReturnType<typeof makeEngine> {
    const near: MapObject = { id: 'npc:near', kind: 'actor', role: 'npc', tag: 'villager', name: 'Nan', col: 11, row: 11, footprint: { w: 1, h: 1 }, facing: 'down', visible: true } as MapObject;
    const far: MapObject = { id: 'npc:far', kind: 'actor', role: 'npc', tag: 'villager', name: 'Far', col: 10, row: 20, footprint: { w: 1, h: 1 }, facing: 'down', visible: true } as MapObject;
    const made = makeEngine([near, far]);
    made.map.objects = made.map.objects.filter((o) => ['pc:aldric', 'npc:bram', 'npc:near', 'npc:far'].includes(o.id));
    return made;
  }
  const pick = (map: SceneMap, covert: boolean): DisturbanceEvent => ({ aggressor: obj(map, 'pc:aldric'), target: obj(map, 'npc:bram'), kind: 'transgress', covert });

  it('covert: the close onlooker reacts; the one 45ft off (in earshot) stays OBLIVIOUS', () => {
    const { engine, map } = twoWitnesses();
    const out = resolveReactions(engine, map, pick(map, true), [], undefined, 'on');
    expect(out.facts.some((f) => f.startsWith('Nan'))).toBe(true); // close + clear view → noticed
    expect(out.facts.some((f) => f.startsWith('Far'))).toBe(false); // 45ft: heard nothing (quiet), saw nothing → oblivious
  });

  it('the SAME act, done openly, would reach the far witness (covert is what silences them)', () => {
    const { engine, map } = twoWitnesses();
    const out = resolveReactions(engine, map, pick(map, false), [], undefined, 'on'); // not covert
    expect(out.facts.some((f) => f.startsWith('Far'))).toBe(true); // 45ft < 60ft earshot → alerted/reacts
  });

  it('a clean covert theft in an empty sightline draws NO reaction at all', () => {
    const { engine, map } = twoWitnesses();
    map.objects = map.objects.filter((o) => ['pc:aldric', 'npc:bram', 'npc:far'].includes(o.id)); // only the far one remains
    const out = resolveReactions(engine, map, pick(map, true), [], undefined, 'on');
    expect(out.facts).toEqual([]);
    expect(out.witnesses).toBe(0);
  });

  it('covert never dispatches the watch (nobody raised the alarm)', () => {
    const farKnight: MapObject = { id: 'npc:warden', kind: 'actor', role: 'npc', tag: 'knight', name: 'Warden', col: 27, row: 10, footprint: { w: 1, h: 1 }, facing: 'down', visible: true } as MapObject;
    const { engine, map } = makeEngine([farKnight]);
    resolveReactions(engine, map, { aggressor: obj(map, 'pc:aldric'), target: obj(map, 'npc:bram'), kind: 'transgress', covert: true }, [], undefined, 'on');
    expect(obj(map, 'npc:warden').state?.['rx:goal']).toBeFalsy(); // sneaky theft → no watch called
  });
});
