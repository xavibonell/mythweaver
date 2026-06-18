import { describe, expect, it } from 'vitest';
import { NotImplemented, type CharacterSheet } from '@mythweaver/shared';
import { Engine } from './engine.js';
import { createInitialState } from './state.js';

function fighter(): CharacterSheet {
  return {
    id: 'fighter',
    name: 'Test Fighter',
    ancestry: 'Human',
    className: 'Fighter',
    level: 1,
    abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 11, cha: 9 },
    proficiencyBonus: 2,
    armorClass: 16,
    maxHitPoints: 12,
    speedFt: 30,
    skillProficiencies: ['athletics'],
    savingThrowProficiencies: ['str', 'con'],
    attacks: [{ name: 'Longsword', attackBonus: 5, damage: '1d8+3', damageType: 'slashing' }],
  };
}

function newEngine() {
  const state = createInitialState({
    sessionId: 's1',
    scenarioId: 'test',
    startSceneId: 'start',
    party: [fighter()],
  });
  return new Engine(state, () => 0.5);
}

describe('Engine — P0', () => {
  it('loads party as combatants at full HP', () => {
    const e = newEngine();
    const state = e.getState();
    const c = state.combatants['pc:fighter'];
    expect(c?.currentHitPoints).toBe(12);
    expect(c?.armorClass).toBe(16);
  });

  it('round-trips a roll request -> in-range submission', () => {
    const e = newEngine();
    const rr = e.requestRoll({ expr: '1d20+5', reason: 'Athletics check to climb', dc: 12 });
    const res = e.submitRoll(rr.id, 17);
    expect(res.validation).toBe('in_range');
    expect(res.accepted).toBe(true);
  });

  it('flags an impossible declaration and keeps the request open', () => {
    const e = newEngine();
    const rr = e.requestRoll({ expr: '1d20+5', reason: 'attack' });
    const bad = e.submitRoll(rr.id, 99);
    expect(bad.accepted).toBe(false);
    // request still pending -> can be re-submitted with a legal value
    const good = e.submitRoll(rr.id, 20);
    expect(good.accepted).toBe(true);
  });

  it('logs engine events for audit', () => {
    const e = newEngine();
    const rr = e.requestRoll({ expr: '1d20', reason: 'perception' });
    e.submitRoll(rr.id, 10);
    expect(e.getState().log.length).toBeGreaterThanOrEqual(2);
  });

  it('enforces the §4.2 ramp: P1+ mechanics are not yet engine-resolved', () => {
    const e = newEngine();
    expect(() => e.resolveCheck({ combatantId: 'pc:fighter', ability: 'str', dc: 12, declaredTotal: 15 })).toThrow(NotImplemented);
    expect(() => e.applyDamage({ targetId: 'pc:fighter', amount: 3, type: 'slashing' })).toThrow(NotImplemented);
  });
});
