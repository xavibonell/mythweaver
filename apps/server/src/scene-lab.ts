/**
 * Scene Lab — drive the setup pipeline from a freeform brief, with NO game session, so the
 * whole DM → Director → Cartographer chain can be exercised and inspected in isolation:
 *
 *   brief ──DM(setScene)──► EstablishScene ──Composer──► SceneComposition ──Cartographer──► SceneMap
 *
 * Returns every intermediate artifact so the /lab UI can show exactly which stage is the weak
 * link (DM fiction? Director layout? cartography? art coverage?). Reuses the real setScene tool
 * + parser from the orchestrator, so the lab and a live turn behave identically.
 */

import type { LlmProvider } from '@mythweaver/llm';
import { buildCityScene, buildComponentSheet, buildSceneMap, buildSpikeScene, GOLD_PROGRAMS, LlmCityPlanner, LlmSceneProgrammer, lookToSprite, runProgram, type CityDistrictSpec, type CityRequest, type SceneComposer, type SceneProgram } from '@mythweaver/scene';
import type { EstablishScene, GameState, Lighting, PartyMemberRef, RealizeSceneResult, SceneComposition, SceneKindHint, SceneMap, ScenePlan, SceneProvenance, SceneRealizeContext } from '@mythweaver/shared';
import { buildToolDefs, parseEstablish, seedFor } from './orchestrator.js';

const SET_SCENE_TOOL = buildToolDefs(false, true).find((t) => t.name === 'setScene')!;

const LAB_SYSTEM = `You are MythWeaver's scene-setter. Given a player's request for a place, imagine it VIVIDLY and call setScene ONCE to establish it:
- a stable locationId (e.g. "loc:mistmoor-green")
- the setting, biome, and time of day
- the notable fixtures/structures present (use evocative tags — well, forge, market_stall, sarcophagus, …)
- EVERY npc present, including hidden ones (visible:false for a lurker)
- If the request mentions the player's own characters ("our three heroes", "the party", "our characters", "we"), declare each of them as a visible npc too, so they appear in the scene — there is no separate party list here.
Populate the place richly but coherently — a believable, lived-in scene.
For a SETTLEMENT (village/town/market), declare each notable BUILDING as its OWN fixture with an evocative structure tag — e.g. "tavern", "smithy", "cottage", "general_store", "shrine", "fishmonger's hut". The engine renders each as a roofless WALLED ROOM you can see into — wall, floor, a door, interior furniture and a keeper — so declare 3-6 distinct buildings for a lived-in town. Do NOT declare the walls, floor, door or interior furniture yourself; just name the building. Separate NPCs you declare appear out in the streets/plaza.
DO NOT list ambient terrain or vegetation as fixtures — the environment itself renders forests, treelines, grass, water and paths from the biome/setting. List only NOTABLE objects (a landmark, a structure, a chest, a campfire) and the characters. (A single focal tree — "the great oak they shelter under" — is fine; a forest's worth of trees is not.)
For REPEATED objects (rows of pews/benches, many graves, a rank of guards, a colonnade of pillars), declare them ONCE as a single fixture/npc (e.g. one "pews", one "statues") — the layout engine arranges the whole group. Do NOT list each copy separately.
After the tool call, write ONE sentence of scene-setting narration.`;

export interface LabResult {
  brief: string;
  establish: EstablishScene;
  /** Omitted for a city build (there is no single composition — one per district). */
  composition?: SceneComposition;
  /** Present for a G1b primitive-program build — the composed op list, for inspection. */
  program?: SceneProgram;
  sceneMap: SceneMap;
  narration: string;
  model: string;
}

/** Run brief → EstablishScene → SceneComposition → SceneMap and return all artifacts. */
export async function labBuildScene(
  deps: { llm: LlmProvider; composer: SceneComposer; model?: string },
  brief: string,
  party: PartyMemberRef[],
  opts: { large?: boolean } = {},
): Promise<LabResult> {
  const res = await deps.llm.complete({
    system: LAB_SYSTEM,
    messages: [{ role: 'user', content: brief }],
    tools: [SET_SCENE_TOOL],
    maxTokens: 1400,
    ...(deps.model ? { model: deps.model } : {}),
  });
  const tc = res.toolCalls.find((t) => t.name === 'setScene');
  if (!tc) throw new Error('the DM did not call setScene for that brief — try a more concrete place');
  const stub = { world: { currentLocationId: null, locations: {}, links: [] } } as unknown as GameState;
  const establish = parseEstablish(tc.input as Record<string, unknown>, stub);
  const composition = await deps.composer.compose({ establish, party, seed: seedFor(establish.locationId), directive: brief, ...(opts.large ? { large: true } : {}) });
  const sceneMap = buildSceneMap(composition);
  return { brief, establish, composition, sceneMap, narration: res.text ?? '', model: res.model };
}

// STORY mode speaks with the DM's voice: same declaration contract, but a real opening beat.
const STORY_SYSTEM = LAB_SYSTEM.replace(
  'After the tool call, write ONE sentence of scene-setting narration.',
  'FIRST write a SHORT opening narration (2-4 sentences) in the voice of a Dungeon Master — where the party stands, what draws the eye, the hook that pulls them in — THEN call setScene ONCE. (Narration BEFORE the tool call, always.)',
);

/**
 * STORY mode — the full experience, lab-first (wire-in part 3 at the lab seam): the REAL DM reads the
 * premise, narrates the opening beat, and declares the setup (setScene: setting + fixtures + named
 * cast); then the MODERN generator (G1 programmer → archetypes/primitives — the audited 10/10
 * extraction path) realizes it, with the DM's declared characters injected into the enriched brief so
 * the story's cast stands in the rendered scene. Two LLM calls (~$0.05-0.1). This is exactly the
 * routing that later flips the live setScene path — proven here first, visibly.
 */
export async function labBuildStory(deps: { llm: LlmProvider; model?: string }, premise: string): Promise<LabResult> {
  // 1. The DM — the story half: opening narration + the scene declaration.
  const res = await deps.llm.complete({
    system: STORY_SYSTEM,
    messages: [{ role: 'user', content: premise }],
    tools: [SET_SCENE_TOOL],
    maxTokens: 1400,
    ...(deps.model ? { model: deps.model } : {}),
  });
  const tc = res.toolCalls.find((t) => t.name === 'setScene');
  if (!tc) throw new Error('the DM did not call setScene for that premise — try a more concrete opening');
  const stub = { world: { currentLocationId: null, locations: {}, links: [] } } as unknown as GameState;
  const establish = parseEstablish(tc.input as Record<string, unknown>, stub);
  const { sceneMap, program } = await realizeStoryScene(deps, establish, premise);
  return { brief: premise, establish, program, sceneMap, narration: res.text ?? '', model: res.model };
}

/**
 * The MODERN realization half, shared by STORY mode and the LIVE setScene flip: enrich the premise with
 * the DM's declaration (setting + cast + fixtures), compose a primitive program (G1 — the audited
 * extraction path), deterministically inject the declared cast, and run it. One LLM call.
 */
/** EMISSION nudge (Weave terrain-field): when the DM's brief names a COAST or MOUNTAINS, prepend a
 *  terrain-field `fill` on a map edge so "a village by the sea" / "a town beneath the mountains"
 *  actually renders the feature — the same `fill`+autotile primitive that already makes lakes, now
 *  triggered from the fiction. Sea → east edge (deep water · shallows · beach), mountains → west edge
 *  (rock massif). Inserted AFTER the base fill but BEFORE the LLM's buildings/scatter, so a structure
 *  drawn later sits ON TOP of the field (a house never sinks into the sea; the band just gets clipped). */
function edgeTerrainFieldOps(text: string, cols: number, rows: number): SceneProgram['ops'] {
  const t = text.toLowerCase();
  const ops: SceneProgram['ops'] = [];
  const w = Math.max(4, Math.round(cols * 0.2));
  if (/\b(sea|seaside|seashore|coast|coastal|beach|shore|shoreline|ocean|oceanside|harbou?r|bay|lagoon|wharf|quay|waterfront|fishing village|by the water)\b/.test(t)) {
    const x0 = cols - w;
    ops.push({ op: 'fill', region: { x: x0, y: 0, w, h: rows }, tag: 'water_deep' });
    ops.push({ op: 'fill', region: { x: Math.max(0, x0 - 2), y: 0, w: 2, h: rows }, tag: 'water' });
    ops.push({ op: 'fill', region: { x: Math.max(0, x0 - 3), y: 0, w: 1, h: rows }, tag: 'sand' });
  }
  if (/\b(mountains?|mountainous|mountainside|cliffs?|crags?|craggy|highlands?|foothills?|ridge|escarpment|rocky peaks?|beneath the peaks?)\b/.test(t)) {
    ops.push({ op: 'fill', region: { x: 0, y: 0, w, h: rows }, tag: 'rock' });
  }
  return ops;
}

export async function realizeStoryScene(
  deps: { llm: LlmProvider; model?: string },
  establish: EstablishScene,
  premise: string,
  party: PartyMemberRef[] = [],
  opts: {
    /** Overrides the mood source (default: the premise). The live path passes DM mood + campaign fiction. */
    moodText?: string;
    /** Forces the layout grammar (the DM's declared `kind` / a beat's ScenePlan kind). */
    kind?: SceneKindHint;
    /** The DM's EXPLICITLY declared time of day — beats mood-inferred lighting (declared > mood > day). */
    lightingDeclared?: Lighting;
  } = {},
): Promise<{ sceneMap: SceneMap; program: SceneProgram; provenance: Pick<SceneProvenance, 'enrichedBrief' | 'moodText' | 'lightingReason' | 'program'> }> {
  const enriched = enrichedBriefFor(establish, premise);
  // Pass the raw PREMISE as the mood source: the scene's time-of-day/weather follows what the PLAYER asked
  // for, not the atmospheric flavour the DM wrote into `enriched` ("the dark maw of the mine" is flavour).
  const moodText = opts.moodText ?? premise;
  const program = await new LlmSceneProgrammer(deps.llm, deps.model).compose(enriched, moodText, opts.kind);
  program.locationId = establish.locationId; // stamp the DM's id — the frozen map must know its own name
  // LIGHTING PRECEDENCE: an explicitly DECLARED time of day beats the mood-regex (which beats 'day').
  // The coerced parser default never reaches here — the orchestrator only sets lightingDeclared when the
  // DM actually wrote timeOfDay in the tool call.
  const lightingReason: SceneProvenance['lightingReason'] = opts.lightingDeclared ? 'declared' : program.lighting !== 'day' ? 'mood' : 'default';
  if (opts.lightingDeclared && program.lighting !== opts.lightingDeclared) {
    (program.notes ??= []).push(`lighting-declared: '${opts.lightingDeclared}' overrides mood-inferred '${program.lighting}'`);
    program.lighting = opts.lightingDeclared;
  } else if (opts.lightingDeclared) {
    program.lighting = opts.lightingDeclared;
  }
  // TERRAIN-FIELD EMISSION: if the fiction names a coast/mountains, splice the field fill in after any
  // leading full-map base fill(s) but before the content ops (so buildings draw over it). Skip interiors.
  if (program.grammar !== 'enclosed-interior') {
    const fieldOps = edgeTerrainFieldOps(`${premise} ${establish.brief?.setting ?? ''} ${establish.brief?.biome ?? ''}`, program.cols, program.rows);
    if (fieldOps.length) {
      const full = (r: unknown): boolean => {
        if (r === 'all') return true;
        if (!r || typeof r !== 'object' || !('w' in r)) return false;
        const rr = r as { x?: number; y?: number; w: number; h: number };
        return (rr.x ?? 0) <= 0 && (rr.y ?? 0) <= 0 && rr.w >= program.cols && rr.h >= program.rows;
      };
      let at = 0;
      while (at < program.ops.length && program.ops[at]!.op === 'fill' && full((program.ops[at] as { region?: unknown }).region)) at++;
      program.ops.splice(at, 0, ...fieldOps);
      (program.notes ??= []).push(`terrain-field: emitted ${fieldOps.length} edge fill(s) (the fiction names a coast/mountains)`);
    }
  }
  // CAST INJECTION (deterministic): the DM's declaration is the story's truth — any named character the
  // programmer dropped is merged straight into the program (archetype contents, else a place op), so the
  // cast can never be lost to LLM variance. Sprites resolved from the DM's look text (lookToSprite).
  const arch = program.ops.find((o) => o.op === 'archetype');
  const have = new Set<string>();
  if (arch && arch.op === 'archetype') for (const n of arch.contents.npcs) if (n.name) have.add(n.name.toLowerCase());
  for (const o of program.ops) if (o.op === 'place' && o.name) have.add(o.name.toLowerCase());
  let castInjected = 0;
  establish.npcs.filter((n) => n.visible !== false).forEach((n, i) => {
    if (have.has(n.name.toLowerCase())) return;
    const tag = lookToSprite(`${n.look ?? ''} ${n.name}`);
    if (arch && arch.op === 'archetype') arch.contents.npcs.push({ tag, name: n.name });
    else program.ops.push({ op: 'place', id: `npc:story-${i}`, tag, kind: 'actor', role: 'npc', at: 'center', name: n.name });
    castInjected++;
  });
  if (castInjected) (program.notes ??= []).push(`cast-injection: merged ${castInjected} declared character(s) the programmer dropped`);
  // PARTY injection (live play): the PCs stand together near the heart of the scene, with their real
  // ids so the engine/combat can address them. place() snaps to free cells and respects claims.
  party.forEach((p) => program.ops.push({ op: 'place', id: p.id, tag: p.spriteTag ?? 'knight', kind: 'actor', role: 'pc', at: 'center', name: p.name }));
  const sceneMap = runProgram(program);
  const provenance: Pick<SceneProvenance, 'enrichedBrief' | 'moodText' | 'lightingReason' | 'program'> = {
    enrichedBrief: enriched,
    moodText,
    lightingReason,
    program: { cols: program.cols, rows: program.rows, biome: program.biome, lighting: program.lighting, grammar: program.grammar, ...(program.theme ? { theme: program.theme } : {}), ops: program.ops, ...(program.notes ? { notes: program.notes } : {}) },
  };
  return { sceneMap, program, provenance };
}

/**
 * The LIVE-PLAY hook (wire-in part 3): the orchestrator calls this on setScene BEFORE the classic
 * Director. ALL kinds (settlement / interior / wild) realize via the modern engine — the programmer +
 * primitives now carry interiors (lighting, materials, caves) and wilds, not just towns. Failures fall
 * back to the classic path — the game never breaks on a generation error.
 *
 * `ctx` is the campaign fiction the tool call can't carry: the arc premise + the current beat (and,
 * later, its authored ScenePlan). It leads the enriched brief and joins the mood chain, so "gothic
 * horror" reaches the map even when the DM's own setting string is short.
 */
/** The declaration+fiction → generator-inputs assembly, PURE and previewable ($0, no model call).
 *  This is the single place the "brief sent to the generator" is composed — iterate it here. */
export function modernRealizeInputs(est: EstablishScene, ctx?: SceneRealizeContext): {
  premise: string;
  moodText: string;
  kind?: SceneKindHint;
  lightingDeclared?: Lighting;
  /** The EXACT enriched brief the programmer receives (premise + Setting + cast + fixtures). */
  enrichedBrief: string;
} {
  const plan = ctx?.scenePlan;
  // The enriched brief LEADS with the designed look (else the campaign fiction), then the DM's declaration.
  const core = [plan?.look, ctx?.premise, ctx?.beat?.summary].filter(Boolean).join('\n') || (est.brief?.setting ?? '');
  const features = plan?.features?.length ? `Must include: ${plan.features.join(', ')}` : '';
  const premise = features ? `${core}\n${features}` : core;
  // Mood chain: the DM's declared mood > the beat's designed mood > the campaign fiction. The DM's
  // explicitly declared timeOfDay still beats all of it (applied post-compose in realizeStoryScene).
  // Deduped — the preview path derives the declaration FROM the plan, which would double every entry.
  const moodText = [...new Set([est.brief?.mood, plan?.mood, ctx?.premise, ctx?.beat?.summary].filter(Boolean))].join('. ') || (est.brief?.setting ?? '');
  const kind = est.kind ?? plan?.kind; // absent → the programmer judges from the full brief
  return {
    premise,
    moodText,
    ...(kind ? { kind } : {}),
    ...(est.timeOfDayExplicit ? { lightingDeclared: est.brief.timeOfDay } : {}),
    enrichedBrief: enrichedBriefFor(est, premise),
  };
}

/** The exact enriched-brief text the programmer receives — shared by the live path and the $0 preview. */
export function enrichedBriefFor(establish: EstablishScene, premise: string): string {
  const npcLines = establish.npcs.filter((n) => n.visible !== false).map((n) => `${n.name}${n.look ? ` (${n.look})` : ''}`);
  const fixTags = [...new Set(establish.fixtures.map((f) => f.tag))];
  return [
    premise,
    establish.brief?.setting ? `Setting: ${establish.brief.setting}` : '',
    npcLines.length ? `Characters present (place EVERY one as a named npc): ${npcLines.join('; ')}` : '',
    fixTags.length ? `Notable objects: ${fixTags.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

/** A deterministic stand-in for the DM's setScene declaration, derived from a beat's authored plan —
 *  the $0/cheap preview path (iterate briefs + scenes per beat without a DM turn). Overrides let you
 *  hand-tweak the declaration exactly as the DM might phrase it. */
export function establishFromBeat(
  sceneId: string,
  beat: { title?: string; summary?: string; scenePlan?: ScenePlan },
  overrides: { setting?: string; kind?: SceneKindHint; mood?: string; timeOfDay?: 'day' | 'dusk' | 'night'; biome?: string } = {},
): EstablishScene {
  const plan = beat.scenePlan;
  const kind = overrides.kind ?? plan?.kind;
  const mood = overrides.mood ?? plan?.mood;
  return {
    locationId: `loc:preview-${sceneId.replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}`,
    brief: {
      setting: overrides.setting ?? plan?.look ?? beat.summary ?? beat.title ?? 'a quiet, dim place',
      biome: overrides.biome ?? (kind === 'interior' ? 'dungeon' : kind === 'wild' ? 'forest' : 'village'),
      timeOfDay: overrides.timeOfDay ?? 'day',
      ...(mood ? { mood } : {}),
    },
    ...(kind ? { kind } : {}),
    ...(overrides.timeOfDay ? { timeOfDayExplicit: true } : {}),
    fixtures: [],
    npcs: [],
  };
}

export function buildModernRealizer(deps: { llm: LlmProvider; model?: string }): (est: EstablishScene, party: PartyMemberRef[], ctx?: SceneRealizeContext) => Promise<RealizeSceneResult | null> {
  return async (est, party, ctx) => {
    const inputs = modernRealizeInputs(est, ctx);
    const { sceneMap, provenance } = await realizeStoryScene(deps, est, inputs.premise, party, {
      moodText: inputs.moodText,
      ...(inputs.kind ? { kind: inputs.kind } : {}),
      ...(inputs.lightingDeclared ? { lightingDeclared: inputs.lightingDeclared } : {}),
    });
    return {
      sceneMap,
      provenance: {
        ...provenance,
        locationId: est.locationId,
        engine: 'modern',
        reused: false,
        establish: est,
        ...(ctx?.beat ? { beat: { id: ctx.beat.id, ...(ctx.beat.title ? { title: ctx.beat.title } : {}) } } : {}),
        ...(ctx?.scenePlan ? { scenePlan: ctx.scenePlan } : {}),
      },
    };
  };
}

/**
 * Run the Director + Cartographer ONLY, from a caller-supplied EstablishScene — NO DM call. This
 * isolates the Director so you can hand it intent directly (or tweak the DM's output and re-run just
 * the layout), to tell whether a bad scene came from the DM's fiction or the Director's composition.
 */
export async function labComposeScene(
  deps: { composer: SceneComposer },
  establish: EstablishScene,
  party: PartyMemberRef[],
  directive?: string,
): Promise<LabResult> {
  const composition = await deps.composer.compose({ establish, party, seed: seedFor(establish.locationId), ...(directive ? { directive } : {}) });
  const sceneMap = buildSceneMap(composition);
  return { brief: directive ?? '', establish, composition, sceneMap, narration: '', model: 'director-only' };
}

// ---------------------------------------------------------------------------
// City build (city-scope V2) — stitch N town districts into ONE big SceneMap, NO LLM. Each district
// reuses the deterministic FakeSceneComposer + Cartographer; the stitcher offsets + connects them.
// ---------------------------------------------------------------------------

/** Themed districts cycled to populate a city — varied flavours so the stitched result reads as
 *  distinct quarters, not one town copied N times. All settlement settings (no water keywords). */
const CITY_DISTRICT_ROSTER: CityDistrictSpec[] = [
  { setting: 'a market square with a tavern, a general store and stalls', builds: ['tavern', 'shop', 'shop'], npcs: [{ name: 'Marta', look: 'a bustling merchant' }, { name: 'a town guard', look: 'a guard' }] },
  { setting: 'a temple precinct with a shrine and clergy houses', builds: ['temple', 'house'], npcs: [{ name: 'Brother Cael', look: 'a robed priest' }] },
  { setting: 'a residential quarter of cottages and homes', builds: ['cottage', 'house', 'house'], npcs: [{ name: 'a goodwife', look: 'a villager woman' }] },
  { setting: 'a craftsmen quarter with a smithy and workshops', builds: ['smithy', 'shop'], npcs: [{ name: 'Borin', look: 'a burly dwarf smith' }] },
  { setting: 'an inn district with a tavern and lodging houses', builds: ['tavern', 'house'], npcs: [{ name: 'a traveler', look: 'a hooded ranger' }] },
  { setting: 'a guild row with a guildhall, a shop and a tavern', builds: ['shop', 'shop', 'tavern'], npcs: [{ name: 'a clerk', look: 'a villager' }] },
];

/**
 * Build a multi-district city SceneMap for the Lab. With NO brief it's fully deterministic ($0, no
 * key) from the roster. With a brief + an LlmProvider it runs the V3 MACRO tier: ONE city-planner LLM
 * call designs the districts (per-district art/layout stays the $0 stitcher), so a whole themed city
 * costs ~one cheap call. `count` is the district cap either way.
 */
export async function labBuildCity(
  deps: { llm?: LlmProvider; model?: string },
  opts: { count?: number; wall?: boolean; cols?: number; lighting?: Lighting; brief?: string } = {},
): Promise<LabResult> {
  const count = Math.max(1, Math.min(opts.count ?? 6, 16));
  const brief = opts.brief?.trim();
  let districts: CityDistrictSpec[];
  let model = 'city-stitcher';
  if (brief && deps.llm) {
    districts = await new LlmCityPlanner(deps.llm, deps.model).plan(brief, { max: count });
    model = 'city-planner+stitcher';
  } else {
    districts = Array.from({ length: count }, (_, i) => CITY_DISTRICT_ROSTER[i % CITY_DISTRICT_ROSTER.length]!);
  }
  const req: CityRequest = {
    locationId: 'loc:lab-city',
    districts,
    lighting: opts.lighting ?? 'day',
    ...(opts.wall !== undefined ? { wall: opts.wall } : {}),
    ...(opts.cols ? { cols: opts.cols } : {}),
  };
  const sceneMap = await buildCityScene(req);
  const establish: EstablishScene = {
    locationId: req.locationId,
    brief: { setting: brief || `a city of ${districts.length} districts`, biome: sceneMap.biome, timeOfDay: sceneMap.lighting },
    fixtures: [],
    npcs: [],
  };
  return { brief: brief ?? '', establish, sceneMap, narration: '', model };
}

/** Build one G1-spike GOLD scene by name (labyrinth/lake/city/crypt) — deterministic, no LLM. Proves
 *  the primitive vocabulary EXPRESSES diverse scenes from one system. */
export function labBuildSpike(name: string): LabResult {
  const key = name in GOLD_PROGRAMS ? name : 'labyrinth';
  const sceneMap = buildSpikeScene(key);
  const establish: EstablishScene = {
    locationId: sceneMap.locationId,
    brief: { setting: `G1 gold scene: ${key}`, biome: sceneMap.biome, timeOfDay: sceneMap.lighting },
    fixtures: [],
    npcs: [],
  };
  return { brief: '', establish, sceneMap, narration: '', model: `spike:${key}` };
}

/** The names of the available G1 gold scenes (for the Lab UI). */
export const SPIKE_SCENE_NAMES = Object.keys(GOLD_PROGRAMS);

/**
 * Component LAB — render a CONTACT SHEET of N seed-varied instances of ONE micro-generator (a building
 * type, a vignette, a density texture, a street/plaza sample…) so a single component can be iterated in
 * isolation. Deterministic, no LLM. `seed` lets the user reshuffle the whole sheet.
 */
export function labBuildComponent(kind: string, count: number, seed: number): LabResult {
  const sceneMap = buildComponentSheet(kind, count, seed);
  const establish: EstablishScene = {
    locationId: sceneMap.locationId,
    brief: { setting: `component sheet: ${kind} ×${count}`, biome: sceneMap.biome, timeOfDay: sceneMap.lighting },
    fixtures: [],
    npcs: [],
  };
  return { brief: '', establish, sceneMap, narration: '', model: `component:${kind}` };
}

/**
 * G1b — the CREATIVITY test: one LLM call composes a PRIMITIVE PROGRAM from a freeform brief (the LLM
 * chooses/arranges primitives, never coordinates), then the deterministic interpreter renders it. No
 * grammar templates involved. Returns the program too, so the lab can show what the model composed.
 */
export async function labBuildProgram(deps: { llm: LlmProvider; model?: string }, brief: string): Promise<LabResult> {
  const program = await new LlmSceneProgrammer(deps.llm, deps.model).compose(brief);
  const sceneMap = runProgram(program);
  const establish: EstablishScene = {
    locationId: sceneMap.locationId,
    brief: { setting: brief, biome: sceneMap.biome, timeOfDay: sceneMap.lighting },
    fixtures: [],
    npcs: [],
  };
  return { brief, establish, program, sceneMap, narration: '', model: 'scene-programmer' };
}
