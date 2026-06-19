import { describe, expect, it } from 'vitest';
import { NotImplemented, type CharacterSheet, type StatBlock } from '@mythweaver/shared';
import { Engine } from './engine.js';
import { createInitialState } from './state.js';

function goblin(): StatBlock {
  return {
    id: 'goblin',
    name: 'Goblin',
    size: 'small',
    type: 'humanoid (goblinoid)',
    armorClass: 15,
    hitPoints: { average: 7, formula: '2d6' },
    speedFt: 30,
    abilities: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
    challengeRating: 0.25,
    proficiencyBonus: 2,
    attacks: [{ name: 'Scimitar', attackBonus: 4, damage: '1d6+2', damageType: 'slashing' }],
    source: 'SRD 5.1',
  };
}

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

  it('ramp guard: the unused direct-call resolve* APIs still throw (checks go via the dice path)', () => {
    const e = newEngine();
    expect(() => e.resolveCheck({ combatantId: 'pc:fighter', ability: 'str', dc: 12, declaredTotal: 15 })).toThrow(NotImplemented);
    expect(() => e.resolveAttack({ attackerId: 'pc:fighter', targetId: 'x', attackName: 'Longsword', declaredTotal: 18 })).toThrow(NotImplemented);
  });
});

describe('Engine — P2 combat', () => {
  it('spawns a monster from a stat block at full HP', () => {
    const e = newEngine();
    const g = e.spawnCombatant(goblin());
    expect(g.kind).toBe('npc');
    expect(g.id).toBe('npc:goblin-1');
    expect(g.currentHitPoints).toBe(7);
    expect(g.armorClass).toBe(15);
    expect(e.getState().combatants['npc:goblin-1']).toBeTruthy();
  });

  it('applies damage (engine owns HP) and downs a creature at 0 HP', () => {
    const e = newEngine();
    const g = e.spawnCombatant(goblin()); // 7 HP
    expect(e.applyDamage({ targetId: g.id, amount: 4, type: 'piercing' })).toEqual({ remaining: 3, downed: false });
    const lethal = e.applyDamage({ targetId: g.id, amount: 10, type: 'piercing' });
    expect(lethal.remaining).toBe(0); // clamps, never negative
    expect(lethal.downed).toBe(true);
    const after = e.getState().combatants[g.id]!;
    expect(after.downed).toBe(true);
    expect(after.conditions).toContain('unconscious');
  });

  it('honors immunity / resistance / vulnerability', () => {
    const e = newEngine();
    const res = e.spawnCombatant({ ...goblin(), id: 'res', damageResistances: ['fire'] }); // 7 HP
    expect(e.applyDamage({ targetId: res.id, amount: 7, type: 'fire' }).remaining).toBe(4); // floor(7/2)=3 applied
    const imm = e.spawnCombatant({ ...goblin(), id: 'imm', damageImmunities: ['poison'] });
    expect(e.applyDamage({ targetId: imm.id, amount: 5, type: 'poison' }).remaining).toBe(7); // 0 applied
    const vul = e.spawnCombatant({ ...goblin(), id: 'vul', damageVulnerabilities: ['fire'] });
    expect(e.applyDamage({ targetId: vul.id, amount: 2, type: 'fire' }).remaining).toBe(3); // 2*2=4 applied
  });

  it('soaks temporary HP before real HP', () => {
    const e = newEngine();
    const f = e.getState().combatants['pc:fighter']!;
    f.temporaryHitPoints = 5;
    const r = e.applyDamage({ targetId: 'pc:fighter', amount: 8, type: 'slashing' }); // 5 soaked, 3 to HP
    expect(r.remaining).toBe(12 - 3);
    expect(e.getState().combatants['pc:fighter']!.temporaryHitPoints).toBe(0);
  });

  it('starts combat in initiative order and advances turns + rounds', () => {
    const e = newEngine();
    const g = e.spawnCombatant(goblin());
    e.startCombat([{ combatantId: 'pc:fighter', initiative: 18 }, { combatantId: g.id, initiative: 12 }]);
    const cs = e.getState().combat;
    expect(cs.active).toBe(true);
    expect(cs.round).toBe(1);
    expect(cs.order).toEqual(['pc:fighter', 'npc:goblin-1']);
    expect(e.nextTurn()).toEqual({ activeCombatantId: 'npc:goblin-1', round: 1 });
    expect(e.nextTurn()).toEqual({ activeCombatantId: 'pc:fighter', round: 2 }); // wraps -> round 2
  });

  it('adds and removes conditions', () => {
    const e = newEngine();
    e.applyCondition({ combatantId: 'pc:fighter', condition: 'prone', add: true });
    expect(e.getState().combatants['pc:fighter']!.conditions).toContain('prone');
    e.applyCondition({ combatantId: 'pc:fighter', condition: 'prone', add: false });
    expect(e.getState().combatants['pc:fighter']!.conditions).not.toContain('prone');
  });
});
