# MythWeaver — agent onboarding & setup

Self-hosted AI Dungeon Master for D&D 5e. TypeScript monorepo (npm workspaces). A deterministic
rules **engine is authoritative for all mechanics**; the LLM is a narrator/tool-caller behind a
swappable `LlmProvider` seam. This file is the fast path to getting it **running on a fresh machine**
and knowing where everything is. Canonical detail lives in `docs/` (see Pointers).

## Prerequisites
- **Node ≥ 20** + npm (workspaces).
- **Docker** — only for Postgres+pgvector (the play/session API). Not needed to run the DM Lab.
- **Python 3** — only if rebuilding the RAG corpus or extracting art assets.
- **Keys:** an `ANTHROPIC_API_KEY` (the DM brain) is required for any real turn. `OPENAI_API_KEY`
  (or `VOYAGE_API_KEY`) is optional — it enables semantic RAG; without it, rule lookup falls back to
  offline keyword search.

## First-time setup (fresh clone)
```bash
cp .env.example .env        # then fill ANTHROPIC_API_KEY (+ OPENAI_API_KEY for semantic RAG)
npm install                 # install all workspace deps
npm run build               # tsc project references — must be clean
npm test                    # 84 tests; all should pass (engine + orchestrator + scene + rag + rubric)
```

## Run it
Ports come from `.env`: **backend `:6984`, web `:6985`** (the web app calls the backend at
`http://localhost:6984` by default — keep `PORT=6984` or set `NEXT_PUBLIC_SERVER_URL` to match).

```bash
npm run dev:server          # backend on :6984 (tsx watch — hot-reloads on source edits)
npm run dev:web             # web UI on :6985
npm run db:up               # Postgres+pgvector (loads db/init/001_init.sql). ONLY needed for the
                            # play/session API (/sessions, /sessions/:id/turn). The DM Lab + Scene
                            # Lab are ephemeral and need NO database.
# or, everything in containers:
npm run up                  # docker compose (db + server + web). Sets HOST=0.0.0.0 — set a token.
```

Verify: `curl http://localhost:6984/health` → `{"ok":true}`.

## The DM-tuning workbench (this is the main current focus)
- **DM Lab (web):** http://localhost:6984/dm/lab. Tabs: **Run / Playbook / Scenario / Distill**.
  **Run is an interactive chat** — New session, then play **turn by turn** with accumulating context;
  each DM reply shows narration + tool calls (inputs & results) + state diff + cost, and an inline
  **roll bar** (Declare / Auto-roll) appears when the DM asks for a roll. A **Start-scene** picker
  drops the party into any scene (e.g. the fight) and combat is fully wired (`startEncounter` /
  `applyDamage` / `heal` / `rollDeathSave`). Live-edit the playbook & scenario (a session captures
  them at creation; new session to apply), a **temperature** knob, and **Distill** (paste/upload
  transcripts→voice or a guide→principles, with a git-style **Diff** preview). Code:
  `apps/server/src/dm-lab.ts` + `dm-lab-page.ts`; endpoints `POST /dm/lab/session(/:id/turn)`.
- **DM Lab (CLI):** `npm run dm:lab` (built-in transcripts `default`/`edges`, or `--script file.json`).
- **Evals:** `npm run eval` (gate vs `apps/server/src/eval/baseline.json`) · `npm run eval:update`
  (re-pin baseline). **Real API calls (~$0.3).** 6-dim LLM judge + deterministic tool-use assertions.
- **Scene Lab (web):** http://localhost:6985/lab — the visual-layer harness (a different track).
- The DM persona is editable data: `prompts/dm-playbook.md` (hot-reloaded per turn; the in-code
  `DEFAULT_DM_PLAYBOOK` in `orchestrator.ts` is only a fallback).

## RAG corpus (NOT in the repo)
`content/corpus/` and `raw-data/` are **gitignored** (large + source PDFs), so a fresh clone has **no
RAG data** — `lookupRule` degrades to offline keyword or none, but everything else runs. To rebuild
(personal use): put source PDFs under `raw-data/<game>/`, then:
```bash
python3 -m venv .venv-pdf && .venv-pdf/bin/pip install pymupdf
.venv-pdf/bin/python scripts/extract-corpus.py raw-data/<game>   # PDFs -> content/corpus/*.jsonl
node scripts/embed-corpus.mjs                                     # -> *.vectors.jsonl (needs OPENAI_API_KEY)
```

## Style-exemplar corpus — Technique B (also NOT in the repo)
A **second, independent** RAG namespace (`content/exemplars/`) makes the turn-DM *sound human*: each
turn retrieves 2 real-DM beats matching the moment's register and injects them into the per-turn prompt
(voice only — never rules, never visible to `lookupRule`). It's **fully separate from the rules corpus
above** — the rules RAG is untouched by it and needs no re-embedding. Both `raw-data/transcripts/` (the
source transcripts) and `content/exemplars/*.{jsonl,vectors.jsonl}` (the built corpus) are **gitignored**,
so the *code* travels via git but each machine builds its **own** corpus once. Without it the feature is
silently off (the DM behaves exactly as before — graceful degrade, no errors).

**To build it (one-time, ~$3.70, needs `OPENAI_API_KEY`/`VOYAGE_API_KEY`):** drop speaker-labeled `.txt`
transcripts into `raw-data/transcripts/` (`DM:` for the DM, `NAME:` for players, `#` lines ignored), then:
```bash
npm run build                                  # the script imports from dist/
node scripts/ingest-exemplars.mjs --dry-run    # FREE: parse->window->tag->sample; prints per-moveType
                                               #   counts + writes content/exemplars/cr3.candidates.jsonl
node scripts/ingest-exemplars.mjs              # PAID: LLM curate (keep/drop + anonymize-by-rewrite +
                                               #   strip mechanics) + embed -> cr3.jsonl + cr3.vectors.jsonl
```
Restart the server; confirm the boot log shows `Style exemplars: semantic (N/N exemplars, <model>)`.
Use the **same embeddings provider** to build the corpus and to run the server (don't mix an
OpenAI-built corpus with a Voyage-configured server). No key at all → it falls back to offline BM25 ($0).
Code: `scripts/ingest-exemplars.mjs` + `apps/server/src/exemplar-ingest.ts` (parser/heuristics) +
`exemplar-corpus.ts` (retriever); design + tickets in `docs/DM-LAYER-TODO.md` §Phase B.

## Key env vars (see `.env.example` for the full list)
| Var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | DM brain (required for real turns). |
| `OPENAI_API_KEY` / `VOYAGE_API_KEY` | Optional — semantic RAG embeddings. |
| `PORT` (6984) / `HOST` | Backend bind. Web expects the backend at `:6984`. |
| `DATABASE_URL` | Postgres (play/session API only). |
| `MYTHWEAVER_DM_PROVIDER` / `MYTHWEAVER_DM_MODEL` | Swap the DM provider/model. |
| `MYTHWEAVER_SESSION_BUDGET_USD` | Per-session spend cap (off by default). |
| `MYTHWEAVER_API_TOKEN` | Shared-secret auth (required if `HOST=0.0.0.0`). |
| `MYTHWEAVER_PLAYBOOK_PATH` | Point the persona at a different playbook (A/B). |
| `MYTHWEAVER_EXEMPLARS` (`on`/`off`) / `MYTHWEAVER_EXEMPLARS_DIR` | Technique B style exemplars: disable, or relocate `content/exemplars/`. |

## Architecture in one breath
Four swappable seams: `LlmProvider` (`packages/llm`), `EmbeddingProvider` (`packages/rag`),
`IoChannel` (`packages/shared`), and the engine tool contract (`packages/engine` + `packages/shared`).
The orchestrator (`apps/server/src/orchestrator.ts`) runs a tool-use loop: stable playbook system
prompt + per-turn state/adventure block → tools `getState`/`requestRoll`/`lookupRule`/`setScene` →
narration. Physical dice **suspend** the turn (`pendingTurn`) and **resume** when the player declares
the total; the engine validates plausibility and decides success vs DC/AC.

## Conventions / guardrails for agents working here
- **The engine owns every number.** The LLM never invents a mechanical outcome; it requests rolls and
  narrates the engine's verdict. Don't move mechanics into prompts.
- **No fine-tuning.** Style is data: playbook + few-shot + (planned) exemplar retrieval.
- **Local concept-proof:** full sourcebook content (incl. PHB) is used locally; `content/corpus/` +
  `raw-data/` are gitignored and must never be committed. Do not re-raise SRD/licensing concerns.
- **Boundary:** the visual/scene layer (`packages/scene`, `apps/web`, `apps/server/src/scene-lab.ts`,
  `setScene` schema) is a separate track — treat as read-only unless asked. The DM layer (engine, RAG,
  playbook, evals, DM Lab) is the active surface.
- **Verify before claiming done:** `npm run build` + `npm test`; for DM behaviour, drive a turn in the
  DM Lab and read the trace.

## Pointers
- `docs/MythWeaver-Dev-Spec.md` — full spec (engine §4, RAG §5, persona §6, memory §7, evals §10).
- `docs/BUILD-PLAN.md` — phase tickets + exit criteria.
- `docs/DM-LAYER-TODO.md` — DM roadmap: Technique A (distillation, current), Technique B (exemplar
  RAG), Phase D (Showrunner / campaign-arc layer).
- `docs/DM-LAB-BRIEF.md` — DM-track charter. `docs/VISUAL-LAYER-TODO.md` + `docs/SCENE-CONTRACTS.md`
  — the visual track.
- `README.md` — project overview.
