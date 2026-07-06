/**
 * Scene PROGRAM (city-scope Phase G1 spike) — a scene is an ordered, DATA-driven COMPOSITION of
 * primitives (scene-program is the interpreter; primitives.ts is the vocabulary). This is the unit
 * that replaces the 3 fixed grammars: a small primitive set + composition = unbounded scenes.
 *
 * The program is plain DATA (a list of ops) on purpose — the same shape an LLM will emit in G1's
 * second half. Here we hand-write GOLD programs for 4 deliberately diverse briefs (labyrinth /
 * waterfall-lake / market-city / crypt) to prove the vocabulary can EXPRESS them all from ONE system,
 * with zero per-scene code. `buildSpikeScene(name)` runs one and returns a frozen SceneMap.
 */

import type { LlmProvider } from '@mythweaver/llm';
import { BIOMES, BUILDING_TYPES, LAYOUT_GRAMMARS, type BuildingType, type LayoutGrammar, type Lighting, type SceneKindHint, type SceneMap } from '@mythweaver/shared';
import { ARCHETYPE_KINDS, GENERATORS, type ArchetypeKind, type Contents } from './archetypes.js';
import { isCharacter, isProp, isTerrain } from './catalog.js';
import { bridge, building, Canvas, bspRooms, cave, clearing, entrance, fill, finalize, island, maze, path, place, plaza, scatter, vignette, VIGNETTE_NAMES, wallRing, type Pt, type Rect } from './primitives.js';
import { THEMES, themeNameFor, type Theme } from './themes.js';

type RegionSpec = 'all' | Rect;
type PtSpec = Pt | 'center' | 'north' | 'south' | 'east' | 'west';

export type SceneOp =
  | { op: 'fill'; region: RegionSpec; tag: string; walkable?: boolean }
  | { op: 'island'; region: RegionSpec; tag?: string }
  | { op: 'bridge'; from: PtSpec; to: PtSpec; tag?: string }
  | { op: 'path'; from: PtSpec; to: PtSpec; tag?: string }
  | { op: 'plaza'; region: RegionSpec; tag?: string }
  | { op: 'maze'; region: RegionSpec; wall?: string; floor?: string }
  | { op: 'cave'; region: RegionSpec; wall?: string; floor?: string }
  | { op: 'clearing'; region: RegionSpec }
  | { op: 'rooms'; region: RegionSpec; count?: number; wall?: string; floor?: string }
  | { op: 'wallRing'; mat?: 'wood' | 'stone' }
  | { op: 'building'; type: BuildingType; region: RegionSpec; door?: 'north' | 'south' | 'east' | 'west'; name?: string; id: string }
  | { op: 'vignette'; type: string; at: PtSpec; id: string }
  | { op: 'place'; id: string; tag: string; kind: 'fixture' | 'prop' | 'actor'; role?: 'pc' | 'npc' | 'mob'; at: PtSpec; name?: string; visible?: boolean }
  | { op: 'scatter'; idBase: string; tags: string[]; kind: 'prop' | 'actor'; role?: 'pc' | 'npc' | 'mob'; region: RegionSpec; count: number }
  | { op: 'entrance'; at: PtSpec }
  /** Run a whole ARCHETYPE GENERATOR over the canvas (the LLM picks the kind + semantic Contents; the
   *  deterministic generator owns the organic layout). Replaces LLM-placed building rects for these. */
  | { op: 'archetype'; kind: ArchetypeKind; contents: Contents };

export interface SceneProgram {
  locationId: string;
  cols: number;
  rows: number;
  seed: number;
  base?: string;
  biome: string;
  lighting: Lighting;
  grammar: LayoutGrammar; // cosmetic for the SceneMap (digest); geometry comes from the ops, not this
  outdoor: boolean; // gates the terrain auto-tile bake + decal scatter
  /** Theme key (one material palette for the whole scene). Set by normalizeProgram on the LLM path;
   *  absent on the hand-written GOLD programs (which keep their explicit per-op tags). */
  theme?: string;
  ops: SceneOp[];
}

const resolveRegion = (cv: Canvas, spec: RegionSpec): Rect => (spec === 'all' ? { x: 0, y: 0, w: cv.cols, h: cv.rows } : spec);
const resolvePt = (cv: Canvas, spec: PtSpec): Pt => {
  if (typeof spec !== 'string') return spec;
  const mc = Math.floor(cv.cols / 2);
  const mr = Math.floor(cv.rows / 2);
  switch (spec) {
    case 'center': return { c: mc, r: mr };
    case 'north': return { c: mc, r: 0 };
    case 'south': return { c: mc, r: cv.rows - 1 };
    case 'west': return { c: 0, r: mr };
    case 'east': return { c: cv.cols - 1, r: mr };
  }
};

/** Run one op against the canvas. When `theme` is set, OPEN-GROUND ops draw their material from it
 *  (hazards water/lava/sand keep their own tag) — the per-scene material-consistency guarantee. */
function runOp(cv: Canvas, op: SceneOp, locationId: string, theme?: Theme): void {
  const haz = (t: string) => t === 'water' || t === 'water_deep' || t === 'lava' || t === 'sand' || t === 'rock';
  const wmat = (): 'wall' | 'wall_wood' => (theme && theme.wallMat === 'wood' ? 'wall_wood' : 'wall');
  switch (op.op) {
    case 'fill': fill(cv, resolveRegion(cv, op.region), theme && !haz(op.tag) ? theme.ground : op.tag, op.walkable); break;
    case 'island': island(cv, resolveRegion(cv, op.region), theme ? theme.ground : op.tag); break;
    case 'bridge': bridge(cv, resolvePt(cv, op.from), resolvePt(cv, op.to), op.tag); break;
    case 'path': path(cv, resolvePt(cv, op.from), resolvePt(cv, op.to), theme ? theme.path : op.tag); break;
    case 'plaza': plaza(cv, resolveRegion(cv, op.region), theme ? theme.plaza : op.tag); break;
    case 'maze': maze(cv, resolveRegion(cv, op.region), theme ? wmat() : op.wall, theme ? theme.ground : op.floor); break;
    case 'cave': cave(cv, resolveRegion(cv, op.region), theme ? wmat() : op.wall, theme ? theme.plaza : op.floor); break;
    case 'clearing': clearing(cv, resolveRegion(cv, op.region)); break;
    case 'rooms': bspRooms(cv, resolveRegion(cv, op.region), op.count, theme ? wmat() : op.wall, theme ? theme.plaza : op.floor); break;
    case 'wallRing': wallRing(cv, op.mat, locationId); break;
    case 'building': building(cv, resolveRegion(cv, op.region), op.type, { ...(op.door ? { door: op.door } : {}), locationId, ...(op.name ? { name: op.name } : {}), id: op.id }); break;
    case 'vignette': vignette(cv, resolvePt(cv, op.at), op.type, op.id.includes(':') ? op.id.slice(op.id.indexOf(':') + 1) : op.id); break;
    case 'place': place(cv, { id: op.id, tag: op.tag, kind: op.kind, ...(op.role ? { role: op.role } : {}), at: resolvePt(cv, op.at), ...(op.name ? { name: op.name } : {}), ...(op.visible !== undefined ? { visible: op.visible } : {}) }); break;
    case 'scatter': scatter(cv, { idBase: op.idBase, tags: op.tags, kind: op.kind, ...(op.role ? { role: op.role } : {}), region: resolveRegion(cv, op.region), count: op.count }); break;
    case 'entrance': entrance(cv, resolvePt(cv, op.at), locationId); break;
    case 'archetype': GENERATORS[op.kind](cv, { theme: theme ?? THEMES.village!, contents: op.contents, bounds: { x: 0, y: 0, w: cv.cols, h: cv.rows }, locationId }); break;
  }
}

/** Interpret a SceneProgram → a frozen, validated-by-construction SceneMap. */
export function runProgram(prog: SceneProgram): SceneMap {
  const theme = prog.theme ? THEMES[prog.theme] : undefined;
  const cv = new Canvas(Math.max(1, prog.cols), Math.max(1, prog.rows), prog.seed, theme ? theme.ground : prog.base ?? 'grass');
  for (const op of prog.ops) runOp(cv, op, prog.locationId, theme);
  return finalize(cv, { locationId: prog.locationId, biome: prog.biome, lighting: prog.lighting, grammar: prog.grammar, outdoor: prog.outdoor });
}

// ---------------------------------------------------------------------------
// GOLD programs — 4 deliberately diverse briefs, ALL from the same primitives, NO per-scene code.
// ---------------------------------------------------------------------------

/** "A tenebrous labyrinth of grass and stone, full of skeletons and goblins, entrance at the left,
 *  a huge fountain with a chest at the centre." Maze (connectivity-correct) + a central chamber + a
 *  main corridor from the west entrance + the landmark + monster scatter. */
const LABYRINTH: SceneProgram = {
  locationId: 'loc:gold-labyrinth', cols: 41, rows: 27, seed: 101, biome: 'dungeon', lighting: 'night', grammar: 'enclosed-interior', outdoor: false,
  ops: [
    { op: 'maze', region: 'all', wall: 'wall', floor: 'flagstone' }, // a STONE labyrinth, not a grass hedge maze
    { op: 'plaza', region: { x: 17, y: 11, w: 7, h: 5 }, tag: 'flagstone' }, // the central chamber
    { op: 'path', from: 'west', to: 'center', tag: 'flagstone' }, // main corridor: entrance → centre (guarantees connectivity)
    { op: 'entrance', at: 'west' },
    { op: 'place', id: 'prop:fountain', tag: 'fountain', kind: 'prop', at: 'center', name: 'a huge fountain' },
    { op: 'place', id: 'prop:hoard', tag: 'chest', kind: 'prop', at: { c: 22, r: 13 } },
    { op: 'scatter', idBase: 'mob:skeleton', tags: ['skeleton'], kind: 'actor', role: 'mob', region: 'all', count: 7 },
    { op: 'scatter', idBase: 'mob:goblin', tags: ['goblin'], kind: 'actor', role: 'mob', region: 'all', count: 6 },
  ],
};

/** "A waterfall lake with islands and bridges." Water everywhere, a deep cascade band, 3 islands
 *  linked by plank bridges, a fisher + a chest, reeds/trees on the islands. */
const WATERFALL_LAKE: SceneProgram = {
  locationId: 'loc:gold-lake', cols: 40, rows: 26, seed: 202, biome: 'forest', lighting: 'day', grammar: 'open-outdoor', outdoor: true,
  ops: [
    { op: 'fill', region: 'all', tag: 'water', walkable: false },
    { op: 'fill', region: { x: 16, y: 0, w: 8, h: 3 }, tag: 'water_deep', walkable: false }, // the falls cascade at the top
    { op: 'island', region: { x: 3, y: 6, w: 12, h: 10 }, tag: 'grass' },
    { op: 'island', region: { x: 24, y: 4, w: 12, h: 9 }, tag: 'grass' },
    { op: 'island', region: { x: 14, y: 15, w: 13, h: 9 }, tag: 'grass' },
    { op: 'bridge', from: { c: 13, r: 11 }, to: { c: 27, r: 8 }, tag: 'wood_floor' }, // isle 1 → isle 2
    { op: 'bridge', from: { c: 29, r: 11 }, to: { c: 21, r: 18 }, tag: 'wood_floor' }, // isle 2 → isle 3
    { op: 'place', id: 'npc:fisher', tag: 'villager_woman', kind: 'actor', role: 'npc', at: { c: 8, r: 10 }, name: 'a lone fisher' },
    { op: 'place', id: 'prop:cache', tag: 'chest', kind: 'prop', at: { c: 30, r: 8 } },
    { op: 'scatter', idBase: 'prop:reeds', tags: ['bush', 'tree'], kind: 'prop', region: 'all', count: 16 },
  ],
};

/** "A walled market city." Grass base, building clusters top + bottom, a central stone plaza with a
 *  fountain, dirt streets to it, townsfolk, greenery, and an outer wall with gates. */
const MARKET_CITY: SceneProgram = {
  locationId: 'loc:gold-city', cols: 52, rows: 34, seed: 303, biome: 'village', lighting: 'day', grammar: 'town-square', outdoor: true,
  ops: [
    { op: 'rooms', region: { x: 4, y: 3, w: 44, h: 9 }, count: 4, wall: 'wall_wood', floor: 'wood_floor' }, // building row (top)
    { op: 'rooms', region: { x: 4, y: 22, w: 44, h: 9 }, count: 4, wall: 'wall_wood', floor: 'wood_floor' }, // building row (bottom)
    { op: 'plaza', region: { x: 20, y: 14, w: 12, h: 6 }, tag: 'stone' },
    { op: 'place', id: 'prop:well', tag: 'fountain', kind: 'prop', at: 'center', name: 'the town fountain' },
    { op: 'path', from: 'north', to: 'center', tag: 'dirt' },
    { op: 'path', from: 'south', to: 'center', tag: 'dirt' },
    { op: 'path', from: 'west', to: 'center', tag: 'dirt' },
    { op: 'path', from: 'east', to: 'center', tag: 'dirt' },
    { op: 'scatter', idBase: 'npc:folk', tags: ['villager', 'villager_woman', 'knight'], kind: 'actor', role: 'npc', region: { x: 18, y: 13, w: 16, h: 8 }, count: 6 },
    { op: 'scatter', idBase: 'prop:tree', tags: ['tree', 'bush', 'flowers'], kind: 'prop', region: 'all', count: 24 },
    { op: 'wallRing', mat: 'stone' },
  ],
};

/** "A torchlit crypt: many chambers, a sarcophagus, an altar, skeletons; entrance at the south." BSP
 *  rooms+corridors (connected), interior (no autotile), monsters + landmarks placed into rooms. */
const CRYPT: SceneProgram = {
  locationId: 'loc:gold-crypt', cols: 38, rows: 26, seed: 404, biome: 'cave', lighting: 'night', grammar: 'enclosed-interior', outdoor: false,
  ops: [
    { op: 'rooms', region: 'all', count: 6, wall: 'wall', floor: 'flagstone' },
    { op: 'place', id: 'prop:altar', tag: 'altar', kind: 'prop', at: 'north', name: 'a blood-stained altar' },
    { op: 'place', id: 'prop:cand-l', tag: 'candelabra_large', kind: 'prop', at: { c: 16, r: 3 } },
    { op: 'place', id: 'prop:cand-r', tag: 'candelabra_large', kind: 'prop', at: { c: 21, r: 3 } },
    // rows of sarcophagi — the defining feature of a crypt
    ...[8, 14, 20, 26].flatMap((c, i) => [10, 16].map((r, j) => ({ op: 'place' as const, id: `prop:tomb-${i}-${j}`, tag: 'sarcophagus', kind: 'prop' as const, at: { c, r } }))),
    { op: 'scatter', idBase: 'prop:bones', tags: ['bones', 'skull', 'urn'], kind: 'prop', region: 'all', count: 10 },
    { op: 'place', id: 'prop:hoard', tag: 'chest', kind: 'prop', at: 'east' },
    { op: 'entrance', at: 'south' },
    { op: 'scatter', idBase: 'mob:skeleton', tags: ['skeleton', 'zombie'], kind: 'actor', role: 'mob', region: 'all', count: 7 },
  ],
};

/** "A small walled town" — the ARCHETYPE-GENERATOR path. ONE op: the LLM (here, hand-written) supplies
 *  only the semantic cast; the deterministic townGen owns the organic streets, parcels, varied
 *  footprints, plaza and density. This is the A/B against MARKET_CITY's grid-of-boxes. */
const TOWN: SceneProgram = {
  locationId: 'loc:gold-town', cols: 60, rows: 44, seed: 717, biome: 'village', lighting: 'day', grammar: 'town-square', outdoor: true, theme: 'village',
  ops: [
    {
      op: 'archetype', kind: 'town', contents: {
        buildings: [
          { type: 'tavern', name: 'the Gilded Stag' },
          { type: 'temple', name: 'a shrine to the Dawnfather' },
          { type: 'smithy', name: 'the smithy' },
          { type: 'shop', name: 'the general store' },
          { type: 'house' }, { type: 'house' }, { type: 'house' }, { type: 'house' },
        ],
        landmarks: [{ tag: 'fountain', name: 'the town well' }],
        npcs: [{ tag: 'villager' }, { tag: 'villager_woman' }, { tag: 'knight', name: 'a town guard' }, { tag: 'villager' }],
        mobs: [],
        wall: true,
        entranceSide: 'south',
      },
    },
  ],
};

export const GOLD_PROGRAMS: Record<string, SceneProgram> = {
  labyrinth: LABYRINTH,
  lake: WATERFALL_LAKE,
  city: MARKET_CITY,
  town: TOWN,
  crypt: CRYPT,
};

/** Build one gold scene by name (the deterministic half of the G1 spike). */
export function buildSpikeScene(name: string): SceneMap {
  const prog = GOLD_PROGRAMS[name] ?? LABYRINTH;
  return runProgram(prog);
}

// ---------------------------------------------------------------------------
// G1b — the LLM SCENE PROGRAMMER. The LLM does NOT place cells; it COMPOSES a program over the
// primitive vocabulary (the creativity test). Robust-by-construction: the model's JSON is UNTRUSTED;
// normalizeProgram clamps the grid, validates/repairs every op (tags → catalog, ids → kind-correct +
// unique, regions/points coerced), and guarantees a runnable program even from garbage. runProgram
// then yields a valid SceneMap by construction.
// ---------------------------------------------------------------------------

export const SCENE_PROGRAMMER_SYSTEM = `You design a TOP-DOWN tactical RPG scene by writing a PROGRAM: an ordered list of spatial OPS over a tile grid. Deterministic code RUNS your ops — it guarantees connectivity and legal placement — so you NEVER draw pixels or worry about reachability. You compose the STRUCTURE. Output ONLY JSON:
{"cols":40,"rows":26,"theme":"village","biome":"forest","lighting":"night","grammar":"open-outdoor","outdoor":true,"ops":[ ... ]}

GRID: cols 28-60, rows 18-40. outdoor=true for nature/settlements (blends grass/water edges); false for indoor dungeons/crypts.
THEME (REQUIRED): pick ONE that fits the mood — village | forest | swamp | dungeon | crypt | cave | desert | lava. It sets ONE coherent floor/wall palette for the WHOLE scene, so you do NOT pick ground/floor tags per op (the engine fills ground/path/plaza/room-floors from the theme). Only specify a tag for a HAZARD region (water / water_deep / lava) — everything else is themed automatically.

OPS (compose 4-12; later ops draw OVER earlier ones):
- {"op":"fill","region":R,"tag":TERRAIN} — flood a region with terrain (use tag "water" for a lake/moat).
- {"op":"island","region":R,"tag":"grass"} — a rounded LAND blob inside water.
- {"op":"bridge","from":P,"to":P} — a walkable plank span (link islands, cross water/a chasm).
- {"op":"path","from":P,"to":P,"tag":"dirt"} — a walkable road/trail.
- {"op":"plaza","region":R,"tag":"stone"} — a paved open square.
- {"op":"maze","region":R,"wall":"wall","floor":"grass"} — a connected MAZE of twisting corridors.
- {"op":"cave","region":R} — an ORGANIC cavern with irregular rock walls + open floor (cellular-automata). USE THIS for caves / caverns / grottos / mines / underground lairs instead of rooms — it gives natural rocky shapes, not rectangles.
- {"op":"clearing","region":R} — a FOREST CLEARING: a dense feathered treeline ringing an OPEN centre (with a bushy fringe). USE THIS for forest clearings / glades / groves / camps in the woods — then put the bonfire/landmark + party in the open centre (NOT a uniform tree scatter). Pair with a "vignette":"camp" at the centre for a campfire.
- {"op":"rooms","region":R,"count":6,"wall":"wall","floor":"stone"} — connected ROOMS + corridors (a dungeon / building interior).
- {"op":"building","type":"tavern","region":{"x":,"y":,"w":,"h":},"door":"south"} — a FURNISHED walled building. type is one of: house, shop, tavern, inn, temple, cathedral, smithy, workshop, general_store, library, courthouse, jail, keep, barracks, armory, guildhall, manor, vault, tomb, curio, goblin_warren. The engine fills each with its DEFINING furniture (altar/forge/bar/bookshelves/cells/throne/racks…) + a keeper. USE THIS for ANY structure, home, shop, temple, forge, or distinct furnished chamber — give it a rect region (min ~6x6). Use the EXACT type for every establishment the brief names (church/chapel→temple, blacksmith→smithy, town hall→courthouse, castle/fort→keep) — NEVER substitute a generic house/shop for a named establishment.
- {"op":"vignette","type":"market","at":P} — an authored SET-PIECE cluster (type: market | forge | camp | shrine | well | graveyard): the engine drops a coherent mini-scene (market = stalls+crates+barrels+a vendor; forge = fire+workbench+weapon-rack+smith; camp = fire+bedrolls+supplies; shrine = altar+candles+statues; well = well+bench; graveyard = tombstones+bones). Use these for open-area focal points — do NOT hand-scatter loose props to fake them.
- {"op":"wallRing","mat":"stone"} — an outer defensive wall with gates (a walled town/fort).
- {"op":"place","id":"prop:NAME","tag":TAG,"kind":"prop","at":P,"name":"..."} — ONE landmark/object (or kind "actor","role":"npc"|"mob" for one creature).
- {"op":"scatter","idBase":"mob:NAME","tags":[TAG,...],"kind":"actor","role":"mob","region":R,"count":8} — MANY of something (monsters, trees, rubble, crowds).
- {"op":"entrance","at":P} — a walkable entrance/exit at the brief's stated edge.

REGION R = "all" OR {"x":,"y":,"w":,"h":} in tiles. POINT P = {"c":,"r":} OR "center"/"north"/"south"/"east"/"west".
TERRAIN tags: grass, dirt, stone, cobblestone, flagstone, stone_brick, sand, water, water_deep, lava, wall, wall_wood, wood_floor.
PROP tags (kind prop) — pick the ones that FIT the scene's theme:
  furniture: table, table_round, chair, stone_bench, desk, throne, bed, bed_blue, shelf, shelf_wares, shelf_food, bookshelf, bookshelf_full, books, rug, rug_ornate
  containers/clutter: chest, barrel, crate, pot, jar, urn, sack, woodpile
  light/shrine: brazier, candelabra, candelabra_large, candle, torch_wall, altar, fountain
  dungeon/ruin: statue, statue_knight, weapon_rack, cage, door_wood, stairs, stairs_down, rubble, bones, skull, cobweb
  graveyard: gravestone, tombstone, tombstone_skull, sarcophagus
  outdoor: tree, tree_pine, tree_autumn, bush, flowers, mushroom, fence, signpost, market_stall
CREATURE tags (kind actor): skeleton, zombie, goblin, orc, slime, spider, wolf, dragon, villager, villager_woman, knight, wizard, ranger, rogue, dwarf, cow, sheep, dog, cat, chicken, duck, horse, deer, frog, rabbit, crab, goat.

RULES:
- HONOR THE BRIEF literally: pick ONE dominant topology op for the GROUND (maze for labyrinths; fill water + island + bridge for lakes/coasts; grass/dirt + streets for towns; one big rooms op for a sprawling many-cell dungeon), THEN place FURNISHED structures with "building" ops, layer landmarks via place, creatures via scatter, paths, and the entrance where stated.
- BUILDINGS/CHAMBERS — THIS IS HOW YOU GET FURNISHED INTERIORS: every named building, home, shop, temple, forge, hut, OR distinct furnished room/chamber MUST be a "building" op with a rect region (it comes furnished + a keeper). A settlement = 3-8 "building" ops spread on a grass field with dirt streets between them, optionally a wallRing — NOT bare rooms/fills (those are empty boxes). Every establishment the brief NAMES gets its own building op with its EXACT type (a library brief → type "library", a courthouse → "courthouse", a keep → "keep"); fill remaining slots with house/shop/tavern flavour. A multi-chamber temple/crypt = several "building" ops (e.g. type temple/house as the chambers) connected by paths. Reserve the bare "rooms" op for a LARGE sprawling dungeon backbone only.
- INCLUDE EVERY creature and landmark the brief names — never drop them. Each creature is an op with a "mob:"/"npc:" id (hostiles = mob:, friendlies = npc:); each landmark a "place" with a "prop:" id. If the brief says "crocodiles and a cultist", you MUST emit a scatter "mob:crocodile" AND a place "npc:cultist".
- HAZARD terrain (water, lava) is IMPASSABLE. Keep the MAJORITY of the map WALKABLE — hazard should cover at most ~40% of the grid. For a "flooded"/"lake"/"swamp" scene, make the islands LARGE and MANY (land covers most of the map), with water only in the channels between them, and bridges across. Never strand the entrance, a landmark, or the creatures on hazard — they need walkable ground.
- For an INTERIOR (crypt/dungeon/temple/cave/vault) set "outdoor":false and grammar "enclosed-interior". For "interconnected rooms/chambers" prefer SEVERAL "building" ops (furnished chambers, type temple/house/shop) connected by "path" ops — that gives furnished rooms with keepers. Only for a HUGE sprawling maze-dungeon use one big "rooms" op as the backbone. Do NOT fill big "plaza"/open areas over your rooms (that erases them into an empty hall).
- ids: prop:xxx for objects, npc:xxx for friendly creatures, mob:xxx for hostile ones (the engine repairs prefixes if you slip).
- Choose evocative cols/rows + biome + lighting that match the mood.

EXAMPLE — "a tenebrous labyrinth of grass and stone, skeletons and goblins, entrance left, a fountain with a chest at the centre":
{"cols":41,"rows":27,"theme":"forest","biome":"forest","lighting":"night","grammar":"open-outdoor","outdoor":true,"ops":[
{"op":"maze","region":"all"},
{"op":"plaza","region":{"x":17,"y":11,"w":7,"h":5}},
{"op":"path","from":"west","to":"center"},
{"op":"entrance","at":"west"},
{"op":"place","id":"prop:fountain","tag":"fountain","kind":"prop","at":"center"},
{"op":"place","id":"prop:hoard","tag":"chest","kind":"prop","at":{"c":22,"r":13}},
{"op":"scatter","idBase":"mob:skeleton","tags":["skeleton"],"kind":"actor","role":"mob","region":"all","count":7},
{"op":"scatter","idBase":"mob:goblin","tags":["goblin"],"kind":"actor","role":"mob","region":"all","count":6}]}

EXAMPLE — "a market village: a tavern, a smithy, two cottages around a well, a merchant and a guard":
{"cols":44,"rows":30,"theme":"village","biome":"village","lighting":"day","grammar":"town-square","outdoor":true,"ops":[
{"op":"building","type":"tavern","region":{"x":4,"y":3,"w":11,"h":9},"door":"south","id":"bldg:tavern"},
{"op":"building","type":"smithy","region":{"x":29,"y":3,"w":11,"h":9},"door":"south","id":"bldg:smithy"},
{"op":"building","type":"house","region":{"x":5,"y":18,"w":9,"h":9},"door":"north","id":"bldg:cottage1"},
{"op":"building","type":"house","region":{"x":30,"y":18,"w":9,"h":9},"door":"north","id":"bldg:cottage2"},
{"op":"plaza","region":{"x":18,"y":12,"w":8,"h":7}},
{"op":"place","id":"prop:well","tag":"fountain","kind":"prop","at":"center"},
{"op":"vignette","type":"market","at":{"c":20,"r":20}},
{"op":"path","from":"north","to":"center"},{"op":"path","from":"south","to":"center"},
{"op":"place","id":"npc:merchant","tag":"villager","kind":"actor","role":"npc","at":{"c":19,"r":21}},
{"op":"place","id":"npc:guard","tag":"knight","kind":"actor","role":"npc","at":{"c":24,"r":15}},
{"op":"scatter","idBase":"prop:tree","tags":["tree","bush","flowers"],"kind":"prop","region":"all","count":16}]}

EXAMPLE — "a flooded lake of grassy islands joined by plank bridges, a lone fisher, reeds":
{"cols":40,"rows":26,"theme":"forest","biome":"forest","lighting":"day","grammar":"open-outdoor","outdoor":true,"ops":[
{"op":"fill","region":"all","tag":"water"},
{"op":"island","region":{"x":3,"y":6,"w":12,"h":10}},
{"op":"island","region":{"x":24,"y":4,"w":12,"h":9}},
{"op":"island","region":{"x":14,"y":15,"w":13,"h":9}},
{"op":"bridge","from":{"c":13,"r":11},"to":{"c":27,"r":8}},
{"op":"bridge","from":{"c":29,"r":11},"to":{"c":21,"r":18}},
{"op":"place","id":"npc:fisher","tag":"villager_woman","kind":"actor","role":"npc","at":{"c":8,"r":10}},
{"op":"scatter","idBase":"prop:reeds","tags":["bush","tree"],"kind":"prop","region":"all","count":14}]}

Now design the scene for the player's brief. Output ONLY the JSON.`;

const asRec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : d);
const terrainOr = (v: unknown, d: string): string => (typeof v === 'string' && isTerrain(v) ? v : d);
const propOr = (v: unknown): string => (typeof v === 'string' && isProp(v) ? v : isProp('placeholder') ? 'placeholder' : 'crate');
const charOr = (v: unknown): string => (typeof v === 'string' && isCharacter(v) ? v : 'villager');

/** Map any structure word → a BuildingType the furnishing engine has a template for. */
function buildingTypeFor(v: unknown): BuildingType {
  const s = (typeof v === 'string' ? v : '').toLowerCase();
  // specific NEW types first, so an inn/cathedral/jail/vault/general-store gets its own slice, not a fallback.
  if (/\b(inn|lodging|hostel)\b/.test(s)) return 'inn';
  if (/tavern|alehouse|pub|tap.?house|lodge/.test(s)) return 'tavern';
  if (/smith|forge|foundry|anvil|blacksmith/.test(s)) return 'smithy';
  if (/cathedral|minster|basilica|abbey|monastery/.test(s)) return 'cathedral';
  if (/temple|shrine|chapel|church|sanctuary|altar/.test(s)) return 'temple';
  if (/jail|gaol|prison|cell.?block/.test(s)) return 'jail';
  if (/vault|treasury|strong.?room|hoard|reliquary/.test(s)) return 'vault';
  if (/keep|castle|fortress|citadel|great.?hall|throne/.test(s)) return 'keep';
  if (/library|archive|scriptorium|bookshop|study/.test(s)) return 'library';
  if (/armou?ry|arsenal|guard.?house|watch.?post/.test(s)) return 'armory';
  if (/barracks|garrison|dormitory|bunk/.test(s)) return 'barracks';
  if (/guild.?hall|guild.?house/.test(s)) return 'guildhall';
  if (/goblin|warren|kobold|orc.?(camp|lair|den)|monster.?(lair|den)|lair|den/.test(s)) return 'goblin_warren';
  if (/manor|estate|mansion|villa|chateau/.test(s)) return 'manor';
  if (/tomb|mausoleum|crypt|sepulchre|sepulcher|barrow|catacomb/.test(s)) return 'tomb';
  if (/court.?house|court.?room|moot.?hall|town.?hall|magistrate/.test(s)) return 'courthouse';
  if (/workshop|carpenter|joiner|cooper|wright|fletcher/.test(s)) return 'workshop';
  if (/curio|pawn.?shop|oddities|curiosity|fence/.test(s)) return 'curio';
  if (/general.?store|provisioner|trading.?post|apothecary|emporium|sundr/.test(s)) return 'general_store';
  if (/shop|store|market|bakery|stall|butcher|tailor/.test(s)) return 'shop';
  if ((BUILDING_TYPES as readonly string[]).includes(s)) return s as BuildingType;
  return 'house';
}

/** Coerce the (untrusted) Contents of an archetype op: building types, landmark/creature tags clamped
 *  to the catalog, counts bounded. The generator owns geometry, so there is nothing spatial to repair. */
function normContents(v: unknown): Contents {
  const r = asRec(v);
  const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
  const name = (o: Record<string, unknown>) => (typeof o.name === 'string' ? { name: o.name.slice(0, 60) } : {});
  const side = r.entranceSide;
  return {
    buildings: arr(r.buildings).slice(0, 24).map((b) => { const o = asRec(b); return { type: buildingTypeFor(o.type ?? o.tag ?? o.kind), ...name(o) }; }),
    landmarks: arr(r.landmarks).slice(0, 12).map((l) => { const o = asRec(l); return { tag: propOr(o.tag ?? o.type), ...name(o) }; }),
    npcs: arr(r.npcs).slice(0, 20).map((n) => { const o = asRec(n); return { tag: charOr(o.tag ?? o.type), ...name(o) }; }),
    mobs: arr(r.mobs).slice(0, 12).map((m) => { const o = asRec(m); return { tag: charOr(o.tag ?? o.type), count: Math.max(1, Math.min(20, num(o.count, 4))) }; }),
    ...(typeof r.wall === 'boolean' ? { wall: r.wall } : {}),
    ...(typeof r.canal === 'boolean' ? { canal: r.canal } : {}),
    ...(typeof r.coast === 'boolean' ? { coast: r.coast } : {}),
    ...(typeof r.mountain === 'boolean' ? { mountain: r.mountain } : {}),
    ...(typeof r.port === 'boolean' ? { port: r.port } : {}),
    ...(typeof r.mine === 'boolean' ? { mine: r.mine } : {}),
    ...(typeof r.character === 'string' && ['mining', 'port', 'market', 'civic', 'rough'].includes(r.character) ? { character: r.character as Contents['character'] } : {}),
    ...(side === 'north' || side === 'south' || side === 'east' || side === 'west' ? { entranceSide: side } : {}),
  };
}

const EDGE_PTS = ['center', 'north', 'south', 'east', 'west'];
function normRegion(v: unknown): RegionSpec {
  if (v === 'all') return 'all';
  const r = asRec(v);
  if (['x', 'y', 'w', 'h'].every((k) => typeof r[k] === 'number')) return { x: num(r.x, 0), y: num(r.y, 0), w: Math.max(1, num(r.w, 1)), h: Math.max(1, num(r.h, 1)) };
  return 'all';
}
function normPt(v: unknown): PtSpec {
  if (typeof v === 'string' && EDGE_PTS.includes(v)) return v as PtSpec;
  const r = asRec(v);
  if (typeof r.c === 'number' && typeof r.r === 'number') return { c: num(r.c, 0), r: num(r.r, 0) };
  return 'center';
}
function fixId(raw: unknown, kind: string, role?: string): string {
  const want = kind === 'actor' ? (role === 'mob' ? 'mob' : role === 'pc' ? 'pc' : 'npc') : kind === 'fixture' ? 'bldg' : 'prop';
  let slug = typeof raw === 'string' ? (raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw) : 'x';
  slug = slug.replace(/#.*/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
  return `${want}:${slug}`;
}
function uniqueId(id: string, seen: Set<string>): string {
  let x = id;
  let n = 2;
  while (seen.has(x)) x = `${id}-${n++}`;
  seen.add(x);
  return x;
}

/** Determine kind+role primarily from the id PREFIX (mob:/npc:/pc: → actor, bldg: → fixture, prop: →
 *  prop) — the prompt teaches these prefixes reliably, so this catches creatures the model emitted
 *  WITHOUT an explicit "kind":"actor" (which otherwise default to props and never appear as actors). */
function kindRoleFrom(rawId: unknown, explicitKind: unknown, explicitRole: unknown): { kind: 'actor' | 'prop' | 'fixture'; role?: 'npc' | 'mob' | 'pc' } {
  const id = typeof rawId === 'string' ? rawId : '';
  const pref = id.includes(':') ? id.slice(0, id.indexOf(':')).toLowerCase() : '';
  let kind: 'actor' | 'prop' | 'fixture';
  if (pref === 'npc' || pref === 'mob' || pref === 'pc') kind = 'actor';
  else if (pref === 'bldg') kind = 'fixture';
  else if (pref === 'prop') kind = 'prop';
  else kind = explicitKind === 'actor' ? 'actor' : explicitKind === 'fixture' ? 'fixture' : 'prop';
  if (kind !== 'actor') return { kind };
  const role = pref === 'mob' ? 'mob' : pref === 'pc' ? 'pc' : pref === 'npc' ? 'npc' : explicitRole === 'mob' ? 'mob' : explicitRole === 'pc' ? 'pc' : 'npc';
  return { kind, role };
}

function normalizeOp(raw: unknown, seen: Set<string>): SceneOp | null {
  const o = asRec(raw);
  switch (o.op) {
    case 'fill':
      return { op: 'fill', region: normRegion(o.region), tag: terrainOr(o.tag, 'grass'), ...(typeof o.walkable === 'boolean' ? { walkable: o.walkable } : {}) };
    case 'water':
      return { op: 'fill', region: normRegion(o.region), tag: 'water', walkable: false };
    case 'island':
      return { op: 'island', region: normRegion(o.region), tag: terrainOr(o.tag, 'grass') };
    case 'bridge':
      return { op: 'bridge', from: normPt(o.from), to: normPt(o.to), tag: terrainOr(o.tag, 'wood_floor') };
    case 'path':
      return { op: 'path', from: normPt(o.from), to: normPt(o.to), tag: terrainOr(o.tag, 'dirt') };
    case 'plaza':
      return { op: 'plaza', region: normRegion(o.region), tag: terrainOr(o.tag, 'stone') };
    case 'maze':
      return { op: 'maze', region: normRegion(o.region), wall: terrainOr(o.wall, 'wall'), floor: terrainOr(o.floor, 'grass') };
    case 'cave':
      return { op: 'cave', region: normRegion(o.region), wall: terrainOr(o.wall, 'wall'), floor: terrainOr(o.floor, 'stone') };
    case 'clearing':
      return { op: 'clearing', region: normRegion(o.region) };
    case 'rooms':
      return { op: 'rooms', region: normRegion(o.region), count: Math.max(1, Math.min(12, num(o.count, 5))), wall: terrainOr(o.wall, 'wall'), floor: terrainOr(o.floor, 'stone') };
    case 'wallRing':
      return { op: 'wallRing', mat: o.mat === 'wood' ? 'wood' : 'stone' };
    case 'building': {
      const door = o.door === 'north' || o.door === 'south' || o.door === 'east' || o.door === 'west' ? o.door : undefined;
      const type = buildingTypeFor(o.type);
      return { op: 'building', type, region: normRegion(o.region), ...(door ? { door } : {}), ...(typeof o.name === 'string' ? { name: o.name.slice(0, 60) } : {}), id: uniqueId(fixId(o.id ?? `bldg:${type}`, 'fixture'), seen) };
    }
    case 'vignette': {
      const type = typeof o.type === 'string' && VIGNETTE_NAMES.includes(o.type) ? o.type : 'market';
      return { op: 'vignette', type, at: normPt(o.at), id: uniqueId(fixId(o.id ?? `prop:${type}`, 'prop'), seen) };
    }
    case 'place': {
      const { kind, role } = kindRoleFrom(o.id, o.kind, o.role);
      return { op: 'place', id: uniqueId(fixId(o.id, kind, role), seen), tag: kind === 'actor' ? charOr(o.tag) : propOr(o.tag), kind, ...(role ? { role } : {}), at: normPt(o.at), ...(typeof o.name === 'string' ? { name: o.name.slice(0, 60) } : {}) };
    }
    case 'scatter': {
      const kr = kindRoleFrom(o.idBase ?? o.id, o.kind, o.role);
      const kind: 'prop' | 'actor' = kr.kind === 'actor' ? 'actor' : 'prop'; // can't scatter fixtures
      const role = kr.role;
      const tagsRaw = Array.isArray(o.tags) ? o.tags : [o.tag];
      const tags = tagsRaw.map((t) => (kind === 'actor' ? charOr(t) : propOr(t)));
      if (!tags.length) tags.push(kind === 'actor' ? 'villager' : 'crate');
      return { op: 'scatter', idBase: uniqueId(fixId(o.idBase ?? o.id, kind, role), seen), tags, kind, ...(role ? { role } : {}), region: normRegion(o.region), count: Math.max(1, Math.min(40, num(o.count, 6))) };
    }
    case 'entrance':
      return { op: 'entrance', at: normPt(o.at) };
    case 'archetype': {
      const kind = typeof o.kind === 'string' && (ARCHETYPE_KINDS as string[]).includes(o.kind) ? (o.kind as ArchetypeKind) : 'town';
      return { op: 'archetype', kind, contents: normContents(o.contents) };
    }
    default:
      return null;
  }
}

/** Brief keyword → (catalog creature tag, hostility). Used by the completeness net: if the LLM names
 *  creatures in the brief but forgets to emit ops for them, we inject them so they ALWAYS appear. */
// The BUILDING completeness net (the twin of BRIEF_CREATURES): if the brief NAMES an establishment and
// the model's program lacks it, the harvest adds it deterministically — a DM's "a village with a temple,
// a smithy and a manor" can never lose a named building to LLM variance. Conservative patterns only
// (tighter than buildingTypeFor's coercion — no den/fence/study foot-guns that misfire on scenery prose).
const BRIEF_BUILDS: [RegExp, BuildingType][] = [
  [/\b(inn|hostel)\b/, 'inn'],
  [/tavern|alehouse|\bpub\b|tap.?house/, 'tavern'],
  [/smithy|blacksmith|\bforge\b|foundry/, 'smithy'],
  [/cathedral|minster|basilica|abbey|monastery/, 'cathedral'],
  [/temple|shrine|chapel|church|sanctuary/, 'temple'],
  [/\bjail\b|gaol|prison/, 'jail'],
  [/vault|treasury|strong.?room/, 'vault'],
  [/\bkeep\b|castle|fortress|citadel/, 'keep'],
  [/library|archive|scriptorium/, 'library'],
  [/armou?ry|arsenal/, 'armory'],
  [/barracks|garrison/, 'barracks'],
  [/guild.?hall/, 'guildhall'],
  [/manor|mansion|estate\b|villa\b/, 'manor'],
  [/court.?house|town.?hall|magistrate/, 'courthouse'],
  [/general.?store|provisioner|trading.?post|emporium/, 'general_store'],
  [/workshop|carpenter/, 'workshop'],
  [/curio|pawn.?shop|oddities/, 'curio'],
];

const BRIEF_CREATURES: [RegExp, string, 'mob' | 'npc'][] = [
  [/skeleton|skeletal/, 'skeleton', 'mob'],
  [/goblin/, 'goblin', 'mob'],
  [/\borc/, 'orc', 'mob'],
  [/zombie|ghoul|undead|wight|risen|drowned/, 'zombie', 'mob'],
  [/spider|arachnid/, 'spider', 'mob'],
  [/wolf|wolves|warg|jackal/, 'wolf', 'mob'],
  [/slime|ooze|jelly|blob/, 'slime', 'mob'],
  [/dragon|wyrm|drake|wyvern/, 'dragon', 'mob'],
  [/crocodile|lizard|gator|reptile/, 'frog', 'mob'],
  [/bandit|rogue|thief|assassin|brigand/, 'rogue', 'mob'],
  [/cultist|priest|mage|wizard|sorcer|necromancer|witch|warlock/, 'wizard', 'npc'],
  [/guard|soldier|knight|warrior|sentry|sentinel/, 'knight', 'npc'],
  [/ranger|hunter|scout|archer|woodsman/, 'ranger', 'npc'],
  [/dwarf|dwarves|dwarven/, 'dwarf', 'npc'],
  [/villager|peasant|townsfolk|hermit|fisher|merchant|elder|woman|man\b/, 'villager', 'npc'],
];

/** Brief keyword → a single notable PROP tag (the landmark net injects these if the LLM forgot them). */
const BRIEF_PROPS: [RegExp, string][] = [
  [/sarcophag|coffin|casket/, 'sarcophagus'],
  [/\baltar|shrine|reliquary/, 'altar'],
  [/throne/, 'throne'],
  [/fountain|\bwell\b|cistern/, 'fountain'],
  [/statue|\bidol\b/, 'statue'],
  [/chest|treasure|\bloot\b|hoard|coffer/, 'chest'],
  [/bonfire|campfire|fire-?pit|brazier|\bpyre\b/, 'brazier'],
  [/sign-?post|\bsignpost\b/, 'signpost'],
  [/gravestone|tombstone|headstone/, 'gravestone'],
];

/** Harvest the SEMANTIC CAST from a settlement program — building types/names, npcs, mobs, landmark
 *  hints, wall + entrance — discarding all geometry. This is the LLM-as-contents-picker step: the town
 *  generator owns the organic layout; this just collects WHAT exists from whatever ops the model emitted
 *  (plus the brief's named creatures/props, via the same nets), guaranteeing a populated town. */
function harvestTownContents(ops: SceneOp[], lcb: string): Contents {
  const buildings: Contents['buildings'] = [];
  const npcs: Contents['npcs'] = [];
  const mobs: Contents['mobs'] = [];
  const landmarks: Contents['landmarks'] = [];
  let wall = /\b(wall|walled|fortif\w*|palisade|stockade|gated|rampart|fortress|\bfort\b|keep|citadel)\b/.test(lcb);
  let entranceSide: Contents['entranceSide'];
  for (const o of ops) {
    if (o.op === 'building') buildings.push({ type: o.type, ...(o.name ? { name: o.name } : {}) });
    else if (o.op === 'wallRing') wall = true;
    else if (o.op === 'entrance') { const a = o.at; if (a === 'north' || a === 'south' || a === 'east' || a === 'west') entranceSide = a; }
    else if (o.op === 'place') { if (o.kind === 'actor') npcs.push({ tag: o.tag, ...(o.name ? { name: o.name } : {}) }); else landmarks.push({ tag: o.tag, ...(o.name ? { name: o.name } : {}) }); }
    else if (o.op === 'scatter' && o.kind === 'actor') { if (o.role === 'mob') mobs.push({ tag: o.tags[0]!, count: o.count }); else for (const t of o.tags) npcs.push({ tag: t }); }
    else if (o.op === 'vignette') landmarks.push({ tag: o.type === 'well' ? 'fountain' : o.type });
  }
  // Completeness nets — anything the brief NAMES that the model's ops missed is added deterministically.
  const haveBuild = new Set<string>(buildings.map((b) => b.type));
  for (const [re, t] of BRIEF_BUILDS) if (re.test(lcb) && !haveBuild.has(t) && buildings.length < 24) { buildings.push({ type: t }); haveBuild.add(t); }
  const haveActor = new Set<string>([...npcs.map((n) => n.tag), ...mobs.map((m) => m.tag)]);
  for (const [re, tag, role] of BRIEF_CREATURES) if (re.test(lcb) && !haveActor.has(tag)) { if (role === 'mob') mobs.push({ tag, count: 6 }); else npcs.push({ tag }); haveActor.add(tag); }
  if (!buildings.length) buildings.push({ type: 'tavern' }, { type: 'shop' }, { type: 'house' }, { type: 'house' }, { type: 'house' }, { type: 'house' });
  const haveProp = new Set(landmarks.map((l) => l.tag));
  for (const [re, tag] of BRIEF_PROPS) if (re.test(lcb) && !haveProp.has(tag)) { landmarks.push({ tag }); haveProp.add(tag); }
  // FEATURE nets (Weave field/seam primitives): a brief naming a waterway threads a canal; naming a
  // coast/mountains hands a map edge to a water/rock terrain field (the town sits on the land).
  const canal = /\b(canal|waterway|watergate)\b/.test(lcb);
  // FRONTIER FEATURES attach a composite to a field's edge — and IMPLY that field (a port needs a coast,
  // a mine needs a mountain), so the compiler always has an edge to hang them on.
  const port = /\b(ports?|harbou?rs?|docks?|piers?|jettys?|wharf|quays?|marina|fishing village)\b/.test(lcb);
  const mine = /\b(mines?|mining|mineshaft|quarry|ore|excavation|dwarven hold)\b/.test(lcb);
  const coast = port || /\b(sea|seaside|seashore|coast|coastal|beach|shore|shoreline|ocean|oceanside|seafront|waterfront|bay|lagoon|by the water)\b/.test(lcb);
  const mountain = mine || /\b(mountains?|mountainous|mountainside|cliffs?|crags?|craggy|highlands?|foothills?|escarpment|beneath the peaks?)\b/.test(lcb);
  // TOWN CHARACTER drives context-appropriate furnishing (no genteel fountain in a mining camp — and
  // MOOD wins: a horror/cursed/drowned village gets a grim marker, never a cheerful plaza fountain).
  const grim = /\b(horror|cursed|haunted|drowned|corpses?|the dead|plague|blight|doomed|forsaken|sinister|macabre|decay(ing)?|rotting|undead|ghostly|buried|sacrific\w*|ominous|dread|eerie|funereal|grim|unhallowed|desecrat\w*)\b/.test(lcb);
  const character: Contents['character'] =
    grim ? 'grim'
    : mine ? 'mining' : port ? 'port'
    : /\b(market ?town|bazaar|trading post|merchant|trade hub)\b/.test(lcb) ? 'market'
    : /\b(camp|outpost|bandit|shanty|refugee|frontier post|ramshackle|rough|logging|hunting lodge)\b/.test(lcb) ? 'rough'
    : 'civic';
  return { buildings, landmarks, npcs, mobs, ...(wall ? { wall: true } : {}), ...(canal ? { canal: true } : {}), ...(coast ? { coast: true } : {}), ...(mountain ? { mountain: true } : {}), ...(port ? { port: true } : {}), ...(mine ? { mine: true } : {}), character, ...(entranceSide ? { entranceSide } : {}) };
}

function progSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Turn the model's (untrusted) JSON into a guaranteed-runnable SceneProgram. `moodText` is the text the
 *  time-of-day/weather is inferred from — the PLAYER'S premise in story mode, so the DM's atmospheric
 *  flavour prose can't silently flip the scene to night/fog. Defaults to `brief` (the direct /program path,
 *  where the brief IS the player's words). */
export function normalizeProgram(raw: unknown, brief: string, moodText: string = brief, kindHint?: SceneKindHint): SceneProgram {
  const r = asRec(raw);
  // An explicitly DECLARED kind (the DM's setScene `kind`, or a beat's authored ScenePlan) FORCES the
  // grammar — it beats both the LLM's guess and the keyword nets below ("flooded mining town" must not
  // become an interior because the brief contains "mine").
  const KIND_GRAMMAR: Record<SceneKindHint, LayoutGrammar> = { settlement: 'town-square', interior: 'enclosed-interior', wild: 'open-outdoor' };
  const grammar: LayoutGrammar = kindHint ? KIND_GRAMMAR[kindHint]
    : (LAYOUT_GRAMMARS as readonly string[]).includes(r.grammar as string) ? (r.grammar as LayoutGrammar) : 'open-outdoor';
  const seen = new Set<string>();
  const ops = (Array.isArray(r.ops) ? r.ops : []).map((o) => normalizeOp(o, seen)).filter((o): o is SceneOp => o !== null).slice(0, 24);
  if (!ops.length) ops.push({ op: 'scatter', idBase: 'prop:rock', tags: ['bush', 'tree'], kind: 'prop', region: 'all', count: 8 });
  // STRUCTURE-COMPLETENESS NET: an interior/dungeon/cave/maze brief MUST have a structural backbone —
  // if the LLM emitted none (e.g. a "dungeon" as flat fill + scattered monsters), inject the right one
  // so it can never come out a flat field. Inserted BEFORE the first object op (so terrain fills stay
  // the base and objects land in the carved structure). Deterministic, no extra LLM call.
  const lcb = brief.toLowerCase();
  // TOWN ROUTING: a settlement is built by the deterministic TOWN GENERATOR (organic streets + parcels +
  // varied footprints), NOT by LLM-placed building rects (which come out an even grid — the whole reason
  // towns looked like a spreadsheet). Harvest the LLM's named CAST and hand it to the generator, dropping
  // its coordinates. Skipped for water-dominant briefs (lake/coast villages, where geometry matters) and
  // when the model already emitted an archetype op directly.
  const settlement = kindHint ? kindHint === 'settlement' : grammar === 'town-square' || /\b(town|village|city|hamlet|township|settlement|market town|burgh?|outpost)\b/.test(lcb);
  const hasArchetype = ops.some((o) => o.op === 'archetype');
  const dominantWater = ops.some((o) => o.op === 'fill' && o.tag.startsWith('water') && o.region === 'all');
  const routedTown = settlement && !hasArchetype && !dominantWater;
  if (routedTown) {
    const contents = harvestTownContents(ops, lcb);
    ops.length = 0;
    ops.push({ op: 'archetype', kind: 'town', contents });
  }
  // The completeness nets below only matter for the loose-op path; the archetype op carries its own cast.
  if (!routedTown && !hasArchetype) {
    // STRUCTURE-COMPLETENESS NET: an interior/dungeon/cave/maze brief MUST have a structural backbone —
    // if the LLM emitted none (e.g. a "dungeon" as flat fill + scattered monsters), inject the right one
    // so it can never come out a flat field. Inserted BEFORE the first object op (so terrain fills stay
    // the base and objects land in the carved structure). Deterministic, no extra LLM call.
    const STRUCT = new Set(['building', 'rooms', 'cave', 'maze']);
    const interiorish = kindHint ? kindHint === 'interior' : grammar === 'enclosed-interior' || /dungeon|crypt|cave|cavern|grotto|temple|vault|lair|tomb|catacomb|fortress|prison|sewer|\bmine\b|warren|labyrinth|maze/.test(lcb);
    if (interiorish && !ops.some((o) => STRUCT.has(o.op))) {
      const inject: SceneOp = /labyrinth|maze/.test(lcb) ? { op: 'maze', region: 'all', wall: 'wall', floor: 'flagstone' }
        : /cave|cavern|grotto|\bmine\b|lair|warren|burrow/.test(lcb) ? { op: 'cave', region: 'all', wall: 'rock_wall', floor: 'stone' }
        : { op: 'rooms', region: 'all', count: 6, wall: 'wall', floor: 'flagstone' };
      const objIdx = ops.findIndex((o) => o.op === 'place' || o.op === 'scatter' || o.op === 'vignette' || o.op === 'entrance');
      if (objIdx < 0) ops.push(inject); else ops.splice(objIdx, 0, inject);
    }
    // CREATURE NET: the LLM sometimes forgets to emit ops for creatures the brief names. Scan the brief;
    // for any creature word whose tag isn't already an actor, INJECT a scatter so the cast always appears.
    const actorTags = new Set<string>();
    for (const o of ops) {
      if (o.op === 'place' && o.kind === 'actor') actorTags.add(o.tag);
      if (o.op === 'scatter' && o.kind === 'actor') for (const t of o.tags) actorTags.add(t);
    }
    for (const [re, tag, role] of BRIEF_CREATURES) {
      if (ops.length >= 26) break;
      if (re.test(lcb) && !actorTags.has(tag)) {
        ops.push({ op: 'scatter', idBase: uniqueId(`${role}:${tag}`, seen), tags: [tag], kind: 'actor', role, region: 'all', count: role === 'mob' ? 6 : 2 });
        actorTags.add(tag);
      }
    }
    // LANDMARK NET: ensure a single notable prop the brief names (sarcophagus, altar, throne, chest…)
    // appears even if the LLM's program omitted it. Placed near centre; place() snaps to a free cell.
    const propTags = new Set<string>();
    for (const o of ops) {
      if (o.op === 'place' && o.kind !== 'actor') propTags.add(o.tag);
      if (o.op === 'building') propTags.add('__building__'); // a building furnishes itself — don't also drop a loose altar/throne
    }
    const hasBuilding = propTags.has('__building__');
    for (const [re, tag] of BRIEF_PROPS) {
      if (ops.length >= 28) break;
      if (re.test(lcb) && !propTags.has(tag) && !(hasBuilding && (tag === 'altar' || tag === 'throne'))) {
        ops.push({ op: 'place', id: uniqueId(`prop:${tag}`, seen), tag, kind: 'prop', at: 'center' });
        propTags.add(tag);
      }
    }
  }
  return {
    locationId: 'loc:lab-program',
    // A routed town needs room for the generator's streets+parcels → floor the grid larger than the LLM
    // may have asked for (a 40×26 town subdivides into too few lots).
    cols: Math.max(routedTown ? 54 : 16, Math.min(96, num(r.cols, routedTown ? 60 : 40))),
    rows: Math.max(routedTown ? 40 : 12, Math.min(64, num(r.rows, routedTown ? 44 : 26))),
    seed: progSeed(brief),
    base: terrainOr(r.base, 'grass'),
    biome: (BIOMES as readonly string[]).includes(r.biome as string) ? (r.biome as string) : 'forest',
    // MOOD → time of day. Driven ONLY by the PLAYER'S words (`moodText`: the premise in story mode), NOT
    // the DM's atmospheric flavour prose or the model's guess — so "a frontier town" stays plain DAY and
    // only the player writing "a fog-bound coast" / "at midnight" / "a grim, haunted village" flips it.
    // (Coast/mountain/character detection above still reads the fuller enriched brief — only WEATHER is the
    // player's call, because evocative prose like "the dark maw of the mine" is flavour, not a weather order.)
    lighting: ((mt: string): Lighting =>
        /\b(fog|foggy|fog-?bound|mist|misty|mist-?shrouded|haze|hazy|murk|murky|pea-?soup)\b/.test(mt) ? 'fog'
      : /\b(night|midnight|nocturnal|moonlit|moonlight|dark(ness)?|horror|cursed|haunted|grim|drowned|corpse|the dead|plague|blight|dread|eerie|gloom|shadow(ed|y)?|storm)\b/.test(mt) ? 'night'
      : /\b(dusk|twilight|sunset|evening|gloaming|nightfall|golden hour)\b/.test(mt) ? 'dusk'
      : 'day')(moodText.toLowerCase()),
    grammar,
    theme: themeNameFor(r.theme, brief, grammar), // one palette for the whole scene
    // A declared kind also owns indoor/outdoor — the LLM's `outdoor` can't contradict a forced interior.
    outdoor: kindHint ? kindHint !== 'interior' : typeof r.outdoor === 'boolean' ? r.outdoor : grammar !== 'enclosed-interior',
    ops,
  };
}

/** The macro creativity test: one LLM call composes a primitive program from a freeform brief. */
export class LlmSceneProgrammer {
  constructor(private readonly llm: LlmProvider, private readonly model?: string) {}

  async compose(brief: string, moodText?: string, kindHint?: SceneKindHint): Promise<SceneProgram> {
    const res = await this.llm.complete({
      system: SCENE_PROGRAMMER_SYSTEM,
      messages: [{ role: 'user', content: brief }],
      maxTokens: 1600,
      ...(this.model ? { model: this.model } : {}),
    });
    let raw: unknown = {};
    try {
      const m = res.text.match(/\{[\s\S]*\}/);
      if (m) raw = JSON.parse(m[0]);
    } catch {
      raw = {};
    }
    // `moodText` (the player's premise) drives time-of-day, so the DM's flavour prose in the enriched brief
    // can't silently set night/fog. Falls back to the brief for the direct /program path.
    return normalizeProgram(raw, brief, moodText ?? brief, kindHint);
  }
}
