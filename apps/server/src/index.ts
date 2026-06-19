/** MythWeaver backend: session lifecycle + the orchestrator turn endpoint. */

import './env.js'; // must be first — loads .env before anything reads process.env
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyReply } from 'fastify';
import { Engine, createInitialState } from '@mythweaver/engine';
import { createProvider } from '@mythweaver/llm';
import { CHARACTERS, FakeSceneComposer, LlmSceneComposer, PROPS, TERRAINS, buildSceneMap, loadAssetLibrary } from '@mythweaver/scene';
import { BIOMES, classToSpriteTag, validateEstablishScene, type EstablishScene } from '@mythweaver/shared';
import { Db } from './db.js';
import { loadScenario, readScenarioRaw, writeScenarioRaw } from './content.js';
import { loadPlaybook, savePlaybook } from './prompts.js';
import { buildRetriever } from './corpus.js';
import { buildTracer } from './tracing.js';
import { runTurn, type TurnInput } from './orchestrator.js';
import { labBuildScene, labComposeScene } from './scene-lab.js';
import { runDmLab, DM_LAB_TRANSCRIPTS, type LabTurn } from './dm-lab.js';
import { renderDmLabPage } from './dm-lab-page.js';
import { distillStyle, DISTILL_MAX_INPUT } from './distill.js';

const PORT = Number(process.env.PORT ?? 8080);
// Bind to localhost by default; containers set HOST=0.0.0.0 (and should set a token).
const HOST = process.env.HOST ?? '127.0.0.1';
const DEFAULT_SCENARIO = 'the-sunken-bell';
const API_TOKEN = process.env.MYTHWEAVER_API_TOKEN ?? '';
const SESSION_BUDGET_USD = Number(process.env.MYTHWEAVER_SESSION_BUDGET_USD || 0);

const app = Fastify({ logger: true });
const db = new Db();

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
  const body = (req.body ?? {}) as { brief?: unknown };
  const brief = typeof body.brief === 'string' ? body.brief.trim() : '';
  if (!brief) return badRequest(reply, 'brief is required');
  if (brief.length > 1000) return badRequest(reply, 'brief too long (max 1000 chars)');
  try {
    // No injected party — the brief's OWN characters (declared by the DM as npcs) are the cast.
    // Injecting a default scenario's pregens contaminated arbitrary scenes with extra heroes.
    return await labBuildScene({ llm, composer, model: dmModel }, brief, []);
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
  return { scenario, playbook: loadPlaybook(), scenarioJson };
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

// Persist edited inputs to disk (validated). Body: { playbook?, scenario?, scenarioJson? }.
app.post('/dm/lab/save', async (req, reply) => {
  const body = (req.body ?? {}) as { playbook?: unknown; scenario?: unknown; scenarioJson?: unknown };
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
  } catch (err) {
    return badRequest(reply, (err as Error).message);
  }
  if (!saved.length) return badRequest(reply, 'nothing to save (provide playbook and/or scenarioJson)');
  return { ok: true, saved };
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
  };
  const scenario = typeof body.scenario === 'string' && body.scenario ? body.scenario : DEFAULT_SCENARIO;
  if (!/^[a-z0-9-]+$/.test(scenario)) return badRequest(reply, 'invalid scenario');
  const turns = parseDmLabTurns(body.turns);
  if ('error' in turns) return badRequest(reply, turns.error);

  // Live overrides (not persisted): the editor's playbook/scenario text + a temperature.
  const playbook = typeof body.playbook === 'string' && body.playbook.trim() ? body.playbook : undefined;
  const scenarioJson = typeof body.scenarioJson === 'string' && body.scenarioJson.trim() ? body.scenarioJson : undefined;
  let temperature: number | undefined;
  if (body.temperature !== undefined && body.temperature !== null && body.temperature !== '') {
    const t = Number(body.temperature);
    if (!Number.isFinite(t) || t < 0 || t > 1) return badRequest(reply, 'temperature must be between 0 and 1');
    temperature = t;
  }

  try {
    // Reuse the live DM provider + retriever; a deterministic FakeSceneComposer keeps the lab cheap.
    return await runDmLab(
      { llm, retriever, composer: new FakeSceneComposer(), ...(playbook ? { playbook } : {}), ...(scenarioJson ? { scenarioJson } : {}), ...(temperature !== undefined ? { temperature } : {}) },
      scenario,
      turns,
    );
  } catch (err) {
    app.log.error(err, 'dm lab failed');
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
    scenes: Object.fromEntries(bundle.scenario.scenes.map((s) => [s.id, { title: s.title, summary: s.summary }])),
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
    const result = await runTurn({ engine, llm, recentTranscript: recent, playbook: loadPlaybook(), retriever, tracer, composer }, parsed);

    const state = engine.getState();
    const newSpent = spent + result.costUsd;
    state.spentUsd = newSpent;
    if (state.log.length > 50) state.log = state.log.slice(-50); // keep the in-blob audit bounded
    await db.saveState(id, state);

    // Canonical transcript lives in the messages table (not the state blob).
    if (parsed.kind === 'message') await db.appendMessage(id, 'player', parsed.speakerId, parsed.text);
    else await db.appendMessage(id, 'player', 'roll', `🎲 ${parsed.total}`);
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
