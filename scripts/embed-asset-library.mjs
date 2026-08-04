// Embed the asset library once for semantic retrieval (menu + binding) and cache the vectors.
// Run: npm run build && node scripts/embed-asset-library.mjs   (or: npm run assets:embed)
// Reads .env for OPENAI_API_KEY (or VOYAGE_API_KEY). Output is gitignored (rebuild after edits
// to assets/library.json — a missing/stale file just means retrieval degrades to off/partial).
import { readFileSync, writeFileSync } from 'node:fs';
import { OpenAIEmbeddingProvider, VoyageEmbeddingProvider } from '../packages/rag/dist/index.js';
import { assetEmbedText, directorAssets, loadAssetLibrary } from '../packages/scene/dist/index.js';

try {
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
} catch {
  /* no .env */
}

const provider = process.env.OPENAI_API_KEY ? new OpenAIEmbeddingProvider() : new VoyageEmbeddingProvider();
console.log(`provider: ${provider.model} (dim ${provider.dimension})`);

const assets = directorAssets(loadAssetLibrary());
console.log(`embedding ${assets.length} Director-relevant assets…`);

const BATCH = 256;
const rows = [];
for (let i = 0; i < assets.length; i += BATCH) {
  const batch = assets.slice(i, i + BATCH);
  const vecs = await provider.embed(batch.map(assetEmbedText));
  for (let j = 0; j < batch.length; j++) {
    const a = batch[j];
    rows.push(JSON.stringify({ tag: a.tag, kind: a.kind, desc: a.desc ?? a.tag, ...(a.biomes?.length ? { biomes: a.biomes } : {}), vec: vecs[j] }));
  }
  console.log(`  ${Math.min(i + BATCH, assets.length)}/${assets.length}`);
}

const out = new URL('../assets/library.vectors.jsonl', import.meta.url).pathname;
writeFileSync(out, [JSON.stringify({ model: provider.model, dim: provider.dimension, count: rows.length }), ...rows].join('\n') + '\n');
console.log(`wrote ${out} (${rows.length} vectors)`);
