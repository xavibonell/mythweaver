import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from './openai-provider.js';

/** Capture the request body the provider POSTs, without hitting the network. */
function stubFetch(): { bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} }),
    } as unknown as Response;
  });
  return { bodies };
}

describe('OpenAIProvider temperature handling', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('OMITS temperature for reasoning-class models (gpt-5*, o-series only accept the default)', async () => {
    const cap = stubFetch();
    const p = new OpenAIProvider({ apiKey: 'x', model: 'gpt-5.5' });
    await p.complete({ messages: [{ role: 'user', content: 'hi' }], temperature: 0.7 });
    expect('temperature' in cap.bodies[0]!).toBe(false);
    expect(cap.bodies[0]!.model).toBe('gpt-5.5');
  });

  it('KEEPS temperature for gpt-4o-class models', async () => {
    const cap = stubFetch();
    const p = new OpenAIProvider({ apiKey: 'x', model: 'gpt-4o' });
    await p.complete({ messages: [{ role: 'user', content: 'hi' }], temperature: 0.7 });
    expect(cap.bodies[0]!.temperature).toBe(0.7);
  });
});
