/**
 * Provider availability check — pings Anthropic, Gemini, and OpenAI with the keys in .env.
 * Masks keys in output. For Gemini it lists available models (so we learn the real id).
 *   node scripts/test-providers.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(resolve(here, '../.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}
const A = process.env.ANTHROPIC_API_KEY || '';
const G = process.env.GEMINI_API_KEY || '';
const O = process.env.OPENAI_API_KEY || '';
const mask = (k) => (k ? `${k.slice(0, 6)}…${k.slice(-4)} (${k.length} chars)` : '(missing)');

console.log('Keys loaded from .env:');
console.log('  ANTHROPIC', mask(A));
console.log('  GEMINI   ', mask(G));
console.log('  OPENAI   ', mask(O));
console.log('');

async function timed(fn) {
  const t = Date.now();
  try {
    const r = await fn();
    return { ok: true, ms: Date.now() - t, ...r };
  } catch (e) {
    return { ok: false, ms: Date.now() - t, error: String(e?.message || e) };
  }
}

const anth = await timed(async () => {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': A, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 16, messages: [{ role: 'user', content: 'Reply with the single word: pong' }] }),
  });
  const b = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(b).slice(0, 240)}`);
  return { reply: (b.content?.[0]?.text || '').trim(), model: b.model };
});
console.log('ANTHROPIC (claude-sonnet-4-6):', anth.ok ? `OK ${anth.ms}ms → "${anth.reply}"` : `FAIL — ${anth.error}`);

const gem = await timed(async () => {
  const list = await fetch('https://generativelanguage.googleapis.com/v1beta/models', { headers: { 'x-goog-api-key': G } });
  const lb = await list.json();
  if (!list.ok) throw new Error(`models.list ${list.status} ${JSON.stringify(lb).slice(0, 320)}`);
  const names = (lb.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace('models/', ''));
  const flash = names.filter((n) => /flash/.test(n) && !/-\d{3}$/.test(n)); // drop dated/deprecated snapshots
  const want = process.env.GEMINI_MODEL;
  const pick = want && names.includes(want) ? want : flash.find((n) => /flash-lite/.test(n)) || flash[0] || names[0];
  const gen = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${pick}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': G },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: pong' }] }],
      generationConfig: { maxOutputTokens: 32, thinkingConfig: { thinkingBudget: 0 } },
    }),
  });
  const gb = await gen.json();
  if (!gen.ok) throw new Error(`generateContent(${pick}) ${gen.status} ${JSON.stringify(gb).slice(0, 320)}`);
  return { flash, pick, reply: (gb.candidates?.[0]?.content?.parts?.[0]?.text || '').trim() };
});
if (gem.ok) {
  console.log('GEMINI flash models available:', gem.flash.join(', ') || '(none)');
  console.log(`GEMINI ping (${gem.pick}):`, `OK ${gem.ms}ms → "${gem.reply}"`);
} else {
  console.log('GEMINI: FAIL —', gem.error);
}

const oai = await timed(async () => {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${O}` },
    body: JSON.stringify({ model: 'gpt-4o-mini', max_completion_tokens: 16, messages: [{ role: 'user', content: 'Reply with the single word: pong' }] }),
  });
  const b = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(b).slice(0, 240)}`);
  return { reply: (b.choices?.[0]?.message?.content || '').trim(), model: b.model };
});
console.log('OPENAI (gpt-4o-mini):', oai.ok ? `OK ${oai.ms}ms → "${oai.reply}"` : `FAIL — ${oai.error}`);
