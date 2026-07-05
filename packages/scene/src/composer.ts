/**
 * The Scene Composer (docs/SCENE-CONTRACTS.md, surface B) — turns the DM's semantic
 * EstablishScene (+ party) into a Director `SceneComposition` (grammar, terrain zones,
 * per-entity placements). The deterministic Cartographer then resolves it to a SceneMap.
 *
 *   - FakeSceneComposer: deterministic, for tests + the no-API slice.
 *   - LlmSceneComposer : a real model composes; normalizeComposition GUARANTEES the output
 *     is valid (every entity placed once, authoritative ids/kinds, catalog-only tags).
 *
 * This is the new path that supersedes director.ts's SceneIntent flow; the live VV-1.5
 * pipeline keeps using director.ts until the orchestrator is migrated (slice 3).
 */

import type { LlmProvider } from '@mythweaver/llm';
import {
  BIOMES,
  BLOCKOUT_CHARS,
  BUILDING_LIMITS,
  BUILDING_TYPES,
  FIELD_LIMITS,
  GRAMMAR_ZONES,
  GRID_LIMITS,
  LAYOUT_GRAMMARS,
  isValidAnchor,
  type Building,
  type BuildingType,
  type CompositionRequest,
  type Facing,
  type FieldArrangement,
  type LayoutGrammar,
  type Lighting,
  type ObjectField,
  type Placement,
  type SceneBlockout,
  type SceneComposition,
} from '@mythweaver/shared';
import { isCharacter, isProp, isTerrain } from './catalog.js';

export interface SceneComposer {
  compose(req: CompositionRequest): Promise<SceneComposition>;
}

const LIGHTINGS = new Set<Lighting>(['day', 'dusk', 'night']);

/** Map a free-text NPC/creature look to a catalog character tag. Animals + monsters + people. */
const LOOK_SYNONYMS: [RegExp, string][] = [
  // animals
  [/chicken|hen|rooster|fowl|poultry/, 'chicken'],
  [/duck|goose|geese|gull|waterfowl/, 'duck'],
  [/cow|cattle|\box\b|bull|calf|cattle/, 'cow'],
  [/sheep|lamb|ewe|ram/, 'sheep'],
  [/goat|kid/, 'goat'],
  [/horse|pony|mare|stallion|steed|mule|donkey/, 'horse'],
  [/dog|hound|pup|mutt|mastiff|terrier/, 'dog'],
  [/cat|kitten|feline|tabby/, 'cat'],
  [/frog|toad/, 'frog'],
  [/deer|stag|doe|elk|fawn/, 'deer'],
  [/rabbit|hare|bunny/, 'rabbit'],
  [/crab|lobster|crayfish/, 'crab'],
  // monsters
  [/orc/, 'orc'],
  [/goblin|kobold|imp/, 'goblin'],
  [/skeleton|skeletal|bones/, 'skeleton'],
  [/zombie|undead|ghoul|corpse|drowned|risen|wight/, 'zombie'],
  [/slime|ooze|jelly|blob/, 'slime'],
  [/wolf|warg|jackal|hyena/, 'wolf'],
  [/spider|arachnid/, 'spider'],
  [/dragon|wyrm|drake|wyvern/, 'dragon'],
  // people / adventurers
  [/dwarf|dwarves|dwarven/, 'dwarf'],
  [/knight|guard|soldier|warrior|fighter|paladin|sentry|sentinel|militia|man-at-arms/, 'knight'],
  [/wizard|mage|witch|sorcer|priest|cleric|druid|shaman|enchant|conjur|warlock/, 'wizard'],
  [/ranger|hunter|scout|elf|archer|woodsman|forester/, 'ranger'],
  [/rogue|thief|spy|assassin|robber|bandit|smuggler|brigand|cutpurse|burglar/, 'rogue'],
  [/woman|girl|lady|matron|maiden|fisherwoman|maid|wife|widow|crone|grandmother/, 'villager_woman'],
];
export function lookToSprite(look: string): string {
  const r = look.toLowerCase();
  for (const [re, tag] of LOOK_SYNONYMS) if (re.test(r) && isCharacter(tag)) return tag;
  return 'villager';
}

/**
 * The kind of place, classified from the RAW brief (biome + setting text) — NOT the coerced
 * BIOMES enum, which lumped everything non-dungeon/forest/cave into "village" (that's why a wild
 * beach rendered as a town square). This drives BOTH the grammar and the Director's paint guidance.
 *   interior   — a roofed/walled space (dungeon, cave, crypt, room, hall)
 *   settlement — a built-up place with structures (village, town, market, plaza)
 *   wild       — open nature (forest, coast, beach, plains, meadow, desert, swamp, …) ← the default
 */
export type SceneKind = 'interior' | 'settlement' | 'wild';
const GRAMMAR_BY_KIND: Record<SceneKind, LayoutGrammar> = { interior: 'enclosed-interior', settlement: 'town-square', wild: 'open-outdoor' };
export function sceneKindOf(e: CompositionRequest['establish']): SceneKind {
  const biome = (e.brief.biome ?? '').toLowerCase();
  const setting = (e.brief.setting ?? '').toLowerCase();
  // Interior is the one kind the biome enum names reliably (cave/dungeon), so read biome + setting.
  if (/dungeon|crypt|catacomb|\bcave\b|cavern|\btomb\b|cellar|\bvault\b|\bmine\b|indoor|interior|chamber|throne ?room|\bsewer\b/.test(`${biome} ${setting}`)) return 'interior';
  // Settlement is decided from the SETTING TEXT ONLY — the biome enum has no 'coast'/'beach'/'plains',
  // so the DM stuffs every outdoor place into 'village', which would misclassify a wild beach as a town.
  // Require real built-environment words; otherwise it's wild (the safe default for open nature).
  if (/village|town|city|hamlet|\bmarket\b|plaza|\bsquare\b|\bhouses?\b|cottage|\bhuts?\b|tavern|\binn\b|smithy|buildings?|\bstalls?\b|courtyard|\bfort\b|citadel|\bkeep\b|castle/.test(setting)) return 'settlement';
  return 'wild';
}

/**
 * Sanitize the Director's painted blockout into a clean, in-bounds SceneBlockout (or undefined to
 * fall back to the zone path). Grid dims come from the painted grid itself; ragged rows are padded
 * with grass and over-long rows truncated; unknown chars become grass; cells are filtered to known
 * ids and clamped in-bounds. Robust to a sloppy model — never throws.
 */
function parseBlockout(raw: unknown, knownIds: Set<string>): SceneBlockout | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { grid?: unknown; cells?: unknown };
  if (!Array.isArray(r.grid)) return undefined;
  let lines = r.grid.filter((l): l is string => typeof l === 'string');
  if (lines.length === 0) return undefined;
  const rows = Math.min(GRID_LIMITS.maxRows, Math.max(GRID_LIMITS.minRows, lines.length));
  lines = lines.slice(0, rows);
  const cols = Math.min(GRID_LIMITS.maxCols, Math.max(GRID_LIMITS.minCols, Math.max(...lines.map((l) => l.length))));
  const valid = new Set((BLOCKOUT_CHARS as string).split(''));
  const grid: string[] = [];
  for (let y = 0; y < rows; y++) {
    const src = (lines[y] ?? '').toUpperCase();
    let line = '';
    for (let x = 0; x < cols; x++) {
      const ch = src[x];
      line += ch && valid.has(ch) ? ch : 'G';
    }
    grid.push(line);
  }
  if (!grid.some((l) => /[GPS]/.test(l))) return undefined; // need some walkable ground to stand on
  const cells: SceneBlockout['cells'] = [];
  const seen = new Set<string>();
  if (Array.isArray(r.cells))
    for (const c of r.cells) {
      if (!c || typeof c !== 'object') continue;
      const cc = c as { id?: unknown; col?: unknown; row?: unknown };
      if (typeof cc.id !== 'string' || !knownIds.has(cc.id) || seen.has(cc.id)) continue;
      cells.push({ id: cc.id, col: clampInt(cc.col, 0, cols - 1, 0), row: clampInt(cc.row, 0, rows - 1, 0) });
      seen.add(cc.id);
    }
  return { cols, rows, grid, cells };
}

const FIELD_ARRANGEMENTS = new Set<FieldArrangement>(['row', 'grid', 'ring', 'line', 'scatter', 'flank']);
const FIELD_BANDS = new Set(['left', 'right', 'top', 'bottom', 'north', 'south', 'east', 'west', 'center', 'all', 'shore']);

/**
 * Sanitize the Director's object-FIELD directives into clean ObjectFields (or drop the bad ones).
 * Resolves the tag to a real catalog tag, infers kind/role from the idBase prefix, clamps count/
 * spacing, and normalizes the region. Robust to a sloppy model — never throws.
 */
function parseFields(raw: unknown): ObjectField[] {
  if (!Array.isArray(raw)) return [];
  const out: ObjectField[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const f = r as Record<string, unknown>;
    let idBase = typeof f.idBase === 'string' ? f.idBase.trim().replace(/#.*$/, '') : ''; // strip any stray "#NN" — the engine appends the child suffix
    if (!idBase) continue;
    const pref = idBase.includes(':') ? idBase.slice(0, idBase.indexOf(':')).toLowerCase() : '';
    const kind: ObjectField['kind'] = pref === 'npc' || pref === 'mob' || pref === 'pc' ? 'actor' : pref === 'prop' ? 'prop' : f.kind === 'actor' ? 'actor' : 'prop';
    if (!idBase.includes(':')) idBase = `${kind === 'actor' ? 'npc' : 'prop'}:${idBase.replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'group'}`;
    if (seen.has(idBase)) continue;
    const rawTag = typeof f.tag === 'string' ? f.tag : '';
    // A BUILDING is never a field — it's carved as a walled room from a structure fixture. Drop any
    // field the model invented that resolves to a building/house facade (it would render as a row of
    // facade "towers" alongside the real rooms — the old-strategy remnant).
    if (kind !== 'actor' && (buildingTypeOf(rawTag) || /^house/.test(resolveFixtureTag(rawTag)))) continue;
    const tag = kind === 'actor' ? (isCharacter(rawTag) ? rawTag : lookToSprite(rawTag)) : resolveFixtureTag(rawTag);
    const arrangement = FIELD_ARRANGEMENTS.has(f.arrangement as FieldArrangement) ? (f.arrangement as FieldArrangement) : 'scatter';
    const reg = f.region && typeof f.region === 'object' ? (f.region as Record<string, unknown>) : {};
    const region: ObjectField['region'] = {};
    if (typeof reg.band === 'string' && FIELD_BANDS.has(reg.band.toLowerCase())) region.band = reg.band.toLowerCase();
    if (reg.rect && typeof reg.rect === 'object') {
      const rr = reg.rect as Record<string, unknown>;
      const n = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined);
      const x = n(rr.x), y = n(rr.y), w = n(rr.w), h = n(rr.h);
      if (x !== undefined && y !== undefined && w !== undefined && h !== undefined && w > 0 && h > 0) region.rect = { x, y, w, h };
    }
    // `near` may be given as region.near OR a top-level field.near; keep it only if it LOOKS like an id
    // (the Cartographer resolves it against placed entities and falls back to centre if unresolvable).
    const nearRaw = typeof reg.near === 'string' ? reg.near : typeof f.near === 'string' ? (f.near as string) : '';
    if (nearRaw && nearRaw.includes(':')) region.near = nearRaw.trim().replace(/#.*$/, '');
    if (!region.band && !region.rect && !region.near) region.band = 'all';
    const field: ObjectField = { idBase, kind, tag, region, arrangement };
    if (kind === 'actor') field.role = pref === 'mob' ? 'mob' : pref === 'pc' ? 'pc' : 'npc';
    if (typeof f.count === 'number' && Number.isFinite(f.count)) field.count = Math.min(FIELD_LIMITS.maxCount, Math.max(1, Math.round(f.count)));
    if (typeof f.spacing === 'number' && Number.isFinite(f.spacing)) field.spacing = Math.min(FIELD_LIMITS.maxSpacing, Math.max(FIELD_LIMITS.minSpacing, Math.round(f.spacing)));
    if (typeof f.facing === 'string' && ['up', 'down', 'left', 'right'].includes(f.facing)) field.facing = f.facing as Facing;
    if (f.aisle === 'vertical' || f.aisle === 'horizontal') field.aisle = f.aisle;
    if (typeof f.visible === 'boolean') field.visible = f.visible;
    if (typeof f.name === 'string') field.name = f.name;
    out.push(field);
    seen.add(idBase);
    if (out.length >= FIELD_LIMITS.maxFields) break;
  }
  return out;
}

/** Resolve a declared anchor to a grammar zone (the coarse placement bucket). */
function anchorToZone(anchor: string | undefined, grammar: LayoutGrammar): string {
  const zones = GRAMMAR_ZONES[grammar];
  if (anchor?.startsWith('in:')) {
    const z = anchor.slice(3);
    if (zones.includes(z)) return z;
  }
  if (grammar === 'enclosed-interior') {
    if (anchor === 'entrance') return 'entrance';
    if (anchor === 'north' || anchor === 'north-edge') return 'back';
    return 'floor';
  }
  if (grammar === 'town-square') {
    if (anchor === 'center') return 'center';
    if (anchor === 'waterside') return 'waterside';
    if (anchor === 'north' || anchor === 'north-edge') return 'building-row';
    return 'plaza';
  }
  if (anchor === 'waterside') return 'waterside';
  if (anchor === 'north' || anchor === 'north-edge') return 'building-row';
  if (anchor === 'entrance' || anchor === 'south' || anchor === 'south-edge') return 'path';
  return 'commons';
}

/** Town-square smart default zone/anchor by tag — used when the DM didn't pin a spot. Gives the
 *  square its structure: the fountain centres, houses line the back, stalls form a row. */
function townSquareDefault(kind: string, tag: string): { zone: string; anchor?: string } {
  if (tag === 'fountain') return { zone: 'center', anchor: 'center' };
  if (tag.startsWith('house')) return { zone: 'building-row' };
  if (tag === 'market_stall') return { zone: 'market-row' };
  if (/^(tree|tree_pine|tree_autumn|bush)$/.test(tag)) return { zone: 'perimeter' };
  if (kind === 'actor') return { zone: 'plaza' };
  return { zone: 'plaza' };
}

/**
 * Resolve a DM-declared fixture tag to a real catalog tag. The DM emits catalog-adjacent names
 * (e.g. "broken_pillar", "wall_sconce_torch"); map them to the nearest art by keyword. The
 * fallback is the neutral PLACEHOLDER (an honest "no art yet" marker), never a misleading sprite.
 */
const FIXTURE_SYNONYMS: [RegExp, string][] = [
  // Buildings (composed cottages) + fountain — highest priority so "house"/"tavern" don't fall through.
  [/fountain|well|cistern|trough|water pump/, 'fountain'],
  [/tavern|inn|alehouse|lodge|guildhall|town ?hall|longhouse/, 'house_tall'],
  [/cottage|hut|cabin|shack|hovel|dwelling/, 'house_wood'],
  [/shop|store|smithy|bakery|market.?house|stall.?house/, 'house_grey'],
  [/manor|house|home|residence|building|\bhall\b|abode|cabin/, 'house_red'],
  [/stair|staircase|\bsteps\b|stairwell|stairway/, 'stairs'],
  [/altar|shrine|pulpit|reliquary|lectern/, 'altar'],
  [/sarcophag|coffin|casket/, 'sarcophagus'],
  [/grave|tomb|headstone|tombstone|cairn|barrow/, 'gravestone'],
  [/torch|sconce|brazier|candle|lantern|firepit|fire-?pit|hearth|campfire|bonfire|fire|lava/, 'brazier'],
  [/barrel|cask|keg|tun/, 'barrel'],
  [/chest|treasure|coffer|strongbox/, 'chest'],
  [/crate|box|crab-?pot|trap|supply|sack|basket|cargo/, 'crate'],
  [/stall|cart|market|vendor|stand|booth/, 'market_stall'],
  [/anvil|forge|smith|furnace|workbench|bench|pew|table|desk|counter|loom|stool/, 'table'],
  [/sign|post|notice|placard/, 'signpost'],
  [/fence|rail|paling|palisade|hedge/, 'fence'],
  [/mushroom|toadstool|fungus/, 'mushroom'],
  [/pine|fir|conifer|spruce/, 'tree_pine'],
  [/autumn|maple|orange tree/, 'tree_autumn'],
  [/bush|shrub|fern|reed|cattail|rush|sapling/, 'bush'],
  [/tree|oak|trunk|willow|birch/, 'tree'],
];
function resolveFixtureTag(tag: string): string {
  if (isProp(tag)) return tag;
  const r = tag.toLowerCase().replace(/_/g, ' ');
  for (const [re, out] of FIXTURE_SYNONYMS) if (re.test(r) && isProp(out)) return out;
  // Genuinely unknown (statue, pillar, …): a neutral PLACEHOLDER, never a misleading sprite
  // (the old crate fallback made stairs/statues read as a box). Crate stays reachable via its regex.
  return isProp('placeholder') ? 'placeholder' : 'crate';
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : dflt;
  return Math.min(max, Math.max(min, n));
}

/**
 * Classify a DM-declared structure tag into a BuildingType (or null = not a building). A building
 * fixture becomes a WALLED ROOM the Cartographer carves + furnishes, not a facade sprite. Order
 * matters — the specific types (tavern/smithy/temple/shop) win over the generic 'house'.
 */
const BUILDING_TAG_TYPE: [RegExp, BuildingType][] = [
  // specific NEW types first (first match wins) so they don't get swallowed by the generic tavern/temple/shop lines.
  [/\b(inn|lodging|hostel)\b/, 'inn'],
  [/tavern|alehouse|pub|brewery|tap.?house|lodge/, 'tavern'],
  [/smith|forge|foundry|blacksmith|anvil/, 'smithy'],
  [/cathedral|minster|basilica|abbey|monastery/, 'cathedral'],
  [/temple|shrine|church|chapel|sanctuary/, 'temple'],
  [/jail|gaol|prison|cell.?block|gallows/, 'jail'],
  [/vault|treasury|strong.?room|hoard|reliquary/, 'vault'],
  [/keep|castle|fortress|citadel|great.?hall|throne/, 'keep'],
  [/library|archive|scriptorium|bookshop/, 'library'],
  [/armou?ry|arsenal|guard.?house|watch.?post/, 'armory'],
  [/barracks|garrison|dormitory|bunk/, 'barracks'],
  [/guild.?hall|guild.?house/, 'guildhall'],
  [/goblin|warren|kobold|monster.?(lair|den)|lair|den/, 'goblin_warren'],
  [/manor|estate|mansion|villa|chateau/, 'manor'],
  [/tomb|mausoleum|crypt|sepulchre|sepulcher|barrow|catacomb/, 'tomb'],
  [/court.?house|court.?room|moot.?hall|town.?hall|magistrate/, 'courthouse'],
  [/workshop|carpenter|joiner|cooper|wright|fletcher/, 'workshop'],
  [/curio|pawn.?shop|oddities|curiosity|fence/, 'curio'],
  [/general.?store|provisioner|trading.?post|apothecary|emporium|sundr/, 'general_store'],
  [/shop|store|market.?house|bakery|butcher|tailor|bank/, 'shop'],
  [/house|home|cottage|hut|cabin|hovel|shack|dwelling|residence|longhouse|farmhouse|barn|mill|tower/, 'house'],
];
function buildingTypeOf(tag: string): BuildingType | null {
  const r = tag.toLowerCase().replace(/_/g, ' ');
  for (const [re, type] of BUILDING_TAG_TYPE) if (re.test(r)) return type;
  return null;
}

/**
 * Lay out building footprints as non-overlapping plots packed into the upper area of the grid, left
 * to right, wrapping to a second row, with 1-tile street gaps and the bottom rows kept open for a
 * plaza. Deterministic (no RNG) — same fixtures → same town. Door faces SOUTH (toward the plaza).
 * The Cartographer carves each plot into a roofless walled room with a door + furniture.
 */
function layoutBuildings(specs: { id: string; type: BuildingType; name?: string }[], cols: number, rows: number): Building[] {
  if (!specs.length) return [];
  const { minW, maxW, minH, maxH, maxBuildings } = BUILDING_LIMITS;
  const list = specs.slice(0, maxBuildings);
  const margin = 1;
  const gap = 1;
  const plazaH = Math.max(2, Math.floor(rows * 0.22)); // reserve the bottom band as walkable plaza (small enough that 2 building rows still fit a short grid)
  const bandH = rows - margin - plazaH; // vertical space available for building rows
  // Fit ALL declared buildings: choose row count (≤ what fits at minH), then per-row count, then size
  // the plots DOWN so nothing is dropped. Prefer one row for a few buildings, two rows for many.
  const maxRowsThatFit = Math.max(1, Math.floor((bandH + gap) / (minH + gap)));
  // ≤3 buildings → one row; 4-6 → two rows. Cap at 3 per row so plots stay WIDE enough (≥~6 cells)
  // for a roomy interior + a 3×3 carpet, rather than many narrow slivers.
  const rowsUsed = Math.min(maxRowsThatFit, Math.max(1, Math.ceil(list.length / 3)));
  const perRow = Math.ceil(list.length / rowsUsed);
  const bw = Math.min(maxW, Math.max(minW, Math.floor((cols - 2 * margin - (perRow - 1) * gap) / perRow)));
  const bh = Math.min(maxH, Math.max(minH, Math.floor((bandH - (rowsUsed - 1) * gap) / rowsUsed)));
  const out: Building[] = [];
  for (let i = 0; i < list.length; i++) {
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    if (row >= rowsUsed) break; // beyond the rows we can fit (only when count > perRow*rowsUsed)
    const x = margin + col * (bw + gap);
    const y = margin + row * (bh + gap);
    if (x + bw > cols - margin || y + bh > rows - margin) continue; // safety: never out of bounds
    const s = list[i]!;
    out.push({ id: s.id, type: s.type, rect: { x, y, w: bw, h: bh }, door: 'south', ...(s.name ? { name: s.name } : {}) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// FakeSceneComposer — deterministic
// ---------------------------------------------------------------------------

export class FakeSceneComposer implements SceneComposer {
  async compose(req: CompositionRequest): Promise<SceneComposition> {
    return buildComposition(req, {});
  }
}

// ---------------------------------------------------------------------------
// LlmSceneComposer — a real model, normalized to a guaranteed-valid composition
// ---------------------------------------------------------------------------

export class LlmSceneComposer implements SceneComposer {
  constructor(private readonly llm: LlmProvider, private readonly model?: string) {}

  async compose(req: CompositionRequest): Promise<SceneComposition> {
    const prompt = composerPrompt(req);
    const res = await this.llm.complete({ ...(this.model ? { model: this.model } : {}), maxTokens: 1400, messages: [{ role: 'user', content: prompt }] });
    let raw: Record<string, unknown> = {};
    try {
      const m = res.text.match(/\{[\s\S]*\}/);
      if (m) raw = JSON.parse(m[0]) as Record<string, unknown>;
    } catch {
      raw = {}; // fall back to a fully deterministic composition
    }
    return buildComposition(req, raw);
  }
}

// ---------------------------------------------------------------------------
// buildComposition — the single normalizer that GUARANTEES a valid SceneComposition.
// `hints` is the (optional, untrusted) model output; the entity SET + identity come from
// the request, so the LLM can only influence grammar/grid/terrain/zone-assignment/ambiance.
// ---------------------------------------------------------------------------

interface CompositionHints {
  grammar?: unknown;
  biome?: unknown;
  lighting?: unknown;
  grid?: { cols?: unknown; rows?: unknown };
  terrain?: { base?: unknown; regions?: { tag?: unknown; zone?: unknown }[] };
  placements?: { id?: unknown; zone?: unknown; anchor?: unknown }[];
  ambiance?: { density?: unknown; tags?: unknown };
  blockout?: unknown;
  fields?: unknown;
}

function buildComposition(req: CompositionRequest, hints: CompositionHints): SceneComposition {
  const e = req.establish;
  const biome = (BIOMES as readonly string[]).includes(hints.biome as string)
    ? (hints.biome as string)
    : (BIOMES as readonly string[]).includes(e.brief.biome)
      ? e.brief.biome
      : 'village';
  const lighting: Lighting = LIGHTINGS.has(hints.lighting as Lighting) ? (hints.lighting as Lighting) : e.brief.timeOfDay;
  // Grammar is STRUCTURAL — derived from the scene KIND (interior/settlement/wild), never the LLM's
  // choice. The kind reads the raw brief so a wild beach stays outdoor instead of collapsing to a town.
  const grammar: LayoutGrammar = GRAMMAR_BY_KIND[sceneKindOf(e)];
  const zones = GRAMMAR_ZONES[grammar];

  const cols = clampInt(hints.grid?.cols, GRID_LIMITS.minCols, GRID_LIMITS.maxCols, grammar === 'enclosed-interior' ? 20 : 24);
  const rows = clampInt(hints.grid?.rows, GRID_LIMITS.minRows, GRID_LIMITS.maxRows, grammar === 'enclosed-interior' ? 14 : 16);

  const wet = /(sea|coast|fen|marsh|bog|swamp|water|lake|river|dock|pier|harbo|shore|bay)/.test(e.brief.setting.toLowerCase());
  // Terrain for the STRUCTURAL grammars (enclosed-interior, town-square) is deterministic so the
  // room/plaza is reliable; only open-outdoor lets the LLM influence terrain regions.
  let base: string;
  const regions: { tag: string; zone: string }[] = [];
  if (grammar === 'enclosed-interior') {
    base = 'stone';
    regions.push({ tag: 'wall', zone: 'wall' }, { tag: 'stone', zone: 'floor' });
  } else if (grammar === 'town-square') {
    base = 'grass';
    regions.push({ tag: 'stone', zone: 'plaza' }, { tag: 'dirt', zone: 'street' }); // always a cobble square
    if (wet || biome === 'coast' || biome === 'village') regions.push({ tag: 'water', zone: 'waterside' });
  } else {
    // open-outdoor: the LLM may influence terrain, but 'wall' is INTERIOR-only — never an outdoor
    // floor or band (it hallucinated a brick wall across a forest). Natural terrains only.
    const naturalBase = isTerrain(hints.terrain?.base as string) && hints.terrain!.base !== 'wall';
    base = naturalBase ? (hints.terrain!.base as string) : 'grass';
    for (const r of hints.terrain?.regions ?? []) {
      if (typeof r?.tag === 'string' && isTerrain(r.tag) && r.tag !== 'wall' && typeof r.zone === 'string' && zones.includes(r.zone)) regions.push({ tag: r.tag, zone: r.zone });
    }
    if (regions.length === 0) {
      if (wet) regions.push({ tag: 'water', zone: 'waterside' });
      regions.push({ tag: 'dirt', zone: 'path' });
    }
  }

  const knownIds = new Set<string>([...e.fixtures.map((f) => f.id), ...e.npcs.map((n) => n.id), ...req.party.map((p) => p.id)]);
  const hintById = new Map<string, { zone?: unknown; anchor?: unknown }>();
  for (const p of hints.placements ?? []) if (typeof p?.id === 'string') hintById.set(p.id, p);

  // The Director paints EVERY scene kind now; the Cartographer renders FROM the blockout when usable,
  // else falls back to the deterministic zone layout. Parsed up-front so the building layout + the
  // returned grid agree on dimensions.
  const blockout = parseBlockout(hints.blockout, knownIds);
  let gridCols = blockout ? blockout.cols : cols;
  let gridRows = blockout ? blockout.rows : rows;
  // A settlement needs room for tall walled rooms + a plaza + greenery; the Director often paints a
  // cramped grid. Enforce a roomy minimum — the Cartographer fills any cells beyond the painted
  // blockout with grass (so the extra margin just becomes leafy outskirts).
  if (grammar === 'town-square') {
    gridCols = Math.min(GRID_LIMITS.maxCols, Math.max(24, gridCols));
    gridRows = Math.min(GRID_LIMITS.maxRows, Math.max(16, gridRows));
  }
  // LARGE (Lab/perf): floor to a big grid so the renderer + pan/zoom camera exercise at scale. The
  // Director's small painted blockout fills the top-left; the Cartographer fills the rest with base
  // terrain + spreads buildings/greenery across it. (Stepping-stone toward the district city.)
  if (req.large) {
    gridCols = Math.min(GRID_LIMITS.maxCols, Math.max(gridCols, 60));
    gridRows = Math.min(GRID_LIMITS.maxRows, Math.max(gridRows, 40));
  }

  // BUILDINGS: in a settlement, a fixture whose tag names a STRUCTURE (smithy/tavern/cottage/…)
  // becomes a walled ROOM the Cartographer carves + furnishes — NOT a facade sprite (which top-down
  // reads as a tower). A PLURAL structure ("reed huts", "cottages") expands to a few rooms. The
  // composer lays them out as non-overlapping plots; the consumed fixture is skipped from point
  // placement, and any field the model folded that fixture into is dropped (the rooms win).
  const buildingFixtures = grammar === 'town-square' ? e.fixtures.filter((f) => buildingTypeOf(f.tag)) : [];
  const buildingSpecs = buildingFixtures.flatMap((f) => {
    const type = buildingTypeOf(f.tag)!;
    const plural = /s\s*$/i.test(f.tag.trim()); // "huts"/"cottages"/"houses" → several rooms
    const n = plural ? 3 : 1;
    return Array.from({ length: n }, (_, i) => ({ id: n > 1 ? `${f.id}#${i + 1}` : f.id, type, name: f.tag }));
  });
  const buildings = layoutBuildings(buildingSpecs, gridCols, gridRows);
  // Only fixtures that actually got a room are "consumed" (skipped from point placement). A fixture
  // whose rooms all failed to fit falls back to a normal placement rather than vanishing from the scene.
  const consumed = new Set(buildings.map((b) => b.id.split('#')[0]!));

  // Object fields the Director authored — expanded by the Cartographer into many children. A declared
  // entity whose id is used as a field idBase is REPRESENTED by that field, so it's not also placed
  // as a single object. Fields for a CONSUMED building fixture are dropped (the building replaces it).
  const fields = parseFields(hints.fields).filter((f) => !consumed.has(f.idBase));
  const fieldBases = new Set(fields.map((f) => f.idBase));

  const placements: Placement[] = [];
  const push = (id: string, kind: Placement['kind'], role: Placement['role'], tag: string, name: string | undefined, visible: boolean, declaredAnchor: string | undefined) => {
    if (fieldBases.has(id) || consumed.has(id)) return; // absorbed by a field or carved as a building
    const hint = hintById.get(id);
    const explicitZone = hint && typeof hint.zone === 'string' && zones.includes(hint.zone) ? hint.zone : undefined;
    const hintAnchor = hint && typeof hint.anchor === 'string' && isValidAnchor(hint.anchor, { grammar, knownIds }) ? hint.anchor : undefined;
    // Pass through ANY valid declared anchor (center, waterside, *-edge, near:, in:), not just
    // relative ones — the Cartographer now resolves all of them, so 'center' must survive.
    const validDeclared = declaredAnchor && isValidAnchor(declaredAnchor, { grammar, knownIds }) ? declaredAnchor : undefined;
    let anchor = hintAnchor ?? validDeclared;
    let zone = explicitZone ?? anchorToZone(declaredAnchor, grammar);
    // B4: give the town-square its structure by tag when nothing was pinned (fountain centres,
    // houses line the back, stalls form a row) — the DM's explicit anchor/zone always wins.
    if (grammar === 'town-square' && !anchor && !explicitZone) {
      const def = townSquareDefault(kind, tag);
      zone = def.zone;
      if (def.anchor) anchor = def.anchor;
    }
    // Actors NEVER claim 'center' (reserved for the landmark/fountain) — a crowd anchored centre
    // just piles on one cell. Spread them through the open area; spacing makes them ring it.
    if (kind === 'actor' && anchor === 'center') {
      anchor = undefined;
      zone = grammar === 'enclosed-interior' ? 'floor' : grammar === 'town-square' ? 'plaza' : 'commons';
    }
    placements.push({ id, kind, ...(role ? { role } : {}), tag, ...(name ? { name } : {}), visible, zone, ...(anchor ? { anchor } : {}) });
  };
  for (const f of e.fixtures) push(f.id, f.kind, undefined, resolveFixtureTag(f.tag), undefined, true, f.anchor);
  for (const n of e.npcs) push(n.id, 'actor', 'npc', lookToSprite(n.look), n.name, n.visible, n.anchor);
  for (const p of req.party) push(p.id, 'actor', 'pc', isCharacter(p.spriteTag) ? p.spriteTag : 'knight', p.name, true, undefined);

  // Ambiance is scattered outdoor DECOR (trees dotting the edges). NONE indoors — trees in a
  // crypt is nonsense — and sparse outdoors, or a village reads as a forest. The Cartographer
  // further caps the absolute count.
  const isInterior = grammar === 'enclosed-interior';
  const density = isInterior ? 0 : typeof hints.ambiance?.density === 'number' ? Math.min(0.12, Math.max(0, hints.ambiance.density)) : biome === 'forest' ? 0.1 : 0.05;
  const hintTags = Array.isArray(hints.ambiance?.tags) ? (hints.ambiance!.tags as unknown[]).filter((t): t is string => typeof t === 'string' && isProp(t)) : [];
  const tags = isInterior ? [] : hintTags.length ? hintTags : ['tree', 'bush'];

  const grid = { cols: gridCols, rows: gridRows };
  return { locationId: e.locationId, seed: req.seed, grammar, biome, lighting, grid, terrain: { base, regions }, placements, ambiance: { density, tags }, ...(blockout ? { blockout } : {}), ...(fields.length ? { fields } : {}), ...(buildings.length ? { buildings } : {}) };
}

function composerPrompt(req: CompositionRequest): string {
  // The Director PAINTS a blockout for every scene kind; the guidance + example below adapt to the
  // kind (interior room / settlement / wild), but the grid format and entity-cell contract are shared.
  return blockoutPrompt(req, sceneKindOf(req.establish));
}

/** Per-kind paint guidance + a worked example of the right shape and size. */
const KIND_GUIDE: Record<SceneKind, { guidance: string; example: string }> = {
  wild: {
    guidance: `This is a WILD outdoor scene — paint terrain bands and natural features:
- Path "left to right" / "horizontal" → a HORIZONTAL run of P across one row. "Top to bottom" / "vertical" → a vertical column of P. Curved/diagonal → paint it so.
- "Thick lines/walls of trees on top and bottom" → SEVERAL FULL rows of T at the very top AND bottom.
- Water on a side → a band of W down that edge. "DARK / DEEP water" zone → paint D there. A beach / sandy shore → paint A (sand). An island → land (G) surrounded by W. Keep the playable middle open (G/P/A).`,
    example: `Example — "forest, thick treelines top & bottom, horizontal dirt path across the middle, heroes left, enemies centre":
{"blockout":{"grid":[
"TTTTTTTTTTTTTTTTTTTT","TTTTTTTTTTTTTTTTTTTT","TTTTTTTTTTTTTTTTTTTT",
"GGGGGGGGGGGGGGGGGGGG","GGGGGGGGGGGGGGGGGGGG","GGGGGGGGGGGGGGGGGGGG",
"PPPPPPPPPPPPPPPPPPPP",
"GGGGGGGGGGGGGGGGGGGG","GGGGGGGGGGGGGGGGGGGG","GGGGGGGGGGGGGGGGGGGG",
"TTTTTTTTTTTTTTTTTTTT","TTTTTTTTTTTTTTTTTTTT","TTTTTTTTTTTTTTTTTTTT"],
"cells":[{"id":"pc:a","col":1,"row":6},{"id":"pc:b","col":2,"row":6},{"id":"npc:foe","col":10,"row":6}]}}`,
  },
  settlement: {
    guidance: `This is a SETTLEMENT — paint mostly GRASS; the engine BUILDS the structures + greenery.
- Base everything GRASS (G). Lay STONE (S) as a COBBLED PLAZA around the centre (where the well/fountain sits) and a stone STREET or two (a vertical and/or horizontal band) connecting it. Use P (dirt) for side lanes. W (water) ONLY if waterside.
- Keep GENEROUS GRASS between and around everything — the engine scatters TREES + WILDFLOWERS on the grass to make it leafy like a real village. A solid stone lot reads cold and empty; grass with stone streets reads alive.
- The BUILDINGS (tavern, smithy, cottages, …) auto-carve as walled rooms along the TOP — do NOT paint # walls or building cells. Leave the upper area as GRASS so rooms drop onto it with grassy margins.
- Put the landmark (fountain/well) CENTRALLY on the plaza. Give cells to NPCs + the party only, out in the OPEN (plaza/streets, lower-middle), NOT in the top building band.
- Use a ROOMY grid (24-28 cols, 14-16 rows).`,
    example: `Example — "a market village: a fountain, a tavern, a smithy, a general store, two cottages, an elder in the square" (26 wide × 15 tall — give the rooms room to breathe):
{"blockout":{"grid":[
"GGGGGGGGGGGGGGGGGGGGGGGGGG","GGGGGGGGGGGGGGGGGGGGGGGGGG","GGGGGGGGGGGGGGGGGGGGGGGGGG",
"GGGGGGGGGGGGGGGGGGGGGGGGGG","GGGGGGGGGGGGGGGGGGGGGGGGGG","GGGGGGGGGGGGSSGGGGGGGGGGGG",
"GGGGGGGGGGSSSSSSGGGGGGGGGG","GGGGGGGGGGSSSSSSGGGGGGGGGG","GGGGGGGGGGSSSSSSGGGGGGGGGG",
"GGGGGGGGGGGGSSGGGGGGGGGGGG","GGGGGGGGGGGGSSGGGGGGGGGGGG","GGGGGGGGGGGGGGGGGGGGGGGGGG",
"GGGGGGGGGGGGGGGGGGGGGGGGGG","GGGGGGGGGGGGGGGGGGGGGGGGGG","GGGGGGGGGGGGGGGGGGGGGGGGGG"],
"cells":[{"id":"prop:fountain","col":12,"row":7},{"id":"npc:elder","col":10,"row":8}]}}
(Note: mostly GRASS with a central stone plaza + a stone street to it; NO building cells — the tavern/smithy/store/cottages auto-build as rooms along the top. Only the fountain + NPCs get cells. Use ~15 rows so the rooms are roomy.)`,
  },
  interior: {
    guidance: `This is an INTERIOR (a roofed room) — paint a CLOSED room:
- Put # (wall) on EVERY outer edge; S (stone floor) inside. You MAY add interior # walls/pillars.
- Place furniture, foes, and any exit on FLOOR (S) cells. Put a back-wall feature (altar/throne/tomb) near the TOP.
- Do NOT use T (trees) or W indoors.`,
    example: `Example — "a torchlit crypt: sarcophagus at the back, broken pillars, two skeletons guarding":
{"blockout":{"grid":[
"####################","#SSSSSSSSSSSSSSSSSS#","#SSSSSSSSSSSSSSSSSS#",
"#SSSSSSSSSSSSSSSSSS#","#SSSSS#SSSSSS#SSSSS#","#SSSSSSSSSSSSSSSSSS#",
"#SSSSSSSSSSSSSSSSSS#","#SSSSS#SSSSSS#SSSSS#","#SSSSSSSSSSSSSSSSSS#",
"#SSSSSSSSSSSSSSSSSS#","#SSSSSSSSSSSSSSSSSS#","####################"],
"cells":[{"id":"prop:tomb","col":10,"row":1},{"id":"npc:skel1","col":7,"row":5},{"id":"npc:skel2","col":12,"row":5}]}}`,
  },
};

/** Unified: the Director PAINTS a coarse grid + a cell per entity, with kind-specific guidance. */
function blockoutPrompt(req: CompositionRequest, kind: SceneKind): string {
  const e = req.establish;
  const entities = [
    ...e.fixtures.map((f) => ({ id: f.id, what: f.tag })),
    ...e.npcs.map((n) => ({ id: n.id, what: n.look })),
    ...req.party.map((p) => ({ id: p.id, what: 'party member' })),
  ];
  const g = KIND_GUIDE[kind];
  return `You are the SCENE DIRECTOR for a top-down pixel-art RPG. Compose this scene by PAINTING A BLOCKOUT. Output ONLY JSON, no prose.

PAINT A BLOCKOUT — a top-down map, ONE CHARACTER PER TILE. Legend:
  G = grass   P = path/dirt   W = water   D = deep/DARK water   A = sand/beach   T = trees (DENSE forest)   S = stone/floor   # = wall

${g.guidance}

GENERAL RULES:
- "on the left" → low column numbers; "on the right" → high; "centre" → middle columns. col 0 = LEFT edge, row 0 = TOP edge.
- The grid MUST be 18-24 columns wide and 12-14 rows tall (like the example). NEVER fewer than 12 rows. EVERY row string MUST be exactly the same length.
- Give EVERY entity a cell on a WALKABLE tile (G, P or S — never on W, #, or T). The engine knows each entity's art; you choose POSITIONS only.

${g.example}
(The example shows the FORMAT and SIZE — copy the SHAPE, not the contents; paint what YOUR request describes.)

REPEATED OBJECTS → use a FIELD, never list each one. For "rows of benches/pews", "statues along the left wall", "a ring of standing stones", "ranks of guards", "torches lining the aisle", emit ONE field (the engine expands it into many, each individually placed):
  { "idBase":"prop:<name>" (or "npc:<name>" for creatures), "tag":"<catalog tag>", "region":{...}, "arrangement":"row|grid|ring|line|scatter|flank", "count":<n>, "spacing":2 }
- region is ONE of: {"band":"left|right|top|bottom|center|all|shore"}, {"rect":{"x":,"y":,"w":,"h":}}, or {"near":"<id of a cell you placed>"} to lay the group AROUND a landmark — use near+"flank" for "guards flanking the throne", near+"ring" for "candles ringing the altar". band:"shore" = the WATERLINE (rings an island) — use it for "crates scattered along the sandy shore".
- ACTORS IN WATER (e.g. "warriors on a boat in the sea"): place a "boat" fixture (a floating PLATFORM) on the water cells, then put those actors ON it — give them cells on the boat, or a field with region near:<boat id>. Don't leave them on land.
- Add "aisle":"vertical" (or "horizontal") to a row/grid to leave a clear central lane (e.g. pews either side of a central aisle).
- If a listed ENTITY above is plural (its description is "benches"/"pews"/"statues"/"a rank of …"), make a field whose **idBase IS that entity's id** and OMIT its cell — otherwise it gets placed twice.
- Use a CELL for a SINGLE notable thing; a FIELD for anything plural. Pick the catalog tag that best matches (e.g. pews→table). Leave spacing ≥2 so there are walkable lanes.

LAYOUT REQUEST:
"${req.directive ?? e.brief.setting}"

ENTITIES (place a cell for EVERY id — UNLESS you fold a plural one into a field below, then omit its cell):
${entities.map((x) => `  ${x.id} — ${x.what}`).join('\n')}

Output this shape (use the REAL ids below; cols/rows are inferred from your grid — keep rows equal-length, ≥12 rows; "fields" is optional):
{"blockout":{
  "grid":["...one string per row, 18-24 chars, 12-14 rows..."],
  "cells":[${entities.map((x) => `{"id":"${x.id}","col":<n>,"row":<n>}`).join(',')}]
 },
 "fields":[ /* 0+ repeated-object groups, e.g. */ {"idBase":"prop:pews","tag":"table","region":{"band":"center"},"arrangement":"grid","count":12,"spacing":2} ]}`;
}
