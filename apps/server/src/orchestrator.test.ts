import { describe, expect, it } from 'vitest';
import { Engine, createInitialState } from '@mythweaver/engine';
import { FakeLlmProvider, fakeText, fakeToolUse, type LlmContentBlock } from '@mythweaver/llm';
import { InMemoryRetriever } from '@mythweaver/rag';
import { FakeSceneComposer, buildSceneMap, type SceneComposer } from '@mythweaver/scene';
import { validateSceneMap, type CharacterSheet, type EstablishScene, type SceneRealizeContext, type StatBlock } from '@mythweaver/shared';
import { runTurn, canonBlock, parseEstablish, classifySpeechAct, classifyBuilding, deriveBuildings } from './orchestrator.js';
import { FakeArcPlanner } from './arc-planner.js';
import type { GameState } from '@mythweaver/shared';

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

  it('hands the modern realizer the campaign fiction (premise + beat) and the DM-declared kind/mood', async () => {
    const state = createInitialState({
      sessionId: 's1',
      scenarioId: 'test',
      startSceneId: 'beat-1',
      party: [fighter()],
      adventure: {
        pitch: 'A drowned bell tolls beneath a flooded mining town.',
        scenes: {
          'beat-1': {
            title: 'The Rising Bell',
            summary: 'The party reaches the reservoir shore where the bell rope rises.',
            scenePlan: { look: 'a half-drowned town on a black reservoir; a bell rope rises from the water', kind: 'settlement', mood: 'grim predawn fog', features: ['bell rope', 'drowned church'] },
          },
        },
      },
    });
    state.arc = {
      blueprint: {
        premise: 'a gothic three-scene horror about a debt owed to a bell-founder',
        centralProblem: 'the bell rises higher each night',
        intendedEnding: 'the debt is paid',
        opening: 'the shore',
        spine: [],
      },
    };
    const engine = new Engine(state, () => 0.5);
    const captured: { est?: EstablishScene; ctx?: SceneRealizeContext } = {};
    const realizeScene = async (est: EstablishScene, _party: unknown, ctx?: SceneRealizeContext) => {
      captured.est = est;
      captured.ctx = ctx;
      return null; // decline → the classic composer still delivers a map (fallback intact)
    };
    const llm = new FakeLlmProvider([
      fakeToolUse([{
        id: 's1',
        name: 'setScene',
        input: {
          locationId: 'loc:drowned-shore',
          setting: 'the drowned shore of the reservoir',
          kind: 'wild',
          mood: 'grim predawn fog',
          biome: 'village',
          timeOfDay: 'dusk',
        },
      }]),
      fakeText('The fog swallows the shore.'),
    ]);

    const result = await runTurn(
      { engine, llm, composer: new FakeSceneComposer(), realizeScene, now: frozenClock },
      { kind: 'message', speakerId: 'Aldric', text: 'We walk down to the water.' },
    );

    // The campaign fiction the tool call can't carry reached the realizer…
    expect(captured.ctx?.premise).toBe('a gothic three-scene horror about a debt owed to a bell-founder');
    expect(captured.ctx?.beat).toEqual({ id: 'beat-1', title: 'The Rising Bell', summary: 'The party reaches the reservoir shore where the bell rope rises.' });
    // …including the beat's authored ScenePlan (Phase C — the designed look flows to the generator).
    expect(captured.ctx?.scenePlan?.look).toContain('half-drowned town');
    expect(captured.ctx?.scenePlan?.kind).toBe('settlement');
    // …and the DM's new declaration fields were parsed.
    expect(captured.est?.kind).toBe('wild');
    expect(captured.est?.brief.mood).toBe('grim predawn fog');
    expect(captured.est?.timeOfDayExplicit).toBe(true);
    // The decline fell back to the classic composer — the turn still produced a scene,
    // and the provenance says so honestly (FakeSceneComposer → engine 'fake').
    expect(result.sceneChanged).toBe(true);
    expect(result.sceneMap).toBeTruthy();
    expect(result.sceneProvenance?.engine).toBe('fake');
    expect(result.sceneProvenance?.reused).toBe(false);
    expect(result.sceneProvenance?.toolInput).toMatchObject({ locationId: 'loc:drowned-shore', kind: 'wild' });
  });

  it('provenance: modern realizer result is attached; a frozen re-entry says so', async () => {
    const engine = newEngine();
    const composer = new FakeSceneComposer();
    // Pre-build a real map for the fake modern realizer to return.
    const preMap = buildSceneMap(await composer.compose({
      establish: { locationId: 'loc:keep', brief: { setting: 'a keep', biome: 'village', timeOfDay: 'day' }, fixtures: [], npcs: [] },
      party: [],
      seed: 7,
    }));
    const realizeScene = async () => ({
      sceneMap: preMap,
      provenance: { locationId: 'loc:keep' as const, engine: 'modern' as const, reused: false, enrichedBrief: 'the keep brief', lightingReason: 'mood' as const },
    });
    const enter = { name: 'setScene', input: { locationId: 'loc:keep', setting: 'a stone keep', biome: 'village' } };
    const llm = new FakeLlmProvider([
      fakeToolUse([{ ...enter, id: 's1' }]),
      fakeText('You approach the keep.'),
      fakeToolUse([{ ...enter, id: 's2' }]),
      fakeText('You return to the keep.'),
    ]);

    const r1 = await runTurn({ engine, llm, composer, realizeScene, now: frozenClock }, { kind: 'message', speakerId: 'Aldric', text: 'to the keep' });
    const r2 = await runTurn({ engine, llm, composer, realizeScene, now: frozenClock }, { kind: 'message', speakerId: 'Aldric', text: 'back to the keep' });

    // First visit: the modern provenance rides the turn, with the raw tool input merged in.
    expect(r1.sceneProvenance?.engine).toBe('modern');
    expect(r1.sceneProvenance?.enrichedBrief).toBe('the keep brief');
    expect(r1.sceneProvenance?.toolInput).toMatchObject({ locationId: 'loc:keep' });
    // Re-entry: nothing regenerated — the provenance is honest about the frozen reuse.
    expect(r2.sceneProvenance?.engine).toBe('frozen');
    expect(r2.sceneProvenance?.reused).toBe(true);
    expect(r2.sceneMap).toBe(r1.sceneMap);
  });

  it('parseEstablish: the coerced day default is NOT an explicit time declaration', () => {
    const stub = { world: { currentLocationId: null, locations: {}, links: [] } } as unknown as GameState;
    const est = parseEstablish({ setting: 'a quiet place' }, stub);
    expect(est.brief.timeOfDay).toBe('day');
    expect(est.timeOfDayExplicit).toBeUndefined(); // phantom 'day' must never beat mood-inferred lighting
    expect(est.kind).toBeUndefined();

    const est2 = parseEstablish({ setting: 'a crypt', timeOfDay: 'night', kind: 'interior', mood: 'grim and still' }, stub);
    expect(est2.timeOfDayExplicit).toBe(true);
    expect(est2.kind).toBe('interior');
    expect(est2.brief.mood).toBe('grim and still');
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

  it('updateScene: the DM moves the world — applied deltas ride the turn, refusals come back as reasons', async () => {
    const engine = newEngine();
    const composer = new FakeSceneComposer();
    const llm = new FakeLlmProvider([
      fakeToolUse([{
        id: 's1',
        name: 'setScene',
        input: {
          locationId: 'loc:green',
          setting: 'a quiet green with a bonfire',
          biome: 'village',
          fixtures: [{ id: 'prop:fire', tag: 'bonfire', anchor: 'center' }],
          npcs: [{ id: 'npc:edda', name: 'Edda', look: 'a wary fisherwoman', visible: true }],
        },
      }]),
      fakeText('The green at dusk.'),
      fakeToolUse([{
        id: 'u1',
        name: 'updateScene',
        input: {
          changes: [
            { op: 'move', id: 'npc:edda', to: 'near:prop:fire' },
            { op: 'move', id: 'npc:ghost', to: 'center' }, // nobody by that id → refused with a reason
            { op: 'spawn', id: 'npc:stranger', look: 'a hooded traveler', name: 'the stranger', to: 'entrance' },
          ],
        },
      }]),
      fakeText('Edda drifts to the fire as a stranger appears at the gate.'),
    ]);

    await runTurn({ engine, llm, composer, now: frozenClock }, { kind: 'message', speakerId: 'Aldric', text: 'We arrive.' });
    const r2 = await runTurn({ engine, llm, composer, now: frozenClock }, { kind: 'message', speakerId: 'Aldric', text: 'We warm our hands.' });

    expect(r2.trace.toolCalls).toContain('updateScene');
    // Applied deltas ride the turn, moves normalized to concrete tiles.
    const move = r2.deltas!.find((d) => d.op === 'move' && d.id === 'npc:edda') as { to: { col: number; row: number } };
    expect(move).toBeTruthy();
    const map = engine.getState().world!.locations['loc:green']!;
    const edda = map.objects.find((o) => o.id === 'npc:edda')!;
    expect({ col: edda.col, row: edda.row }).toEqual(move.to); // the map itself was mutated
    const fire = map.objects.find((o) => o.id === 'prop:fire')!;
    expect(Math.max(Math.abs(edda.col - fire.col), Math.abs(edda.row - fire.row))).toBeLessThanOrEqual(4); // she is BY the fire
    // The spawn landed with a resolved tile.
    const spawn = r2.deltas!.find((d) => d.op === 'spawn') as { at?: { col: number; row: number } };
    expect(spawn?.at).toBeTruthy();
    expect(map.objects.some((o) => o.id === 'npc:stranger')).toBe(true);
    // The refusal was fed back to the DM as a narratable reason.
    const toolResult = llm.requests[3]!.messages.at(-1)!.content as LlmContentBlock[];
    const feedback = JSON.stringify(toolResult);
    expect(feedback).toContain('npc:ghost');
    expect(feedback).toContain('rejected');
  });

  it('combat sync: startEncounter pops monster tokens onto the map; endEncounter clears the fallen', async () => {
    const state = createInitialState({
      sessionId: 's1',
      scenarioId: 'test',
      startSceneId: 'lair',
      party: [fighter()],
      bestiary: { goblin: goblinStat() },
      encounters: [{ id: 'e', sceneId: 'lair', monsters: [{ statBlockId: 'goblin', count: 2 }] }],
    });
    const engine = new Engine(state, () => 0.5);
    const composer = new FakeSceneComposer();
    const llm = new FakeLlmProvider([
      fakeToolUse([{ id: 's1', name: 'setScene', input: { locationId: 'loc:lair', setting: 'a dank lair', biome: 'cave' } }]),
      fakeText('The lair breathes cold.'),
      fakeToolUse([{ id: 'se', name: 'startEncounter', input: {} }]),
      fakeText('Goblins burst from the shadows!'),
    ]);

    await runTurn({ engine, llm, composer, now: frozenClock }, { kind: 'message', speakerId: 'Aldric', text: 'We enter.' });
    const r2 = await runTurn({ engine, llm, composer, now: frozenClock }, { kind: 'message', speakerId: 'Aldric', text: 'We attack!' });

    // The engine-owned sync spawned one token per combatant, near the party, without the DM doing anything.
    const spawns = (r2.deltas ?? []).filter((d) => d.op === 'spawn');
    expect(spawns).toHaveLength(2);
    const map = engine.getState().world!.locations['loc:lair']!;
    expect(map.objects.filter((o) => o.id.startsWith('npc:goblin')).length).toBe(2);
    const pc = map.objects.find((o) => o.role === 'pc')!;
    for (const s of spawns as { at: { col: number; row: number } }[]) {
      expect(Math.max(Math.abs(s.at.col - pc.col), Math.abs(s.at.row - pc.row))).toBeLessThanOrEqual(5); // near the party
    }
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
      adventure: {
        pitch: 'p',
        scenes: {
          green: { title: 'Green', summary: '', exits: ['tower'] },
          tower: { title: 'The Crooked Tower', summary: 'The belfry gapes.', scenePlan: { look: 'a leaning bell tower on a causeway over black water', kind: 'interior', mood: 'moonless dark' } },
        },
      },
    });
    const engine = new Engine(state, () => 0.5);
    const llm = new FakeLlmProvider([
      fakeToolUse([{ id: 'av', name: 'advanceScene', input: { toSceneId: 'tower', outcome: 'resolved' } }]),
      fakeText('You cross the fen to the crooked tower.'),
    ]);

    const result = await runTurn({ engine, llm, now: frozenClock }, { kind: 'message', speakerId: 'Aldric', text: 'We head for the tower.' });

    expect(result.trace.toolCalls).toContain('advanceScene');
    expect(engine.getState().currentSceneId).toBe('tower');
    expect(engine.getState().flags['beat:green']).toBe('resolved');
    // The transition rides the turn (title card client-side)…
    expect(result.beat).toEqual({ from: 'green', to: 'tower', title: 'The Crooked Tower', outcome: 'resolved' });
    // …and the tool RESULT directs the DM to establish the new location NOW, with the beat's
    // authored visual brief (the Phase-C ScenePlan consumed at the transition seam).
    const feedback = JSON.stringify(llm.requests[1]!.messages.at(-1)!.content);
    expect(feedback).toContain('Establish its location NOW with setScene');
    expect(feedback).toContain('a leaning bell tower on a causeway');
    expect(feedback).toContain('moonless dark');
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

describe('canonBlock — deterministic CANON injection (P1)', () => {
  const state = {
    currentSceneId: 'a',
    ledger: {
      entities: {
        'npc:edda': { id: 'npc:edda', kind: 'npc', name: 'Edda', scenes: ['a'], voice: { tic: 'wrings her hands' } },
        'npc:mabon': { id: 'npc:mabon', kind: 'npc', name: 'Mabon', scenes: ['b'] },
        'npc:gorm': { id: 'npc:gorm', kind: 'npc', name: 'Gorm', scenes: ['c'] },
      },
      facts: [
        { id: 'fact:1', subject: 'party', attribute: 'has', value: 'nothing yet', turn: 1, source: 'dm', supersededBy: 'fact:2' },
        { id: 'fact:2', subject: 'party', attribute: 'has', value: 'a silver key and a map', turn: 2, source: 'dm' },
      ],
      plants: {},
    },
  } as unknown as GameState;

  it('injects scene-native + name-mentioned entities and live party facts; excludes off-scene + superseded', () => {
    const out = canonBlock(state, 'we ask Gorm what he saw');
    expect(out).toContain('Edda'); // native to the current scene
    expect(out).toContain('wrings her hands'); // its voice comes along
    expect(out).toContain('Gorm'); // mentioned by name in the turn context
    expect(out).not.toContain('Mabon'); // neither native to scene a nor mentioned
    expect(out).toContain('a silver key and a map'); // the LIVE party fact
    expect(out).not.toContain('nothing yet'); // the superseded fact is not shown
  });

  it('returns empty when the ledger is empty', () => {
    expect(canonBlock({ currentSceneId: 'a', ledger: { entities: {}, facts: [], plants: {} } } as unknown as GameState, 'x')).toBe('');
    expect(canonBlock({ currentSceneId: 'a' } as unknown as GameState, 'x')).toBe('');
  });

  it('ALWAYS injects the party (kind:pc) under a PARTY header, even off-scene and unmentioned', () => {
    const withPc = {
      currentSceneId: 'z', // no entity is native here
      ledger: {
        entities: {
          'pc-1-fighter': { id: 'pc-1-fighter', kind: 'pc', name: 'Aldric', notes: 'a disgraced knight seeking his lost blade' },
          'npc:mabon': { id: 'npc:mabon', kind: 'npc', name: 'Mabon', scenes: ['b'] },
        },
        facts: [],
        plants: {},
      },
    } as unknown as GameState;
    const out = canonBlock(withPc, 'the party rests quietly'); // mentions no one by name
    expect(out).toContain('PARTY');
    expect(out).toContain('Aldric');
    expect(out).toContain('a disgraced knight seeking his lost blade'); // backstory (notes) rendered
    expect(out).not.toContain('Mabon'); // NPC off-scene + unmentioned stays out
  });
});

describe('movement backstop (token truth is engine-owned, not LLM-optional)', () => {
  function withWorld(engine: Engine): GameState {
    const state = engine.getState();
    const cols = 12, rows = 8;
    state.world = {
      currentLocationId: 'loc:shore',
      locations: {
        'loc:shore': {
          locationId: 'loc:shore', seed: 1, biome: 'village', lighting: 'dusk', grammar: 'open-outdoor',
          grid: { cols, rows, feetPerTile: 5 },
          tiles: Array.from({ length: rows }, () => Array.from({ length: cols }, () => 'grass')),
          walkable: Array.from({ length: rows }, () => Array.from({ length: cols }, () => true)),
          objects: [
            { id: 'pc:aldric', kind: 'actor', role: 'pc', tag: 'knight', name: 'Aldric', col: 1, row: 1, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
            { id: 'npc:sedge', kind: 'actor', role: 'npc', tag: 'villager', name: 'Mother Sedge', col: 8, row: 2, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
            { id: 'npc:keeper-1', kind: 'actor', role: 'npc', tag: 'villager', col: 3, row: 3, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
            { id: 'prop:weir1', kind: 'prop', tag: 'weir', col: 9, row: 5, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
          ],
          ambiance: [], entrances: [],
        },
      },
      links: [],
    };
    return state;
  }
  const pcAt = (state: GameState) => {
    const o = state.world!.locations['loc:shore']!.objects.find((x) => x.id === 'pc:aldric')!;
    return { col: o.col, row: o.row };
  };

  it('narration-only DM + "I go to <named NPC>" → the engine moves the token anyway', async () => {
    const engine = newEngine();
    const state = withWorld(engine);
    const llm = new FakeLlmProvider([fakeText('You cross the planks toward the old woman.')]);
    const result = await runTurn({ engine, llm, now: frozenClock }, { kind: 'message', speakerId: 'Aldric', text: 'I go to Mother Sedge and ask about the bell.' });
    const move = (result.deltas ?? []).find((d) => d.op === 'move' && d.id === 'pc:aldric');
    expect(move).toBeTruthy();
    const at = pcAt(state);
    expect(Math.abs(at.col - 8) + Math.abs(at.row - 2)).toBeLessThanOrEqual(3); // landed near Sedge, not at (1,1)
  });

  it('"go to the guy over there" → nearest visible NPC wins (no name needed)', async () => {
    const engine = newEngine();
    const state = withWorld(engine);
    const llm = new FakeLlmProvider([fakeText('You walk over.')]);
    const result = await runTurn({ engine, llm, now: frozenClock }, { kind: 'message', speakerId: 'Aldric', text: 'go to the first guy and ask what is going on' });
    expect((result.deltas ?? []).some((d) => d.op === 'move' && d.id === 'pc:aldric')).toBe(true);
    const at = pcAt(state);
    expect(Math.abs(at.col - 3) + Math.abs(at.row - 3)).toBeLessThanOrEqual(3); // keeper (3,3) is nearer than Sedge (8,2)
  });

  it('no movement declared → no backstop move', async () => {
    const engine = newEngine();
    withWorld(engine);
    const llm = new FakeLlmProvider([fakeText('You see mist and black water.')]);
    const result = await runTurn({ engine, llm, now: frozenClock }, { kind: 'message', speakerId: 'Aldric', text: 'I look around carefully.' });
    expect(result.deltas ?? []).toEqual([]);
  });

  it('nothing resolvable ("I walk to the horizon") → better no move than a wrong one', async () => {
    const engine = newEngine();
    const state = withWorld(engine);
    const llm = new FakeLlmProvider([fakeText('The horizon stays where it is.')]);
    const result = await runTurn({ engine, llm, now: frozenClock }, { kind: 'message', speakerId: 'Aldric', text: 'I walk to the horizon.' });
    expect(result.deltas ?? []).toEqual([]);
    expect(pcAt(state)).toEqual({ col: 1, row: 1 });
  });
});

describe('spatial truth R1 (digest in feet + queryScene)', () => {
  function withPool(engine: Engine): GameState {
    const state = engine.getState();
    const cols = 14, rows = 5;
    const tiles = Array.from({ length: rows }, () => Array.from({ length: cols }, () => 'grass'));
    const walkable = Array.from({ length: rows }, () => Array.from({ length: cols }, () => true));
    for (let r = 0; r < rows; r++) for (let c = 6; c <= 8; c++) { tiles[r]![c] = 'water_deep'; walkable[r]![c] = false; } // a 15-ft pool band
    state.world = {
      currentLocationId: 'loc:pool',
      locations: { 'loc:pool': { locationId: 'loc:pool', seed: 1, biome: 'village', lighting: 'day', grammar: 'open-outdoor', grid: { cols, rows, feetPerTile: 5 }, tiles, walkable, objects: [
        { id: 'pc:aldric', kind: 'actor', role: 'pc', tag: 'knight', name: 'Aldric', col: 2, row: 2, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
        { id: 'npc:hermit', kind: 'actor', role: 'npc', tag: 'villager', name: 'Hermit', col: 11, row: 2, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
      ], ambiance: [], entrances: [] } },
      links: [],
    };
    return state;
  }

  it('the MAP digest states feet + water facts, not coordinates', async () => {
    const engine = newEngine();
    withPool(engine);
    const llm = new FakeLlmProvider([fakeText('The pool glitters.')]);
    await runTurn({ engine, llm, now: frozenClock }, { kind: 'message', speakerId: 'Aldric', text: 'I look at the water.' });
    const sent = llm.requests[0]!.messages[0]!.content as string;
    expect(sent).toContain('45 ft'); // hermit is 9 tiles east of the party centroid
    expect(sent).toContain('AUTHORITATIVE');
    expect(sent).not.toMatch(/@\d+,\d+/); // coordinates left the prompt
  });

  it("queryScene ask:'path' previews the swim: legs, double-cost feet, rounds", async () => {
    const engine = newEngine();
    withPool(engine);
    const llm = new FakeLlmProvider([
      fakeToolUse([{ id: 'q1', name: 'queryScene', input: { from: 'pc:aldric', to: 'npc:hermit', ask: 'path' } }]),
      fakeText('It will be a swim.'),
    ]);
    await runTurn({ engine, llm, now: frozenClock }, { kind: 'message', speakerId: 'Aldric', text: 'How far to the hermit?' });
    const second = llm.requests[1]!;
    const blocks = second.messages[second.messages.length - 1]!.content as LlmContentBlock[];
    const result = blocks.find((b) => b.type === 'tool_result') as { content: string };
    expect(result.content).toContain('SWIMMING');
    expect(result.content).toContain('round');
    // 3 water tiles at double cost = 30 ft of movement for 15 ft of pool
    expect(result.content).toMatch(/15 ft SWIMMING/);
  });
});

describe('travel gate (R2): rough water suspends via requestRoll, resumes engine-side', () => {
  function stormPool(engine: Engine): GameState {
    const state = engine.getState();
    const cols = 14, rows = 5;
    const tiles = Array.from({ length: rows }, () => Array.from({ length: cols }, () => 'grass'));
    const walkable = Array.from({ length: rows }, () => Array.from({ length: cols }, () => true));
    for (let r = 0; r < rows; r++) for (let c = 6; c <= 8; c++) { tiles[r]![c] = 'water_deep'; walkable[r]![c] = false; }
    state.flags['water:rough'] = 'storm surge'; // the hazard flag gates the swim
    state.world = {
      currentLocationId: 'loc:pool',
      locations: { 'loc:pool': { locationId: 'loc:pool', seed: 1, biome: 'village', lighting: 'day', grammar: 'open-outdoor', grid: { cols, rows, feetPerTile: 5 }, tiles, walkable, objects: [
        { id: 'pc:aldric', kind: 'actor', role: 'pc', tag: 'knight', name: 'Aldric', col: 2, row: 2, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
        { id: 'npc:hermit', kind: 'actor', role: 'npc', tag: 'villager', name: 'Hermit', col: 11, row: 2, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
      ], ambiance: [], entrances: [] } },
      links: [],
    };
    return state;
  }
  const cellOf = (state: GameState, id: string) => {
    const o = state.world!.locations['loc:pool']!.objects.find((x) => x.id === id)!;
    return { col: o.col, row: o.row };
  };

  it('success: gate → roll bar → declared success → the engine completes the crossing before the LLM resumes', async () => {
    const engine = newEngine();
    const state = stormPool(engine);
    const llm = new FakeLlmProvider([
      fakeToolUse([{ id: 't1', name: 'travel', input: { actorId: 'Aldric', to: 'npc:hermit' } }], 'Aldric wades toward the churn.'),
      fakeText('He hauls himself out on the far bank.'),
    ]);
    const first = await runTurn({ engine, llm, now: frozenClock }, { kind: 'message', speakerId: 'Aldric', text: 'I cross the pool to the hermit.' });
    expect(first.rollRequest?.reason).toContain('Athletics');
    expect(cellOf(state, 'pc:aldric').col).toBe(5); // waiting at the waterline
    expect(state.pendingTurn?.travelContinuation).toMatchObject({ actorId: 'pc:aldric' });

    const second = await runTurn({ engine, llm, now: frozenClock }, { kind: 'roll', requestId: first.rollRequest!.id, total: 17 });
    expect(second.narration).toBe('He hauls himself out on the far bank.');
    expect(cellOf(state, 'pc:aldric').col).toBeGreaterThanOrEqual(9); // across
    expect((second.deltas ?? []).some((d) => d.op === 'move' && d.id === 'pc:aldric')).toBe(true);
    // the resumed LLM saw the travel facts alongside the roll verdict
    const resume = llm.requests[1]!;
    const blocks = resume.messages[resume.messages.length - 1]!.content as LlmContentBlock[];
    const rr = blocks.find((b) => b.type === 'tool_result') as { content: string };
    expect(rr.content).toContain('travel');
  });

  it('failure: declared fail → fail-forward (dry, displaced, a fact) — never stranded mid-pool', async () => {
    const engine = newEngine();
    const state = stormPool(engine);
    const llm = new FakeLlmProvider([
      fakeToolUse([{ id: 't1', name: 'travel', input: { actorId: 'Aldric', to: 'Hermit' } }]),
      fakeText('The current spits him back.'),
    ]);
    const first = await runTurn({ engine, llm, now: frozenClock }, { kind: 'message', speakerId: 'Aldric', text: 'I swim across.' });
    const second = await runTurn({ engine, llm, now: frozenClock }, { kind: 'roll', requestId: first.rollRequest!.id, total: 7 }); // 7 < DC 12
    const at = cellOf(state, 'pc:aldric');
    expect(at.col).toBeLessThanOrEqual(5); // still on the near side
    expect(second.narration).toBe('The current spits him back.');
    const resume = llm.requests[1]!;
    const blocks = resume.messages[resume.messages.length - 1]!.content as LlmContentBlock[];
    const rr = blocks.find((b) => b.type === 'tool_result') as { content: string };
    expect(rr.content).toContain('current throws');
  });
});

describe('classifyBuilding (One World ⑤/⑥) — a building is named by its interior', () => {
  const c = (...tags: string[]) => classifyBuilding(new Set(tags));
  it('reads the building TYPE from its furniture', () => {
    expect(c('forge', 'anvil', 'barrel', 'crate')).toBe('forge'); // forge wins over the barrels
    expect(c('bar_counter', 'bed', 'shelf_food')).toBe('inn');
    expect(c('altar', 'candelabra', 'bench')).toBe('chapel');
    expect(c('shelf_wares', 'table', 'crate')).toBe('storehouse');
    expect(c('bed', 'table')).toBe('cottage'); // small + a bed
    expect(c('table', 'chair', 'bookshelf_full', 'books', 'chest')).toBe('house'); // a study/home
  });
});

describe('deriveBuildings (One World ⑥) — a door is READ from map.entrances, never guessed', () => {
  // A storehouse whose real door is on the SOUTH (row 7); the party stands to the NORTH (row 0). The old
  // heuristic ("nearest walkable roof-edge to the party") snaps the door to the NORTH ring cell (4,2) — the
  // wrong wall, an interior/behind-the-wall cell an entire footprint from the lock. map.entrances holds truth.
  const buildMap = (entrances: unknown[]): any => {
    const cols = 10, rows = 10;
    const tiles = Array.from({ length: rows }, () => Array.from({ length: cols }, () => 'grass'));
    const walkable = Array.from({ length: rows }, () => Array.from({ length: cols }, () => false));
    walkable[2]![4] = true; // a NORTH exterior ring cell — what the legacy guess would pick
    walkable[7]![4] = true; // the real SOUTH door approach
    return {
      locationId: 'loc:x', seed: 1, biome: 'village', lighting: 'day', grammar: 'town-square',
      grid: { cols, rows, feetPerTile: 5 }, tiles, walkable,
      objects: [{ id: 'p1', kind: 'prop', tag: 'shelf_wares', col: 4, row: 4, footprint: { w: 1, h: 1 }, facing: 'down', visible: true }],
      ambiance: [], entrances, roofs: [],
    };
  };
  const roofAt = new Map<number, string>();
  for (let r = 3; r <= 6; r++) for (let c = 3; c <= 6; c++) roofAt.set(r * 10 + c, 'bldg:store'); // 4×4 roof, cols/rows 3–6
  const idx: any = { roofAt };

  it('reads the real (south) door from map.entrances even when the party is north', () => {
    const map = buildMap([{ toLocationId: 'loc:x', col: 4, row: 7, fixtureId: 'bldg:store' }]);
    const b = deriveBuildings(map, idx, { col: 4, row: 0 })[0]!; // party to the NORTH
    expect(b.type).toBe('storehouse');
    expect({ col: b.col, row: b.row }).toEqual({ col: 4, row: 7 }); // the ENTRANCE, not the north ring cell (4,2)
  });

  it('falls back to the nearest exterior ring cell only when the map carries no entrance for the building', () => {
    const b = deriveBuildings(buildMap([]), idx, { col: 4, row: 0 })[0]!;
    expect({ col: b.col, row: b.row }).toEqual({ col: 4, row: 2 }); // legacy guess: nearest ring cell to the party
  });
});

describe('movement fidelity gate (coherence ②) — a swim narrated as dry is re-narrated', () => {
  function calmPool(engine: Engine): GameState {
    const state = engine.getState();
    const cols = 14, rows = 5;
    const tiles = Array.from({ length: rows }, () => Array.from({ length: cols }, () => 'grass'));
    const walkable = Array.from({ length: rows }, () => Array.from({ length: cols }, () => true));
    for (let r = 0; r < rows; r++) for (let c = 6; c <= 8; c++) { tiles[r]![c] = 'water_deep'; walkable[r]![c] = false; }
    // NO water:rough flag — calm deep water swims at double-cost with no gate (moved, not suspended).
    state.world = {
      currentLocationId: 'loc:pool',
      locations: { 'loc:pool': { locationId: 'loc:pool', seed: 1, biome: 'village', lighting: 'day', grammar: 'open-outdoor', grid: { cols, rows, feetPerTile: 5 }, tiles, walkable, objects: [
        { id: 'pc:aldric', kind: 'actor', role: 'pc', tag: 'knight', name: 'Aldric', col: 2, row: 2, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
        { id: 'npc:sedge', kind: 'actor', role: 'npc', tag: 'villager', name: 'Sedge', col: 11, row: 2, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
      ], ambiance: [], entrances: [] } },
      links: [],
    };
    return state;
  }

  it('re-narrates a dry crossing when the verdict swam (verdict binds the prose)', async () => {
    const engine = newEngine();
    calmPool(engine);
    const llm = new FakeLlmProvider([
      fakeToolUse([{ id: 't1', name: 'travel', input: { actorId: 'Aldric', to: 'Sedge' } }]),
      fakeText('Aldric strides across on solid ground and reaches Sedge, boots dry.'), // DENIES the water
      fakeText('Aldric wades in and swims the cold channel, hauling out beside Sedge, soaked.'), // corrected
    ]);
    const turn = await runTurn({ engine, llm, now: frozenClock }, { kind: 'message', speakerId: 'Aldric', text: 'I swim across to Sedge' });
    expect(turn.narration).toContain('swims'); // the corrected, water-true narration is what returns
    expect(llm.requests.length).toBe(3); // travel → dry (rejected) → re-narrate
    // the correction directive was injected before the retry
    const retry = llm.requests[2]!;
    const lastUser = retry.messages[retry.messages.length - 1]!;
    expect(JSON.stringify(lastUser.content)).toContain('FIDELITY');
  });

  it('does NOT re-narrate when the first narration already shows the swim', async () => {
    const engine = newEngine();
    calmPool(engine);
    const llm = new FakeLlmProvider([
      fakeToolUse([{ id: 't1', name: 'travel', input: { actorId: 'Aldric', to: 'Sedge' } }]),
      fakeText('Aldric wades into the cold water and swims across to Sedge.'),
    ]);
    const turn = await runTurn({ engine, llm, now: frozenClock }, { kind: 'message', speakerId: 'Aldric', text: 'I swim across to Sedge' });
    expect(turn.narration).toContain('swims');
    expect(llm.requests.length).toBe(2); // travel → narration (accepted, no retry)
  });

  it('the GATED (rough-water) swim also binds: a dry resume narration is re-narrated', async () => {
    // rough water → the travel SUSPENDS on turn 1; the swim completes on the ROLL resume turn, which
    // must still arm the fidelity gate (the review caught this being uncovered).
    const engine = newEngine();
    const state = calmPool(engine);
    state.flags['water:rough'] = 'storm surge'; // now the deep-water swim gates on an Athletics check
    const llm = new FakeLlmProvider([
      fakeToolUse([{ id: 't1', name: 'travel', input: { actorId: 'Aldric', to: 'Sedge' } }]), // turn 1 → suspends
      fakeText('Aldric strolls up onto dry stone beside Sedge, not a drop on him.'), // resume: DENIES water
      fakeText('Aldric fights the cold current, swims the last stretch, and drags himself out by Sedge.'), // corrected
    ]);
    const first = await runTurn({ engine, llm, now: frozenClock }, { kind: 'message', speakerId: 'Aldric', text: 'I swim across to Sedge' });
    expect(first.rollRequest).toBeTruthy(); // suspended on the swim gate
    const resume = await runTurn({ engine, llm, now: frozenClock }, { kind: 'roll', requestId: first.rollRequest!.id, total: 18 });
    expect(resume.narration).toContain('swims'); // the corrected, water-true narration returned
    expect(llm.requests.length).toBe(3); // turn1 travel → resume dry (rejected) → resume re-narrate
  });
});

describe('person-first travel resolution (coherence ④) — the player-named NPC outranks the DM\'s guessed id', () => {
  function village(engine: Engine): GameState {
    const state = engine.getState();
    const cols = 14, rows = 6;
    const tiles = Array.from({ length: rows }, () => Array.from({ length: cols }, () => 'grass'));
    const walkable = Array.from({ length: rows }, () => Array.from({ length: cols }, () => true));
    state.world = {
      currentLocationId: 'loc:village',
      locations: { 'loc:village': { locationId: 'loc:village', seed: 1, biome: 'village', lighting: 'day', grammar: 'open-outdoor', grid: { cols, rows, feetPerTile: 5 }, tiles, walkable, objects: [
        { id: 'pc:aldric', kind: 'actor', role: 'pc', tag: 'knight', name: 'Aldric', col: 2, row: 2, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
        { id: 'npc:b1-keeper', kind: 'actor', role: 'npc', tag: 'villager', col: 5, row: 4, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
        { id: 'npc:village-hobb', kind: 'actor', role: 'npc', tag: 'villager', name: 'Hobb Fen', col: 11, row: 2, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
      ], ambiance: [], entrances: [] } },
      links: [],
    };
    return state;
  }

  it('travel aimed at a keeper walks to the PERSON the player named instead', async () => {
    const engine = newEngine();
    const state = village(engine);
    const llm = new FakeLlmProvider([
      // The DM believes "Hobb is at the forge" and aims at the anonymous keeper — the classic identity split.
      fakeToolUse([{ id: 't1', name: 'travel', input: { actorId: 'Aldric', to: 'npc:b1-keeper' } }]),
      fakeText('Hobb looks up as you reach him.'),
    ]);
    await runTurn({ engine, llm, now: frozenClock }, { kind: 'message', speakerId: 'Aldric', text: 'I go to Hobb and ask about the missing grain' });
    const aldric = state.world!.locations['loc:village']!.objects.find((o) => o.id === 'pc:aldric')!;
    // Landed beside Hobb Fen (11,2), NOT beside the keeper (5,4).
    expect(Math.max(Math.abs(aldric.col - 11), Math.abs(aldric.row - 2))).toBeLessThanOrEqual(1);
    expect(Math.max(Math.abs(aldric.col - 5), Math.abs(aldric.row - 4))).toBeGreaterThan(1);
    // And the DM was TOLD about the correction (so its narration follows the person).
    const resume = llm.requests[1]!;
    const blocks = resume.messages[resume.messages.length - 1]!.content as LlmContentBlock[];
    const rr = blocks.find((b) => b.type === 'tool_result') as { content: string };
    expect(rr.content).toContain('destination corrected to Hobb Fen');
  });

  it('two names in the line: the destination is the one after the movement verb', async () => {
    const engine = newEngine();
    const state = village(engine);
    state.world!.locations['loc:village']!.objects.push(
      { id: 'npc:village-orrin', kind: 'actor', role: 'npc', tag: 'villager', name: 'Orrin Vale', col: 3, row: 5, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
    );
    const llm = new FakeLlmProvider([
      fakeToolUse([{ id: 't1', name: 'travel', input: { actorId: 'Aldric', to: 'npc:b1-keeper' } }]),
      fakeText('Hobb grunts.'),
    ]);
    await runTurn({ engine, llm, now: frozenClock }, { kind: 'message', speakerId: 'Aldric', text: 'I go to Hobb and ask if Orrin is trustful' });
    const aldric = state.world!.locations['loc:village']!.objects.find((o) => o.id === 'pc:aldric')!;
    expect(Math.max(Math.abs(aldric.col - 11), Math.abs(aldric.row - 2))).toBeLessThanOrEqual(1); // beside HOBB, not Orrin or the keeper
    const resume = llm.requests[1]!;
    const blocks = resume.messages[resume.messages.length - 1]!.content as LlmContentBlock[];
    const rr = blocks.find((b) => b.type === 'tool_result') as { content: string };
    expect(rr.content).toContain('destination corrected to Hobb Fen');
  });

  it('a travel aimed at the person the player named is untouched (no correction note)', async () => {
    const engine = newEngine();
    const state = village(engine);
    const llm = new FakeLlmProvider([
      fakeToolUse([{ id: 't1', name: 'travel', input: { actorId: 'Aldric', to: 'npc:village-hobb' } }]),
      fakeText('You reach Hobb.'),
    ]);
    await runTurn({ engine, llm, now: frozenClock }, { kind: 'message', speakerId: 'Aldric', text: 'I go to Hobb' });
    const aldric = state.world!.locations['loc:village']!.objects.find((o) => o.id === 'pc:aldric')!;
    expect(Math.max(Math.abs(aldric.col - 11), Math.abs(aldric.row - 2))).toBeLessThanOrEqual(1);
    const resume = llm.requests[1]!;
    const blocks = resume.messages[resume.messages.length - 1]!.content as LlmContentBlock[];
    const rr = blocks.find((b) => b.type === 'tool_result') as { content: string };
    expect(rr.content).not.toContain('destination corrected');
  });
});

describe('classifySpeechAct — a question must not be executed as a move', () => {
  const ask = (text: string) => classifySpeechAct({ kind: 'message', speakerId: 'Aldric', text });
  it('reads feasibility / spatial QUESTIONS as ask (withhold the move)', () => {
    expect(ask('can we reach Mother Sedge? do we need a boat?')).toBe('ask');
    expect(ask('How far is the tower from here?')).toBe('ask');
    expect(ask('Is there a bridge across, or is it cut off?')).toBe('ask');
    expect(ask('should we swim across to her?')).toBe('ask'); // the verb is ASKED about, not commanded
    expect(ask('(to the DM) can I even make that jump?')).toBe('ask');
    expect(ask('where is the boathouse keeper?')).toBe('ask');
  });
  it('reads DECLARED actions as act (movement still executes)', () => {
    expect(ask('I go to Mother Sedge to question her')).toBe('act');
    expect(ask('I swim across to her')).toBe('act');
    expect(ask('We head over to the well.')).toBe('act');
    expect(ask('I draw my bow and loose an arrow at the goblin!')).toBe('act');
    expect(ask('Forget the tower — I want to leave and go fishing.')).toBe('act');
  });
  it('a declared roll is never an ask', () => {
    expect(classifySpeechAct({ kind: 'roll', requestId: 'r1', total: 12 })).toBe('act');
  });
});
