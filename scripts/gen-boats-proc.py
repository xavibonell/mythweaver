#!/usr/bin/env python3
"""Procedural top-down boat + mist sprites in the DawnLike (DB16) idiom.

Replaces the AI-forged boat blobs: those downscaled 1024px art to 32x48 and turned to mud.
These are hand-parameterised pixel art — a pointed-bow / rounded-stern hull with plank interior,
gunwale rim, thwart seats, and per-type rigging (rowboat / sail / cargo / raft). Deterministic,
DB16-quantised, 1px dark outline — reads as an 8-bit boat, not a smear.

Output: apps/web/public/assets/proc/props/{boat,boat_sail,boat_cargo,boat_raft,mist_wisp}.png
"""
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "apps/web/public/assets/proc/props")
os.makedirs(OUT, exist_ok=True)

# DB16 (DawnBringer) — the DawnLike palette.
C = {
    "out":   (0x14, 0x0c, 0x1c, 255),  # near-black outline
    "hull":  (0x85, 0x4c, 0x30, 255),  # dark wood
    "plank": (0xd2, 0x7d, 0x2c, 255),  # orange plank
    "light": (0xd2, 0xaa, 0x99, 255),  # pale plank (gunwale / highlight)
    "deck":  (0x5a, 0x34, 0x22, 255),  # interior shadow (darker than hull)
    "seat":  (0xd2, 0x7d, 0x2c, 255),  # thwart
    "sail":  (0xde, 0xee, 0xd6, 255),  # canvas
    "sail2": (0x8b, 0x95, 0xa1, 255),  # sail shadow
    "mast":  (0x4e, 0x4a, 0x4e, 255),  # grey wood
    "crate": (0xd2, 0x7d, 0x2c, 255),
    "crated":(0x85, 0x4c, 0x30, 255),
    "rope":  (0x75, 0x71, 0x61, 255),
}
CLEAR = (0, 0, 0, 0)


def hull_halfwidth(t, hw):
    """Half-width of the hull at longitudinal fraction t in [0,1] (0=bow tip, 1=stern)."""
    if t < 0.30:                      # pointed bow
        return hw * (t / 0.30) ** 0.62
    if t < 0.78:                      # full body
        return hw
    u = (t - 0.78) / 0.22             # rounded stern
    return hw * (1.0 - 0.45 * u) * (1.0 - (max(0.0, u - 0.72) / 0.28) ** 2 * 0.9)


def draw_hull(px, W, H, y0, y1, cx, hw, plank_step=4):
    """Paint a hull into px (a 2D list). Returns list of interior spans per row for rigging."""
    spans = {}
    L = y1 - y0
    for y in range(y0, y1):
        t = (y - y0) / L
        h = hull_halfwidth(t, hw)
        if h < 0.7:
            continue
        xl, xr = cx - h, cx + h
        ixl, ixr = int(round(xl)), int(round(xr))
        interior = []
        for x in range(ixl, ixr + 1):
            if x < 0 or x >= W:
                continue
            d = abs(x - cx)
            if d >= h - 1.0:                     # outline rim
                px[y][x] = C["out"]
            elif d >= h - 2.2:                   # gunwale (pale plank edge)
                px[y][x] = C["light"]
            else:                                # interior deck: solid wood + a longitudinal keel shadow
                px[y][x] = C["deck"] if d < 1.2 else C["hull"]
                interior.append(x)
        if interior:
            spans[y] = (min(interior), max(interior))
    return spans, L


def thwarts(px, spans, y0, L, rows_frac):
    """Draw seat planks across the interior at the given longitudinal fractions."""
    for f in rows_frac:
        y = y0 + int(f * L)
        if y in spans:
            a, b = spans[y]
            for x in range(a, b + 1):
                px[y][x] = C["seat"]
            # a thin shadow line under the seat
            if (y + 1) in spans:
                aa, bb = spans[y + 1]
                for x in range(max(a, aa), min(b, bb) + 1):
                    px[y + 1][x] = C["deck"]


def new_px(W, H):
    return [[CLEAR for _ in range(W)] for _ in range(H)]


def save(px, W, H, name):
    img = Image.new("RGBA", (W, H), CLEAR)
    for y in range(H):
        for x in range(W):
            img.putpixel((x, y), px[y][x])
    img.save(os.path.join(OUT, name + ".png"))
    print("wrote", name, f"{W}x{H}")


W, H = 32, 48
cx = 15.5
Y0, Y1 = 4, 45
HW = 8.5

# ---- rowboat: bare hull + two thwarts ----
px = new_px(W, H)
spans, L = draw_hull(px, W, H, Y0, Y1, cx, HW)
thwarts(px, spans, Y0, L, [0.42, 0.66])
save(px, W, H, "boat")

# ---- sailboat: hull + mast + a canvas sail ----
px = new_px(W, H)
spans, L = draw_hull(px, W, H, Y0, Y1, cx, HW)
thwarts(px, spans, Y0, L, [0.70])
my = Y0 + int(0.52 * L)               # mast base
# mast (a short grey post at centre)
for y in range(Y0 + int(0.30 * L), my):
    px[y][int(cx)] = C["mast"]
    px[y][int(cx) + 1] = C["mast"]
# sail — a filled canvas triangle billowing forward (toward the bow), with a shadow edge
for y in range(Y0 + int(0.20 * L), Y0 + int(0.54 * L)):
    t = (y - (Y0 + int(0.20 * L))) / (0.34 * L)
    half = 1 + int(6.5 * t)
    for x in range(int(cx) - half, int(cx) + half + 1):
        if 0 <= x < W:
            px[y][x] = C["sail2"] if x >= int(cx) + half - 1 else C["sail"]
# mast cap over the sail
px[Y0 + int(0.30 * L)][int(cx)] = C["out"]
save(px, W, H, "boat_sail")

# ---- cargo boat: wider hull + a stack of crates amidships ----
px = new_px(W, H)
spans, L = draw_hull(px, W, H, Y0, Y1, cx, HW + 0.6)
for (cy0, cy1, cx0, cxw) in [(0.40, 0.52, -5, 4), (0.40, 0.52, 1, 4), (0.55, 0.67, -2, 5)]:
    ya, yb = Y0 + int(cy0 * L), Y0 + int(cy1 * L)
    xa, xb = int(cx) + cx0, int(cx) + cx0 + cxw
    for y in range(ya, yb):
        for x in range(xa, xb):
            if 0 <= x < W and y in spans and spans[y][0] <= x <= spans[y][1]:
                edge = (x == xa or x == xb - 1 or y == ya or y == yb - 1)
                px[y][x] = C["out"] if edge else (C["crate"] if (x + y) % 2 == 0 else C["crated"])
save(px, W, H, "boat_cargo")

# ---- raft: a plain grid of lashed logs (no hull curve) ----
px = new_px(W, H)
rx0, rx1, ry0, ry1 = 7, 25, 8, 40
for y in range(ry0, ry1):
    for x in range(rx0, rx1):
        edge = (x == rx0 or x == rx1 - 1 or y == ry0 or y == ry1 - 1)
        if edge:
            px[y][x] = C["out"]
        else:
            px[y][x] = C["hull"] if ((x - rx0) // 3) % 2 == 0 else C["plank"]
# two lashing ropes across
for y in (ry0 + 6, ry1 - 7):
    for x in range(rx0, rx1):
        px[y][x] = C["rope"]
save(px, W, H, "boat_raft")

# ---- mist wisp: a soft translucent grey blob (feathered, low alpha) ----
MW, MH = 40, 24
img = Image.new("RGBA", (MW, MH), CLEAR)
mcx, mcy = MW / 2, MH / 2
for y in range(MH):
    for x in range(MW):
        # elliptical falloff, elongated horizontally, soft edges
        dx = (x - mcx) / (MW * 0.46)
        dy = (y - mcy) / (MH * 0.42)
        d = dx * dx + dy * dy
        if d >= 1.0:
            continue
        a = int(96 * (1.0 - d) ** 1.6)       # peak alpha ~96/255, feathered to 0
        # a touch of internal wispiness so it isn't a perfect blob
        if (x * 7 + y * 13) % 11 == 0:
            a = int(a * 0.6)
        img.putpixel((x, y), (0xcf, 0xd6, 0xdd, a))
img.save(os.path.join(OUT, "mist_wisp.png"))
print("wrote mist_wisp", f"{MW}x{MH}")

# ---- piling: a wooden mooring post (feet-bottom anchored, ~10x18) ----
PW, PH = 10, 18
px = new_px(PW, PH)
pcx = PW // 2
for y in range(3, PH):                    # the post shaft
    for x in range(pcx - 2, pcx + 3):
        d = abs(x - pcx)
        if d == 2:
            px[y][x] = C["out"]
        else:
            px[y][x] = C["hull"] if x < pcx else C["plank"]
for x in range(pcx - 2, pcx + 3):         # rounded top cap (lighter)
    px[2][x] = C["out"]
    px[3][x] = C["light"]
for x in range(pcx - 2, pcx + 3):         # a rope wrap near the top
    px[7][x] = C["rope"]
    px[8][x] = C["out"]
save(px, PW, PH, "piling")

# ---- rope_coil: a small coil of rope lying on the planks (~12x10) ----
RW, RH = 12, 10
img = Image.new("RGBA", (RW, RH), CLEAR)
rcx, rcy = RW / 2 - 0.5, RH / 2 - 0.5
for y in range(RH):
    for x in range(RW):
        dx = (x - rcx) / (RW * 0.44)
        dy = (y - rcy) / (RH * 0.44)
        d = dx * dx + dy * dy
        if 0.28 <= d <= 1.0:              # a ring (coil), hollow centre
            img.putpixel((x, y), C["rope"] if (x + y) % 2 == 0 else C["hull"])
        elif d < 0.28:
            img.putpixel((x, y), C["out"])
img.save(os.path.join(OUT, "rope_coil.png"))
print("wrote rope_coil", f"{RW}x{RH}")
