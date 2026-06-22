/**
 * STRUCTURAL invariants for built interiors (the deterministic, $0, exhaustive inner loop that pairs
 * with the visual judge). Given a frozen SceneMap, these check the wall/door/floor GEOMETRY for the
 * exact defect classes the judge flagged on building:house — but over the whole seed space, instantly.
 *
 * A clean building satisfies all four = 0:
 *   leakedInterior   interior floor reachable from OUTSIDE without crossing a wall or a door
 *                    → an un-framed hole in the boundary (the "door/hole onto grass" defect).
 *   unreachable      interior floor NOT reachable from any door/entrance → a sealed-off room.
 *   freestandingWall wall cells in a connected component that borders NO interior floor
 *                    → orphan stubs / floating fragments / a fence-ledge that encloses nothing.
 *   badDoor          a door_house with no interior inside (or no opening outside), or an arch that
 *                    does not sit between two interior cells → a door to a wall / to nowhere.
 *
 * Global (not per-building): walls/doors/floor are read straight off the map, so it needs no footprint
 * segmentation and generalises to any built scene.
 */

import type { SceneMap } from '@mythweaver/shared';

const INTERIOR_FLOOR = new Set(['wood_floor', 'stone', 'flagstone', 'stone_brick', 'floor']);
const isInteriorTile = (t: string): boolean => INTERIOR_FLOOR.has(t) || t.startsWith('carpet');
const isWallTile = (t: string): boolean => t.startsWith('wall');
// Everything else walkable-ish (grass/dirt/cobblestone/sand/water/road…) reads as OPEN/exterior.

export interface StructureReport {
  leakedInterior: number;
  unreachable: number;
  freestandingWall: number;
  badDoor: number;
  /** Wall cells with NO interior floor in their 8-neighbourhood — a redundant cell of a 2-tile-thick wall
   *  (the staircase/jog symptom). A clean ring is exactly 1 tile thick, so this should be 0 for any shape. */
  wallJog: number;
  /** A door/arch/entrance whose interior approach cell is blocked by furniture (not walkable) — the building
   *  isn't TRAVERSABLE through that doorway. The ONE furniture-aware check (the rest are furniture-agnostic):
   *  a character must always be able to step through every door. Should be 0 for any building. */
  doorBlocked: number;
  /** True iff all are zero. */
  clean: boolean;
  /** A few example cells per violation, for eyeballing a failing seed. */
  samples: { kind: string; col: number; row: number }[];
}

const N4 = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
] as const;
const N8 = [...N4, [1, -1], [1, 1], [-1, 1], [-1, -1]] as const;

export function checkStructure(map: SceneMap): StructureReport {
  const { cols, rows } = map.grid;
  const t = map.tiles;
  const w = map.walkable;
  const inb = (c: number, r: number) => c >= 0 && r >= 0 && c < cols && r < rows;
  const at = (c: number, r: number): string => (inb(c, r) ? t[r]![c]! : '');
  const walk = (c: number, r: number) => inb(c, r) && w[r]![c] === true; // a fence/wall/blocker is NOT walkable, even on a grass tile
  const wall = (c: number, r: number) => isWallTile(at(c, r));
  const interior = (c: number, r: number) => isInteriorTile(at(c, r)); // an interior-FLOOR tile (may be furniture-blocked)
  const open = (c: number, r: number) => walk(c, r) && !interior(c, r); // walkable exterior/yard ground

  // Door cells (door_house = exterior, arch = interior connector) come from ambiance.
  const doorSet = new Set<string>();
  for (const a of map.ambiance) if (a.tag === 'door_house' || a.tag === 'arch') doorSet.add(`${a.col},${a.row}`);
  for (const e of map.entrances) doorSet.add(`${e.col},${e.row}`);
  const isDoor = (c: number, r: number) => doorSet.has(`${c},${r}`);

  const samples: { kind: string; col: number; row: number }[] = [];
  const sample = (kind: string, c: number, r: number) => { if (samples.filter((s) => s.kind === kind).length < 3) samples.push({ kind, col: c, row: r }); };

  // ── leakedInterior: BFS the EXTERIOR ground (walkable, non-interior, non-door) from the border, with
  //    walls + fences (non-walkable) + doors as barriers. Then count interior-floor tiles that sit
  //    directly against that reachable exterior — i.e. a gap in the boundary with no door = a hole.
  //    Furniture-agnostic: we count gap MOUTHS (the exposed interior tiles), not whole flooded rooms.
  const isExt = (c: number, r: number) => walk(c, r) && !interior(c, r) && !isDoor(c, r);
  const seenExt = Array.from({ length: rows }, () => new Array<boolean>(cols).fill(false));
  const queue: [number, number][] = [];
  for (let c = 0; c < cols; c++) { for (const r of [0, rows - 1]) if (isExt(c, r) && !seenExt[r]![c]) { seenExt[r]![c] = true; queue.push([c, r]); } }
  for (let r = 0; r < rows; r++) { for (const c of [0, cols - 1]) if (isExt(c, r) && !seenExt[r]![c]) { seenExt[r]![c] = true; queue.push([c, r]); } }
  while (queue.length) {
    const [c, r] = queue.shift()!;
    for (const [dc, dr] of N4) { const nc = c + dc, nr = r + dr; if (isExt(nc, nr) && !seenExt[nr]![nc]) { seenExt[nr]![nc] = true; queue.push([nc, nr]); } }
  }
  let leakedInterior = 0;
  const leaked = Array.from({ length: rows }, () => new Array<boolean>(cols).fill(false));
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      if (seenExt[r]![c]) for (const [dc, dr] of N4) { const nc = c + dc, nr = r + dr; if (inb(nc, nr) && interior(nc, nr) && !isDoor(nc, nr) && !leaked[nr]![nc]) { leaked[nr]![nc] = true; leakedInterior++; sample('leak', nc, nr); } }

  // ── unreachable: floor-PLAN connectivity (furniture-agnostic). BFS over interior-floor TILES ∪ doors
  //    from every door/entrance. An interior region not reached = a genuinely sealed-off room. Movable
  //    furniture sits ON interior floor, so we pass through it — this is about walls/doors, not props.
  let totalInterior = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (interior(c, r)) totalInterior++;
  const seenReach = Array.from({ length: rows }, () => new Array<boolean>(cols).fill(false));
  const q2: [number, number][] = [];
  // Pass through interior floor (furniture-agnostic), doors, AND enclosed walkable yards (a courtyard is
  // walkable grass inside the envelope → a valid path to a room off it) — but NOT the exterior street
  // (border-reachable open, `seenExt`), or every building would connect to every other through the street.
  const passI = (c: number, r: number) => inb(c, r) && (interior(c, r) || isDoor(c, r) || (walk(c, r) && !seenExt[r]![c]));
  for (const key of doorSet) { const [c, r] = key.split(',').map(Number) as [number, number]; if (passI(c, r) && !seenReach[r]![c]) { seenReach[r]![c] = true; q2.push([c, r]); } }
  let reachedInterior = 0;
  while (q2.length) {
    const [c, r] = q2.shift()!;
    if (interior(c, r)) reachedInterior++;
    for (const [dc, dr] of N4) { const nc = c + dc, nr = r + dr; if (passI(nc, nr) && !seenReach[nr]![nc]) { seenReach[nr]![nc] = true; q2.push([nc, nr]); } }
  }
  const unreachable = Math.max(0, totalInterior - reachedInterior);
  if (unreachable > 0) for (let r = 0; r < rows && samples.filter((s) => s.kind === 'sealed').length < 3; r++) for (let c = 0; c < cols; c++) if (interior(c, r) && !seenReach[r]![c]) sample('sealed', c, r);

  // ── freestandingWall: 8-connected wall components that border NO interior floor enclose nothing.
  const seenWall = Array.from({ length: rows }, () => new Array<boolean>(cols).fill(false));
  let freestandingWall = 0;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      if (!wall(c, r) || seenWall[r]![c]) continue;
      const comp: [number, number][] = [[c, r]];
      seenWall[r]![c] = true;
      let bordersInterior = false;
      for (let i = 0; i < comp.length; i++) {
        const [cc, cr] = comp[i]!;
        for (const [dc, dr] of N4) if (interior(cc + dc, cr + dr)) bordersInterior = true;
        for (const [dc, dr] of N8) { const nc = cc + dc, nr = cr + dr; if (wall(nc, nr) && !seenWall[nr]![nc]) { seenWall[nr]![nc] = true; comp.push([nc, nr]); } }
      }
      if (!bordersInterior) { freestandingWall += comp.length; sample('freewall', c, r); }
    }

  // ── badDoor: door_house needs interior on one side + an opening on the other; arch needs interior both ways.
  let badDoor = 0;
  for (const a of map.ambiance) {
    if (a.tag !== 'door_house' && a.tag !== 'arch') continue;
    const c = a.col, r = a.row;
    const interiorN = N4.filter(([dc, dr]) => interior(c + dc, r + dr)).length;
    if (a.tag === 'arch') {
      // a connector must join two PASSABLE spaces on opposite sides — interior floor OR walkable ground
      // (a room↔garden gate is valid: one side is the courtyard's walkable grass, not interior floor).
      const psbl = (cc: number, rr: number) => interior(cc, rr) || (walk(cc, rr) && !wall(cc, rr));
      const ns = psbl(c, r - 1) && psbl(c, r + 1);
      const ew = psbl(c - 1, r) && psbl(c + 1, r);
      if (!ns && !ew) { badDoor++; sample('baddoor', c, r); }
    } else {
      const openN = N4.filter(([dc, dr]) => open(c + dc, r + dr) || c + dc < 0 || r + dr < 0 || c + dc >= cols || r + dr >= rows).length;
      if (interiorN < 1 || openN < 1) { badDoor++; sample('baddoor', c, r); }
    }
  }

  // ── wallJog: the KEYSTONE — every wall cell must touch interior floor within its 8-neighbourhood. A
  //    clean ring is exactly 1 tile thick: a ring/partition cell borders interior (N4) and a corner borders
  //    it diagonally (N8). The redundant outer cell of a 2-thick wall (a staircase/jog) touches none → flagged.
  let wallJog = 0;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      if (!wall(c, r)) continue;
      if (!N8.some(([dc, dr]) => interior(c + dc, r + dr))) { wallJog++; sample('jog', c, r); }
    }

  // ── doorBlocked: every door/arch/entrance must be STEPPABLE — its interior approach cell(s) must be
  //    WALKABLE (no furniture on the threshold). Furniture-AWARE, unlike `unreachable` above: a character
  //    must be able to pass through every doorway, so a building is genuinely traversable.
  let doorBlocked = 0;
  const doorCells = new Set<string>(doorSet);
  for (const key of doorCells) {
    const [c, r] = key.split(',').map(Number) as [number, number];
    const approaches = N4.map(([dc, dr]) => [c + dc, r + dr] as [number, number]).filter(([nc, nr]) => interior(nc, nr));
    if (approaches.length === 0) continue; // a door with no interior side is a badDoor, not a block
    if (approaches.some(([nc, nr]) => !walk(nc, nr))) { doorBlocked++; sample('doorblock', c, r); }
  }

  const clean = leakedInterior === 0 && unreachable === 0 && freestandingWall === 0 && badDoor === 0 && wallJog === 0 && doorBlocked === 0;
  return { leakedInterior, unreachable, freestandingWall, badDoor, wallJog, doorBlocked, clean, samples };
}
