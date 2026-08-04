import { describe, expect, it } from 'vitest';
import type { CharacterSheet, GameState, MapObject, SceneMap, StatBlock } from '@mythweaver/shared';
import { Engine, createInitialState } from './index.js';
import { xpForCr } from './progression.js';

/**
 * COMBAT MODE C0 — the turn spine (docs/COMBAT-MODE.md §4.1).
 *
 * These tests are the falsifier for the whole slice: a scripted round proves spend → refuse →
 * endTurn → wrap → refresh, and a scripted kill proves XP → bodies → attribution. Everything here is
 * deterministic (seeded RNG), no LLM anywhere.
 */

const COLS = 20, ROWS = 20;
function arena(extra: MapObject[] = []): SceneMap {
  const tiles = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => 'grass'));
  const walkable = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => true));
  return {
    locationId: 'loc:arena', seed: 1, biome: 'village', lighting: 'day', grammar: 'town-square',
    grid: { cols: COLS, rows: ROWS, feetPerTile: 5 }, tiles, walkable,
    objects: [
      { id: 'pc-1', kind: 'actor', role: 'pc', tag: 'knight', name: 'Aldric', col: 5, row: 5, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
      { id: 'pc-2', kind: 'actor', role: 'pc', tag: 'wizard', name: 'Elara', col: 6, row: 5, footprint: { w: 1, h: 1 }, facing: 'down', visible: true },
      ...extra,
    ],
    ambiance: [], entrances: [], roofs: [],
  } as unknown as SceneMap;
}

const sheet = (id: string, name: string): CharacterSheet => ({
  id, name, ancestry: 'Human', className: 'Fighter', level: 1,
  abilities: { str: 16, dex: 14, con: 15, int: 11, wis: 13, cha: 9 },
  proficiencyBonus: 2, armorClass: 16, maxHitPoints: 12, speedFt: 30,
  skillProficiencies: [], savingThrowProficiencies: ['str'], attacks: [],
});

const BANDIT: StatBlock = {
  id: 'bandit', name: 'Bandit', size: 'medium', type: 'humanoid', armorClass: 12,
  hitPoints: { average: 11, formula: '2d8+2' }, speedFt: 30,
  abilities: { str: 11, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
  challengeRating: 0.125, proficiencyBonus: 2,
  attacks: [{ name: 'Scimitar', attackBonus: 3, damage: '1d6+1', damageType: 'slashing' }],
  source: 'SRD 5.1',
};

function fight(): { engine: Engine; state: GameState } {
  const state = createInitialState({
    sessionId: 's', scenarioId: 't', startSceneId: 'x',
    party: [sheet('pc-1', 'Aldric'), sheet('pc-2', 'Elara')],
    bestiary: { bandit: BANDIT },
    encounters: [{ id: 'e1', sceneId: 'x', monsters: [{ statBlockId: 'bandit', count: 2 }] }],
  });
  state.world = { currentLocationId: 'loc:arena', locations: { 'loc:arena': arena() }, links: [] } as GameState['world'];
  const engine = new Engine(state, () => 0.5); // seeded: every d20 = 11, every d6 = 4
  return { engine, state };
}

/** startEncounter with a fixed-RNG engine gives a deterministic order; find who leads. */
const startFight = (engine: Engine, state: GameState) => {
  engine.startEncounter('x');
  return state.combat.order.map((id) => state.combatants[id]!);
};

describe('the turn spine — spend, refuse, endTurn, wrap, refresh', () => {
  it('seeds every fighter\'s economy at combat start', () => {
    const { engine, state } = fight();
    startFight(engine, state);
    for (const id of state.combat.order) {
      expect(state.combatants[id]!.actionEconomy).toMatchObject({ action: true, bonusAction: true, movementRemainingFt: 30 });
    }
  });

  it('turnGuard: block members may act, everyone else is refused; outside combat all may', () => {
    const { engine, state } = fight();
    expect(engine.turnGuard('pc-1')).toEqual({ ok: true }); // no combat yet
    startFight(engine, state);
    const active = state.combat.order[0]!;
    // seeded order = [pc, pc, npc, npc]: the adjacent PC is a BLOCK member (C3), the bandit is not.
    const blockAlly = state.combat.order[1]!;
    const outsider = state.combat.order.find((id) => state.combatants[id]!.kind === 'npc')!;
    expect(engine.turnGuard(active)).toEqual({ ok: true });
    expect(engine.turnGuard(blockAlly).ok).toBe(true);
    const refused = engine.turnGuard(outsider);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.activeId).toBe(active);
  });

  it('an action spends ONCE; the second swing is refused with a narratable reason', () => {
    const { engine, state } = fight();
    startFight(engine, state);
    const active = state.combat.order[0]!;
    expect(engine.spendAction(active).ok).toBe(true);
    const again = engine.spendAction(active);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toContain('already used their action');
  });

  it('movement is a budget: overdraw refused with the shortfall named, spend decrements', () => {
    const { engine, state } = fight();
    startFight(engine, state);
    const active = state.combat.order[0]!;
    const over = engine.spendMovement(active, 40);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toContain('40 ft');
    const okSpend = engine.spendMovement(active, 20);
    expect(okSpend).toMatchObject({ ok: true, remainingFt: 10 });
  });

  it('dash trades the action for another helping of speed', () => {
    const { engine, state } = fight();
    startFight(engine, state);
    const active = state.combat.order[0]!;
    engine.spendMovement(active, 30);
    expect(engine.dash(active)).toMatchObject({ ok: true, movementRemainingFt: 30 });
    expect(engine.spendAction(active).ok).toBe(false); // the dash WAS the action
  });

  it('endTurn advances, wraps the round, and REFRESHES the new active\'s economy', () => {
    const { engine, state } = fight();
    const order = startFight(engine, state);
    for (let i = 0; i < order.length; i++) {
      const active = state.combat.order[state.combat.turnIndex]!;
      engine.spendAction(active);
      const end = engine.endTurn(active);
      expect(end.ok).toBe(true);
    }
    // Full lap: back to the first fighter, round 2, budget fresh.
    expect(state.combat.round).toBe(2);
    const first = state.combatants[state.combat.order[state.combat.turnIndex]!]!;
    expect(first.actionEconomy!.action).toBe(true);
  });

  it('endTurn refuses outsiders and refuses while a roll hangs in the air', () => {
    const { engine, state } = fight();
    startFight(engine, state);
    const outsider = state.combat.order.find((id) => state.combatants[id]!.kind === 'npc')!;
    expect(engine.endTurn(outsider).ok).toBe(false);
    const active = state.combat.order[0]!;
    state.pendingTurn = { rollRequestId: 'r1' } as GameState['pendingTurn'];
    const blocked = engine.endTurn(active);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toContain('roll is still pending');
  });

  it('nextTurn skips a downed MONSTER (a dying PC stops the order — see the C3 suite)', () => {
    const { engine, state } = fight();
    startFight(engine, state);
    // seeded order = [pc, pc, npc, npc]: down the FIRST bandit; both PCs end; the order must land
    // on the second bandit, skipping the downed one.
    const npcs = state.combat.order.filter((id) => state.combatants[id]!.kind === 'npc');
    state.combatants[npcs[0]!]!.downed = true;
    engine.endTurn(state.combat.order[0]!);
    engine.endTurn(state.combat.order[1]!);
    expect(state.combat.order[state.combat.turnIndex]).toBe(npcs[1]);
  });

  it('removeFromInitiative keeps the index on the SAME active fighter', () => {
    const { engine, state } = fight();
    startFight(engine, state);
    engine.endTurn(state.combat.order[0]!); // active is now index 1
    const activeId = state.combat.order[1]!;
    engine.removeFromInitiative(state.combat.order[0]!); // someone EARLIER leaves
    expect(state.combat.order[state.combat.turnIndex]).toBe(activeId);
  });
});

describe('the fight pays out — attribution, XP, bodies', () => {
  it('downing an enemy stamps WHO felled them and journals the deed', () => {
    const { engine, state } = fight();
    startFight(engine, state);
    const bandit = Object.values(state.combatants).find((c) => c.kind === 'npc')!;
    engine.applyDamage({ targetId: bandit.id, amount: 20, type: 'slashing', attackerId: 'pc-1' });
    expect(bandit.downedBy).toBe('pc:pc-1'); // loosely resolved to the combatant id
    const felled = (state.journal ?? []).find((e) => e.kind === 'verdict' && e.text.includes('fells'));
    expect(felled?.text).toBe(`Aldric fells ${bandit.name}.`);
  });

  it('victory splits SRD CR-XP evenly and leaves lootable bodies where they fell', () => {
    const { engine, state } = fight();
    startFight(engine, state);
    const bandits = Object.values(state.combatants).filter((c) => c.kind === 'npc');
    expect(bandits).toHaveLength(2);
    for (const b of bandits) engine.applyDamage({ targetId: b.id, amount: 20, type: 'slashing', attackerId: 'pc-1' });
    // maybeEndCombat fired on the last drop.
    expect(state.combat.active).toBe(false);
    const each = Math.floor((2 * xpForCr(0.125)) / 2); // 2 bandits, 2 PCs
    expect(state.characters!['pc:pc-1']!.xp).toBe(each);
    expect(state.characters!['pc:pc-2']!.xp).toBe(each);
    const bodies = Object.values(state.pois ?? {}).filter((p) => p.look.includes('body'));
    expect(bodies).toHaveLength(2);
    for (const b of bodies) {
      expect(b.discovered).toBe(true); // straight into Findings — no hidden-corpse nonsense
      expect(b.contents?.gold ?? 0).toBeGreaterThan(0);
    }
  });

  it('a TPK pays nothing — no XP, no bodies, the Director owns that aftermath', () => {
    const { engine, state } = fight();
    startFight(engine, state);
    for (const pc of Object.values(state.combatants).filter((c) => c.kind === 'pc')) {
      pc.dead = true;
    }
    const bandit = Object.values(state.combatants).find((c) => c.kind === 'npc')!;
    engine.applyDamage({ targetId: bandit.id, amount: 50, type: 'slashing' });
    const out = engine.endCombat();
    expect(out.xpAwarded).toBeUndefined();
  });

  it('xpForCr covers the SRD ladder and degrades sanely off it', () => {
    expect(xpForCr(0.125)).toBe(25);
    expect(xpForCr(1)).toBe(200);
    expect(xpForCr(5)).toBe(1800);
    expect(xpForCr(23)).toBeGreaterThan(0); // off-table: proportional fallback
  });
});

describe('C3 — grouped ally blocks (the BG3 rule)', () => {
  /** Order engineered so two PCs sit adjacent: force it by rewriting the order directly. */
  const blockFight = () => {
    const f = fight();
    startFight(f.engine, f.state);
    const pcs = f.state.combat.order.filter((id) => f.state.combatants[id]!.kind === 'pc');
    const npcs = f.state.combat.order.filter((id) => f.state.combatants[id]!.kind === 'npc');
    f.state.combat.order = [...pcs, ...npcs]; // Aldric+Elara block first, bandits after
    f.state.combat.turnIndex = 0;
    f.state.combat.blockEnded = [];
    return f;
  };

  it('either adjacent ally may act; both act once; the SECOND End Turn advances past the block', () => {
    const { engine, state } = blockFight();
    const [a, b] = state.combat.order;
    expect(engine.activeIds().sort()).toEqual([a, b].sort());
    expect(engine.turnGuard(b!).ok).toBe(true); // the non-spotlight ally may act
    expect(engine.spendAction(b!).ok).toBe(true);
    expect(engine.endTurn(b!).ok).toBe(true); // b done — a still up
    expect(engine.activeIds()).toEqual([a]);
    expect(engine.turnGuard(b!).ok).toBe(false); // no second turn in the block
    expect(engine.endTurn(a!).ok).toBe(true);
    expect(state.combatants[state.combat.order[state.combat.turnIndex]!]!.kind).toBe('npc'); // past the block
  });

  it('entering a block refreshes EVERY member and clears the ended list', () => {
    const { engine, state } = blockFight();
    const [a, b] = state.combat.order;
    engine.spendAction(a!); engine.endTurn(a!);
    engine.spendAction(b!); engine.endTurn(b!);
    // walk the bandit turns back around to the block
    while (state.combatants[state.combat.order[state.combat.turnIndex]!]!.kind === 'npc') {
      engine.endTurn(state.combat.order[state.combat.turnIndex]!);
    }
    expect(state.combat.round).toBe(2);
    expect(engine.activeIds().sort()).toEqual([a, b].sort());
    expect(state.combatants[a!]!.actionEconomy!.action).toBe(true);
    expect(state.combatants[b!]!.actionEconomy!.action).toBe(true);
  });
});

describe('C3 — death saves, reinforcements, morale bookkeeping', () => {
  it('a dying PC STOPS the order (their save turn); a stable one is skipped', () => {
    const { engine, state } = fight();
    startFight(engine, state);
    const pcs = state.combat.order.filter((id) => state.combatants[id]!.kind === 'pc');
    const dying = state.combatants[pcs[1] ?? pcs[0]!]!;
    dying.downed = true; dying.deathSaves = { successes: 0, failures: 1 };
    // advance until we land on the dying PC
    for (let i = 0; i < state.combat.order.length + 1; i++) {
      const at = state.combat.order[state.combat.turnIndex]!;
      if (at === dying.id) break;
      engine.endTurn(at);
    }
    expect(state.combat.order[state.combat.turnIndex]).toBe(dying.id); // the order STOPPED on them
    dying.deathSaves = { successes: 3, failures: 1 }; // now stable → skipped
    engine.nextTurn();
    expect(state.combat.order[state.combat.turnIndex]).not.toBe(dying.id);
  });

  it('rollDeathSave honors the PLAYER\'s declared die: 20 revives, 1 double-fails', () => {
    const { engine, state } = fight();
    const pc = Object.values(state.combatants).find((c) => c.kind === 'pc')!;
    pc.downed = true; pc.currentHitPoints = 0; pc.deathSaves = { successes: 0, failures: 0 };
    expect(engine.rollDeathSave(pc.id, 1).failures).toBe(2); // nat 1 = two failures
    const again = engine.rollDeathSave(pc.id, 20);
    expect(again.status).toBe('revived');
    expect(pc.currentHitPoints).toBe(1);
  });

  it('a mid-fight spawn joins the initiative right after the current position', () => {
    const { engine, state } = fight();
    startFight(engine, state);
    const before = state.combat.order.length;
    const knight = engine.spawnCombatant(BANDIT, 'npc:late-knight', 'Late Knight');
    expect(state.combat.order).toHaveLength(before + 1);
    expect(state.combat.order[state.combat.turnIndex + 1]).toBe(knight.id); // next in line
  });

  it('fled enemies: the fight ends without them, they pay HALF XP, and leave no body', () => {
    const { engine, state } = fight();
    startFight(engine, state);
    const [b1, b2] = Object.values(state.combatants).filter((c) => c.kind === 'npc');
    engine.applyDamage({ targetId: b1!.id, amount: 20, type: 'slashing', attackerId: 'pc:pc-1' });
    b2!.fled = true;
    engine.checkCombatEnd(); // one dead + one fled = nobody standing
    expect(state.combat.active).toBe(false);
    const full = xpForCr(0.125), half = Math.floor(full / 2);
    expect(state.characters!['pc:pc-1']!.xp).toBe(Math.floor((full + half) / 2)); // split across 2 PCs
    const bodies = Object.values(state.pois ?? {}).filter((p) => p.look.includes('body'));
    expect(bodies).toHaveLength(1); // only the one who actually fell
  });
});

describe('C4 — opportunity attacks, disengage, condition timers', () => {
  it('breaking away from melee provokes ONE engine-rolled reaction strike', () => {
    const { engine, state } = fight();
    startFight(engine, state);
    const map = state.world!.locations['loc:arena']!;
    const pc = Object.values(state.combatants).find((c) => c.kind === 'pc')!;
    const bandit = Object.values(state.combatants).find((c) => c.kind === 'npc')!;
    // stage them adjacent, then walk the PC away on their turn
    const pcTok = { id: pc.id, kind: 'actor', role: 'pc', tag: 'knight', name: pc.name, col: 10, row: 10, footprint: { w: 1, h: 1 }, facing: 'down', visible: true };
    const bTok = { id: bandit.id, kind: 'actor', role: 'npc', tag: 'bandit', name: bandit.name, col: 11, row: 10, footprint: { w: 1, h: 1 }, facing: 'left', visible: true };
    map.objects.push(pcTok as never, bTok as never);
    while (state.combat.order[state.combat.turnIndex] !== pc.id) engine.endTurn(state.combat.order[state.combat.turnIndex]!);
    const hpBefore = pc.currentHitPoints;
    const v = engine.travel({ actorId: pc.id, to: { col: 14, row: 10 } });
    expect(v.moved).toBe(true);
    expect(v.facts.some((f) => f.includes('opportunity attack'))).toBe(true);
    // seeded d20=11 +3 vs AC 16… bandit attackBonus 3 → 14 vs 16 MISSES; assert the reaction SPENT
    expect(bandit.actionEconomy?.reaction).toBe(false);
    expect(pc.currentHitPoints).toBeLessThanOrEqual(hpBefore);
  });

  it('disengage spends the action and the same walk provokes NOTHING', () => {
    const { engine, state } = fight();
    startFight(engine, state);
    const map = state.world!.locations['loc:arena']!;
    const pc = Object.values(state.combatants).find((c) => c.kind === 'pc')!;
    const bandit = Object.values(state.combatants).find((c) => c.kind === 'npc')!;
    map.objects.push(
      { id: pc.id, kind: 'actor', role: 'pc', tag: 'knight', name: pc.name, col: 10, row: 10, footprint: { w: 1, h: 1 }, facing: 'down', visible: true } as never,
      { id: bandit.id, kind: 'actor', role: 'npc', tag: 'bandit', name: bandit.name, col: 11, row: 10, footprint: { w: 1, h: 1 }, facing: 'left', visible: true } as never,
    );
    while (state.combat.order[state.combat.turnIndex] !== pc.id) engine.endTurn(state.combat.order[state.combat.turnIndex]!);
    expect(engine.disengage(pc.id).ok).toBe(true);
    const v = engine.travel({ actorId: pc.id, to: { col: 14, row: 10 } });
    expect(v.facts.some((f) => f.includes('opportunity attack'))).toBe(false);
    expect(engine.spendAction(pc.id).ok).toBe(false); // disengage WAS the action
  });

  it('a timed condition expires at the start of the afflicted\'s later turn', () => {
    const { engine, state } = fight();
    startFight(engine, state);
    const active = state.combat.order[state.combat.turnIndex]!;
    engine.applyCondition({ combatantId: active, condition: 'poisoned', add: true, rounds: 1 });
    expect(state.combatants[active]!.conditions).toContain('poisoned');
    // a full lap: everyone ends, the order returns to them and the timer ticks out
    for (let i = 0; i < state.combat.order.length; i++) engine.endTurn(state.combat.order[state.combat.turnIndex]!);
    expect(state.combatants[active]!.conditions).not.toContain('poisoned');
  });
});
