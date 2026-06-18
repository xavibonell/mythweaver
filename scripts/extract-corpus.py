#!/usr/bin/env python3
"""
Game-agnostic corpus extractor: turn a folder of PDFs into a chunked JSONL corpus
for the RAG layer. Swap the folder to change games.

Usage:  .venv-pdf/bin/python scripts/extract-corpus.py [SRC_DIR] [OUT_JSONL]
Default: raw-data/dnd  ->  content/corpus/dnd.jsonl

NOTE: output is gitignored. Only run on source material you are licensed to use
(personal use only — see README / spec §11).
"""
import glob
import json
import os
import re
import sys

import fitz  # PyMuPDF — reconstructs word spacing from glyph positions far better than pypdf

SRC = sys.argv[1] if len(sys.argv) > 1 else "raw-data/dnd"
OUT = sys.argv[2] if len(sys.argv) > 2 else "content/corpus/dnd.jsonl"
MAX_CHARS = 1100
OVERLAP = 150


def clean(t: str) -> str:
    t = t.replace("\x00", " ")
    t = re.sub(r"­\s*", "", t)  # join soft-hyphenated line breaks ("spe-\ncially" -> "specially")
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()


def split_long(s: str):
    """Split an over-long passage into ~MAX_CHARS windows on word boundaries."""
    pieces, start = [], 0
    while start < len(s):
        end = min(start + MAX_CHARS, len(s))
        if end < len(s):
            sp = s.rfind(" ", start + int(MAX_CHARS * 0.6), end)
            if sp != -1:
                end = sp
        piece = s[start:end].strip()
        if piece:
            pieces.append(piece)
        if end >= len(s):
            break
        start = max(end - OVERLAP, start + 1)
    return pieces


def chunk(text: str, source: str, start: int):
    # Normalize into units no larger than MAX_CHARS, then pack.
    units = []
    for p in (p.strip() for p in re.split(r"\n{2,}", text) if p.strip()):
        units.extend(split_long(p) if len(p) > MAX_CHARS else [p])

    out, i, buf = [], start, ""
    for u in units:
        if buf and len(buf) + len(u) + 2 > MAX_CHARS:
            out.append({"id": f"{source}#{i}", "source": source, "content": buf})
            i += 1
            buf = u
        else:
            buf = (buf + "\n\n" + u) if buf else u
    if buf:
        out.append({"id": f"{source}#{i}", "source": source, "content": buf})
        i += 1
    return out, i


def main() -> None:
    os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
    pdfs = sorted(glob.glob(os.path.join(SRC, "*.pdf")))
    if not pdfs:
        print(f"No PDFs found in {SRC}")
        sys.exit(1)
    total = 0
    with open(OUT, "w", encoding="utf-8") as f:
        for pdf in pdfs:
            book = os.path.splitext(os.path.basename(pdf))[0]
            try:
                doc = fitz.open(pdf)
            except Exception as e:  # noqa: BLE001
                print(f"  skip {book}: {e}")
                continue
            cid, kept = 0, 0
            for pidx in range(len(doc)):
                try:
                    text = clean(doc[pidx].get_text("text") or "")
                except Exception:  # noqa: BLE001
                    text = ""
                if len(text) < 40:
                    continue
                chunks, cid = chunk(text, f"{book} p.{pidx + 1}", cid)
                for c in chunks:
                    f.write(json.dumps(c, ensure_ascii=False) + "\n")
                    kept += 1
            total += kept
            print(f"  {book}: {len(doc)} pages -> {kept} chunks")
    print(f"TOTAL: {total} chunks -> {OUT}")


if __name__ == "__main__":
    main()
