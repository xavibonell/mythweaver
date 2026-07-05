# DM Layer — Roadmap to "a great Dungeon Master"

Working plan for the **DM-behaviour track** ("dm-lab"). Captures what's built and every phase we
concluded we need. Companion docs: `DM-LAB-BRIEF.md` (track charter), `MythWeaver-Dev-Spec.md`
(esp. §4 engine, §6 DM style, §10 evals), `VISUAL-LAYER-TODO.md` (the parallel scene track).

**Golden rule:** the deterministic engine owns every number; the LLM is narrator + tool-caller.
**Style is data, not weights — no fine-tuning** (spec §6). Voice is achieved with the playbook,
distilled style guides, and (later) retrieved exemplars — never by training a model.

**The test bench is the DM Lab (`/dm/lab`, served by the backend).** Every change below should be
driven there: enter a turn script → real DM → inspect narration + tool calls (inputs **and**
results) + state diffs + cost; tabs to live-edit the **Playbook** and **Scenario**, a **temperature**
knob, and a **Distill** tab. CLI mirror: `npm run dm:lab`. Regression gate: `npm run eval`.

---

## ★ Architecture review verdict (2026-07-05) — "right chassis, thin payload"

A 16-agent research review (tabletop craft theory · academic drama managers · commercial AI GMs ·
LLM narrative-consistency research; three adversarial critiques; three candidate architectures;
three judges) asked: **is the current layered stack the optimal path to a hand-crafted, organic,
turn-by-turn-coherent tabletop experience?** Verdict: **yes — do NOT change the skeleton.** The whole
field independently converged on our exact shape (engine owns every number; narrator DM re-grounded
each turn from external state; offers-only Director behind coercion-hardened seams; persona-as-data;
Fake fallbacks; lab trace). Commercial survivors (Hidden Door, Friends & Fables) ship the same
engine-authoritative split as their moat; the drift literature (~39% multi-turn degradation across
all frontier models, arXiv:2505.06120) proves consistency **must** live in deterministic scaffolding
outside the model — which we already have.

**The gap is the PAYLOAD, not the architecture.** Hand-crafted feel = three signals players detect
within a session, and the current content model structurally deletes all three:
- **Persistence** — NPC voices, gifted items, sworn promises, player-coined facts evaporate past the
  12-line transcript window (no legal home in state; `setArcFlag` admits only `decision|beat|npc`).
- **Pressure** — "clocks" are advisory prose that nothing ticks, so the world provably freezes when
  players idle.
- **Payoff** — `decision:` flags are written but **nothing ever consumes them**, so the ending
  (fixed before turn 1) cannot echo the table's own play.

### The program (each phase independently valuable; deterministic eval gates ride EVERY phase)

- **P0 — State-truth sprint (days).** Fix the blocks that already lie, before stacking new "never
  contradict" context beside them. `endCombat` lifecycle (`combat.active` is set in `startCombat` and
  **never cleared** — verified bug; post-fight turns assert phantom combat with dead foes "present"
  AND route every turn to the expensive `adjudication` model); despawn defeated foes; render the
  write-only `npc:*` flags into steering; replan on decision *value* flips (not just key-count);
  stamp beat outcome (`resolved`/`fled`); empty-exits ⇒ terminal; filter roll-traffic from the recent
  window; **roll-resume rebuilds fresh steering/state instead of replaying frozen history** (subtle —
  its own careful pass). Re-pin the stale eval baseline first.
- **P1 — Canon Ledger (1–2 wks, transformative).** `EntityCard {id, kind, aliases, voice{tic,want,
  fear}, status (absorbing states)}` + append-only `FactRow`s with a contradiction gate + `Plant`s
  (planted→echoed→fired). Deterministic keyword/alias CANON injection per turn (≤600 tok, $0). Sync
  DM tools `recordFact`/`upsertNpc`. Composer seeds cast (every NPC named in beat prose) + 2–4 plants.
  **No async archivist yet** — a wrong fact rendered as canon is gaslighting, worse than forgetting;
  it ships last, gated on a precision eval. This is also the §7 memory tier + the D3 (cross-session)
  substrate. *Exit: NPC introduced turn 3 returns turn 18 with the same voice; the silver key from
  turn 5 opens the door at turn 30.*
- **P2 — Fronts + engine-owned ticks (1 wk).** Composer emits 1–2 fronts {danger, impulse, portents,
  doom = north-star's failure shading}; the **engine** advances a `front:<id>:step` counter on
  deterministic triggers (advanceScene; turnsInScene ≥ K, suppressed when ledger facts show the party
  engaging the front's cast); portent prose renders as established WORLD truth. Delete advisory
  `ArcBrief.clocks[]`. Kills the frozen-world tell (the field's prescribed fix for a hint-only
  Director, measured near-zero-effect: Nelson & Mateas 2008).
- **P3 — Storylets + PC hooks + situation-beats (1–2 wks).** A pool of 10–16 flag-gated situation
  fragments (side scenes, NPC beats, foreshadowing, downtime, PC-hook scenes); engine-side eligibility
  as a pure fn over flags; planner salience-picks ≤2 as offers via the candidate-id filter (the
  `exitIds` pattern); payoffs applied deterministically on `storylet:<id>=played`. Party sheets gain
  `bondNpc`/`personalSecret`/`desiredItem`, cross-wired by the Composer/validator. Beats become
  situations: `cast` refs + `tension` + `ifIdle`; summaries reframed to stakes + terrain; playbook
  "narrate from actor goals, not from a beat summary." *The spared goblin returns because a storylet
  was gated on `decision:goblin=spared` — the cheapest "authored-for-us" move.*
- **P4 — Living endings + variety.** Replace the single `intendedEnding` with `{doom + 2–3 intercept
  endings}` keyed to how players engaged; the Planner may rewrite **UNVISITED** beats/exits only
  (never anything `done`, ledgered, or transcript-named); three-clue revelation validator (a
  gate-load-bearing fact needs ≥3 clues across ≥2 holders); Composer variety axes + motif palette +
  "leave-blanks" preference so the 2nd/3rd generated campaign doesn't share one skeleton.

**Cross-cutting:** deterministic eval gates ride each phase (re-pin the stale baseline *first*); a
single **prompt-budget arbiter** owns per-turn block order + caps (required ≤~70%, CANON ~600 tok,
≤3 NPC cards, total ≤ current +~900 input tokens). Whole program ≈ **+$0.01/turn**, zero locked
constraints touched.

**Deliberately REJECTED** (with reasons): full NPC agent-simulation (cost + drift for marginal gain —
the lesson is the ledger *shape*, not 25 simulated minds); MemGPT/Letta memory-OS (measured worse:
48% vs simple extract-validate-write 67% on LoCoMo); embeddings-first retrieval as v1 (keyword/alias
beats semantic for game facts — Franz's production finding); bigger context windows (story text always
outgrows any window — the AI Dungeon lesson); option-menu input (violates free agency); online
drama-manager search (15 yrs of negative results; keep only the offline eval function); fine-tuning
(locked); party-splitting (deferred non-goal); building D3 before the ledger exists.

Full report archived at
`tasks/w5o4xwpgb.output` (this session's scratch); see [[game-director-arc-design]] memory.

---

## ✅ Phase A — Foundation + the tuning loop (DONE)

- [x] **Orchestrator turn-loop** (`apps/server/src/orchestrator.ts`): cacheable playbook system prompt + per-turn state/adventure block; tools `getState` / `requestRoll` / `lookupRule` / `setScene`; physical-dice suspend/resume. Rules fidelity is **structural** — the engine decides success via `validateDeclaredRoll(dc)`; the DM cannot fabricate an outcome.
- [x] **Playbook overhaul** (`prompts/dm-playbook.md`, the canonical persona; `DEFAULT_DM_PLAYBOOK` is only the fallback): voice + DC-sourcing + one-roll-per-intent + multi-path/anti-railroad + edge cases + interim combat protocol + narrate-from-truth + voice exemplars.
- [x] **DM Lab** — web UI (`GET /dm/lab`, `apps/server/src/dm-lab-page.ts`) + core (`apps/server/src/dm-lab.ts`) + CLI (`scripts/dm-lab.mjs`). Per-turn trace (narration, tool calls + results, state diffs, cost/latency). Both load the EDITED playbook via `loadPlaybook()`.
- [x] **Live tuning** — tabs **Run / Playbook / Scenario** edit the real inputs in-browser; Run applies edits as overrides (even unsaved); Save persists (`POST /dm/lab/files`, `/dm/lab/save`). **Temperature** knob threaded `LlmRequest → all providers → OrchestratorDeps`.
- [x] **Eval harness** (`apps/server/src/eval/*`, `npm run eval`): 8 cases, 6-dim LLM-judge rubric **plus** deterministic tool-use assertions (spec §10 component 1) that block the gate; scene-composer parity; roll-resume + multi-turn cases; baseline in `eval/baseline.json`.
- [x] **Technique A — distillation** (the Distill tab, see below): real transcripts → a Markdown voice guide spliced into the playbook.

---

## ◑ Now — iterating Technique A (distillation into the playbook)

**What it is:** offline-style distillation. Paste/upload source text in the **Distill** tab →
`apps/server/src/distill.ts` (`distillStyle`, chunk + map-reduce) extracts a block → "Apply to
Playbook" splices it between markers (a temporary override) → test in Run → Save to persist.
Guardrails in the prompts: strip proper nouns; never capture mechanical outcomes (the engine stays
authoritative).

**Two source modes** (a `mode` toggle on the tab, `POST /dm/lab/distill` `{mode}`):
- **Transcript** → distils the DM's VOICE (cadence + anonymized exemplars) into a `## VOICE` block,
  markers `<!-- DISTILLED-STYLE:BEGIN/END -->`.
- **Guide** → distils a best-practices/advice doc into actionable `## PRINCIPLES` directives,
  markers `<!-- DISTILLED-PRINCIPLES:BEGIN/END -->` (so voice + principles coexist).

**Diff preview:** the output column has a **Block | Diff** toggle. Diff renders a git-style unified
diff of *current playbook → playbook after applying this block* (client-side LCS line diff with
collapsed unchanged context) so you can review exactly what changes before Apply/Save.

**Recommended transcript format:** speaker-labeled text/Markdown, DM lines prefixed `DM:`, one file
per session (or `[{ "speaker": "DM", "text": "…" }]` JSON). Labeling the DM is what makes the voice
extract cleanly.

**Iteration backlog for A (cheap, do as we go):**
- [ ] Distill a representative spread of real sessions; curate the resulting voice block by hand.
- [ ] A/B the distilled playbook vs the current one in the Lab; re-pin the eval baseline when happy.
- [ ] Tune `distill.ts` prompts if the voice guide drifts (too generic / leaks names / over-long).
- [ ] Optional: let the Distill tab target a specific move-type ("just the combat voice", "just NPC banter").

---

## ☐ Phase B — Technique B: per-turn style-exemplar RAG (PLANNED — not started)

> **This is the deferred step. Capture it fully so we can pick it up cold.** It is the spec §6
> design ("RAG retrieves the most relevant style exemplars per scene") that isn't built yet.

### What it is, and why it's separate from A
Distillation (A) bakes **one constant voice guide** into the playbook — a strong, cheap baseline.
Technique B is **dynamic few-shot**: at each turn, retrieve the 2–4 transcript passages most relevant
to *this exact moment* (a tender NPC beat vs an ominous reveal vs a combat call) and inject them so
the DM emulates the right register for the situation. A gives a constant voice; B gives **range and
situational specificity** A can't — at a per-turn token + latency cost. They compose: keep A as the
floor, add B for depth.

### Architecture (reuse the existing RAG seam; keep a SEPARATE namespace)
A **second corpus namespace** alongside the rules corpus. Reuse `packages/rag` (`chunk.ts`,
embedding providers, `InMemoryVectorRetriever`) and mirror `apps/server/src/corpus.ts`. The exemplar
namespace is **never** merged with the quotable rules corpus and is **never** returned by
`lookupRule` — exemplars are voice, not citable rules.

### Offline ingestion pipeline (a new `scripts/ingest-exemplars.mjs`)
1. **Parse** transcripts (recommended speaker-labeled format) → segment into individual DM turns/beats.
2. **Filter** to DM narration; drop player/table talk **and any passage that states a mechanical
   outcome** (a hit/miss/damage/whether a check passed) — same guardrail as distillation, so the
   engine stays authoritative. Reuse `distill.ts`'s classification approach.
3. **Tag** each passage (LLM pass) with a `moveType` (scene-set · npc-voice · ominous-reveal ·
   transition · banter · fail-forward · combat-beat) and light facets (tone; biome/scene-kind if
   inferable). These power optional filtered retrieval.
4. **Anonymize** — strip proper nouns (names, places, deities, campaign terms) → placeholders.
5. **Chunk** to coherent passages (≈1–4 sentences, a whole DM beat) carrying metadata.
6. **Embed** (existing `OpenAIEmbeddingProvider` / `VoyageEmbeddingProvider`) → write
   `content/exemplars/<set>.jsonl` + `<set>.vectors.jsonl` (mirrors the rules corpus on-disk shape).

   Exemplar record: `{ id, source (session label), moveType, tone, text, vector }`.

### Runtime retrieval + injection
7. **Build a query each turn** from the situation: `sceneSummary + playerInput` (the move the DM is
   about to make). Design choice to settle then: pure semantic retrieval, OR classify the needed
   `moveType` first and filter within it (hybrid). Recommend hybrid: embed `sceneSummary+playerInput`,
   optionally filter by predicted `moveType`.
8. **Retrieve top-k** (k = 2–4) from the exemplar namespace; optionally de-dup against exemplars used
   in the last few turns to avoid repetition.
9. **Inject into the PER-TURN user block** (NOT the cached system prompt — preserves prompt caching),
   under a guarded header: *"STYLE EXEMPLARS — emulate the cadence and diction, NEVER copy the
   content, names, or plot."* The playbook gets one directive pointing at them.

### Integration points (files)
- **New** `apps/server/src/exemplar-corpus.ts` — loader + `Retriever` for the exemplar namespace (mirror `corpus.ts`); env `MYTHWEAVER_EXEMPLARS=on|off` + a path/`MYTHWEAVER_EXEMPLARS_DIR`.
- **New** `scripts/ingest-exemplars.mjs` — the offline pipeline above (reuses `distill.ts` prompts + `packages/rag` chunk/embedding).
- **`orchestrator.ts` (SHARED — coordinate):** add `exemplarRetriever?` to `OrchestratorDeps`; in `runTurn`'s message branch, retrieve top-k and inject into the per-turn block. Additive + DM-side (mirrors how the `lookupRule` retriever is wired). **Does not touch `setScene`.**
- **`index.ts` / `dm-lab.ts` / `eval/runner.ts`:** build the exemplar retriever at boot and pass it into `runTurn` deps everywhere a turn is run.
- **`prompts/dm-playbook.md`:** add the "when STYLE EXEMPLARS are provided, match cadence; never reuse their names/places/plot" directive.
- **DM Lab:** surface the retrieved exemplars per turn in the trace (`DmLabTurn` + page) so we can see *which* exemplars fired, and add an **exemplars on/off** toggle for A/B.

### Guardrails (critical — same spirit as A)
- Anonymize at ingest **and** forbid copying in the injection header (belt + suspenders against
  cross-campaign leakage of names/plot).
- Filter out mechanical-outcome passages at ingest so exemplars never teach the DM to decide a result.
- Keep the exemplar namespace fully separate from the quotable rules corpus; never cite an exemplar
  as a rule; never let `lookupRule` see it.
- Token/caching: exemplars live in the volatile per-turn block only; keep k small + snippets short;
  watch the added cost/latency in the Lab trace.

### Evaluation
- A/B in the eval harness (`exemplars on` vs `off`) on the `style` dimension; **gate that
  `rulesFidelity` and `coherence` don't regress**. Re-pin the baseline after.
- Optional **voice-match judge**: given target-DM exemplars + the produced narration, score how well
  the voice matches the source DM.
- **Leakage check:** assert retrieved-exemplar proper nouns don't appear in the narration.

### Tickets (checklist for when we pick this up)
- [ ] **B1** — `scripts/ingest-exemplars.mjs`: parse → filter → tag → anonymize → chunk → embed → write `content/exemplars/*.{jsonl,vectors.jsonl}`.
- [ ] **B2** — `exemplar-corpus.ts` loader + retriever; `MYTHWEAVER_EXEMPLARS` env + dir.
- [ ] **B3** — orchestrator injection (`OrchestratorDeps.exemplarRetriever`; retrieve from `sceneSummary+playerInput`; inject under the guarded header). Wire in `index.ts`, `dm-lab.ts`, `eval/runner.ts`.
- [ ] **B4** — playbook directive + DM Lab trace shows retrieved exemplars + on/off toggle.
- [ ] **B5** — eval A/B (exemplars on/off) + leakage check; re-pin baseline.

### Dependencies / notes
Needs an embeddings key (OpenAI/Voyage — already configured for the rules RAG). Reuses the
**recommended transcript format** and the **distillation classification** from Technique A — so A is
literally the on-ramp to B (same parse + filter + anonymize + tag steps feed both).

---

## ☐ Phase D — Showrunner / Campaign-Arc layer (PLANNED — not started)

> The higher-order "DM holds an arc" intelligence: steer the story toward points of interest
> **without railroading**, stay aware of the whole picture, and weave in what actually happened
> (party chose A not B → reassess C; reorder beats; introduce a bridge NPC). Design decided via a
> 4-lens architecture panel + adversarial critique (unanimous **hybrid**). Capture in full so we can
> pick it up cold.

### The decision
**A SEPARATE "Showrunner" component, hybrid with the turn DM — NOT baked into the turn LLM call, and
NOT a third model that runs every turn.** It runs **occasionally** (event-triggered, between scenes),
keeps a small arc-state, and emits **one compact "steering" line** the turn DM merely *reads*. The
turn DM stays the only thing that narrates to the table; the engine stays authoritative.

This is the existing **Scene Director pattern lifted one altitude up**: Director plans semantically →
deterministic normalizer freezes → turn DM consumes. The Showrunner is "Director for the campaign."

### Why (not the alternatives)
- **Not bake-in:** a real DM improvises *in* the turn and re-plans *between* scenes — fusing the two
  cadences into every turn call produces stilted, on-rails ("quantum ogre") narration; it also
  collapses testability (every arc experiment would thrash the 6-dim narration baseline) and re-opens
  the door to the LLM reasoning its way into state mutation.
- **Not a per-turn third brain:** cost/latency/coupling on every turn, and it re-introduces railroad
  risk. Unnecessary — the Showrunner rides the existing `LlmProvider` seam + task-class routing (run
  *that* occasional turn on Opus) and fires on ~1-in-3-to-6 turns.
- **Hybrid is what survives bake-in:** the turn DM keeps the *in-moment reflex* (voice, telegraphing
  this scene, reincorporation, anti-railroad phrasing — already in `prompts/dm-playbook.md`). The only
  thing "baked in" is a one-paragraph playbook edit: *treat the steering line as an offer, never a script.*

### Architecture
- **Component:** an `ArcPlanner` interface mirroring `SceneComposer` (`packages/scene/src/composer.ts`):
  `FakeArcPlanner` (deterministic — lab/eval) + `LlmArcPlanner` (narrative), both run through a
  `buildArcComposition()` normalizer that guarantees a valid result from untrusted model JSON (exactly
  as `buildComposition()` does for scenes).
- **When it runs — event-triggered + INLINE for v1 (not async):** there is **no job queue/scheduler**
  in the codebase, and the DB does a **whole-blob `UPDATE sessions SET state=$2`** (`packages/shared/src/db.ts`)
  with no version column — so a fire-and-forget `replan()` would race and silently clobber committed
  flags, and escape turn atomicity. v1 therefore runs the planner **synchronously, conditionally**
  (gated on `sceneChanged`, a beat-prereq flip, a recorded branch decision, or an every-N-turn floor),
  against the same engine instance, committed in the **same atomic save**, before `saveState`. One
  writer, one save. Route that turn heavy and own the latency in the DM Lab trace. **True async is
  deferred** until persistence gets a `version` column + compare-and-swap + a targeted arc-subtree write.
- **Arc-state (where it lives):**
  - **Canonical story-state in `GameState.flags`** (the §7 canonical tier), namespaced:
    `beat:<id>=active|done`, `npc:<id>:trust=N`, `decision:<branch>=<choice>`. Single source of truth.
  - **Non-canonical guidance** (conditional next-beat candidates, telegraph cues, bridge-NPC offers) on
    a **new optional `GameState.arc` field (engine-owned), NOT on `AdventureContext`** (which is immutable
    authored data). Adding `arc` is a real schema change with a back-compat default (empty = flat play,
    so `the-sunken-bell` runs unmodified).
  - **Derived, not dual-canon:** clocks/fronts/trust are **computed from flags + log each pass** (pure
    `flags → ArcState`), never stored as a second copy — "reconcile" becomes automatic.
- **State-write boundary (the hardest new piece):** `engine.record()` only *appends to the log* — it
  mutates nothing. So a **new validated engine tool** (`setBeatStatus(beatId,status)` / `setArcFlag(key,value)`)
  is required: it validates against the loaded arc namespace (reject unknown keys), mutates `flags`,
  mirrors to the audit log, and is dispatched in the tool loop alongside `setScene`. This is the first
  LLM-driven **non-mechanical** state write — design it explicitly, don't hand-wave it.
- **What it emits:** one hard-capped (~120 token, **code-enforced truncation**) `STEERING` sub-block,
  appended as a 4th section of `gmBlock` in `orchestrator.ts`, riding in the per-turn **user message**
  (cache-safe — the system/playbook prefix is untouched). Names the active beat's intent + 1–2
  reachable next beats as pressure/opportunity. `dm-lab.ts` renders it for free.

### How it preserves the locked constraints
- **Engine-authoritative:** arc-state mutates *only* through the validated engine tool → audit log; the
  planner proposes, the engine commits; mechanics resolution is never touched.
- **No-railroad / agency — structural, not vibes:** the brief grammar can express only
  `{clocks, telegraph_candidates, available_bridge_npcs}` — **no "do X now" field**; the normalizer
  strips/rejects imperatives; a deterministic gate fails the build if a directive pushes toward an
  abandoned path.
- **No fine-tuning:** arc guidance is frozen-state string assembly + prompt text (+ later exemplar
  retrieval). Style stays data.
- **Caching / latency / budget:** steering rides the user message (prefix cache preserved); latency paid
  only on gated turns, visibly; **planner spend must be added to `state.spentUsd`** + a planner-tagged
  trace field, or it silently defeats the §4.4 budget hard-stop. (The cap is per-session; a cross-session
  planner will later need a per-campaign budget line.)

### Overlap with the turn-DM work (Technique A / current iteration)
**Minimal and deliberate — turn-DM work is a prerequisite, not a competitor.**
- **Shared:** one narrow seam — the `gmBlock` injection point + the lab/eval plumbing (the DM Lab
  already renders flag diffs, so beats-as-flags show up with zero new trace code).
- **Independent:** the planner, its prompt/output contract, its `FakeArcPlanner`, and its **own**
  `arc-baseline.json`. Tuning the arc never touches the turn DM's cached prefix or its 6-dim baseline.
- **Prerequisites:** the turn DM must reliably honor soft guidance *without over-complying* (that's the
  current anti-railroad/agency work) before steering is worth emitting; and the **§7 episodic memory
  tier is unbuilt**, so cross-session "weave in what happened across sessions" can't be evaluated yet →
  **v1 arc is intra-session steering only** (honest scope).

### Phased plan (sub-stages of Phase D)
- **D0 — Finish the turn DM (current work).** Stabilize narration/agency/voice; pin the 6-dim baseline. Prerequisite, not a detour.
- **D1 — Thin steering, NO LLM planner.** Add the optional `GameState.arc` field + the validated
  `setBeatStatus`/`setArcFlag` engine tool. Assemble the `STEERING` line from **hand-authored** static
  fronts/beats in `scenario.json`, advanced by flag-triggered rules. Code-enforced token cap +
  one-paragraph playbook edit ("treat STEERING as an offer"). Put a `prereqs` field on beats now so
  "chose A not B → reassess C" is at least *expressible*. **~80% of the value at zero per-turn LLM cost,
  no drift, no async, no eval blocker** — and it validates the brief's content shape before building anything expensive.
- **D2 — The LLM Showrunner (gated: only if a flat static list proves insufficient).** `ArcPlanner` +
  `FakeArcPlanner` + `LlmArcPlanner` + `buildArcComposition` normalizer (conditional beat DAG, NPC
  schedule, bridge-NPC offers). Runs inline + conditionally, inside the atomic save, cost-accounted.
  Build the async mechanism (version column + CAS + subtree write) *before* going truly async.
- **D3 — Cross-session arc (gated on the §7 episodic memory tier existing).** Continuity, NPC consistency,
  cliffhanger→payoff across sessions. Building a cross-session brain before its cross-session memory is inverted sequencing.

### Eval (mirror the scene gate-then-judge split)
- **Deterministic hard gates (`checkArcInvariants`, no judge):** acyclic beat DAG (topological sort);
  every beat's flag prereqs satisfiable; scheduled NPC reachable by its beat; clocks monotonic;
  **continuity proof** — every flag the brief references actually exists in the `GameState` log;
  **anti-railroad** — denylist imperatives toward abandoned paths.
- **The money test is deterministic:** use the existing multi-turn `turns: EvalTurn[]` support to script
  an A-vs-B branch and assert `activeBeatId` / the STEERING line **diverges** between paths —
  confabulation-proof reactivity (unlike a fuzzy "momentum" axis).
- **Fuzzy arc judge (separate `arc-baseline.json`):** plot-coherence, escalation-trajectory,
  npc-consistency, arc-agency — fed the full multi-turn transcript; a continuity claim the log can't
  prove is marked failed regardless of score. Extend `JudgeInput`/`buildJudgePrompt` to include
  beat-state + north-star (a single-turn judge is blind to beats). Use `FakeArcPlanner` in the
  deterministic suite; raise arc-dim `runs` (~5) so the −0.4 gate doesn't flap on noisy multi-turn dims.

### Top risks → mitigations
1. **Dual source of truth / drift** → derive ArcState from flags+log each pass; persist only non-canonical guidance; single engine writer.
2. **Blob-clobber race (real data loss, not staleness)** → v1 inline + single atomic save; defer async until version-column CAS exists.
3. **Lossy-projection soft railroad** → no imperative field in the schema + normalizer strips imperatives + deterministic anti-railroad gate + arc-agency dimension.
4. **Un-evaluable cross-session value** → scope v1 to intra-session; gate D3 on the §7 tier.
5. **Over-engineering before need** → ship D1 with NO planner; clone the Fake/Llm/normalizer triad only after a flat list demonstrably fails.
6. **Budget escape** → account planner cost in `spentUsd`; surface "last arc refresh: N turns ago" + repeated-fallback warnings in the DM Lab so a stalled planner is observable.

### Tickets (checklist for when we pick this up)
- [ ] **D1a** — `GameState.arc` field (optional, back-compat default) + `beat`/`npc`/`decision` flag namespaces + `prereqs` on beats.
- [ ] **D1b** — validated engine tool `setBeatStatus`/`setArcFlag` (mutate flags + mirror to log; reject unknown keys); dispatch in the tool loop.
- [ ] **D1c** — static STEERING assembler (flag-triggered) + code-enforced token cap + `gmBlock` 4th section + playbook "offer not script" edit + DM Lab surfaces it.
- [ ] **D1d** — `checkArcInvariants` deterministic gate + an A-vs-B branch eval case asserting divergence.
- [ ] **D2** — `ArcPlanner`/`FakeArcPlanner`/`LlmArcPlanner` + `buildArcComposition` normalizer; conditional inline run inside the atomic save; cost-accounting; separate `arc-baseline.json` + fuzzy arc judge.
- [ ] **D3** — cross-session continuity (after §7 episodic memory tier lands).

### Dependencies / notes
Reuses the `SceneComposer`/Director precedent (`packages/scene/src/composer.ts`), the §7 canonical
memory tier (`GameState.flags`), the model-routing seam, and the DM Lab + eval harness. **D3 is blocked
on the §7 episodic vector tier** (unbuilt). Key files: `orchestrator.ts` (gmBlock, tool dispatch,
system prefix), `index.ts` (turn handler/atomicity, budget gate), `packages/shared/src/domain.ts`
(`GameState`, `AdventureContext`), `packages/engine/src/engine.ts` (`record`, the NotImplemented ramp),
`packages/shared/src/db.ts` (whole-blob save — the race source), `apps/server/src/eval/*` +
`apps/server/src/scene-eval/*` (the gate-then-judge split to mirror).

---

## ☐ Other DM backlog (captured so we don't forget)

- [x] **Combat engine (spec §4.2 P2) — DONE + wired.** Engine-authoritative HP/damage (resist/immunity/vuln, temp HP), monster spawning, initiative, conditions, PC death saves + healing (`packages/engine`). Wired into the DM as tools `startEncounter`/`applyDamage`/`heal`/`rollDeathSave` and tunable in the DM Lab (Start-scene picker + combat-visible trace + `combat` transcript). Verified live (goblin 7→0, downed). Temperature is best-effort (provider drops it for models that reject it).
  - **Known limitation — scene advancement:** `state.currentSceneId` doesn't change during play (no scene-advance tool; `setScene` only sets the *visual* location). `startEncounter` falls back to the only authored encounter so the one-shot works, and the Lab's scene picker reaches any scene — but a multi-encounter scenario will need a scene-advance mechanism. Defer until a scenario needs it.
- [ ] **DM Lab niceties** — a **model picker** (A/B Opus vs Sonnet on the same prompts), a **compare-two-runs** view (run A vs B side by side), and (with Phase B) show retrieved exemplars in the trace.
- [ ] **Baseline hygiene** — re-pin `eval/baseline.json` after each meaningful playbook/voice change; it's the regression reference and is only meaningful if kept current.
