/**
 * The Cartographer (docs/SCENE-CONTRACTS.md, surface C) — the deterministic resolver that
 * turns a Director's semantic `SceneComposition` into a concrete, frozen `SceneMap`.
 *
 * Pure + seed-stable: same composition → byte-identical map. This is the consistency
 * guarantor — it owns ALL geometry (zones→tiles, anchors→positions, footprints, snapping,
 * ambiance scatter) so the LLMs never touch a coordinate. Output satisfies validateSceneMap
 * by construction (actors land on walkable tiles, fixtures never overlap, all in-bounds).
 */

import {
  FEET_PER_TILE,
  FIELD_LIMITS,
  type AmbianceItem,
  type Building,
  type BuildingType,
  type Entrance,
  type LayoutGrammar,
  type MapObject,
  type ObjectField,
  type Placement,
  type SceneComposition,
  type SceneMap,
} from '@mythweaver/shared';
import { isCharacter, propDef, terrainWalkable } from './catalog.js';
import { wallBaseOf, type WallMat } from './themes.js';

/**
 * Per-type interior furniture + an occupant. DawnLike decor is mostly 1×1, so a "counter" is a row
 * of tables — the engine places each as a single prop. `where`: back = top interior row; corner =
 * the interior corners; center = the middle; scatter = random free floor. Tags are catalog props;
 * occupants are catalog characters. This is what makes a room read as a lived-in shop/home/temple.
 */
interface FurnSpec {
  tag: string;
  where: 'back' | 'corner' | 'center' | 'scatter' | 'wall' | 'around';
  count?: number;
}
/**
 * Per-type room recipe: the floor + wall MATERIAL (warm wood for lived-in homes/shops/taverns, cold
 * stone for temples/smithies) + an occupant + a furniture list placed POSITION-AWARELY so the room
 * reads as authored: 'back' = a counter/altar along the back wall, 'wall' = goods hugging the walls,
 * 'around' = chairs ringing the central table, 'center'/'corner'/'scatter' as before. Items are
 * placed in order, so a 'center' table is laid before the chairs that ring it.
 */
export type RoomTemplate = { floor: string; wall: 'wood' | 'stone'; occupant: string; carpet?: boolean; items: FurnSpec[]; groups?: string[] };
export const BUILDING_TEMPLATES: Record<BuildingType, RoomTemplate> = {
  tavern: { floor: 'wood_floor', wall: 'wood', occupant: 'villager_woman', carpet: true, items: [{ tag: 'bar_counter', where: 'back', count: 2 }, { tag: 'table', where: 'center' }, { tag: 'chair', where: 'around', count: 3 }, { tag: 'barrel', where: 'corner', count: 2 }, { tag: 'candelabra', where: 'wall' }] },
  shop: { floor: 'wood_floor', wall: 'wood', occupant: 'villager', items: [{ tag: 'shelf_wares', where: 'wall', count: 2 }, { tag: 'table', where: 'back' }, { tag: 'shelf', where: 'wall' }, { tag: 'crate', where: 'corner', count: 2 }] }, // display wares FIRST — a single-room shop must still read as one
  temple: { floor: 'stone', wall: 'stone', occupant: 'wizard', carpet: true, items: [{ tag: 'altar', where: 'back' }, { tag: 'candelabra', where: 'back', count: 2 }, { tag: 'chair', where: 'around', count: 4 }, { tag: 'bookshelf', where: 'wall' }] },
  smithy: { floor: 'stone', wall: 'stone', occupant: 'dwarf', items: [{ tag: 'forge', where: 'back' }, { tag: 'anvil', where: 'back' }, { tag: 'barrel', where: 'corner' }, { tag: 'crate', where: 'corner' }] }, // defining kit FIRST — a single-room smithy must still read as one (forge+anvil, not a brazier)
  house: { floor: 'wood_floor', wall: 'wood', occupant: 'villager', items: [{ tag: 'bed', where: 'corner' }, { tag: 'table', where: 'center' }, { tag: 'chair', where: 'around', count: 2 }, { tag: 'pot', where: 'wall' }] },
  // P0 batch — town/site location types added on the focal-station kernel (reuse-only props).
  inn: { floor: 'wood_floor', wall: 'wood', occupant: 'villager_woman', carpet: true, items: [{ tag: 'bed', where: 'corner', count: 2 }, { tag: 'table', where: 'back', count: 2 }, { tag: 'chair', where: 'around', count: 2 }, { tag: 'candelabra', where: 'wall' }] }, // beds FIRST — the defining stock must land before flavour exhausts a tiny room's budget
  general_store: { floor: 'wood_floor', wall: 'wood', occupant: 'villager', items: [{ tag: 'table', where: 'back', count: 2 }, { tag: 'shelf_wares', where: 'wall', count: 3 }, { tag: 'sack', where: 'corner', count: 2 }, { tag: 'barrel', where: 'corner', count: 2 }, { tag: 'crate', where: 'corner' }] },
  cathedral: { floor: 'stone', wall: 'stone', occupant: 'wizard', carpet: true, items: [{ tag: 'altar', where: 'back' }, { tag: 'statue', where: 'back' }, { tag: 'candelabra_large', where: 'back', count: 2 }, { tag: 'stone_bench', where: 'around', count: 4 }] },
  jail: { floor: 'stone', wall: 'stone', occupant: 'villager', items: [{ tag: 'cage', where: 'wall', count: 3 }, { tag: 'desk', where: 'center' }, { tag: 'chair', where: 'around' }, { tag: 'barrel', where: 'corner' }] },
  vault: { floor: 'stone', wall: 'stone', occupant: 'villager', items: [{ tag: 'chest', where: 'wall', count: 4 }, { tag: 'barrel', where: 'corner', count: 2 }, { tag: 'crate', where: 'corner' }] },
  // P1 batch.
  keep: { floor: 'stone', wall: 'stone', occupant: 'villager', carpet: true, items: [{ tag: 'throne', where: 'back' }, { tag: 'brazier', where: 'back', count: 2 }, { tag: 'table', where: 'center' }, { tag: 'stone_bench', where: 'around', count: 4 }] },
  library: { floor: 'wood_floor', wall: 'wood', occupant: 'wizard', carpet: true, items: [{ tag: 'bookshelf_full', where: 'wall', count: 4 }, { tag: 'desk', where: 'center' }, { tag: 'chair', where: 'around', count: 2 }, { tag: 'table', where: 'center' }] },
  armory: { floor: 'stone', wall: 'stone', occupant: 'villager', items: [{ tag: 'weapon_rack', where: 'wall', count: 3 }, { tag: 'desk', where: 'center' }, { tag: 'barrel', where: 'corner' }, { tag: 'crate', where: 'corner' }] },
  barracks: { floor: 'wood_floor', wall: 'wood', occupant: 'villager', items: [{ tag: 'bed', where: 'wall', count: 4 }, { tag: 'chest', where: 'corner' }, { tag: 'barrel', where: 'corner' }] },
  guildhall: { floor: 'wood_floor', wall: 'wood', occupant: 'villager', carpet: true, items: [{ tag: 'banner', where: 'back' }, { tag: 'table', where: 'center' }, { tag: 'chair', where: 'around', count: 3 }, { tag: 'chest', where: 'corner' }] },
  goblin_warren: { floor: 'stone', wall: 'stone', occupant: '', items: [{ tag: 'throne', where: 'back' }, { tag: 'brazier', where: 'center' }, { tag: 'bones', where: 'scatter', count: 3 }, { tag: 'cage', where: 'wall' }, { tag: 'crate', where: 'corner' }] },
  manor: { floor: 'wood_floor', wall: 'wood', occupant: 'villager', carpet: true, items: [{ tag: 'table_round', where: 'center' }, { tag: 'chair', where: 'around', count: 4 }, { tag: 'candelabra_large', where: 'wall' }, { tag: 'bookshelf', where: 'wall' }, { tag: 'bed', where: 'corner' }] },
  // P2 batch.
  tomb: { floor: 'stone', wall: 'stone', occupant: '', items: [{ tag: 'sarcophagus', where: 'wall', count: 3 }, { tag: 'candelabra', where: 'wall' }, { tag: 'bones', where: 'scatter', count: 2 }] },
  courthouse: { floor: 'stone', wall: 'stone', occupant: 'villager', carpet: true, items: [{ tag: 'throne', where: 'back' }, { tag: 'stone_bench', where: 'around', count: 6 }, { tag: 'candelabra', where: 'wall' }] },
  workshop: { floor: 'wood_floor', wall: 'wood', occupant: 'villager', items: [{ tag: 'table', where: 'center' }, { tag: 'woodpile', where: 'corner', count: 2 }, { tag: 'weapon_rack', where: 'wall' }, { tag: 'crate', where: 'corner' }] },
  curio: { floor: 'wood_floor', wall: 'wood', occupant: 'villager', items: [{ tag: 'table', where: 'back', count: 2 }, { tag: 'shelf_wares', where: 'wall', count: 2 }, { tag: 'jar', where: 'wall' }, { tag: 'urn', where: 'wall' }, { tag: 'chest', where: 'corner' }, { tag: 'books', where: 'wall' }] },
};

/**
 * Per-ROOM-FUNCTION furniture recipes — the unit a multi-room building (`compound`) is composed from.
 * A building is no longer ONE open furnished box; its footprint is subdivided into rooms, each FURNISHED
 * BY FUNCTION so the interior reads as a real home/shop: a bedroom has beds, a kitchen has shelves +
 * barrels, a tavern bar has a back-wall counter, a temple nave has an altar + pews. floor/wall/occupant
 * are OVERRIDDEN per-building by `compound` (one material for the whole building, one keeper in the
 * primary room); only `carpet` + `items` are function-specific. Reuses the same FurnSpec selectors as
 * BUILDING_TEMPLATES (back = counter/altar along the back wall, around = seating ringing the centre).
 */
export type RoomFunction = 'bar' | 'dining' | 'kitchen' | 'bedroom' | 'storeroom' | 'shopfront' | 'parlor' | 'nave' | 'vestry' | 'forge' | 'apse' | 'cellblock' | 'strongroom' | 'innfront' | 'greathall' | 'readinghall' | 'armory' | 'barracks' | 'guildhall' | 'warrenhall' | 'mausoleum' | 'courtroom' | 'workshop' | 'oddmentshop';
export const ROOM_TEMPLATES: Record<RoomFunction, RoomTemplate> = {
  bar: { floor: 'wood_floor', wall: 'wood', occupant: 'villager_woman', items: [{ tag: 'table', where: 'back', count: 4 }, { tag: 'shelf_wares', where: 'back' }, { tag: 'barrel', where: 'corner', count: 2 }, { tag: 'crate', where: 'corner' }, { tag: 'candelabra', where: 'wall' }, { tag: 'chair', where: 'around', count: 2 }] },
  dining: { floor: 'wood_floor', wall: 'wood', occupant: '', carpet: true, items: [{ tag: 'table', where: 'center' }, { tag: 'chair', where: 'around', count: 4 }, { tag: 'candelabra', where: 'wall' }, { tag: 'barrel', where: 'corner' }] },
  kitchen: { floor: 'wood_floor', wall: 'wood', occupant: '', items: [{ tag: 'shelf_food', where: 'wall', count: 2 }, { tag: 'barrel', where: 'corner' }, { tag: 'sack', where: 'corner' }, { tag: 'pot', where: 'wall' }, { tag: 'woodpile', where: 'corner' }, { tag: 'table', where: 'center' }] },
  bedroom: { floor: 'wood_floor', wall: 'wood', occupant: '', items: [{ tag: 'bed', where: 'corner' }, { tag: 'bed_blue', where: 'corner' }, { tag: 'chair', where: 'around' }, { tag: 'shelf', where: 'wall' }, { tag: 'pot', where: 'wall' }] },
  storeroom: { floor: 'wood_floor', wall: 'wood', occupant: '', items: [{ tag: 'crate', where: 'corner', count: 2 }, { tag: 'barrel', where: 'corner', count: 2 }, { tag: 'sack', where: 'wall', count: 2 }, { tag: 'shelf', where: 'wall' }, { tag: 'woodpile', where: 'corner' }] },
  shopfront: { floor: 'wood_floor', wall: 'wood', occupant: 'villager', items: [{ tag: 'table', where: 'back', count: 2 }, { tag: 'shelf_wares', where: 'wall', count: 2 }, { tag: 'shelf_food', where: 'wall' }, { tag: 'crate', where: 'corner' }, { tag: 'pot', where: 'wall' }] },
  parlor: { floor: 'wood_floor', wall: 'wood', occupant: 'villager', carpet: true, items: [{ tag: 'table', where: 'center' }, { tag: 'chair', where: 'around', count: 2 }, { tag: 'bookshelf', where: 'wall' }, { tag: 'pot', where: 'wall' }, { tag: 'candelabra', where: 'wall' }] },
  nave: { floor: 'stone', wall: 'stone', occupant: 'wizard', carpet: true, items: [{ tag: 'altar', where: 'back' }, { tag: 'candelabra', where: 'back', count: 2 }, { tag: 'stone_bench', where: 'around', count: 4 }, { tag: 'bookshelf', where: 'wall' }] },
  vestry: { floor: 'stone', wall: 'stone', occupant: '', items: [{ tag: 'bookshelf', where: 'wall', count: 2 }, { tag: 'desk', where: 'center' }, { tag: 'chair', where: 'around' }, { tag: 'candle', where: 'wall' }] },
  forge: { floor: 'stone', wall: 'stone', occupant: 'dwarf', items: [{ tag: 'brazier', where: 'back' }, { tag: 'table', where: 'center' }, { tag: 'weapon_rack', where: 'wall' }, { tag: 'barrel', where: 'corner' }, { tag: 'crate', where: 'corner' }, { tag: 'woodpile', where: 'corner' }] },
  // P0 batch room functions: apse (cathedral focal — altar + deity statue), cellblock (jail — caged cells +
  // a jailer's desk), strongroom (vault — a hoard of chests). occupant/material set per-building by compound.
  // innfront — the inn's primary room: the check-in counter + common-room tables. NO beds here: guests
  //   sleep in the dedicated bedroom rooms (depth-cast puts them deepest); a bed beside the check-in
  //   counter is the beds-at-the-bar incoherence. (A SINGLE-room inn uses the `inn` template above,
  //   which keeps its sleeping-hall beds — there's no counter room to collide with.)
  innfront: { floor: 'wood_floor', wall: 'wood', occupant: 'villager_woman', carpet: true, items: [{ tag: 'table', where: 'back', count: 2 }, { tag: 'barrel', where: 'corner' }, { tag: 'chair', where: 'around', count: 2 }] },
  apse: { floor: 'stone', wall: 'stone', occupant: 'wizard', carpet: true, items: [{ tag: 'altar', where: 'back' }, { tag: 'statue', where: 'back' }, { tag: 'candelabra_large', where: 'back', count: 2 }, { tag: 'stone_bench', where: 'around', count: 4 }] },
  cellblock: { floor: 'stone', wall: 'stone', occupant: 'villager', items: [{ tag: 'cage', where: 'wall', count: 3 }, { tag: 'desk', where: 'center' }, { tag: 'chair', where: 'around' }] },
  strongroom: { floor: 'stone', wall: 'stone', occupant: 'villager', items: [{ tag: 'chest', where: 'wall', count: 4 }, { tag: 'barrel', where: 'corner', count: 2 }] },
  // P1 batch room functions: greathall (keep — a throne), readinghall (library — shelves), armory (weapon racks),
  // barracks (rows of bunks), guildhall (a banner crest + meeting table), warrenhall (goblin lair — chief's seat + cookfire).
  greathall: { floor: 'stone', wall: 'stone', occupant: 'villager', carpet: true, items: [{ tag: 'throne', where: 'back' }, { tag: 'brazier', where: 'back', count: 2 }, { tag: 'table', where: 'center' }, { tag: 'stone_bench', where: 'around', count: 4 }] },
  readinghall: { floor: 'wood_floor', wall: 'wood', occupant: 'wizard', carpet: true, items: [{ tag: 'bookshelf_full', where: 'wall', count: 4 }, { tag: 'desk', where: 'center' }, { tag: 'chair', where: 'around', count: 2 }] },
  armory: { floor: 'stone', wall: 'stone', occupant: 'villager', items: [{ tag: 'weapon_rack', where: 'wall', count: 3 }, { tag: 'desk', where: 'center' }, { tag: 'crate', where: 'corner' }] },
  barracks: { floor: 'wood_floor', wall: 'wood', occupant: 'villager', items: [{ tag: 'bed', where: 'wall', count: 4 }, { tag: 'chest', where: 'corner' }] },
  guildhall: { floor: 'wood_floor', wall: 'wood', occupant: 'villager', carpet: true, items: [{ tag: 'banner', where: 'back' }, { tag: 'table', where: 'center' }, { tag: 'chair', where: 'around', count: 3 }] },
  warrenhall: { floor: 'stone', wall: 'stone', occupant: '', items: [{ tag: 'throne', where: 'back' }, { tag: 'brazier', where: 'center' }, { tag: 'bones', where: 'scatter', count: 3 }, { tag: 'cage', where: 'wall' }] },
  // P2 batch room functions: mausoleum (tomb — sarcophagi), courtroom (throne magistrate + bench gallery),
  // workshop (carpenter — workbench + lumber), oddmentshop (curio — counter + bric-a-brac).
  mausoleum: { floor: 'stone', wall: 'stone', occupant: '', items: [{ tag: 'sarcophagus', where: 'wall', count: 3 }, { tag: 'candelabra', where: 'wall' }, { tag: 'bones', where: 'scatter', count: 2 }] },
  courtroom: { floor: 'stone', wall: 'stone', occupant: 'villager', carpet: true, items: [{ tag: 'throne', where: 'back' }, { tag: 'stone_bench', where: 'around', count: 6 }] },
  workshop: { floor: 'wood_floor', wall: 'wood', occupant: 'villager', items: [{ tag: 'table', where: 'center' }, { tag: 'woodpile', where: 'corner', count: 2 }, { tag: 'weapon_rack', where: 'wall' }, { tag: 'crate', where: 'corner' }] },
  oddmentshop: { floor: 'wood_floor', wall: 'wood', occupant: 'villager', items: [{ tag: 'table', where: 'back', count: 2 }, { tag: 'shelf_wares', where: 'wall', count: 2 }, { tag: 'jar', where: 'wall' }, { tag: 'urn', where: 'wall' }, { tag: 'chest', where: 'corner' }] },
};

/** Per-building-type ROOM PROGRAM: the ordered room functions a compound contains. Index 0 is the
 *  PRIMARY (front) room — it gets the keeper + the entrance. Truncated to however many rooms the
 *  footprint subdivides into (a small cottage = just its primary room). */
export const ROOM_PROGRAMS: Record<BuildingType, RoomFunction[]> = {
  tavern: ['bar', 'dining', 'kitchen', 'bedroom'],
  shop: ['shopfront', 'storeroom', 'kitchen'],
  temple: ['nave', 'vestry', 'bedroom'],
  smithy: ['forge', 'storeroom', 'kitchen'],
  house: ['parlor', 'bedroom', 'kitchen'],
  // P0 batch. inn = a check-in bar + a block of rentable bedrooms (the defining beds). general_store =
  // a service counter + storerooms packed with mixed stock. cathedral = a grand apse + vestry. jail =
  // a cell block + storeroom. vault = a strongroom of chests + storeroom.
  inn: ['innfront', 'bedroom', 'bedroom', 'kitchen'],
  general_store: ['shopfront', 'storeroom', 'storeroom'],
  cathedral: ['apse', 'vestry', 'bedroom'],
  jail: ['cellblock', 'storeroom'],
  vault: ['strongroom', 'strongroom'], // both rooms are chest hoards — a treasury reads as chests, not generic crates
  // P1 batch.
  keep: ['greathall', 'kitchen', 'bedroom'],
  library: ['readinghall', 'vestry'],
  armory: ['armory', 'storeroom'],
  barracks: ['barracks', 'storeroom'],
  guildhall: ['guildhall', 'storeroom'],
  goblin_warren: ['warrenhall', 'storeroom'],
  manor: ['parlor', 'dining', 'vestry', 'bedroom'], // a grand multi-room residence (a study sets it apart from a plain house)
  // P2 batch.
  tomb: ['mausoleum', 'storeroom'],
  courthouse: ['courtroom', 'storeroom'],
  workshop: ['workshop', 'storeroom'],
  curio: ['oddmentshop', 'storeroom'],
};

/** Per-room-FUNCTION furniture RECIPE: a short list of relational GROUPS (see furnishRoom's group
 *  engine — dining = a table with chairs around it, bed = against a wall, storage = a corner cluster,
 *  counter = a back-wall bar, …). Groups are the reuse unit (~14, shared by every room/building/biome);
 *  a recipe is just a list of them, so this scales without per-item grind. */
export const ROOM_RECIPES: Record<RoomFunction, string[]> = {
  bar: ['bar', 'dining', 'dining', 'hearth', 'storage'],
  dining: ['dining', 'dining', 'hearth', 'shelf'],
  kitchen: ['pantry', 'storage', 'hearth', 'dining'],
  bedroom: ['bed', 'bed', 'shelf', 'dining'],
  storeroom: ['storage', 'storage', 'storage', 'shelf'],
  shopfront: ['shopfront', 'wares', 'wares', 'storage'],
  parlor: ['dining', 'hearth', 'books'],
  nave: ['nave'],
  vestry: ['study', 'books'],
  forge: ['forge', 'weapons', 'storage'],
  innfront: ['checkin', 'dining', 'dining', 'shelf'], // a LEAN check-in counter (keeper behind) + common-room tables — guests SLEEP in the bedroom rooms, never beside the counter (the beds-at-the-bar incoherence was authored right here)
  apse: ['apse'],               // altar + flanking deity statue + ranked pews = a cathedral (statue distinguishes it from a temple)
  cellblock: ['cells', 'study'], // a row of caged cells + a jailer's desk post
  strongroom: ['hoard', 'hoard'], // a hoard of strongboxes (chest-dominant — a treasury, not a storeroom)
  greathall: ['throne', 'dining', 'dining', 'hearth'], // a throne on the dais + feast tables = a castle great hall
  readinghall: ['shelving', 'shelving', 'study'], // rows of full bookshelves + reading desks = a library
  armory: ['weapons', 'weapons', 'weapons', 'storage'], // ranks of weapon racks
  barracks: ['bunks', 'bunks', 'storage'], // rows of identical cots
  guildhall: ['crest', 'dining', 'storage'], // the guild banner/crest + a meeting table
  warrenhall: ['throne', 'warren', 'storage'], // a crude chief's seat + a cookfire, bones, a prisoner cage
  mausoleum: ['sarcophagi', 'storage'], // rows of stone sarcophagi = a tomb/crypt
  courtroom: ['throne', 'benches', 'storage'], // a magistrate's seat (throne) facing a gallery of benches
  workshop: ['workbench', 'storage', 'storage'], // a workbench + lumber + tools = a carpenter's shop
  oddmentshop: ['shopfront', 'oddments', 'oddments'], // a service counter packed with mismatched curios
};

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Pick a faced wall AUTO-TILE by which edges of a rectangular wall border this cell sits on (top/
 *  bottom/left/right). A 1-cell wall ring has floor on both sides, so neighbour-connectivity alone
 *  can't tell interior from exterior — but the Cartographer knows the rect, so it assigns the right
 *  faced tile directly. Falls back to the plain fill 'wall' for non-border / interior-pillar cells. */
export function wallTagFor(top: boolean, bot: boolean, left: boolean, right: boolean, mat: WallMat = 'stone'): string {
  const b = wallBaseOf(mat);
  if (top && left) return `${b}_tl`;
  if (top && right) return `${b}_tr`;
  if (bot && left) return `${b}_bl`;
  if (bot && right) return `${b}_br`;
  if (top) return `${b}_t`;
  if (bot) return `${b}_b`;
  if (left) return `${b}_l`;
  if (right) return `${b}_r`;
  return b;
}

/** C1 terrain auto-tile: the faithful DawnLike 9-tile OUTER set, keyed by which sides are EXPOSED
 *  (border a different terrain family). One exposed side → that edge; two ADJACENT → that corner;
 *  surrounded, an opposite-pair strip, or 3+ exposed → '' (centre — DawnLike ships no inner corners). */
function edgeSuffix(eN: boolean, eE: boolean, eS: boolean, eW: boolean): string {
  const n = (eN ? 1 : 0) + (eE ? 1 : 0) + (eS ? 1 : 0) + (eW ? 1 : 0);
  if (n === 1) return eN ? '_t' : eS ? '_b' : eW ? '_l' : '_r';
  if (n === 2) {
    if (eN && eW) return '_tl';
    if (eN && eE) return '_tr';
    if (eS && eW) return '_bl';
    if (eS && eE) return '_br';
  }
  return '';
}

/** Deterministic PRNG (mulberry32) — reproducible from the scene seed. */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Reusable post-processing passes — extracted from buildSceneMap (which still calls them, behavior
// unchanged) so the city stitcher (city.ts) can run them ONCE on an ASSEMBLED multi-district grid.
// Each MUTATES its array args in place.
// ---------------------------------------------------------------------------

/** C1 terrain auto-tile bake: give every EDGED-family cell (grass / water / water_deep) the right
 *  DawnLike edge tile for which sides border a DIFFERENT family. Off-grid neighbours count as SAME
 *  (the screen border doesn't fringe). Pure read of a snapshot → writes `${base}${suffix}`; never
 *  touches walkable (an *_edge tile shares its base's walkability). Idempotent on already-baked tags
 *  only insofar as *_edge tags aren't EDGED — so re-baking a stitched grid needs base tags (see
 *  city.ts, which strips suffixes before calling this). */
export function bakeAutoTiles(tiles: string[][], cols: number, rows: number): void {
  // Forge biome families (each knits like grass/water — its own family, fringing against everything else).
  const FORGE_FAMILIES = ['hedge', 'snow', 'ice', 'swamp', 'mud', 'ash', 'blight', 'sand', 'farmland'];
  const FAMILY: Record<string, string> = { grass: 'grass', water: 'water', water_deep: 'water', lava: 'lava', road: 'road', rock: 'rock', ...Object.fromEntries(FORGE_FAMILIES.map((f) => [f, f])) };
  const EDGED = new Set(['grass', 'water', 'water_deep', 'lava', 'road', 'rock', ...FORGE_FAMILIES]);
  const orig = tiles.map((row) => row.slice());
  const famOf = (t: string) => FAMILY[t] ?? t;
  const sameFam = (c: number, r: number, f: string) => c < 0 || r < 0 || c >= cols || r >= rows || famOf(orig[r]![c]!) === f;
  // A road is a UNIFIED brick body with a lined rim where it meets open UNPAVED ground (grass/dirt/sand) —
  // NOT at internal junctions (against building walls, the basin lip, off-grid, or other paving). That gives
  // every cobbled street a curb on its earth/grass edges while the interior stays brick. grass/water still
  // fringe against any different family.
  const OPEN_GROUND = new Set(['grass', 'dirt', 'sand']);
  const openN = (c: number, r: number) => c >= 0 && r >= 0 && c < cols && r < rows && OPEN_GROUND.has(orig[r]![c]!);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const base = orig[r]![c]!;
      if (!EDGED.has(base)) continue;
      const f = famOf(base);
      const suf = base === 'road'
        ? edgeSuffix(openN(c, r - 1), openN(c + 1, r), openN(c, r + 1), openN(c - 1, r)) // curb where cobble meets unpaved ground
        : edgeSuffix(!sameFam(c, r - 1, f), !sameFam(c + 1, r, f), !sameFam(c, r + 1, f), !sameFam(c - 1, r, f));
      if (suf) tiles[r]![c] = `${base}${suf}`;
    }
}

/** WOOD-WALL autotile (hybrid): WALL-LINE CONNECTIVITY decides the SHAPE — a cell is a corner only where the
 *  wall actually turns (2 perpendicular wall-line neighbours). The wall LINE runs through doorways (a hole in
 *  a wall counts as the line continuing), so a door mid-straight-wall stays collinear → straight (no "bump
 *  off a straight wall"), while a door right beside a real corner still reads as that corner (not a false
 *  end). The interior-FLOOR quadrant then orients the corner, so convex corners AND concave inner corners of
 *  an L both face the room correctly. DawnLike's block is one horizontal tile (_t), one vertical (_l) and four corners
 *  (_tl/_tr/_bl/_br); _b/_r are identical to _t/_l, so straights are emitted canonically. Idempotent. */
export function bakeWoodWalls(tiles: string[][], cols: number, rows: number): void {
  const orig = tiles.map((row) => row.slice());
  // Any faced wall — wood ('wall_wood*') OR stone ('wall*'). The tile's base is kept per-cell so a stone
  // building autotiles with the stone set and a wood one with the wood set (both have all 4 corners).
  const wall = (c: number, r: number) => c >= 0 && r >= 0 && c < cols && r < rows && (orig[r]![c] ?? '').startsWith('wall');
  // Preserve the MATERIAL family (wall_wood, wall_sandstone, wall_bone, …): strip only a bake suffix,
  // never the family name — else every forged wall material bakes down to plain stone.
  const baseOf = (c: number, r: number) => (orig[r]?.[c] ?? 'wall').replace(/_(?:t|b|l|r|tl|tr|bl|br)$/, '');
  const f = (c: number, r: number) => { const t = orig[r]?.[c] ?? ''; return t === 'wood_floor' || t === 'stone' || t === 'flagstone' || t === 'stone_brick' || t.startsWith('carpet'); };
  // A DOORWAY is a hole in a wall LINE — a non-wall cell flanked by walls on opposite sides. For SHAPE
  // detection the line continues THROUGH it, so a door adjacent to a real corner still reads as a corner
  // (was a false "end" → straight glyph), while a door mid-straight-wall stays collinear → still straight.
  const doorway = (c: number, r: number) => !wall(c, r) && ((wall(c, r - 1) && wall(c, r + 1)) || (wall(c - 1, r) && wall(c + 1, r)));
  const wline = (c: number, r: number) => wall(c, r) || doorway(c, r); // wall-line present (wall OR doorway)
  const CORNER: Record<number, string> = { 6: '_tl', 12: '_tr', 3: '_bl', 9: '_br' }; // E+S, S+W, N+E, N+W
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      if (!wall(c, r)) continue;
      const wN = wline(c, r - 1), wE = wline(c + 1, r), wS = wline(c, r + 1), wW = wline(c - 1, r);
      const oppH = wE && wW, oppV = wN && wS;
      let suf: string;
      if (oppH || oppV) {
        suf = oppH ? '_t' : '_l'; // straight run, or a T-junction → the through-straight
      } else if ((wN ? 1 : 0) + (wE ? 1 : 0) + (wS ? 1 : 0) + (wW ? 1 : 0) === 2) {
        // exactly two PERPENDICULAR walls = a corner. Orient it by the quadrant the interior floor is in,
        // so convex (floor on the diagonal) and concave/L-step (floor on two adjacent sides) both face the room.
        const fN = f(c, r - 1), fE = f(c + 1, r), fS = f(c, r + 1), fW = f(c - 1, r);
        const fNE = f(c + 1, r - 1), fSE = f(c + 1, r + 1), fSW = f(c - 1, r + 1), fNW = f(c - 1, r - 1);
        if (fSE || (fS && fE)) suf = '_tl';
        else if (fSW || (fS && fW)) suf = '_tr';
        else if (fNE || (fN && fE)) suf = '_bl';
        else if (fNW || (fN && fW)) suf = '_br';
        else suf = CORNER[(wN ? 1 : 0) | (wE ? 2 : 0) | (wS ? 4 : 0) | (wW ? 8 : 0)] ?? '_t'; // fallback by wall directions
      } else if (wE || wW) {
        suf = '_t'; // horizontal END (one wall neighbour) → straight, never a corner
      } else if (wN || wS) {
        suf = '_l'; // vertical END → straight
      } else {
        // isolated wall cell (no wall neighbours) → orient by adjacent floor, never a chunky fill block
        suf = f(c, r - 1) || f(c, r + 1) ? '_t' : '_l';
      }
      tiles[r]![c] = baseOf(c, r) + suf;
    }
}

/** ROCK-MASS autotile (Weave cliff massif): a filled body of `rock_wall` (a mountain/cliff) gets the
 *  DawnLike connectivity blob tile per cell — the town-facing side shows a vertical CLIFF FACE, the
 *  interior a solid rock top — so a mountain reads as impassable high ground, not a flat gravel field.
 *  Off-grid neighbours count as SAME (the massif continues off-screen). Writes `rock_wall_<exposed>`,
 *  where exposed = the sides with NO rock neighbour (the faces the town sees). 3+ exposed → a pillar. */
export function bakeRockMass(tiles: string[][], cols: number, rows: number): void {
  const orig = tiles.map((row) => row.slice());
  const rk = (c: number, r: number) => c < 0 || r < 0 || c >= cols || r >= rows || (orig[r]![c] ?? '').startsWith('rock_wall');
  const SUF: Record<string, string> = { '': '', N: '_n', S: '_s', E: '_e', W: '_w', NS: '_ns', EW: '_ew', NW: '_nw', NE: '_ne', SW: '_sw', SE: '_se' };
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      if (!(orig[r]![c] ?? '').startsWith('rock_wall')) continue;
      const ex = (rk(c, r - 1) ? '' : 'N') + (rk(c + 1, r) ? '' : 'E') + (rk(c, r + 1) ? '' : 'S') + (rk(c - 1, r) ? '' : 'W');
      tiles[r]![c] = `rock_wall${SUF[ex] ?? '_flat'}`;
    }
}

/** C2 ground decals: a light, NON-blocking scatter of pebbles + grass tufts on free open natural
 *  ground (grass/dirt/sand). Reserves each chosen cell in `occ`; leaves walkable untouched (decals
 *  are walkable). Pushes AmbianceItems. Seed via `rand` so it's reproducible. */
export function scatterGroundDecals(tiles: string[][], walkable: boolean[][], occ: boolean[][], cols: number, rows: number, ambiance: AmbianceItem[], rand: () => number): void {
  const open: { c: number; r: number }[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (walkable[r]![c] === true && occ[r]![c] === false && /^(grass|dirt|sand)$/.test(tiles[r]![c]!)) open.push({ c, r });
  for (let i = open.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = open[i]!; open[i] = open[j]!; open[j] = t; }
  const DECALS = ['pebble', 'pebble', 'grass_tuft'] as const;
  const cap = Math.min(open.length, 60, Math.max(4, Math.floor(open.length * 0.08)));
  for (let i = 0; i < cap; i++) {
    const cell = open[i]!;
    occ[cell.r]![cell.c] = true; // reserve; decals are walkable (blocks:false) so DON'T clear walkable
    ambiance.push({ tag: DECALS[Math.floor(rand() * DECALS.length)]!, col: cell.c, row: cell.r });
  }
}

/** Global reachability guard: BFS the walkable graph from a PC (or the bottom-left open cell); for any
 *  actor/entrance cut off from it, carve an L-shaped corridor (opening walls → dirt) to the nearest
 *  reachable cell. UNCONDITIONAL — the caller decides whether it's needed (buildSceneMap gates it on
 *  buildings existing; the city always has cross-district gaps to bridge). */
export function reachabilityCarve(tiles: string[][], walkable: boolean[][], cols: number, rows: number, objects: MapObject[], entrances: Entrance[]): void {
  const ORTH4 = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  const inB = (c: number, r: number) => c >= 0 && c < cols && r >= 0 && r < rows;
  const idx = (c: number, r: number) => r * cols + c;
  const bfs = (start: { c: number; r: number }): Set<number> => {
    const seen = new Set<number>();
    if (!inB(start.c, start.r) || !walkable[start.r]![start.c]) return seen;
    const q = [start];
    seen.add(idx(start.c, start.r));
    while (q.length) {
      const cur = q.shift()!;
      for (const [dx, dy] of ORTH4) {
        const cc = cur.c + dx, rr = cur.r + dy;
        if (inB(cc, rr) && walkable[rr]![cc] && !seen.has(idx(cc, rr))) { seen.add(idx(cc, rr)); q.push({ c: cc, r: rr }); }
      }
    }
    return seen;
  };
  let start: { c: number; r: number } | null = null;
  for (const o of objects) if (o.role === 'pc' && walkable[o.row]?.[o.col]) { start = { c: o.col, r: o.row }; break; }
  if (!start) for (let r = rows - 1; r >= 0 && !start; r--) for (let c = 0; c < cols && !start; c++) if (walkable[r]![c]) start = { c, r };
  if (!start) return;
  let reach = bfs(start);
  const carve = (from: { c: number; r: number }, to: { c: number; r: number }): void => {
    let c = from.c, r = from.r;
    const open = (): void => { if (inB(c, r)) { walkable[r]![c] = true; if (tiles[r]![c]!.startsWith('wall')) tiles[r]![c] = 'dirt'; } };
    open();
    while (c !== to.c) { c += c < to.c ? 1 : -1; open(); }
    while (r !== to.r) { r += r < to.r ? 1 : -1; open(); }
  };
  const targets = [...objects.filter((o) => o.kind === 'actor').map((o) => ({ c: o.col, r: o.row })), ...entrances.map((e2) => ({ c: e2.col, r: e2.row }))];
  for (const t of targets) {
    if (reach.has(idx(t.c, t.r))) continue;
    let best: { c: number; r: number } | null = null;
    let bestD = Infinity;
    for (const k of reach) { const c = k % cols, r = (k - c) / cols; const d = Math.abs(c - t.c) + Math.abs(r - t.r); if (d < bestD) { bestD = d; best = { c, r }; } }
    if (best) { carve(t, best); reach = bfs(start); }
  }
}

/**
 * Furnish a carved room's interior from a per-type template: an optional carpet centrepiece, position-
 * aware furniture (back/corner/center/wall/around), and a seated keeper — keeping the door's inner cell
 * clear and ≥half the floor walkable. MUTATES the arrays; returns the updated furniture sequence so ids
 * stay globally unique. Extracted from carveBuildings so BOTH the classic path AND the primitive engine
 * furnish rooms IDENTICALLY (the module-engine restore). `door` is a cell on the rect border (keepClear
 * derives the inner-door cell from it); pass a cell outside the rect to skip the forced clear. */
export function furnishRoom(
  tiles: string[][],
  walkable: boolean[][],
  occ: boolean[][],
  objects: MapObject[],
  rect: Rect,
  tmpl: RoomTemplate,
  door: { c: number; r: number },
  rand: () => number,
  cols: number,
  safe: string,
  groupId: string,
  seqStart: number,
  name?: string,
): number {
  let furnSeq = seqStart;
  const { x: rx, y: ry, w: rw, h: rh } = rect;
  const midX = rx + Math.floor(rw / 2);
  const midY = ry + Math.floor(rh / 2);
  const ix = rx + 1, iy = ry + 1, iw = rw - 2, ih = rh - 2;
  if (iw < 1 || ih < 1) return furnSeq;
  // BED ORIENTATION — a bed's headboard goes ON the wall it sits against, so the sprite is chosen by which
  // interior edge the cell is on (shared by BOTH furnishing paths: the relational groups + the legacy items).
  const BED_TAG = { top: 'bed', bottom: 'bed_down', left: 'bed_blue', right: 'bed_right' } as const;
  // Headboard side = the direction of the ACTUAL adjacent wall tile. Robust on irregular footprints, where a
  // leaf's bounding-rect edge isn't always a real wall (a U/compose arm can open onto another room, not a wall).
  const wallAt = (c: number, r: number) => (tiles[r]?.[c] ?? '').startsWith('wall');
  const bedSideOf = (c: number, r: number): keyof typeof BED_TAG | null => (wallAt(c, r - 1) ? 'top' : wallAt(c, r + 1) ? 'bottom' : wallAt(c - 1, r) ? 'left' : wallAt(c + 1, r) ? 'right' : null);
  // A focal STATION (bar / forge / shop counter) can post the keeper AT its station (the barkeep behind the
  // bar, the smith at the forge) by setting this; otherwise the keeper falls back to the room centre.
  let keeperAt: { c: number; r: number } | null = null;
  const inB = (c: number, r: number) => r >= 0 && r < tiles.length && c >= 0 && c < (tiles[0]?.length ?? 0);
  const interior: { c: number; r: number }[] = [];
  for (let y = iy; y < iy + ih; y++) for (let x = ix; x < ix + iw; x++) interior.push({ c: x, r: y });
  for (let i = interior.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = interior[i]!; interior[i] = interior[j]!; interior[j] = t; }
  // CARPET centrepiece (tavern/temple): a 3×3 rug centred in the interior, laid AS TERRAIN so it renders UNDER the furniture/keeper.
  if (tmpl.carpet && iw >= 3 && ih >= 3) {
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const cc = midX + dx, rr = midY + dy;
        if (cc < ix || cc > ix + iw - 1 || rr < iy || rr > iy + ih - 1) continue;
        const vparts = dy < 0 ? 't' : dy > 0 ? 'b' : '';
        const hparts = dx < 0 ? 'l' : dx > 0 ? 'r' : '';
        tiles[rr]![cc] = vparts || hparts ? `carpet_${vparts}${hparts}` : 'carpet_c';
      }
  }
  const dR = door.r, dC = door.c;
  const innerDoor = dR === ry ? { c: dC, r: dR + 1 } : dR === ry + rh - 1 ? { c: dC, r: dR - 1 } : dC === rx ? { c: dC + 1, r: dR } : { c: dC - 1, r: dR };
  const keepClear = innerDoor.r * cols + innerDoor.c;
  const budget = Math.max(1, Math.floor((iw * ih) / 2)); // leave ≥half the floor walkable
  const byBack = (cells: { c: number; r: number }[]) => cells.filter((c) => c.r === iy);
  const byCorner = (cells: { c: number; r: number }[]) => cells.filter((c) => (c.c === ix || c.c === ix + iw - 1) && (c.r === iy || c.r === iy + ih - 1));
  const byCenter = (cells: { c: number; r: number }[]) => [...cells].sort((a, z) => Math.abs(a.c - midX) + Math.abs(a.r - midY) - (Math.abs(z.c - midX) + Math.abs(z.r - midY)));
  const byWall = (cells: { c: number; r: number }[]) => cells.filter((c) => c.r === iy || c.r === iy + ih - 1 || c.c === ix || c.c === ix + iw - 1);
  const around = (cells: { c: number; r: number }[]) => cells.filter((c) => Math.max(Math.abs(c.c - midX), Math.abs(c.r - midY)) === 1);
  const takeCell = (pref?: (cells: { c: number; r: number }[]) => { c: number; r: number }[]): { c: number; r: number } | null => {
    for (const cell of pref ? pref(interior) : interior) {
      if (cell.r * cols + cell.c === keepClear) continue;
      if (!inB(cell.c, cell.r) || occ[cell.r]![cell.c] || !walkable[cell.r]![cell.c]) continue;
      return cell;
    }
    return null;
  };
  // Placement FALLBACK CHAINS — a wall-hugging item that can't get its preferred slot falls back to
  // OTHER WALL cells, never to the middle of the room (that was the "beds in the middle of nowhere" /
  // "bookshelf anywhere" bug). Only center/around/scatter items may sit out in the floor.
  const CHAINS: Record<string, ((cells: { c: number; r: number }[]) => { c: number; r: number }[])[]> = {
    back: [byBack, byWall],
    corner: [byCorner, byWall],
    wall: [byWall],
    around: [around, byCenter],
    center: [byCenter],
    scatter: [],
  };
  const freeFloor = (item: FurnSpec): boolean => item.where === 'center' || item.where === 'around' || item.where === 'scatter';
  let placedFurn = 0;
  if (tmpl.groups && tmpl.groups.length) {
    // RELATIONAL FURNITURE GROUPS — place cohesive arrangements (a table WITH chairs around it, a bed
    // against a wall, a corner of crates) instead of independent items, so rooms read as composed.
    const ORTH4 = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
    const free = (c: number, r: number) => c >= ix && c < ix + iw && r >= iy && r < iy + ih && r * cols + c !== keepClear && !occ[r]![c] && walkable[r]![c];
    const put = (c: number, r: number, tag: string, facing: 'up' | 'down' | 'left' | 'right' = 'down'): boolean => {
      if (placedFurn >= budget || !free(c, r)) return false;
      occ[r]![c] = true; if (propDef(tag)?.blocks ?? true) walkable[r]![c] = false;
      objects.push({ id: `prop:${safe}#${(furnSeq++).toString().padStart(2, '0')}`, kind: 'prop', tag, col: c, row: r, footprint: { w: 1, h: 1 }, facing, visible: true, group: groupId });
      placedFurn++; return true;
    };
    const pick = (pool: string[]) => pool[Math.floor(rand() * pool.length)]!;
    // Post the keeper AT a focal station: reserve the cell AND a standing lane (a free orthogonal neighbour)
    // so later groups can't box the keeper in. Returns true if posted. (bar/forge share this.)
    const reserveKeeper = (c: number, r: number, prefer?: readonly [number, number]): boolean => {
      if (!free(c, r)) return false;
      keeperAt = { c, r }; occ[r]![c] = true;
      const dirs = prefer ? [prefer, ...ORTH4] : ORTH4; // prefer a lane deeper into the room, not a seating cell
      for (const [dx, dy] of dirs) if (free(c + dx, r + dy)) { occ[r + dy]![c + dx] = true; break; }
      return true;
    };
    const wallFree = () => byWall(interior).filter((p) => free(p.c, p.r));
    const alongWall = (pool: string[], n: number) => { let k = 0; for (const p of wallFree()) { if (k >= n) break; if (put(p.c, p.r, pick(pool))) k++; } }; // varied per cell
    const CRATES = ['barrel', 'crate', 'sack', 'jar', 'urn', 'woodpile', 'pot'];
    const storage = () => {
      const cn = byCorner(interior).find((p) => free(p.c, p.r));
      if (!cn) { alongWall(CRATES, 1); return; }
      put(cn.c, cn.r, rand() < 0.25 ? 'chest' : pick(CRATES));
      for (const [dx, dy] of ORTH4) if (rand() < 0.6) put(cn.c + dx, cn.r + dy, pick(CRATES));
    };
    const dining = () => { // a table with a RANDOM 1-2 (rarely 3) chairs on its free sides — not a stiff ring of 4
      const t = takeCell(byCenter); if (!t) return;
      put(t.c, t.r, rand() < 0.4 ? 'table_round' : 'table');
      const sides = ORTH4.filter(([dx, dy]) => free(t.c + dx, t.r + dy));
      for (let s = sides.length - 1; s > 0; s--) { const j = Math.floor(rand() * (s + 1)); const tmp = sides[s]!; sides[s] = sides[j]!; sides[j] = tmp; }
      const n = Math.min(sides.length, 1 + Math.floor(rand() * 2) + (rand() < 0.18 ? 1 : 0));
      for (let i = 0; i < n; i++) { const [dx, dy] = sides[i]!; put(t.c + dx, t.r + dy, i === 0 ? 'chair' : rand() < 0.15 ? 'stone_bench' : 'chair'); } // seat #1 is ALWAYS a chair — the tavern's ≥2-chairs contract holds by construction, benches stay flavour
    };
    // BEDS — against a wall, HEADBOARD on it (BED_TAG/bedSideOf, hoisted above). Every bed in the room shares
    // ONE wall+orientation (locked in by the first bed) so a 2-bed room never mixes directions.
    let bedSide: keyof typeof BED_TAG | null = null;
    let bedsPlaced = 0;
    const bed = () => {
      if (bedsPlaced >= 2) return; // never more than two beds in one room
      const slots = interior.filter((p) => free(p.c, p.r) && bedSideOf(p.c, p.r) !== null); // any free floor cell ACTUALLY against a wall
      // DEEP-CORNER bias: beds take the wall slot FARTHEST from the room's door (prospect-refuge — a bed
      // never sits in the doorway to the public side; stable sort keeps the shuffled order among ties).
      // The FIRST bed also picks a wall side that can host the whole pair (the one-wall-per-room rule would
      // otherwise strand bed #2 when the deepest slot sits on a short wall with a single slot).
      slots.sort((a, b) => (b.c - door.c) ** 2 + (b.r - door.r) ** 2 - ((a.c - door.c) ** 2 + (a.r - door.r) ** 2));
      const pool = bedSide ? slots.filter((p) => bedSideOf(p.c, p.r) === bedSide) : slots;
      const onSide = (s: keyof typeof BED_TAG | null) => pool.filter((q) => bedSideOf(q.c, q.r) === s);
      // The first bed picks the deepest slot on a wall side that can host the PAIR (+ a nightstand): ≥3
      // same-side slots preferred, ≥2 acceptable — else the one-wall-per-room rule strands the second bed.
      const head = (!bedSide && pool.length > 1
        ? pool.find((p) => onSide(bedSideOf(p.c, p.r)).length >= 3) ?? pool.find((p) => onSide(bedSideOf(p.c, p.r)).length >= 2)
        : undefined) ?? pool[0];
      if (!head) return; // no slot left on the established wall → skip rather than break orientation consistency
      bedSide ??= bedSideOf(head.c, head.r);
      if (!put(head.c, head.r, BED_TAG[bedSide!])) return;
      bedsPlaced++;
      if (bedsPlaced === 1) {
        // nightstand beside the first bed — but never on the side's remaining bed slot (it would strand bed #2)
        const sideSlots = onSide(bedSide).filter((p) => free(p.c, p.r));
        const dirs = [...ORTH4].sort((a, b) => +sideSlots.some((p) => p.c === head.c + a[0] && p.r === head.r + a[1]) - +sideSlots.some((p) => p.c === head.c + b[0] && p.r === head.r + b[1]));
        for (const [dx, dy] of dirs) if (rand() < 0.5 && put(head.c + dx, head.r + dy, pick(['pot', 'jar', 'chest', 'candle']))) break;
      }
    };
    const hearth = () => { const b = byBack(interior).find((p) => free(p.c, p.r)) ?? wallFree()[0]; if (b) put(b.c, b.r, rand() < 0.3 ? 'candelabra_large' : 'brazier'); };
    const counter = () => { let k = 0; for (const p of byBack(interior)) { if (k >= 4) break; if (free(p.c, p.r) && put(p.c, p.r, 'table')) k++; } if (k < 2) alongWall(['table'], 2); for (const p of byBack(interior)) if (rand() < 0.3 && put(p.c, p.r, pick(['jar', 'pot', 'urn', 'candle']))) break; };
    // COUNTER STATION — a CONTINUOUS bar_counter RUN, the keeper BEHIND it (between counter and wall) and the
    // customers in FRONT, so it reads as a real double-sided counter (not a wall-mounted shelf). The counter
    // sits ONE ROW OFF the wall where the room is deep enough (>=3 perpendicular); in a shallow room it falls
    // back to wall-flush with the keeper in front. Shared by the tavern bar and the shop service counter.
    // Returns the run + `into` = the CUSTOMER-side direction (where stools/approach go).
    const dTop = dR === ry, dBot = dR === ry + rh - 1, dLeft = dC === rx, dRight = dC === rx + rw - 1;
    type CCfg = { line: { c: number; r: number }[]; back: readonly [number, number]; into: readonly [number, number]; opp: boolean; depth: number; offset: boolean };
    const counterRun = (): { run: { c: number; r: number }[]; dc: number; dr: number } | null => {
      // offset=true configs put the counter one row IN (keeper behind); offset=false are the flush fallback.
      const cfgs: CCfg[] = [
        { line: Array.from({ length: iw }, (_, k) => ({ c: ix + k, r: iy + 1 })), back: [0, -1], into: [0, 1], opp: dBot, depth: ih, offset: true },
        { line: Array.from({ length: iw }, (_, k) => ({ c: ix + k, r: iy + ih - 2 })), back: [0, 1], into: [0, -1], opp: dTop, depth: ih, offset: true },
        { line: Array.from({ length: ih }, (_, k) => ({ c: ix + 1, r: iy + k })), back: [-1, 0], into: [1, 0], opp: dRight, depth: iw, offset: true },
        { line: Array.from({ length: ih }, (_, k) => ({ c: ix + iw - 1, r: iy + k })), back: [1, 0], into: [-1, 0], opp: dLeft, depth: iw, offset: true },
        // flush fallback (shallow rooms): counter ON the wall, keeper in front.
        { line: Array.from({ length: iw }, (_, k) => ({ c: ix + k, r: iy })), back: [0, -1], into: [0, 1], opp: dBot, depth: ih, offset: false },
        { line: Array.from({ length: iw }, (_, k) => ({ c: ix + k, r: iy + ih - 1 })), back: [0, 1], into: [0, -1], opp: dTop, depth: ih, offset: false },
        { line: Array.from({ length: ih }, (_, k) => ({ c: ix, r: iy + k })), back: [-1, 0], into: [1, 0], opp: dRight, depth: iw, offset: false },
        { line: Array.from({ length: ih }, (_, k) => ({ c: ix + iw - 1, r: iy + k })), back: [1, 0], into: [-1, 0], opp: dLeft, depth: iw, offset: false },
      ];
      // prefer: offset (double-sided) over flush, then longer run, then the wall opposite the entrance.
      let best: { run: { c: number; r: number }[]; cfg: CCfg } | null = null;
      const better = (run: { c: number; r: number }[], cfg: CCfg) => {
        if (!best) return true;
        if (cfg.offset !== best.cfg.offset) return cfg.offset; // double-sided wins
        if (run.length !== best.run.length) return run.length > best.run.length;
        return cfg.opp && !best.cfg.opp;
      };
      for (const cfg of cfgs) {
        if (cfg.offset && cfg.depth < 3) continue; // need back-lane + counter + customer space for a double-sided bar
        let cur: { c: number; r: number }[] = [];
        for (const p of [...cfg.line, null]) {
          const ok = p && free(p.c, p.r) && (!cfg.offset || free(p.c + cfg.back[0], p.r + cfg.back[1])); // the staff lane behind must exist
          if (ok) cur.push(p);
          else { if (cur.length >= 2 && better(cur, cfg)) best = { run: cur, cfg }; cur = []; }
        }
      }
      if (!best) return null;
      const { run, cfg } = best;
      for (const p of run) put(p.c, p.r, 'bar_counter');
      const mid = run[Math.floor(run.length / 2)]!;
      // keeper on the SERVICE side: behind the counter for a double-sided bar, in front for the flush fallback.
      const kc = cfg.offset ? mid.c + cfg.back[0] : mid.c + cfg.into[0], kr = cfg.offset ? mid.r + cfg.back[1] : mid.r + cfg.into[1];
      const laneDir: readonly [number, number] = cfg.back[0] === 0 ? [1, 0] : [0, 1]; // a keeper lane parallel to the counter
      reserveKeeper(kc, kr, laneDir);
      return { run, dc: cfg.into[0], dr: cfg.into[1] };
    };
    const bar = () => { // tavern: a counter with patron stools in front + a keg at each end
      const cr = counterRun(); if (!cr) return;
      for (const p of cr.run) { const sc = p.c + cr.dc, sr = p.r + cr.dr; if (free(sc, sr) && rand() < 0.6) put(sc, sr, 'chair'); }
      for (const e of [cr.run[0]!, cr.run[cr.run.length - 1]!]) { const ec = e.c + cr.dc, er = e.r + cr.dr; if (free(ec, er) && rand() < 0.45) put(ec, er, 'barrel'); }
    };
    const shopfront = () => { if (counterRun()) alongWall(['shelf_wares'], 2); }; // shop: the service counter + shopkeeper, with ware shelves on display along the walls
    const checkin = () => { counterRun(); }; // inn: a LEAN check-in counter (keeper behind) — no stools/kegs, so the budget is left for the room's defining beds
    const study = () => { const d = wallFree()[0]; if (!d) return; put(d.c, d.r, 'desk'); for (const [dx, dy] of ORTH4) if (put(d.c + dx, d.r + dy, 'chair')) break; alongWall(['bookshelf_full', 'books'], 2); };
    const altar = () => { const a = byBack(interior).find((p) => free(p.c, p.r)); if (!a) return; put(a.c, a.r, 'altar'); put(a.c - 1, a.r, 'candelabra'); put(a.c + 1, a.r, 'candelabra'); };
    const benches = () => { let k = 0; for (let r = iy + 2; r < iy + ih && k < 6; r += 2) for (let c = ix + 1; c < ix + iw - 1 && k < 6; c += 2) if (put(c, r, 'stone_bench')) k++; };
    // NAVE — the temple focal STATION: altar centered on the wall OPPOSITE the entrance (the visual focus),
    // candelabra flanking it, and pews ranked toward the door in rows with a clear CENTRAL AISLE down the
    // door→altar axis. Orients off the door so the altar always faces the congregation, never the back of the door.
    const nave = () => {
      // 1) ALTAR on the wall OPPOSITE the entrance, preferring that wall's centre — but ALWAYS land it (fall
      //    back to any back/wall cell) so the focal point can never go missing.
      const dTop = dR === ry, dLeft = dC === rx, dRight = dC === rx + rw - 1;
      const horiz = dLeft || dRight; // entrance on a side wall → altar on the far side wall
      const cand: { c: number; r: number }[] = [];
      if (horiz) { const ac = dLeft ? ix + iw - 1 : ix; for (let r = iy; r <= iy + ih - 1; r++) cand.push({ c: ac, r }); }
      else { const ar = dTop ? iy + ih - 1 : iy; for (let c = ix; c <= ix + iw - 1; c++) cand.push({ c, r: ar }); }
      const midOf = horiz ? midY : midX;
      cand.sort((a, b) => Math.abs((horiz ? a.r : a.c) - midOf) - Math.abs((horiz ? b.r : b.c) - midOf)); // centre-out
      const altarCell = cand.find((p) => free(p.c, p.r)) ?? byBack(interior).find((p) => free(p.c, p.r)) ?? wallFree()[0];
      if (!altarCell || !put(altarCell.c, altarCell.r, 'altar')) return;
      const aC = altarCell.c, aR = altarCell.r;
      // 2) which wall is the altar actually against → flank candelabra ALONG it and rank pews AWAY from it.
      const side = wallAt(aC, aR - 1) ? 'top' : wallAt(aC, aR + 1) ? 'bottom' : wallAt(aC - 1, aR) ? 'left' : 'right';
      const vert = side === 'top' || side === 'bottom';
      if (vert) { if (free(aC - 1, aR)) put(aC - 1, aR, 'candelabra'); if (free(aC + 1, aR)) put(aC + 1, aR, 'candelabra'); }
      else { if (free(aC, aR - 1)) put(aC, aR - 1, 'candelabra'); if (free(aC, aR + 1)) put(aC, aR + 1, 'candelabra'); }
      // 3) PEWS ranked away from the altar wall (every other row/col), central aisle aligned with the altar kept clear.
      const step = side === 'top' || side === 'left' ? 1 : -1;
      if (vert) for (let r = aR + 2 * step; r >= iy && r <= iy + ih - 1; r += 2 * step) for (let c = ix; c <= ix + iw - 1; c++) { if (c !== aC) put(c, r, 'stone_bench'); }
      else for (let c = aC + 2 * step; c >= ix && c <= ix + iw - 1; c += 2 * step) for (let r = iy; r <= iy + ih - 1; r++) { if (r !== aR) put(c, r, 'stone_bench'); }
    };
    // FORGE STATION (smithy focal): a lit forge on the wall opposite the entrance, the ANVIL in front of it,
    // the SMITH posted beside the forge, a quench barrel adjacent. (weapon_rack comes from the 'weapons' recipe.)
    const forge = () => {
      const dTop = dR === ry, dLeft = dC === rx, dRight = dC === rx + rw - 1;
      const horiz = dLeft || dRight;
      const line: { c: number; r: number }[] = [];
      if (horiz) { const fc = dLeft ? ix + iw - 1 : ix; for (let r = iy; r <= iy + ih - 1; r++) line.push({ c: fc, r }); }
      else { const fr = dTop ? iy + ih - 1 : iy; for (let c = ix; c <= ix + iw - 1; c++) line.push({ c, r: fr }); }
      const midOf = horiz ? midY : midX;
      line.sort((a, b) => Math.abs((horiz ? a.r : a.c) - midOf) - Math.abs((horiz ? b.r : b.c) - midOf)); // centre-out
      const f = line.find((p) => free(p.c, p.r)) ?? byBack(interior).find((p) => free(p.c, p.r)) ?? wallFree()[0];
      if (!f || !put(f.c, f.r, 'forge')) return;
      const dc = wallAt(f.c - 1, f.r) ? 1 : wallAt(f.c + 1, f.r) ? -1 : 0, dr = dc !== 0 ? 0 : (wallAt(f.c, f.r - 1) ? 1 : -1); // into the room
      const aC = f.c + dc, aR = f.r + dr;
      if (free(aC, aR)) put(aC, aR, 'anvil'); // the anvil right in front of the forge
      for (const [pc, pr] of [[f.c + dr, f.r + dc], [f.c - dr, f.r - dc], [aC + dr, aR + dc], [aC - dr, aR - dc]] as const) if (reserveKeeper(pc, pr, [dc, dr])) break; // the smith, posted at the forge (+ a lane)
      // a quench barrel by the anvil — ALWAYS (a forge reads as a working forge), beside it or else any forge-room wall cell
      if (!([[aC + dr, aR + dc], [aC - dr, aR - dc]] as const).some(([bc, br]) => put(bc, br, 'barrel'))) { const b = wallFree()[0]; if (b) put(b.c, b.r, 'barrel'); }
    };
    // P0 STATIONS (reuse-only props).
    // apse — the CATHEDRAL focal: altar centred on the wall opposite the door, a deity STATUE flanking it (placed
    //   BEFORE the pews so it's guaranteed adjacent + within budget — what makes it read as a cathedral, not a
    //   plain temple), candelabra on the other side, then pews ranked toward the door. Mirrors nave()'s geometry.
    const apse = () => {
      const dTop = dR === ry, dLeft = dC === rx, dRight = dC === rx + rw - 1;
      const horiz = dLeft || dRight;
      const cand: { c: number; r: number }[] = [];
      if (horiz) { const ac = dLeft ? ix + iw - 1 : ix; for (let r = iy; r <= iy + ih - 1; r++) cand.push({ c: ac, r }); }
      else { const ar = dTop ? iy + ih - 1 : iy; for (let c = ix; c <= ix + iw - 1; c++) cand.push({ c, r: ar }); }
      const midOf = horiz ? midY : midX;
      cand.sort((a, b) => Math.abs((horiz ? a.r : a.c) - midOf) - Math.abs((horiz ? b.r : b.c) - midOf));
      const altarCell = cand.find((p) => free(p.c, p.r)) ?? byBack(interior).find((p) => free(p.c, p.r)) ?? wallFree()[0];
      if (!altarCell || !put(altarCell.c, altarCell.r, 'altar')) return;
      const aC = altarCell.c, aR = altarCell.r;
      const side = wallAt(aC, aR - 1) ? 'top' : wallAt(aC, aR + 1) ? 'bottom' : wallAt(aC - 1, aR) ? 'left' : 'right';
      const vert = side === 'top' || side === 'bottom';
      // the deity statue goes BESIDE the altar (within 2 → reads as a cathedral): prefer along-wall flanks, then
      //   into-room diagonals, then a cell two along — never the direct aisle front. Placed before pews so a cell is free.
      const ring: readonly (readonly [number, number])[] = vert
        ? [[-1, 0], [1, 0], [-1, 1], [1, 1], [-1, -1], [1, -1], [-2, 0], [2, 0]]
        : [[0, -1], [0, 1], [1, -1], [1, 1], [-1, -1], [-1, 1], [0, -2], [0, 2]];
      let statued = false;
      for (const [dx, dy] of ring) if (put(aC + dx, aR + dy, 'statue')) { statued = true; break; }
      if (!statued) { const s = byBack(interior).find((p) => free(p.c, p.r)) ?? wallFree()[0]; if (s) put(s.c, s.r, 'statue'); } // guarantee a deity statue even in a cramped apse
      if (vert) { put(aC - 1, aR, 'candelabra'); put(aC + 1, aR, 'candelabra'); } else { put(aC, aR - 1, 'candelabra'); put(aC, aR + 1, 'candelabra'); }
      // pews ranked away from the altar wall (every other row/col), central aisle aligned with the altar kept clear.
      const step = side === 'top' || side === 'left' ? 1 : -1;
      if (vert) for (let r = aR + 2 * step; r >= iy && r <= iy + ih - 1; r += 2 * step) for (let c = ix; c <= ix + iw - 1; c++) { if (c !== aC) put(c, r, 'stone_bench'); }
      else for (let c = aC + 2 * step; c >= ix && c <= ix + iw - 1; c += 2 * step) for (let r = iy; r <= iy + ih - 1; r++) { if (r !== aR) put(c, r, 'stone_bench'); }
    };
    // cells — a JAIL cell block: caged cells along the walls, kept NON-ADJACENT so each reads as a separate cell
    //   (not one wide pen), each with a CLEAR interior front (the focal needs a walkable approach). Jailer desk = 'study'.
    const cells = () => {
      const clearFront = (c: number, r: number) => ORTH4.some(([dx, dy]) => free(c + dx, r + dy) && !wallAt(c + dx, r + dy));
      const placed: { c: number; r: number }[] = [];
      const noAdj = (c: number, r: number) => !placed.some((q) => Math.abs(q.c - c) + Math.abs(q.r - r) === 1);
      let idx = 0;
      for (const p of byBack(interior)) { if (placed.length >= 4) break; if (free(p.c, p.r) && clearFront(p.c, p.r) && noAdj(p.c, p.r) && idx++ % 2 === 0 && put(p.c, p.r, 'cage')) placed.push({ c: p.c, r: p.r }); }
      for (const p of byWall(interior)) { if (placed.length >= 3) break; if (free(p.c, p.r) && clearFront(p.c, p.r) && noAdj(p.c, p.r) && put(p.c, p.r, 'cage')) placed.push({ c: p.c, r: p.r }); }
      for (const p of byWall(interior)) { if (placed.length >= 2) break; if (free(p.c, p.r) && clearFront(p.c, p.r) && put(p.c, p.r, 'cage')) placed.push({ c: p.c, r: p.r }); } // last resort: allow adjacency only to reach a 2-cell block
    };
    // hoard — a VAULT treasury: strongboxes lining the walls (fronts kept clear). Chests DOMINATE (no generic-
    //   crate program) so it reads as a treasury, not a storeroom.
    const hoard = () => {
      let placed = 0;
      for (const p of byBack(interior)) { if (placed >= 6) break; if (free(p.c, p.r) && put(p.c, p.r, 'chest')) placed++; }
      for (const p of byWall(interior)) { if (placed >= 4) break; if (free(p.c, p.r) && put(p.c, p.r, 'chest')) placed++; } // ensure ≥2 chests = a hoard
    };
    // P1 STATIONS (reuse-only props).
    // throne — a seat of power centred on the wall opposite the door, braziers flanking it (keep great hall + goblin warren).
    const throne = () => {
      const dTop = dR === ry, dLeft = dC === rx, dRight = dC === rx + rw - 1;
      const horiz = dLeft || dRight;
      const line: { c: number; r: number }[] = [];
      if (horiz) { const fc = dLeft ? ix + iw - 1 : ix; for (let r = iy; r <= iy + ih - 1; r++) line.push({ c: fc, r }); }
      else { const fr = dTop ? iy + ih - 1 : iy; for (let c = ix; c <= ix + iw - 1; c++) line.push({ c, r: fr }); }
      const midOf = horiz ? midY : midX;
      line.sort((a, b) => Math.abs((horiz ? a.r : a.c) - midOf) - Math.abs((horiz ? b.r : b.c) - midOf));
      const t = line.find((p) => free(p.c, p.r)) ?? byBack(interior).find((p) => free(p.c, p.r)) ?? wallFree()[0];
      if (!t) return;
      const side = wallAt(t.c, t.r - 1) ? 'top' : wallAt(t.c, t.r + 1) ? 'bottom' : wallAt(t.c - 1, t.r) ? 'left' : 'right';
      const faceIn = side === 'top' ? 'down' : side === 'bottom' ? 'up' : side === 'left' ? 'right' : 'left'; // the throne faces INTO the hall, never into the wall behind it
      if (!put(t.c, t.r, 'throne', faceIn)) return;
      if (side === 'top' || side === 'bottom') { put(t.c - 1, t.r, 'brazier'); put(t.c + 1, t.r, 'brazier'); } else { put(t.c, t.r - 1, 'brazier'); put(t.c, t.r + 1, 'brazier'); }
      // reserve a clear standing space in front of the throne (occupied so feast tables / lair clutter can't block it,
      //   but kept WALKABLE so the throne reads as prominent + approachable).
      const into: readonly [number, number] = side === 'top' ? [0, 1] : side === 'bottom' ? [0, -1] : side === 'left' ? [1, 0] : [-1, 0];
      if (free(t.c + into[0], t.r + into[1])) occ[t.r + into[1]]![t.c + into[0]] = true;
    };
    // shelving — a LIBRARY: ranks of full bookshelves along the walls.
    const shelving = () => alongWall(['bookshelf_full'], 4);
    // bunks — a BARRACKS: rows of identical cots, each oriented to its wall (not capped like a bedroom).
    const bunks = () => { let k = 0; for (const p of byWall(interior)) { if (k >= 6) break; const s = bedSideOf(p.c, p.r); if (s && free(p.c, p.r) && put(p.c, p.r, BED_TAG[s])) k++; } };
    // crest — a GUILDHALL: the guild banner on the wall opposite the door + a central meeting table with chairs.
    const crest = () => {
      const b = byBack(interior).find((p) => free(p.c, p.r)) ?? wallFree()[0]; if (b) put(b.c, b.r, 'banner');
      const t = byCenter(interior).find((p) => free(p.c, p.r)); if (t) { put(t.c, t.r, 'table'); let k = 0; for (const [dx, dy] of ORTH4) { if (k >= 3) break; if (free(t.c + dx, t.r + dy) && put(t.c + dx, t.r + dy, 'chair')) k++; } }
    };
    // P2 STATIONS (reuse-only props).
    // sarcophagi — a TOMB/CRYPT: rows of stone sarcophagi along the walls (every other, fronts kept clear), a candle + bones for the crypt mood.
    const sarcophagi = () => {
      let placed = 0, idx = 0;
      for (const p of byBack(interior)) { if (placed >= 4) break; if (free(p.c, p.r) && idx++ % 2 === 0 && put(p.c, p.r, 'sarcophagus')) placed++; }
      for (const p of byWall(interior)) { if (placed >= 2) break; if (free(p.c, p.r) && put(p.c, p.r, 'sarcophagus')) placed++; } // ensure ≥2 = a mausoleum
      const cd = wallFree()[0]; if (cd) put(cd.c, cd.r, 'candelabra');
      let b = 0; for (const p of interior) { if (b >= 2) break; if (free(p.c, p.r) && rand() < 0.3 && put(p.c, p.r, rand() < 0.5 ? 'bones' : 'skull')) b++; }
    };
    // workbench — a CARPENTER'S WORKSHOP: a central workbench, a tool rack, stacked lumber + crates (no gated focal — the clutter is the read).
    const workbench = () => {
      const t = byCenter(interior).find((p) => free(p.c, p.r)); if (t) put(t.c, t.r, 'table');
      alongWall(['weapon_rack'], 1); // the tool rack — placed explicitly so it never drops to a random woodpile pick
      alongWall(['woodpile'], 1);
      let k = 0; for (const p of byCorner(interior)) { if (k >= 2) break; if (free(p.c, p.r) && put(p.c, p.r, k % 2 ? 'crate' : 'woodpile')) k++; }
    };
    // oddments — a CURIO SHOP: walls packed with mismatched bric-a-brac on top of the shopfront counter.
    const oddments = () => alongWall(['pot', 'jar', 'urn', 'chest', 'candle', 'books', 'bones', 'skull'], 4);
    // warren — a GOBLIN LAIR: prisoner CAGES (the lair marker — TWO so the read survives a path-carve deleting one),
    //   a central cookfire (brazier), gnawed bones. (throne = the chief's seat.)
    const warren = () => {
      let cages = 0; for (const p of byWall(interior)) { if (cages >= 2) break; if (free(p.c, p.r) && put(p.c, p.r, 'cage')) cages++; }
      if (cages === 0) { const any = interior.find((p) => free(p.c, p.r)); if (any) put(any.c, any.r, 'cage'); }
      const f = byCenter(interior).find((p) => free(p.c, p.r)); if (f) put(f.c, f.r, 'brazier');
      let b = 0; for (const p of interior) { if (b >= 3) break; if (free(p.c, p.r) && rand() < 0.4 && put(p.c, p.r, rand() < 0.5 ? 'bones' : 'skeleton')) b++; }
    };
    const GROUPS: Record<string, () => void> = {
      dining, bed, hearth, counter, bar, shopfront, checkin, study, altar, benches, nave, forge, storage, apse, cells, hoard, throne, shelving, bunks, crest, warren, sarcophagi, workbench, oddments,
      shelf: () => alongWall(['shelf', 'shelf_food'], 2), books: () => alongWall(['bookshelf_full', 'books'], 3), pantry: () => { alongWall(['shelf_food', 'shelf'], 2); storage(); }, wares: () => { alongWall(['shelf_wares'], 1); alongWall(['shelf_wares', 'pot', 'jar'], 1); }, weapons: () => alongWall(['weapon_rack'], 1), // each wares call GUARANTEES a display shelf (the ≥2-shelves contract must hold by construction, not by dice), then one flavour piece
    };
    for (const g of tmpl.groups) { if (placedFurn >= budget) break; (GROUPS[g] ?? (() => {}))(); }
    // CLUTTER — a couple of small props (tins/jars/chests/books) on free wall-adjacent cells for richness.
    { let cl = 0; const CLUT = ['pot', 'jar', 'urn', 'candle', 'chest', 'books']; for (const p of wallFree()) { if (cl >= 2 || placedFurn >= budget) break; if (rand() < 0.5 && put(p.c, p.r, pick(CLUT))) cl++; } }
  } else {
    for (const item of tmpl.items) {
      for (let k = 0; k < (item.count ?? 1); k++) {
        if (placedFurn >= budget) break;
        let cell: { c: number; r: number } | null = null;
        for (const sel of CHAINS[item.where] ?? []) { cell = takeCell(sel); if (cell) break; }
        if (!cell && freeFloor(item)) cell = takeCell(); // tables/chairs/clutter may use open floor; wall items may NOT
        if (!cell) break;
        occ[cell.r]![cell.c] = true; // reserve so nothing else lands here
        if (propDef(item.tag)?.blocks ?? true) walkable[cell.r]![cell.c] = false; // only blocking furniture blocks pathing
        // A bed orients to whichever wall its cell sits against (same per-side sprite as the groups path).
        const tag = item.tag.startsWith('bed') ? BED_TAG[bedSideOf(cell.c, cell.r) ?? 'top'] : item.tag;
        objects.push({ id: `prop:${safe}#${(furnSeq++).toString().padStart(2, '0')}`, kind: 'prop', tag, col: cell.c, row: cell.r, footprint: { w: 1, h: 1 }, facing: 'down', visible: true, group: groupId });
        placedFurn++;
      }
    }
  }
  // Keeper at its STATION if a focal group posted one (barkeep at the bar), else a NON-BOXED room cell. The
  // keeper must always have a walkable neighbour (it can't be sealed in by its own furniture) — so it can move
  // and be reached. The station RESERVED its keeper cell in occ on purpose, so accept the hint on walkability.
  const N4K = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;
  const notBoxed = (c: number, r: number) => N4K.some(([dc, dr]) => walkable[r + dr]?.[c + dc] === true);
  const pickKeeper = (hint: { c: number; r: number } | null): { c: number; r: number } | null => {
    if (hint && walkable[hint.r]![hint.c] === true && hint.r * cols + hint.c !== keepClear && notBoxed(hint.c, hint.r)) return hint;
    for (const cell of byCenter(interior)) if (cell.r * cols + cell.c !== keepClear && !occ[cell.r]![cell.c] && walkable[cell.r]![cell.c] === true && notBoxed(cell.c, cell.r)) return cell;
    return takeCell(byCenter); // last resort (tiny room): any free cell
  };
  const occCell = tmpl.occupant ? pickKeeper(keeperAt) : null; // empty occupant → no keeper (multi-room compounds put ONE keeper in the primary room only)
  if (occCell) {
    occ[occCell.r]![occCell.c] = true; // reserve (actor doesn't block walkable)
    // The keeper is an individually-addressable NPC (NOT grouped) so the DM digest keeps its id/name/position.
    objects.push({ id: `npc:${safe}-keeper`, kind: 'actor', role: 'npc', tag: isCharacter(tmpl.occupant) ? tmpl.occupant : 'villager', ...(name ? { name } : {}), col: occCell.c, row: occCell.r, footprint: { w: 1, h: 1 }, facing: 'down', visible: true });
  }
  return furnSeq;
}

/** Map each grammar zone to a grid rectangle. Simple + deterministic; refine per grammar later. */
function zoneRects(grammar: LayoutGrammar, cols: number, rows: number): Record<string, Rect> {
  if (grammar === 'enclosed-interior') {
    return {
      wall: { x: 0, y: 0, w: cols, h: rows },
      floor: { x: 1, y: 1, w: cols - 2, h: rows - 2 },
      back: { x: 1, y: 1, w: cols - 2, h: Math.max(1, Math.floor((rows - 2) * 0.4)) },
      entrance: { x: Math.max(1, Math.floor(cols / 2) - 1), y: rows - 2, w: 3, h: 1 },
    };
  }
  if (grammar === 'town-square') {
    const waterH = Math.max(2, Math.floor(rows * 0.16)); // the sea along the bottom
    const topH = Math.max(2, Math.floor(rows * 0.16)); // a band where houses line the back
    const plazaY = topH + 1;
    const plazaH = Math.max(2, rows - waterH - topH - 2);
    const plaza: Rect = { x: 2, y: plazaY, w: cols - 4, h: plazaH };
    const cx = Math.floor(cols / 2);
    const cy = plazaY + Math.floor(plazaH / 2);
    return {
      perimeter: { x: 0, y: 0, w: cols, h: rows },
      'building-row': { x: 1, y: 1, w: cols - 2, h: topH }, // houses along the top
      plaza,
      commons: plaza,
      center: { x: cx - 1, y: cy - 1, w: 2, h: 2 }, // fountain / landmark slot
      'market-row': { x: plaza.x + 1, y: plaza.y + plaza.h - 1, w: plaza.w - 2, h: 1 }, // a line of stalls
      street: { x: cx - 1, y: 0, w: 3, h: rows - waterH }, // a road through the square
      waterside: { x: 0, y: rows - waterH, w: cols, h: waterH },
    };
  }
  // open-outdoor
  const waterH = Math.max(2, Math.floor(rows * 0.22));
  const topH = Math.max(2, Math.floor(rows * 0.18));
  return {
    waterside: { x: 0, y: rows - waterH, w: cols, h: waterH },
    'building-row': { x: 1, y: 1, w: cols - 2, h: topH },
    path: { x: Math.max(1, Math.floor(cols / 2) - 1), y: 0, w: 3, h: rows - waterH },
    commons: { x: 2, y: topH + 1, w: cols - 4, h: Math.max(1, rows - waterH - topH - 2) },
    perimeter: { x: 0, y: 0, w: cols, h: topH },
  };
}

/** Blockout region char → terrain tag (+ whether it's a dense-forest cell). Unknown → grass. */
const BLOCKOUT_REGION: Record<string, { terrain: string; forest?: boolean }> = {
  G: { terrain: 'grass' },
  P: { terrain: 'dirt' },
  W: { terrain: 'water' },
  D: { terrain: 'water_deep' },
  A: { terrain: 'sand' },
  T: { terrain: 'grass', forest: true },
  S: { terrain: 'stone' },
  '#': { terrain: 'wall' },
};
export function buildSceneMap(comp: SceneComposition): SceneMap {
  const cols = Math.max(1, comp.grid.cols);
  const rows = Math.max(1, comp.grid.rows);
  const rand = makeRng(comp.seed);
  const zones = zoneRects(comp.grammar, cols, rows);
  // The Director painted a coarse map — render FROM it (orientation, treelines, sides, rooms)
  // instead of the semantic zones, which can't carry composition. Every scene kind can be painted.
  const useBlockout = !!comp.blockout && comp.blockout.grid.length > 0;
  const isInterior = comp.grammar === 'enclosed-interior';

  // 1) Terrain layer.
  let tiles: string[][];
  const forestCells: { c: number; r: number }[] = [];
  if (useBlockout) {
    const bg = comp.blockout!.grid;
    tiles = Array.from({ length: rows }, (_, y) =>
      Array.from({ length: cols }, (_, x) => {
        const ch = (bg[y]?.[x] ?? 'G').toUpperCase();
        const reg = BLOCKOUT_REGION[ch] ?? BLOCKOUT_REGION['G']!;
        if (reg.forest && !isInterior) forestCells.push({ c: x, r: y });
        return reg.terrain;
      }),
    );
    // Interior safety: a roofed room must be a CLOSED box. Force the outer ring to wall (the Director
    // sometimes leaves a gap) and normalise interior ground to stone floor — keeping any walls/pillars
    // it painted, but never grass/water/trees indoors.
    if (isInterior) {
      for (let y = 0; y < rows; y++)
        for (let x = 0; x < cols; x++) {
          if (x === 0 || y === 0 || x === cols - 1 || y === rows - 1) tiles[y]![x] = wallTagFor(y === 0, y === rows - 1, x === 0, x === cols - 1);
          else if (tiles[y]![x] !== 'wall') tiles[y]![x] = 'stone';
        }
      if (rows > 2 && cols > 2) tiles[Math.floor(rows / 2)]![Math.floor(cols / 2)] = 'stone'; // guarantee floor
    }
  } else {
    // base everywhere, then paint each region's zone rect (in order).
    tiles = Array.from({ length: rows }, () => Array.from({ length: cols }, () => comp.terrain.base));
    for (const region of comp.terrain.regions) {
      const r = zones[region.zone];
      if (!r) continue;
      for (let y = r.y; y < r.y + r.h; y++)
        for (let x = r.x; x < r.x + r.w; x++) {
          const row = tiles[y];
          if (row && x >= 0 && x < cols && y >= 0 && y < rows) row[x] = region.tag;
        }
    }
    // An enclosed interior is a walled room: force a non-walkable border ring and a WALKABLE floor
    // inside — regardless of the order the Director sent terrain regions. (The 'wall' zone spans the
    // whole grid, so a late wall paint would otherwise bury the floor and leave nowhere to stand,
    // collapsing every placement onto one cell.)
    if (comp.grammar === 'enclosed-interior') {
      const floorTag = terrainWalkable(comp.terrain.base) ? comp.terrain.base : 'stone';
      for (let y = 0; y < rows; y++)
        for (let x = 0; x < cols; x++) {
          if (x === 0 || y === 0 || x === cols - 1 || y === rows - 1) tiles[y]![x] = wallTagFor(y === 0, y === rows - 1, x === 0, x === cols - 1);
          else if (!terrainWalkable(tiles[y]![x]!)) tiles[y]![x] = floorTag;
        }
    }
  }
  // Index forest cells for boundary-aware effects (feathering + shoreline).
  const fkey = (c: number, r: number) => r * cols + c;
  const forestSet = new Set(forestCells.map((c) => fkey(c.c, c.r)));

  // Shoreline: where open LAND meets water, lay a 1-tile SAND strip so the waterline reads as a real
  // beach instead of a hard grass↔water seam. Also CAPTURE those cells as the `shore` region so object
  // fields ("crates along the sandy shore") can bind to the true waterline — which RINGS an island, not
  // just the bottom edge. Existing tiles only (sand is a flat gen tile).
  const shoreCells: { c: number; r: number }[] = [];
  const isWaterTile = (t: string | undefined): boolean => t === 'water' || t === 'water_deep';
  if (!isInterior) {
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++) {
        if (tiles[y]![x] !== 'grass' || forestSet.has(fkey(x, y))) continue;
        const nearWater = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).some(([dx, dy]) => isWaterTile(tiles[y + dy]?.[x + dx]));
        if (nearWater) shoreCells.push({ c: x, r: y });
      }
    for (const { c, r } of shoreCells) tiles[r]![c] = 'sand';
  }

  const walkable: boolean[][] = tiles.map((row) => row.map((t) => terrainWalkable(t)));
  const occ: boolean[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => false));

  // Forest fill with FEATHERED density: dense at the forest's core, thinning toward the clearing, with
  // bushy undergrowth at the fringe + a little spill into the open — so a treeline reads as a natural
  // mass, not a flat rectangle. depth = steps from the nearest OPEN (non-forest) cell; the map border
  // does NOT count as open, so a treeline at the screen edge stays dense there.
  const forestAmbiance: AmbianceItem[] = [];
  if (useBlockout && forestCells.length) {
    const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
    const depth = new Map<number, number>();
    let frontier: { c: number; r: number }[] = [];
    for (const fc of forestCells) {
      let fringe = false;
      for (let dy = -1; dy <= 1 && !fringe; dy++)
        for (let dx = -1; dx <= 1 && !fringe; dx++) {
          if (!dx && !dy) continue;
          const nx = fc.c + dx, ny = fc.r + dy;
          if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && !forestSet.has(fkey(nx, ny))) fringe = true; // touches open ground
        }
      if (fringe) { depth.set(fkey(fc.c, fc.r), 1); frontier.push(fc); }
    }
    for (let d = 1; frontier.length; d++) {
      const next: { c: number; r: number }[] = [];
      for (const fc of frontier)
        for (const [dx, dy] of ORTH) {
          const nx = fc.c + dx, ny = fc.r + dy, k = fkey(nx, ny);
          if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && forestSet.has(k) && !depth.has(k)) { depth.set(k, d + 1); next.push({ c: nx, r: ny }); }
        }
      frontier = next;
    }
    const CORE = ['tree', 'tree', 'tree_pine', 'tree_pine', 'tree_autumn'] as const;
    const FRINGE = ['bush', 'bush', 'tree', 'tree_autumn'] as const;
    for (const fc of forestCells) {
      const dep = depth.get(fkey(fc.c, fc.r)) ?? 3;
      const density = dep >= 3 ? 0.95 : dep === 2 ? 0.8 : 0.4; // feather toward the clearing
      if (rand() >= density) continue;
      const pool = dep <= 1 ? FRINGE : CORE;
      forestAmbiance.push({ tag: pool[Math.floor(rand() * pool.length)]!, col: fc.c, row: fc.r });
      walkable[fc.r]![fc.c] = false; // forest is a barrier
    }
    // A little undergrowth creeps from the treeline into the open, softening the hard edge. Decorative
    // (the tile stays walkable for pathing) but reserved from entity placement so no one stands in a bush.
    const spilled = new Set<number>();
    for (const fc of forestCells)
      for (const [dx, dy] of ORTH) {
        const nx = fc.c + dx, ny = fc.r + dy, k = fkey(nx, ny);
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        if (forestSet.has(k) || spilled.has(k) || tiles[ny]![nx] !== 'grass') continue;
        if (rand() < 0.15) { forestAmbiance.push({ tag: 'bush', col: nx, row: ny }); occ[ny]![nx] = true; spilled.add(k); }
      }
  }

  const inB = (c: number, r: number) => c >= 0 && c < cols && r >= 0 && r < rows;
  const free = (c: number, r: number) => inB(c, r) && walkable[r]![c] === true && occ[r]![c] === false;
  const footFits = (c: number, r: number, w: number, h: number) => {
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) if (!free(c + dx, r + dy)) return false;
    return true;
  };

  /** Cells of a rect, shuffled by seed (so placement is varied but reproducible). */
  const cellsOf = (rect: Rect): { c: number; r: number }[] => {
    const cells: { c: number; r: number }[] = [];
    for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) if (inB(x, y)) cells.push({ c: x, r: y });
    for (let i = cells.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = cells[i]!;
      cells[i] = cells[j]!;
      cells[j] = tmp;
    }
    return cells;
  };

  const footprintOf = (tag: string, kind: string): { w: number; h: number } => {
    if (kind === 'fixture') {
      const d = propDef(tag);
      return { w: d?.w ?? 1, h: d?.h ?? 1 };
    }
    return { w: 1, h: 1 }; // props + actors are 1x1 for now
  };

  const placedPos = new Map<string, { c: number; r: number }>();
  const placedCells: { c: number; r: number; kind: string }[] = []; // for anti-cluster spacing
  const ADJ = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [-1, -1],
    [1, -1],
    [-1, 1],
  ] as const;

  // Nearest in-bounds cell that fits the footprint to a target point — resolve OUTWARD from the
  // ideal, so an absolute anchor like 'center' lands at the center even when the exact cell is taken.
  const nearestFit = (tc: number, tr: number, fp: { w: number; h: number }): { c: number; r: number } | null => {
    let best: { c: number; r: number } | null = null;
    let bestD = Infinity;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        if (!footFits(c, r, fp.w, fp.h)) continue;
        const d = (c - tc) * (c - tc) + (r - tr) * (r - tr);
        if (d < bestD) {
          bestD = d;
          best = { c, r };
        }
      }
    return best;
  };

  const cxC = (cols - 1) / 2;
  const cyC = (rows - 1) / 2;

  // A cell that is GUARANTEED placeable: the nearest free walkable fit; or, only if the map is
  // genuinely full (no free fitting cell anywhere), carve a walkable spot at the target so an actor
  // never lands inside a wall/fixture. The carve is a last-resort for a degenerate, over-full scene.
  const guaranteedCell = (tc: number, tr: number, fp: { w: number; h: number }): { c: number; r: number } => {
    const hit = nearestFit(tc, tr, fp);
    if (hit) return hit;
    // No free fitting cell anywhere. Carve the nearest UNOCCUPIED cell walkable — never an occupied one,
    // so we don't stack two objects on a tile (degenerate, only when the map is essentially full).
    let best: { c: number; r: number } | null = null;
    let bestD = Infinity;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        if (occ[r]![c]) continue;
        const d = (c - tc) * (c - tc) + (r - tr) * (r - tr);
        if (d < bestD) { bestD = d; best = { c, r }; }
      }
    const cell = best ?? { c: Math.max(0, Math.min(cols - 1, Math.round(tc))), r: Math.max(0, Math.min(rows - 1, Math.round(tr))) };
    if (inB(cell.c, cell.r)) walkable[cell.r]![cell.c] = true;
    return cell;
  };
  // Edge/zone anchors resolve to a BAND, so many props sharing 'north-edge' spread into a LINE
  // along the edge instead of piling on one point. ('center' is handled separately as a point —
  // the single centrepiece.) Returns null for an unknown anchor.
  const anchorBand = (a: string): Rect | null => {
    const tb = Math.max(2, Math.floor(rows * 0.2)); // top/bottom band thickness
    const sb = Math.max(2, Math.floor(cols * 0.16)); // left/right band thickness
    switch (a) {
      case 'north':
      case 'north-edge':
        return { x: 0, y: 0, w: cols, h: tb };
      case 'south':
      case 'south-edge':
        return { x: 0, y: rows - tb, w: cols, h: tb };
      case 'west':
      case 'west-edge':
        return { x: 0, y: 0, w: sb, h: rows };
      case 'east':
      case 'east-edge':
        return { x: cols - sb, y: 0, w: sb, h: rows };
      case 'waterside':
        return zones['waterside'] ?? { x: 0, y: rows - tb, w: cols, h: tb };
      case 'entrance':
        return zones['entrance'] ?? { x: Math.max(0, Math.floor(cols / 2) - 1), y: rows - 2, w: 3, h: 2 };
      default:
        return null;
    }
  };

  // Pick a fitting cell in `rect` that stays AWAY from already-placed objects of the same kind.
  // cellsOf is seed-shuffled; we then choose the best-spread candidate so actors/fixtures don't bunch.
  const pickSpread = (rect: Rect, fp: { w: number; h: number }, kind: string): { c: number; r: number } | null => {
    let best: { c: number; r: number } | null = null;
    let bestScore = -1;
    let scanned = 0;
    for (const cell of cellsOf(rect)) {
      if (!footFits(cell.c, cell.r, fp.w, fp.h)) continue;
      let md = Infinity;
      for (const q of placedCells) if (q.kind === kind) md = Math.min(md, Math.max(Math.abs(q.c - cell.c), Math.abs(q.r - cell.r)));
      const score = md === Infinity ? 999 : md;
      if (score > bestScore) {
        bestScore = score;
        best = cell;
      }
      if (bestScore >= 3 || ++scanned > 80) break; // well-spread enough / bounded scan
    }
    return best;
  };

  const resolve = (p: Placement, fp: { w: number; h: number }): { c: number; r: number } => {
    // near:<id> → an open cell adjacent to the (already-placed) referent.
    if (p.anchor?.startsWith('near:')) {
      const ref = placedPos.get(p.anchor.slice(5));
      if (ref) for (const [dc, dr] of ADJ) if (footFits(ref.c + dc, ref.r + dr, fp.w, fp.h)) return { c: ref.c + dc, r: ref.r + dr };
    }
    // Absolute base anchor. 'center' → the single nearest cell (the centrepiece); edge/zone
    // anchors → spread along a BAND so a shared anchor forms a line, not a pile.
    if (p.anchor && !p.anchor.startsWith('in:') && !p.anchor.startsWith('near:')) {
      if (p.anchor === 'center') {
        const hit = nearestFit(cxC, cyC, fp);
        if (hit) return hit;
      } else {
        const band = anchorBand(p.anchor);
        if (band) {
          const hit = pickSpread(band, fp, p.kind);
          if (hit) return hit;
        }
      }
    }
    // Otherwise place within the zone, spread away from same-kind neighbors.
    const zoneName = p.anchor?.startsWith('in:') ? p.anchor.slice(3) : p.zone;
    const rect = zones[zoneName] ?? zones[p.zone] ?? { x: 0, y: 0, w: cols, h: rows };
    return (
      pickSpread(rect, fp, p.kind) ??
      pickSpread({ x: 0, y: 0, w: cols, h: rows }, fp, p.kind) ?? // fallback: anywhere walkable
      guaranteedCell(cxC, cyC, fp) // degenerate last resort — always a WALKABLE cell, never inside a wall
    );
  };

  // Blockout placement: snap each entity to the nearest walkable cell to the coordinate the Director
  // painted for it (ignores semantic anchors — the painted cell IS the intent). No cell → centre.
  const cellById = new Map((comp.blockout?.cells ?? []).map((c) => [c.id, c]));
  const resolveBlockout = (p: Placement, fp: { w: number; h: number }): { c: number; r: number } => {
    const cell = cellById.get(p.id);
    // A fountain/well is the centrepiece of a settlement square — keep it centred even when painted
    // off-centre, so the town-square's read survives. Everything else honours its painted cell.
    const centrepiece = comp.grammar === 'town-square' && /fountain|well/.test(p.tag);
    const tc = centrepiece ? cxC : cell ? cell.col : Math.round(cxC);
    const tr = centrepiece ? cyC : cell ? cell.row : Math.round(cyC);
    return nearestFit(tc, tr, fp) ?? pickSpread({ x: 0, y: 0, w: cols, h: rows }, fp, p.kind) ?? guaranteedCell(cxC, cyC, fp);
  };

  // Place non-near first (fixtures → props → actors), then near-anchored ones.
  const rank = (k: string) => (k === 'fixture' ? 0 : k === 'prop' ? 1 : 2);
  const order = [...comp.placements].sort((a, b) => {
    const na = a.anchor?.startsWith('near:') ? 1 : 0;
    const nb = b.anchor?.startsWith('near:') ? 1 : 0;
    return na !== nb ? na - nb : rank(a.kind) - rank(b.kind);
  });

  const objects: MapObject[] = [];
  const entrances: Entrance[] = [];

  // BUILDINGS → roofless WALLED ROOMS. Carve each plot into a wall ring + stone floor, punch ONE
  // door (connecting interior↔outside), record an Entrance, furnish the interior from the per-type
  // template, and seat an occupant. Runs BEFORE entity placement so the floors/plaza are correct
  // when declared entities snap, and so furniture cells are reserved (occ) against overlap.
  let furnSeq = 0;
  const carvedRects: Rect[] = [];
  for (const b of comp.buildings ?? []) {
    const rx = Math.max(0, Math.min(cols - 1, b.rect.x));
    const ry = Math.max(0, Math.min(rows - 1, b.rect.y));
    const rw = Math.min(cols - rx, b.rect.w);
    const rh = Math.min(rows - ry, b.rect.h);
    if (rw < 3 || rh < 3) continue; // too small to be a room
    // Skip a building whose plot overlaps an already-carved one — carving it would reset the prior
    // room's reserved cells and stack two objects on a tile. (The composer emits non-overlapping
    // plots; this guards external callers / Director-authored rects.)
    if (carvedRects.some((q) => rx < q.x + q.w && rx + rw > q.x && ry < q.y + q.h && ry + rh > q.y)) continue;
    carvedRects.push({ x: rx, y: ry, w: rw, h: rh });
    // Child ids carry a kind-correct prefix (prop:/npc:) so they pass validation; `group` keeps the
    // building link. `safe` = the building id minus its prefix, sanitized.
    const safe = (b.id.includes(':') ? b.id.slice(b.id.indexOf(':') + 1) : b.id).replace(/[^a-z0-9_-]/gi, '-').toLowerCase() || 'bldg';
    const tmpl = BUILDING_TEMPLATES[b.type];
    for (let y = ry; y < ry + rh; y++)
      for (let x = rx; x < rx + rw; x++) {
        const top = y === ry, bot = y === ry + rh - 1, left = x === rx, right = x === rx + rw - 1;
        if (top || bot || left || right) { tiles[y]![x] = wallTagFor(top, bot, left, right, tmpl.wall); walkable[y]![x] = false; occ[y]![x] = true; }
        else { tiles[y]![x] = tmpl.floor; walkable[y]![x] = true; occ[y]![x] = false; }
      }
    // Door: the middle of a wall → floor + walkable, with the cell just OUTSIDE open. Try the declared
    // side first, then fall back to any side whose outside cell is on-grid (an edge-flush rect would
    // otherwise punch a door to nowhere).
    const midX = rx + Math.floor(rw / 2);
    const midY = ry + Math.floor(rh / 2);
    const doorFor = (side: string): { dC: number; dR: number; oC: number; oR: number } =>
      side === 'north' ? { dC: midX, dR: ry, oC: midX, oR: ry - 1 }
      : side === 'east' ? { dC: rx + rw - 1, dR: midY, oC: rx + rw, oR: midY }
      : side === 'west' ? { dC: rx, dR: midY, oC: rx - 1, oR: midY }
      : { dC: midX, dR: ry + rh - 1, oC: midX, oR: ry + rh }; // south
    let door = doorFor(b.door);
    if (!inB(door.oC, door.oR)) door = [b.door, 'south', 'north', 'east', 'west'].map(doorFor).find((d) => inB(d.oC, d.oR)) ?? door;
    const { dC, dR, oC, oR } = door;
    tiles[dR]![dC] = tmpl.floor; walkable[dR]![dC] = true; occ[dR]![dC] = false;
    if (inB(oC, oR)) { walkable[oR]![oC] = true; occ[oR]![oC] = false; if (tiles[oR]![oC]!.startsWith('wall')) tiles[oR]![oC] = 'dirt'; }
    entrances.push({ toLocationId: comp.locationId, col: dC, row: dR, ...(b.id ? { fixtureId: b.id } : {}) });

    // FURNISH the interior from the per-type template (shared helper — the primitive engine uses the
    // SAME furnishRoom so both paths furnish identically). Keeps the door's inner cell clear.
    furnSeq = furnishRoom(tiles, walkable, occ, objects, { x: rx, y: ry, w: rw, h: rh }, tmpl, { c: dC, r: dR }, rand, cols, safe, b.id, furnSeq, b.name);

    // DOOR CLEARANCE — guarantee the entrance is TRAVERSABLE: clear any furniture from the cell just inside
    // the door (furnishRoom already keeps it clear; this is the universal belt-and-suspenders, same as compound).
    const inIC = 2 * dC - oC, inIR = 2 * dR - oR;
    if (inB(inIC, inIR) && walkable[inIR]![inIC] === false && !(tiles[inIR]![inIC] ?? '').startsWith('wall')) {
      for (let i = objects.length - 1; i >= 0; i--) { const o = objects[i]!; if (o.kind === 'prop' && o.col === inIC && o.row === inIR) objects.splice(i, 1); }
      occ[inIR]![inIC] = false; walkable[inIR]![inIC] = true;
    }
  }

  for (const p of order) {
    // PLATFORM (boat/raft/bridge): may sit ON water — anchor at its painted cell (or the nearest water
    // tile) WITHOUT snapping to land, and make its whole footprint walkable so the party can board it.
    const pdef = p.kind !== 'actor' ? propDef(p.tag) : undefined;
    if (pdef?.platform) {
      const pw = Math.max(1, pdef.w), ph = Math.max(1, pdef.h);
      const cell = cellById.get(p.id);
      let ac: number, ar: number;
      if (cell) { ac = cell.col; ar = cell.row; }
      else {
        let found: { c: number; r: number } | null = null;
        for (let r = 0; r < rows && !found; r++) for (let c = 0; c < cols && !found; c++) if (isWaterTile(tiles[r]![c])) found = { c, r };
        ac = found?.c ?? Math.round(cxC); ar = found?.r ?? Math.round(cyC);
      }
      ac = Math.max(0, Math.min(cols - pw, ac)); ar = Math.max(0, Math.min(rows - ph, ar));
      for (let dy = 0; dy < ph; dy++) for (let dx = 0; dx < pw; dx++) { const cc = ac + dx, rr = ar + dy; if (inB(cc, rr)) { walkable[rr]![cc] = true; occ[rr]![cc] = false; } }
      occ[ar]![ac] = true; // the hull's own origin cell (so an actor doesn't overlap the boat object)
      placedPos.set(p.id, { c: ac, r: ar });
      placedCells.push({ c: ac, r: ar, kind: p.kind });
      objects.push({ id: p.id, kind: p.kind, ...(p.role ? { role: p.role } : {}), tag: p.tag, ...(p.name ? { name: p.name } : {}), col: ac, row: ar, footprint: { w: pw, h: ph }, facing: p.facing ?? 'down', visible: p.visible, zone: p.zone, ...(p.anchor ? { anchorRef: p.anchor } : {}) });
      continue;
    }
    const fp = footprintOf(p.tag, p.kind);
    const pos = useBlockout ? resolveBlockout(p, fp) : resolve(p, fp);
    for (let dy = 0; dy < fp.h; dy++)
      for (let dx = 0; dx < fp.w; dx++) {
        const cc = pos.c + dx;
        const rr = pos.r + dy;
        if (inB(cc, rr)) {
          occ[rr]![cc] = true;
          if (p.kind === 'fixture') walkable[rr]![cc] = false; // a building blocks the tiles it sits on
        }
      }
    placedPos.set(p.id, pos);
    placedCells.push({ c: pos.c, r: pos.r, kind: p.kind });
    objects.push({
      id: p.id,
      kind: p.kind,
      ...(p.role ? { role: p.role } : {}),
      tag: p.tag,
      ...(p.name ? { name: p.name } : {}),
      col: pos.c,
      row: pos.r,
      footprint: fp,
      facing: p.facing ?? 'down',
      visible: p.visible,
      zone: p.zone,
      ...(p.anchor ? { anchorRef: p.anchor } : {}),
    });
  }

  // OBJECT FIELDS: expand each into N concrete, id-addressed children (idBase#NN). Runs AFTER point
  // placement so point actors keep first pick of walkable cells, and field `spacing` leaves lanes.
  const clampRect = (r: Rect): Rect => {
    const x = Math.max(0, Math.min(cols - 1, r.x));
    const y = Math.max(0, Math.min(rows - 1, r.y));
    return { x, y, w: Math.max(1, Math.min(cols - x, r.w)), h: Math.max(1, Math.min(rows - y, r.h)) };
  };
  const BAND_ALIAS: Record<string, string> = { left: 'west', right: 'east', top: 'north', bottom: 'south', north: 'north', south: 'south', east: 'east', west: 'west' };
  const regionRect = (field: ObjectField): Rect => {
    // `near:<id>` → a box centred on that placed landmark (flank/ring/cluster around it).
    if (field.region.near) {
      const ref = placedPos.get(field.region.near);
      if (ref) {
        const half = field.arrangement === 'flank' ? 1 : field.arrangement === 'ring' ? 2 : Math.max(2, Math.ceil(Math.sqrt(field.count ?? 6)));
        return clampRect({ x: ref.c - half, y: ref.r - half, w: 2 * half + 1, h: 2 * half + 1 });
      }
      // unresolvable ref → fall through to band/rect/centre
    }
    if (field.region.rect) return clampRect(field.region.rect);
    const b = field.region.band ?? 'all';
    const aliased = BAND_ALIAS[b];
    if (aliased) {
      const band = anchorBand(aliased);
      if (band) return clampRect(band);
    }
    if (b === 'center') return clampRect({ x: 2, y: 2, w: cols - 4, h: rows - 4 });
    return clampRect({ x: 1, y: 1, w: cols - 2, h: rows - 2 }); // 'all'
  };
  /** Ordered target cells for an arrangement within a rect (deterministic; scatter is seed-shuffled).
   *  `aisle` carves a clear central lane (a column or row left empty) through a row/grid. */
  const fieldTargets = (rect: Rect, arr: ObjectField['arrangement'], spacing: number, aisle?: 'vertical' | 'horizontal'): { c: number; r: number }[] => {
    const s = Math.max(1, spacing);
    const x0 = rect.x, y0 = rect.y, x1 = rect.x + rect.w - 1, y1 = rect.y + rect.h - 1;
    const midR = y0 + Math.floor(rect.h / 2), midC = x0 + Math.floor(rect.w / 2);
    const out: { c: number; r: number }[] = [];
    if (arr === 'grid') for (let r = y0; r <= y1; r += s) for (let c = x0; c <= x1; c += s) out.push({ c, r });
    else if (arr === 'row') for (let c = x0; c <= x1; c += s) out.push({ c, r: midR });
    else if (arr === 'line') {
      if (rect.w >= rect.h) for (let c = x0; c <= x1; c += s) out.push({ c, r: midR });
      else for (let r = y0; r <= y1; r += s) out.push({ c: midC, r });
    } else if (arr === 'ring' && rect.w >= 3 && rect.h >= 3) {
      for (let c = x0; c <= x1; c += s) { out.push({ c, r: y0 }); if (y1 !== y0) out.push({ c, r: y1 }); }
      for (let r = y0 + s; r < y1; r += s) { out.push({ c: x0, r }); if (x1 !== x0) out.push({ c: x1, r }); }
    } else if (arr === 'ring') {
      // A ring needs a 3×3+ rect to read as a perimeter; on a thin band it degenerates to a line.
      if (rect.w >= rect.h) for (let c = x0; c <= x1; c += s) out.push({ c, r: midR });
      else for (let r = y0; r <= y1; r += s) out.push({ c: midC, r });
    } else if (arr === 'flank') {
      out.push({ c: x0, r: midR });
      if (x1 !== x0) out.push({ c: x1, r: midR });
    } else {
      for (let r = y0; r <= y1; r++) for (let c = x0; c <= x1; c++) out.push({ c, r });
      for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = out[i]!; out[i] = out[j]!; out[j] = t; }
    }
    // Carve a central lane — but if the filter would remove EVERY target (a too-narrow region), keep the
    // unfiltered targets so the field still places (and an absorbed entity never lands in the empty aisle).
    if (aisle === 'vertical') { const f = out.filter((t) => t.c !== midC); return f.length ? f : out; }
    if (aisle === 'horizontal') { const f = out.filter((t) => t.r !== midR); return f.length ? f : out; }
    return out;
  };
  for (const field of comp.fields ?? []) {
    const d = propDef(field.tag);
    const fp = field.kind === 'actor' ? { w: 1, h: 1 } : { w: d?.w ?? 1, h: d?.h ?? 1 };
    const blocks = field.kind !== 'actor' && (d?.blocks ?? true);
    const spacing = field.spacing ?? (field.arrangement === 'scatter' ? 1 : 2);
    // `shore` is a special region: the computed waterline cells (a ring on an island), not a rect.
    const onShore = field.region.band === 'shore';
    const rect = regionRect(field);
    let targets: { c: number; r: number }[];
    if (onShore) {
      targets = [...shoreCells];
      for (let i = targets.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = targets[i]!; targets[i] = targets[j]!; targets[j] = t; }
    } else {
      targets = fieldTargets(rect, field.arrangement, spacing, field.aisle);
    }
    const defaultCount = field.arrangement === 'scatter' || onShore ? 6 : field.arrangement === 'flank' ? 2 : targets.length;
    const cap = Math.min(FIELD_LIMITS.maxCount, field.count ?? defaultCount);
    const snapMax = Math.max(2, spacing); // a child may snap up to ~one spacing-step toward a free cell
    const midR2 = onShore && shoreCells.length ? shoreCells[0]!.r : rect.y + Math.floor(rect.h / 2);
    const midC2 = onShore && shoreCells.length ? shoreCells[0]!.c : rect.x + Math.floor(rect.w / 2);
    const place = (pos: { c: number; r: number }, n: number): void => {
      for (let dy = 0; dy < fp.h; dy++)
        for (let dx = 0; dx < fp.w; dx++) {
          const cc = pos.c + dx, rr = pos.r + dy;
          if (inB(cc, rr)) { occ[rr]![cc] = true; if (blocks) walkable[rr]![cc] = false; }
        }
      objects.push({ id: `${field.idBase}#${n.toString().padStart(2, '0')}`, kind: field.kind, ...(field.role ? { role: field.role } : {}), tag: field.tag, ...(field.name ? { name: field.name } : {}), col: pos.c, row: pos.r, footprint: fp, facing: field.facing ?? 'down', visible: field.visible ?? true, group: field.idBase });
    };
    let n = 0;
    for (const t of targets) {
      if (n >= cap) break;
      let pos: { c: number; r: number } | null = footFits(t.c, t.r, fp.w, fp.h) ? { c: t.c, r: t.r } : null;
      if (!pos) {
        const hit = nearestFit(t.c, t.r, fp); // snap to a nearby free cell, but don't teleport across the map
        if (hit && Math.max(Math.abs(hit.c - t.c), Math.abs(hit.r - t.r)) <= snapMax) pos = hit;
      }
      if (!pos) continue;
      place(pos, n);
      n++;
    }
    // An ABSORBED declared entity must appear — guarantee at least one child even if every target was
    // skipped (e.g. a tiny/crowded region), so the entity never silently vanishes from the scene.
    if (n === 0) place(guaranteedCell(midC2, midR2, fp), 0);
  }

  // Reachability guard: a dense field must never TRAP an actor. If any actor has no walkable orthogonal
  // neighbour (boxed in by field props), open one adjacent cell so it can always step out.
  const ORTH4 = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  for (const o of objects) {
    if (o.kind !== 'actor') continue;
    if (ORTH4.some(([dx, dy]) => walkable[o.row + dy]?.[o.col + dx] === true)) continue;
    // Open an UNOCCUPIED neighbour (don't make an occupied cell walkable — that would invite an overlap);
    // if every neighbour is occupied the actor is genuinely packed in, leave it rather than stack.
    for (const [dx, dy] of ORTH4) { const cc = o.col + dx, rr = o.row + dy; if (inB(cc, rr) && !occ[rr]![cc]) { walkable[rr]![cc] = true; break; } }
  }

  // GLOBAL REACHABILITY: a walled settlement must never seal off an actor or a door. Only needed when
  // buildings exist (the carved walls are the only thing that can isolate a cell). Extracted helper —
  // the city stitcher reuses it on the assembled grid.
  if ((comp.buildings?.length ?? 0) > 0) reachabilityCarve(tiles, walkable, cols, rows, objects, entrances);

  // Ambiance. In blockout mode the forest fill IS the ambiance (already placed, intentionally dense);
  // otherwise seed-scatter decor biased to the PERIMETER so the playable middle stays legible, and
  // hard-capped so a village never reads as a forest. Tree sprites are tall/wide, so a little goes far.
  const ambiance: AmbianceItem[] = useBlockout ? forestAmbiance : [];
  const tags = comp.ambiance.tags;
  if (!useBlockout && tags.length > 0 && comp.ambiance.density > 0) {
    const AMBIANCE_CAP = 12;
    const band = 3; // cells from the edge counted as "perimeter"
    const candidates = cellsOf({ x: 0, y: 0, w: cols, h: rows }).filter((c) => free(c.c, c.r));
    const edge = candidates.filter((c) => c.c < band || c.c >= cols - band || c.r < band || c.r >= rows - band);
    const pool = edge.length >= 8 ? edge : candidates; // frame the scene; fall back if there's no room
    const count = Math.min(pool.length, AMBIANCE_CAP, Math.floor(pool.length * comp.ambiance.density));
    for (let i = 0; i < count; i++) {
      const cell = pool[i]!;
      const tag = tags[Math.floor(rand() * tags.length)]!;
      occ[cell.r]![cell.c] = true;
      ambiance.push({ tag, col: cell.c, row: cell.r });
    }
  }

  // SETTLEMENT GREENERY: a town shouldn't sit on a bare lot. Scatter trees/bushes (blocking) +
  // wildflowers (walkable decals) across the GRASS margins between/around the carved buildings, so it
  // reads like the reference's leafy village. Seed-stable; only touches free grass, so streets,
  // plazas, buildings and entities are untouched and reachability holds.
  if (useBlockout && comp.grammar === 'town-square') {
    const grass: { c: number; r: number }[] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (tiles[r]![c] === 'grass' && free(c, r)) grass.push({ c, r });
    for (let i = grass.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = grass[i]!; grass[i] = grass[j]!; grass[j] = t; }
    const TREES = ['tree', 'tree', 'tree_pine', 'bush'] as const;
    let gi = 0;
    const trees = Math.min(grass.length, 70, Math.max(6, Math.floor(grass.length * 0.2))); // abs cap so big maps don't explode the prop count
    for (let n = 0; n < trees && gi < grass.length; n++, gi++) {
      const cell = grass[gi]!;
      occ[cell.r]![cell.c] = true;
      walkable[cell.r]![cell.c] = false; // trees block
      ambiance.push({ tag: TREES[Math.floor(rand() * TREES.length)]!, col: cell.c, row: cell.r });
    }
    const flowers = Math.min(grass.length - gi, 50, Math.max(4, Math.floor(grass.length * 0.15)));
    for (let n = 0; n < flowers && gi < grass.length; n++, gi++) {
      const cell = grass[gi]!;
      occ[cell.r]![cell.c] = true; // a walkable decal — DON'T clear walkable
      ambiance.push({ tag: 'flowers', col: cell.c, row: cell.r });
    }
  }

  // C2 GROUND DECALS: a light, NON-BLOCKING scatter of pebbles + grass tufts on open natural ground
  // (grass/dirt/sand — not stone plaza/interiors/water) for lived-in floor detail. Extracted helper —
  // runs before the auto-tile bake (decals are objects, not tiles, so the bake is unaffected).
  if (!isInterior) scatterGroundDecals(tiles, walkable, occ, cols, rows, ambiance, rand);

  // TERRAIN AUTO-TILING (C1): edge cells of an EDGED terrain so boundaries read with real DawnLike
  // edge tiles instead of a hard rectangular seam. Baked LAST — reads the FINAL tiles grid (after
  // building-carve, reachability dirt-carving, the shoreline sand strip), so it edges against whatever
  // ended up adjacent. Off-grid neighbours count as same (the screen border doesn't fringe, matching
  // the forest-feather rule). GRASS owns its boundaries (grass-on-dirt fade — looks right vs dirt/
  // sand/stone/wall); WATER (incl. water_deep, same family) owns the SHORELINE (a brown shore rim,
  // which the sand-strip puts against sand). dirt/sand need no own edge set — grass+water already own
  // every boundary they touch (a standalone set would just double-edge). `walkable` was computed from
  // the base terrain and each *_edge shares its base's walkability, so it stays consistent.
  if (!isInterior) bakeAutoTiles(tiles, cols, rows);

  return {
    locationId: comp.locationId,
    seed: comp.seed,
    biome: comp.biome,
    lighting: comp.lighting,
    grammar: comp.grammar,
    grid: { cols, rows, feetPerTile: FEET_PER_TILE },
    tiles,
    walkable,
    objects,
    ambiance,
    entrances,
  };
}
