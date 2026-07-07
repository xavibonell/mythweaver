/**
 * Exemplar ingestion core (Technique B — per-turn style-exemplar RAG, docs/DM-LAYER-TODO.md §Phase B).
 *
 * Pure, testable functions that turn REAL session transcripts (speaker-labeled "DM:"/"NAME:" lines)
 * into candidate STYLE EXEMPLARS: an exchange window (a short player `cue` + the DM beat) tagged with
 * a `moveType` so retrieval can match the register to the moment (a roll verdict vs a scene arrival).
 *
 * The paid curation pass (scripts/ingest-exemplars.mjs) then keep/drops, anonymizes-BY-REWRITE (generic
 * equivalents, cadence intact — never "[CITY]" placeholders), and strips mechanical outcomes, reusing
 * the distillation guardrails: exemplars are VOICE, never rules, never engine verdicts.
 */

export type ExemplarMoveType =
  | 'scene-set' // arrival / establishing narration (long, sensory, motion-through-space)
  | 'npc-voice' // an NPC speaks in quoted dialogue
  | 'roll-call' // the DM asks for a check ("Make a perception check")
  | 'roll-verdict' // the DM narrates after a declared roll result (tiered outcome narration)
  | 'short-answer' // a terse in-fiction answer to a player question
  | 'combat-beat' // combat narration/tempo
  | 'general';

export interface TranscriptTurn {
  speaker: string; // "DM" or a player name
  text: string;
}

export interface ExemplarCandidate {
  id: string;
  source: string; // e.g. "CR3 E1"
  moveType: ExemplarMoveType;
  cue: string; // up to 2 preceding player lines, compact ("NAME: …")
  text: string; // the DM beat
}

/** Curated exemplar row as written to content/exemplars/<set>.jsonl. */
export interface ExemplarRow {
  id: string;
  source: string;
  moveType: ExemplarMoveType;
  tone?: string;
  cue: string;
  text: string;
}

/** Parse a speaker-labeled transcript ("DM: …" / "LAURA: …"); '#' lines are headers/comments. */
export function parseTranscript(raw: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = /^([A-Z][A-Z .'-]{1,20}):\s*(.+)$/.exec(t);
    if (!m) continue;
    turns.push({ speaker: m[1]!.trim(), text: m[2]!.trim() });
  }
  return turns;
}

/** Table-meta noise that disqualifies a beat (breaks, sponsors, pure foley, out-of-game logistics). */
const META_NOISE = /\b(we'll take a break|our sponsor|merch|patreon|is it thursday|don't forget to|subscribe)\b/i;
const PURE_FOLEY = /^\(?[a-z\s]+\)$/i; // "(laughter)", "(crashing)"

/** A beat is usable when it's real prose — not foley, not table logistics, not a fragment. */
export function isCleanBeat(text: string): boolean {
  if (text.length < 40) return false;
  if (PURE_FOLEY.test(text)) return false;
  if (META_NOISE.test(text)) return false;
  return true;
}

const ROLL_CALL = /\b(make|give me|go ahead and (make|roll)|roll)( me)?( another)? an? .{0,40}?(check|save|saving throw)\b/i;
const DECLARED_NUMBER = /(^|\s)(natural\s+)?\d{1,2}(\s*(total|\.|!|\?)?\s*)$|that's an? \d{1,2}\b|\b\d{1,2} total\b/i;
const QUOTED_SPEECH = /"[^"]{8,}"/;
const ARRIVAL = /\b(as you (step|walk|enter|approach|arrive|climb|make your way|come))|((you|the party) (step|walk|enter|approach|arrive)s?\b)|\bwe begin with\b/i;
const COMBAT = /\b(initiative|swings?|slashes?|lunges?|parr(y|ies)|dodges?|blade|arrow|claws?|strikes?)\b/i;

/**
 * Heuristic moveType classification of a DM beat in its exchange context ($0, deterministic).
 * Priority: verdict > call > short-answer > scene-set > npc-voice > combat > general.
 */
export function classifyMove(cue: string, text: string): ExemplarMoveType {
  const lastCueLine = cue.split(' / ').pop() ?? '';
  const cueBody = lastCueLine.replace(/^[A-Z][A-Z .'-]{1,20}:\s*/, '');
  if (DECLARED_NUMBER.test(cueBody)) return 'roll-verdict';
  if (ROLL_CALL.test(text)) return 'roll-call';
  if (cueBody.trim().endsWith('?') && text.length < 240) return 'short-answer';
  if (text.length > 600 && ARRIVAL.test(text)) return 'scene-set';
  if (QUOTED_SPEECH.test(text)) return 'npc-voice';
  if (COMBAT.test(text) && text.length < 700) return 'combat-beat';
  return 'general';
}

/** Build exchange windows: every clean DM beat + up to `cueLines` preceding non-DM lines as the cue.
 *  Roll-calls bypass the length floor — "Make a stealth check." is SHORT by design; that's the register. */
export function buildCandidates(turns: TranscriptTurn[], source: string, cueLines = 2): ExemplarCandidate[] {
  const out: ExemplarCandidate[] = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!;
    if (t.speaker !== 'DM') continue;
    const isRollCall = ROLL_CALL.test(t.text) && t.text.length >= 15 && !PURE_FOLEY.test(t.text) && !META_NOISE.test(t.text);
    if (!isRollCall && !isCleanBeat(t.text)) continue;
    const cues: string[] = [];
    for (let j = i - 1; j >= 0 && cues.length < cueLines; j--) {
      const p = turns[j]!;
      if (p.speaker === 'DM') break; // the cue is the player move immediately before this beat
      cues.unshift(`${p.speaker}: ${p.text.slice(0, 140)}`);
    }
    const cue = cues.join(' / ');
    out.push({ id: `${source.replace(/\s+/g, '-').toLowerCase()}#${i}`, source, moveType: classifyMove(cue, t.text), cue, text: t.text.slice(0, 1200) });
  }
  return out;
}

/**
 * Deterministic, diversity-preserving sampling: evenly-spaced picks per (moveType) bucket up to
 * `capPerType`, interleaved across sources by construction (candidates arrive in episode order).
 */
export function sampleCandidates(all: ExemplarCandidate[], capPerType = 350, totalCap = 4000): ExemplarCandidate[] {
  const byType = new Map<ExemplarMoveType, ExemplarCandidate[]>();
  for (const c of all) {
    const list = byType.get(c.moveType) ?? [];
    list.push(c);
    byType.set(c.moveType, list);
  }
  const out: ExemplarCandidate[] = [];
  for (const [, list] of byType) {
    const cap = Math.min(capPerType, list.length);
    const step = list.length / cap;
    for (let i = 0; i < cap; i++) out.push(list[Math.floor(i * step)]!);
  }
  return out.slice(0, totalCap);
}

/**
 * The curation system prompt (one batched LLM call over ~12 candidates). Same guardrails as
 * distillation: anonymize (BY REWRITE) + never keep an engine verdict. JSON in / JSON out.
 */
export const CURATE_SYSTEM = `You curate STYLE EXEMPLARS from a real tabletop D&D session for an AI Dungeon Master to imitate. You receive a JSON array of candidates: {i, moveType, cue, text} — "cue" is what a player just said/did, "text" is how the human DM responded.

For EACH candidate output {i, keep, moveType, tone, cue, text}:
- keep=false when: not self-contained (depends on unseen context), mostly table-talk/logistics/jokes about the real players, heavy crosstalk, or it's dull. Keep only beats a great DM would be proud of. Expect to drop half.
- moveType: confirm or correct — scene-set | npc-voice | roll-call | roll-verdict | short-answer | combat-beat | general.
- tone: one word (ominous, warm, playful, tense, matter-of-fact, wondrous...).
- REWRITE cue and text with these rules, PRESERVING the cadence, rhythm, sentence shapes, and length:
  1. ANONYMIZE by substitution, not placeholders: swap every proper noun (people, places, gods, factions, campaign terms) for a plain generic equivalent ("Jrusar" -> "the city", "Imogen" -> "you", a made-up plain name for a speaking NPC). NEVER output brackets like [name].
  2. STRIP MECHANICAL VERDICTS: the exemplar must never state a roll total's success, a hit/miss, damage numbers, ACs, or DCs. Rephrase around them ("With a 17—" -> "With that result—") or trim; if the beat is NOTHING but a verdict, keep=false. Asking for a check ("Make a perception check") is fine — that's a roll-call, not a verdict.
  3. Remove parenthetical table noise ("(laughter)") unless it's an in-fiction sound cue.
  4. Cue: compress to ONE short line of player intent ("Player: asks whether the spire district is crowded").
Output ONLY the JSON array, no prose.`;
