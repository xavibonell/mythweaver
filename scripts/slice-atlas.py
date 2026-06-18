#!/usr/bin/env python3
"""
Atlas slicer (authoring aid) — find the individual sprites in a packed atlas by alpha
connected-components, so crop rects come from the PIXELS, not from eyeballing a grid.

Usage:  python3 scripts/slice-atlas.py "<raw rel path>" [minArea]

Emits, under /tmp/slice/<atlasname>/:
  - <i>.png            one tight crop per detected sprite, indexed in reading order
  - _contact.png       all sprites laid out with their index + px bbox drawn on
  - boxes.json         {index: [x,y,w,h]} so chosen sprites can be pasted into library.json `from.crop`/`rect`

This is an OFFLINE authoring tool; the runtime pipeline never calls it. Pick the indices you
want from the contact sheet, then add library records with from:{crop:"<atlas>","rect":[x,y,w,h]}.
"""
import json
import os
import sys
from collections import deque

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "Pixel Crawler - Free Pack")


def components(mask, w, h, min_area):
    """8-connected components over a boolean mask (row-major list)."""
    seen = bytearray(w * h)
    boxes = []
    for sy in range(h):
        for sx in range(w):
            i0 = sy * w + sx
            if not mask[i0] or seen[i0]:
                continue
            q = deque([i0])
            seen[i0] = 1
            minx = maxx = sx
            miny = maxy = sy
            area = 0
            while q:
                i = q.popleft()
                y, x = divmod(i, w)
                area += 1
                minx, maxx = min(minx, x), max(maxx, x)
                miny, maxy = min(miny, y), max(maxy, y)
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        nx, ny = x + dx, y + dy
                        if 0 <= nx < w and 0 <= ny < h:
                            j = ny * w + nx
                            if mask[j] and not seen[j]:
                                seen[j] = 1
                                q.append(j)
            if area >= min_area:
                boxes.append((minx, miny, maxx - minx + 1, maxy - miny + 1))
    # reading order: top-to-bottom in bands of 24px, then left-to-right
    boxes.sort(key=lambda b: (b[1] // 24, b[0]))
    return boxes


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    rel = sys.argv[1]
    min_area = int(sys.argv[2]) if len(sys.argv) > 2 else 40
    im = Image.open(os.path.join(RAW, rel)).convert("RGBA")
    w, h = im.size
    alpha = im.getchannel("A").tobytes()
    mask = [a > 16 for a in alpha]
    boxes = components(mask, w, h, min_area)

    name = os.path.splitext(os.path.basename(rel))[0]
    out = os.path.join("/tmp/slice", name)
    os.makedirs(out, exist_ok=True)

    # per-sprite crops + a contact sheet
    S = 3
    cols = 8
    cellw = (max((b[2] for b in boxes), default=16) + 6) * S
    cellh = (max((b[3] for b in boxes), default=16) + 18) * S
    rows = (len(boxes) + cols - 1) // cols
    sheet = Image.new("RGBA", (cols * cellw, rows * cellh), (30, 30, 36, 255))
    d = ImageDraw.Draw(sheet)
    out_boxes = {}
    for i, (x, y, bw, bh) in enumerate(boxes):
        crop = im.crop((x, y, x + bw, y + bh))
        crop.save(os.path.join(out, f"{i}.png"))
        out_boxes[i] = [x, y, bw, bh]
        cx = (i % cols) * cellw
        cy = (i // cols) * cellh
        big = crop.resize((bw * S, bh * S), Image.NEAREST)
        sheet.paste(big, (cx + 3 * S, cy + 14 * S), big)
        d.text((cx + 2, cy + 2), f"{i}: {bw}x{bh}", fill=(255, 230, 120, 255))
    sheet.save(os.path.join(out, "_contact.png"))
    with open(os.path.join(out, "boxes.json"), "w") as f:
        json.dump(out_boxes, f)
    print(f"{name}: {len(boxes)} sprites -> {out}/_contact.png")
    return 0


if __name__ == "__main__":
    sys.exit(main())
