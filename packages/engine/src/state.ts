/** GameState construction helpers (the engine is the sole mutator — spec §4.1). */

import { classToSpriteTag, type AdventureContext, type CharacterSheet, type CharacterState, type Combatant, type EncounterDef, type GameState, type ItemDef, type StatBlock } from '@mythweaver/shared';
import { abilityMod } from './derive.js';
import { hitDieForClass, XP_THRESHOLDS } from './progression.js';

export function pcToCombatant(pc: CharacterSheet): Combatant {
  // Character-engine volatile pools (P3a): seed the live resources the table spends + recovers, from the
  // sheet's spec. Every single-class PC has hit dice = level; slotsMax pairs with slotsRemaining so a long
  // rest can restore it; class resources start full. Absent sheet fields fall back to level/class defaults,
  // so a legacy pregen still produces a valid combatant.
  const hitDieSize = pc.hitDice?.size ?? hitDieForClass(pc.className);
  const hitDiceCount = pc.hitDice?.count ?? pc.level;
  const resources = Object.fromEntries((pc.classResources ?? []).map((r) => [r.id, { current: r.max, max: r.max, recharge: r.recharge }]));
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
    ...(pc.spellcasting ? { slotsRemaining: [...pc.spellcasting.slots], slotsMax: [...pc.spellcasting.slots], preparedSpells: [...pc.spellcasting.prepared] } : {}),
    ...(hitDiceCount > 0 ? { hitDice: { size: hitDieSize, remaining: hitDiceCount, max: hitDiceCount } } : {}),
    ...(Object.keys(resources).length ? { resources } : {}),
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
    ...(sb.conditionImmunities ? { conditionImmunities: [...sb.conditionImmunities] } : {}),
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
  /** The item catalog ItemRefs point into (P3d). */
  itemCatalog?: Record<string, ItemDef>;
}): GameState {
  const combatants: Record<string, Combatant> = {};
  const characters: Record<string, CharacterState> = {};
  const sheets: Record<string, CharacterSheet> = {};
  for (const pc of args.party) {
    const c = pcToCombatant(pc);
    combatants[c.id] = c;
    // Progression home (P3c): xp seeded at the threshold for the starting level so awardXp/levelForXp
    // stay consistent (a level-3 pregen sits at 900 XP, needs 2700 for level 4). Sheet stored read-only
    // as the immutable spec the engine derives from (con mod for level-up HP, abilities/profs for checks).
    const sc = pc.startingCurrency ?? {};
    characters[c.id] = {
      xp: XP_THRESHOLDS[Math.max(1, Math.min(20, pc.level))] ?? 0,
      level: pc.level,
      currency: { cp: sc.cp ?? 0, sp: sc.sp ?? 0, gp: sc.gp ?? 0 },
      items: (pc.carriedItems ?? []).map((r) => ({ ...r })),
      attunedInstanceIds: [],
      equipped: {},
    };
    sheets[c.id] = pc;
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
    characters,
    sheets,
    ...(args.adventure ? { adventure: args.adventure } : {}),
    ...(args.encounters ? { encounters: args.encounters } : {}),
    ...(args.bestiary ? { bestiary: args.bestiary } : {}),
    ...(args.itemCatalog ? { itemCatalog: args.itemCatalog } : {}),
  };
}
