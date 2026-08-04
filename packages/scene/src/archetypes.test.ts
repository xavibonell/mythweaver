import { describe, expect, it } from 'vitest';
import { type SceneMap, validateSceneMap } from '@mythweaver/shared';
import { normalizeProgram, runProgram, type SceneProgram } from './scene-program.js';
import { ARCHETYPE_KINDS, type ArchetypeKind, type Contents } from './archetypes.js';

/** A town SceneProgram with one archetype op — the path that replaces LLM-placed building rects. */
const townProgram = (seed: number, contents?: Partial<Contents>): SceneProgram => ({
  locationId: 'loc:test-town', cols: 60, rows: 44, seed, biome: 'village', lighting: 'day', grammar: 'town-square', outdoor: true, theme: 'village',
  ops: [
    {
      op: 'archetype', kind: 'town', contents: {
        buildings: [{ type: 'tavern' }, { type: 'temple' }, { type: 'smithy' }, { type: 'shop' }, { type: 'house' }, { type: 'house' }],
        landmarks: [{ tag: 'fountain' }],
        npcs: [{ tag: 'villager' }, { tag: 'knight' }],
        mobs: [],
        wall: true,
        entranceSide: 'south',
        ...contents,
      },
    },
  ],
});

const tiles = (m: SceneMap, pred: (t: string) => boolean) => m.tiles.flat().filter(pred).length;
const buildingCount = (m: SceneMap) => m.entrances.filter((e) => e.fixtureId?.startsWith('bldg:')).length;
// Distinct furnished-room groups (furnishRoom tags each room's furniture `bldg:<safe>-r<n>`) — a
// multi-room compound contributes several, so roomCount > buildingCount proves rooms, not open boxes.
const roomCount = (m: SceneMap) => new Set(m.objects.map((o) => o.group).filter((g): g is string => !!g && g.startsWith('bldg:'))).size;

describe('town archetype generator — the organic-layout fix', () => {
  it('is a valid SceneMap by construction', () => {
    expect(validateSceneMap(runProgram(townProgram(717)))).toEqual({ ok: true, violations: [] });
  });

  it('packs varied MULTI-ROOM compounds (not one open box each)', () => {
    const m = runProgram(townProgram(717));
    const b = buildingCount(m);
    expect(b).toBeGreaterThanOrEqual(6);
    expect(b).toBeLessThanOrEqual(40);
    expect(roomCount(m)).toBeGreaterThan(b); // some buildings have >1 furnished room → compounds, not boxes
  });

  it('lays a cobbled street network + a cobbled plaza (not a flat dirt lot)', () => {
    const m = runProgram(townProgram(717));
    // arteries + plaza are the unified `road` cobble (autotiled into road/road_t/…); alleys stay dirt.
    expect(tiles(m, (t) => t.startsWith('road') || t === 'dirt')).toBeGreaterThan(40); // paved arteries + dirt alleys
    expect(tiles(m, (t) => t.startsWith('road'))).toBeGreaterThan(30); // arteries + plaza are actually cobbled, not all mud
  });

  it('dresses the scene with two-texture density (blue-noise + clumps), not a bare field', () => {
    const m = runProgram(townProgram(717));
    expect(m.ambiance.length).toBeGreaterThan(30);
    expect(m.ambiance.some((a) => a.tag.startsWith('tree'))).toBe(true); // structural greenery
    expect(m.ambiance.some((a) => a.tag === 'flowers')).toBe(true); // clumped beds
  });

  it('is deterministic (same seed → byte-identical map)', () => {
    expect(JSON.stringify(runProgram(townProgram(717)))).toBe(JSON.stringify(runProgram(townProgram(717))));
  });

  it('varies with the seed (different seed → a different town, i.e. not a fixed template)', () => {
    const a = runProgram(townProgram(717));
    const b = runProgram(townProgram(424242));
    expect(JSON.stringify(a.tiles)).not.toBe(JSON.stringify(b.tiles));
  });

  it('connects every building entrance, gate, and actor into one reachable component', () => {
    const m = runProgram(townProgram(717, { mobs: [{ tag: 'goblin', count: 4 }] }));
    const { cols, rows } = m.grid;
    const idx = (c: number, r: number) => r * cols + c;
    let start: { c: number; r: number } | null = null;
    for (let r = rows - 1; r >= 0 && !start; r--) for (let c = 0; c < cols && !start; c++) if (m.walkable[r]![c]) start = { c, r };
    const seen = new Set<number>([idx(start!.c, start!.r)]);
    const q = [start!];
    const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
    while (q.length) { const cur = q.shift()!; for (const [dx, dy] of ORTH) { const cc = cur.c + dx, rr = cur.r + dy; if (cc >= 0 && cc < cols && rr >= 0 && rr < rows && m.walkable[rr]![cc] && !seen.has(idx(cc, rr))) { seen.add(idx(cc, rr)); q.push({ c: cc, r: rr }); } } }
    for (const e of m.entrances) expect(seen.has(idx(e.col, e.row))).toBe(true);
    for (const o of m.objects) if (o.kind === 'actor') expect(seen.has(idx(o.col, o.row))).toBe(true);
  });
});

describe('archetype op — untrusted-input coercion (the LLM path)', () => {
  it('clamps an unknown archetype kind to town and coerces the Contents cast', () => {
    const prog = normalizeProgram(
      { cols: 50, rows: 40, theme: 'village', grammar: 'town-square', outdoor: true, ops: [{ op: 'archetype', kind: 'metropolis', contents: { buildings: [{ type: 'pub' }, { type: 'forge' }], npcs: [{ tag: 'goblin' }], landmarks: [{ tag: 'fountain' }], mobs: [{ tag: 'orc', count: 99 }], wall: true } }] },
      'a small walled town',
    );
    const op = prog.ops.find((o) => o.op === 'archetype');
    expect(op).toBeTruthy();
    if (op && op.op === 'archetype') {
      expect(op.kind).toBe('town'); // unknown kind → town
      expect(op.contents.buildings.map((b) => b.type)).toEqual(['tavern', 'smithy']); // pub→tavern, forge→smithy
      expect(op.contents.mobs[0]!.count).toBeLessThanOrEqual(20); // count clamped
      expect(op.contents.wall).toBe(true);
    }
    expect(validateSceneMap(runProgram(prog))).toEqual({ ok: true, violations: [] });
  });
});

describe('every archetype generator produces a valid, reachable SceneMap (the seam generalizes)', () => {
  const sample: Contents = {
    buildings: [{ type: 'tavern' }, { type: 'temple' }, { type: 'house' }],
    landmarks: [{ tag: 'fountain' }, { tag: 'chest' }],
    npcs: [{ tag: 'villager' }],
    mobs: [{ tag: 'skeleton', count: 4 }],
    entranceSide: 'south',
  };
  it.each(ARCHETYPE_KINDS)('"%s" generator → valid SceneMap', (kind: ArchetypeKind) => {
    const interior = kind === 'town' || kind === 'wilderness' || kind === 'coast';
    const prog: SceneProgram = {
      locationId: `loc:gen-${kind}`, cols: 54, rows: 40, seed: 9, biome: 'forest', lighting: 'day',
      grammar: interior ? 'open-outdoor' : 'enclosed-interior', outdoor: interior, theme: kind === 'cave' ? 'cave' : kind === 'dungeon' ? 'dungeon' : 'village',
      ops: [{ op: 'archetype', kind, contents: sample }],
    };
    expect(validateSceneMap(runProgram(prog))).toEqual({ ok: true, violations: [] });
  });
});

describe('town routing — settlements go through the generator, not LLM-placed rects', () => {
  it('rewrites a settlement program of loose building rects into ONE town archetype op (harvesting the cast)', () => {
    const prog = normalizeProgram(
      {
        cols: 44, rows: 28, theme: 'village', grammar: 'town-square', outdoor: true,
        ops: [
          { op: 'building', type: 'tavern', region: { x: 4, y: 3, w: 10, h: 8 }, id: 'bldg:tavern', name: 'the Gilded Stag' },
          { op: 'building', type: 'smithy', region: { x: 28, y: 3, w: 10, h: 8 }, id: 'bldg:smithy' },
          { op: 'plaza', region: { x: 18, y: 12, w: 8, h: 6 } },
          { op: 'place', id: 'prop:well', tag: 'fountain', kind: 'prop', at: 'center' },
          { op: 'place', id: 'npc:guard', tag: 'knight', kind: 'actor', role: 'npc', at: { c: 20, r: 14 } },
          { op: 'wallRing', mat: 'stone' },
        ],
      },
      'a small walled town with a tavern and a smithy and a guard',
    );
    expect(prog.ops.length).toBe(1);
    const op = prog.ops[0]!;
    expect(op.op).toBe('archetype');
    if (op.op === 'archetype') {
      expect(op.kind).toBe('town');
      expect(op.contents.buildings.map((b) => b.type)).toEqual(['tavern', 'smithy']);
      expect(op.contents.npcs.some((n) => n.tag === 'knight')).toBe(true);
      expect(op.contents.wall).toBe(true); // from the wallRing op + "walled"
    }
    expect(prog.cols).toBeGreaterThanOrEqual(54); // floored larger for the generator
    expect(validateSceneMap(runProgram(prog))).toEqual({ ok: true, violations: [] });
  });

  it('BRIEF_BUILDS net: every establishment the brief NAMES survives, even when the model drops it', () => {
    // The model emitted only generic houses — but the brief names a temple, a smithy and a manor. The
    // harvest's completeness net must add all three deterministically (the twin of BRIEF_CREATURES).
    const prog = normalizeProgram(
      {
        cols: 44, rows: 28, theme: 'village', grammar: 'town-square', outdoor: true,
        ops: [
          { op: 'building', type: 'house', region: { x: 4, y: 3, w: 10, h: 8 }, id: 'bldg:h1' },
          { op: 'building', type: 'house', region: { x: 28, y: 3, w: 10, h: 8 }, id: 'bldg:h2' },
        ],
      },
      'a village with a temple, a smithy and a manor house on the hill',
    );
    const op = prog.ops.find((o) => o.op === 'archetype');
    expect(op).toBeTruthy();
    if (op && op.op === 'archetype') {
      const types = new Set<string>(op.contents.buildings.map((b) => b.type));
      for (const t of ['temple', 'smithy', 'manor']) expect(types.has(t), t).toBe(true);
    }
  });

  it('does NOT route a water-dominant village (geometry matters there) to the town generator', () => {
    const prog = normalizeProgram(
      { cols: 40, rows: 26, theme: 'forest', grammar: 'open-outdoor', outdoor: true, ops: [{ op: 'fill', region: 'all', tag: 'water' }, { op: 'island', region: { x: 4, y: 4, w: 12, h: 10 } }] },
      'a fishing village of huts on stilts over a flooded lake',
    );
    expect(prog.ops.some((o) => o.op === 'archetype')).toBe(false);
  });
});

describe('town lot scarcity — a NAMED building must never be silently dropped (the b1 boathouse)', () => {
  // The drowned-bell shape: 7 anonymous waterfront shacks + 1 named waterfront boathouse — more
  // declared buildings than the parcel grid can hold. The named one must claim a lot FIRST.
  const scarceContents: Partial<Contents> = {
    buildings: [
      ...Array.from({ length: 7 }, () => ({ type: 'house' as const, waterfront: true })),
      { type: 'workshop' as const, name: 'sedge_boathouse', waterfront: true },
    ],
    landmarks: [], npcs: [], mobs: [], wall: false, coast: true, port: true, entranceSide: 'east' as const,
  };

  it('lands the named waterfront building on a shore lot, across many seeds', () => {
    for (const seed of [1, 42, 717, 999, 12345, 3737264664]) {
      const prog = townProgram(seed, scarceContents);
      const m = runProgram(prog);
      const marker = m.objects.find((o) => o.name === 'sedge_boathouse');
      expect(marker, `seed ${seed}: the named building must land`).toBeTruthy();
      // shore-side: the coast flips to the west edge (the entrance holds the east), so the marker
      // must sit in the western half — a shore lot, not wherever the queue happened to run out.
      expect(marker!.col, `seed ${seed}: expected a shore-side lot`).toBeLessThan(60 / 2 + 4);
    }
  });

  it('reports any building that found no lot in the program notes (never a silent drop)', () => {
    const prog = townProgram(717, scarceContents);
    runProgram(prog);
    // 8 declared buildings rarely all fit — when any misses, the note must name the loss and may
    // only list ANONYMOUS entries (the named one landed; see above).
    const drop = (prog.notes ?? []).find((n) => n.startsWith('town:') && n.includes('found no lot'));
    if (drop) expect(drop).not.toContain('sedge_boathouse');
  });

  it('keeps gold programs pristine (buildSpikeScene must not accumulate notes on the shared constants)', async () => {
    const { GOLD_PROGRAMS, buildSpikeScene } = await import('./scene-program.js');
    buildSpikeScene('town');
    buildSpikeScene('town');
    expect(GOLD_PROGRAMS.town!.notes ?? []).toEqual([]);
  });
});

describe('cast-station contract — anchored NPCs stand at their post (coherence ④)', () => {
  it('an anchored NPC is posted AT their station, not round-robined onto a street cell', () => {
    const prog = townProgram(717, { npcs: [{ tag: 'villager', name: 'Hobb Fen', anchor: 'near:forge' }] });
    const m = runProgram(prog);
    const hobb = m.objects.find((o) => o.name === 'Hobb Fen')!;
    const forge = m.objects.find((o) => o.tag === 'forge')!;
    expect(hobb).toBeTruthy();
    expect(forge).toBeTruthy(); // the smithy's defining kit
    const d = Math.max(Math.abs(hobb.col - forge.col), Math.abs(hobb.row - forge.row));
    expect(d).toBeLessThanOrEqual(5); // at the post (resolver radius 4 + footprint slack)
    expect((prog.notes ?? []).some((n) => n === 'cast-station: Hobb Fen posted at forge')).toBe(true);
  });

  it('an unresolvable anchor is REPORTED and the NPC still lands (street fallback, never a silent mis-post)', () => {
    const prog = townProgram(717, { npcs: [{ tag: 'villager', name: 'Ghost', anchor: 'near:zzz-nothing' }] });
    const m = runProgram(prog);
    expect(m.objects.some((o) => o.name === 'Ghost')).toBe(true);
    expect((prog.notes ?? []).some((n) => n.startsWith('cast-station: Ghost') && n.includes('matched nothing'))).toBe(true);
  });
});
