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

  it('turnGuard: only the active combatant may act; outside combat everyone may', () => {
    const { engine, state } = fight();
    expect(engine.turnGuard('pc-1')).toEqual({ ok: true }); // no combat yet
    startFight(engine, state);
    const active = state.combat.order[0]!;
    const bystander = state.combat.order[1]!;
    expect(engine.turnGuard(active)).toEqual({ ok: true });
    const refused = engine.turnGuard(bystander);
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

  it('endTurn refuses out-of-turn callers and refuses while a roll hangs in the air', () => {
    const { engine, state } = fight();
    startFight(engine, state);
    const bystander = state.combat.order[1]!;
    expect(engine.endTurn(bystander).ok).toBe(false);
    const active = state.combat.order[0]!;
    state.pendingTurn = { rollRequestId: 'r1' } as GameState['pendingTurn'];
    const blocked = engine.endTurn(active);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toContain('roll is still pending');
  });

  it('nextTurn skips the downed and the dead instead of stalling on them', () => {
    const { engine, state } = fight();
    startFight(engine, state);
    // Down the SECOND combatant in order, then end the first's turn — the third must be active.
    const second = state.combat.order[1]!;
    const c = state.combatants[second]!;
    c.downed = true;
    const active = state.combat.order[0]!;
    engine.endTurn(active);
    expect(state.combat.order[state.combat.turnIndex]).toBe(state.combat.order[2]);
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
