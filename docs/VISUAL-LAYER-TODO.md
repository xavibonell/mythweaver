# Visual Layer — Roadmap to "as perfect as we can"

This is the working plan for the **scene / visual layer** (the "scene-lab" track). It captures
everything done and every phase we concluded we need. Companion docs: `SCENE-CONTRACTS.md` (the
canonical contract spec) and `DM-LAB-BRIEF.md` (the parallel DM-behaviour track).

**Pipeline:** `brief → DM(setScene) → EstablishScene → Composer → SceneComposition → Cartographer → SceneMap (frozen) → Phaser`

**Golden rule:** LLMs propose in semantic terms (ids, anchors, zones); a deterministic layer
(Cartographer + renderer) owns geometry, identity and pixels. Generate-once-then-FREEZE.

**The test bench is the Scene Lab (`/lab`).** Every change below should be eyeballed there:
type a brief → real DM → Director → Cartographer → render, with the EstablishScene /
SceneComposition / SceneMap artifacts shown so you can see *which stage* is at fault.

---

## ✅ Phase A — Foundation (DONE)

- [x] Contract pipeline (EstablishScene → SceneComposition → SceneMap), frozen world graph, re-entry reuse.
- [x] **Single-source asset library** `assets/library.json` → Director vocab + renderer + extractor. Add an asset = one record + `npm run assets:extract`. Pack-aware extractor (`from.pack` + `copy`/`crop`/`gen`); terrain `variants:[{art,from}]` for per-cell variation.
- [x] **Scene Lab** harness (`/lab`, `POST /scene/lab`, `apps/server/src/scene-lab.ts`) with intermediate-artifact panels.
- [x] **CC0 art adoption** — Kenney "Tiny" trio (Tiny Town + Tiny Dungeon + Tiny Creatures), 16×16, cohesive, commercial-safe. Raw packs in `raw-packs/` (gitignored); Pixel Crawler kept at `raw-packs/pixel-crawler` for cherry-picking. ~46 tags: terrains, props, adventurers, **12 animals**, monsters. Sea **water generated** (`gen:water`).
- [x] **Wave-0 quality fixes:** camera frames real sprite overhang on both axes (no clipping / black band); Cartographer honors all base anchors incl. `center` (resolve-outward); per-tile terrain variation; anti-cluster placement spacing.
- [x] **Bug fixes (found via the Lab):** DM tag invention → `setScene` lists real tags + composer synonym resolver; tree-fallback-indoors → neutral `crate`; tree ambiance indoors → none; enclosed-interior placements collapsing to (0,0) → guaranteed walled-room-with-walkable-floor; dark night/interior tint → warm torchlit & legible; Phaser loader refill stall → `maxParallelDownloads:256`.
- [x] Deleted the deprecated VV-1.5 path (tiler/director/ops).

---

## ✅ Phase B — Buildings & town composition (DONE)

- [x] **B1 — Bake buildings** `house` generator in `scripts/extract-assets.py` composites cottages from Tiny Town tiles (roof gable + wall + door): `house_red/blue/grey/wood` (16×48) + `house_tall` 2-storey (16×64). Registered as ordinary footprinted props (zero renderer/cartographer change).
- [x] **B2 — Fountain + synonyms** `fountain` generator (2×2 stone basin + water + spout). `FIXTURE_SYNONYMS` now maps `house`/`cottage`/`inn`/`tavern`/`shop`→`house_*` and `fountain`/`well`→`fountain` (was falling to `crate`).
- [x] **B3 — `town-square` grammar** added to `world.ts` (zones plaza·center·market-row·building-row·street·waterside·perimeter·commons) + `cartographer.ts:zoneRects` + routed `biome=village/town/coast` in `composer.ts:grammarFor`. **Grammar is now structural (biome-derived), never LLM-chosen.**
- [x] **B4 — Composition intelligence** `townSquareDefault()` by tag: fountain→`center` (auto-anchored, lands at grid centre), houses→`building-row`, stalls→`market-row` (the 1-tall zone shape + anti-cluster spacing makes them line up — no `row-of:` needed yet). **`anchor` is now OPTIONAL** (FixtureDecl/NpcDecl) so the deterministic defaults are the floor when the DM doesn't pin a spot. Regression test in `composer.test.ts`.

**Exit met:** "a lively seaside village with houses all around, a market, animals, and a central square with a fountain" renders as exactly that (fountain centred + NPCs ringing it, cottages lining the square, sea below). Renderer also gained `footH`-aware anchoring so flat multi-tile props (the 2×2 fountain) sit correctly while tall cottages overhang upward.

**Deferred to a later pass (optional polish):** `row-of:`/`around:` explicit anchors for finer arrangement; more house variety / 2-wide buildings (paid-pack territory).

---

## ◑ Phase C — Terrain & rendering polish (durable subset DONE; art-specific deferred)

**Done (durable, art-agnostic — chosen over art polish since the paid pack will replace tiles):**
- [x] Deterministic **stone plaza** for town-squares (LLM can't erase it; grammar + structural terrain are biome-derived, not LLM-chosen).
- [x] Actors never claim `center` (reserved for the landmark) → no center-pile; spacing rings them around it.
- [x] **Label de-clutter** — animals/critters unlabelled.
- [x] **Calmer terrain** — fixed the stone edge-bar clutter (only the clean fill tile), weighted plain grass so flowers are occasional.

**Deferred until the paid pack lands (art-pack-specific, throwaway on Kenney):**
- [ ] **C1 — Autotiling / transitions** Kenney terrains include edge/corner tiles; emit a per-cell neighbor-aware frame (Cartographer computes an 8-neighbour mask → `tileFrames`/variant choice) so grass→dirt→sea get real edges/shorelines instead of hard rectangular seams. Add 1-tile seeded **coastline/edge jitter** in `zoneRects` so borders meander.
- [ ] **C2 — Ground decals** non-blocking scatter (pebbles, flowers, grass tufts, cracks) as a `decals` layer on `SceneMap`, seed-scattered onto open cells, drawn just above terrain. Adds "lived-in" floor detail.
- [ ] **C3 — Renderer hardening** camera geometry **mask** so any residual sprite overhang crops cleanly; finalize depth bands (terrain ≪ ambiance < prop < actor, no same-row ties); resize keeps framing.
- [ ] **C4 — Biome/lighting breadth** more terrains per biome (forest floor, cave, sand/beach, snow if needed); per-biome ambiance tags; dusk/night/torchlit tint review across biomes.

---

## ◑ Phase S — Spatial fidelity: the BLOCKOUT grid (THE NEXT BIG ARC)

**Problem (diagnosed 2026-06-17):** briefs with spatial intent — "path left→right horizontal", "thick treelines top+bottom", "party on the left" — render wrong because that intent has **nowhere to live** in the pipeline. `path` is hardcoded VERTICAL (`cartographer.ts`), trees are sparse "ambiance scatter" (cap 12, perimeter-biased, built to *not* read as forest), and the Director never even received the raw brief. Per-feature flags (pathOrientation, treelineThickness) = whack-a-mole; every new brief invents a new spatial relation.

**Decision — a coarse "blockout" grid as the Director's contract.** The Director paints a small (~16×9) grid: a **region tag per cell** (grass/path/water/forest/floor/wall) + each **entity on a coarse cell**. The Cartographer **deterministically upscales** it: each region → real terrain (reusing per-cell variants/autotiling), `forest` cells filled *densely* with trees (thickness = #rows painted), path = whatever cells were painted (**orientation emergent**, no flag), entities snap to the nearest walkable tile in their cell. Model owns composition; engine still owns every pixel. One representation kills orientation + treeline + grouping at once. Gate it: validate the blockout (in-bounds, path roughly contiguous, no entity off-grid) and fall back to today's zone path if invalid.

**Step 1 — isolate + measure (DONE 2026-06-17):**
- [x] **Director-direct mode** — `labComposeScene()` + `POST /scene/lab/compose` run Director+Cartographer from a supplied EstablishScene, NO DM (~2s vs ~14s). `/lab` shows the EstablishScene as an editable textarea + "Run Director only ▸". (The lab was routing every brief through the DM first — couldn't tell which stage failed.)
- [x] **Closed the input gap** — `CompositionRequest.directive` carries the raw brief; `composerPrompt` adds a "LAYOUT REQUEST (honor spatial intent…)" block.
- [x] **Spatial eval** — digest now renders a **top-down ASCII map** (so the judge can SEE layout; counts hid orientation) + cases `forest-horizontal-path`, `shore-side-orientation`. **Baseline: spatialSense 1.83 / legibility 2.67 / briefCoherence 2.67 / completeness 2.33** — the number the blockout must beat.
- Finding: biome→grammar too coarse (a wild beach "coast" routes to `town-square` like a harbor town) — more evidence the semantic layer is too lossy.

**Step 2 — build the blockout (DONE 2026-06-17):**
- [x] **S1 — Contract:** `SceneBlockout` (region grid `string[]` + `cells:[{id,col,row}]`) + `BLOCKOUT_CHARS` on `SceneComposition.blockout` (`packages/shared/src/world.ts`). Legend G/P/W/T/S/#.
- [x] **S2 — Director prompt** branches by grammar: open-outdoor → `outdoorBlockoutPrompt` (paint the grid + a cell per entity, honoring orientation/sides); structural grammars keep `zonePrompt`. `parseBlockout()` sanitizes the painted grid (pad/truncate, clamp cells, drop unknown chars) → falls back to the zone path if unusable.
- [x] **S3 — Cartographer upscaler:** `buildSceneMap` renders FROM the blockout when present — region chars → tiles, **dense tree fill** for `T` cells (weighted trees, treeline = barrier/non-walkable), entities snapped to the nearest walkable tile to their painted cell. The hardcoded vertical `path` no longer applies to painted scenes.
- [x] **S4 — Deterministic spatial gates** in scene-eval: `pathOrientation` (near-full dirt row/col) + `treelineEdges` (≥50% trees in the edge band). Live on `forest-horizontal-path` and PASSING. +2 unit tests (composer parse + cartographer render); 91 total.

**Result:** the forest brief that rendered a vertical path + sparse trees now renders a horizontal path with thick top/bottom treelines, party left, goblins+chest centre. Baseline rose **spatialSense 1.83→2.50, briefCoherence 2.67→3.17** (n=1, noisy). KNOWN: a wild "beach" still routes to town-square (biome→grammar coarseness) so it skips the blockout — separate fix.

**Step 3 / Lever A — reliable painting (DONE 2026-06-18):**
- [x] **Worked examples + size** in `outdoorBlockoutPrompt` — the old JSON sample was only 5 rows (the model copied it → squat grids); replaced with TWO full 12–13-row examples (a horizontal-path forest AND a right-side river, so orientation isn't biased) + a hard "≥12 rows, 18–24 cols" rule. Grids now come out ~20×12 instead of 20×9.
- [x] **Declutter** — `LAB_SYSTEM` now tells the DM NOT to list ambient terrain/vegetation as fixtures (the blockout's `T` owns forests); only notable objects + characters. The forest clearing is now clean grass (no scattered stray tree props); `forest-camp` dropped ~12→5 objects.
- [x] **Cast reliability** — `LAB_SYSTEM` now declares the player's referenced characters ("our three heroes", "the party") as visible npcs, since the lab has no separate party list (they were silently dropped before).
- Verified in `/lab`: clean 20×12 forest, thick treelines, horizontal path, 3 heroes left, goblins+chest centre. Eval gate green; judge scores flat within n=1 noise (wins are qualitative: clutter/size/cast, not rubric-weighted).

**Step 4 / Lever B — paint EVERYTHING + fix the routing (DONE 2026-06-18):**
- [x] **Scene-kind classifier** (`sceneKindOf`) replaces `grammarFor(biome)`: interior / settlement / wild, derived from the RAW brief. Crucially, settlement is decided from the **setting TEXT ONLY** (the `setScene` biome enum has no coast/beach/plains, so the DM dumps every outdoor place into "village" — that false token was making wild beaches render as town squares). `grammar = {interior:enclosed-interior, settlement:town-square, wild:open-outdoor}`.
- [x] **Blockout for ALL kinds** — `buildComposition` parses the blockout for every grammar (was open-outdoor only); the Cartographer's `useBlockout` renders any grammar from the painted grid. The deterministic zone layout remains the fallback when the paint fails to parse.
- [x] **Unified, kind-aware paint prompt** (`blockoutPrompt` + `KIND_GUIDE`) — one prompt with per-kind guidance + a worked example: wild (terrain bands/paths/treelines), settlement (paint ground S/G/P/W, place buildings + centre the landmark), interior (closed `#` room, `S` floor, back-wall feature). Replaced the old outdoor-only + zone prompts.
- [x] **Cartographer safety nets** — interiors: force a closed wall ring + normalise interior ground to stone floor (keep painted pillars), skip forest-fill indoors; settlements: a fountain/well is snapped to centre even if painted off-centre (preserves the square's read + the `fountainCentered` gate).
- **Result:** beach/coast/river now route to open-outdoor and paint water-on-a-side (the beach-as-town-square bug is GONE); crypts are real walled rooms with pillars/alcoves; villages keep a centred fountain + back-row houses. Eval all green; baseline rose to **spatialSense 3.33, legibility 2.83, briefCoherence 3.83, completeness 3.00** (from 2.50/2.50/3.17/2.67). 91 tests. Known art gap: no `sand`/`snow` terrain tile yet (beach "sand" renders as grass) — an asset-pack item, not layout.

**Step 5 / Lever C — intentional look (DONE 2026-06-18, art-agnostic):** uses the blockout's clean region boundaries, existing tiles only — no edge art needed.
- [x] **Feathered treelines** — forest fill is no longer uniform. A BFS computes each forest cell's depth (steps from the nearest OPEN cell; the map border does NOT count, so screen-edge treelines stay dense). Density gradients dense core (0.95) → 0.8 → bushy fringe (0.4); fringe cells favour bushes (`FRINGE` pool) vs the `CORE` tree pool. A treeline now reads as a natural mass thinning into the clearing, not a rectangle.
- [x] **Fringe spill** — a little undergrowth (bushes) creeps from the treeline into adjacent open grass (15%), reserved from placement (occ) so no one stands in a bush; tile stays walkable. Softens the hard forest→clearing edge.
- [x] **Shoreline band** — open LAND (grass) directly adjacent to water is laid as `dirt` (a 1-tile wet-sand/mud strip), so the waterline reads as a real shore (also gives beaches a sandy strip at the tideline). Skips forest cells + interiors.
- Verified in `/lab`: the forest's treelines visibly feather + spill; the beach has a dirt shoreline at the tideline. All deterministic (seed-stable), 91 tests still green. (Deeper Phase-C items — full autotiling/transitions C1, decal layer C2 — remain deferred to the cohesive-pack swap.)

## ◑ Phase F — Scalable composition (scene primitives) — STARTED 2026-06-18

A church test exposed the blockout's ceiling: "rows of benches" rendered as one element, walls were used for furniture, and stairs→chest. Root cause is representational (blockout = one declared thing → one cell → one object; one terrain channel; + raw asset gaps), NOT bugs. Strategy (assessed via a deep multi-agent pass, see memory [[visual-layer]]): a small CLOSED set of **object-field placement primitives** (region × {row|grid|ring|line|scatter|flank} over any catalog prop) the Director emits and the Cartographer expands into real id-addressed objects — generalizes "many of X arranged as Y" without per-keyword code. Honest ceiling: arrangement-generality reachable; arbitrary topology (spiral stairs, broken bridges, organic caves, multi-elevation, compound nested furniture) + ART COVERAGE are hard limits — aim for "macro composition matches, gaps degrade gracefully," not "any sentence → exact picture."

- [x] **Phase 0 — close art gaps + honest fallback (DONE 2026-06-18):** added 3 confident interior tiles from Kenney Tiny Dungeon — `stairs` (tile_0018), `altar` (tile_0041), `sarcophagus` (tile_0031) — plus FIXTURE_SYNONYMS for each (stair/altar/shrine/pulpit; sarcophag/coffin split out of the gravestone regex; pew→table). The unknown-tag fallback is now a neutral **`placeholder`** (Tiny Dungeon tile_0060, a dashed marker, `internal:true` so it's renderable+resolvable but NEVER advertised to the LLM via `PROMPT_PROPS`) instead of the misleading `crate`. Verified in `/lab`: the church now renders stairs (not a chest), a real altar with fire + flanking skeletons, statues/pews as sensible proxies. 91 tests. (No new layout logic — "rows of benches = one row" is the Phase-1 object-field work.)
- [x] **Phase 1 — object-field primitive (DONE 2026-06-18):** `ObjectField {idBase, kind, tag, region:{band|rect}, arrangement: row|grid|ring|line|scatter|flank, count?, spacing?}` on `SceneComposition.fields` (`world.ts` + `FIELD_LIMITS`); `MapObject.group` carries the idBase; `ENTITY_ID_PATTERN` widened for the `#NN` child suffix. The Cartographer (`buildSceneMap`) expands ONE field into N id-addressed children (`idBase#00…`, deterministic, seed-stable) — `regionRect` (band/rect) × `fieldTargets` (the 6 arrangements), snapped to free walkable cells, blocking props set walkable=false, runs AFTER point placement so actors keep walkable + `spacing≥2` leaves lanes. `validateComposition` validates fields and exempts a field-backed declared entity from the 1:1 rule; `composer.parseFields` sanitizes + `buildComposition` absorbs a declared id used as a field idBase (no double-place); `sceneDigest` collapses grouped children to "idBase ×N". Prompt: the Director emits `fields`, and folds a *plural* declared entity into a field with that entity's id. **Plus** the lab DM (`LAB_SYSTEM`) now declares repeated objects ONCE (not N copies) so they don't double-furnish. Verified `/lab`: the church renders real **rows of pews** (grid field) + statues as a **line** field, no duplicates. 95 tests; eval gate green. (Limit: regions are band/rect only — the named-region sublanguage + aisle carve-outs are Phase 2.)
- [x] **Phase 2 — region sublanguage (DONE 2026-06-18):** `ObjectField.region` gained **`near:<id>`** — a field laid out in a box centred on a placed landmark (half-extent flank=1/ring=2/else √count), so "candles ringing the altar" / "guards flanking the throne" compose *around* a fixture (unresolvable `near` degrades to band/rect/centre). Added **`aisle:'vertical'|'horizontal'`** — carves a clear central lane through a row/grid (pew halls), with an empty-result fallback. Added a **reachability guard** — any actor with no walkable orthogonal neighbour gets one opened (an *unoccupied* one), so a dense field never traps an actor. Group-collapsed digest from Phase 1 stands in for the "group abstraction"; group-aware SceneDelta waits on manipulation (Phase D). Adversarial-reviewed (determinism clean) and the HIGH findings fixed: `guaranteedCell` + the reachability guard now only carve **unoccupied** cells (no two-objects-on-a-cell). Verified `/lab`: a throne room renders guards flanking + **braziers ringing the throne** + benches either side of a central aisle. 104 tests; eval gate green (n=1 noise can dip a run — run `scene:eval` 2-3× to confirm). Deferred: per-child `faceToward` (invisible in static art); named-region registry (`rect`+`near` cover it).
- [ ] **Phase 3 — layer separation + autotiling** as edge/corner art lands (fidelity).
- More missing tiles (statue, pillar/column, pew art, multi-tile altar) ride the cohesive-pack track; until then they degrade to the placeholder or a DM-chosen proxy.

- [x] **Phase 3a — integration seam pass (DONE 2026-06-18):** the cheap, pack-durable system+trivial-art layer that an island/coast brief exposed. (1) **`shore` region** — the cartographer's shoreline is now captured as `shoreCells` (a ring on islands) and exposed as field `region:{band:'shore'}`, so "crates along the sandy shore" binds to the true waterline (was scattering in the grass). (2) **`sand` + `water_deep` terrains** (gen tiles) + **blockout legend chars `A` (sand) / `D` (deep/dark water)** → the shoreline now paints sand, and a "dark water zone" has somewhere to live. (3) **Platform concept** — `AssetEntry/PropDef.platform`; a `boat` prop (gen, 3×2, platform) is anchored ON water without snapping to land and forces its footprint walkable, so the party can stand on it over the sea (closes the "actors can't be on water" gap). Director prompt teaches D/A, `band:'shore'`, and the boat platform. Adversarially reviewed: **clean on all 3 dimensions** (determinism/invariants/robustness, 10 edge cases). 113 tests; eval gate green (on re-sample — see noise note). Verified `/lab`: the island brief now renders island+sand shore + crates-on-shore + bonfire/goblins/chest + a boat with the party on the far-left sea + a dark-water patch — every element of the brief, vs the original "no boat, no dark water, crates in grass".
- **Eval noise:** `scene:eval` is n=1 and the baseline was pinned on a lucky-high run, so a single run can transiently FAIL the gate then PASS on re-run (seen twice). Run `scene:eval` 2-3× before trusting a regression. → motivates **lever D** (n=3 de-noise + re-pin).

## Where we are now (assessed 2026-06-18)
Composition system is ~80-85% mature; the dominant ceiling on perceived quality is now **art coverage**, not placement logic. The seam pass spent the last cheap, pack-durable system headroom (shore/terrain-vocab/platform). **Next dominant lever = the cohesive pack** (acquire ONE paid base pack for palette/scale cohesion, then OFFLINE palette-locked diffusion for the long tail + transition tiles; both land via the same `library.json` re-point). Two surfaces must be rebuilt FOR scale, in this order: (a) Director tag **selection** — the full-catalog-in-prompt dump + regex resolver hit lost-in-the-middle at 200+ tags → move to retrieval/embedding + biome-aware resolution (mirrors the DM RAG seam); (b) **terrain-edge geometry** — real 8-neighbour autotiling (Phase C1), which only pays off once the pack ships edge/corner tiles (and without which a richer pack looks WORSE — hard seams). Do NOT swap a big pack in before (b). Avoid more pure-arrangement polish (ceiling is the palette now).

---

## ◐ Phase G — Compositional generation: from 3 templates to a primitive vocabulary (THE CURRENT ARC, 2026-06-20)

**Why (re-diagnosed 2026-06-20, after the city work + a "labyrinth / waterfall-lake" failure):** the generator is still a **phrasebook of 3 hard-coded layout templates** — `town-square` / `enclosed-interior` / `open-outdoor` (`LAYOUT_GRAMMARS`), chosen by keyword regex (`composer.ts:sceneKindOf`), each materialized as fixed rectangular zones (`cartographer.ts:zoneRects`). The blockout is only a partial escape (one terrain channel, flat walls, no maze connectivity). So any brief that isn't a town / room / open-field — a maze, a waterfall lake with islands+bridges, a multi-level ruin — has **nowhere to live** and degrades to a mess. **Adding a 4th/5th template per scene type is the treadmill we are explicitly rejecting.**

**The fix (deep research + adversarial red-team; see memory `scene-gen-strategy`):** replace the 3 templates with a small **vocabulary of composable spatial PRIMITIVES** — deterministic, seeded, region-scoped, **connectivity-correct by construction** (`maze`, `bspRooms`, `cave`, `water`, `island`, `bridge`, `voronoiDistricts`, `plaza`, `path`, `ring`, `scatter`, `carveRooms`, `coast`, `stamp`). A scene is an ordered **composition** of primitives, not a template. Generality is combinatorial: maze = `maze + entrance + landmark + scatter`; waterfall-lake = `water + island×3 + bridge + scatter`; city = `districts + plaza + rooms + streets`. **You add code per spatial *concept* (reused across every scene), never per *scene*.** ~90% of the deterministic helpers already exist (autotile, decals, reachability, placement, validators); `city.ts` is the existence-proof that re-composes them at $0.

**Hard design rules (from the red-team — do NOT violate):**
1. The LLM stays OUT of coordinates AND out of free topology authorship (documented 42–80% LLM spatial-reasoning collapse as topology rises). Its job: classify the brief → pick/compose primitives + a few scalar params + entity/landmark/terrain intent. (The Dungeon-Alchemist model: parametric procedural recipes, not generative maps.)
2. Connectivity BY CONSTRUCTION inside each primitive. `reachabilityCarve` is a rare last-resort safety net, NOT the contract (it bulldozes straight tunnels through a maze, destroying intent).
3. Freeze the resolved MAP (current behaviour), not a replayable program. Determinism is per-location, not per-brief.
4. Diffusion is for ART (offline asset factory), never for layout. Cheaper first: extract far more of the ~2000 DawnLike sprites we own (we use ~120).

**Plan, steps & expected results:**
- [ ] **G1 — Falsification spike (cheap, NO contract change). THE gate.** ~6–8 starter primitives behind a tiny interpreter (reusing the existing post-passes + `validateSceneMap`). Hand-write "gold" compositions for **4 deliberately diverse briefs — a waterfall lake with islands+bridges, a labyrinth, a market city, a multi-room crypt — from the SAME primitives, zero per-scene code**; confirm each renders valid + on-intent in `/lab`. Then have the LLM emit those compositions (structured output) and diff vs gold + a tiny spatial eval (~$1). **Expected result:** 4 structurally-different valid scenes from one system → the central bet is proven; OR the LLM can't compose reliably → fall back to *LLM-picks-recipe + params* (even more constrained) — and we learn that *before* the refactor. Either way the core risk is retired for ~$1.
- [ ] **G2 — Formalize (only if G1 passes; needs the held `world.ts` contract change, landed ADDITIVELY).** Extend `SceneComposition` with the primitive program; extract the full ~15-primitive vocabulary out of the 660-line `buildSceneMap`; a region resolver; the interpreter replaces the `zoneRects` switch; validate-and-repair at freeze. **The 3 grammars are NOT a backbone or a permanent fallback — they were MVP scaffolding.** During migration, the existing town/interior scenes are reproduced AS primitive *compositions* (a "town" = `districts + plaza + rooms + streets`), then `zoneRects`/`GRAMMAR_BY_KIND`/`sceneKindOf` are DELETED. End state: zero whole-map templates. **Expected result:** any brief → a composed scene; the 3-template ceiling is gone; cities / dungeons / mazes / waterfronts from ONE system; existing scenes reproduced as compositions; all current tests green.
- [ ] **G3 — Richness (parallel; the "looks hand-authored" axis).** (a, START NOW) extract far more existing DawnLike sprites → kills repetition cheaply; (b) a WFC / organic-fill primitive learned from the bundled DawnLike `.tmx` → organic cave/ruin texture; (c) a small hand-authored **fragment vault** (a `stamp` primitive: tavern-interior, maze-chunk, fountain-plaza, cave-mouth) → human-quality local detail; (d, later) the offline diffusion asset factory. **Expected result:** scenes read varied + authored, not flat/uniform.

**Decisions locked (2026-06-20):** extract more DawnLike art FIRST (before diffusion); HOLD the `world.ts` contract change until G1 proves the direction; the maze is NOT a goal — it's one of four diverse *test* briefs for a general system.

**SHIPPED 2026-06-20 (NOT committed) — the module engine reached the "consistent creativity" bar.** Built `packages/scene/src/primitives.ts` (Canvas + composable spatial primitives: maze/bspRooms/water/island/bridge/plaza/path/wallRing/**building**/**vignette**/place/scatter, connectivity-correct by construction) + `scene-program.ts` (a DATA `SceneOp[]` program + interpreter + `LlmSceneProgrammer` macro-director + a robust `normalizeProgram` firewall + a `BRIEF_CREATURES` completeness net). Engine path = Lab **"Primitives" mode** (the default), `POST /scene/program`. Landmark wins: (G2a) **furnished buildings restored** — extracted `furnishRoom` from `carveBuildings` (behavior-identical, classic path unchanged) so a `building` op carves a furnished room (furniture + keeper, one material); (G2b) **vignettes** — authored set-pieces (market/forge/camp/shrine/well/graveyard) kill "piled assets"; (G2c-core) **theme system** — one material palette per scene kills floor noise; (G3a) +40 DawnLike sprites + a generated `lava` tile. Verified in /lab: the market/fen-village/lava-temple briefs all render furnished, coherent, populated. **Deferred with reasons (see memory `scene-gen-strategy`):** grammar DELETION (the live DM pipeline depends on the classic path — would break the game), full ASCII marker-grid module format (FurnSpec templates already suffice), G2d connector-snapping (paths + reachabilityCarve already connect), and the WFC texture layer (research said gate it behind the modules). Tests: 208 green.

**Honest ceiling:** always-valid + playable by construction, but semantic intent-fidelity is bounded by LLM spatial reasoning (mitigated by presets / recipes / fragments / eval, not eliminated). Expect "clearly-procedural-but-coherent-and-varied" and — with G3 — "approaching authored," not "indistinguishable from hand-drawn."

---

## ◐ Phase H — ARCHETYPE GENERATORS: stop letting the LLM lay out the map (THE CURRENT ARC, 2026-06-21)

**Why:** even after the module engine, towns still rendered as a **spreadsheet of rectangular building boxes on a flat grass grid** (3 iterations, all the same failure) vs hand-crafted DawnLike refs (organic streets, varied footprints, a plaza, density). **Root cause (research workflow `wf_6323aed4-029`):** we made the **LLM the layout artist** — it places ~6 building rects and an LLM places them in an even grid. The reference tools (Watabou Medieval Fantasy City Generator, Parish-Müller) look good precisely *because* the magic is a deterministic layout **ALGORITHM**, not a brain. Plus our density was **white noise** (uniform %), which clumps+voids = litter.

**The fix:** demote the LLM to an **archetype + semantic-CONTENTS picker**; a deterministic `generator(canvas, ctx)` owns the organic composition. Everything below `finalize()` (renderer, validators, combat) is unchanged.

**SHIPPED 2026-06-21 (NOT committed) — town solved end-to-end, verified in /lab:**
- [x] **Two distribution primitives** (`primitives.ts`): `poissonScatter` (Bridson blue-noise — even spread for trees/lamps) + `noiseField`/`clumpScatter` (noise-threshold — cohesive flower-beds/thickets). Replaces white-noise scatter.
- [x] **`themes.ts`** — extracted Theme/THEMES/themeNameFor (no import cycle).
- [x] **`archetypes.ts`** — `ArchetypeGenerator` + `Contents` + a `GENERATORS` registry of 5 (town/dungeon/cave/wilderness/coast) + the `{op:'archetype'}` SceneOp (runOp + normalizeOp coercion).
- [x] **TOWN generator (the real algorithm):** irregular boundary → recursive-bisection **street network** (narrow lanes, jittered, connected by construction) → centroid **plaza** + well → OBB recursive **parcel subdivision** (soft random stop → varied lots) → **footprints** via existing `building()` (furnished + keeper), door faces nearest street, ward-zoned types, jittered setbacks → **two-texture density**.
- [x] **Town routing** in `normalizeProgram`: a settlement brief (not water-dominant) → `harvestTownContents` pulls the LLM's named cast + drops its geometry → ONE town archetype op (grid floored ≥54×40). Gold `town` program + `/lab` "▣ town" button. **230 tests.**
- [x] **Verified:** the gold town AND the user's own walled-town brief (Primitives mode) both render as a dense organic village — winding streets, ~16 varied-size buildings (big tavern + small huts + 2 stone civic), plaza+well, townsfolk, layered greenery. A decisive leap from the grid-of-boxes.

**COMPOUND-BUILDING DEEP-REFINE (2026-06-21, NOT committed) — per the user's gap analysis; learnings in `TOWN-BUILDER-NOTES.md`.** Buildings went from single open boxes → **multi-room compounds**: `compound()` subdivides the footprint into rooms (shared partition walls, a door carved at every split → connected by construction), each **furnished BY FUNCTION** (`ROOM_TEMPLATES` + `ROOM_PROGRAMS`: tavern = bar+dining+kitchen+bedroom, temple = nave+vestry+bedroom, …) with one keeper in the front room; large compounds get an **inner courtyard** (grass + fountain + flowers). Streets are now **cobblestone arteries + dirt alleys** (was all mud); buildings are **fewer/bigger** (a mix of cottages + compounds); greenery is **lusher** (tree groves + denser flower beds). 230 tests (asserts roomCount > buildingCount = real multi-room). **The generalizable recipe** (see `TOWN-BUILDER-NOTES.md`): recursive bisection at two scales (town→blocks→lots, lot→rooms) + furnish-by-function; biome-agnostic — only palette + topology primitive + room program change per archetype. Remaining town polish: `wall_wood` still flat; rectangular (not L-shaped) footprints; courtyard grass autotiles a dirt rim; 1-cell entrances.

**Honest ceiling (stated to the user):** reaches Watabou "Toy-Town" / Zelda-roguelike-**screen** quality (organic streets/lots/plaza/density), NOT a hand-authored artist map's bespoke set-pieces (~160 DawnLike sprites + rectangular furnished rooms). One screen tops ~20-40 buildings; a true city = stitch several organic screens (P4).

**Remaining (awaiting user's visual sign-off on the town first):**
- [ ] **P3 — route the other 4 archetypes.** dungeon/cave/wilderness/coast generators are built + registered + smoke-tested, but only TOWN is brief-routed + eyeballed; the others still render via the structure-net loose-op path. Route + eyeball them.
- [ ] **P4 — depth.** COAST is a placeholder (water+island blobs) → needs fBm + domain-warp shoreline + multi-band beach (research has the recipe); dungeon graph-grammar (lock-and-key, Unexplored-style); multi-screen city (stitch organic town-screens, replacing `city.ts`'s box-blitter).
- [ ] **Quality eval** (the standing "tests can't tell good from bad" gap) — a vision-model critic scoring rendered output (needs image support in the LLM seam).

---

## ◻ Phase D — Manipulation (DEFERRED until setup is great — user's call: "no manipulation yet")

The `SceneDelta` contract exists but is inert. When ready:
- [ ] `applyDelta(map, delta)` in the scene package (move/face/reveal/hide/setState/spawn/despawn/enter), resolving anchors to tiles — the deterministic owner.
- [ ] `sceneDelta` DM tool in the orchestrator (validated by `validateDelta`), applied to the current frozen map.
- [ ] Renderer **incremental** apply (tween move, fade-in reveal) keyed off the `actorObjs` registry (already populated, currently write-only).
- [ ] World-graph links/entrances on `enter` (the `Entrance.fixtureId` field is ready).

---

## ◻ Phase E — Quality, evals & cleanup

- [x] **Scene evals** — `apps/server/src/scene-eval/` (cases + rubric + runner) + `npm run scene:eval[:update]`. Runs each brief through the real DM→Director→Cartographer, checks **deterministic invariants** (grammar, brief-tag coverage, fountain-centred, no-pile, actors-walkable, valid map) AND an **LLM judge** (spatialSense/legibility/briefCoherence/completeness, 0–5) vs a pinned `baseline.json` gate. First baseline pinned (~2.5–3.3/5 — honest interim composition; the number now MOVES as we improve). Caught a real catalog gap (no sarcophagus tile → gravestone) on first run.
- [x] **Regression tests** for town-square invariants (composer + scene-eval unit tests; 89 total).
- [ ] **Cleanup:** remove the now-unused `apps/web/public/assets/pixelcrawler/` served files; refresh `SCENE-CONTRACTS.md` (image-based terrain, Kenney art, `town-square` grammar, gen assets); prune dead `scene.ts` types if any remain.
- [ ] **Cohesive-pack readiness (hybrid — paid AND/OR diffusion):** the interim CC0 tiles get replaced by a cohesive pack. Options, not mutually exclusive: (a) **acquire** a paid pack; (b) **generate** one offline with a pixel-art-specialised diffusion model/API (Retro Diffusion rd-tile/rd-plus, PixelLab — true palette-locked 16px tiles, Wang/dual-grid tilesets, 4/8-dir sprites); (c) **enhance** an acquired pack with diffusion (fill gaps, add variants/transitions). All three are the SAME data op: re-point each tag's `art`/`from`/geometry in `library.json` + `assets:extract` (contracts unchanged — proven by the Kenney swap). Diffusion stays OFFLINE + human-curated; it never touches the runtime layout/geometry. (Assessed 2026-06-18: diffusion belongs at the art + preview layer, never as the layout brain — it *consumes* the blockout, it can't author it. Optional later: an img2img/ControlNet "establishing shot" rendered FROM the frozen SceneMap, shown beside the playable tile map, cached per location, never read back.)

---

## Smaller known TODOs / watch-items

- Composer still places some props loosely (e.g. many fences scattered on a plaza) — Phase B4 spacing/row logic should tame this.
- `maxParallelDownloads:256` loads all tiles in one batch (fine ≤ a few hundred tiles); if the catalog grows large, pack tiles into atlases instead.
- Kenney Tiny art is static (no idle animation); the renderer keeps spritesheet/animation support for when animated art returns (e.g. a real animated fountain/bonfire).
- `slice-atlas.py` (alpha-bbox slicer) + the `gen` extractor hook are the tools for adding/【cropping】 new art fast.

## How to add an asset (reminder)
1. Add one record to `assets/library.json` (with a `from`: `{pack, copy}` or `{pack, crop, rect}` or `{gen}`).
2. `npm run assets:extract`.
3. It's live in the Director's vocabulary **and** the renderer (no sync). If the DM uses a near-miss word, add a line to `composer.ts:FIXTURE_SYNONYMS` / `LOOK_SYNONYMS`.
