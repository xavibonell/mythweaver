import { describe, expect, it } from 'vitest';
import type { SceneMap } from '@mythweaver/shared';
import { checkCoherence } from './coherence-check.js';

// Synthetic-map probes: each case hand-builds the EXACT geometry of an anchor incoherence class
// (the owner's screenshots) and asserts the claims-blind probe fires — and stays quiet on the sane
// variant. Ground-truth only (tiles/walkable/objects/entrances), mirroring structure-check's style.

/** A grass field with a road column at c=10, and a 5×5 building (walls + wood_floor) with a south door. */
function mk(): SceneMap {
  const cols = 12, rows = 12;
  const tiles = Array.from({ length: rows }, () => new Array<string>(cols).fill('grass'));
  const walkable = Array.from({ length: rows }, () => new Array<boolean>(cols).fill(true));
  for (let r = 0; r < rows; r++) { tiles[r]![10] = 'road'; }
  // building bbox (2,2)-(6,6): wall ring, wood_floor interior, door at (4,6) on the south wall
  for (let r = 2; r <= 6; r++) for (let c = 2; c <= 6; c++) {
    const ring = r === 2 || r === 6 || c === 2 || c === 6;
    tiles[r]![c] = ring ? 'wall_wood' : 'wood_floor';
    walkable[r]![c] = !ring;
  }
  tiles[6]![4] = 'wood_floor'; walkable[6]![4] = true; // the door cell (walkable gap in the ring)
  return {
    locationId: 'loc:coherence-test', seed: 1, biome: 'village', lighting: 'day', grammar: 'town-square',
    grid: { cols, rows, feetPerTile: 5 }, tiles, walkable, objects: [],
    ambiance: [{ tag: 'door_house', col: 4, row: 6 }],
    entrances: [{ toLocationId: 'loc:coherence-test', col: 4, row: 6, fixtureId: 'bldg:test-0' }],
  };
}

describe('coherence probes — doorApproachBlocked (the fountain-in-the-doorway class)', () => {
  it('is quiet when the door apron is open to the world', () => {
    const rep = checkCoherence(mk());
    expect(rep.doorApproachBlocked).toBe(0);
    expect(rep.doors).toBe(1);
    expect(rep.clean).toBe(true);
  });

  it('fires when a blocking prop sits on the only apron cell', () => {
    const m = mk();
    m.walkable[7]![4] = false; // the fountain: blocks the sole exterior approach at (4,7)
    m.objects.push({ id: 'prop:f', kind: 'prop', tag: 'fountain', col: 4, row: 7, footprint: { w: 1, h: 1 }, visible: true });
    const rep = checkCoherence(m);
    expect(rep.doorApproachBlocked).toBe(1);
    expect(rep.clean).toBe(false);
    expect(rep.samples.some((s) => s.kind === 'doorapproach')).toBe(true);
  });

  it('tracks doorStreetFar as a metric without failing clean', () => {
    const m = mk();
    for (let r = 0; r < 12; r++) m.tiles[r]![10] = 'grass'; // remove the road entirely
    const rep = checkCoherence(m);
    expect(rep.doorStreetFar).toBe(1);
    expect(rep.clean).toBe(true); // metric, not a gate
  });
});

describe('coherence probes — bedByBar (the beds-next-to-the-bar class)', () => {
  const obj = (id: string, tag: string, col: number, row: number, group: string) =>
    ({ id, kind: 'prop' as const, tag, col, row, footprint: { w: 1, h: 1 }, visible: true, group });

  it('fires on a bed within reach of the same building\'s bar counter', () => {
    const m = mk();
    m.objects.push(obj('prop:bar', 'bar_counter', 3, 3, 'bldg:test-0-r0'), obj('prop:bed', 'bed', 5, 4, 'bldg:test-0-r1'));
    const rep = checkCoherence(m);
    expect(rep.bedByBar).toBe(1);
    expect(rep.clean).toBe(false);
  });

  it('is quiet when the bed is far from the bar, or in a different building', () => {
    const far = mk();
    far.objects.push(obj('prop:bar', 'bar_counter', 3, 3, 'bldg:test-0-r0'), obj('prop:bed', 'bed', 9, 9, 'bldg:test-0-r1'));
    expect(checkCoherence(far).bedByBar).toBe(0);
    const other = mk();
    other.objects.push(obj('prop:bar', 'bar_counter', 3, 3, 'bldg:test-0-r0'), obj('prop:bed', 'bed', 5, 4, 'bldg:other-1-r0'));
    expect(checkCoherence(other).bedByBar).toBe(0);
  });
});
