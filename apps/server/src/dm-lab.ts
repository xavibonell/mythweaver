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

import { Engine, createInitialState, diceRange, parseDice } from '@mythweaver/engine';
import {
  createProvider,
  type LlmContentBlock,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from '@mythweaver/llm';
import type { Retriever } from '@mythweaver/rag';
import { FakeSceneComposer, type SceneComposer } from '@mythweaver/scene';
import type { GameState } from '@mythweaver/shared';
import { loadScenario, parseScenario } from './content.js';
import { buildRetriever } from './corpus.js';
import { loadPlaybook } from './prompts.js';
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
  /** DM persona. Defaults to the EDITED prompts/dm-playbook.md (loadPlaybook), so editing the
   *  file + re-running iterates the real persona — not the in-code DEFAULT_DM_PLAYBOOK fallback. */
  playbook?: string;
  /** Raw scenario.json text to use INSTEAD of the on-disk scenario (live editing in the lab). */
  scenarioJson?: string;
  /** Sampling temperature for the DM model (omit to use the provider default). */
  temperature?: number;
  /** Drop the party into a specific scene (e.g. the combat scene) instead of the scenario start. */
  startSceneId?: string;
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
  return { llm, ...(retriever ? { retriever } : {}), composer: new FakeSceneComposer(), ragMode };
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
  conditions: string[];
  downed: boolean;
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
    combatants: Object.values(state.combatants).map((c) => ({
      id: c.id,
      hp: `${c.currentHitPoints}/${c.maxHitPoints}`,
      conditions: [...c.conditions],
      downed: !!c.downed,
    })),
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
    if (!b.downed && a.downed) out.push(`${a.id} DOWNED`);
    if (b.downed && !a.downed) out.push(`${a.id} back up`);
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
 * Run a scripted session through the real DM and return a full per-turn trace.
 * Costs money: each player turn (and roll resume) is a real model call.
 */
export async function runDmLab(deps: DmLabDeps, scenarioId: string, script: LabTurn[]): Promise<DmLabResult> {
  const bundle = loadScenario(scenarioId);
  // Live editing: an override scenario.json replaces the on-disk one for this run (pregens/bestiary stay).
  const scenario = deps.scenarioJson ? parseScenario(deps.scenarioJson, scenarioId) : bundle.scenario;
  const adventure = {
    pitch: scenario.pitch,
    scenes: Object.fromEntries(scenario.scenes.map((s) => [s.id, { title: s.title, summary: s.summary }])),
  };
  // Optionally drop the party into a chosen scene (e.g. the undercroft fight) to test it directly.
  const startSceneId = deps.startSceneId && scenario.scenes.some((s) => s.id === deps.startSceneId) ? deps.startSceneId : scenario.startSceneId;
  const state = createInitialState({
    sessionId: `dm-lab-${scenarioId}`,
    scenarioId: scenario.id,
    startSceneId,
    party: bundle.pregens,
    adventure,
    encounters: scenario.encounters,
    bestiary: Object.fromEntries(bundle.bestiary.map((b) => [b.id, b])),
  });
  const engine = new Engine(state);
  const recorder = new RecordingProvider(deps.llm);
  const composer = deps.composer ?? new FakeSceneComposer();
  const playbook = deps.playbook ?? loadPlaybook(); // the edited persona, re-read each run (hot reload)

  const recent: string[] = [];
  // Each turn keeps the toolUseIds it produced so results (which may arrive a turn later,
  // e.g. a roll verdict) can be backfilled from the global index after the session runs.
  const turns: { turn: DmLabTurn; ids: string[] }[] = [];

  const runOne = async (
    input: TurnInput,
    label: { speaker: string; text: string; kind: DmLabTurn['kind'] },
  ): Promise<TurnResult> => {
    const sliceStart = recorder.exchanges.length;
    const before = snapshot(engine.getState());
    const startedAt = Date.now();
    const result = await runTurn(
      { engine, llm: recorder, retriever: deps.retriever, composer, playbook, recentTranscript: recent, ...(deps.temperature !== undefined ? { temperature: deps.temperature } : {}) },
      input,
    );
    const latencyMs = Date.now() - startedAt;
    const after = snapshot(engine.getState());

    // Tool calls made during this turn's exchanges (results indexed globally below).
    const tools: { name: string; input: Record<string, unknown>; id: string }[] = [];
    for (const ex of recorder.exchanges.slice(sliceStart)) {
      for (const tc of ex.response.toolCalls) tools.push({ name: tc.name, input: tc.input, id: tc.id });
    }

    turns.push({
      ids: tools.map((t) => t.id),
      turn: {
        index: turns.length + 1,
        speaker: label.speaker,
        input: label.text,
        kind: label.kind,
        narration: result.narration,
        ...(result.rollRequest ? { rollRequest: result.rollRequest } : {}),
        tools: tools.map((t) => ({ name: t.name, input: t.input })), // result backfilled after the run
        diff: diffSnaps(before, after),
        model: result.model,
        steps: result.trace.steps,
        costUsd: result.costUsd,
        latencyMs,
      },
    });

    recent.push(`${label.speaker}: ${label.text}`);
    if (result.narration) recent.push(`Dungeon Master: ${result.narration}`);
    return result;
  };

  for (let i = 0; i < script.length; i++) {
    const entry = script[i]!;
    if ('roll' in entry) continue; // a stray roll with no pending request — ignore
    let result = await runOne(
      { kind: 'message', speakerId: entry.as ?? 'player', text: entry.say },
      { speaker: entry.as ?? 'player', text: entry.say, kind: 'message' },
    );
    // Resolve any chain of roll requests before advancing to the next scripted line.
    while (result.rollRequest) {
      const next = script[i + 1];
      let total: number;
      let kind: DmLabTurn['kind'];
      if (next && 'roll' in next) {
        total = next.roll;
        kind = 'roll';
        i++;
      } else {
        total = autoRollTotal(result.rollRequest.expr);
        kind = 'auto-roll';
      }
      result = await runOne(
        { kind: 'roll', requestId: result.rollRequest.id, total },
        { speaker: 'roll', text: `🎲 ${total}`, kind },
      );
    }
  }

  // Backfill each tool's result from the global index (roll verdicts land a turn later).
  const resultIndex = buildResultIndex(recorder.exchanges);
  const finalTurns: DmLabTurn[] = turns.map(({ turn, ids }) => ({
    ...turn,
    tools: turn.tools.map((t, n) => ({ ...t, ...(resultIndex.has(ids[n]!) ? { result: resultIndex.get(ids[n]!) } : {}) })),
  }));

  return {
    scenario: scenarioId,
    turns: finalTurns,
    totalCostUsd: finalTurns.reduce((s, t) => s + t.costUsd, 0),
    totalLatencyMs: finalTurns.reduce((s, t) => s + t.latencyMs, 0),
  };
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
