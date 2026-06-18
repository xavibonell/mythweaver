# MythWeaver — Build Plan (P0 / P1)

> Companion to [MythWeaver-Dev-Spec.md](MythWeaver-Dev-Spec.md). The spec is *what & why*; this is *do this, in this order*.
> Phases and exit criteria mirror spec §12. Phase numbers are the same. This plan details **P0** and **P1** (the
> "prove the DM brain + play loop" slice) and sketches P2+.

## Progress — Foundation pass (done)

Before resuming feature tickets, a foundation pass landed the iteration + safety machinery the
[audit](MythWeaver-Dev-Spec.md) flagged as missing:

- ✅ Real agentic tool-loop with physical-dice suspend/resume (the production version of P0-6).
- ✅ `FakeLlmProvider` + orchestrator tests + serialization round-trip + **CI** (P0-1/P1-2 testability base).
- ✅ Prompt caching + timeout/retry in the Anthropic adapter.
- ✅ Operational safety: input validation, localhost-default + optional token auth, budget meter (§4.4),
  per-turn tracing, atomic turn-failure handling.
- ✅ Prompt-as-data (editable `prompts/dm-playbook.md`); canonical transcript in the `messages` table.

- ✅ **P1-1 (this pass):** engine-authoritative **success** — a declared roll's pass/fail vs a DC
  (checks/saves) or a target's AC (attacks, hit/miss) is decided by the engine and fed back to the DM as
  `success: true/false`. The DM narrates the verdict; it cannot decide it. Damage, HP, initiative, and
  action economy remain **P2**. (Natural-20/1 crits need the raw d20, which a declared total hides — P2.)

- ✅ **P1-3 (this pass):** rules corpus (RAG). Game-agnostic PDF→corpus extractor (`scripts/extract-corpus.py`,
  PyMuPDF), an offline BM25+stemming retriever, and a `lookupRule` tool the DM calls (cited). A pgvector
  vector path (`scripts/ingest-corpus.mjs` + `DbRetriever`) is built and ready behind `MYTHWEAVER_RAG=pgvector`
  — needs an embeddings key for high-quality semantic retrieval. Corpus is personal-use + gitignored.

**Next up:** an embeddings key → high-quality semantic retrieval; P2 combat state (HP, damage, initiative,
action economy); P1-5 (LLM-judge eval harness).

## How to read a ticket

```
[ID]  Title                                   (depends on: …)
  Goal        – the outcome
  Deliverable – the concrete artifact(s) / files
  Done when   – objective, testable exit
```

A ticket is **Done** only when: code typechecks (`npm run build`), its tests pass (`npm test`), and the "Done when"
bullet is demonstrably true. Every mechanic added must declare its §4.2 ramp tier in a code comment.

---

## Milestone P0 — Playable skeleton

**Theme (spec §12):** a table can play a short scripted scene end-to-end in the text UI; the LLM-provider and
engine-tool **seams exist**. Only the dice primitive is engine-authoritative.

**P0 exit criteria (spec §12):**
1. A table can play through a short scripted scene end-to-end in the text UI.
2. LLM provider + engine-tool seams exist.

### Tickets

```
[P0-1]  Monorepo & toolchain                              (depends on: —)
  Goal        Workspaces, TS project references, Docker, env, CI skeleton.
  Deliverable package.json (workspaces), tsconfig.base.json, docker-compose.yml,
              .env.example, .gitignore, CI workflow running build+test.
  Done when   `npm install && npm run build && npm test` is green on a clean checkout.

[P0-2]  Shared contracts package  (@mythweaver/shared)    (depends on: P0-1)
  Goal        The domain types + the four seam interfaces every package imports.
  Deliverable domain.ts (Ability, Skill, Condition, DamageType, StatBlock, CharacterSheet,
              Combatant, CombatState, Scene, GameState), engine-contract.ts (EngineTools +
              roll types + NotImplemented), io.ts (IoChannel).
  Done when   Package builds and is importable as @mythweaver/shared by other packages.

[P0-3]  Dice + declared-roll plausibility  (@mythweaver/engine §4.3)  (depends on: P0-2)
  Goal        The ONLY engine-authoritative mechanic in P0: roll dice and validate a player's
              declared physical-dice result against the legal range.
  Deliverable dice.ts (parse "NdX±M", min/max derivation, RNG roll), submitRoll() returning
              in_range | out_of_range | ambiguous per §4.3; unit tests.
  Done when   Tests cover: in-range accept, below-min / above-max flag, unknown-modifier→ambiguous,
              advantage/disadvantage range. `npm test` green.

[P0-4]  Engine skeleton + GameState store  (@mythweaver/engine)  (depends on: P0-2, P0-3)
  Goal        A GameState object + an EngineTools implementation where P1+ methods throw
              NotImplemented('<phase>') but getState / dice work.
  Deliverable engine.ts (Engine implements EngineTools), state.ts (load/mutate/serialize
              GameState; every mutation logged with before/after + cause per §4.1/§13).
  Done when   Engine can load a scenario's GameState, roll dice, and serialize/round-trip it.

[P0-5]  LLM provider seam + router  (@mythweaver/llm §3)   (depends on: P0-2)
  Goal        Single brain boundary: LlmProvider.complete()/stream(); Opus/Sonnet routing policy;
              Anthropic adapter (real SDK call behind the interface).
  Deliverable provider.ts (interface + provider-neutral tool-call types), router.ts (default
              policy: Sonnet routine, Opus for set_piece/adjudication/dispute), anthropic-provider.ts.
  Done when   A smoke call returns a completion; NO other package imports @anthropic-ai/sdk directly.

[P0-6]  Orchestrator turn-loop (skeleton)  (apps/server)   (depends on: P0-4, P0-5)
  Goal        The loop: assemble context (playbook + state snapshot + recent transcript) → call LLM
              with engine tools exposed → execute tool calls against the engine → narrate → persist.
  Deliverable orchestrator.ts (one turn() function), tool-call dispatch to EngineTools,
              transcript persistence.
  Done when   A scripted scene runs: player text in → engine-grounded narration out, with at least
              one engine tool call (a dice request) in the loop.

[P0-7]  Session API + DB wiring  (apps/server)             (depends on: P0-4)
  Goal        Create/load/continue a session; persist GameState + transcript to Postgres.
  Deliverable Fastify routes (POST /sessions, POST /sessions/:id/turn, GET /sessions/:id),
              db.ts (pg pool), uses db/init schema.
  Done when   A session survives a server restart (save/resume, spec §7 v1 slice).

[P0-8]  Web chat UI (shared screen)  (apps/web)            (depends on: P0-7)
  Goal        Minimal single-screen chat: transcript, input box, a "declare your roll" affordance,
              an active-character selector (text-first speaker attribution, spec §8).
  Deliverable Next.js App Router page calling the session API; renders narration + roll prompts.
  Done when   A human can play the P0 scripted scene start-to-finish in the browser.

[P0-9]  Seed content loader + the v1 one-shot  (content/)  (depends on: P0-2)
  Goal        The SRD-safe one-shot as structured seed data conforming to @mythweaver/shared.
  Deliverable content/scenarios/<slug>/{scenario.json, pregens.json, bestiary.json, run-notes.md};
              a loader that validates seed data against the domain types on boot.
  Done when   The scenario loads into a GameState and is playable via P0-6/P0-8.
```

---

## Milestone P1 — Core checks + eval baseline

**Theme (spec §12):** ability checks, saves, attack rolls vs AC, and DC comparison become **engine-authoritative**;
the LLM-judge eval baseline is computed and pinned.

**P1 exit criteria (spec §12):**
3. Rules-correctness checks green for P1 mechanics.
4. Initial LLM-judge baseline computed and pinned (spec §10).

### Tickets

```
[P1-1]  Checks & saves engine  (@mythweaver/engine §4.2 P1)   (depends on: P0-4)
  Goal        Move ability checks, saving throws, attack-vs-AC, DC comparison from LLM to engine.
  Deliverable resolveCheck(), resolveSave(), resolveAttack() (hit/miss only; damage app is P2),
              proficiency/ability-mod math, advantage/disadvantage.
  Done when   Rules-correctness suite asserts exact outcomes for a matrix of checks/saves/attacks.

[P1-2]  Rules-correctness test suite  (eval/, spec §10.1)      (depends on: P1-1)
  Goal        Scripted scenarios asserting exact engine outcomes; enforces the §4.2 ramp
              (a P1-tier mechanic resolved by the LLM instead of the engine = failing test).
  Deliverable golden scenario fixtures + assertions; runs in CI; release-blocking.
  Done when   Suite is green and a deliberately-LLM-resolved check makes it red.

[P1-3]  RAG ingestion + retrieval for SRD rules text  (@mythweaver/rag §5)  (depends on: P0-7)
  Goal        Chunk + embed SRD content into pgvector; retrieve rules text for narration/lookup
              (NOT for resolving mechanics).
  Deliverable EmbeddingProvider (Voyage adapter), ingestion script, retriever (top-k + provenance),
              vector(1024) column wired (spec §5.2).
  Done when   A rules query returns the correct SRD chunk with attribution; recall@5 measured.

[P1-4]  DM playbook + few-shot style preset  (spec §6)         (depends on: P0-6)
  Goal        The editable "inspired-by" style: system prompt + few-shot exemplars + per-scene
              exemplar retrieval.
  Deliverable prompts/dm-playbook.md, exemplars/*.md, exemplar retrieval over an exemplar namespace.
  Done when   Narration visibly follows the preset; swapping the preset changes the voice.

[P1-5]  LLM-judge harness + pinned baseline  (eval/, spec §10.2)  (depends on: P1-2, P1-4)
  Goal        0–5 × 6-dimension narration rubric; baseline = mean over fixed eval set × 3 runs on
              default models; regression gate (≥ baseline − 0.4).
  Deliverable judge runner, rubric, baseline snapshot (version-pinned), CI regression check.
  Done when   Baseline recorded; a prompt change that drops a dimension >0.4 fails CI.

[P1-6]  Budget cap meter  (apps/server §4.4)                   (depends on: P0-5)
  Goal        Per-session USD meter from token usage; soft-warn 80% (notify+continue), hard-stop
              100% (finish current turn, then block).
  Deliverable usage accounting in the provider layer, session budget state, UI surfacing.
  Done when   With a low test cap: 80% warns without interrupting; 100% finishes the turn then blocks.
```

---

## P2+ (sketch — detailed in spec §12)

- **P2 Combat state + voice design:** HP/temp-HP, damage w/ resist/immunity, initiative, action economy,
  conditions become engine-authoritative. Voice I/O *designed* behind `IoChannel` (not built).
- **P3 Resources, tactics, map:** spell slots, charges, range/movement (grid vs zone = spec OQ #10).
- **GA:** 100% of mechanics engine-authoritative; human "would play again" gate + narration bars met.
- **P6 (post-GA):** homebrew uploads in an isolated namespace (spec §11).

---

## Conventions

- **Testing:** Vitest. Engine logic is unit-tested exhaustively (it is the correctness guarantee). LLM behavior is
  tested via the scenario/judge harness, not by asserting exact prose.
- **CI:** `npm run build` + `npm test` on every push; P1 adds rules-correctness + judge-regression gates.
- **Ramp discipline:** each mechanic carries a `// RAMP: Pn engine-authoritative` comment; the rules-correctness
  suite is the enforcement that nothing slides back to the LLM (spec §4.2).
- **Seams are sacred:** nothing outside `packages/llm` imports the Anthropic SDK; nothing outside `packages/rag`
  imports an embeddings SDK; UI/transport go through `IoChannel`. These keep "swap it later" a one-file change.

## First commands to run (this scaffold)

```bash
cp .env.example .env && $EDITOR .env   # set ANTHROPIC_API_KEY
npm install
npm run build
npm test                               # P0-3 dice/plausibility tests should pass
```
