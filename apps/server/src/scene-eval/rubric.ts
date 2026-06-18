/**
 * Scene-composition rubric + LLM judge (docs/VISUAL-LAYER-TODO.md Phase E; SCENE-CONTRACTS surface B).
 * The judge reads the brief + a text digest of the FROZEN SceneMap (terrain, the object_map, the
 * narration) and scores composition quality 0–5 per dimension. Pairs with the deterministic
 * invariants in runner.ts (those catch hard regressions; this scores the fuzzy "is it good").
 */

import type { LlmProvider } from '@mythweaver/llm';

export const SCENE_RUBRIC = [
  { key: 'spatialSense', label: 'Spatial sense', desc: 'Believable layout: a plaza/room reads as one coherent space; a centrepiece (fountain/landmark) is centred; buildings line edges; nothing randomly scattered or piled on one spot.' },
  { key: 'legibility', label: 'Legibility', desc: 'Readable density — not overcrowded or cluttered, not barren; clear focal points; sensible amount of decor.' },
  { key: 'briefCoherence', label: 'Brief coherence', desc: 'The scene actually contains what the brief asked for — the right structures, actors, terrain and mood.' },
  { key: 'completeness', label: 'Completeness', desc: 'Feels like a real, lived-in place: enough relevant detail, nothing major from the brief missing.' },
] as const;

export type SceneRubricKey = (typeof SCENE_RUBRIC)[number]['key'];
export type SceneScores = Record<SceneRubricKey, number>;

export interface SceneJudgeInput {
  brief: string;
  digest: string;
}

export function buildSceneJudgePrompt(input: SceneJudgeInput): string {
  const dims = SCENE_RUBRIC.map((d) => `- ${d.key}: ${d.label} — ${d.desc}`).join('\n');
  const shape = `{${SCENE_RUBRIC.map((d) => `"${d.key}": <integer 0-5>`).join(', ')}, "rationale": "<one sentence>"}`;
  return `You are a strict, calibrated evaluator of a procedurally-composed top-down RPG scene.
A "scene-setter" turned the player's brief into a tile map; you judge the resulting COMPOSITION
(not the art quality — assume placeholder tiles). Score each dimension 0 (terrible) to 5 (excellent).
Be critical; reserve 5 for genuinely excellent. Coordinates are (col,row); the grid origin is top-left.

DIMENSIONS:
${dims}

=== PLAYER BRIEF ===
${input.brief}

=== RESULTING SCENE (frozen map) ===
${input.digest}

Respond with ONLY a JSON object (no prose, no code fence):
${shape}`;
}

export function parseSceneScores(text: string): SceneScores {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Judge returned no JSON object');
  const obj = JSON.parse(match[0]) as Record<string, unknown>;
  const scores = {} as SceneScores;
  for (const d of SCENE_RUBRIC) {
    const v = obj[d.key];
    if (typeof v !== 'number' || Number.isNaN(v)) throw new Error(`Judge missing/invalid score for ${d.key}`);
    scores[d.key] = Math.max(0, Math.min(5, Math.round(v)));
  }
  return scores;
}

/** Default to the strongest model for judging. */
export async function judgeScene(llm: LlmProvider, input: SceneJudgeInput, model = 'claude-opus-4-8'): Promise<SceneScores> {
  const res = await llm.complete({ model, maxTokens: 400, messages: [{ role: 'user', content: buildSceneJudgePrompt(input) }] });
  return parseSceneScores(res.text);
}
