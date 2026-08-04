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

import { SKILLS, type Ability, type CharacterSheet, type CharacterState, type ItemDef, type Skill } from '@mythweaver/shared';

/** D&D ability modifier from a raw score: floor((score - 10) / 2). */
export const abilityMod = (score: number): number => Math.floor((score - 10) / 2);

/** Proficiency bonus by character level (SRD): +2 at 1–4, +3 at 5–8, … +6 at 17–20. */
export const deriveProficiencyBonus = (level: number): number =>
  2 + Math.floor((Math.max(1, Math.min(20, Math.floor(level))) - 1) / 4);

/** Flat d20-test penalty from exhaustion (2024 rule: −2 per level; a single numeric knob). */
const exhaustionPenalty = (exhaustion?: number): number => 2 * Math.max(0, Math.min(6, Math.floor(exhaustion ?? 0)));

/** The live proficiency bonus (from the level in CharacterState, falling back to the sheet's level). */
const profOf = (sheet: CharacterSheet, cs?: CharacterState): number => deriveProficiencyBonus(cs?.level ?? sheet.level);

/**
 * The full modifier on a SKILL check (P3e) — the single formula that makes the engine own the +N:
 * ability modifier + profFactor × proficiency (0 none / 0.5 half / 1 proficient / 2 expertise) − exhaustion.
 */
export function deriveSkillModifier(sheet: CharacterSheet, cs: CharacterState | undefined, skill: Skill, exhaustion?: number): number {
  const base = abilityMod(sheet.abilities[SKILLS[skill]]);
  const prof = profOf(sheet, cs);
  const factor = sheet.skillExpertise?.includes(skill) ? 2 : sheet.skillProficiencies.includes(skill) ? 1 : sheet.skillHalfProficiency?.includes(skill) ? 0.5 : 0;
  return base + Math.floor(prof * factor) - exhaustionPenalty(exhaustion);
}

/** The modifier on a raw ability check (no skill): ability modifier − exhaustion. */
export function deriveAbilityCheckModifier(sheet: CharacterSheet, ability: Ability, exhaustion?: number): number {
  return abilityMod(sheet.abilities[ability]) - exhaustionPenalty(exhaustion);
}

/** The modifier on a SAVING THROW: ability modifier + proficiency (if proficient) − exhaustion. */
export function deriveSaveModifier(sheet: CharacterSheet, cs: CharacterState | undefined, ability: Ability, exhaustion?: number): number {
  return abilityMod(sheet.abilities[ability]) + (sheet.savingThrowProficiencies.includes(ability) ? profOf(sheet, cs) : 0) - exhaustionPenalty(exhaustion);
}

/** Passive score for a skill: 10 + its modifier (used for passive Perception/Investigation/Insight). */
export function derivePassive(sheet: CharacterSheet, cs: CharacterState | undefined, skill: Skill, exhaustion?: number): number {
  return 10 + deriveSkillModifier(sheet, cs, skill, exhaustion);
}

/** Spell save DC, recomputed from the CURRENT level (grows with proficiency): 8 + prof + casting-ability mod. */
export function deriveSpellSaveDc(sheet: CharacterSheet, cs: CharacterState | undefined): number | undefined {
  if (!sheet.spellcasting) return undefined;
  return 8 + profOf(sheet, cs) + abilityMod(sheet.abilities[sheet.spellcasting.ability]);
}

/** How many spells a prepared caster may have ready (P3f): the sheet's explicit cap, else casting-ability
 *  modifier + level (min 1). Known casters (no preparation) simply won't call prepareSpells. */
export function deriveSpellsPreparedMax(sheet: CharacterSheet, cs: CharacterState | undefined): number | undefined {
  if (!sheet.spellcasting) return undefined;
  if (sheet.spellcasting.preparedMax !== undefined) return sheet.spellcasting.preparedMax;
  return Math.max(1, abilityMod(sheet.abilities[sheet.spellcasting.ability]) + (cs?.level ?? sheet.level));
}

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
