/**
 * THE ENEMY PHASE (docs/COMBAT-MODE.md §3.3) — the world finally takes its turns.
 *
 * When a PC ends their turn (or combat opens with monsters ahead of the party in the order), every
 * consecutive NPC in initiative acts HERE: a deterministic tactical policy chooses, the engine's RNG
 * rolls (the DM's dice ARE the engine's — players' physical dice stay sacred for player rolls only),
 * and the whole phase is then narrated in ONE LLM call. Three bandits as three model calls would be a
 * three-minute round at current latencies; as engine resolution + one narration it is one call.
 *
 * The policy is deliberately simple (v1): melee closes on the nearest standing PC and swings; ranged
 * shoots from where it stands. Facts stream out exactly like reaction/MEANWHILE facts — verdicts the
 * narrator must voice and may not overturn. Boss-grade LLM-driven turns are a reserved hook, not v1.
 *
 * The runner NEVER acts for PCs, never advances past a PC's turn, and stops dead when no conscious PC
 * remains (a beaten party is the Director's scene, not an infinite monster loop).
 */

import type { Engine } from '@mythweaver/engine';
import type { LlmProvider } from '@mythweaver/llm';
import type { AttackAction, Combatant, GameState, SceneDelta } from '@mythweaver/shared';

export interface EnemyPhaseResult {
  narration: string;
  facts: string[];
  deltas: SceneDelta[];
  round: number;
  /** Whose turn the table lands on when the dust settles (a PC, or nobody if the fight ended). */
  nextUp?: string;
  costUsd: number;
}

const FALLBACK_ATTACK: AttackAction = { name: 'Strike', attackBonus: 2, damage: '1d4', damageType: 'bludgeoning' };

/** One monster's turn under the v1 policy. Mutates engine state; returns table-facing facts. */
function resolveMonsterTurn(engine: Engine, state: GameState, npc: Combatant, deltas: SceneDelta[]): string[] {
  const facts: string[] = [];
  const map = state.world?.currentLocationId ? state.world.locations[state.world.currentLocationId] : undefined;
  const token = map?.objects.find((o) => o.id === npc.id);
  if (!map || !token) return [`${npc.name} is nowhere on the field and holds back.`];

  // MORALE (C3): flesh breaks. A bloodied fighter whose side is half gone runs for the trees — the
  // mindless (undead, constructs, oozes) never do. Deterministic, so the same fight routs the same way.
  const kindLine = state.bestiary?.[npc.refId]?.type ?? '';
  const fearless = /undead|construct|ooze|fiend|elemental/i.test(kindLine);
  const foes = Object.values(state.combatants).filter((c) => c.kind === 'npc');
  const outOfFight = foes.filter((c) => c.downed || c.dead || c.fled).length;
  const bloodied = npc.currentHitPoints <= Math.floor(npc.maxHitPoints / 2);
  if (!fearless && bloodied && outOfFight * 2 >= foes.length) {
    const { cols, rows } = map.grid;
    const edges = [
      { col: 0, row: token.row }, { col: cols - 1, row: token.row },
      { col: token.col, row: 0 }, { col: token.col, row: rows - 1 },
    ].sort((a, b) => (Math.abs(a.col - token.col) + Math.abs(a.row - token.row)) - (Math.abs(b.col - token.col) + Math.abs(b.row - token.row)));
    const v = engine.travel({ actorId: npc.id, to: edges[0]!, mode: 'auto' });
    if (v.moved && v.at) deltas.push({ op: 'move', id: npc.id, to: { col: v.at.col, row: v.at.row }, ...(v.pathCells?.length ? { via: v.pathCells } : {}) } as SceneDelta);
    const at = v.at ?? token;
    const nearEdge = at.col <= 1 || at.row <= 1 || at.col >= cols - 2 || at.row >= rows - 2;
    if (nearEdge) {
      npc.fled = true;
      deltas.push({ op: 'despawn', id: npc.id } as SceneDelta);
      facts.push(`${npc.name} breaks and flees the field!`);
      engine.checkCombatEnd(); // a full rout ends the fight without a killing blow
    } else {
      facts.push(`${npc.name} falls back, bloodied, looking for a way out.`);
    }
    return facts;
  }

  // Nearest CONSCIOUS PC with a token — the policy never chases the dying.
  const feet = map.grid?.feetPerTile ?? 5;
  const targets = Object.values(state.combatants)
    .filter((c) => c.kind === 'pc' && !c.dead && !c.downed)
    .map((c) => ({ c, tok: map.objects.find((o) => o.id === c.id) }))
    .filter((t): t is { c: Combatant; tok: NonNullable<typeof t.tok> } => !!t.tok)
    .map((t) => ({ ...t, ft: Math.max(Math.abs(t.tok.col - token.col), Math.abs(t.tok.row - token.row)) * feet }))
    .sort((a, b) => a.ft - b.ft);
  if (!targets.length) return [];

  const attack = state.bestiary?.[npc.refId]?.attacks?.[0] ?? FALLBACK_ATTACK;
  const reachFt = attack.reachOrRangeFt && attack.reachOrRangeFt > 10 ? attack.reachOrRangeFt : 5;
  let target = targets[0]!;

  // Close the distance if the arm is short. mode 'auto' never suspends (a monster's stride is not a
  // player decision); the walk emits a real delta so the table SEES the bandit come.
  if (target.ft > reachFt) {
    const v = engine.travel({ actorId: npc.id, to: { id: target.tok.id }, mode: 'auto' });
    if (v.moved && v.at) {
      engine.spendMovement(npc.id, Math.min(v.ft, npc.actionEconomy?.movementRemainingFt ?? v.ft));
      deltas.push({ op: 'move', id: npc.id, to: { col: v.at.col, row: v.at.row }, ...(v.pathCells?.length ? { via: v.pathCells } : {}) } as SceneDelta);
      target = { ...target, ft: Math.max(Math.abs(target.tok.col - v.at.col), Math.abs(target.tok.row - v.at.row)) * feet };
    }
  }

  if (target.ft > reachFt) {
    facts.push(`${npc.name} pushes toward ${target.c.name} but can't close the distance this round.`);
    return facts;
  }

  const spend = engine.spendAction(npc.id);
  if (!spend.ok) return facts; // spent somehow — nothing more this turn

  // The engine rolls: d20 + printed bonus vs AC; nat 20 doubles the damage dice, nat 1 whiffs.
  const d20 = engine.rollDice('1d20');
  const crit = d20 === 20;
  const hit = crit || (d20 !== 1 && d20 + attack.attackBonus >= target.c.armorClass);
  if (!hit) {
    facts.push(`${npc.name}'s ${attack.name.toLowerCase()} misses ${target.c.name}.`);
    return facts;
  }
  const dmg = engine.rollDice(attack.damage) + (crit ? engine.rollDice(attack.damage) : 0);
  const res = engine.applyDamage({ targetId: target.c.id, amount: dmg, type: attack.damageType, attackerId: npc.id });
  facts.push(
    `${npc.name}${crit ? ' CRITICALLY' : ''} hits ${target.c.name} with ${attack.name.toLowerCase()} — ${dmg} ${attack.damageType}` +
      (res.downed ? `. ${target.c.name} goes DOWN.` : ` (${res.remaining} HP left).`),
  );
  return facts;
}

/**
 * Run every consecutive NPC turn from the current position in the order, then narrate the batch.
 * Returns null when there is nothing to do (the active combatant is already a PC, or no combat).
 */
export async function runEnemyPhase(args: { engine: Engine; llm: LlmProvider; playbook: string; leadFacts?: string[] }): Promise<EnemyPhaseResult | null> {
  const { engine, llm } = args;
  const state = engine.getState();
  const lead = args.leadFacts ?? [];
  if (!state.combat.active && !lead.length) return null;
  let active = engine.activeCombatant();
  // A death save's outcome must be narrated even when no monster follows it in the order.
  if ((!active || active.kind === 'pc') && !lead.length) return null;

  engine.normalizeTurn(); // a wedged spotlight (stale freeze, prior crash) heals before we read it
  const facts: string[] = [...lead];
  const deltas: SceneDelta[] = [];
  const roundAtStart = state.combat.round;
  for (let hops = 0; hops < state.combat.order.length + 2 && state.combat.active; hops++) {
    active = engine.activeCombatant();
    if (!active || active.kind !== 'npc') break;
    // A beaten party ends the phase, not the world: the Director owns what bandits do with victory.
    const conscious = Object.values(state.combatants).some((c) => c.kind === 'pc' && !c.dead && !c.downed);
    if (!conscious) {
      facts.push('No one is left standing to oppose them.');
      break;
    }
    facts.push(...resolveMonsterTurn(engine, state, active, deltas));
    if (!state.combat.active) break; // the phase's own damage (or a full rout) can end the fight
    // The actor may have STOPPED being able to act during its own turn — it fled the field, or an
    // opportunity attack dropped it as it ran. endTurn would refuse (the downed cannot end a turn),
    // so hand the spotlight on directly; otherwise the table wedges with nobody able to move.
    if (active.fled || active.downed || active.dead) { try { engine.nextTurn(); } catch { break; } continue; }
    const end = engine.endTurn(active.id);
    if (!end.ok) { engine.normalizeTurn(); break; } // never loop on a refusal — but never leave it stuck
  }

  const after = engine.activeCombatant();
  const nextUp = state.combat.active && after?.kind === 'pc' ? after.name : undefined;
  const round = state.combat.round;

  // Nothing happened (e.g. every NPC was skipped): a canned line costs nothing and says everything.
  if (!facts.length) {
    return { narration: nextUp ? `Round ${round} — ${nextUp}, you're up.` : '', facts, deltas, round, ...(nextUp ? { nextUp } : {}), costUsd: 0 };
  }

  // ONE narration call for the whole phase. Facts are verdicts: voiced, never overturned.
  let narration = '';
  let costUsd = 0;
  try {
    const res = await llm.complete({
      system: args.playbook,
      messages: [{
        role: 'user',
        content:
          `[ENEMY PHASE — round ${roundAtStart}. The engine has ALREADY resolved the enemies' turns; these verdicts are final. ` +
          `Narrate them vividly in 2-5 sentences, in order, exactly as they happened — never soften a hit, never add an action that is not listed. ` +
          `${nextUp ? `End by telling ${nextUp} it is their turn.` : 'End on the fight\'s new shape.'}]\n\n` +
          facts.map((f) => `- ${f}`).join('\n'),
      }],
      maxTokens: 700,
    });
    narration = res.text.trim();
    costUsd = 0; // recorder providers track cost internally; estimate rides the session totals via usage
  } catch {
    narration = facts.join(' ');
  }
  if (!narration) narration = facts.join(' ');
  if (nextUp && !narration.toLowerCase().includes(nextUp.toLowerCase())) narration += `\n\n${nextUp}, you're up.`;
  return { narration, facts, deltas, round, ...(nextUp ? { nextUp } : {}), costUsd };
}
