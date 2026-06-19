/**
 * The deterministic rules engine (spec §4.1) — authoritative source of truth for
 * all mechanics. The LLM affects state ONLY by calling these tools.
 *
 * RAMP (spec §4.2): P0 implements the dice primitive + declared-roll validation +
 * read-only state. Later mechanics throw `NotImplemented(<phase>)` so a premature
 * LLM-side resolution surfaces loudly instead of silently bending the rules.
 */

import {
  NotImplemented,
  type Ability,
  type AdvantageState,
  type AttackResult,
  type CheckResult,
  type Combatant,
  type Condition,
  type DamageType,
  type DiceExpr,
  type EngineTools,
  type GameState,
  type LogEntry,
  type RollRequest,
  type RollResult,
  type Skill,
  type StatBlock,
} from '@mythweaver/shared';
import { rollDice, validateDeclaredRoll, type Rng } from './dice.js';
import { statBlockToCombatant } from './state.js';

export class Engine implements EngineTools {
  private readonly pending = new Map<string, RollRequest>();
  private rollSeq = 0;

  constructor(private readonly state: GameState, private readonly rng: Rng = Math.random) {}

  // --- P0: read-only state + dice -----------------------------------------

  getState(): GameState {
    return this.state;
  }

  rollDice(expr: DiceExpr, advantage: AdvantageState = 'normal'): number {
    return rollDice(expr, advantage, this.rng);
  }

  requestRoll(req: Omit<RollRequest, 'id'>): RollRequest {
    const id = `roll-${++this.rollSeq}`;
    const full: RollRequest = { id, ...req };
    this.pending.set(id, full);
    this.record('engine', `Roll requested: ${full.expr} — ${full.reason}`, { rollRequestId: id });
    return full;
  }

  /**
   * Re-register a roll request that was persisted across a save/resume boundary
   * (the pending map is in-memory; a turn that suspended for a physical-dice roll
   * resumes on a fresh Engine). Spec §4.3.
   */
  registerRoll(req: RollRequest): void {
    this.pending.set(req.id, req);
  }

  submitRoll(requestId: string, declaredTotal: number): RollResult {
    const req = this.pending.get(requestId);
    if (!req) throw new Error(`Unknown roll request: ${requestId}`);
    const result = validateDeclaredRoll(req, declaredTotal);
    if (result.accepted) this.pending.delete(requestId);
    this.record('engine', result.message ?? `Roll ${declaredTotal} (${result.validation})`, { result });
    return result;
  }

  /** Append a transcript/audit entry (spec §4.1 / §13). Not part of the tool surface. */
  record(kind: LogEntry['kind'], text: string, data?: Record<string, unknown>): void {
    this.state.log.push({ seq: this.state.log.length + 1, kind, text, ...(data ? { data } : {}) });
  }

  // --- P1: checks, saves, attacks ------------------------------------------
  // NOTE: in this build the orchestrator resolves checks/saves/attacks through the
  // dice-trust path — requestRoll(dc) -> submitRoll -> validateDeclaredRoll computes
  // success vs the DC/AC (dice.ts). These typed resolve* APIs are reserved for a future
  // direct-call path and remain unimplemented on purpose (the ramp guard, spec §4.2).

  resolveCheck(_args: { combatantId: string; skill?: Skill; ability: Ability; dc: number; declaredTotal: number }): CheckResult {
    throw new NotImplemented('resolveCheck', 'P1');
  }

  resolveSave(_args: { combatantId: string; ability: Ability; dc: number; declaredTotal: number }): CheckResult {
    throw new NotImplemented('resolveSave', 'P1');
  }

  resolveAttack(_args: { attackerId: string; targetId: string; attackName: string; declaredTotal: number }): AttackResult {
    throw new NotImplemented('resolveAttack', 'P1');
  }

  // --- P2: combat state (engine-authoritative) -----------------------------

  /** Spawn a live npc combatant from a monster stat block. Returns the created combatant. */
  spawnCombatant(statBlock: StatBlock, instanceId?: string, name?: string): Combatant {
    const existing = Object.values(this.state.combatants).filter((c) => c.refId === statBlock.id).length;
    const id = instanceId ?? `npc:${statBlock.id}-${existing + 1}`;
    const combatant = statBlockToCombatant(statBlock, id, name ?? `${statBlock.name} ${existing + 1}`);
    this.state.combatants[combatant.id] = combatant;
    this.record('engine', `Spawned ${combatant.name} (${combatant.currentHitPoints} HP, AC ${combatant.armorClass})`, {
      combatantId: combatant.id,
      refId: statBlock.id,
    });
    return combatant;
  }

  /**
   * Apply damage to a combatant (the engine owns HP). Honors immunity/resistance/vulnerability,
   * soaks temporary HP first, clamps at 0, and marks a creature downed at 0 HP. A hit on an
   * already-dying PC is an automatic death-save failure (three failures = dead).
   */
  applyDamage(args: { targetId: string; amount: number; type: DamageType }): { remaining: number; downed: boolean } {
    const c = this.state.combatants[args.targetId];
    if (!c) throw new Error(`Unknown combatant: ${args.targetId}`);
    if (c.dead) return { remaining: 0, downed: true };

    const raw = Math.max(0, Math.floor(args.amount));
    let amount = raw;
    if (c.damageImmunities?.includes(args.type)) amount = 0;
    else if (c.damageResistances?.includes(args.type)) amount = Math.floor(raw / 2);
    else if (c.damageVulnerabilities?.includes(args.type)) amount = raw * 2;

    const wasDyingPc = c.kind === 'pc' && c.currentHitPoints === 0;
    let toHp = amount;
    if (c.temporaryHitPoints > 0) {
      const soak = Math.min(c.temporaryHitPoints, toHp);
      c.temporaryHitPoints -= soak;
      toHp -= soak;
    }
    const before = c.currentHitPoints;
    c.currentHitPoints = Math.max(0, c.currentHitPoints - toHp);

    // A struck dying PC fails a death save (no new HP loss possible, already at 0).
    if (wasDyingPc && amount > 0) {
      const ds = (c.deathSaves ??= { successes: 0, failures: 0 });
      ds.failures += 1;
      if (ds.failures >= 3) c.dead = true;
    }

    const downed = c.currentHitPoints === 0;
    if (downed && !c.downed) {
      c.downed = true;
      if (!c.conditions.includes('unconscious')) c.conditions.push('unconscious');
      if (c.kind === 'pc' && !c.deathSaves) c.deathSaves = { successes: 0, failures: 0 }; // dying: rolls begin
    }
    this.record(
      'engine',
      `${c.name} takes ${amount} ${args.type} damage (${before} -> ${c.currentHitPoints} HP)${c.dead ? ' — dead' : downed ? ' — downed' : ''}`,
      { combatantId: c.id, field: 'currentHitPoints', before, after: c.currentHitPoints, type: args.type, raw, applied: amount, downed, dead: c.dead ?? false },
    );
    return { remaining: c.currentHitPoints, downed };
  }

  /** Restore hit points. Healing a creature above 0 ends the dying state and resets death saves. */
  heal(args: { targetId: string; amount: number }): { current: number } {
    const c = this.state.combatants[args.targetId];
    if (!c) throw new Error(`Unknown combatant: ${args.targetId}`);
    if (c.dead) throw new Error(`${c.name} is dead and cannot be healed by hit points.`);
    const before = c.currentHitPoints;
    c.currentHitPoints = Math.min(c.maxHitPoints, c.currentHitPoints + Math.max(0, Math.floor(args.amount)));
    const revived = before === 0 && c.currentHitPoints > 0;
    if (revived) {
      c.downed = false;
      delete c.deathSaves;
      c.conditions = c.conditions.filter((x) => x !== 'unconscious');
    }
    this.record('engine', `${c.name} heals ${c.currentHitPoints - before} (${before} -> ${c.currentHitPoints} HP)${revived ? ' — back up' : ''}`, {
      combatantId: c.id,
      field: 'currentHitPoints',
      before,
      after: c.currentHitPoints,
      revived,
    });
    return { current: c.currentHitPoints };
  }

  /**
   * Roll a death save for a dying PC (d20): >=10 success, <10 failure; nat 20 revives at 1 HP;
   * nat 1 is two failures. Three successes = stable; three failures = dead.
   */
  rollDeathSave(combatantId: string): { roll: number; successes: number; failures: number; status: 'dying' | 'stable' | 'revived' | 'dead' } {
    const c = this.state.combatants[combatantId];
    if (!c) throw new Error(`Unknown combatant: ${combatantId}`);
    if (c.kind !== 'pc' || !c.downed || c.dead) throw new Error(`${c.name} is not making death saves.`);
    const roll = this.rollDice('1d20');
    const ds = (c.deathSaves ??= { successes: 0, failures: 0 });

    let status: 'dying' | 'stable' | 'revived' | 'dead' = 'dying';
    if (roll === 20) {
      c.currentHitPoints = 1;
      c.downed = false;
      delete c.deathSaves;
      c.conditions = c.conditions.filter((x) => x !== 'unconscious');
      status = 'revived';
    } else if (roll === 1) {
      ds.failures += 2;
    } else if (roll >= 10) {
      ds.successes += 1;
    } else {
      ds.failures += 1;
    }

    if (status !== 'revived' && c.deathSaves) {
      if (c.deathSaves.failures >= 3) {
        c.dead = true;
        status = 'dead';
      } else if (c.deathSaves.successes >= 3) {
        status = 'stable';
      }
    }
    const tally = c.deathSaves ?? { successes: status === 'revived' ? 0 : 3, failures: 0 };
    this.record('engine', `${c.name} death save: rolled ${roll} — ${status} (${tally.successes}✓/${tally.failures}✗)`, {
      combatantId: c.id,
      roll,
      status,
      ...tally,
    });
    return { roll, successes: tally.successes, failures: tally.failures, status };
  }

  /** Begin combat: set initiative on each named combatant and build the turn order (desc). */
  startCombat(initiatives: { combatantId: string; initiative: number }[]): void {
    for (const { combatantId, initiative } of initiatives) {
      const c = this.state.combatants[combatantId];
      if (c) c.initiative = initiative;
    }
    const order = [...initiatives]
      .filter((i) => this.state.combatants[i.combatantId])
      .sort((a, b) => b.initiative - a.initiative)
      .map((i) => i.combatantId);
    this.state.combat = { active: true, round: 1, turnIndex: 0, order };
    this.record('engine', `Combat started (round 1) — order: ${order.join(', ')}`);
  }

  /** Advance to the next combatant; wraps to the next round at the end of the order. */
  nextTurn(): { activeCombatantId: string; round: number } {
    const cs = this.state.combat;
    if (!cs.active || cs.order.length === 0) throw new Error('No active combat to advance.');
    cs.turnIndex += 1;
    if (cs.turnIndex >= cs.order.length) {
      cs.turnIndex = 0;
      cs.round += 1;
    }
    const activeCombatantId = cs.order[cs.turnIndex]!;
    this.record('engine', `Round ${cs.round} — active: ${activeCombatantId}`, { round: cs.round, activeCombatantId });
    return { activeCombatantId, round: cs.round };
  }

  /** Add or remove a condition on a combatant. */
  applyCondition(args: { combatantId: string; condition: Condition; add: boolean }): void {
    const c = this.state.combatants[args.combatantId];
    if (!c) throw new Error(`Unknown combatant: ${args.combatantId}`);
    const has = c.conditions.includes(args.condition);
    if (args.add && !has) c.conditions.push(args.condition);
    else if (!args.add && has) c.conditions = c.conditions.filter((x) => x !== args.condition);
    this.record('engine', `${c.name} ${args.add ? 'gains' : 'loses'} ${args.condition}`, { combatantId: c.id, condition: args.condition, add: args.add });
  }

  /**
   * Begin the authored encounter for a scene: spawn its monsters from the bestiary,
   * roll initiative for every active combatant (1d20 + initiativeBonus), and start combat.
   */
  startEncounter(sceneId?: string): { spawned: string[]; order: string[] } {
    const encs = this.state.encounters ?? [];
    // Prefer the named scene, else the current scene, else the only authored encounter (one-shots).
    const encounter =
      (sceneId ? encs.find((e) => e.sceneId === sceneId) : undefined) ??
      encs.find((e) => e.sceneId === this.state.currentSceneId) ??
      (encs.length === 1 ? encs[0] : undefined);
    if (!encounter) {
      throw new Error(`No authored encounter for "${sceneId ?? this.state.currentSceneId}" (available: ${encs.map((e) => e.sceneId).join(', ') || 'none'}).`);
    }
    const bestiary = this.state.bestiary ?? {};
    const spawned: string[] = [];
    for (const m of encounter.monsters) {
      const sb = bestiary[m.statBlockId];
      if (!sb) throw new Error(`Encounter references unknown stat block: ${m.statBlockId}`);
      for (let i = 0; i < m.count; i++) spawned.push(this.spawnCombatant(sb).id);
    }
    const initiatives = Object.values(this.state.combatants)
      .filter((c) => !c.downed)
      .map((c) => ({ combatantId: c.id, initiative: this.rollDice('1d20') + (c.initiativeBonus ?? 0) }));
    this.startCombat(initiatives);
    return { spawned, order: this.state.combat.order };
  }

  // --- P3: resources -------------------------------------------------------

  spendResource(_args: { combatantId: string; resource: 'slot'; level: number }): { remaining: number } {
    throw new NotImplemented('spendResource', 'P3');
  }
}
