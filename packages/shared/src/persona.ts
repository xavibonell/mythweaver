// persona.ts — the thin persona layer for living-world reactivity (P2).
//
// A persona is the small, STATIC disposition that tells the reaction resolver (P3) HOW a
// non-player actor answers a disturbance: does the smith hold his post, does the market woman
// bolt, does the town knight advance? It is thin by law — the design review rejected simulated
// minds ("the lesson is the ledger shape, not 25 simulated minds"). So: persona is static
// vocabulary; the DYNAMIC standing lives in npc:* flags, and the AUDIT trail lives in facts.
// Persona itself never moves anyone — it is data the resolver reads.
//
// Two tiers, no storage cost for the common case:
//   Tier-1  profileOf(subject)   — DERIVED at read-time from role/tag/id. Every actor on every
//           map (INCLUDING scenes frozen before this code existed) gets a sensible persona for
//           $0. This is the generalization of the p0-killtest prototype that P0 validated.
//   Tier-2  EntityCard.persona   — an OPTIONAL, additive PersonaSeed the composer/upsertNpc fill
//           for NAMED cast (allegiance + a one-line stake, and an override archetype/temper when
//           the derivation is wrong). When present it overrides the derived fields and adds the
//           narrative colour an id-hash can't invent.
//
// personaOf(subject, card?) is the single entry point: seed over derivation, ALWAYS a value.

/** WHO an actor is, functionally — sets the default reaction family. */
export type PersonaArchetype = 'authority' | 'keeper' | 'cleric' | 'commoner' | 'beast' | 'monster';

/** HOW they meet danger — splits the reaction within an archetype. */
export type PersonaTemper = 'timid' | 'steady' | 'bold' | 'brave' | 'territorial' | 'feral';

/** A resolved persona — always complete (Tier-1 fills archetype+temper). */
export interface Persona {
  /** WHO they are, functionally. */
  archetype: PersonaArchetype;
  /** HOW they meet danger. */
  temper: PersonaTemper;
  /** WHO they answer to (a faction/lord/'town'/'the party') — narrative colour, optional. */
  allegiance?: string;
  /** ONE line: what they protect or want ('her market stall', 'the shrine relics'). */
  stake?: string;
  /** true when produced by profileOf (Tier-1); absent when an authored card supplied it. */
  derived?: boolean;
}

/** The AUTHORED, all-optional shape stored on EntityCard — the composer/DM fill what they know. */
export interface PersonaSeed {
  archetype?: PersonaArchetype;
  temper?: PersonaTemper;
  allegiance?: string;
  stake?: string;
}

/** The minimal read-model profileOf needs — a MapObject, an EntityCard, or any {id,…} satisfies it. */
export interface PersonaSubject {
  id: string;
  name?: string;
  tag?: string;
  role?: string; // 'pc' | 'npc' | 'mob' | free text — string so both ActorRole and looser callers fit
}

const PERSONA_TEMPERS: readonly PersonaTemper[] = ['timid', 'steady', 'bold'];

// Word signals, matched against `id + ' ' + tag`. Order matters: the first family that matches wins,
// so hostiles and authority (both can carry weapon words) are disambiguated by role before tags.
const AUTHORITY_RE = /\b(knight|guard|soldier|warden|sentinel|sentry|captain|watch(man|men)?|militia|constable|marshal|paladin)\b/;
const KEEPER_RE = /\b(keeper|keep|smith|blacksmith|farrier|innkeep(er)?|barkeep(er)?|shopkeep(er)?|merchant|miller|tanner|cooper|baker|butcher|apothecary|host(ler)?)\b/;
const CLERIC_RE = /\b(priest|priestess|monk|acolyte|cleric|nun|abbot|friar|deacon|shrine|temple|chapel)\b/;
const BEAST_RE = /\b(wolf|hound|dog|cat|mastiff|boar|bear|rat|horse|mule|ox|goat|sheep|chicken|goose|beast|animal|mount)\b/;

/**
 * Tier-1 — derive a persona from role/tag/id alone. Total (never throws, always returns a Persona),
 * deterministic (a given subject always maps the same way), and retroactive (works on any frozen
 * scene). The commoner temper is split by a stable id-hash so a crowd isn't uniform.
 */
export function profileOf(subject: PersonaSubject): Persona {
  const id = (subject.id ?? '').toLowerCase();
  const tag = (subject.tag ?? '').toLowerCase();
  const role = (subject.role ?? '').toLowerCase();
  const name = subject.name ?? '';
  const sig = `${id} ${tag}`;

  // Hostiles first — a mob is a combatant, not a civilian bystander. A beast reads as skittish,
  // anything else as a monster that closes on the threat.
  if (role === 'mob' || /\b(bandit|raider|cultist|goblin|skeleton|zombie|ghoul|wraith|marauder)\b/.test(sig)) {
    return BEAST_RE.test(sig) ? { archetype: 'beast', temper: 'feral', derived: true } : { archetype: 'monster', temper: 'feral', derived: true };
  }
  if (BEAST_RE.test(sig)) return { archetype: 'beast', temper: 'timid', derived: true };
  if (AUTHORITY_RE.test(sig)) return { archetype: 'authority', temper: 'brave', derived: true };
  // Keeper covers both genuine trades (smith/merchant) AND the scene generator's building-anchor
  // convention: it names every building's occupant "<building>-keeper" (verified against the
  // oakhollow/drowned-bell fixtures — 11/17 and 3/4 NPCs). Rooted-to-a-building IS the keeper
  // disposition (hold the post, retreat into it if pressed), and it is the right call for the one
  // case the user flagged — a storehouse keeper is territorial. It is also mostly moot: these
  // anchors sit under roofs, so the witness oracle grades them alerted/oblivious, not saw. So the
  // `-keeper` suffix mapping to keeper is DELIBERATE, not an accident of naming.
  if (id.endsWith('keeper') || KEEPER_RE.test(sig)) return { archetype: 'keeper', temper: 'territorial', derived: true };
  if (CLERIC_RE.test(sig)) return { archetype: 'cleric', temper: 'steady', derived: true };

  // A plain commoner. Named ones get a stable hash-split temper for variety; the anonymous default
  // is timid (an unnamed extra in a crowd bolts first).
  const h = [...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const temper = name ? PERSONA_TEMPERS[h % PERSONA_TEMPERS.length]! : 'timid';
  return { archetype: 'commoner', temper, derived: true };
}

/**
 * The single entry point: an authored PersonaSeed (Tier-2) OVERRIDES the derived archetype/temper
 * field-by-field and adds allegiance/stake; anything the seed omits falls back to the derivation.
 * Always returns a complete Persona.
 */
export function personaOf(subject: PersonaSubject, seed?: PersonaSeed | null): Persona {
  const base = profileOf(subject);
  if (!seed) return base;
  const merged: Persona = {
    archetype: seed.archetype ?? base.archetype,
    temper: seed.temper ?? base.temper,
    ...(seed.allegiance ? { allegiance: seed.allegiance } : {}),
    ...(seed.stake ? { stake: seed.stake } : {}),
  };
  // "derived" is true only if BOTH identity fields came from the derivation.
  if (!seed.archetype && !seed.temper) merged.derived = true;
  return merged;
}

// ── The reaction vocabulary the P3 resolver consumes ─────────────────────────────────────────
// perception grade (from the witness oracle) × persona → a coordinate-free reaction INTENT. The
// resolver maps `toward` to a concrete cell and `verb` to engine.travel + an rx:* state flag; it
// owns the geometry, this owns the disposition. Kept here (not in the resolver) so it is pure and
// unit-testable on its own.

/** How clearly a witness perceived the disturbance (the oracle's verdict, lowercased). */
export type PerceptionGrade = 'saw' | 'heard' | 'alerted' | 'oblivious';

export type ReactionVerb =
  | 'none' // did not register it, or has no reason to move
  | 'confront' // close on the threat (authority/monster)
  | 'brace' // hold post, wary, ready to bolt if pressed (keeper)
  | 'shield-others' // move to put themselves between threat and the victim (cleric)
  | 'back-away' // retreat a little, keep watching (steady nerve)
  | 'gawk' // freeze and stare, then flee if it worsens (bold curiosity)
  | 'flee' // break for the nearest exit/home (timid, beast)
  | 'cower' // drop where they stand, no movement (overwhelmed)
  | 'emerge'; // was walled off, only ALERTED — come to the door to investigate next beat

/** Coordinate-free destination the resolver resolves to a cell. */
export type ReactionToward = 'attacker' | 'victim' | 'home' | 'exit' | 'door' | 'none';

export interface ReactionIntent {
  verb: ReactionVerb;
  toward: ReactionToward;
  /** A continuation the escalation layer (P4) may read — otherwise the reaction is one-shot. */
  goal?: 'investigate' | 'guard' | 'raise-alarm';
}

/** What KIND of disturbance a witness is reacting to — the same perception, different dispositions:
 *  a threat frightens (flee/confront), an outrage (theft/desecration) SCANDALISES (glare/disapprove,
 *  authority apprehends), a hazard (fire/collapse) endangers everyone (all recoil, none charge it). */
export type ReactionValence = 'threat' | 'outrage' | 'hazard';

/**
 * Map (persona, perception grade, valence) → a reaction intent. Deterministic and side-effect-free. An
 * 'alerted' witness (walled off, only heard a loud event) never acts this beat — it emerges at its
 * door to investigate next beat. 'oblivious' does nothing.
 */
export function reactTo(p: Persona, grade: PerceptionGrade, valence: ReactionValence = 'threat'): ReactionIntent {
  if (grade === 'oblivious') return { verb: 'none', toward: 'none' };
  if (grade === 'alerted') return { verb: 'emerge', toward: 'door', goal: 'investigate' };
  const saw = grade === 'saw';
  // HAZARD (fire, collapse): nobody charges it — even authority pulls back and helps; the timid bolt.
  if (valence === 'hazard') {
    if (p.archetype === 'beast' || p.temper === 'timid' || p.temper === 'feral') return { verb: 'flee', toward: 'exit' };
    if (p.archetype === 'cleric') return { verb: 'shield-others', toward: 'victim' }; // pull others clear
    return { verb: 'back-away', toward: 'none' };
  }
  // OUTRAGE (theft, desecration, trespass): scandal, not danger — the law moves to apprehend, the rest
  // recoil/glare; nobody flees a pickpocket, and beasts/hostiles don't care.
  if (valence === 'outrage') {
    if (p.archetype === 'authority' || p.temper === 'brave') return { verb: 'confront', toward: 'attacker', goal: 'guard' };
    if (p.archetype === 'beast' || p.archetype === 'monster') return { verb: 'none', toward: 'none' };
    if (p.archetype === 'keeper') return { verb: 'brace', toward: 'none' }; // stands over their goods, glaring
    return saw ? { verb: 'gawk', toward: 'none' } : { verb: 'back-away', toward: 'none' }; // scandalised stare / edge off
  }
  switch (p.archetype) {
    case 'authority':
      return { verb: 'confront', toward: 'attacker', goal: 'guard' };
    case 'monster':
      return { verb: 'confront', toward: 'attacker' };
    case 'keeper':
      return saw ? { verb: 'brace', toward: 'none' } : { verb: 'back-away', toward: 'none' };
    case 'cleric':
      return { verb: 'shield-others', toward: 'victim' };
    case 'beast':
      return { verb: 'flee', toward: 'exit' };
    case 'commoner':
    default:
      if (p.temper === 'brave') return { verb: 'confront', toward: 'attacker' };
      if (p.temper === 'bold') return saw ? { verb: 'gawk', toward: 'none' } : { verb: 'back-away', toward: 'none' };
      if (p.temper === 'steady' || p.temper === 'territorial') return { verb: 'back-away', toward: 'none' };
      return { verb: 'flee', toward: 'exit' }; // timid / feral / any residue
  }
}

// ── The DRAW vocabulary (interaction layer P4a) ──────────────────────────────────────────────
// Threat scatters a crowd (reactTo above); a summons or a performance PULLS one. appealTo is the
// draw-side sibling: the APPEAL — derived from the stimulus kind by the resolver, never authored
// by the LLM — is the PRIMARY KEY that pins the default verb; persona/temper only modulate the
// stop-distance and the hold threshold. If a persona ever needs its own verb per appeal cell, the
// rejected multiplicative stimulus×persona table has snuck back — stop and redesign (the P4a
// no-go signal, docs/INTERACTION-LAYER.md §2).

/** Why a broadcast stimulus pulls: authority = a summons/announcement; curiosity = a performance/
 *  spectacle. (Fear stays on reactTo's threat lane; outrage/greed arrive with later phases.) */
export type Appeal = 'authority' | 'curiosity';

export interface AppealResponse {
  /** approach = drift toward the locus; hold = stay put (still a visible reaction); recoil = shy away. */
  verb: 'approach' | 'hold' | 'recoil';
  /** Where an approacher stops, in TILES from the locus — bold presses close, timid keeps distance. */
  approachDist: number;
}

/**
 * Map (appeal, persona, perception grade) → a draw response. Pure and deterministic, like reactTo.
 * 'alerted' (walled off — only caught the noise) and 'oblivious' hold: a broadcast draw produces no
 * visible reaction through a wall this beat (coming to the door is the multi-turn goals phase).
 */
export function appealTo(appeal: Appeal, p: Persona, grade: PerceptionGrade): AppealResponse {
  if (grade === 'oblivious' || grade === 'alerted') return { verb: 'hold', approachDist: 0 };
  // Rooted-or-wary archetypes hold regardless of the appeal: a keeper won't abandon the post, a
  // hostile doesn't join a crowd, and beasts want no part of shouting or music (recoil from the noise).
  if (p.archetype === 'keeper') return { verb: 'hold', approachDist: 0 };
  if (p.archetype === 'monster') return { verb: 'hold', approachDist: 0 };
  if (p.archetype === 'beast') return { verb: 'recoil', approachDist: 0 };
  // Everyone else approaches — the appeal pins the verb; temper sets only HOW CLOSE they come.
  // A summons (authority) gathers tighter than a spectacle (curiosity) is watched.
  const base = appeal === 'authority' ? 2 : 3;
  const dist = p.temper === 'timid' ? base + 3 : p.temper === 'steady' ? base + 1 : base; // bold/brave press in
  return { verb: 'approach', approachDist: dist };
}

/**
 * One-line human render for the canon block / reaction facts, e.g. "keeper, territorial — loyal to
 * the guild, stake: his forge". Returns just "archetype temper" when there's no authored colour.
 */
export function personaLine(p: Persona): string {
  const head = `${p.archetype}, ${p.temper}`;
  const tail = [p.allegiance && `loyal to ${p.allegiance}`, p.stake && `stake: ${p.stake}`].filter(Boolean).join(', ');
  return tail ? `${head} — ${tail}` : head;
}
