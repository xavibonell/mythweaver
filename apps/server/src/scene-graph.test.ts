import { describe, expect, it } from 'vitest';
import type { SpatialIndex } from '@mythweaver/engine';
import { sceneGraph, zoneDigest, nearbyLine, narrationBreaksScene, arrivalZoneNote } from './scene-graph.js';

// A hand-built SpatialIndex (roofAt is what the graph reads for membership) + a matching SceneMap. Avoids
// rasterizing real roof polygons — the graph consumes roofAt/medium/opaque, so setting them directly is
// faithful to the contract. FORGE occupies cols 5-8 × rows 5-8; its door is at (6,9), just south.
const COLS = 30, ROWS = 30, FT = 5;
function idxWithForge(): SpatialIndex {
  const roofAt = new Map<number, string>();
  for (let r = 5; r <= 8; r++) for (let c = 5; c <= 8; c++) roofAt.set(r * COLS + c, 'bldg:forge');
  return {
    locationId: 'loc:x', cols: COLS, rows: ROWS, feetPerTile: FT,
    medium: new Uint8Array(COLS * ROWS), // all ground
    opaque: new Uint8Array(COLS * ROWS), // no walls → line of sight always clear
    roomId: new Int16Array(COLS * ROWS), // 0 = walkable
    rooms: [], occupied: new Map(), roofAt, unknownTags: [],
  };
}
const idx = idxWithForge();

// Aldric acts from (10,10). Bram (the smith) is INSIDE the forge at (7,7). Hobb Fen stands OUTDOORS just
// south of the forge door at (6,10) — 20 ft from Aldric. Tessa Reed is far off at (10,25) — 75 ft (> earshot).
const map: any = {
  locationId: 'loc:x', seed: 1, biome: 'village', lighting: 'day', grammar: 'town-square',
  grid: { cols: COLS, rows: ROWS, feetPerTile: FT },
  tiles: Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => 'grass')),
  walkable: Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => true)),
  objects: [
    { id: 'pc:aldric', kind: 'actor', role: 'pc', tag: 'knight', name: 'Aldric', col: 10, row: 10, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
    { id: 'npc:bram', kind: 'actor', role: 'npc', tag: 'villager', name: 'Bram', col: 5, row: 5, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
    { id: 'npc:hobb', kind: 'actor', role: 'npc', tag: 'villager', name: 'Hobb Fen', col: 6, row: 10, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
    { id: 'npc:tessa', kind: 'actor', role: 'npc', tag: 'villager', name: 'Tessa Reed', col: 10, row: 25, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
    { id: 'prop:anvil', kind: 'prop', tag: 'anvil', col: 6, row: 6, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
    { id: 'prop:bellows', kind: 'prop', tag: 'bellows', col: 7, row: 6, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
  ],
  ambiance: [], entrances: [{ toLocationId: 'loc:x', col: 6, row: 9, fixtureId: 'bldg:forge' }], roofs: [],
};

describe('sceneGraph — zone membership from the oracle roof', () => {
  it('places each actor in exactly one zone: forge interior vs the open ground', () => {
    const g = sceneGraph(map, idx);
    expect(g.zoneOf.get('npc:bram')).toBe('bldg:forge'); // under the roof → inside
    expect(g.zoneOf.get('npc:hobb')).toBe('outdoor'); // just outside the door → outdoors
    expect(g.zoneOf.get('pc:aldric')).toBe('outdoor');
    const forge = g.zones.find((z) => z.buildingId === 'bldg:forge')!;
    expect(forge.type).toBe('forge'); // named by its interior (anvil + bellows)
    expect(forge.contents).toEqual(expect.arrayContaining(['anvil', 'bellows']));
  });
});

describe('zoneDigest / nearbyLine — the WHO-IS-WHERE block', () => {
  it('lists membership and an acting-PC earshot band', () => {
    const d = zoneDigest(map, idx, 'Aldric');
    expect(d).toMatch(/the forge.*Bram/s); // Bram shown inside the forge
    expect(d).toMatch(/OPEN GROUND.*Hobb Fen/s); // Hobb outdoors
    expect(d).toMatch(/SUPERSEDES/); // the anti-stale-tableau header
    const n = nearbyLine(map, idx, 'Aldric');
    expect(n).toMatch(/within reach ≤15 ft: no one/);
    expect(n).toMatch(/in earshot ≤60 ft.*Hobb Fen \(20 ft\)/); // Hobb is a shout away
    expect(n).toMatch(/OUT OF SCENE >60 ft.*Tessa Reed/); // Tessa is out of scene (75 ft)
  });
  it('reports which building door the acting PC is standing at (disambiguates "the house I\'m in front of")', () => {
    const atForge: any = { ...map, objects: map.objects.map((o: any) => (o.id === 'pc:aldric' ? { ...o, col: 6, row: 10 } : o)) }; // 1 tile S of the forge door (6,9)
    const n = nearbyLine(atForge, idx, 'Aldric');
    expect(n).toMatch(/standing AT the door of the forge/);
    expect(n).toMatch(/bldg:forge/); // the concrete id so travel targets THIS building
    // far from any door → no door line
    expect(nearbyLine(map, idx, 'Aldric')).not.toMatch(/standing AT the door/);
  });
  it('flags an interior with no PC inside as UNSEEN (GM-knows, party-cannot-perceive) — the closed-door boundary', () => {
    const d = zoneDigest(map, idx, 'Aldric'); // Bram (NPC) is in the forge; no PC is inside it
    expect(d).toMatch(/the forge.*Bram.*UNSEEN by the party/s);
    // put a PC inside the forge → the party perceives it → no UNSEEN flag on that line
    const pcInside: any = { ...map, objects: map.objects.map((o: any) => (o.id === 'pc:aldric' ? { ...o, col: 6, row: 6 } : o)) };
    const forgeLine = zoneDigest(pcInside, idx, 'Aldric').split('\n').find((l) => /the forge/.test(l))!;
    expect(forgeLine).not.toMatch(/UNSEEN/);
  });
  it('arrivalZoneNote reports the post-move zone + earshot', () => {
    const note = arrivalZoneNote(map, idx, { id: 'pc:aldric', name: 'Aldric' }, { col: 6, row: 7 }); // step INTO the forge
    expect(note).toMatch(/Aldric is the forge/);
    expect(note).toMatch(/Bram/); // Bram is now within earshot
  });
});

describe('narrationBreaksScene — the deterministic coherence gate (P2)', () => {
  const brk = (t: string, pc = 'Aldric') => narrationBreaksScene(map, idx, t, pc);

  it('MEMBERSHIP: fires when an outdoor NPC is narrated at an interior station', () => {
    expect(brk('Hobb Fen looks up from the anvil, grunts.')?.code).toBe('membership');
    expect(brk('Hobb looks up from the anvil.')?.code).toBe('membership'); // first name only
    expect(brk('Hobb Fen watches from inside the forge.')?.code).toBe('membership');
  });
  it('MEMBERSHIP: does NOT fire when the NPC is actually inside', () => {
    expect(brk('Bram hammers at the anvil, sparks flying.')).toBeNull(); // Bram IS in the forge
  });
  it('EARSHOT: fires when a far NPC speaks to the acting PC', () => {
    expect(brk('Behind you, Tessa calls, "Tracks point to the road!"')?.code).toBe('earshot'); // Tessa 75 ft
    expect(brk('Tessa says, "Wait."')?.code).toBe('earshot');
  });
  it('EARSHOT: does NOT fire for a near speaker or a distant NON-speaker', () => {
    expect(brk('Hobb calls out a greeting from a few steps off.')).toBeNull(); // Hobb 20 ft — in earshot
    expect(brk('Across the green, Tessa Reed can be seen brushing dirt from her cuffs.')).toBeNull(); // visible, not speaking
  });
  it('does not flag clean, grounded prose', () => {
    expect(brk('Aldric kneels by the door, running a thumb over the cold latch.')).toBeNull();
  });
  it('MEMBERSHIP: does NOT false-fire on "in the <ambience> NEAR the <building>" (containment must sit on the noun)', () => {
    expect(brk('Hobb Fen waits in the gloom near the forge, arms folded.')).toBeNull(); // outdoors NEAR ≠ inside
    expect(brk('Hobb Fen slips into the forge without a word.')?.code).toBe('membership'); // real containment still fires
  });
});
