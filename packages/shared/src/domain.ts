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

export interface GameState {
  sessionId: string;
  scenarioId: string;
  currentSceneId: string;
  /** PC combatants are persistent; npc combatants are spawned per encounter. */
  combatants: Record<string, Combatant>;
  combat: CombatState;
  /** Quest/world flags — the v1 canonical tier (spec §7). */
  flags: Record<string, string | number | boolean>;
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
    plannedDecisionCount?: number;
    plannedNpcCount?: number;
  };
  /** Persistent, lazily-generated, frozen world graph for the visual layer
   *  (docs/SCENE-CONTRACTS.md). Locations are generated once and reused on re-entry. */
  world?: WorldState;
}
