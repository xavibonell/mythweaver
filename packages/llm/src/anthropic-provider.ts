/**
 * Anthropic adapter for the LlmProvider seam (spec §3).
 *
 * Implemented with a direct `fetch` to the Messages API (zero extra deps, always
 * installable). Swapping to the official `@anthropic-ai/sdk` is a drop-in change
 * confined to THIS file. This is the only place a vendor request is constructed.
 *
 * Adds: provider-neutral content-block mapping (tool_use / tool_result), prompt
 * caching on the stable system+tools prefix, and timeout + backoff retry.
 */

import type {
  LlmContentBlock,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  ToolCall,
} from './provider.js';
import { DEFAULT_POLICY, routeModel, type RoutingPolicy } from './router.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicProviderOptions {
  apiKey?: string;
  policy?: RoutingPolicy;
  defaultMaxTokens?: number;
  /** Per-request timeout in ms (default 60s). */
  timeoutMs?: number;
  /** Retries on 429/5xx/network errors (default 2). */
  retries?: number;
}

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}
interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}
type AnthropicBlock = AnthropicTextBlock | AnthropicToolUseBlock | { type: string };

interface AnthropicMessageResponse {
  content: AnthropicBlock[];
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function mapContent(content: string | LlmContentBlock[]): unknown {
  if (typeof content === 'string') return content;
  return content.map((b) => {
    if (b.type === 'text') return { type: 'text', text: b.text };
    if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
    return { type: 'tool_result', tool_use_id: b.toolUseId, content: b.content, ...(b.isError ? { is_error: true } : {}) };
  });
}

export class AnthropicProvider implements LlmProvider {
  private readonly apiKey: string;
  private readonly policy: RoutingPolicy;
  private readonly defaultMaxTokens: number;
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(opts: AnthropicProviderOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
    this.policy = opts.policy ?? DEFAULT_POLICY;
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 1024;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.retries = opts.retries ?? 2;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    if (!this.apiKey) throw new Error('ANTHROPIC_API_KEY is not set (see .env.example).');
    const model = req.model ?? routeModel(req.taskClass, this.policy);
    const cache = req.cacheSystemPrompt ?? true;

    const body: Record<string, unknown> = {
      model,
      max_tokens: req.maxTokens ?? this.defaultMaxTokens,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      messages: req.messages.map((m: LlmMessage) => ({ role: m.role, content: mapContent(m.content) })),
    };

    // Cache the stable prefix: cache_control on the last system block also caches
    // the (earlier-rendered) tools. If there's no system block, cache the last tool.
    if (req.system) {
      body.system = cache
        ? [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }]
        : req.system;
    }
    if (req.tools && req.tools.length > 0) {
      const toolList: Record<string, unknown>[] = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
      const last = toolList[toolList.length - 1];
      if (cache && !req.system && last) last.cache_control = { type: 'ephemeral' };
      body.tools = toolList;
    }

    let res = await this.fetchWithRetry(body);
    if (!res.ok) {
      const errText = await res.text();
      // Some models reject `temperature` ("deprecated for this model"). Drop it and retry once,
      // so the temperature knob is best-effort rather than fatal.
      if (res.status === 400 && 'temperature' in body && /temperature/i.test(errText)) {
        delete body.temperature;
        res = await this.fetchWithRetry(body);
        if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
      } else {
        throw new Error(`Anthropic API error ${res.status}: ${errText}`);
      }
    }
    const data = (await res.json()) as AnthropicMessageResponse;

    let text = '';
    const toolCalls: ToolCall[] = [];
    for (const block of data.content) {
      if (block.type === 'text') {
        text += (block as AnthropicTextBlock).text;
      } else if (block.type === 'tool_use') {
        const tu = block as AnthropicToolUseBlock;
        toolCalls.push({ id: tu.id, name: tu.name, input: tu.input });
      }
    }

    return {
      text,
      toolCalls,
      usage: {
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens,
        cacheReadInputTokens: data.usage.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: data.usage.cache_creation_input_tokens ?? 0,
      },
      model,
      stopReason: mapStopReason(data.stop_reason),
    };
  }

  private async fetchWithRetry(body: unknown): Promise<Response> {
    let attempt = 0;
    for (;;) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await fetch(ANTHROPIC_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if ((res.status === 429 || res.status >= 500) && attempt < this.retries) {
          attempt++;
          await sleep(Math.min(8000, 500 * 2 ** attempt));
          continue;
        }
        return res;
      } catch (err) {
        clearTimeout(timer);
        if (attempt < this.retries) {
          attempt++;
          await sleep(Math.min(8000, 500 * 2 ** attempt));
          continue;
        }
        throw err;
      }
    }
  }
}

function mapStopReason(reason: string | null): LlmResponse['stopReason'] {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    default:
      return 'other';
  }
}
