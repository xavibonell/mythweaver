/**
 * SPATIAL TRUTH R4 (slice 1) — REACH: the attack legality gate (docs/SPATIAL-TRUTH.md §R4).
 *
 * Travel (travel.ts) made *movement* honest; this makes *violence* honest. Before a blow lands the
 * engine asks the one question nobody was asking: is the attacker actually close enough? Until now
 * distance was structurally unrepresentable in an attack — a RollRequest carries no attacker and no
 * target — so a PC could melee anyone anywhere on the map and the narration would happily describe
 * a strike thrown across a square.
 *
 * Same posture as travel: never a flat no. In reach → proceed. Out of reach but closable in one
 * move with a real route → the engine WALKS them in (the move delta makes the token visibly cross
 * the ground) and the blow lands. Genuinely too far → refused with a narratable corrective.
 *
 * Pure + engine-free by design (mirrors oracle.ts): planning only, no mutation. `Engine.attackReach`
 * owns the one side effect (the approach travel), so this file stays unit-testable with a bare map.
 */

import type { GameState } from '@mythweaver/shared';
import { distanceFt, findPath, type Cell, type MoveCaps, type SpatialIndex } from './oracle.js';

/** What kind of attack is being attempted. 'spell' is ADVISORY in slice 1 — there is no spell-range
 *  table in the engine yet, and guessing one would false-refuse a legitimate 120-ft cantrip. */
export type AttackMode = 'melee' | 'ranged' | 'spell';

/** Default melee reach, PHB (a reach weapon overrides it via ItemDef.reachFt). */
export const DEFAULT_MELEE_REACH_FT = 5;
/** Fallback ranged band when nothing is equipped/printed (shortbow-ish). */
export const DEFAULT_RANGED_FT = 80;
export const DEFAULT_RANGED_LONG_FT = 320;

export interface ReachRequirement {
  /** The distance at/inside which the attack is legal with NO penalty. */
  reachFt: number;
  /** Ranged only: the long band — legal but at disadvantage (5e). */
  longFt?: number;
  /** Where the number came from, for the trace ("longsword", "statblock", "default melee"). */
  source: string;
}

export type ReachReason =
  | 'in-reach' // already close enough — proceed untouched
  | 'closed-to-reach' // the engine walked them in; the blow lands
  | 'too-far-to-close' // out of reach and beyond one move — REFUSED
  | 'no-route' // reachable by distance but nothing walkable connects them — REFUSED
  | 'out-of-range' // ranged, past the long band — REFUSED
  | 'long-range' // ranged, in the long band — legal at disadvantage
  | 'unpositioned' // one side isn't on the map (or no scene) — cannot judge, so allow
  | 'spell-advisory'; // spell ranges aren't modeled yet — allow, but say so

export interface ReachVerdict {
  /** May the attack resolve? FALSE is the gate firing — callers must not apply damage. */
  ok: boolean;
  distanceFt: number;
  requiredFt: number;
  reason: ReachReason;
  /** Ranged band, when it matters (long ⇒ the caller should roll at disadvantage). */
  band?: 'normal' | 'long';
  /** Set when the engine closed the distance: what to tell the client so the token walks.
   *  `actorId` is the resolved MAP-OBJECT id (never a combatant handle) so the delta lands. */
  approach?: { ft: number; at: Cell; pathCells?: Cell[]; actorId?: string };
  /** Engine-authored, narratable — the DM may say these; it invents nothing. */
  facts: string[];
  /** On a refusal: the sentence handed back to the DM so it corrects instead of guessing. */
  corrective?: string;
}

/**
 * How far this attacker can actually strike. Reads the EQUIPPED weapon (the first reader
 * `ItemDef.reachFt`/`rangeFt` ever had — the older `reachOrRangeFt` on stat blocks was declared
 * "informational in v1" and never consulted by anything). Falls back to the monster stat block,
 * then to PHB defaults. Never accepts a number from the model.
 */
export function reachRequiredFt(state: GameState, attackerId: string, mode: AttackMode): ReachRequirement {
  const cs = state.characters?.[attackerId];
  const slot = mode === 'ranged' ? 'ranged' : 'mainHand';
  const instanceId = cs?.equipped?.[slot];
  if (instanceId) {
    const ref = cs?.items?.find((i) => i.instanceId === instanceId);
    const def = ref ? state.itemCatalog?.[ref.defId] : undefined;
    if (def) {
      if (mode === 'ranged') {
        const rangeFt = def.rangeFt ?? DEFAULT_RANGED_FT;
        return { reachFt: rangeFt, longFt: def.longRangeFt ?? rangeFt * 4, source: def.name };
      }
      if (def.reachFt) return { reachFt: def.reachFt, source: def.name };
      return { reachFt: DEFAULT_MELEE_REACH_FT, source: def.name };
    }
  }
  // Monsters carry no inventory — their printed reach/range lives on the stat block.
  const refId = state.combatants?.[attackerId]?.refId;
  const printed = refId ? state.bestiary?.[refId]?.attacks?.[0]?.reachOrRangeFt : undefined;
  if (printed) {
    return mode === 'ranged'
      ? { reachFt: printed, longFt: printed * 4, source: 'statblock' }
      : { reachFt: printed, source: 'statblock' };
  }
  return mode === 'ranged'
    ? { reachFt: DEFAULT_RANGED_FT, longFt: DEFAULT_RANGED_LONG_FT, source: 'default ranged' }
    : { reachFt: DEFAULT_MELEE_REACH_FT, source: 'default melee' };
}

/**
 * The first cell along a real walkable path that brings the attacker within `reachFt` of the target
 * WITHOUT spending more than `budgetFt` of movement. Returns undefined when no such cell exists
 * (too far for one move, or nothing connects the two). Pure — plans, never moves.
 *
 * Path cost is walked cell-by-cell rather than trusting straight-line distance, because a route
 * around a wall can cost far more than the Chebyshev gap suggests.
 */
export function planApproach(
  idx: SpatialIndex,
  from: Cell,
  target: Cell,
  caps: MoveCaps,
  reachFt: number,
  budgetFt: number,
): { cell: Cell; ft: number; pathCells: Cell[] } | undefined {
  if (budgetFt <= 0) return undefined;
  const path = findPath(idx, from, target, caps);
  if (!path.ok) return undefined;
  let spent = 0;
  let prev = from;
  for (let i = 0; i < path.cells.length; i++) {
    const cell = path.cells[i]!;
    // Cost this step by its own span so diagonals/media stay consistent with the pathfinder's metric.
    if (i > 0 || cell.col !== from.col || cell.row !== from.row) spent += distanceFt(idx, prev, cell);
    prev = cell;
    if (spent > budgetFt) return undefined; // one move can't get there
    if (distanceFt(idx, cell, target) <= reachFt) {
      return { cell, ft: spent, pathCells: path.cells.slice(0, i + 1) };
    }
  }
  return undefined; // the path ends without ever entering reach (target unreachable/occupied ring)
}

/**
 * Classify an attack's legality from geometry alone — the pure core. `Engine.attackReach` wraps this
 * and performs the approach; everything here is a decision, not a mutation.
 */
export function classifyReach(args: {
  idx: SpatialIndex;
  attacker: Cell;
  target: Cell;
  attackerName: string;
  targetName: string;
  mode: AttackMode;
  req: ReachRequirement;
  caps: MoveCaps;
}): ReachVerdict {
  const { idx, attacker, target, attackerName, targetName, mode, req, caps } = args;
  const d = distanceFt(idx, attacker, target);
  const base = { distanceFt: d, requiredFt: req.reachFt };

  if (mode === 'spell') {
    return { ...base, ok: true, reason: 'spell-advisory', facts: [`${attackerName} is ${d} ft from ${targetName} (spell ranges are not modeled — judge it yourself).`] };
  }

  if (d <= req.reachFt) {
    return { ...base, ok: true, reason: 'in-reach', band: 'normal', facts: [] };
  }

  if (mode === 'ranged') {
    if (req.longFt && d <= req.longFt) {
      return { ...base, ok: true, reason: 'long-range', band: 'long', facts: [`${targetName} is ${d} ft away — beyond ${req.reachFt} ft normal range, so the shot is at DISADVANTAGE.`] };
    }
    return {
      ...base, ok: false, reason: 'out-of-range', facts: [],
      corrective: `${targetName} is ${d} ft away — past the ${req.longFt ?? req.reachFt} ft maximum range of ${attackerName}'s ${req.source}. The shot cannot be attempted. Say so and offer another approach.`,
    };
  }

  // MELEE, out of reach: can one move close it?
  const plan = planApproach(idx, attacker, target, caps, req.reachFt, caps.speedFt);
  if (plan) {
    return {
      ...base, ok: true, reason: 'closed-to-reach',
      approach: { ft: plan.ft, at: plan.cell, pathCells: plan.pathCells },
      facts: [`${attackerName} closes ${plan.ft} ft on ${targetName} and strikes.`],
    };
  }
  const routed = findPath(idx, attacker, target, caps).ok;
  return {
    ...base, ok: false, reason: routed ? 'too-far-to-close' : 'no-route', facts: [],
    corrective: routed
      ? `${attackerName} is ${d} ft from ${targetName} — too far to close and strike in one move (${caps.speedFt} ft of movement, ${req.reachFt} ft reach). The blow does NOT land. Narrate the distance and let the player decide: close first, or do something else.`
      : `${attackerName} cannot reach ${targetName} — nothing walkable connects them (${d} ft away). The blow does NOT land. Narrate what is in the way.`,
  };
}
