/**
 * DM Lab — drive the real DM brain through a scripted sequence of turns and return
 * a full, inspectable trace of each turn: the narration, every tool call (name +
 * input + the result fed back), the authoritative state DIFF the turn produced, and
 * cost/latency/model. The DM-side analogue of the Scene Lab (scene-lab.ts): it shows
 * *where the DM goes wrong* — wrong tool, invented number, railroad, broken continuity.
 *
 * It runs the REAL orchestrator (orchestrator.ts) so the lab and a live turn behave
 * identically. Only the visual layer is faked (FakeSceneComposer) so the lab costs
 * nothing but the DM model calls.
 *
 * Physical-dice turns are handled for you: when the DM requests a roll, the lab
 * resolves it with the script's next `{ roll: N }` entry, or auto-rolls a plausible
 * total so an unattended script keeps moving (flagged as `auto-roll`).
 */

import {
  Engine,
  createInitialState,
  diceRange,
  parseDice,
  abilityMod,
  deriveProficiencyBonus,
  deriveCarry,
  deriveSkillModifier,
  deriveSaveModifier,
  derivePassive,
  deriveSpellSaveDc,
  deriveSpellsPreparedMax,
  XP_THRESHOLDS,
} from '@mythweaver/engine';
import {
  createProvider,
  type LlmContentBlock,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from '@mythweaver/llm';
import type { Retriever } from '@mythweaver/rag';
import { FakeSceneComposer, type SceneComposer } from '@mythweaver/scene';
import { ABILITIES, SKILLS, type Ability, type CharacterSheet, type EntityCard, type EstablishScene, type GameState, type PartyMemberRef, type RealizeSceneResult, type SceneDelta, type SceneMap, type SceneProvenance, type SceneRealizeContext, type Skill, type StatBlock } from '@mythweaver/shared';
import { createHash } from 'node:crypto';
import { loadItemCatalog, loadScenario, parseScenario, resolveParty } from './content.js';
import { buildRetriever } from './corpus.js';
import { loadDirectorArchitect, loadDirectorComposer, loadDirectorPlanner, loadPlaybook } from './prompts.js';
import { buildArcPlanner, type ArcPlanner } from './arc-planner.js';
import { buildArcComposer, type ArcComposer, type GeneratedArc } from './arc-composer.js';
import { runTurn, type TurnInput, type TurnResult, type TurnRollRequest } from './orchestrator.js';

/** A scripted lab turn: a player line, or a declared physical-dice total. */
export type LabTurn = { say: string; as?: string } | { roll: number };

export interface ToolTrace {
  name: string;
  input: Record<string, unknown>;
  /** The tool result fed back to the DM (engine state, rule passage, roll verdict, …). */
  result?: string;
}

export interface DmLabTurn {
  index: number;
  speaker: string;
  /** What was sent to the DM this turn (player text, or "🎲 N" for a declared roll). */
  input: string;
  kind: 'message' | 'roll' | 'auto-roll';
  narration: string;
  rollRequest?: TurnRollRequest;
  tools: ToolTrace[];
  /** Human-readable authoritative-state changes this turn produced (empty if none). */
  diff: string[];
  /** This turn established/entered a location (the Run tab re-renders the scene panel). */
  sceneChanged?: boolean;
  /** How the scene came to be — engine, briefs, mood chain, program + net injections. */
  sceneProvenance?: SceneProvenance;
  /** APPLIED scene deltas (updateScene/combat sync) — the map moved this turn. */
  deltas?: SceneDelta[];
  model: string;
  steps: number;
  costUsd: number;
  latencyMs: number;
}

export interface DmLabResult {
  scenario: string;
  turns: DmLabTurn[];
  totalCostUsd: number;
  totalLatencyMs: number;
}

export interface DmLabDeps {
  llm: LlmProvider;
  retriever?: Retriever;
  /** Defaults to a deterministic FakeSceneComposer (no API cost). */
  composer?: SceneComposer;
  /** LIVE-PLAY modern engine (wire-in part 3) — all kinds realize via the programmer path; classic on failure. */
  realizeScene?: (est: EstablishScene, party: PartyMemberRef[], ctx?: SceneRealizeContext) => Promise<RealizeSceneResult | null>;
  /** Scene engine for THIS session: 'modern' (default — the real programmer path, ~$0.01-0.05 per new
   *  location) or 'fake' (the deterministic $0 composer, for cheap DM iteration). */
  sceneEngine?: 'modern' | 'fake';
  /** DM persona. Defaults to the EDITED prompts/dm-playbook.md (loadPlaybook), so editing the
   *  file + re-running iterates the real persona — not the in-code DEFAULT_DM_PLAYBOOK fallback. */
  playbook?: string;
  /** Raw scenario.json text to use INSTEAD of the on-disk scenario (live editing in the lab). */
  scenarioJson?: string;
  /** Sampling temperature for the DM model (omit to use the provider default). */
  temperature?: number;
  /** Sampling temperature for the Game Director's own calls (independent of the DM). */
  arcTemperature?: number;
  /** Drop the party into a specific scene (e.g. the combat scene) instead of the scenario start. */
  startSceneId?: string;
  /** Game Director (D2). When present, STEERING is (re)planned by the LLM on triggers. */
  arcPlanner?: ArcPlanner;
  /** Arc Composer (Phase 1). When present, the lab can generate fresh arcs from a seed. */
  arcComposer?: ArcComposer;
  /** A pre-generated arc (from the Composer): use its adventure + blueprint + encounters + bestiary. */
  generatedArc?: GeneratedArc;
  /** The hand-built party (resolved character sheets). Required for generated sessions; authored
   *  sessions fall back to the scenario's pregens. */
  party?: CharacterSheet[];
}

/**
 * Wire DM-Lab deps from the environment, mirroring the live server (index.ts):
 * the same DM provider/model and rules-text retriever, but a deterministic
 * FakeSceneComposer so only the DM model calls cost money.
 */
export function buildDmLabDeps(): DmLabDeps & { ragMode: string } {
  const provider = (process.env.MYTHWEAVER_DM_PROVIDER || 'anthropic').toLowerCase();
  const model = process.env.MYTHWEAVER_DM_MODEL || undefined;
  const llm = createProvider(provider, model ? { model } : {});
  const { retriever, description: ragMode } = buildRetriever(null); // no DB needed for in-memory retrieval
  const arcPlanner = buildArcPlanner(llm, { architectSystem: loadDirectorArchitect, plannerSystem: loadDirectorPlanner });
  const arcComposer = buildArcComposer(llm, { composerSystem: loadDirectorComposer });
  return {
    llm,
    ...(retriever ? { retriever } : {}),
    composer: new FakeSceneComposer(),
    ...(arcPlanner ? { arcPlanner } : {}),
    ...(arcComposer ? { arcComposer } : {}),
    ragMode,
  };
}

/** Records each provider exchange so the lab can surface tool inputs + the results fed back. */
class RecordingProvider implements LlmProvider {
  readonly exchanges: { request: LlmRequest; response: LlmResponse }[] = [];
  constructor(private readonly inner: LlmProvider) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const response = await this.inner.complete(req);
    this.exchanges.push({ request: req, response });
    return response;
  }
}

/** A plausible declared total for an unattended auto-roll: the midpoint of the legal range. */
export function autoRollTotal(expr: string): number {
  try {
    const { min, max } = diceRange(parseDice(expr));
    return Math.round((min + max) / 2);
  } catch {
    return 10;
  }
}

interface CombatantSnap {
  id: string;
  hp: string;
  ac: number;
  conditions: string[];
  downed: boolean;
  /** Compact character-engine signature (level/xp, spell slots, hit dice, class resources, exhaustion,
   *  inspiration, concentration, gold, item count, attunement) so the lab trace shows progression, rests,
   *  and shopping/loot unfold, the way it already shows HP. */
  res: string;
}
interface StateSnap {
  scene: string;
  location: string | null;
  combat: string;
  pending: string | null;
  combatants: CombatantSnap[];
  flags: Record<string, string | number | boolean>;
}

function snapshot(state: GameState): StateSnap {
  return {
    scene: state.currentSceneId,
    location: state.world?.currentLocationId ?? null,
    combat: state.combat.active ? `round ${state.combat.round}` : 'no',
    pending: state.pendingTurn ? `${state.pendingTurn.rollExpr} — ${state.pendingTurn.rollReason}` : null,
    // All combatants (PCs + spawned monsters), so the lab trace shows the fight unfold.
    combatants: Object.values(state.combatants).map((c) => {
      const cs = state.characters?.[c.id];
      return {
        id: c.id,
        hp: `${c.currentHitPoints}/${c.maxHitPoints}`,
        ac: c.armorClass,
        conditions: [...c.conditions],
        downed: !!c.downed,
        res: [
          cs ? `lvl:${cs.level} xp:${cs.xp}` : '',
          c.slotsRemaining ? `slots:${c.slotsRemaining.slice(1).join('/')}` : '',
          c.hitDice ? `hd:${c.hitDice.remaining}/${c.hitDice.max}` : '',
          ...Object.entries(c.resources ?? {}).map(([k, v]) => `${k}:${v.current}/${v.max}`),
          c.exhaustion ? `exh:${c.exhaustion}` : '',
          c.inspiration ? 'insp' : '',
          c.concentratingOn ? `conc:${c.concentratingOn.spell}` : '',
          cs ? `gp:${cs.currency.gp} items:${cs.items.length}${cs.attunedInstanceIds.length ? ` atn:${cs.attunedInstanceIds.length}` : ''}` : '',
        ]
          .filter(Boolean)
          .join(' '),
      };
    }),
    flags: { ...state.flags },
  };
}

function diffSnaps(before: StateSnap, after: StateSnap): string[] {
  const out: string[] = [];
  if (before.scene !== after.scene) out.push(`scene: ${before.scene} → ${after.scene}`);
  if (before.location !== after.location) out.push(`location: ${before.location ?? '∅'} → ${after.location ?? '∅'}`);
  if (before.combat !== after.combat) out.push(`combat: ${before.combat} → ${after.combat}`);
  if (before.pending !== after.pending) {
    if (after.pending) out.push(`paused for roll: ${after.pending}`);
    else if (before.pending) out.push(`roll resolved: ${before.pending}`);
  }
  for (const a of after.combatants) {
    const b = before.combatants.find((p) => p.id === a.id);
    if (!b) {
      out.push(`spawned ${a.id} (${a.hp})`);
      continue;
    }
    if (b.hp !== a.hp) out.push(`${a.id} HP: ${b.hp} → ${a.hp}`);
    if (b.ac !== a.ac) out.push(`${a.id} AC: ${b.ac} → ${a.ac}`);
    if (!b.downed && a.downed) out.push(`${a.id} DOWNED`);
    if (b.downed && !a.downed) out.push(`${a.id} back up`);
    if (b.res !== a.res) out.push(`${a.id} resources: ${b.res || '∅'} → ${a.res || '∅'}`);
    const added = a.conditions.filter((c) => !b.conditions.includes(c));
    const removed = b.conditions.filter((c) => !a.conditions.includes(c));
    if (added.length) out.push(`${a.id} +${added.join(', +')}`);
    if (removed.length) out.push(`${a.id} -${removed.join(', -')}`);
  }
  const flagKeys = new Set([...Object.keys(before.flags), ...Object.keys(after.flags)]);
  for (const k of flagKeys) {
    if (before.flags[k] !== after.flags[k]) out.push(`flag ${k}: ${before.flags[k] ?? '∅'} → ${after.flags[k] ?? '∅'}`);
  }
  return out;
}

/** Build a toolUseId → result-content index from every exchange (results may arrive a turn later, e.g. rolls). */
function buildResultIndex(exchanges: { request: LlmRequest }[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const { request } of exchanges) {
    for (const m of request.messages) {
      if (typeof m.content === 'string') continue;
      for (const b of m.content as LlmContentBlock[]) {
        if (b.type === 'tool_result') index.set(b.toolUseId, b.content);
      }
    }
  }
  return index;
}

/**
 * A stateful interactive DM-Lab session: a live engine + recorder + accumulating transcript that
 * advances ONE turn per `dmLabSubmit`, so you can vibe-test the DM turn-by-turn, piling on context.
 * The persona/scenario/temperature are captured at creation (edit them → start a new session).
 */
export interface DmLabSession {
  scenarioId: string;
  engine: Engine;
  recorder: RecordingProvider;
  composer: SceneComposer;
  realizeScene?: (est: EstablishScene, party: PartyMemberRef[], ctx?: SceneRealizeContext) => Promise<RealizeSceneResult | null>;
  /** Which scene engine this session was created with (surfaced in the UI). */
  sceneEngine: 'modern' | 'fake';
  retriever?: Retriever;
  arcPlanner?: ArcPlanner;
  playbook: string;
  temperature?: number;
  arcTemperature?: number;
  recent: string[];
  turnIndex: number;
  totalCostUsd: number;
  totalLatencyMs: number;
  /** Set when the last turn asked for a roll (the next submit should declare it). */
  pendingRoll?: TurnRollRequest;
  /** Scene the party started in + the party roster (for the UI header). */
  scene: string;
  party: { id: string; name: string }[];
}

/** Build a fresh interactive session (engine state, recorder, captured persona/scenario/temp). */
export function createDmLabSession(deps: DmLabDeps, scenarioId: string): DmLabSession {
  // Generate-mode: a Composer-generated arc supplies the adventure/blueprint/encounters/bestiary, and
  // the party comes from the hand-built roster (deps.party). Authored-mode: the on-disk scenario (or a
  // live-edited override) drives everything, with the scenario's own pregens + bestiary, as before.
  const gen = deps.generatedArc;
  let adventure: GameState['adventure'];
  let startSceneId: string;
  let encounters: GameState['encounters'];
  let bestiary: Record<string, StatBlock>;
  let party: CharacterSheet[];
  let stateScenarioId: string;

  if (gen) {
    adventure = gen.adventure;
    startSceneId = gen.startSceneId;
    encounters = gen.encounters;
    bestiary = gen.bestiary;
    // The (possibly hand-edited) party rides on the bundle; fall back to deps, then a default fighter.
    party = gen.party && gen.party.length ? gen.party : deps.party && deps.party.length ? deps.party : resolveParty([]);
    stateScenarioId = 'generated';
  } else {
    const bundle = loadScenario(scenarioId);
    const scenario = deps.scenarioJson ? parseScenario(deps.scenarioJson, scenarioId) : bundle.scenario;
    adventure = { pitch: scenario.pitch, scenes: Object.fromEntries(scenario.scenes.map((s) => [s.id, { title: s.title, summary: s.summary, exits: s.exits, ...(s.scenePlan ? { scenePlan: s.scenePlan } : {}) }])) };
    encounters = scenario.encounters;
    // Optionally drop the party into a chosen scene (e.g. the undercroft fight) to test it directly.
    startSceneId = deps.startSceneId && scenario.scenes.some((s) => s.id === deps.startSceneId) ? deps.startSceneId : scenario.startSceneId;
    bestiary = Object.fromEntries(bundle.bestiary.map((b) => [b.id, b]));
    party = deps.party && deps.party.length ? deps.party : bundle.pregens;
    stateScenarioId = scenario.id;
  }
  const state = createInitialState({
    sessionId: `dm-lab-${scenarioId}`,
    scenarioId: stateScenarioId,
    startSceneId,
    party,
    ...(adventure ? { adventure } : {}),
    ...(encounters ? { encounters } : {}),
    bestiary,
    itemCatalog: loadItemCatalog(),
  });
  // Pre-prime the architected blueprint so the orchestrator SKIPS the architect step in generate-mode.
  if (gen) state.arc = { blueprint: gen.blueprint, genMeta: gen.genMeta };
  // Prime the Canon Ledger from the generated cast + plants + the PCs' backstories (facts accrue in play).
  // Each PC with a backstory becomes a kind:'pc' canon entity so the DM always knows who they are.
  const pcCards = party
    .filter((p) => p.backstory)
    .map((p): EntityCard => ({ id: p.id, kind: 'pc', name: p.name, notes: p.backstory! }));
  if (gen?.ledger || pcCards.length) {
    state.ledger = {
      entities: {
        ...Object.fromEntries((gen?.ledger?.entities ?? []).map((e) => [e.id, e])),
        ...Object.fromEntries(pcCards.map((c) => [c.id, c])),
      },
      facts: [],
      plants: Object.fromEntries((gen?.ledger?.plants ?? []).map((p) => [p.id, p])),
    };
  }
  // The sceneEngine knob: 'fake' drops the modern realizer so setScene uses the $0 deterministic
  // composer — cheap DM iteration. Default is 'modern': the lab is the test-play surface, so scenes
  // should look like the real thing unless you opt out.
  const sceneEngine: 'modern' | 'fake' = deps.sceneEngine === 'fake' || !deps.realizeScene ? 'fake' : 'modern';
  return {
    scenarioId,
    engine: new Engine(state),
    recorder: new RecordingProvider(deps.llm),
    composer: deps.composer ?? new FakeSceneComposer(),
    sceneEngine,
    ...(sceneEngine === 'modern' && deps.realizeScene ? { realizeScene: deps.realizeScene } : {}),
    ...(deps.retriever ? { retriever: deps.retriever } : {}),
    ...(deps.arcPlanner ? { arcPlanner: deps.arcPlanner } : {}),
    playbook: deps.playbook ?? loadPlaybook(),
    ...(deps.temperature !== undefined ? { temperature: deps.temperature } : {}),
    ...(deps.arcTemperature !== undefined ? { arcTemperature: deps.arcTemperature } : {}),
    recent: [],
    turnIndex: 0,
    totalCostUsd: 0,
    totalLatencyMs: 0,
    scene: startSceneId,
    party: Object.values(state.combatants)
      .filter((c) => c.kind === 'pc')
      .map((c) => ({ id: c.id, name: c.name })),
  };
}

/** Advance the session by ONE turn (a player line, or a declared/auto roll). Mutates the session. */
export async function dmLabSubmit(
  session: DmLabSession,
  input: { say: string; as?: string } | { roll: number; auto?: boolean } | { open: true },
): Promise<DmLabTurn> {
  const { engine, recorder, composer } = session;
  const sliceStart = recorder.exchanges.length;
  const before = snapshot(engine.getState());
  const startedAt = Date.now();

  let turnInput: TurnInput;
  let label: { speaker: string; text: string; kind: DmLabTurn['kind'] };
  if ('open' in input) {
    turnInput = { kind: 'opening' };
    label = { speaker: 'opening', text: '(opening scene)', kind: 'message' };
  } else if ('roll' in input) {
    turnInput = { kind: 'roll', requestId: session.pendingRoll?.id ?? '', total: input.roll };
    label = { speaker: 'roll', text: `🎲 ${input.roll}`, kind: input.auto ? 'auto-roll' : 'roll' };
  } else {
    turnInput = { kind: 'message', speakerId: input.as ?? 'player', text: input.say };
    label = { speaker: input.as ?? 'player', text: input.say, kind: 'message' };
  }

  const result = await runTurn(
    {
      engine,
      llm: recorder,
      ...(session.retriever ? { retriever: session.retriever } : {}),
      composer,
      ...(session.realizeScene ? { realizeScene: session.realizeScene } : {}),
      ...(session.arcPlanner ? { arcPlanner: session.arcPlanner } : {}),
      playbook: session.playbook,
      recentTranscript: session.recent,
      ...(session.temperature !== undefined ? { temperature: session.temperature } : {}),
      ...(session.arcTemperature !== undefined ? { arcTemperature: session.arcTemperature } : {}),
    },
    turnInput,
  );
  const latencyMs = Date.now() - startedAt;
  const after = snapshot(engine.getState());

  const index = buildResultIndex(recorder.exchanges);
  const tools: ToolTrace[] = [];
  for (const ex of recorder.exchanges.slice(sliceStart)) {
    for (const tc of ex.response.toolCalls) tools.push({ name: tc.name, input: tc.input, ...(index.has(tc.id) ? { result: index.get(tc.id)! } : {}) });
  }

  session.turnIndex += 1;
  session.totalCostUsd += result.costUsd;
  session.totalLatencyMs += latencyMs;
  if (result.rollRequest) session.pendingRoll = result.rollRequest;
  else delete session.pendingRoll;
  if (label.speaker !== 'opening') session.recent.push(`${label.speaker}: ${label.text}`); // opening has no player line
  if (result.narration) session.recent.push(`Dungeon Master: ${result.narration}`);

  return {
    index: session.turnIndex,
    speaker: label.speaker,
    input: label.text,
    kind: label.kind,
    narration: result.narration,
    ...(result.rollRequest ? { rollRequest: result.rollRequest } : {}),
    tools,
    diff: diffSnaps(before, after),
    ...(result.sceneChanged ? { sceneChanged: true } : {}),
    ...(result.sceneProvenance ? { sceneProvenance: result.sceneProvenance } : {}),
    ...(result.deltas?.length ? { deltas: result.deltas } : {}),
    model: result.model,
    steps: result.trace.steps,
    costUsd: result.costUsd,
    latencyMs,
  };
}

/** Assemble the Game Director view for the lab's Arc tab: blueprint + brief + per-beat status. */
export function arcView(session: DmLabSession) {
  const st = session.engine.getState();
  const adv = st.adventure;
  const arc = st.arc ?? {};
  const reachable = new Set((arc.brief?.reachable ?? []).map((r) => r.sceneId));
  const beats = adv
    ? Object.entries(adv.scenes).map(([id, s]) => ({
        id,
        title: s.title,
        current: id === st.currentSceneId,
        done: st.flags[`beat:${id}`] === 'done',
        reachable: reachable.has(id),
      }))
    : [];
  const decisions = Object.entries(st.flags).filter(([k]) => k.startsWith('decision:')).map(([k, v]) => ({ key: k.slice(9), value: String(v) }));
  const npcs = Object.entries(st.flags).filter(([k]) => k.startsWith('npc:')).map(([k, v]) => ({ key: k.slice(4), value: String(v) }));
  // Freshness: a generated arc is "stale" once the on-disk composer prompt no longer matches the one
  // it was generated under (the user edited director-composer.md since) — surface it so you can regenerate.
  const genMeta = arc.genMeta ?? null;
  const stale = genMeta ? createHash('sha1').update(loadDirectorComposer()).digest('hex').slice(0, 12) !== genMeta.composerPromptHash : false;
  // Per-beat encounters (resolved monster names + counts) so the lab can show the fights the Director placed.
  const encounters = (st.encounters ?? []).map((e) => ({
    sceneId: e.sceneId,
    monsters: e.monsters.map((m) => ({ name: st.bestiary?.[m.statBlockId]?.name ?? m.statBlockId, count: m.count })),
  }));
  // Canon Ledger (P1): entities (with voice + status), live facts, plants — the live "world bible".
  const L = st.ledger;
  const ledger = L
    ? {
        entities: Object.values(L.entities).map((e) => ({ id: e.id, name: e.name, kind: e.kind, status: e.status ?? 'active', voice: e.voice ?? null, notes: e.notes ?? null })),
        facts: L.facts.filter((f) => !f.supersededBy).map((f) => ({ subject: f.subject, attribute: f.attribute, value: f.value, turn: f.turn })),
        plants: Object.values(L.plants).map((p) => ({ id: p.id, what: p.what, status: p.status })),
      }
    : null;
  return { blueprint: arc.blueprint ?? null, brief: arc.brief ?? null, currentScene: st.currentSceneId, beats, decisions, npcs, genMeta, stale, encounters, ledger };
}

/**
 * Assemble a full, per-PC CHARACTER SHEET view for the Run-view sheet modal — the immutable sheet + live
 * combatant pools + progression/economy + resolved inventory + every engine-DERIVED number. Pure read;
 * the derived values reuse the exact functions the engine uses, so the sheet is a single source of truth
 * and updates live as play progresses (it's rebuilt from state on every turn response).
 */
export function characterSheets(session: DmLabSession) {
  const st = session.engine.getState();
  const catalog = st.itemCatalog ?? {};
  return Object.values(st.combatants)
    .filter((c) => c.kind === 'pc')
    .map((c) => {
      const sheet = st.sheets?.[c.id];
      const cs = st.characters?.[c.id];
      const level = cs?.level ?? sheet?.level ?? 1;
      const prof = deriveProficiencyBonus(level);
      const exh = c.exhaustion;

      const abilities = sheet
        ? ABILITIES.map((a: Ability) => ({
            key: a,
            score: sheet.abilities[a],
            mod: abilityMod(sheet.abilities[a]),
            save: deriveSaveModifier(sheet, cs, a, exh),
            saveProf: sheet.savingThrowProficiencies.includes(a),
          }))
        : [];

      const skills = sheet
        ? (Object.keys(SKILLS) as Skill[]).map((s) => ({
            key: s,
            ability: SKILLS[s],
            mod: deriveSkillModifier(sheet, cs, s, exh),
            tier: sheet.skillExpertise?.includes(s) ? 'expertise' : sheet.skillProficiencies.includes(s) ? 'proficient' : sheet.skillHalfProficiency?.includes(s) ? 'half' : 'none',
          }))
        : [];

      const equipped = cs?.equipped ?? {};
      const slotByInstance = new Map(Object.entries(equipped).filter(([, id]) => !!id).map(([slot, id]) => [id as string, slot]));
      const attuned = new Set(cs?.attunedInstanceIds ?? []);
      const items = (cs?.items ?? []).map((it) => {
        const def = catalog[it.defId];
        return {
          instanceId: it.instanceId,
          name: def?.name ?? it.defId,
          category: def?.category ?? 'item',
          weightLb: def?.weightLb ?? 0,
          qty: it.qty ?? 1,
          equippedSlot: slotByInstance.get(it.instanceId) ?? null,
          attuned: attuned.has(it.instanceId),
          identified: it.identified !== false,
          magic: !!def?.magic,
          ...(def?.charges ? { charges: { remaining: it.chargesRemaining ?? def.charges.max, max: def.charges.max } } : {}),
        };
      });
      const weight = items.reduce((w, i) => w + i.weightLb * (i.qty ?? 1), 0);
      const cap = sheet ? deriveCarry(sheet) : 0;

      const slots = (c.slotsMax ?? [])
        .map((max, lvl) => ({ level: lvl, cur: c.slotsRemaining?.[lvl] ?? 0, max }))
        .filter((s) => s.level >= 1 && s.max > 0);

      const sc = sheet?.spellcasting;
      const spellcasting = sc && sheet
        ? {
            ability: sc.ability,
            saveDc: deriveSpellSaveDc(sheet, cs) ?? sc.spellSaveDc,
            attack: prof + abilityMod(sheet.abilities[sc.ability]),
            preparedMax: deriveSpellsPreparedMax(sheet, cs) ?? null,
            prepared: c.preparedSpells ?? sc.prepared,
            rituals: sc.rituals ?? [],
            cantrips: sc.cantrips,
          }
        : null;

      return {
        id: c.id,
        name: c.name,
        ancestry: sheet?.ancestry ?? '',
        className: sheet?.className ?? '',
        level,
        xp: cs?.xp ?? 0,
        xpNext: level < 20 ? XP_THRESHOLDS[level + 1] ?? null : null,
        xpThis: XP_THRESHOLDS[level] ?? 0,
        hp: { cur: c.currentHitPoints, max: c.maxHitPoints, temp: c.temporaryHitPoints },
        ac: c.armorClass,
        speed: sheet?.speedFt ?? 30,
        prof,
        initiative: c.initiativeBonus ?? 0,
        abilities,
        skills,
        passives: sheet
          ? {
              perception: derivePassive(sheet, cs, 'perception', exh),
              investigation: derivePassive(sheet, cs, 'investigation', exh),
              insight: derivePassive(sheet, cs, 'insight', exh),
            }
          : null,
        conditions: c.conditions,
        exhaustion: c.exhaustion ?? 0,
        inspiration: !!c.inspiration,
        concentration: c.concentratingOn?.spell ?? null,
        hitDice: c.hitDice ?? null,
        slots,
        resources: Object.entries(c.resources ?? {}).map(([k, v]) => ({ id: k, current: v.current, max: v.max, recharge: v.recharge })),
        spellcasting,
        attacks: sheet?.attacks ?? [],
        currency: cs?.currency ?? { cp: 0, sp: 0, gp: 0 },
        carry: { lb: Math.round(weight), cap, over: weight > cap },
        items,
        equipped,
        attunement: { used: attuned.size, max: 3 },
        features: sheet?.features ?? [],
        backstory: sheet?.backstory ?? '',
      };
    });
}

/**
 * Run a scripted session through the real DM and return a full per-turn trace (the batch path,
 * used by the CLI). Built on createDmLabSession + dmLabSubmit. Costs money: one model call per turn.
 */
export async function runDmLab(deps: DmLabDeps, scenarioId: string, script: LabTurn[]): Promise<DmLabResult> {
  const session = createDmLabSession(deps, scenarioId);
  const turns: DmLabTurn[] = [];
  for (let i = 0; i < script.length; i++) {
    const entry = script[i]!;
    if ('roll' in entry) continue; // a stray roll with no pending request — ignore
    turns.push(await dmLabSubmit(session, { say: entry.say, ...(entry.as ? { as: entry.as } : {}) }));
    // Resolve any chain of roll requests before advancing to the next scripted line.
    while (session.pendingRoll) {
      const next = script[i + 1];
      if (next && 'roll' in next) {
        i++;
        turns.push(await dmLabSubmit(session, { roll: next.roll }));
      } else {
        turns.push(await dmLabSubmit(session, { roll: autoRollTotal(session.pendingRoll.expr), auto: true }));
      }
    }
  }
  return { scenario: scenarioId, turns, totalCostUsd: session.totalCostUsd, totalLatencyMs: session.totalLatencyMs };
}

// --- Formatting (shared by the CLI) ---------------------------------------

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

/** Render a DmLabResult as a readable console report. */
export function formatDmLab(result: DmLabResult): string {
  const lines: string[] = [];
  lines.push(`DM Lab — scenario "${result.scenario}" — ${result.turns.length} turn(s)\n`);
  for (const t of result.turns) {
    const meta = `${t.model || '?'} · ${t.steps} step(s) · ${(t.latencyMs / 1000).toFixed(1)}s · $${t.costUsd.toFixed(4)}`;
    const tag = t.kind === 'auto-roll' ? ' (auto-roll)' : '';
    lines.push(`━━━ Turn ${t.index} · ${t.speaker}${tag}: "${truncate(t.input, 80)}"`);
    lines.push(`    [${meta}]`);
    if (t.tools.length) {
      lines.push('    tools:');
      for (const call of t.tools) {
        lines.push(`      • ${call.name}(${truncate(JSON.stringify(call.input), 120)})`);
        if (call.result) lines.push(`        → ${truncate(call.result, 140)}`);
      }
    }
    if (t.rollRequest) lines.push(`    ⏸ roll requested: ${t.rollRequest.expr} — ${t.rollRequest.reason}`);
    if (t.diff.length) lines.push(`    state Δ: ${t.diff.join('  |  ')}`);
    lines.push(`    narration: ${t.narration ? truncate(t.narration, 600) : '(none — paused)'}`);
    lines.push('');
  }
  lines.push(`Total: $${result.totalCostUsd.toFixed(4)} · ${(result.totalLatencyMs / 1000).toFixed(1)}s`);
  return lines.join('\n');
}

// --- Built-in transcripts (exercise the load-bearing DM behaviours) -------

export const DM_LAB_TRANSCRIPTS: Record<string, LabTurn[]> = {
  // Arrival → social read (Insight) → a rules question → barge into the tower.
  default: [
    { as: 'Aldric', say: 'We arrive at the Mistmoor green at dusk and take in the scene.' },
    { as: 'Brakka', say: 'I study Edda closely — is she holding something back? I want to read her.' },
    { roll: 15 },
    { as: 'Pip', say: '(To the DM) Before we go in, how exactly does the grappling rule work?' },
    { as: 'Aldric', say: 'We cross the fen and shove open the gap in the tower wall, weapons ready.' },
  ],
  // Edge cases: an impossible spell, then a hard left-turn away from the plot.
  edges: [
    { as: 'Pip', say: 'I cast Wish to erase the bell-tower from existence.' },
    { as: 'Aldric', say: 'Forget the tower — I want to leave Mistmoor entirely and go fishing for the day.' },
  ],
  // Combat — set the Scene to the encounter scene (tower-undercroft) so startEncounter has monsters.
  // The lab auto-rolls if the DM asks for more rolls than listed, so the exact dice don't have to line up.
  combat: [
    { as: 'Pip', say: 'We burst into the undercroft — I loose an arrow at the nearest goblin!' },
    { roll: 18 },
    { roll: 6 },
    { as: 'Aldric', say: 'I charge the other goblin, longsword swinging.' },
    { roll: 16 },
    { roll: 8 },
  ],
};
