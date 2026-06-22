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
  /** the type's centrepiece prop — must exist, sit against a wall, and have a clear approach in front. */
  focal: string;
  /** required supporting furniture: at least `min` of `tag` per building (scaled later if needed). */
  seating?: { tag: string; min: number };
}

export const BUILDING_SEMANTICS: Record<string, BuildingSemanticSpec> = {
  // Temple is the Phase-F reference slice (its whole kit already exists as art).
  temple: { focal: 'altar', seating: { tag: 'stone_bench', min: 2 } },
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
  const rep: SemanticReport = { buildings: 0, missingFocal: 0, focalNotProminent: 0, understocked: 0, clean: true, samples: [] };
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

  for (const [, props] of byBldg) {
    rep.buildings++;
    const focal = props.find((p) => p.tag === spec.focal);
    if (!focal) { rep.missingFocal++; continue; }
    // Prominence: the focal sits against a wall AND a walkable interior-floor cell is adjacent (its approach).
    const onWall = N4.some(([dc, dr]) => wall(focal.col + dc, focal.row + dr));
    const hasApproach = N4.some(([dc, dr]) => interiorFloor(focal.col + dc, focal.row + dr) && walk(focal.col + dc, focal.row + dr));
    if (!onWall || !hasApproach) { rep.focalNotProminent++; sample('focal', focal.col, focal.row); }
    if (spec.seating) {
      const n = props.filter((p) => p.tag === spec.seating!.tag).length;
      if (n < spec.seating.min) { rep.understocked++; sample('seating', focal.col, focal.row); }
    }
  }

  rep.clean = rep.missingFocal === 0 && rep.focalNotProminent === 0 && rep.understocked === 0;
  return rep;
}
