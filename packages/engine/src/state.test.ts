import { describe, expect, it } from 'vitest';
import type { CharacterSheet } from '@mythweaver/shared';
import { createInitialState } from './state.js';

function pc(): CharacterSheet {
  return {
    id: 'pip',
    name: 'Pip',
    ancestry: 'Halfling',
    className: 'Rogue',
    level: 1,
    abilities: { str: 8, dex: 17, con: 13, int: 12, wis: 10, cha: 15 },
    proficiencyBonus: 2,
    armorClass: 14,
    maxHitPoints: 9,
    speedFt: 25,
    skillProficiencies: ['stealth'],
    savingThrowProficiencies: ['dex', 'int'],
    attacks: [{ name: 'Shortbow', attackBonus: 5, damage: '1d6+3', damageType: 'piercing' }],
  };
}

describe('GameState', () => {
  it('builds combatants from the party at full HP', () => {
    const s = createInitialState({ sessionId: 's', scenarioId: 'x', startSceneId: 'start', party: [pc()] });
    expect(s.combatants['pc:pip']?.currentHitPoints).toBe(9);
    expect(s.combat.active).toBe(false);
  });

  it('survives a JSON serialize/parse round-trip (DB persistence, spec §7)', () => {
    const s = createInitialState({ sessionId: 's', scenarioId: 'x', startSceneId: 'start', party: [pc()] });
    s.flags.metBellkeeper = true;
    s.log.push({ seq: 1, kind: 'player', text: 'hello', data: { speakerId: 'Pip' } });
    s.pendingTurn = {
      rollRequestId: 'roll-1',
      rollToolUseId: 'tu1',
      rollExpr: '1d20+5',
      rollReason: 'check',
      resolvedToolResults: [{ toolUseId: 'g1', content: '{}' }],
      history: [{ role: 'user', content: 'hi' }],
    };
    const round = JSON.parse(JSON.stringify(s));
    expect(round).toEqual(s);
  });
});
