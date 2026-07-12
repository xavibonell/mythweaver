/**
 * OpenAI adapter for the LlmProvider seam (spec §3) — Chat Completions API.
 *
 * Direct `fetch`, zero deps. Maps our provider-neutral content blocks to OpenAI's
 * message shape: assistant tool_use -> `tool_calls`, user tool_result -> `tool` role
 * messages (matched by tool_call_id). Uses `max_completion_tokens` (forward-compatible
 * with reasoning models).
 */

import type { LlmContentBlock, LlmMessage, LlmProvider, LlmRequest, LlmResponse, ToolCall } from './provider.js';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

export interface OpenAIProviderOptions {
  apiKey?: string;
  model?: string;
  defaultMaxTokens?: number;
  timeoutMs?: number;
  retries?: number;
}

interface OpenAIResponse {
  choices?: {
    message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Map our messages (Anthropic-style content blocks) to OpenAI chat messages. */
function toMessages(system: string | undefined, messages: LlmMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks = m.content as LlmContentBlock[];
    if (m.role === 'assistant') {
      let text = '';
      const toolCalls: unknown[] = [];
      for (const b of blocks) {
        if (b.type === 'text') text += b.text;
        else if (b.type === 'tool_use') toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } });
      }
      out.push({ role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    } else {
      // user turn: tool_result blocks become `tool` messages; any text becomes a user message.
      let text = '';
      for (const b of blocks) {
        if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.toolUseId, content: b.content });
        else if (b.type === 'text') text += b.text;
      }
      if (text) out.push({ role: 'user', content: text });
    }
  }
  return out;
}

export class OpenAIProvider implements LlmProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly defaultMaxTokens: number;
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(opts: OpenAIProviderOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.model = opts.model ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 1024;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.retries = opts.retries ?? 2;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY is not set (see .env).');
    const model = req.model ?? this.model;
    // Reasoning-class models (gpt-5*, o-series) accept ONLY the default temperature (1) — sending the
    // DM Lab's slider value 400s the turn. Omit temperature for them; keep it for gpt-4o-class models.
    const reasoningClass = /^(gpt-5|o\d)/i.test(model);

    const body: Record<string, unknown> = {
      model,
      messages: toMessages(req.system, req.messages),
      max_completion_tokens: req.maxTokens ?? this.defaultMaxTokens,
      ...(req.temperature !== undefined && !reasoningClass ? { temperature: req.temperature } : {}),
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    }

    const res = await this.fetchWithRetry(body);
    if (!res.ok) throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as OpenAIResponse;
    const choice = data.choices?.[0];
    const msg = choice?.message;

    const toolCalls: ToolCall[] = [];
    for (const tc of msg?.tool_calls ?? []) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        input = {};
      }
      toolCalls.push({ id: tc.id, name: tc.function.name, input });
    }

    return {
      text: typeof msg?.content === 'string' ? msg.content : '',
      toolCalls,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        cacheReadInputTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      },
      model,
      stopReason: mapFinish(choice?.finish_reason),
    };
  }

  private async fetchWithRetry(body: unknown): Promise<Response> {
    let attempt = 0;
    for (;;) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await fetch(OPENAI_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if ((res.status === 429 || res.status >= 500) && attempt < this.retries) {
          attempt++;
          // 429 TPM windows tell us when to come back (retry-after) — honor it (+ jitter margin),
          // else the old 8s cap burns every retry inside the SAME rate window and the turn dies.
          const ra = Number(res.headers.get('retry-after'));
          const wait = res.status === 429 && Number.isFinite(ra) && ra > 0 ? Math.min(30_000, ra * 1000 + 750) : Math.min(8000, 500 * 2 ** attempt);
          await sleep(wait);
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

function mapFinish(reason: string | undefined): LlmResponse['stopReason'] {
  switch (reason) {
    case 'stop':
      return 'end';
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    default:
      return reason ? 'other' : 'end';
  }
}
