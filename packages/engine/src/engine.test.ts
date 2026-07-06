import { describe, expect, it } from 'vitest';
import { NotImplemented, type CharacterSheet, type ItemDef, type Skill, type StatBlock } from '@mythweaver/shared';
import { Engine } from './engine.js';
import { createInitialState } from './state.js';
import { derivePassive, deriveSpellSaveDc } from './derive.js';

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

  it('ramp guard: resolveAttack is still reserved (combat resolves via requestRoll/applyDamage)', () => {
    const e = newEngine();
    // resolveCheck/resolveSave are implemented as of P3e; resolveAttack stays on the ramp.
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

  it('startEncounter spawns the authored monsters and rolls initiative (1d20 + dex)', () => {
    const state = createInitialState({
      sessionId: 's',
      scenarioId: 'test',
      startSceneId: 'lair',
      party: [fighter()],
      bestiary: { goblin: goblin() },
      encounters: [{ id: 'e1', sceneId: 'lair', monsters: [{ statBlockId: 'goblin', count: 2 }] }],
    });
    const e = new Engine(state, () => 0.5); // 1d20 -> 11 for everyone; order decided by dex bonus
    const r = e.startEncounter('lair');
    expect(r.spawned).toEqual(['npc:goblin-1', 'npc:goblin-2']);
    const cs = e.getState().combat;
    expect(cs.active).toBe(true);
    expect(cs.order).toHaveLength(3); // fighter + 2 goblins
    // goblins (dex 14 -> +2 -> init 13) act before the fighter (dex 12 -> +1 -> init 12)
    expect(cs.order).toEqual(['npc:goblin-1', 'npc:goblin-2', 'pc:fighter']);
  });
});

describe('Engine — P0 state-truth (combat lifecycle + arc)', () => {
  it('auto-resolves the fight + despawns the foe when the last enemy drops', () => {
    const e = newEngine();
    const g = e.spawnCombatant(goblin()); // 7 HP
    e.startCombat([{ combatantId: 'pc:fighter', initiative: 15 }, { combatantId: g.id, initiative: 10 }]);
    expect(e.getState().combat.active).toBe(true);
    e.applyDamage({ targetId: g.id, amount: 99, type: 'slashing' });
    expect(e.getState().combat.active).toBe(false); // fight over — no phantom combat lingers
    expect(e.getState().combatants[g.id]).toBeUndefined(); // defeated foe cleared from the field
    expect(e.getState().combatants['pc:fighter']).toBeTruthy(); // PCs persist
  });

  it('keeps combat active while another foe still stands', () => {
    const e = newEngine();
    const g1 = e.spawnCombatant(goblin());
    const g2 = e.spawnCombatant(goblin());
    e.startCombat([{ combatantId: g1.id, initiative: 15 }, { combatantId: g2.id, initiative: 12 }]);
    e.applyDamage({ targetId: g1.id, amount: 99, type: 'slashing' }); // down one
    expect(e.getState().combat.active).toBe(true);
    expect(e.getState().combatants[g2.id]).toBeTruthy();
    e.applyDamage({ targetId: g2.id, amount: 99, type: 'slashing' }); // down the last
    expect(e.getState().combat.active).toBe(false);
  });

  it('endCombat clears combat + despawns all foes (non-lethal end), PCs persist', () => {
    const e = newEngine();
    const g = e.spawnCombatant(goblin());
    e.startCombat([{ combatantId: 'pc:fighter', initiative: 15 }, { combatantId: g.id, initiative: 10 }]);
    const r = e.endCombat();
    expect(r.despawned).toContain(g.id);
    expect(e.getState().combat.active).toBe(false);
    expect(e.getState().combatants[g.id]).toBeUndefined();
    expect(e.getState().combatants['pc:fighter']).toBeTruthy();
  });

  it('advanceScene stamps the beat outcome + is blocked from a terminal beat', () => {
    const state = createInitialState({
      sessionId: 's1', scenarioId: 'test', startSceneId: 'a', party: [fighter()],
      adventure: { pitch: 'p', scenes: { a: { title: 'A', summary: '', exits: ['b'] }, b: { title: 'B', summary: '', exits: [] } } },
    });
    const e = new Engine(state, () => 0.5);
    e.advanceScene('b', 'fled');
    expect(e.getState().flags['beat:a']).toBe('fled'); // outcome recorded (not just "done")
    expect(e.getState().currentSceneId).toBe('b');
    expect(() => e.advanceScene('a')).toThrow(/terminal/); // b has no exits → cannot advance
  });
});

describe('Engine — P1 Canon Ledger', () => {
  it('upserts an entity and MERGES voice/aliases/scenes across calls', () => {
    const e = newEngine();
    e.upsertEntity({ id: 'npc:edda', kind: 'npc', name: 'Edda', voice: { tic: 'wrings her hands' }, scenes: ['a'] });
    e.upsertEntity({ id: 'npc:edda', name: 'Edda', voice: { want: 'to be forgiven' }, aliases: ['the bellkeeper'], scenes: ['b'] });
    const card = e.getState().ledger!.entities['npc:edda']!;
    expect(card.voice).toEqual({ tic: 'wrings her hands', want: 'to be forgiven' });
    expect(card.aliases).toEqual(['the bellkeeper']);
    expect(card.scenes).toEqual(['a', 'b']);
  });

  it('absorbing status: a dead entity cannot be revived by a later upsert', () => {
    const e = newEngine();
    e.upsertEntity({ id: 'npc:mabon', kind: 'npc', name: 'Mabon', status: 'dead' });
    e.upsertEntity({ id: 'npc:mabon', name: 'Mabon', status: 'active' }); // attempt to un-die
    expect(e.getState().ledger!.entities['npc:mabon']!.status).toBe('dead');
  });

  it('recordFact supersedes the prior live fact for the same subject+attribute', () => {
    const e = newEngine();
    e.recordFact({ subject: 'npc:edda', attribute: 'standing', value: 'wary' });
    e.recordFact({ subject: 'npc:edda', attribute: 'standing', value: 'trusting' });
    const facts = e.getState().ledger!.facts;
    expect(facts).toHaveLength(2);
    expect(facts[0]!.supersededBy).toBe(facts[1]!.id); // old one marked, not deleted (append-only)
    const live = facts.filter((f) => !f.supersededBy);
    expect(live.map((f) => f.value)).toEqual(['trusting']);
  });

  it('plants advance monotonically (planted → echoed → fired; never backward)', () => {
    const e = newEngine();
    e.setPlant('plant:heirloom', 'a cracked locket', 'planted');
    e.setPlant('plant:heirloom', 'a cracked locket', 'fired');
    e.setPlant('plant:heirloom', 'a cracked locket', 'planted'); // attempt to go backward
    expect(e.getState().ledger!.plants['plant:heirloom']!.status).toBe('fired');
  });
});

describe('Engine — death saves & healing', () => {
  it('downs a PC to dying (not dead) and begins death saves', () => {
    const e = newEngine();
    e.applyDamage({ targetId: 'pc:fighter', amount: 100, type: 'slashing' });
    const f = e.getState().combatants['pc:fighter']!;
    expect(f.currentHitPoints).toBe(0);
    expect(f.downed).toBe(true);
    expect(f.dead).toBeFalsy();
    expect(f.deathSaves).toEqual({ successes: 0, failures: 0 });
  });

  it('a hit on a dying PC is a death-save failure; three failures = dead', () => {
    const e = newEngine();
    e.applyDamage({ targetId: 'pc:fighter', amount: 100, type: 'slashing' }); // downed, dying
    e.applyDamage({ targetId: 'pc:fighter', amount: 5, type: 'slashing' });
    e.applyDamage({ targetId: 'pc:fighter', amount: 5, type: 'slashing' });
    expect(e.getState().combatants['pc:fighter']!.deathSaves!.failures).toBe(2);
    expect(e.getState().combatants['pc:fighter']!.dead).toBeFalsy();
    e.applyDamage({ targetId: 'pc:fighter', amount: 5, type: 'slashing' });
    expect(e.getState().combatants['pc:fighter']!.dead).toBe(true);
  });

  it('healing a downed PC revives them and clears death saves', () => {
    const e = newEngine();
    e.applyDamage({ targetId: 'pc:fighter', amount: 100, type: 'slashing' });
    expect(e.heal({ targetId: 'pc:fighter', amount: 6 }).current).toBe(6);
    const f = e.getState().combatants['pc:fighter']!;
    expect(f.downed).toBeFalsy();
    expect(f.deathSaves).toBeUndefined();
    expect(f.conditions).not.toContain('unconscious');
  });

  it('heal clamps at max HP', () => {
    const e = newEngine();
    e.applyDamage({ targetId: 'pc:fighter', amount: 4, type: 'slashing' }); // 12 -> 8
    expect(e.heal({ targetId: 'pc:fighter', amount: 999 }).current).toBe(12);
  });

  it('rollDeathSave: >=10 success, nat 20 revives at 1 HP, nat 1 is two failures', () => {
    const down = (rng: () => number) => {
      const e = new Engine(createInitialState({ sessionId: 's', scenarioId: 't', startSceneId: 'x', party: [fighter()] }), rng);
      e.applyDamage({ targetId: 'pc:fighter', amount: 100, type: 'slashing' });
      return e;
    };
    expect(down(() => 0.5).rollDeathSave('pc:fighter')).toMatchObject({ status: 'dying', successes: 1, failures: 0 }); // d20=11

    const nat20 = down(() => 0.99); // d20=20
    expect(nat20.rollDeathSave('pc:fighter').status).toBe('revived');
    expect(nat20.getState().combatants['pc:fighter']!.currentHitPoints).toBe(1);

    expect(down(() => 0).rollDeathSave('pc:fighter').failures).toBe(2); // d20=1
  });
});

describe('Engine — soft arc steering (D1)', () => {
  function arcEngine() {
    const state = createInitialState({
      sessionId: 's',
      scenarioId: 't',
      startSceneId: 'a',
      party: [fighter()],
      adventure: { pitch: 'p', scenes: { a: { title: 'A', summary: '', exits: ['b'] }, b: { title: 'B', summary: '', exits: [] } } },
    });
    return new Engine(state, () => 0.5);
  }

  it('advances to a reachable scene and marks the prior beat done', () => {
    const e = arcEngine();
    expect(e.advanceScene('b')).toEqual({ scene: 'b', from: 'a' });
    expect(e.getState().currentSceneId).toBe('b');
    expect(e.getState().flags['beat:a']).toBe('done');
  });

  it('rejects an unreachable scene and leaves currentSceneId unchanged', () => {
    const e = arcEngine();
    expect(() => e.advanceScene('a')).toThrow(); // 'a' is not in a's exits (['b'])
    expect(() => e.advanceScene('zzz')).toThrow(); // unknown scene
    expect(e.getState().currentSceneId).toBe('a');
  });

  it('setArcFlag accepts namespaced keys and rejects others', () => {
    const e = arcEngine();
    e.setArcFlag('decision:tower-approach', 'stealth');
    expect(e.getState().flags['decision:tower-approach']).toBe('stealth');
    expect(() => e.setArcFlag('hp', 5)).toThrow(); // not namespaced
  });
});

function wizard(): CharacterSheet {
  return {
    id: 'wizard',
    name: 'Test Wizard',
    ancestry: 'Elf',
    className: 'Wizard',
    level: 3,
    abilities: { str: 8, dex: 14, con: 12, int: 16, wis: 11, cha: 10 },
    proficiencyBonus: 2,
    armorClass: 12,
    maxHitPoints: 18,
    speedFt: 30,
    skillProficiencies: ['arcana'],
    savingThrowProficiencies: ['int', 'wis'],
    attacks: [],
    spellcasting: { ability: 'int', spellSaveDc: 13, spellAttackBonus: 5, slots: [0, 4, 2, 0], cantrips: ['fire bolt'], prepared: ['magic missile'] },
    classResources: [{ id: 'arcaneRecovery', name: 'Arcane Recovery', max: 1, recharge: 'long' }],
    hitDice: { size: 6, count: 3 },
  };
}

function monk(): CharacterSheet {
  return {
    id: 'monk',
    name: 'Test Monk',
    ancestry: 'Human',
    className: 'Monk',
    level: 3,
    abilities: { str: 12, dex: 16, con: 13, int: 10, wis: 15, cha: 10 },
    proficiencyBonus: 2,
    armorClass: 15,
    maxHitPoints: 20,
    speedFt: 40,
    skillProficiencies: ['acrobatics'],
    savingThrowProficiencies: ['str', 'dex'],
    attacks: [{ name: 'Unarmed Strike', attackBonus: 5, damage: '1d4+3', damageType: 'bludgeoning' }],
    classResources: [{ id: 'ki', name: 'Ki', max: 3, recharge: 'short' }],
    hitDice: { size: 8, count: 3 },
  };
}

function construct(): StatBlock {
  return { ...goblin(), id: 'golem', name: 'Clay Golem', type: 'construct', conditionImmunities: ['charmed', 'frightened', 'poisoned'] };
}

function ogre(): StatBlock {
  return { ...goblin(), id: 'ogre', name: 'Ogre Mystic', hitPoints: { average: 60, formula: '8d10+16' } };
}

describe('Engine — P3a character resources & rests', () => {
  const engineWith = (party: CharacterSheet[]) => new Engine(createInitialState({ sessionId: 's', scenarioId: 't', startSceneId: 'x', party }), () => 0.5);

  it('seeds volatile pools at spawn, and a legacy sheet still gets hit dice from level/class', () => {
    const e = engineWith([wizard(), fighter()]);
    const w = e.getState().combatants['pc:wizard']!;
    expect(w.slotsRemaining).toEqual([0, 4, 2, 0]);
    expect(w.slotsMax).toEqual([0, 4, 2, 0]);
    expect(w.hitDice).toEqual({ size: 6, remaining: 3, max: 3 });
    expect(w.resources?.arcaneRecovery).toEqual({ current: 1, max: 1, recharge: 'long' });
    // The fighter fixture carries none of the new sheet fields → hit dice default to hitDieForClass × level.
    const f = e.getState().combatants['pc:fighter']!;
    expect(f.hitDice).toEqual({ size: 10, remaining: 1, max: 1 });
    expect(f.slotsRemaining).toBeUndefined();
    expect(f.resources).toBeUndefined();
  });

  it('spends a spell slot and refuses when empty; a long rest restores it (dormant-slot bug closed)', () => {
    const e = engineWith([wizard()]);
    expect(e.spendResource({ combatantId: 'pc:wizard', resource: 'slot', level: 1 }).remaining).toBe(3);
    expect(e.spendResource({ combatantId: 'pc:wizard', resource: 'slot', level: 1, amount: 3 }).remaining).toBe(0);
    expect(() => e.spendResource({ combatantId: 'pc:wizard', resource: 'slot', level: 1 })).toThrow(/no level-1 spell slot/);
    // The latent bug: slots were copied at spawn and consumed nowhere. Long rest is the recovery path.
    e.longRest();
    expect(e.getState().combatants['pc:wizard']!.slotsRemaining).toEqual([0, 4, 2, 0]);
  });

  it('spends a named class pool; short rest recharges short pools, long rest recharges all', () => {
    const e = engineWith([monk()]);
    expect(e.spendResource({ combatantId: 'pc:monk', resource: 'ki', amount: 2 }).remaining).toBe(1);
    e.shortRest({ combatantId: 'pc:monk' });
    expect(e.getState().combatants['pc:monk']!.resources!.ki!.current).toBe(3);
    // A long-rest pool is untouched by a short rest, restored by a long rest.
    const e2 = engineWith([wizard()]);
    e2.spendResource({ combatantId: 'pc:wizard', resource: 'arcaneRecovery' });
    e2.shortRest({ combatantId: 'pc:wizard' });
    expect(e2.getState().combatants['pc:wizard']!.resources!.arcaneRecovery!.current).toBe(0);
    e2.longRest();
    expect(e2.getState().combatants['pc:wizard']!.resources!.arcaneRecovery!.current).toBe(1);
  });

  it('short rest spends hit dice to heal by the declared total; long rest refunds half + full HP', () => {
    const e = engineWith([wizard()]);
    e.applyDamage({ targetId: 'pc:wizard', amount: 10, type: 'fire' }); // 18 -> 8
    const r = e.shortRest({ combatantId: 'pc:wizard', spendHitDice: 2, rolledTotal: 7 });
    expect(r.hpRestored).toBe(7); // 8 -> 15
    expect(r.hitDiceRemaining).toBe(1);
    expect(e.getState().combatants['pc:wizard']!.currentHitPoints).toBe(15);
    // Over-spending hit dice throws with no partial mutation.
    expect(() => e.shortRest({ combatantId: 'pc:wizard', spendHitDice: 5, rolledTotal: 3 })).toThrow(/hit dice/);
    expect(e.getState().combatants['pc:wizard']!.hitDice!.remaining).toBe(1);
    e.longRest();
    expect(e.getState().combatants['pc:wizard']!.hitDice!.remaining).toBe(2); // 1 + max(1, floor(3/2))
    expect(e.getState().combatants['pc:wizard']!.currentHitPoints).toBe(18); // full HP
  });

  it('honors condition immunity (a construct cannot be charmed) but takes normal conditions', () => {
    const e = engineWith([fighter()]);
    const g = e.spawnCombatant(construct());
    e.applyCondition({ combatantId: g.id, condition: 'charmed', add: true });
    expect(e.getState().combatants[g.id]!.conditions).not.toContain('charmed');
    e.applyCondition({ combatantId: g.id, condition: 'prone', add: true });
    expect(e.getState().combatants[g.id]!.conditions).toContain('prone');
  });

  it('clamps exhaustion 0–6 (6 kills a PC); a long rest eases it by 1', () => {
    const e = engineWith([fighter()]);
    expect(e.setExhaustion({ combatantId: 'pc:fighter', level: 9 }).exhaustion).toBe(6);
    expect(e.getState().combatants['pc:fighter']!.dead).toBe(true);
    const e2 = engineWith([fighter()]);
    e2.setExhaustion({ combatantId: 'pc:fighter', level: 3 });
    e2.longRest();
    expect(e2.getState().combatants['pc:fighter']!.exhaustion).toBe(2);
  });

  it('grants and spends inspiration; spending without any throws', () => {
    const e = engineWith([fighter()]);
    expect(() => e.spendInspiration({ combatantId: 'pc:fighter' })).toThrow(/no inspiration/);
    e.grantInspiration({ combatantId: 'pc:fighter' });
    expect(e.getState().combatants['pc:fighter']!.inspiration).toBe(true);
    expect(e.spendInspiration({ combatantId: 'pc:fighter' }).spent).toBe(true);
    expect(e.getState().combatants['pc:fighter']!.inspiration).toBe(false);
  });
});

describe('Engine — P3b concentration', () => {
  const engineWith = (party: CharacterSheet[]) => new Engine(createInitialState({ sessionId: 's', scenarioId: 't', startSceneId: 'x', party }), () => 0.5);

  it('holds one concentration spell at a time (a new one drops the old)', () => {
    const e = engineWith([wizard()]);
    e.startConcentration({ combatantId: 'pc:wizard', spell: 'Bless' });
    e.startConcentration({ combatantId: 'pc:wizard', spell: 'Haste' });
    expect(e.getState().combatants['pc:wizard']!.concentratingOn).toEqual({ spell: 'Haste' });
  });

  it('a hit while concentrating returns a Con-save DC of max(10, half the damage)', () => {
    const e = engineWith([fighter()]);
    const o = e.spawnCombatant(ogre()); // 60 HP, survives both hits
    e.startConcentration({ combatantId: o.id, spell: 'Hold Person' });
    expect(e.applyDamage({ targetId: o.id, amount: 9, type: 'slashing' }).concentration).toEqual({ dc: 10, spell: 'Hold Person' }); // floor(9/2)=4 → 10
    expect(e.applyDamage({ targetId: o.id, amount: 30, type: 'fire' }).concentration).toEqual({ dc: 15, spell: 'Hold Person' }); // floor(30/2)=15
  });

  it('being knocked to 0 HP ends concentration outright (no save offered)', () => {
    const e = engineWith([wizard()]);
    e.startConcentration({ combatantId: 'pc:wizard', spell: 'Bless' });
    const r = e.applyDamage({ targetId: 'pc:wizard', amount: 25, type: 'necrotic' }); // 18 → 0, downed
    expect(r.downed).toBe(true);
    expect(r.concentration).toBeUndefined();
    expect(e.getState().combatants['pc:wizard']!.concentratingOn).toBeUndefined();
  });

  it('breakConcentration ends the spell and is idempotent; a non-concentrator has nothing to break', () => {
    const e = engineWith([wizard()]);
    e.startConcentration({ combatantId: 'pc:wizard', spell: 'Hex' });
    expect(e.breakConcentration({ combatantId: 'pc:wizard' }).was).toBe('Hex');
    expect(e.breakConcentration({ combatantId: 'pc:wizard' }).was).toBe(null);
    // a hit on a non-concentrating combatant carries no concentration prompt
    expect(e.applyDamage({ targetId: 'pc:wizard', amount: 3, type: 'cold' }).concentration).toBeUndefined();
  });
});

describe('Engine — P3c progression (XP + leveling)', () => {
  const engineWith = (party: CharacterSheet[]) => new Engine(createInitialState({ sessionId: 's', scenarioId: 't', startSceneId: 'x', party }), () => 0.5);

  it('seeds a character progression record and awards XP without auto-leveling', () => {
    const e = engineWith([fighter()]);
    expect(e.getState().characters!['pc:fighter']).toEqual({ xp: 0, level: 1, currency: { cp: 0, sp: 0, gp: 0 }, items: [], attunedInstanceIds: [], equipped: {} });
    expect(e.awardXp({ combatantId: 'pc:fighter', amount: 100 })).toEqual({ xp: 100, level: 1, levelUpAvailable: false });
    expect(e.awardXp({ combatantId: 'pc:fighter', amount: 250 })).toEqual({ xp: 350, level: 1, levelUpAvailable: true }); // 350 ≥ 300
    expect(e.getState().characters!['pc:fighter']!.level).toBe(1); // still 1 — awardXp never levels
  });

  it('levels up by one when XP allows: HP + hit dice + proficiency grow, ASI flagged not applied', () => {
    const e = engineWith([fighter()]); // L1, d10 hit die, CON 14 (+2), 12 HP
    expect(() => e.levelUp({ combatantId: 'pc:fighter' })).toThrow(/XP for level 2/);
    e.awardXp({ combatantId: 'pc:fighter', amount: 300 });
    expect(e.levelUp({ combatantId: 'pc:fighter' })).toEqual({ level: 2, maxHitPoints: 20, hitDiceRemaining: 2, proficiencyBonus: 2, asiDue: false, hpGained: 8 }); // avg d10 (6) + CON (2)
    const c = e.getState().combatants['pc:fighter']!;
    expect(c.currentHitPoints).toBe(20);
    expect(c.hitDice).toEqual({ size: 10, remaining: 2, max: 2 });
  });

  it('level-up HP can use a rolled hit die instead of the average', () => {
    const e = engineWith([fighter()]);
    e.awardXp({ combatantId: 'pc:fighter', amount: 300 });
    expect(e.levelUp({ combatantId: 'pc:fighter', hpMode: 'roll', rolledTotal: 9 }).hpGained).toBe(11); // 9 + CON 2
    expect(e.getState().combatants['pc:fighter']!.maxHitPoints).toBe(23);
  });

  it('milestone leveling jumps multiple levels (avg HP), syncs XP, and flags a crossed ASI level', () => {
    const e = engineWith([fighter()]); // L1 → L4
    const r = e.setMilestoneLevel({ combatantId: 'pc:fighter', level: 4 });
    expect(r).toEqual({ level: 4, maxHitPoints: 36, hitDiceRemaining: 4, proficiencyBonus: 2, asiDue: true, hpGained: 24 }); // 3 × (avg 6 + CON 2)
    expect(e.getState().characters!['pc:fighter']!.xp).toBe(2700); // synced to the L4 threshold
    expect(() => e.setMilestoneLevel({ combatantId: 'pc:fighter', level: 3 })).toThrow(/already level 4/);
  });
});

const TEST_CATALOG: Record<string, ItemDef> = {
  'leather-armor': { id: 'leather-armor', name: 'Leather Armor', category: 'armor', slot: 'armor', weightLb: 10, costGp: 10, acBase: 11 },
  'plate-armor': { id: 'plate-armor', name: 'Plate Armor', category: 'armor', slot: 'armor', weightLb: 65, costGp: 1500, acBase: 18, acDexCap: 0 },
  shield: { id: 'shield', name: 'Shield', category: 'shield', slot: 'shield', weightLb: 6, costGp: 10, acBonus: 2 },
  torch: { id: 'torch', name: 'Torch', category: 'gear', weightLb: 1, costGp: 0.01 },
  'ring-protection': { id: 'ring-protection', name: 'Ring of Protection', category: 'ring', weightLb: 0, magic: true, requiresAttunement: true, acBonus: 1 },
  'cloak-elvenkind': { id: 'cloak-elvenkind', name: 'Cloak of Elvenkind', category: 'wondrous', weightLb: 1, magic: true, requiresAttunement: true },
  'boots-striding': { id: 'boots-striding', name: 'Boots of Striding', category: 'wondrous', weightLb: 1, magic: true, requiresAttunement: true },
  'belt-giant': { id: 'belt-giant', name: 'Belt of Giant Strength', category: 'wondrous', weightLb: 1, magic: true, requiresAttunement: true },
};

describe('Engine — P3d economy + inventory + equipment', () => {
  const engineWith = (party: CharacterSheet[]) => new Engine(createInitialState({ sessionId: 's', scenarioId: 't', startSceneId: 'x', party, itemCatalog: TEST_CATALOG }), () => 0.5);

  it('buys with exact change, refuses when unaffordable, and sells for half', () => {
    const e = engineWith([fighter()]);
    e.getState().characters!['pc:fighter']!.currency = { cp: 0, sp: 0, gp: 100 };
    expect(e.buyItem({ combatantId: 'pc:fighter', itemDefId: 'leather-armor' }).currency).toEqual({ gp: 90, sp: 0, cp: 0 });
    expect(() => e.buyItem({ combatantId: 'pc:fighter', itemDefId: 'plate-armor' })).toThrow(/afford/);
    // change-making across cp/sp/gp: a 1-cp torch off 90 gp → 89 gp 9 sp 9 cp
    expect(e.buyItem({ combatantId: 'pc:fighter', itemDefId: 'torch' }).currency).toEqual({ gp: 89, sp: 9, cp: 9 });
    // sell the leather back for half its 10 gp value (+5 gp)
    expect(e.sellItem({ combatantId: 'pc:fighter', itemDefId: 'leather-armor' }).currency).toEqual({ gp: 94, sp: 9, cp: 9 });
  });

  it('equipping armor + shield recomputes AC; unequipping falls back to the sheet AC', () => {
    const e = engineWith([fighter()]); // sheet AC 16, DEX 12 (+1)
    const plate = e.addItem({ combatantId: 'pc:fighter', itemDefId: 'plate-armor' }).instanceIds[0]!;
    const shield = e.addItem({ combatantId: 'pc:fighter', itemDefId: 'shield' }).instanceIds[0]!;
    expect(e.equipItem({ combatantId: 'pc:fighter', instanceId: plate }).armorClass).toBe(18); // 18 + min(1,0 cap)
    expect(e.equipItem({ combatantId: 'pc:fighter', instanceId: shield }).armorClass).toBe(20); // + 2 shield
    expect(e.getState().combatants['pc:fighter']!.armorClass).toBe(20);
    e.unequipItem({ combatantId: 'pc:fighter', slot: 'armor' });
    e.unequipItem({ combatantId: 'pc:fighter', slot: 'shield' });
    expect(e.getState().combatants['pc:fighter']!.armorClass).toBe(16); // nothing equipped → sheet fallback
  });

  it('enforces identify-first and the hard cap of 3 attuned items', () => {
    const e = engineWith([fighter()]);
    const ids = ['ring-protection', 'cloak-elvenkind', 'boots-striding', 'belt-giant'].map((d) => e.addItem({ combatantId: 'pc:fighter', itemDefId: d }).instanceIds[0]!);
    expect(() => e.attuneItem({ combatantId: 'pc:fighter', instanceId: ids[0]! })).toThrow(/identified/);
    for (const id of ids) e.identifyItem({ combatantId: 'pc:fighter', instanceId: id });
    e.attuneItem({ combatantId: 'pc:fighter', instanceId: ids[0]! });
    e.attuneItem({ combatantId: 'pc:fighter', instanceId: ids[1]! });
    e.attuneItem({ combatantId: 'pc:fighter', instanceId: ids[2]! });
    expect(() => e.attuneItem({ combatantId: 'pc:fighter', instanceId: ids[3]! })).toThrow(/3 items/);
    expect(e.getState().characters!['pc:fighter']!.attunedInstanceIds).toHaveLength(3);
  });

  it('gear stacks vs instances, and removing an item detaches it from equip/attune', () => {
    const e = engineWith([fighter()]);
    e.addItem({ combatantId: 'pc:fighter', itemDefId: 'torch', qty: 3 });
    e.addItem({ combatantId: 'pc:fighter', itemDefId: 'torch', qty: 2 });
    const torches = e.getState().characters!['pc:fighter']!.items.filter((i) => i.defId === 'torch');
    expect(torches).toHaveLength(1); // stacked
    expect(torches[0]!.qty).toBe(5);
    const shield = e.addItem({ combatantId: 'pc:fighter', itemDefId: 'shield' }).instanceIds[0]!;
    e.equipItem({ combatantId: 'pc:fighter', instanceId: shield });
    e.removeItem({ combatantId: 'pc:fighter', instanceId: shield }); // detaches from the slot
    expect(e.getState().characters!['pc:fighter']!.equipped.shield).toBeUndefined();
  });

  it('revive brings back a dead character; heal cannot', () => {
    const e = engineWith([fighter()]);
    e.setExhaustion({ combatantId: 'pc:fighter', level: 6 }); // exhaustion 6 = death
    expect(e.getState().combatants['pc:fighter']!.dead).toBe(true);
    expect(() => e.heal({ targetId: 'pc:fighter', amount: 5 })).toThrow(/dead/);
    expect(e.revive({ combatantId: 'pc:fighter', hpRestored: 8 }).current).toBe(8);
    const c = e.getState().combatants['pc:fighter']!;
    expect(c.dead).toBe(false);
    expect(c.currentHitPoints).toBe(8);
  });
});

describe('Engine — P3e checks + saves (engine owns the +N)', () => {
  const engineWith = (party: CharacterSheet[]) => new Engine(createInitialState({ sessionId: 's', scenarioId: 't', startSceneId: 'x', party }), () => 0.5);

  it('derives a check modifier across all four proficiency tiers + exhaustion', () => {
    const e = engineWith([fighter()]); // STR 16 (+3), athletics proficient; DEX 12 (+1); prof 2
    expect(e.checkModifier({ combatantId: 'pc:fighter', skill: 'athletics', ability: 'str' })).toBe(5); // +3 +prof
    expect(e.checkModifier({ combatantId: 'pc:fighter', skill: 'acrobatics', ability: 'dex' })).toBe(1); // +1, no prof
    expect(e.checkModifier({ combatantId: 'pc:fighter', ability: 'str' })).toBe(3); // raw STR check
    const s: CharacterSheet = { ...fighter(), skillExpertise: ['athletics'] as Skill[], skillHalfProficiency: ['stealth'] as Skill[] };
    const e2 = engineWith([s]);
    expect(e2.checkModifier({ combatantId: 'pc:fighter', skill: 'athletics', ability: 'str' })).toBe(7); // +3 + 2×prof
    expect(e2.checkModifier({ combatantId: 'pc:fighter', skill: 'stealth', ability: 'dex' })).toBe(2); // +1 + floor(prof×0.5)
    e2.setExhaustion({ combatantId: 'pc:fighter', level: 2 }); // −2 per level
    expect(e2.checkModifier({ combatantId: 'pc:fighter', skill: 'athletics', ability: 'str' })).toBe(3); // 7 − 4
  });

  it('resolveCheck adds the engine modifier to the raw d20 and rules vs the DC', () => {
    const e = engineWith([fighter()]); // athletics +5
    expect(e.resolveCheck({ combatantId: 'pc:fighter', skill: 'athletics', ability: 'str', dc: 15, d20: 10 })).toEqual({ total: 15, dc: 15, success: true });
    expect(e.resolveCheck({ combatantId: 'pc:fighter', skill: 'athletics', ability: 'str', dc: 15, d20: 9 }).success).toBe(false);
    expect(e.resolveCheck({ combatantId: 'pc:fighter', skill: 'athletics', ability: 'str', dc: 15, d20: 20 }).critical).toBe('hit');
  });

  it('derives save modifiers (proficiency adds) and resolves saves', () => {
    const e = engineWith([fighter()]); // saves: STR, CON proficient; prof 2
    expect(e.saveModifier({ combatantId: 'pc:fighter', ability: 'con' })).toBe(4); // CON +2 + prof
    expect(e.saveModifier({ combatantId: 'pc:fighter', ability: 'int' })).toBe(0); // INT +0, not proficient
    expect(e.resolveSave({ combatantId: 'pc:fighter', ability: 'con', dc: 13, d20: 9 })).toEqual({ total: 13, dc: 13, success: true });
  });

  it('spell save DC + passives recompute from the current level', () => {
    const e = engineWith([wizard()]); // INT 16 (+3), L3 (prof 2) → 8+2+3
    expect(deriveSpellSaveDc(wizard(), e.getState().characters!['pc:wizard'])).toBe(13);
    e.getState().characters!['pc:wizard']!.level = 5; // prof 3 → DC 14
    expect(deriveSpellSaveDc(wizard(), e.getState().characters!['pc:wizard'])).toBe(14);
    const ef = engineWith([fighter()]); // WIS 11 (+0), perception NOT proficient → passive 10
    expect(derivePassive(fighter(), ef.getState().characters!['pc:fighter'], 'perception')).toBe(10);
  });

  it('findCombatantId resolves the loose ids the DM invents (exact / prefixed name / bare name / refId)', () => {
    const e = engineWith([fighter()]); // real id "pc:fighter", name "Test Fighter"
    expect(e.findCombatantId('pc:fighter')).toBe('pc:fighter'); // exact
    expect(e.findCombatantId('test fighter')).toBe('pc:fighter'); // bare name (case-insensitive)
    expect(e.findCombatantId('pc:Test Fighter')).toBe('pc:fighter'); // "pc:"-prefixed name
    expect(e.findCombatantId('fighter')).toBe('pc:fighter'); // refId
    expect(e.findCombatantId('nobody')).toBeUndefined();
  });
});

describe('Engine — P3f caster completeness (rituals + prepared limits)', () => {
  const engineWith = (party: CharacterSheet[]) => new Engine(createInitialState({ sessionId: 's', scenarioId: 't', startSceneId: 'x', party }), () => 0.5);
  const caster = (): CharacterSheet => ({ ...wizard(), spellcasting: { ...wizard().spellcasting!, rituals: ['Detect Magic', 'Identify'] } });

  it('caps prepared spells at (ability mod + level) and re-prepares within it', () => {
    const e = engineWith([caster()]); // INT 16 (+3), L3 → cap 6
    const six = ['Magic Missile', 'Shield', 'Sleep', 'Detect Magic', 'Mage Armor', 'Fog Cloud'];
    expect(e.prepareSpells({ combatantId: 'pc:wizard', prepared: six })).toEqual({ prepared: six, max: 6 });
    expect(e.getState().combatants['pc:wizard']!.preparedSpells).toEqual(six);
    expect(() => e.prepareSpells({ combatantId: 'pc:wizard', prepared: [...six, 'Web'] })).toThrow(/at most 6/);
  });

  it('casts a ritual with no slot spent; refuses a non-ritual spell', () => {
    const e = engineWith([caster()]);
    const before = [...e.getState().combatants['pc:wizard']!.slotsRemaining!];
    expect(e.castRitual({ combatantId: 'pc:wizard', spell: 'detect magic' })).toEqual({ ritual: true, spell: 'detect magic' });
    expect(e.getState().combatants['pc:wizard']!.slotsRemaining).toEqual(before); // no slot debited
    expect(() => e.castRitual({ combatantId: 'pc:wizard', spell: 'Fireball' })).toThrow(/can't be cast as a ritual/);
  });
});
