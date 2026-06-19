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
import { buildSceneMap, type SceneComposer } from '@mythweaver/scene';
import type { EstablishScene, GameState, PartyMemberRef, SceneComposition, SceneMap } from '@mythweaver/shared';
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
  composition: SceneComposition;
  sceneMap: SceneMap;
  narration: string;
  model: string;
}

/** Run brief → EstablishScene → SceneComposition → SceneMap and return all artifacts. */
export async function labBuildScene(
  deps: { llm: LlmProvider; composer: SceneComposer; model?: string },
  brief: string,
  party: PartyMemberRef[],
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
  const composition = await deps.composer.compose({ establish, party, seed: seedFor(establish.locationId), directive: brief });
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
