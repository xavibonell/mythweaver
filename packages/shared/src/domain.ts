import type { WorldState } from './world.js';

/**
 * MythWeaver core domain types (D&D 5e SRD).
 *
 * These types are consumed by every package and by the content seed data
 * (`content/scenarios/...`). They describe AUTHORITATIVE game data; the
 * deterministic engine (spec §4.1) is the only thing allowed to mutate the
 * runtime state derived from them. The LLM never writes these — it reads them
 * and calls engine tools.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export type Ability = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';

export const ABILITIES: readonly Ability[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

/** SRD skills mapped to their governing ability. */
export const SKILLS = {
  acrobatics: 'dex',
  animalHandling: 'wis',
  arcana: 'int',
  athletics: 'str',
  deception: 'cha',
  history: 'int',
  insight: 'wis',
  intimidation: 'cha',
  investigation: 'int',
  medicine: 'wis',
  nature: 'int',
  perception: 'wis',
  performance: 'cha',
  persuasion: 'cha',
  religion: 'int',
  sleightOfHand: 'dex',
  stealth: 'dex',
  survival: 'wis',
} as const satisfies Record<string, Ability>;

export type Skill = keyof typeof SKILLS;

/** SRD conditions the engine tracks. */
export type Condition =
  | 'blinded'
  | 'charmed'
  | 'deafened'
  | 'frightened'
  | 'grappled'
  | 'incapacitated'
  | 'invisible'
  | 'paralyzed'
  | 'petrified'
  | 'poisoned'
  | 'prone'
  | 'restrained'
  | 'stunned'
  | 'unconscious';

export type DamageType =
  | 'acid'
  | 'bludgeoning'
  | 'cold'
  | 'fire'
  | 'force'
  | 'lightning'
  | 'necrotic'
  | 'piercing'
  | 'poison'
  | 'psychic'
  | 'radiant'
  | 'slashing'
  | 'thunder';

export type AbilityScores = Record<Ability, number>;

/** Roll advantage state for a single d20 resolution. */
export type AdvantageState = 'normal' | 'advantage' | 'disadvantage';

/** A dice expression in `NdX±M` form, e.g. "1d20+5", "2d6", "8d6-2". */
export type DiceExpr = string;

// ---------------------------------------------------------------------------
// Attacks & actions (shared by PCs and monsters)
// ---------------------------------------------------------------------------

export interface AttackAction {
  name: string;
  /** Total bonus added to the attack d20 (already includes proficiency + ability). */
  attackBonus: number;
  /** Damage dice, e.g. "1d6+2". */
  damage: DiceExpr;
  damageType: DamageType;
  /** Melee reach or ranged range, in feet, as printed (informational in v1). */
  reachOrRangeFt?: number;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Monsters (stat blocks)
// ---------------------------------------------------------------------------

export interface StatBlock {
  id: string;
  name: string;
  size: 'tiny' | 'small' | 'medium' | 'large' | 'huge' | 'gargantuan';
  type: string; // e.g. "humanoid (goblinoid)"
  armorClass: number;
  /** Average HP and the rolled formula, e.g. { average: 7, formula: "2d6" }. */
  hitPoints: { average: number; formula: DiceExpr };
  speedFt: number;
  abilities: AbilityScores;
  /** Challenge rating, as a number (1/8 -> 0.125). */
  challengeRating: number;
  proficiencyBonus: number;
  savingThrowProficiencies?: Ability[];
  skillProficiencies?: Partial<Record<Skill, number>>;
  damageResistances?: DamageType[];
  damageImmunities?: DamageType[];
  damageVulnerabilities?: DamageType[];
  conditionImmunities?: Condition[];
  senses?: string;
  attacks: AttackAction[];
  traits?: { name: string; text: string }[];
  /** Free-form provenance label for citation, e.g. "SRD 5.1" or "PHB p.255" (no licensing lock — spec §11). */
  source: string;
}

// ---------------------------------------------------------------------------
// Player characters (pre-gens in v1; OCR is a later phase)
// ---------------------------------------------------------------------------

export interface SpellcastingBlock {
  ability: Ability;
  spellSaveDc: number;
  spellAttackBonus: number;
  /** Slots per level, index 1..9. Index 0 unused. */
  slots: number[];
  cantrips: string[];
  prepared: string[];
}

export interface CharacterSheet {
  id: string;
  name: string;
  /** Ancestry/race + class as SRD names, for flavor + rules lookups. */
  ancestry: string;
  className: string;
  level: number;
  abilities: AbilityScores;
  proficiencyBonus: number;
  armorClass: number;
  maxHitPoints: number;
  speedFt: number;
  skillProficiencies: Skill[];
  savingThrowProficiencies: Ability[];
  attacks: AttackAction[];
  spellcasting?: SpellcastingBlock;
  features?: { name: string; text: string }[];
  inventory?: string[];
  /** Freeform origin/motivation (player-authored, or Director-invented). Woven into the arc + NPCs
   *  and injected as canon so the DM keeps the story about who the characters are. */
  backstory?: string;
  // --- Character-engine starting-state (P3a). Optional/additive: absent → defaults derived from
  // level/class at spawn, so existing pregens keep loading unchanged. The sheet is the immutable spec;
  // the live pools that grow/shrink at the table live on the Combatant.
  /** Hit-dice spec: die size + count (defaults to hitDieForClass(className) × level when omitted). */
  hitDice?: { size: number; count: number };
  /** Class resource pools this character starts with (ki, rage, channel divinity, …). */
  classResources?: { id: string; name: string; max: number; recharge: 'short' | 'long' }[];
}

// ---------------------------------------------------------------------------
// Spells (minimal SRD model — enough for the v1 scenario)
// ---------------------------------------------------------------------------

export interface Spell {
  id: string;
  name: string;
  level: number; // 0 = cantrip
  school: string;
  castingTime: string;
  range: string;
  components: string;
  duration: string;
  /** Saving throw ability if the spell forces one. */
  save?: Ability;
  /** Damage at base level, if any. */
  damage?: { dice: DiceExpr; type: DamageType };
  text: string;
  /** Free-form provenance label for citation (no licensing lock — spec §11). */
  source: string;
}

// ---------------------------------------------------------------------------
// Runtime state (the engine is the sole owner — spec §4.1)
// ---------------------------------------------------------------------------

/** Per-round action economy budget for one combatant. */
export interface ActionEconomy {
  action: boolean;
  bonusAction: boolean;
  reaction: boolean;
  movementRemainingFt: number;
}

/** A live participant in play (PC or monster instance). */
export interface Combatant {
  id: string;
  /** Display name, e.g. "Goblin 2". */
  name: string;
  /** 'pc' references a CharacterSheet; 'npc' references a StatBlock. */
  kind: 'pc' | 'npc';
  refId: string;
  /** Sprite tag for the visual layer; resolved to art by the renderer manifest. */
  spriteTag?: string;
  currentHitPoints: number;
  maxHitPoints: number;
  temporaryHitPoints: number;
  armorClass: number;
  conditions: Condition[];
  /** Set when reduced to 0 HP (P2). npcs are out of the fight; PCs are dying (death saves). */
  downed?: boolean;
  /** Death-save tally while a PC is dying at 0 HP (3 successes = stable, 3 failures = dead). */
  deathSaves?: { successes: number; failures: number };
  /** Set when a PC fails three death saves. */
  dead?: boolean;
  /** Damage modifiers — engine-owned, copied from the stat block when an npc is spawned (P2). */
  damageResistances?: DamageType[];
  damageImmunities?: DamageType[];
  damageVulnerabilities?: DamageType[];
  /** Initiative roll total; undefined outside combat. */
  initiative?: number;
  /** Dex-based initiative modifier, set at spawn (engine rolls 1d20 + this). */
  initiativeBonus?: number;
  /** Abstract position label in v1 (e.g. "near the door"); grid is a later phase (OQ #10). */
  position?: string;
  actionEconomy?: ActionEconomy;
  /** Remaining spell slots by level, mirrors SpellcastingBlock.slots; engine-owned. */
  slotsRemaining?: number[];
  // --- Character-engine volatile pools (P3a). Seeded at spawn from the sheet; engine-owned; mutated in
  // place like currentHitPoints. All optional so legacy combatants/pregens are byte-identical without them.
  /** Full spell-slot capacity by level (paired with slotsRemaining). A long rest restores remaining→max
   *  — this is what makes slotsRemaining a live resource instead of a copied-at-spawn dead field. */
  slotsMax?: number[];
  /** Hit-dice pool: die size (for the roll), how many remain to spend on a short rest, and the max
   *  (a long rest refunds up to half the max, min 1). */
  hitDice?: { size: number; remaining: number; max: number };
  /** Named class resources (ki/rage/channelDivinity/sorceryPoints/…): current + max + which rest refills
   *  them. Self-contained so short/long rest recovery needs no back-reference to the sheet. */
  resources?: Record<string, { current: number; max: number; recharge: 'short' | 'long' }>;
  /** Exhaustion level 0–6 (6 = death, SRD). derive.ts applies its penalty to checks/saves. */
  exhaustion?: number;
  /** Heroic Inspiration — a one-shot token the DM grants and the player spends for advantage. */
  inspiration?: boolean;
  /** Conditions this combatant can't suffer (copied from a monster stat block; applyCondition honors it). */
  conditionImmunities?: Condition[];
  /** The concentration spell this caster is holding, if any (P3b). `dc` is the save DC of the most recent
   *  hit, set by applyDamage. Only one at a time — starting a new concentration spell drops the old one. */
  concentratingOn?: { spell: string; dc?: number };
}

export interface CombatState {
  active: boolean;
  round: number;
  /** Index into `order` whose turn it is. */
  turnIndex: number;
  /** Combatant ids in initiative order (desc). */
  order: string[];
}

export interface Scene {
  id: string;
  title: string;
  /** GM-facing summary the orchestrator uses to set the scene. */
  summary: string;
  /** Ids of scenes reachable from here (soft graph; the LLM paces within it). */
  exits: string[];
}

/** A single appended record of something that happened (spec §4.1 / §13 audit). */
export interface LogEntry {
  seq: number;
  kind: 'narration' | 'player' | 'engine' | 'system';
  text: string;
  /** Structured payload for engine mutations (creature, field, before/after, cause). */
  data?: Record<string, unknown>;
}

/**
 * An in-flight turn suspended while waiting for a player's declared physical-dice
 * roll (spec §4.3). Orchestrator-owned; stored here as part of GameState so a
 * paused turn survives save/resume. `history` is opaque (LlmMessage[]) to keep
 * this package free of an LLM dependency.
 */
export interface PendingTurn {
  rollRequestId: string;
  rollToolUseId: string;
  rollExpr: string;
  rollReason: string;
  /** The DC/AC the roll is checked against, if any (so success survives resume — spec §4.2). */
  rollDc?: number;
  /** Tool results already resolved this turn (e.g. getState), sent with the roll result. */
  resolvedToolResults: { toolUseId: string; content: string }[];
  /** Opaque LLM message history for the in-flight turn. */
  history: unknown[];
}

/** Authored adventure context fed to the DM so it runs the written scenario (GM-facing, not read aloud). */
export interface AdventureContext {
  pitch: string;
  /** sceneId -> scene guidance + reachable next beats (exits) for soft arc steering (D1). */
  scenes: Record<string, { title: string; summary: string; exits?: string[] }>;
}

/** An authored encounter: which monsters appear in a scene (P2 combat spawn). */
export interface EncounterDef {
  id: string;
  sceneId: string;
  monsters: { statBlockId: string; count: number }[];
}

/**
 * The campaign arc the Game Director architects up front (the "north star"): what the whole thing is
 * about, the problem the party must address, where they start, the envisioned ENDING it steers toward,
 * and the interim spine of milestones leading there. The ending vision anchors all steering; the spine
 * flexes as players move (it is a route, not a rigid script).
 */
export interface CampaignBlueprint {
  premise: string; // what the whole campaign is about (theme)
  centralProblem: string; // the problem the characters must address
  intendedEnding: string; // the envisioned resolution — the destination the Director steers toward
  opening: string; // where the party starts
  /** Envisioned interim steps from opening to ending; sceneId links a milestone to an authored beat. */
  spine: { milestone: string; sceneId?: string; intent: string }[];
}

/**
 * The Game Director's steering brief (Phase D / D2): non-canonical, regenerated guidance the turn DM
 * reads. OFFERS ONLY — there is deliberately no imperative "do X" field (player agency is sacred).
 */
/**
 * Provenance for a GENERATED campaign arc (Composer output). Proves freshness — seed/model/temperature/
 * timestamp tell two generations apart — and detects staleness: when `composerPromptHash` no longer
 * matches the on-disk composer prompt (or the seed/temperature differ), the arc was made under
 * different conditions. `fallback` flags the deterministic Fake path (the model gave nothing usable).
 */
export interface ArcGenMeta {
  /** Hash of the canonical seed — same seed ⇒ same hash. */
  seedHash: string;
  seedPhrase?: string;
  model: string;
  temperature?: number;
  timestampMs: number;
  inputTokens: number;
  outputTokens: number;
  /** Hash of the composer system prompt actually used (fresh-vs-stale signal). */
  composerPromptHash: string;
  /** True when generation fell back to the deterministic Fake composer. */
  fallback: boolean;
}

export interface ArcBrief {
  /** One line on what this beat is really about / what's at stake now. */
  activeBeatIntent: string;
  /** 1-3 reachable next beats, each framed as an opportunity/pressure hook (sceneId is a real exit). */
  reachable: { sceneId: string; hook: string }[];
  /** Optional bridge NPCs to open a path toward a desired beat when there's a gap. */
  bridgeNpcs?: { name: string; role: string }[];
  /** Optional escalating-pressure notes ("clocks"/fronts). */
  clocks?: string[];
  /** Optional free-form director note (e.g. how the party's choices reshaped the plan). */
  notes?: string;
}

// ---------------------------------------------------------------------------
// Canon Ledger (P1 — the §7 memory tier): the "world bible" that survives the
// transcript window, so NPCs stay themselves and items/promises/facts persist.
// ---------------------------------------------------------------------------

/** Statuses an entity cannot leave once reached (no un-dying / un-destroying) — engine-enforced. */
export type EntityStatus = 'active' | 'wounded' | 'captive' | 'gone' | 'dead' | 'destroyed';
export const TERMINAL_ENTITY_STATUSES: readonly EntityStatus[] = ['dead', 'gone', 'destroyed'];

/** A canonical world entity (NPC/place/item/faction) the DM must stay consistent with. */
export interface EntityCard {
  id: string; // e.g. "npc:edda", "item:silver-key", "place:bell-tower", "pc-1-fighter"
  kind: 'pc' | 'npc' | 'place' | 'item' | 'faction' | 'other';
  name: string;
  /** Other ways the entity is referred to — used for canon matching against narration/input. */
  aliases?: string[];
  /** NPC personality anchors so a returning NPC sounds like themselves. */
  voice?: { tic?: string; want?: string; fear?: string };
  status?: EntityStatus; // default 'active'; terminal states are absorbing
  /** Scenes where this entity is native — always injected into CANON when the party is there. */
  scenes?: string[];
  notes?: string;
}

/** An append-only canonical fact. A newer fact for the same subject+attribute SUPERSEDES the older. */
export interface FactRow {
  id: string;
  subject: string; // an entity id, "party", or a free label
  attribute: string; // e.g. "has", "promised", "location", "knows"
  value: string;
  turn: number; // turn index recorded (recency)
  source: 'dm' | 'composer' | 'archivist';
  /** Set to the superseding fact's id when a later fact overrides this one. */
  supersededBy?: string;
}

/** A planted detail (Chekhov's gun): planted → echoed → fired over the campaign. */
export interface Plant {
  id: string;
  what: string;
  status: 'planted' | 'echoed' | 'fired';
  turn?: number;
}

export interface LedgerState {
  entities: Record<string, EntityCard>;
  facts: FactRow[];
  plants: Record<string, Plant>;
}

export interface GameState {
  sessionId: string;
  scenarioId: string;
  currentSceneId: string;
  /** PC combatants are persistent; npc combatants are spawned per encounter. */
  combatants: Record<string, Combatant>;
  combat: CombatState;
  /** Quest/world flags — the v1 canonical tier (spec §7). */
  flags: Record<string, string | number | boolean>;
  /** Canon Ledger (P1 §7 memory): entities + append-only facts + plants that survive the window. */
  ledger?: LedgerState;
  /** Monotonic count of message turns taken (recency stamp for facts). */
  turnCount?: number;
  log: LogEntry[];
  /** Set when a turn is paused waiting for a player's declared dice result (spec §4.3). */
  pendingTurn?: PendingTurn;
  /** Cumulative model spend for this session in USD (budget meter, spec §4.4). */
  spentUsd: number;
  /** Authored scenario guidance for the DM (so it runs the written adventure). */
  adventure?: AdventureContext;
  /** Authored encounters by scene + the resolved stat blocks (P2 combat spawn). Engine-owned;
   *  lets the engine instantiate authored monsters without re-loading content. */
  encounters?: EncounterDef[];
  bestiary?: Record<string, StatBlock>;
  /** Game Director state (Phase D): the cached steering brief + when it was last (re)planned.
   *  Canonical decisions live in `flags` (decision:/beat:/npc:); this holds the volatile guidance. */
  arc?: {
    /** The architected campaign arc (north star) — generated once, anchors all steering. */
    blueprint?: CampaignBlueprint;
    brief?: ArcBrief;
    plannedForScene?: string;
    /** Signature of decision:/npc: flag VALUES the brief was planned against (replan when it changes). */
    plannedFlagSig?: string;
    /** Provenance when the arc was Composer-generated from a seed (absent for authored scenarios). */
    genMeta?: ArcGenMeta;
  };
  /** Persistent, lazily-generated, frozen world graph for the visual layer
   *  (docs/SCENE-CONTRACTS.md). Locations are generated once and reused on re-entry. */
  world?: WorldState;
}
