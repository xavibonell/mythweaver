import { describe, expect, it } from 'vitest';
import { Engine, createInitialState } from '@mythweaver/engine';
import { FakeLlmProvider, fakeText, fakeToolUse, type LlmContentBlock } from '@mythweaver/llm';
import { InMemoryRetriever } from '@mythweaver/rag';
import { FakeSceneComposer, type SceneComposer } from '@mythweaver/scene';
import { validateSceneMap, type CharacterSheet, type StatBlock } from '@mythweaver/shared';
import { runTurn } from './orchestrator.js';
import { FakeArcPlanner } from './arc-planner.js';

function goblinStat(): StatBlock {
  return {
    id: 'goblin',
    name: 'Goblin',
    size: 'small',
    type: 'humanoid (goblinoid)',
    armorClass: 15,
    hitPoints: { average: 7, formula: '2d6' },
    speedFt: 30,
    abilities: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
    challengeRating: 0.25,
    proficiencyBonus: 2,
    attacks: [{ name: 'Scimitar', attackBonus: 4, damage: '1d6+2', damageType: 'slashing' }],
    source: 'SRD 5.1',
  };
}

function fighter(): CharacterSheet {
  return {
    id: 'aldric',
    name: 'Aldric',
    ancestry: 'Human',
    className: 'Fighter',
    level: 1,
    abilities: { str: 16, dex: 14, con: 15, int: 11, wis: 13, cha: 9 },
    proficiencyBonus: 2,
    armorClass: 18,
    maxHitPoints: 12,
    speedFt: 30,
    skillProficiencies: ['athletics'],
    savingThrowProficiencies: ['str', 'con'],
    attacks: [{ name: 'Longsword', attackBonus: 5, damage: '1d8+3', damageType: 'slashing' }],
  };
}

function newEngine() {
  const state = createInitialState({ sessionId: 's1', scenarioId: 'test', startSceneId: 'start', party: [fighter()] });
  return new Engine(state, () => 0.5);
}

const frozenClock = () => 1000;

describe('orchestrator turn-loop', () => {
  it('resolves getState in-loop then narrates (multi-step, no roll)', async () => {
    const engine = newEngine();
    const llm = new FakeLlmProvider([
      fakeToolUse([{ id: 'g1', name: 'getState', input: {} }]),
      fakeText('The cellar is cold and dark.'),
    ]);

    const result = await runTurn({ engine, llm, now: frozenClock }, { kind: 'message', speakerId: 'Aldric', text: 'I look around.' });

    expect(result.rollRequest).toBeUndefined();
    expect(result.narration).toBe('The cellar is cold and dark.');
    expect(result.trace.steps).toBe(2);
    expect(result.trace.toolCalls).toEqual(['getState']);
    // The 2nd LLM call must have received a tool_result for getState.
    const secondCall = llm.requests[1]!;
    const lastMsg = secondCall.messages[secondCall.messages.length - 1]!;
    const blocks = lastMsg.content as LlmContentBlock[];
    expect(blocks[0]).toMatchObject({ type: 'tool_result', toolUseId: 'g1' });
  });

  it('suspends on a roll request, then resumes when the player declares the result', async () => {
    const engine = newEngine();
    const llm = new FakeLlmProvider([
      fakeToolUse([{ id: 'tu1', name: 'requestRoll', input: { expr: '1d20+5', reason: 'Athletics to climb', dc: 12 } }], 'You set your hands to the slick stone.'),
      fakeText('You haul yourself up and over the ledge.'),
    ]);

    const first = await runTurn({ engine, llm, now: frozenClock }, { kind: 'message', speakerId: 'Aldric', text: 'I climb the wall.' });
    expect(first.rollRequest).toMatchObject({ expr: '1d20+5', reason: 'Athletics to climb' });
    expect(first.narration).toBe('You set your hands to the slick stone.');
    expect(engine.getState().pendingTurn).toBeTruthy();

    const second = await runTurn(
      { engine, llm, now: frozenClock },
      { kind: 'roll', requestId: first.rollRequest!.id, total: 18 },
    );
    expect(second.narration).toBe('You haul yourself up and over the ledge.');
    expect(second.rollRequest).toBeUndefined();
    expect(engine.getState().pendingTurn).toBeUndefined();

    // The resume call must feed the roll result back as a tool_result for tu1.
    const resumeCall = llm.requests[1]!;
    const lastMsg = resumeCall.messages[resumeCall.messages.length - 1]!;
    const blocks = lastMsg.content as LlmContentBlock[];
    expect(blocks.some((b) => b.type === 'tool_result' && b.toolUseId === 'tu1')).toBe(true);
  });

  it('re-asks (does not advance) on an impossible declared roll (spec §4.3)', async () => {
    const engine = newEngine();
    const llm = new FakeLlmProvider([
      fakeToolUse([{ id: 'tu1', name: 'requestRoll', input: { expr: '1d20+5', reason: 'attack' } }]),
      fakeText('should-not-be-reached'),
    ]);

    const first = await runTurn({ engine, llm, now: frozenClock }, { kind: 'message', speakerId: 'Aldric', text: 'I attack.' });
    const bad = await runTurn({ engine, llm, now: frozenClock }, { kind: 'roll', requestId: first.rollRequest!.id, total: 99 });

    expect(bad.rollRequest).toMatchObject({ id: first.rollRequest!.id }); // still asking
    expect(engine.getState().pendingTurn).toBeTruthy(); // still paused
    expect(llm.requests).toHaveLength(1); // never called the LLM again
  });

  it('uses the stable playbook as the cacheable system prompt (no volatile state in it)', async () => {
    const engine = newEngine();
    const llm = new FakeLlmProvider([fakeText('Welcome, travelers.')]);
    await runTurn({ engine, llm, now: frozenClock }, { kind: 'message', speakerId: 'Aldric', text: 'Hello.' });
    const sys = llm.requests[0]!.system ?? '';
    expect(sys).toContain('You are MythWeaver');
    // The volatile per-turn state summary must NOT be in the cached system prompt.
    expect(sys).not.toContain('CURRENT STATE');
    const firstUser = llm.requests[0]!.messages[0]!;
    expect(String(firstUser.content)).toContain('CURRENT STATE');
  });

  it('feeds the engine success verdict back to the DM (P1 DC comparison)', async () => {
    const engine = newEngine();
    const llm = new FakeLlmProvider([
      fakeToolUse([{ id: 'tu1', name: 'requestRoll', input: { expr: '1d20+5', reason: 'Athletics', dc: 15 } }]),
      fakeText('You scrabble up and over the wall.'),
    ]);

    const first = await runTurn({ engine, llm, now: frozenClock }, { kind: 'message', speakerId: 'Aldric', text: 'I climb.' });
    await runTurn({ engine, llm, now: frozenClock }, { kind: 'roll', requestId: first.rollRequest!.id, total: 17 });

    const resumeCall = llm.requests[1]!;
    const lastMsg = resumeCall.messages[resumeCall.messages.length - 1]!;
    const blocks = lastMsg.content as LlmContentBlock[];
    const toolResult = blocks.find((b) => b.type === 'tool_result');
    const content = toolResult && toolResult.type === 'tool_result' ? toolResult.content : '';
    expect(content).toContain('"success":true'); // 17 vs DC 15 — engine decided, not the LLM
    expect(content).toContain('"dc":15');
  });

  it('lets the DM look up a rule and feeds the cited passage back (P1-3 RAG)', async () => {
    const engine = newEngine();
    const retriever = new InMemoryRetriever([
      { id: 'g1', source: 'PHB p.195', text: 'Grappling: you can use the Attack action to make a special melee attack to grab a creature.' },
    ]);
    const llm = new FakeLlmProvider([
      fakeToolUse([{ id: 'lr1', name: 'lookupRule', input: { query: 'how does grappling work' } }]),
      fakeText('You lunge to grab the goblin.'),
    ]);

    const result = await runTurn(
      { engine, llm, retriever, now: frozenClock },
      { kind: 'message', speakerId: 'Aldric', text: 'I grapple the goblin.' },
    );

    expect(result.narration).toBe('You lunge to grab the goblin.');
    expect(result.trace.toolCalls).toContain('lookupRule');

    const secondCall = llm.requests[1]!;
    const lastMsg = secondCall.messages[secondCall.messages.length - 1]!;
    const blocks = lastMsg.content as LlmContentBlock[];
    const tr = blocks.find((b) => b.type === 'tool_result');
    const content = tr && tr.type === 'tool_result' ? tr.content : '';
    expect(content).toContain('PHB p.195'); // citation
    expect(content).toContain('special melee attack');
  });

  it('does not offer lookupRule when no retriever is configured', async () => {
    const engine = newEngine();
    const llm = new FakeLlmProvider([fakeText('No corpus loaded.')]);
    await runTurn({ engine, llm, now: frozenClock }, { kind: 'message', speakerId: 'Aldric', text: 'Hello.' });
    const toolNames = (llm.requests[0]!.tools ?? []).map((t) => t.name);
    expect(toolNames).not.toContain('lookupRule');
    expect(toolNames).toContain('getState');
  });

  it('establishes a location, freezes it into the world graph, and returns the SceneMap', async () => {
    const engine = newEngine();
    const composer = new FakeSceneComposer();
    const llm = new FakeLlmProvider([
      fakeToolUse([
        {
          id: 's1',
          name: 'setScene',
          input: {
            locationId: 'loc:mistmoor-green',
            setting: 'a misty fen-village green at dusk, black water beyond',
            biome: 'village',
            timeOfDay: 'dusk',
            fixtures: [{ id: 'prop:fire', tag: 'bonfire', anchor: 'center' }],
            npcs: [
              { id: 'npc:edda', name: 'Edda', look: 'a wary fisherwoman', anchor: 'near:prop:fire', visible: true },
              { id: 'npc:orc', name: 'a shape in the reeds', look: 'a lurking orc', anchor: 'waterside', visible: false },
            ],
          },
        },
      ]),
      fakeText('Dusk settles on the silent green; a lantern stirs behind an oiled-hide window.'),
    ]);

    const result = await runTurn({ engine, llm, composer, now: frozenClock }, { kind: 'message', speakerId: 'Aldric', text: 'We arrive at Mistmoor.' });

    expect(result.trace.toolCalls).toEqual(['setScene']);
    expect(result.sceneChanged).toBe(true);
    expect(result.sceneMap).toBeTruthy();
    expect(validateSceneMap(result.sceneMap!)).toEqual({ ok: true, violations: [] });

    const world = engine.getState().world!;
    expect(world.currentLocationId).toBe('loc:mistmoor-green');
    const map = world.locations['loc:mistmoor-green']!;
    expect(map).toBe(result.sceneMap); // the returned map is the frozen one
    expect(map.objects.some((o) => o.id === 'pc:aldric')).toBe(true); // party injected by the engine
    expect(map.objects.find((o) => o.id === 'npc:edda')!.visible).toBe(true);
    expect(map.objects.find((o) => o.id === 'npc:orc')!.visible).toBe(false); // the lurker is present but hidden
  });

  it('reuses a frozen location on re-entry instead of regenerating it', async () => {
    const engine = newEngine();
    const base = new FakeSceneComposer();
    let composeCalls = 0;
    const composer: SceneComposer = {
      compose: (r) => {
        composeCalls++;
        return base.compose(r);
      },
    };
    const enter = { name: 'setScene', input: { locationId: 'loc:green', setting: 'a quiet green', biome: 'village', timeOfDay: 'day' } };
    const llm = new FakeLlmProvider([
      fakeToolUse([{ ...enter, id: 's1' }]),
      fakeText('You step onto the green.'),
      fakeToolUse([{ ...enter, id: 's2' }]),
      fakeText('You return to the familiar green.'),
    ]);

    const r1 = await runTurn({ engine, llm, composer, now: frozenClock }, { kind: 'message', speakerId: 'Aldric', text: 'enter the green' });
    const r2 = await runTurn({ engine, llm, composer, now: frozenClock }, { kind: 'message', speakerId: 'Aldric', text: 'return to the green' });

    expect(composeCalls).toBe(1); // generated once, REUSED on re-entry — nothing re-rolled
    expect(r1.sceneMap).toBe(r2.sceneMap); // the same frozen map
    expect(Object.keys(engine.getState().world!.locations)).toEqual(['loc:green']);
  });

  it('runs engine-authoritative combat: startEncounter spawns + applyDamage downs a monster', async () => {
    const state = createInitialState({
      sessionId: 's1',
      scenarioId: 'test',
      startSceneId: 'lair',
      party: [fighter()],
      bestiary: { goblin: goblinStat() },
      encounters: [{ id: 'e', sceneId: 'lair', monsters: [{ statBlockId: 'goblin', count: 1 }] }],
    });
    const engine = new Engine(state, () => 0.5);
    const llm = new FakeLlmProvider([
      fakeToolUse([{ id: 'se', name: 'startEncounter', input: {} }]),
      fakeToolUse([{ id: 'dmg', name: 'applyDamage', input: { targetId: 'npc:goblin-1', amount: 99, type: 'slashing' } }]),
      fakeText('The goblin crumples into the muck.'),
    ]);

    const result = await runTurn({ engine, llm, now: frozenClock }, { kind: 'message', speakerId: 'Aldric', text: 'I cut the goblin down.' });

    expect(result.trace.toolCalls).toEqual(['startEncounter', 'applyDamage']);
    // The DM passed a ROLLED total; the engine applied it and, as the last foe dropped, auto-resolved
    // the fight (P0 state-truth): combat clears and the defeated foe stops being listed as present.
    expect(engine.getState().combat.active).toBe(false);
    expect(engine.getState().combatants['npc:goblin-1']).toBeUndefined();
    expect(result.narration).toContain('crumples');
  });

  it('advances the adventure beat via the advanceScene tool (soft arc steering)', async () => {
    const state = createInitialState({
      sessionId: 's1',
      scenarioId: 'test',
      startSceneId: 'green',
      party: [fighter()],
      adventure: { pitch: 'p', scenes: { green: { title: 'Green', summary: '', exits: ['tower'] }, tower: { title: 'Tower', summary: '', exits: [] } } },
    });
    const engine = new Engine(state, () => 0.5);
    const llm = new FakeLlmProvider([
      fakeToolUse([{ id: 'av', name: 'advanceScene', input: { toSceneId: 'tower' } }]),
      fakeText('You cross the fen to the crooked tower.'),
    ]);

    const result = await runTurn({ engine, llm, now: frozenClock }, { kind: 'message', speakerId: 'Aldric', text: 'We head for the tower.' });

    expect(result.trace.toolCalls).toContain('advanceScene');
    expect(engine.getState().currentSceneId).toBe('tower');
    expect(engine.getState().flags['beat:green']).toBe('done');
  });

  it('Game Director (D2) re-plans + injects the STEERING brief into the DM prompt', async () => {
    const state = createInitialState({
      sessionId: 's1',
      scenarioId: 'test',
      startSceneId: 'green',
      party: [fighter()],
      adventure: { pitch: 'p', scenes: { green: { title: 'Green', summary: 'Dusk on the green.', exits: ['tower'] }, tower: { title: 'Tower', summary: '', exits: [] } } },
    });
    const engine = new Engine(state, () => 0.5);
    const llm = new FakeLlmProvider([fakeText('Mist coils over the green.')]);

    const result = await runTurn({ engine, llm, arcPlanner: new FakeArcPlanner(), now: frozenClock }, { kind: 'message', speakerId: 'Aldric', text: 'We look around.' });

    expect(result.narration).toBe('Mist coils over the green.');
    expect(result.trace.toolCalls).toContain('arcPlanner');
    const arc = engine.getState().arc;
    expect(arc?.brief?.activeBeatIntent).toBe('Dusk on the green.');
    expect(arc?.plannedForScene).toBe('green');
    // the brief was injected into the DM's per-turn prompt
    const userMsg = String(llm.requests[0]!.messages[0]!.content);
    expect(userMsg).toContain('STEERING (Game Director');
    expect(userMsg).toContain('Dusk on the green.');
  });

  it('re-plans only on a high-signal change — incl. an NPC-standing flag (not every turn)', async () => {
    const state = createInitialState({
      sessionId: 's1',
      scenarioId: 'test',
      startSceneId: 'green',
      party: [fighter()],
      adventure: { pitch: 'p', scenes: { green: { title: 'Green', summary: 'Dusk.', exits: ['tower'] }, tower: { title: 'Tower', summary: '', exits: [] } } },
    });
    const engine = new Engine(state, () => 0.5);
    let planCalls = 0;
    const counting = {
      architect: async () => ({ blueprint: { premise: '', centralProblem: '', intendedEnding: '', opening: '', spine: [] }, costUsd: 0 }),
      plan: async () => { planCalls += 1; return { brief: { activeBeatIntent: 'x', reachable: [] }, costUsd: 0 }; },
    };
    const llm = new FakeLlmProvider([fakeText('a'), fakeText('b'), fakeText('c')]);
    const run = (text: string) => runTurn({ engine, llm, arcPlanner: counting, now: frozenClock }, { kind: 'message', speakerId: 'Aldric', text });

    await run('look around'); // no brief -> plan #1
    expect(planCalls).toBe(1);
    await run('keep looking'); // same scene, no new flags -> reuse
    expect(planCalls).toBe(1);
    engine.setArcFlag('npc:edda:trust', 'low'); // NPC standing changed
    await run('press Edda'); // -> re-plan #2
    expect(planCalls).toBe(2);
  });
});
