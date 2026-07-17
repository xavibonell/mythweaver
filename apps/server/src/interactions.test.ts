import { describe, expect, it } from 'vitest';
import type { CharacterSheet, GameState, MapObject, SceneDelta, SceneMap } from '@mythweaver/shared';
import { Engine, createInitialState } from '@mythweaver/engine';
import { assessCommand, commandDC, commandFact, forbiddenCommand, narrationDefiesCommand, resolveInteraction, resolveReactions, specForArchetype, standingOf, type DisturbanceEvent, type Stimulus } from './interactions.js';

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
