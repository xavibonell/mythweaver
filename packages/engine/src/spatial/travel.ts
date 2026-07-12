/**
 * SPATIAL TRUTH R2 — travel: the single movement gate (docs/SPATIAL-TRUTH.md §1.2-1.3).
 *
 * Every actor move funnels here — the DM's travel tool, the token-truth backstop, raw updateScene
 * actor moves — so a narrated walk and a tool-called walk hit the SAME truth. Single-shot with
 * one-gate-per-call: a calm swim just costs double (triviality — no dialog for the trivial); a
 * HAZARDOUS swim stops at the waterline and hands back ONE check gate that parameterizes the
 * existing requestRoll machinery (pendingTurn stays the only suspension state). Refusals move the
 * actor to the FRONTIER (as far as legal) with a narratable reason — never a flat no. The verdict
 * carries facts[] the DM may narrate; it invents nothing.
 */

import type { GameState, SceneMap } from '@mythweaver/shared';
import { spatialIndex, findPath, travelTime, distanceFt, type Cell, type MoveCaps, type PathOk } from './oracle.js';

/** Concentration-tracked spells that change traversal (R2 approximation: our engine tracks lasting
 *  spells via concentratingOn; real effect records arrive with interactables in R3+). */
const SPELL_MOVE_EFFECTS: [match: string, cap: 'waterWalk' | 'fly'][] = [
  ['water walk', 'waterWalk'],
  ['fly', 'fly'],
  ['levitate', 'fly'],
];

/** Movement-killing / crawling conditions (CONDITION_MOVE, minimal v1 rows). */
const SPEED_ZERO = new Set(['grappled', 'restrained', 'paralyzed', 'petrified', 'stunned', 'unconscious']);

export interface TravelIntent {
  actorId: string; // resolved map-object id (callers resolve fiction-words first)
  to: { id?: string; col?: number; row?: number };
  /** 'auto' = engine-initiated (backstop/reroute): gates NEVER suspend — degrade to the frontier. */
  mode?: 'walk' | 'auto';
  /** Set on the resume leg after a gate check SUCCEEDED — executes the crossing without re-gating. */
  gatePassed?: boolean;
}

export interface TravelVerdict {
  moved: boolean;
  ft: number;
  rounds: number;
  legs: { medium: string; ft: number; swimming?: boolean }[];
  /** Present when the actor stopped short (frontier degrade / waterline gate). */
  stoppedAt?: 'waterline' | 'frontier';
  /** ONE gate max per call: the swim check the orchestrator turns into a real requestRoll. */
  needsRoll?: { ability: 'str'; skill: 'athletics'; dc: number; reason: string };
  facts: string[];
  rejected?: string;
  /** The actor's cell after this call (post-snap) — callers synthesize the client tween from it. */
  at?: Cell;
}

export function deriveMoveCaps(state: GameState, actorId: string): MoveCaps {
  const c = state.combatants[actorId];
  const sheet = state.sheets?.[actorId];
  const stat = c?.refId ? state.bestiary?.[c.refId] : undefined;
  let speedFt = sheet?.speedFt ?? stat?.speedFt ?? 30;
  if (c?.conditions.some((x) => SPEED_ZERO.has(x))) speedFt = 0;
  const caps: MoveCaps = { speedFt, swim: 'double-cost' }; // PHB default: anyone may swim at 2x cost
  const spell = c?.concentratingOn?.spell.toLowerCase() ?? '';
  for (const [match, cap] of SPELL_MOVE_EFFECTS) if (spell.includes(match)) caps[cap] = true;
  return caps;
}

/** Is the water dangerous enough to gate an Athletics check? Default CALM (no roll — triviality);
 *  rough via the arc/DM flag or storm weather. DC 12 (rough water, PHB-adjacent default). */
function waterHazard(state: GameState, map: SceneMap): { hazardous: boolean; dc: number } {
  const rough = state.flags?.['water:rough'] !== undefined || (map.weather as string | undefined) === 'storm';
  return { hazardous: rough, dc: 12 };
}

export interface TravelDeps {
  state: GameState;
  map: SceneMap;
  /** The single mutator — travel emits through it so occupancy/snap/refusal safety all apply. */
  applyMove: (actorId: string, to: Cell) => { applied: boolean; at?: Cell };
}

export function runTravel(deps: TravelDeps, intent: TravelIntent): TravelVerdict {
  const { state, map } = deps;
  const idx = spatialIndex(map);
  const actor = map.objects.find((o) => o.id === intent.actorId);
  if (!actor) return { moved: false, ft: 0, rounds: 0, legs: [], facts: [], rejected: `no actor "${intent.actorId}" on this map` };
  const targetObj = intent.to.id ? map.objects.find((o) => o.id === intent.to.id) : undefined;
  const target: Cell | undefined = targetObj ? { col: targetObj.col, row: targetObj.row } : Number.isInteger(intent.to.col) ? { col: intent.to.col!, row: intent.to.row! } : undefined;
  if (!target) return { moved: false, ft: 0, rounds: 0, legs: [], facts: [], rejected: `no target "${intent.to.id ?? ''}" on this map` };

  const caps = deriveMoveCaps(state, intent.actorId);
  if (caps.speedFt === 0) return { moved: false, ft: 0, rounds: 0, legs: [], facts: [`${actor.name ?? actor.id} cannot move (condition)`], rejected: 'speed 0' };

  const path = findPath(idx, { col: actor.col, row: actor.row }, target, caps);
  if (!path.ok) {
    // Frontier degrade: walk them as far as the world allows, say why.
    if (path.frontier && (path.frontier.col !== actor.col || path.frontier.row !== actor.row)) {
      const res = deps.applyMove(intent.actorId, path.frontier);
      if (res.applied) {
        const ft = distanceFt(idx, path.frontier, target);
        return {
          moved: true, ft: 0, rounds: 0, legs: [], stoppedAt: 'frontier', at: res.at ?? path.frontier,
          facts: [`${actor.name ?? actor.id} advances as far as the ground allows — still ${ft} ft short (${path.blockedBy}).`],
        };
      }
    }
    return { moved: false, ft: 0, rounds: 0, legs: [], facts: [`no route: ${path.blockedBy}`], rejected: path.blockedBy };
  }

  const swimLegs = path.segments.filter((s) => s.swimming);
  const { hazardous, dc } = waterHazard(state, map);

  if (swimLegs.length && hazardous && !intent.gatePassed) {
    // ONE gate: stop at the waterline (execute the dry prefix), hand back the check.
    const firstSwim = path.cells.findIndex((c) => {
      const k = c.row * idx.cols + c.col;
      return idx.roomId[k] === -1; // off the walkable network = in the water
    });
    const bank = firstSwim > 0 ? path.cells[firstSwim - 1]! : { col: actor.col, row: actor.row };
    let bankAt: Cell = { col: actor.col, row: actor.row };
    if (bank.col !== actor.col || bank.row !== actor.row) {
      const r = deps.applyMove(intent.actorId, bank);
      if (r.applied) bankAt = r.at ?? bank;
    }
    const swimFt = swimLegs.reduce((s, l) => s + l.ft, 0);
    if (intent.mode === 'auto') {
      return {
        moved: true, ft: 0, rounds: 0, legs: path.segments, stoppedAt: 'waterline', at: bankAt,
        facts: [`${actor.name ?? actor.id} stops at the waterline — ${swimFt} ft of rough water ahead (a swim would need an Athletics check).`],
      };
    }
    return {
      moved: bank.col !== actor.col || bank.row !== actor.row, ft: 0, rounds: 0, legs: path.segments, stoppedAt: 'waterline', at: bankAt,
      needsRoll: { ability: 'str', skill: 'athletics', dc, reason: `Athletics to swim ${swimFt} ft of rough water` },
      facts: [`${swimFt} ft of rough water lies ahead; the crossing needs an Athletics check (the engine will resolve it).`],
    };
  }

  const res = deps.applyMove(intent.actorId, target);
  const landed = res.applied;
  const t = travelTime(path.totalFt, caps.speedFt);
  const swamFt = swimLegs.reduce((s, l) => s + l.ft, 0);
  const facts = [
    `${actor.name ?? actor.id} covers ${path.totalFt} ft of movement (~${t.rounds} round${t.rounds === 1 ? '' : 's'})${swamFt ? `, swimming ${swamFt} ft of it${caps.waterWalk ? '' : ' at double cost'}` : ''}.`,
    ...(caps.waterWalk && path.segments.some((s) => s.medium.startsWith('water')) ? [`${actor.name ?? actor.id} walks ON the water (spell effect).`] : []),
  ];
  return { moved: landed, ft: path.totalFt, rounds: t.rounds, legs: path.segments, facts, ...(res.at ? { at: res.at } : {}) };
}

/** Fail-forward for a FAILED swim gate: the actor stays out of the deep but the world moves —
 *  swept along the bank if a lateral cell is free, and the failure is a narratable fact. */
export function swimGateFailure(deps: TravelDeps, actorId: string): string[] {
  const { map } = deps;
  const idx = spatialIndex(map);
  const actor = map.objects.find((o) => o.id === actorId);
  if (!actor) return [];
  for (const [dr, dc] of [[0, 2], [0, -2], [2, 0], [-2, 0]] as const) {
    const cell = { col: actor.col + dc, row: actor.row + dr };
    const k = cell.row * idx.cols + cell.col;
    if (cell.col >= 0 && cell.col < idx.cols && cell.row >= 0 && cell.row < idx.rows && idx.roomId[k] !== -1 && !idx.occupied.has(k)) {
      deps.applyMove(actorId, cell);
      return [`the current throws ${actor.name ?? actorId} back and ${Math.abs(dr + dc) * 5} ft along the bank — no crossing this attempt, and the round is lost.`];
    }
  }
  return [`the current throws ${actor.name ?? actorId} back — no crossing this attempt, and the round is lost.`];
}
