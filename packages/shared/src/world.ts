/**
 * Scene/World contracts (docs/SCENE-CONTRACTS.md).
 *
 * The typed artifacts that flow across the actor boundaries of the visual layer:
 *
 *   DM ──EstablishScene──► Director ──SceneComposition──► Cartographer ──SceneMap──► [FREEZE]
 *                                                                           │
 *                                              manipulation: ──SceneDelta──►┘ (mutates objects in place)
 *
 * Principle (mirrors the rules engine, spec §4.1): the LLMs PROPOSE in semantic terms
 * (ids, anchors, zones) and never own coordinates or memory; a deterministic layer owns
 * identity, geometry and persistence. Everything is addressed by STABLE ID, generated
 * once per location and FROZEN — so a fully-procedural world stays consistent.
 *
 * These are pure type/const contracts (no behavior). Validators live in ./world-validate.
 */

import type { Facing, Lighting } from './scene.js';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Stable location id, e.g. "loc:mistmoor-green". A node in the world graph. */
export type LocationId = string;

/** Stable entity id, e.g. "npc:edda", "bldg:bell-tower", "prop:well", "pc:aldric", "mob:orc-1". */
export type EntityId = string;

/** Prefix → kind. Ids are `<prefix>:<kebab-slug>`; the prefix is the canonical kind hint. */
export const ENTITY_ID_PREFIXES = ['loc', 'bldg', 'prop', 'npc', 'pc', 'mob'] as const;
export type EntityIdPrefix = (typeof ENTITY_ID_PREFIXES)[number];

/** `<prefix>:<slug>` where slug is lowercase kebab/alphanumeric, with an optional `#NN` suffix for
 *  object-field children (e.g. "prop:pews#03" — one of an expanded group sharing idBase "prop:pews"). */
export const ENTITY_ID_PATTERN = /^(loc|bldg|prop|npc|pc|mob):[a-z0-9]+(?:-[a-z0-9]+)*(?:#\d+)?$/;

/** What an object IS on the map. fixture = building/large structure; prop = small object; actor = mover. */
export type EntityKind = 'fixture' | 'prop' | 'actor';
/** For actors only. */
export type ActorRole = 'pc' | 'npc' | 'mob';

// ---------------------------------------------------------------------------
// Layout grammars + semantic anchors (the LLM's coordinate-free vocabulary)
// ---------------------------------------------------------------------------

/** Reusable structural layout grammars (NOT authored maps). */
export const LAYOUT_GRAMMARS = ['open-outdoor', 'enclosed-interior', 'town-square'] as const;
export type LayoutGrammar = (typeof LAYOUT_GRAMMARS)[number];

/** Zones each grammar exposes; `in:<zone>` anchors resolve into these. */
export const GRAMMAR_ZONES: Record<LayoutGrammar, readonly string[]> = {
  'open-outdoor': ['commons', 'perimeter', 'waterside', 'building-row', 'path'],
  'enclosed-interior': ['floor', 'back', 'entrance', 'wall'],
  // A village/town centred on a plaza: a fountain at `center`, stalls along `market-row`,
  // houses lining `building-row`, a `street` through it, the sea on `waterside`.
  'town-square': ['plaza', 'center', 'market-row', 'building-row', 'street', 'waterside', 'perimeter', 'commons'],
};

/** Grammar-agnostic anchors usable in any scene. */
export const BASE_ANCHORS = [
  'center',
  'north',
  'south',
  'east',
  'west',
  'north-edge',
  'south-edge',
  'east-edge',
  'west-edge',
  'waterside',
  'entrance',
] as const;
export type BaseAnchor = (typeof BASE_ANCHORS)[number];

/**
 * A coordinate-free placement hint the LLMs emit. One of:
 *   - a BaseAnchor ("center", "waterside", …)
 *   - `near:<entityId>`  (relational — "by the well")
 *   - `in:<zone>`        (a grammar zone)
 * Typed loosely (string) because it crosses the LLM boundary; validated by isValidAnchor().
 */
export type SemanticAnchor = string;

// ---------------------------------------------------------------------------
// Contract 1 — EstablishScene  (DM → Director). The FICTION. No coordinates.
// ---------------------------------------------------------------------------

export interface FixtureDecl {
  id: EntityId; // "bldg:bell-tower" | "prop:well"
  kind: 'fixture' | 'prop';
  tag: string; // catalog tag the renderer can resolve
  /** Optional placement hint; if omitted, the Director decides from the grammar (e.g. a fountain centres). */
  anchor?: SemanticAnchor;
  facing?: Facing;
  /** GM-facing flavor; never rendered. */
  note?: string;
}

export interface NpcDecl {
  id: EntityId; // "npc:edda"
  name: string;
  /** Free-text role/appearance; the Director maps it to a character sprite tag. */
  look: string;
  /** Optional placement hint; if omitted, the Director decides from the grammar. */
  anchor?: SemanticAnchor;
  /** false = present but not drawn (a lurker); revealed later by a SceneDelta. */
  visible: boolean;
  disposition?: 'friendly' | 'neutral' | 'hostile' | 'unknown';
}

/** Structural layout family — the DM's explicit routing declaration (beats keyword inference). */
export type SceneKindHint = 'settlement' | 'interior' | 'wild';

/** The DM's tool call to stand up a brand-new location (the fiction, semantic only). */
export interface EstablishScene {
  locationId: LocationId;
  brief: { setting: string; biome: string; timeOfDay: Lighting; mood?: string };
  /** DM-declared structural kind. When present it FORCES the layout grammar (settlement =
   *  buildings+streets, interior = enclosed, wild = open nature); absent → the generator infers. */
  kind?: SceneKindHint;
  /** true when the DM explicitly declared timeOfDay — the parser's coerced 'day' default does NOT
   *  count. Declared time beats mood-inferred lighting (declared > mood > day). */
  timeOfDayExplicit?: boolean;
  fixtures: FixtureDecl[];
  npcs: NpcDecl[];
  size?: 'small' | 'medium' | 'large';
}

/** A per-beat scene design authored at ARC-GENERATION time, when the full campaign premise is in
 *  context — the Director-quality brief the DM inherits instead of improvising one mid-turn. */
export interface ScenePlan {
  /** 1-3 sentences: what the place LOOKS like top-down — terrain, structures, water/edges. */
  look: string;
  kind: SceneKindHint;
  /** Lighting/weather intent in plain words ("predawn fog", "grim, drowned dusk"). */
  mood: string;
  /** Must-exist landmark concepts (the generator's completeness nets pick them up). */
  features?: string[];
}

/** Campaign fiction the live orchestrator hands the modern realizer alongside the DM's declaration —
 *  the context a setScene tool call cannot carry (the premise/beat live in GameState, not the tool). */
export interface SceneRealizeContext {
  /** Campaign premise (arc blueprint premise, falling back to the adventure pitch). */
  premise?: string;
  /** The current arc beat this scene realizes. */
  beat?: { id: string; title?: string; summary?: string };
  /** The beat's authored scene design, when the arc composer produced one. */
  scenePlan?: ScenePlan;
}

/** Where a rendered scene came from — attached to the turn (response-only, never persisted) so the
 *  lab can show exactly what the DM asked, what the generator was given, and what it decided. */
export interface SceneProvenance {
  locationId: LocationId;
  /** modern = programmer path · classic = zone composer · fake = deterministic test composer ·
   *  frozen = an already-generated location was reused verbatim. */
  engine: 'modern' | 'classic' | 'fake' | 'frozen';
  reused: boolean;
  toolInput?: Record<string, unknown>;
  establish?: EstablishScene;
  beat?: { id: string; title?: string };
  scenePlan?: ScenePlan;
  /** The exact brief handed to the scene programmer. */
  enrichedBrief?: string;
  /** The text lighting was inferred from + why the final lighting won. */
  moodText?: string;
  lightingReason?: 'declared' | 'mood' | 'default';
  /** The composed program (structural shape only — the scene package owns the real SceneProgram type;
   *  `notes` records what the safety nets injected/rerouted, so the lab can show every intervention). */
  program?: { cols: number; rows: number; biome: string; lighting: string; grammar: string; theme?: string; ops: unknown[]; notes?: string[] };
}

/** What the modern realizer returns: the frozen map + the record of how it came to be. */
export interface RealizeSceneResult {
  sceneMap: SceneMap;
  provenance: SceneProvenance;
}

/** The Director's input = the DM's fiction + engine-authoritative party + the deterministic seed. */
export interface PartyMemberRef {
  id: EntityId; // "pc:aldric"
  spriteTag: string;
  name: string;
}
export interface CompositionRequest {
  establish: EstablishScene;
  party: PartyMemberRef[];
  /** Deterministic, derived from locationId (same place → same ambiance). */
  seed: number;
  /**
   * The player's raw layout request, verbatim. The EstablishScene loses spatial language
   * ("path left-to-right", "trees top and bottom", "party on the left"); this carries it
   * straight to the Director so it can honor composition the DM couldn't encode. Optional.
   */
  directive?: string;
  /** Lab/perf flag: floor the grid to a LARGE size (a big single settlement) so the renderer +
   *  pan/zoom camera can be exercised at scale. The Director still paints small; the extra margin
   *  fills with base terrain + spread buildings/greenery. (Stepping-stone toward district cities.) */
  large?: boolean;
}

// ---------------------------------------------------------------------------
// Contract 2 — SceneComposition  (Director → Cartographer). Semantic layout.
// ---------------------------------------------------------------------------

export interface TerrainRegion {
  tag: string; // terrain tag (catalog)
  zone: string; // grammar zone the region fills
}
/**
 * The Director's concretized per-entity plan: WHAT (resolved sprite tag, kind, visibility —
 * it maps an NPC's free-text `look` to a catalog tag here) + WHERE (zone/anchor). The
 * Cartographer turns each Placement into a positioned MapObject. One per declared entity + party.
 */
export interface Placement {
  id: EntityId;
  kind: EntityKind;
  role?: ActorRole; // for actors
  tag: string; // catalog art tag the Director chose (fixtures echo their decl tag; NPCs map look→tag)
  name?: string;
  visible: boolean;
  zone: string; // a grammar zone
  anchor?: SemanticAnchor; // optional finer hint within the zone
  facing?: Facing;
}
/**
 * A coarse top-down "blockout" the Director PAINTS to control composition directly — one region
 * char per tile, plus a coarse cell per entity. The Cartographer upscales it deterministically
 * (dense tree fill for forest, path of whatever orientation was painted, entities snapped to
 * walkable). This is how spatial intent ("path left→right", "thick treeline top+bottom", "party on
 * the left") survives — semantic zones can't express orientation. Used for open-outdoor scenes;
 * structural grammars (town-square / enclosed-interior) keep their deterministic layout.
 * Legend: G=grass  P=path/dirt  W=water  D=deep/dark water  A=sand  T=trees(dense)  S=stone  #=wall.
 */
export const BLOCKOUT_CHARS = 'GPWDATS#' as const;
export interface SceneBlockout {
  cols: number;
  rows: number;
  /** `rows` strings, each `cols` chars from BLOCKOUT_CHARS; grid[row][col]. */
  grid: string[];
  /** Coarse entity positions on the grid. Entities omitted here are auto-placed on open ground. */
  cells: { id: EntityId; col: number; row: number }[];
}
/**
 * An OBJECT FIELD — the Director's way to place MANY copies of one prop/actor by a RULE instead of
 * one-by-one ("rows of pews", "statues along the left wall", "a ring of standing stones", "guards
 * flanking the throne"). The Cartographer expands ONE field into N concrete, id-addressed children
 * (idBase + "#NN"), so a generic verb set × the open catalog covers an open-ended family of scenes
 * with no per-keyword code, while each child stays individually manipulable (SceneDelta target).
 */
export type FieldArrangement = 'row' | 'grid' | 'ring' | 'line' | 'scatter' | 'flank';
export interface ObjectField {
  idBase: EntityId; // children are `${idBase}#00`, `${idBase}#01`, … (deterministic)
  kind: EntityKind; // 'prop' | 'actor'
  role?: ActorRole;
  tag: string; // catalog art tag (resolved)
  name?: string;
  visible?: boolean;
  facing?: Facing;
  /** Where to fill: a named band, an explicit grid rect, OR `near` a placed entity (the field is laid
   *  out in a box centred on that landmark — "candles ringing the altar", "guards flanking the throne").
   *  Cartographer clamps + resolves it; an unresolvable `near` falls back to the grid centre. */
  region: { band?: string; rect?: { x: number; y: number; w: number; h: number }; near?: EntityId };
  arrangement: FieldArrangement;
  count?: number; // target number of children (clamped); omitted → derived from region + spacing
  spacing?: number; // cells between children (clamped); leaves walkable lanes
  /** Carve a clear central lane through a row/grid (a pew-hall aisle). */
  aisle?: 'vertical' | 'horizontal';
}
/**
 * A BUILDING — a structure the Cartographer renders as a ROOFLESS WALLED ROOM (a wall ring around a
 * floor, with ONE walkable door and a furniture set) instead of a flat facade sprite. This is what
 * makes a settlement read like a real top-down town (rooms you can see into) rather than a plaza
 * dotted with house-shaped towers. The Director/composer assigns each a non-overlapping `rect` + a
 * `door` side; the Cartographer carves the ring, punches the door (guaranteeing it connects inside↔
 * out), furnishes the interior from a per-type template, and seats an occupant. One per declared
 * building fixture (tavern/smithy/shop/temple/cottage…).
 */
export const BUILDING_TYPES = ['house', 'shop', 'tavern', 'temple', 'smithy', 'inn', 'general_store', 'cathedral', 'jail', 'vault', 'keep', 'library', 'armory', 'barracks', 'guildhall', 'goblin_warren', 'manor', 'tomb', 'courthouse', 'workshop', 'curio'] as const;
export type BuildingType = (typeof BUILDING_TYPES)[number];
export interface Building {
  id: EntityId;
  type: BuildingType;
  /** Wall-inclusive footprint on the grid: the outer ring is wall, the inside is floor. */
  rect: { x: number; y: number; w: number; h: number };
  /** Which wall holds the (single) door — faces the open ground/plaza side. */
  door: 'north' | 'south' | 'east' | 'west';
  name?: string;
}
/** Building footprint bounds (wall-inclusive). Min 4×4 = a 2×2 interior; capped so a sloppy
 *  layout can't swallow the map. */
export const BUILDING_LIMITS = { minW: 4, minH: 4, maxW: 12, maxH: 9, maxBuildings: 8 } as const;

export interface SceneComposition {
  locationId: LocationId;
  seed: number;
  grammar: LayoutGrammar;
  biome: string; // carried through from the brief; the SceneMap needs it
  lighting: Lighting;
  grid: { cols: number; rows: number };
  terrain: { base: string; regions: TerrainRegion[] };
  placements: Placement[];
  ambiance: { density: number; tags: string[] }; // 0..1 density of seed-scattered decor
  /** Present for open-outdoor scenes the Director painted; the Cartographer prefers it over zones. */
  blockout?: SceneBlockout;
  /** Repeated-object groups the Cartographer expands into many id-addressed children. */
  fields?: ObjectField[];
  /** Walled-room structures the Cartographer carves + furnishes (settlements). */
  buildings?: Building[];
}

/** Grid bounds the Director must stay within (also enforced by validation). */
// Cap raised for the city-scope work (V1): allows LARGE single settlements (and headroom toward the
// district city later). The Director still PAINTS small (~24×28 per its prompt) and parseBlockout
// clamps to the painted grid, so normal scenes are unaffected — only an explicit `large` request
// floors the grid bigger (buildComposition). The eventual full city will add a separate CITY limit.
export const GRID_LIMITS = { minCols: 12, maxCols: 96, minRows: 8, maxRows: 64 } as const;
/** Bounds on object fields (expansion caps — keeps a sloppy model from flooding the map). */
export const FIELD_LIMITS = { maxFields: 12, maxCount: 40, minSpacing: 1, maxSpacing: 6 } as const;

// ---------------------------------------------------------------------------
// Contract 3 — SceneMap  (Cartographer → FREEZE). The canonical object_map.
// ---------------------------------------------------------------------------

/** One addressable thing on the map. The `objects` array is the object_map / registry. */
export interface MapObject {
  id: EntityId;
  kind: EntityKind;
  /** Present iff kind === 'actor'. */
  role?: ActorRole;
  tag: string; // catalog art tag
  name?: string;
  col: number;
  row: number;
  footprint: { w: number; h: number }; // tiles; props/actors usually 1x1
  facing: Facing;
  /** false = present in the map but NOT drawn (lurkers, secrets). */
  visible: boolean;
  /** Arbitrary flags the DM can flip via setState (e.g. { door: 'open', burning: true }). */
  state?: Record<string, string | number | boolean>;
  /** The original anchor, kept so relations survive and re-resolution stays consistent. */
  anchorRef?: SemanticAnchor;
  /** The grammar zone the entity was placed in — the coarse, coordinate-free locus the
   *  digest narrates from when no finer anchorRef exists. Carried from SceneComposition. */
  zone?: string;
  /** If this object is one child of an expanded ObjectField, the field's idBase (so the digest can
   *  collapse "prop:pews#00..#07" → "a row of 8 pews" and SceneDelta can address the group). */
  group?: EntityId;
}

/** Seed-scattered decoration — rich but NOT narratively addressable (no stable id). */
export interface AmbianceItem {
  tag: string;
  col: number;
  row: number;
}

/** A door/exit tile linking to another location in the world graph. */
export interface Entrance {
  toLocationId: LocationId;
  col: number;
  row: number;
  /** The fixture this entrance belongs to, if any (e.g. "bldg:hut-2"). */
  fixtureId?: EntityId;
}

/** A roof-cover tile — the "closed building" layer. Drawn ON TOP of the walls + interior so a player sees
 *  only rooftops from outside; hidden per-building when the party enters (reveal), or globally via the lab
 *  Roofs switch. Computed from building footprints in the tiler, so both renderers stay pixel-identical. */
/** A roof is emitted as VECTOR geometry (not tiles): gradient-filled polygon FACES, crisp hip/ridge/rim
 *  LINES, and chimney/dormer SPRITES. Both renderers rasterise the same ops and apply the day/night tint,
 *  so a clean 45° hip and a solid rim are actually drawn, not approximated by shaded squares. Coordinates
 *  are in SCENE PIXELS (col*16 …). Colours are packed 0xRRGGBB (the builder does all the shading math). */
export interface RoofFace { pts: number[]; top: number; bot: number } // flat [x0,y0,x1,y1,…]; vertical gradient top→bot
export interface RoofLine { x1: number; y1: number; x2: number; y2: number; c: number; w: number } // hips, ridge, rim
export interface RoofSprite { x: number; y: number; tag: string } // 'roof_chimney' | 'roof_dormer', drawn centred
export interface RoofBuilding {
  id: string; // buildingId — so play can reveal one building at a time
  faces: RoofFace[];
  lines: RoofLine[];
  sprites: RoofSprite[];
}

/** The frozen, canonical scene — the single source of truth for renderer AND DM digest. */
export interface SceneMap {
  locationId: LocationId;
  seed: number;
  biome: string;
  lighting: Lighting;
  grammar: LayoutGrammar;
  grid: { cols: number; rows: number; feetPerTile: number };
  tiles: string[][]; // terrain tag per cell; tiles[row][col]
  walkable: boolean[][]; // walkable[row][col]
  objects: MapObject[]; // the object_map (id-addressed registry)
  ambiance: AmbianceItem[];
  entrances: Entrance[];
  /** Rooftop cover as vector geometry, one entry per building (optional; absent = no roofs). */
  roofs?: RoofBuilding[];
}

// ---------------------------------------------------------------------------
// World graph (persistent, engine-owned) — lazily generated, frozen on first visit.
// ---------------------------------------------------------------------------

export interface WorldLink {
  from: LocationId;
  to: LocationId;
  via?: EntityId; // the entrance/fixture traversed
}
export interface WorldState {
  currentLocationId: LocationId | null;
  /** Frozen maps keyed by id; re-entering a location reuses its map verbatim. */
  locations: Record<LocationId, SceneMap>;
  links: WorldLink[];
}

// ---------------------------------------------------------------------------
// Contract 4 — SceneDelta  (manipulation). Shaped now; wired in a later phase.
// ---------------------------------------------------------------------------

/** A target for a move: a semantic anchor (preferred) or an explicit resolved tile. */
export type MoveTarget = { anchor: SemanticAnchor } | { col: number; row: number };

export type SceneDelta =
  | { op: 'move'; id: EntityId; to: MoveTarget }
  | { op: 'face'; id: EntityId; facing: Facing }
  | { op: 'reveal'; id: EntityId }
  | { op: 'hide'; id: EntityId }
  | { op: 'setState'; id: EntityId; state: Record<string, string | number | boolean> }
  | { op: 'despawn'; id: EntityId }
  | {
      op: 'spawn';
      id: EntityId;
      kind: EntityKind;
      role?: ActorRole;
      tag: string;
      name?: string;
      anchor: SemanticAnchor;
      visible?: boolean;
      /** The concrete tile the applier resolved the anchor to — filled on APPLIED deltas so the
       *  renderer places the sprite without re-resolving. Absent on proposals. */
      at?: { col: number; row: number };
    }
  | { op: 'enter'; id: EntityId; toLocationId: LocationId; via?: EntityId };

// ---------------------------------------------------------------------------
// Digest — SceneMap → DM (closes the loop so narration reads from truth).
// ---------------------------------------------------------------------------

/** A compact, LLM-friendly view of a frozen SceneMap the DM narrates from. */
export interface SceneDigest {
  locationId: LocationId;
  biome: string;
  lighting: Lighting;
  // `at` is a coordinate-free locus (anchorRef ?? zone), never raw coordinates.
  fixtures: { id: EntityId; tag: string; at: string }[];
  npcs: { id: EntityId; name: string; at: string; visible: boolean }[];
  party: { id: EntityId; name?: string; at: string }[];
  exits: { toLocationId: LocationId; via?: EntityId }[];
}

// ---------------------------------------------------------------------------
// Helpers (pure, dependency-free) — shared by validators + future resolver.
// ---------------------------------------------------------------------------

export function isEntityId(id: string): boolean {
  return ENTITY_ID_PATTERN.test(id);
}

/** Validate a semantic anchor's FORM (and, when context is given, its referents). */
export function isValidAnchor(anchor: string, ctx?: { grammar?: LayoutGrammar; knownIds?: ReadonlySet<string> }): boolean {
  if ((BASE_ANCHORS as readonly string[]).includes(anchor)) return true;
  const near = /^near:(.+)$/.exec(anchor);
  if (near) return isEntityId(near[1]!) && (!ctx?.knownIds || ctx.knownIds.has(near[1]!));
  const inz = /^in:(.+)$/.exec(anchor);
  if (inz) return !ctx?.grammar || GRAMMAR_ZONES[ctx.grammar].includes(inz[1]!);
  return false;
}

/** Eval dimensions for the LLM-judged surfaces (used by the eval harness; spec §10). */
export const SCENE_EVAL_DIMENSIONS = {
  establish: ['narrative-fidelity', 'completeness', 'visibility-correctness'],
  composition: ['spatial-sense', 'legibility', 'brief-coherence'],
} as const;
