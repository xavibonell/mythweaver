/** GameState construction helpers (the engine is the sole mutator — spec §4.1). */

import { classToSpriteTag, type AdventureContext, type CharacterSheet, type Combatant, type EncounterDef, type GameState, type StatBlock } from '@mythweaver/shared';

/** D&D ability modifier from a raw score. */
const abilityMod = (score: number): number => Math.floor((score - 10) / 2);

export function pcToCombatant(pc: CharacterSheet): Combatant {
  return {
    id: `pc:${pc.id}`,
    name: pc.name,
    kind: 'pc',
    refId: pc.id,
    spriteTag: classToSpriteTag(pc.className),
    currentHitPoints: pc.maxHitPoints,
    maxHitPoints: pc.maxHitPoints,
    temporaryHitPoints: 0,
    armorClass: pc.armorClass,
    conditions: [],
    initiativeBonus: abilityMod(pc.abilities.dex),
    ...(pc.spellcasting ? { slotsRemaining: [...pc.spellcasting.slots] } : {}),
  };
}

/** Build a live npc Combatant from a monster stat block (P2 combat spawn). */
export function statBlockToCombatant(sb: StatBlock, instanceId: string, name?: string): Combatant {
  return {
    id: instanceId,
    name: name ?? sb.name,
    kind: 'npc',
    refId: sb.id,
    currentHitPoints: sb.hitPoints.average,
    maxHitPoints: sb.hitPoints.average,
    temporaryHitPoints: 0,
    armorClass: sb.armorClass,
    conditions: [],
    initiativeBonus: abilityMod(sb.abilities.dex),
    ...(sb.damageResistances ? { damageResistances: [...sb.damageResistances] } : {}),
    ...(sb.damageImmunities ? { damageImmunities: [...sb.damageImmunities] } : {}),
    ...(sb.damageVulnerabilities ? { damageVulnerabilities: [...sb.damageVulnerabilities] } : {}),
  };
}

export function createInitialState(args: {
  sessionId: string;
  scenarioId: string;
  startSceneId: string;
  party: CharacterSheet[];
  adventure?: AdventureContext;
  /** Authored encounters + resolved stat blocks, so the engine can spawn monsters (P2). */
  encounters?: EncounterDef[];
  bestiary?: Record<string, StatBlock>;
}): GameState {
  const combatants: Record<string, Combatant> = {};
  for (const pc of args.party) {
    const c = pcToCombatant(pc);
    combatants[c.id] = c;
  }
  return {
    sessionId: args.sessionId,
    scenarioId: args.scenarioId,
    currentSceneId: args.startSceneId,
    combatants,
    combat: { active: false, round: 0, turnIndex: 0, order: [] },
    flags: {},
    log: [],
    spentUsd: 0,
    ...(args.adventure ? { adventure: args.adventure } : {}),
    ...(args.encounters ? { encounters: args.encounters } : {}),
    ...(args.bestiary ? { bestiary: args.bestiary } : {}),
  };
}
