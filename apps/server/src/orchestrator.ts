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

import { deriveProficiencyBonus, derivePassive, deriveSpellSaveDc, type Engine } from '@mythweaver/engine';
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
import { ABILITIES, SKILLS, isEntityId, type Ability, type ArcBrief, type CharacterSheet, type CharacterState, type Combatant, type DamageType, type EntityCard, type EstablishScene, type FixtureDecl, type GameState, type ItemDef, type NpcDecl, type PartyMemberRef, type PendingTurn, type SceneMap, type Skill } from '@mythweaver/shared';
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
  like "loc:mistmoor-green", a rich "setting" (terrain, structures, mood), the "biome"
  (village/forest/cave/dungeon) and "timeOfDay", and LIST what is present:
  - "fixtures": notable objects/structures, each { id ("prop:well" / "bldg:hall"), tag, anchor }.
  - "npcs": everyone present, each { id ("npc:edda"), name, look, anchor, visible } — set visible:false
    for anyone hidden/lurking (they are placed but unseen until revealed).
- Anchors are coordinate-free: "center", "north-edge", "waterside", "near:<id>". The game owns exact
  tiles. Reuse the SAME locationId when the party returns — the place is remembered, not rebuilt.

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
  brings them back.`;

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
  ].join('\n');
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
    state.turnCount = (state.turnCount ?? 0) + 1; // recency stamp for any facts the DM records this turn
    // Drop bare roll-declaration lines ("roll: 🎲 15") — they are mechanical noise, not narrative context.
    const recent = (deps.recentTranscript ?? []).filter((l) => !/^\s*roll\s*:/i.test(l)).slice(-12).join('\n');
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
    messages = [
      {
        role: 'user',
        content:
          gmBlock +
          canon +
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
        resolved.push({ toolUseId: tc.id, content: JSON.stringify({ ended: true, ...r }) });
      } else if (tc.name === 'advanceScene') {
        try {
          const outcome = ['resolved', 'fled', 'done'].includes(String(tc.input.outcome)) ? (String(tc.input.outcome) as 'resolved' | 'fled' | 'done') : undefined;
          const r = engine.advanceScene(String(tc.input.toSceneId ?? ''), outcome);
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
