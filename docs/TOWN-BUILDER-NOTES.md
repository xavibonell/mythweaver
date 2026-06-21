# Town builder — process learnings (2026-06-21)

How we got the `town` archetype from a "spreadsheet of boxes" to a dense, composed medieval village,
and **what generalizes** so the other archetypes (dungeon / cave / wilderness / coast) can follow the
same recipe. This is the scalability assessment the work was meant to produce.

## The core insight (do not relearn this)

**The map looks "designed" when a deterministic ALGORITHM owns spatial composition — the LLM never
places geometry.** Hand-crafted DawnLike / Watabou-quality maps come from layout algorithms, not a
smarter prompt. The LLM is demoted to an **archetype + semantic-CONTENTS picker** (which buildings/NPCs
exist, names, theme); a `generator(canvas, ctx)` owns streets, parcels, footprints, rooms, density.

## The pattern that worked: recursive subdivision at TWO scales + furnish-by-function

The town is **recursive bisection applied twice**, which is the whole trick:

1. **Town → blocks → lots** (`townGen`, `archetypes.ts`): recursive-bisection street network (cut the
   longer axis at a jittered position, carve a street, recurse) → blocks; then OBB parcel subdivision
   inside each block (soft random stop → varied lot sizes) → lots.
2. **Lot → rooms** (`compound`, `primitives.ts`): the SAME recursive bisection inside a building
   footprint, with shared partition walls and **a door carved at every split** (so the room graph is a
   connected spanning tree BY CONSTRUCTION).
3. **Room → furniture by FUNCTION** (`ROOM_TEMPLATES` + `ROOM_PROGRAMS`, `cartographer.ts`): each room
   is assigned a function from the building type's program (tavern → bar/dining/kitchen/bedroom; temple
   → nave/vestry/bedroom) and furnished by that function's recipe (a bedroom has beds, a bar has a
   back-wall counter, a nave has an altar + rug + pews). ONE keeper in the primary (front) room.

Everything reuses the existing `furnishRoom` (furniture-placement selectors back/corner/center/wall/
around) — we just call it **per room** with a function-specific template instead of once per building.

### Levers that mattered (tuned by eyeballing, not in the abstract)

| Lever | Value | Why |
|---|---|---|
| `MIN_BLOCK` | 15 | bigger blocks → bigger lots → room to subdivide into compounds |
| `minLot / maxLot` | 6 / 18 | wide range → a mix of small cottages and big multi-room compounds |
| street width | arteries 2, alleys 1 | wide streets flood the map with dirt and read as a muddy field |
| street material | `cobblestone` arteries, `dirt` alleys | paved lanes, not all mud — the single biggest "cheap" win |
| `compound` room target | `interiorArea / 20` | how readily a footprint splits into rooms |
| courtyard | big compound, 55% | one back room → open grass + fountain + flowers ("inner garden") |
| density | Poisson (spread) + noise-clump (beds), `flowers` threshold 0.52 | two deliberate textures, not white-noise litter |

## What generalizes to the other archetypes (the scalability answer)

The recipe is **biome-agnostic**; only three things change per archetype:

1. **Palette** — the `Theme` (ground/path/plaza/wall material). Already data.
2. **Topology primitive** — town uses bisection-streets; dungeon uses `bspRooms`/graph-grammar; cave
   uses cellular-automata `cave`; wilderness uses `clearing` + noise; coast uses an fBm shoreline. These
   already exist as primitives.
3. **Room functions** — `ROOM_TEMPLATES` + `ROOM_PROGRAMS` is the reusable furnishing layer. A dungeon
   gets a dungeon program (guardroom / cell / shrine / treasury / barracks); the `compound` multi-room +
   door-carving + furnish-by-function machinery is **identical**.

Reusable primitives now in place for ALL archetypes: `compound` (multi-room furnished building),
`poissonScatter` (blue-noise spread), `clumpScatter` (noise-threshold beds), `noiseField`, the
two-scale recursive subdivision, and the `furnishRoom` selector system. **A new archetype = a generator
that sequences these + a palette + a room program. No per-scene code.**

## Honest remaining gaps (town polish, next iteration)

- **`wall_wood` is still flat** — wood buildings read flatter than stone (which has DawnLike depth-walls).
  Repoint `wall_wood` to a DawnLike wood-wall depth block (needs grounded rects from Wall.png).
- **Footprints are rectangular compounds**, not true L-shapes. Multi-room + courtyard gives the
  "compound" read; true L/courtyard-around footprints are a later refinement (merge adjacent lots).
- **Courtyard grass autotiles a dirt rim** inside the walls (cosmetic) — could use a dedicated garden
  floor or skip the bake inside buildings.
- **Cobblestone texture reads slightly busy** at the artery width; a calmer paving variant would help.
- **Entrances are a 1-cell gap** — grand buildings could get a 2-wide gate / porch / steps for variety.
- **Quality is eyeballed, not measured** — the standing "tests check validity, not quality" gap; a
  vision-model critic is the real fix (needs image support in the LLM seam).

## Iteration tooling: the Component contact sheet (Scene Lab → "Component" mode)

To iterate a single micro-generator without rebuilding a whole town: Scene Lab → **Component** mode →
pick a kind (`building:tavern`, `vignette:forge`, `density:trees`, `plaza`, `streets`, `cave`, …) → it
renders **N seed-varied instances tiled in a grid** on one canvas. **↻ reshuffle** for new variations.
Deterministic, no LLM ($0). This is the fast eyeball-and-tune loop for the *decoupled* components
(buildings, vignettes, density, topology) — the rich parts you actually iterate. The *relational* layer
(street/parcel placement) is still judged in the full-town view (▣ town), since it only means something
as the whole. The contact sheet is also the substrate a future vision-model quality critic would score.

Code: `packages/scene/src/component-lab.ts` (`buildComponentSheet` + `COMPONENT_KINDS`), route
`POST /scene/component`, Lab mode in `apps/web/app/lab/page.tsx`.

## Where the code lives

- `packages/scene/src/archetypes.ts` — `townGen` (streets → parcels → footprints → density → cast) +
  the `GENERATORS` registry.
- `packages/scene/src/primitives.ts` — `compound` (multi-room building), `poissonScatter`,
  `clumpScatter`, `noiseField`.
- `packages/scene/src/cartographer.ts` — `furnishRoom` (shared), `BUILDING_TEMPLATES`, `ROOM_TEMPLATES`,
  `ROOM_PROGRAMS`.
- `packages/scene/src/scene-program.ts` — `{op:'archetype'}` + town routing (`harvestTownContents`).
- Tests: `packages/scene/src/archetypes.test.ts` (valid / reachable / deterministic / multi-room /
  cobbled / routing / all-5-generators).
