import { describe, expect, it } from 'vitest';
import type { GameState, SceneDelta, SceneMap } from '@mythweaver/shared';
import { maskItem, playerArcView, playerBook, playerCharacters, playerSceneMap, playerTurn, projectDeltas } from './player-view.js';

/**
 * THE SECRET SCAN — the permanent guard behind the Player Interface (docs/PLAYER-INTERFACE.md P1).
 * Every marker below is a real leak class the red-team confirmed in the live payload. The scan asserts
 * they are ABSENT from the serialized player payload; it must run on every future slice, because the
 * failure mode is silent (a new DM-side field ships to the table and nobody notices for months).
 */

// Distinctive strings planted in the fixture — any appearance in a player payload is a leak.
const MARKERS = {
  ending: 'ZZENDINGZZ-the-bell-is-a-god',
  problem: 'ZZPROBLEMZZ-the-mayor-lies',
  spine: 'ZZSPINEZZ-betrayal-at-the-mill',
  want: 'ZZWANTZZ-to-flee-the-valley',
  fear: 'ZZFEARZZ-being-recognised',
  notes: 'ZZNOTESZZ-secretly-a-doppelganger',
  plant: 'ZZPLANTZZ-the-cracked-locket',
  unvisited: 'ZZUNVISITEDZZ The Drowned Undercroft',
  lurker: 'ZZLURKERZZ-assassin',
  indoor: 'ZZINDOORZZ-cultist',
  destination: 'loc:ZZSECRETZZ-smugglers-cave',
  encounter: 'ZZENCOUNTERZZ-bone-naga',
  trueItem: 'ZZITEMZZ Blade of the Hollow King',
  briefIntent: 'ZZINTENTZZ-the-miller-is-about-to-turn',
};

const COLS = 20, ROWS = 20;
function fixtureMap(): SceneMap {
  const tiles = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => 'grass'));
  const walkable = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => true));
  return {
    locationId: 'loc:green', seed: 1, biome: 'village', lighting: 'day', grammar: 'town-square',
    grid: { cols: COLS, rows: ROWS, feetPerTile: 5 }, tiles, walkable,
    objects: [
      { id: 'pc:aldric', kind: 'actor', role: 'pc', tag: 'knight', name: 'Aldric', col: 2, row: 2, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
      { id: 'npc:tessa', kind: 'actor', role: 'npc', tag: 'villager', name: 'Tessa Reed', col: 3, row: 2, footprint: { w: 1, h: 1 }, facing: 'down', visible: true, state: { 'rx:verb': 'gawk', 'rx:goal': '{"kind":"reinforce"}', mood: 'wary' } },
      // A hidden lurker: present in engine truth, must never reach a player payload.
      { id: 'npc:lurker', kind: 'actor', role: 'npc', tag: 'rogue', name: MARKERS.lurker, col: 9, row: 9, footprint: { w: 1, h: 1 }, facing: 'down', visible: false },
    ],
    ambiance: [], entrances: [{ col: 6, row: 9, fixtureId: 'bldg:shed', toLocationId: MARKERS.destination }],
    roofs: [],
  } as unknown as SceneMap;
}

function fixtureState(): GameState {
  const map = fixtureMap();
  return {
    currentSceneId: 'scene:b1',
    flags: { 'beat:scene:b1': true, 'decision:spared-the-thief': 'yes', 'npc:tessa:mood': 'ZZFLAGZZ-suspicious' },
    adventure: {
      pitch: 'a village mystery',
      scenes: {
        'scene:b1': { title: 'The Green at Dusk' },
        'scene:b9': { title: MARKERS.unvisited }, // never visited → must not appear
      },
    },
    arc: {
      blueprint: { premise: 'A village mystery about trust.', centralProblem: MARKERS.problem, intendedEnding: MARKERS.ending, opening: 'the green', spine: [{ milestone: MARKERS.spine, intent: MARKERS.spine }] },
      brief: { activeBeatIntent: MARKERS.briefIntent, reachable: [], bridgeNpcs: [MARKERS.notes], clocks: ['ZZCLOCKZZ'], notes: MARKERS.notes },
    },
    ledger: {
      entities: { 'npc:tessa': { id: 'npc:tessa', name: 'Tessa Reed', kind: 'npc', voice: { tic: 'brushes dirt', want: MARKERS.want, fear: MARKERS.fear }, notes: MARKERS.notes } },
      facts: [], plants: { 'plant:locket': { id: 'plant:locket', what: MARKERS.plant, status: 'planted' } },
    },
    encounters: [{ sceneId: 'scene:b9', monsters: [{ statBlockId: MARKERS.encounter, count: 2 }] }],
    world: { currentLocationId: 'loc:green', locations: { 'loc:green': map }, links: [] },
  } as unknown as GameState;
}

const scan = (payload: unknown) => {
  const s = JSON.stringify(payload);
  return Object.entries(MARKERS).filter(([, marker]) => s.includes(marker)).map(([k]) => k);
};

describe('playerArcView — the arc, whitelisted to what the table lived through', () => {
  it('leaks NO authored secret: ending, central problem, spine, brief steering, unvisited titles, encounters', () => {
    expect(scan(playerArcView(fixtureState()))).toEqual([]);
  });

  it('keeps what players legitimately see: premise, visited chapters, their own decisions', () => {
    const v = playerArcView(fixtureState());
    expect(v.premise).toBe('A village mystery about trust.');
    expect(v.chapters.map((c) => c.title)).toEqual(['The Green at Dusk']); // visited only
    expect(v.decisions).toEqual([{ key: 'spared-the-thief', value: 'yes' }]);
  });

  it('shows NO goal until the planner emits a player-safe one (activeBeatIntent is a spoiler)', () => {
    expect(playerArcView(fixtureState()).goal).toBeNull();
    const withGoal = fixtureState();
    (withGoal.arc as unknown as { brief: Record<string, unknown> }).brief.partyGoal = 'Find who is stealing the seed grain.';
    expect(playerArcView(withGoal).goal).toBe('Find who is stealing the seed grain.');
  });
});

describe('playerSceneMap — the map as the table can see it', () => {
  it('drops hidden tokens and exit destinations, and strips engine bookkeeping from state', () => {
    const m = playerSceneMap(fixtureMap());
    expect(scan(m)).toEqual([]);
    expect(m.objects.some((o) => o.id === 'npc:lurker')).toBe(false);
    expect(m.objects.find((o) => o.id === 'npc:tessa')!.state).toEqual({ mood: 'wary' }); // rx:* gone, real state kept
    expect(JSON.stringify(m.entrances)).not.toContain('toLocationId');
  });

  it('conceals a non-PC actor inside a building no PC has entered', () => {
    const map = fixtureMap();
    // Roof the shed over (5-7)x(5-7) and put a cultist inside; no PC is in there.
    (map as unknown as { roofs: unknown[] }).roofs = [{ id: 'bldg:shed', faces: [{ pts: [80, 80, 128, 80, 128, 128, 80, 128], top: 0, bot: 0 }] }];
    map.objects.push({ id: 'npc:cultist', kind: 'actor', role: 'npc', tag: 'cultist', name: MARKERS.indoor, col: 6, row: 6, footprint: { w: 1, h: 1 }, facing: 'down', visible: true } as never);
    expect(scan(playerSceneMap(map))).toEqual([]);
  });
});

describe('projectDeltas — visibility-resolving, not op-shaped', () => {
  const map = fixtureMap();
  it('drops EVERY op about a hidden token — the stalker leak (move/face/setState, not just spawn)', () => {
    const deltas = [
      { op: 'move', id: 'npc:lurker', to: { col: 5, row: 5 }, via: [{ col: 4, row: 4 }] },
      { op: 'face', id: 'npc:lurker', facing: 'left' },
      { op: 'setState', id: 'npc:lurker', state: { alerted: true } },
      { op: 'move', id: 'npc:tessa', to: { col: 4, row: 2 } },
    ] as unknown as SceneDelta[];
    const out = projectDeltas(deltas, map);
    expect(JSON.stringify(out)).not.toContain('npc:lurker');
    expect(out).toHaveLength(1);
  });

  it('strips engine-only setState ops entirely, keeps genuine state', () => {
    const out = projectDeltas([{ op: 'setState', id: 'npc:tessa', state: { 'rx:verb': 'flee' } }, { op: 'setState', id: 'npc:tessa', state: { lamp: 'lit' } }] as unknown as SceneDelta[], map);
    expect(out).toHaveLength(1);
    expect(JSON.stringify(out)).toContain('lamp');
  });

  it('drops a spawn that arrives already hidden', () => {
    const out = projectDeltas([{ op: 'spawn', object: { id: 'npc:x', visible: false, name: MARKERS.lurker } }] as unknown as SceneDelta[], map);
    expect(out).toEqual([]);
  });
});

describe('playerTurn — the turn as the table experienced it', () => {
  it('carries narration and drops tool traces, diff, provenance and cost', () => {
    const t = playerTurn({
      index: 3, speaker: 'Aldric', input: 'I look', kind: 'message', narration: 'The green is quiet.',
      tools: [{ name: 'searchPoi', input: { id: 'poi:x' }, result: '{"discoverDc":18,"contents":["ZZLOOTZZ"]}' }],
      diff: ['hp 12→8'], sceneProvenance: { enrichedBrief: MARKERS.notes }, exemplars: [{ text: 'x' }],
      costUsd: 0.02, model: 'gpt-5.6-luna', steps: 4, mentions: ['npc:tessa'], deltas: [],
    }, fixtureMap());
    const s = JSON.stringify(t);
    for (const key of ['searchPoi', 'discoverDc', 'ZZLOOTZZ', 'sceneProvenance', 'costUsd', 'gpt-5.6-luna', 'diff']) expect(s).not.toContain(key);
    expect(t.narration).toBe('The green is quiet.');
    expect(t.mentions).toEqual(['npc:tessa']);
  });
});

describe('maskItem / playerCharacters — one masking rule, no true names', () => {
  it('masks an unidentified item and hides that it is magical', () => {
    expect(maskItem({ name: MARKERS.trueItem, category: 'weapon', magic: true }, false)).toEqual({ name: 'an unidentified weapon' });
    expect(maskItem({ name: 'Longsword', category: 'weapon' }, true)).toEqual({ name: 'Longsword' });
  });

  it('never ships the true name, magic flag or charges of an unidentified item', () => {
    const out = playerCharacters([{ name: 'Aldric', items: [{ name: MARKERS.trueItem, category: 'weapon', magic: true, charges: { max: 3 }, identified: false }] }]);
    const s = JSON.stringify(out);
    expect(s).not.toContain(MARKERS.trueItem);
    expect(s).not.toContain('magic');
    expect(s).not.toContain('charges');
    expect(s).toContain('an unidentified weapon');
  });

  it('leaves identified gear untouched', () => {
    const out = playerCharacters([{ name: 'Aldric', items: [{ name: 'Longsword', category: 'weapon', identified: true }] }]);
    expect(JSON.stringify(out)).toContain('Longsword');
  });
});

describe('playerBook — the Book, folded from what the table witnessed (P3)', () => {
  const st = (over: Partial<GameState> = {}): GameState => ({
    currentSceneId: 'scene:b2',
    adventure: { pitch: 'x', scenes: { 'scene:b1': { title: 'The Green' }, 'scene:b2': { title: 'The Storehouse' } } },
    flags: {},
    ledger: { entities: { 'npc:tessa': { id: 'npc:tessa', name: 'Tessa Reed', kind: 'npc', voice: { want: MARKERS.want, fear: MARKERS.fear } } }, facts: [], plants: {} },
    journal: [],
    ...over,
  } as unknown as GameState);
  const ev = (o: Partial<any>): any => ({ seq: 1, turn: 1, beatId: 'scene:b2', kind: 'verdict', subjects: [], text: '', ...o });

  it('groups events into chapters in the order the party lived them, titled from the adventure', () => {
    const b = playerBook(st({ journal: [ev({ seq: 1, beatId: 'scene:b1', text: 'a villager bolts' }), ev({ seq: 2, beatId: 'scene:b2', text: 'the lock is scarred' })] } as any));
    expect(b.chapters.map((c) => c.title)).toEqual(['The Green', 'The Storehouse']);
    expect(b.chapters[1]!.current).toBe(true);
  });

  it('carries each chapter its OWN goal snapshot (the live brief is overwritten on replan)', () => {
    const b = playerBook(st({ journal: [
      ev({ seq: 1, beatId: 'scene:b1', kind: 'goal', text: 'Find the missing grain.' }),
      ev({ seq: 2, beatId: 'scene:b2', kind: 'goal', text: 'Get inside the storehouse.' }),
    ] } as any));
    expect(b.chapters.find((c) => c.beatId === 'scene:b1')!.goal).toBe('Find the missing grain.');
    expect(b.chapters.find((c) => c.beatId === 'scene:b2')!.goal).toBe('Get inside the storehouse.');
  });

  it('BIRTHS a dossier from the first event naming a card — and never from the ledger alone', () => {
    // Tessa is in the ledger from the start (the composer authored her); with no events she is unmet.
    expect(playerBook(st()).people).toEqual([]);
    const b = playerBook(st({ journal: [ev({ seq: 3, turn: 4, subjects: ['npc:tessa'], text: 'Tessa Reed freezes and stares.' })] } as any));
    expect(b.people).toHaveLength(1);
    expect(b.people[0]).toMatchObject({ name: 'Tessa Reed', firstSeen: { turn: 4 }, regard: 0 });
    expect(b.people[0]!.deeds[0]!.text).toBe('Tessa Reed freezes and stares.');
  });

  it('accumulates regard from WITNESSED shifts only, starting at zero (never the authored seed)', () => {
    const b = playerBook(st({ journal: [
      ev({ seq: 1, subjects: ['npc:tessa'], kind: 'disposition', text: 'Tessa looks at you more coldly.', data: { dir: -1 } }),
      ev({ seq: 2, subjects: ['npc:tessa'], kind: 'disposition', text: 'Tessa looks at you more coldly.', data: { dir: -1 } }),
    ] } as any));
    expect(b.people[0]!.regard).toBe(-2);
  });

  it('never leaks an NPC’s authored want/fear into their dossier', () => {
    const b = playerBook(st({ journal: [ev({ subjects: ['npc:tessa'], text: 'Tessa Reed steps back.' })] } as any));
    expect(scan(b)).toEqual([]);
  });

  it('collects findings and loot, and leaves people out of them', () => {
    const b = playerBook(st({ journal: [
      ev({ seq: 1, kind: 'finding', subjects: ['poi:pot'], text: 'Found: a cracked clay pot' }),
      ev({ seq: 2, kind: 'loot', subjects: ['poi:pot'], text: 'Pip takes 3 gp.' }),
      ev({ seq: 3, subjects: ['npc:tessa'], text: 'Tessa watches.' }),
    ] } as any));
    expect(b.findings.map((f) => f.kind)).toEqual(['finding', 'loot']);
    expect(b.people.map((p) => p.id)).toEqual(['npc:tessa']); // a POI id is not a person
  });
});

describe('playerBook — the prologue is the opening PAGE, not a chapter row (P4.1)', () => {
  const base = (): GameState => ({
    currentSceneId: 'scene:b1',
    adventure: { pitch: 'x', scenes: { 'scene:b1': { title: 'The Green' } } },
    flags: {}, ledger: { entities: {}, facts: [], plants: {} },
    journal: [
      { seq: 1, turn: 0, beatId: 'scene:b1', kind: 'prologue', subjects: [], text: 'You come together on the King’s Road…' },
      { seq: 2, turn: 1, beatId: 'scene:b1', kind: 'verdict', subjects: [], text: 'a villager bolts' },
    ],
  } as unknown as GameState);

  it('extracts the prologue and keeps it OUT of the chapter event rows', () => {
    const b = playerBook(base());
    expect(b.prologue).toContain('King’s Road');
    const rows = b.chapters.flatMap((c) => c.events);
    expect(rows.map((e) => e.kind)).toEqual(['verdict']); // the page is not a row
  });

  it('is null when no prologue has landed (keyless setups fall back to the premise in the UI)', () => {
    const st = base();
    (st.journal as unknown as { kind: string }[]).shift();
    expect(playerBook(st).prologue).toBeNull();
  });
});

describe('playerBook — P5 kinds land in their places, never as debug rows', () => {
  const base = (): GameState => ({
    currentSceneId: 'scene:b2',
    adventure: { pitch: 'x', scenes: { 'scene:b1': { title: 'The Green' }, 'scene:b2': { title: 'The Mill' } } },
    flags: {},
    ledger: { entities: { 'npc:tessa': { id: 'npc:tessa', kind: 'npc', name: 'Tessa Reed' } }, facts: [], plants: {} },
    journal: [
      { seq: 1, turn: 1, beatId: 'scene:b1', kind: 'met', subjects: ['npc:tessa'], text: 'Tessa Reed waves you over.' },
      { seq: 2, turn: 2, beatId: 'scene:b1', kind: 'clue', subjects: ['npc:tessa'], text: 'Learned: she was seen by the bell tower after dark', data: { factKey: 'k' } },
      // The closing marker lives in the NEXT beat's group (journaled after currentSceneId flips).
      { seq: 3, turn: 3, beatId: 'scene:b2', kind: 'chapter', subjects: ['scene:b2'], text: 'The Mill', data: { from: 'scene:b1', to: 'scene:b2', outcome: 'resolved', opened: true } },
      { seq: 4, turn: 3, beatId: 'scene:b1', kind: 'chronicle', subjects: [], text: 'You met Tessa on the green and learned where she walks at night.' },
    ],
  } as unknown as GameState);

  it('chronicle becomes the closed chapter prose, never a row; the outcome is found across groups', () => {
    const b = playerBook(base());
    const green = b.chapters.find((c) => c.beatId === 'scene:b1')!;
    expect(green.summary).toContain('You met Tessa');
    expect(green.outcome).toBe('resolved'); // marker lives in scene:b2's group — found anyway
    expect(green.events.map((e) => e.kind)).toEqual(['met', 'clue']); // no chronicle row
  });

  it('met births the dossier with the DM\'s introducing sentence; the clue joins the deeds and Findings', () => {
    const b = playerBook(base());
    const tessa = b.people.find((p) => p.id === 'npc:tessa')!;
    expect(tessa.intro).toBe('Tessa Reed waves you over.');
    expect(tessa.deeds[0]!.text).toContain('bell tower');
    expect(b.findings.map((e) => e.kind)).toEqual(['clue']);
  });
});
