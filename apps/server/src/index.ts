/** MythWeaver backend: session lifecycle + the orchestrator turn endpoint. */

import './env.js'; // must be first — loads .env before anything reads process.env
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyReply } from 'fastify';
import { Engine, createInitialState } from '@mythweaver/engine';
import { createProvider } from '@mythweaver/llm';
import { CHARACTERS, FakeSceneComposer, LlmSceneComposer, PROPS, TERRAINS, buildSceneMap, cityMeshBlueprint, loadAssetLibrary } from '@mythweaver/scene';
import { BIOMES, classToSpriteTag, validateEstablishScene, type EstablishScene } from '@mythweaver/shared';
import { Db } from './db.js';
import { loadScenario, readScenarioRaw, writeScenarioRaw, parseScenario, loadSharedParty, loadSharedBestiary, resolveParty } from './content.js';
import {
  loadPlaybook,
  savePlaybook,
  loadDirectorArchitect,
  loadDirectorPlanner,
  loadDirectorComposer,
  saveDirectorArchitect,
  saveDirectorPlanner,
  saveDirectorComposer,
} from './prompts.js';
import { buildRetriever } from './corpus.js';
import { buildTracer } from './tracing.js';
import { runTurn, type TurnInput } from './orchestrator.js';
import { labBuildCity, labBuildComponent, labBuildProgram, labBuildScene, labBuildSpike, labComposeScene } from './scene-lab.js';
import { saveSceneCapture } from './scene-eval/capture.js';
import { runDmLab, createDmLabSession, dmLabSubmit, arcView, autoRollTotal, DM_LAB_TRANSCRIPTS, type LabTurn, type DmLabSession } from './dm-lab.js';
import { renderDmLabPage } from './dm-lab-page.js';
import { distillStyle, DISTILL_MAX_INPUT } from './distill.js';
import { buildArcPlanner } from './arc-planner.js';
import { buildArcComposer, validateGeneratedArc, type ArcSeed, type GeneratedArc } from './arc-composer.js';

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

// Scene Lab — G1b: the LLM composes a PRIMITIVE PROGRAM from a freeform brief (the creativity test),
// then the deterministic interpreter renders it. No grammar templates. One LLM call.
app.post('/scene/program', async (req, reply) => {
  const body = (req.body ?? {}) as { brief?: unknown };
  const brief = typeof body.brief === 'string' ? body.brief.trim() : '';
  if (!brief) return badRequest(reply, 'brief is required');
  if (brief.length > 1000) return badRequest(reply, 'brief too long (max 1000 chars)');
  try {
    return await labBuildProgram({ llm, model: dmModel }, brief);
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
  const q = (req.query ?? {}) as { seed?: string; nPatches?: string };
  const seed = Number.isFinite(Number(q.seed)) ? Number(q.seed) : 1;
  const nPatches = Number.isFinite(Number(q.nPatches)) ? Number(q.nPatches) : 15;
  try {
    return cityMeshBlueprint(seed, { nPatches });
  } catch (err) {
    app.log.error(err, 'scene citymesh blueprint failed');
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
  return renderDmLabPage(DM_LAB_TRANSCRIPTS);
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

// Parse the hand-built party (Add player → role) from a request body: [{role, name?}], capped at 6.
function parsePartyPicks(raw: unknown): { role: string; name?: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p) => {
      const pp = (p ?? {}) as Record<string, unknown>;
      return { role: typeof pp.role === 'string' ? pp.role.trim().slice(0, 40) : '', ...(typeof pp.name === 'string' && pp.name.trim() ? { name: pp.name.trim().slice(0, 60) } : {}) };
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
    return { name: (pk.name || '').trim() || (a ? a.name : pk.role), className: a ? a.className : pk.role };
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
    lines.push(`**Party:** ${arc.party.map((p) => `${p.name} (L${p.level} ${p.className}, ${p.maxHitPoints} HP, AC ${p.armorClass})`).join(' · ')}`);
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
    const { arc, costUsd } = await arcComposer.compose(seed, { ...(temperature !== undefined ? { temperature } : {}), library: loadSharedBestiary() });
    arc.party = resolveParty(parsePartyPicks((req.body as Record<string, unknown>)?.party)); // resolved sheets, editable in the bundle
    return { arc, costUsd, markdown: arcMarkdown(arc) };
  } catch (err) {
    app.log.error(err, 'arc generation failed');
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
  };
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
        ...(arcPlanner ? { arcPlanner } : {}),
        ...(playbook ? { playbook } : {}),
        ...(scenarioJson ? { scenarioJson } : {}),
        ...(temperature !== undefined ? { temperature: temperature as number } : {}),
        ...(arcTemperature !== undefined ? { arcTemperature: arcTemperature as number } : {}),
        ...(startSceneId ? { startSceneId } : {}),
        ...(generatedArc ? { generatedArc } : {}),
        ...(party ? { party } : {}),
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
  return { sessionId, scenarioId: session.scenarioId, scene: session.scene, party: session.party, arc: arcView(session) };
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
    return { turn, totalCostUsd: session.totalCostUsd, totalLatencyMs: session.totalLatencyMs, pendingRoll: session.pendingRoll ?? null, arc: arcView(session) };
  } catch (err) {
    app.log.error(err, 'dm lab session turn failed');
    reply.code(502);
    return { error: (err as Error).message };
  }
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
    scenes: Object.fromEntries(bundle.scenario.scenes.map((s) => [s.id, { title: s.title, summary: s.summary, exits: s.exits }])),
  };
  const state = createInitialState({
    sessionId: id,
    scenarioId: bundle.scenario.id,
    startSceneId: bundle.scenario.startSceneId,
    party: bundle.pregens,
    adventure,
    encounters: bundle.scenario.encounters,
    bestiary: Object.fromEntries(bundle.bestiary.map((b) => [b.id, b])),
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
    const result = await runTurn({ engine, llm, recentTranscript: recent, playbook: loadPlaybook(), retriever, tracer, composer, ...(arcPlanner ? { arcPlanner } : {}) }, parsed);

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
