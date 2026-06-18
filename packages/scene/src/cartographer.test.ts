import { describe, expect, it } from 'vitest';
import { type SceneComposition, validateSceneMap } from '@mythweaver/shared';
import { buildSceneMap } from './cartographer.js';

function composition(seed = 42): SceneComposition {
  return {
    locationId: 'loc:mistmoor-green',
    seed,
    grammar: 'open-outdoor',
    biome: 'village',
    lighting: 'dusk',
    grid: { cols: 24, rows: 16 },
    terrain: {
      base: 'grass',
      regions: [
        { tag: 'water', zone: 'waterside' },
        { tag: 'dirt', zone: 'path' },
      ],
    },
    placements: [
      { id: 'bldg:hall', kind: 'fixture', tag: 'market_stall', visible: true, zone: 'building-row' },
      { id: 'prop:fire', kind: 'prop', tag: 'brazier', visible: true, zone: 'commons' },
      { id: 'pc:aldric', kind: 'actor', role: 'pc', tag: 'knight', visible: true, zone: 'commons' },
      { id: 'npc:edda', kind: 'actor', role: 'npc', tag: 'villager', visible: true, zone: 'commons', anchor: 'near:prop:fire' },
      { id: 'npc:orc', kind: 'actor', role: 'npc', tag: 'orc', visible: false, zone: 'commons' },
    ],
    ambiance: { density: 0.2, tags: ['tree'] },
  };
}

describe('buildSceneMap (Cartographer)', () => {
  it('produces a SceneMap that satisfies validateSceneMap by construction', () => {
    expect(validateSceneMap(buildSceneMap(composition()))).toEqual({ ok: true, violations: [] });
  });

  it('is deterministic (same composition → identical map)', () => {
    expect(buildSceneMap(composition())).toEqual(buildSceneMap(composition()));
  });

  it('places actors only on walkable, in-bounds tiles', () => {
    const m = buildSceneMap(composition());
    for (const a of m.objects.filter((o) => o.kind === 'actor')) {
      expect(m.walkable[a.row]?.[a.col]).toBe(true);
    }
  });

  it("blocks a fixture's footprint tiles (not walkable) and never overlaps actors with it", () => {
    const m = buildSceneMap(composition());
    const hall = m.objects.find((o) => o.id === 'bldg:hall')!;
    for (let dy = 0; dy < hall.footprint.h; dy++)
      for (let dx = 0; dx < hall.footprint.w; dx++) expect(m.walkable[hall.row + dy]?.[hall.col + dx]).toBe(false);
    expect(m.objects.filter((o) => o.kind === 'actor').some((a) => a.col === hall.col && a.row === hall.row)).toBe(false);
  });

  it('honors a near:<id> anchor by placing adjacent to the referent', () => {
    const m = buildSceneMap(composition());
    const fire = m.objects.find((o) => o.id === 'prop:fire')!;
    const edda = m.objects.find((o) => o.id === 'npc:edda')!;
    const cheby = Math.max(Math.abs(edda.col - fire.col), Math.abs(edda.row - fire.row));
    expect(cheby).toBe(1); // immediately adjacent
  });

  it('carries visibility, kind/role and the semantic zone onto objects', () => {
    const m = buildSceneMap(composition());
    expect(m.objects.find((o) => o.id === 'npc:orc')!.visible).toBe(false);
    expect(m.objects.find((o) => o.id === 'pc:aldric')).toMatchObject({ kind: 'actor', role: 'pc', zone: 'commons' });
  });

  it('paints terrain regions into their zones (water along the bottom)', () => {
    const m = buildSceneMap(composition());
    expect(m.tiles[m.grid.rows - 1]!.every((t) => t === 'water')).toBe(true);
    expect(m.walkable[m.grid.rows - 1]!.every((w) => w === false)).toBe(true); // water is impassable
  });

  it('renders a blockout: horizontal path, dense treeline edges, entities snapped to their painted cells', () => {
    // 8 rows × 12 cols: two T rows top, two T rows bottom, a full P row in the middle, grass else.
    const grid = ['TTTTTTTTTTTT', 'TTTTTTTTTTTT', 'GGGGGGGGGGGG', 'GGGGGGGGGGGG', 'PPPPPPPPPPPP', 'GGGGGGGGGGGG', 'TTTTTTTTTTTT', 'TTTTTTTTTTTT'];
    const comp: SceneComposition = {
      locationId: 'loc:forest-path',
      seed: 5,
      grammar: 'open-outdoor',
      biome: 'forest',
      lighting: 'day',
      grid: { cols: 12, rows: 8 },
      terrain: { base: 'grass', regions: [] },
      placements: [
        { id: 'prop:chest', kind: 'prop', tag: 'chest', visible: true, zone: 'commons' },
        { id: 'npc:gob1', kind: 'actor', role: 'npc', tag: 'goblin', visible: true, zone: 'commons' },
        { id: 'pc:hero', kind: 'actor', role: 'pc', tag: 'knight', visible: true, zone: 'commons' },
      ],
      ambiance: { density: 0.1, tags: ['tree'] },
      blockout: {
        cols: 12,
        rows: 8,
        grid,
        cells: [
          { id: 'prop:chest', col: 6, row: 4 }, // centre, on the path
          { id: 'npc:gob1', col: 7, row: 4 },
          { id: 'pc:hero', col: 1, row: 4 }, // left
        ],
      },
    };
    const m = buildSceneMap(comp);
    expect(validateSceneMap(m)).toEqual({ ok: true, violations: [] });
    // A horizontal dirt path: row 4 is all dirt.
    expect(m.tiles[4]!.every((t) => t === 'dirt')).toBe(true);
    // No vertical dirt column spans the grid (orientation is horizontal, not vertical).
    const vert = Array.from({ length: m.grid.cols }, (_, c) => m.tiles.every((row) => row[c] === 'dirt')).some(Boolean);
    expect(vert).toBe(false);
    // Top + bottom edges are a dense treeline (trees live in ambiance).
    const treeCells = new Set(m.ambiance.filter((a) => /tree|bush/.test(a.tag)).map((a) => `${a.col},${a.row}`));
    const topFrac = m.tiles[0]!.filter((_, c) => treeCells.has(`${c},0`)).length / m.grid.cols;
    const botFrac = m.tiles[0]!.filter((_, c) => treeCells.has(`${c},${m.grid.rows - 1}`)).length / m.grid.cols;
    expect(topFrac).toBeGreaterThanOrEqual(0.5);
    expect(botFrac).toBeGreaterThanOrEqual(0.5);
    // The hero snaps near its painted left cell; the goblin near centre — hero is left of the goblin.
    const hero = m.objects.find((o) => o.id === 'pc:hero')!;
    const gob = m.objects.find((o) => o.id === 'npc:gob1')!;
    expect(hero.col).toBeLessThan(gob.col);
    expect(m.walkable[hero.row]?.[hero.col]).toBe(true);
  });

  it('guarantees a walkable interior for enclosed rooms even if the wall region is painted last', () => {
    // The 'wall' zone spans the whole grid; with regions in this (LLM-plausible) order a naive
    // painter would bury the floor and collapse every object onto (0,0).
    const interior: SceneComposition = {
      locationId: 'loc:crypt',
      seed: 7,
      grammar: 'enclosed-interior',
      biome: 'dungeon',
      lighting: 'night',
      grid: { cols: 20, rows: 14 },
      terrain: { base: 'stone', regions: [{ tag: 'stone', zone: 'floor' }, { tag: 'wall', zone: 'wall' }] },
      placements: [
        { id: 'prop:tomb', kind: 'prop', tag: 'sarcophagus', visible: true, zone: 'floor' },
        { id: 'npc:guard', kind: 'actor', role: 'npc', tag: 'skeleton', visible: true, zone: 'floor' },
        { id: 'pc:aldric', kind: 'actor', role: 'pc', tag: 'knight', visible: true, zone: 'floor' },
      ],
      ambiance: { density: 0, tags: [] },
    };
    const m = buildSceneMap(interior);
    expect(validateSceneMap(m)).toEqual({ ok: true, violations: [] });
    // The border is wall; the interior has walkable floor.
    expect(m.walkable[0]!.every((w) => w === false)).toBe(true);
    expect(m.walkable.slice(1, -1).some((row) => row.slice(1, -1).some((w) => w === true))).toBe(true);
    // Objects are spread, not piled on one cell.
    const cells = new Set(m.objects.map((o) => `${o.col},${o.row}`));
    expect(cells.size).toBe(m.objects.length);
  });
});
