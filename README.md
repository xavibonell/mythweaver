# MythWeaver

A self-hosted, AI-driven Dungeon Master for tabletop RPGs. **v1 is text-first, D&D 5e.**
A deterministic rules engine owns every number; the LLM is the narrator and tool-caller.

- **Agent / fresh-machine setup:** [CLAUDE.md](CLAUDE.md) — get it running on another computer fast.
- **Specification:** [docs/MythWeaver-Dev-Spec.md](docs/MythWeaver-Dev-Spec.md) — the single source of truth.
- **Build plan:** [docs/BUILD-PLAN.md](docs/BUILD-PLAN.md) — P0/P1 tickets and exit criteria.
- **DM roadmap:** [docs/DM-LAYER-TODO.md](docs/DM-LAYER-TODO.md) — DM Lab, voice distillation, and the planned Showrunner/arc layer.

## Why this shape

| Decision | Choice |
|---|---|
| Rules correctness | Deterministic engine = source of truth for all mechanics; LLM never invents a number (spec §4). |
| Reasoning model | Anthropic Claude, behind a swappable `LlmProvider` seam (spec §3). |
| Knowledge | RAG over SRD text for narration/lookup — never to resolve a mechanic (spec §5). |
| DM style | "Inspired-by" preset via prompt + few-shot + playbook. **No fine-tuning, no name/voice clone** (spec §6). |
| Stack | TypeScript full-stack · Next.js/React · Node · Postgres + pgvector · Docker. |

## The four seams (swap-it-later boundaries)

1. `LlmProvider` — `packages/llm` (reasoning model)
2. `EmbeddingProvider` — `packages/rag` (embeddings vendor)
3. `IoChannel` — `packages/shared` (text now, voice later)
4. Engine tool contract — `packages/shared` + `packages/engine` (mechanics)

## Layout

```
packages/
  shared/   domain types, engine tool contract, IoChannel seam
  engine/   deterministic rules engine (authoritative state) + dice-trust validation
  llm/      LlmProvider interface, Opus/Sonnet router, Anthropic adapter (stub)
  rag/      EmbeddingProvider interface, pgvector retriever (stub)
apps/
  server/   Node/Fastify backend: orchestrator turn-loop, session API, DB
  web/      Next.js shared-screen chat UI
db/init/    Postgres schema (pgvector)
content/    SRD-safe scenarios, pre-gens, bestiary (seed data)
docs/       spec + build plan
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

Tuning tools: **DM Lab** at http://localhost:6984/dm/lab (`npm run dm:lab` for the CLI) ·
**evals** `npm run eval` / `npm run eval:update` (real API calls) · **Scene Lab** at
http://localhost:6985/lab. See [CLAUDE.md](CLAUDE.md) for the full agent setup guide.

### Rules corpus (RAG) setup — personal use only

```bash
python3 -m venv .venv-pdf && .venv-pdf/bin/pip install pymupdf   # one-time
.venv-pdf/bin/python scripts/extract-corpus.py raw-data/dnd      # PDFs -> content/corpus/dnd.jsonl
node scripts/embed-corpus.mjs                                    # embed -> dnd.vectors.jsonl (needs OPENAI_API_KEY)
```

Point the extractor at any folder of PDFs to swap games. With no embeddings key, retrieval falls back to
offline keyword and the embed step is unnecessary. `raw-data/` and `content/corpus/` are gitignored.

## Status (honest maturity)

**Foundation + P1 checks + RAG (offline keyword) complete; P2 combat, semantic retrieval, and memory next.**

**Real & tested** (84 tests, CI on every push):
- Deterministic dice + declared-roll plausibility engine (spec §4.3); `NotImplemented(<phase>)` ramp guard (§4.2).
- **Engine-authoritative checks/saves/attacks** (P1): the engine decides pass/fail vs a DC or AC and the DM narrates the verdict (it cannot decide it).
- Agentic **turn-loop** with physical-dice suspend/resume, content-block LLM contract, `FakeLlmProvider` + orchestrator tests + serialization round-trip.
- Anthropic adapter with **prompt caching** + timeout/retry; Opus/Sonnet routing.
- Operational safety: input validation, localhost-default binding + optional `MYTHWEAVER_API_TOKEN`, per-turn structured **trace**, **budget meter** (soft-warn 80% / hard-stop 100%, spec §4.4), graceful turn-failure (atomic — nothing persists on error).
- Editable **DM playbook as data** (`prompts/dm-playbook.md`, hot-reloaded; A/B via `MYTHWEAVER_PLAYBOOK_PATH`).
- Canonical transcript in the `messages` table; bounded state blob.
- **Rules corpus (RAG):** game-agnostic PDF→chunked-corpus extraction (PyMuPDF) + a `lookupRule` tool that cites sources. Three retrievers behind one seam, best-available first: **in-memory semantic vector** (cached embeddings, no DB — active with an `OPENAI_API_KEY`), **pgvector** (scale path), or **offline BM25+stemming** (no key/DB). Corpus is **personal-use + gitignored**.
- **DM Lab + eval harness:** a web/CLI workbench (`/dm/lab`, `npm run dm:lab`) to drive turns and inspect narration + tool calls + state diffs + cost, with live playbook/scenario editing, a temperature knob, and transcript→voice distillation; plus an eval set (`npm run eval`) scored by a 6-dim LLM judge **and** deterministic tool-use assertions (spec §10).

**Stub / not built yet** (intentionally — see [build plan](docs/BUILD-PLAN.md)):
- P2 combat state: HP, damage (resist/immunity), initiative, action economy, conditions — `NotImplemented`.
- High-quality **semantic** retrieval (needs an embeddings key; offline keyword path is the fallback). Episodic vector memory (schema only).
- Tactical/spatial model. Voice I/O (the `IoChannel` seam is declared but the live path is HTTP/JSON).
- Per-turn style-exemplar RAG + the Showrunner/campaign-arc layer (designed — see [DM roadmap](docs/DM-LAYER-TODO.md)).
