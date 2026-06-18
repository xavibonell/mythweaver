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
