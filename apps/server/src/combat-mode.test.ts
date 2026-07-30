import { describe, expect, it } from 'vitest';
import { Engine, createInitialState } from '@mythweaver/engine';
import { FakeLlmProvider, fakeText, fakeToolUse } from '@mythweaver/llm';
import type { CharacterSheet, GameState, MapObject, SceneMap, StatBlock } from '@mythweaver/shared';
import { runTurn } from './orchestrator.js';
import { runEnemyPhase } from './combat-phase.js';

/**
 * COMBAT MODE C1 — the orchestrator gates + the enemy phase (docs/COMBAT-MODE.md §4.2-4.3).
 * All deterministic: FakeLlm scripts the DM, a seeded RNG rolls the world's dice. These are the
 * "eval cases" of the slice — out-of-turn refused for $0, the second swing refused, enemies that
 * actually act — kept as vitest so they run on every push instead of costing API money.
 */

const COLS = 20, ROWS = 20;
function arena(extra: MapObject[] = []): SceneMap {
  const tiles = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => 'grass'));
  const walkable = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => true));
  return {
    locationId: 'loc:arena', seed: 1, biome: 'village', lighting: 'day', grammar: 'town-square',
    grid: { cols: COLS, rows: ROWS, feetPerTile: 5 }, tiles, walkable,
    objects: [
      { id: 'pc:pc-1', kind: 'actor', role: 'pc', tag: 'knight', name: 'Aldric', col: 5, row: 5, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
      { id: 'pc:pc-2', kind: 'actor', role: 'pc', tag: 'wizard', name: 'Elara', col: 6, row: 5, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
      ...extra,
    ],
    ambiance: [], entrances: [], roofs: [],
  } as unknown as SceneMap;
}

const sheet = (id: string, name: string): CharacterSheet => ({
  id, name, ancestry: 'Human', className: 'Fighter', level: 1,
  abilities: { str: 16, dex: 14, con: 15, int: 11, wis: 13, cha: 9 },
  proficiencyBonus: 2, armorClass: 10, maxHitPoints: 12, speedFt: 30,
  skillProficiencies: [], savingThrowProficiencies: ['str'], attacks: [],
});

const BANDIT: StatBlock = {
  id: 'bandit', name: 'Bandit', size: 'medium', type: 'humanoid', armorClass: 12,
  hitPoints: { average: 11, formula: '2d8+2' }, speedFt: 30,
  abilities: { str: 11, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
  challengeRating: 0.125, proficiencyBonus: 2,
  attacks: [{ name: 'Scimitar', attackBonus: 3, damage: '1d6+1', damageType: 'slashing' }],
  source: 'SRD 5.1',
};

/** A live fight: 2 PCs, 2 bandits adjacent, initiative rolled, seeded dice (0.5 → d20=11, d6=4). */
function liveFight(): { engine: Engine; state: GameState } {
  const state = createInitialState({
    sessionId: 's', scenarioId: 't', startSceneId: 'x',
    party: [sheet('pc-1', 'Aldric'), sheet('pc-2', 'Elara')],
    bestiary: { bandit: BANDIT },
    encounters: [{ id: 'e1', sceneId: 'x', monsters: [{ statBlockId: 'bandit', count: 2 }] }],
  });
  state.world = { currentLocationId: 'loc:arena', locations: { 'loc:arena': arena([
    { id: 'npc:bandit-1', kind: 'actor', role: 'npc', tag: 'bandit', name: 'Bandit 1', col: 5, row: 6, footprint: { w: 1, h: 1 }, facing: 'up', visible: true },
    { id: 'npc:bandit-2', kind: 'actor', role: 'npc', tag: 'bandit', name: 'Bandit 2', col: 6, row: 6, footprint: { w: 1, h: 1 }, facing: 'up', visible: true },
  ]) }, links: [] } as GameState['world'];
  const engine = new Engine(state, () => 0.5);
  engine.startEncounter('x');
  // startEncounter SPAWNS its own combatants; pin the two spawned ids onto the pre-staged tokens so
  // combatant ids and map ids agree (what the fixture builder guarantees in production).
  const map = state.world!.locations['loc:arena']!;
  const spawned = Object.values(state.combatants).filter((c) => c.kind === 'npc');
  spawned.forEach((c, i) => { const tok = map.objects.find((o) => o.id === `npc:bandit-${i + 1}`); if (tok) tok.id = c.id; });
  return { engine, state };
}

const frozenClock = () => 1000;
const activePc = (engine: Engine, state: GameState): string | undefined => {
  while (state.combat.active && engine.activeCombatant()?.kind === 'npc') engine.endTurn(engine.activeCombatant()!.id);
  return engine.activeCombatant()?.name;
};

describe('the pre-LLM combat gate — out-of-turn costs nothing and calls nobody', () => {
  it('refuses a message from the wrong PC without an LLM call, naming whose turn it is', async () => {
    const { engine, state } = liveFight();
    const active = activePc(engine, state)!; // walk to the first PC turn
    const other = active === 'Aldric' ? 'Elara' : 'Aldric';
    const llm = new FakeLlmProvider([]); // ANY call would throw — the gate must answer alone
    const result = await runTurn({ engine, llm, now: frozenClock }, { kind: 'message', speakerId: other, text: 'I attack!' });
    expect(result.costUsd).toBe(0);
    expect(result.narration).toContain(`${active}'s turn`);
    expect(llm.requests).toHaveLength(0);
  });

  it('lets the ACTIVE PC through to the DM', async () => {
    const { engine, state } = liveFight();
    const active = activePc(engine, state)!;
    const llm = new FakeLlmProvider([fakeText('The DM answers.')]);
    const result = await runTurn({ engine, llm, now: frozenClock }, { kind: 'message', speakerId: active, text: 'I size them up.' });
    expect(result.narration).toBe('The DM answers.');
  });

  it('typed "end turn" IS the End Turn button', async () => {
    const { engine, state } = liveFight();
    const active = activePc(engine, state)!;
    const before = state.combat.order[state.combat.turnIndex];
    const llm = new FakeLlmProvider([]);
    const result = await runTurn({ engine, llm, now: frozenClock }, { kind: 'message', speakerId: active, text: 'end turn' });
    expect(result.costUsd).toBe(0);
    expect(state.combat.order[state.combat.turnIndex]).not.toBe(before);
  });
});

describe('the action is a budget the tools enforce', () => {
  it('a second attack the same turn is refused at the tool layer with a narratable note', async () => {
    const { engine, state } = liveFight();
    const active = activePc(engine, state)!;
    const activeId = state.combat.order[state.combat.turnIndex]!;
    const targetId = Object.values(state.combatants).find((c) => c.kind === 'npc')!.id;
    const llm = new FakeLlmProvider([
      fakeToolUse([{ id: 't1', name: 'requestRoll', input: { expr: '1d20+5', reason: 'first swing', dc: 12, combatantId: activeId, targetId, attack: 'melee' } }], 'He swings once—'),
      // resume after the declared roll: the DM immediately tries a SECOND attack roll
      fakeToolUse([{ id: 't2', name: 'requestRoll', input: { expr: '1d20+5', reason: 'second swing', dc: 12, combatantId: activeId, targetId, attack: 'melee' } }]),
      fakeText('The opening is gone.'),
    ]);
    const first = await runTurn({ engine, llm, now: frozenClock }, { kind: 'message', speakerId: active, text: 'I attack the bandit!' });
    expect(first.rollRequest).toBeTruthy(); // first swing armed the dice (action spent NOW)
    const second = await runTurn({ engine, llm, now: frozenClock }, { kind: 'roll', requestId: first.rollRequest!.id, total: 18 });
    expect(second.narration).toBe('The opening is gone.');
    // The second requestRoll was refused as a tool result — the last request carries the block.
    const lastReq = llm.requests.at(-1)!;
    expect(JSON.stringify(lastReq.messages.at(-1))).toContain('action-economy');
    expect(state.pendingTurn).toBeUndefined(); // no second die ever hung
  });
});

describe('the enemy phase — the world finally answers', () => {
  it('bandits act on their own dice, damage lands, ONE narration call covers the phase', async () => {
    const { engine, state } = liveFight();
    // Fast-forward so a bandit block is up next (end PC turns only).
    while (engine.activeCombatant()?.kind === 'pc') engine.endTurn(engine.activeCombatant()!.id);
    const llm = new FakeLlmProvider([fakeText('Steel answers steel — the bandits press in. Aldric, you\'re up.')]);
    const hpBefore = Object.values(state.combatants).filter((c) => c.kind === 'pc').map((c) => c.currentHitPoints);
    const phase = await runEnemyPhase({ engine, llm, playbook: 'You are the DM.' });
    expect(phase).toBeTruthy();
    // Seeded d20=11 +3 = 14 vs PC AC 10 → both bandits HIT for 4+1=5.
    const hpAfter = Object.values(state.combatants).filter((c) => c.kind === 'pc').map((c) => c.currentHitPoints);
    expect(hpAfter.reduce((a, b) => a + b, 0)).toBeLessThan(hpBefore.reduce((a, b) => a + b, 0));
    expect(phase!.facts.some((f) => /hits/i.test(f))).toBe(true);
    expect(llm.requests).toHaveLength(1); // the whole phase = one narration call
    expect(engine.activeCombatant()?.kind).toBe('pc'); // the table lands on a player
  });

  it('does nothing when a PC is already active (never steals a player turn)', async () => {
    const { engine, state } = liveFight();
    activePc(engine, state);
    const llm = new FakeLlmProvider([]);
    expect(await runEnemyPhase({ engine, llm, playbook: 'x' })).toBeNull();
  });

  it('stops dead when no conscious PC remains — a beaten party is a scene, not a loop', async () => {
    const { engine, state } = liveFight();
    for (const pc of Object.values(state.combatants).filter((c) => c.kind === 'pc')) {
      pc.downed = true;
    }
    while (state.combat.active && engine.activeCombatant()?.kind === 'pc') engine.endTurn(engine.activeCombatant()!.id);
    const llm = new FakeLlmProvider([fakeText('They stand over you.')]);
    const phase = await runEnemyPhase({ engine, llm, playbook: 'x' });
    expect(phase?.facts.some((f) => f.includes('No one is left standing'))).toBe(true);
    expect(state.combat.active).toBe(true); // the fight state survives for the Director's aftermath
  });
});
