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
  GRAMMAR_ZONES,
  GRID_LIMITS,
  LAYOUT_GRAMMARS,
  isValidAnchor,
  type CompositionRequest,
  type LayoutGrammar,
  type Lighting,
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
function lookToSprite(look: string): string {
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
type SceneKind = 'interior' | 'settlement' | 'wild';
const GRAMMAR_BY_KIND: Record<SceneKind, LayoutGrammar> = { interior: 'enclosed-interior', settlement: 'town-square', wild: 'open-outdoor' };
function sceneKindOf(e: CompositionRequest['establish']): SceneKind {
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
 * fallback is a CRATE, never a tree — a tree indoors is the worst possible wrong guess.
 */
const FIXTURE_SYNONYMS: [RegExp, string][] = [
  // Buildings (composed cottages) + fountain — highest priority so "house"/"tavern" don't fall through.
  [/fountain|well|cistern|trough|water pump/, 'fountain'],
  [/tavern|inn|alehouse|lodge|guildhall|town ?hall|longhouse/, 'house_tall'],
  [/cottage|hut|cabin|shack|hovel|dwelling/, 'house_wood'],
  [/shop|store|smithy|bakery|market.?house|stall.?house/, 'house_grey'],
  [/manor|house|home|residence|building|\bhall\b|abode|cabin/, 'house_red'],
  [/grave|tomb|sarcophag|coffin|headstone|tombstone|cairn/, 'gravestone'],
  [/torch|sconce|brazier|candle|lantern|firepit|fire-?pit|hearth|campfire|bonfire|fire|lava/, 'brazier'],
  [/barrel|cask|keg|tun/, 'barrel'],
  [/chest|treasure|coffer|strongbox/, 'chest'],
  [/crate|box|crab-?pot|trap|supply|sack|basket|cargo/, 'crate'],
  [/stall|cart|market|vendor|stand|booth/, 'market_stall'],
  [/anvil|forge|smith|furnace|workbench|bench|table|desk|counter|loom/, 'table'],
  [/sign|post|notice|placard/, 'signpost'],
  [/fence|rail|paling|palisade|hedge/, 'fence'],
  [/mushroom|toadstool|fungus/, 'mushroom'],
  [/pine|fir|conifer|spruce/, 'tree_pine'],
  [/autumn|maple|orange tree/, 'tree_autumn'],
  [/bush|shrub|fern|reed|cattail|rush|sapling/, 'bush'],
  [/tree|oak|trunk|willow|birch/, 'tree'],
  // Houses, fountains & wells have no single-tile art yet (Stage B: baked from the Tiny Town kit).
  // Until then they fall through to the neutral crate rather than a wrong guess.
];
function resolveFixtureTag(tag: string): string {
  if (isProp(tag)) return tag;
  const r = tag.toLowerCase().replace(/_/g, ' ');
  for (const [re, out] of FIXTURE_SYNONYMS) if (re.test(r) && isProp(out)) return out;
  return 'crate';
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : dflt;
  return Math.min(max, Math.max(min, n));
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

  const placements: Placement[] = [];
  const push = (id: string, kind: Placement['kind'], role: Placement['role'], tag: string, name: string | undefined, visible: boolean, declaredAnchor: string | undefined) => {
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
  // Blockout: the Director paints EVERY scene kind now (interior rooms, settlements, wild). When a
  // usable grid comes back the Cartographer renders FROM it; otherwise we fall back to the
  // deterministic zone layout below (so a parse failure still yields a valid, sensible map).
  const blockout = parseBlockout(hints.blockout, knownIds);

  const isInterior = grammar === 'enclosed-interior';
  const density = isInterior ? 0 : typeof hints.ambiance?.density === 'number' ? Math.min(0.12, Math.max(0, hints.ambiance.density)) : biome === 'forest' ? 0.1 : 0.05;
  const hintTags = Array.isArray(hints.ambiance?.tags) ? (hints.ambiance!.tags as unknown[]).filter((t): t is string => typeof t === 'string' && isProp(t)) : [];
  const tags = isInterior ? [] : hintTags.length ? hintTags : ['tree', 'bush'];

  const grid = blockout ? { cols: blockout.cols, rows: blockout.rows } : { cols, rows };
  return { locationId: e.locationId, seed: req.seed, grammar, biome, lighting, grid, terrain: { base, regions }, placements, ambiance: { density, tags }, ...(blockout ? { blockout } : {}) };
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
- Water on a side → a band of W down that edge. Keep the playable middle open (G/P).`,
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
    guidance: `This is a SETTLEMENT (a built-up place) — paint the GROUND, then place structures:
- S (stone) for the plaza / market square; G (grass) around the edges; P (dirt) for streets; W (water) ONLY if waterside.
- Keep the MIDDLE open for movement. Put the main landmark (fountain/well) CENTRALLY.
- Place BUILDINGS along the top/back or sides (NOT the centre); scatter stalls and NPCs around the square.`,
    example: `Example — "a village square with a central fountain, houses lining the back, a market stall, by the sea":
{"blockout":{"grid":[
"GGGGGGGGGGGGGGGGGGGG","GGSSSSSSSSSSSSSSSSGG","GGSSSSSSSSSSSSSSSSGG",
"GGSSSSSSSSSSSSSSSSGG","GGSSSSSSSSSSSSSSSSGG","GGSSSSSSSSSSSSSSSSGG",
"GGSSSSSSSSSSSSSSSSGG","GGSSSSSSSSSSSSSSSSGG","GGSSSSSSSSSSSSSSSSGG",
"GGSSSSSSSSSSSSSSSSGG","GGGGGGGGGGGGGGGGGGGG","WWWWWWWWWWWWWWWWWWWW"],
"cells":[{"id":"prop:fountain","col":10,"row":6},{"id":"bldg:h1","col":5,"row":2},{"id":"bldg:h2","col":14,"row":2},{"id":"npc:elder","col":8,"row":7}]}}`,
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
  G = grass    P = path / dirt road    W = water    T = trees (DENSE forest)    S = stone / floor    # = wall

${g.guidance}

GENERAL RULES:
- "on the left" → low column numbers; "on the right" → high; "centre" → middle columns. col 0 = LEFT edge, row 0 = TOP edge.
- The grid MUST be 18-24 columns wide and 12-14 rows tall (like the example). NEVER fewer than 12 rows. EVERY row string MUST be exactly the same length.
- Give EVERY entity a cell on a WALKABLE tile (G, P or S — never on W, #, or T). The engine knows each entity's art; you choose POSITIONS only.

${g.example}
(The example shows the FORMAT and SIZE — copy the SHAPE, not the contents; paint what YOUR request describes.)

LAYOUT REQUEST:
"${req.directive ?? e.brief.setting}"

ENTITIES (place a cell for EVERY id):
${entities.map((x) => `  ${x.id} — ${x.what}`).join('\n')}

Output this shape (use the REAL ids below; cols/rows are inferred from your grid — keep rows equal-length, ≥12 rows):
{"blockout":{
  "grid":["...one string per row, 18-24 chars, 12-14 rows..."],
  "cells":[${entities.map((x) => `{"id":"${x.id}","col":<n>,"row":<n>}`).join(',')}]
}}`;
}
