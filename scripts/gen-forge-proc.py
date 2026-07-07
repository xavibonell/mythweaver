#!/usr/bin/env python3
"""THE ASSET FORGE — procedural DawnLike/DB16-style sprites for everything behind the ART WALL.

Style contract (matches gen-boats-proc.py + the DawnLike originals):
  - 16px grid; larger set-pieces in multiples (32/48/64). Hard pixels, NO anti-aliasing/gradients.
  - 1px near-black outline (OUT) around every silhouette.
  - 2-3 shades per material: light from top-left, shadow bottom-right.
  - Feet-anchored: the subject stands on the bottom row(s) of its canvas.
  - Animations: 2 frames, horizontal sheet; frame 2 is a small delta (flicker / 1px bob).
  - Deterministic: no randomness.

Run: python3 scripts/gen-forge-proc.py  -> writes PNGs under apps/web/public/assets/proc/{props,char,terrain}/
     + /tmp/forge-manifest.json (library registration data) + /tmp/forge-contact.png (QA sheet).
"""
import json
import os
from PIL import Image, ImageDraw

ROOT = os.path.join(os.path.dirname(__file__), "..")
OUT_PROPS = os.path.join(ROOT, "apps/web/public/assets/proc/props")
OUT_CHAR = os.path.join(ROOT, "apps/web/public/assets/proc/char")
OUT_TERR = os.path.join(ROOT, "apps/web/public/assets/proc/terrain")
for d in (OUT_PROPS, OUT_CHAR, OUT_TERR):
    os.makedirs(d, exist_ok=True)

# ---- palette: DB16 + a small fixed extension (bronze/bone/blood/foliage) -----------------------
def C(h, a=255):
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)

OUT = C("140c1c")        # outline / near-black
PLUM = C("442434")       # deep plum shadow
NAVY = C("30346d")       # deep blue
SLATE = C("4e4a4e")      # dark grey
BROWN = C("854c30")      # wood dark
GREEN_D = C("346524")    # foliage dark
RED = C("d04648")        # blood-bright / cloth
GREY = C("757161")       # stone mid
BLUE = C("597dce")       # water / magic
ORANGE = C("d27d2c")     # fire / bronze-light
GREY_L = C("8595a1")     # stone light
GREEN = C("6daa2c")      # foliage mid
TAN = C("d2aa99")        # skin / rope
CYAN = C("6dc2ca")       # ghost / ice
YELLOW = C("dad45e")     # flame / gold
WHITE = C("deeed6")      # highlight / bone-light
# extension (kept minimal + reused everywhere)
BRONZE = C("8a6d3b")
BRONZE_D = C("5c4426")
BONE = C("c9c2a6")
BONE_D = C("8f8a72")
BLOOD = C("7a1f1f")
BLOOD_D = C("4d1010")
GREEN_DD = C("1e3d16")
PURPLE = C("6a3f8f")

def S(w, h):
    return Image.new("RGBA", (w, h), (0, 0, 0, 0))

def px(img, x, y, c):
    if 0 <= x < img.width and 0 <= y < img.height:
        img.putpixel((x, y), c)

def rect(img, x0, y0, x1, y1, c):
    d = ImageDraw.Draw(img)
    d.rectangle([x0, y0, x1, y1], fill=c)

def hline(img, x0, x1, y, c):
    for x in range(x0, x1 + 1):
        px(img, x, y, c)

def vline(img, x, y0, y1, c):
    for y in range(y0, y1 + 1):
        px(img, x, y, c)

def outline(img, c=OUT):
    """1px outline around every opaque region (drawn onto transparent neighbours)."""
    src = img.copy()
    for y in range(img.height):
        for x in range(img.width):
            if src.getpixel((x, y))[3] == 0:
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < img.width and 0 <= ny < img.height and src.getpixel((nx, ny))[3] > 0:
                        px(img, x, y, c)
                        break
    return img

def sheet(frames):
    """Horizontal 2-frame sheet."""
    w, h = frames[0].width, frames[0].height
    s = S(w * len(frames), h)
    for i, f in enumerate(frames):
        s.paste(f, (i * w, 0))
    return s

def bob(frame, dy=1):
    """DawnLike idle frame 2: body shifts down 1px, feet stay (crop+repaste)."""
    f = S(frame.width, frame.height)
    body = frame.crop((0, 0, frame.width, frame.height - 1))
    f.paste(body, (0, dy))
    # keep the original bottom row (feet) so the ground contact doesn't slide
    feet = frame.crop((0, frame.height - 1, frame.width, frame.height))
    f.paste(feet, (0, frame.height - 1), feet)
    return f

ASSETS = []  # dicts: {tag, kind, frames:[Image], footW, footH, blocks, light, walkable, desc, biomes, category}

def register(tag, kind, frames, desc, biomes, category, footW=1, footH=1, blocks=True, light=False, walkable=None, fps=3):
    ASSETS.append(dict(tag=tag, kind=kind, frames=frames, footW=footW, footH=footH, blocks=blocks,
                       light=light, walkable=walkable, desc=desc, biomes=biomes, category=category, fps=fps))

# =================================================================================================
# EXEMPLAR 1 (quality bar, prop): the GREAT BRONZE BELL — 32x32, the drowned-bell campaign's finale.
# =================================================================================================
def draw_bell_great():
    img = S(32, 32)
    # crown loop
    rect(img, 14, 2, 17, 4, BRONZE_D)
    rect(img, 15, 3, 16, 3, BRONZE)
    # the bell body: a flared profile, banded
    profile = [(13, 18), (12, 19), (11, 20), (11, 20), (10, 21), (10, 21), (9, 22), (9, 22), (8, 23), (8, 23), (8, 23), (7, 24), (7, 24), (6, 25), (5, 26), (4, 27)]
    for i, (x0, x1) in enumerate(profile):
        y = 5 + i
        hline(img, x0, x1, y, BRONZE)
        # left highlight + right shade for the round body
        px(img, x0, y, ORANGE)
        px(img, x0 + 1, y, ORANGE if i < 10 else BRONZE)
        px(img, x1, y, BRONZE_D)
        px(img, x1 - 1, y, BRONZE_D)
    # bands
    for y in (9, 15, 19):
        x0, x1 = profile[y - 5]
        hline(img, x0, x1, y, BRONZE_D)
        px(img, x0, y, BRONZE)
    # the lip (bottom rim) — heavier
    hline(img, 4, 27, 21, BRONZE_D)
    hline(img, 3, 28, 22, BRONZE_D)
    hline(img, 3, 28, 23, OUT)
    # green corrosion streaks (it drowned for fifty years)
    for x, y0, y1 in ((7, 11, 16), (24, 8, 14), (16, 17, 21)):
        vline(img, x, y0, y1, GREEN_D)
    # the clapper peeking under the lip
    rect(img, 15, 24, 16, 26, SLATE)
    px(img, 15, 27, GREY)
    return outline(img)

register("bell_great", "prop", [draw_bell_great()],
         "the great bronze bell — corroded, banded, big enough to seal a man inside",
         ["crypt", "dungeon", "village"], "campaign", footW=2, footH=1, blocks=True)

# =================================================================================================
# EXEMPLAR 2 (quality bar, animated light prop): a standing LAMP POST with a flickering pane.
# =================================================================================================
def draw_lamp_post(flicker=False):
    img = S(16, 28)
    # post
    vline(img, 7, 8, 25, SLATE)
    vline(img, 8, 8, 25, GREY)
    # base
    rect(img, 5, 26, 10, 27, SLATE)
    # crossarm + housing
    rect(img, 5, 3, 10, 8, SLATE)
    rect(img, 6, 4, 9, 7, YELLOW if not flicker else ORANGE)
    px(img, 7, 2, SLATE)
    px(img, 8, 2, SLATE)
    # glow speck
    px(img, 7 if not flicker else 8, 5, WHITE)
    return outline(img)

register("lamp_post", "prop", [draw_lamp_post(False), draw_lamp_post(True)],
         "a standing iron lamp post, lit", ["town", "village", "port"], "campaign",
         blocks=False, light=True)

# --- AGENT SECTIONS ARE CONCATENATED BELOW THIS LINE ---------------------------------------------
# FORGE_SECTIONS
# ===== section: 0-campaign.py (11 assets) =====
# =================================================================================================
# CAMPAIGN KIT — the drowned-bell campaign's flagged gaps + nautical dressing
# =================================================================================================

def draw_weir():
    img = S(48, 16)
    rect(img, 3, 9, 44, 14, GREY)                     # stone strip
    hline(img, 3, 44, 9, GREY_L)                      # lit top course
    for i, x in enumerate(range(6, 43, 4)):           # stacked-stone joints
        vline(img, x + (i % 2), 10, 11 + (i % 2), SLATE)
    hline(img, 3, 44, 12, SLATE)                      # course line
    for x in range(5, 44, 7):                         # texture flecks
        px(img, x, 10, GREY_L)
        px(img, x + 3, 13, SLATE)
    for x in range(3, 45, 2):                         # downstream foam
        px(img, x, 14, WHITE)
        if x % 6 == 3:
            px(img, x, 13, WHITE)
    for xp in (2, 44):                                # timber posts
        rect(img, xp, 4, xp + 1, 14, BROWN)
        px(img, xp, 4, TAN)
        vline(img, xp + 1, 10, 13, PLUM)
    return outline(img)

register("weir", "prop", [draw_weir()],
         "a low stone weir combing the river into a white sill of foam",
         ["river", "reservoir", "fen"], "campaign", footW=3, footH=1, blocks=True)

def draw_iron_ring():
    img = S(16, 16)
    rect(img, 3, 9, 12, 14, GREY)                     # stone block
    hline(img, 3, 12, 9, GREY_L)
    px(img, 3, 10, GREY_L)
    px(img, 5, 12, SLATE); px(img, 10, 11, SLATE); px(img, 11, 13, SLATE)
    hline(img, 4, 12, 14, SLATE)
    vline(img, 12, 10, 13, SLATE)
    rect(img, 6, 9, 9, 10, SLATE)                     # bolt plate
    px(img, 6, 9, GREY_L); px(img, 9, 10, PLUM)
    hline(img, 6, 9, 3, SLATE)                        # the ring
    vline(img, 5, 4, 7, SLATE)
    vline(img, 10, 4, 7, SLATE)
    hline(img, 6, 9, 8, SLATE)
    px(img, 6, 3, GREY_L); px(img, 5, 4, GREY_L)      # glint
    px(img, 10, 7, PLUM)
    return outline(img)

register("iron_ring", "prop", [draw_iron_ring()],
         "a heavy iron mooring ring bolted through a worn stone block",
         ["port", "dock"], "campaign", blocks=False)

def draw_bell_clapper():
    img = S(16, 16)
    rect(img, 3, 11, 9, 12, SLATE)                    # shaft lying flat
    hline(img, 3, 9, 11, GREY)
    for cx, cy in ((2, 9), (1, 10), (1, 11), (2, 13)):
        px(img, cx, cy, SLATE)                        # broken hanger loop
    for y, (x0, x1) in ((8, (10, 12)), (9, (9, 13)), (10, (9, 14)), (11, (9, 14)), (12, (9, 14)), (13, (10, 13))):
        hline(img, x0, x1, y, GREY)                   # teardrop head
    px(img, 10, 8, GREY_L); px(img, 9, 9, GREY_L); px(img, 10, 9, GREY_L)
    vline(img, 14, 10, 12, SLATE)                     # shaded flank
    hline(img, 10, 13, 13, SLATE)
    px(img, 13, 12, SLATE)
    px(img, 5, 11, BLOOD_D); px(img, 7, 12, BLOOD_D); px(img, 12, 10, BLOOD_D)
    return outline(img)

register("bell_clapper", "prop", [draw_bell_clapper()],
         "the great bell's iron clapper, torn loose and left to rust",
         ["crypt", "village"], "campaign", blocks=False)

def draw_tomb_door():
    img = S(16, 24)
    rect(img, 2, 1, 13, 22, SLATE)                    # frame
    hline(img, 2, 13, 1, GREY)
    rect(img, 3, 3, 12, 21, GREY)                     # slab
    hline(img, 3, 12, 3, GREY_L)
    vline(img, 3, 3, 20, GREY_L)
    vline(img, 12, 4, 21, SLATE)
    hline(img, 4, 12, 21, SLATE)
    for i in range(10):                               # crossed iron bands
        y = 4 + (i * 16) // 9
        px(img, 3 + i, y, SLATE); px(img, 3 + i, y + 1, SLATE)
        px(img, 12 - i, y, SLATE); px(img, 12 - i, y + 1, SLATE)
    rect(img, 6, 11, 9, 12, RED)                      # wax seal disc
    rect(img, 7, 10, 8, 13, RED)
    px(img, 7, 10, ORANGE)
    px(img, 7, 11, OUT); px(img, 8, 12, OUT)          # the sigil
    for cx, cy in ((4, 6), (5, 7), (5, 8), (10, 17), (11, 18), (10, 19)):
        px(img, cx, cy, SLATE)                        # hairline cracks
    return outline(img)

register("tomb_door", "prop", [draw_tomb_door()],
         "a sealed tomb slab, iron-banded, its wax seal unbroken",
         ["crypt", "dungeon"], "campaign", blocks=True)

def draw_net_drying():
    img = S(32, 24)
    hline(img, 4, 27, 4, TAN)                         # head rope
    for y in range(5, 19):                            # diamond lattice
        for x in range(6, 26):
            if (x + y) % 4 == 0 or (x - y) % 4 == 0:
                px(img, x, y, TAN)
    for wx, wy in ((9, 9), (17, 14), (22, 7)):        # weed clumps
        rect(img, wx, wy, wx + 1, wy + 1, GREEN_D)
        px(img, wx, wy, GREEN)
    for xp in (3, 27):                                # timber posts
        rect(img, xp, 3, xp + 1, 22, BROWN)
        px(img, xp, 3, TAN)
        vline(img, xp + 1, 14, 21, PLUM)
    return outline(img)

register("net_drying", "prop", [draw_net_drying()],
         "a fishing net strung between posts to dry, weed still caught in it",
         ["port", "village"], "campaign", footW=2, blocks=True)

def draw_anchor():
    img = S(16, 16)
    rect(img, 6, 2, 9, 4, SLATE)                      # ring
    px(img, 7, 3, OUT); px(img, 8, 3, OUT)
    px(img, 6, 2, GREY_L)
    vline(img, 7, 5, 12, SLATE)                       # shank
    vline(img, 8, 5, 12, SLATE)
    vline(img, 7, 5, 10, GREY_L)
    hline(img, 4, 11, 6, SLATE)                       # stock
    px(img, 4, 6, GREY_L)
    hline(img, 4, 11, 14, SLATE)                      # arm curve
    px(img, 3, 13, SLATE); px(img, 12, 13, SLATE)
    px(img, 2, 12, SLATE); px(img, 13, 12, SLATE)
    px(img, 2, 11, GREY_L); px(img, 13, 11, GREY_L)   # fluke tips
    px(img, 3, 12, GREY_L)
    for rx, ry in ((10, 2), (11, 3), (12, 3), (13, 4), (13, 5), (12, 6)):
        px(img, rx, ry, TAN)                          # rope through the ring
    return outline(img)

register("anchor", "prop", [draw_anchor()],
         "a ship's anchor stood on its flukes, rope still bent to the ring",
         ["port", "dock"], "campaign", blocks=False)

def draw_buoy():
    img = S(16, 18)
    rect(img, 7, 2, 8, 5, BROWN)                      # mast nub
    px(img, 7, 2, TAN)
    prof = [(6, 9), (5, 10), (4, 11), (3, 12), (3, 12), (3, 12), (3, 12), (4, 11), (5, 10), (6, 9)]
    for i, (x0, x1) in enumerate(prof):
        y = 6 + i
        c = RED if i < 4 else WHITE if i < 6 else BRONZE_D
        hline(img, x0, x1, y, c)
        px(img, x1, y, GREY_L if c == WHITE else PLUM)
        if c == BRONZE_D:
            px(img, x0 + 1, y, BRONZE)
    px(img, 5, 7, WHITE)                              # glint
    px(img, 7, 13, BRONZE); px(img, 9, 14, BRONZE)    # weathering
    return outline(img)

register("buoy", "prop", [draw_buoy()],
         "a weathered channel buoy riding low at the waterline",
         ["reservoir", "port"], "campaign", blocks=False)

def draw_well():
    img = S(16, 20)
    rect(img, 2, 2, 13, 3, BROWN)                     # crossbeam
    px(img, 3, 2, TAN); px(img, 9, 2, TAN); px(img, 13, 3, PLUM)
    vline(img, 3, 4, 12, BROWN)                       # uprights
    vline(img, 12, 4, 12, BROWN)
    px(img, 3, 5, TAN); px(img, 12, 8, PLUM)
    vline(img, 7, 4, 10, TAN)                         # rope
    rect(img, 6, 11, 9, 12, BROWN)                    # bucket
    px(img, 6, 11, TAN); px(img, 9, 12, PLUM)
    for y, (x0, x1) in zip(range(13, 19), ((3, 12), (2, 13), (2, 13), (2, 13), (2, 13), (3, 12))):
        hline(img, x0, x1, y, GREY)                   # round stone ring
    hline(img, 4, 11, 13, GREY_L)
    hline(img, 5, 10, 14, PLUM)                       # dark mouth
    px(img, 2, 14, GREY_L); px(img, 2, 15, GREY_L)
    for x in (5, 8, 11):
        px(img, x, 16, SLATE)                         # mortar joints
    for x in (4, 7, 10):
        px(img, x, 17, SLATE)
    hline(img, 3, 12, 18, SLATE)
    return outline(img)

register("well", "prop", [draw_well()],
         "a village well — stone ring, crossbeam, and a waiting bucket",
         ["village", "town"], "campaign", blocks=True)

def draw_rope_ladder():
    img = S(16, 32)
    for y in range(1, 31):                            # swaying rope rails
        o = (max(y - 3, 0) // 4) % 2
        px(img, 4 + o, y, BROWN if y % 4 == 0 else TAN)
        px(img, 11 + o, y, BROWN if y % 3 == 0 else TAN)
    for i, y in enumerate(range(3, 31, 4)):           # rungs, offset alternately
        o = i % 2
        hline(img, 5 + o, 10 + o, y, BROWN)
        px(img, 5 + o, y, TAN)
        px(img, 10 + o, y, PLUM)
    return outline(img)

register("rope_ladder", "prop", [draw_rope_ladder()],
         "a rope ladder swaying against the trunk, rungs worn smooth",
         ["wild", "treehouse"], "campaign", blocks=False)

# ===== section: 1-dungeon.py (16 assets) =====
# =================================================================================================
# DUNGEON & CRYPT FURNITURE — pillars, traps, coffins, ritual gear
# =================================================================================================
def draw_pillar():
    img = S(16, 28)
    # square capital
    hline(img, 3, 12, 2, GREY_L)
    hline(img, 3, 12, 3, GREY)
    hline(img, 4, 11, 4, SLATE)
    # fluted shaft: light ridge / mid / groove, repeated
    for y in range(5, 23):
        px(img, 5, y, GREY_L)
        px(img, 6, y, GREY)
        px(img, 7, y, SLATE)
        px(img, 8, y, GREY_L)
        px(img, 9, y, GREY)
        px(img, 10, y, SLATE)
    for fx, fy in ((6, 9), (9, 14), (6, 19), (9, 7), (8, 12)):
        px(img, fx, fy, SLATE)
    # base plinth
    hline(img, 4, 11, 23, GREY_L)
    rect(img, 3, 24, 12, 25, GREY)
    px(img, 3, 24, GREY_L)
    hline(img, 3, 12, 26, SLATE)
    return outline(img)

register("pillar", "prop", [draw_pillar()],
         "a fluted stone column holding up the dark", ["dungeon", "crypt", "temple"], "dungeon",
         blocks=True)

def draw_pillar_broken():
    img = S(16, 18)
    # snapped shaft: jagged zigzag top per column
    for x, c, t in ((5, GREY_L, 4), (6, GREY, 2), (7, SLATE, 5), (8, GREY_L, 3), (9, GREY, 6), (10, SLATE, 4)):
        vline(img, x, t, 12, c)
        px(img, x, t, SLATE if c != SLATE else GREY)
    for fx, fy in ((6, 7), (9, 10), (8, 8)):
        px(img, fx, fy, SLATE)
    # base plinth + rubble chips
    hline(img, 4, 11, 13, GREY_L)
    rect(img, 3, 14, 12, 15, GREY)
    hline(img, 3, 12, 16, SLATE)
    px(img, 2, 16, GREY_L)
    px(img, 13, 16, SLATE)
    px(img, 1, 15, GREY)
    return outline(img)

register("pillar_broken", "prop", [draw_pillar_broken()],
         "the column snapped at a man's height — rubble where the rest fell", ["dungeon", "crypt"],
         "dungeon", blocks=True)

def draw_lever():
    img = S(16, 16)
    # stone base block
    rect(img, 4, 11, 11, 13, GREY)
    hline(img, 4, 11, 11, GREY_L)
    hline(img, 4, 11, 13, SLATE)
    px(img, 6, 12, SLATE)
    px(img, 9, 12, GREY_L)
    # pivot bracket + arm angled up-right
    hline(img, 7, 8, 10, SLATE)
    for ax, ay in ((8, 9), (9, 8), (9, 7), (10, 6), (10, 5)):
        px(img, ax, ay, SLATE)
    px(img, 9, 8, GREY_L)
    # red knob
    rect(img, 11, 3, 12, 4, RED)
    px(img, 12, 4, BLOOD)
    return outline(img)

register("lever", "prop", [draw_lever()],
         "a floor lever nobody remembers the purpose of", ["dungeon", "crypt"], "dungeon",
         blocks=False)

def draw_portcullis():
    img = S(16, 24)
    # iron verticals every 3px, spiked at the foot
    for x in (1, 4, 7, 10, 13):
        vline(img, x, 1, 20, SLATE)
        px(img, x, 21, GREY_L)
        px(img, x, 4, GREY)
    # three crossbars + rivets
    for y in (2, 10, 18):
        hline(img, 1, 13, y, SLATE)
        for x in (1, 4, 7, 10, 13):
            px(img, x, y, GREY_L)
    for fx, fy in ((4, 7), (10, 14), (7, 12)):
        px(img, fx, fy, GREY)
    return outline(img)

register("portcullis", "prop", [draw_portcullis()],
         "an iron grid gate, points hungry for the floor", ["dungeon", "crypt"], "dungeon",
         blocks=True)

def draw_chains_wall():
    img = S(16, 16)
    # mounting bar
    hline(img, 1, 14, 1, SLATE)
    px(img, 2, 1, GREY_L)
    px(img, 13, 1, GREY_L)
    # left chain, full drop
    for y in range(2, 13):
        px(img, 4, y, SLATE)
        if y % 2 == 0:
            px(img, 5, y, GREY_L)
    # right chain, snapped short
    for y in range(2, 9):
        px(img, 10, y, SLATE)
        if y % 2 == 1:
            px(img, 11, y, GREY_L)
    # broken shackle swinging open at its end
    for dx, dy in ((-1, 1), (-2, 2), (-2, 3), (-1, 4), (1, 1), (2, 2)):
        px(img, 10 + dx, 8 + dy, SLATE)
    px(img, 8, 10, GREY_L)
    return outline(img)

register("chains_wall", "prop", [draw_chains_wall()],
         "hanging chains — one shackle empty, one broken", ["dungeon", "crypt"], "dungeon",
         blocks=False)

def draw_shackles():
    img = S(16, 12)
    # two open rings lying on the ground (gap = the opening)
    ring = ((0, 1), (0, 2), (1, 3), (2, 3), (3, 2), (3, 1), (2, 0))
    for dx, dy in ring:
        px(img, 2 + dx, 6 + dy, SLATE)
        px(img, 10 + dx, 5 + dy, SLATE)
    px(img, 2, 7, GREY_L)
    px(img, 12, 6, GREY_L)
    # short connecting chain
    for cx, cy in ((6, 8), (7, 7), (8, 8), (9, 7)):
        px(img, cx, cy, SLATE)
    px(img, 7, 7, GREY_L)
    return outline(img)

register("shackles", "prop", [draw_shackles()],
         "a pair of shackles, opened or slipped", ["dungeon", "crypt"], "dungeon", blocks=False)

def draw_spike_trap():
    img = S(16, 16)
    # floor plate
    rect(img, 1, 1, 14, 14, GREY)
    hline(img, 1, 14, 1, SLATE)
    hline(img, 1, 14, 14, SLATE)
    vline(img, 1, 1, 14, SLATE)
    vline(img, 14, 1, 14, SLATE)
    hline(img, 2, 13, 2, GREY_L)
    vline(img, 2, 2, 13, GREY_L)
    for fx, fy in ((6, 12), (12, 8), (3, 6), (9, 13)):
        px(img, fx, fy, SLATE)
    # five squat pyramid spikes in a quincunx
    for sx, sy in ((4, 4), (10, 4), (7, 7), (4, 10), (10, 10)):
        px(img, sx, sy, WHITE)
        hline(img, sx - 1, sx + 1, sy + 1, GREY_L)
        px(img, sx + 1, sy + 2, SLATE)
    # old blood on two tips
    px(img, 10, 4, BLOOD_D)
    px(img, 11, 5, BLOOD_D)
    px(img, 7, 7, BLOOD_D)
    px(img, 6, 8, BLOOD_D)
    return outline(img)

register("spike_trap", "prop", [draw_spike_trap()],
         "a floor plate of spikes — two are already stained", ["dungeon", "crypt"], "dungeon",
         blocks=False)

def coffin_prof():
    """Hexagonal coffin half-profile: (x0, x1) per row, y = 2 + i. Shared by both coffins."""
    return [(6, 9), (5, 10), (4, 11), (3, 12), (3, 12), (2, 13), (2, 13), (3, 12), (3, 12), (3, 12),
            (4, 11), (4, 11), (4, 11), (4, 11), (5, 10), (5, 10), (5, 10), (5, 10), (5, 10), (5, 10)]

def draw_coffin_wood():
    img = S(16, 24)
    for i, (x0, x1) in enumerate(coffin_prof()):
        y = 2 + i
        hline(img, x0, x1, y, BROWN)
        px(img, x0, y, TAN)
        px(img, x1, y, BRONZE_D)
    # lid seams
    vline(img, 8, 3, 20, BRONZE_D)
    hline(img, 3, 12, 8, BRONZE_D)
    # nails
    for nx, ny in ((4, 9), (11, 9), (6, 20), (10, 20), (7, 3)):
        px(img, nx, ny, BRONZE_D)
    # grain
    px(img, 5, 13, PLUM)
    px(img, 10, 16, PLUM)
    px(img, 6, 6, PLUM)
    return outline(img)

register("coffin_wood", "prop", [draw_coffin_wood()],
         "a hexagonal pine coffin, nailed shut", ["dungeon", "crypt"], "dungeon", blocks=True)

def draw_coffin_open():
    img = S(16, 24)
    for i, (x0, x1) in enumerate(coffin_prof()):
        y = 2 + i
        if i in (0, 19):
            hline(img, x0, x1, y, BROWN)
            px(img, x1, y, BRONZE_D)
            continue
        # dark interior, lid shoved to the right side
        hline(img, x0 + 1, x1 - 3, y, PLUM)
        px(img, x0, y, BROWN)
        px(img, x1 - 3, y, OUT)
        hline(img, x1 - 2, x1, y, BROWN)
        px(img, x1 - 2, y, TAN)
        px(img, x1, y, BRONZE_D)
    # the occupant
    rect(img, 5, 5, 7, 7, BONE)
    px(img, 5, 5, WHITE)
    px(img, 5, 6, OUT)
    px(img, 7, 6, OUT)
    hline(img, 5, 7, 8, BONE_D)
    px(img, 6, 11, BONE_D)
    px(img, 6, 13, BONE_D)
    return outline(img)

register("coffin_open", "prop", [draw_coffin_open()],
         "the same coffin, lid ajar — someone is still home", ["dungeon", "crypt"], "dungeon",
         blocks=True)

def draw_ritual_circle():
    img = S(32, 32)
    d = ImageDraw.Draw(img)
    # chalk double circle in old blood
    d.ellipse([2, 2, 29, 29], outline=BLOOD)
    d.ellipse([5, 5, 26, 26], outline=BLOOD)
    # pentagram on the inner ring
    pts = ((15, 5), (25, 12), (22, 24), (9, 24), (5, 12))
    order = (0, 2, 4, 1, 3, 0)
    for a, b in zip(order, order[1:]):
        d.line([pts[a], pts[b]], fill=BLOOD)
    # arcane marks between the rings
    for mx, my in ((27, 15), (3, 15), (11, 3), (20, 3), (24, 25), (11, 28), (20, 28), (4, 20)):
        px(img, mx, my, BLOOD_D)
    # candle stubs at the five points
    for cx, cy in pts:
        px(img, cx, cy, OUT)
        px(img, cx, cy - 1, OUT)
        px(img, cx, cy - 2, YELLOW)
    return outline(img)

register("ritual_circle", "prop", [draw_ritual_circle()],
         "a chalk-and-blood summoning circle, candles still warm", ["dungeon", "crypt"], "dungeon",
         footW=2, footH=2, blocks=False)

def draw_crystal_glow(alt=False):
    img = S(16, 18)
    # base rock
    rect(img, 2, 13, 13, 15, NAVY)
    hline(img, 3, 12, 16, PLUM)
    px(img, 4, 14, PLUM)
    px(img, 10, 13, SLATE)
    # tall center shard
    vline(img, 7, 2, 13, CYAN)
    vline(img, 8, 3, 13, CYAN)
    vline(img, 6, 5, 13, CYAN)
    vline(img, 9, 5, 13, BLUE)
    # left + right shards
    vline(img, 4, 7, 13, CYAN)
    vline(img, 3, 9, 13, CYAN)
    vline(img, 5, 8, 13, BLUE)
    vline(img, 11, 8, 13, CYAN)
    vline(img, 12, 9, 13, BLUE)
    # the glint wanders between frames
    if alt:
        px(img, 8, 6, WHITE)
        px(img, 3, 10, WHITE)
        px(img, 11, 11, WHITE)
    else:
        px(img, 7, 4, WHITE)
        px(img, 4, 9, WHITE)
        px(img, 12, 10, WHITE)
    return outline(img)

register("crystal_glow", "prop", [draw_crystal_glow(False), draw_crystal_glow(True)],
         "a cluster of cave crystals, lit from inside", ["dungeon", "crypt"], "dungeon",
         blocks=True, light=True)

def draw_rune_stone(lit=False):
    img = S(16, 18)
    prof = ((6, 9), (5, 10), (4, 11), (4, 11), (3, 11), (3, 12), (3, 12), (3, 12), (3, 12), (4, 12),
            (4, 12), (4, 12), (4, 12), (4, 12))
    for i, (x0, x1) in enumerate(prof):
        y = 2 + i
        hline(img, x0, x1, y, GREY)
        px(img, x0, y, GREY_L)
        px(img, x1, y, SLATE)
    hline(img, 3, 13, 16, SLATE)
    for fx, fy in ((6, 4), (10, 8), (5, 13), (10, 12)):
        px(img, fx, fy, SLATE)
    # the carved rune breathes light
    g = WHITE if lit else CYAN
    for rx, ry in ((8, 5), (7, 6), (8, 7), (7, 8), (8, 9), (7, 10)):
        px(img, rx, ry, g)
    return outline(img)

register("rune_stone", "prop", [draw_rune_stone(False), draw_rune_stone(True)],
         "a rough monolith whose rune pulses cold light", ["dungeon", "crypt"], "dungeon",
         blocks=True, light=True)

def draw_iron_maiden():
    img = S(16, 24)
    prof = [(6, 9), (4, 11), (3, 12)] + [(2, 13)] * 17
    for i, (x0, x1) in enumerate(prof):
        y = 2 + i
        hline(img, x0, x1, y, SLATE)
        px(img, x0, y, GREY)
        px(img, x1, y, PLUM)
        px(img, x1 - 1, y, PLUM)
    # face plate with two eye slits
    rect(img, 5, 5, 10, 11, GREY_L)
    vline(img, 10, 5, 11, GREY)
    hline(img, 5, 10, 11, GREY)
    px(img, 6, 7, OUT)
    px(img, 9, 7, OUT)
    hline(img, 7, 8, 9, GREY)
    # door seam, spikes hinted behind it
    vline(img, 12, 6, 19, OUT)
    for sy in (7, 10, 13, 16):
        px(img, 11, sy, GREY_L)
    for ry in (6, 12, 18):
        px(img, 3, ry, GREY_L)
    # what leaks out at the foot
    vline(img, 7, 18, 21, BLOOD_D)
    px(img, 6, 21, BLOOD_D)
    px(img, 8, 21, BLOOD_D)
    return outline(img)

register("iron_maiden", "prop", [draw_iron_maiden()],
         "an upright iron case shaped like a person — it drips", ["dungeon", "crypt"], "dungeon",
         blocks=True)

def draw_cauldron(alt=False):
    img = S(16, 16)
    # rim, lit from the left
    hline(img, 3, 12, 3, SLATE)
    hline(img, 3, 7, 3, GREY_L)
    # bubbling green surface
    hline(img, 4, 11, 4, GREEN)
    px(img, 10, 4, GREEN_D)
    px(img, 11, 4, GREEN_D)
    # black belly
    prof = ((3, 12), (2, 13), (2, 13), (2, 13), (2, 13), (3, 12), (4, 11))
    for i, (x0, x1) in enumerate(prof):
        y = 5 + i
        hline(img, x0, x1, y, OUT)
        px(img, x0, y, SLATE)
        px(img, x0 + 1, y, SLATE)
    px(img, 3, 6, GREY_L)
    px(img, 5, 8, SLATE)
    px(img, 6, 10, SLATE)
    # three legs
    for lx in (4, 8, 11):
        vline(img, lx, 12, 13, OUT)
    px(img, 4, 13, SLATE)
    # bubbles crawl and pop
    if alt:
        px(img, 5, 4, WHITE)
        px(img, 9, 4, WHITE)
        px(img, 8, 2, GREEN)
    else:
        px(img, 6, 4, WHITE)
        px(img, 10, 4, WHITE)
        px(img, 7, 2, GREEN)
    return outline(img)

register("cauldron", "prop", [draw_cauldron(False), draw_cauldron(True)],
         "a witch's cauldron at a slow green boil", ["dungeon", "crypt"], "dungeon", blocks=True)

# ===== section: 2-haunt.py (10 assets) =====
# =================================================================================================
# HAUNT — the undead house / abandoned interior kit
# =================================================================================================
def draw_table_broken():
    img = S(16, 14)
    # tabletop sloping down to the snapped end (left high, right collapsed)
    for i in range(13):
        x = 1 + i
        y = 3 + i // 3
        px(img, x, y, TAN)
        px(img, x, y + 1, BROWN)
        px(img, x, y + 2, PLUM if i % 5 == 2 else BROWN)
    # ragged snapped edge at the right end
    px(img, 14, 9, TAN)
    px(img, 14, 10, BROWN)
    # intact left leg
    rect(img, 2, 6, 3, 12, BROWN)
    vline(img, 2, 6, 12, TAN)
    px(img, 3, 12, PLUM)
    # snapped right leg stub under the fallen edge
    rect(img, 11, 9, 12, 11, BROWN)
    px(img, 11, 9, TAN)
    # the broken-off leg lying on the floor + splinters
    hline(img, 6, 9, 12, BROWN)
    px(img, 6, 12, TAN)
    px(img, 10, 11, TAN)
    px(img, 13, 12, TAN)
    return outline(img)

register("table_broken", "prop", [draw_table_broken()],
         "a wooden table collapsed at one end, leg snapped to splinters",
         ["interior", "crypt", "manor"], "haunt", blocks=True)

def draw_chair_broken():
    img = S(16, 14)
    # tipped on its side: the seat plank stands upright in the middle
    rect(img, 7, 4, 9, 12, BROWN)
    vline(img, 7, 4, 12, TAN)
    vline(img, 9, 5, 12, PLUM)
    # backrest rails pointing left, bottom one on the floor
    hline(img, 2, 6, 6, BROWN)
    px(img, 2, 6, TAN)
    hline(img, 2, 6, 9, BROWN)
    px(img, 2, 9, TAN)
    hline(img, 2, 6, 12, BROWN)
    px(img, 2, 12, PLUM)
    # legs pointing right — one intact, one snapped to a stub
    hline(img, 10, 14, 6, BROWN)
    px(img, 14, 6, TAN)
    hline(img, 10, 11, 11, BROWN)
    px(img, 12, 11, TAN)
    px(img, 12, 12, TAN)
    # grain flecks
    px(img, 8, 7, PLUM)
    px(img, 8, 10, PLUM)
    return outline(img)

register("chair_broken", "prop", [draw_chair_broken()],
         "a chair tipped on its side, one leg gone",
         ["interior", "crypt", "manor"], "haunt", blocks=False)

def draw_furniture_shrouded():
    img = S(16, 18)
    # dust sheet over a tall-backed chair: high shoulder left, low arm right
    tops = [6, 4, 3, 3, 3, 3, 4, 5, 7, 7, 7, 7, 8, 10]
    for i, top in enumerate(tops):
        vline(img, 1 + i, top, 16, GREY_L)
    # crown highlight (light from top-left)
    for x in range(2, 7):
        px(img, x, tops[x - 1], WHITE)
    px(img, 3, 4, WHITE)
    px(img, 8, 7, WHITE)
    px(img, 9, 7, WHITE)
    # fold lines cascading to the hem
    vline(img, 4, 6, 15, GREY)
    vline(img, 7, 6, 15, GREY)
    vline(img, 10, 9, 15, GREY)
    vline(img, 12, 10, 15, GREY)
    # shadowed right flank
    vline(img, 13, 9, 15, GREY)
    px(img, 14, 11, GREY)
    # rippled hem touching the floor
    hline(img, 1, 14, 16, GREY)
    for x in (3, 6, 9, 12):
        px(img, x, 16, GREY_L)
    return outline(img)

register("furniture_shrouded", "prop", [draw_furniture_shrouded()],
         "furniture under a dust sheet, waiting like a ghost",
         ["interior", "crypt", "manor"], "haunt", blocks=True)

def draw_mirror_standing():
    img = S(16, 24)
    # oval frame, row profile
    prof = [(6, 9), (4, 11), (3, 12), (2, 13), (2, 13), (2, 13), (2, 13), (2, 13),
            (2, 13), (2, 13), (2, 13), (2, 13), (3, 12), (4, 11), (6, 9)]
    for i, (x0, x1) in enumerate(prof):
        y = 2 + i
        hline(img, x0, x1, y, BRONZE_D)
        px(img, x0, y, BRONZE)
    # glass inset 1px
    for i, (x0, x1) in enumerate(prof[2:-2]):
        hline(img, x0 + 1, x1 - 1, 4 + i, NAVY)
    # cold sheen top-left
    hline(img, 4, 7, 5, CYAN)
    hline(img, 4, 5, 6, CYAN)
    px(img, 4, 7, CYAN)
    # the diagonal crack
    for i in range(7):
        px(img, 4 + i, 7 + i, WHITE)
    px(img, 8, 10, WHITE)
    # stand column, crossfoot, claw feet
    rect(img, 7, 17, 8, 20, BRONZE_D)
    vline(img, 7, 17, 20, BRONZE)
    hline(img, 4, 11, 21, BRONZE_D)
    px(img, 4, 21, BRONZE)
    px(img, 3, 22, BRONZE_D)
    px(img, 4, 22, BRONZE)
    px(img, 11, 22, BRONZE)
    px(img, 12, 22, BRONZE_D)
    return outline(img)

register("mirror_standing", "prop", [draw_mirror_standing()],
         "an oval standing mirror, cracked corner to corner",
         ["interior", "crypt", "manor"], "haunt", blocks=True)

def draw_clock_grandfather():
    img = S(16, 28)
    # crown
    rect(img, 3, 1, 12, 2, BROWN)
    hline(img, 3, 12, 1, TAN)
    # head housing + face
    rect(img, 3, 3, 12, 10, BROWN)
    vline(img, 12, 3, 10, PLUM)
    rect(img, 5, 4, 10, 9, TAN)
    px(img, 5, 4, WHITE)
    # hands stopped at midnight (both straight up) + pivot
    vline(img, 8, 5, 7, OUT)
    px(img, 7, 7, OUT)
    # body, shadowed right, light left edge
    rect(img, 4, 11, 11, 24, BROWN)
    vline(img, 11, 11, 24, PLUM)
    vline(img, 10, 12, 24, PLUM)
    vline(img, 4, 11, 24, TAN)
    # pendulum slit + still pendulum
    rect(img, 6, 13, 8, 22, PLUM)
    vline(img, 7, 14, 19, BRONZE)
    px(img, 7, 20, YELLOW)
    px(img, 7, 21, YELLOW)
    # wood grain flecks
    px(img, 5, 16, PLUM)
    px(img, 5, 21, PLUM)
    px(img, 9, 12, TAN)
    # base
    rect(img, 3, 25, 12, 26, BROWN)
    hline(img, 3, 12, 25, TAN)
    hline(img, 3, 12, 26, PLUM)
    return outline(img)

register("clock_grandfather", "prop", [draw_clock_grandfather()],
         "a grandfather clock stopped dead at midnight",
         ["interior", "crypt", "manor"], "haunt", blocks=True)

def draw_fireplace(flicker=False):
    img = S(16, 20)
    # mantel shelf
    rect(img, 1, 3, 14, 4, GREY_L)
    hline(img, 1, 14, 4, GREY)
    # stone body + firebox
    rect(img, 2, 5, 13, 18, GREY)
    rect(img, 4, 8, 11, 17, OUT)
    # stone texture: light top-left, dark mortar bottom-right
    for x, y in ((3, 6), (7, 6), (11, 7), (2, 9), (3, 12), (12, 9), (2, 15)):
        px(img, x, y, GREY_L)
    for x, y in ((5, 7), (10, 6), (13, 10), (3, 16), (12, 15), (13, 14)):
        px(img, x, y, SLATE)
    # flames
    a, b = (YELLOW, ORANGE) if not flicker else (ORANGE, YELLOW)
    rect(img, 5, 13, 10, 15, RED)
    rect(img, 6, 12, 9, 15, b)
    rect(img, 7, 11, 8, 14, a)
    px(img, 6, 11, b)
    px(img, 9, 12, b)
    px(img, 7 if not flicker else 8, 12, WHITE)
    # burning logs
    hline(img, 5, 10, 16, BROWN)
    hline(img, 4, 11, 17, BROWN)
    px(img, 5, 16, TAN)
    px(img, 10, 17, PLUM)
    # hearthstone
    hline(img, 2, 13, 18, SLATE)
    return outline(img)

register("fireplace", "prop", [draw_fireplace(False), draw_fireplace(True)],
         "a stone hearth, logs still burning for no one",
         ["interior", "crypt", "manor"], "haunt", blocks=True, light=True)

def draw_portrait_cracked():
    img = S(16, 16)
    # crooked frame: the right half sags 1px
    for x in range(2, 14):
        d = 0 if x < 8 else 1
        vline(img, x, 2 + d, 13 + d, PLUM)
        px(img, x, 2 + d, BRONZE)
        px(img, x, 13 + d, BRONZE_D)
    vline(img, 2, 2, 13, BRONZE)
    vline(img, 13, 3, 14, BRONZE_D)
    # the sitter: pale face, dark eyes, shoulders
    rect(img, 6, 4, 9, 9, TAN)
    px(img, 6, 4, WHITE)
    px(img, 7, 4, WHITE)
    px(img, 7, 6, OUT)
    px(img, 9, 6, OUT)
    hline(img, 5, 10, 10, SLATE)
    hline(img, 4, 11, 11, SLATE)
    # the diagonal tear
    for i in range(9):
        px(img, 4 + i, 4 + i, OUT)
    return outline(img)

register("portrait_cracked", "prop", [draw_portrait_cracked()],
         "a torn portrait hanging crooked; the sitter still watches",
         ["interior", "crypt", "manor"], "haunt", blocks=False)

def draw_wine_rack():
    img = S(16, 20)
    # frame, lit left/top, shadowed right/bottom
    rect(img, 2, 2, 13, 17, BROWN)
    hline(img, 2, 13, 2, TAN)
    vline(img, 2, 3, 17, TAN)
    vline(img, 13, 3, 17, PLUM)
    hline(img, 3, 12, 17, PLUM)
    # shelf rails
    for y in (7, 12):
        hline(img, 3, 12, y - 1, TAN)
        hline(img, 3, 12, y, PLUM)
    # bottle ends in their cells; two slots stand empty
    for cy in (4, 9, 14):
        for cx in (4, 7, 10):
            if (cx, cy) in ((7, 9), (4, 14)):
                rect(img, cx, cy, cx + 1, cy + 1, OUT)
            else:
                rect(img, cx, cy, cx + 1, cy + 1, GREEN_D)
                px(img, cx + 1, cy + 1, PLUM)
    return outline(img)

register("wine_rack", "prop", [draw_wine_rack()],
         "a dusty wine rack, two bottles unaccounted for",
         ["interior", "crypt", "manor"], "haunt", blocks=True)

# ===== section: 3-nature.py (17 assets) =====
# ---- NATURE: hedge labyrinth family, flooded floors, wilderness props ---------------------------
def _hedge_base():
    img = S(16, 16)
    rect(img, 0, 0, 15, 15, GREEN_DD)
    for cx, cy in ((1, 1), (6, 2), (11, 1), (3, 5), (9, 5), (13, 4), (1, 8), (6, 9), (12, 8), (4, 12), (10, 12), (14, 11)):
        rect(img, cx, cy, cx + 1, cy + 1, GREEN_D)
    for cx, cy in ((2, 3), (8, 1), (12, 5), (5, 7), (10, 9), (2, 10)):
        rect(img, cx, cy, cx + 1, cy + 1, GREEN)
    for fx, fy in ((4, 2), (13, 3), (7, 7), (1, 11)):
        px(img, fx, fy, WHITE)
    for fx in (2, 7, 12):
        px(img, fx, 14, OUT)
    return img

def draw_hedge(edges=""):
    img = _hedge_base()
    if "t" in edges:
        hline(img, 0, 15, 0, GREEN_DD)
        for y in (1, 2):
            hline(img, 0, 15, y, GREEN)
        for x in (1, 5, 9, 13):
            px(img, x, 2, GREEN_D)
        for x in (3, 8, 12):
            px(img, x, 1, WHITE)
        for x in (2, 7, 12):
            px(img, x, 0, GREEN_D)
    if "b" in edges:
        for y in (13, 14, 15):
            hline(img, 0, 15, y, GREEN_DD)
        for x in (1, 4, 8, 11, 14):
            vline(img, x, 14, 15, OUT)
        for x in (2, 6, 10, 13):
            px(img, x, 13, GREEN_D)
    if "l" in edges:
        for x in (0, 1, 2):
            vline(img, x, 0, 15, GREEN)
        for y in (2, 6, 10, 14):
            px(img, 2, y, GREEN_D)
        for y in (3, 9, 13):
            px(img, 1, y, WHITE)
        for y in (0, 4, 8, 12, 15):
            px(img, 0, y, GREEN_D)
    if "r" in edges:
        for x in (13, 14, 15):
            vline(img, x, 0, 15, GREEN_DD)
        for y in (1, 4, 8, 12):
            px(img, 13, y, GREEN_D)
        for y in (2, 6, 10, 14):
            px(img, 15, y, OUT)
    if len(edges) == 2:
        cx = 0 if "l" in edges else 14
        cy = 0 if "t" in edges else 14
        rect(img, cx, cy, cx + 1, cy + 1, GREEN_DD)
        px(img, cx if "l" in edges else 15, cy if "t" in edges else 15, OUT)
    return img

for _e in ("", "t", "b", "l", "r", "tl", "tr", "bl", "br"):
    register("hedge" + (("_" + _e) if _e else ""), "terrain", [draw_hedge(_e)],
             "a wall of clipped labyrinth hedge, dense enough to lose a war in" + ((" (" + _e + " edge)") if _e else ""),
             ["garden", "labyrinth", "wild"], "nature", walkable=False, blocks=True)

def draw_flagstone_flooded():
    img = S(16, 16)
    rect(img, 0, 0, 15, 15, GREY)
    hline(img, 0, 15, 0, SLATE)
    hline(img, 0, 15, 8, SLATE)
    vline(img, 5, 0, 7, SLATE)
    vline(img, 11, 0, 7, SLATE)
    vline(img, 2, 8, 15, SLATE)
    vline(img, 8, 8, 15, SLATE)
    vline(img, 13, 8, 15, SLATE)
    for y in range(16):
        for x in range(16):
            if (x + y) % 2 == 0 and img.getpixel((x, y)) == GREY:
                px(img, x, y, NAVY if (x * 3 + y) % 5 else GREEN_DD)
    for fx, fy in ((3, 4), (12, 2), (7, 11), (14, 13)):
        px(img, fx, fy, CYAN)
    return img

register("flagstone_flooded", "terrain", [draw_flagstone_flooded()],
         "dark flagstones under a hand-span of black-teal floodwater",
         ["interior", "crypt"], "nature", walkable=True, blocks=False)

def draw_wood_floor_flooded():
    img = S(16, 16)
    rect(img, 0, 0, 15, 15, BROWN)
    for y in (3, 7, 11, 15):
        hline(img, 0, 15, y, BRONZE_D)
    for sx, sy in ((5, 0), (12, 4), (3, 8), (10, 12)):
        vline(img, sx, sy, sy + 2, BRONZE_D)
    for y in range(16):
        for x in range(16):
            if (x + y) % 2 == 1 and img.getpixel((x, y)) == BROWN:
                px(img, x, y, NAVY if (x + y * 3) % 5 else GREEN_DD)
    for fx, fy in ((2, 2), (13, 6), (6, 10), (11, 14)):
        px(img, fx, fy, CYAN)
    return img

register("wood_floor_flooded", "terrain", [draw_wood_floor_flooded()],
         "warped floor planks drowned in shallow water, ripples catching the light",
         ["interior", "crypt"], "nature", walkable=True, blocks=False)

def draw_treehouse():
    img = S(48, 64)
    # canopy lobes (drawn first; hut sits in front)
    for x0, y0, x1, y1 in ((8, 3, 39, 15), (14, 1, 33, 6), (3, 8, 12, 26), (35, 8, 44, 26), (5, 26, 10, 30), (37, 26, 43, 30)):
        rect(img, x0, y0, x1, y1, GREEN_D)
    for x0, y0, x1, y1 in ((10, 4, 19, 7), (15, 2, 26, 3), (4, 9, 8, 14)):
        rect(img, x0, y0, x1, y1, GREEN)
    rect(img, 40, 12, 44, 26, GREEN_DD)
    rect(img, 38, 27, 43, 30, GREEN_DD)
    hline(img, 9, 38, 15, GREEN_DD)
    hline(img, 5, 11, 26, GREEN_DD)
    for fx, fy in ((13, 6), (22, 5), (29, 8), (17, 11), (25, 13), (6, 12), (41, 10), (8, 20), (38, 22), (7, 27), (41, 28)):
        px(img, fx, fy, GREEN)
    for fx, fy in ((20, 9), (31, 12), (11, 16), (36, 16), (24, 2), (6, 22)):
        px(img, fx, fy, GREEN_DD)
    # trunk + root flare
    rect(img, 21, 33, 26, 62, BROWN)
    vline(img, 26, 33, 62, BRONZE_D)
    vline(img, 25, 40, 62, BRONZE_D)
    for y in (36, 43, 50, 56):
        px(img, 22, y, BRONZE_D)
        px(img, 21, y + 2, TAN)
    hline(img, 20, 27, 60, BROWN)
    hline(img, 18, 29, 61, BROWN)
    hline(img, 17, 31, 62, BROWN)
    px(img, 29, 61, BRONZE_D)
    px(img, 31, 62, BRONZE_D)
    # plank hut
    rect(img, 15, 17, 32, 30, BROWN)
    vline(img, 32, 17, 30, BRONZE_D)
    vline(img, 31, 22, 30, BRONZE_D)
    for y in (19, 23, 27):
        hline(img, 16, 30, y, TAN)
    rect(img, 22, 20, 25, 24, PLUM)
    hline(img, 14, 33, 16, BRONZE_D)
    # platform + braces
    hline(img, 10, 37, 31, TAN)
    hline(img, 10, 37, 32, BRONZE_D)
    vline(img, 19, 33, 37, BRONZE_D)
    vline(img, 28, 33, 37, BRONZE_D)
    # rope ladder to the ground
    vline(img, 30, 33, 58, TAN)
    vline(img, 33, 33, 58, TAN)
    for y in range(36, 57, 4):
        hline(img, 31, 32, y, TAN)
    return outline(img)

register("treehouse", "prop", [draw_treehouse()],
         "a great oak carrying a plank hut in its arms, rope ladder swaying to the ground",
         ["forest", "wild"], "nature", footW=3, footH=2, blocks=True)

def draw_standing_stone():
    img = S(16, 24)
    profile = [(6, 9), (5, 10), (4, 10), (4, 11), (3, 11), (3, 11), (3, 12), (3, 12), (2, 12), (2, 12),
               (2, 12), (2, 13), (2, 13), (2, 13), (2, 13), (1, 13), (1, 13), (1, 14), (1, 14), (1, 14), (1, 14)]
    for i, (x0, x1) in enumerate(profile):
        y = 2 + i
        hline(img, x0, x1, y, GREY)
        px(img, x0, y, GREY_L)
        px(img, x0 + 1, y, GREY_L if i < 12 else GREY)
        px(img, x1, y, SLATE)
        px(img, x1 - 1, y, SLATE)
    # faint old carving
    vline(img, 7, 6, 12, OUT)
    px(img, 6, 8, OUT)
    px(img, 8, 10, OUT)
    px(img, 7, 15, OUT)
    # weather flecks + moss at the base
    for fx, fy in ((5, 4), (10, 7), (4, 13), (9, 16), (11, 12)):
        px(img, fx, fy, SLATE)
    px(img, 3, 9, GREY_L)
    for mx, my in ((2, 21), (3, 22), (4, 22), (11, 21), (12, 22), (7, 22), (13, 20)):
        px(img, mx, my, GREEN_D)
    return outline(img)

register("standing_stone", "prop", [draw_standing_stone()],
         "a weathered menhir older than the road, moss creeping up its feet",
         ["wild", "moor"], "nature", blocks=True)

def draw_tent():
    img = S(32, 24)
    # crossed poles + ridge
    hline(img, 14, 17, 6, BROWN)
    px(img, 13, 4, BROWN)
    px(img, 14, 5, BROWN)
    px(img, 18, 4, BROWN)
    px(img, 17, 5, BROWN)
    # canvas A-frame
    for i in range(15):
        y = 7 + i
        x0, x1 = 15 - i, 16 + i
        hline(img, x0, x1, y, TAN)
        px(img, x0, y, WHITE)
        px(img, x0 + 1, y, WHITE if i < 9 else TAN)
        px(img, x1, y, BROWN)
        px(img, x1 - 1, y, BROWN if i > 4 else TAN)
    # panel seams + weathering
    for sy in (10, 14, 18):
        px(img, 15 - (sy - 7) + 3, sy, WHITE)
        px(img, 16 + (sy - 7) - 3, sy, BROWN)
    px(img, 12, 19, BROWN)
    px(img, 7, 20, BROWN)
    # dark triangular opening
    for i in range(9):
        y = 13 + i
        hline(img, 15 - i // 2, 16 + i // 2, y, PLUM)
    px(img, 15, 21, OUT)
    px(img, 16, 21, OUT)
    px(img, 16, 18, OUT)
    # guy ropes pegged at the corners
    px(img, 2, 19, BROWN)
    px(img, 1, 20, BROWN)
    px(img, 29, 19, BROWN)
    px(img, 30, 20, BROWN)
    return outline(img)

register("tent", "prop", [draw_tent()],
         "an A-frame canvas tent, flap open onto the dark inside",
         ["camp", "wild"], "nature", footW=2, blocks=True)

def draw_scarecrow():
    img = S(16, 26)
    # post + crossarm
    vline(img, 7, 8, 24, BROWN)
    vline(img, 8, 8, 24, BRONZE_D)
    hline(img, 2, 13, 10, BROWN)
    # sack head, stitched face, tied neck
    rect(img, 5, 2, 10, 7, TAN)
    px(img, 5, 2, WHITE)
    px(img, 6, 2, WHITE)
    px(img, 10, 6, BROWN)
    px(img, 10, 7, BROWN)
    px(img, 6, 4, OUT)
    px(img, 9, 4, OUT)
    hline(img, 7, 8, 6, OUT)
    hline(img, 6, 9, 8, BRONZE_D)
    # ragged red coat + sleeves on the crossarm
    rect(img, 4, 11, 11, 17, RED)
    rect(img, 2, 10, 4, 12, RED)
    rect(img, 11, 10, 13, 12, RED)
    vline(img, 11, 11, 17, BLOOD)
    px(img, 6, 14, BLOOD)
    px(img, 9, 12, BLOOD_D)
    px(img, 4, 18, RED)
    px(img, 7, 18, RED)
    px(img, 10, 18, RED)
    # straw at the wrists and hem
    for sx, sy in ((1, 10), (1, 12), (2, 13), (14, 10), (14, 12), (13, 13), (6, 18), (9, 19)):
        px(img, sx, sy, YELLOW)
    return outline(img)

register("scarecrow", "prop", [draw_scarecrow()],
         "a cross-framed scarecrow in a ragged red coat, straw bleeding from its wrists",
         ["farm", "field"], "nature", blocks=False)

# ===== section: 4-beast.py (11 assets) =====
# ---- BEAST PACK: animals + human foes (16x16 characters, 2-frame bob) --------------------------
def _beast_frames(f):
    return [f, bob(f)]

def draw_bear():
    img = S(16, 16)
    rect(img, 4, 6, 13, 12, BROWN)                      # body mass
    rect(img, 7, 4, 12, 5, BROWN)                       # humped shoulders
    hline(img, 8, 11, 4, TAN)                           # light along the hump
    rect(img, 2, 5, 5, 8, BROWN)                        # head
    px(img, 3, 4, BROWN); px(img, 5, 4, BROWN)          # ears
    hline(img, 1, 2, 7, TAN); px(img, 1, 8, TAN)        # muzzle
    px(img, 3, 6, OUT)                                  # eye
    hline(img, 5, 13, 11, BRONZE_D)                     # belly shadow
    hline(img, 5, 13, 12, BRONZE_D)
    rect(img, 4, 13, 5, 14, BROWN)                      # front leg
    rect(img, 11, 13, 12, 14, BROWN)                    # hind leg
    px(img, 5, 14, BRONZE_D); px(img, 12, 14, BRONZE_D)
    px(img, 6, 8, BRONZE_D); px(img, 9, 7, BRONZE_D); px(img, 11, 9, BRONZE_D)  # fur flecks
    px(img, 5, 6, TAN)
    return outline(img)

def draw_boar():
    img = S(16, 16)
    rect(img, 3, 7, 13, 12, BRONZE_D)                   # body
    hline(img, 4, 12, 6, OUT)                           # bristle ridge on the spine
    px(img, 5, 5, OUT); px(img, 8, 5, OUT); px(img, 11, 5, OUT)
    rect(img, 1, 8, 4, 12, BRONZE_D)                    # head held low
    hline(img, 1, 2, 10, TAN); px(img, 1, 11, TAN)      # snout
    px(img, 3, 9, WHITE)                                # eye
    px(img, 1, 12, WHITE); px(img, 2, 12, WHITE)        # tusks
    hline(img, 4, 9, 7, BRONZE)                         # flank highlight
    px(img, 6, 8, BRONZE); px(img, 10, 8, BRONZE); px(img, 8, 10, BRONZE)
    hline(img, 5, 12, 12, PLUM)                         # belly shade
    rect(img, 4, 13, 5, 14, BRONZE_D)                   # legs
    rect(img, 11, 13, 12, 14, BRONZE_D)
    px(img, 14, 8, BRONZE_D)                            # tail curl
    return outline(img)

def draw_snake():
    img = S(16, 16)
    rect(img, 3, 10, 13, 12, GREEN)                     # base coil
    hline(img, 4, 12, 13, GREEN_D)                      # underside
    hline(img, 5, 11, 14, GREEN_D)
    rect(img, 5, 8, 12, 9, GREEN)                       # upper coil
    hline(img, 6, 12, 9, GREEN_D)                       # coil separation
    px(img, 6, 10, GREEN_D); px(img, 9, 11, GREEN_D); px(img, 12, 10, GREEN_D)
    px(img, 6, 13, TAN); px(img, 9, 13, TAN); px(img, 12, 12, TAN)  # belly scutes
    vline(img, 5, 4, 7, GREEN)                          # neck rising from the coil
    vline(img, 6, 5, 8, GREEN_D)
    rect(img, 3, 2, 6, 3, GREEN)                        # narrow wedge head
    hline(img, 3, 6, 3, GREEN_D)                        # jaw shade
    px(img, 4, 2, YELLOW)                               # eye
    px(img, 2, 3, RED); px(img, 1, 3, RED)              # tongue flick
    return outline(img)

def draw_raven():
    img = S(16, 16)
    rect(img, 5, 7, 10, 11, OUT)                        # body
    hline(img, 5, 8, 7, SLATE); px(img, 5, 8, SLATE)    # top-left sheen
    rect(img, 3, 4, 6, 6, OUT)                          # head
    px(img, 4, 4, SLATE); px(img, 5, 4, SLATE)
    px(img, 4, 5, GREY_L)                               # eye glint
    hline(img, 1, 2, 5, SLATE); px(img, 1, 5, GREY_L)   # beak
    hline(img, 6, 9, 9, SLATE)                          # folded-wing line
    hline(img, 11, 13, 8, OUT); hline(img, 11, 14, 9, OUT); hline(img, 11, 13, 10, OUT)  # tail fan
    px(img, 13, 8, SLATE); px(img, 14, 9, SLATE)
    vline(img, 5, 12, 13, OUT); vline(img, 10, 12, 13, OUT)  # legs
    hline(img, 4, 6, 14, GREY); hline(img, 9, 11, 14, GREY)  # perched feet
    return outline(img)

def draw_bat():
    img = S(16, 16)
    for i, (x0, x1) in enumerate([(2, 5), (1, 6), (1, 6), (2, 6), (3, 6)]):
        hline(img, x0, x1, 4 + i, PLUM)                 # left wing
        hline(img, 15 - x1, 15 - x0, 4 + i, PLUM)       # right wing (mirror)
    hline(img, 2, 5, 4, PURPLE); hline(img, 10, 13, 4, PURPLE)  # light on the wing arms
    px(img, 3, 6, OUT); px(img, 5, 7, OUT)              # webbed fingers
    px(img, 12, 6, OUT); px(img, 10, 7, OUT)
    rect(img, 7, 5, 8, 10, PLUM)                        # furry body
    px(img, 6, 4, PLUM); px(img, 9, 4, PLUM)            # ears
    px(img, 7, 6, CYAN); px(img, 8, 6, CYAN)            # eyes
    px(img, 7, 8, SLATE); px(img, 8, 9, SLATE)          # fur flecks
    return outline(img)

def draw_fox():
    img = S(16, 16)
    rect(img, 4, 8, 10, 12, ORANGE)                     # body
    rect(img, 2, 5, 5, 7, ORANGE)                       # head up, alert
    vline(img, 2, 3, 4, OUT); vline(img, 5, 3, 4, OUT)  # ears
    px(img, 1, 6, WHITE)                                # muzzle tip
    px(img, 3, 6, OUT)                                  # eye
    rect(img, 4, 8, 5, 11, WHITE)                       # chest
    rect(img, 10, 9, 13, 11, ORANGE); px(img, 12, 8, ORANGE)  # tail sweeping back
    rect(img, 13, 9, 14, 10, WHITE)                     # tail tip
    hline(img, 6, 9, 12, BROWN)                         # underbelly shade
    px(img, 11, 11, BROWN); px(img, 9, 9, BROWN)        # fur flecks
    vline(img, 5, 13, 14, OUT); vline(img, 9, 13, 14, OUT)  # legs
    return outline(img)

def draw_drowned_dead():
    img = S(16, 16)
    rect(img, 5, 2, 8, 5, GREY)                         # lolling head
    px(img, 8, 2, GREEN_D); px(img, 5, 5, GREEN_D)      # mottled skin
    px(img, 6, 3, OUT)                                  # sunken eye
    px(img, 7, 4, GREEN_DD)                             # slack mouth
    rect(img, 4, 6, 9, 10, GREEN_D)                     # torso
    rect(img, 10, 7, 10, 10, GREEN_D)                   # sagging right shoulder
    px(img, 4, 6, GREY); px(img, 5, 7, GREY); px(img, 9, 9, GREY)  # waterlogged mottle
    px(img, 6, 8, BONE); px(img, 8, 8, BONE); px(img, 7, 9, BONE)  # ribs showing
    vline(img, 3, 7, 11, GREY)                          # hanging arms
    vline(img, 11, 8, 11, GREY)
    vline(img, 3, 12, 14, GREEN_DD)                     # kelp trailing off the arms
    vline(img, 11, 12, 14, GREEN_DD)
    vline(img, 6, 11, 14, GREY)                         # shambling legs
    vline(img, 9, 11, 14, GREEN_D)
    px(img, 5, 11, CYAN); px(img, 10, 12, CYAN); px(img, 8, 5, CYAN)  # drips
    return outline(img)

def draw_cultist():
    img = S(16, 16)
    px(img, 7, 1, BLOOD)                                # hood peak
    rect(img, 6, 2, 9, 3, BLOOD)                        # hood
    px(img, 5, 4, BLOOD); px(img, 10, 4, BLOOD)         # drooping hood edges
    rect(img, 6, 4, 9, 5, OUT)                          # face lost in shadow
    for i, (x0, x1) in enumerate([(5, 10), (5, 10), (4, 11), (4, 11), (4, 11), (3, 12), (3, 12), (3, 12), (3, 12)]):
        hline(img, x0, x1, 6 + i, BLOOD)                # robe flaring to the hem
    vline(img, 9, 7, 13, BLOOD_D)                       # folds
    vline(img, 11, 10, 13, BLOOD_D)
    hline(img, 3, 12, 14, BLOOD_D)                      # hem shade
    px(img, 6, 2, RED); hline(img, 5, 6, 6, RED)        # top-left light
    px(img, 7, 8, TAN); px(img, 8, 8, TAN)              # clasped hands
    vline(img, 7, 9, 12, OUT)                           # the dagger, point down
    return outline(img)

def draw_witch():
    img = S(16, 16)
    rect(img, 6, 1, 9, 3, OUT)                          # hat crown
    px(img, 5, 1, OUT)                                  # bent tip
    hline(img, 3, 12, 4, OUT)                           # wide brim
    hline(img, 6, 9, 3, PLUM)                           # hat band
    rect(img, 6, 5, 9, 6, TAN)                          # face
    px(img, 7, 5, OUT)                                  # eye
    for i, (x0, x1) in enumerate([(6, 9), (5, 10), (5, 10), (4, 11), (4, 11), (4, 11), (3, 11), (3, 11)]):
        hline(img, x0, x1, 7 + i, PLUM)                 # dress
    vline(img, 4, 10, 13, PURPLE); px(img, 5, 8, PURPLE); px(img, 6, 9, PURPLE)  # left light
    px(img, 10, 10, OUT); px(img, 10, 12, OUT); px(img, 9, 13, OUT)  # right-side folds
    px(img, 5, 9, GREEN); px(img, 5, 10, GREEN)         # potion at the belt
    px(img, 5, 8, WHITE)                                # cork
    vline(img, 13, 5, 11, BROWN)                        # broom handle
    rect(img, 12, 12, 14, 14, YELLOW)                   # bristles
    px(img, 13, 13, TAN); px(img, 12, 14, TAN); px(img, 14, 13, TAN)  # straw texture
    px(img, 11, 8, TAN); px(img, 12, 8, TAN)            # hand on the broom
    return outline(img)

register("bear", "character", _beast_frames(draw_bear()),
         "a heavy brown bear, shoulders humped like a hill", ["forest", "wild"], "beast", fps=3)
register("boar", "character", _beast_frames(draw_boar()),
         "a bristle-backed wild boar, tusks worn white", ["forest", "wild"], "beast", fps=3)
register("snake", "character", _beast_frames(draw_snake()),
         "a coiled green snake, head raised to strike", ["swamp", "wild"], "beast", fps=3)
register("raven", "character", _beast_frames(draw_raven()),
         "a black raven, watching with one pale eye", ["moor", "crypt", "wild"], "beast", fps=3)
register("bat", "character", _beast_frames(draw_bat()),
         "a cave bat mid-flight, wings spread wide", ["cave", "crypt"], "beast", fps=3)
register("fox", "character", _beast_frames(draw_fox()),
         "a red fox, ears pricked, tail tipped white", ["forest"], "beast", fps=3)
register("drowned_dead", "character", _beast_frames(draw_drowned_dead()),
         "a waterlogged walker trailing kelp, still dripping", ["reservoir", "fen", "crypt"], "beast", fps=3)
register("cultist", "character", _beast_frames(draw_cultist()),
         "a blood-robed cultist, dagger clasped, face in shadow", ["dungeon", "crypt"], "beast", fps=3)
register("witch", "character", _beast_frames(draw_witch()),
         "a swamp witch with broom and belt-hung potion", ["swamp", "forest"], "beast", fps=3)

# ===== section: 5-boss.py (14 assets) =====
# ---- BOSS SECTION helpers (namespaced _b* to avoid collisions) ----------------------------------
def _bprof(img, profile, y0, c):
    for i, (x0, x1) in enumerate(profile):
        hline(img, x0, x1, y0 + i, c)

def _bpts(img, pts, c):
    for x, y in pts:
        px(img, x, y, c)

def _bedge(img, profile, y0, cl, cr):
    for i, (x0, x1) in enumerate(profile):
        px(img, x0, y0 + i, cl)
        px(img, x1, y0 + i, cr)

def draw_dragon_red(fl=False):
    img = S(48, 48)
    wingR = [(33,35),(32,37),(31,38),(31,40),(30,42),(30,43),(29,44),(29,43),(29,42),(28,41),
             (28,40),(28,39),(28,37),(28,36),(28,34),(28,33),(28,31),(28,30),(28,29)]
    _bprof(img, wingR, 3, BLOOD_D)
    _bedge(img, wingR, 3, BONE, BLOOD_D)
    _bpts(img, [(30,19),(31,18),(32,17),(33,16),(34,15),(35,14),(36,13),(37,12),(38,11),(39,10),(40,10),(41,9),(42,9),(43,8),(44,8)], BONE)
    wingL = [(12,14),(11,15),(10,16),(10,17),(11,17),(12,18),(13,19),(14,19),(15,19),(16,20),
             (17,21),(18,22),(19,23),(20,24),(21,25),(22,26)]
    _bprof(img, wingL, 5, BLOOD_D)
    _bedge(img, wingL, 5, BONE_D, BLOOD_D)
    body = [(17,27),(15,29),(14,30),(13,31),(13,32),(12,32),(12,33),(12,33),(12,33),(13,32),(13,31),(14,30),(15,29)]
    _bprof(img, body, 22, RED)
    _bedge(img, body, 22, ORANGE, BLOOD_D)
    hline(img, 17, 26, 22, ORANGE)
    _bpts(img, [(19,26),(24,29),(29,31),(21,32),(26,25),(17,30)], BLOOD)
    for i in range(4, 13):
        x0 = body[i][0]
        hline(img, x0 + 1, x0 + 3, 22 + i, TAN if i % 2 else BONE_D)
    neck = [(6,10),(6,10),(7,11),(8,12),(9,13),(10,14),(12,16),(13,17),(15,18)]
    _bprof(img, neck, 13, RED)
    _bedge(img, neck, 13, ORANGE, BLOOD_D)
    rect(img, 5, 9, 13, 13, RED)
    rect(img, 2, 11, 6, 14, RED)
    hline(img, 5, 12, 9, ORANGE)
    hline(img, 2, 7, 14, BLOOD_D)
    px(img, 8, 11, YELLOW)
    px(img, 2, 12, OUT)
    _bpts(img, [(12,8),(13,7),(14,6),(15,5),(15,4)], BONE)
    _bpts(img, [(9,8),(10,7),(10,6)], BONE_D)
    for x0 in (14, 25):
        rect(img, x0, 35, x0 + 4, 42, RED)
        vline(img, x0 + 4, 35, 42, BLOOD_D)
        rect(img, x0 - 1, 42, x0 + 5, 44, RED)
    _bpts(img, [(13,44),(16,44),(24,44),(27,44)], BONE)
    for x, y in [(32,33),(33,35),(34,37),(35,39),(34,41),(33,43),(31,44),(28,45),(24,45),(20,45),(16,45),(12,45),(9,44),(7,43)]:
        px(img, x, y - 1, RED)
        px(img, x, y, BLOOD_D)
    _bpts(img, [(6,42),(5,43),(6,43),(6,44)], RED)
    _bpts(img, [(1,10),(2,11),(1,12)] if fl else [(1,11),(1,13)], ORANGE)
    px(img, 1, 11 if fl else 12, YELLOW)
    return outline(img)

def draw_dragon_black(drip=0):
    img = S(48, 48)
    # FOLDED WING - one big angular sail over the back: spar rising to a wrist spur, membrane below
    spar = [(20, 30), (21, 27), (22, 24), (23, 21), (24, 18), (25, 15), (26, 13), (27, 12)]
    for x, y in spar:
        px(img, x, y, GREY_L)
        px(img, x + 1, y, SLATE)
    px(img, 27, 10, GREY_L)
    px(img, 27, 11, GREY_L)
    for i, (x, y) in enumerate(spar):
        x1 = 38 - i
        if x + 2 <= x1:
            hline(img, x + 2, x1, y + 1, PLUM)
            hline(img, x + 2, x1, y + 2, OUT)
    for x, y in [(30, 20), (33, 23), (35, 26)]:
        vline(img, x, y, y + 6, SLATE)
    # BODY - heavy low mass
    body = [(15, 39), (14, 40), (13, 41), (13, 41), (13, 41), (14, 41), (15, 40)]
    for i, (x0, x1) in enumerate(body):
        hline(img, x0, x1, 31 + i, SLATE)
    hline(img, 15, 38, 31, PLUM)
    hline(img, 14, 40, 33, PLUM)
    for x, y in [(18, 35), (24, 36), (30, 35), (36, 34), (21, 33)]:
        px(img, x, y, OUT)
    hline(img, 14, 40, 37, OUT)
    # NECK - S-curve rising up-left from the shoulder
    neck = [(15, 31, 19), (13, 29, 17), (11, 27, 15), (10, 25, 13), (9, 23, 12), (9, 21, 12), (10, 19, 13)]
    for x0, y, x1 in neck:
        hline(img, x0, x1, y, SLATE)
        px(img, x0, y, PLUM)
        px(img, x1, y, OUT)
    # HEAD - a wedge aimed left, horns swept back
    for i, (x0, x1) in enumerate([(4, 15), (2, 15), (2, 14), (4, 14)]):
        hline(img, x0, x1, 15 + i, SLATE)
    hline(img, 4, 15, 14, PLUM)
    px(img, 5, 16, GREEN)
    px(img, 2, 18, GREEN)
    px(img, 2, 19 + drip, GREEN)
    hline(img, 2, 8, 18, OUT)
    for x, y in [(15, 13), (16, 12), (17, 11), (18, 10)]:
        px(img, x, y, GREY_L)
    for x, y in [(14, 13), (15, 12), (16, 11)]:
        px(img, x, y, SLATE)
    # LEGS - four, crouched, clawed
    for lx in (17, 33):
        rect(img, lx, 38, lx + 3, 43, SLATE)
        vline(img, lx + 3, 38, 43, OUT)
        rect(img, lx - 1, 44, lx + 4, 45, SLATE)
        for cx in (lx - 1, lx + 1, lx + 3):
            px(img, cx, 46, GREY_L)
    # TAIL - sweeping right and down to a spade tip
    tail = [(41, 33), (43, 35), (44, 37), (45, 39), (45, 41), (44, 43), (42, 44)]
    for i, (x, y) in enumerate(tail):
        px(img, x, y, SLATE)
        px(img, x - 1, y, PLUM if i < 4 else SLATE)
        px(img, x, y + 1, OUT)
    rect(img, 41, 44, 43, 45, SLATE)
    px(img, 42, 46, GREY_L)
    return outline(img)
def draw_dragon_bone(flare=False):
    img = S(48, 48)
    # WINGS - two fans of bare finger-spars with tattered membrane scraps
    for sgn, sx in ((-1, 21), (1, 26)):
        for i, (dx, dy) in enumerate([(1, 26), (3, 23), (5, 20), (7, 17), (9, 14), (10, 11), (11, 9)]):
            px(img, sx + sgn * dx, dy, BONE)
            px(img, sx + sgn * dx, dy + 1, BONE_D)
        wrist = (sx + sgn * 11, 9)
        for fdx, fdy in ((6, -5), (8, 0), (7, 6), (5, 11)):
            steps = max(abs(fdx), abs(fdy))
            for t in range(1, steps + 1):
                x = wrist[0] + sgn * (fdx * t // steps)
                y = wrist[1] + (fdy * t // steps)
                px(img, x, y, BONE_D)
        for mdx, mdy in ((4, -1), (5, 1), (6, 3), (4, 4), (6, 7), (5, 8)):
            px(img, wrist[0] + sgn * mdx, wrist[1] + mdy, PLUM)
    # SKULL - big, snouted, horned
    rect(img, 17, 6, 28, 13, BONE)
    hline(img, 17, 28, 6, WHITE)
    rect(img, 12, 9, 17, 13, BONE)
    hline(img, 12, 16, 13, BONE_D)
    px(img, 12, 11, OUT)
    hline(img, 12, 28, 14, OUT)
    for x in (14, 16, 18, 21, 24, 27):
        px(img, x, 15, WHITE)
    rect(img, 19, 8, 21, 10, OUT)
    rect(img, 24, 8, 26, 10, OUT)
    px(img, 20, 9, WHITE if flare else CYAN)
    px(img, 25, 9, WHITE if flare else CYAN)
    for x, y in [(28, 5), (29, 4), (30, 3), (17, 5), (16, 4)]:
        px(img, x, y, BONE_D)
    # NECK vertebrae down to the ribcage
    for x, y in [(23, 16), (23, 17), (23, 18)]:
        px(img, x, y, BONE)
        px(img, x + 1, y, BONE_D)
    # RIBCAGE - a barrel of curved ribs over a dark void
    rect(img, 18, 19, 29, 31, OUT)
    vline(img, 23, 19, 32, BONE)
    vline(img, 24, 19, 32, BONE_D)
    for i in range(4):
        y = 20 + i * 3
        hline(img, 18 - min(i, 2), 22, y, BONE)
        hline(img, 25, 29 + min(i, 2), y, BONE)
        px(img, 17 - min(i, 2), y + 1, BONE_D)
        px(img, 30 + min(i, 2), y + 1, BONE_D)
    # PELVIS + legs + claw feet
    rect(img, 19, 32, 28, 34, BONE)
    hline(img, 19, 28, 34, BONE_D)
    for lx in (20, 26):
        vline(img, lx, 35, 42, BONE)
        vline(img, lx + 1, 35, 42, BONE_D)
    for fx in (17, 25):
        hline(img, fx, fx + 5, 43, BONE)
        for cx in (fx, fx + 2, fx + 4):
            px(img, cx, 44, BONE_D)
    # TAIL - vertebrae sweeping right, tapering
    for j, (x, y) in enumerate([(30, 34), (33, 36), (36, 38), (39, 40), (41, 42), (43, 43), (45, 44)]):
        px(img, x, y, BONE)
        if j < 4:
            px(img, x + 1, y, BONE_D)
            px(img, x, y + 1, BONE_D)
    return outline(img)
def draw_demon():
    img = S(32, 32)
    # folded bat wings behind
    wl = [(7,8),(6,8),(5,8),(5,8),(4,8),(4,8),(4,8),(4,7),(4,7),(5,7),(5,7),(5,6),(5,6),(6,6),(6,6)]
    _bprof(img, wl, 9, PLUM)
    wr = [(23,24),(23,25),(23,26),(23,26),(23,27),(23,27),(23,27),(24,27),(24,27),(24,26),(24,26),(25,26),(25,26),(25,25),(25,25)]
    _bprof(img, wr, 9, PLUM)
    vline(img, 8, 9, 20, BLOOD_D)
    vline(img, 23, 9, 20, BLOOD_D)
    # head + big OUT horns
    rect(img, 12, 4, 19, 9, BLOOD)
    hline(img, 13, 18, 4, RED)
    _bpts(img, [(11,4),(11,3),(10,3),(10,2),(9,1),(20,4),(20,3),(21,3),(21,2),(22,1)], OUT)
    _bpts(img, [(13,6),(18,6)], OUT)
    px(img, 13, 7, YELLOW)
    px(img, 18, 7, YELLOW)
    hline(img, 14, 17, 9, OUT)
    rect(img, 14, 10, 17, 10, BLOOD)
    # broad shoulders, torso, ember cracks
    rect(img, 10, 11, 21, 21, BLOOD)
    hline(img, 11, 20, 11, RED)
    hline(img, 11, 13, 12, RED)
    hline(img, 18, 20, 12, RED)
    vline(img, 20, 13, 21, BLOOD_D)
    hline(img, 11, 20, 21, BLOOD_D)
    _bpts(img, [(14,13),(15,14),(14,15),(16,15),(15,16),(17,17),(15,17),(14,18),(16,19)], ORANGE)
    px(img, 15, 15, YELLOW)
    _bpts(img, [(12,16),(19,15),(12,19),(18,20)], BLOOD_D)
    # arms + claws
    for x in (9, 22):
        vline(img, x, 13, 20, BLOOD)
        px(img, x, 13, RED)
    _bpts(img, [(9,21),(22,21)], OUT)
    # goat legs + OUT hooves
    rect(img, 12, 22, 14, 24, BLOOD)
    rect(img, 17, 22, 19, 24, BLOOD)
    rect(img, 11, 25, 13, 27, BLOOD)
    rect(img, 18, 25, 20, 27, BLOOD)
    _bpts(img, [(14,23),(19,23),(13,26),(18,26)], BLOOD_D)
    rect(img, 10, 28, 13, 29, OUT)
    rect(img, 18, 28, 21, 29, OUT)
    return outline(img)

def draw_treant():
    img = S(32, 32)
    can = [(10,19),(8,23),(6,25),(5,26),(4,27),(4,27),(4,27),(5,26),(6,25),(8,23),(10,21),(13,19)]
    _bprof(img, can, 2, GREEN_D)
    for i, (x0, x1) in enumerate(can[:7]):
        hline(img, x0, x1 - 4 - i, 2 + i, GREEN)
    _bpts(img, [(9,8),(14,10),(20,9),(12,5),(18,4),(23,7),(7,9),(22,10)], GREEN_DD)
    _bpts(img, [(6,4),(11,3),(16,6),(21,5)], GREEN)
    hline(img, 13, 19, 13, GREEN_DD)
    # trunk + face hollows
    rect(img, 12, 13, 19, 24, BROWN)
    vline(img, 12, 13, 24, TAN)
    vline(img, 19, 14, 24, BRONZE_D)
    vline(img, 15, 19, 24, BRONZE_D)
    rect(img, 13, 15, 14, 16, OUT)
    rect(img, 17, 15, 18, 16, OUT)
    rect(img, 14, 19, 17, 20, OUT)
    px(img, 15, 21, OUT)
    # club arm right, twig arm left
    _bpts(img, [(20,15),(21,16),(22,16),(23,17)], BROWN)
    club = [(24,26),(24,26),(23,27),(23,27),(23,28),(23,28),(23,28),(24,28),(24,27)]
    _bprof(img, club, 17, BROWN)
    _bedge(img, club, 17, TAN, BRONZE_D)
    _bpts(img, [(26,19),(25,22),(27,23)], OUT)
    _bpts(img, [(11,15),(10,16),(9,17),(8,18),(7,18)], BROWN)
    px(img, 8, 17, GREEN)
    px(img, 6, 18, GREEN)
    # trunk-legs + root toes
    rect(img, 11, 25, 14, 29, BROWN)
    rect(img, 17, 25, 20, 29, BROWN)
    vline(img, 14, 25, 29, BRONZE_D)
    vline(img, 20, 25, 29, BRONZE_D)
    _bpts(img, [(10,29),(15,29),(16,29),(21,29)], BROWN)
    px(img, 11, 25, TAN)
    px(img, 17, 25, TAN)
    return outline(img)

def draw_serpent_giant():
    img = S(32, 24)
    # coil mound, banded
    coil = [(12,26),(9,28),(7,29),(6,30),(6,30),(7,30),(8,29),(10,28)]
    _bprof(img, coil, 13, GREEN_D)
    _bprof(img, [(13,22),(12,24)], 11, GREEN_D)
    for i, (x0, x1) in enumerate(coil):
        y = 13 + i
        for xb in range(x0 + 2 - (i % 2), x1 - 1, 4):
            px(img, xb, y, GREEN)
    hline(img, 8, 28, 20, GREEN_DD)
    hline(img, 10, 26, 19, GREEN_DD)
    # neck rising to the head
    neck = [(11,14),(11,15),(12,16),(12,17),(13,18),(14,19),(15,20)]
    _bprof(img, neck, 5, GREEN_D)
    _bedge(img, neck, 5, GREEN, GREEN_DD)
    # head high, jaw open wide, fangs
    rect(img, 5, 1, 13, 4, GREEN_D)
    rect(img, 2, 2, 5, 4, GREEN_D)
    hline(img, 5, 12, 1, GREEN)
    px(img, 8, 2, YELLOW)
    px(img, 7, 2, OUT)
    hline(img, 2, 9, 5, OUT)
    px(img, 3, 5, WHITE)
    px(img, 6, 5, WHITE)
    _bprof(img, [(3,9),(4,10)], 6, GREEN_D)
    hline(img, 5, 10, 7, GREEN_DD)
    return outline(img)

def draw_banshee(sh=0):
    img = S(16, 24)
    # streaming hair
    _bpts(img, [(9,1),(11,2),(12,3),(12,5),(3,2),(2,3)], CYAN)
    # head, hollow eyes, mouth agape
    rect(img, 4, 2, 9, 7, WHITE)
    vline(img, 9, 3, 7, CYAN)
    hline(img, 4, 8, 7, CYAN)
    px(img, 5, 4, PLUM)
    px(img, 8, 4, PLUM)
    rect(img, 6, 5, 7, 6, OUT)
    # flowing shroud
    body = [(4,9),(3,10),(3,10),(2,11),(2,11),(2,12),(2,12),(3,12),(3,13),(3,13)]
    _bprof(img, body, 8, CYAN)
    _bedge(img, body, 8, WHITE, CYAN)
    vline(img, 4, 9, 14, WHITE)
    vline(img, 8, 10, 15, WHITE)
    _bpts(img, [(6,12),(10,14),(5,15)], OUT)
    # trailing wisps — no feet; frame 2 shifts them
    for x0, y1 in ((4, 19), (7, 20), (10, 19)):
        vline(img, x0, 18, y1, CYAN)
    px(img, 5 + sh, 21, CYAN)
    px(img, 9 - sh, 21, CYAN)
    px(img, 7 + sh, 22, WHITE)
    return outline(img)

def draw_vampire():
    img = S(16, 16)
    rect(img, 4, 3, 10, 7, TAN)
    hline(img, 4, 10, 2, OUT)
    _bpts(img, [(4,3),(5,3),(9,3),(10,3),(7,3)], OUT)
    px(img, 5, 5, RED)
    px(img, 9, 5, RED)
    px(img, 6, 7, WHITE)
    px(img, 8, 7, WHITE)
    # high collar
    rect(img, 2, 3, 3, 6, PLUM)
    rect(img, 11, 3, 12, 6, PLUM)
    px(img, 2, 3, PURPLE)
    px(img, 11, 3, PURPLE)
    # cloak + red lining glimpse
    cloak = [(3,12),(2,13),(2,13),(2,13),(1,14),(1,14)]
    _bprof(img, cloak, 8, PLUM)
    _bedge(img, cloak, 8, PURPLE, OUT)
    rect(img, 6, 8, 8, 12, RED)
    px(img, 7, 8, OUT)
    hline(img, 1, 14, 13, OUT)
    hline(img, 4, 6, 14, OUT)
    hline(img, 8, 10, 14, OUT)
    return outline(img)

def draw_werewolf():
    img = S(16, 16)
    # high shoulder hump sloping to the haunch
    hump = [(7,10),(6,12),(5,13),(5,13),(4,13),(4,12),(5,12)]
    _bprof(img, hump, 2, GREY)
    _bedge(img, hump, 2, GREY_L, SLATE)
    _bpts(img, [(7,4),(10,5),(9,7),(6,6),(11,7),(8,8)], SLATE)
    # head thrust low + muzzle + red eye + tooth glint
    rect(img, 2, 4, 6, 8, GREY)
    rect(img, 1, 6, 3, 8, GREY)
    _bpts(img, [(2,3),(5,3)], SLATE)
    px(img, 3, 5, RED)
    hline(img, 1, 4, 8, OUT)
    px(img, 2, 8, WHITE)
    # knuckle-down forelimb with white claws
    vline(img, 5, 9, 12, GREY)
    vline(img, 6, 9, 11, SLATE)
    rect(img, 4, 12, 5, 13, GREY)
    _bpts(img, [(3,13),(3,14),(5,14)], WHITE)
    # haunch + bent hind leg + foot
    rect(img, 9, 8, 12, 11, GREY)
    vline(img, 12, 8, 11, SLATE)
    vline(img, 11, 11, 12, GREY)
    rect(img, 9, 13, 12, 14, GREY)
    _bpts(img, [(8,14),(10,14)], WHITE)
    _bpts(img, [(13,7),(14,6),(14,5)], SLATE)
    return outline(img)

def draw_skeleton_king():
    img = S(16, 16)
    # cape behind
    hline(img, 3, 11, 7, RED)
    rect(img, 3, 8, 4, 12, RED)
    rect(img, 10, 8, 11, 12, RED)
    vline(img, 11, 8, 12, BLOOD)
    px(img, 3, 12, BLOOD)
    # crown + skull + orange eye pits
    hline(img, 5, 9, 2, YELLOW)
    _bpts(img, [(5,1),(7,1),(9,1)], YELLOW)
    rect(img, 5, 3, 9, 5, BONE)
    hline(img, 6, 8, 6, BONE)
    px(img, 6, 4, ORANGE)
    px(img, 8, 4, ORANGE)
    px(img, 7, 6, OUT)
    # ribs over the cape gap
    vline(img, 7, 7, 11, BONE)
    hline(img, 5, 9, 8, BONE)
    hline(img, 5, 9, 10, BONE)
    px(img, 9, 8, BONE_D)
    px(img, 9, 10, BONE_D)
    rect(img, 6, 12, 8, 12, BONE_D)
    # legs + feet
    vline(img, 6, 13, 14, BONE)
    vline(img, 8, 13, 14, BONE)
    px(img, 5, 14, BONE)
    px(img, 9, 14, BONE)
    # raised OUT sword
    vline(img, 13, 4, 11, OUT)
    px(img, 13, 5, GREY_L)
    hline(img, 12, 14, 10, OUT)
    hline(img, 9, 12, 9, BONE)
    px(img, 13, 12, BRONZE)
    return outline(img)

def draw_necromancer(g=False):
    img = S(16, 16)
    hood = [(6,9),(5,10),(4,10),(4,11),(5,11)]
    _bprof(img, hood, 2, PURPLE)
    rect(img, 6, 4, 9, 5, OUT)
    px(img, 7, 6, TAN)
    px(img, 8, 6, TAN)
    robe = [(4,11),(4,11),(3,12),(3,12),(2,12),(2,13),(2,13)]
    _bprof(img, robe, 7, PURPLE)
    _bedge(img, robe, 7, PURPLE, PLUM)
    hline(img, 2, 13, 13, PLUM)
    px(img, 7, 7, BONE)
    _bpts(img, [(5,9),(8,11),(4,12)], PLUM)
    # arm to the staff
    hline(img, 10, 12, 9, PURPLE)
    px(img, 12, 9, TAN)
    # bone staff + cyan orb (frame 2: white glint)
    vline(img, 13, 3, 14, BONE)
    px(img, 13, 6, BONE_D)
    px(img, 13, 10, BONE_D)
    rect(img, 12, 1, 13, 2, CYAN)
    if g:
        px(img, 12, 1, WHITE)
    px(img, 6, 14, OUT)
    px(img, 9, 14, OUT)
    return outline(img)

def draw_mimic(open_=False):
    img = S(16, 16)
    if not open_:
        rect(img, 2, 4, 13, 14, BROWN)
        hline(img, 3, 12, 4, TAN)
        hline(img, 2, 13, 8, OUT)
        vline(img, 13, 5, 14, BRONZE_D)
        hline(img, 2, 13, 14, BRONZE_D)
        _bpts(img, [(6,10),(9,12),(3,6),(10,6)], BRONZE_D)
        for x in (4, 11):
            vline(img, x, 4, 14, BRONZE)
            px(img, x, 5, ORANGE)
        rect(img, 7, 7, 8, 9, BRONZE)
        px(img, 8, 8, OUT)
    else:
        rect(img, 2, 1, 13, 4, BROWN)
        hline(img, 3, 12, 1, TAN)
        rect(img, 2, 5, 13, 8, OUT)
        rect(img, 2, 9, 13, 14, BROWN)
        hline(img, 2, 13, 14, BRONZE_D)
        vline(img, 13, 9, 14, BRONZE_D)
        for x in (4, 11):
            vline(img, x, 1, 4, BRONZE)
            vline(img, x, 9, 14, BRONZE)
        _bpts(img, [(3,5),(5,5),(8,5),(10,5),(12,5)], WHITE)
        _bpts(img, [(4,8),(6,8),(11,8),(13,8)], WHITE)
        px(img, 9, 8, RED)
        px(img, 5, 6, YELLOW)
        rect(img, 7, 10, 8, 11, BRONZE)
    return outline(img)

register("dragon_red", "character", [draw_dragon_red(False), bob(draw_dragon_red(True))],
         "the red wyrm, wings raised — furnace breath and hoarded wrath", ["mountain", "lair"], "boss", footW=3, footH=2)
register("dragon_black", "character", [draw_dragon_black(0), bob(draw_dragon_black(1))],
         "the black dragon in a low predatory crouch, acid at the jaw", ["swamp", "lair"], "boss", footW=3, footH=2)
register("dragon_bone", "character", [draw_dragon_bone(False), bob(draw_dragon_bone(True))],
         "a dracolich — bare spars, tattered wings, cold pinprick eyes", ["crypt", "lair"], "boss", footW=3, footH=2)
register("demon", "character", [draw_demon(), bob(draw_demon())],
         "a horned demon, embers cracking through its hide", ["abyss", "dungeon"], "boss", footW=2, footH=1)
register("treant", "character", [draw_treant(), bob(draw_treant())],
         "a walking tree with a club arm and hollow eyes", ["forest"], "boss", footW=2, footH=1)
register("serpent_giant", "character", [draw_serpent_giant(), bob(draw_serpent_giant())],
         "a giant serpent rearing from its coils, fangs bared", ["swamp", "jungle"], "boss", footW=2, footH=1)
register("banshee", "character", [draw_banshee(0), draw_banshee(1)],
         "a wailing spectre trailing into mist", ["moor", "crypt"], "boss")
register("vampire", "character", [draw_vampire(), bob(draw_vampire())],
         "a pale lord in a high-collared cloak, red silk beneath", ["crypt", "manor"], "boss")
register("werewolf", "character", [draw_werewolf(), bob(draw_werewolf())],
         "a hunched wolf-man, claws out, one red eye", ["forest", "moor"], "boss")
register("skeleton_king", "character", [draw_skeleton_king(), bob(draw_skeleton_king())],
         "a crowned skeleton with a raised black sword", ["crypt", "dungeon"], "boss")
register("necromancer", "character", [draw_necromancer(False), bob(draw_necromancer(True))],
         "a purple-robed necromancer, orb-tipped bone staff", ["crypt", "dungeon"], "boss")
register("mimic", "character", [draw_mimic(False), draw_mimic(True)],
         "just a wooden chest — until it is not", ["dungeon"], "boss")

# ===== section: 6-gore.py (11 assets) =====
# =================================================================================================
# GORE — battle aftermath + magical effects (floor decals & overlays; nothing here blocks)
# =================================================================================================
def draw_blood_pool():
    img = S(16, 16)
    spans = [(4, 6, 8), (5, 5, 10), (6, 4, 11), (7, 3, 12), (8, 3, 13), (9, 4, 12), (10, 5, 11), (11, 7, 10)]
    for y, x0, x1 in spans:
        hline(img, x0, x1, y, BLOOD_D)
    for y, x0, x1 in ((6, 6, 9), (7, 5, 10), (8, 5, 11), (9, 6, 10)):
        hline(img, x0, x1, y, BLOOD)
    # irregular lobes so no edge runs straight
    px(img, 2, 8, BLOOD_D); px(img, 13, 6, BLOOD_D); px(img, 6, 12, BLOOD_D); px(img, 9, 12, BLOOD_D)
    # wet highlight arc (top-left light)
    px(img, 5, 5, RED); px(img, 4, 6, RED); px(img, 4, 7, RED); px(img, 6, 6, RED)
    # two satellite drips
    px(img, 14, 10, BLOOD_D); px(img, 14, 11, BLOOD)
    px(img, 2, 11, BLOOD)
    return outline(img)

register("blood_pool", "prop", [draw_blood_pool()],
         "a dark pool of blood, still wet at the edge", ["dungeon", "battle", "any"], "gore", blocks=False)

def draw_blood_splatter():
    img = S(16, 16)
    rect(img, 2, 2, 4, 4, BLOOD_D)  # the impact mass at the origin
    px(img, 5, 2, BLOOD_D); px(img, 2, 5, BLOOD_D)
    streaks = [[(5, 5), (6, 6), (7, 7), (8, 8), (10, 9)],
               [(4, 6), (5, 8), (6, 10), (7, 12)],
               [(6, 4), (8, 5), (10, 5), (12, 6)],
               [(5, 7), (7, 9), (9, 11)]]
    for s in streaks:
        for x, y in s:
            px(img, x, y, BLOOD_D)
    for x, y in ((11, 8), (13, 7), (10, 13), (13, 12), (9, 3), (12, 3), (8, 14)):  # far scatter
        px(img, x, y, BLOOD)
    px(img, 3, 3, RED)  # wet gleam at the heart
    return outline(img)

register("blood_splatter", "prop", [draw_blood_splatter()],
         "a violent spray of blood fanning across the stones", ["dungeon", "battle", "any"], "gore", blocks=False)

def draw_blood_trail():
    img = S(16, 16)
    off = [1, 1, 2, 2, 2, 2, 1, 1, 1, 0, 0, 0]  # drag arc, heavy at the left, tapering right
    for base in (2, 7, 12):
        for i, o in enumerate(off):
            px(img, 2 + i, base + o, BLOOD_D)
            if i <= 6:
                px(img, 2 + i, base + o - 1, BLOOD)  # wet upper edge where the drag started
        px(img, 14, base, BLOOD)  # the last thin fleck of each smear
    return outline(img)

register("blood_trail", "prop", [draw_blood_trail()],
         "smeared drag-marks — something was hauled away, bleeding", ["dungeon", "battle", "any"], "gore", blocks=False)

def draw_web_floor():
    img = S(16, 16)
    rays = [[(x, 1) for x in range(1, 15)],           # anchor strand corner to corner
            [(1, y) for y in range(1, 14)],           # down the left wall
            [(1 + i, 1 + i) for i in range(11)],      # main diagonal
            [(2 + i * 2, 1 + i) for i in range(7)],   # shallow ray
            [(1 + i, 2 + i * 2) for i in range(7)]]   # steep ray
    arcs = [[(4, 1), (4, 2), (3, 3), (2, 4), (1, 4)],
            [(8, 1), (8, 2), (7, 3), (7, 4), (6, 5), (5, 6), (4, 7), (3, 7), (2, 8), (1, 8)],
            [(12, 1), (12, 3), (11, 4), (11, 5), (10, 6), (9, 7), (8, 8), (7, 9), (6, 10), (5, 11), (4, 11), (3, 12), (2, 12), (1, 13)]]
    for r in rays + arcs:
        for x, y in r:
            px(img, x, y, GREY_L)
    for x, y in ((4, 1), (8, 2), (12, 3), (1, 4), (2, 8), (5, 6), (8, 8), (5, 11)):  # dew glints
        px(img, x, y, WHITE)
    px(img, 6, 4, SLATE); px(img, 7, 4, SLATE)  # the dead fly
    return img

register("web_floor", "prop", [draw_web_floor()],
         "a dusty floor cobweb strung between two corners, one fly past caring",
         ["dungeon", "battle", "any"], "gore", blocks=False)

def draw_scorch_mark():
    img = S(16, 16)
    disk = [(4, 6, 9), (5, 5, 10), (6, 4, 11), (7, 4, 11), (8, 4, 11), (9, 4, 11), (10, 5, 10), (11, 6, 9)]
    for y, x0, x1 in disk:  # the scorched ground
        hline(img, x0, x1, y, SLATE)
    for y, x0, x1 in ((6, 6, 9), (7, 5, 10), (8, 5, 10), (9, 6, 9)):  # charred-black heart
        hline(img, x0, x1, y, OUT)
    # radial blast streaks, attached so the burn reads as one blast
    for near, far in (((4, 4), (3, 3)), ((11, 4), (12, 3)), ((4, 11), (3, 12)), ((11, 11), (12, 12)),
                      ((7, 3), (7, 2)), ((8, 12), (8, 13)), ((3, 7), (2, 7)), ((12, 8), (13, 8))):
        px(img, near[0], near[1], SLATE)
        px(img, far[0], far[1], GREY)
    for x, y in ((5, 5), (10, 6), (4, 9), (11, 10), (7, 4), (8, 11)):  # ash motes on the rim
        px(img, x, y, GREY)
    return outline(img)

register("scorch_mark", "prop", [draw_scorch_mark()],
         "a blast-burn seared into the floor, ash fanning outward", ["dungeon", "battle", "any"], "gore", blocks=False)

def draw_slime_puddle():
    img = S(16, 16)
    for y, x0, x1 in ((5, 6, 8), (6, 5, 10), (7, 4, 11), (8, 3, 11), (9, 4, 12), (10, 5, 10), (11, 7, 9)):
        hline(img, x0, x1, y, GREEN_D)
    for y, x0, x1 in ((6, 6, 9), (7, 5, 10), (8, 4, 10), (9, 6, 10)):
        hline(img, x0, x1, y, GREEN)
    px(img, 5, 6, WHITE); px(img, 4, 7, WHITE)  # sheen arc
    px(img, 8, 8, GREEN_DD); px(img, 9, 9, GREEN_DD)  # sunken bubble
    px(img, 12, 10, GREEN_D)  # oozing lobe
    px(img, 13, 5, GREEN); px(img, 14, 6, GREEN_D)  # the detached blob
    return outline(img)

register("slime_puddle", "prop", [draw_slime_puddle()],
         "a glistening smear of green ooze, one blob crawling off on its own",
         ["dungeon", "battle", "any"], "gore", blocks=False)

def draw_magic_circle(shift=0):
    img = S(32, 32)
    for y in range(32):
        for x in range(32):
            dx, dy = 2 * x - 31, 2 * y - 31
            d2 = dx * dx + dy * dy
            if 676 <= d2 <= 784 or 400 <= d2 <= 484:  # outer + inner ring
                px(img, x, y, BLUE)
    verts = [(15, 6), (8, 21), (23, 21)]  # the binding triangle
    for i in range(3):
        (x0, y0), (x1, y1) = verts[i], verts[(i + 1) % 3]
        for t in range(16):
            px(img, x0 + (x1 - x0) * t // 15, y0 + (y1 - y0) * t // 15, NAVY)
    # eight runes riding the band between the rings; frame 2 rotates them one seat
    seats = [(15, 3), (23, 7), (27, 15), (23, 23), (15, 27), (7, 23), (3, 15), (7, 7)]
    glyphs = [[(0, 0)], [(0, 0), (0, 1)], [(0, 0), (1, 0)], [(0, 0), (0, -1)],
              [(0, 0)], [(0, 0), (-1, 0)], [(0, 0), (0, 1)], [(0, 0), (1, 0)]]
    for i, (sx, sy) in enumerate(seats):
        for gx, gy in glyphs[(i + shift) % 8]:
            px(img, sx + gx, sy + gy, CYAN)
    for x, y in ((15, 2), (15, 29), (2, 15), (29, 15)):  # cardinal glow points
        px(img, x, y, WHITE if shift else CYAN)
    return outline(img)

register("magic_circle", "prop", [draw_magic_circle(0), draw_magic_circle(1)],
         "an arcane summoning circle, runes crawling along the band", ["dungeon", "battle", "any"], "gore",
         footW=2, footH=2, blocks=False, light=True)

def draw_smoke_plume(drift=False):
    img = S(16, 28)
    u = 1 if drift else 0
    blob3 = [(-2, -2, 1), (-1, -3, 2), (0, -3, 3), (1, -2, 3), (2, -1, 1)]
    blob2 = [(-1, -1, 1), (0, -2, 2), (1, -1, 1)]
    puffs = [(8, 24, blob2), (7, 21, blob3), (8, 17, blob3), (7, 13, blob3), (9, 9, blob3), (8, 5, blob2)]
    for cx, cy, shape in puffs:  # billows stacked up a wavering column
        for dy, dx0, dx1 in shape:
            hline(img, cx + dx0, cx + dx1, cy + dy - u, SLATE)
        # light catches each puff's upper-left shoulder
        hline(img, cx - 2, cx, cy - 1 - u, GREY)
        px(img, cx - 1, cy - 2 - u, GREY)
    hline(img, 7, 9, 25, SLATE)  # the base never leaves the ground
    hline(img, 7, 9, 26, SLATE)
    px(img, 9 + u, 3 - u, GREY)  # the top wisp drifts off
    px(img, 10 + u, 2 - u, GREY)
    return outline(img)

register("smoke_plume", "prop", [draw_smoke_plume(False), draw_smoke_plume(True)],
         "a column of smoke rolling up from something still burning", ["dungeon", "battle", "any"], "gore",
         blocks=False)

def draw_fire_small(lean=False):
    img = S(16, 16)
    d = 1 if lean else -1  # the flame-tip lean swaps each frame
    outer = [(12, 4, 11), (11, 4, 11), (10, 4, 11), (9, 5, 10), (8, 5, 10), (7, 6, 9), (6, 6, 9), (5, 7, 8), (4, 7, 8)]
    for y, x0, x1 in outer:
        s = d if y <= 7 else 0
        hline(img, x0 + s, x1 + s, y, RED)
    for y, x0, x1 in ((12, 5, 10), (11, 5, 10), (10, 5, 10), (9, 6, 9), (8, 6, 9), (7, 7, 8)):
        s = d if y <= 7 else 0
        hline(img, x0 + s, x1 + s, y, ORANGE)
    for y, x0, x1 in ((12, 6, 9), (11, 6, 9), (10, 7, 8)):
        hline(img, x0, x1, y, YELLOW)
    px(img, 8 if lean else 7, 11, WHITE)  # the hot core wanders
    # charred log stubs under it all
    hline(img, 2, 6, 13, OUT); hline(img, 9, 13, 13, OUT)
    hline(img, 3, 12, 14, OUT)
    px(img, 4, 14, SLATE); px(img, 11, 14, SLATE)  # ember-lit char
    return outline(img)

register("fire_small", "prop", [draw_fire_small(False), draw_fire_small(True)],
         "a small crackling ground fire on blackened logs", ["dungeon", "battle", "any"], "gore",
         blocks=False, light=True)
# --- END AGENT SECTIONS --------------------------------------------------------------------------

def main():
    manifest = []
    for a in ASSETS:
        frames = a["frames"]
        img = sheet(frames) if len(frames) > 1 else frames[0]
        sub = OUT_CHAR if a["kind"] == "character" else OUT_TERR if a["kind"] == "terrain" else OUT_PROPS
        path = os.path.join(sub, a["tag"] + ".png")
        img.save(path)
        rel = path.split("apps/web/public")[-1]
        manifest.append(dict(tag=a["tag"], kind=a["kind"], art=rel, frameW=frames[0].width, frameH=frames[0].height,
                             frames=len(frames), footW=a["footW"], footH=a["footH"], blocks=a["blocks"],
                             light=a["light"], walkable=a["walkable"], desc=a["desc"], biomes=a["biomes"],
                             category=a["category"], fps=a["fps"]))
        print(f"  {a['tag']:24s} {frames[0].width}x{frames[0].height} x{len(frames)} [{a['kind']}] {a['category']}")
    with open("/tmp/forge-manifest.json", "w") as f:
        json.dump(manifest, f, indent=1)
    # QA contact sheet: 4x zoom, grouped rows
    pad, zoom = 6, 4
    cols = 10
    cell = 68 * zoom // 4  # loose cell; scale per sprite below
    rows = (len(ASSETS) + cols - 1) // cols
    sheet_img = Image.new("RGBA", (cols * 80, rows * 90), C("2a2a2a"))
    for i, a in enumerate(ASSETS):
        f = a["frames"][0]
        z = f.resize((f.width * 3, f.height * 3), Image.NEAREST)
        x = (i % cols) * 80 + 6
        y = (i // cols) * 90 + 6
        sheet_img.paste(z, (x, y), z)
    sheet_img.save("/tmp/forge-contact.png")
    print(f"\n{len(ASSETS)} assets -> manifest + /tmp/forge-contact.png")

if __name__ == "__main__":
    main()
