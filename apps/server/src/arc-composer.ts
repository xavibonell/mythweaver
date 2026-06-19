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
import type { AdventureContext, ArcGenMeta, CampaignBlueprint, EncounterDef, StatBlock } from '@mythweaver/shared';
import { buildBlueprint, extractJson, str } from './arc-planner.js';
import { validateScenario, type Scenario } from './content.js';

/** The knobs that vary what the Director designs from — the input that makes each arc fresh. */
export interface ArcSeed {
  /** Optional — when blank, the Director invents the whole premise itself ("surprise me"). */
  theme?: string;
  tone?: string; // e.g. grim | heroic | whimsical | mystery | horror
  lengthBeats?: number; // clamped 3-8
  /** The hand-built party (name + role), which PRE-EXISTS the campaign so it's designed for them. */
  party: { name: string; className?: string }[];
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
    party: (seed.party || []).map((p) => ({ name: p.name || '', className: p.className || '' })),
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
    `PARTY (design the adventure FOR this party): ${(seed.party || []).map((p) => (p.className ? `${str(p.name, 60)} the ${str(p.className, 40)}` : str(p.name, 60))).join(', ') || '(a small adventuring party)'}`,
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
{"premise":"<what the campaign is about / its theme>","centralProblem":"<the concrete problem the party must address>","intendedEnding":"<a clear, specific resolution — how it should end if it lands>","opening":"<where/how the party starts>","beats":[{"title":"<short scene name>","summary":"<GM guidance: what's here, what's at stake, ways to engage; you MAY note suggested checks + DCs; reveal it through play>","exits":[2,3],"intent":"<what this beat accomplishes toward the ending>","monsters":[{"from":"<library id>","count":2},{"new":{"name":"<creature>","challengeRating":1,"type":"<e.g. undead>","attackName":"<e.g. Spectral Touch>","damageType":"necrotic","ranged":false},"count":1}]}],"spine":[{"milestone":"<short label>","beat":1,"intent":"<step toward the ending>"}]}

RULES:
- "beats" is an ORDERED array; the FIRST beat is where the party starts. Produce the requested number of beats (3-8).
- "exits" are the 1-based indexes of the OTHER beats reachable from this beat (a short list; the finale may have none). Build a connected path from beat 1 to the finale.
- "spine" milestones map to a beat via its 1-based "beat" index; you MAY add 1-2 final milestones with NO "beat" (pure narrative payoff after the last scene).
- "monsters" (optional, only on beats with a fight): each entry is EITHER {"from":"<library id>","count":N} to place an existing creature, OR {"new":{...},"count":N} to commission one — pick whichever the MONSTERS line in the seed allows. For "new", give ONLY fiction: name, challengeRating (0–5), type, attackName, damageType, ranged (true/false). The ENGINE computes its HP/AC/damage — never write any number other than challengeRating and count. Scale fights to the party size; not every beat needs combat.
- intendedEnding must be a concrete destination, not vague. No stat blocks, no HP/AC/to-hit. Keep prose tight (~500 words total).`;

interface StampCtx {
  model: string;
  temperature?: number;
  promptText: string;
  usage: { inputTokens: number; outputTokens: number };
  now: () => number;
  fallback: boolean;
}

const clampCount = (v: unknown): number => Math.max(1, Math.min(8, Math.round(Number(v)) || 1));

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
    scenes[ids[i]!] = { title: str(b.title, 80) || `Beat ${i + 1}`, summary: str(b.summary, 1200), exits };
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
  return { adventure, startSceneId: ids[0]!, encounters, bestiary, blueprint, genMeta };
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
    let res;
    try {
      res = await this.llm.complete({
        system: promptText,
        messages: [{ role: 'user', content: seedDigest(seed, monsters) }],
        maxTokens: 2600,
        taskClass: 'set_piece',
        ...(this.model ? { model: this.model } : {}),
        ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
      });
    } catch {
      return this.fallbackResult(seed, opts, promptText);
    }
    let parsed: unknown = {};
    const json = extractJson(res.text);
    if (json) {
      try {
        parsed = JSON.parse(json);
      } catch {
        /* fall through to coercer, which returns null on empty → fallback */
      }
    }
    const arc = buildGeneratedArc(
      parsed,
      seed,
      { model: res.model, ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}), promptText, usage: { inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens }, now, fallback: false },
      monsters,
    );
    if (!arc) return this.fallbackResult(seed, opts, promptText);
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

/** Pick a composer from the environment: MYTHWEAVER_ARC_COMPOSER = llm (default) | fake | off. */
export function buildArcComposer(llm: LlmProvider, opts?: { composerSystem?: () => string; model?: string }): ArcComposer | undefined {
  const name = (process.env.MYTHWEAVER_ARC_COMPOSER || 'llm').toLowerCase();
  if (name === 'off' || name === 'none') return undefined;
  if (name === 'fake') return new FakeArcComposer();
  return new LlmArcComposer(llm, opts ?? {});
}
