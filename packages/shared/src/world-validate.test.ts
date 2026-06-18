import { describe, expect, it } from 'vitest';
import type { EstablishScene, PartyMemberRef, SceneComposition, SceneDelta, SceneMap } from './world.js';
import { type CatalogSets, validateComposition, validateDelta, validateEstablishScene, validateSceneMap } from './world-validate.js';

const cat: CatalogSets = {
  tags: new Set(['grass', 'dirt', 'water', 'stone', 'well', 'bell-tower', 'dock', 'tree_oak', 'knight', 'wizard', 'rogue', 'villager', 'orc']),
  biomes: new Set(['village', 'forest', 'dungeon', 'cave']),
};
const party: PartyMemberRef[] = [{ id: 'pc:aldric', spriteTag: 'knight', name: 'Aldric' }];
const clone = <T>(x: T): T => structuredClone(x);
const codes = (r: { violations: { code: string }[] }) => r.violations.map((v) => v.code);

function establish(): EstablishScene {
  return {
    locationId: 'loc:mistmoor-green',
    brief: { setting: 'a fen-village green at dusk', biome: 'village', timeOfDay: 'dusk' },
    fixtures: [
      { id: 'bldg:bell-tower', kind: 'fixture', tag: 'bell-tower', anchor: 'north-edge' },
      { id: 'prop:well', kind: 'prop', tag: 'well', anchor: 'center' },
    ],
    npcs: [
      { id: 'npc:edda', name: 'Edda', look: 'a wary fisherwoman', anchor: 'near:prop:well', visible: true },
      { id: 'npc:orc-lurk', name: 'a shape in the reeds', look: 'a lurking orc', anchor: 'waterside', visible: false },
    ],
  };
}

function composition(): SceneComposition {
  return {
    locationId: 'loc:mistmoor-green',
    seed: 1,
    grammar: 'open-outdoor',
    biome: 'village',
    lighting: 'dusk',
    grid: { cols: 24, rows: 16 },
    terrain: { base: 'grass', regions: [{ tag: 'water', zone: 'waterside' }] },
    placements: [
      { id: 'bldg:bell-tower', kind: 'fixture', tag: 'bell-tower', visible: true, zone: 'building-row' },
      { id: 'prop:well', kind: 'prop', tag: 'well', visible: true, zone: 'commons' },
      { id: 'npc:edda', kind: 'actor', role: 'npc', tag: 'villager', visible: true, zone: 'commons', anchor: 'near:prop:well' },
      { id: 'npc:orc-lurk', kind: 'actor', role: 'npc', tag: 'orc', visible: false, zone: 'waterside' },
      { id: 'pc:aldric', kind: 'actor', role: 'pc', tag: 'knight', visible: true, zone: 'commons' },
    ],
    ambiance: { density: 0.3, tags: ['tree_oak'] },
  };
}

function sceneMap(): SceneMap {
  return {
    locationId: 'loc:mistmoor-green',
    seed: 1,
    biome: 'village',
    lighting: 'dusk',
    grammar: 'open-outdoor',
    grid: { cols: 6, rows: 6, feetPerTile: 5 },
    tiles: Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => 'grass')),
    walkable: Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => true)),
    objects: [
      { id: 'bldg:bell-tower', kind: 'fixture', tag: 'bell-tower', col: 1, row: 1, footprint: { w: 2, h: 2 }, facing: 'down', visible: true },
      { id: 'pc:aldric', kind: 'actor', role: 'pc', tag: 'knight', col: 4, row: 4, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
      { id: 'npc:edda', kind: 'actor', role: 'npc', tag: 'villager', col: 3, row: 4, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
    ],
    ambiance: [{ tag: 'tree_oak', col: 0, row: 0 }],
    entrances: [],
  };
}

describe('validateEstablishScene (A)', () => {
  it('accepts a well-formed declaration', () => {
    expect(validateEstablishScene(establish(), cat)).toEqual({ ok: true, violations: [] });
  });
  it('rejects unknown biome + lighting', () => {
    const e = clone(establish());
    e.brief.biome = 'mars';
    e.brief.timeOfDay = 'noon' as never;
    expect(codes(validateEstablishScene(e, cat))).toEqual(expect.arrayContaining(['bad-biome', 'bad-lighting']));
  });
  it('rejects bad ids, unknown tags, bad anchors, and coordinates', () => {
    const e = clone(establish());
    e.fixtures[0]!.id = 'wall:x'; // bad prefix
    e.fixtures[1]!.tag = 'spaceship'; // unknown tag
    e.npcs[0]!.anchor = 'somewhere'; // bad anchor
    (e.npcs[1] as unknown as Record<string, unknown>).col = 4; // coordinates forbidden
    expect(codes(validateEstablishScene(e, cat))).toEqual(expect.arrayContaining(['bad-id', 'unknown-tag', 'bad-anchor', 'coords-forbidden']));
  });
  it('rejects duplicate ids', () => {
    const e = clone(establish());
    e.npcs[1]!.id = 'npc:edda';
    expect(codes(validateEstablishScene(e, cat))).toContain('dup-id');
  });
  it('rejects a fixture whose kind disagrees with its id prefix', () => {
    const e = clone(establish());
    e.fixtures[0]!.kind = 'prop'; // id is "bldg:bell-tower" → implies fixture
    expect(codes(validateEstablishScene(e, cat))).toContain('kind-prefix-mismatch');
  });
});

describe('validateComposition (B)', () => {
  it('accepts a composition that covers every entity + party member once', () => {
    expect(validateComposition(composition(), establish(), party, cat)).toEqual({ ok: true, violations: [] });
  });
  it('flags a dropped entity and an unknown placement', () => {
    const c = clone(composition());
    c.placements = c.placements.filter((p) => p.id !== 'npc:edda'); // drop one
    c.placements.push({ id: 'npc:ghost', kind: 'actor', role: 'npc', tag: 'villager', visible: true, zone: 'commons' }); // not declared
    const got = codes(validateComposition(c, establish(), party, cat));
    expect(got).toEqual(expect.arrayContaining(['missing-placement', 'unknown-placement']));
  });
  it('flags a bad zone, oversized grid, and out-of-range density', () => {
    const c = clone(composition());
    c.placements[0]!.zone = 'rooftop';
    c.grid.cols = 99;
    c.ambiance.density = 2;
    expect(codes(validateComposition(c, establish(), party, cat))).toEqual(expect.arrayContaining(['bad-zone', 'bad-grid', 'bad-density']));
  });
});

describe('validateSceneMap (C)', () => {
  it('accepts a consistent frozen map', () => {
    expect(validateSceneMap(sceneMap())).toEqual({ ok: true, violations: [] });
  });
  it('flags an out-of-bounds object', () => {
    const m = clone(sceneMap());
    m.objects[1]!.col = 99;
    expect(codes(validateSceneMap(m))).toContain('out-of-bounds');
  });
  it('flags an actor on a non-walkable tile', () => {
    const m = clone(sceneMap());
    m.walkable[4]![4] = false; // pc:aldric stands at (4,4)
    expect(codes(validateSceneMap(m))).toContain('actor-blocked');
  });
  it('flags overlapping fixtures', () => {
    const m = clone(sceneMap());
    m.objects.push({ id: 'bldg:hut', kind: 'fixture', tag: 'dock', col: 2, row: 2, footprint: { w: 2, h: 2 }, facing: 'down', visible: true });
    expect(codes(validateSceneMap(m))).toContain('fixture-overlap');
  });
  it('flags grid/tiles dimension mismatch and bad scale', () => {
    const m = clone(sceneMap());
    m.tiles.pop(); // now 5 rows for a 6-row grid
    m.grid.feetPerTile = 4;
    expect(codes(validateSceneMap(m))).toEqual(expect.arrayContaining(['tiles-rows', 'bad-scale']));
  });
  it('flags a duplicate object id and a missing actor role', () => {
    const m = clone(sceneMap());
    m.objects[2]!.id = 'pc:aldric'; // dup
    delete (m.objects[1] as unknown as Record<string, unknown>).role; // actor without role
    expect(codes(validateSceneMap(m))).toEqual(expect.arrayContaining(['dup-id', 'missing-role']));
  });
  it('flags a bad locationId and lighting', () => {
    const m = clone(sceneMap());
    m.locationId = 'mistmoor'; // missing "loc:" prefix
    m.lighting = 'noon' as never;
    expect(codes(validateSceneMap(m))).toEqual(expect.arrayContaining(['bad-location-id', 'bad-lighting']));
  });
  it('flags kind/prefix mismatch and (with a catalog) an unknown biome', () => {
    const m = clone(sceneMap());
    m.objects[0]!.kind = 'actor'; // id "bldg:bell-tower" implies fixture
    (m.objects[0] as unknown as Record<string, unknown>).role = 'npc'; // actors need a role
    m.biome = 'mars';
    expect(codes(validateSceneMap(m, { biomes: new Set(['village']) }))).toEqual(expect.arrayContaining(['kind-prefix-mismatch', 'bad-biome']));
  });
});

describe('validateDelta (E)', () => {
  it('accepts move-by-anchor, move-by-tile, and reveal', () => {
    expect(validateDelta({ op: 'move', id: 'npc:edda', to: { anchor: 'near:prop:well' } }).ok).toBe(true);
    expect(validateDelta({ op: 'move', id: 'npc:edda', to: { col: 4, row: 4 } }).ok).toBe(true);
    expect(validateDelta({ op: 'reveal', id: 'npc:orc-lurk' }).ok).toBe(true);
  });
  it('rejects a move with no valid target and a spawn with a bad kind', () => {
    expect(codes(validateDelta({ op: 'move', id: 'npc:edda', to: {} as never }))).toContain('bad-target');
    expect(codes(validateDelta({ op: 'spawn', id: 'mob:orc-2', kind: 'beast' as never, tag: 'orc', anchor: 'center' }))).toContain('bad-kind');
  });
  it('accepts enter with a valid toLocationId and rejects a malformed one', () => {
    expect(validateDelta({ op: 'enter', id: 'pc:aldric', toLocationId: 'loc:bell-tower-interior' }).ok).toBe(true);
    expect(codes(validateDelta({ op: 'enter', id: 'pc:aldric', toLocationId: 'bell-tower' }))).toContain('bad-location-id');
  });
});
