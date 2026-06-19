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

  it('expands an object field into many id-addressed children (grid of pews) sharing a group', () => {
    const comp: SceneComposition = {
      locationId: 'loc:church',
      seed: 11,
      grammar: 'enclosed-interior',
      biome: 'dungeon',
      lighting: 'night',
      grid: { cols: 20, rows: 14 },
      terrain: { base: 'stone', regions: [{ tag: 'stone', zone: 'floor' }, { tag: 'wall', zone: 'wall' }] },
      placements: [{ id: 'prop:altar', kind: 'prop', tag: 'altar', visible: true, zone: 'floor', anchor: 'north' }],
      ambiance: { density: 0, tags: [] },
      fields: [{ idBase: 'prop:pews', kind: 'prop', tag: 'table', region: { band: 'center' }, arrangement: 'grid', count: 10, spacing: 2 }],
    };
    const m = buildSceneMap(comp);
    expect(validateSceneMap(m)).toEqual({ ok: true, violations: [] });
    const pews = m.objects.filter((o) => o.group === 'prop:pews');
    expect(pews.length).toBeGreaterThanOrEqual(6); // a real grid, not one element
    expect(pews.length).toBeLessThanOrEqual(10); // respects count
    expect(pews.every((o) => /^prop:pews#\d\d$/.test(o.id))).toBe(true); // deterministic child ids
    expect(new Set(pews.map((o) => `${o.col},${o.row}`)).size).toBe(pews.length); // no two pews stack
    expect(pews.every((o) => m.walkable[o.row]?.[o.col] === false)).toBe(true); // blocking props block their tile
    // spacing leaves walkable lanes between pews
    expect(m.walkable.some((row) => row.some((w) => w === true))).toBe(true);
  });

  it('field expansion is deterministic (same composition → identical map)', () => {
    const comp = (): SceneComposition => ({
      locationId: 'loc:hall', seed: 3, grammar: 'enclosed-interior', biome: 'dungeon', lighting: 'night',
      grid: { cols: 18, rows: 12 }, terrain: { base: 'stone', regions: [{ tag: 'stone', zone: 'floor' }] },
      placements: [], ambiance: { density: 0, tags: [] },
      fields: [{ idBase: 'npc:guards', kind: 'actor', role: 'mob', tag: 'skeleton', region: { band: 'all' }, arrangement: 'scatter', count: 5 }],
    });
    expect(buildSceneMap(comp())).toEqual(buildSceneMap(comp()));
    const guards = buildSceneMap(comp()).objects.filter((o) => o.group === 'npc:guards');
    expect(guards.length).toBe(5);
    expect(guards.every((o) => o.kind === 'actor' && o.role === 'mob')).toBe(true);
  });

  it('a "line" field along a wall places the requested count in a line', () => {
    const comp: SceneComposition = {
      locationId: 'loc:gallery', seed: 7, grammar: 'enclosed-interior', biome: 'dungeon', lighting: 'night',
      grid: { cols: 20, rows: 14 }, terrain: { base: 'stone', regions: [{ tag: 'stone', zone: 'floor' }] },
      placements: [], ambiance: { density: 0, tags: [] },
      fields: [{ idBase: 'prop:statues', kind: 'prop', tag: 'gravestone', region: { band: 'left' }, arrangement: 'line', count: 3, spacing: 3 }],
    };
    const statues = buildSceneMap(comp).objects.filter((o) => o.group === 'prop:statues');
    expect(statues.length).toBe(3);
    expect(new Set(statues.map((s) => s.col)).size).toBe(1); // a vertical line: one column
  });

  it('a near:<id> + flank field places children on either side of the referenced landmark', () => {
    const comp: SceneComposition = {
      locationId: 'loc:throne', seed: 2, grammar: 'enclosed-interior', biome: 'dungeon', lighting: 'night',
      grid: { cols: 20, rows: 14 }, terrain: { base: 'stone', regions: [{ tag: 'stone', zone: 'floor' }] },
      placements: [{ id: 'prop:throne', kind: 'prop', tag: 'altar', visible: true, zone: 'floor', anchor: 'center' }],
      ambiance: { density: 0, tags: [] },
      fields: [{ idBase: 'mob:guards', kind: 'actor', role: 'mob', tag: 'skeleton', region: { near: 'prop:throne' }, arrangement: 'flank' }],
    };
    const m = buildSceneMap(comp);
    expect(validateSceneMap(m)).toEqual({ ok: true, violations: [] });
    const throne = m.objects.find((o) => o.id === 'prop:throne')!;
    const guards = m.objects.filter((o) => o.group === 'mob:guards');
    expect(guards.length).toBe(2);
    expect(guards.every((g) => Math.abs(g.row - throne.row) <= 1)).toBe(true); // flanking on the throne's row
    expect(guards[0]!.col).toBeLessThan(throne.col); // one to the left
    expect(guards[1]!.col).toBeGreaterThan(throne.col); // one to the right
  });

  it('an aisle:"vertical" grid leaves the central column clear', () => {
    const comp: SceneComposition = {
      locationId: 'loc:nave', seed: 1, grammar: 'enclosed-interior', biome: 'dungeon', lighting: 'night',
      grid: { cols: 20, rows: 14 }, terrain: { base: 'stone', regions: [{ tag: 'stone', zone: 'floor' }] },
      placements: [], ambiance: { density: 0, tags: [] },
      fields: [{ idBase: 'prop:pews', kind: 'prop', tag: 'table', region: { band: 'center' }, arrangement: 'grid', spacing: 1, aisle: 'vertical' }],
    };
    const m = buildSceneMap(comp);
    const pews = m.objects.filter((o) => o.group === 'prop:pews');
    const cols = new Set(pews.map((p) => p.col));
    const aisleCol = 2 + Math.floor((20 - 4) / 2); // region 'center' = {x:2,w:16}; its mid column is the aisle
    expect(cols.has(aisleCol)).toBe(false); // a clear central lane
    expect([...cols].some((c) => c < aisleCol) && [...cols].some((c) => c > aisleCol)).toBe(true); // pews on both sides
  });

  it('blockout chars D/A paint deep water + sand terrain', () => {
    const comp: SceneComposition = {
      locationId: 'loc:coast', seed: 1, grammar: 'open-outdoor', biome: 'forest', lighting: 'day',
      grid: { cols: 12, rows: 8 }, terrain: { base: 'grass', regions: [] }, placements: [], ambiance: { density: 0, tags: [] },
      blockout: { cols: 12, rows: 8, cells: [], grid: ['AAAAAAAAAAAA', 'GGGGGGGGGGGG', 'GGGGGGGGGGGG', 'GGGGGGGGGGGG', 'GGGGGGGGGGGG', 'GGGGGGGGGGGG', 'DDDDDDDDDDDD', 'DDDDDDDDDDDD'] },
    };
    const m = buildSceneMap(comp);
    expect(m.tiles[0]!.every((t) => t === 'sand')).toBe(true);
    expect(m.tiles[7]!.every((t) => t === 'water_deep')).toBe(true);
    expect(m.walkable[7]!.every((w) => w === false)).toBe(true); // deep water is impassable
  });

  it('a band:"shore" field binds crates to the waterline (an island ringed by water)', () => {
    // An island: grass interior, water all around the border → shore = the land ring.
    const grid: string[] = [];
    for (let r = 0; r < 10; r++) {
      let row = '';
      for (let c = 0; c < 16; c++) row += r === 0 || r === 9 || c === 0 || c === 1 || c === 14 || c === 15 ? 'W' : 'G';
      grid.push(row);
    }
    const comp: SceneComposition = {
      locationId: 'loc:isle', seed: 3, grammar: 'open-outdoor', biome: 'forest', lighting: 'day',
      grid: { cols: 16, rows: 10 }, terrain: { base: 'grass', regions: [] }, placements: [], ambiance: { density: 0, tags: [] },
      blockout: { cols: 16, rows: 10, cells: [], grid },
      fields: [{ idBase: 'prop:crates', kind: 'prop', tag: 'crate', region: { band: 'shore' }, arrangement: 'scatter', count: 6 }],
    };
    const m = buildSceneMap(comp);
    expect(validateSceneMap(m)).toEqual({ ok: true, violations: [] });
    const crates = m.objects.filter((o) => o.group === 'prop:crates');
    expect(crates.length).toBeGreaterThanOrEqual(4);
    // every crate sits on a shore (sand) tile — i.e. land orthogonally adjacent to water
    for (const cr of crates) {
      const adjWater = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).some(([dx, dy]) => m.tiles[cr.row + dy]?.[cr.col + dx] === 'water');
      expect(adjWater).toBe(true);
    }
  });

  it('a boat is a PLATFORM: its footprint becomes walkable so an actor can stand on it over water', () => {
    const comp: SceneComposition = {
      locationId: 'loc:sea', seed: 2, grammar: 'open-outdoor', biome: 'forest', lighting: 'day',
      grid: { cols: 14, rows: 10 }, terrain: { base: 'water', regions: [] },
      placements: [
        { id: 'prop:boat', kind: 'prop', tag: 'boat', visible: true, zone: 'commons' },
        { id: 'npc:sailor', kind: 'actor', role: 'npc', tag: 'knight', visible: true, zone: 'commons', anchor: 'near:prop:boat' },
      ],
      ambiance: { density: 0, tags: [] },
    };
    const m = buildSceneMap(comp);
    expect(validateSceneMap(m)).toEqual({ ok: true, violations: [] });
    const boat = m.objects.find((o) => o.id === 'prop:boat')!;
    expect(boat.footprint).toEqual({ w: 3, h: 2 }); // the platform footprint
    // the boat's deck tiles are walkable even though the base terrain is water
    let deckWalkable = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 3; dx++) if (m.walkable[boat.row + dy]?.[boat.col + dx]) deckWalkable++;
    expect(deckWalkable).toBeGreaterThanOrEqual(5);
    const sailor = m.objects.find((o) => o.id === 'npc:sailor')!;
    expect(m.walkable[sailor.row]?.[sailor.col]).toBe(true); // standing on the boat, not drowning
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

  it('carves a settlement building into a reachable, furnished walled room', () => {
    const comp: SceneComposition = {
      locationId: 'loc:town',
      seed: 7,
      grammar: 'town-square',
      biome: 'village',
      lighting: 'day',
      grid: { cols: 24, rows: 16 },
      terrain: { base: 'grass', regions: [{ tag: 'stone', zone: 'plaza' }] },
      placements: [{ id: 'pc:hero', kind: 'actor', role: 'pc', tag: 'knight', visible: true, zone: 'plaza' }],
      ambiance: { density: 0, tags: [] },
      buildings: [{ id: 'bldg:shop', type: 'shop', rect: { x: 2, y: 1, w: 7, h: 6 }, door: 'south' }],
    };
    const m = buildSceneMap(comp);
    expect(validateSceneMap(m)).toEqual({ ok: true, violations: [] });
    // A wall ring: the footprint border is wall, the interior has walkable floor.
    expect(m.tiles[1]![2]).toBe('wall');
    expect(m.tiles[3]![5]).toBe('stone');
    // A door Entrance links the building.
    const door = m.entrances.find((e) => e.fixtureId === 'bldg:shop');
    expect(door).toBeTruthy();
    // Furniture + a keeper were placed inside, grouped under the building.
    const inside = m.objects.filter((o) => o.group === 'bldg:shop');
    expect(inside.some((o) => o.kind === 'actor')).toBe(true); // keeper
    expect(inside.filter((o) => o.kind === 'prop').length).toBeGreaterThan(0); // furniture
    // CONNECTIVITY: every actor (incl. the shop keeper) is reachable from the hero via walkable tiles.
    const { cols, rows } = m.grid;
    const start = m.objects.find((o) => o.role === 'pc')!;
    const seen = new Set<number>([start.row * cols + start.col]);
    const q = [{ c: start.col, r: start.row }];
    while (q.length) {
      const { c, r } = q.shift()!;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const cc = c + dx, rr = r + dy;
        if (cc >= 0 && rr >= 0 && cc < cols && rr < rows && m.walkable[rr]![cc] && !seen.has(rr * cols + cc)) { seen.add(rr * cols + cc); q.push({ c: cc, r: rr }); }
      }
    }
    for (const a of m.objects.filter((o) => o.kind === 'actor')) expect(seen.has(a.row * cols + a.col)).toBe(true);
  });
});
