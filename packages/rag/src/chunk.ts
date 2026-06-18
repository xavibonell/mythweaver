/** Text chunking for ingestion (mirrors scripts/extract-corpus.py for non-PDF text). */

export interface RawChunk {
  id: string;
  source: string;
  content: string;
}

export function chunkText(
  text: string,
  opts: { source: string; maxChars?: number; overlap?: number },
): RawChunk[] {
  const max = opts.maxChars ?? 1100;
  const overlap = opts.overlap ?? 150;

  const splitLong = (s: string): string[] => {
    const pieces: string[] = [];
    let start = 0;
    while (start < s.length) {
      let end = Math.min(start + max, s.length);
      if (end < s.length) {
        const sp = s.lastIndexOf(' ', end);
        if (sp > start + max * 0.6) end = sp;
      }
      const piece = s.slice(start, end).trim();
      if (piece) pieces.push(piece);
      if (end >= s.length) break;
      start = Math.max(end - overlap, start + 1);
    }
    return pieces;
  };

  const units: string[] = [];
  for (const p of text.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean)) {
    if (p.length > max) units.push(...splitLong(p));
    else units.push(p);
  }

  const out: RawChunk[] = [];
  let i = 0;
  let buf = '';
  for (const u of units) {
    if (buf && buf.length + u.length + 2 > max) {
      out.push({ id: `${opts.source}#${i++}`, source: opts.source, content: buf });
      buf = u;
    } else {
      buf = buf ? `${buf}\n\n${u}` : u;
    }
  }
  if (buf) out.push({ id: `${opts.source}#${i++}`, source: opts.source, content: buf });
  return out;
}
