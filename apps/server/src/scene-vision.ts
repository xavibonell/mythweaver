/**
 * VISION SEMANTIC GATE (Weave "fidelity flywheel", Layer 4): render the composed scene, show the image +
 * the brief to a VISION model, and ask whether the brief's KEY features are PRESENT — the only check that
 * judges MEANING, not structure, so it catches the "pun" class (a maze that read as furnished walls, a
 * cave that was a lone arrow, a camp not in the clearing) that every deterministic validator passes.
 *
 * The prompt was FALSIFY-FIRST calibrated (spike-judge): an un-calibrated critic conflated art fidelity
 * (rope-vs-plank sprite, water hue) with semantic absence and failed FAITHFUL scenes. This one judges only
 * PRESENCE OF CONCEPT — a plank bridge IS "a bridge", blue tiles ARE "water" — so it passes good scenes
 * (no wasted retries) and flags only entirely-absent features (verified 3/3 on good/mismatch/miss probes).
 *
 * Degrade-proof: any failure (no key, parse error, provider hiccup) returns null → the scene ships as-is.
 */

import type { LlmProvider } from '@mythweaver/llm';
import { renderSceneMapToPng } from '@mythweaver/scene';
import type { SceneMap } from '@mythweaver/shared';

export interface SceneCritique {
  score: number; // fraction of key brief features present, 0..1
  faithful: boolean; // every key feature present (stylised is fine)
  present: string[];
  missing: string[]; // key features ENTIRELY absent — the actionable signal
  fix: string; // one imperative line naming only what to add
}

const JUDGE_SYSTEM = `You are a scene-completeness critic for a TOP-DOWN tile map in a retro fantasy RPG built from a small fixed sprite set. You are shown a rendered map and the BRIEF it was generated from. Judge ONLY whether the brief's KEY NAMED FEATURES are PRESENT and roughly arranged — this is about MEANING, not art.

A feature COUNTS AS PRESENT if ANY sprite plausibly stands for it: a plank/wood bridge IS "a bridge" (even "rope-and-plank"); blue tiles ARE "water"/"a channel"/"a river"; a walled tile structure IS "ruins"/"a building"; green conifers ARE "a forest"; a dark opening in rock IS "a cave mouth". DO NOT penalize sprite style, exact color, exact count, art quality, or how "pretty" it is. Mark a feature MISSING only if the CONCEPT is entirely absent (the brief needs water and there is NO water at all; needs a cave mouth and there is none).

Reply ONLY with JSON, no prose:
{"score": 0.0-1.0 (fraction of KEY features present), "faithful": true if EVERY key feature is present (stylised is fine), "present": ["key features you can see"], "missing": ["key features ENTIRELY absent"], "fix": "one imperative line naming ONLY the missing features to add (empty string if faithful)"}`;

/** Render the map, ask the vision model whether the brief's key features are present. null on any failure. */
export async function critiqueScene(
  llm: LlmProvider,
  model: string | undefined,
  map: SceneMap,
  brief: string,
  assetsRoot: string,
): Promise<SceneCritique | null> {
  try {
    const png = renderSceneMapToPng(map, { assetsRoot, neutralLighting: true });
    const res = await llm.complete({
      system: JUDGE_SYSTEM,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: `BRIEF: ${brief}\n\nJudge the attached top-down map against this brief.` },
          { type: 'image', mediaType: 'image/png', dataBase64: png.toString('base64') },
        ],
      }],
      maxTokens: 700,
      ...(model ? { model } : {}),
    });
    const m = res.text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const raw = JSON.parse(m[0]) as Partial<SceneCritique>;
    const arr = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string').slice(0, 12) : []);
    const missing = arr(raw.missing);
    const score = typeof raw.score === 'number' ? Math.max(0, Math.min(1, raw.score)) : missing.length ? 0.3 : 1;
    return {
      score,
      faithful: raw.faithful === true || (raw.faithful === undefined && missing.length === 0),
      present: arr(raw.present),
      missing,
      fix: typeof raw.fix === 'string' ? raw.fix.slice(0, 300) : '',
    };
  } catch {
    return null; // degrade — the scene ships as composed
  }
}

/** Turn a critique into re-composition guidance for the programmer's model-only channel. */
export function critiqueToGuidance(c: SceneCritique): string {
  return `SCENE REVIEW — a rendered attempt was MISSING these brief features: ${c.missing.join('; ')}. In this new program you MUST include them.${c.fix ? ` ${c.fix}` : ''} Keep everything that was already correct.`;
}
