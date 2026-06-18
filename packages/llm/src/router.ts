/**
 * Model routing policy (spec §3). Owned here, inside the provider layer, so a
 * routing change is a single edit and is covered by the eval harness (§10).
 *
 * NOTE: model IDs and pricing are a STANDING constraint to re-verify against the
 * canonical Anthropic pages before a swap (spec §3, §14 OQ #13). Verified
 * 2026-06-14: opus 4.8 = $5/$25, sonnet 4.6 = $3/$15 per 1M in/out tokens.
 */

import type { LlmModelId, TaskClass } from './provider.js';

export const DEFAULT_MODELS = {
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-4-6',
} as const;

/** USD per 1M tokens, for the budget meter (spec §4.4). Re-verify before relying on it. */
export const MODEL_PRICING_USD_PER_MTOK: Record<LlmModelId, { input: number; output: number }> = {
  [DEFAULT_MODELS.opus]: { input: 5, output: 25 },
  [DEFAULT_MODELS.sonnet]: { input: 3, output: 15 },
};

export interface RoutingPolicy {
  /** The long tail of routine narration, NPC chatter, simple lookups. */
  routine: LlmModelId;
  /** Combat adjudication framing, rules disputes, tagged set-pieces. */
  heavy: LlmModelId;
}

export const DEFAULT_POLICY: RoutingPolicy = {
  routine: DEFAULT_MODELS.sonnet,
  heavy: DEFAULT_MODELS.opus,
};

export function routeModel(taskClass: TaskClass = 'routine', policy: RoutingPolicy = DEFAULT_POLICY): LlmModelId {
  switch (taskClass) {
    case 'adjudication':
    case 'set_piece':
    case 'dispute':
      return policy.heavy;
    case 'routine':
    default:
      return policy.routine;
  }
}

/** Estimate USD cost of a call from its token usage. */
export function estimateCostUsd(model: LlmModelId, inputTokens: number, outputTokens: number): number {
  const p = MODEL_PRICING_USD_PER_MTOK[model];
  if (!p) return 0;
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}
