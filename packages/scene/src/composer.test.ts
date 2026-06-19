import { describe, expect, it } from 'vitest';
import { FakeLlmProvider, fakeText } from '@mythweaver/llm';
import { type CompositionRequest, type EstablishScene, type PartyMemberRef, validateComposition, validateSceneMap } from '@mythweaver/shared';
import { buildSceneMap } from './cartographer.js';
import { CHARACTERS, PROPS, TERRAINS } from './catalog.js';
import { FakeSceneComposer, LlmSceneComposer } from './composer.js';

const cat = {
  tags: new Set([...TERRAINS, ...PROPS, ...CHARACTERS].map((x) => x.tag)),
  biomes: new Set(['dungeon', 'forest', 'cave', 'village']),
};

const establish: EstablishScene = {
  locationId: 'loc:mistmoor-green',
  brief: { setting: 'a misty fen-village green at dusk, black water beyond', biome: 'village', timeOfDay: 'dusk' },
  fixtures: [
    { id: 'bldg:hall', kind: 'fixture', tag: 'tree_oak', anchor: 'north-edge' },
    { id: 'prop:fire', kind: 'prop', tag: 'bonfire', anchor: 'center' },
  ],
  npcs: [
    { id: 'npc:edda', name: 'Edda', look: 'a wary fisherwoman', anchor: 'near:prop:fire', visible: true },
    { id: 'npc:orc', name: 'a shape in the reeds', look: 'a lurking orc', anchor: 'waterside', visible: false },
  ],
};
const party: PartyMemberRef[] = [{ id: 'pc:aldric', spriteTag: 'knight', name: 'Aldric' }];
const req: CompositionRequest = { establish, party, seed: 7 };

describe('FakeSceneComposer', () => {
  it('produces a valid composition that covers every entity', async () => {
    const comp = await new FakeSceneComposer().compose(req);
    expect(validateComposition(comp, establish, party, cat)).toEqual({ ok: true, violations: [] });
    expect(comp.placements.length).toBe(5); // 2 fixtures + 2 npcs + 1 party
    expect(comp.biome).toBe('village');
    expect(comp.grammar).toBe('town-square'); // villages route to the town-square grammar
    expect(comp.placements.find((p) => p.id === 'npc:edda')!.tag).toBe('villager_woman'); // "fisherwoman" → look→sprite
    expect(comp.placements.find((p) => p.id === 'npc:orc')!.visible).toBe(false);
  });

  it('feeds straight into the Cartographer to make a valid SceneMap (full data pipeline)', async () => {
    const comp = await new FakeSceneComposer().compose(req);
    expect(validateSceneMap(buildSceneMap(comp))).toEqual({ ok: true, violations: [] });
  });

  it('town-square: structure fixtures become carved walled ROOMS (not facade sprites), fountain centred', async () => {
    const est: EstablishScene = {
      locationId: 'loc:harbor',
      brief: { setting: 'a seaside village square', biome: 'village', timeOfDay: 'day' },
      fixtures: [
        { id: 'prop:fountain', kind: 'prop', tag: 'fountain' },
        { id: 'bldg:h1', kind: 'fixture', tag: 'cottage' },
        { id: 'bldg:h2', kind: 'fixture', tag: 'smithy' },
        { id: 'prop:stall', kind: 'prop', tag: 'market_stall' },
      ],
      npcs: [{ id: 'npc:elder', name: 'Elder', look: 'an old villager', visible: true }],
    };
    const comp = await new FakeSceneComposer().compose({ establish: est, party, seed: 5 });
    expect(comp.grammar).toBe('town-square');
    expect(comp.placements.find((p) => p.id === 'prop:fountain')!.anchor).toBe('center'); // tag default
    // Building fixtures are carved as rooms — NOT placed as point sprites (the facade-tower bug).
    expect(comp.placements.find((p) => p.id === 'bldg:h1')).toBeUndefined();
    expect(comp.buildings?.map((b) => b.id)).toEqual(['bldg:h1', 'bldg:h2']);
    expect(comp.buildings?.find((b) => b.id === 'bldg:h1')?.type).toBe('house');
    expect(comp.buildings?.find((b) => b.id === 'bldg:h2')?.type).toBe('smithy');
    const m = buildSceneMap(comp);
    expect(validateSceneMap(m)).toEqual({ ok: true, violations: [] });
    const fo = m.objects.find((o) => o.id === 'prop:fountain')!;
    expect(Math.abs(fo.col - m.grid.cols / 2)).toBeLessThanOrEqual(3); // near centre
    expect(Math.abs(fo.row - m.grid.rows / 2)).toBeLessThanOrEqual(3);
    // Each building rendered as a roofless room: a wall ring, a walkable interior floor, a door
    // Entrance, and grouped interior objects (furniture + keeper).
    const b1 = comp.buildings!.find((b) => b.id === 'bldg:h1')!;
    expect(m.tiles[b1.rect.y]![b1.rect.x]).toBe('wall'); // corner of the ring
    let floorWalkable = 0;
    for (let y = b1.rect.y + 1; y < b1.rect.y + b1.rect.h - 1; y++) for (let x = b1.rect.x + 1; x < b1.rect.x + b1.rect.w - 1; x++) if (m.walkable[y]![x]) floorWalkable++;
    expect(floorWalkable).toBeGreaterThan(0); // never sealed solid by furniture
    expect(m.entrances.some((en) => en.fixtureId === 'bldg:h1')).toBe(true);
    expect(m.objects.some((o) => o.group === 'bldg:h1')).toBe(true);
  });

  it('routes a dungeon brief to the enclosed-interior grammar', async () => {
    const dungeon: EstablishScene = { ...establish, brief: { setting: 'a dripping crypt', biome: 'dungeon', timeOfDay: 'night' } };
    const comp = await new FakeSceneComposer().compose({ establish: dungeon, party, seed: 3 });
    expect(comp.grammar).toBe('enclosed-interior');
    expect(validateComposition(comp, dungeon, party, cat).ok).toBe(true);
  });
});

describe('LlmSceneComposer', () => {
  it('uses the model hints but keeps the entity set + identity authoritative', async () => {
    const llm = new FakeLlmProvider([
      fakeText(
        JSON.stringify({
          grammar: 'open-outdoor',
          grid: { cols: 28, rows: 18 },
          terrain: { base: 'grass', regions: [{ tag: 'water', zone: 'waterside' }] },
          placements: [
            { id: 'pc:aldric', zone: 'commons' },
            { id: 'npc:edda', zone: 'waterside' },
            { id: 'pc:aldric', zone: 'path', tag: 'villager' }, // duplicate + wrong tag → must be ignored
          ],
          ambiance: { density: 0.5, tags: ['tree_round'] },
        }),
      ),
    ]);
    const comp = await new LlmSceneComposer(llm).compose(req);
    expect(validateComposition(comp, establish, party, cat)).toEqual({ ok: true, violations: [] });
    expect(comp.grid).toEqual({ cols: 28, rows: 18 }); // honored the model's grid
    expect(comp.placements.find((p) => p.id === 'npc:edda')!.zone).toBe('waterside'); // honored the zone hint
    expect(comp.placements.find((p) => p.id === 'pc:aldric')!.tag).toBe('knight'); // party identity is authoritative
    expect(new Set(comp.placements.map((p) => p.id)).size).toBe(5); // exactly one per entity, no dup
  });

  it('falls back to a valid deterministic composition on malformed model output', async () => {
    const comp = await new LlmSceneComposer(new FakeLlmProvider([fakeText('definitely not json')])).compose(req);
    expect(validateComposition(comp, establish, party, cat)).toEqual({ ok: true, violations: [] });
    expect(validateSceneMap(buildSceneMap(comp)).ok).toBe(true);
  });

  it('parses object fields: absorbs a declared entity into a field, adds new groups, stays valid', async () => {
    const church: EstablishScene = {
      locationId: 'loc:church',
      brief: { setting: 'the interior of an old stone church', biome: 'dungeon', timeOfDay: 'night' },
      fixtures: [
        { id: 'prop:pews', kind: 'prop', tag: 'benches' }, // a plural the Director will fold into a field
        { id: 'prop:altar', kind: 'prop', tag: 'altar' },
      ],
      npcs: [],
    };
    const fparty: PartyMemberRef[] = [{ id: 'pc:aldric', spriteTag: 'knight', name: 'Aldric' }];
    const llm = new FakeLlmProvider([
      fakeText(
        JSON.stringify({
          fields: [
            { idBase: 'prop:pews', tag: 'table', region: { band: 'center' }, arrangement: 'grid', count: 8, spacing: 2 },
            { idBase: 'prop:statues', tag: 'gravestone', region: { band: 'left' }, arrangement: 'line', count: 3 },
          ],
        }),
      ),
    ]);
    const comp = await new LlmSceneComposer(llm).compose({ establish: church, party: fparty, seed: 4 });
    expect(validateComposition(comp, church, fparty, cat)).toEqual({ ok: true, violations: [] });
    expect(comp.fields?.length).toBe(2);
    // The declared "prop:pews" is REPRESENTED by its field — not also placed as a single object.
    expect(comp.placements.some((p) => p.id === 'prop:pews')).toBe(false);
    // The altar (no field) and the party member are still placed normally.
    expect(comp.placements.some((p) => p.id === 'prop:altar')).toBe(true);
    expect(comp.placements.some((p) => p.id === 'pc:aldric')).toBe(true);
    const m = buildSceneMap(comp);
    expect(validateSceneMap(m)).toEqual({ ok: true, violations: [] });
    expect(m.objects.filter((o) => o.group === 'prop:pews').length).toBeGreaterThanOrEqual(4);
    expect(m.objects.filter((o) => o.group === 'prop:statues').length).toBe(3);
  });

  it('parses a painted blockout for an outdoor scene and renders it (horizontal path + cells)', async () => {
    const forest: EstablishScene = {
      locationId: 'loc:forest-path',
      brief: { setting: 'a forest clearing with a path', biome: 'forest', timeOfDay: 'day' },
      fixtures: [{ id: 'prop:chest', kind: 'prop', tag: 'chest' }],
      npcs: [{ id: 'npc:gob', name: 'goblin', look: 'a goblin', visible: true }],
    };
    const fparty: PartyMemberRef[] = [{ id: 'pc:aldric', spriteTag: 'knight', name: 'Aldric' }];
    const llm = new FakeLlmProvider([
      fakeText(
        JSON.stringify({
          blockout: {
            grid: ['TTTTTTTTTTTT', 'TTTTTTTTTTTT', 'GGGGGGGGGGGG', 'GGGGGGGGGGGG', 'PPPPPPPPPPPP', 'GGGGGGGGGGGG', 'TTTTTTTTTTTT', 'TTTTTTTTTTTT'],
            cells: [
              { id: 'pc:aldric', col: 1, row: 4 },
              { id: 'prop:chest', col: 6, row: 4 },
              { id: 'npc:gob', col: 7, row: 4 },
            ],
          },
        }),
      ),
    ]);
    const comp = await new LlmSceneComposer(llm).compose({ establish: forest, party: fparty, seed: 9 });
    expect(comp.grammar).toBe('open-outdoor');
    expect(comp.blockout).toBeDefined();
    expect(comp.grid).toEqual({ cols: 12, rows: 8 }); // dims inferred from the painted grid
    const m = buildSceneMap(comp);
    expect(validateSceneMap(m)).toEqual({ ok: true, violations: [] });
    expect(m.tiles[4]!.every((t) => t === 'dirt')).toBe(true); // the painted horizontal path
    const hero = m.objects.find((o) => o.id === 'pc:aldric')!;
    const chest = m.objects.find((o) => o.id === 'prop:chest')!;
    expect(hero.col).toBeLessThan(chest.col); // hero left of chest, as painted
  });
});
