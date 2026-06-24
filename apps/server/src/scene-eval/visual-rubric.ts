/**
 * VISUAL rubric + judge prompts (strategy A — score the rendered PIXELS, not a text digest).
 *
 * The text judge in rubric.ts reads a digest of the SceneMap and explicitly ignores art ("assume
 * placeholder tiles") — so it is blind to whole classes of defect that exist ONLY in the render:
 * unfinished wall corners, a door opening onto a wall, a hole in an exterior wall, a prop used for
 * the wrong purpose, the same three assets repeated. This rubric scores exactly those, from an image.
 *
 * Design notes:
 * - We describe WHAT GOOD LOOKS LIKE per dimension (which naturally enumerates the failure classes)
 *   but never tell the judge which specific defects to expect — the whole point is that it finds them
 *   on its own.
 * - CALIBRATION: a NOT-A-DEFECT list pins the builder's INTENTIONAL features (enclosed courtyards /
 *   indoor gardens / fenced plots, the roofless top-down view, placeholder art) so the judge stops
 *   dinging things we want. Edit that list as taste is established — it is the judge's calibration knob.
 * - LOCALIsATION: each defect carries a canonical `unit` (which building, counted left→right, top row
 *   then bottom: "#3") + a coarse `region` (nw…se/whole). That makes a defect a MATCHABLE key, so the
 *   panel's lenses can corroborate the same defect (consensus) instead of phrasing it three ways.
 * - The judge runs as a PANEL of LENSES (see visual-judge.ts); each shares this rubric but scrutinises
 *   one area hardest, so a single flaky pass can't sink (or inflate) the verdict.
 */

export const VISUAL_RUBRIC = [
  {
    key: 'wallIntegrity',
    label: 'Wall & edge integrity',
    desc:
      'Each building is a CLOSED wall ring. Corners are finished with proper corner tiles (a top-left corner ' +
      'differs from a top-right corner, which differ from a straight run). There are NO black / blank / ' +
      'transparent cells where a wall or floor should be, and no stretch of wall built from the wrong or a ' +
      'repeated tile. The wall reads as one continuous, deliberate boundary.',
  },
  {
    key: 'openingSanity',
    label: 'Opening sanity',
    desc:
      'Every door and archway connects two REAL walkable spaces. There is NO door that opens onto a wall or ' +
      'onto empty exterior ground, and NO gap / hole in an exterior wall that lacks an actual door in it ' +
      '(a wall is continuous except at genuine, framed doorways). Interior connector arches sit between two ' +
      'interior rooms, never on an outside wall.',
  },
  {
    key: 'furnitureCoherence',
    label: 'Furniture coherence',
    desc:
      'Furniture is grouped sensibly by room function: a table HAS chairs around it; a bed sits AGAINST a ' +
      'wall; storage (chests/barrels/shelves) clusters in a corner. Nothing is marooned alone in the middle ' +
      'of a room, there are no duplicate beds scattered at random, and no prop is used for the wrong job ' +
      '(e.g. an archway tile dropped in as if it were a table). NOTE: an enclosed COURTYARD or indoor GARDEN ' +
      '(trees, flowers, a fountain/well inside or beside the walls) is an intentional space, not a furnished ' +
      'room — judge it as a garden, never as "marooned props" or "no room function".',
  },
  {
    key: 'assetRichness',
    label: 'Asset richness & legibility',
    desc:
      'A believable VARIETY of props is used (not the same two or three tiles repeated everywhere). Density ' +
      'reads well — rooms feel lived-in, neither barren nor an unreadable clutter. Outdoor greenery (trees, ' +
      'flowers, bushes) looks intentional, not noise.',
  },
  {
    key: 'typeReadability',
    label: 'Type readability',
    desc:
      'Each building reads UNMISTAKABLY as the kind of place it is, from its FOCAL composition — not just ' +
      'generic furniture. A temple has a clear altar as the focal point with seating ranked toward it down an ' +
      'aisle; a tavern a continuous bar counter with stools; a smithy a forge workstation (forge + anvil + ' +
      'tools clustered); a shop a service counter with goods on display. You could name the building type at a ' +
      'glance. A geometrically-correct but generic interior (right walls, plausible furniture, but no legible ' +
      'function) scores LOW here even if every other dimension is high — this is the "reads as itself" gate. ' +
      '(This is necessary-but-not-sufficient with the deterministic semantic check, which proves the focal ' +
      'piece is present and prominent; this dimension judges whether it actually READS as the focus.)',
  },
  {
    key: 'overallFidelity',
    label: 'Overall fidelity',
    desc:
      'Taken whole, each building reads as a hand-crafted, top-down RPG building in the DawnLike style — a ' +
      'place a person designed — rather than a procedurally filled box of scattered tiles.',
  },
] as const;

export type VisualRubricKey = (typeof VISUAL_RUBRIC)[number]['key'];
/** Scores are keyed by the ACTIVE rubric's dimension keys (building OR composition), so this is open. */
export type VisualScores = Record<string, number>;

/**
 * The builder's INTENTIONAL features — the judge must NOT report these as defects. This is the
 * calibration knob: as taste is established, add/remove lines here rather than re-prompting ad hoc.
 */
export const NOT_DEFECTS = [
  'An indoor GARDEN/COURTYARD that is ringed by a low FENCE (open — you can see into it: trees, flowers, a fountain or well on grass) is INTENTIONAL — do not call it clutter, marooned props, or "no room function". (A garden boxed in by SOLID WALLS instead of a fence is NOT intentional — that one you SHOULD flag.)',
  'The ROOFLESS top-down view (you can see into every building by design — that is not a "missing roof").',
  'Placeholder / programmer-art tile quality, minor colour banding, or the dark background OUTSIDE the buildings.',
  'Any faint coordinate grid or labels overlaid for reference (if present) — that is annotation, not part of the scene.',
];

export type DefectSeverity = 'critical' | 'major' | 'minor';
/** Coarse position of a defect within its unit/the image — a matchable bucket for consensus. */
export const REGIONS = ['nw', 'n', 'ne', 'w', 'center', 'e', 'sw', 's', 'se', 'whole'] as const;
export type Region = (typeof REGIONS)[number];

export interface VisualDefect {
  severity: DefectSeverity;
  /** Which rubric dimension this defect belongs to (a key of the active rubric). */
  category: string;
  /** Canonical unit label — which building, counted left→right then top→bottom, e.g. "#3" (or "whole"). */
  unit: string;
  /** Coarse region within that unit. */
  region: Region;
  /** What is wrong, concretely and visually, including the precise spot. */
  detail: string;
}

export interface VisualVerdict {
  scores: VisualScores;
  defects: VisualDefect[];
  rationale: string;
}

/** A judging LENS: a label + the area it scrutinises hardest. All lenses share the full rubric. */
export interface JudgeLens {
  key: string;
  focus: string;
}

export const JUDGE_LENSES: JudgeLens[] = [
  { key: 'structure', focus: 'WALLS, CORNERS and OPENINGS — trace every wall ring; hunt unfinished/mismatched corners, doors that open onto a wall or nothing, and holes in walls with no door.' },
  { key: 'habitability', focus: 'FURNITURE and ROOM FUNCTION — check each room is furnished coherently; hunt marooned items, duplicate/random beds, and props used for the wrong purpose. (Remember: courtyards/gardens are not rooms.)' },
  { key: 'fidelity', focus: 'RICHNESS and OVERALL CRAFT — judge asset variety, density legibility, and whether the whole thing reads as hand-crafted vs. procedurally scattered.' },
];

// ── COMPOSITION rubric — judges a whole SETTLEMENT slice (town / precinct), not a single building interior.
// The building rubric above grades wall rings + per-room furniture; applied to a town it mis-frames everything
// (it reads the plaza as "a room", a door onto the street as "a door onto nothing", a water pool as "a dark
// room"). This rubric instead grades the COMPOSITION: plaza, streets/alleys, frontage packing, massing, green.
export const COMPOSITION_RUBRIC = [
  {
    key: 'plazaLegibility',
    label: 'Plaza legibility',
    desc:
      'The public CENTRE reads as a deliberate paved plaza/square — a coherent open space FRAMED by building ' +
      'frontage, not a leftover gap. It has a clear civic focal feature (a fountain, a well, a water pool, a ' +
      'market) that anchors it. The paving reads as one intentional surface.',
  },
  {
    key: 'streetNetwork',
    label: 'Street & alley network',
    desc:
      'Paved streets and alleys form a CONNECTED, navigable network: ways link the plaza to the buildings and ' +
      'lead out of frame; alleys run BETWEEN buildings and wind enough to invite exploring. No paved area is an ' +
      'isolated island, and no "street" is a single dead stub. Width varies (broad ways vs narrow alleys).',
  },
  {
    key: 'frontagePacking',
    label: 'Frontage packing',
    desc:
      'Buildings PACK onto the street/plaza frontage — their walls and doors ADDRESS the paved space and they ' +
      'abut their neighbours — so the open space is DEFINED by building walls (an outdoor room). The failure ' +
      'mode is the opposite: isolated boxes floating in grass moats with space all around each one.',
  },
  {
    key: 'massingVariety',
    label: 'Massing & silhouette variety',
    desc:
      'Footprints VARY in size and SILHOUETTE — irregular L / T / U / compound shapes and a mix of large civic ' +
      'blocks and smaller shops/houses — giving an organic, hand-built rhythm. A grid of identical same-size ' +
      'squares scores LOW. Irregular outlines should be what makes the gaps between buildings irregular.',
  },
  {
    key: 'greenIntegration',
    label: 'Green integration',
    desc:
      'Greenery is placed with INTENT: trees clustered into groves/parks, gardens in coherent pockets, planting ' +
      'lining or framing spaces. Uniform tree/flower scatter sprinkled evenly across all open ground (reads as ' +
      'procedural noise) scores LOW.',
  },
  {
    key: 'settlementFidelity',
    label: 'Settlement fidelity',
    desc:
      'Taken whole, it reads as a believable, hand-designed slice of a TOWN — a place people live in and move ' +
      'through, with a centre, streets, and packed varied buildings — rather than a procedural parcel-fill, a ' +
      'field of scattered huts, or one big building mislabelled as a town.',
  },
] as const;

export const COMPOSITION_NOT_DEFECTS = [
  'This is an OUTDOOR town/precinct seen TOP-DOWN and ROOFLESS — you see INTO every building by design. Do NOT expect one enclosed wall ring around the whole scene, and do NOT judge it as a single building.',
  'Buildings FACE the street/plaza: a door or wall opening onto the PAVED public space is the ENTRANCE and is CORRECT — never call it "a door opening onto nothing" or "a hole in the wall".',
  'Building INTERIORS are secondary here. Do NOT score or report per-room furniture grouping, marooned props, or single-room function — judge the SETTLEMENT (plaza, streets, packing, massing, greenery, gestalt). Sparse interiors are fine at this zoom.',
  'The central WATER POOL — water framed by a brick rim, often with a fountain at its centre — is an intentional civic water feature. Do NOT read it as "a dark room", "a void", or "a machine/console".',
  'Placeholder / programmer-art tile quality, minor colour banding, the dark background OUTSIDE the precinct, and any faint reference grid/labels — all intentional, not defects.',
];

export const COMPOSITION_LENSES: JudgeLens[] = [
  { key: 'publicspace', focus: 'the PLAZA and STREET NETWORK — is the centre a deliberate framed square with a clear focal feature? do paved streets/alleys form a connected, navigable, intricate network (plaza→buildings→out) with winding alleys, not dead gaps or one lone ring?' },
  { key: 'packing', focus: 'FRONTAGE PACKING and MASSING — do buildings pack onto the street edge (walls/doors addressing it, abutting neighbours) to DEFINE the open space, vs isolated boxes in grass? do footprints vary in size and use irregular L/T/U/compound silhouettes?' },
  { key: 'gestalt', focus: 'GREENERY and the WHOLE — is greenery intentional (groves/parks/lining) rather than uniform noise? does the whole read as a believable hand-built town slice, not a procedural fill or one mislabelled building?' },
];

/** A rubric BUNDLE: the dimensions + the lens panel + the calibration list, selectable by key. */
export interface Rubric {
  key: string;
  label: string;
  dimensions: readonly { key: string; label: string; desc: string }[];
  lenses: JudgeLens[];
  notDefects: string[];
}

export const BUILDING_RUBRIC: Rubric = { key: 'building', label: 'Building interior', dimensions: VISUAL_RUBRIC, lenses: JUDGE_LENSES, notDefects: NOT_DEFECTS };
export const TOWN_RUBRIC: Rubric = { key: 'town', label: 'Town composition', dimensions: COMPOSITION_RUBRIC, lenses: COMPOSITION_LENSES, notDefects: COMPOSITION_NOT_DEFECTS };
export const RUBRICS: Record<string, Rubric> = { building: BUILDING_RUBRIC, town: TOWN_RUBRIC };

const SEVERITIES: DefectSeverity[] = ['critical', 'major', 'minor'];

export interface VisualJudgeContext {
  /** What the image shows, e.g. "a contact sheet of 6 'building:house' instances". */
  subject: string;
  /** Tile pixel size in the render (DawnLike = 16), so the judge can reason about cells. */
  tilePx?: number;
}

/** Build the judge prompt for one lens. The image is attached separately as an image block. Defaults to the
 *  building rubric; pass a different bundle (e.g. TOWN_RUBRIC) to judge a settlement composition instead. */
export function buildVisualJudgePrompt(ctx: VisualJudgeContext, lens: JudgeLens, rubric: Rubric = BUILDING_RUBRIC): string {
  const dims = rubric.dimensions.map((d) => `- ${d.key}: ${d.label} — ${d.desc}`).join('\n');
  const notDefects = rubric.notDefects.map((n) => `- ${n}`).join('\n');
  const defectShape = `{"severity": "critical|major|minor", "category": "<one rubric key>", "unit": "<which building, counted left→right then top→bottom, e.g. #3; or 'whole'>", "region": "<nw|n|ne|w|center|e|sw|s|se|whole>", "detail": "<what is visually wrong, with the precise spot>"}`;
  const shape = `{${rubric.dimensions.map((d) => `"${d.key}": <integer 0-5>`).join(', ')}, "defects": [${defectShape}, ...], "rationale": "<one sentence>"}`;
  return `You are a strict, calibrated art-direction reviewer for a top-down, tile-based RPG (DawnLike sprite style, ${ctx.tilePx ?? 16}px tiles, grid origin top-left). You are shown ONE rendered image: ${ctx.subject}. Judge the COMPOSITION AND THE RENDER ITSELF — what is actually drawn on screen.

Your sharpest focus this pass: ${lens.focus}
(Still score every dimension and report defects you notice outside that focus too.)

Score each dimension 0 (broken) to 5 (excellent). Be critical; reserve 5 for genuinely excellent. Then list EVERY visible defect, each pinned to its UNIT (which building — count left→right, top row first — e.g. "#3") and a coarse REGION within it (nw…se, or "whole"). Use the SAME counting so your locations are comparable. Do not invent defects you cannot actually see; do not soften real ones. Unfinished corners, doors opening onto a wall, and holes in walls without a door are exactly the kind of thing to catch.

These are INTENTIONAL — do NOT report them as defects:
${notDefects}

DIMENSIONS:
${dims}

Respond with ONLY a JSON object (no prose, no code fence):
${shape}`;
}

function clampScore(v: unknown): number {
  if (typeof v !== 'number' || Number.isNaN(v)) throw new Error('missing/invalid score');
  return Math.max(0, Math.min(5, Math.round(v)));
}

/** Parse one lens's JSON verdict. Tolerant of surrounding prose / code fences. Defaults to the building rubric. */
export function parseVisualVerdict(text: string, rubric: Rubric = BUILDING_RUBRIC): VisualVerdict {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('judge returned no JSON object');
  const obj = JSON.parse(match[0]) as Record<string, unknown>;
  const scores = {} as VisualScores;
  for (const d of rubric.dimensions) scores[d.key] = clampScore(obj[d.key]);
  const rawDefects = Array.isArray(obj.defects) ? obj.defects : [];
  const validKeys = new Set<string>(rubric.dimensions.map((d) => d.key));
  const fallbackCategory = rubric.dimensions[rubric.dimensions.length - 1]!.key;
  const validRegions = new Set<string>(REGIONS);
  const defects: VisualDefect[] = rawDefects
    .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
    .map((d) => {
      // Tolerate older/looser keys: detail|description, unit|where.
      const detail = typeof d.detail === 'string' ? d.detail : typeof d.description === 'string' ? d.description : '';
      const unit = typeof d.unit === 'string' && d.unit.trim() ? d.unit.trim() : typeof d.where === 'string' ? d.where.trim() : 'whole';
      const region = validRegions.has(d.region as string) ? (d.region as Region) : 'whole';
      return {
        severity: SEVERITIES.includes(d.severity as DefectSeverity) ? (d.severity as DefectSeverity) : 'minor',
        category: validKeys.has(d.category as string) ? (d.category as string) : fallbackCategory,
        unit,
        region,
        detail,
      };
    })
    .filter((d) => d.detail.length > 0);
  const rationale = typeof obj.rationale === 'string' ? obj.rationale : '';
  return { scores, defects, rationale };
}
