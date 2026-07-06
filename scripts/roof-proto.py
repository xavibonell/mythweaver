#!/usr/bin/env python3
"""PROTOTYPE v2 — vector roofs, iterating on feedback: fix the tall-building geometry (ridge along the LONG
axis), shape VARIETY (hip / gable / pyramid / L / T from the footprint), a crafted 2-tone RIM with tick
courses, and chimney + dormer copied from the reference. Not wired in — draws to /tmp to judge the look."""
from PIL import Image, ImageDraw


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def _mask_poly(size, poly):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).polygon([(round(px), round(py)) for px, py in poly], fill=255)
    return m


def fill_grad(img, poly, c_top, c_bot):
    """Fill a polygon with a vertical gradient + a faint course texture (subtle, faces stay smooth planes)."""
    W, H = img.size
    ys = [p[1] for p in poly]
    y0, y1 = int(min(ys)), max(int(min(ys)) + 1, int(max(ys)))
    grad = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gp = grad.load()
    for y in range(H):
        col = lerp(c_top, c_bot, max(0.0, min(1.0, (y - y0) / (y1 - y0)))) + (255,)
        for x in range(W):
            gp[x, y] = col
    mask = _mask_poly((W, H), poly)
    img.paste(grad, (0, 0), mask)
    tex = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    td = ImageDraw.Draw(tex)
    line = lerp(c_bot, (0, 0, 0), 0.25)
    for y in range(0, H, 3):
        td.line([(0, y), (W, y)], fill=line + (34,))
    img.alpha_composite(Image.composite(tex, Image.new("RGBA", (W, H), (0, 0, 0, 0)), mask))


def line(d, a, b, col, w=1):
    d.line([(round(a[0]), round(a[1])), (round(b[0]), round(b[1]))], fill=col + (255,), width=w)


def crafted_rim(img, d, outline_poly, base):
    """A 2-tone fascia: a lighter TRIM band just inside a dark outline, with tick courses — the human-craft
    border. `outline_poly` is the roof's outer edge (closed)."""
    RIM_DK = lerp(base, (0, 0, 0), 0.55)
    TRIM = lerp(base, (255, 240, 210), 0.30)
    pts = [(round(x), round(y)) for x, y in outline_poly]
    d.line(pts + [pts[0]], fill=TRIM + (255,), width=3)      # the fascia band
    d.line(pts + [pts[0]], fill=RIM_DK + (255,), width=1)    # crisp dark outer edge
    # tick courses along each edge (the shingle-tile ends)
    for i in range(len(pts)):
        a, b = pts[i], pts[(i + 1) % len(pts)]
        n = max(1, int((((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2) ** 0.5) // 5))
        for k in range(1, n):
            t = k / n
            px, py = a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t
            d.point((round(px), round(py)), fill=RIM_DK + (255,))


def chimney(img, d, cx, cy):
    """A brick chimney copied from the reference: a stubby brick stack, mortar courses, a lit cap, dark flue,
    and a soft cast shadow on the roof."""
    w, h = 11, 13
    x0, y0 = cx - w // 2, cy - h
    d.ellipse([cx - 7, cy - 2, cx + 8, cy + 3], fill=(0, 0, 0, 60))                        # cast shadow
    BR, BRD, MOR, CAP = (0x9a, 0x4e, 0x38), (0x6e, 0x34, 0x28), (0x4a, 0x24, 0x1e), (0xba, 0x6c, 0x50)
    d.rectangle([x0, y0 + 4, x0 + w, y0 + h], fill=BR, outline=BRD)                        # stack
    for my in range(y0 + 6, y0 + h, 3):                                                    # mortar courses
        d.line([(x0 + 1, my), (x0 + w - 1, my)], fill=MOR)
    for mx in range(x0 + 3, x0 + w, 4):
        d.line([(mx, y0 + 4), (mx, y0 + h)], fill=(MOR[0], MOR[1], MOR[2], 120))
    d.rectangle([x0 - 1, y0, x0 + w + 1, y0 + 4], fill=CAP, outline=BRD)                   # lit cap
    d.rectangle([x0 + 2, y0 + 1, x0 + w - 2, y0 + 3], fill=(0x16, 0x10, 0x12))             # flue opening


def dormer(img, d, cx, cy, base):
    """A dormer skylight copied from the reference: a little pitched rooflet + a framed blue-glass pane."""
    ROOF = lerp(base, (0, 0, 0), 0.28)
    FRAME = lerp(base, (255, 240, 210), 0.35)
    d.polygon([(cx - 8, cy + 5), (cx + 8, cy + 5), (cx + 6, cy - 3), (cx - 6, cy - 3)],
              fill=ROOF, outline=(0x20, 0x14, 0x14))                                       # dormer roof
    d.rectangle([cx - 5, cy - 3, cx + 5, cy + 4], fill=FRAME, outline=(0x20, 0x14, 0x14))  # frame
    d.rectangle([cx - 4, cy - 2, cx + 4, cy + 3], fill=(0x5f, 0x9b, 0xb4))                 # glass
    d.rectangle([cx - 4, cy - 2, cx + 4, cy], fill=(0x9d, 0xc6, 0xd6))                     # glass highlight
    line(d, (cx, cy - 2), (cx, cy + 3), (0x2a, 0x4a, 0x54))                                # mullion


def hip(img, d, X, Y, W, H, base, rim=True):
    """A hip roof — ridge along the LONG axis (fixes the tall-building bug). 4 lit faces + crisp hips."""
    horiz = W >= H
    inset = min(W, H) / 2
    TL, TR, BR, BL = (X, Y), (X + W, Y), (X + W, Y + H), (X, Y + H)
    N_lit, S_dk = lerp(base, (255, 255, 255), 0.26), lerp(base, (0, 0, 0), 0.30)
    Wm, Em = lerp(base, (255, 255, 255), 0.08), lerp(base, (0, 0, 0), 0.18)
    if horiz:
        r1, r2 = (X + inset, Y + H / 2), (X + W - inset, Y + H / 2)
        faces = [([TL, TR, r2, r1], lerp(base, (255, 255, 255), 0.32), N_lit),
                 ([BL, BR, r2, r1], lerp(base, (0, 0, 0), 0.06), S_dk),
                 ([TL, BL, r1], Wm, lerp(base, (0, 0, 0), 0.10)),
                 ([TR, BR, r2], Em, lerp(base, (0, 0, 0), 0.22))]
    else:
        r1, r2 = (X + W / 2, Y + inset), (X + W / 2, Y + H - inset)   # rt, rb
        faces = [([TL, BL, r2, r1], lerp(base, (255, 255, 255), 0.20), Wm),   # W trapezoid (lit)
                 ([TR, BR, r2, r1], lerp(base, (0, 0, 0), 0.06), Em),         # E trapezoid (shadow)
                 ([TL, TR, r1], lerp(base, (255, 255, 255), 0.30), N_lit),    # N triangle
                 ([BL, BR, r2], lerp(base, (0, 0, 0), 0.10), S_dk)]           # S triangle
    for poly, ct, cb in faces:
        fill_grad(img, poly, ct, cb)
    HIP = lerp(base, (0, 0, 0), 0.42)
    for a, bp in ([TL, r1], [BL, r1 if horiz else r2], [TR, r2 if horiz else r1], [BR, r2]):
        line(d, a, bp, HIP)
    line(d, r1, r2, lerp(base, (255, 255, 255), 0.40), 2)   # ridge cap
    if rim:
        crafted_rim(img, d, [TL, TR, BR, BL], base)


def gable(img, d, X, Y, W, H, base):
    """A gable roof for LONG/narrow buildings — ridge runs the full long axis, two big slopes, gable ends."""
    horiz = W >= H
    TL, TR, BR, BL = (X, Y), (X + W, Y), (X + W, Y + H), (X, Y + H)
    if horiz:  # ridge horizontal, full width; slopes N (lit) + S (dark)
        m1, m2 = (X, Y + H / 2), (X + W, Y + H / 2)
        fill_grad(img, [TL, TR, m2, m1], lerp(base, (255, 255, 255), 0.32), lerp(base, (255, 255, 255), 0.14))
        fill_grad(img, [m1, m2, BR, BL], lerp(base, (0, 0, 0), 0.08), lerp(base, (0, 0, 0), 0.32))
        line(d, m1, m2, lerp(base, (255, 255, 255), 0.40), 2)
    else:      # ridge vertical, full height; slopes W (lit) + E (dark)
        m1, m2 = (X + W / 2, Y), (X + W / 2, Y + H)
        fill_grad(img, [TL, m1, m2, BL], lerp(base, (255, 255, 255), 0.26), lerp(base, (255, 255, 255), 0.10))
        fill_grad(img, [m1, TR, BR, m2], lerp(base, (0, 0, 0), 0.06), lerp(base, (0, 0, 0), 0.28))
        line(d, m1, m2, lerp(base, (255, 255, 255), 0.40), 2)
    crafted_rim(img, d, [TL, TR, BR, BL], base)


def make(w, h, kind, base, tile=16, extras=None):
    W, H = w * tile, h * tile
    pad = 4
    img = Image.new("RGBA", (W + pad * 2, H + pad * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    X, Y = pad, pad
    if kind == "hip":
        hip(img, d, X, Y, W, H, base)
    elif kind == "gable":
        gable(img, d, X, Y, W, H, base)
    elif kind == "L":   # two wings meeting — a hip on each
        hip(img, d, X, Y, W, int(H * 0.6), base)
        hip(img, d, X, Y + int(H * 0.42), int(W * 0.58), H - int(H * 0.42), base)
    elif kind == "T":
        hip(img, d, X, Y, W, int(H * 0.5), base)
        hip(img, d, X + int(W * 0.30), Y + int(H * 0.34), int(W * 0.4), int(H * 0.66), base)
    for (ex, ey, what) in (extras or []):
        (chimney if what == "chimney" else dormer)(img, d, X + int(W * ex), Y + int(H * ey), base) if what == "dormer" else chimney(img, d, X + int(W * ex), Y + int(H * ey))
    return img


TILE_RED = (0xb0, 0x50, 0x38)
SLATE = (0x70, 0x78, 0x88)
THATCH = (0xc2, 0x9c, 0x5c)
row = [
    make(9, 6, "hip", TILE_RED, extras=[(0.34, 0.42, "chimney")]),
    make(7, 7, "hip", TILE_RED, extras=[(0.3, 0.72, "dormer"), (0.7, 0.72, "dormer"), (0.5, 0.30, "chimney")]),
    make(4, 9, "gable", SLATE, extras=[(0.5, 0.2, "chimney")]),
    make(9, 8, "L", THATCH, extras=[(0.3, 0.25, "chimney")]),
    make(9, 9, "T", TILE_RED, extras=[(0.5, 0.18, "chimney")]),
]
scale, pad, BG = 3, 18, (0x3a, 0x5a, 0x3a)
Wt = sum(o.width for o in row) * scale + pad * (len(row) + 1)
Ht = max(o.height for o in row) * scale + pad * 2
sheet = Image.new("RGBA", (Wt, Ht), BG + (255,))
x = pad
for o in row:
    sheet.alpha_composite(o.resize((o.width * scale, o.height * scale), Image.NEAREST), (x, pad + (max(o.height for o in row) - o.height) * scale // 2))
    x += o.width * scale + pad
sheet.convert("RGB").save("/tmp/roof_proto.png")
print("-> /tmp/roof_proto.png")
