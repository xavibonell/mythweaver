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

import { deriveProficiencyBonus, derivePassive, deriveSpellSaveDc, deriveSpellsPreparedMax, type Engine } from '@mythweaver/engine';
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
import { ABILITIES, SKILLS, isEntityId, type Ability, type ArcBrief, type CharacterSheet, type CharacterState, type Combatant, type DamageType, type EntityCard, type EstablishScene, type FixtureDecl, type GameState, type ItemDef, type NpcDecl, type PartyMemberRef, type PendingTurn, type Poi, type PoiKind, type RealizeSceneResult, type SceneDelta, type SceneMap, type SceneProvenance, type SceneRealizeContext, type Skill } from '@mythweaver/shared';
import type { ArcPlanner } from './arc-planner.js';
import { CHARACTERS, PROMPT_PROPS, buildSceneMap, lookToSprite, type SceneComposer } from '@mythweaver/scene';

// Catalog tag hints surfaced to the DM in the setScene tool, so it declares real art tags
// (the Composer still maps near-misses, but exact tags render best). Internal props (the no-art
// placeholder) are excluded so the DM never picks them.
const FIXTURE_TAG_HINT = PROMPT_PROPS.map((p) => p.tag).join(', ');
const ACTOR_LOOK_HINT = CHARACTERS.map((c) => c.tag).join(', ');
import { NoopTracer, type Tracer } from './tracing.js';
import { spatialIndex, distanceFt, whereIs, findPath, hasLineOfSight, travelTime, type SpatialIndex } from '@mythweaver/engine';
import type { ExemplarRetriever } from './exemplar-corpus.js';
import type { ExemplarMoveType } from './exemplar-ingest.js';

export const DEFAULT_DM_PLAYBOOK = `You are MythWeaver, the Dungeon Master for a Dungeons & Dragons 5e session.

STYLE (a configurable preset):
- Set scenes with vivid, economical sensory detail; give NPCs distinct voices.
- Keep momentum: don't ramble. Most turns end by asking the players what they do.
- Be fair but firm. Rulings are final in the moment.
- A "STYLE EXEMPLARS" block may appear in the turn context: real-DM beats for THIS kind of moment.
  Match their cadence, rhythm, and length — a terse answer stays terse, an arrival earns its length.
  NEVER reuse their names, places, or plot; they are voice, not content, and never rules.

ABSOLUTE RULES (non-negotiable):
- You are the NARRATOR. You NEVER decide a number or a mechanical outcome yourself.
- For any ability check, saving throw, or attack, call the "requestRoll" tool and wait for the
  player's declared physical-dice result. NEVER invent or assume a roll's result.
- ALWAYS pass the target number to requestRoll: the DC for a check or save, or the target's AC for an
  attack. The engine returns "success": true/false — narrate the engine's verdict; NEVER decide
  success or failure yourself.
- For a CHARACTER's ability check or saving throw, pass "combatantId" + "ability" (add "skill" for a
  skill check, or "save": true for a save) with expr "1d20" — the engine adds that character's own bonus
  (proficiency / expertise / exhaustion). Do NOT bake the bonus into the expression yourself. getState
  lists each PC's passive Perception/Investigation/Insight + spell save DC for anything you judge WITHOUT
  a roll.
- Use the "getState" tool to read authoritative state (HP, scene, combatants) before stating any
  mechanical fact. A snapshot is also provided each turn, but call getState if you need it fresh.
- Use the "lookupRule" tool to check a rule, spell, monster, or option from the sourcebooks before
  adjudicating anything you are unsure of. Prefer cited rules over memory, and mention the source when apt.
- When you need a roll, make "requestRoll" your only tool call for that step.
- If you don't know a rule, say so plainly rather than inventing one.

VISUAL SCENE (the table sees a live top-down map — docs/SCENE-CONTRACTS.md):
- When the party arrives somewhere new, call "setScene" to establish it. Give a stable "locationId"
  like "loc:mistmoor-green", a rich "setting" (terrain, structures, mood), the "kind"
  (settlement/interior/wild — ALWAYS declare it; it decides the layout family), a "mood" line
  (atmosphere/weather in plain words — it drives the lighting), the "biome"
  (village/forest/cave/dungeon) and "timeOfDay", and LIST what is present:
  - "fixtures": notable objects/structures, each { id ("prop:well" / "bldg:hall"), tag, anchor }.
  - "npcs": everyone present, each { id ("npc:edda"), name, look, anchor, visible } — set visible:false
    for anyone hidden/lurking (they are placed but unseen until revealed).
- Anchors are coordinate-free: "center", "north-edge", "waterside", "near:<id>". The game owns exact
  tiles. Reuse the SAME locationId when the party returns — the place is remembered, not rebuilt.
- When the ADVENTURE block shows a "Scene look", HONOR it: your setScene setting/kind/mood/fixtures
  should realize that designed look (it also feeds the map generator directly — stay consistent).
- When your narration MOVES the world — someone walks somewhere, appears, vanishes, is revealed, or
  an object's state flips — mirror it with ONE "updateScene" call (batch every change; ids from the
  scene). The engine owns exact tiles: it snaps targets to free ground and REFUSES impossible moves —
  narrate its verdict. Movement only; location changes stay setScene, mechanics stay the dice.
- NEVER call setScene for movement WITHIN the current place — crossing the green, approaching a
  building, stepping to an NPC is updateScene ({op:"move", id:"pc:...", to:"near:bldg:..."}).
  setScene is ONLY for a genuinely DIFFERENT location (leaving town for the mine, entering a
  building's interior, descending into the crypt).

CANON (keep the world consistent):
- A "CANON" block may appear in the turn context — established truth (named NPCs + their voice/status,
  facts learned, items held). Treat it as real and NEVER contradict it. If the players seek a CANON
  NPC, it IS that NPC — voice them with their established tic/want/fear; never invent a stand-in.
- Call "upsertNpc" the first time a named NPC speaks/acts (id, name, tic, want, fear; update status —
  dead/gone are permanent). Call "recordFact" when the party gains an item, makes a promise, or learns
  something load-bearing. Invent freely when it isn't established — then record it so it becomes canon.

RESOURCES & REST (the engine tracks every pool — the party's HP snapshot shows what's left):
- When a caster casts a LEVELLED spell, call "spendResource" (resource:"slot", the slot level). For a
  class feature with a pool (ki, rage, channel divinity), call "spendResource" with that pool name. The
  engine refuses if it's empty — respect that; a character can't use what they've spent.
- CONCENTRATION: when a caster casts a spell that needs concentration (Bless, Hold Person, Hex, Haste…),
  call "startConcentration". If they later take damage while concentrating, "applyDamage" returns a
  Con-save DC — "requestRoll" that save; on a FAILURE call "breakConcentration" (the spell ends). A caster
  holds only ONE concentration spell at a time.
- RITUALS: when a caster casts a ritual-tagged spell as a ritual (Detect Magic, Identify…), call
  "castRitual" — it spends NO slot (getState lists each caster's rituals). On a long rest, a prepared
  caster may re-prepare via "prepareSpells" (the engine enforces how many they can ready).
- When the party takes a SHORT rest, call "shortRest" per character; to heal, requestRoll their hit dice
  and pass the declared total + how many dice they spent. When they take a LONG rest, call "longRest"
  (no args = the whole party) — it restores HP, spell slots, and features. Spell slots ONLY come back on
  a long rest, so track them across the day.
- Reward great play with "grantInspiration"; a player may later spend it ("spendInspiration") for
  advantage. Use "setExhaustion" when they push past their limits.

PROGRESSION (the engine owns levels + XP):
- Award XP after a real challenge with "awardXp" — the engine tells you when a level-up is available.
  It NEVER auto-levels; you choose when (usually on a long rest). Then call "levelUp" and the engine
  raises HP/hit dice/proficiency and flags any Ability Score Improvement / feat for you to narrate.
- For a milestone campaign (no XP tracking), skip awardXp and call "setMilestoneLevel" at story beats.
  Use one scheme or the other, not both.

GEAR & GOLD (the engine owns coins, items, and AC — read them from getState, which lists each PC's
items with their instanceIds, their coin purse, and a "shop" of buyable ids + prices):
- Shops: use "buyItem" (the engine makes change and refuses if they can't afford it) and "sellItem"
  (half value). Hand out loot with "addItem"; remove used/lost items with "removeItem".
- Equipment: "equipItem" (by the item's instanceId) fills the slot and recomputes AC — narrate from the
  new AC, never invent it. Magic items often need "attuneItem" (the engine enforces the limit of 3 and
  that the item is identified first); an unidentified magic item must be "identifyItem"-ed before it works.
- Death & revival: heal NEVER works on a dead character. Only "revive" (a Revivify/Raise Dead effect)
  brings them back.

POINTS OF INTEREST & SECRETS (you know the secret; the players don't until they find it):
- When you set a scene, plant the interactive things the story hides — a chest behind the roots, a loose
  flagstone, a secret cellar door — with "placePoi": an id, a "look", where it is ("anchor"), and for a
  hidden one a "discoverDc" (the Perception/Investigation DC to spot it). For a container give "contents"
  (catalog item ids + gold); for a passage give "leadsTo" (a "loc:…" place, or a scene id).
- Finding it: the party searches, or you "requestRoll" a Perception/Investigation check vs the discoverDc —
  on success call "discoverPoi" (the engine also auto-reveals anything a character's passive Perception
  already beats). Then "searchPoi" to describe what's inside and "lootPoi" to hand the contents to a
  character (they land on their sheet; it's idempotent — a looted chest is empty).
- NEVER invent loot or a hidden door on the spot — "placePoi" it first, THEN let the players discover it.
  Your state block lists every POI here with its DC + contents; the players never see that.`;

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
  /** How the scene came to be (engine, briefs, mood chain, program + net injections). Present only
   *  when sceneChanged. Response-only — never persisted into the state blob. */
  sceneProvenance?: SceneProvenance;
  /** APPLIED scene deltas this turn (updateScene + combat sync), moves/spawns normalized to concrete
   *  tiles — the client tweens these instead of re-rendering. The map itself is already mutated. */
  deltas?: SceneDelta[];
  /** An arc beat transition landed this turn (advanceScene) — the client shows a title card. */
  beat?: { from: string; to: string; title?: string; outcome?: 'resolved' | 'fled' | 'done' };
  /** Style exemplars injected this turn (Technique B) — for the lab trace + session de-dup. */
  exemplars?: { id: string; moveType: string; source: string }[];
  /** Map-object ids the narration MENTIONS this turn (names + story-prop words) — the live table
   *  pulses them so players can connect the DM's nouns to pixels ("where is Mother Sedge?"). */
  mentions?: string[];
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
   *  null to decline → the classic Composer path runs. Any failure also falls back — scene generation
   *  can never break a turn. `ctx` carries the campaign fiction (premise/beat/plan) the tool call can't. */
  realizeScene?: (est: EstablishScene, party: PartyMemberRef[], ctx?: SceneRealizeContext) => Promise<RealizeSceneResult | null>;
  /** Game Director (Phase D / D2). When present, the per-turn STEERING brief is (re)planned on triggers. */
  arcPlanner?: ArcPlanner;
  /** Style-exemplar retriever (Technique B): real-DM beats injected per turn so the narration keeps a
   *  human table rhythm. VOICE only — never rules; failure to retrieve never breaks a turn. */
  exemplars?: ExemplarRetriever;
  /** Exemplar ids used in recent turns (the session tracks them) — suppressed to avoid repetition. */
  excludeExemplarIds?: string[];
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
        'Ask a player to roll physical dice for a check, save, or attack. For a CHARACTER\'s ability check or saving throw, pass "combatantId" + "ability" (add "skill" for a skill check, or "save": true for a save) with expr "1d20" — the ENGINE adds that character\'s bonus (proficiency / expertise / exhaustion), so you never invent it. For anything else (damage, a monster, a flat roll) give the full "expr". Always pass "dc"; the engine returns whether it succeeded. Never invent the result; the player declares it. Make this your only tool call for the step.',
      inputSchema: {
        type: 'object',
        properties: {
          expr: { type: 'string', description: 'Dice expression: "1d20" for a character check/save (the engine adds the bonus), or a raw roll like "1d8+3".' },
          reason: { type: 'string', description: 'What the roll is for, e.g. "Athletics check to climb".' },
          dc: { type: 'number', description: 'Target number to beat: the DC for a check/save, or a target AC for an attack.' },
          combatantId: { type: 'string', description: 'The character rolling — set this WITH "ability" to have the engine supply the check/save bonus.' },
          ability: { type: 'string', enum: ['str', 'dex', 'con', 'int', 'wis', 'cha'], description: 'The governing ability for the check/save.' },
          skill: { type: 'string', description: 'The skill for a skill check, e.g. "athletics", "perception", "stealth" (omit for a raw ability check).' },
          save: { type: 'boolean', description: 'true if this is a saving throw (uses the save bonus rather than a check bonus).' },
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
          kind: { type: 'string', enum: ['settlement', 'interior', 'wild'], description: 'Structural kind — settlement (buildings + streets), interior (an enclosed space: dungeon, cave, crypt, building interior), wild (open nature). ALWAYS declare it; it decides the layout family.' },
          mood: { type: 'string', description: 'Atmosphere/weather in plain words — e.g. "grim predawn fog", "festive noon", "moonlit and dead quiet". Drives the scene\'s lighting.' },
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
                anchor: { type: 'string', description: 'The character\'s STATION — where the fiction posts them: "near:forge", "near:well", "in:inn". GIVE ONE to every NPC with a post (the smith at his forge, the innkeep at her inn); the map places them THERE, and your narration must match. Omit only for wanderers.' },
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
    tools.push({
      name: 'updateScene',
      description:
        'Mirror CHANGES on the live map when your narration moves the world: someone walks somewhere, appears, vanishes, is revealed, or an object\'s state flips. ONE call per turn with every change batched. The engine owns exact tiles — it snaps targets to free ground and REFUSES impossible ones (narrate its verdict). Use ids from the scene (the setScene result / MAP digest). Do NOT use this to change location (that is setScene) or to resolve mechanics.',
      inputSchema: {
        type: 'object',
        properties: {
          changes: {
            type: 'array',
            description: 'The batched scene changes, applied in order.',
            items: {
              type: 'object',
              properties: {
                op: { type: 'string', enum: ['move', 'face', 'reveal', 'hide', 'setState', 'spawn', 'despawn'], description: 'What happens.' },
                id: { type: 'string', description: 'The object/actor id, e.g. "npc:edda", "pc:aldric", "prop:chest".' },
                to: { type: 'string', description: 'move/spawn: a coordinate-free anchor — "near:<id>", "center", "north", "entrance", "waterside", …' },
                facing: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'face: which way they turn.' },
                state: { type: 'object', description: 'setState: flags to merge, e.g. {"door":"open"} or {"burning":true}.', additionalProperties: true },
                look: { type: 'string', description: 'spawn: role/appearance, e.g. "a gaunt drowned villager" — mapped to a sprite.' },
                name: { type: 'string', description: 'spawn: display name.' },
                role: { type: 'string', enum: ['npc', 'mob'], description: 'spawn: npc (someone to talk to) or mob (a hostile).' },
                visible: { type: 'boolean', description: 'spawn: false = present but hidden (reveal later).' },
              },
              required: ['op', 'id'],
              additionalProperties: false,
            },
          },
        },
        required: ['changes'],
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
    {
      name: 'endEncounter',
      description:
        'End the fight and clear the enemies from the field — call when combat is over (all foes defeated, or they flee/surrender). The engine auto-ends when the last foe drops, so mainly use this for a non-lethal end. Defeated/fled foes stop being listed as present.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'startConcentration',
      description:
        'Mark a caster as concentrating on a spell the MOMENT they cast one that requires concentration (Bless, Hold Person, Hex, Haste…). A creature holds only ONE at a time — casting another drops the first. When a concentrating caster later takes damage, applyDamage returns the Con-save DC needed to keep it.',
      inputSchema: {
        type: 'object',
        properties: {
          combatantId: { type: 'string', description: 'The caster, e.g. "pc:elara".' },
          spell: { type: 'string', description: 'The concentration spell, e.g. "Hold Person".' },
        },
        required: ['combatantId', 'spell'],
        additionalProperties: false,
      },
    },
    {
      name: 'breakConcentration',
      description:
        "End a caster's concentration — call this when they FAIL the Con save after taking damage, cast another concentration spell, are incapacitated, or choose to drop it. The ongoing spell's effect ends.",
      inputSchema: {
        type: 'object',
        properties: { combatantId: { type: 'string' } },
        required: ['combatantId'],
        additionalProperties: false,
      },
    },
  );
  // Character resources + rests (P3a). The engine owns every pool and every HP number — the DM narrates
  // the fiction ("she burns a spell", "they catch their breath") and calls these; it never invents a total.
  tools.push(
    {
      name: 'spendResource',
      description:
        'Spend a limited resource when a character uses it: a spell slot (resource:"slot", level 1–9) or a named class pool (resource:"ki"/"rage"/"channelDivinity"/…). The engine subtracts it and returns what remains, refusing if the pool is empty. Call this whenever a caster casts a levelled spell or a limited class feature is used.',
      inputSchema: {
        type: 'object',
        properties: {
          combatantId: { type: 'string', description: 'The character, e.g. "pc:elara".' },
          resource: { type: 'string', description: '"slot" for a spell slot, or a class pool name like "ki", "rage".' },
          level: { type: 'number', description: 'Spell slot level 1–9 (only for resource:"slot").' },
          amount: { type: 'number', description: 'How many to spend (default 1).' },
        },
        required: ['combatantId', 'resource'],
        additionalProperties: false,
      },
    },
    {
      name: 'shortRest',
      description:
        'Take a SHORT rest for one character (~1 hour). To heal, first requestRoll their hit dice (e.g. "2d10+4") and pass the declared total as "rolledTotal" plus how many dice were spent ("spendHitDice"); the engine heals and tracks the hit-dice pool. Also recharges short-rest features. Does NOT restore spell slots.',
      inputSchema: {
        type: 'object',
        properties: {
          combatantId: { type: 'string' },
          spendHitDice: { type: 'number', description: 'How many hit dice the character spends (0 to just recharge features).' },
          rolledTotal: { type: 'number', description: 'The rolled healing total from those hit dice (+CON).' },
        },
        required: ['combatantId'],
        additionalProperties: false,
      },
    },
    {
      name: 'longRest',
      description:
        'Take a LONG rest (~8 hours): restores full HP, refills spell slots + class resources, returns half the hit-dice pool, and lowers exhaustion by 1. Call with no arguments to rest the whole party. This is the ONLY way spell slots come back.',
      inputSchema: {
        type: 'object',
        properties: {
          combatantIds: { type: 'array', items: { type: 'string' }, description: 'Specific characters to rest (omit = the whole party).' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'setExhaustion',
      description: "Set a character's exhaustion level (0–6; 6 is death). Use when they push past their limits — no sleep, forced march, starvation, or a rule that inflicts it.",
      inputSchema: {
        type: 'object',
        properties: { combatantId: { type: 'string' }, level: { type: 'number', description: 'New exhaustion level 0–6.' } },
        required: ['combatantId', 'level'],
        additionalProperties: false,
      },
    },
    {
      name: 'grantInspiration',
      description: 'Give a player Heroic Inspiration (a one-shot token they can later spend for advantage) — reward great roleplay or a clever plan.',
      inputSchema: { type: 'object', properties: { combatantId: { type: 'string' } }, required: ['combatantId'], additionalProperties: false },
    },
    {
      name: 'spendInspiration',
      description: "Spend a character's Heroic Inspiration for advantage on a roll. Fails if they hold none.",
      inputSchema: { type: 'object', properties: { combatantId: { type: 'string' } }, required: ['combatantId'], additionalProperties: false },
    },
    {
      name: 'awardXp',
      description:
        'Award experience to a character after a real challenge (a defeated foe, a solved problem, a story beat). The engine adds it and reports when a level-up becomes available — it NEVER levels them up on its own; that stays your call as a beat.',
      inputSchema: {
        type: 'object',
        properties: {
          combatantId: { type: 'string', description: 'The character, e.g. "pc:aldric".' },
          amount: { type: 'number', description: 'XP to award (e.g. ~100 for a CR 1/2 foe, split among the party).' },
        },
        required: ['combatantId', 'amount'],
        additionalProperties: false,
      },
    },
    {
      name: 'levelUp',
      description:
        "Level a character up by one, when their XP allows it and the moment fits (usually on a rest). The engine raises HP, hit dice, and proficiency and tells you if an Ability Score Improvement / feat is due (you narrate that choice). Optionally pass hpMode:\"roll\" with a requestRoll'd hit-die total; default is the fixed average.",
      inputSchema: {
        type: 'object',
        properties: {
          combatantId: { type: 'string' },
          hpMode: { type: 'string', enum: ['avg', 'roll'], description: '"avg" (fixed HP, default) or "roll" (pass rolledTotal).' },
          rolledTotal: { type: 'number', description: "The rolled hit-die total, if hpMode is \"roll\"." },
        },
        required: ['combatantId'],
        additionalProperties: false,
      },
    },
    {
      name: 'setMilestoneLevel',
      description:
        'Milestone leveling: set a character directly to a level (no XP needed) when the story reaches a milestone. The engine applies the full gain. Use this OR awardXp+levelUp for a campaign, not both.',
      inputSchema: {
        type: 'object',
        properties: { combatantId: { type: 'string' }, level: { type: 'number', description: 'The new level (2–20).' } },
        required: ['combatantId', 'level'],
        additionalProperties: false,
      },
    },
    {
      name: 'prepareSpells',
      description:
        "Re-prepare a prepared caster's spell list — usually on a long rest. Pass the COMPLETE new list of prepared spell names; the engine enforces how many they can ready (their ability modifier + level). getState shows the current list and the cap.",
      inputSchema: {
        type: 'object',
        properties: {
          combatantId: { type: 'string' },
          prepared: { type: 'array', items: { type: 'string' }, description: 'The complete new prepared-spell list.' },
        },
        required: ['combatantId', 'prepared'],
        additionalProperties: false,
      },
    },
    {
      name: 'castRitual',
      description:
        'Cast a spell as a RITUAL — it takes 10 minutes longer but spends NO spell slot. Only works for a spell tagged as a ritual for that caster (see getState). Use this INSTEAD of spendResource when a caster ritual-casts (e.g. Detect Magic, Identify).',
      inputSchema: {
        type: 'object',
        properties: { combatantId: { type: 'string' }, spell: { type: 'string', description: 'The ritual spell, e.g. "Detect Magic".' } },
        required: ['combatantId', 'spell'],
        additionalProperties: false,
      },
    },
  );
  // Economy + inventory + equipment (P3d). The engine owns coins, item state, AC, and attunement — the
  // DM narrates the shop/loot/gear fiction and calls these; it never invents a price, an AC, or a total.
  tools.push(
    {
      name: 'buyItem',
      description: 'Buy an item from a shop by its catalog id. The engine checks the character can afford it, makes exact change across cp/sp/gp, and adds it — refusing if they are too poor.',
      inputSchema: {
        type: 'object',
        properties: { combatantId: { type: 'string' }, itemDefId: { type: 'string', description: 'Catalog id, e.g. "leather-armor", "potion-healing", "shield".' }, qty: { type: 'number' } },
        required: ['combatantId', 'itemDefId'],
        additionalProperties: false,
      },
    },
    {
      name: 'sellItem',
      description: 'Sell a carried item back for half its value (identify it by instanceId, or itemDefId for a stack). The engine removes it and credits the coins.',
      inputSchema: {
        type: 'object',
        properties: { combatantId: { type: 'string' }, instanceId: { type: 'string' }, itemDefId: { type: 'string' }, qty: { type: 'number' } },
        required: ['combatantId'],
        additionalProperties: false,
      },
    },
    {
      name: 'addItem',
      description: 'Give a character an item (loot, a gift, a found object) by catalog id — no cost. Returns the new instanceId(s) you can then equip or attune.',
      inputSchema: {
        type: 'object',
        properties: { combatantId: { type: 'string' }, itemDefId: { type: 'string' }, qty: { type: 'number' } },
        required: ['combatantId', 'itemDefId'],
        additionalProperties: false,
      },
    },
    {
      name: 'removeItem',
      description: 'Remove an item (used up, dropped, stolen, destroyed) — by instanceId (one), or itemDefId + qty (from a stack).',
      inputSchema: {
        type: 'object',
        properties: { combatantId: { type: 'string' }, instanceId: { type: 'string' }, itemDefId: { type: 'string' }, qty: { type: 'number' } },
        required: ['combatantId'],
        additionalProperties: false,
      },
    },
    {
      name: 'equipItem',
      description: 'Equip a carried item (armor, shield, weapon) by its instanceId. The engine fills the slot and recomputes AC from the gear.',
      inputSchema: {
        type: 'object',
        properties: { combatantId: { type: 'string' }, instanceId: { type: 'string' } },
        required: ['combatantId', 'instanceId'],
        additionalProperties: false,
      },
    },
    {
      name: 'unequipItem',
      description: 'Unequip a slot ("armor"/"shield"/"mainHand"/"offHand"/"ranged") or a specific instanceId; AC recomputes.',
      inputSchema: {
        type: 'object',
        properties: { combatantId: { type: 'string' }, slot: { type: 'string', enum: ['armor', 'shield', 'mainHand', 'offHand', 'ranged'] }, instanceId: { type: 'string' } },
        required: ['combatantId'],
        additionalProperties: false,
      },
    },
    {
      name: 'attuneItem',
      description: 'Attune a character to a magic item (by instanceId) — required for many magic items to function. The engine enforces the SRD limit of 3 attuned items and that the item is identified first.',
      inputSchema: {
        type: 'object',
        properties: { combatantId: { type: 'string' }, instanceId: { type: 'string' } },
        required: ['combatantId', 'instanceId'],
        additionalProperties: false,
      },
    },
    {
      name: 'unattuneItem',
      description: "End a character's attunement to an item, freeing an attunement slot.",
      inputSchema: {
        type: 'object',
        properties: { combatantId: { type: 'string' }, instanceId: { type: 'string' } },
        required: ['combatantId', 'instanceId'],
        additionalProperties: false,
      },
    },
    {
      name: 'identifyItem',
      description: 'Identify a magic item (an Identify spell, or a short rest spent studying it) so its properties and attunement unlock.',
      inputSchema: {
        type: 'object',
        properties: { combatantId: { type: 'string' }, instanceId: { type: 'string' } },
        required: ['combatantId', 'instanceId'],
        additionalProperties: false,
      },
    },
    {
      name: 'revive',
      description: 'Bring a DEAD character back to life (Revivify, Raise Dead, a divine boon). The engine clears death and restores HP (pass hpRestored; default 1). This is the ONLY way back — heal does not work on the dead.',
      inputSchema: {
        type: 'object',
        properties: { combatantId: { type: 'string' }, hpRestored: { type: 'number' } },
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
        properties: {
          toSceneId: { type: 'string', description: 'Destination scene id (a reachable exit from STEERING).' },
          outcome: { type: 'string', enum: ['resolved', 'fled', 'done'], description: 'How the prior beat closed: "resolved" (goal met), "fled" (left it undone), or "done".' },
        },
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
    {
      name: 'upsertNpc',
      description:
        'CANON: record or update a named NPC the moment they matter, so they stay themselves when they return. Give a stable id ("npc:edda"), their name, and their voice — a speech tic, what they WANT, what they FEAR. Update "status" when it changes ("wounded","captive","gone","dead"; dead/gone are permanent). Do this the FIRST time an NPC speaks or acts.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Stable id, e.g. "npc:edda".' },
          name: { type: 'string' },
          tic: { type: 'string', description: 'A distinctive speech/behaviour tic.' },
          want: { type: 'string', description: 'What they want.' },
          fear: { type: 'string', description: 'What they fear.' },
          status: { type: 'string', enum: ['active', 'wounded', 'captive', 'gone', 'dead'], description: 'Their standing; dead/gone are permanent.' },
          aliases: { type: 'array', items: { type: 'string' }, description: 'Other names they go by.' },
        },
        required: ['id', 'name'],
        additionalProperties: false,
      },
    },
    {
      name: 'recordFact',
      description:
        'CANON: record a load-bearing fact so later turns honor it — an item the party gained, a promise made, something learned, a place\'s state. subject = an entity id / "party" / a label; attribute = a short relation ("has","promised","knows","location"); value = the detail. A new fact for the same subject+attribute supersedes the old.',
      inputSchema: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'e.g. "party", "npc:edda", "item:silver-key".' },
          attribute: { type: 'string', description: 'e.g. "has", "promised", "knows", "location".' },
          value: { type: 'string', description: 'The detail, e.g. "the silver key from the crypt".' },
        },
        required: ['subject', 'attribute', 'value'],
        additionalProperties: false,
      },
    },
  );
  // Points of interest / interactables (P4). The engine owns the secret (discover DC, contents); players
  // never see a hidden POI until they find it. The DM plants them when scene-setting.
  tools.push({
    name: 'placePoi',
    description:
      'Plant a point of interest the players can interact with — a hidden chest, a secret door, a searchable altar. YOU know it; the players do NOT until they find it. Give a short "look", where it is ("anchor"), and whether it is hidden (with a discoverDc = the Perception/Investigation DC to spot it). For a container, list "contents" (catalog item ids + gold). For a passage (a door/stairs), give "leadsTo" (a "loc:…" place to enter, or a scene id). Never invent loot or a secret door on the fly — place it first, then have the party find it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Stable id, e.g. "poi:cellar-chest".' },
        kind: { type: 'string', enum: ['container', 'passage', 'feature', 'hidden-cache'], description: 'container (chest/crate), passage (door/stairs → leadsTo), feature (statue/altar), hidden-cache.' },
        look: { type: 'string', description: 'Short description read when found, e.g. "an iron-bound chest half-buried behind the roots".' },
        anchor: { type: 'string', description: 'Coordinate-free placement: "behind:prop:tree-3" | "near:bldg:inn" | "waterside" | "center".' },
        hidden: { type: 'boolean', description: 'true = not seen until discovered.' },
        discoverDc: { type: 'number', description: 'The DC to spot a hidden POI (required when hidden).' },
        contents: {
          type: 'object',
          description: 'What a container holds.',
          properties: {
            items: { type: 'array', items: { type: 'object', properties: { itemDefId: { type: 'string' }, qty: { type: 'number' } }, required: ['itemDefId'], additionalProperties: false } },
            gold: { type: 'number' },
          },
          additionalProperties: false,
        },
        leadsTo: { type: 'string', description: 'For a passage: a "loc:…" location to enter, or an arc scene id.' },
        notes: { type: 'string', description: 'A private GM note (never shown to players).' },
      },
      required: ['id', 'kind', 'look'],
      additionalProperties: false,
    },
  });
  tools.push(
    {
      name: 'discoverPoi',
      description: "Reveal a hidden point of interest the party just FOUND — after they beat its discoverDc on a Perception/Investigation check, or searched the right spot. Pass the POI id. (The engine also auto-reveals a POI whose DC is ≤ a character's passive Perception when they arrive.)",
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, by: { type: 'string', description: 'How they found it (for the log).' } }, required: ['id'], additionalProperties: false },
    },
    {
      name: 'searchPoi',
      description: "Search a FOUND point of interest to see what's inside — describe it to the players (no transfer yet). Pass the POI id.",
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    },
    {
      name: 'lootPoi',
      description: "Hand a FOUND point of interest's contents (items + gold) to a character — they land on that character's sheet. Pass the POI id + the looter's combatant id. Idempotent (a looted POI is empty).",
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, combatantId: { type: 'string' } }, required: ['id', 'combatantId'], additionalProperties: false },
    },
  );
  if (SPATIAL_ON) {
    tools.push({
      name: 'travel',
      description:
        "MOVE a character to something on the map — the engine walks the REAL path (walkable ground; water means swimming at double cost; rough water suspends for an Athletics check it will resolve itself). Use this for ALL declared movement ('I go to…'). Set `to` to the EXACT (id) of the target as listed in the MAP block's Fixtures/NPCs (each entry is 'a barrel (prop:…-1) — 10 ft NW'); pick the id whose noun AND bearing match what the player named ('the barrel next to the fountain' → the barrel id nearest the fountain, NOT some other prop). If the thing the player named is NOT in the MAP block, call queryScene ('near'/'whereis') to find its id FIRST — NEVER invent or guess an id. The verdict tells you feet, rounds, what was swum, or why they stopped short — narrate THAT, in fiction, without reciting the numbers as numbers.",
      inputSchema: {
        type: 'object',
        properties: {
          actorId: { type: 'string', description: 'who moves (id or name)' },
          to: { type: 'string', description: 'destination: an entity id or name on the map' },
        },
        required: ['actorId', 'to'],
        additionalProperties: false,
      },
    });
    tools.push({
      name: 'queryScene',
      description:
        "Ask the spatial oracle about the CURRENT map (read-only, exact, in feet). asks: 'distance' between two things; 'path' = a walk/swim preview (legs, feet, rounds — how long, whether it means swimming); 'los' = line of sight; 'whereis' = medium/indoors/adjacency of one thing; 'near' = what is within 30 ft of it. Use it BEFORE narrating any distance, route, or blockage the MAP block doesn't state — never guess geometry.",
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'entity id or name' },
          to: { type: 'string', description: "the other entity (needed for 'distance', 'path', 'los')" },
          ask: { type: 'string', enum: ['distance', 'path', 'los', 'whereis', 'near'] },
        },
        required: ['from', 'ask'],
        additionalProperties: false,
      },
    });
  }
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
const SPATIAL_ON = (process.env.MYTHWEAVER_SPATIAL ?? 'on').toLowerCase() !== 'off';

/** Compass phrase from a to b ("15 ft NE"). Distances in FEET — coordinates never enter the prompt. */
function bearingFt(idx: SpatialIndex, a: { col: number; row: number }, b: { col: number; row: number }): string {
  const ft = distanceFt(idx, a, b);
  if (ft === 0) return 'adjacent';
  const dc = b.col - a.col;
  const dr = b.row - a.row;
  const dir = `${Math.abs(dr) > Math.abs(dc) / 2 ? (dr < 0 ? 'N' : 'S') : ''}${Math.abs(dc) > Math.abs(dr) / 2 ? (dc < 0 ? 'W' : 'E') : ''}`;
  return `${ft} ft${dir ? ` ${dir}` : ''}`;
}

/** COHERENCE ④ — the cast's REALIZED positions, returned with every setScene so the establishing
 *  narration places people where they ACTUALLY stand. The fiction's expectation ("the smith at his
 *  forge") is a request; this block is the result — any deviation is now fiction to narrate, never a
 *  false fact to assert. */
function castPositionsBlock(map: SceneMap): string {
  try {
    const idx = spatialIndex(map);
    const pcs = map.objects.filter((o) => o.role === 'pc' && o.visible !== false);
    if (!pcs.length) return '';
    const centroid = {
      col: Math.round(pcs.reduce((s, p) => s + p.col, 0) / pcs.length),
      row: Math.round(pcs.reduce((s, p) => s + p.row, 0) / pcs.length),
    };
    const named = map.objects.filter((o) => o.kind === 'actor' && o.role === 'npc' && o.name && o.visible !== false);
    if (!named.length) return '';
    const lines = named.map((o) => {
      const w = whereIs(idx, o);
      return `${o.name} (${o.id}): ${bearingFt(idx, centroid, o)} of the party${w.indoor ? ` — INDOORS (${w.buildingId ?? 'under a roof'}, not visible from outside)` : ''}`;
    });
    return ` CAST POSITIONS (authoritative — narrate people WHERE THEY STAND; if the fiction expected someone elsewhere, that mismatch is itself story, never a fact to assert): ${lines.join(' · ')}.`;
  } catch {
    return '';
  }
}

/** SPATIAL TRUTH R1: the actor lines speak in feet, rooms and media derived by the oracle —
 *  "25 ft NE of the party, indoors (bldg:house)" — never raw coordinates. The DM narrates from
 *  these instead of inventing geography. Oracle failure falls back to the legacy digest. */
function sceneDigest(map: SceneMap): string {
  let idx: SpatialIndex | undefined;
  if (SPATIAL_ON) {
    try {
      idx = spatialIndex(map);
    } catch {
      /* the oracle must never break a turn — legacy digest below */
    }
  }
  const pcObjs = map.objects.filter((o) => o.role === 'pc');
  const centroid = pcObjs.length
    ? { col: Math.round(pcObjs.reduce((s, p) => s + p.col, 0) / pcObjs.length), row: Math.round(pcObjs.reduce((s, p) => s + p.row, 0) / pcObjs.length) }
    : { col: 0, row: 0 };
  const place = (o: { col: number; row: number }): string => {
    if (!idx) return '';
    const w = whereIs(idx, o);
    const bits: string[] = [];
    if (w.indoor) bits.push(`indoors${w.buildingId ? ` (${w.buildingId})` : ''}`);
    if (w.medium === 'water-deep' || w.medium === 'water-shallow') bits.push('IN THE WATER');
    return bits.length ? `, ${bits.join(', ')}` : '';
  };
  const human = (tag: string): string => tag.replace(/[_-]+/g, ' ').replace(/\d+/g, '').trim() || 'object';

  // FIXTURES — a plain noun + its (id) + bearing, so the DM can TARGET the right prop by id ("the barrel
  // next to the fountain" → the barrel's real id) instead of guessing from opaque strings. Was: bare
  // `id(zone)` with no tag or position, which forced the DM to hallucinate a target.
  const single: SceneMap['objects'] = [];
  const fixGroups = new Map<string, { n: number; tag: string; sample: { col: number; row: number } }>();
  for (const o of map.objects.filter((o) => o.kind !== 'actor')) {
    if (o.group) {
      const g = fixGroups.get(o.group) ?? { n: 0, tag: o.tag, sample: { col: o.col, row: o.row } };
      g.n++;
      fixGroups.set(o.group, g);
    } else single.push(o);
  }
  if (idx) single.sort((a, b) => distanceFt(idx!, centroid, a) - distanceFt(idx!, centroid, b)); // nearest first — the props players actually reference
  const fix = single.map((o) => `a ${human(o.tag)} (${o.id})${idx ? ` — ${bearingFt(idx, centroid, o)} of the party${place(o)}` : ` @${o.col},${o.row}`}`);
  for (const [id, g] of fixGroups) fix.push(`${human(g.tag)} ×${g.n} (${id})${idx ? ` — nearest ${bearingFt(idx, centroid, g.sample)} of the party` : ''}`);

  const npcs: string[] = [];
  const npcGroups = new Map<string, { n: number; sample?: { col: number; row: number } }>();
  for (const o of map.objects.filter((o) => o.kind === 'actor' && o.role !== 'pc')) {
    if (o.group) {
      const g = npcGroups.get(o.group) ?? { n: 0, sample: { col: o.col, row: o.row } };
      g.n++;
      npcGroups.set(o.group, g);
    } else {
      const pos = idx ? ` — ${bearingFt(idx, centroid, o)} of the party${place(o)}` : `@${o.col},${o.row}`;
      npcs.push(`${o.id} "${o.name ?? ''}"${pos}${o.visible ? '' : ' [hidden]'}`);
    }
  }
  for (const [id, g] of npcGroups) npcs.push(`${id} ×${g.n}${idx && g.sample ? ` — nearest ${bearingFt(idx, centroid, g.sample)} of the party` : ''}`);

  const pcs = pcObjs.map((o) => {
    if (!idx) return `${o.id}@${o.col},${o.row}`;
    const first = pcObjs[0]!;
    const rel = o === first ? '' : `, ${bearingFt(idx, first, o)} of ${first.id}`;
    return `${o.id}${rel}${place(o)}`;
  });

  return [
    `Location ${map.locationId} — ${map.biome}, ${map.lighting}${idx ? ` · ${map.grid.cols * 5}×${map.grid.rows * 5} ft` : ''}`,
    `Fixtures: ${fix.join(', ') || 'none'}`,
    `NPCs here: ${npcs.join('; ') || 'none'}`,
    `Party here: ${pcs.join(', ') || 'none'}`,
    ...(idx ? ['(distances above are AUTHORITATIVE — narrate from them; use queryScene for a path/line-of-sight)'] : []),
  ].join('\n');
}

/** queryScene dispatch — the oracle answers in feet/media/rooms, never coordinates. Read-only;
 *  any failure returns an explanatory string (the oracle must never break a turn). */
/** Loose fiction-word → map-object resolution: exact id, name, combatant handle, then GROUP/TAG
 *  fuzzy match picking the member NEAREST `near` (the DM says "the drowned dead", not "#03"). */
function resolveMapObject(engine: Engine, map: SceneMap, ref: unknown, near?: { col: number; row: number }): SceneMap['objects'][number] | undefined {
  const s = String(ref ?? '').trim();
  if (!s) return undefined;
  const direct =
    map.objects.find((o) => o.id === s) ??
    map.objects.find((o) => (o.name ?? '').toLowerCase() === s.toLowerCase()) ??
    map.objects.find((o) => o.id === engine.findCombatantId(s));
  if (direct) return direct;
  const norm = s.toLowerCase().replace(/^(mob|npc|prop|bldg|pc):/, '').replace(/[-_\s]+/g, '');
  const loose = map.objects.filter((o) => {
    if (o.visible === false) return false;
    const cands = [o.group ?? '', o.tag, o.id, o.name ?? ''];
    return cands.some((c) => {
      const cn = c.toLowerCase().replace(/^(mob|npc|prop|bldg|pc):/, '').replace(/[-_\s#\d]+/g, '');
      return cn && (cn.includes(norm) || norm.includes(cn));
    });
  });
  if (!loose.length) return undefined;
  if (!near) return loose[0];
  const idx = spatialIndex(map);
  return loose.sort((a, b) => distanceFt(idx, near, a) - distanceFt(idx, near, b))[0];
}

/** COHERENCE: when a player ADDRESSES a named NPC from a distance, the DM must narrate the reply AT
 *  that distance — a shout across the water is not an at-the-shoulder murmur. The oracle knows the gap
 *  (feet, water between, line of sight); this binds the NPC's blocking to it, so dialogue stops ignoring
 *  relational position. Empty string when they're face-to-face (normal blocking) or no NPC is addressed. */
function addresseeSpatialNote(engine: Engine, state: GameState, input: TurnInput): string {
  if (input.kind !== 'message') return '';
  const map = currentMap(state);
  if (!map) return '';
  const speaker = (map.objects ?? []).find((o) => o.role === 'pc' && (o.name ?? '').toLowerCase() === (input.speakerId ?? '').trim().toLowerCase());
  if (!speaker) return '';
  const text = input.text.toLowerCase();
  const npc = (map.objects ?? []).find((o) => o.kind === 'actor' && o.role === 'npc' && o.name && o.visible !== false && text.includes(o.name.toLowerCase()));
  if (!npc) return '';
  const idx = spatialIndex(map);
  const ft = distanceFt(idx, speaker, npc);
  if (ft <= 10) return ''; // within a step — a normal face-to-face exchange; say nothing
  // Water between them? sample the straight line for water tiles (a swim, not a stroll, separates them).
  let waterN = 0, samples = 0;
  const dc = npc.col - speaker.col, dr = npc.row - speaker.row, steps = Math.max(Math.abs(dc), Math.abs(dr));
  for (let i = 1; i < steps; i++) {
    const c = Math.round(speaker.col + (dc * i) / steps), r = Math.round(speaker.row + (dr * i) / steps);
    samples++; if ((map.tiles?.[r]?.[c] ?? '').startsWith('water')) waterN++;
  }
  const acrossWater = samples > 0 && waterN / samples > 0.3;
  const los = hasLineOfSight(idx, speaker, npc).clear;
  const register = ft >= 30 ? 'a SHOUT across the gap' : 'several paces apart, out of arm’s reach';
  return (
    `=== SPATIAL — SOCIAL DISTANCE (authoritative; from the oracle) ===\n` +
    `${speaker.name} is ~${ft} ft from ${npc.name}${acrossWater ? ', across open water' : ''}${los ? '' : ', not in clear line of sight'} — this is ${register}, NOT a face-to-face exchange. ` +
    `Narrate ${npc.name}'s reply AT that distance: they raise their voice, beckon ${speaker.name} closer, or only part of it carries${acrossWater ? ' over the water' : ''}. ` +
    `Do NOT block it as an intimate, at-the-shoulder conversation, and do NOT have them touch/hand over/lean in across that gap. For a close exchange, ${speaker.name} must approach (a declared move).\n\n`
  );
}

/** Coherence ② — did the narration DENY a water crossing the gate actually made? We flag only prose that
 *  EXPLICITLY asserts dryness ("solid ground", "boots dry", "not a drop") AND never mentions water — the
 *  exact "solid ground rises beneath his boots" failure. Prose that merely IMPLIES the crossing without a
 *  named water word ("hauls himself out on the far bank") is NOT second-guessed: a false positive would
 *  re-narrate good prose, worse than an occasional miss. This binds the verdict without nagging. */
function narrationDeniesWater(text: string): boolean {
  const dry = /\b(dry(?:-shod|-footed)?|solid ground|firm ground|dry stone|without (?:getting )?wet|not a drop|(?:boots?|feet) (?:stay(?:ed)? )?dry|dry (?:boots?|feet))\b/i;
  if (!dry.test(text)) return false; // no explicit dryness claim → trust the prose
  const wet = /\b(swim|swam|swum|wad(?:e|es|ed|ing)|water|current|soak|soaked|drench|drip|flood|reservoir|submerg|wet|waist-deep|knee-deep)\b/i;
  return !wet.test(text); // asserts dryness AND never mentions water → the failure we re-narrate
}

function answerSceneQuery(engine: Engine, state: GameState, input: Record<string, unknown>): string {
  try {
    const map = currentMap(state);
    if (!map) return 'No scene is established yet.';
    const idx = spatialIndex(map);
    const from = resolveMapObject(engine, map, input.from);
    if (!from) return `No object "${String(input.from)}" on this map.`;
    const to = resolveMapObject(engine, map, input.to, from);
    const ask = String(input.ask ?? 'distance');
    const need = (): string | null => (to ? null : `ask:'${ask}' needs a 'to' — no object "${String(input.to)}" on this map.`);

    if (ask === 'distance') {
      const miss = need();
      if (miss) return miss;
      const ft = distanceFt(idx, from, to!);
      const los = hasLineOfSight(idx, from, to!);
      return `${from.id} → ${to!.id}: ${ft} ft, line of sight ${los.clear ? 'CLEAR' : 'BLOCKED'}.`;
    }
    if (ask === 'los') {
      const miss = need();
      if (miss) return miss;
      const los = hasLineOfSight(idx, from, to!);
      return los.clear ? `${from.id} can see ${to!.id}.` : `${from.id} CANNOT see ${to!.id} — sight is blocked.`;
    }
    if (ask === 'path') {
      const miss = need();
      if (miss) return miss;
      const speedFt = state.sheets?.[from.id]?.speedFt ?? 30;
      const r = findPath(idx, from, to!, { speedFt, swim: 'double-cost' });
      if (!r.ok) {
        const fr = r.frontier ? ` Closest approach: ${distanceFt(idx, r.frontier, to!)} ft short of the target.` : '';
        return `No route for ${from.id} → ${to!.id} (${r.blockedBy}).${fr}`;
      }
      const legs = r.segments.map((s) => `${s.ft} ft ${s.swimming ? 'SWIMMING' : s.medium}`).join(' + ');
      const t = travelTime(r.totalFt, speedFt);
      return `${from.id} → ${to!.id}: ${legs} = ${r.totalFt} ft of movement at speed ${speedFt} (~${t.rounds} round${t.rounds === 1 ? '' : 's'}). ${r.segments.some((s) => s.swimming) ? 'Crossing water means swimming (double cost; a check may apply in rough water).' : ''}`.trim();
    }
    if (ask === 'whereis') {
      const w = whereIs(idx, from);
      const adj = w.adjacent.length ? ` Adjacent: ${w.adjacent.join(', ')}.` : '';
      return `${from.id}: ${w.indoor ? `indoors${w.buildingId ? ` in ${w.buildingId}` : ''}` : 'outdoors'}, on ${w.medium}.${adj}`;
    }
    if (ask === 'near') {
      const namedFirst = map.objects
        .filter((o) => o !== from && o.visible !== false)
        .map((o) => ({ o, ft: distanceFt(idx, from, o) }))
        .filter((x) => x.ft <= 30)
        .sort((a, b) => a.ft - b.ft || (a.o.name ? -1 : 1))
        .slice(0, 8);
      return namedFirst.length
        ? `Within 30 ft of ${from.id}: ${namedFirst.map((x) => `${x.o.id}${x.o.name ? ` "${x.o.name}"` : ''} (${x.ft} ft)`).join(', ')}.`
        : `Nothing notable within 30 ft of ${from.id}.`;
    }
    return `Unknown ask "${ask}".`;
  } catch (e) {
    return `Spatial query failed: ${(e as Error).message}`;
  }
}

/** Compact per-PC character-engine tail for the state block — NON-DEFAULT pools only, so a mundane L1
 *  martial adds ~0 tokens and a loaded caster/adventurer adds ~15–25 (spell slots, class pools, exhaustion,
 *  inspiration, concentration, gold, attunement, overload). Keeps the token budget honest while the DM
 *  still sees what each character has left to spend / is carrying. */
function characterTail(c: Combatant, cs?: CharacterState, sheet?: CharacterSheet, catalog?: Record<string, ItemDef>): string {
  const parts: string[] = [];
  if (c.slotsRemaining && c.slotsMax) {
    const slots = c.slotsRemaining
      .map((n, lvl) => (lvl >= 1 && (c.slotsMax![lvl] ?? 0) > 0 ? `L${lvl} ${n}/${c.slotsMax![lvl]}` : ''))
      .filter(Boolean)
      .join(', ');
    if (slots) parts.push(`slots ${slots}`);
  }
  const res = Object.entries(c.resources ?? {})
    .map(([k, v]) => `${k} ${v.current}/${v.max}`)
    .join(', ');
  if (res) parts.push(res);
  if (c.hitDice && c.hitDice.remaining < c.hitDice.max) parts.push(`hit dice ${c.hitDice.remaining}/${c.hitDice.max}d${c.hitDice.size}`);
  if (c.exhaustion) parts.push(`exhaustion ${c.exhaustion}`);
  if (c.inspiration) parts.push('inspiration');
  if (c.concentratingOn) parts.push(`concentrating: ${c.concentratingOn.spell}`);
  if (cs) {
    const { cp, sp, gp } = cs.currency;
    const coins = [gp ? `${gp}gp` : '', sp ? `${sp}sp` : '', cp ? `${cp}cp` : ''].filter(Boolean).join(' ');
    if (coins) parts.push(coins);
    if (cs.attunedInstanceIds.length) parts.push(`attuned ${cs.attunedInstanceIds.length}/3`);
    if (sheet && catalog) {
      const weight = cs.items.reduce((w, i) => w + (catalog[i.defId]?.weightLb ?? 0) * (i.qty ?? 1), 0);
      const cap = sheet.abilities.str * 15;
      if (weight > cap) parts.push(`OVERLOADED ${Math.round(weight)}/${cap}lb`);
    }
  }
  return parts.length ? ` — ${parts.join('; ')}` : '';
}

function summarizeState(state: GameState): string {
  const pcs = Object.values(state.combatants)
    .filter((c) => c.kind === 'pc')
    .map((c) => {
      const cs = state.characters?.[c.id];
      return (
        `- ${c.name}${cs ? ` (L${cs.level})` : ''}: ${c.currentHitPoints}/${c.maxHitPoints} HP, AC ${c.armorClass}` +
        (c.conditions.length ? `, conditions: ${c.conditions.join(', ')}` : '') +
        characterTail(c, cs, state.sheets?.[c.id], state.itemCatalog)
      );
    })
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
    ...(poiDigest(state) ? [poiDigest(state)] : []),
  ].join('\n');
}

/** DM-ONLY digest of the current location's points of interest — WITH their discover DCs + contents. The DM
 *  knows these; the players never do (the narration + the map slice the client sees never carry them). */
function poiDigest(state: GameState): string {
  const loc = state.world?.currentLocationId;
  const pois = Object.values(state.pois ?? {}).filter((p) => !loc || p.locationId === loc);
  if (!pois.length) return '';
  const lines = pois.map((p) => {
    const status = p.looted ? 'looted' : p.searched ? 'searched' : p.discovered ? 'found' : p.hidden ? `HIDDEN, DC ${p.discoverDc}` : 'in plain sight';
    const loot = p.contents ? ` — holds ${[...(p.contents.items ?? []).map((it) => `${it.qty && it.qty > 1 ? `${it.qty}× ` : ''}${it.itemDefId}`), ...(p.contents.gold ? [`${p.contents.gold} gp`] : [])].join(', ') || '(nothing)'}` : '';
    const leads = p.leadsTo ? ` → leads to ${p.leadsTo}` : '';
    return `- ${p.id} (${p.kind})${p.anchor ? ` ${p.anchor}` : ''} — ${status}${loot}${leads}: ${p.look}`;
  });
  return `\n=== POINTS OF INTEREST (you know these; the players don't until they find them) ===\n${lines.join('\n')}`;
}

/** The JSON the getState tool returns to the model. */
function serializeStateForModel(state: GameState): string {
  const map = currentMap(state);
  const catalog = state.itemCatalog ?? {};
  return JSON.stringify({
    scene: state.currentSceneId,
    inCombat: state.combat.active,
    round: state.combat.round,
    combatants: Object.values(state.combatants).map((c) => {
      const cs = state.characters?.[c.id];
      const sheet = state.sheets?.[c.id];
      const dc = sheet ? deriveSpellSaveDc(sheet, cs) : undefined;
      return {
        id: c.id,
        name: c.name,
        kind: c.kind,
        hp: `${c.currentHitPoints}/${c.maxHitPoints}`,
        ac: c.armorClass,
        conditions: c.conditions,
        // Engine-derived numbers the DM states WITHOUT a roll (passive senses, spell DC, prof). The bonus
        // on an active check/save comes from requestRoll (combatantId+ability), so no full skill table here.
        ...(sheet
          ? {
              proficiencyBonus: deriveProficiencyBonus(cs?.level ?? sheet.level),
              passives: {
                perception: derivePassive(sheet, cs, 'perception', c.exhaustion),
                investigation: derivePassive(sheet, cs, 'investigation', c.exhaustion),
                insight: derivePassive(sheet, cs, 'insight', c.exhaustion),
              },
              ...(dc !== undefined ? { spellSaveDc: dc } : {}),
              ...(sheet.spellcasting
                ? {
                    spells: {
                      preparedMax: deriveSpellsPreparedMax(sheet, cs),
                      prepared: c.preparedSpells ?? sheet.spellcasting.prepared,
                      ...(sheet.spellcasting.rituals?.length ? { rituals: sheet.spellcasting.rituals } : {}),
                    },
                  }
                : {}),
            }
          : {}),
        ...(cs
          ? {
              level: cs.level,
              xp: cs.xp,
              currency: cs.currency,
              // Instance ids the DM needs to equip/attune/sell, with live flags.
              items: cs.items.map((i) => ({
                instanceId: i.instanceId,
                id: i.defId,
                name: catalog[i.defId]?.name ?? i.defId,
                ...(i.qty && i.qty > 1 ? { qty: i.qty } : {}),
                ...(Object.values(cs.equipped).includes(i.instanceId) ? { equipped: true } : {}),
                ...(cs.attunedInstanceIds.includes(i.instanceId) ? { attuned: true } : {}),
                ...(i.identified === false ? { unidentified: true } : {}),
              })),
            }
          : {}),
      };
    }),
    flags: state.flags,
    // The buyable catalog (id + name + price) so the DM can run a shop with real ids + prices.
    ...(Object.keys(catalog).length ? { shop: Object.values(catalog).filter((d) => d.costGp !== undefined).map((d) => ({ id: d.id, name: d.name, gp: d.costGp })) } : {}),
    // POINTS OF INTEREST for the current location — DM-only (discover DC + contents). Never sent to players.
    ...(state.pois && Object.keys(state.pois).length
      ? {
          pois: Object.values(state.pois)
            .filter((p) => !map || p.locationId === map.locationId)
            .map((p) => ({ id: p.id, kind: p.kind, look: p.look, anchor: p.anchor, hidden: p.hidden, discoverDc: p.discoverDc, discovered: p.discovered, searched: p.searched, looted: p.looted, contents: p.contents, leadsTo: p.leadsTo })),
        }
      : {}),
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
/**
 * The CANON block (P1): deterministically inject the ledger slice relevant to THIS turn — entities
 * native to the current scene or named in the turn's context, their live facts, party facts (items/
 * promises), and any free fact being discussed. Capped ~550 tokens. $0, no LLM. This is how a returning
 * NPC keeps its voice and the silver key stays remembered past the 12-line window.
 */
export function canonBlock(state: GameState, context: string): string {
  const L = state.ledger;
  if (!L || (!Object.keys(L.entities).length && !L.facts.length)) return '';
  const hay = context.toLowerCase();
  const scene = state.currentSceneId;
  const entities = Object.values(L.entities);
  const live = L.facts.filter((f) => !f.supersededBy);
  const named = (e: { name: string; aliases?: string[] }) => [e.name, ...(e.aliases ?? [])].some((a) => a && hay.includes(a.toLowerCase()));
  // PCs (kind:'pc') are ALWAYS present; NPCs/others are pulled in when native to the scene or named.
  const matched = new Set(entities.filter((e) => e.kind === 'pc' || e.scenes?.includes(scene) || named(e)).map((e) => e.id));
  // One recursion pass: a matched entity's fact may name another entity → pull that one in too.
  for (const f of live) if (matched.has(f.subject)) for (const e of entities) if (!matched.has(e.id) && f.value.toLowerCase().includes(e.name.toLowerCase())) matched.add(e.id);

  let budget = 2200; // ~550 tokens
  const factsFor = (id: string) => live.filter((f) => f.subject === id);
  const renderEntity = (e: (typeof entities)[number], lines: string[]) => {
    const v = e.voice;
    const voice = v ? [v.tic && `tic: ${v.tic}`, v.want && `wants: ${v.want}`, v.fear && `fears: ${v.fear}`].filter(Boolean).join('; ') : '';
    const tail = voice || e.notes || '';
    const push = (s: string) => { if (s && budget - s.length > 0) { lines.push(s); budget -= s.length + 1; } };
    push(`- ${e.name} [${e.id}] (${e.status ?? 'active'})${tail ? ` — ${tail}` : ''}`);
    for (const f of factsFor(e.id)) push(`    · ${f.attribute}: ${f.value}`);
  };

  // Party block first — the DM should always know who the characters are and weave their backstories.
  const partyLines: string[] = [];
  for (const e of entities) if (e.kind === 'pc') renderEntity(e, partyLines);
  // NPCs / places / items relevant to this turn.
  const worldLines: string[] = [];
  for (const e of entities) if (e.kind !== 'pc' && matched.has(e.id)) renderEntity(e, worldLines);
  // Free-subject facts (party items/promises, or anything named in the turn's context).
  for (const f of live) {
    if (L.entities[f.subject]) continue; // already rendered under its entity
    if (f.subject === 'party' || hay.includes(f.subject.toLowerCase()) || hay.includes(f.value.toLowerCase())) {
      const s = `- ${f.subject} · ${f.attribute}: ${f.value}`;
      if (budget - s.length > 0) { worldLines.push(s); budget -= s.length + 1; }
    }
  }
  if (!partyLines.length && !worldLines.length) return '';
  const parts = [
    partyLines.length ? `PARTY (the player characters — their backstories are canon; weave callbacks, honor who they are):\n${partyLines.join('\n')}` : '',
    worldLines.join('\n'),
  ].filter(Boolean);
  return `=== CANON (established world truth — NEVER contradict; if something is unknown, invent it freshly and record it with recordFact/upsertNpc) ===\n${parts.join('\n')}\n\n`;
}

/** Render the persistent NPC standings (`npc:*` flags) so the DM keeps NPCs consistent across turns. */
function npcStandings(flags: Record<string, string | number | boolean>): string[] {
  return Object.entries(flags)
    .filter(([k]) => k.startsWith('npc:'))
    .map(([k, v]) => `${k.slice(4)}=${v}`);
}

function steeringFromBrief(brief: ArcBrief, flags: Record<string, string | number | boolean>): string {
  const beatsDone = Object.keys(flags).filter((k) => k.startsWith('beat:')).map((k) => k.slice(5));
  const decisions = Object.entries(flags).filter(([k]) => k.startsWith('decision:')).map(([k, v]) => `${k.slice(9)}=${v}`);
  const npcs = npcStandings(flags);
  const reach = brief.reachable.map((r) => `  - ${r.sceneId} — ${r.hook}`).join('\n');
  return (
    [
      `=== STEERING (Game Director — soft; OFFER these as the fiction allows, never force. advanceScene only when the party goes there) ===`,
      brief.activeBeatIntent ? `Now: ${brief.activeBeatIntent}` : '',
      reach ? `Reachable beats:\n${reach}` : 'Reachable beats: (none — this beat resolves the arc)',
      brief.bridgeNpcs?.length ? `Bridge NPCs available: ${brief.bridgeNpcs.map((n) => `${n.name} (${n.role})`).join('; ')}` : '',
      brief.clocks?.length ? `Pressure: ${brief.clocks.join('; ')}` : '',
      brief.notes ? `Director note: ${brief.notes}` : '',
      npcs.length ? `NPC standings (keep consistent): ${npcs.join(', ')}` : '',
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

/** A beat's authored visual brief for the establish-directive: the ScenePlan when the arc composer
 *  designed one (look + kind + mood + features), else the beat summary. The SINGLE seam Phase C's
 *  plans are consumed through at transition time. */
export function beatVisualBrief(state: GameState, sceneId: string): string {
  const beat = state.adventure?.scenes?.[sceneId];
  if (!beat) return '';
  const p = beat.scenePlan;
  if (!p) return beat.summary ? beat.summary.slice(0, 300) : '';
  return `${p.look} [kind: ${p.kind}; mood: ${p.mood}${p.features?.length ? `; must include: ${p.features.join(', ')}` : ''}]`;
}

/** Coerce the DM's setScene tool input into a well-formed EstablishScene (the Composer normalizes further). */
export function parseEstablish(input: Record<string, unknown>, state: GameState): EstablishScene {
  const setting = typeof input.setting === 'string' && input.setting.trim() ? input.setting : 'a quiet, dim place';
  const biome = typeof input.biome === 'string' ? input.biome : 'village';
  const tod = input.timeOfDay;
  // Track whether the DM actually DECLARED a time — the coerced 'day' default below must never count
  // as a declaration (declared time beats mood-inferred lighting; a phantom 'day' would kill mood).
  const timeOfDayExplicit = tod === 'day' || tod === 'dusk' || tod === 'night';
  const timeOfDay = timeOfDayExplicit ? tod : 'day';
  const kind = input.kind === 'settlement' || input.kind === 'interior' || input.kind === 'wild' ? input.kind : undefined;
  const mood = typeof input.mood === 'string' && input.mood.trim() ? input.mood.trim() : undefined;
  let locationId = typeof input.locationId === 'string' && /^loc:[a-z0-9-]+$/.test(input.locationId) ? input.locationId : '';
  if (!locationId) {
    locationId = `loc:${slug(setting)}`;
    if (!/^loc:[a-z0-9-]+$/.test(locationId)) locationId = `loc:place-${Object.keys(state.world?.locations ?? {}).length}`;
  }
  return {
    locationId,
    brief: { setting, biome, timeOfDay, ...(mood ? { mood } : {}) },
    ...(kind ? { kind } : {}),
    ...(timeOfDayExplicit ? { timeOfDayExplicit: true } : {}),
    fixtures: parseFixtures(input.fixtures),
    npcs: parseNpcs(input.npcs),
  };
}

/**
 * Predict which register of style exemplar THIS turn needs (deterministic, $0). The filter is the
 * verbosity control: long arrival-style exemplars only fire on scene-setting turns, so the DM doesn't
 * learn to ramble on an ordinary beat. Undefined → unfiltered semantic retrieval.
 */
export function predictMoveType(input: TurnInput, state: GameState): ExemplarMoveType | undefined {
  if (input.kind === 'opening') return 'scene-set';
  if (state.combat.active) return 'combat-beat';
  if (input.kind === 'message') {
    const t = input.text.trim();
    if (t.endsWith('?') && t.length < 160) return 'short-answer';
  }
  return undefined;
}

/**
 * SPEECH-ACT classifier (deterministic, $0) — is the player ASKING about the situation/space (a
 * question to ANSWER) or DECLARING an action (to execute)? This closes the coherence leak where a
 * feasibility question ("can we reach her? do we need a boat?") was silently run as a committed move:
 * the engine had no notion of a speech act, so an interrogative line and a command flowed through the
 * identical tool loop and the model resolved the ambiguity toward acting. On 'ask', the turn withholds
 * movement and the DM answers (via queryScene) — the player still chooses whether to actually go.
 *
 * Errs toward 'act' (only WITHHOLDS the move when it is confident it is a question): a line reads as
 * 'ask' iff it is interrogative (ends with '?' or opens with an interrogative word) AND does not also
 * DECLARE a first-person action ("…so I swim across"). A declared action under an interrogative opener
 * ("should we swim?") stays 'ask' — the verb is what's being ASKED about, not commanded.
 */
export function classifySpeechAct(input: TurnInput): 'ask' | 'act' {
  if (input.kind !== 'message') return 'act';
  const t = input.text.trim().toLowerCase().replace(/^\(?\s*(to the dm|ooc|meta)\b[:)\s]*/i, '').trim();
  if (!t) return 'act';
  const opensInterrogative = /^(can|could|should|shall|would|do|does|did|is|are|was|were|how|where|what|which|who|why|when|will|are there|is there)\b/.test(t);
  const interrogative = t.endsWith('?') || opensInterrogative;
  if (!interrogative) return 'act';
  // A first-person COMMITTED action makes it a declaration — UNLESS it sits under an interrogative
  // opener, where the action verb is the subject of the question ("should we swim?"), not a command.
  const declaresAction =
    !opensInterrogative &&
    /\b(i|we)\s+(?:now\s+|then\s+|will\s+|'?ll\s+|just\s+|also\s+)?(go|goes|walk|walks|run|runs|move|moves|approach|head|heads|swim|swims|climb|enter|cross|step|charge|attack|cast|draw|shoot|fire|strike|grab|open|push|pull|leap|jump|sneak|throw|follow)\b/.test(t);
  return declaresAction ? 'act' : 'ask';
}

/** Did the player DECLARE movement this turn? ("go to…", "I approach…", "we head over…") */
const MOVEMENT_DECLARED = /\b(go|goes|walk|walks|head|heads|run|runs|stride|strides|step|steps|move|moves)\s+(to|over|toward|towards|up to|closer|across|into|see)\b|\bapproach(es)?\b|\bfollow (him|her|them|the)\b/i;
/** Generic person-words → "the guy over there" targets the nearest visible NPC. */
const PERSON_WORDS = /\b(guy|guys|man|men|woman|women|person|people|villager|villagers|stranger|figure|folk|keeper|him|her|them)\b/i;

/**
 * TOKEN-TRUTH BACKSTOP (engine-owned, provider-proof). The playbook orders the DM to mirror declared
 * movement with an updateScene move, but LLM compliance is probabilistic — and the table shows tokens.
 * So after a narration-completing message turn: if the player declared movement and NO move was applied
 * for their PC, resolve the target deterministically (named object in the text > prop/fixture tag word >
 * person-word → nearest visible NPC) and apply the move mechanically. The engine stays authoritative:
 * anchors snap to free tiles, impossible moves are refused, and the applied delta rides the normal
 * TurnResult.deltas path (client tween + player-camera glide). No target confidently resolved → no move.
 */
/** Which map objects does this narration TALK ABOUT? Named objects by name; story props by tag
 *  words (weir/rope/bell/ring/…). Powers the live table's story pings. Cap 6, dedup'd. */
export function extractMentions(map: SceneMap | undefined, narration: string): string[] {
  if (!map || !narration) return [];
  const text = narration.toLowerCase();
  const out: string[] = [];
  for (const o of map.objects) {
    if (o.visible === false || out.includes(o.id)) continue;
    if (o.name && text.includes(o.name.toLowerCase())) { out.push(o.id); continue; }
    if (o.kind !== 'actor') {
      const words = o.tag.split('_').filter((w) => w.length > 3);
      if (words.some((w) => new RegExp(`\\b${w}s?\\b`).test(text))) out.push(o.id);
    }
    if (out.length >= 6) break;
  }
  return out;
}

export function movementBackstop(engine: Engine, state: GameState, input: TurnInput, sceneDeltas: SceneDelta[]): void {
  if (input.kind !== 'message') return;
  const text = input.text.toLowerCase();
  if (!MOVEMENT_DECLARED.test(text)) return;
  const map = state.world?.currentLocationId ? state.world.locations[state.world.currentLocationId] : undefined;
  if (!map) return;
  const pcs = (map.objects ?? []).filter((o) => o.role === 'pc' && o.visible !== false);
  const speaker = (input.speakerId ?? '').trim().toLowerCase();
  const speakerPcs = pcs.filter((p) => (p.name ?? '').toLowerCase() === speaker);
  const moving = (speakerPcs.length ? speakerPcs : pcs).filter((p) => !sceneDeltas.some((d) => d.op === 'move' && d.id === p.id));
  if (moving.length === 0) return;

  const words = new Set(text.split(/[^a-z0-9]+/));
  const candidates = (map.objects ?? []).filter((o) => o.visible !== false && o.role !== 'pc');
  // 1. An object the text names outright ("I go to Mother Sedge", "walk to the well").
  let target = candidates.find((o) => o.name && text.includes(o.name.toLowerCase()));
  // 2. A prop/fixture whose tag words appear ("the rope", "that chest", "the weir").
  if (!target) target = candidates.find((o) => o.kind !== 'actor' && o.tag.split('_').some((w) => w.length > 2 && words.has(w)));
  // 3. "the guy over there" — nearest visible NPC to the (first) mover.
  if (!target && PERSON_WORDS.test(text)) {
    const from = moving[0]!;
    target = candidates
      .filter((o) => o.role === 'npc')
      .sort((a, b) => Math.abs(a.col - from.col) + Math.abs(a.row - from.row) - (Math.abs(b.col - from.col) + Math.abs(b.row - from.row)))[0];
  }
  if (!target) return; // nothing confidently resolvable — better no move than a wrong one

  if (SPATIAL_ON) {
    // SPATIAL R2: the backstop inherits real pathing + media gates. Engine-initiated ⇒ mode 'auto'
    // (a hazardous swim degrades to the waterline; it never suspends a roll the player didn't ask for).
    for (const p of moving) {
      const v = engine.travel({ actorId: p.id, to: { id: target!.id }, mode: 'auto' });
      if (v.at) sceneDeltas.push({ op: 'move', id: p.id, to: { col: v.at.col, row: v.at.row }, ...(v.pathCells?.length ? { via: v.pathCells } : {}) });
    }
    engine.record('engine', `Token backstop: routed ${moving.map((p) => p.id).join(', ')} toward ${target.name ?? target.id} via travel (declared movement had no move delta this turn).`, { backstop: true, targetId: target.id });
    return;
  }
  const res = engine.applySceneDeltas(moving.map((p) => ({ op: 'move' as const, id: p.id, to: { anchor: `near:${target!.id}` } })));
  if (res.applied.length) {
    sceneDeltas.push(...res.applied);
    engine.record('engine', `Token backstop: moved ${res.applied.map((d) => d.id).join(', ')} near ${target.name ?? target.id} (declared movement had no move delta this turn).`, { backstop: true, targetId: target.id });
  }
}

export async function runTurn(deps: OrchestratorDeps, input: TurnInput): Promise<TurnResult> {
  const { engine, llm } = deps;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const playbook = deps.playbook ?? DEFAULT_DM_PLAYBOOK;
  let tools = buildToolDefs(Boolean(deps.retriever), Boolean(deps.composer));
  const state = engine.getState();
  // SPEECH-ACT GATE (coherence leak ①): an information-seeking question must NOT silently execute a
  // move. On an 'ask' turn we withhold `travel`, skip the movement backstop, and reject PC-move ops
  // (below) — so the DM answers (queryScene + fiction) and hands control back, instead of committing
  // an unasked crossing (e.g. swimming a fighter across deep water because they wondered if they could).
  const answeringOnly = classifySpeechAct(input) === 'ask';
  if (answeringOnly) tools = tools.filter((t) => t.name !== 'travel');
  // Bind NPC dialogue to the oracle: if the player addresses a named NPC across a gap, the DM is told
  // the real distance so the reply happens AT that distance (shout/beckon), not at the shoulder.
  const socialNote = SPATIAL_ON ? addresseeSpatialNote(engine, state, input) : '';

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
  let sceneProvenance: SceneProvenance | undefined; // how the scene came to be (response-only)
  const sceneDeltas: SceneDelta[] = []; // APPLIED updateScene/combat-sync ops this turn (normalized tiles)
  let beatTransition: TurnResult['beat']; // an advanceScene landed this turn (title card client-side)
  let firedExemplars: TurnResult['exemplars']; // style exemplars injected this turn (Technique B)

  const span = (deps.tracer ?? NOOP_TRACER).startTurn({
    sessionId: state.sessionId,
    speaker: input.kind === 'message' ? input.speakerId : input.kind === 'roll' ? 'roll' : 'opening',
    input: input.kind === 'message' ? input.text : input.kind === 'roll' ? `declared roll ${input.total}` : 'session start',
  });
  const finish = (result: TurnResult): TurnResult => {
    if (firedExemplars && !result.exemplars) result.exemplars = firedExemplars;
    span.end({
      narration: result.narration,
      costUsd: result.costUsd,
      model: result.model,
      latencyMs: now() - startedAt,
      toolCalls: toolCallLog,
    });
    return result;
  };

  // SPATIAL ②: a travel this turn actually SWAM — the final narration must show the water. Declared
  // HERE (above the roll branch) so a rough-water swim that suspended and completes on THIS resume turn
  // arms the fidelity gate too — the gated crossing is the exact "the die's verdict binds the prose" case.
  let crossedWater = false;
  let fidelityRetries = 0; // bounded: at most one re-narration if the prose denies the swim

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
    // SPATIAL R2: a suspended swim gate resolves ENGINE-SIDE before the LLM resumes — success
    // completes the crossing (deltas ride the normal path), failure fail-forwards (the world moves).
    let travelFacts: string[] = [];
    if (pending.travelContinuation && result.accepted) {
      crossedWater = true; // a travelContinuation IS a swim gate — success completes the swim, failure spits them back wet; either way the prose must show water
      const tcn = pending.travelContinuation;
      try {
        if (result.success === true) {
          const v = engine.travel({ actorId: tcn.actorId, to: { id: tcn.toId ?? '' }, gatePassed: true });
          if (v.at) sceneDeltas.push({ op: 'move', id: tcn.actorId, to: { col: v.at.col, row: v.at.row }, ...(v.pathCells?.length ? { via: v.pathCells } : {}) });
          travelFacts = v.facts;
        } else {
          travelFacts = engine.swimGateFail(tcn.actorId);
          const map = currentMap(state);
          const obj = map?.objects.find((o) => o.id === tcn.actorId);
          if (obj) sceneDeltas.push({ op: 'move', id: tcn.actorId, to: { col: obj.col, row: obj.row } });
        }
      } catch { /* travel resume must never break the turn */ }
    }
    messages = (pending.history as LlmMessage[]).slice();
    const toolResults: LlmContentBlock[] = [
      ...pending.resolvedToolResults.map((r) => ({ type: 'tool_result' as const, toolUseId: r.toolUseId, content: r.content })),
      { type: 'tool_result', toolUseId: pending.rollToolUseId, content: JSON.stringify(travelFacts.length ? { ...result, travel: travelFacts } : result) },
    ];
    messages.push({ role: 'user', content: toolResults });
    state.pendingTurn = undefined;
  } else {
    if (input.kind === 'message') engine.record('player', input.text, { speakerId: input.speakerId });
    state.turnCount = (state.turnCount ?? 0) + 1; // recency stamp for any facts the DM records this turn
    // Drop bare roll-declaration lines ("roll: 🎲 15") — they are mechanical noise, not narrative context.
    const recent = (deps.recentTranscript ?? []).filter((l) => !/^\s*roll\s*:/i.test(l)).slice(-12).join('\n');
    const adv = state.adventure;
    const scene = adv?.scenes[state.currentSceneId];
    // The beat's authored VISUAL design (Phase C): shown to the DM so narration + setScene align with
    // the designed look — and independently fed to the generator via ctx (belt AND suspenders).
    const planLine = scene?.scenePlan
      ? `Scene look (honor it in narration and in setScene): ${scene.scenePlan.look} [kind: ${scene.scenePlan.kind}; mood: ${scene.scenePlan.mood}${scene.scenePlan.features?.length ? `; features: ${scene.scenePlan.features.join(', ')}` : ''}]\n`
      : '';
    const gmBlock = adv
      ? `=== ADVENTURE (GM guidance — run this scene; reveal it through play, don't read aloud verbatim) ===\n` +
        `Premise: ${adv.pitch}\nCurrent scene — ${scene?.title ?? state.currentSceneId}: ${scene?.summary ?? ''}\n${planLine}\n`
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
      // Dirty-bit over the VALUES (not just the count) of decision:/npc: flags, so flipping an existing
      // flag (e.g. npc:edda=hostile after being friendly) re-plans — key-count alone would miss it.
      const flagSig = Object.entries(state.flags)
        .filter(([k]) => k.startsWith('decision:') || k.startsWith('npc:'))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => `${k}=${v}`)
        .join('|');
      const due = !arc.brief || arc.plannedForScene !== state.currentSceneId || arc.plannedFlagSig !== flagSig;
      if (due) {
        try {
          const { brief, costUsd: planCost } = await deps.arcPlanner.plan({ ...planInput, ...(arc.blueprint ? { blueprint: arc.blueprint } : {}) });
          arc.brief = brief;
          arc.plannedForScene = state.currentSceneId;
          arc.plannedFlagSig = flagSig;
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
      const npcs = npcStandings(state.flags);
      steering =
        `=== STEERING (soft — OFFER these as the fiction allows; never force. advanceScene only when the party goes there) ===\n` +
        `Reachable beats from here: ${exits.join(', ') || '(none — this beat resolves the arc)'}\n` +
        (beatsDone.length ? `Beats done: ${beatsDone.join(', ')}\n` : '') +
        (decisions.length ? `Decisions so far: ${decisions.join(', ')}\n` : '') +
        (npcs.length ? `NPC standings (keep consistent): ${npcs.join(', ')}\n` : '') +
        `\n`;
    }
    // CANON: the ledger slice relevant to what's being discussed this turn (established truth to honor).
    const playerLine = input.kind === 'message' ? input.text : '';
    const canon = canonBlock(state, [scene?.summary ?? '', recent, playerLine].join(' '));
    // STYLE EXEMPLARS (Technique B): retrieve 2 real-DM beats matched to THIS moment's register and
    // inject them into the volatile per-turn block (system prompt stays cache-eligible). Voice only —
    // guarded against content copying; retrieval failure never breaks a turn.
    let exemplarBlock = '';
    if (deps.exemplars) {
      try {
        const mt = predictMoveType(input, state);
        const exclude = new Set(deps.excludeExemplarIds ?? []);
        const hits = await deps.exemplars.retrieve([scene?.summary?.slice(0, 300) ?? '', playerLine || 'the session opens; establish the scene'].join('\n'), 2, mt, exclude);
        if (hits.length) {
          exemplarBlock =
            `=== STYLE EXEMPLARS (how a real DM plays this kind of beat — match the cadence, rhythm, and length; NEVER copy their names, places, or plot) ===\n` +
            `These shape your PROSE ONLY. They never override your rules: if a roll, a rule lookup, or any tool is called for, do that FIRST exactly as instructed — then narrate in this register.\n` +
            hits.map((h, i) => `${i + 1}. ${h.cue ? `[${h.cue.slice(0, 140)}]\n   ` : ''}DM: ${h.text.slice(0, 600)}`).join('\n') +
            '\n\n';
          firedExemplars = hits.map((h) => ({ id: h.id, moveType: h.moveType, source: h.source }));
        }
      } catch {
        /* style retrieval must never break a turn */
      }
    }
    messages = [
      {
        role: 'user',
        content:
          gmBlock +
          canon +
          steering +
          exemplarBlock +
          `=== CURRENT STATE (authoritative; from the engine) ===\n${summarizeState(state)}\n\n` +
          (recent ? `=== RECENT ===\n${recent}\n\n` : '') +
          (input.kind === 'opening'
            ? `=== SESSION START — OPENING NARRATION ===\nThe session is beginning. Deliver the OPENING: vividly establish where the party is, the immediate situation and what's at stake, and what they can see/sense right now. CRITICALLY: make the party's PURPOSE plain in-fiction — why THEY came here and what they're after (the premise's hook); a table that doesn't know why it's here can't play. Then end by asking what they do. If a concrete location is established, call setScene. Do NOT request rolls, resolve actions, or advance scenes yet.`
            : `${socialNote}${answeringOnly ? `[This line is a QUESTION, not a declared move. ANSWER it — for anything about distance, a route, reachability, or "do we need a boat" feasibility, call queryScene first ('distance'/'path'/'los'/'whereis'/'near') and narrate from its facts. Do NOT move any token this turn; let the player decide whether to actually go.]\n` : ''}${input.speakerId}: ${input.text}`),
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
      // SPATIAL ② — FIDELITY GATE: the travel verdict swam, but the prose denies the water. Re-narrate
      // once (the flawed line is already in `messages`) so the crossing reads as the swim it was — the
      // spatial verdict BINDS the narration, exactly as a die result does. Bounded to one retry.
      if (crossedWater && res.text && narrationDeniesWater(res.text) && fidelityRetries < 1 && steps < MAX_STEPS) {
        fidelityRetries++;
        span.event('fidelity-renarrate', { reason: 'swim narrated as dry' });
        messages.push({ role: 'user', content: `[FIDELITY: the travel this turn crossed DEEP WATER — the character SWAM (the engine's verdict). Your narration shows a dry crossing and never mentions the water. Rewrite the narration so the swim/wade through cold water is clear — same events, corrected. Narrate only; call no tools.]` });
        continue;
      }
      if (res.text) engine.record('narration', res.text);
      if (!answeringOnly) movementBackstop(engine, state, input, sceneDeltas); // token truth: declared movement always lands on the table (never on a question)
      const mentioned = extractMentions(currentMap(state), res.text);
      return finish({ narration: res.text, costUsd, model: lastModel, trace: makeTrace(), ...(mentioned.length ? { mentions: mentioned } : {}), ...sceneDelta() });
    }

    // Dispatch tool calls: resolve engine-immediate ones; suspend on a roll request.
    const resolved: { toolUseId: string; content: string }[] = [];
    let roll: { toolUseId: string; id: string; expr: string; reason: string; dc?: number } | undefined;
    let travelGate: { actorId: string; toId: string } | undefined; // SPATIAL R2: a travel suspended on a swim gate
    for (const tc of res.toolCalls) {
      toolCallLog.push(tc.name);
      span.event(`tool:${tc.name}`);
      if (tc.name === 'requestRoll' && !roll) {
        let expr = typeof tc.input.expr === 'string' ? tc.input.expr : '1d20';
        let reason = typeof tc.input.reason === 'string' ? tc.input.reason : 'check';
        const dc = typeof tc.input.dc === 'number' ? tc.input.dc : undefined;
        // P3e: when the DM names a character + ability, the ENGINE supplies the modifier (ability +
        // proficiency/expertise/exhaustion) and builds the die expression, so the +N on a check/save is
        // engine-owned rather than invented. Unknown combatant / bad ability falls back to the DM's expr.
        const combatantId = engine.findCombatantId(typeof tc.input.combatantId === 'string' ? tc.input.combatantId : '') ?? '';
        const ability = typeof tc.input.ability === 'string' ? tc.input.ability : '';
        if (combatantId && (ABILITIES as readonly string[]).includes(ability)) {
          try {
            const skill = typeof tc.input.skill === 'string' && tc.input.skill in SKILLS ? (tc.input.skill as Skill) : undefined;
            const m =
              tc.input.save === true
                ? engine.saveModifier({ combatantId, ability: ability as Ability })
                : engine.checkModifier({ combatantId, ability: ability as Ability, ...(skill ? { skill } : {}) });
            expr = `1d20${m >= 0 ? '+' : ''}${m}`;
            const label = tc.input.save === true ? `${ability.toUpperCase()} save` : skill ? `${skill} check` : `${ability.toUpperCase()} check`;
            reason = `${reason} [${label}, engine bonus ${m >= 0 ? '+' : ''}${m}]`;
          } catch {
            /* unknown combatant → keep the DM's expr */
          }
        }
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
          if (existed) {
            // Re-entry: the frozen map is reused verbatim — record that honestly.
            sceneProvenance = { locationId: est.locationId, engine: 'frozen', reused: true, toolInput: tc.input as Record<string, unknown>, establish: est };
          }
          if (!map) {
            // First visit — the MODERN engine gets first refusal (all kinds via the programmer path),
            // the classic Composer + Cartographer is the decline/failure fallback — then FREEZE.
            const party = Object.values(state.combatants)
              .filter((c) => c.kind === 'pc')
              .map((c) => ({ id: c.id, spriteTag: c.spriteTag ?? 'knight', name: c.name }));
            if (deps.realizeScene) {
              // The campaign fiction the tool call can't carry: premise + the current beat (+ its
              // authored ScenePlan when the arc composer produced one) — so the generator hears
              // "gothic horror" even when the DM's own setting string is short.
              const beatId = state.currentSceneId;
              const beat = state.adventure?.scenes?.[beatId];
              const premise = state.arc?.blueprint?.premise ?? state.adventure?.pitch;
              const ctx: SceneRealizeContext = {
                ...(premise ? { premise } : {}),
                ...(beat ? { beat: { id: beatId, title: beat.title, summary: beat.summary } } : {}),
                ...(beat?.scenePlan ? { scenePlan: beat.scenePlan } : {}),
              };
              try {
                const res = await deps.realizeScene(est, party, ctx);
                if (res) {
                  map = res.sceneMap;
                  sceneProvenance = { ...res.provenance, toolInput: tc.input as Record<string, unknown> };
                }
              } catch { map = undefined; /* modern engine failed → classic path below */ }
            }
            if (!map) {
              const comp = await deps.composer.compose({ establish: est, party, seed: seedFor(est.locationId) });
              map = buildSceneMap(comp);
              sceneProvenance = {
                locationId: est.locationId,
                engine: deps.composer.constructor?.name === 'FakeSceneComposer' ? 'fake' : 'classic',
                reused: false,
                toolInput: tc.input as Record<string, unknown>,
                establish: est,
              };
            }
            world.locations[est.locationId] = map;
            if (world.currentLocationId && world.currentLocationId !== est.locationId) world.links.push({ from: world.currentLocationId, to: est.locationId });
          }
          world.currentLocationId = est.locationId;
          sceneChanged = true;
          sceneMap = map;
          span.event('setScene', { locationId: est.locationId, engine: sceneProvenance?.engine, reused: existed, lighting: map.lighting });
          resolved.push({
            toolUseId: tc.id,
            content: `Scene ${existed ? 'reused' : 'set'}: ${map.biome} (${map.lighting}), ${map.grid.cols}x${map.grid.rows}. Present: ${map.objects.filter((o) => o.visible).map((o) => o.id).join(', ')}.${SPATIAL_ON ? castPositionsBlock(map) : ''}`,
          });
        } catch {
          resolved.push({ toolUseId: tc.id, content: 'Scene setup failed; continue narrating.' });
        }
      } else if (tc.name === 'updateScene' && deps.composer) {
        // The DM mirrors narrated movement/appearances on the live map. The engine owns exact tiles:
        // it snaps to free ground and refuses impossible ops with narratable reasons.
        const changes = Array.isArray(tc.input.changes) ? (tc.input.changes as Record<string, unknown>[]) : [];
        const proposals: SceneDelta[] = [];
        const preRejected: { op: string; id: string; reason: string }[] = [];
        for (const c of changes.slice(0, 16)) {
          const op = String(c.op ?? '');
          const id = String(c.id ?? '');
          if (op === 'move') {
            // Speech-act gate: on an 'ask' turn a PC never moves — the player asked, they didn't declare it.
            if (answeringOnly && id.startsWith('pc:')) { preRejected.push({ op, id, reason: 'the player is asking, not declaring a move — answer their question; do not move them' }); continue; }
            if (typeof c.to !== 'string' || !c.to.trim()) { preRejected.push({ op, id, reason: 'move needs a "to" anchor' }); continue; }
            proposals.push({ op: 'move', id, to: { anchor: c.to.trim() } });
          } else if (op === 'face') {
            proposals.push({ op: 'face', id, facing: String(c.facing ?? '') as never });
          } else if (op === 'reveal' || op === 'hide' || op === 'despawn') {
            proposals.push({ op, id });
          } else if (op === 'setState') {
            const state = c.state && typeof c.state === 'object' ? (c.state as Record<string, string | number | boolean>) : undefined;
            if (!state) { preRejected.push({ op, id, reason: 'setState needs a "state" object' }); continue; }
            proposals.push({ op: 'setState', id, state });
          } else if (op === 'spawn') {
            const role = c.role === 'mob' ? 'mob' as const : 'npc' as const;
            const look = typeof c.look === 'string' ? c.look : '';
            const name = typeof c.name === 'string' ? c.name : undefined;
            proposals.push({
              op: 'spawn', id, kind: 'actor', role,
              tag: lookToSprite(`${look} ${name ?? ''} ${id}`),
              ...(name ? { name } : {}),
              anchor: typeof c.to === 'string' && c.to.trim() ? c.to.trim() : 'center',
              ...(c.visible === false ? { visible: false } : {}),
            });
          } else {
            preRejected.push({ op, id, reason: `unknown op "${op}"` });
          }
        }
        const res = engine.applySceneDeltas(proposals);
        sceneDeltas.push(...res.applied);
        const rej = [...preRejected, ...res.rejected.map((r) => ({ op: r.delta.op, id: 'id' in r.delta ? r.delta.id : '', reason: r.reason }))];
        resolved.push({
          toolUseId: tc.id,
          content: JSON.stringify({
            applied: res.applied.map((a) => (a.op === 'move' ? `move ${a.id} → (${(a.to as { col: number }).col},${(a.to as { row: number }).row})` : a.op === 'spawn' ? `spawn ${a.id} at (${a.at?.col},${a.at?.row})` : `${a.op} ${a.id}`)),
            ...(rej.length ? { rejected: rej } : {}),
          }),
        });
      } else if (tc.name === 'startEncounter') {
        try {
          const r = engine.startEncounter(); // engine resolves the encounter from the current scene
          // COMBAT SYNC: monsters that just entered initiative POP ONTO the map — one spawn delta per
          // combatant that has no token yet, placed near the first PC. Engine-owned; the DM does nothing.
          const world = state.world;
          const map = world?.currentLocationId ? world.locations[world.currentLocationId] : undefined;
          if (map && r.spawned.length) {
            const firstPc = map.objects.find((o) => o.role === 'pc');
            const spawnDeltas: SceneDelta[] = r.spawned
              .filter((id) => !map.objects.some((o) => o.id === id))
              .map((id) => {
                const cb = engine.getState().combatants[id];
                return {
                  op: 'spawn' as const, id, kind: 'actor' as const, role: 'mob' as const,
                  tag: cb?.spriteTag ?? lookToSprite(cb?.name ?? id),
                  ...(cb?.name ? { name: cb.name } : {}),
                  anchor: firstPc ? `near:${firstPc.id}` : 'center',
                };
              });
            sceneDeltas.push(...engine.applySceneDeltas(spawnDeltas).applied);
          }
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ started: true, ...r }) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ started: false, error: (e as Error).message }) });
        }
      } else if (tc.name === 'applyDamage') {
        try {
          const amount = Number(tc.input.amount);
          const r = engine.applyDamage({ targetId: (engine.findCombatantId(String(tc.input.targetId ?? '')) ?? String(tc.input.targetId ?? '')), amount: Number.isFinite(amount) ? amount : 0, type: String(tc.input.type ?? 'bludgeoning') as DamageType });
          resolved.push({ toolUseId: tc.id, content: JSON.stringify(r) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: (e as Error).message }) });
        }
      } else if (tc.name === 'heal') {
        try {
          const amount = Number(tc.input.amount);
          const r = engine.heal({ targetId: (engine.findCombatantId(String(tc.input.targetId ?? '')) ?? String(tc.input.targetId ?? '')), amount: Number.isFinite(amount) ? amount : 0 });
          resolved.push({ toolUseId: tc.id, content: JSON.stringify(r) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: (e as Error).message }) });
        }
      } else if (tc.name === 'rollDeathSave') {
        try {
          const r = engine.rollDeathSave((engine.findCombatantId(String(tc.input.combatantId ?? '')) ?? String(tc.input.combatantId ?? '')));
          resolved.push({ toolUseId: tc.id, content: JSON.stringify(r) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: (e as Error).message }) });
        }
      } else if (tc.name === 'endEncounter') {
        const r = engine.endCombat();
        // COMBAT SYNC: the fallen's tokens leave the map when the fight ends (survivors stay).
        {
          const world = state.world;
          const map = world?.currentLocationId ? world.locations[world.currentLocationId] : undefined;
          if (map) {
            const downedIds = Object.values(state.combatants)
              .filter((c) => c.kind !== 'pc' && c.downed && map.objects.some((o) => o.id === c.id))
              .map((c) => c.id);
            if (downedIds.length) sceneDeltas.push(...engine.applySceneDeltas(downedIds.map((id) => ({ op: 'despawn' as const, id }))).applied);
          }
        }
        resolved.push({ toolUseId: tc.id, content: JSON.stringify({ ended: true, ...r }) });
      } else if (tc.name === 'advanceScene') {
        try {
          const outcome = ['resolved', 'fled', 'done'].includes(String(tc.input.outcome)) ? (String(tc.input.outcome) as 'resolved' | 'fled' | 'done') : undefined;
          const r = engine.advanceScene(String(tc.input.toSceneId ?? ''), outcome);
          // A beat transition is a LEGIBLE dramatic moment: report it on the turn (title card client-side)
          // and DIRECT the DM to establish the new beat's location NOW — with its authored visual brief —
          // so one turn delivers beat + scene (tool results loop within the same turn).
          const toBeat = state.adventure?.scenes?.[r.scene];
          beatTransition = { from: r.from, to: r.scene, ...(toBeat?.title ? { title: toBeat.title } : {}), ...(outcome ? { outcome } : {}) };
          const visual = beatVisualBrief(state, r.scene);
          resolved.push({
            toolUseId: tc.id,
            content: JSON.stringify({
              advanced: true,
              ...r,
              directive: `Beat advanced to "${toBeat?.title ?? r.scene}". Establish its location NOW with setScene (a NEW locationId — this is a different place).${visual ? ` Visual brief: ${visual}` : ''}`,
            }),
          });
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
      } else if (tc.name === 'upsertNpc') {
        try {
          const i = tc.input;
          const rawId = String(i.id ?? '');
          const id = /^[a-z]+:/i.test(rawId) ? rawId : `npc:${slug(rawId || String(i.name ?? ''))}`;
          const voice = { ...(i.tic ? { tic: String(i.tic) } : {}), ...(i.want ? { want: String(i.want) } : {}), ...(i.fear ? { fear: String(i.fear) } : {}) };
          const e = engine.upsertEntity({
            id,
            kind: 'npc',
            name: String(i.name ?? ''),
            ...(Object.keys(voice).length ? { voice } : {}),
            ...(typeof i.status === 'string' ? { status: i.status as EntityCard['status'] } : {}),
            ...(Array.isArray(i.aliases) ? { aliases: i.aliases.map(String) } : {}),
            scenes: [state.currentSceneId],
          });
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ ok: true, id: e.id, status: e.status }) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: (e as Error).message }) });
        }
      } else if (tc.name === 'recordFact') {
        try {
          const f = engine.recordFact({ subject: String(tc.input.subject ?? ''), attribute: String(tc.input.attribute ?? ''), value: String(tc.input.value ?? '') });
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ ok: true, id: f.id }) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: (e as Error).message }) });
        }
      } else if (tc.name === 'spendResource') {
        try {
          const r = engine.spendResource({
            combatantId: (engine.findCombatantId(String(tc.input.combatantId ?? '')) ?? String(tc.input.combatantId ?? '')),
            resource: String(tc.input.resource ?? ''),
            ...(tc.input.level !== undefined ? { level: Number(tc.input.level) } : {}),
            ...(tc.input.amount !== undefined ? { amount: Number(tc.input.amount) } : {}),
          });
          resolved.push({ toolUseId: tc.id, content: JSON.stringify(r) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: (e as Error).message }) });
        }
      } else if (tc.name === 'shortRest') {
        try {
          const r = engine.shortRest({
            combatantId: (engine.findCombatantId(String(tc.input.combatantId ?? '')) ?? String(tc.input.combatantId ?? '')),
            ...(tc.input.spendHitDice !== undefined ? { spendHitDice: Number(tc.input.spendHitDice) } : {}),
            ...(tc.input.rolledTotal !== undefined ? { rolledTotal: Number(tc.input.rolledTotal) } : {}),
          });
          resolved.push({ toolUseId: tc.id, content: JSON.stringify(r) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: (e as Error).message }) });
        }
      } else if (tc.name === 'longRest') {
        try {
          const ids = Array.isArray(tc.input.combatantIds) ? tc.input.combatantIds.map(String) : undefined;
          const r = engine.longRest(ids && ids.length ? { combatantIds: ids } : undefined);
          resolved.push({ toolUseId: tc.id, content: JSON.stringify(r) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: (e as Error).message }) });
        }
      } else if (tc.name === 'setExhaustion') {
        try {
          const r = engine.setExhaustion({ combatantId: (engine.findCombatantId(String(tc.input.combatantId ?? '')) ?? String(tc.input.combatantId ?? '')), level: Number(tc.input.level) });
          resolved.push({ toolUseId: tc.id, content: JSON.stringify(r) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: (e as Error).message }) });
        }
      } else if (tc.name === 'grantInspiration') {
        try {
          engine.grantInspiration({ combatantId: (engine.findCombatantId(String(tc.input.combatantId ?? '')) ?? String(tc.input.combatantId ?? '')) });
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ ok: true }) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: (e as Error).message }) });
        }
      } else if (tc.name === 'spendInspiration') {
        try {
          const r = engine.spendInspiration({ combatantId: (engine.findCombatantId(String(tc.input.combatantId ?? '')) ?? String(tc.input.combatantId ?? '')) });
          resolved.push({ toolUseId: tc.id, content: JSON.stringify(r) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: (e as Error).message }) });
        }
      } else if (tc.name === 'startConcentration') {
        try {
          engine.startConcentration({ combatantId: (engine.findCombatantId(String(tc.input.combatantId ?? '')) ?? String(tc.input.combatantId ?? '')), spell: String(tc.input.spell ?? '') });
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ ok: true }) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: (e as Error).message }) });
        }
      } else if (tc.name === 'breakConcentration') {
        try {
          const r = engine.breakConcentration({ combatantId: (engine.findCombatantId(String(tc.input.combatantId ?? '')) ?? String(tc.input.combatantId ?? '')) });
          resolved.push({ toolUseId: tc.id, content: JSON.stringify(r) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: (e as Error).message }) });
        }
      } else if (tc.name === 'awardXp') {
        try {
          const r = engine.awardXp({ combatantId: (engine.findCombatantId(String(tc.input.combatantId ?? '')) ?? String(tc.input.combatantId ?? '')), amount: Number(tc.input.amount) });
          resolved.push({ toolUseId: tc.id, content: JSON.stringify(r) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: (e as Error).message }) });
        }
      } else if (tc.name === 'levelUp') {
        try {
          const hpMode = tc.input.hpMode === 'roll' ? 'roll' : tc.input.hpMode === 'avg' ? 'avg' : undefined;
          const r = engine.levelUp({
            combatantId: (engine.findCombatantId(String(tc.input.combatantId ?? '')) ?? String(tc.input.combatantId ?? '')),
            ...(hpMode ? { hpMode } : {}),
            ...(tc.input.rolledTotal !== undefined ? { rolledTotal: Number(tc.input.rolledTotal) } : {}),
          });
          resolved.push({ toolUseId: tc.id, content: JSON.stringify(r) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: (e as Error).message }) });
        }
      } else if (tc.name === 'setMilestoneLevel') {
        try {
          const r = engine.setMilestoneLevel({ combatantId: (engine.findCombatantId(String(tc.input.combatantId ?? '')) ?? String(tc.input.combatantId ?? '')), level: Number(tc.input.level) });
          resolved.push({ toolUseId: tc.id, content: JSON.stringify(r) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: (e as Error).message }) });
        }
      } else if (tc.name === 'buyItem') {
        try {
          const r = engine.buyItem({ combatantId: (engine.findCombatantId(String(tc.input.combatantId ?? '')) ?? String(tc.input.combatantId ?? '')), itemDefId: String(tc.input.itemDefId ?? ''), ...(tc.input.qty !== undefined ? { qty: Number(tc.input.qty) } : {}) });
          resolved.push({ toolUseId: tc.id, content: JSON.stringify(r) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: (e as Error).message }) });
        }
      } else if (tc.name === 'sellItem') {
        try {
          const r = engine.sellItem({ combatantId: (engine.findCombatantId(String(tc.input.combatantId ?? '')) ?? String(tc.input.combatantId ?? '')), ...(tc.input.instanceId !== undefined ? { instanceId: String(tc.input.instanceId) } : {}), ...(tc.input.itemDefId !== undefined ? { itemDefId: String(tc.input.itemDefId) } : {}), ...(tc.input.qty !== undefined ? { qty: Number(tc.input.qty) } : {}) });
          resolved.push({ toolUseId: tc.id, content: JSON.stringify(r) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: (e as Error).message }) });
        }
      } else if (tc.name === 'addItem') {
        try {
          const r = engine.addItem({ combatantId: (engine.findCombatantId(String(tc.input.combatantId ?? '')) ?? String(tc.input.combatantId ?? '')), itemDefId: String(tc.input.itemDefId ?? ''), ...(tc.input.qty !== undefined ? { qty: Number(tc.input.qty) } : {}) });
          resolved.push({ toolUseId: tc.id, content: JSON.stringify(r) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: (e as Error).message }) });
        }
      } else if (tc.name === 'removeItem') {
        try {
          const r = engine.removeItem({ combatantId: (engine.findCombatantId(String(tc.input.combatantId ?? '')) ?? String(tc.input.combatantId ?? '')), ...(tc.input.instanceId !== undefined ? { instanceId: String(tc.input.instanceId) } : {}), ...(tc.input.itemDefId !== undefined ? { itemDefId: String(tc.input.itemDefId) } : {}), ...(tc.input.qty !== undefined ? { qty: Number(tc.input.qty) } : {}) });
          resolved.push({ toolUseId: tc.id, content: JSON.stringify(r) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: (e as Error).message }) });
        }
      } else if (tc.name === 'equipItem') {
        try {
          const r = engine.equipItem({ combatantId: (engine.findCombatantId(String(tc.input.combatantId ?? '')) ?? String(tc.input.combatantId ?? '')), instanceId: String(tc.input.instanceId ?? '') });
          resolved.push({ toolUseId: tc.id, content: JSON.stringify(r) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: (e as Error).message }) });
        }
      } else if (tc.name === 'unequipItem') {
        try {
          const slot = ['armor', 'shield', 'mainHand', 'offHand', 'ranged'].includes(String(tc.input.slot)) ? (String(tc.input.slot) as 'armor' | 'shield' | 'mainHand' | 'offHand' | 'ranged') : undefined;
          const r = engine.unequipItem({ combatantId: (engine.findCombatantId(String(tc.input.combatantId ?? '')) ?? String(tc.input.combatantId ?? '')), ...(slot ? { slot } : {}), ...(tc.input.instanceId !== undefined ? { instanceId: String(tc.input.instanceId) } : {}) });
          resolved.push({ toolUseId: tc.id, content: JSON.stringify(r) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: (e as Error).message }) });
        }
      } else if (tc.name === 'attuneItem') {
        try {
          const r = engine.attuneItem({ combatantId: (engine.findCombatantId(String(tc.input.combatantId ?? '')) ?? String(tc.input.combatantId ?? '')), instanceId: String(tc.input.instanceId ?? '') });
          resolved.push({ toolUseId: tc.id, content: JSON.stringify(r) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: (e as Error).message }) });
        }
      } else if (tc.name === 'unattuneItem') {
        try {
          const r = engine.unattuneItem({ combatantId: (engine.findCombatantId(String(tc.input.combatantId ?? '')) ?? String(tc.input.combatantId ?? '')), instanceId: String(tc.input.instanceId ?? '') });
          resolved.push({ toolUseId: tc.id, content: JSON.stringify(r) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: (e as Error).message }) });
        }
      } else if (tc.name === 'identifyItem') {
        try {
          const r = engine.identifyItem({ combatantId: (engine.findCombatantId(String(tc.input.combatantId ?? '')) ?? String(tc.input.combatantId ?? '')), instanceId: String(tc.input.instanceId ?? '') });
          resolved.push({ toolUseId: tc.id, content: JSON.stringify(r) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: (e as Error).message }) });
        }
      } else if (tc.name === 'revive') {
        try {
          const r = engine.revive({ combatantId: (engine.findCombatantId(String(tc.input.combatantId ?? '')) ?? String(tc.input.combatantId ?? '')), ...(tc.input.hpRestored !== undefined ? { hpRestored: Number(tc.input.hpRestored) } : {}) });
          resolved.push({ toolUseId: tc.id, content: JSON.stringify(r) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: (e as Error).message }) });
        }
      } else if (tc.name === 'prepareSpells') {
        try {
          const prepared = Array.isArray(tc.input.prepared) ? tc.input.prepared.map(String) : [];
          const r = engine.prepareSpells({ combatantId: (engine.findCombatantId(String(tc.input.combatantId ?? '')) ?? String(tc.input.combatantId ?? '')), prepared });
          resolved.push({ toolUseId: tc.id, content: JSON.stringify(r) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: (e as Error).message }) });
        }
      } else if (tc.name === 'castRitual') {
        try {
          const r = engine.castRitual({ combatantId: (engine.findCombatantId(String(tc.input.combatantId ?? '')) ?? String(tc.input.combatantId ?? '')), spell: String(tc.input.spell ?? '') });
          resolved.push({ toolUseId: tc.id, content: JSON.stringify(r) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: (e as Error).message }) });
        }
      } else if (tc.name === 'placePoi') {
        try {
          const i = tc.input;
          const c = i.contents && typeof i.contents === 'object' ? (i.contents as Record<string, unknown>) : null;
          const contents = c
            ? {
                ...(Array.isArray(c.items) ? { items: (c.items as unknown[]).map((x) => { const xx = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>; return { itemDefId: String(xx.itemDefId ?? ''), ...(xx.qty !== undefined ? { qty: Number(xx.qty) } : {}) }; }) } : {}),
                ...(c.gold !== undefined ? { gold: Number(c.gold) } : {}),
              }
            : undefined;
          const r = engine.placePoi({
            id: String(i.id ?? ''),
            kind: String(i.kind ?? 'feature') as PoiKind,
            look: String(i.look ?? ''),
            ...(typeof i.anchor === 'string' ? { anchor: i.anchor } : {}),
            ...(i.hidden !== undefined ? { hidden: !!i.hidden } : {}),
            ...(i.discoverDc !== undefined ? { discoverDc: Number(i.discoverDc) } : {}),
            ...(contents ? { contents } : {}),
            ...(typeof i.leadsTo === 'string' ? { leadsTo: i.leadsTo } : {}),
            ...(typeof i.notes === 'string' ? { notes: i.notes } : {}),
          });
          resolved.push({ toolUseId: tc.id, content: JSON.stringify(r) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: (e as Error).message }) });
        }
      } else if (tc.name === 'discoverPoi') {
        try {
          const r = engine.discoverPoi({ id: String(tc.input.id ?? ''), ...(typeof tc.input.by === 'string' ? { by: tc.input.by } : {}) });
          resolved.push({ toolUseId: tc.id, content: JSON.stringify(r) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: (e as Error).message }) });
        }
      } else if (tc.name === 'searchPoi') {
        try {
          const r = engine.searchPoi({ id: String(tc.input.id ?? '') });
          resolved.push({ toolUseId: tc.id, content: JSON.stringify(r) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: (e as Error).message }) });
        }
      } else if (tc.name === 'lootPoi') {
        try {
          const r = engine.lootPoi({ id: String(tc.input.id ?? ''), combatantId: (engine.findCombatantId(String(tc.input.combatantId ?? '')) ?? String(tc.input.combatantId ?? '')) });
          resolved.push({ toolUseId: tc.id, content: JSON.stringify(r) });
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: (e as Error).message }) });
        }
      } else if (tc.name === 'travel') {
        // SPATIAL R2: the single movement gate. A rough-water crossing suspends THROUGH the normal
        // roll machinery (pendingTurn stays the only suspension state); the continuation completes
        // or fail-forwards engine-side on resume — a 429 mid-swim can never strand the token wet.
        try {
          const map = currentMap(state);
          const actorObj = map ? resolveMapObject(engine, map, tc.input.actorId) : undefined;
          let targetObj = map && actorObj ? resolveMapObject(engine, map, tc.input.to, actorObj) : undefined;
          // PERSON-FIRST (coherence ④): the player's own words outrank the DM's guessed id. If the
          // line names exactly one visible NPC and the DM aimed elsewhere (a keeper, a building the
          // fiction claims they occupy), the destination is the PERSON — never the place. This is what
          // turns "walked to the forge, then found Hobb across the green" into one clean walk.
          let personNote = '';
          if (map && actorObj && input.kind === 'message') {
            // Which named NPCs does the line mention, and WHERE? ("I go to Hobb and ask if Orrin is
            // trustful" names two — the DESTINATION is the one right after the movement verb.)
            const firstIdx = (name: string): number => {
              let best = -1;
              for (const wd of name.split(/\s+/)) {
                if (wd.length <= 2) continue;
                const m = new RegExp(`\\b${wd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').exec(input.text);
                if (m && (best === -1 || m.index < best)) best = m.index;
              }
              return best;
            };
            const hits = map.objects
              .filter((o) => o.kind === 'actor' && o.role !== 'pc' && o.visible !== false && o.name)
              .map((o) => ({ o, idx: firstIdx(o.name!) }))
              .filter((h) => h.idx >= 0);
            const mv = /\b(?:go(?:es)?|walk(?:s)?|head(?:s)?|run(?:s)?|move(?:s)?|stride(?:s)?|approach(?:es)?|over|up)\s+(?:on\s+)?(?:to|toward|towards)?\s*/i.exec(input.text);
            let person: (typeof hits)[number]['o'] | undefined;
            if (hits.length === 1) person = hits[0]!.o;
            else if (hits.length > 1 && mv) {
              // the destination = the first name mentioned AFTER the movement verb
              const after = hits.filter((h) => h.idx >= mv.index).sort((a, b) => a.idx - b.idx);
              person = after[0]?.o;
            }
            if (person && targetObj && targetObj.id !== person.id) {
              personNote = `destination corrected to ${person.name} (${person.id}) — the person the player named; "${String(tc.input.to)}" was somewhere else. Narrate the approach to ${person.name} where they actually stand.`;
              targetObj = person;
            }
          }
          if (!map || !actorObj) {
            resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: `no actor "${String(tc.input.actorId)}" on this map` }) });
          } else if (!targetObj) {
            resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: `no destination "${String(tc.input.to)}" on this map — use an id/name from the MAP block` }) });
          } else {
            const v = engine.travel({ actorId: actorObj.id, to: { id: targetObj.id } });
            if (v.at) sceneDeltas.push({ op: 'move', id: actorObj.id, to: { col: v.at.col, row: v.at.row }, ...(v.pathCells?.length ? { via: v.pathCells } : {}) });
            if (v.moved && v.legs?.some((l) => l.swimming)) crossedWater = true; // the verdict swam — bind the prose (below)
            if (v.needsRoll && !roll) {
              // Gate → the SAME suspend-and-verdict loop dice already use, with the engine-owned modifier.
              let expr = '1d20';
              try {
                const m = engine.checkModifier({ combatantId: actorObj.id, ability: 'str', skill: 'athletics' });
                expr = `1d20${m >= 0 ? '+' : ''}${m}`;
              } catch { /* no sheet — flat d20 */ }
              const rr = engine.requestRoll({ expr, reason: v.needsRoll.reason, dc: v.needsRoll.dc });
              roll = { toolUseId: tc.id, id: rr.id, expr: rr.expr, reason: rr.reason, dc: v.needsRoll.dc };
              travelGate = { actorId: actorObj.id, toId: targetObj.id };
            } else {
              resolved.push({ toolUseId: tc.id, content: JSON.stringify({ ...v, at: undefined, ...(personNote ? { resolution: personNote } : {}) }) });
            }
          }
        } catch (e) {
          resolved.push({ toolUseId: tc.id, content: JSON.stringify({ error: (e as Error).message }) });
        }
      } else if (tc.name === 'queryScene') {
        resolved.push({ toolUseId: tc.id, content: answerSceneQuery(engine, state, tc.input) });
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
        ...(travelGate ? { travelContinuation: { actorId: travelGate.actorId, toId: travelGate.toId } } : {}),
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
  if (!answeringOnly) movementBackstop(engine, state, input, sceneDeltas); // token truth holds even on the MAX_STEPS fallback (never on a question)
  const mentionedF = extractMentions(currentMap(state), fallback);
  return finish({ narration: fallback, costUsd, model: lastModel, trace: makeTrace(), ...(mentionedF.length ? { mentions: mentionedF } : {}), ...sceneDelta() });

  function sceneDelta(): { sceneChanged?: boolean; sceneMap?: SceneMap } {
    return {
      ...(sceneChanged ? { sceneChanged: true, ...(sceneMap ? { sceneMap } : {}), ...(sceneProvenance ? { sceneProvenance } : {}) } : {}),
      ...(sceneDeltas.length ? { deltas: sceneDeltas } : {}),
      ...(beatTransition ? { beat: beatTransition } : {}),
    };
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
