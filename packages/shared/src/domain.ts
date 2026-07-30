import type { JournalEvent } from './journal.js';
import type { PersonaSeed } from './persona.js';
import type { ScenePlan, WorldState } from './world.js';

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
  /** Spells this caster can cast as RITUALS — no spell slot spent (P3f). */
  rituals?: string[];
  /** Explicit cap on prepared spells; when omitted the engine derives it (ability mod + level) (P3f). */
  preparedMax?: number;
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
  /** Starting coin purse (P3d) — seeds CharacterState.currency at spawn. */
  startingCurrency?: { cp?: number; sp?: number; gp?: number };
  /** Starting kit as catalog references (P3d) — seeds CharacterState.items. Legacy `inventory` (freeform
   *  strings) still works for flavor; carriedItems are the mechanical ones. */
  carriedItems?: ItemRef[];
  /** Skills with EXPERTISE (double proficiency) — e.g. a Rogue's chosen skills (P3e). */
  skillExpertise?: Skill[];
  /** Skills with HALF proficiency (e.g. a Bard's Jack of All Trades) (P3e). */
  skillHalfProficiency?: Skill[];
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
  /** WHO dropped them (combatant id) — stamped by applyDamage when HP hits 0. Attribution feeds the
   *  journal ("Pip fells Bandit 1") and the fight summary; XP stays an even party split regardless. */
  downedBy?: string;
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
  /** The caster's currently-prepared spells (P3f) — seeded from the sheet, re-set on a long rest via
   *  prepareSpells (validated against the derived cap). Volatile (changes daily), so it lives here. */
  preparedSpells?: string[];
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
  /** P5: facts the DM recorded in the SUSPENDED half of this turn. The clue lane corroborates against
   *  the FINAL narration, which for the record-then-roll shape only exists on resume — without this
   *  carry, the canonical recordFact+requestRoll turn could never produce a clue. Dies with the turn. */
  dmFacts?: { subject: string; attribute: string; value: string }[];
  /** Tool results already resolved this turn (e.g. getState), sent with the roll result. */
  resolvedToolResults: { toolUseId: string; content: string }[];
  /** Opaque LLM message history for the in-flight turn. */
  history: unknown[];
  /** SPATIAL R2: a travel that suspended on a swim gate — on submitRoll the engine completes the
   *  crossing (success) or applies the fail-forward (failure) BEFORE the LLM resumes. Additive;
   *  dies with the pendingTurn (no plan-staleness class). */
  travelContinuation?: { actorId: string; toId?: string; toCol?: number; toRow?: number };
  /** Interaction layer P4b: a directed COMMAND that suspended on a social check — on submitRoll the
   *  engine either walks the target to the deed (pass → obeyed) or records a refusal (fail), BEFORE the
   *  LLM resumes. Additive; dies with the pendingTurn. `verb`/`anchorId` are the closed DesiredAction. */
  commandContinuation?: { targetId: string; targetName: string; verb: string; anchorId?: string; anchorCol?: number; anchorRow?: number; anchorName?: string; tone: string; sig?: string; feared?: boolean };
  /** Interaction layer P4c: a PERFORMANCE that suspended on a Performance check — on submitRoll a pass
   *  draws the crowd (resolveInteraction), a fail falls flat, BEFORE the LLM resumes. Dies with the pendingTurn. */
  performContinuation?: { sourceId: string; locusCol: number; locusRow: number };
  /** P4d: a command verdict resolved THIS turn while a DIFFERENT tool suspended — carried so the resume's
   *  polarity gate still checks the narration against it. `verdict` is a CommandVerdict (string here to keep
   *  the shared package free of the apps/server enum). */
  commandOutcome?: { targetName: string; verdict: string };
  /** SPATIAL R4/S4: the PC who acted on the turn that suspended. The coherence gate needs an acting PC
   *  to measure earshot/reach against, and a roll-resume turn has no speakerId of its own — without
   *  this the whole proximity check silently switches OFF for exactly the beat that narrates the hit. */
  actingPcName?: string;
}

/** Authored adventure context fed to the DM so it runs the written scenario (GM-facing, not read aloud). */
export interface AdventureContext {
  pitch: string;
  /** sceneId -> scene guidance + reachable next beats (exits) for soft arc steering (D1).
   *  `scenePlan` is the beat's authored VISUAL design (arc-composer, Phase C) — the Director-quality
   *  brief the DM inherits at setScene time instead of improvising one mid-turn. */
  scenes: Record<string, { title: string; summary: string; exits?: string[]; scenePlan?: ScenePlan }>;
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
  /** WHAT THEY LOOK LIKE — one line of observable surface (build, age, dress, one memorable feature).
   *  WRITE-ONCE canon: the composer authors it for staged cast, `upsertNpc` sets it for anyone invented
   *  in play, and `Engine.upsertEntity` refuses to overwrite it thereafter — so Tessa cannot be stout in
   *  one scene and willowy in the next. Every generator that describes her is CONDITIONED on this string
   *  (it rides the per-turn CANON block); nobody re-invents it. Deliberately surface only: it is copied
   *  verbatim into the player-facing Book the moment she is introduced, so it must hold no secret. */
  appearance?: string;
  /** Optional authored disposition (living-world reactivity). Absent → the resolver DERIVES one at
   *  read-time via profileOf(); present → it overrides the derived archetype/temper and adds colour. */
  persona?: PersonaSeed;
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

/**
 * A catalog item DEFINITION (P3d) — data, loaded from content/shared/items.json like the bestiary. The
 * catalog is the single source of an item's rules; a character owns lightweight ItemRefs pointing at it.
 */
export interface ItemDef {
  id: string;
  name: string;
  /** e.g. "weapon" | "armor" | "shield" | "gear" | "potion" | "wondrous" | "ring" | "scroll". */
  category: string;
  weightLb: number;
  /** Market price in gold; omitted = priceless / not for sale. Selling returns half (SRD). */
  costGp?: number;
  /** Equip slot this occupies, if wearable/wieldable. */
  slot?: 'armor' | 'shield' | 'mainHand' | 'offHand' | 'ranged';
  /** Armor: base AC (heavy sets the floor); acDexCap limits the Dex bonus (0 heavy, 2 medium, none light). */
  acBase?: number;
  acDexCap?: number;
  /** Shield / wondrous flat AC bonus. */
  acBonus?: number;
  /** Weapon geometry — READ BY THE REACH GATE (spatial/reach.ts), unlike the older informational
   *  `AttackAction.reachOrRangeFt`. Melee reach in feet (omit = PHB 5; a pike/whip sets 10). */
  reachFt?: number;
  /** Ranged: normal band in feet (beyond it, up to longRangeFt, the shot is at disadvantage). */
  rangeFt?: number;
  longRangeFt?: number;
  /** True if the item is magical (its effects/attunement stay gated until identified). */
  magic?: boolean;
  requiresAttunement?: boolean;
  /** Limited-use charges + which rest recharges them. */
  charges?: { max: number; recharge: 'short' | 'long' | 'dawn' };
  /** Passive grants while equipped/attuned (a skill proficiency or a save proficiency). */
  grants?: { skill?: Skill; save?: Ability };
}

/** An owned instance of a catalog item (P3d) — points at an ItemDef by id, carries per-instance state. */
export interface ItemRef {
  defId: string;
  /** Unique per-owner instance id (so two of the same item can be equipped/attuned/tracked apart). */
  instanceId: string;
  qty?: number;
  chargesRemaining?: number;
  /** Magic items start unidentified; identifyItem flips this and unlocks effects/attunement. */
  identified?: boolean;
}

/**
 * Progression + economy that persists ACROSS and around combat (P3c+) — the third character "home",
 * keyed by combatant id in GameState.characters. The immutable CharacterSheet is the STARTING spec;
 * the Combatant holds volatile combat pools; THIS holds what grows over the campaign. Derived numbers
 * (proficiency, AC, skill mods) are never stored here — they're computed from (sheet + this) in derive.ts.
 */
export interface CharacterState {
  /** Cumulative experience points. */
  xp: number;
  /** Current character level — starts at the sheet's level; grows via levelUp / setMilestoneLevel. */
  level: number;
  /** Coin purse (copper / silver / gold). */
  currency: { cp: number; sp: number; gp: number };
  /** Everything carried (P3d) — loot, gear, consumables. */
  items: ItemRef[];
  /** instanceIds currently attuned (hard cap of 3, SRD). */
  attunedInstanceIds: string[];
  /** Which instance fills each equip slot. AC + item grants derive from these. */
  equipped: { armor?: string; shield?: string; mainHand?: string; offHand?: string; ranged?: string };
}

/**
 * A POINT OF INTEREST / interactable (Phase-1 scene gameplay): a hidden chest behind a tree, a cellar
 * door in the inn, a searchable altar. The ENGINE owns this authoritative, DM-SECRET state (discover DC,
 * contents, discovered/looted flags); the frozen SceneMap carries only a `visible` render-shadow of it.
 */
export type PoiKind = 'container' | 'passage' | 'feature' | 'hidden-cache';

/** What a POI holds — catalog item refs + gold. Validated against the item catalog at placement. */
export interface PoiContents {
  items?: { itemDefId: string; qty?: number }[];
  gold?: number; // gp
}

export interface Poi {
  /** "poi:chest-cellar" — its OWN namespace (outside the entity-id pattern); the render shadow uses fixtureId. */
  id: string;
  locationId: string;
  kind: PoiKind;
  /** Short description read out when the party finds it. */
  look: string;
  /** Coordinate-free placement, incl. a POI-only "behind:<id>" (down-projected to "near:<id>" for the shadow). */
  anchor?: string;
  /** The prop:/bldg: MapObject id that shadows this POI on the map (visible = discovery state). */
  fixtureId?: string;
  hidden: boolean;
  /** Perception/Investigation DC to find a hidden POI (required when hidden). */
  discoverDc?: number;
  discovered: boolean;
  searched: boolean;
  looted: boolean;
  contents?: PoiContents;
  /** For a passage (a door): a "loc:…" location (setScene re-entry) or an arc sceneId (advanceScene). */
  leadsTo?: string;
  /** GM-facing note; never rendered or shown to players. */
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
  /** Character progression + economy (P3c), keyed by combatant id. Optional/additive — legacy sessions
   *  without it still run; the tools that read it throw a clear error until a session is (re)created. */
  characters?: Record<string, CharacterState>;
  /** Immutable character sheets keyed by combatant id — the spec the engine DERIVES from (con mod for
   *  level-up HP; abilities/proficiencies for checks in P3e). Read-only; never mutated at runtime. */
  sheets?: Record<string, CharacterSheet>;
  /** The item catalog (P3d), loaded on boot from content/shared/items.json. ItemRefs point into it. */
  itemCatalog?: Record<string, ItemDef>;
  /** Points of interest / interactables (hidden chests, secret doors) — engine-owned, DM-secret. Optional/
   *  additive; keyed by POI id. The players never see this; a `visible` render-shadow lives on the map. */
  pois?: Record<string, Poi>;
  /** THE JOURNAL (docs/PLAYER-INTERFACE.md) — the append-only record of what the PLAYERS witnessed, from
   *  which the Book is projected and the future inter-chapter diary distills. Additive and optional: it
   *  rides both persistence paths (dev-session freeze, play-API blob) for free, and an old save without
   *  it simply hydrates with no Book. Written only through Engine.journal(). */
  journal?: JournalEvent[];
  /** Salt for the clue lane's shipped dedup keys (P5). Random per session, persisted so freeze/reload
   *  keeps deduping; lives at the state ROOT, which no player projection ships — without it, the hashed
   *  factKey is a deterministic guess-confirmation oracle over the DM's filing vocabulary. */
  journalSalt?: string;
}
