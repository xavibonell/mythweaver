import { describe, expect, it } from 'vitest';
import { applySceneDeltas, findMapObject } from './world-apply.js';
import type { MapObject, SceneMap } from './world.js';

/** A hand-built 12×8 map: grass everywhere, a water column at col 9, a wall at (5,2). */
function makeMap(): SceneMap {
  const cols = 12, rows = 8;
  const tiles = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => (c === 9 ? 'water' : r === 2 && c === 5 ? 'wall' : 'grass')));
  const walkable = tiles.map((row) => row.map((t) => t === 'grass'));
  const obj = (o: Partial<MapObject> & { id: string; col: number; row: number }): MapObject => ({
    kind: 'actor', tag: 'knight', footprint: { w: 1, h: 1 }, facing: 'down', visible: true, ...o,
  } as MapObject);
  return {
    locationId: 'loc:test', seed: 1, biome: 'village', lighting: 'day', grammar: 'open-outdoor',
    grid: { cols, rows, feetPerTile: 5 },
    tiles, walkable,
    objects: [
      obj({ id: 'pc:aldric', role: 'pc', col: 2, row: 2, name: 'Aldric' }),
      obj({ id: 'npc:edda', role: 'npc', col: 6, row: 5, name: 'Edda' }),
      obj({ id: 'npc:orc', role: 'npc', col: 8, row: 6, name: 'a lurking orc', visible: false }),
      obj({ id: 'prop:well', kind: 'prop', tag: 'well', col: 6, row: 3 }),
    ],
    ambiance: [], entrances: [{ toLocationId: 'loc:elsewhere', col: 6, row: 7 }],
  };
}

describe('applySceneDeltas — the deterministic geometry gateway', () => {
  it('moves to a near:<id> anchor: first free walkable cell adjacent to the referent', () => {
    const map = makeMap();
    const { applied, rejected } = applySceneDeltas(map, [{ op: 'move', id: 'npc:edda', to: { anchor: 'near:prop:well' } }]);
    expect(rejected).toEqual([]);
    const edda = map.objects.find((o) => o.id === 'npc:edda')!;
    expect(Math.max(Math.abs(edda.col - 6), Math.abs(edda.row - 3))).toBeLessThanOrEqual(2); // beside the well
    // The applied delta is NORMALIZED to a concrete tile so a client can tween to it.
    expect(applied[0]).toEqual({ op: 'move', id: 'npc:edda', to: { col: edda.col, row: edda.row } });
    expect(edda.anchorRef).toBe('near:prop:well');
  });

  it('snaps a blocked explicit tile to the nearest free cell (radius 3), mutating in place', () => {
    const map = makeMap();
    const { applied, rejected } = applySceneDeltas(map, [{ op: 'move', id: 'pc:aldric', to: { col: 5, row: 2 } }]); // the wall
    expect(rejected).toEqual([]);
    const to = (applied[0] as { to: { col: number; row: number } }).to;
    expect(map.walkable[to.row]![to.col]).toBe(true);
    expect(Math.max(Math.abs(to.col - 5), Math.abs(to.row - 2))).toBeLessThanOrEqual(3);
  });

  it('refuses a move into open water with a narratable reason', () => {
    const map = makeMap();
    // Make the whole east side water so nothing is free within the snap radius.
    for (let r = 0; r < 8; r++) for (let c = 6; c < 12; c++) { map.tiles[r]![c] = 'water'; map.walkable[r]![c] = false; }
    map.objects = map.objects.filter((o) => o.id === 'pc:aldric');
    const { applied, rejected } = applySceneDeltas(map, [{ op: 'move', id: 'pc:aldric', to: { col: 11, row: 4 } }]);
    expect(applied).toEqual([]);
    expect(rejected[0]!.reason).toContain('blocked');
  });

  it('will not stack two visible actors on one cell (occupancy snaps the second aside)', () => {
    const map = makeMap();
    applySceneDeltas(map, [{ op: 'move', id: 'npc:edda', to: { col: 2, row: 2 } }]); // Aldric's cell
    const edda = map.objects.find((o) => o.id === 'npc:edda')!;
    expect(edda.col === 2 && edda.row === 2).toBe(false); // snapped to a neighbour
  });

  it('reveal/hide flip visibility; despawn removes; PCs cannot be despawned', () => {
    const map = makeMap();
    const { applied, rejected } = applySceneDeltas(map, [
      { op: 'reveal', id: 'npc:orc' },
      { op: 'hide', id: 'npc:edda' },
      { op: 'despawn', id: 'npc:orc' },
      { op: 'despawn', id: 'pc:aldric' },
    ]);
    expect(applied.map((a) => a.op)).toEqual(['reveal', 'hide', 'despawn']);
    expect(map.objects.some((o) => o.id === 'npc:orc')).toBe(false);
    expect(map.objects.find((o) => o.id === 'npc:edda')!.visible).toBe(false);
    expect(rejected[0]!.reason).toContain('party members');
    expect(map.objects.some((o) => o.id === 'pc:aldric')).toBe(true);
  });

  it('spawns near a referent with a fresh id (and refuses a duplicate id)', () => {
    const map = makeMap();
    const { applied, rejected } = applySceneDeltas(map, [
      { op: 'spawn', id: 'npc:goblin-1', kind: 'actor', role: 'mob', tag: 'goblin', anchor: 'near:pc:aldric' },
      { op: 'spawn', id: 'npc:edda', kind: 'actor', role: 'npc', tag: 'villager', anchor: 'center' },
    ]);
    const g = map.objects.find((o) => o.id === 'npc:goblin-1')!;
    expect(g).toBeTruthy();
    expect(Math.max(Math.abs(g.col - 2), Math.abs(g.row - 2))).toBeLessThanOrEqual(2); // beside Aldric
    const spawn = applied[0] as { at?: { col: number; row: number } };
    expect(spawn.at).toEqual({ col: g.col, row: g.row }); // resolved tile rides the applied delta
    expect(rejected[0]!.reason).toContain('already exists');
  });

  it('an earlier spawn can anchor a later move (ops apply in order)', () => {
    const map = makeMap();
    const { rejected } = applySceneDeltas(map, [
      { op: 'spawn', id: 'prop:brazier-1', kind: 'prop', tag: 'brazier', anchor: 'center' },
      { op: 'move', id: 'npc:edda', to: { anchor: 'near:prop:brazier-1' } },
    ]);
    expect(rejected).toEqual([]);
  });

  it('setState merges; enter is refused; unknown ids are refused with the id in the reason', () => {
    const map = makeMap();
    const { applied, rejected } = applySceneDeltas(map, [
      { op: 'setState', id: 'prop:well', state: { bucket: 'raised' } },
      { op: 'enter', id: 'pc:aldric', toLocationId: 'loc:elsewhere' },
      { op: 'move', id: 'npc:ghost', to: { anchor: 'center' } },
    ]);
    expect(applied).toHaveLength(1);
    expect(map.objects.find((o) => o.id === 'prop:well')!.state).toEqual({ bucket: 'raised' });
    expect(rejected[0]!.reason).toContain('setScene');
    expect(rejected[1]!.reason).toContain('npc:ghost');
  });

  it('findMapObject resolves loosely: exact id, case-insensitive, or name', () => {
    const map = makeMap();
    expect(findMapObject(map, 'npc:edda')!.id).toBe('npc:edda');
    expect(findMapObject(map, 'NPC:Edda')!.id).toBe('npc:edda');
    expect(findMapObject(map, 'Edda')!.id).toBe('npc:edda');
    expect(findMapObject(map, 'npc:nobody')).toBeUndefined();
  });
});
