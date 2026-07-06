/**
 * The engine tool contract (spec §4.1).
 *
 * This is the boundary between the LLM (narrator) and the deterministic engine
 * (authoritative state). The LLM may ONLY affect mechanics by calling these
 * tools; it never computes a number itself. Methods are added to the engine over
 * the §4.2 ramp — until a method's ramp tier is reached, the engine throws
 * `NotImplemented` so a premature LLM-side resolution can't hide.
 */

import type {
  Ability,
  AdvantageState,
  Condition,
  DamageType,
  DiceExpr,
  GameState,
  Skill,
} from './domain.js';

/** Thrown by engine methods whose ramp tier (spec §4.2) is not yet implemented. */
export class NotImplemented extends Error {
  constructor(public readonly feature: string, public readonly phase: string) {
    super(`NotImplemented: ${feature} is scheduled for ${phase} (spec §4.2)`);
    this.name = 'NotImplemented';
  }
}

// ---------------------------------------------------------------------------
// Dice & declared-roll plausibility (spec §4.3) — engine-authoritative in P0
// ---------------------------------------------------------------------------

/** A parsed `NdX±M` expression. */
export interface ParsedDice {
  count: number;
  sides: number;
  modifier: number;
}

/** The engine asks a player for a physical-dice roll. */
export interface RollRequest {
  id: string;
  /** The die expression the player should roll, e.g. "1d20+5". */
  expr: DiceExpr;
  /** Human-readable reason ("Athletics check to climb"). */
  reason: string;
  advantage?: AdvantageState;
  /** If this is a check/save, the DC to beat (informational; engine compares on submit). */
  dc?: number;
  ability?: Ability;
  /**
   * Engine's estimate of an extra, hard-to-derive bonus that may legitimately be
   * in play (e.g. an unmodeled situational buff the engine can't fully account
   * for). Declared totals above max but within max+unmodeledBonusMax are accepted
   * as 'ambiguous' (recorded but trusted) rather than flagged out-of-range (§4.3).
   */
  unmodeledBonusMax?: number;
}

export type RollValidation = 'in_range' | 'out_of_range' | 'ambiguous';

/** The result of validating a player's declared total against the legal range. */
export interface RollResult {
  requestId: string;
  declared: number;
  validation: RollValidation;
  /** Legal min/max the engine derived from the expression (+ advantage). */
  min: number;
  max: number;
  /** True only when validation === 'in_range' (or 'ambiguous' and accepted). */
  accepted: boolean;
  /** The target number compared against, when the request carried a `dc`. */
  dc?: number;
  /** Whether the accepted roll met/beat the DC — engine-authoritative (spec §4.2 P1). */
  success?: boolean;
  /** Set when a modifier the player applied couldn't be derived by the engine. */
  unvalidatedModifier?: boolean;
  message?: string;
}

// ---------------------------------------------------------------------------
// Engine tool surface
// ---------------------------------------------------------------------------

export interface CheckResult {
  total: number;
  dc: number;
  success: boolean;
  critical?: 'hit' | 'miss';
}

export interface AttackResult {
  attackTotal: number;
  targetAc: number;
  hit: boolean;
  critical?: 'hit' | 'miss';
}

/**
 * The tools the orchestrator exposes to the LLM. Implemented incrementally:
 *   P0  getState, rollDice, requestRoll, submitRoll
 *   P1  resolveCheck, resolveSave, resolveAttack (hit/miss)
 *   P2  applyDamage, startCombat, nextTurn, applyCondition
 *   P3  spendResource (slots/charges), movement/range
 */
export interface EngineTools {
  /** Read-only snapshot for context assembly. Always available. */
  getState(): GameState;

  /** Roll dice with the engine RNG (for monsters / GM-side rolls). P0. */
  rollDice(expr: DiceExpr, advantage?: AdvantageState): number;

  /** Create a roll request to hand to a player. P0. */
  requestRoll(req: Omit<RollRequest, 'id'>): RollRequest;

  /** Validate + record a player's declared physical-dice total (spec §4.3). P0. */
  submitRoll(requestId: string, declaredTotal: number): RollResult;

  /** Resolve an ability/skill check against a DC. P1. */
  resolveCheck(args: { combatantId: string; skill?: Skill; ability: Ability; dc: number; declaredTotal: number }): CheckResult;

  /** Resolve a saving throw. P1. */
  resolveSave(args: { combatantId: string; ability: Ability; dc: number; declaredTotal: number }): CheckResult;

  /** Resolve an attack vs AC (hit/miss only; damage is P2). P1. */
  resolveAttack(args: { attackerId: string; targetId: string; attackName: string; declaredTotal: number }): AttackResult;

  /** Apply damage of a type, honoring resist/immunity/vuln. P2. If the target was concentrating and
   *  survives, `concentration` carries the Con-save DC the caster must make (max 10, half the damage). P3b. */
  applyDamage(args: { targetId: string; amount: number; type: DamageType }): { remaining: number; downed: boolean; concentration?: { dc: number; spell: string } };

  /** Begin concentrating on a spell (drops any spell already held — one at a time). P3b. */
  startConcentration(args: { combatantId: string; spell: string }): void;

  /** Stop concentrating (spell ends, incapacitation, or a failed save). P3b. */
  breakConcentration(args: { combatantId: string }): { was: string | null };

  /** Begin combat from a list of combatant ids + their initiative totals. P2. */
  startCombat(initiatives: { combatantId: string; initiative: number }[]): void;

  /** Advance to the next turn in initiative order. P2. */
  nextTurn(): { activeCombatantId: string; round: number };

  /** Apply/remove a condition. P2. */
  applyCondition(args: { combatantId: string; condition: Condition; add: boolean }): void;

  /** Spend a spell slot (resource:'slot' + level) or a named class pool (ki/rage/channelDivinity/…). P3a. */
  spendResource(args: { combatantId: string; resource: string; level?: number; amount?: number }): { remaining: number };

  /**
   * Short rest: optionally spend hit dice to heal (pass the ROLLED total via the dice-trust path) and
   * recharge short-rest resources. The engine validates the hit-dice count and owns the HP arithmetic. P3a.
   */
  shortRest(args: { combatantId: string; spendHitDice?: number; rolledTotal?: number }): { hpRestored: number; hitDiceRemaining: number };

  /**
   * Long rest: restore HP to full, spell slots + resources to max, refund up to half the hit-dice pool
   * (min 1), and reduce exhaustion by 1 — for each combatant (defaults to the whole party). This is the
   * single place spell slots come back, making slotsRemaining a real resource. P3a.
   */
  longRest(args?: { combatantIds?: string[] }): { restored: Record<string, { hp: number; slotsRestored: boolean; hitDiceRemaining: number; exhaustion: number }> };

  /** Set a combatant's exhaustion level (clamped 0–6; 6 = death, SRD). P3a. */
  setExhaustion(args: { combatantId: string; level: number }): { exhaustion: number };

  /** Grant Heroic Inspiration (a one-shot advantage token). P3a. */
  grantInspiration(args: { combatantId: string }): void;

  /** Spend Heroic Inspiration; throws if the combatant holds none. P3a. */
  spendInspiration(args: { combatantId: string }): { spent: boolean };
}
