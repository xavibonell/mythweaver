// Vector-path ingestion: embed the corpus JSONL into pgvector (spec §5.2).
// Only needed for MYTHWEAVER_RAG=pgvector. Requires VOYAGE_API_KEY + a running DB.
// The default (in-memory keyword retriever) needs none of this.
//
// Usage: npm run build && node scripts/ingest-corpus.mjs [corpus.jsonl] [namespace]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { VoyageEmbeddingProvider } from '../packages/rag/dist/index.js';
import { Db } from '../apps/server/dist/db.js';

// Minimal .env loader (no dep).
try {
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
} catch {
  /* no .env */
}

const file = process.argv[2] ?? 'content/corpus/dnd.jsonl';
const namespace = process.argv[3] ?? 'dnd';

const rows = readFileSync(resolve(file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
console.log(`Ingesting ${rows.length} chunks from ${file} into namespace '${namespace}'…`);

const embeddings = new VoyageEmbeddingProvider();
const db = new Db();
const BATCH = 100;
let done = 0;
for (let i = 0; i < rows.length; i += BATCH) {
  const batch = rows.slice(i, i + BATCH);
  const vecs = await embeddings.embed(batch.map((r) => r.content));
  for (let j = 0; j < batch.length; j++) {
    await db.upsertChunk({ id: batch[j].id, namespace, source: batch[j].source, content: batch[j].content, embedding: vecs[j] });
  }
  done += batch.length;
  console.log(`  ${done}/${rows.length}`);
}
await db.close();
console.log('Done. Set MYTHWEAVER_RAG=pgvector to use it.');
