/** GameState construction helpers (the engine is the sole mutator — spec §4.1). */

import { classToSpriteTag, type AdventureContext, type CharacterSheet, type Combatant, type GameState } from '@mythweaver/shared';

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
    ...(pc.spellcasting ? { slotsRemaining: [...pc.spellcasting.slots] } : {}),
  };
}

export function createInitialState(args: {
  sessionId: string;
  scenarioId: string;
  startSceneId: string;
  party: CharacterSheet[];
  adventure?: AdventureContext;
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
  };
}
