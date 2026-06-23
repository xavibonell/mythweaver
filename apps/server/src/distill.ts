/**
 * Style distillation — turn real session transcripts into a DM voice guide (spec §6:
 * "style is data, not weights"). We do NOT fine-tune; we extract the DM's voice into a
 * Markdown style block that the DM Lab splices into the playbook (a temporary override the
 * operator tests live, then persists if happy).
 *
 * Strategy: chunk the transcript, MAP each excerpt to terse voice notes (parallel), then
 * REDUCE the notes into a compact style guide + anonymized exemplars. Two hard guardrails
 * the prompts enforce: (1) anonymize — strip real names/places so other campaigns don't bleed
 * in; (2) never capture passages where the DM states a mechanical outcome — the rules engine
 * stays authoritative, so the voice must not learn to decide hits/damage/success.
 */

import type { LlmProvider } from '@mythweaver/llm';

/**
 * Two input kinds:
 *  - 'transcript' — a real play transcript → distil the DM's VOICE (cadence + exemplars).
 *  - 'guide'      — a best-practices/advice doc → distil actionable DM PRINCIPLES (directives).
 */
export type DistillMode = 'transcript' | 'guide';

/** Hard input cap (chars). Above this we sample; the endpoint rejects beyond DISTILL_MAX_INPUT. */
export const DISTILL_MAX_INPUT = 400_000;
const CHUNK_CHARS = 14_000;
const MAX_CHUNKS = 6; // bound cost: at most MAX_CHUNKS map calls + 1 reduce
const SINGLE_CALL_UNDER = 16_000;

export interface DistillResult {
  /** Markdown block (no markers) — the lab wraps + splices it into the playbook. */
  styleBlock: string;
  /** Which kind of distillation produced it (drives the playbook marker the lab uses). */
  mode: DistillMode;
  /** Excerpts actually analysed, and roughly how many chars were covered (transparency). */
  chunks: number;
  sampledChars: number;
  inputChars: number;
}

const MAP_SYSTEM = `You analyse a transcript excerpt from a REAL tabletop D&D session to capture the DUNGEON MASTER's voice.
Extract ONLY the DM's narration and speech patterns; ignore players and out-of-character table talk.
Report terse bullet notes on:
- diction & tone (word choice, formality, humour, warmth)
- sentence rhythm & length; how descriptions are paced
- scene-opening techniques (how a new place/beat is introduced)
- how NPCs are voiced (tics, cadence, how dialogue is framed)
- pacing / transitions / how the DM hands agency back to players
- 2-3 SHORT example snippets of the DM's narration, ANONYMISED (replace any proper noun — names, places, gods, campaign terms — with a generic placeholder like [name]/[place]).
HARD RULES: never include a passage where the DM states a mechanical OUTCOME (a hit, miss, damage number, or whether a check succeeded) — we keep all mechanics in a separate engine. Output bullets only, no preamble.`;

const REDUCE_SYSTEM = `You are a DM style editor. You are given voice notes distilled from several excerpts of ONE Dungeon Master's real sessions.
Synthesise them into a concise STYLE GUIDE that will make an AI Dungeon Master speak in this DM's voice.

Output GitHub-flavoured Markdown, under ~400 words, in EXACTLY this shape:

## VOICE (distilled from real sessions)
- <6-9 imperative style directives: tone, diction, sentence rhythm, scene openings, NPC voicing, pacing/handing-back agency>

### Exemplars (emulate the cadence, NEVER copy the content)
- "<short anonymised snippet 1>"
- "<short anonymised snippet 2>"
- "<4-6 snippets total>"

HARD RULES:
- Anonymise everything: no real proper nouns (names, places, deities, campaign terms) — use generic placeholders.
- NEVER instruct the DM to decide a mechanical outcome (hit/miss/damage/success). Voice only; the rules engine owns mechanics.
- Directives must be about HOW to speak, not WHAT happens in any specific campaign.`;

const GUIDE_MAP_SYSTEM = `You extract actionable Dungeon Master guidance from an excerpt of a best-practices / advice document (NOT a play transcript).
List terse imperative bullets: concrete directives on HOW a DM should run play — pacing, telegraphing danger, spotlight sharing, player agency, ruling fairly, improvising, session flow, handling tone.
Ignore rules-math specifics and any campaign-specific examples.
HARD RULE: never produce a directive that has the DM decide a mechanical OUTCOME (a hit/miss/damage/whether a check passed) — a separate engine owns that; "call for a check" is fine. Output bullets only, no preamble.`;

const GUIDE_REDUCE_SYSTEM = `You are a DM coaching editor. You are given best-practices material (either bullet notes or a short excerpt) about running a tabletop RPG.
Synthesise it into a concise PRINCIPLES guide for an AI Dungeon Master.

Output GitHub-flavoured Markdown, under ~400 words, in EXACTLY this shape:

## PRINCIPLES (distilled from a guide)
- <6-12 imperative directives, grouped logically: pacing, player agency, telegraphing, spotlight, fairness, improv, tone>

HARD RULES:
- Keep it about HOW to run play, not specific rules numbers or DCs.
- NEVER instruct the DM to decide a mechanical outcome (hit/miss/damage/success) — the rules engine owns mechanics; the DM may "call for" a check.
- No campaign-specific proper nouns.`;

interface PromptSet {
  map: string;
  reduce: string;
  /** Instruction for the small-input single call. */
  single: string;
  userLabel: string;
}
const PROMPTS: Record<DistillMode, PromptSet> = {
  transcript: {
    map: MAP_SYSTEM,
    reduce: REDUCE_SYSTEM,
    single: `${MAP_SYSTEM}\n\nAfter analysing, IMMEDIATELY produce the final style guide.\n\n${REDUCE_SYSTEM}`,
    userLabel: 'Transcript',
  },
  guide: {
    map: GUIDE_MAP_SYSTEM,
    // The reduce prompt accepts notes OR a short excerpt, so it doubles as the single-call prompt.
    reduce: GUIDE_REDUCE_SYSTEM,
    single: GUIDE_REDUCE_SYSTEM,
    userLabel: 'Best-practices document',
  },
};

async function complete(llm: LlmProvider, system: string, user: string, maxTokens: number): Promise<string> {
  const res = await llm.complete({ system, messages: [{ role: 'user', content: user }], maxTokens, temperature: 0.3 });
  return res.text.trim();
}

function chunk(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK_CHARS) out.push(text.slice(i, i + CHUNK_CHARS));
  return out;
}

/** Evenly sample at most MAX_CHUNKS excerpts so a long corpus is represented, not just its head. */
function sample(chunks: string[]): string[] {
  if (chunks.length <= MAX_CHUNKS) return chunks;
  const picked: string[] = [];
  const step = chunks.length / MAX_CHUNKS;
  for (let i = 0; i < MAX_CHUNKS; i++) picked.push(chunks[Math.floor(i * step)]!);
  return picked;
}

export async function distillStyle(llm: LlmProvider, input: string, mode: DistillMode = 'transcript'): Promise<DistillResult> {
  const text = input.trim();
  if (!text) throw new Error('No text provided.');
  const p = PROMPTS[mode];
  const clipped = text.slice(0, DISTILL_MAX_INPUT);

  // Small input: a single analyse-and-synthesise call.
  if (clipped.length <= SINGLE_CALL_UNDER) {
    const styleBlock = await complete(llm, p.single, `${p.userLabel}:\n\n${clipped}`, 1600);
    return { styleBlock, mode, chunks: 1, sampledChars: clipped.length, inputChars: text.length };
  }

  // Large input: MAP each sampled excerpt to notes (parallel), then REDUCE to the final block.
  const excerpts = sample(chunk(clipped));
  const notes = await Promise.all(
    excerpts.map((e, i) => complete(llm, p.map, `Excerpt ${i + 1} of ${excerpts.length}:\n\n${e}`, 700)),
  );
  const styleBlock = await complete(
    llm,
    p.reduce,
    `Notes from ${excerpts.length} excerpts:\n\n${notes.map((n, i) => `--- excerpt ${i + 1} ---\n${n}`).join('\n\n')}`,
    1600,
  );
  return { styleBlock, mode, chunks: excerpts.length, sampledChars: excerpts.length * CHUNK_CHARS, inputChars: text.length };
}

// ---------------------------------------------------------------------------
// Pass 2 — RECONCILE: merge a freshly-distilled block into the WHOLE playbook
// cumulatively. The LLM is advisory only (it returns a small JSON MergePlan);
// the client does the deterministic, marker-bounded text surgery so the
// hand-written CANON (everything outside the markers) can never be clobbered.
// Keep these marker strings in sync with markersFor() in dm-lab-page.ts.
// ---------------------------------------------------------------------------

export const DISTILL_MARKERS: Record<DistillMode, { begin: string; end: string }> = {
  guide: { begin: '<!-- DISTILLED-PRINCIPLES:BEGIN -->', end: '<!-- DISTILLED-PRINCIPLES:END -->' },
  transcript: { begin: '<!-- DISTILLED-STYLE:BEGIN -->', end: '<!-- DISTILLED-STYLE:END -->' },
};

export interface MergePlan {
  /** New bullet directives (text only, no leading "- ") to ADD cumulatively. */
  keep: string[];
  /** Direct contradictions with an EXISTING distilled bullet — operator approves each. */
  conflicts: { add: string; remove: string; why: string }[];
  /** Things dropped or flagged (duplicates, canon overlap, mechanics) — shown, never applied. */
  notes: string[];
}

/** Belt-and-suspenders: a distilled directive must never carry a mechanical NUMBER. */
const MECHANICS_TRIPWIRE = /\b(dc|ac)\s*\d|\b\d+\s*hp\b|\b\d+d\d+\b|\bto[- ]hit\b|[-+]\d+\s+to\s+(hit|the)/i;

const RECONCILE_SYSTEM = `You merge a NEW set of distilled Dungeon Master guidance bullets into an existing AI DM playbook, CUMULATIVELY and conservatively.

You get the FULL current playbook plus the new bullets. The playbook has CANON sections (hand-authored, AUTHORITATIVE) and ONE auto-managed DISTILLED region delimited by HTML markers ("<!-- DISTILLED-...:BEGIN/END -->"). Only the text BETWEEN those markers may grow or change.

For each NEW bullet choose exactly one:
- KEEP — it adds something not already covered anywhere in the playbook → put its directive text in "keep".
- DROP — it is already substantially present (in CANON or the existing DISTILLED region) → do NOT keep it; add a short line to "notes" ("duplicate of: …", or "overlaps canon: … — hand-edit if you want it stronger").
- CONFLICT — it DIRECTLY contradicts an EXISTING bullet that is INSIDE the DISTILLED region, on the same topic → add { "add": <new bullet text>, "remove": <the existing distilled bullet it would replace>, "why": <one line> }.

HARD RULES:
- NEVER remove or edit CANON. "remove" may ONLY quote a line that currently sits INSIDE the distilled markers. If a new bullet conflicts with CANON, DROP it and explain in "notes" — canon always wins.
- Bias to KEEP / cumulative. Only raise a conflict when the contradiction is direct and on the same topic; when unsure, keep both.
- NEVER keep a bullet that encodes a mechanical number (a DC, AC, HP, damage dice, to-hit, modifier). Drop it to "notes". The engine owns mechanics; this is voice/principles only.
- "keep"/"add"/"remove" hold the directive TEXT ONLY — no leading "- ".

Return ONLY a JSON object, no prose, no code fence:
{"keep":["…"],"conflicts":[{"add":"…","remove":"…","why":"…"}],"notes":["…"]}`;

function bulletsOf(block: string): string[] {
  return block
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+/.test(l))
    .map((l) => l.replace(/^[-*]\s+/, ''));
}

/** Degrade gracefully: a missing/garbled plan becomes a pure cumulative append of the new bullets. */
function fallbackPlan(newBlock: string): MergePlan {
  return { keep: bulletsOf(newBlock), conflicts: [], notes: [] };
}

function parsePlan(raw: string): MergePlan | null {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) s = fence[1].trim();
  const obj = s.match(/\{[\s\S]*\}/);
  if (!obj) return null;
  try {
    const p = JSON.parse(obj[0]) as Partial<MergePlan>;
    if (!Array.isArray(p.keep)) return null;
    return {
      keep: p.keep.filter((x): x is string => typeof x === 'string' && x.trim().length > 0),
      conflicts: Array.isArray(p.conflicts)
        ? (p.conflicts as ReadonlyArray<Record<string, unknown>>)
            .filter((c) => c && typeof c.add === 'string' && typeof c.remove === 'string')
            .map((c) => ({ add: c.add as string, remove: c.remove as string, why: typeof c.why === 'string' ? c.why : '' }))
        : [],
      notes: Array.isArray(p.notes) ? p.notes.filter((x): x is string => typeof x === 'string') : [],
    };
  } catch {
    return null;
  }
}

export async function reconcile(llm: LlmProvider, mode: DistillMode, newBlock: string, currentPlaybook: string): Promise<MergePlan> {
  const markers = DISTILL_MARKERS[mode];
  const pb = currentPlaybook.slice(0, 60_000);
  const user = `CURRENT PLAYBOOK (canon = everything OUTSIDE the ${markers.begin} … ${markers.end} region; the distilled region between those markers is what you may grow):\n\n${pb}\n\n---\nNEW DISTILLED BULLETS to merge:\n\n${newBlock}`;

  let plan: MergePlan;
  try {
    plan = parsePlan(await complete(llm, RECONCILE_SYSTEM, user, 1600)) ?? fallbackPlan(newBlock);
  } catch {
    return fallbackPlan(newBlock);
  }

  // Server-side tripwire: any kept bullet that encodes a number is dropped to notes.
  const keep: string[] = [];
  const notes = [...plan.notes];
  for (const k of plan.keep) {
    if (MECHANICS_TRIPWIRE.test(k)) notes.push(`dropped (looks mechanical — add to canon by hand if you meant it): ${k}`);
    else keep.push(k);
  }
  return { keep, conflicts: plan.conflicts, notes };
}
