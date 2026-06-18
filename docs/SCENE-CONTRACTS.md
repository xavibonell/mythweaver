# Scene Contracts (DM → UI Director → Cartographer → object_map)

The typed artifacts that cross the actor boundaries of the visual layer, and the **two
checks** each carries: deterministic **invariants** (unit tests) and graded **quality**
(LLM-judge evals). Types live in [`packages/shared/src/world.ts`](../packages/shared/src/world.ts);
validators in [`packages/shared/src/world-validate.ts`](../packages/shared/src/world-validate.ts).

```
 DM ──EstablishScene──► Director ──SceneComposition──► Cartographer ──SceneMap──► [FREEZE] ──► Phaser
   (A: schema + eval)     (B: invariant + eval)        (C: pure invariants)        (D: snapshot)

 manipulation (later):  DM ──SceneDelta──► engine ──(resolve + mutate object_map)──► Phaser tweens
```

## Principles

1. **LLMs propose in semantic space; the deterministic layer owns geometry, identity, memory.** The LLMs emit ids, anchors and zones — never coordinates (mirrors the rules engine, spec §4.1).
2. **Everything is a stable id.** Locations (`loc:*`) and entities (`npc:edda`, `bldg:bell-tower`, `prop:well`, `pc:aldric`, `mob:orc-1`) are addressed by id — the consistency anchor.
3. **Generate-once, freeze.** On first entry a location is generated, resolved to a `SceneMap`, and **frozen** into the world graph. Re-entry reuses it; turns mutate by delta; nothing re-rolls. This is how a fully-procedural world stays consistent.
4. **Only two surfaces are LLM-judged** (A: the DM's fiction, B: the Director's arrangement). Everything downstream (C, D) is deterministic and unit-tested.

## The four nouns

| # | Artifact | Producer → Consumer | Meaning |
|---|---|---|---|
| 1 | **`EstablishScene`** | DM → Director | the *fiction*: which fixtures/NPCs exist + semantic anchors (no coords) |
| 2 | **`SceneComposition`** | Director → Cartographer | semantic *layout*: grammar, grid, terrain regions, every entity assigned to a zone |
| 3 | **`SceneMap`** | Cartographer → **freeze** | the canonical **object_map**: resolved tiles + id-keyed `objects[]` (+ visibility, entrances) |
| 4 | **`SceneDelta`** | DM → engine | manipulation: `move/face/reveal/hide/spawn/despawn/setState/enter` |

`SceneMap` is "the UI map of the scenery" — note the Director does **not** draw it; it proposes the arrangement and the deterministic Cartographer resolves it to tiles. That split is what makes positions consistent, legal, and testable.

## Test/eval surface per boundary

### A · `EstablishScene` (DM)
- **Invariants** (`validateEstablishScene`): ids unique + well-formed (`<prefix>:<slug>`, prefix ∈ bldg/prop/npc); tags ∈ catalog; anchors valid form; **no coordinates**; biome ∈ catalog; `timeOfDay` ∈ day/dusk/night; npc `visible` is boolean; npc names non-empty.
- **Eval** (judge 0–5): `narrative-fidelity` (fixtures/NPCs match the prose + the beat), `completeness` (story-critical NPC declared), `visibility-correctness` (lurkers are `visible:false`).
- **Test how:** script the DM with `FakeLlmProvider` over a fixed beat → assert the call shape. Golden corpus of `(beat → expected entities)` → judge.

### B · `SceneComposition` (Director)
- **Invariants** (`validateComposition`): `biome` ∈ catalog; `lighting` ∈ day/dusk/night; every declared entity **and** party member placed **exactly once** (none dropped/dup/extra); each placement's `tag` ∈ catalog and `kind`/`role` agree with the id prefix; zones ∈ grammar zones; grid within `GRID_LIMITS`; terrain + ambiance tags ∈ catalog; density ∈ [0,1].
- **Eval** (judge 0–5): `spatial-sense` (dock at waterside, buildings not stacked, party grouped), `legibility`, `brief-coherence`.
- **Test how:** `FakeLlmProvider` returns a canned composition → assert invariants. Real-model run over the golden corpus → judge. (Director runs once per location → the corpus is stable.)

### C · `SceneMap` (Cartographer — deterministic, **no eval**)
- **Invariants** (`validateSceneMap`): `tiles`/`walkable` dims == grid; `feetPerTile == FEET_PER_TILE`; `locationId` well-formed (`loc:`); `lighting` ∈ day/dusk/night; `biome` ∈ catalog (when supplied); every object in-bounds (footprint fits); footprints ≥ 1×1; **fixtures never overlap**; **actors walkable across their whole footprint**; `kind`/`role` agree with the id prefix; entrances on walkable cells; ids unique; actors have a role (non-actors don't); ambiance in-bounds; tiles non-empty.
- **Plus determinism:** same `SceneComposition` + seed → byte-identical `SceneMap`.
- **Test how:** plain vitest on hand-built + resolver-produced maps. This layer is the consistency guarantor — it earns full deterministic coverage.

### D · Phaser render
- **Invariant (snapshot):** every `visible` object has resolved art; hidden objects are *not* drawn; depth order matches row; tweens resolve by id.

## Semantic anchor vocabulary

A coordinate-free placement hint. One of:
- a **base anchor**: `center`, `north[/-edge]`, `south[/-edge]`, `east[/-edge]`, `west[/-edge]`, `waterside`, `entrance`;
- **relational**: `near:<entityId>` ("by the well");
- **zone**: `in:<zone>` where zone ∈ the grammar's zones.

**Layout grammars** (structural, *not* authored maps — start with two, grow):
- `open-outdoor` → zones: `commons`, `perimeter`, `waterside`, `building-row`, `path`
- `enclosed-interior` → zones: `floor`, `back`, `entrance`, `wall`

> **Base anchors are grammar-agnostic hints.** The DM emits anchors at *establish*, before a grammar is chosen, so it uses base anchors (+ `near:<id>`); the Director resolves them per the grammar it picks (a `waterside` hint in an interior just falls back). `in:<zone>` is grammar-scoped (validated against that grammar's zones) and is the Director's tool, not the DM's. `waterside`/`entrance` deliberately appear in both namespaces for this reason.

## World model & lifecycle

- **`WorldState`** = `{ currentLocationId, locations: Record<LocationId, SceneMap>, links }` — a graph of frozen locations; engine-owned, persisted in `GameState`.
- **Establish** (once per new location): DM → Director → Cartographer → freeze into `locations`. The only time the Director (LLM) runs.
- **Animate** (every turn within a location): DM emits `SceneDelta[]` → engine resolves anchors→tiles and **mutates the object_map in place** (no LLM, no re-layout) → renderer tweens. Nothing teleports.
- **Digest back to the DM** (`SceneDigest`): a compact view of the frozen map so the DM narrates *from truth*, closing the loop (world → narration → deltas → world).
- **Seed** is derived deterministically from `locationId` → same place, same ambiance, reproducibly, with nothing authored.

## Manipulation (shaped now, wired later)

`SceneDelta` operates on the **same object_map and ids** produced at establish — which is why establish must emit stable ids + a delta-mutable structure (it does). Key calls:
- `move{id, to: anchor|tile}` → resolve → update `objects[id].col/row` → tween.
- `reveal{id}` → flip `visible:false→true` (the lurker was in the map all along → consistent, not a fresh spawn).
- `enter{id, toLocationId, via?}` → location transition via the world graph (target a `toLocationId` from the digest's exits; `via` names the fixture/door traversed).
Deltas need **no LLM** — the DM issues the op, the engine applies it deterministically.

> **Non-render hints (e.g. `NpcDecl.disposition`)** are establish-time fiction that flow to **engine-side memory** (or `MapObject.state.*`), *not* first-class `SceneMap` fields — the object_map holds geometry/identity/visibility only, never rules state (no HP, faction, etc.).

## Migration map (current runtime → these contracts)

The contracts are **additive**; the live VV-1.5 runtime still uses the older `scene.ts` types. Mapping for the implementation phase:

| Current (`scene.ts`) | Contract (`world.ts`) | Note |
|---|---|---|
| `setScene` tool (setting + npcs) | `EstablishScene` | gains stable fixture/NPC ids + visibility |
| `SceneIntent` | `SceneComposition` | semantic; Director output |
| `SceneState` | `SceneMap` | adds id-keyed `objects[]`, visibility, entrances, grammar |
| `SceneState.terrain` (`string[][]`) | `SceneMap.tiles` (`string[][]`) | ⚠️ the floor-art layer is **renamed** `terrain`→`tiles` (renderer must read `tiles`) |
| `SceneState.tiles` (`number[][]`) + `TILE_WALL`/`TILE_FLOOR` | **dropped** | ⚠️ `walkable` is now the sole collision layer |
| `SceneState.actors[]` | `SceneMap.objects[]` (kind:`actor`) | fixtures/props now first-class objects |
| `SceneOp` (move/face) | `SceneDelta` | superset (reveal/hide/spawn/despawn/setState/enter) |
| (none) | `WorldState` | persistent location graph + freeze |

## Eval harness integration (spec §10)

- New eval dimensions (`SCENE_EVAL_DIMENSIONS`): surface A (`establish`) and surface B (`composition`), judged over a golden corpus.
- Surfaces C/D are vitest invariant suites (deterministic) that run on every commit.
- Net: a **consistency** regression fails a unit test; a **quality** regression drops an eval score.
