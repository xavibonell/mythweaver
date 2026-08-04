/**
 * Asset semantic retrieval — the scalable replacement for hardcoded prompt tag-lists and
 * hand-written synonym tables (falsified 2026-07-08: 8/8 fuzzy bindings, 15/15 right-biome
 * palettes over the full library, including adversarial briefs).
 *
 * Two jobs, one index over assets/library.vectors.jsonl (built by `npm run assets:embed`):
 *   MENU    — palette(brief): per-scene top-K assets, partitioned by kind, injected into the
 *             scene-author prompts so the LLM knows what art exists (constant cost at ANY library size).
 *   BINDING — bind(concepts): fuzzy concept → tag resolution used as the LONG-TAIL FALLBACK after
 *             the exact/synonym fast path misses in compileSpec.
 *
 * Degrades to nothing: no vectors file or no embedding key → callers skip retrieval and behave
 * exactly as before. The embedder is a STRUCTURAL interface (duck-typed to packages/rag providers)
 * so this package takes no new dependency.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AssetEntry, AssetLibrary } from './asset-library.js';

/** Structurally compatible with packages/rag EmbeddingProvider — no hard dependency. */
export interface QueryEmbedder {
  model: string;
  embed(texts: string[]): Promise<number[][]>;
}

export interface AssetVectorRow {
  tag: string;
  kind: string;
  desc: string;
  biomes?: string[];
  vec: number[];
}

/** The ONE canonical embedding text per asset — the build script and any staleness check share it. */
export function assetEmbedText(a: Pick<AssetEntry, 'kind' | 'tag' | 'desc' | 'biomes'>): string {
  return `${a.kind}: ${a.tag.replace(/_/g, ' ')} — ${a.desc ?? ''}${a.biomes?.length ? `. found in: ${a.biomes.join(', ')}` : ''}`;
}

const EDGE_SUFFIX = /_(tl|tr|bl|br|t|b|l|r)$/;

/** The Director-relevant slice of the library: skip internal entries and autotile EDGE tiles
 *  (the cartographer bake owns those — the scene author only ever names the base terrain). */
export function directorAssets(lib: AssetLibrary): AssetEntry[] {
  return lib.assets.filter((a) => !a.internal && a.kind !== 'tileset' && !(a.kind === 'terrain' && EDGE_SUFFIX.test(a.tag)));
}

/** Load assets/library.vectors.jsonl by walking up from this module (same pattern as the library
 *  loader). Returns null when absent/corrupt — retrieval simply switches off. */
export function loadAssetVectors(): { model: string; rows: AssetVectorRow[] } | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    try {
      const lines = readFileSync(join(dir, 'assets', 'library.vectors.jsonl'), 'utf8').split('\n').filter(Boolean);
      const header = JSON.parse(lines[0]!) as { model: string; dim: number; count: number };
      const rows = lines.slice(1).map((l) => JSON.parse(l) as AssetVectorRow);
      if (!header.model || rows.length === 0) return null;
      return { model: header.model, rows };
    } catch {
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return null;
}

const dot = (a: number[], b: number[]): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};
const cosine = (a: number[], b: number[]): number => dot(a, b) / (Math.sqrt(dot(a, a)) * Math.sqrt(dot(b, b)) || 1);

export interface AssetPalette {
  props: { tag: string; desc: string }[];
  chars: { tag: string; desc: string }[];
  terrain: { tag: string; desc: string }[];
}

/** Below this cosine similarity a binding is refused — a wrong confident binding is worse than an
 *  honest "unrepresented" (falsification: correct bindings scored 0.40–0.74, noise ≈0.30–0.36). */
const BIND_MIN_SCORE = 0.38;
/** Soft biome-affinity nudge for palettes (a hint, never a filter — cross-biome briefs must straddle). */
const BIOME_NUDGE = 0.03;

export class AssetRetriever {
  constructor(
    private readonly rows: AssetVectorRow[],
    private readonly embedder: QueryEmbedder,
  ) {}

  private rank(qv: number[], kind: string, k: number, biomeHint?: string[]): { row: AssetVectorRow; score: number }[] {
    const scored: { row: AssetVectorRow; score: number }[] = [];
    for (const row of this.rows) {
      if (row.kind !== kind) continue;
      let score = cosine(qv, row.vec);
      if (biomeHint?.length && row.biomes?.some((b) => biomeHint.includes(b))) score += BIOME_NUDGE;
      scored.push({ row, score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, k);
  }

  /** MENU: the per-scene palette (partitioned top-K — the shape that passed falsification). */
  async palette(query: string, opts?: { biomeHint?: string[]; props?: number; chars?: number; terrain?: number }): Promise<AssetPalette> {
    const [qv] = await this.embedder.embed([query]);
    const pick = (kind: string, k: number) => this.rank(qv!, kind, k, opts?.biomeHint).map(({ row }) => ({ tag: row.tag, desc: row.desc }));
    return {
      props: pick('prop', opts?.props ?? 14),
      chars: pick('character', opts?.chars ?? 8),
      terrain: pick('terrain', opts?.terrain ?? 8),
    };
  }

  /** BINDING: fuzzy concepts → tags of one kind, batch-embedded; sub-threshold concepts are OMITTED
   *  (the caller's honest unrepresented/generic path then applies). */
  async bind(concepts: string[], kind: 'prop' | 'character', minScore = BIND_MIN_SCORE): Promise<Record<string, string>> {
    if (!concepts.length) return {};
    const qvs = await this.embedder.embed(concepts.map((c) => c.replace(/-/g, ' ')));
    const out: Record<string, string> = {};
    concepts.forEach((c, i) => {
      const [best] = this.rank(qvs[i]!, kind, 1);
      if (best && best.score >= minScore) out[c] = best.row.tag;
    });
    return out;
  }
}

/** Render a palette as the prompt block injected into scene-author prompts. Tag names double as
 *  resolvable concepts (bell_great → "bell-great" → direct-form resolution), so no new resolver. */
export function paletteBlock(p: AssetPalette, heading = 'AVAILABLE ART (retrieved for this scene — prefer these exact tags when they fit the fiction)'): string {
  const line = (xs: { tag: string; desc: string }[]) => xs.map((x) => `${x.tag} (${x.desc})`).join(', ');
  const parts = [
    p.props.length ? `  props: ${line(p.props)}` : '',
    p.chars.length ? `  creatures: ${line(p.chars)}` : '',
    p.terrain.length ? `  terrain: ${line(p.terrain)}` : '',
  ].filter(Boolean);
  return parts.length ? `${heading}\n${parts.join('\n')}` : '';
}
