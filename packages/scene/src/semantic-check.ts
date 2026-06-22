/**
 * SEMANTIC invariants for built interiors — the SECOND deterministic, $0 gate, paired with the vision
 * judge. Where structure-check.ts proves a building is geometrically sound (watertight, reachable, 1-tile
 * walls), this proves it READS AS ITS TYPE: the focal piece exists, is prominent (on a wall with a clear
 * approach), and the required supporting furniture is present. Type-parameterized by a declarative
 * BuildingSpec, so a new type becomes "checkable" by declaring its contract — no per-building code.
 *
 * Mirrors structure-check.ts deliberately (pure read of a frozen SceneMap → per-defect-class integer
 * counters + clean + samples), so the sweep/test harness is identical and the two gates compose.
 *
 * Buildings are identified by the object `group` id ('bldg:<safe>-r<room>'); props are grouped per
 * building by stripping the room suffix. A type with no spec is vacuously clean (its station isn't built
 * yet) — specs are added as each type's focal station lands (Phase F: temple first).
 */

import type { SceneMap } from '@mythweaver/shared';

const INTERIOR_FLOOR = new Set(['wood_floor', 'stone', 'flagstone', 'stone_brick', 'floor']);
const isInteriorTile = (t: string): boolean => INTERIOR_FLOOR.has(t) || t.startsWith('carpet');
const isWallTile = (t: string): boolean => t.startsWith('wall');

/** The CHECKABLE contract for a building type (what must read as itself), NOT the recipe that builds it. */
export interface BuildingSemanticSpec {
  /** the type's centrepiece prop. A POINT focal (altar) must sit against a wall with a clear approach; a RUN
   *  focal (bar counter) must form a contiguous line — see focalRun. */
  focal: string;
  /** if set, the focal is a RUN: there must be a contiguous straight line of ≥ focalRun focal tiles (a bar,
   *  a service counter) — not a single prop. */
  focalRun?: number;
  /** required supporting furniture: at least `min` of `tag` per building (scaled later if needed). */
  seating?: { tag: string; min: number };
  /** a STATION partner that must sit near the focal (the anvil by the forge) — within Chebyshev `within`
   *  cells. When set, a point focal is "prominent" if it's wall-backed AND has its partner (instead of a
   *  clear approach — a workstation's front is occupied by its partner, not open floor). */
  nearFocal?: { tag: string; within: number };
  /** the keeper must be posted AT the focal (the barkeep behind the bar, the smith at the forge) — i.e.
   *  orthogonally adjacent to a focal cell, not marooned in the room centre. */
  keeperAtFocal?: boolean;
}

export const BUILDING_SEMANTICS: Record<string, BuildingSemanticSpec> = {
  // Temple is the Phase-F reference slice (its whole kit already exists as art).
  temple: { focal: 'altar', seating: { tag: 'stone_bench', min: 2 } },
  // Tavern: a continuous bar counter (run) is the focal; chairs are patron seating; the barkeep is AT the bar.
  tavern: { focal: 'bar_counter', focalRun: 3, seating: { tag: 'chair', min: 2 }, keeperAtFocal: true },
  // Smithy: a lit forge is the focal, the anvil its station partner; the smith is posted at the forge.
  smithy: { focal: 'forge', nearFocal: { tag: 'anvil', within: 2 }, keeperAtFocal: true },
  // Shop: a service counter (run) is the focal; display wares are the stock; the shopkeeper is at the counter.
  shop: { focal: 'bar_counter', focalRun: 2, seating: { tag: 'shelf_wares', min: 2 }, keeperAtFocal: true },
};

export interface SemanticReport {
  /** buildings evaluated (props grouped by building id). */
  buildings: number;
  /** the type's focal prop is absent from the building. */
  missingFocal: number;
  /** focal present but not prominent: not against a wall, or no clear (walkable interior) approach in front. */
  focalNotProminent: number;
  /** required supporting furniture below its minimum (e.g. a nave with too few pews). */
  understocked: number;
  /** the keeper exists but isn't posted at the focal (e.g. a barkeep marooned away from the bar). */
  keeperOffStation: number;
  /** True iff all defect counts are zero (vacuously true for a type with no spec). */
  clean: boolean;
  samples: { kind: string; col: number; row: number }[];
}

const N4 = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
] as const;

/** Deterministic semantic check of a frozen SceneMap for building type `type`. */
export function checkSemantics(map: SceneMap, type: string): SemanticReport {
  const rep: SemanticReport = { buildings: 0, missingFocal: 0, focalNotProminent: 0, understocked: 0, keeperOffStation: 0, clean: true, samples: [] };
  const spec = BUILDING_SEMANTICS[type];
  if (!spec) return rep; // no contract declared yet → vacuously clean

  const { cols, rows } = map.grid;
  const inb = (c: number, r: number) => c >= 0 && r >= 0 && c < cols && r < rows;
  const at = (c: number, r: number): string => (inb(c, r) ? map.tiles[r]![c]! : '');
  const wall = (c: number, r: number) => isWallTile(at(c, r));
  const interiorFloor = (c: number, r: number) => isInteriorTile(at(c, r));
  const walk = (c: number, r: number) => inb(c, r) && map.walkable[r]![c] === true;
  const sample = (kind: string, c: number, r: number) => { if (rep.samples.filter((s) => s.kind === kind).length < 3) rep.samples.push({ kind, col: c, row: r }); };

  // Group PROPS by building (the group id minus its '-r<room>' suffix).
  const byBldg = new Map<string, { tag: string; col: number; row: number }[]>();
  for (const o of map.objects) {
    if (o.kind !== 'prop') continue;
    const id = (o.group ?? '').replace(/-r\d+$/, '') || (o.group ?? '?');
    (byBldg.get(id) ?? byBldg.set(id, []).get(id)!).push({ tag: o.tag, col: o.col, row: o.row });
  }
  // Keeper actor per building (id 'npc:<safe>-r<room>-keeper') → keyed to match the prop group 'bldg:<safe>'.
  const keeperByBldg = new Map<string, { col: number; row: number }>();
  for (const o of map.objects) {
    if (o.kind !== 'actor') continue;
    const m = /^npc:(.+)-r\d+-keeper$/.exec(o.id ?? '');
    if (m) keeperByBldg.set(`bldg:${m[1]}`, { col: o.col, row: o.row });
  }

  // Bounding-box of the interior-floor room containing (c,r) — to scale a focal requirement to room size
  // (graceful degradation: a tiny room can only host a short bar, so don't demand a 3-run it can't fit).
  const roomSpan = (c0: number, r0: number): number => {
    const seen = new Set([`${c0},${r0}`]); const st: [number, number][] = [[c0, r0]];
    let minc = c0, maxc = c0, minr = r0, maxr = r0;
    while (st.length) {
      const [c, r] = st.pop()!; minc = Math.min(minc, c); maxc = Math.max(maxc, c); minr = Math.min(minr, r); maxr = Math.max(maxr, r);
      for (const [dc, dr] of N4) { const nc = c + dc, nr = r + dr, k = `${nc},${nr}`; if (!seen.has(k) && interiorFloor(nc, nr)) { seen.add(k); st.push([nc, nr]); } }
    }
    return Math.max(maxc - minc + 1, maxr - minr + 1); // the room's longest interior dimension = its longest wall
  };

  // Longest contiguous straight run (horizontal or vertical) among a set of cells — for a RUN focal (a bar).
  const longestRun = (cells: { col: number; row: number }[]): number => {
    const set = new Set(cells.map((p) => `${p.col},${p.row}`));
    let best = 0;
    for (const p of cells) {
      if (!set.has(`${p.col - 1},${p.row}`)) { let n = 0, c = p.col; while (set.has(`${c},${p.row}`)) { n++; c++; } best = Math.max(best, n); }
      if (!set.has(`${p.col},${p.row - 1}`)) { let n = 0, r = p.row; while (set.has(`${p.col},${r}`)) { n++; r++; } best = Math.max(best, n); }
    }
    return best;
  };

  for (const [bldgKey, props] of byBldg) {
    rep.buildings++;
    const focals = props.filter((p) => p.tag === spec.focal);
    if (focals.length === 0) { rep.missingFocal++; continue; }
    const focal = focals[0]!;
    if (spec.focalRun) {
      // RUN focal (bar counter): a contiguous line against a wall, ≥ focalRun — but never longer than the room
      // can hold (a tiny room legitimately gets a shorter bar; the station already places the longest run).
      const wallBacked = focals.some((f) => N4.some(([dc, dr]) => wall(f.col + dc, f.row + dr)));
      const need = Math.min(spec.focalRun, roomSpan(focal.col, focal.row));
      if (longestRun(focals) < need || !wallBacked) { rep.focalNotProminent++; sample('focalrun', focal.col, focal.row); }
    } else {
      // POINT focal: sits against a wall, AND — for a STATION (nearFocal) — has its partner nearby (the anvil
      // by the forge); otherwise (a lone focal like an altar) has a clear walkable approach in front.
      const onWall = N4.some(([dc, dr]) => wall(focal.col + dc, focal.row + dr));
      const stationOk = spec.nearFocal
        ? props.some((p) => p.tag === spec.nearFocal!.tag && Math.abs(p.col - focal.col) <= spec.nearFocal!.within && Math.abs(p.row - focal.row) <= spec.nearFocal!.within)
        : N4.some(([dc, dr]) => interiorFloor(focal.col + dc, focal.row + dr) && walk(focal.col + dc, focal.row + dr));
      if (!onWall || !stationOk) { rep.focalNotProminent++; sample('focal', focal.col, focal.row); }
    }
    if (spec.seating) {
      const n = props.filter((p) => p.tag === spec.seating!.tag).length;
      if (n < spec.seating.min) { rep.understocked++; sample('seating', focal.col, focal.row); }
    }
    if (spec.keeperAtFocal) {
      const k = keeperByBldg.get(bldgKey);
      if (k && !N4.some(([dc, dr]) => focals.some((f) => f.col === k.col + dc && f.row === k.row + dr))) { rep.keeperOffStation++; sample('keeper', k.col, k.row); }
    }
  }

  rep.clean = rep.missingFocal === 0 && rep.focalNotProminent === 0 && rep.understocked === 0 && rep.keeperOffStation === 0;
  return rep;
}
