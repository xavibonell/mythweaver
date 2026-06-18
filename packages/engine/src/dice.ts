/**
 * Dice + declared-roll plausibility (spec §4.3). RAMP: P0 engine-authoritative.
 *
 * The engine derives the legal range of a roll from its `NdX±M` expression and
 * validates a player's *declared* physical-dice total against it. It trusts
 * plausible declarations and only intervenes on the impossible — it never
 * fabricates a roll to "correct" the player.
 */

import type {
  AdvantageState,
  DiceExpr,
  ParsedDice,
  RollRequest,
  RollResult,
  RollValidation,
} from '@mythweaver/shared';

/** Injectable randomness source returning a float in [0, 1). */
export type Rng = () => number;

const defaultRng: Rng = Math.random;

const DICE_RE = /^\s*(\d+)\s*d\s*(\d+)\s*([+-]\s*\d+)?\s*$/i;

export function parseDice(expr: DiceExpr): ParsedDice {
  const m = DICE_RE.exec(expr);
  if (!m) throw new Error(`Invalid dice expression: "${expr}" (expected NdX±M, e.g. "1d20+5")`);
  const count = Number(m[1]);
  const sides = Number(m[2]);
  const modifier = m[3] ? Number(m[3].replace(/\s+/g, '')) : 0;
  if (count < 1 || sides < 2) throw new Error(`Invalid dice expression: "${expr}"`);
  return { count, sides, modifier };
}

/**
 * The legal min/max of an expression. Advantage/disadvantage on a d20 does NOT
 * change the range (still 1..20) — only the distribution — so it's ignored here.
 */
export function diceRange(p: ParsedDice): { min: number; max: number } {
  return { min: p.count * 1 + p.modifier, max: p.count * p.sides + p.modifier };
}

export function rollDie(sides: number, rng: Rng = defaultRng): number {
  return 1 + Math.floor(rng() * sides);
}

/** Roll a full expression. Advantage/disadvantage applies to single-d20 rolls. */
export function rollDice(expr: DiceExpr, advantage: AdvantageState = 'normal', rng: Rng = defaultRng): number {
  const p = parseDice(expr);
  if (advantage !== 'normal' && p.count === 1 && p.sides === 20) {
    const a = rollDie(20, rng);
    const b = rollDie(20, rng);
    const chosen = advantage === 'advantage' ? Math.max(a, b) : Math.min(a, b);
    return chosen + p.modifier;
  }
  let sum = 0;
  for (let i = 0; i < p.count; i++) sum += rollDie(p.sides, rng);
  return sum + p.modifier;
}

/**
 * Validate a declared total against a roll request (spec §4.3):
 *   in_range     -> accepted, applied
 *   ambiguous    -> accepted but recorded as unvalidated (within unmodeledBonusMax)
 *   out_of_range -> flagged, NOT applied; the DM re-requests
 */
export function validateDeclaredRoll(req: RollRequest, declaredTotal: number): RollResult {
  const { min, max } = diceRange(parseDice(req.expr));
  const slack = Math.max(0, req.unmodeledBonusMax ?? 0);

  let result: RollResult;
  if (declaredTotal >= min && declaredTotal <= max) {
    result = { requestId: req.id, declared: declaredTotal, validation: 'in_range', min, max, accepted: true };
  } else if (slack > 0 && declaredTotal > max && declaredTotal <= max + slack) {
    result = {
      requestId: req.id,
      declared: declaredTotal,
      validation: 'ambiguous',
      min,
      max,
      accepted: true,
      unvalidatedModifier: true,
      message: `Accepted ${declaredTotal} with an unverified bonus (legal base range ${min}–${max}).`,
    };
  } else {
    result = {
      requestId: req.id,
      declared: declaredTotal,
      validation: 'out_of_range',
      min,
      max,
      accepted: false,
      message: `Declared ${declaredTotal} is outside the legal range ${min}–${max} for ${req.expr}.`,
    };
  }

  // Engine-authoritative success (spec §4.2 P1): when the request carried a target
  // number (a check/save DC, or a target's AC for an attack), the ENGINE — not the
  // LLM — decides whether the accepted roll met it.
  if (result.accepted && req.dc !== undefined) {
    result.dc = req.dc;
    result.success = declaredTotal >= req.dc;
  }
  return result;
}

/** Convenience alias used in validation messages/tests. */
export type { RollValidation };
