/**
 * VISUAL judge (strategy A) — score a RENDERED scene image against VISUAL_RUBRIC.
 *
 * Runs a PANEL of independent lenses (structure / habitability / fidelity), each a separate vision
 * call at temperature 0, then aggregates: per-dimension MEDIAN score + a merged, deduped defect list
 * with a CONSENSUS count (how many lenses independently saw it). The panel exists precisely because
 * one pass — like one pair of human eyes — is flaky; cross-checking is the whole point.
 *
 * Pairs with capture.ts (gets the pixels onto disk) and visual-rubric.ts (defines "good").
 */

import { readFile } from 'node:fs/promises';
import type { LlmProvider, LlmUsage } from '@mythweaver/llm';
import {
  buildVisualJudgePrompt,
  parseVisualVerdict,
  RUBRICS,
  BUILDING_RUBRIC,
  type JudgeLens,
  type Rubric,
  type VisualDefect,
  type VisualJudgeContext,
  type VisualScores,
  type VisualVerdict,
} from './visual-rubric.js';

const JUDGE_SYSTEM =
  'You are a meticulous, calibrated visual reviewer of rendered top-down tile maps. You report only what is actually drawn in the image, with concrete locations. You output strict JSON.';

export interface LensResult {
  lens: string;
  verdict: VisualVerdict;
  model: string;
  usage: LlmUsage;
}

/** A defect after merging across lenses, with how many lenses independently reported it. */
export interface MergedDefect extends VisualDefect {
  consensus: number;
  lenses: string[];
}

export interface VisualJudgeReport {
  subject: string;
  imagePath: string;
  /** Which rubric scored this image ('building' | 'town'). */
  rubric: string;
  lenses: LensResult[];
  /** Per-dimension median across the lenses. */
  scores: VisualScores;
  /** Mean of the median dimension scores — one headline number. */
  meanScore: number;
  /** Merged, deduped defects, sorted by severity then consensus. */
  defects: MergedDefect[];
  usage: LlmUsage;
}

export interface RunVisualJudgeOptions {
  imagePath: string;
  subject: string;
  tilePx?: number;
  model?: string;
  /** Which rubric to score against: 'building' (default) or 'town' (settlement composition). */
  rubric?: string;
  /** Override the default panel (e.g. a single lens for a cheap smoke test). */
  lenses?: JudgeLens[];
}

const SEVERITY_RANK = { critical: 0, major: 1, minor: 2 } as const;

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

// Canonicalise a unit label so "#3", "building #3", "top-row 3rd" all collapse to "3" where possible.
const normUnit = (s: string): string => {
  const num = s.match(/#?\s*(\d+)/);
  if (num) return num[1]!;
  return s.toLowerCase().replace(/building|instance|the/g, '').replace(/[^a-z0-9]+/g, '').slice(0, 24) || 'whole';
};

/** Merge defects across lenses: same dimension + same unit + same region ⇒ one entry + consensus count. */
function mergeDefects(results: LensResult[]): MergedDefect[] {
  const byKey = new Map<string, MergedDefect>();
  for (const r of results) {
    for (const d of r.verdict.defects) {
      const key = `${d.category}|${normUnit(d.unit)}|${d.region}`;
      const existing = byKey.get(key);
      if (existing) {
        if (!existing.lenses.includes(r.lens)) {
          existing.lenses.push(r.lens);
          existing.consensus += 1;
        }
        // Keep the most severe framing, and the longer (usually more specific) detail.
        if (SEVERITY_RANK[d.severity] < SEVERITY_RANK[existing.severity]) existing.severity = d.severity;
        if (d.detail.length > existing.detail.length) existing.detail = d.detail;
      } else {
        byKey.set(key, { ...d, consensus: 1, lenses: [r.lens] });
      }
    }
  }
  return [...byKey.values()].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.consensus - a.consensus,
  );
}

function sumUsage(results: LensResult[]): LlmUsage {
  return results.reduce<LlmUsage>(
    (acc, r) => ({
      inputTokens: acc.inputTokens + r.usage.inputTokens,
      outputTokens: acc.outputTokens + r.usage.outputTokens,
      cacheReadInputTokens: (acc.cacheReadInputTokens ?? 0) + (r.usage.cacheReadInputTokens ?? 0),
      cacheCreationInputTokens: (acc.cacheCreationInputTokens ?? 0) + (r.usage.cacheCreationInputTokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  );
}

/** Run one lens: attach the image + the lens prompt, parse the JSON verdict. */
async function runLens(llm: LlmProvider, dataBase64: string, ctx: VisualJudgeContext, lens: JudgeLens, model: string, rubric: Rubric): Promise<LensResult> {
  const res = await llm.complete({
    model,
    system: JUDGE_SYSTEM,
    temperature: 0,
    maxTokens: 3000,
    cacheSystemPrompt: false,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', mediaType: 'image/png', dataBase64 },
          { type: 'text', text: buildVisualJudgePrompt(ctx, lens, rubric) },
        ],
      },
    ],
  });
  return { lens: lens.key, verdict: parseVisualVerdict(res.text, rubric), model: res.model, usage: res.usage };
}

export async function runVisualJudge(llm: LlmProvider, opts: RunVisualJudgeOptions): Promise<VisualJudgeReport> {
  const bytes = await readFile(opts.imagePath);
  const dataBase64 = bytes.toString('base64');
  const ctx: VisualJudgeContext = { subject: opts.subject, tilePx: opts.tilePx ?? 16 };
  const rubric = (opts.rubric && RUBRICS[opts.rubric]) || BUILDING_RUBRIC;
  const lenses = opts.lenses ?? rubric.lenses;
  const model = opts.model ?? 'claude-opus-4-8';

  // allSettled, not all: a panel that loses one lens to a transient API error still gives a verdict.
  const settled = await Promise.allSettled(lenses.map((lens) => runLens(llm, dataBase64, ctx, lens, model, rubric)));
  const results = settled.filter((s): s is PromiseFulfilledResult<LensResult> => s.status === 'fulfilled').map((s) => s.value);
  const failed = settled.length - results.length;
  if (!results.length) {
    const reason = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected')?.reason;
    throw new Error(`all ${settled.length} judge lenses failed: ${reason instanceof Error ? reason.message : String(reason)}`);
  }
  if (failed) console.warn(`visual judge: ${failed}/${settled.length} lens(es) failed; reporting from the ${results.length} that succeeded`);

  const scores = {} as VisualScores;
  for (const d of rubric.dimensions) scores[d.key] = median(results.map((r) => r.verdict.scores[d.key]!));
  const meanScore = Math.round((rubric.dimensions.reduce((s, d) => s + scores[d.key]!, 0) / rubric.dimensions.length) * 100) / 100;

  return { subject: opts.subject, imagePath: opts.imagePath, rubric: rubric.key, lenses: results, scores, meanScore, defects: mergeDefects(results), usage: sumUsage(results) };
}
