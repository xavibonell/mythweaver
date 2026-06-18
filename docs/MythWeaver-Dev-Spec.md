# MythWeaver — Developer Specification

> **Status:** Implementation-ready draft for v1. This document is the single source of truth for the MythWeaver build. Where it conflicts with the original "blueprint," this document wins. Where it conflicts with the **Locked Project Decisions**, the Locked Decisions win and this document must be corrected.
>
> **Last verification of model IDs / pricing:** 14 June 2026 (see §12 and the Sources line under §3).

---

## Table of Contents

1. [Product Overview & Goals](#1-product-overview--goals)
2. [Guiding Principles](#2-guiding-principles)
3. [Compute, Models & the Provider-Abstraction Boundary](#3-compute-models--the-provider-abstraction-boundary)
4. [Correctness Strategy: Rules Engine + RAG](#4-correctness-strategy-rules-engine--rag)
   - 4.1 [The Deterministic Rules Engine (authoritative state)](#41-the-deterministic-rules-engine-authoritative-state)
   - 4.2 [The "loose-now → total-at-GA" rules ramp](#42-the-loose-now--total-at-ga-rules-ramp)
   - 4.3 [Dice-trust validation](#43-dice-trust-validation)
   - 4.4 [Per-Session Budget Cap](#44-per-session-budget-cap)
5. [Knowledge Base & RAG](#5-knowledge-base--rag)
   - 5.1 [Corpus & ingestion](#51-corpus--ingestion)
   - 5.2 [Embeddings & the pgvector dimension invariant](#52-embeddings--the-pgvector-dimension-invariant)
   - 5.3 [Retrieval, rerank & the acceptance bar](#53-retrieval-rerank--the-acceptance-bar)
6. [DM Style & Persona ("inspired-by", not a clone)](#6-dm-style--persona-inspired-by-not-a-clone)
7. [Memory Layer](#7-memory-layer)
8. [Interaction & Topology](#8-interaction--topology)
9. [Architecture & Stack](#9-architecture--stack)
10. [Eval & Playtest Harness](#10-eval--playtest-harness)
11. [Legal & Licensing](#11-legal--licensing)
12. [Roadmap & Phase Exit Criteria](#12-roadmap--phase-exit-criteria)
13. [Safety, Privacy & Auditability](#13-safety-privacy--auditability)
14. [Open Questions & Deferred Decisions](#14-open-questions--deferred-decisions)

---

## 1. Product Overview & Goals

**MythWeaver** is a self-hosted, AI-driven Dungeon Master (DM) web application that runs tabletop RPG sessions autonomously. It strictly adheres to the ruleset while delivering rich narration in a configurable DM "style" **inspired by** Matthew Mercer's pacing, descriptive flair, and fair-but-firm rulings. It is explicitly **not** a named likeness or voice clone of any real person; the persona is a configurable, tunable **style preset** (see §6).

The product targets a **single table of players in one room** — a shared screen today, a shared microphone later. There is no multi-device networking or per-player sync in v1, though the architecture must not preclude adding companion devices later.

**Target system:** Dungeons & Dragons 5th Edition. This is a **local, domestic concept-proof** for private at-home play, so it uses **full 5e sourcebook content (including the Player's Handbook)** locally to validate output quality. Nothing here is shipped, published, or redistributed. The earlier "SRD-only" ingestion lock has been intentionally removed for this build (the operator is aware of the licensing implications of local-only use). If this ever moves toward public distribution, revisit the corpus to SRD 5.1 (CC-BY 4.0) first.

**v1 in one sentence:** a text-first web chat where a small group plays a short, pre-authored level-1 adventure, with a deterministic engine owning every number and the LLM acting as narrator and tool-caller.

---

## 2. Guiding Principles

| Principle | What it means in practice |
|---|---|
| **Rules adherence is non-negotiable at GA.** | The shipped product must **never** bend a rule or let the DM hallucinate a rule/mechanic. Looser LLM reasoning is permitted **only** as a temporary iteration scaffold in the earliest phases. The committed end-state is the deterministic engine owning **100% of mechanics**, with the LLM as a pure narrator/tool-caller that cannot produce an unsanctioned number or ruling. See the explicit ramp in §4.2 and §12. |
| **Engine is the source of truth for numbers.** | HP, conditions, initiative, resources/slots, dice resolution, DC checks, attack rolls, damage, action economy, and ranges live in deterministic code. The LLM calls the engine as **tools** and is never the source of truth for a number that matters. |
| **RAG for text, never for math.** | Rules *text* and lore are retrieved at runtime — quotable, updatable, attributable. RAG informs *narration and rules lookup*, but the engine — not retrieved text — resolves outcomes. |
| **Style is data, not weights.** | DM tone is achieved with a system prompt + few-shot exemplars + a written "DM playbook," all fully editable. No fine-tuning in v1. Example-driven style transfer does **not** imply fine-tuning (see §6). |
| **Swappable everything.** | The reasoning model, embedding provider, and (later) voice provider all sit behind interfaces so they can be replaced without rewriting callers. |
| **Faithful to source, never inventive.** | When the engine or KB lacks an answer, the system surfaces "not in the loaded rules" rather than inventing rules text or fabricating mechanics. |
| **Quality is gated, not vibed.** | Model/prompt swaps are only safe because an eval + playtest harness exists from the start (see §10). |
| **Auditability.** | Safety-relevant decisions (refusals, content-filter trips, budget stops) are logged for review; this also feeds the eval harness (see §13). |

*Sources: [Anthropic pricing (canonical)](https://platform.claude.com/docs/en/about-claude/pricing), [Anthropic models overview (canonical)](https://platform.claude.com/docs/en/about-claude/models/overview), [Anthropic API data & retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention), [Is my data used for training?](https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training), [SRD 5.1 CC-BY legal text (WotC PDF)](https://media.wizards.com/2023/downloads/dnd/SRD_CC_v5.1.pdf), [SRD v5.2.1 (D&D Beyond)](https://www.dndbeyond.com/srd), [CC-BY-4.0 license](https://creativecommons.org/licenses/by/4.0/legalcode), [voyage-3-large announcement](https://blog.voyageai.com/2025/01/07/voyage-3-large/), [OpenAI embedding models](https://openai.com/index/new-embedding-models-and-api-updates/). Model IDs and pricing were re-verified via the canonical Anthropic pages on 14 June 2026; secondary blog summaries (e.g. finout.io) are not authoritative and must not be the cited basis for any quoted figure.*

---

## 3. Compute, Models & the Provider-Abstraction Boundary

MythWeaver uses **cloud AI APIs** with **Anthropic Claude as the primary reasoning model**, accessed **behind a provider-abstraction interface** so the model is swappable and a local/open-source model could be substituted later without rewriting callers.

**The LLM provider interface (the brain boundary).** All reasoning calls go through a single internal interface — conceptually `LlmProvider.complete(request) → response` plus a streaming variant — that the rest of the codebase depends on. No game-engine, narration, or RAG code constructs an Anthropic request directly. This is the boundary that makes "swap the model" or "drop in a local model later" a one-file change. Tool-calling (the engine-as-tools contract in §4.1) is expressed in provider-neutral terms and adapted inside the provider implementation.

**No fine-tuning in v1.** Fine-tuning is at most a distant optimization for narrative-voice consistency; it must never be the source of rules/facts.

**Model routing policy.** Two models are used, selected per call by a routing function that lives inside the provider layer:

| Use class | Model | Model ID | Rationale |
|---|---|---|---|
| Hard reasoning / adjudication / set-piece narration | Claude Opus 4.8 | `claude-opus-4-8` | Highest quality where it matters most (combat adjudication framing, climactic scenes). $5 / $25 per 1M input/output tokens. |
| Cheaper high-frequency turns (routine narration, NPC chatter, simple lookups) | Claude Sonnet 4.6 | `claude-sonnet-4-6` | Lower cost for the long tail of turns. $3 / $15 per 1M input/output tokens. |

The **Opus-vs-Sonnet routing thresholds** (which turn classes go to which model, and any escalation rule, e.g. "escalate to Opus when a combat round contains ≥1 contested adjudication or the scene is flagged a set-piece") are a tunable policy table owned by the routing function. The default policy: Sonnet for routine narration and lookups; Opus for combat adjudication framing, rules-disputed turns, and scenes explicitly tagged `set_piece` in the scenario data. This policy is covered by the eval harness (§10) so a routing change is measured before it ships.

> **Standing constraint:** Re-verify current model IDs and pricing via web search against the **canonical Anthropic pages** (pricing: `platform.claude.com/docs/en/about-claude/pricing`; models: `.../models/overview`) before quoting any number in a downstream plan or before a model swap. Do not rely on third-party pricing blogs as the source of a quoted figure. Verified 14 June 2026: `claude-opus-4-8` = $5/$25; `claude-sonnet-4-6` = $3/$15 (per 1M input/output tokens).

---

## 4. Correctness Strategy: Rules Engine + RAG

The correctness strategy has two halves that must not be confused:

1. **A deterministic game engine written in code** is the **authoritative source of truth for all numbers and state** (§4.1).
2. **RAG** supplies rules *text* and lore for narration and lookup (§5) — it never resolves a mechanic.

### 4.1 The Deterministic Rules Engine (authoritative state)

The engine owns, in code, every quantity that affects play:

- **State:** HP, temporary HP, conditions, exhaustion, initiative order, position/range (abstract in v1; see §14 OQ #10), resource pools (spell slots, class features, item charges), and the action economy (action / bonus action / reaction / movement) per creature per round.
- **Resolution:** dice resolution, ability checks against DCs, saving throws, attack rolls vs. AC, damage application (including resistances/immunities the engine knows about), and condition application/expiry.

The LLM **calls the engine as tools** and consumes the engine's results to narrate. The LLM must **never** be the source of truth for a number that matters. Concretely:

- The LLM does not decide whether an attack hits — it calls `resolve_attack(...)` and narrates the returned result.
- The LLM does not decide how much HP remains — it reads engine state.
- The LLM does not invent a DC — it requests the engine's DC for the check, or asks the player for a roll and submits it for validation (§4.3).

Engine tools are versioned and schema-validated. Every engine mutation is logged (creature, field, before/after, cause) to support the eval harness (§10) and audit (§13).

### 4.2 The "loose-now → total-at-GA" rules ramp

Rules adherence is **non-negotiable at GA**, but the engine is built incrementally. Each combat/mechanic phase must **explicitly state which mechanics move from LLM-reasoned to engine-authoritative.** The ramp:

| Phase | Mechanics the LLM may still reason about (scaffold) | Mechanics that have become engine-authoritative |
|---|---|---|
| **P0 (skeleton)** | Everything mechanical may be LLM-narrated as a temporary scaffold to get a playable loop. | Dice *rolling* primitive only (RNG + declared-roll intake). |
| **P1 (core checks)** | Combat damage math, conditions, action economy. | Ability checks, saving throws, attack rolls vs. AC, DC comparison. |
| **P2 (combat state)** | Multi-round resource bookkeeping edge cases, rare condition interactions. | HP/temp-HP, damage application with resistance/immunity, initiative order, the full action economy, condition application/expiry. |
| **P3 (resources & tactics)** | Only genuinely ambiguous/edge rulings (flagged for review). | Spell slots & class-feature charges, item charges, range/movement (per the §14 OQ #10 map-scope decision). |
| **GA** | **None.** The LLM is a pure narrator/tool-caller. | **100% of mechanics.** The LLM cannot emit an unsanctioned number or ruling; any number in narration must trace to an engine result. |

A regression in this ramp (a mechanic sliding back from engine-authoritative to LLM-reasoned) is a release blocker, enforced by the rules-correctness checks in §10.

### 4.3 Dice-trust validation

Physical dice are kept. The flow:

1. The system (engine) determines a roll is needed and **asks the player** for it (e.g., "Roll a d20 + your Athletics modifier").
2. The **player declares the result**.
3. The system **trusts it as truth** and **validates plausibility** before committing it to engine state.

**Plausibility contract (deterministic):** for a declared roll, the engine computes the legal range from the die expression plus known modifiers it can derive (e.g., `1d20 + proficiency + ability mod`). A declared value is:

- **In-range** → accepted silently and applied.
- **Out-of-range** (below the minimum or above the maximum possible) → **flagged**. The engine does not silently apply it. The DM surfaces a gentle correction ("That's above the max for a d20 + 5 — want to re-read the die?") and re-requests. The flagged event is logged (§13).
- **Ambiguous** (the engine cannot derive every modifier the player applied) → accepted but recorded as `unvalidated_modifier` so the player's stated total stands while remaining auditable.

The engine never fabricates a roll to "correct" the player; trust-with-validation means it accepts plausible declarations and only intervenes on the impossible.

### 4.4 Per-Session Budget Cap

An **operator-settable per-session budget cap** bounds model spend.

- **Units:** **USD per session** (computed from token usage × the current per-model rates in §3).
- **Default:** **off by default** for v1 (no cap) — operators opt in by setting a positive USD value. (Whether to ship a non-zero default is OQ #5.)
- **Soft-warn** at a configurable fraction of the cap (default 80%): the system emits a non-blocking notice to the operator/DM surface and **continues the turn**. Play is not interrupted.
- **Hard-stop** at 100% of the cap: the system **finishes the current in-progress turn** (so narration is never truncated mid-sentence and engine state is never left half-mutated), then **blocks new model calls** and surfaces a clear "budget reached — raise the cap or end the session" state. A hard-stop never aborts mid-narration and never leaves the engine in an inconsistent state.

Both thresholds and the cap value are operator configuration. Budget stops are logged for audit (§13).

---

## 5. Knowledge Base & RAG

### 5.1 Corpus & ingestion

For this **local concept-proof** the corpus is **full 5e sourcebook text (including the PHB)** plus first-party authored lore, used locally to validate output quality. Ingestion is offline: text is chunked, each chunk carries provenance metadata (source label, section), and chunks are embedded and stored in PostgreSQL/pgvector alongside the structured data. Lore for the v1 scenario is hand-authored seed data ingested the same way.

**No ingestion lock for this build.** Any rules text the operator has locally may enter the corpus — the SRD-only restriction has been removed for private at-home use. (If the project ever heads toward public distribution, restore an SRD-5.1/CC-BY-only ingestion path and an isolated, never-merged namespace for user uploads before doing so.)

### 5.2 Embeddings & the pgvector dimension invariant

Two **independent** decisions govern embeddings; do not conflate them:

**(a) Embedding vendor selection.** Default: **Voyage `voyage-3-large`**. Fallback under consideration: **OpenAI `text-embedding-3-large`**. Both sit behind the embedding-provider interface. (Pinning one for v1 is OQ #3a.)

**(b) pgvector column dimension.** The `vector(N)` column dimension is a **hard schema invariant** that must equal the **chosen model's native/configured output dimension** — it is **not** provider-agnostic:

| Model | Native / configured dimension | Notes |
|---|---|---|
| Voyage `voyage-3-large` | **1024** (default via Matryoshka; also supports 2048 / 512 / 256) | Default choice → `vector(1024)`. |
| OpenAI `text-embedding-3-large` | **3072** native (truncatable to 1536) | Choosing this → `vector(3072)` or `vector(1536)` if truncated. |

**Consequence:** picking the vendor *fixes* the column dimension; the value 1024 is **specific to Voyage `voyage-3-large`**, not a portable default. **Switching vendors (or dimensions) after launch requires a full re-embed of the corpus plus a schema migration of the vector column** — it is not a config flip. The dimension is therefore frozen at the moment the vendor is pinned (OQ #3a → OQ #3b). This is a *different vendor from Anthropic*; confirm comfort with sending SRD/lore text to it (OQ #3a).

### 5.3 Retrieval, rerank & the acceptance bar

Retrieval is top-k vector search over the corpus, filtered by namespace (shared SRD/lore only for quotable answers). Retrieved chunks are passed to the LLM as context with their provenance so narration can attribute or quote SRD text faithfully.

**Optional rerank** (e.g. Voyage `rerank-2`) is designed behind the provider interface as a quality dial. It is **deferred for v1** unless the retrieval acceptance bar is missed. The objective trigger:

- **Retrieval acceptance metric:** **recall@k** measured against a hand-labeled gold set of (query → correct SRD chunk) pairs drawn from the eval scenarios (§10).
- **Bar:** **recall@5 ≥ 0.90** on the gold set.
- **"Near-miss" definition (the rerank trigger):** the correct chunk is retrieved within the top-k candidate pool but **ranked outside the top-5** (i.e., present in top-k but not surfaced) on **≥10%** of gold queries. A near-miss rate at or above that threshold means the candidate set is good but the ordering is poor — exactly the case rerank fixes — and is the signal to wire rerank in. If recall@5 already meets the bar and near-miss is below 10%, rerank stays deferred (the draft recommendation). (Final go/defer is OQ #6.)

---

## 6. DM Style & Persona ("inspired-by", not a clone)

The "Mercer" reference is **narrative style only** — **no name, no voice cloning, ever.** It is a configurable, swappable DM **style preset** achieved via:

- a **system prompt** describing pacing, descriptive density, and a fair-but-firm ruling posture;
- **curated few-shot exemplars** of in-style narration; and
- a written, fully editable **"DM playbook."**

RAG retrieves the **most relevant style exemplars per scene** (the same retrieval machinery as §5, over an exemplar namespace) so the voice is reinforced contextually without bloating every prompt.

**Example-driven style transfer does NOT imply fine-tuning.** Fine-tuning is not required and is only a far-future fallback *if* prompt + few-shot ever proves insufficient for holding the voice across long sessions. If ever pursued, fine-tuning would touch narrative voice only and must never become a source of rules or facts.

**Persona neutrality in shipped/marketed assets:** internal "inspired-by" language is fine, but no shipped UI string, preset name, store listing, or voice asset may name or clone any real person (re-confirmed at release — §14 OQ #13).

---

## 7. Memory Layer

Deep cross-session "butterfly effect" memory is **deferred**. The memory layer is **designed** as two tiers so it can grow into full cross-session continuity later, but only the lightweight v1 slice is built now.

**Two-tier layered design (target architecture):**

1. **Canonical world-state tier (structured).** The authoritative, queryable record of facts and state: characters, NPCs met, locations, quest flags, faction standings, and the engine's combat/resource state. Structured rows in PostgreSQL.
2. **Episodic vector tier.** Embedded summaries of what happened ("the party spared the smuggler") for fuzzy recall and recap generation, stored in pgvector.

**v1 memory slice (what is actually built now):**

- **Within-session state** — the engine's live state plus the canonical world-state for the active session.
- **Simple session save/resume** — persist and reload a session so a table can stop and continue later.
- **A basic recap** — a short "previously…" summary generated from the canonical tier (and episodic summaries where available) at session resume.

Cross-session continuity beyond save/resume + recap is explicitly out of scope for v1. The two-tier shape above must be in place so the deferred work is additive, not a rewrite. (Confirmation that this slice is correctly scoped is OQ #2/A-note — see §14.)

---

## 8. Interaction & Topology

**Text-first for v1:** typed input/output in a web chat UI. The I/O layer sits **behind an interface** so that voice can swap in later without touching the "brain."

**Voice is a later phase (P2):** shared-mic STT + speaker diarization + expressive TTS. Designed, not built, in v1.

**Topology:** a **single shared instance** — one screen, one input device, players around one table take turns. **No** multi-device networking/sync in v1, but the architecture must not preclude adding per-player companion devices later. Language of play: **English only**.

**Physical dice are kept** (see §4.3): the system asks for a roll, the player declares the result, the system trusts and validates it.

---

## 9. Architecture & Stack

- **Language:** TypeScript full-stack.
- **Frontend:** Next.js / React (the shared-screen chat UI).
- **Backend:** a Node/TypeScript service hosting the rules engine, the LLM provider interface, the RAG pipeline, and the memory layer.
- **Datastore:** **PostgreSQL with the pgvector extension** for **both** structured/relational data **and** vector embeddings. No separate vector DB at this stage. The vector column dimension is the schema invariant from §5.2.
- **Containerization:** everything in Docker / docker-compose for local-dev → server portability. The **same image** runs on a laptop today and a server later; **only secrets/keys differ** between environments.
- **Optional Python sidecar (later, not v1):** reserved for character-sheet OCR and local-model experiments. Not built in v1.

**Interfaces that must exist as seams from day one:** (1) the LLM provider interface (§3), (2) the embedding provider interface (§5.2), (3) the I/O layer interface for future voice (§8), and (4) the engine tool contract (§4.1). These four seams are what keep every "swap it later" decision cheap.

---

## 10. Eval & Playtest Harness

A lightweight **eval + playtest harness is built early** — it is what makes model/prompt/provider swaps safe. Three components:

1. **Automated rules-correctness checks against the engine.** Scripted scenarios assert exact engine outcomes (HP after a hit, slot count after a cast, who acts next in initiative, condition expiry). These also enforce the §4.2 ramp: a mechanic that should be engine-authoritative for the current phase must resolve in the engine, not the LLM. A regression here blocks release.

2. **Scripted scenario evals, including LLM-as-judge for narration.** Deterministic transcripts are replayed and the narration is scored by an LLM judge against a written rubric.

   **Narration rubric — dimensions and scale.** Each narration sample is scored **0–5** (integer) on each of these dimensions:
   - **Rules fidelity** — narration never contradicts the engine result or invents a mechanic.
   - **Faithfulness to source** — no fabricated rules text; "not in the loaded rules" when appropriate.
   - **Style adherence** — matches the configured DM preset's pacing/voice (§6).
   - **Pacing & momentum** — keeps the scene moving; no stalling or rambling.
   - **Coherence & continuity** — consistent with canonical world-state and prior turns.
   - **Player agency & fairness** — fair-but-firm; does not railroad or contradict declared player intent.

   **Initial baseline.** The baseline is computed **once** at the start of P1: run the **fixed v1 eval scenario set** (the scripted scenarios above, ≥ the agreed count — see OQ #2) through the **then-current default models** (Opus 4.8 / Sonnet 4.6 per the §3 routing policy), **3 runs per scenario**, judged by the LLM judge. The **baseline for each dimension** is the **mean** of all per-sample scores on that dimension across all runs. The baseline is recorded and version-pinned.

   **Per-dimension pass bar for v1 release.** Each dimension must meet an absolute floor (the v1 release bar) — the concrete value per dimension is OQ #2 — *and* must not regress past the relative gate below.

   **Regression gate (relative).** On any subsequent run (after a prompt/model/provider change), a dimension **passes** if `score_mean ≥ baseline_mean − 0.4` on the 0–5 scale. Dropping more than 0.4 below baseline on any dimension blocks the change until investigated.

3. **A human playtest rubric.** Real tables play and rate the experience, including the **"would play again"** gate (exit criterion 8, §12) — passing requires **≥ N testers** answering yes, where **N** is OQ #2.

The harness runs in CI (rules-correctness checks + LLM-judge evals) and on demand (human playtests). Safety-relevant logs (§13) feed back into the eval corpus.

---

## 11. Legal & Licensing

- **Local concept-proof — no SRD-only lock.** This build runs privately at home and uses **full 5e sourcebook content (including the PHB)** to validate output quality. It is **not** shipped, published, hosted for others, or redistributed. The operator is aware of, and accepts, the licensing implications of this **local-only, personal-use** posture.
- **Provenance is still tracked** for auditing/citation (each chunk carries a source label), but no content is excluded on licensing grounds in this build.
- **Before any public distribution (not in scope now):** restore an **SRD-5.1 / CC-BY-4.0-only** quotable corpus with attribution, drop PHB/copyrighted text from anything redistributable, and gate user uploads behind an isolated, never-merged, never-redistributed per-user namespace + license-attestation flow. Until then, treat this as a private prototype.

---

## 12. Roadmap & Phase Exit Criteria

Each phase names which mechanics move to engine-authoritative (the §4.2 ramp) and what must be true to exit.

| Phase | Theme | Mechanics moved to engine-authoritative | Exit criteria |
|---|---|---|---|
| **P0** | Playable skeleton | Dice primitive (RNG + declared-roll intake) | (1) A table can play through a short scripted scene end-to-end in the text UI. (2) LLM provider + engine-tool seams exist. |
| **P1** | Core checks + eval baseline | Ability checks, saves, attack rolls vs. AC, DC comparison | (3) Rules-correctness checks green for P1 mechanics. (4) **Initial LLM-judge baseline computed and pinned** (§10). |
| **P2** | Combat state + voice design | HP/temp-HP, damage w/ resist/immunity, initiative, action economy, conditions | (5) Rules-correctness checks green for P2 mechanics. (6) Voice I/O designed behind the interface (not yet built). **Voice-phase exit also requires:** diarization correctly attributes **≥ X%** of turns (X is OQ #8), *or* sign-off that the manual speaker-toggle fallback alone is acceptable. |
| **P3** | Resources, tactics, map | Spell slots, class-feature & item charges, range/movement (per OQ #10 map model) | (7) Rules-correctness checks green for P3 mechanics, including resource bookkeeping. |
| **v1 / GA** | Total rules adherence | **100% of mechanics** — LLM is pure narrator/tool-caller | (8) **Human gate:** ≥ N testers (OQ #2) say "would play again." (9) Every narration dimension meets its v1 release bar (OQ #2) and the regression gate (§10). (10) No mechanic is LLM-reasoned. |
| **P6 (post-GA)** | Homebrew / uploads | (no engine change) | (11) Isolated per-user namespace + license-attestation flow shipped (OQ #11), with the §11 no-leak guard verified. |

The two narration thresholds referenced above (absolute per-dimension v1 bar, and N for the human gate) are the OQ #2 numbers and must be set before P1 baseline (for the bar) and before GA (for N).

---

## 13. Safety, Privacy & Auditability

- **Auditability:** safety-relevant decisions — refusals, content-filter trips, **budget soft-warns/hard-stops (§4.4)**, and **flagged implausible dice declarations (§4.3)** — are logged with enough context for review and feed the eval corpus (§10).
- **Data handling:** SRD/lore text and gameplay transcripts are sent to the Anthropic API (and, for embeddings, to the chosen embedding vendor — a *different* vendor from Anthropic; see §5.2). Operators must be comfortable with this; see the API data/retention sources under §2.
- **Zero Data Retention (ZDR):** documented as the upgrade path for privacy-sensitive operators; whether ZDR is the default distribution or an operator-configured option is OQ #9.
- **Voice (P2):** sending live table audio to a third-party STT/TTS vendor interacts with the data-handling posture; the cloud-vs-self-hosted choice (OQ #7) must weigh this.

---

## 14. Open Questions & Deferred Decisions

These need the user's input or an explicit ruling before the relevant work begins. Grouped by urgency. **Note:** items that were previously phrased as both "locked" and "open" have been resolved — see #1.

### A. Needed before / during v1 build

1. **Corpus licensing — resolved for this build.** No SRD-only lock: this local concept-proof uses full 5e sourcebook content (incl. PHB) for private at-home play (§5.1, §11). Not an open question and **not to be re-flagged** during this build. Only revisit if the project moves toward public distribution, at which point switch the quotable corpus to SRD 5.1 / CC-BY 4.0.
2. **Concrete rubric thresholds and tester count.** Set, before the relevant gate: (a) the **absolute per-dimension v1 release bar** on the 0–5 narration rubric (§10) — needed before the P1 baseline is interpreted; (b) **N**, the number of testers who must say "would play again" for exit criterion 8 — needed before GA. The scale (0–5), the six rubric dimensions, the baseline computation (default models, fixed eval set, 3 runs/scenario, per-dimension mean), and the regression formula (`≥ baseline_mean − 0.4`) are already specified in §10.
3. **Embedding decision — two separate sub-decisions:**
   - **#3a — Vendor:** pin **Voyage `voyage-3-large`** (default) or **OpenAI `text-embedding-3-large`** (fallback) for v1, and confirm comfort sending SRD/lore text to that *non-Anthropic* vendor.
   - **#3b — Dimension (follows from #3a):** the `vector(N)` column must equal the chosen model's dimension — **1024** for Voyage `voyage-3-large`; **3072** (or 1536 truncated) for OpenAI `text-embedding-3-large`. 1024 is **not** provider-agnostic. Switching vendor/dimension after launch requires a **re-embed + schema migration** (§5.2).
4. **Pre-authored v1 scenario content.** Confirm or substitute "The Smuggler's Cellar," the 2–3 pre-gen level-1 PCs, and the 1–2 monster stat blocks (hand-authored seed data either way).
5. **Per-session budget cap default (§4.4).** Default is currently **off** (no cap), units **USD/session**, with soft-warn (notify+continue) at 80% and hard-stop (finish current turn, then block) at 100%. Decide whether to ship a non-zero default cap value, or keep it off by default.
6. **Optional rerank in v1? (§5.3)** Defer rerank until the objective trigger fires — **recall@5 < 0.90** or **near-miss rate ≥ 10%** on the gold set — which is the draft recommendation. Confirm this defer-with-trigger, or opt to wire rerank in for v1 regardless.
7. **(was a gap) v1 memory slice scope confirmation.** Confirm the v1 memory slice — within-session state + simple save/resume + basic recap, atop the two-tier (canonical world-state + episodic vector) design — is correctly scoped per §7, and that the deferred cross-session work is purely additive.

### B. Needed before later phases (not v1-blocking)

8. **Voice vendor commitments (P2).** Shortlist: AssemblyAI (STT + bundled diarization) + Cartesia Sonic-3 / Kokoro-82M (TTS), with self-hosted fallbacks. Defer selection until voice work starts; re-verify pricing/latency then. The cloud-vs-self-hosted choice interacts with data-handling posture (§13) — sending live table audio to a third party.
9. **Diarization accuracy target (P2 exit).** Set **X** in "diarization correctly attributes ≥ X% of turns" (§12), **or** confirm the manual speaker-toggle fallback alone is acceptable for P2 sign-off (the draft makes diarization an enhancement, not a dependency).
10. **Zero Data Retention (ZDR).** Decide whether ZDR is pursued for the default distribution or left as an operator-configured option (§13).
11. **Tactical map scope (P3).** Decide whether the eventual battle map is a true coordinate grid vs. a zone/abstract-distance model — this affects how much authoritative-state surface (range/movement) the engine takes on (§4.1, §4.2 P3). The draft assumes a real grid; confirm before P3.
12. **Homebrew / user-uploaded content policy (P6).** Only relevant if the project ever exposes uploads or goes public. For this local concept-proof there is no ingestion restriction (§5.1, §11). A future public path would need the **license-attestation flow** and the **isolated per-user namespace, never-merged, never-redistributed** guard — deferred until then.

### C. Standing constraints to re-confirm at each milestone

13. **Model IDs and pricing drift.** All numbers (`claude-opus-4-8` $5/$25, `claude-sonnet-4-6` $3/$15, embedding/voice costs) were verified **14 June 2026** against the canonical Anthropic pages. Per the locked decision, re-verify current model IDs/pricing **via web search against the canonical Anthropic pricing/models pages** (not third-party blogs) before quoting them in any future plan or before a model swap.
14. **Persona neutrality in shipped/marketed assets.** Internal "inspired-by" language is fine; confirm at release that no shipped UI string, preset name, store listing, or voice asset names or clones any real person (§6).
