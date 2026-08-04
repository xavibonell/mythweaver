/**
 * The STYLE-EXEMPLAR corpus (Technique B) — a SEPARATE retrieval namespace from the rules corpus.
 * Exemplars are VOICE, not rules: they are never merged into the quotable corpus and never visible
 * to `lookupRule`. Mirrors corpus.ts (jsonl + base64-Float32 vectors.jsonl on disk), plus a
 * `moveType` facet so retrieval can match the register to the moment (a roll verdict wants a
 * verdict-shaped exemplar, not a five-sentence arrival).
 *
 * Env: MYTHWEAVER_EXEMPLARS=off disables; MYTHWEAVER_EXEMPLARS_DIR overrides content/exemplars.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryRetriever, OpenAIEmbeddingProvider, VoyageEmbeddingProvider, type EmbeddingProvider } from '@mythweaver/rag';
import type { ExemplarMoveType, ExemplarRow } from './exemplar-ingest.js';

const EXEMPLARS_DIR =
  process.env.MYTHWEAVER_EXEMPLARS_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../content/exemplars');

export interface ExemplarHit extends ExemplarRow {
  score: number;
}

interface LoadedExemplar extends ExemplarRow {
  vector?: number[];
}

function listFiles(): string[] {
  try {
    return readdirSync(EXEMPLARS_DIR);
  } catch {
    return [];
  }
}

export function loadExemplars(): LoadedExemplar[] {
  const rows: LoadedExemplar[] = [];
  for (const file of listFiles().filter((f) => f.endsWith('.jsonl') && !f.endsWith('.vectors.jsonl') && !f.endsWith('.candidates.jsonl'))) {
    for (const line of readFileSync(join(EXEMPLARS_DIR, file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as ExemplarRow;
        if (r.id && r.text && r.moveType) rows.push(r);
      } catch {
        /* skip malformed line */
      }
    }
  }
  // Vectors (optional — without them we fall back to BM25 keyword matching).
  const vectors = new Map<string, number[]>();
  for (const file of listFiles().filter((f) => f.endsWith('.vectors.jsonl'))) {
    for (const line of readFileSync(join(EXEMPLARS_DIR, file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { id: string; v: string };
        const buf = Buffer.from(row.v, 'base64');
        const f32 = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
        vectors.set(row.id, Array.from(f32));
      } catch {
        /* skip malformed line */
      }
    }
  }
  for (const r of rows) {
    const v = vectors.get(r.id);
    if (v) r.vector = v;
  }
  return rows;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
}

/**
 * Retrieve style exemplars for THIS moment: optional moveType filter first (register match), then
 * semantic top-k (cosine over cached vectors) — or BM25 within the filtered subset when there is no
 * embeddings key. `exclude` suppresses recently-used ids so the DM doesn't see the same beat twice.
 */
export class ExemplarRetriever {
  private readonly bm25ByType = new Map<string, InMemoryRetriever>();

  constructor(
    private readonly rows: LoadedExemplar[],
    private readonly embeddings?: EmbeddingProvider,
  ) {}

  get size(): number {
    return this.rows.length;
  }

  get semantic(): boolean {
    return !!this.embeddings && this.rows.some((r) => r.vector);
  }

  async retrieve(query: string, k: number, moveType?: ExemplarMoveType, exclude?: ReadonlySet<string>): Promise<ExemplarHit[]> {
    let pool = moveType ? this.rows.filter((r) => r.moveType === moveType) : this.rows;
    if (pool.length < k) pool = this.rows; // a sparse bucket falls back to the whole corpus
    if (exclude?.size) pool = pool.filter((r) => !exclude.has(r.id));
    if (pool.length === 0) return [];

    if (this.embeddings && pool.some((r) => r.vector)) {
      const [q] = await this.embeddings.embed([query]);
      if (q) {
        return pool
          .filter((r) => r.vector)
          .map((r) => ({ ...r, score: cosine(q, r.vector!) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, k);
      }
    }
    // BM25 fallback (offline / no key). One cached index per filter bucket.
    const key = moveType ?? '*';
    let bm = this.bm25ByType.get(key);
    if (!bm) {
      bm = new InMemoryRetriever((moveType ? this.rows.filter((r) => r.moveType === moveType) : this.rows).map((r) => ({ id: r.id, text: `${r.cue}\n${r.text}`, source: r.source })));
      this.bm25ByType.set(key, bm);
    }
    const hits = await bm.retrieve(query, k + (exclude?.size ?? 0));
    const byId = new Map(this.rows.map((r) => [r.id, r]));
    return hits
      .filter((h) => !exclude?.has(h.id))
      .slice(0, k)
      .map((h) => ({ ...byId.get(h.id)!, score: h.score }));
  }
}

/** Build the exemplar retriever (or explain why not). Mirrors corpus.ts's buildRetriever contract. */
export function buildExemplarRetriever(): { exemplars?: ExemplarRetriever; description: string } {
  if ((process.env.MYTHWEAVER_EXEMPLARS ?? 'on').toLowerCase() === 'off') {
    return { description: 'off (MYTHWEAVER_EXEMPLARS=off)' };
  }
  const rows = loadExemplars();
  if (rows.length === 0) return { description: 'none (no exemplar corpus — run scripts/ingest-exemplars.mjs)' };
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
  const hasVoyage = Boolean(process.env.VOYAGE_API_KEY);
  const withVectors = rows.filter((r) => r.vector).length;
  if ((hasOpenAI || hasVoyage) && withVectors > 0) {
    const provider = hasOpenAI ? new OpenAIEmbeddingProvider() : new VoyageEmbeddingProvider();
    return { exemplars: new ExemplarRetriever(rows, provider), description: `semantic (${withVectors}/${rows.length} exemplars, ${provider.model})` };
  }
  return { exemplars: new ExemplarRetriever(rows), description: `keyword BM25 (${rows.length} exemplars)` };
}
