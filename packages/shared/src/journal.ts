/**
 * THE JOURNAL — the fourth world-model (docs/PLAYER-INTERFACE.md §2).
 *
 * The engine knows the world, the DM narrates it, the canvas shows it — and until now nothing recorded
 * what the PLAYERS know. This is that record: an append-only stream of the moments the table actually
 * witnessed, from which the Book (this scene / past scenes / who we've met / what we found) is a pure
 * projection, and from which the future inter-chapter diary distills its durable facts.
 *
 * THE LOAD-BEARING RULE: every event is composed PLAYER-SAFE AT WRITE TIME, from data the table just
 * saw. Nothing here is ever redacted at read time. That is what makes the stream shippable verbatim —
 * and what keeps a new engine feature from silently leaking into it.
 *
 * A P0 probe over a real session settled the shape: the engine's own log rows are unreadable machinery
 * ("scene: setState npc:…", "reach: too-far-to-close"), while the strings that read like a book — "a
 * villager breaks and bolts away from the violence" — existed only inside tool results and died each
 * turn. So the journal is WRITTEN at those verdict moments rather than mined from the log afterwards.
 */

/** What kind of moment this was. Deliberately small: rolls, damage and inventory are NOT here — the
 *  roll bar, the transcript and the character sheet already own them, and duplicating them turns the
 *  Book into a debug feed (the failure mode the design red-team flagged as fatal to the whole idea). */
export type JournalKind =
  | 'prologue' // the once-per-session opening: who you are, how you came to be here — in the DM's voice
  | 'chapter' // a beat opened or closed — the Book's chapter boundary
  | 'goal' // what the party is trying to do (snapshotted, because the brief is overwritten in place)
  | 'place' // the party entered somewhere
  | 'verdict' // the world answered: a crowd scattered, an NPC obeyed or refused, help arrived
  | 'disposition' // someone's regard for the party visibly shifted
  | 'finding' // a point of interest was discovered or searched
  | 'loot' // something was actually taken
  | 'decision'; // a choice the party made, recorded as canon

export interface JournalEvent {
  /** Monotonic within the session — the ONLY safe sort key (a roll-resume shares its turn number). */
  seq: number;
  turn: number;
  /** The beat this happened in — the chapter key the Book and the future archivist group by. */
  beatId: string;
  locationId?: string;
  kind: JournalKind;
  /** Ledger card / POI / map ids this event is ABOUT. This is what grows a dossier: an entity's entry
   *  is born from the first event that names it, so pre-authored cast never appears before it is met. */
  subjects: string[];
  /** The player-facing sentence, composed at write time. Never a template to be filled in later. */
  text: string;
  /** Small structured extras per kind: {outcome}, {dir:-1}, {items,gold}, {opened:true}. */
  data?: Record<string, string | number | boolean>;
}

/** A person or thing the party has encountered, folded from the events that name it. Perceived, not
 *  authored: nothing here comes from an NPC's secret want/fear/allegiance — only what the table saw. */
export interface Dossier {
  id: string;
  name: string;
  firstSeen: { turn: number; beatId: string };
  lastSeen: { turn: number; beatId: string };
  /** Accumulated from WITNESSED shifts only, starting at 0. Never the engine's standing scalar, which
   *  is seeded from authored allegiance — printing that would put a disguised villain's true feelings
   *  on the players' screen before they earned the knowledge. */
  regard: number;
  /** What this person was seen to do, newest first. */
  deeds: { seq: number; turn: number; text: string }[];
}

/** One closed or current chapter of the Book. */
export interface Chapter {
  beatId: string;
  title: string;
  /** The goal as it stood during THIS chapter (the live brief is overwritten on every replan). */
  goal?: string;
  outcome?: string;
  current: boolean;
  events: JournalEvent[];
}
