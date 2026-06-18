# MythWeaver — Visual Vertical Strategy

> The plan for the graphical layer. Companion to [MythWeaver-Dev-Spec.md](MythWeaver-Dev-Spec.md).
> Status: **VV-0** (this slice) building the seam; later phases below.

## Vision

A **Sea of Stars–style HD pixel-art** game layer. The **game drives everything**: scenes are
**procedurally assembled tile-by-tile** from a **labeled asset library**; characters **move, emote,
and speak in bubbles**; players supply only **story inputs** (text now → audio later). A separate
**Scene Director** model composes and mutates the scene as a **tool the DM brain calls**. The **tile
grid doubles as the tactical grid** (1 tile = 5 ft), so visuals and combat are one spatial model.
Occasional full-screen art for wow moments; player menus (journal/sheet/level-up/shop) come later.

## Decisions

| Axis | Decision |
|---|---|
| Visual form | Videogame-like (scene + map + actors), read-only scenery; players act via story inputs |
| Assets | Free OSS pixel-art for the PoC → later hybrid (buy + AI in-style); labeling schema designed now |
| Scene assembly | **Fully procedural** — Director emits *intent*, a **deterministic tiler** builds the tilemap |
| Composition | **DM brain narrates + calls a separate Scene Director model as a tool** (setup + live updates) |
| Combat space | **Tiles = tactical grid**, 1 tile = 5 ft, engine-enforced (unifies with P2 combat) |
| Camera | **Full top-down orthogonal** (decided for the PoC; not pursuing 3/4) |
| Engine | **Phaser 3** (browser) |

**Camera rationale:** 3/4 makes *procedural* maps much harder (depth-sort, wall/elevation tiles,
occlusion, taller sprites). Top-down keeps **world grid = tile grid 1:1** (clean autotiling, collision,
pathing, tactics). We keep **logical grid coords separate from screen projection**, so moving to 3/4
later is an art + render change, not a rewrite.

**Engine rationale:** Phaser ships tilemaps, sprite animation, camera, tweens, input, pixel-art mode —
weeks faster than rebuilding those on PixiJS for a tilemap+sprites renderer driven by scene-state.

## Architecture — three testable pieces

```
DM brain (turn loop)  --calls tool-->  setScene(hint) / updateScene(ops)
        │
        ▼
Scene Director (separate LLM; structured output; schema-validated)   ── emits SceneIntent / SceneOp
        │
        ▼
Deterministic Tiler (pure, seeded, unit-tested)                      ── SceneIntent -> SceneState (tilemap + collision + actor grid-positions)
        │
        ▼
SceneState (persisted in GameState; tile = 5 ft shared spatial model)
        │
        ▼
Phaser client (browser)                                             ── renders tilemap + sprites; tweens move/emote/bubble
```

**Separation:** the DM doesn't draw; the Director doesn't narrate; the **Tiler is deterministic code**
(the LLM never emits raw tile arrays — the reliability win). The Director is a tool in the existing
agentic loop → **traced in Langfuse** and gets its **own eval dimension** (scene coherence) in the harness.
The grid **unifies with P2 combat** — they become one build.

### Contracts (see `packages/shared/src/scene.ts`)
- **`SceneIntent`** (Director → Tiler): biome, grid size, `rooms` (rects), `corridors`, `props`, `actors`
  (placement by cell or room, facing, bubble/emote). High-level; no raw tiles.
- **`SceneState`** (Tiler → renderer): `tiles[row][col]`, `walkable[row][col]`, `props`, `actors`
  (grid col/row, facing, anim, emote, bubble), `grid.feetPerTile = 5`.
- **`SceneOp`** (live updates, VV-1): `move` / `emote` / `bubble` / `face`.
- **`SceneDirector`** (`packages/scene/src/director.ts`): `setScene(req) -> SceneIntent`. `FakeSceneDirector`
  (deterministic, for tests + the slice) and `LlmSceneDirector` (real model) implement it.

### Asset library (labeling schema)
A **tileset manifest** (per-tile: id, tags/biome, walkable) and a **sprite manifest** (per-sprite:
tag, animations, emote set). VV-0 uses **runtime-generated placeholder pixel art** so the pipeline is
provable with zero external assets; real OSS/bought/AI art drops in behind the same manifest.

## Route

- **VV-0 (this slice):** the contracts + a deterministic tiler (one biome) + a `setScene` tool wired
  into the DM loop (Fake Director) + a Phaser client rendering one procedurally-built room with 2
  animated sprites + a speech bubble, over placeholder art. Proves the whole seam end-to-end.
- **VV-1 (shipped):** multiple biomes; scene transitions; live `updateScene` ops tweened during play.
  Transport is **request/response** (no SSE/WebSocket): each turn returns the full scene on a
  transition (`setScene`) and `sceneOps` deltas otherwise, which the client tweens. Streaming is
  deferred to when narration tokens stream — pair them then.
- **VV-1.5 (shipped):** **populated, coherent scenes.** The Scene Director is now **catalog-aware**:
  the DM calls `setScene` with a structured BRIEF (`setting` + `timeOfDay` + the `npcs` present), and
  the Director composes a full-screen scene from an asset CATALOG — a terrain layer (grass/dirt/stone
  /water for fens), scattered props (trees, bonfire), and actors (party + named NPCs + foes). A
  dusk/night tint sets the mood. Both a deterministic `FakeSceneDirector` (no-API) and a real
  `LlmSceneDirector` (picks from the catalog) implement the seam. Speech bubbles/emotes were scrapped
  — `updateScene` is **move/face** only now.
- **VV-2:** tile-grid **tactical combat** (move/range/LoS, tile↔feet) — folds in P2 combat + combat view.
- **VV-3:** asset maturation (OSS + bought + AI-in-style), labeling at scale, Director eval dimension.
- **VV-4:** player menus (journal/sheet/level-up/shop) + audio I/O.

## Risks & mitigations
- **Procedural coherence** → intent→tiler with seeded generation + room-rect guardrails; stress full
  procedural, fall back to templates only if needed.
- **Asset consistency** → OSS placeholders first; manifest designed for swap-in.
- **Director latency/cost** → separate (cheaper) model; pre-generate the next likely scene async; cache.
- **Perspective creep** → top-down locked for now; logical grid is camera-agnostic so 3/4 stays reachable.

## Asset pipeline (live)

Real art is wired in (Pixel Crawler Free Pack, Anokolisa). The system speaks in **logical tags** —
the DM/Director never touch file paths. Two halves stay in sync by tag:

- **The catalog** [`packages/scene/src/catalog.ts`](../packages/scene/src/catalog.ts) — the vocabulary
  the Director composes with: `TERRAINS` (grass/dirt/stone/water), `PROPS` (tree_*, bonfire), and
  `CHARACTERS` (knight/wizard/rogue/villager/orc/skeleton), each with a description + footprint. The
  Director is fed this in its prompt and may only emit these tags.
- **The manifest** [`apps/web/app/play/manifest.ts`](../apps/web/app/play/manifest.ts) — resolves each
  tag to pixels: `TERRAIN_TILES` (tag → tileset frame), `PROP_ART` (image or animated spritesheet),
  `SPRITES` (idle sheets). **To add or re-point art, edit only these two files (keep tags in sync).**
- **Who emits tags:** `classToSpriteTag()` maps a PC class → sprite tag (stamped on `Combatant.spriteTag`);
  the Director maps NPC roles → sprite tags and chooses terrain/props from the brief. Unknown tags warn
  and fall back (`DEFAULT_SPRITE` / grass / dungeon).
- **Finding tile coordinates:** packed tilesets are addressed by frame index (`row*cols + col`); use
  `python3 scripts/tilegrid.py <sheet.png>` for a numbered overlay. Current picks: grass 126, dirt 281,
  stone 67 (Floors_Tiles), water 55 (Water_Tiles), wall 58 (Wall_Tiles).
- **Assets on disk:** curated subset under `apps/web/public/assets/pixelcrawler/` (tilesets/, npc/,
  props/); the raw pack is gitignored. License permits commercial use *within* a project; the pack
  itself can't be resold.
- **Deferred:** modular buildings (`Structures/Buildings/` Walls/Roofs/Floors) and fences (`Farm`) are
  packed atlases needing sub-tile indexing + house-assembly — next pass; for now villages are evoked
  with terrain + trees + bonfire + scattered NPCs.
