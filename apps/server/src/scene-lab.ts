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
import { buildCityScene, buildComponentSheet, buildSceneMap, buildSpikeScene, GOLD_PROGRAMS, LlmCityPlanner, LlmSceneProgrammer, runProgram, type CityDistrictSpec, type CityRequest, type SceneComposer, type SceneProgram } from '@mythweaver/scene';
import type { EstablishScene, GameState, Lighting, PartyMemberRef, SceneComposition, SceneMap } from '@mythweaver/shared';
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
