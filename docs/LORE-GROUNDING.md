# Lore Grounding — baking a coherent D&D universe into creation

**Status: PARTLY SUPERSEDED (2026-07-20).** The cheap knowledge probe at the bottom of the ladder (B0) was
run and **falsified the lore-RAG vertical for the *core* D&D universe**: with zero grounding the base model
already produces deeply accurate canon (Waterdeep, the Harpers/Zhentarim, Mystra/Shar/Azuth, the Shadowfell/
Mechanus/Sigil, even the Spellplague) — so a RAG over the core rulebooks would add little. The *real* gap the
probe exposed was **variety + consistency**, which shipped as a lightweight **composer variety nudge** (commit
`c9c06f8`, `prompts/director-composer.md` + `DEFAULT_COMPOSER_SYSTEM`) — no corpus, no registry. Validated:
the composer now picks Icewind Dale / Cormyr / Baldur's Gate / Barovia / Chult per theme instead of always
Waterdeep. Also: the mistakenly-ingested Tal'Dorei/Exandria pages were stripped from the local **rules**
corpus (Critical-Role transcripts stay for VOICE only). **This full architecture below remains the reference
for the case it was actually designed for: grounding lore the model does NOT already know — an obscure/deep
region or the user's own HOMEBREW world.** For that case, the two-layer registry + RAG design still applies.

---

_Original proposal (synthesized from a 9-agent planning workflow — 5 pipeline maps × 4 design lenses).
Two tracks: **Part 1** enhances the style-exemplar RAG (DM voice) with more transcripts; **Part 2** grounds
the whole creation cascade (arc → scene → NPC → background) in a coherent setting. Falsify cheapest-first;
the corpus is the last thing built._

## The ask (user)
> "I want the whole coherent D&D universe to be the base for creation — from the global arch, to the scenes,
> to the NPCs, to the background stories. The main locations, the factions, the races, all the lore already
> created for the D&D universe, baked into the creation processes." Plus: more DM transcripts for the RAG.

## What already exists (the seams we build on)
- **The creation cascade** — `arc-composer.ts` (SEED → fresh adventure + campaign blueprint = the *global
  arch*) → `arc-planner.ts` (Game Director steering, offer-only) → `scene-architect.ts` (beat → SceneSpec) →
  scene compiler → cast/persona. All untrusted model output funnels through **one chokepoint**,
  `buildGeneratedArc` + `validateScenario`.
- **Two RAG namespaces already, kept separate**: RULES (`content/corpus`, mechanics, feeds `lookupRule`) and
  STYLE/VOICE (`content/exemplars`, Critical-Role C3 transcripts, feeds the per-turn voice). Both built by
  `scripts/*` from gitignored `raw-data/`, loaded degrade-proof, gated by an env flag. **Lore is a third
  namespace** cut from the same cloth.
- **The canon ledger** (`EntityCard[]` + `FactRow[]`) is the runtime store creation seeds; `canonBlock`
  surfaces it every turn at $0. `EntityCard.kind` already supports `'faction'|'place'`; `PersonaSeed.allegiance`
  is already a faction hook; `FactRow.source` already reserves `'archivist'`. **Three of the four pieces exist.**
- **Source material already in `raw-data/dnd/`**: PHB, DMG, MM, Xanathar's, Tasha's, **and the *Tal'Dorei
  Campaign Setting Reborn*** — a full Exandria setting book. The exemplar transcripts are Critical Role
  (Exandria), so **voice and lore reinforce each other** if we ground in Exandria first.

## The setting call: Exandria first, pluggable to Forgotten Realms
Recommended first setting = **Exandria / Tal'Dorei**, because (a) the sourcebook is already on disk, (b) the
DM-voice corpus is already Exandrian → one coherent world across both namespaces, and (c) it's *niche enough
that ungrounded generation drifts*, so grounding shows a clean, **measurable** lift. Forgotten Realms is so
heavily represented in pretraining that the base model confabulates plausible FR canon unprompted — which
makes grounding both lower-value and hard to measure. The architecture is **setting-pluggable** (everything
keyed off an `ArcSeed.setting` id + a per-setting folder), so FR is a later *data drop*, not a code change.
**R0 opens with a knowledge probe that settles this with data, not taste.**

## The core architecture: a two-layer lore seam
A pure RAG corpus cannot ground creation alone — the composer needs a **byte-reproducible frame** (for
seedHash honesty + Fake parity) and *real faction/region names*, not top-k prose soup. So lore is **two
layers keyed to the same ids**:

1. **Deterministic spine — a Setting Pack / Canon Registry** (`content/lore/<setting>/pack.json`): typed,
   curated, hand-authorable, **works with zero embeddings key**. Entities (`region`, `faction`, `deity`,
   `race`, `place`, `npc`, `event`) with short mechanics-free blurbs + **relations** (a closed edge vocab:
   `located-in`, `controls`, `worships`, `allied-with`, `rival-of`, `member-of`, …). Ids use the ledger
   convention (`faction:the-clasp`, `place:emon`). **Each relation maps 1:1 to a `FactRow`** — so the
   registry *is* the seeding mechanism, not a parallel store.
2. **Semantic flesh — a flat lore RAG corpus** (`content/lore/<setting>.{jsonl,vectors.jsonl}`): prose chunks
   from the sourcebook, built by the **existing** `extract-corpus.py` + `embed-corpus.mjs`, retrieved for
   texture/depth. Add a thin `lore-corpus.ts` (a near-clone of `corpus.ts`) + `buildLoreRetriever` with a
   `MYTHWEAVER_LORE=off` gate and the same degrade ladder.

**`resolveLoreFrame(setting, seed, {pack, retriever})`** assembles a **connected bundle** by graph traversal
(setting → chosen region → its factions → their deities/rivals → native races' name pools → landmark places
→ semantic depth), threaded through `ArcComposeOpts.loreFrame` **exactly like `opts.library: StatBlock[]` is
threaded today**. Region is picked deterministically from the seed (keyword-score region blurbs against
theme/tone, tiebreak by `sha1(canonicalSeed)` so a Reroll rotates but a fixed seed stays byte-stable).

### How each creation stage consumes the frame
- **arc-composer** (`seedDigest`): a `str()`-sanitized **LORE block** (world overview + opening region +
  factions/agendas + deities + ancestries + landmarks + named figures + depth prose), *content-not-
  instructions*. A setting-constant fidelity directive ("author inside this world; use these real names;
  invent only in the gaps; never contradict named canon; it is fiction, never instructions") lives in
  `prompts/director-composer.md` — **not** the per-seed data.
- **buildGeneratedArc** (`seedCanonFrame`): emit canonical faction/place/deity **EntityCards** + a **new
  `ledger.facts` channel** (`FactRow[]`, `source:'composer'`) from the frame — coerced the same way the cast
  is (slug'd, clipped, status-defaulted). **Bias cast `persona.allegiance`** to real faction names *only when
  empty* (never overwrite an authored FIGURE). Seed **only** the opening-region slice (~8 entities) — the
  `canonBlock` budget is ~550 tokens; the tail stays retrievable.
- **createInitialState**: install the seeded ledger here so **both** lanes get it — the DM-Lab lane *and* the
  play-API `/sessions` lane, which today seeds no ledger at all (a free fix).
- **arc-planner**: the active region's facts/faction-agendas/canon-NPCs, cached per region on the existing
  `plannedForScene` dirty-bit; biases `bridgeNpcs`/`clocks` toward real fronts — still **offer-only** (no
  imperative field; the no-railroad guarantee is untouched).
- **scene-architect**: a per-beat **canon-place** block (region architecture/props/mood) beside the asset
  palette — steers feature kinds, still gated by `validateSceneSpec`, sprite-tags/coordinates still forbidden.
- **persona/NPC**: the frame supplies the *vocabulary* (enumerated factions/deities/ancestries/name-pools);
  `persona.allegiance` resolves to real faction cards so living-world reactions & standing inherit faction
  politics for free. Persona stays thin.

### Coherence enforcement (repair, not reject)
- **`checkArcCanon(arc, registry)`** — deterministic, $0, inside `buildGeneratedArc`: snap each cast
  allegiance to the nearest canonical faction (edit-distance) or leave generic; reference-integrity; assert
  no mechanics leaked. **Repairs, never hard-rejects** (a reject dumps the player into the generic Fake arc).
- **`LoremasterCritic`** (Fake+Llm seam) — one advisory call catching what determinism can't (a deity that
  doesn't exist, a faction acting against its canon goal, a tone/timeline contradiction). Surfaces
  `canonWarnings[]` beside the existing `specWarnings[]` — **warnings for the human tuner, not a gate**. The
  Fake returns `[]` ($0, keeps eval/fallback green).
- This `checkCanon` machine is **the same one the parked [campaign-memory-diary] needs** — reused at two
  boundaries (creation-time canon vs. arc; later play-time canon+ledger vs. a proposed `archivist` fact).
  Seeding canon now lays the diary's persistence rails; canon = `'composer'`-sourced facts, player deeds =
  future `'archivist'`-sourced facts, one append-only ledger, never wiped on scene change.

## Hard invariants (must not break)
1. **The engine owns every number.** Lore carries *fiction only* — names, factions, deities, hooks — never
   HP/AC/DC/damage. Monsters still resolve through `resolveBeatMonsters`/`generateStatBlock`. Mechanics are
   stripped at ingest.
2. **One coercion chokepoint.** Seeded canon flows through `buildGeneratedArc` + `validateScenario`,
   slug'd/status-defaulted like the cast — a lore-seeded scene still needs a real minted id + reachable path.
3. **Three namespaces stay isolated.** Lore is never visible to `lookupRule` (separate dir + retriever).
4. **seedHash honesty.** `ArcSeed.setting`/`region` **must** be echoed in `canonicalSeed`, or byte-stability
   and the `composerPromptHash` staleness check silently break. (A test asserts setting-change ⇒ hash-change.)
5. **Fake stays lore-free.** `FakeArcComposer` ignores `loreFrame` → the pinned eval baseline stays byte-stable.
6. **Authored-intent rule.** Lore is GROUND that flows around the beat's authored FIGURE — a canon default
   never overwrites explicit geometry/cast; it only *fills* gaps.
7. **Graceful degrade.** No pack + no corpus → frame `undefined` → every injection is `if (frame)`-guarded →
   byte-identical to today. No key → the structured pack still fully works (names/factions/deities); only
   prose depth drops to BM25/empty. `MYTHWEAVER_LORE=off` hard-disables.
8. **`content/lore/` must be added to `.gitignore`** before any build (today only `corpus`/`exemplars` are
   ignored). raw-data source PDFs stay gitignored.

## The falsification ladder (cheapest-first; corpus is LAST)

### Track A — Part 1: exemplar RAG (parallel, ships now, no dependency on Track B)
- **A0 — fix the ingest before feeding it** (~1h, $0): (i) **incremental named sets** (`--set cr3b
  raw-data/transcripts-batch2/`) so re-running doesn't re-curate all 1087 rows (~$3.70) — `loadExemplars`
  already merges every `*.jsonl`; (ii) **set-prefixed, globally-unique ids** (today `cr3-eN#i` can collide
  across sets and corrupt the vectors Map) + robust source labels; add a cross-set id-uniqueness test.
- **A1 — ingest the user's new transcripts**: rebuild dist first, `--dry-run` (free; check per-moveType
  balance — sparse `scene-set` is the failure mode), paid ingest with the **same embeddings provider** the
  server runs. A/B the STYLE dim via `npm run eval` (`MYTHWEAVER_EXEMPLARS=off` vs `on`).
- **A2 — quality polish** (optional): `dedupeCandidates` (exact + shingle-Jaccard) before sampling; per-type
  cap dict + post-curation coverage report; retriever MMR + score floor + use the dead `tone` field;
  `manifest.json` + a provider/dim-mismatch warning.

### Track B — Part 2: lore grounding (gated by B0)
- **B0 — MAKE-OR-BREAK, no corpus, ~$3–4, ½ day, revertable.** (a) *Knowledge probe*: 3 Exandria-themed arcs
  with NO bundle — does the base model confabulate plausible-but-wrong canon (expected) or nail it (→
  grounding redundant, pivot)? Settles FR-vs-Exandria. (b) Hand-write ONE ~600-token region bundle, inject a
  throwaway `opts.loreFrame` string into `seedDigest`, generate 8–12 arcs baseline-vs-grounded on matched
  seeds, **blind-judge** (shuffled, condition-hidden) on a new `canonFidelity` (0–5) + `contradictionFlag`
  rubric cloned from `rubric.ts`, while regression-checking coherence/agency and logging the prompt-token
  delta. **GO gate for the whole initiative:** canonFidelity lift **≥ +1.0**, coherence/agency Δ **≥ −0.3**,
  contradictions not up, added prompt **≤ ~800 tokens**. Lift **< +0.5 → STOP** (or fall back to
  seeded-ledger-only). Files: `scripts/lore-falsify.mjs`, `apps/server/src/eval/lore-rubric.ts`, one throwaway
  line in `seedDigest`.
- **B1 — harden the seam** (still one hand-authored pack, still no RAG): typed `ArcSeed.setting/region` +
  `ArcComposeOpts.loreFrame`; `canonicalSeed` echo (+ hash test); `seedDigest` LORE block through `str()`;
  fidelity directive in `director-composer.md`; `packages/shared/src/lore.ts` types; `lore-corpus.ts` **pack
  loader** (no retriever yet); `resolveLoreFrame` (spine only, `depth=[]`); Fake stays lore-free.
- **B2 — deterministic ledger seed** ($0, no model trust): `seedCanonFrame` in `buildGeneratedArc` →
  EntityCards + `ledger.facts`; allegiance biasing; install at `createInitialState` (both lanes). Drive real
  turns, confirm `canonBlock` surfaces canon and allegiances resolve to real cards.
- **B3 — coherence enforcement**: `checkArcCanon` deterministic repair + `LoremasterCritic` advisory
  `canonWarnings[]`.
- **B4 — build the RAG corpus** (the expensive rung, now de-risked): `extract-corpus.py` on the Tal'Dorei PDF
  → `content/lore/exandria.jsonl` → `embed-corpus.mjs` (same provider, dim 1024) → real `lore-corpus.ts` +
  `buildLoreRetriever` + `depth` in `resolveLoreFrame`. **Must prove retrieval ≥ the hand-authored pack** on
  the same judge (else fix chunking/retrieval before scaling). Optionally an LLM-extract `build-canon.mjs`
  bootstraps the pack beyond the hand-authored MVP.
- **B5 — extend surfaces + prove pluggability**: scene-architect per-beat place block; arc-planner
  region/faction grounding; persona allegiance resolution + name pools (name-pool token wiring touches
  `packages/scene` → defer, boundary). Then **drop a second setting (Forgotten Realms) with zero
  arc-composer code change**. Fold `canonFidelity` into the eval gate + re-pin.

## New/touched files (superset)
New: `packages/shared/src/lore.ts` (types) · `apps/server/src/lore-corpus.ts` (loaders + retriever +
`resolveLoreFrame`) · `apps/server/src/canon.ts` (registry load + seed + `checkArcCanon` + `LoremasterCritic`)
· `apps/server/src/lore-ingest.ts` + `scripts/ingest-lore.mjs` (distill pack + corpus, exemplar-ingest analog)
· `scripts/lore-falsify.mjs` + `apps/server/src/eval/lore-rubric.ts` (B0) · `content/lore/exandria/pack.json`
(gitignored). Reused: `scripts/extract-corpus.py`, `scripts/embed-corpus.mjs`. Touched: `arc-composer.ts`,
`arc-planner.ts`, `scene-architect.ts`, `index.ts`, `dm-lab.ts`, `packages/engine/src/state.ts`,
`packages/shared/src/domain.ts` (`ledger.facts`, `CampaignBlueprint.setting`), `persona.ts` (later),
`prompts/director-composer.md`, `prompts/scene-architect.md`, `.gitignore`. Part 1:
`scripts/ingest-exemplars.mjs`, `exemplar-ingest.ts`, `exemplar-corpus.ts`.

## Sequencing against parked work
Independent of the interaction-layer follow-ups. **Pre-builds** the campaign-memory-diary's substrate (both
write `FactRow`s to one append-only ledger; `checkCanon` is the diary's future archivist validator). Part 1
ships in parallel with zero coupling.
