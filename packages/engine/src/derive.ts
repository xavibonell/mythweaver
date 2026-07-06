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

import type { CharacterSheet, CharacterState, ItemDef } from '@mythweaver/shared';

/** D&D ability modifier from a raw score: floor((score - 10) / 2). */
export const abilityMod = (score: number): number => Math.floor((score - 10) / 2);

/** Proficiency bonus by character level (SRD): +2 at 1–4, +3 at 5–8, … +6 at 17–20. */
export const deriveProficiencyBonus = (level: number): number =>
  2 + Math.floor((Math.max(1, Math.min(20, Math.floor(level))) - 1) / 4);

/**
 * Armor Class from EQUIPPED armor/shield (P3d) — the single AC formula. Nothing equipped → fall back to
 * the sheet's printed AC, so a legacy pregen (whose gear is baked into that number) stays byte-identical
 * until it equips a real catalog item. (Attuned-item AC bonuses like a Ring of Protection are narrative
 * for now — a later refinement.)
 */
export function deriveArmorClass(sheet: CharacterSheet, cs: CharacterState | undefined, catalog: Record<string, ItemDef> | undefined): number {
  const cat = catalog ?? {};
  const defOf = (instanceId?: string): ItemDef | undefined => {
    if (!instanceId || !cs) return undefined;
    const ref = cs.items.find((i) => i.instanceId === instanceId);
    return ref ? cat[ref.defId] : undefined;
  };
  const armor = defOf(cs?.equipped?.armor);
  const shield = defOf(cs?.equipped?.shield);
  if (!armor && !shield) return sheet.armorClass;
  const dex = abilityMod(sheet.abilities.dex);
  let ac = 10 + dex;
  if (armor?.acBase !== undefined) {
    const dexBonus = armor.acDexCap !== undefined ? Math.min(dex, armor.acDexCap) : dex;
    ac = armor.acBase + dexBonus;
  }
  if (shield?.acBonus) ac += shield.acBonus;
  return ac;
}

/** Carrying capacity in pounds (SRD basic rule): STR × 15. */
export const deriveCarry = (sheet: CharacterSheet): number => sheet.abilities.str * 15;
