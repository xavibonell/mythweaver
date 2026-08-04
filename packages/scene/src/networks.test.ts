import { describe, expect, it } from 'vitest';
import { validateSceneMap } from '@mythweaver/shared';
import { runProgram, type SceneProgram } from './scene-program.js';

// The LOOM (Weave L1): a canal is the town's street-seam engine with a water material profile. These gates
// prove the general claim holds — a water feature realizes as a valid, connected, deterministic scene, and
// stays opt-in (street = profile #1 is unchanged; the byte-identity of that refactor is proven separately
// in the R1 harness). The canal severing the town without bridges would be the signature bug — hence the
// cross-canal reachability assertion.

const townProg = (seed: number, canal: boolean): SceneProgram => ({
  locationId: `loc:net-${seed}`, cols: 70, rows: 50, seed, biome: 'village', lighting: 'day', grammar: 'town-square', outdoor: true, theme: 'village',
  ops: [{ op: 'archetype', kind: 'town', contents: { buildings: [{ type: 'temple' }, { type: 'shop' }, { type: 'tavern' }, { type: 'house' }, { type: 'house' }, { type: 'house' }], landmarks: [{ tag: 'shrine' }], npcs: [{ tag: 'villager' }], mobs: [], wall: true, canal } }] });

const waterTiles = (m: ReturnType<typeof runProgram>) => m.tiles.flat().filter((t) => t.startsWith('water')).length;

/** Every building door reachable on the walkable grid from a single seed → both canal banks are connected. */
function allDoorsReachable(m: ReturnType<typeof runProgram>): boolean {
  const { cols, rows } = m.grid, w = m.walkable;
  let start: [number, number] | null = null;
  for (let r = 0; r < rows && !start; r++) for (let c = 0; c < cols && !start; c++) if (w[r]![c]) start = [c, r];
  if (!start) return false;
  const seen = new Set([`${start[0]},${start[1]}`]); const q = [start];
  while (q.length) { const [c, r] = q.pop()!; for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) { const nc = c + dc, nr = r + dr; if (nc >= 0 && nr >= 0 && nc < cols && nr < rows && w[nr]![nc] && !seen.has(`${nc},${nr}`)) { seen.add(`${nc},${nr}`); q.push([nc, nr]); } } }
  return m.entrances.filter((e) => e.fixtureId?.startsWith('bldg:')).every((e) => seen.has(`${e.col},${e.row}`));
}

describe('networks — canal is data over the seam engine (Weave L1)', () => {
  it('a canal town is a valid SceneMap with real water, deterministically', () => {
    for (const seed of [3, 7, 11, 19]) {
      const m = runProgram(townProg(seed, true));
      expect(validateSceneMap(m), `seed ${seed}`).toEqual({ ok: true, violations: [] });
      expect(waterTiles(m), `seed ${seed}: canal water`).toBeGreaterThan(20);
      expect(JSON.stringify(m)).toBe(JSON.stringify(runProgram(townProg(seed, true)))); // deterministic
    }
  });

  it('bridges reconnect the banks — every building door reachable across the canal', () => {
    for (const seed of [3, 7, 11, 19, 23]) expect(allDoorsReachable(runProgram(townProg(seed, true))), `seed ${seed}`).toBe(true);
  });

  it('is OPT-IN — a plain town has no water (street profile unchanged)', () => {
    for (const seed of [3, 7, 11]) expect(waterTiles(runProgram(townProg(seed, false))), `seed ${seed}`).toBe(0);
  });
});
