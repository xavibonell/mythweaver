#!/usr/bin/env python3
"""Procedural top-down boat + cloud sprites in the DawnLike (DB16) idiom — hand-drawn, NOT a diffusion model.

Boats are drawn ONCE in a canonical frame (bow UP) and emitted in four headings (n/e/s/w) by rotation, so a
boat can moor ALONGSIDE a dock in any orientation. The sail is drawn ORTHOGONAL to the keel (a square sail on a
yard perpendicular to the hull — basic boat logic), not a triangle along the hull. Clouds are fluffy, translucent
cumulus puffs (see-through) for drifting mist.

Output: apps/web/public/assets/proc/props/{boat,boat_sail,boat_cargo}_{n,e,s,w}.png, boat_raft, piling,
        rope_coil, mist_a/b/c.png
"""
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "apps/web/public/assets/proc/props")
os.makedirs(OUT, exist_ok=True)

C = {
    "out":   (0x14, 0x0c, 0x1c, 255),
    "hull":  (0x85, 0x4c, 0x30, 255),
    "plank": (0xd2, 0x7d, 0x2c, 255),
    "light": (0xd2, 0xaa, 0x99, 255),
    "deck":  (0x5a, 0x34, 0x22, 255),
    "seat":  (0xd2, 0x7d, 0x2c, 255),
    "sail":  (0xde, 0xee, 0xd6, 255),
    "sail2": (0xb0, 0xba, 0xc6, 255),
    "mast":  (0x4e, 0x4a, 0x4e, 255),
    "crate": (0xd2, 0x7d, 0x2c, 255),
    "crated":(0x85, 0x4c, 0x30, 255),
    "rope":  (0x75, 0x71, 0x61, 255),
}
CLEAR = (0, 0, 0, 0)

# Canonical frame: bow UP. Width 32, height 48. Hull long axis = Y.
W, H = 32, 48
CX = 15.5
Y0, Y1 = 4, 45
HW = 8.5


def hull_halfwidth(t, hw):
    if t < 0.30:
        return hw * (t / 0.30) ** 0.62
    if t < 0.78:
        return hw
    u = (t - 0.78) / 0.22
    return hw * (1.0 - 0.45 * u) * (1.0 - (max(0.0, u - 0.72) / 0.28) ** 2 * 0.9)


def new_px(w, h):
    return [[CLEAR for _ in range(w)] for _ in range(h)]


def draw_hull(px, hw=HW):
    spans = {}
    L = Y1 - Y0
    for y in range(Y0, Y1):
        t = (y - Y0) / L
        h = hull_halfwidth(t, hw)
        if h < 0.7:
            continue
        ixl, ixr = int(round(CX - h)), int(round(CX + h))
        interior = []
        for x in range(ixl, ixr + 1):
            if x < 0 or x >= W:
                continue
            d = abs(x - CX)
            if d >= h - 1.0:
                px[y][x] = C["out"]
            elif d >= h - 2.2:
                px[y][x] = C["light"]
            else:
                px[y][x] = C["deck"] if d < 1.2 else C["hull"]
                interior.append(x)
        if interior:
            spans[y] = (min(interior), max(interior))
    return spans, L


def thwarts(px, spans, L, rows_frac):
    for f in rows_frac:
        y = Y0 + int(f * L)
        if y in spans:
            a, b = spans[y]
            for x in range(a, b + 1):
                px[y][x] = C["seat"]


def save_rotations(px, base):
    """Save the canonical (bow-up = north) image + its 3 rotations as {base}_{n,e,s,w}.png."""
    img = Image.new("RGBA", (W, H), CLEAR)
    for y in range(H):
        for x in range(W):
            img.putpixel((x, y), px[y][x])
    # ROTATE_270 = 90° CW → bow up becomes bow right (east); ROTATE_90 CCW → west; ROTATE_180 → south.
    variants = {"n": img,
                "e": img.transpose(Image.ROTATE_270),
                "s": img.transpose(Image.ROTATE_180),
                "w": img.transpose(Image.ROTATE_90)}
    for d, im in variants.items():
        im.save(os.path.join(OUT, f"{base}_{d}.png"))
    print("wrote", base, "n/e/s/w", f"({img.width}x{img.height} + rotations)")


def save_one(img, name):
    img.save(os.path.join(OUT, name + ".png"))
    print("wrote", name, f"{img.width}x{img.height}")


# ---- rowboat ----
px = new_px(W, H)
spans, L = draw_hull(px)
thwarts(px, spans, L, [0.42, 0.66])
save_rotations(px, "boat")

# ---- sailboat: hull + mast + a SQUARE sail on a yard ORTHOGONAL to the keel ----
px = new_px(W, H)
spans, L = draw_hull(px)
thwarts(px, spans, L, [0.72])
mast_y = Y0 + int(0.46 * L)
# mast: a short grey post at the hull centre
for y in range(Y0 + int(0.30 * L), mast_y + 2):
    px[y][int(CX)] = C["mast"]
    px[y][int(CX) + 1] = C["mast"]
# YARD (spar) — a dark horizontal bar PERPENDICULAR to the keel, a touch wider than the hull
yard_y = Y0 + int(0.36 * L)
yard_half = 10
for x in range(int(CX) - yard_half, int(CX) + yard_half + 1):
    if 0 <= x < W:
        px[yard_y][x] = C["out"]
# SAIL — a square canvas HANGING from the yard: full width at the head, tapering to a curved foot, with a
# gentle billow. Spanning left-right (not up-down) is what makes it read as a sail seen from above.
sail_top, sail_bot = yard_y + 1, yard_y + 1 + int(0.16 * L)
for y in range(sail_top, sail_bot):
    v = (y - sail_top) / max(1, (sail_bot - sail_top))
    half = int(round((yard_half - 1) * (1.0 - 0.30 * v)))     # taper toward the foot
    half += int(round(1.5 * (0.5 - abs(v - 0.5))))            # a slight belly
    for x in range(int(CX) - half, int(CX) + half + 1):
        if 0 <= x < W:
            # trailing (left) edge shaded, a seam highlight down the luff (right of mast)
            px[y][x] = C["sail2"] if x <= int(CX) - half + 1 else C["sail"]
# a curved outlined foot for definition
foot = sail_bot
for x in range(int(CX) - (yard_half - 3), int(CX) + (yard_half - 3) + 1):
    yy = foot - (1 if abs(x - int(CX)) > yard_half - 5 else 0)
    if 0 <= x < W and 0 <= yy < H and px[yy][x] != CLEAR:
        px[yy][x] = C["sail2"]
save_rotations(px, "boat_sail")

# ---- cargo boat: hull + a stack of crates amidships ----
px = new_px(W, H)
spans, L = draw_hull(px, HW + 0.6)
for (cy0, cy1, cx0, cxw) in [(0.40, 0.52, -5, 4), (0.40, 0.52, 1, 4), (0.55, 0.67, -2, 5)]:
    ya, yb = Y0 + int(cy0 * L), Y0 + int(cy1 * L)
    xa, xb = int(CX) + cx0, int(CX) + cx0 + cxw
    for y in range(ya, yb):
        for x in range(xa, xb):
            if 0 <= x < W and y in spans and spans[y][0] <= x <= spans[y][1]:
                edge = (x == xa or x == xb - 1 or y == ya or y == yb - 1)
                px[y][x] = C["out"] if edge else (C["crate"] if (x + y) % 2 == 0 else C["crated"])
save_rotations(px, "boat_cargo")

# ---- raft: a plain grid of lashed logs (symmetric — one sprite) ----
px = new_px(W, H)
rx0, rx1, ry0, ry1 = 7, 25, 8, 40
for y in range(ry0, ry1):
    for x in range(rx0, rx1):
        edge = (x == rx0 or x == rx1 - 1 or y == ry0 or y == ry1 - 1)
        px[y][x] = C["out"] if edge else (C["hull"] if ((x - rx0) // 3) % 2 == 0 else C["plank"])
for y in (ry0 + 6, ry1 - 7):
    for x in range(rx0, rx1):
        px[y][x] = C["rope"]
img = Image.new("RGBA", (W, H), CLEAR)
for y in range(H):
    for x in range(W):
        img.putpixel((x, y), px[y][x])
save_one(img, "boat_raft")

# ---- piling: a wooden mooring post (feet-bottom anchored) ----
PW, PH = 10, 18
px = new_px(PW, PH)
pcx = PW // 2
for y in range(3, PH):
    for x in range(pcx - 2, pcx + 3):
        px[y][x] = C["out"] if abs(x - pcx) == 2 else (C["hull"] if x < pcx else C["plank"])
for x in range(pcx - 2, pcx + 3):
    px[2][x] = C["out"]; px[3][x] = C["light"]
for x in range(pcx - 2, pcx + 3):
    px[7][x] = C["rope"]; px[8][x] = C["out"]
img = Image.new("RGBA", (PW, PH), CLEAR)
for y in range(PH):
    for x in range(PW):
        img.putpixel((x, y), px[y][x])
save_one(img, "piling")

# ---- barrel: a solid wooden cask (DawnLike's blue-hooped barrel reads as a CAGE at 16px) ----
# A 3/4 barrel: bulging staves (vertical), two DARK hoops, a lighter elliptical lid on top.
BW, BH = 16, 16
img = Image.new("RGBA", (BW, BH), CLEAR)
bcx = BW / 2 - 0.5
for y in range(2, 15):
    # barrel half-width bulges in the middle (a cask silhouette)
    t = (y - 2) / 12.0
    hw = 4.6 + 1.4 * (1 - (2 * t - 1) ** 2)
    for x in range(BW):
        d = abs(x - bcx)
        if d > hw:
            continue
        if d >= hw - 1.0:
            img.putpixel((x, y), C["out"])                       # stave outline
        elif y in (5, 10):
            img.putpixel((x, y), C["deck"])                      # dark hoop bands (brown, not metal)
        else:
            # vertical staves: alternate wood shades; a highlight column left of centre
            shade = C["plank"] if (x < bcx - 1) else (C["light"] if x < bcx + 1 else C["hull"])
            img.putpixel((x, y), shade)
# lid (top ellipse)
for x in range(BW):
    d = abs(x - bcx)
    if d <= 4.6:
        img.putpixel((x, 2), C["out"])
        if d < 3.6:
            img.putpixel((x, 3), C["light"])
save_one(img, "barrel")

# ---- crate: an X-braced wooden box (DawnLike's crate reads as a barred GRATE at 16px) ----
# A warm-wood box with a dark frame and a diagonal X-brace — the universal, unmistakable "crate".
CW = 16
img = Image.new("RGBA", (CW, CW), CLEAR)
lo, hi = 2, 13
for y in range(lo, hi + 1):
    for x in range(lo, hi + 1):
        frame = (x == lo or x == hi or y == lo or y == hi)
        img.putpixel((x, y), C["out"] if frame else C["hull"])
# lighter top plank + a corner highlight
for x in range(lo + 1, hi):
    img.putpixel((x, lo + 1), C["light"])
# diagonal X-brace (both diagonals), in pale plank so it reads as slats crossing the face
n = hi - lo
for i in range(1, n):
    for (bx, by) in [(lo + i, lo + i), (hi - i, lo + i)]:
        if lo < bx < hi and lo < by < hi:
            img.putpixel((bx, by), C["plank"])
            if lo < bx + 1 < hi:
                img.putpixel((bx + 1, by), C["light"])
save_one(img, "crate")

# ---- mine_entrance: a timbered adit (dark tunnel mouth + wooden headframe) set into the rock ----
ME = 16
img = Image.new("RGBA", (ME, ME), CLEAR)
TIMB = (0x85, 0x4c, 0x30, 255)     # timber
TIMB_HI = (0xd2, 0x7d, 0x2c, 255)  # lit timber edge
DARK = (0x0d, 0x0b, 0x12, 255)     # tunnel black
ROCK = (0x4e, 0x4a, 0x4e, 255)     # a little grey rock lip
# rock lintel/brow across the top
for x in range(1, 15):
    img.putpixel((x, 1), ROCK)
# timber lintel (a beam under the brow, overhanging)
for x in range(1, 15):
    img.putpixel((x, 2), C["out"])
    img.putpixel((x, 3), TIMB_HI if x % 3 else TIMB)
# the dark tunnel mouth (an arch), framed by two timber posts
for y in range(4, ME):
    for x in range(2, 14):
        edge_post = x in (2, 3, 12, 13)
        inside = 4 <= x <= 11 and not (y == 4 and x in (4, 11))  # rounded top corners
        if edge_post:
            img.putpixel((x, y), TIMB if x in (3, 12) else C["out"])
        elif inside:
            img.putpixel((x, y), DARK)
# a lintel edge over the mouth + rubble at the foot
for x in range(4, 12):
    img.putpixel((x, 4), C["out"])
for x in (5, 8, 10):
    img.putpixel((x, ME - 1), ROCK)
save_one(img, "mine_entrance")

# ---- minecart: an ore cart on a rail (strong 'mine' signal) ----
MC = 16
img = Image.new("RGBA", (MC, MC), CLEAR)
CART = (0x5a, 0x34, 0x22, 255)
CART_HI = (0x85, 0x4c, 0x30, 255)
IRON = (0x4e, 0x4a, 0x4e, 255)
OREG = (0x75, 0x71, 0x61, 255)
# ore heap mounded above the cart
for (ox, oy, orr) in [(6, 4, 3), (9, 4, 3), (7, 3, 2)]:
    for y in range(MC):
        for x in range(MC):
            if (x - ox) ** 2 + (y - oy) ** 2 <= orr * orr:
                img.putpixel((x, y), OREG if (x + y) % 3 else IRON)
img.putpixel((8, 4), (0x6d, 0xc2, 0xca, 255))  # a cold crystal-ore glint (cool, never ember-red)
# cart body (a trapezoid tub)
for y in range(6, 12):
    inset = max(0, y - 9)
    for x in range(2 + inset, 14 - inset):
        edge = (x == 2 + inset or x == 13 - inset or y == 11)
        img.putpixel((x, y), C["out"] if edge else (CART_HI if x < 8 else CART))
# wheels + a rail
for wx in (5, 11):
    for dy in range(2):
        for dx in range(-1, 2):
            img.putpixel((wx + dx, 12 + dy), IRON)
for x in range(1, 15):
    img.putpixel((x, 14), C["out"])
save_one(img, "minecart")

# ---- ore_vein: a COLD crystal/metal seam in dark rock (red ore reads as embers/fire at zoom) ----
OV = 16
img = Image.new("RGBA", (OV, OV), CLEAR)
RKD = (0x2a, 0x24, 0x2c, 255)   # dark rock
RKM = (0x4e, 0x4a, 0x4e, 255)   # mid rock
CRY = (0x59, 0x7d, 0xce, 255)   # blue crystal
CRY_HI = (0x6d, 0xc2, 0xca, 255)  # cyan highlight
CRY_LT = (0xde, 0xee, 0xd6, 255)  # white glint
ocx, ocy = 7.5, 8.5
for y in range(OV):
    for x in range(OV):
        d = ((x - ocx) / 6.5) ** 2 + ((y - ocy) / 6.0) ** 2   # a rounded rock lump
        if d > 1.0:
            continue
        img.putpixel((x, y), C["out"] if d > 0.82 else (RKD if (x + y) % 2 else RKM))
# angular crystal facets embedded in the rock (cold blues)
for (fx, fy) in [(6, 6), (7, 7), (8, 6), (9, 8), (6, 10), (8, 10), (10, 9)]:
    if 0 <= fx < OV and 0 <= fy < OV:
        img.putpixel((fx, fy), CRY)
for (fx, fy) in [(7, 6), (8, 7), (9, 9), (7, 10)]:
    img.putpixel((fx, fy), CRY_HI)
img.putpixel((8, 6), CRY_LT); img.putpixel((7, 9), CRY_LT)  # bright glints
save_one(img, "ore_vein")

# ---- peaks: clean GREY STONE mountain icons (DawnLike's peaks read as bluish blobs) ----
# A top-down/overworld mountain icon: a pointed peak with a LIT left face + SHADOWED right face split down
# the ridge, a dark base shadow, optional snow cap. Reads as grey stone rock, never fire/ice-blob.
PK = 16
ST_LIT = (0x85, 0x95, 0xa1, 255)   # lit rock face (steel grey)
ST_SHA = (0x4e, 0x4a, 0x4e, 255)   # shadowed rock face
ST_DK = (0x14, 0x0c, 0x1c, 255)    # outline / deep shadow
SNOW = (0xde, 0xee, 0xd6, 255)     # snow
SNOW_SH = (0xb6, 0xc4, 0xd6, 255)  # snow shadow


def draw_peak(apex_x, apex_y, base_y, half_max, snow_frac):
    img = Image.new("RGBA", (PK, PK), CLEAR)
    L = base_y - apex_y
    for y in range(apex_y, base_y + 1):
        t = (y - apex_y) / L
        hw = t * half_max
        xl, xr = int(round(apex_x - hw)), int(round(apex_x + hw))
        for x in range(xl, xr + 1):
            if not (0 <= x < PK):
                continue
            ridge = abs(x - apex_x) <= 0.6
            edge = (x <= xl + 0.5 or x >= xr - 0.5)
            snowy = t < snow_frac
            if edge or y == base_y:
                img.putpixel((x, y), ST_DK)
            elif snowy:
                img.putpixel((x, y), SNOW if (x <= apex_x or ridge) else SNOW_SH)
            elif ridge:
                img.putpixel((x, y), SNOW_SH if snow_frac > 0 else ST_LIT)
            else:
                img.putpixel((x, y), ST_LIT if x < apex_x else ST_SHA)
    # a cast base shadow line
    for x in range(int(apex_x - half_max), int(apex_x + half_max) + 1):
        if 0 <= x < PK and base_y + 1 < PK:
            img.putpixel((x, base_y), ST_DK)
    return img


draw_peak(7.5, 2, 14, 7.0, 0.0).save(os.path.join(OUT, "peak_a.png"))   # bare grey stone
draw_peak(7.5, 1, 14, 6.6, 0.34).save(os.path.join(OUT, "peak_b.png"))  # snow-capped
# peak_c: a craggy twin — a tall peak with a lower shoulder to its right
_c = draw_peak(6.0, 2, 14, 5.2, 0.30)
_sh = draw_peak(11.0, 6, 14, 3.4, 0.0)
_c.alpha_composite(_sh)
_c.save(os.path.join(OUT, "peak_c.png"))
print("wrote peak_a/b/c (procedural grey stone)")

# ---- rope_coil ----
RW, RH = 12, 10
img = Image.new("RGBA", (RW, RH), CLEAR)
rcx, rcy = RW / 2 - 0.5, RH / 2 - 0.5
for y in range(RH):
    for x in range(RW):
        d = ((x - rcx) / (RW * 0.44)) ** 2 + ((y - rcy) / (RH * 0.44)) ** 2
        if 0.28 <= d <= 1.0:
            img.putpixel((x, y), C["rope"] if (x + y) % 2 == 0 else C["hull"])
        elif d < 0.28:
            img.putpixel((x, y), C["out"])
save_one(img, "rope_coil")

# ---- CLOUDS: fluffy, translucent cumulus puffs (see-through drifting mist) ----
# White canvas with a soft blue-grey underside, feathered edges, moderate alpha so terrain shows through.
CLOUD_W, CLOUD_H = 56, 30
SW = (0xde, 0xee, 0xd6)   # cloud white
SH = (0xb6, 0xc4, 0xd6)   # cloud shadow (light blue)
PEAK = 135                 # peak alpha — clearly visible, but TRANSLUCENT even at the core (terrain shows through)


def cloud(lobes):
    """lobes: list of (cx, cy, r) circles. Alpha = soft union of the lobes, feathered to 0; the whole puff
    (not just the rim) stays see-through so the map reads underneath — a drifting cloud, not a cotton blob."""
    img = Image.new("RGBA", (CLOUD_W, CLOUD_H), CLEAR)
    for y in range(CLOUD_H):
        for x in range(CLOUD_W):
            best = 0.0
            for (lx, ly, r) in lobes:
                d = ((x - lx) ** 2 + (y - ly) ** 2) ** 0.5 / r
                if d < 1.0:
                    best = max(best, (1.0 - d))
            if best <= 0.02:
                continue
            a = int(PEAK * best ** 0.7)   # core tops out at PEAK (~53% opacity), feathered to 0 at the rim
            under = y > CLOUD_H * 0.52 and best < 0.6
            col = SH if under else SW
            img.putpixel((x, y), (col[0], col[1], col[2], a))
    return img


# three distinct cumulus silhouettes so the scatter isn't a repeated stamp
save_one(cloud([(16, 17, 11), (27, 12, 13), (40, 16, 12), (33, 19, 10), (20, 20, 9)]), "mist_a")
save_one(cloud([(14, 16, 10), (26, 14, 12), (37, 18, 11), (46, 16, 9)]), "mist_b")
save_one(cloud([(18, 15, 12), (30, 18, 13), (42, 14, 10), (24, 20, 8)]), "mist_c")
