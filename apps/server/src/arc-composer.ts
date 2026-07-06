/**
 * The Game Director's ARC COMPOSER (Phase 1): generate a brand-new, self-contained adventure +
 * campaign blueprint from a SEED (theme/tone/party/length), so every session can be a TRULY fresh
 * arc instead of a reformat of one authored scenario. This is the "generate" lane; the authored
 * scenario.json stays the default quality lane.
 *
 * Engine-safety by construction: the model only authors FICTION (beats + GM guidance + the north
 * star). Scene ids are MINTED in code (scene:b1..bN), exits are remapped through that id map and any
 * dangling/self/forged exit is dropped, reachability from b1 is guaranteed, encounters are forced
 * empty (combat stays the DM's startEncounter over the existing bestiary — the engine owns every
 * number), and the whole thing is run through the SAME validateScenario() gate authored content uses.
 * Anything unusable falls back to a deterministic Fake arc so a session never starts broken.
 *
 * Mirrors the ArcPlanner seam: a Fake (deterministic, $0, for tests/eval/fallback) + an Llm composer,
 * selected by MYTHWEAVER_ARC_COMPOSER = llm (default) | fake | off.
 */

import { createHash } from 'node:crypto';
import { generateStatBlock, type MonsterSpec } from '@mythweaver/engine';
import { estimateCostUsd, type LlmProvider } from '@mythweaver/llm';
import type { AdventureContext, ArcGenMeta, CampaignBlueprint, CharacterSheet, EncounterDef, EntityCard, Plant, ScenePlan, StatBlock } from '@mythweaver/shared';
import { buildBlueprint, extractJson, str } from './arc-planner.js';
import { validateScenario, type Scenario } from './content.js';

/** The knobs that vary what the Director designs from — the input that makes each arc fresh. */
export interface ArcSeed {
  /** Optional — when blank, the Director invents the whole premise itself ("surprise me"). */
  theme?: string;
  tone?: string; // e.g. grim | heroic | whimsical | mystery | horror
  lengthBeats?: number; // clamped 3-8
  /** The hand-built party (name + role + optional backstory), which PRE-EXISTS the campaign so it's
   *  designed for them. A blank backstory tells the Director to invent one that fits. */
  party: { name: string; className?: string; backstory?: string }[];
  constraints?: string[];
  /** A throwaway phrase that varies the prompt so "Reroll" yields a different arc. */
  seedPhrase?: string;
  /** Monsters: 'auto' = the Director fits creatures per beat; 'manual' = only the chosen palette. */
  monsterMode?: 'auto' | 'manual';
  /** Library ids the Director may use (the allowed palette in manual mode). */
  monsterPalette?: string[];
  /** In auto mode, allow COMMISSIONING brand-new creatures (engine computes stats). Default true. */
  allowCommission?: boolean;
}

/** A fully-resolved, engine-safe generated arc (adventure + north star + monsters + provenance). */
export interface GeneratedArc {
  adventure: AdventureContext;
  startSceneId: string;
  /** Per-beat encounters the Director placed (selected from the library and/or engine-commissioned). */
  encounters: EncounterDef[];
  /** The stat blocks those encounters reference (library picks + commissioned creatures). */
  bestiary: Record<string, StatBlock>;
  /** The resolved party sheets (attached by the endpoint) — editable in the lab to tweak levels/HP. */
  party?: CharacterSheet[];
  /** Canon Ledger seed (P1): the cast (NPCs with voice, native scenes) + planted details. */
  ledger?: { entities: EntityCard[]; plants: Plant[] };
  /** Per-PC backstories the composer echoed/invented, keyed by name — merged onto `party` by the endpoint. */
  pcBackstories?: { name: string; backstory: string }[];
  blueprint: CampaignBlueprint;
  genMeta: ArcGenMeta;
}

/** Resources the coercer uses to resolve per-beat monsters (engine owns every generated number). */
export interface MonsterResources {
  library: Map<string, StatBlock>;
  /** Library ids the Director is allowed to place. */
  allowedIds: Set<string>;
  /** Whether commissioned ("new") creatures are permitted. */
  allowCommission: boolean;
  /** The engine's CR -> stat-block generator (injected so this module stays engine-agnostic). */
  generate: (spec: MonsterSpec) => StatBlock;
}

export interface ArcComposeResult {
  arc: GeneratedArc;
  /** Composer spend, surfaced in the lab so the budget meter stays honest. */
  costUsd: number;
}

export interface ArcComposeOpts {
  /** The Director's own temperature (independent of the DM). */
  temperature?: number;
  /** Injected clock (tests pass () => 0 for byte-stable fixtures). */
  now?: () => number;
  /** The shared monster library the Director may select from (and commission alongside). */
  library?: StatBlock[];
}

export interface ArcComposer {
  compose(seed: ArcSeed, opts?: ArcComposeOpts): Promise<ArcComposeResult>;
}

const clampLen = (n: unknown): number => {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 5;
  return Math.max(3, Math.min(8, v));
};

const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex').slice(0, 12);

/** Canonical seed serialization — same seed (incl. seedPhrase + monster config) ⇒ same seedHash. */
function canonicalSeed(seed: ArcSeed): string {
  return JSON.stringify({
    theme: (seed.theme || '').trim(),
    tone: seed.tone || '',
    lengthBeats: clampLen(seed.lengthBeats),
    party: (seed.party || []).map((p) => ({ name: p.name || '', className: p.className || '', backstory: (p.backstory || '').trim() })),
    constraints: (seed.constraints || []).map((c) => (c || '').trim()).filter(Boolean),
    seedPhrase: seed.seedPhrase || '',
    monsterMode: seed.monsterMode || 'auto',
    monsterPalette: (seed.monsterPalette || []).slice().sort(),
    allowCommission: seed.allowCommission !== false,
  });
}

/** The seed, rendered for the model (user-authored content; kept compact, not treated as instructions). */
function seedDigest(seed: ArcSeed, res: MonsterResources): string {
  const palette = [...res.allowedIds].map((id) => {
    const sb = res.library.get(id);
    return sb ? `${sb.id} (${sb.name}, CR ${sb.challengeRating})` : id;
  });
  const monsterGuidance =
    seed.monsterMode === 'manual'
      ? `MONSTERS: place ONLY creatures from this palette, by id — ${palette.join('; ') || '(none)'}. Do NOT invent new creatures.`
      : `MONSTERS: select fitting creatures from the library by id — ${palette.join('; ') || '(none)'}.` +
        (res.allowCommission ? ` You MAY also COMMISSION a brand-new creature when none fit, via "new" (give name + challengeRating 0–5 + concept; the engine computes its stats).` : ' Do NOT invent new creatures.');
  return [
    seed.theme ? `THEME: ${str(seed.theme, 300)}` : 'THEME: (none given — invent a fresh, compelling premise yourself)',
    seed.tone ? `TONE: ${str(seed.tone, 60)}` : '',
    `LENGTH: ${clampLen(seed.lengthBeats)} beats`,
    (seed.party || []).length
      ? `PARTY (design the adventure FOR these characters; weave their backstories in where they fit):\n${(seed.party || [])
          .map((p) => `  - ${str(p.name, 60)}${p.className ? ` the ${str(p.className, 40)}` : ''} — ${str(p.backstory, 300) || '(no backstory given: invent a short one that fits the theme)'}`)
          .join('\n')}`
      : 'PARTY: (a small adventuring party)',
    (seed.constraints || []).length ? `CONSTRAINTS: ${(seed.constraints || []).map((c) => str(c, 200)).filter(Boolean).join('; ')}` : '',
    seed.seedPhrase ? `SEED PHRASE (use for variety/novelty): ${str(seed.seedPhrase, 200)}` : '',
    monsterGuidance,
  ]
    .filter(Boolean)
    .join('\n');
}

export const DEFAULT_COMPOSER_SYSTEM = `You are the GAME DIRECTOR composing a brand-new, self-contained tabletop adventure BEFORE play begins, from a seed. You do NOT narrate to the table and you NEVER decide mechanical outcomes (no rolls, no HP, no to-hit) — but you MAY suggest skill checks + DCs inside a beat's GM guidance, exactly like an authored module (the engine still adjudicates every number).

Design a coherent arc with a KNOWN ENDING: what the whole thing is about, the central problem, where the party starts, the envisioned ending you steer toward, and an ordered chain of BEATS (scenes) that route from the opening to that ending. Honor the seed's theme, tone, length, and constraints. Give players real agency — offer multiple approaches per beat, never a single gated path.

Respond with ONLY a JSON object (no prose, no code fence):
{"premise":"<what the campaign is about / its theme>","centralProblem":"<the concrete problem the party must address>","intendedEnding":"<a clear, specific resolution — how it should end if it lands>","opening":"<where/how the party starts>","beats":[{"title":"<short scene name>","summary":"<GM guidance: what's here, what's at stake, ways to engage; you MAY note suggested checks + DCs; reveal it through play>","scene":{"look":"<1-3 sentences: what the place LOOKS like top-down — terrain, structures, water/edges>","kind":"settlement|interior|wild","mood":"<lighting/weather in plain words, e.g. \\"grim predawn fog\\">","features":["<must-exist landmark>","<another>"]},"exits":[2,3],"intent":"<what this beat accomplishes toward the ending>","monsters":[{"from":"<library id>","count":2},{"new":{"name":"<creature>","challengeRating":1,"type":"<e.g. undead>","attackName":"<e.g. Spectral Touch>","damageType":"necrotic","ranged":false},"count":1}]}],"spine":[{"milestone":"<short label>","beat":1,"intent":"<step toward the ending>"}],"cast":[{"id":"npc:<slug>","name":"<name>","atBeats":[1],"voice":{"tic":"<a distinctive speech/behaviour tic>","want":"<what they want>","fear":"<what they fear>"}}],"plants":[{"id":"plant:<slug>","what":"<a detail planted early that pays off later>"}],"pcBackstories":[{"name":"<pc name exactly as given>","backstory":"<their backstory>"}]}

RULES:
- "beats" is an ORDERED array; the FIRST beat is where the party starts. Produce the requested number of beats (3-8).
- "exits" are the 1-based indexes of the OTHER beats reachable from this beat (a short list; the finale may have none). Build a connected path from beat 1 to the finale.
- "spine" milestones map to a beat via its 1-based "beat" index; you MAY add 1-2 final milestones with NO "beat" (pure narrative payoff after the last scene).
- "monsters" (optional, only on beats with a fight): each entry is EITHER {"from":"<library id>","count":N} to place an existing creature, OR {"new":{...},"count":N} to commission one — pick whichever the MONSTERS line in the seed allows. For "new", give ONLY fiction: name, challengeRating (0–5), type, attackName, damageType, ranged (true/false). The ENGINE computes its HP/AC/damage — never write any number other than challengeRating and count. Scale fights to the party size; not every beat needs combat.
- "scene" (per beat): the beat's VISUAL design, authored now while the whole premise is in front of you — the map generator renders from it. "look" = what a top-down map of the place shows (terrain, structures, water/edges — concrete nouns, not vibes). "kind" decides the layout family: "settlement" (buildings + streets), "interior" (an enclosed space: dungeon/cave/crypt/a building's inside), "wild" (open nature). "mood" = lighting/weather in plain words (it drives the scene's light). "features" = 2-5 landmark concepts that MUST exist on the map (the generator guarantees them).
- "cast": EVERY named NPC in your beat prose MUST appear here with a memorable VOICE (a tic, a want, a fear) and "atBeats" = the 1-based beats they appear in. This is what keeps them themselves when they return.
- "plants": 2-4 Chekhov details planted early that pay off later (a heirloom, a rumour, a scar) — the seeds of callbacks.
- PARTY BACKSTORIES: weave the party's backstories into the arc where they naturally fit — tie an NPC to a PC's past, let a beat touch a PC's stakes, plant a detail that pays off their history (no need to hook every PC). For any PC whose backstory is "(no backstory given…)", INVENT a short one that fits the theme.
- "pcBackstories": return one entry per PC — the given backstory verbatim, or the short one you invented. Use the PC's name exactly as given.
- intendedEnding must be a concrete destination, not vague. No stat blocks, no HP/AC/to-hit. Keep prose tight (~600 words total).`;

interface StampCtx {
  model: string;
  temperature?: number;
  promptText: string;
  usage: { inputTokens: number; outputTokens: number };
  now: () => number;
  fallback: boolean;
}

const clampCount = (v: unknown): number => Math.max(1, Math.min(8, Math.round(Number(v)) || 1));

/** Coerce a beat's authored scene design (Phase C). Look is required — without it there is no plan. */
function coerceScenePlan(raw: unknown): ScenePlan | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as Record<string, unknown>;
  const look = str(s.look, 300);
  if (!look) return undefined;
  const kind: ScenePlan['kind'] = s.kind === 'settlement' || s.kind === 'interior' || s.kind === 'wild' ? s.kind : 'wild';
  const features = (Array.isArray(s.features) ? s.features : []).map((f) => str(f, 40)).filter(Boolean).slice(0, 6);
  return { look, kind, mood: str(s.mood, 80), ...(features.length ? { features } : {}) };
}

/** Coerce a commissioned-creature spec (fiction only; the engine computes the numbers). */
function coerceSpec(raw: unknown): MonsterSpec | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const name = str(o.name, 60);
  if (!name) return null;
  const cr = Number(o.challengeRating);
  return {
    name,
    challengeRating: Number.isFinite(cr) ? Math.max(0, Math.min(5, cr)) : 0.25,
    ...(str(o.type, 60) ? { type: str(o.type, 60) } : {}),
    ...(str(o.attackName, 60) ? { attackName: str(o.attackName, 60) } : {}),
    ...(typeof o.damageType === 'string' ? { damageType: o.damageType as MonsterSpec['damageType'] } : {}),
    ...(o.ranged === true ? { ranged: true } : {}),
    ...(o.primaryAbility === 'dex' || o.primaryAbility === 'str' ? { primaryAbility: o.primaryAbility } : {}),
    source: 'commissioned',
  };
}

/**
 * Resolve a beat's `monsters` into an encounter, mutating `bestiary` with the stat blocks used.
 * Library picks are gated to `res.allowedIds`; commissioned creatures are engine-generated (only when
 * allowed). Returns the encounter monster refs (empty if the beat has no resolvable monsters).
 */
function resolveBeatMonsters(rawMonsters: unknown, res: MonsterResources, bestiary: Record<string, StatBlock>): { statBlockId: string; count: number }[] {
  const out: { statBlockId: string; count: number }[] = [];
  for (const m of Array.isArray(rawMonsters) ? rawMonsters : []) {
    const mm = m && typeof m === 'object' ? (m as Record<string, unknown>) : {};
    const count = clampCount(mm.count);
    const fromId = str(mm.from, 60);
    if (fromId && res.allowedIds.has(fromId) && res.library.has(fromId)) {
      const sb = res.library.get(fromId)!;
      bestiary[sb.id] = sb;
      out.push({ statBlockId: sb.id, count });
      continue;
    }
    if (res.allowCommission && mm.new) {
      const spec = coerceSpec(mm.new);
      if (spec) {
        const sb = res.generate(spec);
        let id = sb.id;
        for (let n = 2; bestiary[id] || res.library.has(id); n++) id = `${sb.id}-${n}`;
        bestiary[id] = { ...sb, id };
        out.push({ statBlockId: id, count });
      }
    }
  }
  return out;
}

/**
 * Coerce untrusted composer JSON into an engine-safe GeneratedArc. Returns null when the model gave
 * nothing usable (no beats / empty blueprint / fails validateScenario) so the caller can fall back.
 * When `res` is given, per-beat monsters are resolved (library selection + engine commissioning).
 */
export function buildGeneratedArc(raw: unknown, seed: ArcSeed, ctx: StampCtx, res?: MonsterResources): GeneratedArc | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const rawBeats = Array.isArray(o.beats) ? o.beats : [];
  const cap = Math.min(rawBeats.length, 12);
  if (cap === 0) return null;
  const ids = Array.from({ length: cap }, (_, i) => `scene:b${i + 1}`);

  const scenes: AdventureContext['scenes'] = {};
  for (let i = 0; i < cap; i++) {
    const b = rawBeats[i] && typeof rawBeats[i] === 'object' ? (rawBeats[i] as Record<string, unknown>) : {};
    const exits = [
      ...new Set(
        (Array.isArray(b.exits) ? b.exits : [])
          .map((x) => Math.round(Number(x)))
          .filter((x) => Number.isInteger(x) && x >= 1 && x <= cap && x - 1 !== i) // valid index, not self
          .map((x) => ids[x - 1]!),
      ),
    ];
    const scenePlan = coerceScenePlan(b.scene);
    scenes[ids[i]!] = { title: str(b.title, 80) || `Beat ${i + 1}`, summary: str(b.summary, 1200), exits, ...(scenePlan ? { scenePlan } : {}) };
  }

  // Guarantee reachability from b1: any orphan gets an edge from its predecessor (which, going in
  // order from the reachable b1, is itself reachable — so the whole chain stays connected).
  const reach = new Set<string>([ids[0]!]);
  const queue = [ids[0]!];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of scenes[cur]!.exits ?? []) if (!reach.has(e)) { reach.add(e); queue.push(e); }
  }
  for (let i = 1; i < cap; i++) {
    if (!reach.has(ids[i]!)) {
      const pred = scenes[ids[i - 1]!]!;
      if (!(pred.exits ?? []).includes(ids[i]!)) pred.exits = [...(pred.exits ?? []), ids[i]!];
      reach.add(ids[i]!);
    }
  }

  const sceneIdSet = new Set(ids);
  const rawSpine = Array.isArray(o.spine) ? o.spine : [];
  const remappedSpine = rawSpine.map((s) => {
    const ss = s && typeof s === 'object' ? (s as Record<string, unknown>) : {};
    const bi = Math.round(Number(ss.beat));
    const sceneId = Number.isInteger(bi) && bi >= 1 && bi <= cap ? ids[bi - 1] : undefined;
    return { milestone: ss.milestone, intent: ss.intent, ...(sceneId ? { sceneId } : {}) };
  });
  let blueprint = buildBlueprint(
    { premise: o.premise, centralProblem: o.centralProblem, intendedEnding: o.intendedEnding, opening: o.opening, spine: remappedSpine },
    sceneIdSet,
  );
  // No usable spine from the model → derive one straight from the beats (each beat is a milestone).
  if (blueprint.spine.length === 0) {
    blueprint = {
      ...blueprint,
      spine: ids.map((id, i) => ({ milestone: scenes[id]!.title, sceneId: id, intent: str((rawBeats[i] as Record<string, unknown>)?.intent, 240) })),
    };
  }
  if (!blueprint.premise && !blueprint.intendedEnding) return null; // model gave nothing usable

  const adventure: AdventureContext = { pitch: blueprint.premise || str(seed.theme, 400) || 'A generated adventure.', scenes };

  // Resolve per-beat monsters into encounters + the stat blocks they use (engine owns every number).
  const bestiary: Record<string, StatBlock> = {};
  const encounters: EncounterDef[] = [];
  if (res) {
    for (let i = 0; i < cap; i++) {
      const b = rawBeats[i] && typeof rawBeats[i] === 'object' ? (rawBeats[i] as Record<string, unknown>) : {};
      const monsters = resolveBeatMonsters(b.monsters, res, bestiary);
      if (monsters.length) encounters.push({ id: `enc-b${i + 1}`, sceneId: ids[i]!, monsters });
    }
  }

  // Second independent safety gate: the SAME validator authored scenarios pass through.
  const scenario: Scenario = {
    id: 'generated',
    title: (blueprint.premise || seed.theme || 'Generated').slice(0, 80),
    pitch: adventure.pitch,
    startSceneId: ids[0]!,
    scenes: ids.map((id) => ({ id, title: scenes[id]!.title, summary: scenes[id]!.summary, exits: scenes[id]!.exits ?? [] })),
    encounters,
  };
  try {
    validateScenario(scenario, 'generated');
  } catch {
    return null;
  }

  // Canon Ledger seed (P1): the cast (NPCs with voice, native beats) + planted details.
  const entities: EntityCard[] = (Array.isArray(o.cast) ? o.cast : [])
    .map((c) => {
      const cc = c && typeof c === 'object' ? (c as Record<string, unknown>) : {};
      const name = str(cc.name, 80);
      if (!name) return null;
      const idRaw = str(cc.id, 60);
      const id = /^[a-z]+:/i.test(idRaw) ? idRaw : `npc:${ledgerSlug(idRaw || name)}`;
      const atScenes = (Array.isArray(cc.atBeats) ? cc.atBeats : [])
        .map((x) => Math.round(Number(x)))
        .filter((x) => Number.isInteger(x) && x >= 1 && x <= cap)
        .map((x) => ids[x - 1]!);
      const v = cc.voice && typeof cc.voice === 'object' ? (cc.voice as Record<string, unknown>) : cc;
      const voice = { ...(str(v.tic, 120) ? { tic: str(v.tic, 120) } : {}), ...(str(v.want, 120) ? { want: str(v.want, 120) } : {}), ...(str(v.fear, 120) ? { fear: str(v.fear, 120) } : {}) };
      const card: EntityCard = {
        id,
        kind: 'npc',
        name,
        ...(Object.keys(voice).length ? { voice } : {}),
        ...(atScenes.length ? { scenes: [...new Set(atScenes)] } : {}),
        status: 'active',
      };
      return card;
    })
    .filter((c): c is EntityCard => c !== null)
    .slice(0, 16);
  const plants: Plant[] = (Array.isArray(o.plants) ? o.plants : [])
    .map((p, i): Plant | null => {
      const pp = p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
      const what = str(pp.what, 200) || str(pp, 200);
      if (!what) return null;
      return { id: str(pp.id, 60) || `plant:${i + 1}`, what, status: 'planted' };
    })
    .filter((p): p is Plant => p !== null)
    .slice(0, 6);

  // Per-PC backstories (echoed authored + invented for blanks), keyed by name — merged onto party later.
  const pcBackstories = (Array.isArray(o.pcBackstories) ? o.pcBackstories : [])
    .map((p): { name: string; backstory: string } | null => {
      const pp = p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
      const name = str(pp.name, 60);
      const backstory = str(pp.backstory, 400);
      return name && backstory ? { name, backstory } : null;
    })
    .filter((p): p is { name: string; backstory: string } => p !== null)
    .slice(0, 8);

  const genMeta: ArcGenMeta = {
    seedHash: sha1(canonicalSeed(seed)),
    ...(seed.seedPhrase ? { seedPhrase: str(seed.seedPhrase, 200) } : {}),
    model: ctx.model,
    ...(ctx.temperature !== undefined ? { temperature: ctx.temperature } : {}),
    timestampMs: ctx.now(),
    inputTokens: ctx.usage.inputTokens,
    outputTokens: ctx.usage.outputTokens,
    composerPromptHash: sha1(ctx.promptText),
    fallback: ctx.fallback,
  };
  return { adventure, startSceneId: ids[0]!, encounters, bestiary, ...(entities.length || plants.length ? { ledger: { entities, plants } } : {}), ...(pcBackstories.length ? { pcBackstories } : {}), blueprint, genMeta };
}

const ledgerSlug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'npc';

/**
 * Validate a (possibly HAND-EDITED) generated bundle before it starts a session — the lab lets the
 * tester tweak the JSON (party levels, monster stats, beats), so a bad edit must fail loudly here
 * rather than crash a turn. Throws a clear message; returns the bundle typed on success.
 */
export function validateGeneratedArc(raw: unknown): GeneratedArc {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const adv = o.adventure as { pitch?: unknown; scenes?: Record<string, unknown> } | undefined;
  if (!adv || typeof adv !== 'object' || !adv.scenes || typeof adv.scenes !== 'object' || !Object.keys(adv.scenes).length) {
    throw new Error('adventure.scenes is missing or empty');
  }
  const sceneIds = new Set(Object.keys(adv.scenes));
  const startSceneId = typeof o.startSceneId === 'string' ? o.startSceneId : '';
  if (!sceneIds.has(startSceneId)) throw new Error('startSceneId must name one of adventure.scenes');
  for (const [id, s] of Object.entries(adv.scenes)) {
    const sc = (s ?? {}) as Record<string, unknown>;
    if (typeof sc.title !== 'string' || !sc.title) throw new Error(`scene "${id}" needs a title`);
    if (sc.exits !== undefined && !Array.isArray(sc.exits)) throw new Error(`scene "${id}" exits must be an array`);
  }
  const party = Array.isArray(o.party) ? o.party : [];
  if (!party.length) throw new Error('party must have at least one character');
  for (const p of party) {
    const pc = (p ?? {}) as Record<string, unknown>;
    if (!pc.id || !pc.name || typeof pc.maxHitPoints !== 'number' || typeof pc.armorClass !== 'number') {
      throw new Error('each party member needs id, name, numeric maxHitPoints and armorClass');
    }
  }
  const bestiary = o.bestiary && typeof o.bestiary === 'object' ? (o.bestiary as Record<string, unknown>) : {};
  for (const [id, b] of Object.entries(bestiary)) {
    const sb = (b ?? {}) as Record<string, unknown>;
    const hp = (sb.hitPoints ?? {}) as Record<string, unknown>;
    if (!sb.id || !sb.name || typeof sb.armorClass !== 'number' || typeof hp.average !== 'number') {
      throw new Error(`monster "${id}" needs id, name, numeric armorClass and hitPoints.average`);
    }
  }
  for (const e of Array.isArray(o.encounters) ? o.encounters : []) {
    const en = (e ?? {}) as Record<string, unknown>;
    if (!sceneIds.has(en.sceneId as string)) throw new Error(`an encounter references unknown scene "${String(en.sceneId)}"`);
    for (const m of Array.isArray(en.monsters) ? en.monsters : []) {
      const id = (m as Record<string, unknown>)?.statBlockId as string;
      if (!(bestiary as Record<string, unknown>)[id]) throw new Error(`an encounter references unknown monster "${String(id)}"`);
    }
  }
  // Reuse the authored-scenario validator for the beat graph (parity with the on-disk path).
  validateScenario(
    {
      id: 'generated',
      title: 'edited',
      pitch: typeof adv.pitch === 'string' ? adv.pitch : '',
      startSceneId,
      scenes: Object.entries(adv.scenes).map(([id, s]) => {
        const sc = (s ?? {}) as Record<string, unknown>;
        return { id, title: String(sc.title ?? ''), summary: String(sc.summary ?? ''), exits: Array.isArray(sc.exits) ? (sc.exits as string[]) : [] };
      }),
      encounters: [],
    },
    'generated',
  );
  return o as unknown as GeneratedArc;
}

/** Build the monster resources for a compose call from the seed's config + the shared library. */
function monsterResources(seed: ArcSeed, library: StatBlock[]): MonsterResources {
  const libMap = new Map(library.map((s) => [s.id, s]));
  const manual = seed.monsterMode === 'manual';
  const allowedIds =
    manual && seed.monsterPalette && seed.monsterPalette.length
      ? new Set(seed.monsterPalette.filter((id) => libMap.has(id)))
      : new Set(libMap.keys());
  return { library: libMap, allowedIds, allowCommission: !manual && seed.allowCommission !== false, generate: generateStatBlock };
}

/** Deterministic composer: a clean linear arc derived from the seed alone (no API). Tests/eval/fallback. */
export class FakeArcComposer implements ArcComposer {
  async compose(seed: ArcSeed, opts?: ArcComposeOpts): Promise<ArcComposeResult> {
    const now = opts?.now ?? Date.now;
    const len = clampLen(seed.lengthBeats);
    const tone = seed.tone || 'classic';
    const theme = (seed.theme || 'an adventure').trim();
    const beats = Array.from({ length: len }, (_, i) => ({
      title: i === 0 ? `Arrival — ${theme}` : i === len - 1 ? `Resolution — ${theme}` : `Step ${i} — ${theme}`,
      summary: `Beat ${i + 1} of a ${tone} arc about ${theme}. Offer the party several ways to engage; reveal it through play.`,
      exits: i < len - 1 ? [i + 2] : [],
      intent: i === 0 ? 'establish the situation and the central problem' : i === len - 1 ? 'resolve the central problem at the intended ending' : 'advance toward the ending',
    }));
    const raw = {
      premise: `A ${tone} adventure about ${theme}.`,
      centralProblem: `The party must address ${theme}.`,
      intendedEnding: `The party resolves ${theme} and the central problem is put to rest.`,
      opening: beats[0]!.title,
      beats,
      spine: beats.map((b, i) => ({ milestone: b.title, beat: i + 1, intent: b.intent })),
    };
    const arc = buildGeneratedArc(
      raw,
      seed,
      { model: 'fake', ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}), promptText: 'fake-composer', usage: { inputTokens: 0, outputTokens: 0 }, now, fallback: false },
      monsterResources(seed, opts?.library ?? []),
    )!;
    return { arc, costUsd: 0 };
  }
}

/** Real composer: one LLM call → coerce → engine-safe arc; falls back to Fake on any error/empty. */
export class LlmArcComposer implements ArcComposer {
  private readonly fallback = new FakeArcComposer();
  private readonly composerSystem: () => string;
  private readonly model?: string;
  constructor(private readonly llm: LlmProvider, opts: { composerSystem?: () => string; model?: string } = {}) {
    this.composerSystem = opts.composerSystem ?? (() => DEFAULT_COMPOSER_SYSTEM);
    this.model = opts.model;
  }

  async compose(seed: ArcSeed, opts?: ArcComposeOpts): Promise<ArcComposeResult> {
    const now = opts?.now ?? Date.now;
    const promptText = this.composerSystem();
    const monsters = monsterResources(seed, opts?.library ?? []);
    // Composing a whole arc is one expensive call — a transient overload (429/529) should NOT silently
    // dump the player into a generic Fake arc. Retry a couple of times with a short backoff first, and
    // if it still fails, LOG it (don't swallow) so degraded generation is visible, not a mystery.
    let res;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        res = await this.llm.complete({
          // A full arc (beats + spine + cast + plants + pcBackstories) can exceed 2600 output tokens —
          // when it did, the JSON truncated mid-array, failed to parse, and the WHOLE arc silently fell
          // back to the generic Fake. Give it real headroom (you only pay for tokens actually emitted).
          system: promptText,
          messages: [{ role: 'user', content: seedDigest(seed, monsters) }],
          maxTokens: 6000,
          taskClass: 'set_piece',
          ...(this.model ? { model: this.model } : {}),
          ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
        });
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
      }
    }
    if (!res) {
      console.warn('[arc-composer] LLM composer failed after retries — using deterministic fallback arc:', (lastErr as Error)?.message ?? lastErr);
      return this.fallbackResult(seed, opts, promptText);
    }
    let parsed: unknown = {};
    let parseErr = '';
    const json = extractJson(res.text);
    if (json) {
      try {
        parsed = JSON.parse(json);
      } catch (e) {
        parseErr = `JSON.parse failed (${(e as Error).message})`;
      }
    } else {
      // No balanced JSON found — almost always a maxTokens truncation cutting the object mid-array.
      parseErr = `no parseable JSON (${res.text.length} chars, likely truncated: …${res.text.slice(-60)})`;
    }
    const arc = buildGeneratedArc(
      parsed,
      seed,
      { model: res.model, ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}), promptText, usage: { inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens }, now, fallback: false },
      monsters,
    );
    if (!arc) {
      // Don't silently hand the player a generic arc — a real composer output that failed to become a
      // usable arc is a signal worth surfacing (truncation, invalid scenario, empty beats).
      console.warn('[arc-composer] composed output unusable — using deterministic fallback arc:', parseErr || 'arc failed validation (beats/premise/reachability)');
      return this.fallbackResult(seed, opts, promptText);
    }
    return { arc, costUsd: estimateCostUsd(res.model, res.usage.inputTokens, res.usage.outputTokens) };
  }

  /** Fall back to the deterministic arc, but stamp the REAL prompt hash + fallback flag for honesty. */
  private async fallbackResult(seed: ArcSeed, opts: ArcComposeOpts | undefined, promptText: string): Promise<ArcComposeResult> {
    const r = await this.fallback.compose(seed, opts);
    r.arc.genMeta.fallback = true;
    r.arc.genMeta.composerPromptHash = sha1(promptText);
    return r;
  }
}

/**
 * RELIABILITY BACKSTOP: the composer is asked to echo a `pcBackstories` entry for every PC, but an LLM
 * intermittently drops that field on a long generation — leaving a PC with no backstory, which should
 * NEVER happen (every PC is canon). This is a tiny dedicated call that invents a fitting backstory for
 * ONLY the PCs the composer left blank. Returns [] on any error (the caller keeps whatever it had).
 */
export async function inventBackstories(
  llm: LlmProvider,
  args: { premise: string; party: { name: string; className: string }[]; temperature?: number; model?: string },
): Promise<{ backstories: { name: string; backstory: string }[]; costUsd: number }> {
  if (!args.party.length) return { backstories: [], costUsd: 0 };
  const system =
    'You are the GAME DIRECTOR. Given a campaign premise and a party, write a vivid ONE-to-two-sentence backstory for EACH character that fits the premise and gives them a personal stake in it. No mechanics, no rolls — pure fiction. Respond with ONLY a JSON object: {"backstories":[{"name":"<exact name as given>","backstory":"…"}]} — one entry per character, echoing each name exactly.';
  const user = `PREMISE: ${args.premise || '(none given — invent a fitting one)'}\n\nPARTY:\n${args.party.map((p) => `- ${p.name} the ${p.className}`).join('\n')}`;
  try {
    const res = await llm.complete({
      system,
      messages: [{ role: 'user', content: user }],
      maxTokens: 700,
      taskClass: 'set_piece',
      ...(args.model ? { model: args.model } : {}),
      ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
    });
    const costUsd = estimateCostUsd(res.model, res.usage.inputTokens, res.usage.outputTokens);
    const json = extractJson(res.text);
    if (!json) return { backstories: [], costUsd };
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const arr = Array.isArray(parsed.backstories) ? parsed.backstories : [];
    const backstories = arr
      .map((b) => {
        const bb = b && typeof b === 'object' ? (b as Record<string, unknown>) : {};
        return { name: str(bb.name, 60), backstory: str(bb.backstory, 400) };
      })
      .filter((b) => b.name && b.backstory);
    return { backstories, costUsd };
  } catch {
    return { backstories: [], costUsd: 0 };
  }
}

/** Pick a composer from the environment: MYTHWEAVER_ARC_COMPOSER = llm (default) | fake | off. */
export function buildArcComposer(llm: LlmProvider, opts?: { composerSystem?: () => string; model?: string }): ArcComposer | undefined {
  const name = (process.env.MYTHWEAVER_ARC_COMPOSER || 'llm').toLowerCase();
  if (name === 'off' || name === 'none') return undefined;
  if (name === 'fake') return new FakeArcComposer();
  return new LlmArcComposer(llm, opts ?? {});
}
