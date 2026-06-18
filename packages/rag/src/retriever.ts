/**
 * Retrieval seam (spec §5.3). RAG supplies rules TEXT for narration/lookup — it
 * NEVER resolves a mechanic (that's the engine, spec §4). Every chunk carries
 * provenance so narration can cite the source.
 */

import type { EmbeddingProvider } from './embedding.js';

export interface RetrievedChunk {
  id: string;
  text: string;
  /** Provenance for citation, e.g. "Player's Handbook p.123". */
  source: string;
  /** Relevance score (higher = better). */
  score: number;
}

export interface Retriever {
  retrieve(query: string, k: number): Promise<RetrievedChunk[]>;
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'what', 'how', 'does', 'did', 'are', 'can', 'you',
  'your', 'from', 'into', 'when', 'where', 'who', 'why', 'will', 'would', 'should', 'could', 'has',
  'have', 'had', 'was', 'were', 'about', 'they', 'them', 'then', 'than', 'its', 'his', 'her',
  'rule', 'rules', 'work', 'works', 'use', 'using',
]);

/** Crude suffix stemmer so query word-forms match the text (grappling≈grapple, saves≈saving). */
function stem(t: string): string {
  let w = t;
  if (w.length > 4) {
    if (w.endsWith('ing')) w = w.slice(0, -3);
    else if (w.endsWith('edly')) w = w.slice(0, -4);
    else if (w.endsWith('ed')) w = w.slice(0, -2);
    else if (w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
    else if (w.endsWith('es')) w = w.slice(0, -2);
    else if (w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  }
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1); // grapple->grappl, damage->damag
  return w;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t))
    .map(stem);
}

/**
 * A dependency-free BM25 keyword retriever. Rarity-weights query terms (IDF) and
 * normalizes for chunk length, so a passage dense in a specific term ("grappling")
 * outranks one that merely mentions it. Good for a small/medium corpus and works
 * offline with no embeddings key. Swap in a vector retriever (same interface) for
 * true semantic search once the corpus is large or queries are paraphrased.
 */
export class InMemoryRetriever implements Retriever {
  private readonly docs: { id: string; text: string; source: string; len: number; tf: Map<string, number> }[] = [];
  private readonly df = new Map<string, number>();
  private readonly avgdl: number;
  private readonly k1 = 1.5;
  private readonly b = 0.75;

  constructor(chunks: ReadonlyArray<{ id: string; text: string; source: string }>) {
    let totalLen = 0;
    for (const c of chunks) {
      const tokens = tokenize(c.text);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs.push({ id: c.id, text: c.text, source: c.source, len: tokens.length, tf });
      totalLen += tokens.length;
    }
    this.avgdl = this.docs.length > 0 ? totalLen / this.docs.length : 1;
  }

  get size(): number {
    return this.docs.length;
  }

  async retrieve(query: string, k: number): Promise<RetrievedChunk[]> {
    const terms = Array.from(new Set(tokenize(query)));
    if (terms.length === 0 || this.docs.length === 0) return [];
    const N = this.docs.length;

    const scored: RetrievedChunk[] = [];
    for (const d of this.docs) {
      let score = 0;
      for (const t of terms) {
        const tf = d.tf.get(t);
        if (!tf) continue;
        const df = this.df.get(t) ?? 1;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        const denom = tf + this.k1 * (1 - this.b + (this.b * d.len) / this.avgdl);
        score += idf * ((tf * (this.k1 + 1)) / denom);
      }
      if (score > 0) scored.push({ id: d.id, text: d.text, source: d.source, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }
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
 * Semantic retriever: cosine similarity over precomputed chunk vectors, with the
 * query embedded at retrieval time. Runs fully in-memory (no DB) — load the cached
 * corpus vectors and go. Same `Retriever` interface as the keyword/pgvector paths.
 */
export class InMemoryVectorRetriever implements Retriever {
  constructor(
    private readonly chunks: ReadonlyArray<{ id: string; text: string; source: string; vector: number[] }>,
    private readonly embeddings: EmbeddingProvider,
  ) {}

  get size(): number {
    return this.chunks.length;
  }

  async retrieve(query: string, k: number): Promise<RetrievedChunk[]> {
    if (this.chunks.length === 0) return [];
    const [q] = await this.embeddings.embed([query]);
    if (!q) return [];
    const scored = this.chunks.map((c) => ({ id: c.id, text: c.text, source: c.source, score: cosine(q, c.vector) }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }
}
