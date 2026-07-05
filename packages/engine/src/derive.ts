/**
 * The Character Engine's pure DERIVATION layer (P3 foundation).
 *
 * The governing invariant of the character engine is DERIVE-DON'T-STORE: every COMPUTED character number
 * (proficiency bonus, skill/save modifier, AC, carry capacity, passives, spell save DC) lives here as a
 * pure, RNG-free function and is NEVER persisted. That makes "the engine owns every mechanical number" a
 * structural property — there is no stored derived value for the LLM (or a careless writer) to drift.
 *
 * This module grows over the P3 ramp; P3a lands the two foundations everything else builds on
 * (ability modifier — re-homed here from state.ts and re-exported so callers don't churn — and the
 * proficiency-bonus-by-level curve).
 */

/** D&D ability modifier from a raw score: floor((score - 10) / 2). */
export const abilityMod = (score: number): number => Math.floor((score - 10) / 2);

/** Proficiency bonus by character level (SRD): +2 at 1–4, +3 at 5–8, … +6 at 17–20. */
export const deriveProficiencyBonus = (level: number): number =>
  2 + Math.floor((Math.max(1, Math.min(20, Math.floor(level))) - 1) / 4);
