/**
 * SCENE-COHERENCE probes (P0 of the coherence strategy — the falsifier). Deterministic, $0, and
 * CLAIMS-BLIND BY DESIGN: these read only the frozen SceneMap ground truth (tiles/walkable/objects/
 * entrances/ambiance) so they stay an INDEPENDENT net under any future claims/contract layer — the
 * fence and the net must never share eyes.
 *
 * Two anchor probes (the owner's screenshot classes), plus one tracked metric:
 *   doorApproachBlocked  a building's door with NO usable outside approach — no orthogonal neighbour
 *                        that is walkable AND reachable from the map border. The "fountain parked in
 *                        front of the only entrance" class: the sole apron cell is prop-blocked, so
 *                        the door (and the whole interior behind it) is unreachable from the world.
 *   bedByBar             a bed within Chebyshev BEDBAR_DIST of a bar_counter in the SAME building —
 *                        private furniture bleeding into the public serving area (beds-next-to-the-
 *                        bar in an inn). Same-building = the `bldg:` object group sans room suffix.
 *   doorStreetFar        TRACKED METRIC, not gated: a reachable door whose nearest PAVED tile
 *                        (road/flagstone/cobblestone) is farther than STREET_REACH walkable steps.
 *                        Legitimately non-zero for countryside farmsteads — reported for signal only.
 *
 * `clean` gates on the two anchor probes. Pairs with structure-check (interiors) / semantic-check
 * (stations); this is the SCENE axis of the same seed-sweep crank.
 */

import type { SceneMap } from '@mythweaver/shared';

/** Walkable steps within which a bed standing near a bar counter (same open space) reads as incoherent. */
const BEDBAR_DIST = 3;
/** Walkable steps from a door's approach to the nearest paved tile before we call it street-far. */
const STREET_REACH = 18;

const isPaved = (t: string): boolean => t.startsWith('road') || t.startsWith('flagstone') || t.startsWith('cobblestone');

export interface CoherenceReport {
  /** Building doors with zero border-reachable walkable orthogonal neighbours (unusable from outside). */
  doorApproachBlocked: number;
  /** Beds within BEDBAR_DIST (Chebyshev) of a bar_counter in the same building. */
  bedByBar: number;
  /** Doors whose nearest paved tile is > STREET_REACH steps away (tracked, NOT gated — farms are far). */
  doorStreetFar: number;
  /** Building doors examined (entrances with a bldg: fixture). */
  doors: number;
  /** True iff both GATED probes are zero (doorStreetFar is a metric, not a gate). */
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

export function checkCoherence(map: SceneMap): CoherenceReport {
  const { cols, rows } = map.grid;
  const w = map.walkable;
  const t = map.tiles;
  const inb = (c: number, r: number) => c >= 0 && r >= 0 && c < cols && r < rows;
  const walk = (c: number, r: number) => inb(c, r) && w[r]![c] === true;

  const samples: { kind: string; col: number; row: number }[] = [];
  const sample = (kind: string, c: number, r: number) => { if (samples.filter((s) => s.kind === kind).length < 3) samples.push({ kind, col: c, row: r }); };

  // ── Border-reachability flood: every walkable cell reachable from the map edge (flows through open
  //    doors into interiors — so a door whose sole apron is prop-blocked strands its whole interior).
  const reach = Array.from({ length: rows }, () => new Array<boolean>(cols).fill(false));
  const q: [number, number][] = [];
  for (let c = 0; c < cols; c++) for (const r of [0, rows - 1]) if (walk(c, r) && !reach[r]![c]) { reach[r]![c] = true; q.push([c, r]); }
  for (let r = 0; r < rows; r++) for (const c of [0, cols - 1]) if (walk(c, r) && !reach[r]![c]) { reach[r]![c] = true; q.push([c, r]); }
  while (q.length) {
    const [c, r] = q.pop()!;
    for (const [dc, dr] of N4) { const nc = c + dc, nr = r + dr; if (walk(nc, nr) && !reach[nr]![nc]) { reach[nr]![nc] = true; q.push([nc, nr]); } }
  }

  // ── Paved-distance field: multi-source BFS from every paved tile over walkable cells.
  const dist = Array.from({ length: rows }, () => new Array<number>(cols).fill(Infinity));
  let q2: [number, number][] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (isPaved(t[r]![c]!) && walk(c, r)) { dist[r]![c] = 0; q2.push([c, r]); }
  while (q2.length) {
    const next: [number, number][] = [];
    for (const [c, r] of q2) for (const [dc, dr] of N4) {
      const nc = c + dc, nr = r + dr;
      if (walk(nc, nr) && dist[nr]![nc] === Infinity) { dist[nr]![nc] = dist[r]![c]! + 1; next.push([nc, nr]); }
    }
    q2 = next;
  }

  // ── doorApproachBlocked + doorStreetFar over every building door.
  let doorApproachBlocked = 0, doorStreetFar = 0, doors = 0;
  for (const e of map.entrances) {
    if (!e.fixtureId?.startsWith('bldg:')) continue; // town gates etc. are not building doors
    doors++;
    const approaches = N4.map(([dc, dr]) => [e.col + dc, e.row + dr] as const).filter(([c, r]) => walk(c, r) && reach[r]![c]);
    if (!approaches.length) { doorApproachBlocked++; sample('doorapproach', e.col, e.row); continue; }
    const best = Math.min(...approaches.map(([c, r]) => dist[r]![c]!));
    if (best > STREET_REACH) { doorStreetFar++; sample('streetfar', e.col, e.row); }
  }

  // ── bedByBar: private sleeping furniture within arm's reach of the public serving counter IN THE SAME
  //    SPACE — WALKABLE proximity, not through-wall distance (a guest room legitimately sharing a solid
  //    wall with the taproom is fine; a bed standing beside the bar is not). BFS over walkable cells from
  //    the bed's neighbours; fail if within BEDBAR_DIST steps we stand adjacent to a same-building bar.
  //    Building key = the object `group` (bldg:<id>-r<room>) with the room suffix stripped.
  const bldgOf = (g: string | undefined): string | null => (g && g.startsWith('bldg:') ? g.replace(/-r\d+$/, '') : null);
  const barCells = new Map<string, Set<string>>();
  for (const o of map.objects) {
    if (o.tag !== 'bar_counter') continue;
    const b = bldgOf(o.group);
    if (b) (barCells.get(b) ?? barCells.set(b, new Set()).get(b)!).add(`${o.col},${o.row}`);
  }
  // Single-ROOM buildings are exempt: a one-hall inn (check-in counter + beds in the common room) is the
  // accepted historical degradation — the same graceful-degradation rule the semantic sweeps encode.
  const roomsOf = new Map<string, Set<string>>();
  for (const o of map.objects) { const b = bldgOf(o.group); if (b) (roomsOf.get(b) ?? roomsOf.set(b, new Set()).get(b)!).add(o.group!); }
  let bedByBar = 0;
  for (const o of map.objects) {
    if (!o.tag.startsWith('bed')) continue;
    const b = bldgOf(o.group);
    const bars = b ? barCells.get(b) : undefined;
    if (!bars?.size) continue;
    if ((roomsOf.get(b!)?.size ?? 0) <= 1) continue; // single-hall building → deliberate common room
    const nextToBar = (c: number, r: number) => N4.some(([dc, dr]) => bars.has(`${c + dc},${r + dr}`));
    let hit = false;
    const seen = new Set<string>([`${o.col},${o.row}`]);
    let frontier: [number, number][] = [[o.col, o.row]]; // the bed cell itself (non-walkable) is the source
    for (let step = 0; step < BEDBAR_DIST && !hit && frontier.length; step++) {
      const next: [number, number][] = [];
      for (const [c, r] of frontier) for (const [dc, dr] of N4) {
        const nc = c + dc, nr = r + dr, key = `${nc},${nr}`;
        if (seen.has(key) || !walk(nc, nr)) continue;
        seen.add(key);
        if (nextToBar(nc, nr)) { hit = true; break; }
        next.push([nc, nr]);
      }
      frontier = next;
    }
    if (hit) { bedByBar++; sample('bedbybar', o.col, o.row); }
  }

  return { doorApproachBlocked, bedByBar, doorStreetFar, doors, clean: doorApproachBlocked === 0 && bedByBar === 0, samples };
}
