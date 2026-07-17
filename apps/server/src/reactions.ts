// reactions.ts — the living-world reaction resolver (P3).
//
// When a PC attacks or menaces someone, the ENGINE — not the narrator — decides how the bystanders
// answer: it reads each onlooker's disposition (persona.ts) and how clearly they perceived the strike
// (a witness oracle built from the spatial primitives), walks them on the REAL map via engine.travel,
// and hands back a set of "verdict facts". The orchestrator injects those facts into the triggering
// tool result, and the DM narrates ONLY them — the One-World law: the engine owns the movement, the
// LLM edits/narrates it, it never invents who runs. This is the spine of living-world reactivity;
// escalation (reinforcements, continuation goals) is P4.
//
// Everything here is deterministic and degrade-safe: no map, no witnesses, or a thrown primitive all
// resolve to "no reactions", never a broken turn. Gated behind MYTHWEAVER_REACTIONS in the orchestrator.

import { distanceFt, hasLineOfSight, spatialIndex, whereIs, type Cell, type Engine, type MonsterSpec } from '@mythweaver/engine';
import { personaOf, reactTo, type LedgerState, type MapObject, type PerceptionGrade, type Persona, type PersonaArchetype, type ReactionIntent, type SceneDelta, type SceneMap } from '@mythweaver/shared';
import { EARSHOT_FT, sceneGraph, type SceneGraph } from './scene-graph.js';

/** What happened, resolved to concrete map tokens by the caller (the orchestrator owns id resolution). */
export interface DisturbanceEvent {
  /** The acting actor (usually the PC who struck/threatened). Excluded from the reacting crowd. */
  aggressor: MapObject;
  /** The struck/menaced NPC, if any. Excluded from the crowd (the DM narrates the victim directly). */
  target?: MapObject;
  kind: 'attack' | 'menace' | 'threaten';
}

export interface ReactionOutcome {
  /** Plain-English verdict lines the DM narrates from (never mechanics/coordinates). */
  facts: string[];
  /** How many onlookers reacted individually (a fact + possibly a walk each). */
  reactors: number;
  /** Extra onlookers folded into a single aggregate line instead of individual deltas. */
  overflow: number;
  /** Total non-oblivious witnesses considered (reactors + overflow + verb:'none'). */
  witnesses: number;
}

/** Individual reactors surfaced with their own fact/walk; the rest become one aggregate line (delta cap). */
const MAX_REACTORS = 10;
/** How far a bystander bolts in one beat — kept modest so they stay on-map and in the scene (P4 = leave). */
const FLEE_TILES = 6;
/** A steady onlooker only edges back a step or two — enough to read as recoiling, not fleeing. */
const BACK_AWAY_TILES = 2;

/**
 * The witness oracle, pointed backwards: how clearly does onlooker `o` perceive an event at `eventCell`?
 * Distance gates first (beyond earshot = oblivious). Then the P0 rule: a different zone than the event
 * means a WALL separates them (the single open zone is 'outdoor'; any other zone is a specific building),
 * so LOS through a doorway is a false positive — cap such a witness at 'alerted' (they only caught the
 * noise; they come to the door NEXT beat, they don't act now). Same zone → true line of sight decides
 * saw vs heard. All P3 disturbances are "loud" (a fight/shout), so a walled-off witness is alerted, not
 * oblivious, within earshot.
 */
function gradeOf(idx: ReturnType<typeof spatialIndex>, g: SceneGraph, eventCell: Cell, eventZone: string, o: MapObject): PerceptionGrade {
  const oc: Cell = { col: o.col, row: o.row };
  if (distanceFt(idx, oc, eventCell) > EARSHOT_FT) return 'oblivious';
  const witnessZone = g.zoneOf.get(o.id) ?? whereIs(idx, oc).buildingId ?? 'outdoor';
  if (witnessZone !== eventZone) return 'alerted'; // a wall between them (zone occlusion, P0) — never "saw"
  return hasLineOfSight(idx, oc, eventCell).clear ? 'saw' : 'heard';
}

/** A reachable walkable open cell up to `maxTiles` away in the direction AWAY from the event. Used for a
 *  full bolt (flee) and a short recoil (back-away); returns the farthest clear cell it finds, or undefined. */
function awayCell(idx: ReturnType<typeof spatialIndex>, map: SceneMap, from: Cell, event: Cell, maxTiles: number, minTiles: number): Cell | undefined {
  const cols = map.grid.cols, rows = map.grid.rows;
  let dx = from.col - event.col, dy = from.row - event.row;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len; dy /= len;
  for (let step = maxTiles; step >= minTiles; step--) {
    const c = Math.round(from.col + dx * step), r = Math.round(from.row + dy * step);
    if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
    if (map.walkable?.[r]?.[c] === true && !idx.roofAt.has(r * cols + c)) return { col: c, row: r };
  }
  return undefined; // no clear away-cell → they don't move (still narrated as recoiling in place)
}

/** Join a map token to its ledger card by NAME/alias (token id ≠ card id) to read any authored persona. */
function findCard(ledger: LedgerState, o: MapObject): LedgerState['entities'][string] | undefined {
  const name = (o.name ?? '').toLowerCase();
  if (!name) return undefined;
  for (const c of Object.values(ledger.entities)) {
    if (c.kind === 'pc') continue;
    if ([c.name, ...(c.aliases ?? [])].some((a) => a && a.toLowerCase() === name)) return c;
  }
  return undefined;
}

/** A CR/stat spec per persona archetype, for the promotion lane (a struck NPC becomes damageable). */
export function specForArchetype(archetype: PersonaArchetype, name: string): MonsterSpec {
  switch (archetype) {
    case 'authority':
      return { name, challengeRating: 2, type: 'humanoid', primaryAbility: 'str', attackName: 'Longsword', damageType: 'slashing' };
    case 'monster':
      return { name, challengeRating: 1, type: 'humanoid', primaryAbility: 'str', attackName: 'Scimitar', damageType: 'slashing' };
    case 'beast':
      return { name, challengeRating: 0, type: 'beast', primaryAbility: 'dex', attackName: 'Bite', damageType: 'piercing' };
    case 'keeper':
    case 'cleric':
    case 'commoner':
    default:
      return { name, challengeRating: 0, type: 'humanoid', primaryAbility: 'dex', attackName: 'Fist', damageType: 'bludgeoning' };
  }
}

/** A readable label for an anonymous token ("a villager woman") or the NPC's name when it has one. */
function displayName(o: MapObject): string {
  if (o.name) return o.name;
  const t = (o.tag || 'villager').replace(/_/g, ' ');
  return /^[aeiou]/.test(t) ? `an ${t}` : `a ${t}`;
}

/** Authored persona colour as pure FICTION — allegiance/stake only. The archetype/temper taxonomy
 *  (personaLine) is meta and must NEVER reach the narrated fact (the DM might read it aloud verbatim). */
function personaColour(p: Persona): string {
  const bits = [p.allegiance && `loyal to ${p.allegiance}`, p.stake && `mindful of ${p.stake}`].filter(Boolean);
  return bits.length ? ` (${bits.join(', ')})` : '';
}

/** One plain-English verdict line per reactor — pure fiction, and HONEST about what the engine actually
 *  did: a move-verb reactor that couldn't move (cornered / walled interior / blocked path) is narrated
 *  recoiling in place, never "bolts away", so narration matches the token that did not move. */
function reactionFact(o: MapObject, w: { grade: PerceptionGrade; persona: Persona; intent: ReactionIntent }, ev: DisturbanceEvent, moved: boolean): string {
  const name = displayName(o) + personaColour(w.persona);
  const aggName = ev.aggressor.name ?? 'the attacker';
  switch (w.intent.verb) {
    case 'confront':
      return moved ? `${name} closes on ${aggName}, moving to challenge the attack.` : `${name} squares up to ${aggName} but can't get through, holding their ground.`;
    case 'shield-others':
      // Only name a victim the disturbance actually has — a targetless menace has none to interpose for.
      return ev.target
        ? (moved ? `${name} moves to put themselves between the attacker and ${ev.target.name ?? 'the one under attack'}.` : `${name} braces to shield ${ev.target.name ?? 'the one under attack'} but is blocked from reaching them.`)
        : `${name} steps forward, ready to shield whoever the attacker turns on.`;
    case 'flee':
      return moved ? `${name} breaks and bolts away from the violence.` : `${name} recoils to run but is hemmed in, unable to get clear.`;
    case 'back-away':
      return moved ? `${name} edges back a step, keeping their distance and watching.` : `${name} flinches back, watching warily, with nowhere to give ground.`;
    case 'brace':
      return `${name} plants their feet at their post — wary, holding, not backing down.`;
    case 'gawk':
      return `${name} freezes and stares, startled still.`;
    case 'cower':
      return `${name} shrinks down where they stand.`;
    case 'emerge':
      return `${name} — walled off, only caught the noise — will come to a doorway to look next beat.`;
    default:
      return `${name} reacts to the disturbance.`;
  }
}

const MOVING_VERBS = new Set<ReactionIntent['verb']>(['confront', 'flee', 'shield-others', 'back-away']);

/**
 * Resolve a disturbance into engine-owned reactions. In mode 'on' it MOVES the reactors (real walks via
 * engine.travel) and stamps engine-owned rx:* state; in mode 'dry' it computes the same verdict facts but
 * moves nothing (soak). Movement deltas + rx:* deltas are pushed onto the caller's `sceneDeltas` array so
 * the live table animates them. Returns the verdict facts the caller injects into the tool result.
 */
export function resolveReactions(engine: Engine, map: SceneMap, ev: DisturbanceEvent, sceneDeltas: SceneDelta[], ledger: LedgerState | undefined, mode: 'on' | 'dry', reacted: Set<string> = new Set()): ReactionOutcome {
  const idx = spatialIndex(map);
  const g = sceneGraph(map, idx);
  // Perception is judged from the EVENT locus (the victim, or the aggressor for a targetless menace)…
  const eventCell: Cell = ev.target ? { col: ev.target.col, row: ev.target.row } : { col: ev.aggressor.col, row: ev.aggressor.row };
  const eventZone = whereIs(idx, eventCell).buildingId ?? 'outdoor';
  // …but flight is AWAY FROM THE THREAT (the wielder), which differs from the victim on a ranged strike.
  const threatCell: Cell = { col: ev.aggressor.col, row: ev.aggressor.row };

  type W = { o: MapObject; grade: PerceptionGrade; persona: Persona; intent: ReactionIntent; d: number };
  const ws: W[] = [];
  for (const o of map.objects) {
    if (o.kind !== 'actor' || o.visible === false || o.role === 'pc') continue; // PCs aren't the crowd
    if (o.id === ev.aggressor.id || o.id === ev.target?.id) continue; // attacker + victim handled directly
    if (reacted.has(o.id)) continue; // already reacted to an earlier disturbance THIS turn — don't re-move them
    const grade = gradeOf(idx, g, eventCell, eventZone, o);
    if (grade === 'oblivious') continue;
    const card = ledger ? findCard(ledger, o) : undefined;
    // Derive from the CARD id when one exists (stable across the token↔card split), else the token id.
    const persona = personaOf({ id: card?.id ?? o.id, name: o.name, tag: o.tag, role: o.role }, card?.persona);
    const intent = reactTo(persona, grade);
    if (intent.verb === 'none') continue;
    ws.push({ o, grade, persona, intent, d: distanceFt(idx, { col: o.col, row: o.row }, eventCell) });
  }
  ws.sort((a, b) => a.d - b.d); // nearest onlookers react individually; the far tail aggregates

  const facts: string[] = [];
  let reactors = 0, overflow = 0;
  for (const w of ws) {
    if (reactors >= MAX_REACTORS) { overflow++; reacted.add(w.o.id); continue; }
    let moved = false;
    if (mode === 'on') {
      // Walk the movers on the real map (mode:'auto' NEVER suspends the turn — degrades to the frontier).
      if (MOVING_VERBS.has(w.intent.verb)) {
        // Flee/back-away retreat AWAY FROM THE AGGRESSOR (threatCell); confront/shield close on a token.
        const away = (max: number) => { const fc = awayCell(idx, map, { col: w.o.col, row: w.o.row }, threatCell, max, 1); return fc ? { col: fc.col, row: fc.row } : undefined; };
        const dest = w.intent.verb === 'back-away' ? away(BACK_AWAY_TILES)
          : w.intent.toward === 'attacker' ? { id: ev.aggressor.id }
          : w.intent.toward === 'victim' ? (ev.target ? { id: ev.target.id } : undefined)
          : w.intent.toward === 'exit' ? away(FLEE_TILES)
          : undefined;
        if (dest) {
          const from = { col: w.o.col, row: w.o.row }; // capture BEFORE travel — it mutates w.o in place
          const v = engine.travel({ actorId: w.o.id, to: dest, mode: 'auto' });
          if (v.at && (v.at.col !== from.col || v.at.row !== from.row)) { // a real relocation, not a no-op
            sceneDeltas.push({ op: 'move', id: w.o.id, to: { col: v.at.col, row: v.at.row }, ...(v.pathCells?.length ? { via: v.pathCells } : {}) });
            moved = true;
          }
        }
      }
      // Engine-owned reaction state (the DM's updateScene path strips rx:*; this is the trusted writer).
      // NOTE (P4): rx:* has no reader yet and no cross-turn sweep — a stale flag is latent until P4 gives
      // it a lifecycle + consumer. Stamp the HONEST outcome so it never claims a move that didn't happen.
      const rs = engine.applySceneDeltas([{ op: 'setState', id: w.o.id, state: { 'rx:verb': w.intent.verb, 'rx:grade': w.grade, 'rx:moved': moved, ...(w.intent.goal ? { 'rx:goal': w.intent.goal } : {}) } }]);
      sceneDeltas.push(...rs.applied);
    }
    facts.push(reactionFact(w.o, w, ev, moved));
    reacted.add(w.o.id);
    reactors++;
  }
  if (overflow > 0) {
    // Disposition-neutral + no movement claim — the engine did NOT walk these tail onlookers.
    facts.push(`Around the edges of the scene, ${overflow} more ${overflow === 1 ? 'onlooker reacts' : 'onlookers react'} to the violence.`);
  }
  return { facts, reactors, overflow, witnesses: ws.length };
}
