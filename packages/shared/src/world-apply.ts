/**
 * SceneDelta APPLIER (Contract 4, wired) — the deterministic layer that owns geometry when the DM
 * moves the world mid-scene. The LLM proposes in semantic terms (updateScene → typed SceneDelta ops);
 * this module resolves anchors to concrete tiles, enforces walkability + occupancy, and mutates the
 * FROZEN SceneMap in place (the documented manipulation model — world.ts header). Every applied move
 * is normalized to an explicit {col,row} so clients can tween to exact tiles; every refusal returns
 * a reason the DM can narrate around. Pure + dependency-free: the Engine wraps it as the sole
 * mutation gateway.
 */

import type { Facing } from './scene.js';
import { BASE_ANCHORS, type EntityId, type MapObject, type SceneDelta, type SceneMap } from './world.js';

export interface ApplyResult {
  /** Ops that landed, with moves/spawns normalized to concrete tiles. */
  applied: SceneDelta[];
  /** Ops refused, each with a human-readable reason (fed back to the DM as the tool result). */
  rejected: { delta: SceneDelta; reason: string }[];
}

/** How far a blocked target may snap to the nearest free walkable cell before we refuse. */
const SNAP_RADIUS = 3;
/** How far around a `near:<id>` referent we search for a free adjacent cell. */
const NEAR_RADIUS = 4;

const FACINGS = new Set<Facing>(['up', 'down', 'left', 'right']);

/** Resolve an id against the registry: exact → case-insensitive → name (case-insensitive). */
export function findMapObject(map: SceneMap, id: string): MapObject | undefined {
  const exact = map.objects.find((o) => o.id === id);
  if (exact) return exact;
  const lower = id.trim().toLowerCase();
  const bare = lower.replace(/^(pc|npc|prop|bldg|fixture):/, '');
  return map.objects.find(
    (o) => o.id.toLowerCase() === lower || (o.name ?? '').toLowerCase() === lower || (o.name ?? '').toLowerCase() === bare,
  );
}

function inBounds(map: SceneMap, c: number, r: number): boolean {
  return c >= 0 && r >= 0 && c < map.grid.cols && r < map.grid.rows;
}

/** A cell an ACTOR can stand on: in bounds, walkable terrain, no OTHER visible actor standing there. */
function cellFree(map: SceneMap, c: number, r: number, self?: MapObject): boolean {
  if (!inBounds(map, c, r) || !map.walkable[r]?.[c]) return false;
  return !map.objects.some((o) => o !== self && o.kind === 'actor' && o.visible && o.col === c && o.row === r);
}

/** Nearest free cell to (c,r) within `radius`, searching outward ring by ring (deterministic order). */
function snapToFree(map: SceneMap, c: number, r: number, radius: number, self?: MapObject): { col: number; row: number } | null {
  for (let d = 0; d <= radius; d++) {
    for (let dr = -d; dr <= d; dr++) {
      for (let dc = -d; dc <= d; dc++) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== d) continue; // ring only
        if (cellFree(map, c + dc, r + dr, self)) return { col: c + dc, row: r + dr };
      }
    }
  }
  return null;
}

/** Resolve a BASE anchor to a target cell (before snapping). */
function baseAnchorCell(map: SceneMap, anchor: string): { col: number; row: number } | null {
  const mc = Math.floor(map.grid.cols / 2);
  const mr = Math.floor(map.grid.rows / 2);
  switch (anchor) {
    case 'center': return { col: mc, row: mr };
    case 'north': return { col: mc, row: 2 };
    case 'south': return { col: mc, row: map.grid.rows - 3 };
    case 'east': return { col: map.grid.cols - 3, row: mr };
    case 'west': return { col: 2, row: mr };
    case 'north-edge': return { col: mc, row: 0 };
    case 'south-edge': return { col: mc, row: map.grid.rows - 1 };
    case 'east-edge': return { col: map.grid.cols - 1, row: mr };
    case 'west-edge': return { col: 0, row: mr };
    case 'entrance': {
      const e = map.entrances[0];
      return e ? { col: e.col, row: e.row } : { col: mc, row: map.grid.rows - 1 };
    }
    case 'waterside': {
      // The walkable cell nearest to centre that touches water.
      let best: { col: number; row: number } | null = null;
      let bestD = Infinity;
      for (let r = 0; r < map.grid.rows; r++) {
        for (let c = 0; c < map.grid.cols; c++) {
          if (!map.walkable[r]?.[c]) continue;
          const touchesWater = [[0, 1], [0, -1], [1, 0], [-1, 0]].some(([dc, dr]) => (map.tiles[r + dr!]?.[c + dc!] ?? '').startsWith('water'));
          if (!touchesWater) continue;
          const d = Math.abs(c - mc) + Math.abs(r - mr);
          if (d < bestD) { bestD = d; best = { col: c, row: r }; }
        }
      }
      return best;
    }
    default: return null;
  }
}

/** Resolve a semantic anchor OR explicit tile to a concrete FREE cell, or a refusal reason. */
function resolveTarget(
  map: SceneMap,
  to: { anchor?: string; col?: number; row?: number },
  self?: MapObject,
): { col: number; row: number } | { reason: string } {
  if (typeof to.anchor === 'string') {
    const near = /^near:(.+)$/.exec(to.anchor);
    if (near) {
      const ref = findMapObject(map, near[1]!);
      if (!ref) return { reason: `unknown referent "${near[1]}" in anchor "${to.anchor}"` };
      const cell = snapToFree(map, ref.col, ref.row, NEAR_RADIUS, self);
      return cell ?? { reason: `no free cell near ${ref.id}` };
    }
    if ((BASE_ANCHORS as readonly string[]).includes(to.anchor)) {
      const base = baseAnchorCell(map, to.anchor);
      if (!base) return { reason: `anchor "${to.anchor}" has no target on this map` };
      const cell = snapToFree(map, base.col, base.row, Math.max(SNAP_RADIUS, 5), self);
      return cell ?? { reason: `no free cell around "${to.anchor}"` };
    }
    return { reason: `unsupported anchor "${to.anchor}" (use center/north/…/entrance/waterside or near:<id>)` };
  }
  if (Number.isInteger(to.col) && Number.isInteger(to.row)) {
    const c = Math.max(0, Math.min(map.grid.cols - 1, to.col!));
    const r = Math.max(0, Math.min(map.grid.rows - 1, to.row!));
    const cell = snapToFree(map, c, r, SNAP_RADIUS, self);
    return cell ?? { reason: `(${to.col},${to.row}) is blocked and nothing is free within ${SNAP_RADIUS} tiles` };
  }
  return { reason: 'move target must be an anchor or a tile' };
}

/**
 * Apply a batch of SceneDeltas to a frozen map, IN PLACE. Each op resolves independently and in
 * order (an earlier spawn can be the referent of a later move). Never throws — refusals come back
 * as reasons so a turn can't break on geometry.
 */
export function applySceneDeltas(map: SceneMap, deltas: SceneDelta[]): ApplyResult {
  const applied: SceneDelta[] = [];
  const rejected: { delta: SceneDelta; reason: string }[] = [];
  const refuse = (delta: SceneDelta, reason: string): void => { rejected.push({ delta, reason }); };

  for (const d of deltas) {
    switch (d.op) {
      case 'move': {
        const obj = findMapObject(map, d.id);
        if (!obj) { refuse(d, `no object "${d.id}" on this map`); break; }
        const cell = resolveTarget(map, d.to as { anchor?: string; col?: number; row?: number }, obj);
        if ('reason' in cell) { refuse(d, cell.reason); break; }
        obj.col = cell.col;
        obj.row = cell.row;
        const anchor = (d.to as { anchor?: string }).anchor;
        if (anchor) obj.anchorRef = anchor;
        applied.push({ op: 'move', id: obj.id, to: { col: cell.col, row: cell.row } }); // normalized for tweens
        break;
      }
      case 'face': {
        const obj = findMapObject(map, d.id);
        if (!obj) { refuse(d, `no object "${d.id}" on this map`); break; }
        if (!FACINGS.has(d.facing)) { refuse(d, `invalid facing "${String(d.facing)}"`); break; }
        obj.facing = d.facing;
        applied.push({ op: 'face', id: obj.id, facing: d.facing });
        break;
      }
      case 'reveal':
      case 'hide': {
        const obj = findMapObject(map, d.id);
        if (!obj) { refuse(d, `no object "${d.id}" on this map`); break; }
        obj.visible = d.op === 'reveal';
        applied.push({ op: d.op, id: obj.id });
        break;
      }
      case 'setState': {
        const obj = findMapObject(map, d.id);
        if (!obj) { refuse(d, `no object "${d.id}" on this map`); break; }
        obj.state = { ...(obj.state ?? {}), ...d.state };
        applied.push({ op: 'setState', id: obj.id, state: d.state });
        break;
      }
      case 'despawn': {
        const obj = findMapObject(map, d.id);
        if (!obj) { refuse(d, `no object "${d.id}" on this map`); break; }
        if (obj.role === 'pc') { refuse(d, 'party members cannot be despawned'); break; }
        map.objects.splice(map.objects.indexOf(obj), 1);
        applied.push({ op: 'despawn', id: obj.id });
        break;
      }
      case 'spawn': {
        if (map.objects.some((o) => o.id === d.id)) { refuse(d, `an object with id "${d.id}" already exists (move or reveal it instead)`); break; }
        const cell = resolveTarget(map, { anchor: d.anchor });
        if ('reason' in cell) { refuse(d, cell.reason); break; }
        const spawned: MapObject = {
          id: d.id as EntityId,
          kind: d.kind,
          ...(d.role ? { role: d.role } : {}),
          tag: d.tag,
          ...(d.name ? { name: d.name } : {}),
          col: cell.col,
          row: cell.row,
          footprint: { w: 1, h: 1 },
          facing: 'down',
          visible: d.visible !== false,
          anchorRef: d.anchor,
        };
        map.objects.push(spawned);
        // Normalized: the anchor is preserved (provenance) and `at` carries the resolved tile.
        applied.push({ op: 'spawn', id: spawned.id, kind: spawned.kind, ...(spawned.role ? { role: spawned.role } : {}), tag: spawned.tag, ...(spawned.name ? { name: spawned.name } : {}), anchor: d.anchor, visible: spawned.visible, at: { col: cell.col, row: cell.row } });
        break;
      }
      case 'enter': {
        refuse(d, 'location transitions are setScene\'s job (enter is not supported yet)');
        break;
      }
      default:
        refuse(d as SceneDelta, `unknown op "${(d as { op?: string }).op}"`);
    }
  }
  return { applied, rejected };
}
