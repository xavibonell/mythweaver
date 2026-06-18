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
  type Condition,
  type DamageType,
  type DiceExpr,
  type EngineTools,
  type GameState,
  type LogEntry,
  type RollRequest,
  type RollResult,
  type Skill,
} from '@mythweaver/shared';
import { rollDice, validateDeclaredRoll, type Rng } from './dice.js';

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

  // --- P1: checks, saves, attacks (engine-authoritative at P1) -------------

  resolveCheck(_args: { combatantId: string; skill?: Skill; ability: Ability; dc: number; declaredTotal: number }): CheckResult {
    throw new NotImplemented('resolveCheck', 'P1');
  }

  resolveSave(_args: { combatantId: string; ability: Ability; dc: number; declaredTotal: number }): CheckResult {
    throw new NotImplemented('resolveSave', 'P1');
  }

  resolveAttack(_args: { attackerId: string; targetId: string; attackName: string; declaredTotal: number }): AttackResult {
    throw new NotImplemented('resolveAttack', 'P1');
  }

  // --- P2: combat state ----------------------------------------------------

  applyDamage(_args: { targetId: string; amount: number; type: DamageType }): { remaining: number; downed: boolean } {
    throw new NotImplemented('applyDamage', 'P2');
  }

  startCombat(_initiatives: { combatantId: string; initiative: number }[]): void {
    throw new NotImplemented('startCombat', 'P2');
  }

  nextTurn(): { activeCombatantId: string; round: number } {
    throw new NotImplemented('nextTurn', 'P2');
  }

  applyCondition(_args: { combatantId: string; condition: Condition; add: boolean }): void {
    throw new NotImplemented('applyCondition', 'P2');
  }

  // --- P3: resources -------------------------------------------------------

  spendResource(_args: { combatantId: string; resource: 'slot'; level: number }): { remaining: number } {
    throw new NotImplemented('spendResource', 'P3');
  }
}
