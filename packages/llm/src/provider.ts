/**
 * The LLM provider seam (spec §3) — the single "brain boundary".
 *
 * Nothing outside this package may construct a vendor request. The rest of the
 * codebase depends only on `LlmProvider` and these provider-neutral types, so
 * swapping the model (or dropping in a local model later) is a one-package change.
 *
 * Messages carry provider-neutral content BLOCKS so the orchestrator can run a
 * real multi-step tool loop (assistant tool_use -> user tool_result -> ...).
 */

export type LlmModelId = string;

/** Routing hint; the router (router.ts) maps this to a concrete model (spec §3). */
export type TaskClass = 'routine' | 'adjudication' | 'set_piece' | 'dispute';

/** A provider-neutral tool definition (maps to the engine tool contract). */
export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>;
}

export interface TextBlock {
  type: 'text';
  text: string;
}
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export interface ToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
}
export type LlmContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface LlmMessage {
  role: 'user' | 'assistant';
  /** Plain string for simple turns, or content blocks for tool-use turns. */
  content: string | LlmContentBlock[];
}

export interface LlmRequest {
  system?: string;
  messages: LlmMessage[];
  tools?: ToolDef[];
  maxTokens?: number;
  /** Routing hint resolved by the router unless `model` is set explicitly. */
  taskClass?: TaskClass;
  /** Sampling temperature (provider-native scale; omit to use the provider default). */
  temperature?: number;
  /** Explicit model override (skips routing). */
  model?: LlmModelId;
  /** Cache the stable system+tools prefix (spec §3 / prompt caching). Defaults to true. */
  cacheSystemPrompt?: boolean;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/** Convenience view of the tool_use blocks in a response. */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LlmResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: LlmUsage;
  model: LlmModelId;
  stopReason: 'end' | 'tool_use' | 'max_tokens' | 'other';
}

export interface LlmProvider {
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/** Build the assistant message to append after a response (text + tool_use blocks). */
export function responseToAssistantMessage(res: LlmResponse): LlmMessage {
  const blocks: LlmContentBlock[] = [];
  if (res.text) blocks.push({ type: 'text', text: res.text });
  for (const tc of res.toolCalls) blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
  return { role: 'assistant', content: blocks };
}
