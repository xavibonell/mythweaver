# MythWeaver

A self-hosted, AI-driven Dungeon Master for tabletop RPGs (**v1: D&D 5e**). Two ideas carry it:

1. **A deterministic engine owns every number.** The LLM narrates and calls tools; it never invents a
   mechanic — the engine decides pass/fail vs a DC/AC and the DM narrates the verdict.
2. **A fully dynamic, LLM-_directed_ scene UI.** Every location is drawn on the fly from the unfolding
   story — there are no hand-authored maps. The LLM _directs_ in semantic terms (what kind of place,
   what's in it, who's present); a deterministic layer plus a curated tile library _resolve_ that into a
   hand-crafted-looking, walkable top-down scene. **The model never paints a pixel.**

The real appeal is the **orchestration**: several nuanced layers — fiction → composition → geometry →
pixels — each a swappable seam with a typed contract and its own checks, resolving into a story-driven
UI that is *generated*, not authored.

- **Agent / fresh-machine setup:** [CLAUDE.md](CLAUDE.md) — get it running on another computer fast.
- **Specification:** [docs/MythWeaver-Dev-Spec.md](docs/MythWeaver-Dev-Spec.md) — the single source of truth.
- **Build plan:** [docs/BUILD-PLAN.md](docs/BUILD-PLAN.md) — P0/P1 tickets and exit criteria.
- **DM track:** [docs/DM-LAYER-TODO.md](docs/DM-LAYER-TODO.md) — DM Lab, voice distillation, the planned Showrunner/arc layer.
- **Visual track:** [docs/VISUAL-LAYER-TODO.md](docs/VISUAL-LAYER-TODO.md) · contracts in [docs/SCENE-CONTRACTS.md](docs/SCENE-CONTRACTS.md) · [docs/TOWN-BUILDER-NOTES.md](docs/TOWN-BUILDER-NOTES.md) — the scene/Director layer.

## Why this shape

| Decision | Choice |
|---|---|
| Rules correctness | Deterministic engine = source of truth for all mechanics; LLM never invents a number (spec §4). |
| Reasoning model | Anthropic Claude, behind a swappable `LlmProvider` seam (spec §3). |
| Knowledge | RAG over SRD text for narration/lookup — never to resolve a mechanic (spec §5). |
| DM style | "Inspired-by" preset via prompt + few-shot + playbook. **No fine-tuning, no name/voice clone** (spec §6). |
| Visual world | LLM **directs** (archetype + contents + intent), never draws; deterministic generators + a curated tile library own geometry and pixels. Generate-once-then-**freeze**. |
| Scene art | DawnLike (CC-BY) via a single `assets/library.json` → engine catalog **and** renderer manifest — one source of truth, so vocabulary and pixels can't drift. |
| Stack | TypeScript full-stack · Next.js/React · Phaser renderer · Node · Postgres + pgvector · Docker. |

## The visual layer — a story-driven scene UI, generated not authored

When play moves to a new place, the DM calls **one tool** (`setScene`) describing it in fiction —
*"a misty fen-village green at dusk: reed huts, a well, black water beyond; a wary fisherwoman waits."*
From there a chain of deterministic layers turns that intent into a rendered, walkable top-down scene
and **freezes** it (so the renderer and the DM's text digest always agree). Each arrow is a typed
contract; nothing downstream ever lets the model choose a coordinate or a pixel.

```
brief → DM(setScene) → EstablishScene → Director/Composer → SceneComposition → Cartographer → SceneMap → Phaser
        └─ fiction ──┘  └─ schema ────┘  └ composition intent ┘  └─ geometry · identity · pixels (FREEZE) ─┘  └ render
```

- **LLM picks, doesn't paint.** The Director chooses an **archetype** (town / dungeon / cave /
  wilderness / coast) and its **contents**; a deterministic `generator(canvas, ctx)` owns the layout.
  The town generator runs streets → parcels → **multi-room compound buildings** → density — and those
  buildings are made structurally correct **by construction** (a *seal → connect → repair → frame* pass:
  no holes, no sealed-off rooms, no doors opening onto nothing), verified clean across **1000 random seeds**.
- **One asset library.** Every tile comes from a single `assets/library.json` (DawnLike, CC-BY),
  compiled to the engine's catalog **and** the renderer's manifest — the Director's vocabulary and the
  pixels are guaranteed to agree. A floor-facing wall **autotiler** picks edges and corners by which side
  the interior is on, so any footprint (incl. L-shapes) tiles correctly.
- **Typed contracts, two checks per seam.** `EstablishScene` (DM), `SceneComposition` (Director) and
  `SceneMap` (Cartographer) each carry deterministic **invariants** (unit tests) *and* graded **quality**
  (LLM-judge). See [SCENE-CONTRACTS.md](docs/SCENE-CONTRACTS.md).

### The scene workbench and its two quality gates

- **Scene Lab** — http://localhost:6985/lab — type a brief and watch every stage render, with the
  intermediate artifacts shown so you can see *which* layer is at fault. Modes: **Primitives** (the LLM
  composes a primitive program, no templates), **Classic** (the three fixed grammars), **City** (district
  stitcher), **Component** (a contact sheet of N seed-varied instances of one micro-generator — iterate a
  building or vignette in isolation, $0).
- **Structural sweep** — `npm run scene:sweep` — deterministic and $0: builds a component over hundreds
  of seeds and asserts the geometry invariants (closed walls, every room reachable, framed doors only).
  The fast inner loop — it gates *geometry*.
- **Visual judge** — `npm run scene:judge:visual` — a vision-LLM **panel** scores the rendered pixels
  against a rubric (wall integrity, opening sanity, furniture coherence, asset richness, fidelity) with a
  before/after **baseline gate**. It catches what geometry can't — corners, mismatched tiles, "reads
  hand-crafted." It gates *aesthetics*.

The two are complementary: the sweep proves the layout is **sound**; the judge proves it **looks right**.

## The four seams (swap-it-later boundaries)

1. `LlmProvider` — `packages/llm` (reasoning model)
2. `EmbeddingProvider` — `packages/rag` (embeddings vendor)
3. `IoChannel` — `packages/shared` (text now, voice later)
4. Engine tool contract — `packages/shared` + `packages/engine` (mechanics)

The visual layer adds three more typed boundaries on the same principle — `EstablishScene`,
`SceneComposition`, `SceneMap` (`packages/shared/src/world.ts`) — each independently swappable and checked
([SCENE-CONTRACTS.md](docs/SCENE-CONTRACTS.md)).

## Layout

```
packages/
  shared/   domain types, engine + scene tool contracts (EstablishScene/SceneComposition/SceneMap), IoChannel seam
  engine/   deterministic rules engine (authoritative state) + dice-trust validation
  llm/      LlmProvider interface, Opus/Sonnet router, Anthropic adapter (text + vision)
  rag/      EmbeddingProvider interface, pgvector retriever
  scene/    the visual layer: Director/Composer, archetype generators, Cartographer, wall autotiler,
            structural invariants, the asset catalog
apps/
  server/   Node/Fastify backend: orchestrator turn-loop, session API, DM Lab + Scene Lab endpoints, eval harnesses
  web/      Next.js UI: shared-screen chat + the Phaser scene renderer + the Scene Lab (/lab)
assets/     library.json — the single source of truth for tiles (DawnLike, CC-BY)
db/init/    Postgres schema (pgvector)
content/    SRD-safe scenarios, pre-gens, bestiary (seed data)
docs/       spec, build plan, DM + visual roadmaps, scene contracts
```

## Quickstart (local dev)

> Requires Node ≥ 20 and Docker. The same image runs locally and on a server; only secrets differ (spec §9).

```bash
cp .env.example .env          # fill in ANTHROPIC_API_KEY (+ OPENAI_API_KEY for semantic RAG)
npm install                   # install workspace deps
npm run build                 # build packages (TS project references)
npm test                      # full test suite (engine + orchestrator + scene + rag + rubric)
npm run dev:server            # backend on :6984 (tsx watch — hot-reloads)
npm run dev:web               # web UI on :6985 (expects the backend at :6984)
npm run db:up                 # Postgres + pgvector — ONLY for the play/session API; the DM Lab needs no DB
# or: npm run up              # everything via docker compose (containers use :8080 / :3000)
```

Tuning tools — **DM track:** DM Lab at http://localhost:6984/dm/lab (`npm run dm:lab` CLI) ·
evals `npm run eval` (real API calls). **Visual track:** Scene Lab at http://localhost:6985/lab ·
structural sweep `npm run scene:sweep` ($0) · visual judge `npm run scene:judge:visual` (vision API).
See [CLAUDE.md](CLAUDE.md) for the full agent setup guide.

### Rules corpus (RAG) setup — personal use only

```bash
python3 -m venv .venv-pdf && .venv-pdf/bin/pip install pymupdf   # one-time
.venv-pdf/bin/python scripts/extract-corpus.py raw-data/dnd      # PDFs -> content/corpus/dnd.jsonl
node scripts/embed-corpus.mjs                                    # embed -> dnd.vectors.jsonl (needs OPENAI_API_KEY)
```

Point the extractor at any folder of PDFs to swap games. With no embeddings key, retrieval falls back to
offline keyword and the embed step is unnecessary. `raw-data/` and `content/corpus/` are gitignored.

## Status (honest maturity)

**Foundation + P1 checks + RAG + a full visual/scene layer are complete; deeper P2 combat, semantic retrieval, and memory next.**

**Real & tested** (264 tests, CI on every push):
- Deterministic dice + declared-roll plausibility engine (spec §4.3); `NotImplemented(<phase>)` ramp guard (§4.2).
- **Engine-authoritative checks/saves/attacks** (P1): the engine decides pass/fail vs a DC or AC and the DM narrates the verdict (it cannot decide it).
- Agentic **turn-loop** with physical-dice suspend/resume, content-block LLM contract, `FakeLlmProvider` + orchestrator tests + serialization round-trip.
- Anthropic adapter with **prompt caching** + timeout/retry; Opus/Sonnet routing.
- Operational safety: input validation, localhost-default binding + optional `MYTHWEAVER_API_TOKEN`, per-turn structured **trace**, **budget meter** (soft-warn 80% / hard-stop 100%, spec §4.4), graceful turn-failure (atomic — nothing persists on error).
- Editable **DM playbook as data** (`prompts/dm-playbook.md`, hot-reloaded; A/B via `MYTHWEAVER_PLAYBOOK_PATH`).
- Canonical transcript in the `messages` table; bounded state blob.
- **Rules corpus (RAG):** game-agnostic PDF→chunked-corpus extraction (PyMuPDF) + a `lookupRule` tool that cites sources. Three retrievers behind one seam, best-available first: **in-memory semantic vector** (cached embeddings, no DB — active with an `OPENAI_API_KEY`), **pgvector** (scale path), or **offline BM25+stemming** (no key/DB). Corpus is **personal-use + gitignored**.
- **DM Lab + eval harness:** a web/CLI workbench (`/dm/lab`, `npm run dm:lab`) to drive turns and inspect narration + tool calls + state diffs + cost, with live playbook/scenario editing, a temperature knob, and transcript→voice distillation; plus an eval set (`npm run eval`) scored by a 6-dim LLM judge **and** deterministic tool-use assertions (spec §10).
- **Visual / scene layer:** the full `setScene → EstablishScene → Director → Cartographer → frozen SceneMap → Phaser` pipeline, with typed contracts + invariants + LLM-judge at each seam. Archetype generators (town/dungeon/cave/wilderness/coast); a town builder whose multi-room compound buildings are **structurally correct by construction** — 0 defects across 1000 seeds, enforced as a test; a floor-facing wall autotiler; a one-source asset library (DawnLike, CC-BY). Tooling: **Scene Lab** (`/lab`), a deterministic **structural sweep** (`npm run scene:sweep`), and a vision-LLM **visual judge** with a regression-gated baseline (`npm run scene:judge:visual`).

**Stub / not built yet** (intentionally — see [build plan](docs/BUILD-PLAN.md)):
- P2 combat state: HP, damage (resist/immunity), initiative, action economy, conditions — `NotImplemented`.
- High-quality **semantic** retrieval (needs an embeddings key; offline keyword path is the fallback). Episodic vector memory (schema only).
- Tactical/spatial model. Voice I/O (the `IoChannel` seam is declared but the live path is HTTP/JSON).
- Per-turn style-exemplar RAG + the Showrunner/campaign-arc layer (designed — see [DM roadmap](docs/DM-LAYER-TODO.md)).
- **Visual layer next:** bring the other building types to `house`'s bar (tavern is WIP), extract inner-corner/T-junction wall tiles for pixel-perfect corners, and live **SceneDelta** manipulation (move/add objects mid-scene). See the [visual roadmap](docs/VISUAL-LAYER-TODO.md).

## Credits

Scene art: **DawnLike — 16×16 Universal Rogue-like tileset** by **DragonDePlatino & DawnBringer**,
[CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/) — [OpenGameArt](https://opengameart.org/content/dawnlike-16x16-universal-rogue-like-tileset-v181).
Per-tile `license`/`attribution` are carried in `assets/library.json`; see [docs/DAWNLIKE-SWAP.md](docs/DAWNLIKE-SWAP.md).
