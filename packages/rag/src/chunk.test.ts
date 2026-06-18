import { describe, expect, it } from 'vitest';
import { chunkText } from './chunk.js';

describe('chunkText', () => {
  it('splits long text into bounded chunks with provenance', () => {
    const long = 'word '.repeat(600); // ~3000 chars, one paragraph
    const chunks = chunkText(long, { source: 'Test p.1', maxChars: 500 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(500);
    expect(chunks[0]?.source).toBe('Test p.1');
    expect(chunks[0]?.id).toBe('Test p.1#0');
  });

  it('keeps short text as a single chunk', () => {
    expect(chunkText('a short passage', { source: 's' })).toHaveLength(1);
  });
});
