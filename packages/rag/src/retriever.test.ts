import { describe, expect, it } from 'vitest';
import type { EmbeddingProvider } from './embedding.js';
import { InMemoryRetriever, InMemoryVectorRetriever } from './retriever.js';

const chunks = [
  { id: 'a', source: 'PHB p.195', text: 'Grappling: you can use the Attack action to make a special melee attack, a grapple.' },
  { id: 'b', source: 'PHB p.241', text: 'Fireball: a bright streak flashes; each creature in the area makes a Dexterity saving throw.' },
  { id: 'c', source: 'PHB p.186', text: 'A short rest lets you spend Hit Dice to recover hit points.' },
];

describe('InMemoryRetriever', () => {
  it('ranks the chunk with the most query-term matches first', async () => {
    const hits = await new InMemoryRetriever(chunks).retrieve('how does grappling work', 2);
    expect(hits[0]?.id).toBe('a');
  });

  it('returns provenance and a positive score', async () => {
    const [top] = await new InMemoryRetriever(chunks).retrieve('Fireball Dexterity saving throw', 1);
    expect(top?.id).toBe('b');
    expect(top?.source).toBe('PHB p.241');
    expect(top?.score).toBeGreaterThan(0);
  });

  it('returns nothing when the query has no meaningful terms', async () => {
    expect(await new InMemoryRetriever(chunks).retrieve('the and of', 5)).toEqual([]);
  });

  it('respects the k limit', async () => {
    const hits = await new InMemoryRetriever(chunks).retrieve('rest hit dice grapple fireball', 1);
    expect(hits).toHaveLength(1);
  });
});

describe('InMemoryVectorRetriever', () => {
  // Deterministic 3-dim "embedding" over [grapple, fire, rest] for offline testing.
  const fake: EmbeddingProvider = {
    model: 'fake',
    dimension: 3,
    async embed(texts) {
      return texts.map((t) => {
        const s = t.toLowerCase();
        return [s.includes('grappl') ? 1 : 0, s.includes('fire') ? 1 : 0, s.includes('rest') ? 1 : 0];
      });
    },
  };
  const vchunks = [
    { id: 'g', source: 'PHB p.196', text: 'grappling rules', vector: [1, 0, 0] },
    { id: 'f', source: 'PHB p.241', text: 'fireball spell', vector: [0, 1, 0] },
    { id: 'r', source: 'PHB p.187', text: 'long rest', vector: [0, 0, 1] },
  ];

  it('ranks by cosine similarity to the query embedding', async () => {
    const hits = await new InMemoryVectorRetriever(vchunks, fake).retrieve('how does grappling work', 1);
    expect(hits[0]?.id).toBe('g');
    expect(hits[0]?.source).toBe('PHB p.196');
  });

  it('matches a semantically different query to its chunk', async () => {
    expect((await new InMemoryVectorRetriever(vchunks, fake).retrieve('fire damage', 1))[0]?.id).toBe('f');
  });
});
