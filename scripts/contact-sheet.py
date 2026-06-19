#!/usr/bin/env python3
"""
Contact-sheet authoring aid — render a tile sheet as a labeled, upscaled grid so you can
identify WHICH cell holds a given tile (then use rect=[col*16, row*16, 16, 16] in library.json).

    python3 scripts/contact-sheet.py <sheet.png> [out.png] [--cell 48] [--tile 16]

Draws each 16x16 cell upscaled, with a thin grid and col/row index gutters. Cells are indexed
[col,row] 0-based — matching the DawnLike convention rect=[col*tile, row*tile, tile, tile].
Default tile=16. Output defaults to /tmp/cs-<name>.png.
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont


def build(src: str, out: str, cell: int, tile: int) -> None:
    sheet = Image.open(src).convert("RGBA")
    cols, rows = sheet.width // tile, sheet.height // tile
    gut_l, gut_t = 34, 22  # gutters for row / col labels
    W = gut_l + cols * cell
    H = gut_t + rows * cell
    canvas = Image.new("RGBA", (W, H), (24, 22, 28, 255))
    d = ImageDraw.Draw(canvas)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 11)
    except Exception:
        font = ImageFont.load_default()
    # checkerboard behind cells so transparent art is visible
    for r in range(rows):
        for c in range(cols):
            x0, y0 = gut_l + c * cell, gut_t + r * cell
            bg = (60, 58, 66, 255) if (r + c) % 2 else (44, 42, 50, 255)
            d.rectangle([x0, y0, x0 + cell - 1, y0 + cell - 1], fill=bg)
            tilecrop = sheet.crop((c * tile, r * tile, c * tile + tile, r * tile + tile))
            up = tilecrop.resize((cell, cell), Image.NEAREST)
            canvas.alpha_composite(up, (x0, y0))
    # grid + labels
    grid = (90, 88, 96, 255)
    for c in range(cols + 1):
        x = gut_l + c * cell
        d.line([(x, gut_t), (x, H)], fill=grid)
    for r in range(rows + 1):
        y = gut_t + r * cell
        d.line([(gut_l, y), (W, y)], fill=grid)
    for c in range(cols):
        d.text((gut_l + c * cell + cell // 2 - 4, 5), str(c), fill=(230, 220, 180, 255), font=font)
    for r in range(rows):
        d.text((6, gut_t + r * cell + cell // 2 - 6), str(r), fill=(230, 220, 180, 255), font=font)
    canvas.convert("RGB").save(out)
    print(f"{os.path.basename(src)}: {cols}cols x {rows}rows -> {out}")


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    src = sys.argv[1]
    pos = [a for a in sys.argv[2:] if not a.startswith("--")]
    out = pos[0] if pos else f"/tmp/cs-{os.path.splitext(os.path.basename(src))[0]}.png"
    cell = int(sys.argv[sys.argv.index("--cell") + 1]) if "--cell" in sys.argv else 48
    tile = int(sys.argv[sys.argv.index("--tile") + 1]) if "--tile" in sys.argv else 16
    build(src, out, cell, tile)
    return 0


if __name__ == "__main__":
    sys.exit(main())
