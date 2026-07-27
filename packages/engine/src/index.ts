export { Engine } from './engine.js';
export { createInitialState, pcToCombatant, statBlockToCombatant } from './state.js';
export { parseDice, diceRange, rollDie, rollDice, validateDeclaredRoll, type Rng } from './dice.js';
export { generateStatBlock, type MonsterSpec } from './monster-gen.js';
export { abilityMod, deriveProficiencyBonus, deriveArmorClass, deriveCarry, deriveSkillModifier, deriveAbilityCheckModifier, deriveSaveModifier, derivePassive, deriveSpellSaveDc, deriveSpellsPreparedMax } from './derive.js';
export { hitDieForClass, XP_THRESHOLDS, levelForXp, hitDieAvg, ASI_LEVELS } from './progression.js';
export { buildSpatialIndex, spatialIndex, bumpSpatialVersion, distanceFt, findPath, hasLineOfSight, whereIs, travelTime, DEFAULT_CAPS, type SpatialIndex, type MoveCaps, type Medium, type Cell, type PathResult, type WhereIs } from './spatial/oracle.js';
export { deriveMoveCaps, type TravelIntent, type TravelVerdict } from './spatial/travel.js';
export { classifyReach, planApproach, reachRequiredFt, DEFAULT_MELEE_REACH_FT, type AttackMode, type ReachRequirement, type ReachVerdict, type ReachReason } from './spatial/reach.js';
