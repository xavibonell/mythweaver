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
  applySceneDeltas,
  type ApplyResult,
  type SceneDelta,
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
  type Poi,
  type PoiContents,
  type PoiKind,
  type RollRequest,
  type RollResult,
  type Skill,
  type StatBlock,
} from '@mythweaver/shared';
import { rollDice, validateDeclaredRoll, type Rng } from './dice.js';
import { generateStatBlock, type MonsterSpec } from './monster-gen.js';
import { bumpSpatialVersion, spatialIndex } from './spatial/oracle.js';
import { deriveMoveCaps, runTravel, swimGateFailure, type TravelIntent, type TravelVerdict } from './spatial/travel.js';
import { classifyReach, reachRequiredFt, type AttackMode, type ReachReason, type ReachVerdict } from './spatial/reach.js';
import type { SceneMap, JournalEvent} from '@mythweaver/shared';
import { statBlockToCombatant } from './state.js';
import { abilityMod, deriveAbilityCheckModifier, deriveArmorClass, derivePassive, deriveProficiencyBonus, deriveSaveModifier, deriveSkillModifier, deriveSpellsPreparedMax } from './derive.js';
import { ASI_LEVELS, XP_THRESHOLDS, hitDieAvg, hitDieForClass, levelForXp } from './progression.js';

/** Coin math in the smallest unit so change-making is exact (1 gp = 10 sp = 100 cp). */
const toCopper = (c: { cp: number; sp: number; gp: number }): number => Math.round(c.cp + c.sp * 10 + c.gp * 100);
const fromCopper = (total: number): { cp: number; sp: number; gp: number } => ({ gp: Math.floor(total / 100), sp: Math.floor((total % 100) / 10), cp: total % 10 });
const gpToCopper = (gp: number): number => Math.round(gp * 100);
const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';

export class Engine implements EngineTools {
  private readonly pending = new Map<string, RollRequest>();
  private rollSeq = 0;

  constructor(private readonly state: GameState, private readonly rng: Rng = Math.random) {}

  // --- P0: read-only state + dice -----------------------------------------

  getState(): GameState {
    return this.state;
  }

  /**
   * Resolve a combatant the DM names loosely — the LLM habitually invents "pc:<name>" ids instead of the
   * real "pc:pc-1-fighter". Accept an exact id, a "pc:"/"npc:"-prefixed name, a bare name, or the refId,
   * so every character tool works with the natural handle. Returns the real combatant id, or undefined.
   */
  findCombatantId(idOrName: string): string | undefined {
    const raw = (idOrName ?? '').trim();
    if (!raw) return undefined;
    if (this.state.combatants[raw]) return raw;
    const bare = raw.replace(/^(pc|npc):/i, '').toLowerCase();
    const rawLower = raw.toLowerCase();
    const match = Object.values(this.state.combatants).find((c) => c.id.toLowerCase() === rawLower || c.name.toLowerCase() === bare || c.id.toLowerCase() === bare || c.refId.toLowerCase() === bare);
    return match?.id;
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

  /**
   * THE JOURNAL (docs/PLAYER-INTERFACE.md §2) — the ONE door into the players' world-model.
   *
   * Distinct from `record()`, which is a DM-grade audit trail carrying DCs, arc flags and staging
   * chatter. Everything written here is composed PLAYER-SAFE at the call site, from what the table just
   * witnessed, so the stream ships to a player screen verbatim and never needs read-time redaction.
   * Never throws: a Book entry must not be able to break a turn.
   */
  journal(e: { kind: JournalEvent['kind']; subjects?: string[]; text: string; data?: JournalEvent['data'] }): void {
    try {
      const j = (this.state.journal ??= []);
      const world = this.state.world;
      j.push({
        seq: j.length + 1, // NOT the turn: a roll-resume shares its originating turn's number
        turn: this.state.turnCount ?? 0,
        beatId: this.state.currentSceneId,
        ...(world?.currentLocationId ? { locationId: world.currentLocationId } : {}),
        kind: e.kind,
        subjects: e.subjects ?? [],
        text: e.text.length > 240 ? `${e.text.slice(0, 237)}…` : e.text,
        ...(e.data ? { data: e.data } : {}),
      });
    } catch { /* the Book is never worth a turn */ }
  }

  // --- P3e: checks + saves (the engine owns the +N on every d20) ------------
  // The player rolls a RAW d20; the engine adds the modifier it derives from the sheet + progression
  // (ability + proficiency/expertise/half + exhaustion) and rules success vs the DC. Nothing about the
  // bonus is the LLM's to invent. (resolveAttack stays reserved — combat uses requestRoll/applyDamage.)

  /** The engine's modifier for an ability/skill CHECK by this character (derive-don't-store). */
  checkModifier(args: { combatantId: string; skill?: Skill; ability: Ability }): number {
    const c = this.state.combatants[args.combatantId];
    if (!c) throw new Error(`Unknown combatant: ${args.combatantId}`);
    const sheet = this.state.sheets?.[args.combatantId];
    if (!sheet) return abilityMod({ str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }[args.ability]); // no sheet → +0
    const cs = this.state.characters?.[args.combatantId];
    return args.skill ? deriveSkillModifier(sheet, cs, args.skill, c.exhaustion) : deriveAbilityCheckModifier(sheet, args.ability, c.exhaustion);
  }

  /** The engine's modifier for a SAVING THROW by this character. */
  saveModifier(args: { combatantId: string; ability: Ability }): number {
    const c = this.state.combatants[args.combatantId];
    if (!c) throw new Error(`Unknown combatant: ${args.combatantId}`);
    const sheet = this.state.sheets?.[args.combatantId];
    if (!sheet) return 0;
    return deriveSaveModifier(sheet, this.state.characters?.[args.combatantId], args.ability, c.exhaustion);
  }

  resolveCheck(args: { combatantId: string; skill?: Skill; ability: Ability; dc: number; d20: number }): CheckResult {
    const modifier = this.checkModifier(args);
    const d20 = Math.max(1, Math.min(20, Math.floor(args.d20)));
    const total = d20 + modifier;
    const success = total >= args.dc;
    this.record('engine', `${this.state.combatants[args.combatantId]?.name ?? args.combatantId} ${args.skill ?? args.ability} check: ${d20}${modifier >= 0 ? '+' : ''}${modifier} = ${total} vs DC ${args.dc} — ${success ? 'success' : 'fail'}`, { combatantId: args.combatantId, skill: args.skill, ability: args.ability, d20, modifier, total, dc: args.dc, success });
    return { total, dc: args.dc, success, ...(d20 === 20 ? { critical: 'hit' as const } : d20 === 1 ? { critical: 'miss' as const } : {}) };
  }

  resolveSave(args: { combatantId: string; ability: Ability; dc: number; d20: number }): CheckResult {
    const modifier = this.saveModifier(args);
    const d20 = Math.max(1, Math.min(20, Math.floor(args.d20)));
    const total = d20 + modifier;
    const success = total >= args.dc;
    this.record('engine', `${this.state.combatants[args.combatantId]?.name ?? args.combatantId} ${args.ability} save: ${d20}${modifier >= 0 ? '+' : ''}${modifier} = ${total} vs DC ${args.dc} — ${success ? 'success' : 'fail'}`, { combatantId: args.combatantId, ability: args.ability, d20, modifier, total, dc: args.dc, success });
    return { total, dc: args.dc, success, ...(d20 === 20 ? { critical: 'hit' as const } : d20 === 1 ? { critical: 'miss' as const } : {}) };
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
   * Living-world reactions (P3): promote a MAP-ONLY npc token into a damageable/movable combatant AT its
   * current cell. The combatant id is bound to the EXISTING token id, so `applyDamage` and `travel` both
   * resolve to the same actor with no id translation. Idempotent — a token already promoted is returned
   * unchanged (re-promotion would reset its HP to full). Creates no new token, moves nothing, leaves
   * occupancy untouched. `spec` (from the token's persona archetype) shapes the stats; the default is a
   * CR-0 commoner. Returns undefined for a missing token, a non-actor, or a PC.
   */
  promoteToken(tokenId: string, spec?: MonsterSpec): Combatant | undefined {
    const world = this.state.world;
    const map = world?.currentLocationId ? world.locations[world.currentLocationId] : undefined;
    const obj = map?.objects.find((o) => o.id === tokenId);
    if (!obj || obj.kind !== 'actor' || obj.role === 'pc') return undefined;
    const existing = this.state.combatants[tokenId];
    if (existing) return existing; // idempotent — never re-promote (that would heal it to full)
    const sb = generateStatBlock(spec ?? { name: obj.name ?? 'Villager', challengeRating: 0, primaryAbility: 'dex' });
    (this.state.bestiary ??= {})[sb.id] = sb; // register so deriveMoveCaps reads its real speed
    return this.spawnCombatant(sb, tokenId, obj.name);
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

  /** Apply DM-proposed SceneDeltas to the CURRENT location's frozen map (Contract 4, wired).
   *  The engine is the sole mutation gateway: the pure applier owns geometry (anchor resolution,
   *  walkability, occupancy) and every refusal comes back as a narratable reason. Actor ids resolve
   *  loosely (combatant handles vs map ids) before applying, mirroring findCombatantId. */
  /** SPATIAL: sanitize PARTY STAGING on a loaded/frozen scene — every PC must start outdoors, on
   *  ground that LOOKS like ground (walkable water-art reads as "standing on the lake" to players,
   *  whatever the collision layer says), and clustered with the party. Generation staging scatter
   *  and bad freezes both land here, so no fixture can present a stranded/indoor/wet party again. */
  sanitizePartyStaging(): string[] {
    const world = this.state.world;
    const map = world?.currentLocationId ? world.locations[world.currentLocationId] : undefined;
    if (!map) return [];
    const idx = spatialIndex(map);
    const { cols, rows } = map.grid;
    const pcs = map.objects.filter((o) => o.role === 'pc');
    if (!pcs.length) return [];
    const occupied = new Set(map.objects.filter((o) => o.kind === 'actor' && o.visible !== false).map((o) => `${o.col},${o.row}`));
    const sane = (c: number, r: number): boolean => {
      if (c < 0 || c >= cols || r < 0 || r >= rows) return false;
      const k = r * cols + c;
      if (idx.roomId[k] === -1 || idx.roofAt.has(k)) return false; // walkable + outdoors
      const tag = map.tiles?.[r]?.[c] ?? '';
      return !tag.startsWith('water') && !tag.startsWith('wall'); // and LOOKS dry
    };
    // Cluster capacity: free sane cells within 2 of (c,r) — the anchor must have room for the PARTY
    // (an islet PC is "sane" but can host no one; anchoring there strands everyone — seen in the wild).
    const capacity = (c: number, r: number): number => {
      let n = 0;
      for (let dr = -2; dr <= 2; dr++)
        for (let dc = -2; dc <= 2; dc++) {
          if (!dr && !dc) continue;
          if (sane(c + dc, r + dr) && !occupied.has(`${c + dc},${r + dr}`)) n++;
        }
      return n;
    };
    const need = pcs.length - 1;
    const cx = pcs.reduce((t, p) => t + p.col, 0) / pcs.length;
    const cy = pcs.reduce((t, p) => t + p.row, 0) / pcs.length;
    const facts: string[] = [];

    // Anchor: a sane PC whose neighborhood can host the party; else the roomiest sane cell nearest
    // the party centroid (move the first PC there — the whole party regroups around it).
    let anchorPc = pcs.find((p) => sane(p.col, p.row) && capacity(p.col, p.row) >= need);
    if (!anchorPc) {
      let best: { col: number; row: number } | undefined;
      let bestScore = -Infinity;
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          if (!sane(c, r) || occupied.has(`${c},${r}`)) continue;
          const cap = capacity(c, r);
          if (cap < need) continue;
          const score = -Math.max(Math.abs(c - cx), Math.abs(r - cy)); // nearest roomy cell to the party
          if (score > bestScore) { bestScore = score; best = { col: c, row: r }; }
        }
      if (!best) return []; // pathological map — leave it alone
      const p0 = pcs[0]!;
      occupied.delete(`${p0.col},${p0.row}`);
      this.applySceneDeltas([{ op: 'move', id: p0.id, to: best }]);
      occupied.add(`${p0.col},${p0.row}`);
      facts.push(`staging: moved ${p0.name ?? p0.id} to open ground with room for the party`);
      anchorPc = p0;
    }
    for (const p of pcs) {
      if (p === anchorPc) continue;
      const far = Math.max(Math.abs(p.col - anchorPc.col), Math.abs(p.row - anchorPc.row)) > 3;
      if (sane(p.col, p.row) && !far) continue;
      let placed = false;
      for (let radius = 1; radius <= 4 && !placed; radius++)
        for (let dr = -radius; dr <= radius && !placed; dr++)
          for (let dc = -radius; dc <= radius && !placed; dc++) {
            if (Math.max(Math.abs(dr), Math.abs(dc)) !== radius) continue;
            const c = anchorPc.col + dc, r = anchorPc.row + dr;
            if (!sane(c, r) || occupied.has(`${c},${r}`)) continue;
            occupied.delete(`${p.col},${p.row}`);
            const res = this.applySceneDeltas([{ op: 'move', id: p.id, to: { col: c, row: r } }]);
            if (res.applied.length) {
              occupied.add(`${p.col},${p.row}`);
              facts.push(`staging: regrouped ${p.name ?? p.id} beside ${anchorPc.name ?? anchorPc.id}`);
              placed = true;
            }
          }
    }
    for (const f of facts) this.record('engine', f, { staging: true });
    return facts;
  }

  /** SPATIAL R2: the single movement gate (docs/SPATIAL-TRUTH.md). Callers resolve fiction-words
   *  to map ids first; the engine owns the path, media pricing, gates and the frontier degrade. */
  travel(intent: TravelIntent): TravelVerdict {
    const world = this.state.world;
    const map = world?.currentLocationId ? world.locations[world.currentLocationId] : undefined;
    if (!map) return { moved: false, ft: 0, rounds: 0, legs: [], facts: [], rejected: 'no scene established' };
    const verdict = runTravel({ state: this.state, map, applyMove: (actorId, to) => this.travelApplyMove(map, actorId, to) }, intent);
    if (verdict.facts.length) this.record('engine', `travel: ${verdict.facts[0]}`, { travel: { actorId: intent.actorId, ...verdict } });
    return verdict;
  }

  /**
   * SPATIAL R4 (slice 1): the ATTACK legality gate — can this blow reach that target at all?
   * Callers must not apply damage when `ok` is false. Out of reach but closable in one move ⇒ the
   * engine WALKS the attacker in through `travel()` (so the single movement gate still owns every
   * step) and returns the approach for the client tween. Degrades OPEN — no scene, no map token, or
   * an unresolvable id yields ok:true, so a mapless session behaves exactly as before.
   */
  attackReach(intent: { attackerId: string; targetId: string; mode?: AttackMode }): ReachVerdict {
    const mode: AttackMode = intent.mode ?? 'melee';
    const allow = (reason: ReachReason, facts: string[] = []): ReachVerdict => ({ ok: true, distanceFt: 0, requiredFt: 0, reason, facts });
    const world = this.state.world;
    const map = world?.currentLocationId ? world.locations[world.currentLocationId] : undefined;
    if (!map) return allow('unpositioned');

    const find = (id: string) => {
      const direct = map.objects.find((o) => o.id === id);
      if (direct) return direct;
      const cid = this.findCombatantId(id);
      const name = cid ? this.state.combatants[cid]?.name : undefined;
      return (cid ? map.objects.find((o) => o.id === cid) : undefined)
        ?? (name ? map.objects.find((o) => (o.name ?? '').toLowerCase() === name.toLowerCase()) : undefined);
    };
    const attacker = find(intent.attackerId);
    const target = find(intent.targetId);
    if (!attacker || !target) return allow('unpositioned'); // can't judge geometry we don't have

    const idx = spatialIndex(map);
    const verdict = classifyReach({
      idx,
      attacker: { col: attacker.col, row: attacker.row },
      target: { col: target.col, row: target.row },
      attackerName: attacker.name ?? attacker.id,
      targetName: target.name ?? target.id,
      mode,
      req: reachRequiredFt(this.state, this.findCombatantId(intent.attackerId) ?? intent.attackerId, mode),
      caps: deriveMoveCaps(this.state, this.findCombatantId(intent.attackerId) ?? intent.attackerId),
    });

    // The ONLY side effect: close the distance through the single movement gate.
    if (verdict.ok && verdict.reason === 'closed-to-reach' && verdict.approach) {
      const t = this.travel({ actorId: attacker.id, to: { col: verdict.approach.at.col, row: verdict.approach.at.row }, mode: 'auto' });
      if (!t.moved || !t.at) {
        return { ...verdict, ok: false, reason: 'no-route', approach: undefined, facts: [], corrective: `${attacker.name ?? attacker.id} could not close on ${target.name ?? target.id} (${t.rejected ?? 'the way is blocked'}). The blow does NOT land.` };
      }
      verdict.approach = { ft: verdict.approach.ft, at: t.at, actorId: attacker.id, ...(t.pathCells?.length ? { pathCells: t.pathCells } : {}) };
    }
    this.record('engine', `reach: ${verdict.reason} (${verdict.distanceFt} ft vs ${verdict.requiredFt} ft)`, { reach: { ...verdict, attackerId: attacker.id, targetId: target.id } });
    return verdict;
  }

  /** Fail-forward after a FAILED swim gate — the world moves even on a miss (no free retries). */
  swimGateFail(actorId: string): string[] {
    const world = this.state.world;
    const map = world?.currentLocationId ? world.locations[world.currentLocationId] : undefined;
    if (!map) return [];
    const facts = swimGateFailure({ state: this.state, map, applyMove: (id, to) => this.travelApplyMove(map, id, to) }, actorId);
    for (const f of facts) this.record('engine', `travel: ${f}`);
    return facts;
  }

  private travelApplyMove(map: SceneMap, actorId: string, to: { col: number; row: number }): { applied: boolean; at?: { col: number; row: number } } {
    const res = this.applySceneDeltas([{ op: 'move', id: actorId, to: { col: to.col, row: to.row } }]);
    const a = res.applied.find((d) => d.op === 'move');
    return { applied: !!a, ...(a && 'to' in a ? { at: a.to as { col: number; row: number } } : {}) };
  }

  applySceneDeltas(deltas: SceneDelta[]): ApplyResult {
    const world = this.state.world;
    const map = world?.currentLocationId ? world.locations[world.currentLocationId] : undefined;
    if (!map) return { applied: [], rejected: deltas.map((delta) => ({ delta, reason: 'no scene is established yet (call setScene first)' })) };
    // Loose actor-id resolution: the DM may address a combatant handle ("npc:goblin-1") whose map
    // object id differs, or vice versa. Map combatant ids/names onto map-object ids where possible.
    const resolved = deltas.map((d) => {
      if (!('id' in d) || map.objects.some((o) => o.id === d.id)) return d;
      const cid = this.findCombatantId(d.id);
      if (cid && map.objects.some((o) => o.id === cid)) return { ...d, id: cid } as SceneDelta;
      const byName = cid ? this.state.combatants[cid]?.name : undefined;
      if (byName) {
        const obj = map.objects.find((o) => (o.name ?? '').toLowerCase() === byName.toLowerCase());
        if (obj) return { ...d, id: obj.id } as SceneDelta;
      }
      return d; // the applier's own loose lookup gets a final try (or refuses with a reason)
    });
    const res = applySceneDeltas(map, resolved);
    if (res.applied.length) bumpSpatialVersion(map); // spatial oracle rebuilds on next read (derive-don't-store)
    for (const a of res.applied) {
      const detail = a.op === 'move' ? ` → (${(a.to as { col: number }).col},${(a.to as { row: number }).row})` : a.op === 'spawn' ? ` at (${a.at?.col},${a.at?.row})` : '';
      this.record('engine', `scene: ${a.op} ${a.id}${detail}`, { sceneDelta: a });
    }
    return res;
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
    // The Book's chapter boundary. Emitted here rather than in the tool handler so EVERY caller
    // chapters the journal, including a table that is only watching the poll.
    const title = this.state.adventure?.scenes[toSceneId]?.title ?? toSceneId;
    this.journal({ kind: 'chapter', subjects: [toSceneId], text: title, data: { from, to: toSceneId, outcome: outcome ?? 'done', opened: true } });
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
    // Authored persona colour (living-world reactivity): merge over any prior, clip the free-text bits.
    const persona = { ...(prev?.persona ?? {}), ...(card.persona ?? {}) };
    const merged: EntityCard = {
      id: card.id,
      kind: card.kind ?? prev?.kind ?? 'other',
      name: Engine.clip(card.name, 80) || prev?.name || card.id,
      ...(aliases.length ? { aliases } : {}),
      ...(voice.tic || voice.want || voice.fear ? { voice: { ...(voice.tic ? { tic: Engine.clip(voice.tic, 120) } : {}), ...(voice.want ? { want: Engine.clip(voice.want, 120) } : {}), ...(voice.fear ? { fear: Engine.clip(voice.fear, 120) } : {}) } } : {}),
      ...(persona.archetype || persona.temper || persona.allegiance || persona.stake
        ? { persona: { ...(persona.archetype ? { archetype: persona.archetype } : {}), ...(persona.temper ? { temper: persona.temper } : {}), ...(persona.allegiance ? { allegiance: Engine.clip(persona.allegiance, 80) } : {}), ...(persona.stake ? { stake: Engine.clip(persona.stake, 120) } : {}) } }
        : {}),
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

  // --- P3f: caster completeness (prepared-spell limits + ritual casting) ---

  /** Re-prepare a caster's spell list (typically on a long rest). Enforces the derived cap. */
  prepareSpells(args: { combatantId: string; prepared: string[] }): { prepared: string[]; max: number } {
    const c = this.state.combatants[args.combatantId];
    if (!c) throw new Error(`Unknown combatant: ${args.combatantId}`);
    const sheet = this.state.sheets?.[args.combatantId];
    if (!sheet?.spellcasting) throw new Error(`${c.name} is not a spellcaster.`);
    const max = deriveSpellsPreparedMax(sheet, this.state.characters?.[args.combatantId]) ?? 0;
    const prepared = [...new Set(args.prepared.map((s) => s.trim()).filter(Boolean))];
    if (prepared.length > max) throw new Error(`${c.name} can prepare at most ${max} spells (tried ${prepared.length}).`);
    c.preparedSpells = prepared;
    this.record('engine', `${c.name} prepares ${prepared.length}/${max} spells`, { combatantId: c.id, prepared, max });
    return { prepared, max };
  }

  /** Cast a spell as a RITUAL — no spell slot spent. The engine verifies the spell is ritual-tagged. */
  castRitual(args: { combatantId: string; spell: string }): { ritual: true; spell: string } {
    const c = this.state.combatants[args.combatantId];
    if (!c) throw new Error(`Unknown combatant: ${args.combatantId}`);
    const sheet = this.state.sheets?.[args.combatantId];
    if (!sheet?.spellcasting) throw new Error(`${c.name} is not a spellcaster.`);
    const spell = args.spell.trim();
    const rituals = sheet.spellcasting.rituals ?? [];
    if (!rituals.some((r) => r.toLowerCase() === spell.toLowerCase())) throw new Error(`${spell} can't be cast as a ritual by ${c.name}.`);
    this.record('engine', `${c.name} casts ${spell} as a ritual (no slot spent)`, { combatantId: c.id, spell, ritual: true });
    return { ritual: true, spell };
  }

  // --- P4: Points of Interest (hidden/interactive scene objects) -----------

  private poiMap(): Record<string, Poi> {
    return (this.state.pois ??= {});
  }

  private poi(id: string): Poi {
    const p = this.state.pois?.[id];
    if (!p) throw new Error(`Unknown POI "${id}".`);
    return p;
  }

  /**
   * Place a point of interest / interactable — a hidden chest, a secret cellar door, a searchable altar.
   * The engine owns this DM-SECRET truth (discover DC, contents); players never see it until it's found.
   * Contents are validated against the item catalog NOW so a typo fails at placement, not at loot.
   */
  placePoi(args: { id: string; locationId?: string; kind: PoiKind; look: string; anchor?: string; hidden?: boolean; discoverDc?: number; contents?: PoiContents; leadsTo?: string; fixtureId?: string; notes?: string }): { id: string; hidden: boolean; locationId: string } {
    const raw = (args.id ?? '').trim();
    const id = /^poi:/i.test(raw) ? raw : `poi:${slugify(raw || args.look || 'poi')}`;
    if (!(['container', 'passage', 'feature', 'hidden-cache'] as PoiKind[]).includes(args.kind)) throw new Error(`Bad POI kind "${args.kind}".`);
    const look = (args.look ?? '').trim();
    if (!look) throw new Error('placePoi needs a look (a short description).');
    const locationId = args.locationId?.trim() || this.state.world?.currentLocationId;
    if (!locationId) throw new Error('placePoi needs a locationId (no current location established yet).');
    const hidden = !!args.hidden;
    if (hidden && !(typeof args.discoverDc === 'number' && args.discoverDc > 0)) throw new Error('a hidden POI needs a discoverDc (the DC to find it).');
    if (args.kind === 'passage' && !args.leadsTo) throw new Error('a passage POI needs "leadsTo" (a loc: id or a scene id).');
    let contents: PoiContents | undefined;
    if (args.contents) {
      const items = (args.contents.items ?? []).map((it) => {
        this.itemDef(it.itemDefId); // throws on an unknown catalog id
        return { itemDefId: it.itemDefId, ...(it.qty && it.qty > 1 ? { qty: Math.floor(it.qty) } : {}) };
      });
      const gold = Math.max(0, Math.floor(args.contents.gold ?? 0));
      contents = { ...(items.length ? { items } : {}), ...(gold ? { gold } : {}) };
    }
    const poi: Poi = {
      id,
      locationId,
      kind: args.kind,
      look,
      hidden,
      discovered: false,
      searched: false,
      looted: false,
      fixtureId: args.fixtureId?.trim() || `prop:${slugify(id.replace(/^poi:/, ''))}`,
      ...(args.anchor ? { anchor: args.anchor.trim().slice(0, 60) } : {}),
      ...(hidden ? { discoverDc: Math.floor(args.discoverDc!) } : {}),
      ...(contents ? { contents } : {}),
      ...(args.leadsTo ? { leadsTo: args.leadsTo.trim() } : {}),
      ...(args.notes ? { notes: args.notes.trim().slice(0, 240) } : {}),
    };
    this.poiMap()[id] = poi;
    this.record('engine', `POI placed: ${id} (${args.kind}) at ${locationId}${hidden ? ` — hidden DC ${poi.discoverDc}` : ''}`, { poiId: id, locationId, kind: args.kind, hidden });
    return { id, hidden, locationId };
  }

  /** The party found a POI (a Perception/Investigation check beat its DC, or they looked in the right place).
   *  Idempotent; clears `hidden` so the render-shadow can be revealed; echoes to canon. */
  discoverPoi(args: { id: string; by?: string }): { id: string; revealed: boolean } {
    const p = this.poi(args.id);
    if (p.discovered) return { id: p.id, revealed: false };
    p.discovered = true;
    p.hidden = false;
    this.record('engine', `POI discovered: ${p.id} (${p.look})${args.by ? ` — ${args.by}` : ''}`, { poiId: p.id, by: args.by });
    this.recordFact({ subject: p.id, attribute: 'discovered', value: p.look, source: 'dm' });
    this.journal({ kind: 'finding', subjects: [p.id, ...(p.fixtureId ? [p.fixtureId] : [])], text: `Found: ${p.look}`, data: { status: 'spotted' } });
    return { id: p.id, revealed: true };
  }

  /** SRD passive notice: for each hidden POI in a location, if the party's best passive Perception ≥ its DC,
   *  they spot it without looking. Returns the ids discovered (so the orchestrator can reveal their shadows). */
  autoNoticePois(args?: { locationId?: string }): { discovered: string[] } {
    const loc = args?.locationId ?? this.state.world?.currentLocationId;
    const pcs = Object.values(this.state.combatants).filter((c) => c.kind === 'pc');
    const passives = pcs.map((c) => {
      const sheet = this.state.sheets?.[c.id];
      return sheet ? derivePassive(sheet, this.state.characters?.[c.id], 'perception', c.exhaustion) : 10;
    });
    const best = passives.length ? Math.max(...passives) : 10;
    const discovered: string[] = [];
    for (const p of Object.values(this.state.pois ?? {})) {
      if (p.hidden && !p.discovered && p.locationId === loc && (p.discoverDc ?? Infinity) <= best) {
        this.discoverPoi({ id: p.id, by: `passive perception ${best}` });
        discovered.push(p.id);
      }
    }
    return { discovered };
  }

  /** Search a discovered POI — describe what's inside (no transfer). Requires it be found first. */
  searchPoi(args: { id: string }): { id: string; contents: PoiContents | null; empty: boolean } {
    const p = this.poi(args.id);
    if (!p.discovered) throw new Error(`${p.id} hasn't been found yet.`);
    p.searched = true;
    const has = !!p.contents && ((p.contents.items?.length ?? 0) > 0 || (p.contents.gold ?? 0) > 0);
    const empty = p.looted || !has;
    this.record('engine', `POI searched: ${p.id}${empty ? ' — empty' : ''}`, { poiId: p.id, empty });
    const seen = empty ? [] : [
      ...(p.contents?.items ?? []).map((it) => {
        const def = this.state.itemCatalog?.[it.itemDefId];
        const masked = def?.magic ? `an unidentified ${def.category ?? 'item'}` : def?.name ?? it.itemDefId;
        return `${it.qty && it.qty > 1 ? `${it.qty}× ` : ''}${masked}`;
      }),
      ...((p.contents?.gold ?? 0) > 0 ? [`${p.contents!.gold} gp`] : []),
    ];
    this.journal({ kind: 'finding', subjects: [p.id], text: empty ? `${p.look} — nothing inside.` : `${p.look} — ${seen.join(', ')}.`, data: { status: 'searched', empty } });
    return { id: p.id, contents: p.looted || !has ? null : p.contents!, empty };
  }

  /** Credit gold to a character (internal — no public "give money" tool; gold moves only via loot/buy/sell). */
  private creditGold(combatantId: string, gp: number): void {
    const cs = this.character(combatantId);
    cs.currency = fromCopper(toCopper(cs.currency) + gpToCopper(Math.max(0, Math.floor(gp))));
  }

  /** Loot a discovered POI: transfer its contents to a character (reuses P3d addItem + gold). Idempotent —
   *  a looted POI never double-grants. Echoes the looted status to canon so it stays empty on re-entry. */
  lootPoi(args: { id: string; combatantId: string }): { id: string; items: string[]; gold: number; alreadyLooted: boolean } {
    const p = this.poi(args.id);
    if (!p.discovered) throw new Error(`${p.id} hasn't been found yet.`);
    const cid = this.findCombatantId(args.combatantId);
    if (!cid) throw new Error(`Unknown combatant: ${args.combatantId}`);
    if (p.looted) return { id: p.id, items: [], gold: 0, alreadyLooted: true };
    const items: string[] = [];
    for (const it of p.contents?.items ?? []) {
      const added = this.addItem({ combatantId: cid, itemDefId: it.itemDefId, qty: it.qty ?? 1 });
      items.push(`${it.qty && it.qty > 1 ? `${it.qty}× ` : ''}${added.item}`);
    }
    const gold = p.contents?.gold ?? 0;
    if (gold > 0) this.creditGold(cid, gold);
    p.looted = true;
    p.searched = true;
    const name = this.state.combatants[cid]?.name ?? cid;
    this.record('engine', `${name} loots ${p.id} — ${items.join(', ') || 'no items'}${gold ? ` + ${gold} gp` : ''}`, { poiId: p.id, combatantId: cid, items, gold });
    this.recordFact({ subject: p.id, attribute: 'status', value: 'looted', source: 'dm' });
    this.journal({ kind: 'loot', subjects: [p.id], text: `${name} takes ${items.join(', ') || 'nothing'}${gold ? ` and ${gold} gp` : ''}.`, data: { gold, by: name } });
    return { id: p.id, items, gold, alreadyLooted: false };
  }
}
