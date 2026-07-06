import { describe, expect, it } from 'vitest';
import { type SceneMap, validateSceneMap } from '@mythweaver/shared';
import { GOLD_PROGRAMS, buildSpikeScene, runProgram } from './scene-program.js';

/** BFS the walkable graph from the same start reachabilityCarve uses (no PC here → bottom-left
 *  walkable cell) → the set of reachable flat indices. Proves connectivity-by-construction. */
function reachableSet(m: SceneMap): Set<number> {
  const { cols, rows } = m.grid;
  const idx = (c: number, r: number) => r * cols + c;
  let start: { c: number; r: number } | null = null;
  for (let r = rows - 1; r >= 0 && !start; r--) for (let c = 0; c < cols && !start; c++) if (m.walkable[r]![c]) start = { c, r };
  const seen = new Set<number>();
  if (!start) return seen;
  const q = [start];
  seen.add(idx(start.c, start.r));
  const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  while (q.length) {
    const cur = q.shift()!;
    for (const [dx, dy] of ORTH) {
      const cc = cur.c + dx, rr = cur.r + dy;
      if (cc >= 0 && cc < cols && rr >= 0 && rr < rows && m.walkable[rr]![cc] && !seen.has(idx(cc, rr))) { seen.add(idx(cc, rr)); q.push({ c: cc, r: rr }); }
    }
  }
  return seen;
}

const tileCount = (m: SceneMap, pred: (t: string) => boolean) => m.tiles.flat().filter(pred).length;

describe('scene program (G1 spike) — diverse scenes from ONE primitive vocabulary', () => {
  const names = Object.keys(GOLD_PROGRAMS);

  it.each(names)('"%s" is a valid SceneMap by construction', (name) => {
    expect(validateSceneMap(buildSpikeScene(name))).toEqual({ ok: true, violations: [] });
  });

  it.each(names)('"%s" connects every actor + entrance into one reachable component', (name) => {
    const m = buildSpikeScene(name);
    const reach = reachableSet(m);
    const idx = (c: number, r: number) => r * m.grid.cols + c;
    for (const o of m.objects) if (o.kind === 'actor') expect(reach.has(idx(o.col, o.row))).toBe(true);
    for (const e of m.entrances) expect(reach.has(idx(e.col, e.row))).toBe(true);
  });

  it.each(names)('"%s" is deterministic (same program → byte-identical map)', (name) => {
    expect(JSON.stringify(buildSpikeScene(name))).toBe(JSON.stringify(buildSpikeScene(name)));
  });

  // --- the point of the spike: the SAME system expresses STRUCTURALLY DIFFERENT scenes ---

  it('labyrinth is mostly walls with grass corridors + a central fountain + monsters', () => {
    const m = buildSpikeScene('labyrinth');
    expect(tileCount(m, (t) => t.startsWith('wall'))).toBeGreaterThan(m.grid.cols * m.grid.rows * 0.2); // a real maze
    expect(m.objects.some((o) => o.tag === 'fountain')).toBe(true);
    expect(m.objects.filter((o) => o.role === 'mob').length).toBeGreaterThan(5); // skeletons + goblins
    expect(m.entrances.length).toBeGreaterThan(0);
  });

  it('waterfall-lake is mostly water with grass islands joined by wood bridges', () => {
    const m = buildSpikeScene('lake');
    expect(tileCount(m, (t) => t.startsWith('water'))).toBeGreaterThan(m.grid.cols * m.grid.rows * 0.3);
    expect(tileCount(m, (t) => t === 'wood_floor')).toBeGreaterThan(8); // the bridges
    expect(tileCount(m, (t) => t.startsWith('grass'))).toBeGreaterThan(20); // the islands (grass + autotiled edges)
  });

  it('market-city has a stone plaza + fountain wrapped in a walled ring', () => {
    const m = buildSpikeScene('city');
    expect(tileCount(m, (t) => t === 'stone')).toBeGreaterThan(20); // the plaza
    expect(m.objects.some((o) => o.tag === 'fountain')).toBe(true);
    // outer wall ring: top row is all wall except its single gate
    const topWall = m.tiles[0]!.filter((t) => t.startsWith('wall')).length;
    expect(topWall).toBeGreaterThan(m.grid.cols - 3);
    expect(m.objects.filter((o) => o.role === 'npc').length).toBeGreaterThan(3); // townsfolk
  });

  it('crypt is a walled interior (NO grass/water) of stone rooms with a sarcophagus', () => {
    const m = buildSpikeScene('crypt');
    expect(tileCount(m, (t) => t.startsWith('grass') || t.startsWith('water'))).toBe(0); // interior
    expect(tileCount(m, (t) => t === 'flagstone' || t === 'stone')).toBeGreaterThan(20); // stone room floors
    expect(m.objects.some((o) => o.tag === 'sarcophagus')).toBe(true);
  });

  it('the gold scenes are genuinely different (tile composition + object/ambiance mix)', () => {
    // grammar + terrain flags + wall density distinguish most; town vs city share "walled village" on
    // those, so also bucket OBJECT + AMBIANCE counts — the organic furnished town (many furniture +
    // dense two-texture greenery) is a different beast from the bare-room grid city even when both walled.
    const sig = (name: string) => {
      const m = buildSpikeScene(name);
      return [
        m.grammar,
        `water:${tileCount(m, (t) => t.startsWith('water')) > 0}`,
        `grass:${tileCount(m, (t) => t.startsWith('grass')) > 0}`,
        `wallpct:${Math.round((tileCount(m, (t) => t.startsWith('wall')) / (m.grid.cols * m.grid.rows)) * 10)}`,
        `obj:${Math.round(m.objects.length / 12)}`,
        `amb:${Math.round(m.ambiance.length / 20)}`,
      ].join('|');
    };
    const sigs = Object.keys(GOLD_PROGRAMS).map(sig);
    expect(new Set(sigs).size).toBe(sigs.length); // all distinct
  });

  it('exposes the program as plain data (the shape an LLM will emit)', () => {
    expect(Array.isArray(GOLD_PROGRAMS.labyrinth!.ops)).toBe(true);
    expect(GOLD_PROGRAMS.labyrinth!.ops[0]!.op).toBe('maze');
    expect(runProgram(GOLD_PROGRAMS.lake!).grammar).toBe('open-outdoor');
  });
});
