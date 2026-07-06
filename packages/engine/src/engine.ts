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
  TERMINAL_ENTITY_STATUSES,
  type Ability,
  type AdvantageState,
  type AttackResult,
  type CharacterState,
  type CheckResult,
  type Combatant,
  type Condition,
  type DamageType,
  type DiceExpr,
  type EngineTools,
  type EntityCard,
  type FactRow,
  type GameState,
  type LedgerState,
  type LogEntry,
  type Plant,
  type RollRequest,
  type RollResult,
  type Skill,
  type StatBlock,
} from '@mythweaver/shared';
import { rollDice, validateDeclaredRoll, type Rng } from './dice.js';
import { statBlockToCombatant } from './state.js';
import { abilityMod, deriveArmorClass, deriveProficiencyBonus } from './derive.js';
import { ASI_LEVELS, XP_THRESHOLDS, hitDieAvg, hitDieForClass, levelForXp } from './progression.js';

/** Coin math in the smallest unit so change-making is exact (1 gp = 10 sp = 100 cp). */
const toCopper = (c: { cp: number; sp: number; gp: number }): number => Math.round(c.cp + c.sp * 10 + c.gp * 100);
const fromCopper = (total: number): { cp: number; sp: number; gp: number } => ({ gp: Math.floor(total / 100), sp: Math.floor((total % 100) / 10), cp: total % 10 });
const gpToCopper = (gp: number): number => Math.round(gp * 100);

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
    // Concentration (P3b): a hit forces a Con save (DC = max 10, half the damage) to keep the spell;
    // being knocked unconscious ends it outright. The engine sets the DC and surfaces the prompt — the
    // caster's declared save (via requestRoll/submitRoll) decides it, and the DM calls breakConcentration
    // on a failure. The engine owns the DC and the number; it never decides the save itself here.
    let concentration: { dc: number; spell: string } | undefined;
    if (c.concentratingOn) {
      if (downed || c.dead) {
        this.record('engine', `${c.name}'s concentration on ${c.concentratingOn.spell} breaks (unconscious)`, { combatantId: c.id, concentrationBroken: c.concentratingOn.spell });
        delete c.concentratingOn;
      } else if (amount > 0) {
        const dc = Math.max(10, Math.floor(amount / 2));
        c.concentratingOn.dc = dc;
        concentration = { dc, spell: c.concentratingOn.spell };
      }
    }

    if (downed) this.maybeEndCombat(); // P0: when the last conscious foe drops, resolve the fight
    return { remaining: c.currentHitPoints, downed, ...(concentration ? { concentration } : {}) };
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

  /**
   * End the fight: clear combat state and despawn every npc combatant (defeated or fled) so the
   * authoritative state stops asserting phantom combat with dead foes "present" (P0 state-truth).
   * PCs persist. Idempotent.
   */
  endCombat(): { despawned: string[] } {
    const despawned: string[] = [];
    for (const [id, c] of Object.entries(this.state.combatants)) {
      if (c.kind === 'npc') {
        delete this.state.combatants[id];
        despawned.push(id);
      }
    }
    const wasActive = this.state.combat.active;
    this.state.combat = { active: false, round: 0, turnIndex: 0, order: [] };
    if (wasActive || despawned.length) {
      this.record('engine', `Combat ended${despawned.length ? ` — ${despawned.length} foe(s) cleared from the field` : ''}`, { despawned });
    }
    return { despawned };
  }

  /** Auto-resolve a fight the moment no conscious enemy (npc) remains. */
  private maybeEndCombat(): void {
    if (!this.state.combat.active) return;
    const enemyStanding = Object.values(this.state.combatants).some((c) => c.kind === 'npc' && !c.downed && !c.dead);
    if (!enemyStanding) this.endCombat();
  }

  /** Add or remove a condition on a combatant. A creature immune to a condition never gains it. */
  applyCondition(args: { combatantId: string; condition: Condition; add: boolean }): void {
    const c = this.state.combatants[args.combatantId];
    if (!c) throw new Error(`Unknown combatant: ${args.combatantId}`);
    if (args.add && c.conditionImmunities?.includes(args.condition)) {
      this.record('engine', `${c.name} is immune to ${args.condition}`, { combatantId: c.id, condition: args.condition, immune: true });
      return;
    }
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

  // --- D1: soft arc steering (scene advancement + branch flags) ------------

  /** Advance the active beat to a reachable next scene (per the adventure's exits). `outcome` stamps
   *  HOW the beat closed (resolved / fled / done) so later steering + payoffs can read it. */
  advanceScene(toSceneId: string, outcome?: 'resolved' | 'fled' | 'done'): { scene: string; from: string } {
    const adv = this.state.adventure;
    if (!adv?.scenes[toSceneId]) throw new Error(`Unknown scene: ${toSceneId}`);
    const from = this.state.currentSceneId;
    const exits = adv.scenes[from]?.exits ?? [];
    // A beat with no exits is TERMINAL — the arc resolves here; nothing is reachable from it (P0).
    if (exits.length === 0) {
      throw new Error(`"${from}" is a terminal beat (no exits) — the arc resolves here; there is nowhere to advance.`);
    }
    if (!exits.includes(toSceneId)) {
      throw new Error(`"${toSceneId}" is not reachable from "${from}" (exits: ${exits.join(', ')}).`);
    }
    this.state.flags[`beat:${from}`] = outcome ?? 'done';
    this.state.currentSceneId = toSceneId;
    this.record('engine', `Scene advanced: ${from} -> ${toSceneId} (${outcome ?? 'done'})`, { from, to: toSceneId, outcome: outcome ?? 'done' });
    return { scene: toSceneId, from };
  }

  /** Record a soft arc fact (a branch decision, a beat status, an NPC standing). Namespaced. */
  setArcFlag(key: string, value: string | number | boolean): void {
    if (!/^(decision|beat|npc):[a-z0-9:_-]+$/i.test(key)) {
      throw new Error(`Arc flag key must be namespaced "decision:"/"beat:"/"npc:" — got "${key}".`);
    }
    // Strip newlines: flag values are rendered into the line-structured STEERING block (anti-injection).
    const v = typeof value === 'string' ? value.replace(/\s*\n\s*/g, ' ').slice(0, 200) : value;
    this.state.flags[key] = v;
    this.record('engine', `Arc flag ${key} = ${v}`, { key, value: v });
  }

  // --- P1: the Canon Ledger (the §7 memory tier that survives the transcript window) -------------

  private ledger(): LedgerState {
    return (this.state.ledger ??= { entities: {}, facts: [], plants: {} });
  }

  private static isTerminal(s?: string): boolean {
    return !!s && (TERMINAL_ENTITY_STATUSES as readonly string[]).includes(s);
  }

  private static clip(s: unknown, n: number): string {
    return typeof s === 'string' ? s.replace(/\s*\n\s*/g, ' ').trim().slice(0, n) : '';
  }

  /**
   * Create or merge a canonical entity (NPC/place/item/…). ABSORBING STATUS: once an entity is
   * dead/gone/destroyed it can never leave that state — a downgrade is ignored (no un-dying).
   * Voice/aliases/scenes MERGE across upserts so a returning NPC keeps its established self.
   */
  upsertEntity(card: Partial<EntityCard> & { id: string }): EntityCard {
    const L = this.ledger();
    const prev = L.entities[card.id];
    let status = card.status;
    if (Engine.isTerminal(prev?.status) && !Engine.isTerminal(status)) status = prev!.status; // absorbing
    const aliases = [...new Set([...(prev?.aliases ?? []), ...(card.aliases ?? [])].map((a) => Engine.clip(a, 60)).filter(Boolean))];
    const scenes = [...new Set([...(prev?.scenes ?? []), ...(card.scenes ?? [])])];
    const voice = { ...(prev?.voice ?? {}), ...(card.voice ?? {}) };
    const merged: EntityCard = {
      id: card.id,
      kind: card.kind ?? prev?.kind ?? 'other',
      name: Engine.clip(card.name, 80) || prev?.name || card.id,
      ...(aliases.length ? { aliases } : {}),
      ...(voice.tic || voice.want || voice.fear ? { voice: { ...(voice.tic ? { tic: Engine.clip(voice.tic, 120) } : {}), ...(voice.want ? { want: Engine.clip(voice.want, 120) } : {}), ...(voice.fear ? { fear: Engine.clip(voice.fear, 120) } : {}) } } : {}),
      status: (status ?? prev?.status ?? 'active') as EntityCard['status'],
      ...(scenes.length ? { scenes } : {}),
      ...(Engine.clip(card.notes, 240) || prev?.notes ? { notes: Engine.clip(card.notes, 240) || prev?.notes } : {}),
    };
    L.entities[card.id] = merged;
    this.record('engine', `Canon: ${merged.name} [${merged.id}] — ${merged.status}`, { entityId: merged.id, status: merged.status });
    return merged;
  }

  /**
   * Append a canonical fact. A newer fact for the same subject+attribute SUPERSEDES the older one
   * (marked, not deleted — the ledger is append-only for audit). Facts about a terminal entity's
   * being (subject=entity, attribute="status") cannot revive it — that lives on the EntityCard.
   */
  recordFact(args: { subject: string; attribute: string; value: string; source?: FactRow['source'] }): FactRow {
    const L = this.ledger();
    const subject = Engine.clip(args.subject, 80);
    const attribute = Engine.clip(args.attribute, 60);
    const value = Engine.clip(args.value, 240);
    if (!subject || !attribute) throw new Error('recordFact needs a subject and an attribute.');
    const id = `fact:${L.facts.length + 1}`;
    for (const f of L.facts) if (!f.supersededBy && f.subject === subject && f.attribute === attribute) f.supersededBy = id;
    const row: FactRow = { id, subject, attribute, value, turn: this.state.turnCount ?? 0, source: args.source ?? 'dm' };
    L.facts.push(row);
    this.record('engine', `Fact: ${subject} · ${attribute} = ${value}`, { ...row });
    return row;
  }

  /** Plant / advance a Chekhov detail. Status only moves forward: planted → echoed → fired. */
  setPlant(id: string, what: string, status: Plant['status'] = 'planted'): Plant {
    const L = this.ledger();
    const order: Plant['status'][] = ['planted', 'echoed', 'fired'];
    const prev = L.plants[id];
    const next = prev && order.indexOf(status) < order.indexOf(prev.status) ? prev.status : status; // monotonic
    const plant: Plant = { id, what: Engine.clip(what, 200) || prev?.what || id, status: next, turn: this.state.turnCount ?? 0 };
    L.plants[id] = plant;
    this.record('engine', `Plant ${id}: ${plant.status}`, { plantId: id, status: plant.status });
    return plant;
  }

  // --- P3a: the Character Engine's live pools (resources + rests) -----------

  /**
   * Spend a spell slot (resource:'slot' + level) or a named class pool (ki/rage/channelDivinity/…). The
   * single debit path — the DM can never "use" a resource the engine hasn't subtracted. Throws if empty.
   */
  spendResource(args: { combatantId: string; resource: string; level?: number; amount?: number }): { remaining: number } {
    const c = this.state.combatants[args.combatantId];
    if (!c) throw new Error(`Unknown combatant: ${args.combatantId}`);
    const amount = Math.max(1, Math.floor(args.amount ?? 1));
    if (args.resource === 'slot') {
      const level = Math.floor(args.level ?? 0);
      if (level < 1 || level > 9) throw new Error(`Spell slot level must be 1–9 (got ${args.level ?? 'none'}).`);
      const slots = c.slotsRemaining;
      if (!slots || (slots[level] ?? 0) < amount) throw new Error(`${c.name} has no level-${level} spell slot to spend.`);
      const before = slots[level]!;
      slots[level] = before - amount;
      this.record('engine', `${c.name} spends a level-${level} spell slot (${before} -> ${slots[level]} left)`, { combatantId: c.id, resource: `slot:${level}`, before, after: slots[level] });
      return { remaining: slots[level]! };
    }
    const pool = c.resources?.[args.resource];
    if (!pool || pool.current < amount) throw new Error(`${c.name} has no "${args.resource}" left to spend.`);
    const before = pool.current;
    pool.current = before - amount;
    this.record('engine', `${c.name} spends ${amount} ${args.resource} (${before} -> ${pool.current} left)`, { combatantId: c.id, resource: args.resource, before, after: pool.current });
    return { remaining: pool.current };
  }

  /**
   * Short rest: spend up to `spendHitDice` hit dice to heal (the player rolls Nd(hitDie)+CON via the
   * dice-trust path and passes the total as `rolledTotal`; the engine validates the count and owns the HP
   * clamp) and recharge short-rest resources. Does NOT restore spell slots — that's a long rest.
   */
  shortRest(args: { combatantId: string; spendHitDice?: number; rolledTotal?: number }): { hpRestored: number; hitDiceRemaining: number } {
    const c = this.state.combatants[args.combatantId];
    if (!c) throw new Error(`Unknown combatant: ${args.combatantId}`);
    if (c.dead) throw new Error(`${c.name} is dead and cannot rest.`);
    const spend = Math.max(0, Math.floor(args.spendHitDice ?? 0));
    let hpRestored = 0;
    if (spend > 0) {
      const hd = c.hitDice;
      if (!hd || hd.remaining < spend) throw new Error(`${c.name} has only ${c.hitDice?.remaining ?? 0} hit dice to spend.`);
      hd.remaining -= spend;
      const before = c.currentHitPoints;
      c.currentHitPoints = Math.min(c.maxHitPoints, c.currentHitPoints + Math.max(0, Math.floor(args.rolledTotal ?? 0)));
      hpRestored = c.currentHitPoints - before;
      if (before === 0 && c.currentHitPoints > 0) {
        c.downed = false;
        delete c.deathSaves;
        c.conditions = c.conditions.filter((x) => x !== 'unconscious');
      }
    }
    let recharged = 0;
    for (const r of Object.values(c.resources ?? {})) if (r.recharge === 'short' && r.current < r.max) { r.current = r.max; recharged++; }
    this.record('engine', `${c.name} takes a short rest — ${spend} hit dice spent (+${hpRestored} HP)${recharged ? `, ${recharged} resource(s) recharged` : ''}`, {
      combatantId: c.id,
      spendHitDice: spend,
      hpRestored,
      hitDiceRemaining: c.hitDice?.remaining ?? 0,
    });
    return { hpRestored, hitDiceRemaining: c.hitDice?.remaining ?? 0 };
  }

  /**
   * Long rest: full HP, spell slots + resources back to max, half the hit-dice pool refunded (min 1), and
   * exhaustion reduced by 1 — for each named combatant (defaults to every PC). This is THE place spell
   * slots come back: without it, slotsRemaining is copied at spawn and never restored (a live correctness
   * hole). A long rest does not raise the dead.
   */
  longRest(args?: { combatantIds?: string[] }): { restored: Record<string, { hp: number; slotsRestored: boolean; hitDiceRemaining: number; exhaustion: number }> } {
    const ids = args?.combatantIds?.length ? args.combatantIds : Object.values(this.state.combatants).filter((c) => c.kind === 'pc').map((c) => c.id);
    const restored: Record<string, { hp: number; slotsRestored: boolean; hitDiceRemaining: number; exhaustion: number }> = {};
    for (const id of ids) {
      const c = this.state.combatants[id];
      if (!c) throw new Error(`Unknown combatant: ${id}`);
      if (c.dead) continue;
      c.currentHitPoints = c.maxHitPoints;
      c.temporaryHitPoints = 0;
      c.downed = false;
      delete c.deathSaves;
      c.conditions = c.conditions.filter((x) => x !== 'unconscious');
      let slotsRestored = false;
      if (c.slotsRemaining && c.slotsMax) {
        c.slotsRemaining = [...c.slotsMax];
        slotsRestored = true;
      }
      for (const r of Object.values(c.resources ?? {})) r.current = r.max;
      if (c.hitDice) c.hitDice.remaining = Math.min(c.hitDice.max, c.hitDice.remaining + Math.max(1, Math.floor(c.hitDice.max / 2)));
      if (c.exhaustion) c.exhaustion = Math.max(0, c.exhaustion - 1);
      restored[id] = { hp: c.currentHitPoints, slotsRestored, hitDiceRemaining: c.hitDice?.remaining ?? 0, exhaustion: c.exhaustion ?? 0 };
    }
    this.record('engine', `Long rest — ${Object.keys(restored).length} character(s) recovered`, { restored });
    return { restored };
  }

  /** Set a combatant's exhaustion level (clamped 0–6; 6 = death, SRD). */
  setExhaustion(args: { combatantId: string; level: number }): { exhaustion: number } {
    const c = this.state.combatants[args.combatantId];
    if (!c) throw new Error(`Unknown combatant: ${args.combatantId}`);
    const before = c.exhaustion ?? 0;
    const level = Math.max(0, Math.min(6, Math.floor(args.level)));
    c.exhaustion = level;
    if (level >= 6 && c.kind === 'pc' && !c.dead) {
      c.dead = true;
      c.downed = true;
    }
    this.record('engine', `${c.name} exhaustion ${before} -> ${level}${level >= 6 ? ' — dead' : ''}`, { combatantId: c.id, before, after: level, dead: c.dead ?? false });
    return { exhaustion: level };
  }

  /** Grant Heroic Inspiration (a one-shot advantage token). */
  grantInspiration(args: { combatantId: string }): void {
    const c = this.state.combatants[args.combatantId];
    if (!c) throw new Error(`Unknown combatant: ${args.combatantId}`);
    c.inspiration = true;
    this.record('engine', `${c.name} gains inspiration`, { combatantId: c.id, inspiration: true });
  }

  /** Spend Heroic Inspiration; throws if the combatant holds none. */
  spendInspiration(args: { combatantId: string }): { spent: boolean } {
    const c = this.state.combatants[args.combatantId];
    if (!c) throw new Error(`Unknown combatant: ${args.combatantId}`);
    if (!c.inspiration) throw new Error(`${c.name} has no inspiration to spend.`);
    c.inspiration = false;
    this.record('engine', `${c.name} spends inspiration`, { combatantId: c.id, inspiration: false });
    return { spent: true };
  }

  // --- P3b: concentration (a combat-track throttle on the spell economy) ---

  /**
   * Begin concentrating on a spell. A creature can hold only ONE concentration spell — starting a new one
   * drops whatever it was holding (5e). The save DC is set later, per hit, by applyDamage.
   */
  startConcentration(args: { combatantId: string; spell: string }): void {
    const c = this.state.combatants[args.combatantId];
    if (!c) throw new Error(`Unknown combatant: ${args.combatantId}`);
    const spell = args.spell.trim().slice(0, 80);
    if (!spell) throw new Error('startConcentration needs a spell name.');
    const dropped = c.concentratingOn?.spell;
    c.concentratingOn = { spell };
    this.record('engine', `${c.name} concentrates on ${spell}${dropped && dropped !== spell ? ` (drops ${dropped})` : ''}`, { combatantId: c.id, spell, ...(dropped ? { dropped } : {}) });
  }

  /** Stop concentrating (the spell ends, the caster is incapacitated, or a save was failed). Idempotent. */
  breakConcentration(args: { combatantId: string }): { was: string | null } {
    const c = this.state.combatants[args.combatantId];
    if (!c) throw new Error(`Unknown combatant: ${args.combatantId}`);
    const was = c.concentratingOn?.spell ?? null;
    if (c.concentratingOn) {
      delete c.concentratingOn;
      this.record('engine', `${c.name}'s concentration on ${was} ends`, { combatantId: c.id, concentrationBroken: was });
    }
    return { was };
  }

  // --- P3c: progression (XP + leveling; the engine owns every number from a table) -------------------

  private character(combatantId: string): CharacterState {
    const cs = this.state.characters?.[combatantId];
    if (!cs) throw new Error(`No character progression tracked for ${combatantId}.`);
    return cs;
  }

  /**
   * Award experience. Pure accumulation — it NEVER auto-levels (leveling stays an explicit beat, so the
   * DM controls pacing and the player chooses when). Reports whether a level-up is now available.
   */
  awardXp(args: { combatantId: string; amount: number }): { xp: number; level: number; levelUpAvailable: boolean } {
    const cs = this.character(args.combatantId);
    const amount = Math.max(0, Math.floor(args.amount));
    const before = cs.xp;
    cs.xp = before + amount;
    const levelUpAvailable = levelForXp(cs.xp) > cs.level;
    const name = this.state.combatants[args.combatantId]?.name ?? args.combatantId;
    this.record('engine', `${name} gains ${amount} XP (${before} -> ${cs.xp})${levelUpAvailable ? ` — level ${cs.level + 1} available` : ''}`, { combatantId: args.combatantId, xp: cs.xp, level: cs.level, levelUpAvailable });
    return { xp: cs.xp, level: cs.level, levelUpAvailable };
  }

  /**
   * Level up ONE level when the character's XP supports it. The engine computes the new HP (fixed average
   * by default, or a validated hit-die roll passed as `rolledTotal`), grows the hit-dice pool, derives the
   * new proficiency bonus, and FLAGS an ASI/feat rather than auto-applying it (the player's choice).
   */
  levelUp(args: { combatantId: string; hpMode?: 'avg' | 'roll'; rolledTotal?: number }): { level: number; maxHitPoints: number; hitDiceRemaining: number; proficiencyBonus: number; asiDue: boolean; hpGained: number } {
    const cs = this.character(args.combatantId);
    if (levelForXp(cs.xp) <= cs.level) {
      throw new Error(`${this.state.combatants[args.combatantId]?.name ?? args.combatantId} needs ${XP_THRESHOLDS[cs.level + 1] ?? '—'} XP for level ${cs.level + 1} (has ${cs.xp}).`);
    }
    return this.applyLevelGain(args.combatantId, cs.level + 1, args.hpMode ?? 'avg', args.rolledTotal);
  }

  /**
   * Milestone leveling: the DM grants a level directly (no XP needed). Applies the full gain to the target
   * level with fixed-average HP, and syncs XP up to that level's threshold so the two modes never disagree.
   */
  setMilestoneLevel(args: { combatantId: string; level: number }): { level: number; maxHitPoints: number; hitDiceRemaining: number; proficiencyBonus: number; asiDue: boolean; hpGained: number } {
    const cs = this.character(args.combatantId);
    const target = Math.max(1, Math.min(20, Math.floor(args.level)));
    if (target <= cs.level) throw new Error(`${this.state.combatants[args.combatantId]?.name ?? args.combatantId} is already level ${cs.level}.`);
    const result = this.applyLevelGain(args.combatantId, target, 'avg', undefined);
    cs.xp = Math.max(cs.xp, XP_THRESHOLDS[target] ?? cs.xp);
    return result;
  }

  /** Shared level-gain math: raise the character from its current level to `targetLevel`, one level at a
   *  time, granting HP + a hit die per level and flagging any ASI level crossed. Engine-owned throughout. */
  private applyLevelGain(combatantId: string, targetLevel: number, hpMode: 'avg' | 'roll', rolledTotal?: number): { level: number; maxHitPoints: number; hitDiceRemaining: number; proficiencyBonus: number; asiDue: boolean; hpGained: number } {
    const cs = this.character(combatantId);
    const c = this.state.combatants[combatantId];
    if (!c) throw new Error(`Unknown combatant: ${combatantId}`);
    const sheet = this.state.sheets?.[combatantId];
    const conMod = sheet ? abilityMod(sheet.abilities.con) : 0;
    const dieSize = c.hitDice?.size ?? (sheet ? hitDieForClass(sheet.className) : 8);
    let hpGained = 0;
    let asiDue = false;
    for (let lvl = cs.level + 1; lvl <= targetLevel; lvl++) {
      // A single-level XP level-up may pass a rolled hit die for the first level gained; anything beyond
      // (a multi-level milestone jump) uses the fixed average. Every gain is at least 1 HP.
      const base = hpMode === 'roll' && lvl === cs.level + 1 && rolledTotal !== undefined ? Math.max(1, Math.floor(rolledTotal)) : hitDieAvg(dieSize);
      hpGained += Math.max(1, base + conMod);
      if (c.hitDice) {
        c.hitDice.max += 1;
        c.hitDice.remaining += 1;
      }
      if (ASI_LEVELS.includes(lvl)) asiDue = true;
    }
    c.maxHitPoints += hpGained;
    c.currentHitPoints += hpGained;
    cs.level = targetLevel;
    const proficiencyBonus = deriveProficiencyBonus(cs.level);
    this.record('engine', `${c.name} reaches level ${cs.level} (+${hpGained} HP, prof +${proficiencyBonus})${asiDue ? ' — ASI/feat available' : ''}`, { combatantId, level: cs.level, hpGained, proficiencyBonus, asiDue });
    return { level: cs.level, maxHitPoints: c.maxHitPoints, hitDiceRemaining: c.hitDice?.remaining ?? 0, proficiencyBonus, asiDue, hpGained };
  }

  // --- P3d: economy + inventory + equipment + attunement + revival ---------

  private itemDef(defId: string) {
    const def = this.state.itemCatalog?.[defId];
    if (!def) throw new Error(`Unknown item "${defId}" (not in the catalog).`);
    return def;
  }

  /** Unique-across-the-session instance id (scan the max numeric suffix so a fresh per-turn Engine never collides). */
  private nextInstanceId(defId: string): string {
    let max = 0;
    for (const cs of Object.values(this.state.characters ?? {})) {
      for (const it of cs.items) {
        const m = /#(\d+)$/.exec(it.instanceId);
        if (m) max = Math.max(max, Number(m[1]));
      }
    }
    return `${defId}#${max + 1}`;
  }

  /** Recompute + cache the live AC from equipped gear (the single formula lives in derive.ts). */
  private recomputeArmorClass(combatantId: string): void {
    const c = this.state.combatants[combatantId];
    const cs = this.state.characters?.[combatantId];
    const sheet = this.state.sheets?.[combatantId];
    if (c && cs && sheet) c.armorClass = deriveArmorClass(sheet, cs, this.state.itemCatalog);
  }

  /** Detach an instance from every equip slot + attunement (used on remove/sell so nothing dangles). */
  private detach(cs: CharacterState, instanceId: string): void {
    for (const slot of Object.keys(cs.equipped) as (keyof CharacterState['equipped'])[]) {
      if (cs.equipped[slot] === instanceId) delete cs.equipped[slot];
    }
    cs.attunedInstanceIds = cs.attunedInstanceIds.filter((id) => id !== instanceId);
  }

  /** Add an item to a character. Plain gear/consumables STACK (qty); equippable/magic items get their own
   *  instance so they can be equipped/attuned/tracked apart. Returns the created instance ids. */
  addItem(args: { combatantId: string; itemDefId: string; qty?: number }): { item: string; qty: number; instanceIds: string[] } {
    const cs = this.character(args.combatantId);
    const def = this.itemDef(args.itemDefId);
    const qty = Math.max(1, Math.floor(args.qty ?? 1));
    const stackable = !def.slot && !def.magic && !def.requiresAttunement;
    const instanceIds: string[] = [];
    if (stackable) {
      const existing = cs.items.find((i) => i.defId === def.id);
      if (existing) existing.qty = (existing.qty ?? 1) + qty;
      else {
        const id = this.nextInstanceId(def.id);
        cs.items.push({ defId: def.id, instanceId: id, qty });
        instanceIds.push(id);
      }
    } else {
      for (let i = 0; i < qty; i++) {
        const id = this.nextInstanceId(def.id);
        cs.items.push({ defId: def.id, instanceId: id, qty: 1, ...(def.charges ? { chargesRemaining: def.charges.max } : {}), identified: !def.magic });
        instanceIds.push(id);
      }
    }
    this.record('engine', `${this.state.combatants[args.combatantId]?.name ?? args.combatantId} gains ${qty}× ${def.name}`, { combatantId: args.combatantId, itemDefId: def.id, qty });
    return { item: def.name, qty, instanceIds };
  }

  /** Remove an item — by instanceId (one instance) or by itemDefId + qty (from a stack). Detaches first. */
  removeItem(args: { combatantId: string; instanceId?: string; itemDefId?: string; qty?: number }): { removed: string; qty: number } {
    const cs = this.character(args.combatantId);
    if (args.instanceId) {
      const idx = cs.items.findIndex((i) => i.instanceId === args.instanceId);
      if (idx < 0) throw new Error(`No item ${args.instanceId} carried.`);
      const ref = cs.items[idx]!;
      const name = this.state.itemCatalog?.[ref.defId]?.name ?? ref.defId;
      this.detach(cs, args.instanceId);
      cs.items.splice(idx, 1);
      this.recomputeArmorClass(args.combatantId);
      this.record('engine', `${this.state.combatants[args.combatantId]?.name ?? args.combatantId} loses ${name}`, { combatantId: args.combatantId, instanceId: args.instanceId });
      return { removed: name, qty: 1 };
    }
    if (!args.itemDefId) throw new Error('removeItem needs an instanceId or an itemDefId.');
    const def = this.itemDef(args.itemDefId);
    let qty = Math.max(1, Math.floor(args.qty ?? 1));
    let removed = 0;
    for (let i = cs.items.length - 1; i >= 0 && qty > 0; i--) {
      const ref = cs.items[i]!;
      if (ref.defId !== def.id) continue;
      const take = Math.min(qty, ref.qty ?? 1);
      ref.qty = (ref.qty ?? 1) - take;
      qty -= take;
      removed += take;
      if ((ref.qty ?? 0) <= 0) {
        this.detach(cs, ref.instanceId);
        cs.items.splice(i, 1);
      }
    }
    if (removed === 0) throw new Error(`${this.state.combatants[args.combatantId]?.name ?? args.combatantId} isn't carrying ${def.name}.`);
    this.recomputeArmorClass(args.combatantId);
    this.record('engine', `${this.state.combatants[args.combatantId]?.name ?? args.combatantId} loses ${removed}× ${def.name}`, { combatantId: args.combatantId, itemDefId: def.id, qty: removed });
    return { removed: def.name, qty: removed };
  }

  /** Buy a catalog item: exact cp/sp/gp change-making, refuses if unaffordable, then adds the item. */
  buyItem(args: { combatantId: string; itemDefId: string; qty?: number }): { currency: { cp: number; sp: number; gp: number }; item: string; qty: number; instanceIds: string[] } {
    const cs = this.character(args.combatantId);
    const def = this.itemDef(args.itemDefId);
    if (def.costGp === undefined) throw new Error(`${def.name} is not for sale.`);
    const qty = Math.max(1, Math.floor(args.qty ?? 1));
    const cost = gpToCopper(def.costGp) * qty;
    const have = toCopper(cs.currency);
    if (have < cost) throw new Error(`Can't afford ${qty}× ${def.name} (needs ${def.costGp * qty} gp, has ${(have / 100).toFixed(2)} gp).`);
    cs.currency = fromCopper(have - cost);
    const added = this.addItem(args);
    this.record('engine', `${this.state.combatants[args.combatantId]?.name ?? args.combatantId} buys ${qty}× ${def.name} for ${def.costGp * qty} gp`, { combatantId: args.combatantId, itemDefId: def.id, qty, currency: cs.currency });
    return { currency: cs.currency, item: def.name, qty, instanceIds: added.instanceIds };
  }

  /** Sell an item back for HALF its market value (SRD). Removes it, credits the coins. */
  sellItem(args: { combatantId: string; instanceId?: string; itemDefId?: string; qty?: number }): { currency: { cp: number; sp: number; gp: number }; sold: string; qty: number } {
    const cs = this.character(args.combatantId);
    const defId = args.itemDefId ?? cs.items.find((i) => i.instanceId === args.instanceId)?.defId;
    if (!defId) throw new Error('Nothing to sell (unknown item).');
    const def = this.itemDef(defId);
    if (def.costGp === undefined) throw new Error(`${def.name} has no resale value.`);
    const { qty } = this.removeItem(args);
    const credit = Math.floor((gpToCopper(def.costGp) * qty) / 2);
    cs.currency = fromCopper(toCopper(cs.currency) + credit);
    this.record('engine', `${this.state.combatants[args.combatantId]?.name ?? args.combatantId} sells ${qty}× ${def.name} for ${(credit / 100).toFixed(2)} gp`, { combatantId: args.combatantId, itemDefId: def.id, qty, currency: cs.currency });
    return { currency: cs.currency, sold: def.name, qty };
  }

  /** Equip an item into its slot (replacing whatever was there). Recomputes AC from armor/shield. */
  equipItem(args: { combatantId: string; instanceId: string }): { slot: string; armorClass: number } {
    const cs = this.character(args.combatantId);
    const ref = cs.items.find((i) => i.instanceId === args.instanceId);
    if (!ref) throw new Error(`No item ${args.instanceId} carried.`);
    const def = this.itemDef(ref.defId);
    if (!def.slot) throw new Error(`${def.name} can't be equipped.`);
    cs.equipped[def.slot] = args.instanceId;
    this.recomputeArmorClass(args.combatantId);
    const ac = this.state.combatants[args.combatantId]?.armorClass ?? 0;
    this.record('engine', `${this.state.combatants[args.combatantId]?.name ?? args.combatantId} equips ${def.name} (AC ${ac})`, { combatantId: args.combatantId, slot: def.slot, instanceId: args.instanceId, armorClass: ac });
    return { slot: def.slot, armorClass: ac };
  }

  /** Unequip a slot (or a specific instance). Recomputes AC (falling back to the sheet's printed value). */
  unequipItem(args: { combatantId: string; slot?: 'armor' | 'shield' | 'mainHand' | 'offHand' | 'ranged'; instanceId?: string }): { armorClass: number } {
    const cs = this.character(args.combatantId);
    if (args.slot) delete cs.equipped[args.slot];
    else if (args.instanceId) this.detachEquip(cs, args.instanceId);
    else throw new Error('unequipItem needs a slot or an instanceId.');
    this.recomputeArmorClass(args.combatantId);
    const ac = this.state.combatants[args.combatantId]?.armorClass ?? 0;
    this.record('engine', `${this.state.combatants[args.combatantId]?.name ?? args.combatantId} unequips an item (AC ${ac})`, { combatantId: args.combatantId, armorClass: ac });
    return { armorClass: ac };
  }

  private detachEquip(cs: CharacterState, instanceId: string): void {
    for (const slot of Object.keys(cs.equipped) as (keyof CharacterState['equipped'])[]) {
      if (cs.equipped[slot] === instanceId) delete cs.equipped[slot];
    }
  }

  /** Attune to a magic item — enforces the SRD cap of 3 and that the item is identified first. */
  attuneItem(args: { combatantId: string; instanceId: string }): { attunedInstanceIds: string[] } {
    const cs = this.character(args.combatantId);
    const ref = cs.items.find((i) => i.instanceId === args.instanceId);
    if (!ref) throw new Error(`No item ${args.instanceId} carried.`);
    const def = this.itemDef(ref.defId);
    if (!def.requiresAttunement) throw new Error(`${def.name} doesn't require attunement.`);
    if (def.magic && !ref.identified) throw new Error(`${def.name} must be identified before attuning.`);
    if (cs.attunedInstanceIds.includes(args.instanceId)) return { attunedInstanceIds: cs.attunedInstanceIds };
    if (cs.attunedInstanceIds.length >= 3) throw new Error(`Already attuned to 3 items — unattune one first.`);
    cs.attunedInstanceIds.push(args.instanceId);
    this.record('engine', `${this.state.combatants[args.combatantId]?.name ?? args.combatantId} attunes to ${def.name} (${cs.attunedInstanceIds.length}/3)`, { combatantId: args.combatantId, instanceId: args.instanceId });
    return { attunedInstanceIds: cs.attunedInstanceIds };
  }

  /** Drop attunement to an item. */
  unattuneItem(args: { combatantId: string; instanceId: string }): { attunedInstanceIds: string[] } {
    const cs = this.character(args.combatantId);
    cs.attunedInstanceIds = cs.attunedInstanceIds.filter((id) => id !== args.instanceId);
    this.record('engine', `${this.state.combatants[args.combatantId]?.name ?? args.combatantId} ends attunement`, { combatantId: args.combatantId, instanceId: args.instanceId });
    return { attunedInstanceIds: cs.attunedInstanceIds };
  }

  /** Identify a (magic) item so its effects/attunement unlock — via a short rest with it or an Identify spell. */
  identifyItem(args: { combatantId: string; instanceId: string }): { identified: true; item: string } {
    const cs = this.character(args.combatantId);
    const ref = cs.items.find((i) => i.instanceId === args.instanceId);
    if (!ref) throw new Error(`No item ${args.instanceId} carried.`);
    const def = this.itemDef(ref.defId);
    ref.identified = true;
    this.record('engine', `${this.state.combatants[args.combatantId]?.name ?? args.combatantId} identifies ${def.name}`, { combatantId: args.combatantId, instanceId: args.instanceId });
    return { identified: true, item: def.name };
  }

  /** Raise a dead character (Revivify / Raise Dead): clears death and restores HP. The one path back
   *  from dead — heal() deliberately refuses a dead target. */
  revive(args: { combatantId: string; hpRestored?: number }): { current: number } {
    const c = this.state.combatants[args.combatantId];
    if (!c) throw new Error(`Unknown combatant: ${args.combatantId}`);
    if (!c.dead) throw new Error(`${c.name} isn't dead.`);
    c.dead = false;
    c.downed = false;
    delete c.deathSaves;
    c.conditions = c.conditions.filter((x) => x !== 'unconscious');
    c.currentHitPoints = Math.max(1, Math.min(c.maxHitPoints, Math.floor(args.hpRestored ?? 1)));
    this.record('engine', `${c.name} is restored to life (${c.currentHitPoints} HP)`, { combatantId: c.id, current: c.currentHitPoints });
    return { current: c.currentHitPoints };
  }
}
