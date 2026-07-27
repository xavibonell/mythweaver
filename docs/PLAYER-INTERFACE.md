# The Player Interface — the table's Book, and the fourth world-model

**Status: PROPOSED (2026-07-27).** Synthesized from a 10-agent design workflow (4 seam maps × 4 designs ×
2 adversarial critiques); the critiques' corrections are folded in — where a design variant and a critique
disagreed, the critique won. This is the reconciled, single design.

## The ask (user)
A player-facing interface on the **live table** (`apps/web /dm`): character status/inventory/backstory
(maybe secrets), and a contextual **Book** — what happened in this scene, past scenes, the current goal,
knowledge acquired. Entities accrue: *"Tessa is introduced → she appears with only what the DM provided;
interacting with her grows the entry — perceived personality etc."* Findings too: *"I explore the pot →
what's in it goes in there."* Distribute it so it's usable; wire it in; parts must serve the future
inter-chapter diary.

## The one-sentence architecture
A new append-only, engine-owned **journal** (`state.journal: JournalEvent[]`) records the moments the table
*witnessed* — composed player-safe **at write time** — and a **fail-closed server projection** (dedicated
`/player-view` + `/player-turn` routes) is the *only* thing the player page can fetch; the Book UI is a pure
render of that stream, and the inter-chapter diary later distills the same stream.

This materializes the missing **fourth world-model**: engine knows / DM says / player sees / **players KNOW**.

## Part 1 — The visibility law (default-closed)
> A datum enters the players' world-model only when a deterministic engine/orchestrator event surfaces it at
> the table, and the write point composes the player-facing text at that moment from witnessed data only.
> Nothing is redacted at read time to produce player text; read-time filtering exists only for the payload
> envelope (arc whitelist, map strip), never for knowledge content.

**Never enters the journal or any player payload:** `blueprint.intendedEnding/centralProblem/spine`; ArcBrief
steering (reachable hooks, bridgeNpcs, notes, **clocks** — Director pressure spoils); **`activeBeatIntent`**
(Director-facing by construction — see Goal below); unvisited beat titles; per-beat encounters;
`EntityCard.voice{tic,want,fear}`, `persona`, `notes`, aliases; Plants (any status); composer-sourced facts;
raw standing scalars AND seeded standings; POI `hidden/discoverDc/contents-before-search/notes/leadsTo`;
`visible:false` map objects **and every delta that touches them**; actors inside unrevealed closed buildings;
`rx:*`/`cmd-refused:*` state keys; any DC; tool traces/diff/provenance/cost/model; unidentified magic items'
true names + `magic` flags; `Entrance.toLocationId`.

**Two LLM-trust traps the critiques caught (both excluded from v1):**
- `recordFact` (`source:'dm'`) is **not** proof of narration — the playbook tells the DM to record
  *un-narrated bookkeeping* (an NPC's private motive). No ledger fact reaches the players directly. A later
  "clue" lane needs deterministic corroboration (fact value appears verbatim in that turn's narration) or an
  explicit `revealFact` tool.
- The **first standing word leaks the authored seed** (first fact = seed±1; a disguised doppelganger thanked
  once would print "wary"). Dossier disposition therefore shows only **witnessed deltas** ("seems
  warmer/cooler toward you"), accumulating a perceived level from 0 — never `standingWord(fact.value)`.

**Known inherited hazard (playbook-level, not projection-level):** `requestRoll.reason` is LLM-composed and
already player-visible in the roll bar — add "reasons name the attempt, never the secret" to the playbook.

## Part 2 — The journal substrate
`packages/shared`: `JournalEvent { seq, turn, beatId, locationId?, kind, subjects[], text, data?, source:
'engine'|'verdict'|'chronicler' }` (text clipped ~240; `source` here ≠ `FactRow.source`). Storage:
**additive** `GameState.journal?: JournalEvent[]` — rides both persistence paths free (dev-session freeze +
play-API blob); absent ⇒ feature off, table renders as today. Single writer `Engine.journal(e)` (stamps
seq/turn/beatId/locationId; never throws).

**v1 kind set (~9, curated — the anti-debug-feed rule):** `chapter-open/close` (from `advanceScene`,
engine-side so every caller chapters the Book and passive tables get transitions), `goal`, `entity-met` (once
per entity ever), `disposition` (only when the *witnessed* word changes), `verdict` (engine verdict facts the
table saw: reactions, command/perform outcomes, MEANWHILE arrivals, travel/reach facts — deduped: the
resume/continuation path is the sole writer for suspended turns; hidden-actor guard in the emit helper),
`finding-discovered/searched/looted` (from `discoverPoi/searchPoi/lootPoi` — existence-leak-safe because the
engine already throws on undiscovered POIs), `decision` (only `decision:*` flags), `place`. **Explicitly not
journaled in v1:** rolls/damage/heal/xp/item/gold (the roll bar, transcript and sheet already own those),
`sighting` (becomes a dossier `lastSeen` field, never a rendered row), `clue` (see traps above).

**Dossier birth = first *mention in narration* of a carded, staged entity** (`extractMentions` →
`cardForToken`) — never `upsertEntity` (the composer pre-authors future cast; that would be a timing leak).
Known v1 narrowing: an NPC narrated but never staged ("the Duke demands tribute") gets no entry; v1.5 adds a
name-match against ledger cards (narrated ⇒ revealed keeps it law-compliant).

**Dossier projection (pure fold):** id, name+kind (at met), status *only* via a witnessed `entity-status`
event, first-met/last-seen, perceived disposition (witnessed deltas only), observed deeds (verdict texts,
newest N), findings it anchors. Plus `tokenToDossier: Record<mapId, cardId>` to power click-token→entry.
`source:'archivist'` facts (the future diary lane) are player-visible by definition once they exist.

**Goal:** the planner contract (`director-planner.md` + `ArcBrief`) gains a **`partyGoal`** field — one line
phrased as what the *party* currently intends (player-safe by authorship). The journal snapshots it per
chapter (the brief is overwritten in place on replan — snapshots are the only way past chapters keep "what we
were trying to do"). Show nothing rather than `activeBeatIntent`. Premise journals at session create (also
fixes the empty turn-0 prologue goal).

## Part 3 — The fail-closed projection + the security hardening it requires
**Dedicated routes** `GET /dm/lab/session/:id/player-view` + `POST .../player-turn` (a forgotten `?role=`
param fails *open*; a route fails *closed*). New `apps/server/src/player-view.ts`: `playerArcView` (premise,
partyGoal, visited chapters, decisions — nothing else), `playerSceneMap` (drop `visible:false`; **drop
non-PC actors indoors in unrevealed buildings** — reuse `revealedBuildingIds`/`whereIs` from dm-view, which
already codifies "a name over a closed lid leaks"; strip `rx:*` state + `Entrance.toLocationId`),
`projectDeltas` (**visibility-resolving, not op-shaped**: drop ANY op — move/face/setState/hide/spawn — whose
object is hidden post-turn; `reveal`→`spawn` carrying the player-safe row; the rev-gap full-refetch self-heals
drift; this closes the hidden-stalker move-delta leak the red-team confirmed via the reach/updateScene lanes),
`playerTurn` (narration, rollRequest, projected deltas, beat, mentions — no tools/diff/provenance/cost),
`playerCharacters` (= characterSheets + one shared `maskItem()` for `identified===false` — used by the sheet
AND finding/loot texts — + additive `downed/deathSaves`; fixes the existing unidentified-item leak),
`playerJournal`. `/rev` gains `journalLen` (chronicler/goal writes don't bump rev).

**The projection is decorative until the side doors close** (red-team, confirmed): the auth hook *exempts*
`/dm/lab*` from `MYTHWEAVER_API_TOKEN`, `/dm/lab/sessions` enumerates ids, and `/view`, `/turn`,
`/characters`, `/pregen/:slug` (full GeneratedArc incl. ending), `/files` (raw scenario), `/dev-sessions`+
clone-and-read, and play-API `GET /sessions/:id` (raw GameState blob) each hand over the campaign. **v1
ships:** a per-session `dmKey` minted at session create (returned only to the creating DM Lab page), required
on every DM-grade route; the blanket token exemption narrowed to {lab HTML, player routes, `/rev`,
`/scene.png`}; play-API `GET /sessions/:id` swapped to the player projection. Honest scope: sessionId+dmKey is
a *screen-content* boundary on a LAN, not real auth; per-seat identity is future work.

**Client:** `page.tsx` repoints to the player routes and deletes every `/view`/`/turn` reference (kill test
fetches `/player-view`). One `applyView()` used by both the submit and poll paths — the journal array is
always **replaced**, never appended (no dupes when the poll races a submit); the titleCard chapter-diff
baseline initializes on fresh join (no stale card on rejoin).

## Part 4 — The UI distribution (the Book)
Grammar: **one ambient layer + one Book drawer + one Sheet modal.** The map stays dominant; the right rail
(transcript + roll bar + input) is the table's spine and is never covered.

- **Ambient:** header gains one segment — `NOW — <partyGoal>` (click opens Journal; merged into the header,
  not a separate bar); **PartyDock** bottom-left (ring-color dot, name, HP sliver, condition icons,
  death-save pips; click → SheetModal) replacing the rail HP strip; chapter breadcrumb shows **visited**
  chapters only. No clocks on the player screen.
- **Book drawer:** a 44px bookmark spine on the left edge — 📖 Journal · 👥 People · 🎒 Findings · ⚔ Party —
  sliding a ~400px non-modal drawer over the canvas (play continues; explicit close only — one player reads
  while another acts; hides/shifts the PartyDock while open). Journal = premise + NOW + this-scene event rows
  (icon + one line + turn stamp; *the index of what mattered* — prose lives in the transcript) + past-scene
  accordions (title + outcome + goal-at-the-time + collapsed events). People = "Here now" / "Met before" →
  dossier (name/look → first-met/last-seen → perceived disposition → observed deeds). Findings =
  event-shaped POI lifecycle (spotted → searched → emptied; contents only once searched) — inventory state
  stays on the sheet (one owner per state). Party = compact rows → **SheetModal** (React port of the lab
  sheet's section structure: Core, Abilities, Skills, Attacks, Spellcasting, Resources, Inventory, Story).
- **Map → Book bridge:** ONE optional `onInspect(id)` prop on SceneCanvas (pointerup at the two existing
  `setInteractive` sites, playerView-gated) → PC token opens its sheet, NPC token opens its dossier. The only
  visual-track edit (sole-author unblock stands).
- **De-workbench the rail:** TurnDetails, DeltaChips, tool traces, state Δ, provenance, cost, engine badge —
  all removed from the player page (the :6984 DM Lab keeps the full workbench).
- **Poll ergonomics are P1/P2 acceptance criteria, not polish** (critique): near-bottom-only transcript
  autoscroll; stable list ordering (first-met) with an "updated" dot instead of resorting under the reader's
  finger; drawer tabs stay mounted (CSS toggle) so the 2s re-hydrate never remounts a scroll container;
  stable keys (seq/entity id).
- **v1 model is party-level knowledge, stated plainly:** the Book is the party's collective eyes; backstories
  are party-visible (real-table norm); the speaker select stays (shared-device idiom). "Secrets from each
  other" needs a per-seat primitive (device + token) that does not exist — deferred whole, not half-built
  (no `pcId` threading, no `backstorySecret` dead field; those land later WITH their never-serializes tests
  and a real writer).

**v1 cuts (explicit):** NEW badges (localStorage "seen" is per-screen, not per-player — semantically confused
on a shared table), chronicler (below), clue lane, dossier quotes, trend arrows, portraits, book→map pings,
journal search, per-seat anything, mobile bottom-sheet.

## Part 5 — The chronicler + the diary rails
**Chronicler (optional, LAST, skippable forever):** on beat close, one LLM call whose *input is exclusively
the already-projected player-safe journal + transcript slice* (it cannot leak what it never sees) → one
`chronicle` event of 2–4 sentences of prose above the chapter's bullets. Additive color, never truth; absent
key/flag ⇒ $0, byte-identical behavior.

**Diary rails, not the diary:** chapters keyed by `chapter-close` {beatId, outcome, goal, turnRange} are
exactly the roll-up unit the future archivist consumes; events are self-describing (kind+subjects+beatId+
turn). The archivist is a *reader*: it folds a closed chapter's events + `decision:*` flags into durable
`FactRow`s with `source:'archivist'` — the reserved lane v1 **never** writes. The dossier projection already
surfaces archivist facts, so past-campaign knowledge auto-appears in future sessions. **P-last dry-run:** a
script folds a finished session's journal into *proposed* archivist rows ($0, no LLM) — if that pass needs
data the events lack, fix the schema while it's cheap.

## Phasing (each slice falsifiable; secret-scan test runs on every one, permanently)
- **P0 — the product bet, half a day, $0:** scratch script over the dev-session freezes rendering the
  would-be Book from deterministic artifacts alone. GO: it reads like "what happened", with growing NPC
  entries. NO-GO: re-scope toward more verdict instrumentation or an earlier chronicler — decided *before*
  any UI exists.
- **P1 — leak-stopper + security:** `player-view.ts` + dedicated routes + dmKey gating + token-exemption
  narrowing + play-API projection + page repoint + de-workbench. **Secret-scan kill test:** fixture with
  planted markers (intendedEnding string, want/fear, plant, discoverDc, hidden lurker+stalker move, DC text,
  toLocationId) → zero hits across `/player-view` AND `/player-turn`; DM routes 401 without the key.
- **P2 — sheet modal + dock + drawer shell:** the near-port win (SheetModal from the existing characters
  payload + `maskItem` + deathSaves), PartyDock, BookDrawer mechanics (z-index over the canvas label layer,
  pointer isolation, Esc order, mounted-tab scroll).
- **P3 — journal substrate, engine-first (no UI):** JournalEvent + `Engine.journal()` + engine write points
  (advanceScene, discover/search/lootPoi, place) + goal snapshots + `partyGoal` in the planner contract +
  journal in `/player-view` + `journalLen` in `/rev`. Tests: Tessa appears at first mention with name/kind
  only; the pot's contents appear only after search; freeze→reload rebuilds the journal byte-identically.
- **P4 — growth events + the Book UI + click-to-inspect:** mentions→entity-met, disposition deltas at the
  four standing sites, deduped verdict events with the hidden-actor guard; Journal/People/Findings tabs;
  `onInspect`. **The accretion screenplay (the user's demo):** ① DM introduces an NPC → card appears with
  only what was said; ② thank/insult her → the perceived-attitude line shifts; ③ "I search the pot" →
  Findings gains the entry; ④ click her token → her entry opens. Plus: a second passive browser shows the
  beat title card via the poll.
- **P5 (optional, unordered):** chronicler; clue-with-corroboration; narrated-only entity birth; book→map
  pings; per-seat seams; archivist dry-run script.

## Files (superset)
New: `packages/shared/src/journal.ts` · `apps/server/src/player-view.ts` · `apps/server/src/player-view.test.ts`
(the permanent secret-scan) · `apps/web/app/dm/components/*` (BookDrawer, JournalTab, PeopleTab, DossierView,
FindingsTab, PartyTab, SheetModal, PartyDock, EventRow, TranscriptRail) · later `apps/server/src/chronicler.ts`.
Touched: `packages/shared/src/domain.ts` (GameState.journal), `packages/engine/src/engine.ts` (journal() +
engine write points), `apps/server/src/orchestrator.ts` (mention/disposition/verdict/goal emits),
`apps/server/src/interactions.ts` (recordStanding helper), `apps/server/src/index.ts` (routes + dmKey + gates),
`apps/server/src/dm-lab.ts` (serializer additions), `apps/web/app/dm/page.tsx` (repoint + applyView + layout),
`apps/web/app/play/SceneCanvas.tsx` (onInspect only), `prompts/director-planner.md` (partyGoal),
`prompts/dm-playbook.md` (roll-reason hygiene).
