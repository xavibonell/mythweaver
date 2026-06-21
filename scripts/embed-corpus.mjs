// Embed the corpus once and cache vectors to disk for the in-memory vector retriever.
// Run: npm run build && node scripts/embed-corpus.mjs [corpus.jsonl] [out.vectors.jsonl]
// Reads .env for OPENAI_API_KEY (or VOYAGE_API_KEY). Output is gitignored.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { OpenAIEmbeddingProvider, VoyageEmbeddingProvider } from '../packages/rag/dist/index.js';

try {
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
} catch {
  /* no .env */
}

const inFile = process.argv[2] ?? 'content/corpus/dnd.jsonl';
const outFile = process.argv[3] ?? inFile.replace(/\.jsonl$/, '.vectors.jsonl');
const provider = process.env.OPENAI_API_KEY ? new OpenAIEmbeddingProvider() : new VoyageEmbeddingProvider();
console.log(`provider: ${provider.model} (dim ${provider.dimension})`);

const rows = readFileSync(resolve(inFile), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
console.log(`embedding ${rows.length} chunks…`);
const BATCH = 256;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry a batch on transient failures (429 TPM rate limits, fetch/header timeouts).
// Honours the provider's "try again in Xms" hint when present; otherwise backs off.
async function embedWithRetry(texts, attempts = 6) {
  for (let a = 1; ; a++) {
    try {
      return await provider.embed(texts);
    } catch (err) {
      const msg = String(err?.message ?? err);
      const transient = /429|rate.?limit|timeout|UND_ERR|fetch failed|ECONNRESET|503/i.test(msg);
      if (!transient || a >= attempts) throw err;
      const hinted = Number(msg.match(/try again in (\d+(?:\.\d+)?)s/i)?.[1]) * 1000;
      const wait = Number.isFinite(hinted) && hinted > 0 ? hinted + 500 : Math.min(2000 * 2 ** (a - 1), 30000);
      process.stdout.write(`\n  batch retry ${a}/${attempts - 1} after ${Math.round(wait)}ms (${msg.slice(0, 60)}…)\n`);
      await sleep(wait);
    }
  }
}

const lines = [];
for (let i = 0; i < rows.length; i += BATCH) {
  const batch = rows.slice(i, i + BATCH);
  const vecs = await embedWithRetry(batch.map((r) => r.content));
  for (let j = 0; j < batch.length; j++) {
    const b64 = Buffer.from(Float32Array.from(vecs[j]).buffer).toString('base64');
    lines.push(JSON.stringify({ id: batch[j].id, v: b64 }));
  }
  process.stdout.write(`\r  ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
  await sleep(400); // light throttle to stay under the org TPM ceiling
}
writeFileSync(resolve(outFile), lines.join('\n') + '\n');
console.log(`\nwrote ${outFile} (${lines.length} vectors)`);
