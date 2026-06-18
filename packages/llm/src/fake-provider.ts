/**
 * A scripted LlmProvider for deterministic tests of the orchestrator turn-loop
 * (no network, no key). Build a list of responses; each `complete()` returns the
 * next one. Helpers below construct the common shapes.
 */

import type { LlmProvider, LlmRequest, LlmResponse, ToolCall } from './provider.js';

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0 };

export function fakeText(text: string, model = 'fake-model'): LlmResponse {
  return { text, toolCalls: [], usage: { ...ZERO_USAGE }, model, stopReason: 'end' };
}

export function fakeToolUse(calls: ToolCall[], text = '', model = 'fake-model'): LlmResponse {
  return { text, toolCalls: calls, usage: { ...ZERO_USAGE }, model, stopReason: 'tool_use' };
}

export class FakeLlmProvider implements LlmProvider {
  private index = 0;
  /** Records every request it received, for assertions. */
  readonly requests: LlmRequest[] = [];

  constructor(private readonly scripted: LlmResponse[]) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    // Snapshot so later mutation of the caller's `messages` array doesn't rewrite
    // what this call received.
    this.requests.push(structuredClone(req));
    const next = this.scripted[this.index++];
    if (!next) throw new Error(`FakeLlmProvider: no scripted response for call #${this.index}`);
    return next;
  }
}
