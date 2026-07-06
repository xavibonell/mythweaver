/**
 * Visual-vertical contracts (docs/VISUAL-VERTICAL.md). Pure types — no deps — so the
 * Scene Director, the tiler (packages/scene) and the renderer all share the same shapes.
 *
 *   SceneIntent  (Director -> Tiler)  : high-level; terrain regions + props + actors, no raw tiles
 *   SceneState   (Tiler -> renderer)  : concrete per-cell terrain + collision + placed props/actors
 *   SceneOp      (live updates)       : move / face (cute emotes/bubbles were scrapped — VV-1.5)
 *
 * The grid is the tactical grid too: 1 tile = FEET_PER_TILE feet (spec §4 combat).
 */

export const FEET_PER_TILE = 5;

/** Tile ids in SceneState.tiles (collision/walkability layer). 0/1 are universal wall/floor. */
export const TILE_WALL = 0;
export const TILE_FLOOR = 1;

export type Facing = 'up' | 'down' | 'left' | 'right';
export type ActorAnim = 'idle' | 'walk' | 'attack' | 'down';
export type ActorKind = 'pc' | 'npc';

/** Time of day / atmosphere — the renderer applies a darkening TINT for dusk/night, and a pale
 *  desaturating HAZE for fog (a washed-out, low-contrast overlay, not a multiply). */
export type Lighting = 'day' | 'dusk' | 'night' | 'fog';

/** A placed actor in the rendered scene. */
export interface ActorState {
  id: string;
  /** Sprite tag resolved to art by the renderer manifest (catalog CHARACTERS). */
  spriteTag: string;
  /** Display name shown under the sprite. */
  name?: string;
  /** 'pc' = party, 'npc' = everyone else (villagers, foes). */
  kind?: ActorKind;
  col: number;
  row: number;
  facing: Facing;
  anim: ActorAnim;
}

/** A placed decoration/structure (tree, bonfire, …). Tag resolves to art via the manifest. */
export interface SceneProp {
  tag: string;
  col: number;
  row: number;
}

export interface SceneGrid {
  cols: number;
  rows: number;
  feetPerTile: number;
}

/** The renderer's input — output of the deterministic tiler. */
export interface SceneState {
  sceneId: string;
  biome: string;
  seed: number;
  grid: SceneGrid;
  /** tiles[row][col] -> tile id (collision basis). */
  tiles: number[][];
  /** walkable[row][col]. */
  walkable: boolean[][];
  /** terrain[row][col] -> terrain tag (grass/water/dirt/…). Drives the floor art. */
  terrain: string[][];
  props: SceneProp[];
  actors: ActorState[];
  lighting: Lighting;
  /** Actor id to center the camera on. */
  cameraFocus?: string;
}

export interface RoomRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A rectangular region painted with one terrain (e.g. a fen of water, a dirt clearing). */
export interface TerrainPatch {
  terrain: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ActorPlacement = { col: number; row: number } | { room: number };

export interface IntentActor {
  id: string;
  spriteTag: string;
  name?: string;
  kind?: ActorKind;
  placement: ActorPlacement;
  facing?: Facing;
}

/**
 * The Director's output — expanded into a SceneState by the deterministic tiler.
 * Outdoor scenes use `terrain` (base + patches); dungeon scenes use `rooms`/`corridors`.
 */
export interface SceneIntent {
  sceneId: string;
  biome: string;
  seed: number;
  grid: { cols: number; rows: number };
  /** Outdoor terrain painting: a base terrain plus rectangular patches over it. */
  terrain?: { base: string; patches?: TerrainPatch[] };
  /** Dungeon carving (used when `terrain` is absent). */
  rooms?: RoomRect[];
  /** Pairs of room indices to connect with an L-corridor. */
  corridors?: [number, number][];
  props?: SceneProp[];
  actors: IntentActor[];
  lighting?: Lighting;
}

/**
 * Canonical biomes the Scene Director may emit. The tiler is biome-agnostic (it lays the
 * terrain layer); the renderer's manifest maps terrains/props/sprites to art.
 */
export const BIOMES = ['dungeon', 'forest', 'cave', 'village'] as const;
export type Biome = (typeof BIOMES)[number];

/**
 * Map a D&D class to a sprite tag in the asset library. The renderer's manifest
 * resolves the tag to actual sheets — so this is the "index" the orchestrator emits
 * and art-management happens in one place (the manifest). Add classes/tags freely.
 */
export function classToSpriteTag(className: string): string {
  const c = className.toLowerCase();
  if (/cleric|wizard|mage|sorcer|warlock|druid|priest/.test(c)) return 'wizard';
  if (/rogue|ranger|bard|thief|assassin|monk/.test(c)) return 'rogue';
  return 'knight'; // fighter / paladin / barbarian / default
}

/** Incremental scene mutations (the DM's updateScene tool). Move + face only in VV-1.5. */
export type SceneOp =
  | { type: 'move'; actorId: string; col: number; row: number }
  | { type: 'face'; actorId: string; facing: Facing };
