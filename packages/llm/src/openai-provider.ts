/**
 * OpenAI adapter for the LlmProvider seam (spec §3) — Chat Completions + Responses APIs.
 *
 * Direct `fetch`, zero deps. Two wire formats behind one provider:
 * - CHAT COMPLETIONS (/v1/chat/completions) for gpt-4o-class + gpt-5.5-and-earlier: our blocks map
 *   to `tool_calls` / `tool`-role messages; `max_completion_tokens`.
 * - RESPONSES (/v1/responses) for gpt-5.6+ (routed by model id): OpenAI REQUIRES it for function
 *   tools on those models ("Function tools … are not supported for gpt-5.6-luna in
 *   /v1/chat/completions"). Our blocks map to `input` items — assistant tool_use ->
 *   `function_call`, user tool_result -> `function_call_output` (matched by call_id) — with flat
 *   tool defs, `instructions` for the system prompt, and `store:false` (we replay full history;
 *   the engine owns state, never OpenAI's server-side thread).
 */

import type { LlmContentBlock, LlmMessage, LlmProvider, LlmRequest, LlmResponse, ToolCall } from './provider.js';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const RESPONSES_URL = 'https://api.openai.com/v1/responses';

/** gpt-5.6+ only support function tools on the Responses API — route them there. */
export function usesResponsesApi(model: string): boolean {
  return /^gpt-5\.[6-9]|^gpt-[6-9]/i.test(model);
}

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

/** /v1/responses payload (the parts we consume). `output` is an ordered item list. */
interface OpenAIResponsesPayload {
  status?: string;
  incomplete_details?: { reason?: string };
  output?: {
    type?: string; // 'message' | 'function_call' | 'reasoning' | …
    role?: string;
    content?: { type?: string; text?: string }[]; // message items: output_text blocks
    call_id?: string;
    name?: string;
    arguments?: string;
  }[];
  usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Join a /v1/responses reply's `output_text` blocks into ONE narration.
 *
 * A reasoning model sometimes emits its answer, thinks again, and emits a near-identical answer as a
 * second block. Concatenating blocks straight (`text += c.text`) welded them into a doubled paragraph
 * with no separator — the DM appeared to say everything twice at the table, and every downstream
 * consumer (transcript, journal, style corpus) inherited the doubling. Identical or
 * whitespace/punctuation-equivalent blocks collapse to one; genuinely different blocks are kept and
 * separated by a blank line, because a model CAN legitimately emit prose in parts.
 */
export function joinOutputText(blocks: string[]): string {
  const norm = (s: string) => s.replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, '').trim().toLowerCase();
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const b of blocks) {
    const t = b.trim();
    if (!t) continue;
    const k = norm(t);
    if (!k || seen.has(k)) continue;
    // A block that merely restates one already kept (or is restated BY it) is the same narration.
    const dup = [...seen].some((s) => (s.length > 40 && k.length > 40) && (s.includes(k) || k.includes(s)));
    if (dup) continue;
    seen.add(k);
    kept.push(t);
  }
  return kept.join('\n\n');
}

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
      // user turn: tool_result blocks become `tool` messages; text + images become a user message.
      let text = '';
      const imageParts: unknown[] = [];
      for (const b of blocks) {
        if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.toolUseId, content: b.content });
        else if (b.type === 'text') text += b.text;
        else if (b.type === 'image') imageParts.push({ type: 'image_url', image_url: { url: `data:${b.mediaType};base64,${b.dataBase64}` } });
      }
      // Vision input rides the user message as content PARTS (Chat Completions can't put images in a
      // `tool` message). Previously image blocks were dropped SILENTLY — a vision experiment saw nothing.
      if (imageParts.length) out.push({ role: 'user', content: [...(text ? [{ type: 'text', text }] : []), ...imageParts] });
      else if (text) out.push({ role: 'user', content: text });
    }
  }
  return out;
}

/** Map our messages to Responses-API `input` items. Assistant tool_use becomes a top-level
 *  `function_call` item and user tool_result a `function_call_output` — matched by call_id, in
 *  original order, so multi-step tool loops replay exactly. */
function toResponsesInput(messages: LlmMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: [{ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: m.content }] });
      continue;
    }
    const blocks = m.content as LlmContentBlock[];
    for (const b of blocks) {
      if (b.type === 'text') {
        if (b.text) out.push({ role: m.role, content: [{ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: b.text }] });
      } else if (b.type === 'tool_use') {
        out.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.input) });
      } else if (b.type === 'tool_result') {
        out.push({ type: 'function_call_output', call_id: b.toolUseId, output: b.content });
      } else if (b.type === 'image') {
        // Vision input on the Responses API (the path gpt-5.6+ uses) — was DROPPED silently before.
        out.push({ role: 'user', content: [{ type: 'input_image', image_url: `data:${b.mediaType};base64,${b.dataBase64}` }] });
      }
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
    if (usesResponsesApi(model)) return this.completeViaResponses(req, model, reasoningClass);

    const body: Record<string, unknown> = {
      model,
      messages: toMessages(req.system, req.messages),
      max_completion_tokens: req.maxTokens ?? this.defaultMaxTokens,
      ...(req.temperature !== undefined && !reasoningClass ? { temperature: req.temperature } : {}),
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    }

    const res = await this.fetchWithRetry(OPENAI_URL, body);
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

  /** /v1/responses path (gpt-5.6+): flat tool defs, `instructions` for system, store:false. */
  private async completeViaResponses(req: LlmRequest, model: string, reasoningClass: boolean): Promise<LlmResponse> {
    const body: Record<string, unknown> = {
      model,
      input: toResponsesInput(req.messages),
      ...(req.system ? { instructions: req.system } : {}),
      max_output_tokens: req.maxTokens ?? this.defaultMaxTokens,
      store: false, // stateless: we replay full history; the engine owns state, not OpenAI's thread store
      ...(req.temperature !== undefined && !reasoningClass ? { temperature: req.temperature } : {}),
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.inputSchema }));
    }

    const res = await this.fetchWithRetry(RESPONSES_URL, body);
    if (!res.ok) throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as OpenAIResponsesPayload;

    const textBlocks: string[] = [];
    const toolCalls: ToolCall[] = [];
    for (const item of data.output ?? []) {
      if (item.type === 'message') {
        for (const c of item.content ?? []) if (c.type === 'output_text' && c.text) textBlocks.push(c.text);
      } else if (item.type === 'function_call' && item.call_id && item.name) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(item.arguments || '{}') as Record<string, unknown>;
        } catch {
          input = {};
        }
        toolCalls.push({ id: item.call_id, name: item.name, input });
      }
    }

    return {
      text: joinOutputText(textBlocks),
      toolCalls,
      usage: {
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
        cacheReadInputTokens: data.usage?.input_tokens_details?.cached_tokens ?? 0,
      },
      model,
      stopReason: toolCalls.length
        ? 'tool_use'
        : data.status === 'incomplete' && data.incomplete_details?.reason === 'max_output_tokens'
          ? 'max_tokens'
          : 'end',
    };
  }

  private async fetchWithRetry(url: string, body: unknown): Promise<Response> {
    let attempt = 0;
    for (;;) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await fetch(url, {
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
