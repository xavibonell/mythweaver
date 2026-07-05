/**
 * The orchestrator turn-loop (spec: LLM Orchestration & DM Persona).
 *
 * A real bounded agentic loop: assemble context -> call the LLM with the engine
 * exposed as tools -> dispatch tool calls -> feed results back -> repeat until the
 * DM narrates with no tool call (or MAX_STEPS).
 *
 * Physical dice (spec §4.3) suspend the loop: when the DM calls `requestRoll`, we
 * persist the in-flight conversation in `GameState.pendingTurn`, return the roll
 * request to the table, and RESUME on the next turn once the player declares the
 * result — feeding it back as the tool's result.
 *
 * Caching note: the system prompt is the STABLE playbook only (no per-turn state),
 * so the system+tools prefix stays cache-eligible (spec §3). Volatile state travels
 * in the user turn.
 *
 * Persona = the built-in default "inspired-by" style preset (spec §6) — a
 * configurable, swappable prompt. No real person is named or imitated.
 */

import type { Engine } from '@mythweaver/engine';
import {
  estimateCostUsd,
  responseToAssistantMessage,
  type LlmContentBlock,
  type LlmMessage,
  type LlmProvider,
  type TaskClass,
  type ToolDef,
} from '@mythweaver/llm';
import type { Retriever } from '@mythweaver/rag';
import { isEntityId, type ArcBrief, type DamageType, type EstablishScene, type FixtureDecl, type GameState, type NpcDecl, type PartyMemberRef, type PendingTurn, type SceneMap } from '@mythweaver/shared';
import type { ArcPlanner } from './arc-planner.js';
import { CHARACTERS, PROMPT_PROPS, buildSceneMap, type SceneComposer } from '@mythweaver/scene';

// Catalog tag hints surfaced to the DM in the setScene tool, so it declares real art tags
// (the Composer still maps near-misses, but exact tags render best). Internal props (the no-art
// placeholder) are excluded so the DM never picks them.
const FIXTURE_TAG_HINT = PROMPT_PROPS.map((p) => p.tag).join(', ');
const ACTOR_LOOK_HINT = CHARACTERS.map((c) => c.tag).join(', ');
import { NoopTracer, type Tracer } from './tracing.js';

export const DEFAULT_DM_PLAYBOOK = `You are MythWeaver, the Dungeon Master for a Dungeons & Dragons 5e session.

STYLE (a configurable preset):
- Set scenes with vivid, economical sensory detail; give NPCs distinct voices.
- Keep momentum: don't ramble. Most turns end by asking the players what they do.
- Be fair but firm. Rulings are final in the moment.

ABSOLUTE RULES (non-negotiable):
- You are the NARRATOR. You NEVER decide a number or a mechanical outcome yourself.
- For any ability check, saving throw, or attack, call the "requestRoll" tool and wait for the
  player's declared physical-dice result. NEVER invent or assume a roll's result.
- ALWAYS pass the target number to requestRoll: the DC for a check or save, or the target's AC for an
  attack. The engine returns "success": true/false — narrate the engine's verdict; NEVER decide
  success or failure yourself.
- Use the "getState" tool to read authoritative state (HP, scene, combatants) before stating any
  mechanical fact. A snapshot is also provided each turn, but call getState if you need it fresh.
- Use the "lookupRule" tool to check a rule, spell, monster, or option from the sourcebooks before
  adjudicating anything you are unsure of. Prefer cited rules over memory, and mention the source when apt.
- When you need a roll, make "requestRoll" your only tool call for that step.
- If you don't know a rule, say so plainly rather than inventing one.

VISUAL SCENE (the table sees a live top-down map — docs/SCENE-CONTRACTS.md):
- When the party arrives somewhere new, call "setScene" to establish it. Give a stable "locationId"
  like "loc:mistmoor-green", a rich "setting" (terrain, structures, mood), the "biome"
  (village/forest/cave/dungeon) and "timeOfDay", and LIST what is present:
  - "fixtures": notable objects/structures, each { id ("prop:well" / "bldg:hall"), tag, anchor }.
  - "npcs": everyone present, each { id ("npc:edda"), name, look, anchor, visible } — set visible:false
    for anyone hidden/lurking (they are placed but unseen until revealed).
- Anchors are coordinate-free: "center", "north-edge", "waterside", "near:<id>". The game owns exact
  tiles. Reuse the SAME locationId when the party returns — the place is remembered, not rebuilt.`;

const MAX_STEPS = 6;
const MAX_OUTPUT_TOKENS = 700;

const NOOP_TRACER = new NoopTracer();

export type TurnInput =
  | { kind: 'message'; speakerId: string; text: string }
  | { kind: 'roll'; requestId: string; total: number }
  // No player line — asks the DM to deliver the campaign's OPENING narration (session start).
  | { kind: 'opening' };

export interface TurnRollRequest {
  id: string;
  expr: string;
  reason: string;
}

export interface TurnTrace {
  model: string;
  taskClass: TaskClass;
  steps: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number };
  costUsd: number;
  latencyMs: number;
  toolCalls: string[];
}

export interface TurnResult {
  narration: string;
  rollRequest?: TurnRollRequest;
  costUsd: number;
  model: string;
  trace: TurnTrace;
  /** Set on a turn that entered/established a location — client renders `sceneMap`. */
  sceneChanged?: boolean;
  /** The (frozen) map to render this turn. Present only when sceneChanged. */
  sceneMap?: SceneMap;
}

export interface OrchestratorDeps {
  engine: Engine;
  llm: LlmProvider;
  playbook?: string;
  recentTranscript?: string[];
  /** Rules-text retriever (spec §5). When present, the DM gets a `lookupRule` tool. */
  retriever?: Retriever;
  /** Observability sink (tracing). Defaults to no-op. */
  tracer?: Tracer;
  /** Scene Composer for the visual layer (docs/SCENE-CONTRACTS.md). When present, the DM gets `setScene`. */
  composer?: SceneComposer;
  /** LIVE-PLAY modern engine (wire-in part 3): tried FIRST when a NEW location is established. Returns
   *  null to decline (currently everything but settlements) → the classic Composer path runs. Any
   *  failure also falls back — scene generation can never break a turn. */
  realizeScene?: (est: EstablishScene, party: PartyMemberRef[]) => Promise<SceneMap | null>;
  /** Game Director (Phase D / D2). When present, the per-turn STEERING brief is (re)planned on triggers. */
  arcPlanner?: ArcPlanner;
  /** Sampling temperature for the DM model (omit to use the provider default). Used by the DM Lab. */
  temperature?: number;
  /** Sampling temperature for the Game Director's own calls (architect/plan). Falls back to `temperature`. */
  arcTemperature?: number;
  /** Injectable clock for deterministic tests (defaults to Date.now). */
  now?: () => number;
}

export function buildToolDefs(retrieval: boolean, scene: boolean): ToolDef[] {
  const tools: ToolDef[] = [
    {
      name: 'getState',
      description: 'Read the authoritative game state (HP, conditions, scene, combatants). Returns JSON.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'requestRoll',
      description:
        'Ask a player to roll physical dice for a check, save, or attack. Provide the dice expression and the reason. Never invent the result; the player declares it. Make this your only tool call for the step.',
      inputSchema: {
        type: 'object',
        properties: {
          expr: { type: 'string', description: 'Dice expression, e.g. "1d20+5".' },
          reason: { type: 'string', description: 'What the roll is for, e.g. "Athletics check to climb".' },
          dc: { type: 'number', description: 'Target number to beat: the DC for a check or save, or a target AC for an attack. The engine returns whether the roll succeeded.' },
        },
        required: ['expr', 'reason'],
        additionalProperties: false,
      },
    },
  ];
  if (retrieval) {
    tools.push({
      name: 'lookupRule',
      description:
        'Look up a rule, spell, monster, class option, or setting detail from the loaded sourcebooks before adjudicating anything you are unsure of. Returns relevant passages with citations.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look up, e.g. "how grappling works" or "Fireball spell".' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    });
  }
  if (scene) {
    tools.push({
      name: 'setScene',
      description:
        'Establish the visual scene the table sees — a full top-down map. CALL THIS when the party arrives somewhere new. Declare the place semantically (no coordinates): a stable locationId, the setting/biome/time, the notable fixtures, and EVERY NPC present (incl. hidden ones via visible:false). The game generates + freezes the map; reuse the same locationId to return to a place.',
      inputSchema: {
        type: 'object',
        properties: {
          locationId: { type: 'string', description: 'Stable id for this place, e.g. "loc:mistmoor-green". Reuse it to return here.' },
          setting: { type: 'string', description: 'Rich description: terrain + structures + mood.' },
          biome: { type: 'string', enum: ['village', 'forest', 'cave', 'dungeon'] },
          timeOfDay: { type: 'string', enum: ['day', 'dusk', 'night'] },
          fixtures: {
            type: 'array',
            description: 'Notable objects/structures present.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Stable id, e.g. "prop:well" or "bldg:hall".' },
                tag: { type: 'string', description: `What it is. Prefer a catalog tag (rendered exactly): ${FIXTURE_TAG_HINT}. Other words are mapped to the nearest match.` },
                anchor: { type: 'string', description: 'Coordinate-free placement: center | north-edge | waterside | near:<id> | …' },
              },
              required: ['id', 'tag'],
              additionalProperties: false,
            },
          },
          npcs: {
            type: 'array',
            description: 'Everyone present besides the party (the party is added automatically).',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Stable id, e.g. "npc:edda".' },
                name: { type: 'string' },
                look: { type: 'string', description: `Short role/appearance, e.g. "a wary fisherwoman", "an armoured skeleton". Mapped to a sprite (${ACTOR_LOOK_HINT}).` },
                anchor: { type: 'string', description: 'Coordinate-free placement (see fixtures).' },
                visible: { type: 'boolean', description: 'false = present but hidden/lurking (placed, not drawn).' },
              },
              required: ['id', 'name', 'look'],
              additionalProperties: false,
            },
          },
        },
        required: ['setting'],
        additionalProperties: false,
      },
    });
  }
  // Combat tools (engine-authoritative HP/damage/initiative/death). Always available; the DM uses
  // them only in a fight. The engine owns every number — the DM passes ROLLED totals, never invents.
  tools.push(
    {
      name: 'startEncounter',
      description:
        "Begin the authored combat where the party is: spawns the scene's monsters at full HP and rolls initiative. Call ONCE when a fight breaks out (no arguments — the engine knows the current scene). Returns the spawned combatant ids + initiative order.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'applyDamage',
      description:
        'Apply damage to a combatant after a hit. Pass the ROLLED damage total (from a requestRoll), never an invented number. The engine reduces HP and reports whether the target is downed.',
      inputSchema: {
        type: 'object',
        properties: {
          targetId: { type: 'string', description: 'Combatant id, e.g. "npc:goblin-1" or "pc:aldric".' },
          amount: { type: 'number', description: 'The rolled damage total.' },
          type: { type: 'string', description: 'Damage type, e.g. "slashing", "piercing", "fire".' },
        },
        required: ['targetId', 'amount', 'type'],
        additionalProperties: false,
      },
    },
    {
      name: 'heal',
      description: 'Restore hit points to a combatant (e.g. a healing spell). Pass the rolled amount. Healing a creature above 0 ends its dying state.',
      inputSchema: {
        type: 'object',
        properties: {
          targetId: { type: 'string', description: 'Combatant id.' },
          amount: { type: 'number', description: 'The rolled healing amount.' },
        },
        required: ['targetId', 'amount'],
        additionalProperties: false,
      },
    },
    {
      name: 'rollDeathSave',
      description:
        'Roll a death save for a dying player character (at 0 HP), on their turn. The engine rolls the d20 and tracks it (3 successes = stable, 3 failures = dead; nat 20 revives at 1 HP).',
      inputSchema: {
        type: 'object',
        properties: { combatantId: { type: 'string', description: 'The dying PC combatant id.' } },
        required: ['combatantId'],
        additionalProperties: false,
      },
    },
  );
  // Arc / Game-Master steering (D1): move the story by following the players, and remember branch choices.
  tools.push(
    {
      name: 'advanceScene',
      description:
        'Move the party to a new beat/scene WHEN THEY CHOOSE to go there — it must be a reachable exit listed in STEERING. Records the prior beat as done. This steers the arc by following the players; never force it.',
      inputSchema: {
        type: 'object',
        properties: { toSceneId: { type: 'string', description: 'Destination scene id (a reachable exit from STEERING).' } },
        required: ['toSceneId'],
        additionalProperties: false,
      },
    },
    {
      name: 'setArcFlag',
      description:
        'Record a soft arc fact so later turns stay consistent: a branch decision the party made, a beat status, or an NPC standing. The key MUST be namespaced "decision:<x>", "beat:<x>", or "npc:<x>".',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'e.g. "decision:tower-approach", "npc:edda:trust".' },
          value: { type: 'string', description: 'e.g. "stealth", "confessed", "12".' },
        },
        required: ['key', 'value'],
        additionalProperties: false,
      },
    },
  );
  return tools;
}

/** The current frozen map (if the party is in a known location). */
function currentMap(state: GameState): SceneMap | undefined {
  const w = state.world;
  return w && w.currentLocationId ? w.locations[w.currentLocationId] : undefined;
}

/** A compact digest of the current location so the DM narrates from TRUTH, not imagination.
 *  Object-field children (group set) are collapsed to one "group ×N" line so a row of 8 pews reads
 *  as a group, not 8 lines (the DM addresses the group, or a member by its #NN id when needed). */
function sceneDigest(map: SceneMap): string {
  const fix: string[] = [];
  const fixGroups = new Map<string, { n: number; tag: string; zone?: string }>();
  for (const o of map.objects.filter((o) => o.kind !== 'actor')) {
    if (o.group) {
      const g = fixGroups.get(o.group) ?? { n: 0, tag: o.tag, zone: o.zone };
      g.n++;
      fixGroups.set(o.group, g);
    } else fix.push(`${o.id}(${o.zone ?? '?'})`);
  }
  for (const [id, g] of fixGroups) fix.push(`${id} ×${g.n} ${g.tag}(${g.zone ?? '?'})`);
  const npcs: string[] = [];
  const npcGroups = new Map<string, number>();
  for (const o of map.objects.filter((o) => o.kind === 'actor' && o.role !== 'pc')) {
    if (o.group) npcGroups.set(o.group, (npcGroups.get(o.group) ?? 0) + 1);
    else npcs.push(`${o.id} "${o.name ?? ''}"@${o.col},${o.row}${o.visible ? '' : ' [hidden]'}`);
  }
  for (const [id, n] of npcGroups) npcs.push(`${id} ×${n}`);
  const pcs = map.objects.filter((o) => o.role === 'pc').map((o) => `${o.id}@${o.col},${o.row}`);
  return [
    `Location ${map.locationId} — ${map.biome}, ${map.lighting}`,
    `Fixtures: ${fix.join(', ') || 'none'}`,
    `NPCs here: ${npcs.join('; ') || 'none'}`,
    `Party here: ${pcs.join(', ') || 'none'}`,
  ].join('\n');
}

function summarizeState(state: GameState): string {
  const pcs = Object.values(state.combatants)
    .filter((c) => c.kind === 'pc')
    .map(
      (c) =>
        `- ${c.name}: ${c.currentHitPoints}/${c.maxHitPoints} HP, AC ${c.armorClass}` +
        (c.conditions.length ? `, conditions: ${c.conditions.join(', ')}` : ''),
    )
    .join('\n');
  const npcs = Object.values(state.combatants)
    .filter((c) => c.kind === 'npc')
    .map((c) => `- ${c.name} (${c.id}): ${c.currentHitPoints}/${c.maxHitPoints} HP, AC ${c.armorClass}` + (c.downed ? ' [down]' : '') + (c.conditions.length ? `, ${c.conditions.join(', ')}` : ''))
    .join('\n');
  const map = currentMap(state);
  const inCombat = state.combat.active
    ? `yes (round ${state.combat.round}; initiative: ${state.combat.order.join(' > ')})`
    : 'no';
  return [
    `Scene: ${state.currentSceneId}`,
    `Party:\n${pcs || '- (none)'}`,
    ...(npcs ? [`Enemies/NPCs present:\n${npcs}`] : []),
    `In combat: ${inCombat}`,
    ...(map ? [`\n=== MAP (current location, authoritative) ===\n${sceneDigest(map)}`] : []),
  ].join('\n');
}

/** The JSON the getState tool returns to the model. */
function serializeStateForModel(state: GameState): string {
  const map = currentMap(state);
  return JSON.stringify({
    scene: state.currentSceneId,
    inCombat: state.combat.active,
    round: state.combat.round,
    combatants: Object.values(state.combatants).map((c) => ({
      id: c.id,
      name: c.name,
      kind: c.kind,
      hp: `${c.currentHitPoints}/${c.maxHitPoints}`,
      ac: c.armorClass,
      conditions: c.conditions,
    })),
    flags: state.flags,
    // The frozen object_map so the DM references real entity ids + positions (slice 5: deltas).
    ...(map
      ? {
          map: {
            locationId: map.locationId,
            biome: map.biome,
            lighting: map.lighting,
            grid: { cols: map.grid.cols, rows: map.grid.rows },
            objects: map.objects.map((o) => ({ id: o.id, kind: o.kind, ...(o.role ? { role: o.role } : {}), ...(o.name ? { name: o.name } : {}), col: o.col, row: o.row, visible: o.visible })),
          },
        }
      : {}),
  });
}

/** Render the Game Director's brief (D2) as the per-turn STEERING block — offers, never orders. */
function steeringFromBrief(brief: ArcBrief, flags: Record<string, string | number | boolean>): string {
  const beatsDone = Object.keys(flags).filter((k) => k.startsWith('beat:')).map((k) => k.slice(5));
  const decisions = Object.entries(flags).filter(([k]) => k.startsWith('decision:')).map(([k, v]) => `${k.slice(9)}=${v}`);
  const reach = brief.reachable.map((r) => `  - ${r.sceneId} — ${r.hook}`).join('\n');
  return (
    [
      `=== STEERING (Game Director — soft; OFFER these as the fiction allows, never force. advanceScene only when the party goes there) ===`,
      brief.activeBeatIntent ? `Now: ${brief.activeBeatIntent}` : '',
      reach ? `Reachable beats:\n${reach}` : 'Reachable beats: (none — this beat resolves the arc)',
      brief.bridgeNpcs?.length ? `Bridge NPCs available: ${brief.bridgeNpcs.map((n) => `${n.name} (${n.role})`).join('; ')}` : '',
      brief.clocks?.length ? `Pressure: ${brief.clocks.join('; ')}` : '',
      brief.notes ? `Director note: ${brief.notes}` : '',
      beatsDone.length ? `Beats done: ${beatsDone.join(', ')}` : '',
      decisions.length ? `Decisions: ${decisions.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n') + '\n\n'
  );
}

function pickTaskClass(state: GameState): TaskClass {
  return state.combat.active ? 'adjudication' : 'routine';
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'place';
}
/** Deterministic seed from a location id (same place → same ambiance). */
export function seedFor(locationId: string): number {
  let h = 0;
  for (const ch of locationId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h >>> 0;
}

function parseFixtures(raw: unknown): FixtureDecl[] {
  if (!Array.isArray(raw)) return [];
  const out: FixtureDecl[] = [];
  let n = 0;
  for (const o of raw) {
    if (!o || typeof o !== 'object') continue;
    const r = o as Record<string, unknown>;
    const tag = typeof r.tag === 'string' ? r.tag : '';
    if (!tag) continue;
    let id = typeof r.id === 'string' && isEntityId(r.id) && /^(bldg|prop):/.test(r.id) ? r.id : '';
    if (!id) id = `prop:${slug(tag)}-${n}`;
    out.push({ id, kind: id.startsWith('bldg:') ? 'fixture' : 'prop', tag, ...(typeof r.anchor === 'string' ? { anchor: r.anchor } : {}) });
    n++;
  }
  return out;
}

function parseNpcs(raw: unknown): NpcDecl[] {
  if (!Array.isArray(raw)) return [];
  const out: NpcDecl[] = [];
  let n = 0;
  for (const o of raw) {
    if (!o || typeof o !== 'object') continue;
    const r = o as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name.slice(0, 60) : '';
    if (!name) continue;
    let id = typeof r.id === 'string' && isEntityId(r.id) && r.id.startsWith('npc:') ? r.id : '';
    if (!id) id = `npc:${slug(name)}-${n}`;
    const look = typeof r.look === 'string' ? r.look : typeof r.role === 'string' ? (r.role as string) : name;
    out.push({ id, name, look, visible: typeof r.visible === 'boolean' ? r.visible : true, ...(typeof r.anchor === 'string' ? { anchor: r.anchor } : {}) });
    n++;
  }
  return out;
}

/** Coerce the DM's setScene tool input into a well-formed EstablishScene (the Composer normalizes further). */
export function parseEstablish(input: Record<string, unknown>, state: GameState): EstablishScene {
  const setting = typeof input.setting === 'string' && input.setting.trim() ? input.setting : 'a quiet, dim place';
  const biome = typeof input.biome === 'string' ? input.biome : 'village';
  const tod = input.timeOfDay;
  const timeOfDay = tod === 'day' || tod === 'dusk' || tod === 'night' ? tod : 'day';
  let locationId = typeof input.locationId === 'string' && /^loc:[a-z0-9-]+$/.test(input.locationId) ? input.locationId : '';
  if (!locationId) {
    locationId = `loc:${slug(setting)}`;
    if (!/^loc:[a-z0-9-]+$/.test(locationId)) locationId = `loc:place-${Object.keys(state.world?.locations ?? {}).length}`;
  }
  return { locationId, brief: { setting, biome, timeOfDay }, fixtures: parseFixtures(input.fixtures), npcs: parseNpcs(input.npcs) };
}

export async function runTurn(deps: OrchestratorDeps, input: TurnInput): Promise<TurnResult> {
  const { engine, llm } = deps;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const playbook = deps.playbook ?? DEFAULT_DM_PLAYBOOK;
  const tools = buildToolDefs(Boolean(deps.retriever), Boolean(deps.composer));
  const state = engine.getState();

  let messages: LlmMessage[];
  let inTok = 0;
  let outTok = 0;
  let cacheReadTok = 0;
  let costUsd = 0;
  let lastModel = '';
  const toolCallLog: string[] = [];
  // Visual-layer transition this turn (docs/SCENE-CONTRACTS.md).
  let sceneChanged = false; // a setScene established/entered a location
  let sceneMap: SceneMap | undefined; // the frozen map to render

  const span = (deps.tracer ?? NOOP_TRACER).startTurn({
    sessionId: state.sessionId,
    speaker: input.kind === 'message' ? input.speakerId : input.kind === 'roll' ? 'roll' : 'opening',
    input: input.kind === 'message' ? input.text : input.kind === 'roll' ? `declared roll ${input.total}` : 'session start',
  });
  const finish = (result: TurnResult): TurnResult => {
    span.end({
      narration: result.narration,
      costUsd: result.costUsd,
      model: result.model,
      latencyMs: now() - startedAt,
      toolCalls: toolCallLog,
    });
    return result;
  };

  if (input.kind === 'roll') {
    const pending = state.pendingTurn as PendingTurn | undefined;
    if (!pending) throw new Error('No pending roll to resolve for this session.');
    // Rehydrate the roll request (the engine's pending map is in-memory; this turn
    // may resume on a fresh Engine after save/resume — spec §4.3).
    engine.registerRoll({
      id: pending.rollRequestId,
      expr: pending.rollExpr,
      reason: pending.rollReason,
      ...(pending.rollDc !== undefined ? { dc: pending.rollDc } : {}),
    });
    const result = engine.submitRoll(pending.rollRequestId, input.total);
    if (!result.accepted) {
      // Implausible declaration (spec §4.3): keep the turn paused and re-ask.
      return finish({
        narration: result.message ?? 'That roll is outside the possible range — please re-read your dice.',
        rollRequest: { id: pending.rollRequestId, expr: pending.rollExpr, reason: pending.rollReason },
        costUsd: 0,
        model: lastModel,
        trace: emptyTrace(now() - startedAt),
      });
    }
    messages = (pending.history as LlmMessage[]).slice();
    const toolResults: LlmContentBlock[] = [
      ...pending.resolvedToolResults.map((r) => ({ type: 'tool_result' as const, toolUseId: r.toolUseId, content: r.content })),
      { type: 'tool_result', toolUseId: pending.rollToolUseId, content: JSON.stringify(result) },
    ];
    messages.push({ role: 'user', content: toolResults });
    state.pendingTurn = undefined;
  } else {
    if (input.kind === 'message') engine.record('player', input.text, { speakerId: input.speakerId });
    const recent = (deps.recentTranscript ?? []).slice(-12).join('\n');
    const adv = state.adventure;
    const scene = adv?.scenes[state.currentSceneId];
    const gmBlock = adv
      ? `=== ADVENTURE (GM guidance — run this scene; reveal it through play, don't read aloud verbatim) ===\n` +
        `Premise: ${adv.pitch}\nCurrent scene — ${scene?.title ?? state.currentSceneId}: ${scene?.summary ?? ''}\n\n`
      : '';
    // Game Director (D2): re-plan the steering brief on a high-signal trigger (scene change, or a new
    // decision/NPC-standing flag, or no brief yet), then steer from it. Runs inline; planner cost joins
    // the turn. NOTE: this is in the message branch only — an advanceScene/setArcFlag during a roll
    // resume isn't reflected until the next message turn (roll turns emit no STEERING; harmless).
    if (deps.arcPlanner && adv) {
      const arc = (state.arc ??= {});
      const pcs = Object.values(state.combatants).filter((c) => c.kind === 'pc').map((c) => ({ name: c.name }));
      const directorTemp = deps.arcTemperature ?? deps.temperature; // Director temp (independent), else the DM's
      const planInput = { adventure: adv, currentSceneId: state.currentSceneId, flags: state.flags, recentTranscript: deps.recentTranscript ?? [], party: pcs, ...(directorTemp !== undefined ? { temperature: directorTemp } : {}) };
      // Architect the campaign arc once (the north star); all steering anchors to its intended ending.
      if (!arc.blueprint) {
        try {
          const { blueprint, costUsd: bpCost } = await deps.arcPlanner.architect(planInput);
          arc.blueprint = blueprint;
          costUsd += bpCost;
          toolCallLog.push('arcArchitect');
          span.event('arcArchitect');
        } catch (err) {
          span.event('arcArchitect.error', { message: String(err) });
        }
      }
      const decisionCount = Object.keys(state.flags).filter((k) => k.startsWith('decision:')).length;
      const npcCount = Object.keys(state.flags).filter((k) => k.startsWith('npc:')).length;
      const due =
        !arc.brief ||
        arc.plannedForScene !== state.currentSceneId ||
        arc.plannedDecisionCount !== decisionCount ||
        arc.plannedNpcCount !== npcCount;
      if (due) {
        try {
          const { brief, costUsd: planCost } = await deps.arcPlanner.plan({ ...planInput, ...(arc.blueprint ? { blueprint: arc.blueprint } : {}) });
          arc.brief = brief;
          arc.plannedForScene = state.currentSceneId;
          arc.plannedDecisionCount = decisionCount;
          arc.plannedNpcCount = npcCount;
          costUsd += planCost;
          toolCallLog.push('arcPlanner');
          span.event('arcPlanner');
        } catch (err) {
          span.event('arcPlanner.error', { message: String(err) }); // keep the prior brief; never break the turn
        }
      }
    }
    // STEERING: the Director's brief (D2) when present, else the static D1 fallback (reachable exits).
    let steering = '';
    if (state.arc?.brief) {
      steering = steeringFromBrief(state.arc.brief, state.flags);
    } else if (adv) {
      const exits = (scene?.exits ?? []).map((id) => (adv.scenes[id] ? `${id} ("${adv.scenes[id].title}")` : id));
      const beatsDone = Object.keys(state.flags).filter((k) => k.startsWith('beat:')).map((k) => k.slice(5));
      const decisions = Object.entries(state.flags).filter(([k]) => k.startsWith('decision:')).map(([k, v]) => `${k.slice(9)}=${v}`);
      steering =
        `=== STEERING (soft — OFFER these as the fiction allows; never force. advanceScene only when the party goes there) ===\n` +
        `Reachable beats from here: ${exits.join(', ') || '(none — this beat resolves the arc)'}\n` +
        (beatsDone.length ? `Beats done: ${beatsDone.join(', ')}\n` : '') +
        (decisions.length ? `Decisions so far: ${decisions.join(', ')}\n` : '') +
        `\n`;
    }
    messages = [
      {
        role: 'user',
        content:
          gmBlock +
          steering +
          `=== CURRENT STATE (authoritative; from the engine) ===\n${summarizeState(state)}\n\n` +
          (recent ? `=== RECENT ===\n${recent}\n\n` : '') +
          (input.kind === 'opening'
            ? `=== SESSION START — OPENING NARRATION ===\nThe session is beginning. Deliver the OPENING: vividly establish where the party is, the immediate situation and what's at stake, and what they can see/sense right now — then end by asking what they do. If a concrete location is established, call setScene. Do NOT request rolls, resolve actions, or advance scenes yet.`
            : `${input.speakerId}: ${input.text}`),
      },
    ];
  }

  let steps = 0;
  for (steps = 1; steps <= MAX_STEPS; steps++) {
    const res = await llm.complete({ system: playbook, messages, tools, taskClass: pickTaskClass(state), maxTokens: MAX_OUTPUT_TOKENS, ...(deps.temperature !== undefined ? { temperature: deps.temperature } : {}) });
    inTok += res.usage.inputTokens;
    outTok += res.usage.outputTokens;
    cacheReadTok += res.usage.cacheReadInputTokens ?? 0;
    costUsd += estimateCostUsd(res.model, res.usage.inputTokens, res.usage.outputTokens);
    lastModel = res.model;
    span.generation({
      name: `step-${steps}`,
      model: res.model,
      input: messages,
      output: res.text,
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      costUsd: estimateCostUsd(res.model, res.usage.inputTokens, res.usage.outputTokens),
    });
    messages.push(responseToAssistantMessage(res));

    if (res.toolCalls.length === 0) {
      if (res.text) engine.record('narration', res.text);
      return finish({ narration: res.text, costUsd, model: lastModel, trace: makeTrace(), ...sceneDelta() });
    }

    // Dispatch tool calls: resolve engine-immediate ones; suspend on a roll request.
    const resolved: { toolUseId: string; content: string }[] = [];
    let roll: { toolUseId: string; id: string; expr: string; reason: string; dc?: number } | undefined;
    for (const tc of res.toolCalls) {
      toolCallLog.push(tc.name);
      span.event(`tool:${tc.name}`);
      if (tc.name === 'requestRoll' && !roll) {
        const expr = typeof tc.input.expr === 'string' ? tc.input.expr : '1d20';
        const reason = typeof tc.input.reason === 'string' ? tc.input.reason : 'check';
        const dc = typeof tc.input.dc === 'number' ? tc.input.dc : undefined;
        const rr = engine.requestRoll({ expr, reason, ...(dc !== undefined ? { dc } : {}) });
        roll = { toolUseId: tc.id, id: rr.id, expr: rr.expr, reason: rr.reason, ...(dc !== undefined ? { dc } : {}) };
      } else if (tc.name === 'getState') {
        resolved.push({ toolUseId: tc.id, content: serializeStateForModel(engine.getState()) });
      } else if (tc.name === 'lookupRule' && deps.retriever) {
        const q = typeof tc.input.query === 'string' ? tc.input.query : '';
        let content: string;
        try {
          const hits = q ? await deps.retriever.retrieve(q, 4) : [];
          content = hits.length
            ? hits.map((h) => `[${h.source}] ${h.text}`).join('\n\n---\n\n')
            : 'No matching rules found in the corpus.';
        } catch {
          content = 'Rule lookup is unavailable right now.';
        }
        resolved.push({ toolUseId: tc.id, content });
      } else if (tc.name === 'setScene' && deps.composer) {
        const est = parseEstablish(tc.input as Record<string, unknown>, state);
        try {
          const world = (state.world ??= { currentLocationId: null, locations: {}, links: [] });
          const existed = !!world.locations[est.locationId];
          let map = world.locations[est.locationId];
          if (!map) {
            // First visit — the MODERN engine gets first refusal (settlements → the proven story path),
            // the classic Composer + Cartographer is the decline/failure fallback — then FREEZE.
            const party = Object.values(state.combatants)
              .filter((c) => c.kind === 'pc')
              .map((c) => ({ id: c.id, spriteTag: c.spriteTag ?? 'knight', name: c.name }));
            if (deps.realizeScene) {
              try { map = (await deps.realizeScene(est, party)) ?? undefined; } catch { map = undefined; /* modern engine failed → classic path below */ }
            }
            if (!map) {
              const comp = await deps.composer.compose({ establish: est, party, seed: seedFor(est.locationId) });
              map = buildSceneMap(comp);
            }
            world.locations[est.locationId] = map;
            if (world.currentLocationId && world.currentLocationId !== est.locationId) world.links.push({ from: world.currentLocationId, to: est.locationId });
          }
          world.currentLocationId = est.locationId;
          sceneChanged = true;
          sceneMap = map;
          resolved.push({
            toolUseId: tc.id,
            content: `Scene ${existed ? 'reused' : 'set'}: ${map.biome} (${map.lighting}), ${map.grid.cols}x${map.grid.rows}. Present: ${map.objects.filter((o) => o.visible).map((o) => o.id).join(', ')}.`,
          });
        } catch {
          resolved.push({ toolUseId: tc.id, content: 'Scene setup failed; continue narrating.' });
        }
      } else if (tc.name === 'startEncounter') {
        try {
          const r = engine.startEncounter(); // engine resolves the encounter from the current scene
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ started: true, ...r }) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ started: false, error: (e as Error).message }) });
        }
      } else if (tc.name === 'applyDamage') {
        try {
          const amount = Number(tc.input.amount);
          const r = engine.applyDamage({ targetId: String(tc.input.targetId ?? ''), amount: Number.isFinite(amount) ? amount : 0, type: String(tc.input.type ?? 'bludgeoning') as DamageType });
          resolved.push({ toolUseId: tc.id, content: JSON.stringify(r) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: (e as Error).message }) });
        }
      } else if (tc.name === 'heal') {
        try {
          const amount = Number(tc.input.amount);
          const r = engine.heal({ targetId: String(tc.input.targetId ?? ''), amount: Number.isFinite(amount) ? amount : 0 });
          resolved.push({ toolUseId: tc.id, content: JSON.stringify(r) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: (e as Error).message }) });
        }
      } else if (tc.name === 'rollDeathSave') {
        try {
          const r = engine.rollDeathSave(String(tc.input.combatantId ?? ''));
          resolved.push({ toolUseId: tc.id, content: JSON.stringify(r) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: (e as Error).message }) });
        }
      } else if (tc.name === 'advanceScene') {
        try {
          const r = engine.advanceScene(String(tc.input.toSceneId ?? ''));
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ advanced: true, ...r }) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ advanced: false, error: (e as Error).message }) });
        }
      } else if (tc.name === 'setArcFlag') {
        try {
          engine.setArcFlag(String(tc.input.key ?? ''), typeof tc.input.value === 'string' ? tc.input.value : String(tc.input.value));
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ ok: true }) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: (e as Error).message }) });
        }
      } else {
        resolved.push({ toolUseId: tc.id, content: `Unknown tool: ${tc.name}` });
      }
    }

    if (roll) {
      if (res.text) engine.record('narration', res.text);
      state.pendingTurn = {
        rollRequestId: roll.id,
        rollToolUseId: roll.toolUseId,
        rollExpr: roll.expr,
        rollReason: roll.reason,
        ...(roll.dc !== undefined ? { rollDc: roll.dc } : {}),
        resolvedToolResults: resolved,
        history: messages,
      };
      return finish({
        narration: res.text,
        rollRequest: { id: roll.id, expr: roll.expr, reason: roll.reason },
        costUsd,
        model: lastModel,
        trace: makeTrace(),
        ...sceneDelta(),
      });
    }

    messages.push({
      role: 'user',
      content: resolved.map((r) => ({ type: 'tool_result' as const, toolUseId: r.toolUseId, content: r.content })),
    });
  }

  // Loop budget exhausted — close the turn gracefully rather than hang.
  const fallback = 'The DM pauses, gathering the threads of the scene. "What do you do?"';
  engine.record('narration', fallback);
  return finish({ narration: fallback, costUsd, model: lastModel, trace: makeTrace(), ...sceneDelta() });

  function sceneDelta(): { sceneChanged?: boolean; sceneMap?: SceneMap } {
    return sceneChanged ? { sceneChanged: true, ...(sceneMap ? { sceneMap } : {}) } : {};
  }

  function makeTrace(): TurnTrace {
    return {
      model: lastModel,
      taskClass: pickTaskClass(state),
      steps,
      usage: { inputTokens: inTok, outputTokens: outTok, cacheReadInputTokens: cacheReadTok },
      costUsd,
      latencyMs: now() - startedAt,
      toolCalls: toolCallLog,
    };
  }
}

function emptyTrace(latencyMs: number): TurnTrace {
  return {
    model: '',
    taskClass: 'routine',
    steps: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
    costUsd: 0,
    latencyMs,
    toolCalls: [],
  };
}
