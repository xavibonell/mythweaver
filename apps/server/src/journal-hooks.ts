/**
 * P5 JOURNAL HOOKS — the two write points that depend on the FINAL narration (docs/PLAYER-INTERFACE.md P5).
 *
 * Both are pure functions the orchestrator's finish() calls once per completed narration, and both obey
 * the journal's law: composed player-safe AT WRITE TIME, from words the table actually heard.
 *
 *  · narratedMeets — "narrated ⇒ revealed": the first time a carded NPC is NAMED ALOUD, a `met` event
 *    births their dossier carrying the DM's own introducing sentence.
 *
 *  · corroboratedClues — recordFact(source:'dm') is bookkeeping, not proof of narration (the playbook
 *    TELLS the DM to record un-narrated motives). A fact becomes party knowledge only when its VALUE
 *    appears verbatim in this turn's narration — and the clue text carries the value alone, never the
 *    attribute (DM filing vocabulary the table never heard; 'secretly-a-doppelganger: she avoids the
 *    chapel' would leak the secret through the label while the value stays innocent). The subject card
 *    is attached only if the players already know that person or the narration named them in the same
 *    breath — otherwise the clue stands alone and the association stays unearned.
 *
 * NAME MATCHING IS PRECISION-FIRST, because the two failure modes are not symmetric: a MISSED match
 * self-heals (the dossier births the moment the person acts — a verdict or disposition names them),
 * while a FALSE match permanently ships an authored-but-unmet NPC's name into the players' Book. The
 * adversarial review demonstrated three false-birth lanes in a looser matcher — a shared surname
 * ("Tessa Reed" bearing every unmet Reed), a lowercase homograph ("Willow" from a willow tree), and a
 * sentence-initial capital ("Rose petals…" bearing Rose Thorn) — so the rules are:
 *   · a MULTI-WORD name matches as the full name, case-insensitively (enough signal on its own);
 *   · a single name-token (≥4 chars) is evidence only if it is UNIQUE across the whole cast,
 *     capitalized exactly, and NOT opening a sentence (a capitalized sentence-opener is just English).
 */

import { randomUUID } from 'node:crypto';
import type { GameState } from '@mythweaver/shared';
import { STANDING_ATTR } from './interactions.js';

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A case-sensitive token match at a position that is EVIDENCE — i.e. not opening a sentence, and not
 *  opening a QUOTED sentence either (the first word after “ is capitalized regardless of what it is;
 *  a live drive showed dialogue-initial names slipping through the plain-quote class). */
function tokenEvidence(token: string, narration: string): boolean {
  for (const m of narration.matchAll(new RegExp(`\\b${esc(token)}\\b`, 'g'))) {
    const before = narration.slice(0, m.index).trimEnd();
    if (before && !/[.!?…"'”“‘«]$/.test(before)) return true;
  }
  return false;
}

/** Build the narration↔name matcher for one cast. Token uniqueness is computed over EVERY card name
 *  (PCs included): a token two people share identifies neither.
 *
 *  TWO TIERS, because the risk is not the same for everyone. Someone STAGED on the map is already
 *  standing in the players' view — the DM naming them is a plain introduction, and the DM writes
 *  "Tessa returns the greeting" far more often than "the woman called Tessa Reed does" — so a staged
 *  name matches wherever it appears. Someone UNSTAGED is authored cast the table has never seen, and
 *  a false match there leaks a stranger's existence, so their name must survive the strict evidence
 *  test (multi-word full name, or a unique token that is NOT merely opening a sentence or a quote). */
export function buildNameMatcher(cards: { name?: string }[], stagedNames: Set<string> = new Set()): (name: string, narration: string) => boolean {
  const owners = new Map<string, number>();
  for (const c of cards) {
    for (const t of new Set((c.name ?? '').split(/\s+/).filter((t) => t.length >= 4))) {
      owners.set(t, (owners.get(t) ?? 0) + 1);
    }
  }
  return (name, narration) => {
    if (!name || !narration) return false;
    const staged = stagedNames.has(name.toLowerCase());
    // Staging relaxes POSITION, never CASE — otherwise a staged "Willow" is born from the willow
    // she is standing under. Only a multi-word full name is unambiguous enough to match loosely.
    if (name.includes(' ') && new RegExp(`\\b${esc(name)}\\b`, 'i').test(narration)) return true;
    // A single token still has to be capitalized like a proper noun — that is what keeps a staged
    // "Willow" from being born out of the willow she is standing under.
    return name.split(/\s+/).some((t) => t.length >= 4 && owners.get(t) === 1
      && (staged ? new RegExp(`\\b${esc(t)}\\b`).test(narration) : tokenEvidence(t, narration)));
  };
}

/** Names the players can currently SEE on the map — the tier-1 signal above. Hidden tokens never
 *  count: a lurker the projection drops must not become evidence that they were introduced. */
export function stagedNames(state: GameState): Set<string> {
  const world = state.world;
  const map = world?.currentLocationId ? world.locations[world.currentLocationId] : undefined;
  const out = new Set<string>();
  for (const o of map?.objects ?? []) if (o.visible !== false && o.name) out.add(o.name.toLowerCase());
  return out;
}

/** Every card id the journal has already shown the players. */
function knownIds(state: GameState): Set<string> {
  return new Set((state.journal ?? []).flatMap((e) => e.subjects));
}

const allCards = (state: GameState) => Object.values(state.ledger?.entities ?? {});

/** The DM narrates in markdown (**STOREHOUSE**, *iron creaking*); the Book is prose, not source. */
export const plainProse = (s: string) => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/[*_`]/g, '').trim();

/** The sentence that introduced them — the DM's words, not a template.
 *
 *  Not every sentence that carries a name INTRODUCES anyone. DM turns close with menus of options
 *  ("Ask Orrin about the lock. Ask Hobb about the metal. What do you do?"), and a live test filed
 *  exactly those as first impressions. A suggestion is addressed to the players, not a description
 *  of the person, so questions and imperative prompts are skipped in favour of a plain statement;
 *  when a name appears ONLY in a menu, the neutral fallback is the honest entry. */
function introSentence(name: string, narration: string, matches: (n: string, s: string) => boolean): string {
  const sentences = narration.split(/(?<=[.!?…])\s+/).map((s) => s.trim()).filter(Boolean);
  const descriptive = (s: string) => !/[?]\s*$/.test(s) && !/^(ask|try|tell|talk|speak|asking|maybe|consider|you could|perhaps)\b/i.test(s);
  const hit = sentences.find((s) => matches(name, s) && descriptive(s)) ?? sentences.find((s) => matches(name, s) && descriptive(s.replace(/\s*what do you do\?.*$/i, '')));
  return plainProse(hit ?? `${name} is here, among the people of this place.`);
}

/** Carded NPCs named aloud for the first time → `met` events. */
export function narratedMeets(narration: string, state: GameState): { cardId: string; text: string }[] {
  if (!narration) return [];
  const known = knownIds(state);
  const matches = buildNameMatcher(allCards(state), stagedNames(state));
  const out: { cardId: string; text: string }[] = [];
  for (const card of allCards(state)) {
    if (card.kind !== 'npc' || !card.name || known.has(card.id)) continue;
    if (matches(card.name, narration)) out.push({ cardId: card.id, text: introSentence(card.name, narration, matches) });
  }
  return out;
}

export interface DmFact { subject: string; attribute: string; value: string }

/** Dedup key for a recorded fact. Salted + hashed because it ships inside the journal event's data —
 *  the raw subject|attribute pair is the DM's filing vocabulary ('npc:malachi|secretly-a-doppelganger')
 *  and unsalted it is a deterministic guess-confirmation oracle over exactly that vocabulary. */
export function clueFactKey(subject: string, attribute: string, salt: string): string {
  const s = `${salt}|${subject}|${attribute}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `fk_${h.toString(16)}`;
}

/** DM-recorded facts whose value the table actually HEARD this turn → `clue` events. */
export function corroboratedClues(narration: string, facts: DmFact[], state: GameState): { subjects: string[]; text: string; factKey: string }[] {
  if (!narration || !facts.length) return [];
  const known = knownIds(state);
  const matches = buildNameMatcher(allCards(state), stagedNames(state));
  const salt = (state.journalSalt ??= randomUUID());
  const cards = state.ledger?.entities ?? {};
  const already = new Set(
    (state.journal ?? []).filter((e) => e.kind === 'clue' && e.data?.factKey).map((e) => String(e.data!.factKey)),
  );
  const out: { subjects: string[]; text: string; factKey: string }[] = [];
  for (const f of facts) {
    const value = f.value.trim();
    // Short values ("yes", "40 gp") corroborate by accident; standing is engine bookkeeping, never lore.
    if (value.length < 12 || f.attribute === STANDING_ATTR || f.attribute.startsWith('standing')) continue;
    if (!narration.toLowerCase().includes(value.toLowerCase())) continue;
    const factKey = clueFactKey(f.subject, f.attribute, salt);
    if (already.has(factKey)) continue;
    already.add(factKey);
    const card = cards[f.subject] ?? Object.values(cards).find((c) => c.name?.toLowerCase() === f.subject.toLowerCase());
    const subjects = card && (known.has(card.id) || matches(card.name, narration)) ? [card.id] : [];
    out.push({ subjects, text: `Learned: ${value}`, factKey });
  }
  return out;
}
