/**
 * Google Gemini adapter for the LlmProvider seam (spec §3) — generativelanguage v1beta.
 *
 * Direct `fetch`, zero deps. Maps our provider-neutral content blocks to Gemini's
 * `contents`/`parts` shape (tool_use -> functionCall, tool_result -> functionResponse).
 * Gemini matches tool results to calls BY NAME, so we recover the name from the prior
 * assistant tool_use blocks. Cheap/fast models (flash-lite) are ideal for the Scene Director.
 */

import type { LlmContentBlock, LlmMessage, LlmProvider, LlmRequest, LlmResponse, ToolCall } from './provider.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export interface GeminiProviderOptions {
  apiKey?: string;
  model?: string;
  defaultMaxTokens?: number;
  timeoutMs?: number;
  retries?: number;
  /** Gemini 2.5+/3.x "thinking" budget. 0 = off (much faster + cheaper, ideal for the Director). */
  thinkingBudget?: number;
}

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
}
interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Strip JSON-Schema keys Gemini's function-parameter schema rejects (additionalProperties, $schema). */
function sanitizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (schema && typeof schema === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
      if (k === 'additionalProperties' || k === '$schema') continue;
      out[k] = sanitizeSchema(v);
    }
    return out;
  }
  return schema;
}

function toContent(m: LlmMessage, idToName: Map<string, string>): { role: 'user' | 'model'; parts: unknown[] } {
  const role = m.role === 'assistant' ? 'model' : 'user';
  if (typeof m.content === 'string') return { role, parts: [{ text: m.content }] };
  const parts: unknown[] = [];
  for (const b of m.content as LlmContentBlock[]) {
    if (b.type === 'text') parts.push({ text: b.text });
    else if (b.type === 'tool_use') parts.push({ functionCall: { name: b.name, args: b.input } });
    else parts.push({ functionResponse: { name: idToName.get(b.toolUseId) ?? 'tool', response: { result: b.content } } });
  }
  return { role, parts };
}

export class GeminiProvider implements LlmProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly defaultMaxTokens: number;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly thinkingBudget: number;

  constructor(opts: GeminiProviderOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY ?? '';
    this.model = opts.model ?? process.env.GEMINI_MODEL ?? 'gemini-2.5-flash-lite';
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 1024;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.retries = opts.retries ?? 2;
    this.thinkingBudget = opts.thinkingBudget ?? 0;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    if (!this.apiKey) throw new Error('GEMINI_API_KEY is not set (see .env).');
    const model = req.model ?? this.model;

    const idToName = new Map<string, string>();
    for (const m of req.messages) {
      if (Array.isArray(m.content)) for (const b of m.content) if (b.type === 'tool_use') idToName.set(b.id, b.name);
    }

    const body: Record<string, unknown> = {
      contents: req.messages.map((m) => toContent(m, idToName)),
      generationConfig: {
        maxOutputTokens: req.maxTokens ?? this.defaultMaxTokens,
        thinkingConfig: { thinkingBudget: this.thinkingBudget },
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      },
    };
    if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
    if (req.tools && req.tools.length > 0) {
      body.tools = [
        { functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: sanitizeSchema(t.inputSchema) })) },
      ];
    }

    const res = await this.fetchWithRetry(model, body);
    if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as GeminiResponse;

    const cand = data.candidates?.[0];
    let text = '';
    const toolCalls: ToolCall[] = [];
    let i = 0;
    for (const part of cand?.content?.parts ?? []) {
      if (typeof part.text === 'string') text += part.text;
      else if (part.functionCall) toolCalls.push({ id: `gem_${part.functionCall.name}_${i++}`, name: part.functionCall.name, input: part.functionCall.args ?? {} });
    }

    return {
      text,
      toolCalls,
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
        cacheReadInputTokens: data.usageMetadata?.cachedContentTokenCount ?? 0,
      },
      model,
      stopReason: toolCalls.length ? 'tool_use' : mapFinish(cand?.finishReason),
    };
  }

  private async fetchWithRetry(model: string, body: unknown): Promise<Response> {
    let attempt = 0;
    for (;;) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
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

function mapFinish(reason: string | undefined): LlmResponse['stopReason'] {
  switch (reason) {
    case 'STOP':
      return 'end';
    case 'MAX_TOKENS':
      return 'max_tokens';
    default:
      return reason ? 'other' : 'end';
  }
}
