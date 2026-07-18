/** MythWeaver backend: session lifecycle + the orchestrator turn endpoint. */

import './env.js'; // must be first — loads .env before anything reads process.env
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyReply } from 'fastify';
import { Engine, createInitialState } from '@mythweaver/engine';
import { createProvider } from '@mythweaver/llm';
import { AssetRetriever, CHARACTERS, FakeSceneComposer, LlmSceneComposer, PROPS, TERRAINS, buildSceneMap, cityBspBlueprint, cityMeshBlueprint, loadAssetLibrary, loadAssetVectors, paletteBlock, realizeCityBsp, realizeCityMesh, renderSceneMapToPng } from '@mythweaver/scene';
import { OpenAIEmbeddingProvider, VoyageEmbeddingProvider } from '@mythweaver/rag';
import { BIOMES, BUILDING_TYPES, classToSpriteTag, validateEstablishScene, type EstablishScene, type GameState, type SceneRealizeContext } from '@mythweaver/shared';
import { Db } from './db.js';
import { loadScenario, readScenarioRaw, writeScenarioRaw, parseScenario, loadSharedParty, loadSharedBestiary, loadItemCatalog, listPregens, readPregen, resolveParty, listDevSessions, readDevSession, writeDevSession } from './content.js';
import {
  loadPlaybook,
  savePlaybook,
  loadDirectorArchitect,
  loadDirectorPlanner,
  loadDirectorComposer,
  saveDirectorArchitect,
  saveDirectorPlanner,
  saveDirectorComposer,
  loadSceneArchitect,
} from './prompts.js';
import { buildRetriever } from './corpus.js';
import { buildExemplarRetriever } from './exemplar-corpus.js';
import { buildTracer } from './tracing.js';
import { runTurn, type TurnInput } from './orchestrator.js';
import { buildModernRealizer, establishFromBeat, labBuildCity, labBuildComponent, labBuildProgram, labBuildScene, labBuildSpike, labBuildStory, labComposeScene, modernRealizeInputs } from './scene-lab.js';
import { saveSceneCapture } from './scene-eval/capture.js';
import { runDmLab, createDmLabSession, dmLabSubmit, arcView, characterSheets, autoRollTotal, DM_LAB_TRANSCRIPTS, type LabTurn, type DmLabSession } from './dm-lab.js';
import { renderDmView } from './dm-view.js';
import { renderDmLabPage } from './dm-lab-page.js';
import { distillStyle, DISTILL_MAX_INPUT } from './distill.js';
import { buildArcPlanner } from './arc-planner.js';
import { buildArcComposer, inventBackstories, validateGeneratedArc, type ArcSeed, type GeneratedArc } from './arc-composer.js';
import { architectSpecs } from './scene-architect.js';

const PORT = Number(process.env.PORT ?? 8080);
// Bind to localhost by default; containers set HOST=0.0.0.0 (and should set a token).
const HOST = process.env.HOST ?? '127.0.0.1';
const DEFAULT_SCENARIO = 'the-sunken-bell';
const API_TOKEN = process.env.MYTHWEAVER_API_TOKEN ?? '';
const SESSION_BUDGET_USD = Number(process.env.MYTHWEAVER_SESSION_BUDGET_USD || 0);

const app = Fastify({ logger: true });
const db = new Db();

// In-memory store for interactive DM-Lab sessions (ephemeral — lost on restart; lab-only).
const dmLabSessions = new Map<string, DmLabSession>();
const DM_LAB_SESSION_CAP = 50;

// DM (narrator) provider — anthropic | gemini | openai (+ optional model override).
const dmProvider = (process.env.MYTHWEAVER_DM_PROVIDER || 'anthropic').toLowerCase();
const dmModel = process.env.MYTHWEAVER_DM_MODEL || undefined;
const llm = createProvider(dmProvider, dmModel ? { model: dmModel } : {});
app.log.info(`DM provider: ${dmProvider}${dmModel ? ` (${dmModel})` : ''}`);

const { retriever, description: ragMode } = buildRetriever(db);
app.log.info(`RAG retrieval: ${ragMode}`);
// Style exemplars (Technique B) — a SEPARATE voice namespace, never visible to lookupRule.
const { exemplars, description: exemplarMode } = buildExemplarRetriever();
app.log.info(`Style exemplars: ${exemplarMode}`);
const { tracer, description: traceMode } = await buildTracer();
app.log.info(`Tracing: ${traceMode}`);

// Scene Composer — fake (deterministic, no API) | anthropic | gemini | openai (+ optional model).
const dirName = (process.env.MYTHWEAVER_SCENE_DIRECTOR || 'fake').toLowerCase();
const dirModel = process.env.MYTHWEAVER_DIRECTOR_MODEL || undefined;
const composer =
  dirName === 'fake' || dirName === '' || dirName === 'none'
    ? new FakeSceneComposer()
    : new LlmSceneComposer(createProvider(dirName, dirModel ? { model: dirModel } : {}), dirModel);
app.log.info(`Scene Composer: ${dirName}${dirModel ? ` (${dirModel})` : ''}`);

// Scene PROGRAMMER provider — the MODERN generator's brain (the G1 LlmSceneProgrammer that emits scene ops).
// This must NOT be the DM's model: the DM is a NARRATOR (prose + tool calls), while composing spatial
// scene-op JSON is a distinct task the DM model does badly (it silently returns unparseable output → the
// scene collapses to the completeness-net fallback). Default it to the SAME specialized provider chosen for
// the classic Scene Composer (Gemini) — the model already picked for exactly this spatial job — overridable
// via MYTHWEAVER_SCENE_PROGRAMMER[_MODEL]. Only when no scene provider is configured (director=fake) does it
// fall back to the DM provider, preserving prior single-provider behavior.
const progName = (process.env.MYTHWEAVER_SCENE_PROGRAMMER || dirName).toLowerCase();
const progModel = process.env.MYTHWEAVER_SCENE_PROGRAMMER_MODEL || (progName === dirName ? dirModel : undefined);
const sceneReuseDm = progName === 'fake' || progName === '' || progName === 'none';
const sceneLlm = sceneReuseDm ? llm : createProvider(progName, progModel ? { model: progModel } : {});
const sceneModel = sceneReuseDm ? dmModel : progModel;
app.log.info(`Scene programmer: ${sceneReuseDm ? `${dmProvider} (REUSING DM — set MYTHWEAVER_SCENE_PROGRAMMER=gemini for a dedicated spatial model)` : `${progName}${progModel ? ` (${progModel})` : ''}`}`);

// LIVE-PLAY scene engine (wire-in part 3): settlements realize via the MODERN story path (G1 programmer
// -> archetypes, the audited extraction pipeline) with the classic Composer as decline/failure fallback.
// Kill-switch: MYTHWEAVER_SCENE_ENGINE=classic.
const sceneEngineMode = (process.env.MYTHWEAVER_SCENE_ENGINE || 'modern').toLowerCase();
// ASSET RETRIEVAL (semantic menu + binding over the library) — vectors from `npm run assets:embed`.
// Absent vectors / key / model mismatch => retrieval OFF and every consumer behaves exactly as before.
const assetVectors = loadAssetVectors();
const assetEmbedder = process.env.OPENAI_API_KEY ? new OpenAIEmbeddingProvider() : process.env.VOYAGE_API_KEY ? new VoyageEmbeddingProvider() : undefined;
const assetRetriever =
  assetVectors && assetEmbedder && assetVectors.model === assetEmbedder.model
    ? new AssetRetriever(assetVectors.rows, assetEmbedder)
    : undefined;
app.log.info(
  `Asset retrieval: ${assetRetriever ? `on (${assetVectors!.rows.length} vectors, ${assetVectors!.model})` : `off (${!assetVectors ? 'no vectors — run npm run assets:embed' : !assetEmbedder ? 'no embedding key' : `model mismatch: vectors=${assetVectors.model} embedder=${assetEmbedder.model} — re-run npm run assets:embed`})`}`,
);
const realizeScene = sceneEngineMode === 'classic' ? undefined : buildModernRealizer({ llm: sceneLlm, ...(sceneModel ? { model: sceneModel } : {}), ...(assetRetriever ? { assetRetriever } : {}) });
app.log.info(`Scene engine: ${realizeScene ? 'modern (all kinds: settlement/interior/wild) + classic fallback' : 'classic'}`);

// Game Director / arc planner (Phase D / D2) — MYTHWEAVER_ARC_PLANNER = llm (default) | fake | off.
// Director prompts are editable/hot-reloaded (prompts/director-*.md), mirroring the DM playbook.
const arcPlanner = buildArcPlanner(llm, { architectSystem: loadDirectorArchitect, plannerSystem: loadDirectorPlanner });
app.log.info(`Game Director (arc planner): ${arcPlanner ? 'on' : 'off'}`);
// Arc Composer (Phase 1) — generate fresh arcs from a seed. MYTHWEAVER_ARC_COMPOSER = llm (default) | fake | off.
const arcComposer = buildArcComposer(llm, { composerSystem: loadDirectorComposer });
app.log.info(`Game Director (arc composer): ${arcComposer ? 'on' : 'off'}`);

app.addHook('onRequest', async (req, reply) => {
  reply.header('access-control-allow-origin', '*');
  reply.header('access-control-allow-headers', 'content-type, authorization');
  reply.header('access-control-allow-methods', 'GET,POST,OPTIONS');
  // Optional shared-secret auth — enforced only when MYTHWEAVER_API_TOKEN is set.
  // The DM Lab (/dm/lab) is a local iteration tool served same-origin, so it's exempt.
  if (API_TOKEN && req.method !== 'OPTIONS' && req.url !== '/health' && !req.url.startsWith('/dm/lab')) {
    if (req.headers['authorization'] !== `Bearer ${API_TOKEN}`) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  }
});
app.options('/*', async (_req, reply) => reply.code(204).send());

app.get('/health', async () => ({ ok: true }));

// The asset library (assets/library.json) — the renderer fetches this at boot to build its
// art tables, so the Director's vocabulary and the renderer always agree (one source of truth).
app.get('/assets/library', async () => loadAssetLibrary());

// Demo scene for the renderer: the new contract pipeline (EstablishScene → FakeSceneComposer →
// Cartographer → frozen SceneMap), no session or API key needed. Mirrors a real setScene turn.
app.get('/scene/demo', async () => {
  const bundle = loadScenario(DEFAULT_SCENARIO);
  const party = bundle.pregens.slice(0, 3).map((p) => ({ id: `pc:${p.id}`, spriteTag: classToSpriteTag(p.className), name: p.name }));
  const establish = {
    locationId: 'loc:mistmoor-green',
    brief: { setting: 'a misty fen-village green at dusk, reed huts and black water beyond', biome: 'village', timeOfDay: 'dusk' as const },
    fixtures: [{ id: 'prop:bonfire', kind: 'prop' as const, tag: 'bonfire', anchor: 'center' }],
    npcs: [
      { id: 'npc:edda', name: 'Edda', look: 'a wary fisherwoman', anchor: 'near:prop:bonfire', visible: true },
      { id: 'npc:pell', name: 'Old Pell', look: 'a hunched villager', anchor: 'in:commons', visible: true },
      { id: 'npc:lurker', name: 'a shape in the reeds', look: 'a lurking orc', anchor: 'waterside', visible: false },
    ],
  };
  const composition = await new FakeSceneComposer().compose({ establish, party, seed: 42 });
  return buildSceneMap(composition);
});

// Scene Lab — drive the full setup pipeline (DM → Director → Cartographer) from a freeform
// brief, no session needed, returning every intermediate artifact for inspection. Powers /lab.
app.post('/scene/lab', async (req, reply) => {
  const body = (req.body ?? {}) as { brief?: unknown; large?: unknown };
  const brief = typeof body.brief === 'string' ? body.brief.trim() : '';
  const large = body.large === true;
  if (!brief) return badRequest(reply, 'brief is required');
  if (brief.length > 1000) return badRequest(reply, 'brief too long (max 1000 chars)');
  try {
    // No injected party — the brief's OWN characters (declared by the DM as npcs) are the cast.
    // Injecting a default scenario's pregens contaminated arbitrary scenes with extra heroes.
    return await labBuildScene({ llm, composer, model: dmModel }, brief, [], { large });
  } catch (err) {
    app.log.error(err, 'scene lab failed');
    reply.code(502);
    return { error: (err as Error).message };
  }
});

// Scene Lab — Director-only: skip the DM and compose a caller-supplied EstablishScene directly, so
// the Director can be tested in isolation (hand it intent, or edit the DM's output and re-run layout).
const SCENE_CATALOG = { tags: new Set([...TERRAINS, ...PROPS, ...CHARACTERS].map((x) => x.tag)), biomes: new Set<string>(BIOMES) };
app.post('/scene/lab/compose', async (req, reply) => {
  const body = (req.body ?? {}) as { establish?: unknown; directive?: unknown };
  const establish = body.establish as EstablishScene | undefined;
  if (!establish || typeof establish !== 'object') return badRequest(reply, 'establish (an EstablishScene) is required');
  const directive = typeof body.directive === 'string' ? body.directive.trim().slice(0, 1000) : undefined;
  const v = validateEstablishScene(establish, SCENE_CATALOG);
  if (!v.ok) return badRequest(reply, `invalid EstablishScene: ${v.violations.map((x) => x.code).join(', ')}`);
  try {
    return await labComposeScene({ composer }, establish, [], directive);
  } catch (err) {
    app.log.error(err, 'scene lab compose failed');
    reply.code(502);
    return { error: (err as Error).message };
  }
});

// Scene Lab — CITY build (city-scope V2): stitch N town districts into ONE big SceneMap, fully
// deterministic (no DM, no API key, no DB). Powers the Lab "City" toggle for the scope/zoom work.
app.post('/scene/city', async (req, reply) => {
  const body = (req.body ?? {}) as { count?: unknown; wall?: unknown; cols?: unknown; lighting?: unknown; brief?: unknown };
  const count = typeof body.count === 'number' && Number.isFinite(body.count) ? Math.round(body.count) : undefined;
  const cols = typeof body.cols === 'number' && Number.isFinite(body.cols) ? Math.round(body.cols) : undefined;
  const wall = typeof body.wall === 'boolean' ? body.wall : undefined;
  const lighting = body.lighting === 'day' || body.lighting === 'dusk' || body.lighting === 'night' ? body.lighting : undefined;
  // Optional brief → the V3 macro planner designs the districts (one LLM call). No brief → $0 roster.
  const brief = typeof body.brief === 'string' && body.brief.trim() ? body.brief.trim().slice(0, 1000) : undefined;
  try {
    return await labBuildCity({ llm, model: dmModel }, { ...(count !== undefined ? { count } : {}), ...(cols !== undefined ? { cols } : {}), ...(wall !== undefined ? { wall } : {}), ...(lighting ? { lighting } : {}), ...(brief ? { brief } : {}) });
  } catch (err) {
    app.log.error(err, 'scene city build failed');
    reply.code(502);
    return { error: (err as Error).message };
  }
});

// Scene Lab — G1 SPIKE: render a hand-written GOLD composition (labyrinth/lake/city/crypt) built from
// the new primitive vocabulary. Deterministic, no DM/LLM — proves the vocabulary expresses diverse scenes.
app.post('/scene/spike', async (req, reply) => {
  const body = (req.body ?? {}) as { name?: unknown };
  const name = typeof body.name === 'string' ? body.name : 'labyrinth';
  try {
    return labBuildSpike(name);
  } catch (err) {
    app.log.error(err, 'scene spike build failed');
    reply.code(502);
    return { error: (err as Error).message };
  }
});

// Scene Lab — STORY mode (the full experience, lab-first): the REAL DM narrates the opening beat and
// declares the setup (setScene), then the MODERN generator realizes it with the DM's cast injected.
// Two LLM calls. This is the routing that later flips the live setScene path.
app.post('/scene/story', async (req, reply) => {
  const body = (req.body ?? {}) as { premise?: unknown };
  const premise = typeof body.premise === 'string' ? body.premise.trim() : '';
  if (!premise) return badRequest(reply, 'premise is required');
  if (premise.length > 1000) return badRequest(reply, 'premise too long (max 1000 chars)');
  try {
    return await labBuildStory({ dm: llm, ...(dmModel ? { dmModel } : {}), scene: sceneLlm, ...(sceneModel ? { sceneModel } : {}), ...(assetRetriever ? { assetRetriever } : {}) }, premise);
  } catch (err) {
    app.log.error(err, 'scene story failed');
    reply.code(502);
    return { error: (err as Error).message };
  }
});

// Scene Lab — G1b: the LLM composes a PRIMITIVE PROGRAM from a freeform brief (the creativity test),
// then the deterministic interpreter renders it. No grammar templates. One LLM call.
app.post('/scene/program', async (req, reply) => {
  const body = (req.body ?? {}) as { brief?: unknown };
  const brief = typeof body.brief === 'string' ? body.brief.trim() : '';
  if (!brief) return badRequest(reply, 'brief is required');
  if (brief.length > 1000) return badRequest(reply, 'brief too long (max 1000 chars)');
  try {
    return await labBuildProgram({ llm: sceneLlm, ...(sceneModel ? { model: sceneModel } : {}), ...(assetRetriever ? { assetRetriever } : {}) }, brief);
  } catch (err) {
    app.log.error(err, 'scene program failed');
    reply.code(502);
    return { error: (err as Error).message };
  }
});

// Scene Lab — COMPONENT contact sheet: N seed-varied instances of ONE micro-generator (building type /
// vignette / density / street / plaza …) tiled in a grid, for iterating a component in isolation. $0.
app.post('/scene/component', async (req, reply) => {
  const body = (req.body ?? {}) as { kind?: unknown; count?: unknown; seed?: unknown };
  const kind = typeof body.kind === 'string' ? body.kind : 'building:tavern';
  const count = typeof body.count === 'number' && Number.isFinite(body.count) ? body.count : 6;
  const seed = typeof body.seed === 'number' && Number.isFinite(body.seed) ? body.seed : 1;
  try {
    return labBuildComponent(kind, count, seed);
  } catch (err) {
    app.log.error(err, 'scene component build failed');
    reply.code(502);
    return { error: (err as Error).message };
  }
});

// Scene Lab — CITY MESH BLUEPRINT (the "Blueprint" tab): the float Voronoi ward mesh + the structures
// derivable from it (wall/streets/skeleton). Deterministic, $0 — for iterating the layout core in isolation.
app.get('/scene/citymesh', async (req, reply) => {
  const q = (req.query ?? {}) as { seed?: string; nPatches?: string; wall?: string; engine?: string };
  const seed = Number.isFinite(Number(q.seed)) ? Number(q.seed) : 1;
  const nPatches = Number.isFinite(Number(q.nPatches)) ? Number(q.nPatches) : 15;
  const wall = q.wall !== '0' && q.wall !== 'false'; // walled by default; ?wall=0 for an open settlement
  const bsp = q.engine === 'orthogonal' || q.engine === 'bsp';
  try {
    return (bsp ? cityBspBlueprint : cityMeshBlueprint)(seed, { nPatches, wall });
  } catch (err) {
    app.log.error(err, 'scene citymesh blueprint failed');
    reply.code(502);
    return { error: (err as Error).message };
  }
});

// Scene Lab — CITY layout realized to TILES (the Blueprint tab's "tiles" view): rasterizes the chosen
// engine (voronoi=organic wards · orthogonal=BSP rectangular blocks) into a real lived-in SceneMap.
// `buildings` / `npcs` (CSV) simulate the DM's roster: requested types are GUARANTEED wards; named
// story characters stand on the plaza. `plaza=grand` widens the central square.
app.get('/scene/citymesh/render', async (req, reply) => {
  const q = (req.query ?? {}) as { seed?: string; nPatches?: string; wall?: string; engine?: string; buildings?: string; npcs?: string; plaza?: string };
  const seed = Number.isFinite(Number(q.seed)) ? Number(q.seed) : 1;
  const nPatches = Number.isFinite(Number(q.nPatches)) ? Number(q.nPatches) : 15;
  const wall = q.wall !== '0' && q.wall !== 'false';
  const bsp = q.engine === 'orthogonal' || q.engine === 'bsp';
  const KNOWN = new Set<string>(BUILDING_TYPES);
  const buildings = (q.buildings ?? '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => KNOWN.has(s)).slice(0, 12) as (typeof BUILDING_TYPES)[number][];
  const npcs = (q.npcs ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 8).map((name) => ({ name: name.slice(0, 40) }));
  const contents = buildings.length || npcs.length || q.plaza === 'grand' ? { buildings, npcs, ...(q.plaza === 'grand' ? { plaza: 'grand' as const } : {}) } : undefined;
  try {
    return { sceneMap: (bsp ? realizeCityBsp : realizeCityMesh)(seed, { nPatches, wall, contents }) };
  } catch (err) {
    app.log.error(err, 'scene citymesh render failed');
    reply.code(502);
    return { error: (err as Error).message };
  }
});

// Scene Lab — VISUAL EVAL capture (strategy A): the renderer POSTs a PNG data URL of the CURRENT
// render; we persist it under scene-eval/captures/ so the visual judge scores the real pixels the
// player sees (not a text digest). Dev tool; big body limit because a PNG data URL is ~MBs.
app.post('/scene/eval/capture', { bodyLimit: 32 * 1024 * 1024 }, async (req, reply) => {
  const body = (req.body ?? {}) as { name?: unknown; dataUrl?: unknown };
  const name = typeof body.name === 'string' ? body.name : '';
  const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : '';
  const m = dataUrl.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return badRequest(reply, 'dataUrl must be a base64 PNG data URL');
  try {
    const path = await saveSceneCapture(name, m[1]!);
    return { ok: true, path, bytes: Math.floor((m[1]!.length * 3) / 4) };
  } catch (err) {
    app.log.error(err, 'scene capture failed');
    reply.code(400);
    return { error: (err as Error).message };
  }
});

// DM Lab — a self-contained web front-end (served by the backend, not apps/web) to drive the real
// DM and inspect each turn, with live-editable playbook + scenario + a temperature knob.
app.get('/dm/lab', async (_req, reply) => {
  reply.type('text/html');
  // The live-table (:6985/dm animated view) must point at whichever web app targets THIS backend.
  // Override with MYTHWEAVER_LIVE_TABLE_URL when this backend isn't on the canonical :6984 (e.g. a
  // dev backend on :6991 paired with a web instance on :6992).
  return renderDmLabPage(DM_LAB_TRANSCRIPTS, process.env.MYTHWEAVER_LIVE_TABLE_URL ?? 'http://localhost:6985');
});

// Current contents of the editable inputs (playbook + scenario.json) for the chosen scenario.
app.get('/dm/lab/files', async (req, reply) => {
  const q = (req.query ?? {}) as { scenario?: unknown };
  const scenario = typeof q.scenario === 'string' && /^[a-z0-9-]+$/.test(q.scenario) ? q.scenario : DEFAULT_SCENARIO;
  let scenarioJson = '';
  try {
    scenarioJson = readScenarioRaw(scenario);
  } catch {
    return badRequest(reply, `scenario not found: ${scenario}`);
  }
  // Scene list powers the Run tab's scene picker (start the party in any scene, e.g. the fight).
  let scenes: { id: string; title: string }[] = [];
  try {
    scenes = parseScenario(scenarioJson, scenario).scenes.map((s) => ({ id: s.id, title: s.title }));
  } catch {
    /* leave empty if the scenario JSON is mid-edit/invalid */
  }
  return {
    scenario,
    playbook: loadPlaybook(),
    scenarioJson,
    scenes,
    // Editable Game Director prompts (architect / per-turn planner / arc composer).
    directorArchitect: loadDirectorArchitect(),
    directorPlanner: loadDirectorPlanner(),
    directorComposer: loadDirectorComposer(),
    composerOn: Boolean(arcComposer),
  };
});

// Distill real session transcripts into a DM voice guide (spec §6). Returns a Markdown style
// block the UI splices into the playbook as a temporary override to test, then persist if happy.
app.post('/dm/lab/distill', async (req, reply) => {
  const body = (req.body ?? {}) as { transcript?: unknown; mode?: unknown };
  const transcript = typeof body.transcript === 'string' ? body.transcript : '';
  const mode = body.mode === 'guide' ? 'guide' : 'transcript';
  if (!transcript.trim()) return badRequest(reply, 'paste or upload some text first');
  if (transcript.length > DISTILL_MAX_INPUT) {
    return badRequest(reply, `input too large (${transcript.length} chars; max ${DISTILL_MAX_INPUT}) — paste a representative sample or fewer files`);
  }
  try {
    return await distillStyle(llm, transcript, mode);
  } catch (err) {
    app.log.error(err, 'distill failed');
    reply.code(502);
    return { error: (err as Error).message };
  }
});

// Persist edited inputs to disk (validated). Body: { playbook?, scenario?, scenarioJson?, director*? }.
app.post('/dm/lab/save', async (req, reply) => {
  const body = (req.body ?? {}) as {
    playbook?: unknown;
    scenario?: unknown;
    scenarioJson?: unknown;
    directorArchitect?: unknown;
    directorPlanner?: unknown;
    directorComposer?: unknown;
  };
  const saved: string[] = [];
  try {
    if (typeof body.playbook === 'string' && body.playbook.trim()) {
      savePlaybook(body.playbook);
      saved.push('playbook');
    }
    if (typeof body.scenarioJson === 'string' && body.scenarioJson.trim()) {
      const slug = typeof body.scenario === 'string' && /^[a-z0-9-]+$/.test(body.scenario) ? body.scenario : DEFAULT_SCENARIO;
      writeScenarioRaw(slug, body.scenarioJson); // validates JSON + shape before overwriting
      saved.push(`scenario:${slug}`);
    }
    if (typeof body.directorArchitect === 'string' && body.directorArchitect.trim()) {
      saveDirectorArchitect(body.directorArchitect);
      saved.push('director:architect');
    }
    if (typeof body.directorPlanner === 'string' && body.directorPlanner.trim()) {
      saveDirectorPlanner(body.directorPlanner);
      saved.push('director:planner');
    }
    if (typeof body.directorComposer === 'string' && body.directorComposer.trim()) {
      saveDirectorComposer(body.directorComposer);
      saved.push('director:composer');
    }
  } catch (err) {
    return badRequest(reply, (err as Error).message);
  }
  if (!saved.length) return badRequest(reply, 'nothing to save (provide playbook, scenarioJson, and/or director prompts)');
  return { ok: true, saved };
});

// The shared libraries the Generate tab draws from: pickable roles + the monster palette.
app.get('/dm/lab/library', async (_req, reply) => {
  try {
    return {
      roles: loadSharedParty().map((p) => ({ id: p.id, name: p.name, className: p.className, hp: p.maxHitPoints, ac: p.armorClass })),
      bestiary: loadSharedBestiary().map((b) => ({ id: b.id, name: b.name, cr: b.challengeRating, type: b.type })),
    };
  } catch (err) {
    return badRequest(reply, (err as Error).message);
  }
});

// Parse the hand-built party from a request body: [{role, name?, backstory?}], capped at 6.
function parsePartyPicks(raw: unknown): { role: string; name?: string; backstory?: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p) => {
      const pp = (p ?? {}) as Record<string, unknown>;
      return {
        role: typeof pp.role === 'string' ? pp.role.trim().slice(0, 40) : '',
        ...(typeof pp.name === 'string' && pp.name.trim() ? { name: pp.name.trim().slice(0, 60) } : {}),
        ...(typeof pp.backstory === 'string' && pp.backstory.trim() ? { backstory: pp.backstory.trim().slice(0, 600) } : {}),
      };
    })
    .filter((p) => p.role)
    .slice(0, 6);
}

// Parse a generation seed from a request body. Theme is OPTIONAL (blank → the Director invents it).
function parseArcSeed(raw: unknown): ArcSeed | { error: string } {
  const b = (raw ?? {}) as Record<string, unknown>;
  const theme = typeof b.theme === 'string' ? b.theme.trim().slice(0, 400) : '';
  const tone = typeof b.tone === 'string' && b.tone.trim() ? b.tone.trim().slice(0, 60) : undefined;
  let lengthBeats: number | undefined;
  if (b.lengthBeats !== undefined && b.lengthBeats !== null && b.lengthBeats !== '') {
    const n = Number(b.lengthBeats);
    if (!Number.isFinite(n)) return { error: 'lengthBeats must be a number' };
    lengthBeats = n;
  }
  // Party comes from role picks; resolve each role's className for the composer's flavor.
  const lib = new Map(loadSharedParty().map((p) => [p.id, p]));
  const party = parsePartyPicks(b.party).map((pk) => {
    const a = lib.get(pk.role);
    return { name: (pk.name || '').trim() || (a ? a.name : pk.role), className: a ? a.className : pk.role, ...(pk.backstory ? { backstory: pk.backstory } : {}) };
  });
  const constraints = Array.isArray(b.constraints) ? b.constraints.filter((c): c is string => typeof c === 'string').map((c) => c.slice(0, 200)).slice(0, 8) : undefined;
  const seedPhrase = typeof b.seedPhrase === 'string' && b.seedPhrase.trim() ? b.seedPhrase.trim().slice(0, 200) : undefined;
  const monsterMode = b.monsterMode === 'manual' ? 'manual' : 'auto';
  const monsterPalette = Array.isArray(b.monsterPalette) ? b.monsterPalette.filter((s): s is string => typeof s === 'string').map((s) => s.slice(0, 60)).slice(0, 40) : undefined;
  const allowCommission = b.allowCommission !== false;
  return {
    ...(theme ? { theme } : {}),
    ...(tone ? { tone } : {}),
    ...(lengthBeats !== undefined ? { lengthBeats } : {}),
    party,
    ...(constraints && constraints.length ? { constraints } : {}),
    ...(seedPhrase ? { seedPhrase } : {}),
    monsterMode,
    ...(monsterPalette && monsterPalette.length ? { monsterPalette } : {}),
    allowCommission,
  };
}

// Render a generated arc as a readable markdown preview for the Generate tab.
function arcMarkdown(arc: GeneratedArc): string {
  const bp = arc.blueprint;
  const encBySceneId = new Map(arc.encounters.map((e) => [e.sceneId, e]));
  const lines: string[] = [];
  lines.push(`# ${bp.premise || 'Generated arc'}`);
  lines.push('');
  if (arc.party && arc.party.length) {
    lines.push('## Party');
    for (const p of arc.party) {
      lines.push(`- **${p.name}** — L${p.level} ${p.className}, ${p.maxHitPoints} HP, AC ${p.armorClass}${p.backstory ? `\n  _${p.backstory}_` : ''}`);
    }
    lines.push('');
  }
  lines.push(`**Central problem:** ${bp.centralProblem || '—'}`);
  lines.push('');
  lines.push(`**Intended ending (north star):** ${bp.intendedEnding || '—'}`);
  lines.push('');
  lines.push(`**Opening:** ${bp.opening || '—'}`);
  lines.push('');
  lines.push('## Spine — route to the ending');
  for (const s of bp.spine) lines.push(`- **${s.milestone || s.sceneId || ''}**${s.sceneId ? ` _(${s.sceneId})_` : ''}: ${s.intent || ''}`);
  lines.push('');
  lines.push('## Beats');
  for (const [id, s] of Object.entries(arc.adventure.scenes)) {
    lines.push(`### ${s.title} _(${id})_`);
    lines.push(s.summary || '');
    if (s.exits && s.exits.length) lines.push(`→ exits: ${s.exits.join(', ')}`);
    const enc = encBySceneId.get(id);
    if (enc) lines.push(`⚔ ${enc.monsters.map((m) => `${m.count}× ${arc.bestiary[m.statBlockId]?.name ?? m.statBlockId}`).join(', ')}`);
    lines.push('');
  }
  const commissioned = Object.values(arc.bestiary).filter((b) => b.source === 'commissioned' || b.source === 'generated');
  if (commissioned.length) {
    lines.push('## Commissioned creatures (engine-statted)');
    for (const c of commissioned) lines.push(`- **${c.name}** — CR ${c.challengeRating}, AC ${c.armorClass}, ${c.hitPoints.average} HP, ${c.attacks[0]?.name ?? 'attack'} ${c.attacks[0]?.damage ?? ''}`);
  }
  return lines.join('\n');
}

// Generate a fresh campaign arc from a seed (Phase 1) — preview only; start a session with it via
// POST /dm/lab/session { generatedArc, scenario }. Returns the arc + a markdown preview + provenance.
app.post('/dm/lab/generate-arc', async (req, reply) => {
  if (!arcComposer) return badRequest(reply, 'arc generation is off (set MYTHWEAVER_ARC_COMPOSER=llm)');
  const body = (req.body ?? {}) as { temperature?: unknown };
  const seed = parseArcSeed(req.body);
  if ('error' in seed) return badRequest(reply, seed.error);
  let temperature: number | undefined;
  if (body.temperature !== undefined && body.temperature !== null && body.temperature !== '') {
    const t = Number(body.temperature);
    if (!Number.isFinite(t) || t < 0 || t > 1) return badRequest(reply, 'temperature must be between 0 and 1');
    temperature = t;
  }
  try {
    // Resolve the party FIRST and feed the composer the SAME names the sheets carry ("Fighter 1"),
    // not the bare archetype ("Fighter"). Otherwise the composer keys pcBackstories "Fighter the
    // Fighter" while the sheet is "Fighter 1" — neither a prefix of the other — and the merge misses.
    const resolvedParty = resolveParty(parsePartyPicks((req.body as Record<string, unknown>)?.party));
    if (resolvedParty.length) {
      seed.party = resolvedParty.map((s) => ({ name: s.name, className: s.className, ...(s.backstory ? { backstory: s.backstory } : {}) }));
    }
    const { arc, costUsd } = await arcComposer.compose(seed, { ...(temperature !== undefined ? { temperature } : {}), library: loadSharedBestiary() });
    arc.party = resolvedParty; // resolved sheets, editable in the bundle
    // Backstory precedence: authored (already on the sheet) wins; fill the blanks with what the Director
    // invented. The composer often keys entries "Aldric the Fighter" while the sheet is "Aldric", so match
    // on a name prefix (either direction), not just exact equality.
    const norm = (s: string) => s.trim().toLowerCase();
    const fill = (invented: { name: string; backstory: string }[]) => {
      for (const sheet of arc.party!) {
        if (sheet.backstory) continue;
        const s = norm(sheet.name);
        const hit = invented.find((p) => {
          const n = norm(p.name);
          return n === s || n.startsWith(`${s} `) || s.startsWith(`${n} `);
        });
        if (hit) sheet.backstory = hit.backstory;
      }
    };
    fill(arc.pcBackstories ?? []);
    // Guarantee: the composer intermittently drops pcBackstories. Any PC still blank gets a dedicated
    // fallback call — every PC ends the request with a backstory (never "(no backstory)").
    let extraCost = 0;
    const blanks = arc.party.filter((sheet) => !sheet.backstory);
    if (blanks.length) {
      const { backstories, costUsd: fillCost } = await inventBackstories(llm, {
        premise: arc.blueprint.premise || seed.theme || '',
        party: blanks.map((s) => ({ name: s.name, className: s.className })),
        ...(temperature !== undefined ? { temperature } : {}),
      });
      extraCost = fillCost;
      fill(backstories);
    }
    // SCENE ARCHITECT (S1 — Weave L0): one batched call turns every beat's fiction into a validated
    // SceneSpec — the FUNCTIONAL contract (features + relations + entry staging) the compiler consumes.
    // Invalid specs are dropped with a warning; the beat still plays on its prose plan.
    const specWarnings: string[] = [];
    try {
      const beats = Object.entries(arc.adventure.scenes).map(([id, s]) => ({ id, title: s.title, summary: s.summary, ...(s.scenePlan ? { plan: s.scenePlan } : {}) }));
      // Per-beat retrieved palettes: the architect names concepts the renderer HAS art for — this is
      // what makes 500 (later 4,500) assets reachable without a 100K-token tag dump. Optional.
      let palettes: Record<string, string> | undefined;
      if (assetRetriever) {
        try {
          palettes = {};
          for (const b of beats) {
            const pal = await assetRetriever.palette(`${b.title}. ${b.summary}. ${b.plan?.look ?? ''}`, { props: 12, chars: 6, terrain: 0 });
            const block = paletteBlock(pal, '  ASSETS (retrieved for this beat — renderable concepts; use as dotted feature kinds, e.g. prop.bell_great / actor.wolf_winter, when they fit the fiction)');
            if (block) palettes[b.id] = block;
          }
        } catch (err) {
          app.log.warn(err, 'asset palette retrieval failed (architect proceeds without)');
          palettes = undefined;
        }
      }
      const { specs, warnings, costUsd: specCost } = await architectSpecs(llm, {
        ...(palettes && Object.keys(palettes).length ? { palettes } : {}),
        premise: arc.blueprint.premise || seed.theme || '',
        beats,
        system: loadSceneArchitect(),
        ...(dmModel ? { model: dmModel } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
      });
      extraCost += specCost;
      specWarnings.push(...warnings);
      for (const [id, spec] of Object.entries(specs)) {
        const scene = arc.adventure.scenes[id];
        if (!scene) continue;
        // A beat without a prose plan still gets its spec — synthesize the plan wrapper from the spec.
        scene.scenePlan = scene.scenePlan
          ? { ...scene.scenePlan, spec }
          : { look: spec.brief.slice(0, 300), kind: spec.frame.grammar === 'interior' ? 'interior' : spec.frame.grammar === 'wild' ? 'wild' : 'settlement', mood: '', spec };
      }
    } catch (err) {
      app.log.error(err, 'scene architect failed (arc still usable without specs)');
      specWarnings.push(`scene architect failed: ${(err as Error).message}`);
    }
    return { arc, costUsd: costUsd + extraCost, markdown: arcMarkdown(arc), ...(specWarnings.length ? { specWarnings } : {}) };
  } catch (err) {
    app.log.error(err, 'arc generation failed');
    reply.code(502);
    return { error: (err as Error).message };
  }
});

// --- Pregenerated campaigns + per-beat previews: the CHEAP iteration loop -----------------------
// A frozen arc skips arc generation AND the architect ($0 to session start); the previews skip the
// DM turn entirely — brief-preview is $0 (pure assembly), scene-preview is one programmer call.

app.get('/dm/lab/pregens', async () => ({ pregens: listPregens() }));

app.get('/dm/lab/pregen/:slug', async (req, reply) => {
  try {
    const arc = validateGeneratedArc(readPregen((req.params as { slug: string }).slug));
    return { arc };
  } catch (err) {
    reply.code(404);
    return { error: (err as Error).message };
  }
});

// Prerendered dev sessions — captured full GameStates (scene already rendered) for instant, $0 play.
app.get('/dm/lab/dev-sessions', async () => ({ devSessions: listDevSessions() }));

// Freeze the CURRENT live session (its scene is already rendered in state.world) → a reusable dev-session
// fixture. The one-time-paid capture that bootstraps instant $0 iteration for everyone downstream.
app.post('/dm/lab/session/:id/freeze', async (req, reply) => {
  const session = dmLabSessions.get((req.params as { id: string }).id);
  if (!session) return badRequest(reply, 'unknown session');
  const raw = (req.body ?? {}) as { slug?: unknown; title?: unknown };
  const slug = typeof raw.slug === 'string' ? raw.slug.trim() : '';
  if (!/^[a-z0-9-]+$/.test(slug)) return badRequest(reply, 'slug must be lowercase kebab-case (a-z0-9-)');
  const state = session.engine.getState();
  if (!state.world?.currentLocationId) return badRequest(reply, 'no scene established yet — establish the opening scene before freezing');
  const lastNarration = [...state.log].reverse().find((e) => e.kind === 'narration')?.text;
  try {
    writeDevSession(slug, {
      state,
      meta: {
        title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : slug,
        scene: state.currentSceneId,
        locationId: state.world.currentLocationId,
        ...(lastNarration ? { lastNarration: lastNarration.slice(0, 400) } : {}),
      },
    });
    return { ok: true, slug };
  } catch (err) {
    app.log.error(err, 'freeze dev session failed');
    reply.code(500);
    return { error: (err as Error).message };
  }
});

/** Resolve the {arc, beat, ctx, establish} a preview works on, from a pregen slug OR an inline arc. */
function resolvePreviewBeat(raw: unknown): { arc: GeneratedArc; sceneId: string; establish: EstablishScene; ctx: SceneRealizeContext } | { error: string } {
  const body = (raw ?? {}) as { pregen?: unknown; generatedArc?: unknown; sceneId?: unknown; overrides?: unknown };
  let arc: GeneratedArc;
  try {
    if (typeof body.pregen === 'string' && body.pregen) arc = validateGeneratedArc(readPregen(body.pregen));
    else if (body.generatedArc && typeof body.generatedArc === 'object') arc = validateGeneratedArc(body.generatedArc);
    else return { error: 'pass a "pregen" slug or an inline "generatedArc"' };
  } catch (err) {
    return { error: `arc is invalid: ${(err as Error).message}` };
  }
  const sceneId = typeof body.sceneId === 'string' ? body.sceneId : '';
  const beat = arc.adventure.scenes[sceneId];
  if (!beat) return { error: `unknown sceneId "${sceneId}" (have: ${Object.keys(arc.adventure.scenes).join(', ')})` };
  const o = (body.overrides ?? {}) as Record<string, unknown>;
  const overrides: Parameters<typeof establishFromBeat>[2] = {
    ...(typeof o.setting === 'string' && o.setting.trim() ? { setting: o.setting.trim().slice(0, 600) } : {}),
    ...(o.kind === 'settlement' || o.kind === 'interior' || o.kind === 'wild' ? { kind: o.kind } : {}),
    ...(typeof o.mood === 'string' && o.mood.trim() ? { mood: o.mood.trim().slice(0, 120) } : {}),
    ...(o.timeOfDay === 'day' || o.timeOfDay === 'dusk' || o.timeOfDay === 'night' ? { timeOfDay: o.timeOfDay } : {}),
    ...(typeof o.biome === 'string' && o.biome.trim() ? { biome: o.biome.trim().slice(0, 40) } : {}),
  };
  const establish = establishFromBeat(sceneId, beat, overrides);
  const premise = arc.blueprint?.premise ?? arc.adventure.pitch;
  const ctx: SceneRealizeContext = {
    ...(premise ? { premise } : {}),
    beat: { id: sceneId, title: beat.title, summary: beat.summary },
    ...(beat.scenePlan ? { scenePlan: beat.scenePlan } : {}),
  };
  return { arc, sceneId, establish, ctx };
}

// $0 — the EXACT generator inputs for a beat (enriched brief, mood chain, kind, declared lighting),
// composed from the beat's authored plan + the campaign fiction + optional hand-tweaked declaration.
// No model call: iterate the brief template/plan wording instantly.
app.post('/dm/lab/brief-preview', async (req, reply) => {
  const r = resolvePreviewBeat(req.body);
  if ('error' in r) return badRequest(reply, r.error);
  return {
    sceneId: r.sceneId,
    establish: r.establish,
    inputs: modernRealizeInputs(r.establish, r.ctx),
    // The FUNCTIONAL contract (S1) rides beside the prose inputs so both halves of the handoff are inspectable.
    ...(r.ctx.scenePlan?.spec ? { spec: r.ctx.scenePlan.spec } : {}),
  };
});

// ~one programmer call (~$0.02, no DM turn) — realize the beat's scene through the EXACT live path
// (buildModernRealizer) and return the rendered PNG + full provenance.
app.post('/dm/lab/scene-preview', async (req, reply) => {
  const r = resolvePreviewBeat(req.body);
  if ('error' in r) return badRequest(reply, r.error);
  try {
    const res = await buildModernRealizer({ llm: sceneLlm, ...(sceneModel ? { model: sceneModel } : {}), ...(assetRetriever ? { assetRetriever } : {}) })(r.establish, [], r.ctx);
    if (!res) return badRequest(reply, 'the realizer declined');
    const png = renderSceneMapToPng(res.sceneMap, { assetsRoot: new URL('../../web/public', import.meta.url).pathname });
    // The addressable objects, so relation satisfaction is CHECKABLE from the preview (not just eyeballed).
    const objects = res.sceneMap.objects.map((o) => ({ id: o.id, ...(o.name ? { name: o.name } : {}), tag: o.tag, col: o.col, row: o.row, ...(o.group ? { group: o.group } : {}) }));
    return { sceneId: r.sceneId, provenance: res.provenance, objects, png: `data:image/png;base64,${png.toString('base64')}` };
  } catch (err) {
    app.log.error(err, 'scene preview failed');
    reply.code(502);
    return { error: (err as Error).message };
  }
});

function parseDmLabTurns(raw: unknown): LabTurn[] | { error: string } {
  if (!Array.isArray(raw)) return { error: 'turns must be an array' };
  if (raw.length === 0) return { error: 'add at least one turn' };
  if (raw.length > 20) return { error: 'too many turns (max 20)' };
  const out: LabTurn[] = [];
  let says = 0;
  for (const t of raw) {
    if (!t || typeof t !== 'object') return { error: 'each turn must be an object' };
    const r = t as Record<string, unknown>;
    if (typeof r.roll === 'number' && Number.isFinite(r.roll)) {
      out.push({ roll: r.roll });
    } else if (typeof r.say === 'string' && r.say.trim()) {
      if (r.say.length > 2000) return { error: 'a turn is too long (max 2000 chars)' };
      out.push({ say: r.say.trim(), ...(typeof r.as === 'string' && r.as.trim() ? { as: r.as.trim().slice(0, 40) } : {}) });
      says++;
    } else {
      return { error: 'each turn needs a non-empty "say" string or a numeric "roll"' };
    }
  }
  if (says === 0) return { error: 'add at least one player turn (a "say")' };
  if (says > 10) return { error: 'too many player turns (max 10) — keep lab runs cheap' };
  return out;
}

app.post('/dm/lab', async (req, reply) => {
  const body = (req.body ?? {}) as {
    scenario?: unknown;
    turns?: unknown;
    temperature?: unknown;
    playbook?: unknown;
    scenarioJson?: unknown;
    startScene?: unknown;
  };
  const scenario = typeof body.scenario === 'string' && body.scenario ? body.scenario : DEFAULT_SCENARIO;
  if (!/^[a-z0-9-]+$/.test(scenario)) return badRequest(reply, 'invalid scenario');
  const turns = parseDmLabTurns(body.turns);
  if ('error' in turns) return badRequest(reply, turns.error);

  // Live overrides (not persisted): the editor's playbook/scenario text + a temperature + start scene.
  const playbook = typeof body.playbook === 'string' && body.playbook.trim() ? body.playbook : undefined;
  const scenarioJson = typeof body.scenarioJson === 'string' && body.scenarioJson.trim() ? body.scenarioJson : undefined;
  const startSceneId = typeof body.startScene === 'string' && body.startScene.trim() ? body.startScene.trim() : undefined;
  let temperature: number | undefined;
  if (body.temperature !== undefined && body.temperature !== null && body.temperature !== '') {
    const t = Number(body.temperature);
    if (!Number.isFinite(t) || t < 0 || t > 1) return badRequest(reply, 'temperature must be between 0 and 1');
    temperature = t;
  }

  try {
    // Reuse the live DM provider + retriever; a deterministic FakeSceneComposer keeps the lab cheap.
    return await runDmLab(
      { llm, retriever, composer: new FakeSceneComposer(), ...(arcPlanner ? { arcPlanner } : {}), ...(playbook ? { playbook } : {}), ...(scenarioJson ? { scenarioJson } : {}), ...(temperature !== undefined ? { temperature } : {}), ...(startSceneId ? { startSceneId } : {}) },
      scenario,
      turns,
    );
  } catch (err) {
    app.log.error(err, 'dm lab failed');
    reply.code(502);
    return { error: (err as Error).message };
  }
});

// Interactive DM Lab — create a stateful session, then submit one turn at a time (accumulating
// context), the natural way to vibe-test the DM. The persona/scenario/temp are captured at create.
// DM Lab — the CURRENT SCENE, rendered server-side (headless PNG, pixel-parity with the web renderer):
// the playable view's "see the story come alive" panel. 404 until the DM has established a location.
app.get('/dm/lab/session/:id/scene.png', async (req, reply) => {
  const session = dmLabSessions.get((req.params as { id: string }).id);
  if (!session) return reply.code(404).send({ error: 'unknown session' });
  const world = session.engine.getState().world;
  const map = world?.currentLocationId ? world.locations[world.currentLocationId] : undefined;
  if (!map) return reply.code(404).send({ error: 'no scene established yet' });
  try {
    const png = renderSceneMapToPng(map, { assetsRoot: new URL('../../web/public', import.meta.url).pathname });
    reply.header('content-type', 'image/png');
    reply.header('cache-control', 'no-store');
    return reply.send(png);
  } catch (err) {
    app.log.error(err, 'dm lab scene render failed');
    return reply.code(500).send({ error: (err as Error).message });
  }
});

// P3 — the DM'S EYE, for human inspection: exactly the annotated roofless view the DM model receives
// each turn (name plaques, party rings, building labels). Look at what the DM looks at. `?as=<PC name>`
// adds the acting-character double ring.
app.get('/dm/lab/session/:id/dm-view.png', async (req, reply) => {
  const session = dmLabSessions.get((req.params as { id: string }).id);
  if (!session) return reply.code(404).send({ error: 'unknown session' });
  const world = session.engine.getState().world;
  const map = world?.currentLocationId ? world.locations[world.currentLocationId] : undefined;
  if (!map) return reply.code(404).send({ error: 'no scene established yet' });
  const acting = (req.query as { as?: string }).as;
  const b64 = renderDmView(map, new URL('../../web/public', import.meta.url).pathname, acting);
  if (!b64) return reply.code(500).send({ error: 'dm view render failed' });
  reply.header('content-type', 'image/png');
  reply.header('cache-control', 'no-store');
  return reply.send(Buffer.from(b64, 'base64'));
});

app.post('/dm/lab/session', async (req, reply) => {
  const body = (req.body ?? {}) as {
    scenario?: unknown;
    temperature?: unknown;
    arcTemperature?: unknown;
    playbook?: unknown;
    scenarioJson?: unknown;
    startScene?: unknown;
    generatedArc?: unknown;
    party?: unknown;
    sceneEngine?: unknown;
    frozenSession?: unknown;
  };
  // Prerendered dev session: load a captured full GameState (scene already rendered) → instant, $0.
  let frozenState: GameState | undefined;
  if (typeof body.frozenSession === 'string' && body.frozenSession) {
    if (!/^[a-z0-9-]+$/.test(body.frozenSession)) return badRequest(reply, 'invalid frozenSession slug');
    try {
      frozenState = readDevSession(body.frozenSession).state;
    } catch (err) {
      return badRequest(reply, `dev session not found: ${(err as Error).message}`);
    }
  }
  const sceneEngine = body.sceneEngine === 'fake' ? 'fake' as const : 'modern' as const;
  const scenario = typeof body.scenario === 'string' && body.scenario ? body.scenario : DEFAULT_SCENARIO;
  if (!/^[a-z0-9-]+$/.test(scenario)) return badRequest(reply, 'invalid scenario');
  const playbook = typeof body.playbook === 'string' && body.playbook.trim() ? body.playbook : undefined;
  const scenarioJson = typeof body.scenarioJson === 'string' && body.scenarioJson.trim() ? body.scenarioJson : undefined;
  const startSceneId = typeof body.startScene === 'string' && body.startScene.trim() ? body.startScene.trim() : undefined;
  // A previously-previewed (and possibly hand-edited) generated arc. Validate before it drives a session.
  let generatedArc: GeneratedArc | undefined;
  if (body.generatedArc && typeof body.generatedArc === 'object') {
    try {
      generatedArc = validateGeneratedArc(body.generatedArc);
    } catch (err) {
      return badRequest(reply, `generated arc is invalid: ${(err as Error).message}`);
    }
  }
  // The hand-built party (role picks) → resolved character sheets. Used for generated sessions.
  const partyPicks = parsePartyPicks(body.party);
  const party = partyPicks.length ? resolveParty(partyPicks) : undefined;
  const readTemp = (v: unknown): number | undefined | { error: string } => {
    if (v === undefined || v === null || v === '') return undefined;
    const t = Number(v);
    if (!Number.isFinite(t) || t < 0 || t > 1) return { error: 'temperature must be between 0 and 1' };
    return t;
  };
  const temperature = readTemp(body.temperature);
  if (temperature && typeof temperature === 'object') return badRequest(reply, temperature.error);
  const arcTemperature = readTemp(body.arcTemperature);
  if (arcTemperature && typeof arcTemperature === 'object') return badRequest(reply, arcTemperature.error);
  let session: DmLabSession;
  try {
    session = createDmLabSession(
      {
        llm,
        ...(retriever ? { retriever } : {}),
        composer: new FakeSceneComposer(),
        ...(realizeScene ? { realizeScene } : {}),
        sceneEngine,
        ...(arcPlanner ? { arcPlanner } : {}),
        ...(playbook ? { playbook } : {}),
        ...(scenarioJson ? { scenarioJson } : {}),
        ...(temperature !== undefined ? { temperature: temperature as number } : {}),
        ...(arcTemperature !== undefined ? { arcTemperature: arcTemperature as number } : {}),
        ...(startSceneId ? { startSceneId } : {}),
        ...(generatedArc ? { generatedArc } : {}),
        ...(party ? { party } : {}),
        ...(exemplars ? { exemplars } : {}),
        ...((req.body as Record<string, unknown>)?.exemplars === false ? { useExemplars: false } : {}),
        ...(frozenState ? { frozenState } : {}),
      },
      scenario,
    );
  } catch (err) {
    return badRequest(reply, (err as Error).message);
  }
  if (dmLabSessions.size >= DM_LAB_SESSION_CAP) {
    const oldest = dmLabSessions.keys().next().value;
    if (oldest) dmLabSessions.delete(oldest);
  }
  // Architect the campaign arc up front (the north star) so the Arc tab shows it before any turn.
  // Generated sessions already have a blueprint primed, so the architect is skipped.
  if (session.arcPlanner && !session.engine.getState().arc?.blueprint) {
    try {
      const st = session.engine.getState();
      const directorTemp = (arcTemperature ?? temperature) as number | undefined; // Director temp, else DM's
      const { blueprint, costUsd } = await session.arcPlanner.architect({
        adventure: st.adventure!,
        currentSceneId: st.currentSceneId,
        flags: st.flags,
        recentTranscript: [],
        party: session.party.map((p) => ({ name: p.name })),
        ...(directorTemp !== undefined ? { temperature: directorTemp } : {}),
      });
      st.arc = { ...(st.arc ?? {}), blueprint };
      session.totalCostUsd += costUsd;
    } catch (err) {
      app.log.error(err, 'arc architect (session create) failed');
    }
  }
  const sessionId = randomUUID();
  dmLabSessions.set(sessionId, session);
  return { sessionId, scenarioId: session.scenarioId, scene: session.scene, party: session.party, sceneEngine: session.sceneEngine, arc: arcView(session), characters: characterSheets(session) };
});

app.post('/dm/lab/session/:id/turn', async (req, reply) => {
  const { id } = req.params as { id: string };
  const session = dmLabSessions.get(id);
  if (!session) {
    reply.code(404);
    return { error: 'session not found — start a new one' };
  }
  const body = (req.body ?? {}) as { say?: unknown; as?: unknown; roll?: unknown; auto?: unknown; open?: unknown };
  let input: { say: string; as?: string } | { roll: number; auto?: boolean } | { open: true };
  if (body.open === true) {
    if (session.turnIndex > 0) return badRequest(reply, 'opening narration is only available at the start of a session');
    input = { open: true };
  } else if (body.auto === true) {
    if (!session.pendingRoll) return badRequest(reply, 'no roll is pending to auto-roll');
    input = { roll: autoRollTotal(session.pendingRoll.expr), auto: true };
  } else if (body.roll !== undefined && body.roll !== null && body.roll !== '') {
    const n = Number(body.roll);
    if (!Number.isFinite(n)) return badRequest(reply, 'roll must be a number');
    if (!session.pendingRoll) return badRequest(reply, 'no roll is pending — submit a player line');
    input = { roll: n };
  } else {
    const say = typeof body.say === 'string' ? body.say.trim() : '';
    if (!say) return badRequest(reply, 'say (a player line) is required');
    if (say.length > 2000) return badRequest(reply, 'turn too long (max 2000 chars)');
    input = { say, ...(typeof body.as === 'string' && body.as.trim() ? { as: body.as.trim().slice(0, 40) } : {}) };
  }
  try {
    const turn = await dmLabSubmit(session, input);
    // The live-table scene block: the full map ONLY when the location changed; deltas otherwise.
    // `rev` is the monotonic scene revision — a client seeing a gap does a full re-render instead
    // of applying deltas to a stale map.
    const world = session.engine.getState().world;
    const map = world?.currentLocationId ? world.locations[world.currentLocationId] : undefined;
    const scene = {
      changed: !!turn.sceneChanged,
      ...(turn.sceneChanged && map ? { map } : {}),
      deltas: turn.deltas ?? [],
      rev: session.sceneRev,
    };
    return { turn, scene, totalCostUsd: session.totalCostUsd, totalLatencyMs: session.totalLatencyMs, pendingRoll: session.pendingRoll ?? null, arc: arcView(session), characters: characterSheets(session) };
  } catch (err) {
    app.log.error(err, 'dm lab session turn failed');
    reply.code(502);
    return { error: (err as Error).message };
  }
});

// Fresh per-PC character sheets for the Run-view sheet modal (on open / manual refresh).
app.get('/dm/lab/session/:id/characters', async (req, reply) => {
  const session = dmLabSessions.get((req.params as { id: string }).id);
  if (!session) {
    reply.code(404);
    return { error: 'session not found — start a new one' };
  }
  return { characters: characterSheets(session) };
});

// The live table (:6985/dm) — list the joinable in-memory lab sessions.
app.get('/dm/lab/sessions', async () => {
  return {
    sessions: [...dmLabSessions.entries()].map(([id, s]) => ({
      sessionId: id,
      scenarioId: s.scenarioId,
      scene: s.scene,
      party: s.party,
      turnIndex: s.turnIndex,
      sceneEngine: s.sceneEngine,
      totalCostUsd: s.totalCostUsd,
    })),
  };
});

// The live table's cold-boot hydration: everything one screen needs to join a running session.
app.get('/dm/lab/session/:id/view', async (req, reply) => {
  const session = dmLabSessions.get((req.params as { id: string }).id);
  if (!session) {
    reply.code(404);
    return { error: 'session not found — start a new one' };
  }
  const world = session.engine.getState().world;
  const map = world?.currentLocationId ? world.locations[world.currentLocationId] : undefined;
  return {
    sessionId: (req.params as { id: string }).id,
    scenarioId: session.scenarioId,
    sceneEngine: session.sceneEngine,
    party: session.party,
    turnIndex: session.turnIndex,
    recent: session.recent,
    pendingRoll: session.pendingRoll ?? null,
    totalCostUsd: session.totalCostUsd,
    totalLatencyMs: session.totalLatencyMs,
    arc: arcView(session),
    characters: characterSheets(session),
    scene: { ...(map ? { map } : {}), rev: session.sceneRev },
  };
});

function badRequest(reply: FastifyReply, message: string) {
  reply.code(400);
  return { error: message };
}

app.post('/sessions', async (req, reply) => {
  const body = (req.body ?? {}) as { scenarioId?: unknown };
  const slug = typeof body.scenarioId === 'string' && body.scenarioId ? body.scenarioId : DEFAULT_SCENARIO;
  if (!/^[a-z0-9-]+$/.test(slug)) return badRequest(reply, 'invalid scenarioId');

  let bundle;
  try {
    bundle = loadScenario(slug);
  } catch {
    reply.code(404);
    return { error: `scenario not found: ${slug}` };
  }

  const id = randomUUID();
  const adventure = {
    pitch: bundle.scenario.pitch,
    scenes: Object.fromEntries(bundle.scenario.scenes.map((s) => [s.id, { title: s.title, summary: s.summary, exits: s.exits, ...(s.scenePlan ? { scenePlan: s.scenePlan } : {}) }])),
  };
  const state = createInitialState({
    sessionId: id,
    scenarioId: bundle.scenario.id,
    startSceneId: bundle.scenario.startSceneId,
    party: bundle.pregens,
    adventure,
    encounters: bundle.scenario.encounters,
    bestiary: Object.fromEntries(bundle.bestiary.map((b) => [b.id, b])),
    itemCatalog: loadItemCatalog(),
  });
  await db.createSession(id, bundle.scenario.id, state);
  return {
    sessionId: id,
    scenario: { id: bundle.scenario.id, title: bundle.scenario.title, pitch: bundle.scenario.pitch },
    party: bundle.pregens.map((p) => ({ id: p.id, name: p.name, className: p.className })),
  };
});

function parseTurnInput(raw: unknown): TurnInput | { error: string } {
  const body = (raw ?? {}) as { speakerId?: unknown; text?: unknown; rollRequestId?: unknown; total?: unknown };
  if (typeof body.rollRequestId === 'string' && body.rollRequestId) {
    const total = Number(body.total);
    if (!Number.isFinite(total)) return { error: 'roll total must be a number' };
    return { kind: 'roll', requestId: body.rollRequestId, total };
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return { error: 'text is required' };
  if (text.length > 2000) return { error: 'text too long (max 2000 chars)' };
  const speakerId = typeof body.speakerId === 'string' && body.speakerId ? body.speakerId.slice(0, 80) : 'player';
  return { kind: 'message', speakerId, text };
}

app.post('/sessions/:id/turn', async (req, reply) => {
  const { id } = req.params as { id: string };
  const parsed = parseTurnInput(req.body);
  if ('error' in parsed) return badRequest(reply, parsed.error);

  const row = await db.loadSession(id);
  if (!row) {
    reply.code(404);
    return { error: 'session not found' };
  }

  // Budget hard-stop (spec §4.4): block a NEW turn once the cap is reached.
  const spent = row.state.spentUsd ?? 0;
  if (SESSION_BUDGET_USD > 0 && spent >= SESSION_BUDGET_USD) {
    reply.code(402);
    return { error: 'session budget reached — raise the cap or end the session', spentUsd: spent, budgetUsd: SESSION_BUDGET_USD };
  }

  const engine = new Engine(row.state);
  const recent = await db.recentMessages(id, 12);

  try {
    const result = await runTurn({ engine, llm, recentTranscript: recent, playbook: loadPlaybook(), retriever, tracer, composer, ...(realizeScene ? { realizeScene } : {}), ...(arcPlanner ? { arcPlanner } : {}), ...(exemplars ? { exemplars } : {}), dmView: (map, acting) => renderDmView(map, new URL('../../web/public', import.meta.url).pathname, acting) }, parsed);

    const state = engine.getState();
    const newSpent = spent + result.costUsd;
    state.spentUsd = newSpent;
    if (state.log.length > 50) state.log = state.log.slice(-50); // keep the in-blob audit bounded
    await db.saveState(id, state);

    // Canonical transcript lives in the messages table (not the state blob).
    if (parsed.kind === 'message') await db.appendMessage(id, 'player', parsed.speakerId, parsed.text);
    else if (parsed.kind === 'roll') await db.appendMessage(id, 'player', 'roll', `🎲 ${parsed.total}`);
    if (result.narration) await db.appendMessage(id, 'dm', 'Dungeon Master', result.narration);

    app.log.info({ sessionId: id, trace: result.trace }, 'turn');
    await tracer.flush();

    const softWarn = SESSION_BUDGET_USD > 0 && newSpent >= 0.8 * SESSION_BUDGET_USD && spent < 0.8 * SESSION_BUDGET_USD;
    return {
      ...result, // includes sceneChanged + the frozen sceneMap when a location is entered/established
      spentUsd: newSpent,
      ...(SESSION_BUDGET_USD > 0 ? { budgetUsd: SESSION_BUDGET_USD } : {}),
      ...(softWarn ? { warning: `Approaching session budget ($${newSpent.toFixed(2)} / $${SESSION_BUDGET_USD}).` } : {}),
    };
  } catch (err) {
    // Turn atomicity: nothing was persisted, so the turn simply didn't happen.
    app.log.error(err, 'turn failed');
    reply.code(502);
    return { error: 'The DM stumbled (model or tool error). Your turn was not applied — please try again.' };
  }
});

app.get('/sessions/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const row = await db.loadSession(id);
  if (!row) {
    reply.code(404);
    return { error: 'session not found' };
  }
  return { id: row.id, scenarioId: row.scenarioId, state: row.state };
});

app
  .listen({ port: PORT, host: HOST })
  .then((addr) => app.log.info(`MythWeaver server listening on ${addr}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
