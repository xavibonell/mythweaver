# DM-Lab — Brief for the parallel DM-behaviour session

You are starting a **fresh session to refine the Dungeon Master's behaviour** ("dm-lab"), running
in parallel with another session that owns the visual layer ("scene-lab"). This document tells you
what the project is, what's already built, exactly what your track owns, and which files to read.

> Read this whole file first, then read the files in **§6 Files to read**. Don't start changing
> things until you've read the engine + orchestrator + playbook + eval harness.

---

## 1. What MythWeaver is

A **self-hosted, AI-driven Dungeon Master** web app for tabletop RPGs. v1 is **text-first, D&D 5e**,
with a Phaser visual layer bolted on. (This is a **local, domestic concept-proof** for private play;
it uses full 5e sourcebook content incl. the PHB — the old SRD-only lock is intentionally removed and
should not be re-flagged.) Repo: `/Users/xavierbonell/dev/mythweaver`
(TypeScript monorepo, npm workspaces; **not a git repo yet**). Canonical sources of truth — read
these, don't re-derive: `docs/MythWeaver-Dev-Spec.md` (full spec, "Decisions at a Glance", open
questions) and `docs/BUILD-PLAN.md` (tickets + exit criteria).

**Locked architecture (must hold):** a deterministic rules **engine is authoritative for ALL
mechanics — the LLM never invents a number**; RAG is for rules *text* only; the LLM sits behind a
swappable `LlmProvider` seam; **no fine-tuning**; "Mercer" is a *style preset*, not a voice clone;
TS full-stack (Next.js + Node + Postgres/pgvector). Adherence is loose only as early scaffold; total at GA.

## 2. How a turn works (the orchestrator loop)

`apps/server/src/orchestrator.ts` runs a tool-use loop against the DM model:
1. Build messages: stable **playbook** (cacheable system prompt) + a per-turn user block with
   `CURRENT STATE` (authoritative, from the engine), recent transcript, the player's input.
2. The model may call **tools**: `getState` (read state), `requestRoll` (ask the player to roll
   physical dice — the engine, not the LLM, decides success vs DC/AC), `lookupRule` (RAG citation),
   `setScene` (stand up the visual scene — *shared with scene-lab, see §4*).
3. Roll requests **suspend** the turn (`pendingTurn` in `GameState`) and resume when the player
   declares a total; the engine validates plausibility and computes success.
4. The model emits narration when done. Turn is atomic: nothing persists if it throws.

Providers: `MYTHWEAVER_DM_PROVIDER` (anthropic | gemini | openai) + optional `MYTHWEAVER_DM_MODEL`.
Budget meter + tracing (Langfuse-optional) wrap each turn. Ports: backend **6984**, web **6985**.

## 3. The DM playbook (your primary lever)

The persona/system prompt is **editable data**: `prompts/dm-playbook.md` (loaded by
`apps/server/src/prompts.ts`; falls back to `DEFAULT_DM_PLAYBOOK` in `orchestrator.ts`; overridable
via `MYTHWEAVER_PLAYBOOK_PATH` for A/B). Tuning the DM is mostly: edit the playbook, run the evals,
read traces. The playbook also instructs *when/how* to call the tools (incl. `setScene`).

## 4. ⚠ Boundary with the scene-lab session (avoid collisions)

The other session owns the **visual layer**: `packages/scene/*`, `assets/library.json`,
`apps/web/*`, `docs/SCENE-CONTRACTS.md`, `docs/VISUAL-LAYER-TODO.md`, `scripts/extract-assets.py`,
`scripts/slice-atlas.py`, and `apps/server/src/scene-lab.ts`. **Treat those as read-only.**

- **Shared files — coordinate before editing:** `apps/server/src/orchestrator.ts` and
  `apps/server/src/index.ts`. The `setScene` tool definition + `parseEstablish` live in the
  orchestrator. You MAY tune the DM's *prose instructions* about when to set a scene and what
  fiction to put in it (playbook), but **do not change the setScene schema, the EstablishScene
  shape, or the rendering** — that's scene-lab's contract. If you need a setScene change, leave a
  note rather than editing it.
- Everything else DM-side (engine, RAG, tools `getState`/`requestRoll`/`lookupRule`, narration,
  pacing, evals, playbook) is **yours**.

## 5. What your track should focus on

Make the DM **a great Dungeon Master**: narration quality + voice, **rules fidelity** (always
defer mechanics to the engine; request rolls instead of deciding outcomes), pacing within the
authored adventure, correct + economical tool use, scene/NPC continuity, and handling of edge
cases (impossible rolls, ambiguous intent, combat flow). Drive it with the **eval harness** and
trace inspection — add eval cases, then tune the playbook/loop against them.

- Eval harness: `apps/server/src/eval/{cases,rubric,runner}.ts` + `npm run eval` (`scripts/eval.mjs`).
  Each case runs the real brain; an LLM-judge scores the last turn's narration on rubric dimensions.
- Quick provider check: `npm run test:providers`. Unit tests: `npm test` (orchestrator.test.ts is the loop's spec).
- A natural "DM Lab" deliverable mirrors the Scene Lab: a way to drive turns and inspect the
  narration + tool calls + state diffs + cost/latency, so you can see *where the DM goes wrong*.

## 6. Files to read (in this order)

**Spec & plan:** `docs/MythWeaver-Dev-Spec.md` (esp. §4 engine, §4.3 dice/suspend, §6 DM playbook,
§7 state tiers, §10 evals) · `docs/BUILD-PLAN.md` · `docs/DM-LAYER-TODO.md` (the DM roadmap — what's
built, and the deferred **Technique B** style-exemplar RAG, spec'd in full) · this file.

**The brain:** `apps/server/src/orchestrator.ts` (turn loop, tools, `DEFAULT_DM_PLAYBOOK`) ·
`prompts/dm-playbook.md` · `apps/server/src/prompts.ts` · `apps/server/src/index.ts` (turn
endpoint, providers, budget) · `apps/server/src/orchestrator.test.ts`.

**Engine & knowledge (authoritative):** `packages/engine/src/*` (dice, checks, combat, state —
the rules owner) · `packages/shared/src/domain.ts` (GameState/Combatant/PendingTurn types) ·
`packages/rag/src/*` + `apps/server/src/corpus.ts` + `apps/server/src/retriever.ts` (rules RAG) ·
`packages/llm/src/*` (provider seam, FakeLlmProvider for tests).

**Evals & content:** `apps/server/src/eval/{cases,rubric,runner}.ts` · `scripts/eval.mjs` ·
`apps/server/src/{content,tracing,db}.ts` · `content/scenarios/the-sunken-bell/*` · `content/srd/*`.

**Visual layer — READ-ONLY context (so you understand `setScene`):** `docs/SCENE-CONTRACTS.md`,
`docs/VISUAL-LAYER-TODO.md`. Do not edit the visual layer.

---

## 7. PASTE THIS PROMPT into the new dm-lab session

```
We're building MythWeaver — a self-hosted, AI-driven D&D 5e (SRD) Dungeon Master (text-first, TS
monorepo at /Users/xavierbonell/dev/mythweaver). I'm running two parallel sessions: one owns the
visual/scene layer ("scene-lab"); YOU are the "dm-lab" session and own DUNGEON-MASTER BEHAVIOUR —
narration quality/voice, rules fidelity (the deterministic engine decides all mechanics; the DM
must request rolls, never invent outcomes), pacing, tool use, NPC/scene continuity, and evals.

Start by reading docs/DM-LAB-BRIEF.md in full, then read the files it lists in §6 (spec §4/§6/§10,
the orchestrator + playbook, the engine, the RAG path, the LLM seam, and the eval harness). Treat
the visual layer (packages/scene, assets/, apps/web, scripts/extract-assets.py, apps/server/src/
scene-lab.ts, docs/SCENE-CONTRACTS.md) as READ-ONLY — that's the other session. orchestrator.ts and
index.ts are shared: you may tune the DM playbook's prose about when/how to call setScene, but do
NOT change the setScene schema/EstablishScene/rendering.

Once you've read everything, give me: (1) a short map of how the DM currently behaves and where its
weak points likely are, and (2) a proposed plan to refine it (playbook changes, new eval cases, and
optionally a "DM Lab" harness to drive turns and inspect narration + tool calls + state diffs).
Don't change code until we agree on the plan.
```
