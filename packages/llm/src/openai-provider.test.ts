import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIProvider, joinOutputText, usesResponsesApi } from './openai-provider.js';

/** Capture URL + body of each POST the provider makes, returning a canned payload. */
function stubFetch(payload: unknown): { urls: string[]; bodies: Record<string, unknown>[] } {
  const urls: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    urls.push(String(url));
    bodies.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => payload,
    } as unknown as Response;
  });
  return { urls, bodies };
}

const CHAT_PAYLOAD = { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} };
const RESPONSES_PAYLOAD = {
  status: 'completed',
  output: [
    { type: 'reasoning' }, // ignored
    { type: 'function_call', call_id: 'call_1', name: 'requestRoll', arguments: '{"expr":"1d20"}' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'You brace on the planks.' }] },
  ],
  usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 60 } },
};

describe('API routing (gpt-5.6+ requires /v1/responses for function tools)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('routes gpt-5.6-luna to /v1/responses and gpt-4o / gpt-5.5 to chat completions', () => {
    expect(usesResponsesApi('gpt-5.6-luna')).toBe(true);
    expect(usesResponsesApi('gpt-6')).toBe(true);
    expect(usesResponsesApi('gpt-5.5')).toBe(false);
    expect(usesResponsesApi('gpt-4o')).toBe(false);
  });

  it('gpt-5.6-luna: POSTs /v1/responses with flat tools, instructions, store:false, no temperature', async () => {
    const cap = stubFetch(RESPONSES_PAYLOAD);
    const p = new OpenAIProvider({ apiKey: 'x', model: 'gpt-5.6-luna' });
    await p.complete({
      system: 'You are the DM.',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'requestRoll', description: 'roll', inputSchema: { type: 'object' } }],
      temperature: 0.7,
      maxTokens: 900,
    });
    expect(cap.urls[0]).toContain('/v1/responses');
    const b = cap.bodies[0]!;
    expect(b.instructions).toBe('You are the DM.');
    expect(b.store).toBe(false);
    expect(b.max_output_tokens).toBe(900);
    expect('temperature' in b).toBe(false); // reasoning-class
    expect((b.tools as Record<string, unknown>[])[0]).toMatchObject({ type: 'function', name: 'requestRoll' }); // FLAT, not nested under `function`
  });

  it('replays tool history as function_call / function_call_output items matched by call_id', async () => {
    const cap = stubFetch(RESPONSES_PAYLOAD);
    const p = new OpenAIProvider({ apiKey: 'x', model: 'gpt-5.6-luna' });
    await p.complete({
      messages: [
        { role: 'user', content: 'I search the crate.' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_9', name: 'getState', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call_9', content: '{"hp":12}' }] },
      ],
    });
    const input = cap.bodies[0]!.input as Record<string, unknown>[];
    expect(input[1]).toMatchObject({ type: 'function_call', call_id: 'call_9', name: 'getState' });
    expect(input[2]).toMatchObject({ type: 'function_call_output', call_id: 'call_9', output: '{"hp":12}' });
  });

  it('maps an ImageBlock to input_image on the Responses path (gpt-5.6+) — was dropped silently', async () => {
    const cap = stubFetch(RESPONSES_PAYLOAD);
    const p = new OpenAIProvider({ apiKey: 'x', model: 'gpt-5.6-luna' });
    await p.complete({ messages: [{ role: 'user', content: [{ type: 'text', text: 'what do you see?' }, { type: 'image', mediaType: 'image/png', dataBase64: 'AAAA' }] }] });
    const input = cap.bodies[0]!.input as Record<string, unknown>[];
    const img = input.find((i) => Array.isArray((i as any).content) && (i as any).content[0]?.type === 'input_image') as any;
    expect(img).toBeTruthy();
    expect(img.content[0].image_url).toBe('data:image/png;base64,AAAA');
  });

  it('maps an ImageBlock to an image_url content part on the chat path (gpt-4o)', async () => {
    const cap = stubFetch(CHAT_PAYLOAD);
    const p = new OpenAIProvider({ apiKey: 'x', model: 'gpt-4o' });
    await p.complete({ messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', mediaType: 'image/png', dataBase64: 'BBBB' }] }] });
    const msgs = cap.bodies[0]!.messages as any[];
    const u = msgs.find((m) => m.role === 'user' && Array.isArray(m.content));
    expect(u.content).toContainEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } });
    expect(u.content).toContainEqual({ type: 'text', text: 'look' });
  });

  it('parses Responses output: text + toolCalls (call_id) + usage + stopReason', async () => {
    stubFetch(RESPONSES_PAYLOAD);
    const p = new OpenAIProvider({ apiKey: 'x', model: 'gpt-5.6-luna' });
    const res = await p.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.text).toBe('You brace on the planks.');
    expect(res.toolCalls).toEqual([{ id: 'call_1', name: 'requestRoll', input: { expr: '1d20' } }]);
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 60 });
    expect(res.stopReason).toBe('tool_use');
  });
});

describe('OpenAIProvider temperature handling (chat-completions path)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('OMITS temperature for reasoning-class models (gpt-5*, o-series only accept the default)', async () => {
    const cap = stubFetch(CHAT_PAYLOAD);
    const p = new OpenAIProvider({ apiKey: 'x', model: 'gpt-5.5' });
    await p.complete({ messages: [{ role: 'user', content: 'hi' }], temperature: 0.7 });
    expect(cap.urls[0]).toContain('/v1/chat/completions'); // 5.5 stays on chat
    expect('temperature' in cap.bodies[0]!).toBe(false);
  });

  it('KEEPS temperature for gpt-4o-class models', async () => {
    const cap = stubFetch(CHAT_PAYLOAD);
    const p = new OpenAIProvider({ apiKey: 'x', model: 'gpt-4o' });
    await p.complete({ messages: [{ role: 'user', content: 'hi' }], temperature: 0.7 });
    expect(cap.bodies[0]!.temperature).toBe(0.7);
  });
});

describe('joinOutputText — a reasoning model that restates itself must not double the DM (B0)', () => {
  const NARRATION = 'Aldric crosses the green, boots scraping the dry cobbles, and stops beside Tessa. She brushes dirt from her sleeves. "Seed’s gone. Lock looks untouched."';

  it('collapses an exact restatement into one narration', () => {
    expect(joinOutputText([NARRATION, NARRATION])).toBe(NARRATION);
  });

  it('collapses a restatement that only differs in whitespace or trailing prompt punctuation', () => {
    const again = `${NARRATION.replace(/\s+/g, '  ')}`;
    expect(joinOutputText([NARRATION, again])).toBe(NARRATION);
  });

  it('keeps genuinely different blocks, separated — never welded into one paragraph', () => {
    const out = joinOutputText(['The gate groans open.', 'Beyond it, the road forks north.']);
    expect(out).toBe('The gate groans open.\n\nBeyond it, the road forks north.');
    expect(out).not.toContain('open.Beyond'); // the weld that produced the live bug
  });

  it('ignores empty and whitespace-only blocks', () => {
    expect(joinOutputText(['', '   ', NARRATION])).toBe(NARRATION);
  });
});

describe('joinOutputText — a restatement must never TRUNCATE the narration', () => {
  it('keeps the fuller block when the second pass extends the first', () => {
    const partial = 'Pip reaches the storehouse door after a long crossing of the green.';
    const full = `${partial} The lock is old iron, its face scratched bright around the keyway.`;
    expect(joinOutputText([partial, full])).toBe(full);
    expect(joinOutputText([full, partial])).toBe(full); // order must not decide it
  });
});
