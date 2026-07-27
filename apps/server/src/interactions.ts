// interactions.ts — the living-world INTERACTION resolver (docs/INTERACTION-LAYER.md).
//
// One spine for every way a PC's act ripples through the scene: the ENGINE — not the narrator —
// decides who perceives the act (the witness oracle), how each NPC answers it (persona.ts), and
// walks them on the REAL map via engine.travel; the DM narrates ONLY the returned verdict facts.
// The One-World law, generalized: the engine owns the movement, the LLM edits/narrates it, it never
// invents who runs — or who gathers.
//
// Two lanes live here today:
//   THREAT (P3, resolveReactions) — an attack/menace SCATTERS the crowd (flee/confront/brace/…).
//   BROADCAST DRAW (P4a, resolveInteraction) — a summons or performance PULLS it (approach/hold),
//     via appealTo: the appeal is derived from the stimulus kind, never authored by the LLM.
// Directed-social (commands/requests vs a persona-DC) is the next slice (P4b, directNpc).
//
// Everything here is deterministic and degrade-safe: no map, no witnesses, or a thrown primitive all
// resolve to "no reactions", never a broken turn. Gated behind MYTHWEAVER_REACTIONS (threat) and
// MYTHWEAVER_INTERACTIONS (draw) in the orchestrator.

import { deriveMoveCaps, distanceFt, findPath, hasLineOfSight, spatialIndex, whereIs, type Cell, type Engine, type MonsterSpec } from '@mythweaver/engine';
import { appealTo, personaOf, reactTo, type Appeal, type GameState, type LedgerState, type MapObject, type PerceptionGrade, type Persona, type PersonaArchetype, type ReactionIntent, type ReactionValence, type SceneDelta, type SceneMap } from '@mythweaver/shared';
import { deriveBuildings, EARSHOT_FT, sceneGraph, type SceneGraph } from './scene-graph.js';

/** What happened, resolved to concrete map tokens by the caller (the orchestrator owns id resolution). */
export interface DisturbanceEvent {
  /** The acting actor (the PC who struck/stole/etc). Excluded from the reacting crowd. For a pure
   *  environmental hazard (fire) there is no actor — pass the source of the hazard, or the acting PC. */
  aggressor: MapObject;
  /** The struck/menaced/robbed NPC or the desecrated thing, if any. Excluded from the crowd. */
  target?: MapObject;
  /** attack/menace/threaten = THREAT (scatter); transgress = OUTRAGE (theft/desecration/trespass →
   *  scandal + the law); hazard = ENVIRONMENTAL danger (fire/collapse → everyone recoils). */
  kind: 'attack' | 'menace' | 'threaten' | 'transgress' | 'hazard';
  /** P4g: a COVERT act (pickpocket, sneak) — only close, clear-line-of-sight onlookers notice it. */
  covert?: boolean;
  /** Where the disturbance is (a hazard cell, a desecrated altar); defaults to target, else aggressor. */
  at?: Cell;
}

/** The reaction valence a disturbance kind carries (drives reactTo + the fact prose). */
function valenceOf(kind: DisturbanceEvent['kind']): ReactionValence {
  return kind === 'transgress' ? 'outrage' : kind === 'hazard' ? 'hazard' : 'threat';
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
/** How near a covert act must be seen to register — a pickpocket/sneak makes no noise, so only a close,
 *  clear line of sight catches it (P4g stealth pre-filter). Everyone else is oblivious. */
const COVERT_SIGHT_FT = 25;
function gradeOf(idx: ReturnType<typeof spatialIndex>, g: SceneGraph, eventCell: Cell, eventZone: string, o: MapObject, covert = false): PerceptionGrade {
  const oc: Cell = { col: o.col, row: o.row };
  const d = distanceFt(idx, oc, eventCell);
  if (covert) {
    // A quiet, hidden act: no earshot, no through-wall alarm — only a close witness with a clear view.
    const witnessZone = g.zoneOf.get(o.id) ?? whereIs(idx, oc).buildingId ?? 'outdoor';
    if (witnessZone === eventZone && d <= COVERT_SIGHT_FT && hasLineOfSight(idx, oc, eventCell).clear) return 'saw';
    return 'oblivious';
  }
  if (d > EARSHOT_FT) return 'oblivious';
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

/** Join a map token to its ledger card (by name) — the stable key for persona seed + standing. Public
 *  so the command lane can key standing mutations/reads by the card id (a bare token has no standing). */
export function cardForToken(o: MapObject, ledger: LedgerState | undefined): LedgerState['entities'][string] | undefined {
  return ledger ? findCard(ledger, o) : undefined;
}

/** Resolve a map token's persona — join to its ledger card by name for any AUTHORED allegiance/stake
 *  (so standing seeds from it), else derive from role/tag/id. The stable key is the card id when joined. */
export function personaForToken(o: MapObject, ledger: LedgerState | undefined): Persona {
  const card = cardForToken(o, ledger);
  return personaOf({ id: card?.id ?? o.id, name: o.name, tag: o.tag, role: o.role }, card?.persona);
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
  const aggName = ev.aggressor.name ?? 'the offender';
  const valence = valenceOf(ev.kind);
  const outrage = valence === 'outrage', hazard = valence === 'hazard';
  const danger = ev.kind === 'hazard' ? 'the danger' : 'the violence';
  switch (w.intent.verb) {
    case 'confront':
      if (outrage) return moved ? `${name} moves to stop ${aggName}, calling them out.` : `${name} rounds on ${aggName} but can't reach them, glaring.`;
      return moved ? `${name} closes on ${aggName}, moving to challenge the attack.` : `${name} squares up to ${aggName} but can't get through, holding their ground.`;
    case 'shield-others':
      if (hazard) return moved ? `${name} moves to pull people clear of ${danger}.` : `${name} reaches to pull others back from ${danger}.`;
      return ev.target
        ? (moved ? `${name} moves to put themselves between the attacker and ${ev.target.name ?? 'the one under attack'}.` : `${name} braces to shield ${ev.target.name ?? 'the one under attack'} but is blocked from reaching them.`)
        : `${name} steps forward, ready to shield whoever the attacker turns on.`;
    case 'flee':
      if (hazard) return moved ? `${name} bolts away from ${danger}.` : `${name} scrambles to flee ${danger} but is hemmed in.`;
      return moved ? `${name} breaks and bolts away from ${danger}.` : `${name} recoils to run but is hemmed in, unable to get clear.`;
    case 'back-away':
      if (outrage) return moved ? `${name} edges off, muttering in disapproval and keeping an eye on ${aggName}.` : `${name} stiffens with disapproval, nowhere to give ground.`;
      if (hazard) return moved ? `${name} backs away from ${danger}, wary.` : `${name} shrinks from ${danger}, hemmed in.`;
      return moved ? `${name} edges back a step, keeping their distance and watching.` : `${name} flinches back, watching warily, with nowhere to give ground.`;
    case 'brace':
      return outrage ? `${name} plants themselves over their goods, glaring at ${aggName}.` : `${name} plants their feet at their post — wary, holding, not backing down.`;
    case 'gawk':
      return outrage ? `${name} stares, scandalised by what they just saw.` : `${name} freezes and stares, startled still.`;
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
  const valence = valenceOf(ev.kind);
  // Perception is judged from the EVENT locus (an explicit `at`, else the target, else the actor)…
  const eventCell: Cell = ev.at ?? (ev.target ? { col: ev.target.col, row: ev.target.row } : { col: ev.aggressor.col, row: ev.aggressor.row });
  const eventZone = whereIs(idx, eventCell).buildingId ?? 'outdoor';
  // …but retreat is AWAY FROM THE THREAT: the wielder for an attack/theft (differs from the victim on a
  // ranged strike), the hazard itself for a fire/collapse (there is no wielder to flee).
  const threatCell: Cell = valence === 'hazard' ? eventCell : { col: ev.aggressor.col, row: ev.aggressor.row };

  type W = { o: MapObject; grade: PerceptionGrade; persona: Persona; intent: ReactionIntent; card?: LedgerState['entities'][string]; d: number };
  const ws: W[] = [];
  for (const o of map.objects) {
    if (o.kind !== 'actor' || o.visible === false || o.role === 'pc') continue; // PCs aren't the crowd
    if (o.id === ev.aggressor.id || o.id === ev.target?.id) continue; // attacker + victim handled directly
    if (reacted.has(o.id)) continue; // already reacted to an earlier disturbance THIS turn — don't re-move them
    const grade = gradeOf(idx, g, eventCell, eventZone, o, ev.covert);
    if (grade === 'oblivious') continue;
    const card = ledger ? findCard(ledger, o) : undefined;
    // Derive from the CARD id when one exists (stable across the token↔card split), else the token id.
    const persona = personaOf({ id: card?.id ?? o.id, name: o.name, tag: o.tag, role: o.role }, card?.persona);
    const intent = reactTo(persona, grade, valence);
    if (intent.verb === 'none') continue;
    ws.push({ o, grade, persona, intent, card, d: distanceFt(idx, { col: o.col, row: o.row }, eventCell) });
  }
  ws.sort((a, b) => a.d - b.d); // nearest onlookers react individually; the far tail aggregates

  const facts: string[] = [];
  let reactors = 0, overflow = 0;
  // A single crime docks a ledger IDENTITY once — even if several visible tokens share that card's name
  // (two "Town Guard" tokens → one card). findCard is many-to-one by name, and recordFact mutates the
  // live ledger that standingOf re-reads, so without this a lone theft would compound the same card's
  // standing (−1, then −2…). Keyed by CARD id (the `reacted` guard is token-keyed and can't catch this).
  const dockedCards = new Set<string>();
  // S7 — VIOLENCE HAS A SOCIAL COST. Until now the ledger modelled the social cost of THEFT (−1 with
  // every witness) and none at all for ASSAULT: `valenceOf` maps only `transgress` to 'outrage', so
  // stabbing a friendly villager was free — with the witnesses AND with the victim, who is skipped by
  // the witness loop entirely. Striking a NON-HOSTILE person is the graver offence, so it docks harder.
  // Attacking a monster/beast is not a social crime, and a covert act nobody saw costs nothing.
  const victimPersona = ev.target ? personaForToken(ev.target, ledger) : undefined;
  const victimHostile = !victimPersona || victimPersona.archetype === 'monster' || victimPersona.archetype === 'beast';
  const violenceCost = !ev.covert && !victimHostile && (ev.kind === 'attack' || ev.kind === 'menace') ? (ev.kind === 'attack' ? 2 : 1) : 0;
  /** Write a standing drop once per ledger identity (the name-alias guard applies to every lane). */
  const dock = (cardId: string, persona: Persona, amount: number) => {
    if (!amount || dockedCards.has(cardId)) return;
    engine.recordFact({ subject: cardId, attribute: STANDING_ATTR, value: String(clampStanding(standingOf(persona, ledger, cardId) - amount)) });
    dockedCards.add(cardId);
  };
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
      const rs = engine.applySceneDeltas([{ op: 'setState', id: w.o.id, state: { 'rx:verb': w.intent.verb, 'rx:grade': w.grade, 'rx:moved': moved } }]);
      sceneDeltas.push(...rs.applied);
      // P4e/S7: a WITNESSED crime costs the party standing with everyone who saw it — theft −1,
      // an assault on a non-hostile person −2. Once per ledger identity (name-alias guard).
      if (w.card) dock(w.card.id, w.persona, valence === 'outrage' ? 1 : violenceCost);
      // P4f: an 'emerge' witness (walled off, only alerted) is given a WAYPOINT GOAL to its own doorway —
      // advanceGoals walks it there next beat and it speaks on arrival. The consumer P3 was missing.
      if (w.intent.verb === 'emerge') {
        const zone = g.zoneOf.get(w.o.id) ?? whereIs(idx, { col: w.o.col, row: w.o.row }).buildingId ?? '';
        const door = deriveBuildings(map, idx).find((b) => b.id === zone);
        if (door) setGoal(engine, w.o.id, { kind: 'emerge', col: door.col, row: door.row, say: "What's all this, then?", ttl: 2, bornTurn: engine.getState().turnCount ?? 0 }, sceneDeltas);
      }
    }
    facts.push(reactionFact(w.o, w, ev, moved));
    reacted.add(w.o.id);
    reactors++;
  }
  if (overflow > 0) {
    // Disposition-neutral + no movement claim — the engine did NOT walk these tail onlookers.
    facts.push(`Around the edges of the scene, ${overflow} more ${overflow === 1 ? 'onlooker reacts' : 'onlookers react'}.`);
  }
  // S7: THE VICTIM. The witness loop skips the person actually struck, so until now the one NPC with the
  // strongest reason to resent the party was the only one whose standing never moved. They don't need to
  // "witness" it — it happened to them. Deliberately steeper than a bystander's view of the same act.
  if (mode === 'on' && violenceCost && ev.target) {
    const vCard = ledger ? findCard(ledger, ev.target) : undefined;
    if (vCard && victimPersona) dock(vCard.id, victimPersona, violenceCost + 1);
  }
  // P4f: a disturbance carries beyond earshot — distant authority is DISPATCHED (walks in over beats). A
  // hazard summons no lawman to "apprehend" anyone (there's no offender), so only violence/crime dispatches.
  if (mode === 'on' && (ev.kind === 'attack' || ev.kind === 'menace' || ev.kind === 'transgress') && !ev.covert) {
    facts.push(...dispatchReinforcements(engine, map, eventCell, ev.aggressor.id, ev.target?.id, ledger, sceneDeltas, reacted));
  }
  return { facts, reactors, overflow, witnesses: ws.length };
}

// ── P4a: the broadcast DRAW lane (summon / performance) ─────────────────────────────────────────

/** A non-threat broadcast act, resolved to concrete tokens/cells by the caller (orchestrator). */
export interface Stimulus {
  /** summon = a call/announcement (appeal: authority); perform = music/spectacle (appeal: curiosity). */
  kind: 'summon' | 'perform';
  /** The acting actor (usually a PC). Excluded from the responding crowd. */
  source: MapObject;
  /** Where the crowd is being drawn TO — the source's cell, or a named spot ("gather at the well"). */
  locus: Cell;
}

/** The appeal is DERIVED from the stimulus kind — never an LLM argument (it would steer who gathers). */
function appealOf(kind: Stimulus['kind']): Appeal {
  return kind === 'summon' ? 'authority' : 'curiosity';
}

/** A walkable outdoor cell ~stopTiles from the locus along the approach line — where a drawn NPC
 *  pulls up. Walks the line from the locus TOWARD the approacher so the crowd fans out around the
 *  locus instead of stacking on it. Undefined = no clear cell (they stay put, still narrated). */
function towardCell(idx: ReturnType<typeof spatialIndex>, map: SceneMap, from: Cell, locus: Cell, stopTiles: number): Cell | undefined {
  const cols = map.grid.cols, rows = map.grid.rows;
  let dx = from.col - locus.col, dy = from.row - locus.row;
  const len = Math.hypot(dx, dy) || 1;
  if (len <= stopTiles) return undefined; // already close enough — hold where they are
  dx /= len; dy /= len;
  for (let step = stopTiles; step <= stopTiles + 3; step++) { // prefer the stop ring, degrade outward
    const c = Math.round(locus.col + dx * step), r = Math.round(locus.row + dy * step);
    if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
    if (map.walkable?.[r]?.[c] === true && !idx.roofAt.has(r * cols + c)) return { col: c, row: r };
  }
  return undefined;
}

/** One plain-English draw-verdict line — honest about whether the token actually moved. */
function drawFact(o: MapObject, persona: Persona, kind: Stimulus['kind'], verb: 'approach' | 'hold' | 'recoil', moved: boolean, closeEnough: boolean): string {
  const name = displayName(o) + personaColour(persona);
  const call = kind === 'summon' ? 'the call' : 'the performance';
  if (verb === 'approach') {
    if (moved) return `${name} ${persona.temper === 'timid' ? `drifts warily toward ${call}, keeping some distance` : `comes over toward ${call}`}.`;
    return closeEnough ? `${name} is already close — they turn and give ${call} their attention.` : `${name} turns toward ${call} but stays where they are.`;
  }
  if (verb === 'recoil') return moved ? `${name} shies away from the noise.` : `${name} tenses at the noise, unsettled.`;
  // hold — a visible non-response IS the reaction (the keeper stays at the stall).
  return persona.archetype === 'keeper' ? `${name} looks up but stays at their post, watching from where they stand.` : `${name} pays it no mind.`;
}

/**
 * Resolve a broadcast draw (P4a): who hears the summons/performance, and who comes. Same contract as
 * resolveReactions — 'on' MOVES tokens (real walks) + stamps rx:*; 'dry' computes facts only; deltas
 * ride the caller's sceneDeltas; the returned facts are the ONLY channel the DM narrates crowd
 * behavior from. One-beat drift only: sustained gathering is the multi-turn goals phase (P4f).
 */
export function resolveInteraction(engine: Engine, map: SceneMap, st: Stimulus, sceneDeltas: SceneDelta[], ledger: LedgerState | undefined, mode: 'on' | 'dry', reacted: Set<string> = new Set()): ReactionOutcome {
  const idx = spatialIndex(map);
  const g = sceneGraph(map, idx);
  const appeal = appealOf(st.kind);
  // Perception is judged from the SOURCE (the shout/music comes from the performer)…
  const srcCell: Cell = { col: st.source.col, row: st.source.row };
  const srcZone = whereIs(idx, srcCell).buildingId ?? 'outdoor';

  type W = { o: MapObject; grade: PerceptionGrade; persona: Persona; verb: 'approach' | 'hold' | 'recoil'; approachDist: number; d: number };
  const ws: W[] = [];
  for (const o of map.objects) {
    if (o.kind !== 'actor' || o.visible === false || o.role === 'pc') continue; // PCs answer for themselves
    if (o.id === st.source.id) continue;
    if (reacted.has(o.id)) continue; // already reacted to something this turn — don't re-move them
    const grade = gradeOf(idx, g, srcCell, srcZone, o);
    if (grade === 'oblivious' || grade === 'alerted') continue; // through a wall, a draw shows nothing this beat
    const card = ledger ? findCard(ledger, o) : undefined;
    const persona = personaOf({ id: card?.id ?? o.id, name: o.name, tag: o.tag, role: o.role }, card?.persona);
    const r = appealTo(appeal, persona, grade);
    ws.push({ o, grade, persona, verb: r.verb, approachDist: r.approachDist, d: distanceFt(idx, { col: o.col, row: o.row }, st.locus) });
  }
  ws.sort((a, b) => a.d - b.d); // nearest respond individually; the far tail aggregates

  const facts: string[] = [];
  let reactors = 0, overflow = 0;
  for (const w of ws) {
    if (reactors >= MAX_REACTORS) { overflow++; reacted.add(w.o.id); continue; }
    let moved = false;
    let closeEnough = false;
    if (mode === 'on') {
      if (w.verb === 'approach') {
        const from = { col: w.o.col, row: w.o.row }; // capture BEFORE travel — it mutates w.o in place
        const dest = towardCell(idx, map, from, st.locus, w.approachDist);
        closeEnough = !dest && Math.hypot(from.col - st.locus.col, from.row - st.locus.row) <= w.approachDist + 0.5;
        if (dest) {
          const v = engine.travel({ actorId: w.o.id, to: dest, mode: 'auto' });
          if (v.at && (v.at.col !== from.col || v.at.row !== from.row)) {
            sceneDeltas.push({ op: 'move', id: w.o.id, to: { col: v.at.col, row: v.at.row }, ...(v.pathCells?.length ? { via: v.pathCells } : {}) });
            moved = true;
          }
        }
      } else if (w.verb === 'recoil') {
        const from = { col: w.o.col, row: w.o.row };
        const fc = awayCell(idx, map, from, srcCell, BACK_AWAY_TILES, 1);
        if (fc) {
          const v = engine.travel({ actorId: w.o.id, to: { col: fc.col, row: fc.row }, mode: 'auto' });
          if (v.at && (v.at.col !== from.col || v.at.row !== from.row)) {
            sceneDeltas.push({ op: 'move', id: w.o.id, to: { col: v.at.col, row: v.at.row }, ...(v.pathCells?.length ? { via: v.pathCells } : {}) });
            moved = true;
          }
        }
      }
      const rs = engine.applySceneDeltas([{ op: 'setState', id: w.o.id, state: { 'rx:verb': w.verb, 'rx:grade': w.grade, 'rx:moved': moved } }]);
      sceneDeltas.push(...rs.applied);
    }
    facts.push(drawFact(w.o, w.persona, st.kind, w.verb, moved, closeEnough));
    reacted.add(w.o.id);
    reactors++;
  }
  if (overflow > 0) {
    facts.push(`Beyond them, ${overflow} more ${overflow === 1 ? 'onlooker takes' : 'onlookers take'} notice.`);
  }
  return { facts, reactors, overflow, witnesses: ws.length };
}

// ── P4b: the directed COMMAND lane (directNpc) ──────────────────────────────────────────────────
// A PC tells a specific NPC to DO something. The engine decides whether they comply — from the NPC's
// disposition (a persona-derived PASSIVE DC the PC rolls against; the NPC never rolls) — and, on a
// pass or an auto-obey, WALKS them to the deed. Refusal and fear are first-class verdicts. The action
// is a CLOSED verb set: choosing the verb is declaration (like travel's `to`), never an outcome. This
// lane runs on SEEDED-IMMUTABLE standing (mutation is a later phase) and voices tone only — the verdict
// is the engine's. docs/INTERACTION-LAYER.md §1-2, invariants 3/5/9.

/** The closed set of things an NPC can be told to do — each cashes out to an engine op the DM can't fake. */
export type CommandVerb = 'go' | 'operate' | 'fetch' | 'give' | 'fight' | 'hold';
/** How the PC frames it — selects the social skill and colours the verdict, never the outcome. */
export type CommandTone = 'order' | 'request' | 'plea' | 'threat';
/** The engine's ruling — a closed enum the narration is gated against (narrationDefiesCommand). */
export type CommandVerdict = 'obeyed' | 'refused' | 'feared-into-compliance';

export interface CommandAction {
  verb: CommandVerb;
  /** The thing/place/person the deed is about (the lock, the gate, the foe) — a resolved map-object id. */
  anchorId?: string;
}

/** How costly/dangerous the ask is — the spine of the DC (a favour is easy, a fight is not). */
const COST_TIER: Record<CommandVerb, number> = { hold: 0, go: 1, operate: 2, fetch: 3, give: 3, fight: 8 };
/** Temper shifts resistance: the timid fold, the proud/rooted dig in, a feral thing won't be told anything. */
const TEMPER_MOD: Record<Persona['temper'], number> = { timid: -2, steady: 0, bold: 0, brave: 2, territorial: 2, feral: 5 };

const clampDC = (n: number) => Math.max(5, Math.min(25, Math.round(n)));

/** Standing lives on a ledger fact (subject = card id, attribute STANDING_ATTR) so it MUTATES (P4d) yet
 *  stays engine-owned + audited. Bounded −3..+3. Absent → seeded from the authored allegiance (P4b). */
export const STANDING_ATTR = 'standing:party';
export const STANDING_MIN = -3, STANDING_MAX = 3;

/** The seed a fresh NPC starts at, from authored allegiance (a stranger = 0). Used when no fact exists yet. */
function seedStanding(persona: Persona): number {
  const a = (persona.allegiance ?? '').toLowerCase();
  if (/\b(party|the pcs?|adventurers?)\b/.test(a)) return 2;
  if (persona.archetype === 'monster') return -2;
  if (a) return 1; // some allegiance (the town, a guild) reads as mildly cooperative
  return 0;
}

/** Read the current standing toward the party: the live standing fact if one has been recorded, else the
 *  allegiance seed. `cardId` is the ledger-card id (the stable key; a bare map token has no standing). */
export function standingOf(persona: Persona, ledger?: LedgerState, cardId?: string): number {
  if (ledger && cardId) {
    for (const f of ledger.facts) {
      if (!f.supersededBy && f.subject === cardId && f.attribute === STANDING_ATTR) {
        const n = Number(f.value);
        if (Number.isFinite(n)) return Math.max(STANDING_MIN, Math.min(STANDING_MAX, n));
      }
    }
  }
  return seedStanding(persona);
}

/** Clamp a proposed new standing to the legal band (the caller records it via engine.recordFact). */
export function clampStanding(n: number): number {
  return Math.max(STANDING_MIN, Math.min(STANDING_MAX, Math.round(n)));
}

/** The passive DC the PC's social check must beat. Pure; clamped to a rollable band. */
export function commandDC(persona: Persona, standing: number, action: CommandAction, authorityBonus: number): number {
  return clampDC(10 + COST_TIER[action.verb] - 2 * standing + TEMPER_MOD[persona.temper] - authorityBonus);
}

/** Order/request/plea lean on Persuasion; a threat leans on Intimidation. Both are CHA checks. */
export function commandSkill(tone: CommandTone): 'persuasion' | 'intimidation' {
  return tone === 'threat' ? 'intimidation' : 'persuasion';
}

/**
 * The KIND firewall (invariant 5), run BEFORE any DC: some asks are refused outright, no roll offered,
 * even for a derived persona (Tier-1 has no stake, so a stake-based check fails open). You cannot order
 * someone to attack the one commanding them, or to harm themselves. (Faction-kin forbidding needs a
 * faction model — P4d.) Returns a refusal reason, or null if the ask is at least askable.
 */
export function forbiddenCommand(action: CommandAction, targetId: string, sourceId: string): string | null {
  if (action.verb === 'fight') {
    // (A missing fight target is an INPUT error, handled at intake — not a refusal.)
    if (action.anchorId === sourceId) return 'will not turn on the one giving the order';
    if (action.anchorId === targetId) return 'will not harm themselves';
  }
  return null;
}

export interface CommandAssessment {
  band: 'obey' | 'refuse' | 'roll';
  dc: number;
  skill: 'persuasion' | 'intimidation';
  /** Set when a threat tries to compel a costly deed — fear breaks toward defiance, not obedience. */
  fearCapped?: boolean;
}

/**
 * Decide how the command resolves: auto-obey (in their nature), auto-refuse (no chance), or a roll in
 * between. Fear cap (invariant 9): a threat compels only cheap asks; menacing someone into a costly or
 * dangerous act just hardens them (they balk), it does not conjure obedience.
 */
export function assessCommand(persona: Persona, standing: number, action: CommandAction, tone: CommandTone, authorityBonus = 0): CommandAssessment {
  const skill = commandSkill(tone);
  if (tone === 'threat' && COST_TIER[action.verb] >= 6) return { band: 'refuse', dc: 25, skill, fearCapped: true };
  const dc = commandDC(persona, standing, action, authorityBonus);
  if (dc <= 5) return { band: 'obey', dc, skill };
  if (dc >= 25) return { band: 'refuse', dc, skill };
  return { band: 'roll', dc, skill };
}

/** A verb → a short deed phrase for the verdict fiction ("to check the lock"). */
function deedPhrase(action: CommandAction, anchorName?: string): string {
  const at = anchorName ? ` the ${anchorName.replace(/_/g, ' ')}` : ' it';
  switch (action.verb) {
    case 'go': return anchorName ? ` over to${at}` : ' where they were sent';
    case 'operate': return ` to see to${at}`;
    case 'fetch': return ` to fetch${at}`;
    case 'give': return ` to hand over${at}`;
    case 'fight': return ` at${at}`;
    case 'hold': return ' to stay put';
  }
}

/** One plain-English command verdict line — pure fiction, honest about what the engine did. */
export function commandFact(target: MapObject, persona: Persona, action: CommandAction, tone: CommandTone, verdict: CommandVerdict, moved: boolean, anchorName?: string): string {
  const name = displayName(target) + personaColour(persona);
  const deed = deedPhrase(action, anchorName);
  if (verdict === 'refused') {
    const flavor = tone === 'threat' ? "isn't cowed — they set their jaw and stand their ground"
      : tone === 'plea' ? 'looks away, unmoved, and stays put'
      : persona.temper === 'timid' ? 'shrinks back and does not go' : 'folds their arms and refuses';
    return `${name} ${flavor}.`;
  }
  const coerced = verdict === 'feared-into-compliance' ? ', warily, keeping their eyes on you,' : '';
  if (action.verb === 'hold') return `${name} stays where they are${coerced ? ' —' + coerced.replace(/,$/, '') : ''}, as told.`;
  return moved ? `${name}${coerced} moves off${deed}.` : `${name}${coerced} turns to go${deed} — already close enough to see to it.`;
}

// ── The polarity gate (invariant 7): the DM voices TONE, the engine owns the VERDICT ────────────
const OBEY_MARKERS = /\b(obeys?|nods?|heads?\s+(off|for|to|over)|goes?\s+(to|off|over)|sets?\s+(off|to work)|hurries?\s+(off|to|over)|moves?\s+(to|off|toward)|edges?\s+toward|does\s+as|complies|agrees|makes?\s+(her|his|their)\s+way|turns?\s+to\s+(go|check|see|do)|slips?\s+(off|away)|obliges|scurries|trots?\s+(off|over))\b/i;
// Genuine refusal / non-movement only. "won't"/"doesn't" must GOVERN a comply-verb (so bare "won't take
// her eyes off you" or "defiant" — pure demeanor a feared-compliance invites — is NOT counted a reversal).
const REFUSE_MARKERS = /\b(refuses?|refusal|shakes?\s+(her|his|their)\s+head|(won'?t|will\s+not|does(n'?t|\s+not))\s+(go|move|budge|leave|comply|listen|obey|do\s+it)|declines?|balks?|scoffs?|ignores?|defies|(stays?|remains?)\s+(put|rooted)|rooted\s+to|plants?\s+(her|his|their)\s+feet|stands?\s+(firm|(her|his|their)\s+ground)|holds?\s+(her|his|their)\s+ground|folds?\s+(her|his|their)\s+arms)\b/i;

/**
 * Flag when the DM narrates a compliance polarity the engine did not rule. `obeyed` narrated as refusal
 * (or vice-versa) trips a single bounded re-narration, the same contract as the coherence gate — so the
 * player never reads "Tessa refuses" over a token the engine just walked to the deed. Conservative: fires
 * only on a clear opposite-polarity marker with NO same-polarity marker, and only when the target is named.
 */
export function narrationDefiesCommand(narration: string, targetName: string | undefined, verdict: CommandVerdict): { code: 'command-polarity'; want: 'obeyed' | 'refused' } | null {
  if (!narration || !targetName) return null;
  const first = targetName.split(/\s+/)[0]!;
  if (!new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(narration)) return null;
  const obeyed = verdict === 'obeyed' || verdict === 'feared-into-compliance';
  const hasObey = OBEY_MARKERS.test(narration);
  const hasRefuse = REFUSE_MARKERS.test(narration);
  if (obeyed && hasRefuse && !hasObey) return { code: 'command-polarity', want: 'obeyed' };
  if (!obeyed && hasObey && !hasRefuse) return { code: 'command-polarity', want: 'refused' };
  return null;
}

// ── P4f: multi-turn goals — the world keeps moving between beats ─────────────────────────────────
// Some reactions don't finish in one beat: a walled-off keeper must come to the door NEXT beat; the
// distant knight must RUN in over several. Those carry an rx:goal — a DUMB WAYPOINT (invariant 11): a
// destination cell + one line to say on arrival + a countdown. advanceGoals is a turn-top stateless
// reducer that walks each goal-carrier ONE round toward its cell, emits an ETA fact, and on arrival
// emits the line then CLEARS the goal. It never re-perceives, branches, or re-targets — the moment a
// goal re-evaluates the world, it's a simulated mind, which the design rejects.

const GOAL_KEY = 'rx:goal';
const MAX_GOAL_AGE = 16; // wall-clock turns after which any goal is stale (the farthest reinforcer arrives in ~10)
interface Goal { kind: 'emerge' | 'reinforce' | 'gather'; col: number; row: number; say?: string; ttl: number; bornTurn?: number }

/** Stamp a dumb-waypoint goal on a token (engine-owned rx:* state; JSON-encoded since state is flat). */
export function setGoal(engine: Engine, id: string, goal: Goal, sceneDeltas: SceneDelta[]): void {
  const rs = engine.applySceneDeltas([{ op: 'setState', id, state: { [GOAL_KEY]: JSON.stringify(goal) } }]);
  sceneDeltas.push(...rs.applied);
}
function readGoal(o: MapObject): Goal | undefined {
  const g = o.state?.[GOAL_KEY];
  if (typeof g !== 'string' || !g) return undefined;
  try { const p = JSON.parse(g) as Goal; return typeof p?.col === 'number' && typeof p?.row === 'number' ? p : undefined; } catch { return undefined; }
}

/** One round of movement toward a cell, CAPPED by the actor's speed (so a far arrival takes several
 *  beats, not one teleport). Returns {arrived, at} — arrived when within ~1 tile of the goal. */
function stepToward(engine: Engine, state: GameState, map: SceneMap, o: MapObject, goal: Cell, sceneDeltas: SceneDelta[]): { arrived: boolean; moved: boolean; remainingFt: number } {
  const idx = spatialIndex(map);
  const from: Cell = { col: o.col, row: o.row };
  const arriveFt = map.grid.feetPerTile * 1.5;
  if (distanceFt(idx, from, goal) <= arriveFt) return { arrived: true, moved: false, remainingFt: 0 };
  const caps = deriveMoveCaps(state, o.id);
  const speedTiles = Math.max(3, Math.round((caps.speedFt || 30) / (map.grid.feetPerTile || 5)));
  const path = findPath(idx, from, goal, caps);
  let dest: Cell | undefined;
  if (path.ok) dest = path.cells.length <= speedTiles + 1 ? goal : path.cells[speedTiles]; // arrive, or one round along
  else if (path.frontier && (path.frontier.col !== from.col || path.frontier.row !== from.row)) dest = path.frontier;
  if (!dest) return { arrived: false, moved: false, remainingFt: distanceFt(idx, from, goal) }; // boxed in / no route
  const v = engine.travel({ actorId: o.id, to: { col: dest.col, row: dest.row }, mode: 'auto' });
  let moved = false;
  if (v.at && (v.at.col !== from.col || v.at.row !== from.row)) { sceneDeltas.push({ op: 'move', id: o.id, to: { col: v.at.col, row: v.at.row }, ...(v.pathCells?.length ? { via: v.pathCells } : {}) }); moved = true; }
  const now = v.at ?? from;
  return { arrived: distanceFt(idx, now, goal) <= arriveFt, moved, remainingFt: distanceFt(idx, now, goal) };
}

/**
 * Turn-top: advance every in-flight goal one round. Runs BEFORE the DM narrates so the world it describes
 * has already moved; the returned facts are injected as a "MEANWHILE" block. Deltas ride sceneDeltas.
 * `reacted` (shared with the disturbance resolvers) stops a token that already reacted THIS turn from also
 * being goal-advanced. Degrade-safe: any bad token is skipped, never a thrown turn.
 */
export function advanceGoals(engine: Engine, map: SceneMap, state: GameState, sceneDeltas: SceneDelta[], reacted: Set<string> = new Set()): string[] {
  const facts: string[] = [];
  let n = 0;
  for (const o of map.objects) {
    if (o.kind !== 'actor' || o.role === 'pc' || o.visible === false) continue;
    if (reacted.has(o.id)) continue;
    const goal = readGoal(o);
    if (!goal) continue;
    reacted.add(o.id); // ALWAYS claim a goal-carrier (even over the move cap) so a fresh reaction can't double-move it
    if (n >= MAX_REACTORS) continue; // over the per-beat move budget — advance it next beat, not this one
    try {
      const name = displayName(o);
      // Wall-clock staleness (a goal cannot outlive its scene). turnCount keeps incrementing while the party
      // is at OTHER locations, but a departed map's goals aren't processed (ttl frozen) — so on RETURN a
      // long-cold goal would resurrect (the knight walking to where a fight WAS). A present goal always
      // clears via its ttl within ~10 beats; anything older than the absolute cap is a stale return → drop it.
      if ((state.turnCount ?? 0) - (goal.bornTurn ?? (state.turnCount ?? 0)) > MAX_GOAL_AGE) { engine.applySceneDeltas([{ op: 'setState', id: o.id, state: { [GOAL_KEY]: '' } }]); n++; continue; }
      const step = stepToward(engine, state, map, o, { col: goal.col, row: goal.row }, sceneDeltas);
      const ttl = goal.ttl - 1;
      if (step.arrived || ttl <= 0) {
        // Reached (or ran out of patience) → deliver the one line, then the goal DIES.
        engine.applySceneDeltas([{ op: 'setState', id: o.id, state: { [GOAL_KEY]: '' } }]);
        if (step.arrived) {
          // Soft arrival — no HARD engine-quoted line (a quote from an NPC the party's moved away from would
          // trip the earshot gate); the say is offered as intent the DM voices only if they're close enough.
          facts.push(goal.kind === 'emerge' ? `${name} comes to the doorway, drawn by the commotion${goal.say ? ` (wanting to ask something like "${goal.say}")` : ''}.`
            : goal.kind === 'reinforce' ? `${name} reaches the scene and moves to take charge${goal.say ? ` (a stand-down: "${goal.say}")` : ''}.`
            : `${name} arrives.`);
        } // ttl-expired-without-arriving = they gave up; say nothing (silent stand-down)
      } else if (step.moved) {
        // Still en route AND actually moved — a distance-aware progress beat (never claim motion that didn't happen).
        engine.applySceneDeltas([{ op: 'setState', id: o.id, state: { [GOAL_KEY]: JSON.stringify({ ...goal, ttl }) } }]);
        const close = step.remainingFt <= map.grid.feetPerTile * 4;
        facts.push(goal.kind === 'reinforce'
          ? (close ? `${name} is nearly here, only a few strides out.` : `${name} is crossing the ground toward the disturbance, coming fast.`)
          : `${name} moves toward the disturbance.`);
      } else {
        // Could not move (boxed in / no route) — stay honest: no progress claim, just let the goal age out.
        engine.applySceneDeltas([{ op: 'setState', id: o.id, state: { [GOAL_KEY]: JSON.stringify({ ...goal, ttl }) } }]);
      }
      n++;
    } catch { /* a goal must never break the turn */ }
  }
  return facts;
}

/**
 * Reinforcement dispatch (P4f): a loud disturbance carries beyond earshot — distant AUTHORITY (a knight,
 * the watch) turns and comes. Gives each nearest such NPC (within alarm range, not already reacting or
 * goal-bound) a 'reinforce' goal toward the disturbance + a dispatch fact. They walk in over beats via
 * advanceGoals; this is "the guard comes to help" the reaction layer was always reaching for.
 */
const ALARM_FT = 240; // a shout/scream + word-of-mouth carries this far to those who'd respond
const MAX_REINFORCERS = 2;
export function dispatchReinforcements(engine: Engine, map: SceneMap, eventCell: Cell, aggressorId: string, targetId: string | undefined, ledger: LedgerState | undefined, sceneDeltas: SceneDelta[], reacted: Set<string>): string[] {
  const idx = spatialIndex(map);
  const g = sceneGraph(map, idx);
  const eventZone = whereIs(idx, eventCell).buildingId ?? 'outdoor';
  const cands: { o: MapObject; d: number }[] = [];
  for (const o of map.objects) {
    if (o.kind !== 'actor' || o.visible === false || o.role === 'pc') continue;
    if (o.id === aggressorId || o.id === targetId || reacted.has(o.id)) continue;
    if (readGoal(o)) continue; // already on the way / busy
    const persona = personaForToken(o, ledger);
    if (persona.archetype !== 'authority') continue; // only those whose job is to respond
    const d = distanceFt(idx, { col: o.col, row: o.row }, eventCell);
    if (d <= EARSHOT_FT) continue; // in-earshot authority already reacted (confront) in resolveReactions
    // Beyond earshot but within alarm range, AND not walled in the same room as nothing — they hear the alarm.
    if (d <= ALARM_FT && (g.zoneOf.get(o.id) ?? 'outdoor') === 'outdoor') cands.push({ o, d });
  }
  cands.sort((a, b) => a.d - b.d);
  const facts: string[] = [];
  for (const { o, d } of cands.slice(0, MAX_REINFORCERS)) {
    // ttl SCALES with distance (~30 ft/round of travel + 2 beats of slack) so a far reinforcer always has
    // enough beats to actually ARRIVE — a fixed ttl would strand anyone past ~125 ft "closing" then vanishing.
    const ttl = Math.ceil(d / 30) + 2;
    setGoal(engine, o.id, { kind: 'reinforce', col: eventCell.col, row: eventCell.row, say: 'Hold! Stand down!', ttl, bornTurn: engine.getState().turnCount ?? 0 }, sceneDeltas);
    reacted.add(o.id);
    facts.push(`Across the way, ${displayName(o)} snaps toward the commotion and breaks into a run — help is coming.`);
  }
  return facts;
}
