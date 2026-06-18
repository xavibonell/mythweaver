/**
 * Provider factory — build any provider by name so callers can swap models freely
 * (spec §3: the brain boundary stays a one-package change). `model` overrides the
 * provider's default; Anthropic keeps its task-class routing when no model is given.
 */

import { AnthropicProvider } from './anthropic-provider.js';
import { GeminiProvider } from './gemini-provider.js';
import { OpenAIProvider } from './openai-provider.js';
import type { LlmProvider } from './provider.js';

export type ProviderName = 'anthropic' | 'gemini' | 'openai';

export function createProvider(name: string, opts: { model?: string } = {}): LlmProvider {
  const model = opts.model || undefined;
  switch ((name || 'anthropic').toLowerCase()) {
    case 'gemini':
      return new GeminiProvider(model ? { model } : {});
    case 'openai':
      return new OpenAIProvider(model ? { model } : {});
    case 'anthropic':
    default:
      return new AnthropicProvider();
  }
}
