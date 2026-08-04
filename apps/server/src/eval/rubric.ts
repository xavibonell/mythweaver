/**
 * Narration-quality rubric + LLM judge (spec §10). The judge scores a DM turn on
 * six dimensions, 0–5. Used by the eval runner to compute a baseline + regression gate.
 */

import type { LlmProvider } from '@mythweaver/llm';

export const RUBRIC_DIMENSIONS = [
  { key: 'rulesFidelity', label: 'Rules fidelity', desc: 'Never contradicts the engine result or invents a mechanic; asks for rolls instead of deciding outcomes.' },
  { key: 'sourceFaithfulness', label: 'Faithfulness to source', desc: 'No fabricated rules; says "not in the rules" when apt; grounds rules it looked up.' },
  {
    key: 'style',
    label: 'Style adherence',
    // The target register is a HUMAN table DM (distilled from real sessions), not polished prose:
    // economy over lushness, length earned by the beat. Re-pinned 2026-07-07 with the exemplar RAG.
    desc: 'A human table-DM register: concrete, economical sensory strokes; LENGTH MATCHED TO THE BEAT — a simple question earns a terse in-fiction answer, only arrivals/set-pieces earn long narration; NPC dialogue clipped and distinct; dry warmth. Lush paragraphs where a short beat was called for are a FAULT, not a virtue.',
  },
  {
    key: 'pacing',
    label: 'Pacing & momentum',
    desc: 'Moves at table speed: answer first, then at most a couple of strokes; no recaps, no narrating past the natural stopping point; hands control back (usually "What do you do?"). Terse IS good pacing when the moment is small.',
  },
  { key: 'coherence', label: 'Coherence & continuity', desc: 'Consistent with the authored adventure and prior turns.' },
  { key: 'agency', label: 'Player agency & fairness', desc: 'Honors declared player intent; does not railroad or override choices.' },
] as const;

export type RubricKey = (typeof RUBRIC_DIMENSIONS)[number]['key'];
export type Scores = Record<RubricKey, number>;

export interface JudgeInput {
  playerInput: string;
  narration: string;
  toolCalls: string[];
  sceneSummary?: string;
}

export function buildJudgePrompt(input: JudgeInput): string {
  const dims = RUBRIC_DIMENSIONS.map((d) => `- ${d.key}: ${d.label} — ${d.desc}`).join('\n');
  const shape = `{${RUBRIC_DIMENSIONS.map((d) => `"${d.key}": <integer 0-5>`).join(', ')}, "rationale": "<one sentence>"}`;
  return `You are a strict, calibrated evaluator of an AI Dungeon Master's narration for a D&D 5e game.
Score each dimension from 0 (terrible) to 5 (excellent). Be critical; reserve 5 for genuinely excellent.

DIMENSIONS:
${dims}

=== CONTEXT ===
Authored scene: ${input.sceneSummary ?? '(n/a)'}
Engine tool calls this turn: ${input.toolCalls.join(', ') || '(none)'}
Player said: ${input.playerInput}

=== DM NARRATION TO JUDGE ===
"""
${input.narration}
"""

Respond with ONLY a JSON object (no prose, no code fence):
${shape}`;
}

const clampScore = (v: number): number => Math.max(0, Math.min(5, Math.round(v)));

export function parseJudgeScores(text: string): Scores {
  const scores = {} as Scores;
  // Preferred path: a well-formed JSON object.
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const obj = JSON.parse(match[0]) as Record<string, unknown>;
      if (RUBRIC_DIMENSIONS.every((d) => typeof obj[d.key] === 'number' && !Number.isNaN(obj[d.key]))) {
        for (const d of RUBRIC_DIMENSIONS) scores[d.key] = clampScore(obj[d.key] as number);
        return scores;
      }
    } catch { /* malformed/truncated JSON — fall through to lenient key extraction */ }
  }
  // Lenient fallback: pull each score by key. Recovers a reply truncated at maxTokens inside the
  // trailing (unused) "rationale" — the six numbers arrive before it, so the object need not close.
  for (const d of RUBRIC_DIMENSIONS) {
    const m = text.match(new RegExp(`"${d.key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
    if (!m) throw new Error(`Judge missing/invalid score for ${d.key}`);
    scores[d.key] = clampScore(Number(m[1]));
  }
  return scores;
}

/** Default to the strongest model for judging. */
export async function judgeNarration(llm: LlmProvider, input: JudgeInput, model = 'claude-opus-4-8', attempts = 3): Promise<Scores> {
  const base = buildJudgePrompt(input);
  let lastErr: unknown;
  let lastText = '';
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
    // A judge that once returned prose/empty/reasoning gets a firmer, shorter re-ask — the model
    // occasionally wraps or omits the object, and one bad response must NOT abort a whole paid run.
    const content = attempt === 0 ? base : `${base}\n\nYour previous reply could not be parsed. Reply with ONLY the raw JSON object on a single line — no prose, no code fence, no preamble.`;
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await llm.complete({ model, maxTokens: 700, messages: [{ role: 'user', content }] });
      lastText = res.text;
      return parseJudgeScores(res.text);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`Judge failed after ${attempts} attempt(s): ${lastErr instanceof Error ? lastErr.message : String(lastErr)} (last reply: ${JSON.stringify((lastText || '').slice(0, 120))})`);
}
