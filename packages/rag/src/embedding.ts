/**
 * Embedding provider seam (spec §5.2).
 *
 * CRITICAL INVARIANT: `dimension` must equal the pgvector column dimension. It is
 * NOT provider-agnostic — voyage-3-large = 1024, text-embedding-3-large = 3072.
 * Changing vendor/dimension after launch requires a full re-embed + schema
 * migration (spec §5.2). This is a DIFFERENT vendor from Anthropic; SRD/lore text
 * is sent to it (spec §13).
 */

export interface EmbeddingProvider {
  readonly model: string;
  /** Output vector dimension; must match the `vector(N)` DB column. */
  readonly dimension: number;
  embed(texts: string[]): Promise<number[][]>;
}

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';

export interface VoyageOptions {
  apiKey?: string;
  model?: string;
  dimension?: number;
}

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimension: number;
  private readonly apiKey: string;

  constructor(opts: VoyageOptions = {}) {
    this.model = opts.model ?? 'voyage-3-large';
    this.dimension = opts.dimension ?? 1024; // matches db/init vector(1024) — spec §5.2
    this.apiKey = opts.apiKey ?? process.env.VOYAGE_API_KEY ?? '';
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.apiKey) throw new Error('VOYAGE_API_KEY is not set (see .env.example).');
    const res = await fetch(VOYAGE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: texts, output_dimension: this.dimension }),
    });
    if (!res.ok) throw new Error(`Voyage API error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { data: { embedding: number[] }[] };
    return data.data.map((d) => d.embedding);
  }
}

const OPENAI_URL = 'https://api.openai.com/v1/embeddings';

export interface OpenAIEmbeddingOptions {
  apiKey?: string;
  model?: string;
  /** Output dimension; text-embedding-3-large supports reducing via `dimensions`. */
  dimension?: number;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimension: number;
  private readonly apiKey: string;

  constructor(opts: OpenAIEmbeddingOptions = {}) {
    this.model = opts.model ?? 'text-embedding-3-large';
    this.dimension = opts.dimension ?? 1024; // matches db/init vector(1024) — spec §5.2
    this.apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? '';
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY is not set (see .env.example).');
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: texts, dimensions: this.dimension }),
    });
    if (!res.ok) throw new Error(`OpenAI embeddings error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { data: { embedding: number[]; index: number }[] };
    // Preserve input order (the API returns an `index` per item).
    return data.data.slice().sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}
