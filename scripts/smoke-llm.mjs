// Throwaway smoke test: verify the API key works through our AnthropicProvider seam.
// Reads the key from .env (not the command line) so it isn't echoed in logs.
import { readFileSync } from 'node:fs';
import { AnthropicProvider } from '../packages/llm/dist/index.js';

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const apiKey = env.match(/^ANTHROPIC_API_KEY=(.*)$/m)?.[1]?.trim();
if (!apiKey) {
  console.error('No ANTHROPIC_API_KEY found in .env');
  process.exit(1);
}

const provider = new AnthropicProvider({ apiKey });

try {
  const res = await provider.complete({
    model: 'claude-haiku-4-5', // cheapest model for a connectivity check
    maxTokens: 32,
    messages: [{ role: 'user', content: 'Reply with exactly: MythWeaver online.' }],
  });
  console.log('✅ API key works.');
  console.log('   model      :', res.model);
  console.log('   reply      :', JSON.stringify(res.text));
  console.log('   stopReason :', res.stopReason);
  console.log('   usage      :', JSON.stringify(res.usage));
} catch (err) {
  console.error('❌ API call failed:');
  console.error('  ', err instanceof Error ? err.message : String(err));
  process.exit(1);
}
