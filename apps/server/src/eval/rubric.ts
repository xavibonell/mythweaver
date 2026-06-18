/**
 * Narration-quality rubric + LLM judge (spec §10). The judge scores a DM turn on
 * six dimensions, 0–5. Used by the eval runner to compute a baseline + regression gate.
 */

import type { LlmProvider } from '@mythweaver/llm';

export const RUBRIC_DIMENSIONS = [
  { key: 'rulesFidelity', label: 'Rules fidelity', desc: 'Never contradicts the engine result or invents a mechanic; asks for rolls instead of deciding outcomes.' },
  { key: 'sourceFaithfulness', label: 'Faithfulness to source', desc: 'No fabricated rules; says "not in the rules" when apt; grounds rules it looked up.' },
  { key: 'style', label: 'Style adherence', desc: 'Vivid, economical scene-setting; distinct NPC voices; fair-but-firm DM voice.' },
  { key: 'pacing', label: 'Pacing & momentum', desc: 'Keeps the scene moving; no rambling; usually ends by asking what the players do.' },
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

export function parseJudgeScores(text: string): Scores {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Judge returned no JSON object');
  const obj = JSON.parse(match[0]) as Record<string, unknown>;
  const scores = {} as Scores;
  for (const d of RUBRIC_DIMENSIONS) {
    const v = obj[d.key];
    if (typeof v !== 'number' || Number.isNaN(v)) throw new Error(`Judge missing/invalid score for ${d.key}`);
    scores[d.key] = Math.max(0, Math.min(5, Math.round(v)));
  }
  return scores;
}

/** Default to the strongest model for judging. */
export async function judgeNarration(llm: LlmProvider, input: JudgeInput, model = 'claude-opus-4-8'): Promise<Scores> {
  const res = await llm.complete({
    model,
    maxTokens: 400,
    messages: [{ role: 'user', content: buildJudgePrompt(input) }],
  });
  return parseJudgeScores(res.text);
}
