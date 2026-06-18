/** pgvector-backed retriever (spec §5.3) — the scale path for large corpora.
 *  Used when MYTHWEAVER_RAG=pgvector and an embeddings key is configured. */

import type { EmbeddingProvider, Retriever, RetrievedChunk } from '@mythweaver/rag';
import type { Db } from './db.js';

export class DbRetriever implements Retriever {
  constructor(
    private readonly db: Db,
    private readonly embeddings: EmbeddingProvider,
    private readonly namespace = 'dnd',
  ) {}

  async retrieve(query: string, k: number): Promise<RetrievedChunk[]> {
    const [vec] = await this.embeddings.embed([query]);
    if (!vec) return [];
    return this.db.searchChunks(vec, this.namespace, k);
  }
}
