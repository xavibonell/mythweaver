/**
 * Loads the RAG corpus and picks a retriever (spec §5), best-available first:
 *   1. in-memory VECTOR (semantic) — if a cached vectors file + an embeddings key exist (no DB needed)
 *   2. pgvector — if MYTHWEAVER_RAG=pgvector + a Voyage key (scale path)
 *   3. in-memory KEYWORD (BM25) — offline fallback, no key/DB
 *   4. none — DM falls back to its own knowledge (no lookupRule tool)
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  InMemoryRetriever,
  InMemoryVectorRetriever,
  OpenAIEmbeddingProvider,
  VoyageEmbeddingProvider,
  type Retriever,
} from '@mythweaver/rag';
import type { Db } from './db.js';
import { DbRetriever } from './retriever.js';

const CORPUS_DIR =
  process.env.MYTHWEAVER_CORPUS_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../content/corpus');

interface CorpusChunk {
  id: string;
  text: string;
  source: string;
}

function listCorpusFiles(): string[] {
  try {
    return readdirSync(CORPUS_DIR);
  } catch {
    return [];
  }
}

export function loadCorpus(): CorpusChunk[] {
  const files = listCorpusFiles().filter((f) => f.endsWith('.jsonl') && !f.endsWith('.vectors.jsonl'));
  const chunks: CorpusChunk[] = [];
  for (const file of files) {
    const text = readFileSync(join(CORPUS_DIR, file), 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { id: string; source: string; content: string };
        if (row.id && row.content) chunks.push({ id: row.id, text: row.content, source: row.source });
      } catch {
        /* skip malformed line */
      }
    }
  }
  return chunks;
}

function loadVectors(): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const file of listCorpusFiles().filter((f) => f.endsWith('.vectors.jsonl'))) {
    const text = readFileSync(join(CORPUS_DIR, file), 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { id: string; v: string };
        const buf = Buffer.from(row.v, 'base64');
        const f32 = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
        map.set(row.id, Array.from(f32));
      } catch {
        /* skip malformed line */
      }
    }
  }
  return map;
}

export function buildRetriever(db: Db | null): { retriever?: Retriever; description: string } {
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
  const hasVoyage = Boolean(process.env.VOYAGE_API_KEY);
  const chunks = loadCorpus();

  // 1. Semantic, in-memory (no DB) — best quality, no infra.
  if ((hasOpenAI || hasVoyage) && chunks.length > 0) {
    const vectors = loadVectors();
    if (vectors.size > 0) {
      const joined = chunks
        .filter((c) => vectors.has(c.id))
        .map((c) => ({ ...c, vector: vectors.get(c.id)! }));
      if (joined.length > 0) {
        const provider = hasOpenAI ? new OpenAIEmbeddingProvider() : new VoyageEmbeddingProvider();
        return {
          retriever: new InMemoryVectorRetriever(joined, provider),
          description: `in-memory vector (${joined.length} chunks, ${provider.model})`,
        };
      }
    }
  }

  // 2. pgvector scale path.
  if (db && process.env.MYTHWEAVER_RAG === 'pgvector' && hasVoyage) {
    return { retriever: new DbRetriever(db, new VoyageEmbeddingProvider()), description: 'pgvector (Voyage)' };
  }

  // 3. Offline keyword fallback.
  if (chunks.length > 0) {
    return { retriever: new InMemoryRetriever(chunks), description: `in-memory keyword (${chunks.length} chunks)` };
  }

  return { description: 'none (no corpus found; DM uses its own knowledge)' };
}
