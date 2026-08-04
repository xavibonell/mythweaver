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

def register(tag, kind, frames, desc, biomes, category, footW=1, footH=1, blocks=True, light=False, walkable=None, fps=3, platform=False):
    ASSETS.append(dict(tag=tag, kind=kind, frames=frames, footW=footW, footH=footH, blocks=blocks,
                       light=light, walkable=walkable, desc=desc, biomes=biomes, category=category, fps=fps,
                       platform=platform))

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

# ===== section: 10-swamp.py (18 assets) =====
# =================================================================================================
# SWAMP / JUNGLE KIT — willows, mangroves, lilies, reeds, mossy idols, gas + bayou wildlife
# =================================================================================================

def _swp_draw_willow():
    img = S(32, 32)
    # curtain: one solid mass with a scalloped hem, parted at the centre to show the trunk
    for x in range(3, 29):
        if 13 <= x <= 18:
            d = 14 + (x % 3)              # parted fringe over the trunk
        else:
            d = 22 + ((x * 5) % 9)        # hem swings 22..30
        vline(img, x, 8, d, GREEN_DD)
    # strand shading: mid strands, then lit strands catching light top-left
    for x in (6, 9, 12, 20, 23, 26):
        if 13 <= x <= 18:
            continue
        vline(img, x, 9, 21 + ((x * 5) % 9), GREEN_D)
    for x in (4, 7, 10):
        vline(img, x, 9, 21 + ((x * 5) % 9), GREEN)
    # crown dome (drawn over the curtain top)
    for i, (x0, x1) in enumerate([(12, 19), (9, 22), (7, 24), (5, 26), (4, 27), (3, 28), (3, 28), (4, 27)]):
        hline(img, x0, x1, 2 + i, GREEN_D)
    hline(img, 12, 17, 2, GREEN)
    hline(img, 9, 15, 3, GREEN)
    hline(img, 7, 12, 4, GREEN)
    hline(img, 5, 9, 5, GREEN)
    hline(img, 4, 6, 6, GREEN)
    px(img, 3, 7, GREEN)
    # trunk + root flare (visible through the parted curtain)
    rect(img, 14, 16, 17, 31, BROWN)
    vline(img, 14, 16, 31, TAN)
    vline(img, 17, 16, 31, PLUM)
    hline(img, 12, 19, 31, BROWN)
    px(img, 12, 31, TAN)
    px(img, 19, 31, PLUM)
    return outline(img)

register("willow_weeping", "prop", [_swp_draw_willow()],
         "a weeping willow, its green curtain of fronds trailing to the water",
         ["swamp", "fen", "jungle"], "swampland", footW=2, footH=1, blocks=True)


def _swp_draw_mangrove():
    img = S(16, 24)
    # canopy: a full dome held high over the roots (rows 0-8)
    dome = [(5, 10), (3, 12), (2, 13), (1, 14), (1, 14), (2, 13), (2, 13), (3, 12), (5, 10)]
    for i, (x0, x1) in enumerate(dome):
        hline(img, x0, x1, i, GREEN_D)
    # lit crown (top-left) + deep underside
    hline(img, 5, 9, 0, GREEN)
    hline(img, 3, 8, 1, GREEN)
    hline(img, 2, 7, 2, GREEN)
    hline(img, 1, 5, 3, GREEN)
    px(img, 2, 4, GREEN)
    hline(img, 9, 14, 6, GREEN_DD)
    hline(img, 8, 13, 7, GREEN_DD)
    hline(img, 6, 10, 8, GREEN_DD)
    # short trunk under the dome
    rect(img, 7, 9, 8, 13, BROWN)
    vline(img, 8, 9, 13, PLUM)
    px(img, 7, 10, TAN)
    # root crown
    hline(img, 4, 11, 14, BROWN)
    px(img, 4, 14, TAN)
    px(img, 11, 14, PLUM)
    # stilt roots: two THICK arched legs straddling the mud + a shadowed back leg
    px(img, 4, 15, BROWN)
    px(img, 3, 15, TAN)
    rect(img, 2, 16, 3, 17, BROWN)
    px(img, 2, 16, TAN)
    rect(img, 1, 18, 2, 23, BROWN)
    vline(img, 1, 18, 23, TAN)
    px(img, 11, 15, BROWN)
    px(img, 12, 15, PLUM)
    rect(img, 12, 16, 13, 17, PLUM)
    rect(img, 13, 18, 14, 23, PLUM)
    vline(img, 13, 18, 23, BROWN)
    # back leg, in shadow, between the two
    vline(img, 8, 15, 22, PLUM)
    px(img, 7, 15, BROWN)
    return outline(img)

register("mangrove", "prop", [_swp_draw_mangrove()],
         "a mangrove on arched stilt roots, canopy held above the water",
         ["swamp", "fen", "jungle"], "swampland", blocks=True)


def _swp_draw_jungle_canopy():
    img = S(32, 32)
    # base shadow mass
    for i, (x0, x1) in enumerate([(4, 27), (2, 29), (1, 30), (1, 30), (1, 30), (2, 29), (3, 28), (5, 26), (8, 23)]):
        hline(img, x0, x1, 5 + i, GREEN_DD)
    # scallop lumps hanging below (kept attached to the base mass)
    for x0, x1 in ((6, 10), (12, 16), (18, 22)):
        hline(img, x0, x1, 14, GREEN_DD)
    for x0, x1 in ((7, 9), (19, 21)):
        hline(img, x0, x1, 15, GREEN_DD)
    # mid layer
    for i, (x0, x1) in enumerate([(8, 21), (5, 25), (3, 27), (2, 28), (2, 28), (3, 26), (5, 22)]):
        hline(img, x0, x1, 2 + i, GREEN_D)
    # lit lumps, top-left biased
    hline(img, 9, 16, 1, GREEN)
    hline(img, 6, 18, 2, GREEN)
    hline(img, 4, 14, 3, GREEN)
    hline(img, 3, 10, 4, GREEN)
    hline(img, 4, 7, 5, GREEN)
    hline(img, 20, 24, 2, GREEN)
    hline(img, 19, 22, 3, GREEN)
    # leaf flecks
    for x, y in ((7, 7), (12, 6), (17, 5), (23, 6), (26, 7)):
        px(img, x, y, GREEN)
    for x, y in ((10, 9), (20, 9), (14, 11), (6, 11), (24, 11), (17, 12)):
        px(img, x, y, GREEN_D)
    # thick trunk with buttress flare
    rect(img, 13, 14, 18, 31, BROWN)
    vline(img, 13, 16, 31, TAN)
    vline(img, 18, 14, 31, PLUM)
    vline(img, 17, 22, 31, PLUM)
    px(img, 12, 29, BROWN)
    px(img, 11, 30, BROWN)
    hline(img, 10, 12, 31, BROWN)
    px(img, 10, 31, TAN)
    px(img, 19, 29, PLUM)
    px(img, 20, 30, PLUM)
    hline(img, 19, 21, 31, PLUM)
    # a strangler vine on the trunk
    vline(img, 15, 16, 25, GREEN_DD)
    px(img, 16, 26, GREEN_DD)
    px(img, 15, 20, GREEN_D)
    return outline(img)

register("jungle_canopy", "prop", [_swp_draw_jungle_canopy()],
         "a broad-crowned jungle emergent, layered canopy over a buttressed trunk",
         ["jungle", "swamp"], "swampland", footW=2, footH=1, blocks=True)


def _swp_draw_lily_pad(flower=False):
    img = S(16, 16)
    # the pad: a wide ellipse
    for y, (x0, x1) in ((4, (6, 9)), (5, (4, 11)), (6, (3, 12)), (7, (2, 13)),
                        (8, (1, 14)), (9, (1, 14)), (10, (1, 14)), (11, (2, 13)),
                        (12, (3, 12)), (13, (4, 11)), (14, (6, 9))):
        hline(img, x0, x1, y, GREEN)
    # rim shade, bottom-right
    hline(img, 6, 9, 14, GREEN_D)
    hline(img, 5, 11, 13, GREEN_D)
    hline(img, 9, 12, 12, GREEN_D)
    vline(img, 13, 10, 11, GREEN_D)
    vline(img, 14, 8, 10, GREEN_D)
    px(img, 7, 14, GREEN_DD)
    px(img, 8, 14, GREEN_DD)
    # veins radiating from the heart
    for x, y in ((6, 8), (5, 7), (4, 6), (6, 10), (5, 11), (10, 7), (11, 6), (9, 11), (10, 12)):
        px(img, x, y, GREEN_D)
    # the notch (a slice cut toward the heart, opening right)
    for y, xs in ((8, (12, 13, 14)), (9, (10, 11, 12, 13, 14)), (10, (12, 13, 14))):
        for x in xs:
            px(img, x, y, (0, 0, 0, 0))
    if flower:
        # white bloom, TAN under-shadow, YELLOW heart
        px(img, 5, 4, WHITE)
        px(img, 4, 5, WHITE)
        px(img, 6, 5, WHITE)
        px(img, 3, 6, WHITE)
        px(img, 5, 6, YELLOW)
        px(img, 7, 6, WHITE)
        px(img, 4, 7, TAN)
        px(img, 6, 7, TAN)
        px(img, 5, 8, TAN)
    return outline(img)

register("lily_pad", "prop", [_swp_draw_lily_pad(False)],
         "a broad green lily pad, notched", ["swamp", "fen", "jungle"], "swampland", blocks=False)
register("lily_pad_flower", "prop", [_swp_draw_lily_pad(True)],
         "a lily pad with a white water-lily bloom", ["swamp", "fen", "jungle"], "swampland", blocks=False)


def _swp_draw_reeds():
    img = S(16, 24)
    # stalks (one lit)
    vline(img, 3, 9, 23, GREEN_D)
    px(img, 2, 8, GREEN_D)
    px(img, 2, 7, GREEN_D)
    vline(img, 6, 6, 23, GREEN)
    vline(img, 9, 8, 23, GREEN_D)
    px(img, 10, 7, GREEN_D)
    vline(img, 12, 11, 23, GREEN_D)
    # seed heads
    vline(img, 2, 4, 6, TAN)
    px(img, 2, 3, BONE)
    vline(img, 6, 3, 5, TAN)
    px(img, 6, 2, BONE)
    vline(img, 10, 4, 6, TAN)
    px(img, 10, 3, BONE)
    vline(img, 12, 8, 10, TAN)
    px(img, 12, 7, BONE)
    # bent leaf blades
    px(img, 4, 18, GREEN)
    px(img, 5, 17, GREEN)
    px(img, 6, 16, GREEN)
    px(img, 11, 17, GREEN_D)
    px(img, 10, 16, GREEN_D)
    # base tuft
    hline(img, 2, 13, 23, GREEN_DD)
    px(img, 5, 22, GREEN_DD)
    px(img, 10, 22, GREEN_DD)
    return outline(img)

register("reeds", "prop", [_swp_draw_reeds()],
         "marsh reeds with tan seed heads", ["swamp", "fen", "jungle"], "swampland", blocks=False)


def _swp_draw_cattails():
    img = S(16, 24)
    # stalks
    vline(img, 4, 8, 23, GREEN_D)
    vline(img, 8, 7, 23, GREEN)
    vline(img, 12, 10, 23, GREEN_D)
    # velvet heads + spike tips
    rect(img, 3, 3, 4, 7, BROWN)
    px(img, 3, 3, TAN)
    vline(img, 3, 6, 7, PLUM)
    vline(img, 4, 1, 2, GREEN_D)
    rect(img, 7, 2, 8, 6, BROWN)
    px(img, 7, 2, TAN)
    vline(img, 7, 5, 6, PLUM)
    vline(img, 8, 0, 1, GREEN_D)
    rect(img, 11, 5, 12, 9, BROWN)
    px(img, 11, 5, TAN)
    vline(img, 11, 8, 9, PLUM)
    vline(img, 12, 3, 4, GREEN_D)
    # bent leaf blades
    px(img, 5, 16, GREEN)
    px(img, 6, 15, GREEN)
    px(img, 7, 14, GREEN)
    px(img, 10, 16, GREEN_D)
    px(img, 11, 15, GREEN_D)
    # base tuft
    hline(img, 3, 13, 23, GREEN_DD)
    px(img, 6, 22, GREEN_DD)
    px(img, 11, 22, GREEN_DD)
    return outline(img)

register("cattails", "prop", [_swp_draw_cattails()],
         "cattails, brown velvet heads on tall stalks", ["swamp", "fen", "jungle"], "swampland", blocks=False)


def _swp_draw_fern_giant():
    img = S(16, 16)
    # fronds: 1px arcs, pinnae ticks in the SAME green so nothing merges to black
    # up-left, lit
    for x, y in ((6, 13), (5, 12), (4, 11), (3, 10), (2, 9), (1, 9)):
        px(img, x, y, GREEN)
    px(img, 5, 11, GREEN)
    px(img, 3, 9, GREEN)
    # tall centre, lit — bends left at the tip
    vline(img, 7, 8, 13, GREEN)
    px(img, 6, 7, GREEN)
    px(img, 6, 6, GREEN)
    px(img, 5, 5, GREEN)
    px(img, 6, 11, GREEN)
    px(img, 8, 10, GREEN)
    px(img, 6, 9, GREEN)
    px(img, 8, 8, GREEN)
    # up-right
    for x, y in ((9, 13), (10, 12), (11, 11), (12, 10), (13, 9), (14, 10)):
        px(img, x, y, GREEN_D)
    px(img, 10, 11, GREEN_D)
    px(img, 12, 9, GREEN_D)
    # low droopers, both sides
    for x, y in ((6, 14), (5, 14), (4, 14), (3, 15), (2, 15)):
        px(img, x, y, GREEN_D)
    px(img, 4, 13, GREEN_D)
    for x, y in ((9, 14), (10, 14), (11, 14), (12, 15), (13, 15)):
        px(img, x, y, GREEN_DD)
    px(img, 11, 13, GREEN_DD)
    # crown clump at the root
    rect(img, 7, 14, 8, 15, GREEN_DD)
    return outline(img)

register("fern_giant", "prop", [_swp_draw_fern_giant()],
         "a giant fern, fronds arcing from a central crown", ["jungle", "swamp", "fen"], "swampland", blocks=False)


def _swp_draw_vine_curtain():
    img = S(16, 24)
    for x, ye in ((1, 13), (3, 20), (5, 9), (7, 23), (9, 16), (11, 21), (13, 11), (14, 18)):
        for y in range(0, ye + 1):
            xx = x + ((y // 7) % 2)   # gentle sway
            px(img, xx, y, GREEN if y >= ye - 1 else GREEN_D)
            if y % 5 == 3 and y < ye - 2:
                px(img, xx + 1, y, GREEN)     # leaf pip
            if y % 7 == 5 and y < ye - 2:
                px(img, xx, y, GREEN_DD)      # shadowed knuckle
    return outline(img)

register("vine_curtain", "prop", [_swp_draw_vine_curtain()],
         "a curtain of hanging jungle vines, green at the tips", ["jungle", "swamp"], "swampland", blocks=False)


def _swp_draw_shroom_cluster():
    img = S(16, 16)
    # big toadstool (back left)
    hline(img, 5, 8, 3, PURPLE)
    hline(img, 4, 9, 4, PURPLE)
    hline(img, 3, 10, 5, PURPLE)
    hline(img, 3, 10, 6, PLUM)
    px(img, 5, 4, WHITE)
    px(img, 8, 5, WHITE)
    px(img, 4, 4, WHITE)
    rect(img, 6, 7, 7, 12, BONE)
    vline(img, 7, 7, 12, BONE_D)
    # middle toadstool (front right)
    hline(img, 11, 13, 8, PURPLE)
    hline(img, 10, 14, 9, PURPLE)
    hline(img, 10, 14, 10, PLUM)
    px(img, 11, 9, WHITE)
    rect(img, 11, 11, 12, 15, BONE)
    vline(img, 12, 11, 15, BONE_D)
    # small toadstool (front left)
    hline(img, 2, 4, 11, PURPLE)
    hline(img, 1, 5, 12, PLUM)
    px(img, 2, 11, WHITE)
    vline(img, 3, 13, 15, BONE)
    return outline(img)

register("shroom_cluster", "prop", [_swp_draw_shroom_cluster()],
         "a cluster of purple toadstools, white-flecked", ["swamp", "jungle", "fen"], "swampland", blocks=False)


def _swp_draw_log_rotten():
    img = S(16, 16)
    # the fallen trunk
    rect(img, 1, 9, 14, 15, BROWN)
    hline(img, 1, 11, 9, TAN)
    hline(img, 1, 14, 15, PLUM)
    hline(img, 2, 13, 14, PLUM)
    # sawn end, right — growth rings
    rect(img, 12, 10, 14, 14, TAN)
    px(img, 13, 12, PLUM)
    px(img, 12, 12, BROWN)
    px(img, 14, 12, BROWN)
    px(img, 13, 11, BROWN)
    px(img, 13, 13, BROWN)
    # rotted hollow, left
    rect(img, 1, 11, 2, 14, OUT)
    px(img, 3, 12, PLUM)
    px(img, 3, 13, PLUM)
    # bark cracks
    vline(img, 6, 10, 13, PLUM)
    vline(img, 9, 10, 12, PLUM)
    # moss eating the top
    hline(img, 3, 6, 8, GREEN)
    px(img, 4, 7, GREEN)
    px(img, 8, 8, GREEN_D)
    px(img, 9, 8, GREEN_D)
    px(img, 4, 10, GREEN_D)
    px(img, 5, 10, GREEN_D)
    px(img, 8, 10, GREEN_D)
    px(img, 5, 11, GREEN_D)
    px(img, 10, 10, GREEN_D)
    return outline(img)

register("log_rotten", "prop", [_swp_draw_log_rotten()],
         "a rotten fallen log, moss-eaten and hollow at one end", ["swamp", "jungle", "fen"], "swampland", blocks=True)


def _swp_draw_idol_moss():
    img = S(16, 24)
    # the monolith
    rect(img, 3, 2, 12, 23, GREY)
    vline(img, 3, 2, 23, GREY_L)
    vline(img, 12, 2, 23, SLATE)
    vline(img, 11, 17, 23, SLATE)
    # the carved face: brow, sunken eyes, nose, grim mouth
    hline(img, 4, 11, 6, GREY_L)
    hline(img, 4, 11, 7, SLATE)
    rect(img, 4, 8, 5, 9, OUT)
    rect(img, 9, 8, 10, 9, OUT)
    vline(img, 7, 10, 12, SLATE)
    px(img, 8, 12, SLATE)
    hline(img, 5, 10, 15, OUT)
    px(img, 5, 16, OUT)
    px(img, 10, 16, OUT)
    px(img, 6, 16, GREY_L)
    px(img, 9, 16, GREY_L)
    # old crack
    px(img, 10, 18, SLATE)
    px(img, 9, 19, SLATE)
    px(img, 9, 20, SLATE)
    px(img, 8, 21, SLATE)
    # moss swallowing it: cap, creeping left flank, risen base
    hline(img, 2, 13, 2, GREEN_D)
    hline(img, 2, 13, 3, GREEN_D)
    hline(img, 3, 9, 4, GREEN_D)
    hline(img, 2, 7, 2, GREEN)
    px(img, 3, 4, GREEN)
    px(img, 4, 5, GREEN_D)
    px(img, 11, 4, GREEN_D)
    px(img, 12, 5, GREEN_DD)
    vline(img, 3, 5, 11, GREEN_D)
    px(img, 4, 9, GREEN_D)
    px(img, 3, 14, GREEN_D)
    px(img, 4, 17, GREEN_DD)
    hline(img, 2, 13, 23, GREEN_D)
    hline(img, 3, 9, 22, GREEN_DD)
    px(img, 2, 23, GREEN)
    px(img, 5, 22, GREEN)
    px(img, 12, 22, GREEN_DD)
    return outline(img)

register("idol_moss", "prop", [_swp_draw_idol_moss()],
         "a stone idol face half-swallowed by moss — a jungle-temple sentinel",
         ["jungle", "swamp"], "swampland", blocks=True)


def _swp_draw_swamp_gas(phase=0):
    img = S(16, 16)
    o = phase
    # top wisp (drifts right on frame 2) — an open curl, not a closed ring
    for x, y in ((9, 4), (10, 3), (11, 3), (12, 4), (12, 5), (11, 6)):
        px(img, x + o, y, GREEN_D)
    px(img, 10 + o, 3, GREEN)
    # middle curl (drifts up)
    for x, y in ((4, 10), (3, 9), (4, 8), (5, 8), (6, 9), (5, 11)):
        px(img, x, y - o, GREEN_D)
    px(img, 4, 8 - o, GREEN)
    # stray bubble
    px(img, 9, 11, GREEN_D)
    px(img, 10, 11 - o, GREEN)
    # ground seep (anchors the sprite)
    hline(img, 5, 8, 15, GREEN_D)
    px(img, 6, 14, GREEN)
    px(img, 7, 15, GREEN)
    return outline(img)

register("swamp_gas", "prop", [_swp_draw_swamp_gas(0), _swp_draw_swamp_gas(1)],
         "curls of marsh gas seeping from the mire", ["swamp", "fen", "jungle"], "swampland",
         blocks=False, fps=2)


def _swp_draw_crocodile():
    img = S(16, 16)
    # tail, tapering right
    hline(img, 12, 13, 10, GREEN_D)
    hline(img, 12, 14, 11, GREEN_DD)
    px(img, 12, 12, GREEN_DD)
    px(img, 13, 12, GREEN_DD)
    px(img, 13, 10, PLUM)
    # body, low-slung
    rect(img, 4, 10, 11, 13, GREEN_DD)
    hline(img, 4, 11, 10, GREEN_D)
    px(img, 4, 10, GREEN)
    px(img, 5, 10, GREEN)
    hline(img, 4, 11, 13, PLUM)
    # dorsal ridges
    for x in (5, 7, 9, 11):
        px(img, x, 9, PLUM)
    # head + long jaw, facing left
    rect(img, 1, 10, 3, 13, GREEN_DD)
    hline(img, 1, 3, 10, GREEN_D)
    px(img, 2, 9, GREEN_D)
    px(img, 2, 10, YELLOW)
    px(img, 0, 11, GREEN_DD)
    px(img, 0, 12, GREEN_DD)
    hline(img, 0, 2, 12, OUT)
    px(img, 0, 13, PLUM)
    hline(img, 1, 3, 13, PLUM)
    # squat legs
    rect(img, 4, 14, 5, 15, GREEN_DD)
    rect(img, 10, 14, 11, 15, GREEN_DD)
    px(img, 4, 15, GREEN_D)
    px(img, 10, 15, GREEN_D)
    f = outline(img)
    return f

register("crocodile", "character", [_swp_draw_crocodile(), bob(_swp_draw_crocodile())],
         "a crocodile — low, long-jawed, ridge-backed", ["swamp", "jungle", "fen"], "swampland", fps=3)


def _swp_draw_frog_giant():
    img = S(16, 16)
    # eye bumps + pupils
    rect(img, 3, 2, 5, 4, GREEN)
    rect(img, 10, 2, 12, 4, GREEN)
    px(img, 4, 3, OUT)
    px(img, 11, 3, OUT)
    px(img, 3, 2, WHITE)
    px(img, 10, 2, WHITE)
    # body
    rect(img, 3, 5, 12, 6, GREEN)
    rect(img, 2, 7, 13, 12, GREEN)
    vline(img, 13, 7, 12, GREEN_D)
    hline(img, 2, 13, 12, GREEN_D)
    # wide mouth crease
    hline(img, 4, 11, 7, GREEN_D)
    px(img, 3, 7, GREEN_D)
    px(img, 12, 7, GREEN_D)
    # yellow throat
    rect(img, 5, 9, 10, 12, YELLOW)
    hline(img, 5, 10, 12, ORANGE)
    px(img, 10, 11, ORANGE)
    # back spots
    px(img, 6, 5, GREEN_D)
    px(img, 9, 5, GREEN_D)
    px(img, 4, 8, GREEN_D)
    px(img, 11, 8, GREEN_D)
    # splayed haunches + feet on the ground row
    rect(img, 1, 10, 3, 14, GREEN_D)
    rect(img, 12, 10, 14, 14, GREEN_D)
    px(img, 1, 10, GREEN)
    px(img, 2, 10, GREEN)
    hline(img, 1, 4, 15, GREEN_D)
    hline(img, 11, 14, 15, GREEN_D)
    px(img, 6, 15, GREEN_D)
    px(img, 9, 15, GREEN_D)
    return outline(img)

register("frog_giant", "character", [_swp_draw_frog_giant(), bob(_swp_draw_frog_giant())],
         "a giant frog, yellow-throated and squat", ["swamp", "jungle", "fen"], "swampland", fps=3)


def _swp_draw_heron():
    img = S(16, 16)
    # body oval
    for y, (x0, x1) in ((7, (6, 11)), (8, (5, 12)), (9, (5, 12)), (10, (6, 11))):
        hline(img, x0, x1, y, GREY_L)
    # folded wing shade + tail
    hline(img, 9, 11, 8, SLATE)
    hline(img, 9, 11, 9, SLATE)
    px(img, 12, 7, GREY_L)
    px(img, 13, 7, SLATE)
    # white breast
    px(img, 5, 8, WHITE)
    px(img, 5, 9, WHITE)
    px(img, 6, 7, WHITE)
    # neck (white front) up to the head
    px(img, 5, 6, WHITE)
    vline(img, 4, 3, 5, WHITE)
    # head + black crest plume
    rect(img, 3, 1, 5, 2, GREY_L)
    px(img, 3, 1, WHITE)
    px(img, 6, 1, SLATE)
    px(img, 7, 2, SLATE)
    px(img, 4, 2, OUT)
    # long beak
    hline(img, 0, 2, 2, YELLOW)
    # one stilt leg + tucked stub
    vline(img, 8, 11, 14, SLATE)
    px(img, 9, 11, SLATE)
    hline(img, 7, 9, 15, SLATE)
    return outline(img)

register("heron", "character", [_swp_draw_heron(), bob(_swp_draw_heron())],
         "a grey heron poised on one leg, spear-beaked", ["swamp", "fen", "jungle"], "swampland", fps=3)

# ===== section: 11-deepearth.py (18 assets) =====
# =================================================================================================
# DEEPEARTH KIT — volcanic / underdark: obsidian, basalt, vents, crystals, glowcaps, cave fauna
# =================================================================================================

def _dpe_taper(ax, ay, by, bx0, bx1):
    """Rows (y, x0, x1) of a linear spike from apex (ax, ay) to base [bx0..bx1] at by."""
    rows = []
    h = max(1, by - ay)
    for y in range(ay, by + 1):
        t = (y - ay) / h
        rows.append((y, int(round(ax + (bx0 - ax) * t)), int(round(ax + (bx1 - ax) * t))))
    return rows

def _dpe_clear(img, pts):
    for x, y in pts:
        px(img, x, y, (0, 0, 0, 0))

def _dpe_crystal_spike(img, ax, ay, by, bx0, bx1, lit, dark, edge=None):
    for y, x0, x1 in _dpe_taper(ax, ay, by, bx0, bx1):
        for x in range(x0, x1 + 1):
            px(img, x, y, lit if x <= ax else dark)
        if edge is not None and x1 > ax:
            px(img, x1, y, edge)

# ---- obsidian_shard: knapped volcanic glass, 16x24 ----------------------------------------------
def _dpe_draw_obsidian_shard():
    img = S(16, 24)
    for y, x0, x1 in _dpe_taper(8, 2, 22, 3, 13):
        for x in range(x0, x1 + 1):
            px(img, x, y, PLUM if x <= 9 else OUT)
    # left rim catches the light
    for y, x0, x1 in _dpe_taper(8, 2, 22, 3, 13):
        if 4 <= y <= 15:
            px(img, x0, y, PURPLE)
    # conchoidal facet line
    for y in range(7, 21):
        px(img, 8 - (y - 7) // 4, y, OUT)
    # knapped chips out of the silhouette
    _dpe_clear(img, [(3, 21), (3, 22), (12, 16), (12, 17), (13, 22), (12, 22)])
    # glints
    px(img, 7, 4, WHITE)
    px(img, 5, 12, PURPLE)
    px(img, 4, 17, PURPLE)
    return outline(img)

# ---- obsidian_spire: twin black glass fangs, 16x32 ----------------------------------------------
def _dpe_draw_obsidian_spire():
    img = S(16, 32)
    # side fang (right, shorter) — PURPLE rim on its left separates it from the main fang
    side = ((7, 13, 13), (8, 12, 13), (9, 12, 13), (10, 12, 14), (11, 12, 14), (12, 11, 14),
            (13, 11, 14), (14, 11, 14), (15, 11, 14), (16, 11, 14), (17, 11, 14), (18, 11, 14),
            (19, 11, 14), (20, 11, 14), (21, 11, 14), (22, 11, 14), (23, 11, 14), (24, 11, 14),
            (25, 11, 14), (26, 11, 14), (27, 11, 14), (28, 11, 14), (29, 11, 14), (30, 11, 14))
    for y, x0, x1 in side:
        hline(img, x0, x1, y, PLUM)
        if y >= 10:
            px(img, x1, y, OUT)
        if 8 <= y <= 22:
            px(img, x0, y, PURPLE)
    px(img, 13, 7, WHITE)
    # main fang
    main = ((1, 6, 6), (2, 6, 7), (3, 5, 7), (4, 5, 7), (5, 5, 8), (6, 4, 8), (7, 4, 8),
            (8, 4, 8), (9, 4, 9), (10, 3, 9), (11, 3, 9), (12, 3, 9), (13, 3, 9), (14, 3, 10),
            (15, 3, 10), (16, 2, 10), (17, 2, 10), (18, 3, 10), (19, 2, 10), (20, 2, 10),
            (21, 2, 10), (22, 2, 10), (23, 2, 9), (24, 2, 9), (25, 2, 10), (26, 2, 10),
            (27, 1, 10), (28, 1, 10), (29, 1, 10), (30, 1, 10))
    for y, x0, x1 in main:
        hline(img, x0, x1, y, PLUM)
        if y >= 5:
            px(img, x1, y, OUT)
            px(img, x1 - 1, y, OUT)
        if 2 <= y <= 24:
            px(img, x0, y, PURPLE)
    # facet crease
    for y in range(4, 25):
        px(img, 7 - (y - 4) // 6, y, OUT)
    px(img, 6, 1, WHITE)
    px(img, 5, 3, WHITE)
    px(img, 3, 13, PURPLE)
    px(img, 4, 20, PURPLE)
    return outline(img)

# ---- basalt_column: stepped hexagonal columns, 16x24 --------------------------------------------
def _dpe_draw_basalt_column():
    img = S(16, 24)
    # right column (shorter, behind)
    rect(img, 8, 11, 14, 22, GREY)
    hline(img, 9, 13, 9, GREY_L)
    hline(img, 8, 14, 10, GREY_L)
    hline(img, 8, 14, 11, SLATE)     # cap lip
    vline(img, 14, 12, 22, SLATE)
    vline(img, 11, 12, 22, SLATE)    # facet edge
    hline(img, 12, 13, 17, SLATE)    # crack
    # left column (taller, front)
    rect(img, 2, 7, 8, 22, GREY)
    hline(img, 3, 7, 5, GREY_L)
    hline(img, 2, 8, 6, GREY_L)
    hline(img, 2, 8, 7, SLATE)       # cap lip
    vline(img, 2, 8, 22, GREY_L)     # lit edge
    vline(img, 8, 8, 22, SLATE)
    vline(img, 5, 8, 22, SLATE)      # facet edge
    hline(img, 3, 4, 13, SLATE)      # cracks
    hline(img, 6, 7, 19, SLATE)
    px(img, 3, 6, WHITE)             # top-face glint
    return outline(img)

# ---- vent_volcanic: fumarole cone with a glowing fissure, 16x16, 2f, light ----------------------
def _dpe_draw_vent(hot):
    img = S(16, 16)
    for y, x0, x1 in _dpe_taper(7, 3, 14, 1, 13):
        hline(img, x0, x1, y, SLATE)
        px(img, x0, y, GREY)
        px(img, x1, y, PLUM)
    # crater mouth
    hline(img, 5, 9, 3, GREY)                          # far rim
    hline(img, 5, 10, 4, SLATE)                        # near rim
    hline(img, 6, 9, 4, YELLOW if hot else ORANGE)     # lava in the throat
    # rubble flecks
    px(img, 3, 9, GREY)
    px(img, 11, 11, GREY)
    px(img, 4, 12, GREY)
    # glowing fissure down the face
    crack = ((7, 5), (7, 6), (8, 7), (8, 8), (7, 9), (7, 10), (8, 11), (8, 12), (7, 13), (6, 14))
    for cx, cy in crack:
        px(img, cx, cy, ORANGE)
    hot_idx = (1, 4, 7) if hot else (2, 5, 8)
    for j in hot_idx:
        px(img, crack[j][0], crack[j][1], YELLOW)
    return outline(img)

# ---- geyser_sulfur: scalding plume over a sinter mound, 16x24, 2f -------------------------------
def _dpe_draw_geyser(up):
    img = S(16, 24)
    # sinter crust mound
    for y, x0, x1 in ((18, 5, 10), (19, 4, 11), (20, 3, 12), (21, 2, 13), (22, 2, 13)):
        hline(img, x0, x1, y, TAN)
    hline(img, 5, 10, 18, BONE)
    px(img, 4, 19, BONE)
    px(img, 3, 20, BONE)
    for sx, sy in ((5, 19), (10, 19), (4, 21), (12, 20), (8, 21)):
        px(img, sx, sy, YELLOW)                        # sulfur staining
    hline(img, 10, 13, 21, BRONZE)
    hline(img, 9, 13, 22, BRONZE)
    rect(img, 7, 18, 8, 18, OUT)                       # the vent throat
    # plume: a thin jet that bursts into spray at the top
    if up:
        rect(img, 7, 5, 8, 17, WHITE)                  # the jet
        px(img, 7, 16, YELLOW)
        px(img, 8, 12, YELLOW)
        px(img, 7, 8, YELLOW)
        hline(img, 5, 10, 3, WHITE)                    # burst head
        hline(img, 6, 9, 4, WHITE)
        px(img, 5, 3, YELLOW)
        px(img, 10, 3, YELLOW)
        px(img, 5, 2, WHITE)                           # spray fingers
        px(img, 8, 2, WHITE)
        px(img, 10, 2, WHITE)
        px(img, 3, 5, WHITE)                           # flung droplets
        px(img, 12, 4, WHITE)
        px(img, 2, 8, WHITE)
        px(img, 13, 7, WHITE)
    else:
        rect(img, 7, 10, 8, 17, WHITE)                 # dying jet
        px(img, 8, 15, YELLOW)
        px(img, 7, 12, YELLOW)
        hline(img, 6, 9, 9, WHITE)                     # collapsing puff
        px(img, 6, 8, WHITE)
        px(img, 9, 8, YELLOW)
        px(img, 4, 11, WHITE)                          # falling droplets
        px(img, 11, 13, WHITE)
        px(img, 5, 15, WHITE)
        px(img, 12, 16, WHITE)
    return outline(img)

# ---- crystal_blue: luminous blue outcrop, 16x24, 2f, light --------------------------------------
def _dpe_draw_crystal_blue(g):
    img = S(16, 24)
    _dpe_crystal_spike(img, 12, 7, 21, 9, 14, CYAN, BLUE, NAVY)   # side spike
    _dpe_crystal_spike(img, 5, 2, 21, 2, 9, CYAN, BLUE, NAVY)     # main spike
    # rocky feet
    hline(img, 1, 14, 22, SLATE)
    px(img, 1, 21, GREY)
    if g == 0:
        px(img, 4, 4, WHITE)
        px(img, 5, 3, WHITE)
    else:
        px(img, 11, 9, WHITE)
        px(img, 12, 8, WHITE)
    return outline(img)

# ---- crystal_purple: luminous violet outcrop, 16x24, 2f, light ----------------------------------
def _dpe_draw_crystal_purple(g):
    img = S(16, 24)
    _dpe_crystal_spike(img, 4, 6, 21, 1, 7, PURPLE, PLUM)         # side spike
    _dpe_crystal_spike(img, 10, 2, 21, 7, 13, PURPLE, PLUM)       # main spike
    hline(img, 1, 14, 22, SLATE)
    px(img, 14, 21, GREY)
    if g == 0:
        px(img, 9, 4, WHITE)
        px(img, 10, 3, WHITE)
    else:
        px(img, 3, 8, WHITE)
        px(img, 4, 7, WHITE)
    return outline(img)

# ---- crystal_cluster: low mixed crystal bed, 16x16, 2f, light -----------------------------------
def _dpe_draw_crystal_cluster(g):
    img = S(16, 16)
    _dpe_crystal_spike(img, 10, 3, 13, 7, 13, PURPLE, PLUM)
    _dpe_crystal_spike(img, 4, 5, 13, 1, 7, CYAN, BLUE, NAVY)
    px(img, 14, 12, PURPLE)                            # stub crystal
    px(img, 14, 13, PLUM)
    hline(img, 1, 14, 14, SLATE)
    px(img, 2, 13, GREY)
    if g == 0:
        px(img, 3, 6, WHITE)
        px(img, 9, 5, WHITE)
    else:
        px(img, 4, 7, WHITE)
        px(img, 10, 6, WHITE)
    return outline(img)

# ---- mushroom_glowcap: giant underdark glowcap, 24x32, 2f, light --------------------------------
def _dpe_draw_glowcap(pulse):
    img = S(24, 32)
    cap = ((2, 9, 14), (3, 7, 16), (4, 5, 18), (5, 4, 19), (6, 3, 20), (7, 2, 21),
           (8, 2, 21), (9, 1, 22), (10, 1, 22), (11, 1, 22))
    for y, x0, x1 in cap:
        hline(img, x0, x1, y, CYAN)
    # lower-right dome shade
    for y, x0, x1 in cap[4:]:
        px(img, x1, y, NAVY)
        px(img, x1 - 1, y, NAVY)
    hline(img, 16, 22, 11, NAVY)
    # top-left sheen
    hline(img, 9, 12, 2, WHITE)
    px(img, 7, 3, WHITE)
    px(img, 8, 3, WHITE)
    px(img, 6, 4, WHITE)
    # spore spots
    for sx, sy in ((15, 4), (18, 7), (5, 7), (12, 6), (3, 9)):
        px(img, sx, sy, GREY_L)
    # glowing gills under the rim
    hline(img, 3, 20, 12, WHITE)
    hline(img, 5, 18, 13, WHITE if not pulse else CYAN)
    if pulse:
        for gx in range(4, 20, 2):
            px(img, gx, 12, CYAN)
    # stalk
    rect(img, 9, 14, 14, 28, SLATE)
    vline(img, 9, 14, 28, GREY)
    vline(img, 14, 14, 28, PLUM)
    hline(img, 9, 14, 18, GREY)                        # ring
    px(img, 10, 14, CYAN)                              # gill-light on the stalk top
    px(img, 11, 14, CYAN)
    # base flare
    rect(img, 8, 29, 15, 30, SLATE)
    px(img, 8, 29, GREY)
    px(img, 7, 30, SLATE)
    px(img, 16, 30, SLATE)
    return outline(img)

# ---- mushroom_shelf: bracket fungi off a boulder, 16x16 -----------------------------------------
def _dpe_draw_mushroom_shelf():
    img = S(16, 16)
    # narrow rock stub the brackets grow from
    rect(img, 7, 3, 10, 14, GREY)
    vline(img, 7, 3, 14, GREY_L)
    vline(img, 10, 3, 14, SLATE)
    # three tiered bracket caps: BONE lit rim / TAN face / BRONZE underside
    # top cap (biased right)
    hline(img, 6, 12, 4, BONE)
    hline(img, 5, 13, 5, TAN)
    px(img, 13, 5, BRONZE_D)
    hline(img, 6, 12, 6, BRONZE)
    # mid cap (biased left, the big one)
    hline(img, 3, 11, 8, BONE)
    hline(img, 2, 12, 9, TAN)
    px(img, 12, 9, BRONZE_D)
    hline(img, 3, 11, 10, BRONZE)
    # low cap
    hline(img, 5, 13, 12, BONE)
    hline(img, 4, 14, 13, TAN)
    px(img, 14, 13, BRONZE_D)
    hline(img, 5, 13, 14, BRONZE)
    return outline(img)

# ---- stalagmite_tall: drip-banded floor spike, 16x24 --------------------------------------------
def _dpe_draw_stalagmite_tall():
    img = S(16, 24)
    rows = ((2, 7, 8), (3, 7, 8), (4, 6, 9), (5, 6, 9), (6, 6, 10), (7, 5, 10), (8, 6, 10),
            (9, 5, 10), (10, 5, 11), (11, 4, 11), (12, 5, 11), (13, 5, 11), (14, 4, 12),
            (15, 4, 12), (16, 3, 12), (17, 4, 12), (18, 4, 13), (19, 3, 13), (20, 3, 13),
            (21, 2, 14), (22, 2, 14))
    for y, x0, x1 in rows:
        hline(img, x0, x1, y, GREY)
    for y, x0, x1 in rows:
        px(img, x0, y, GREY_L)                         # lit left edge
        if y >= 6:
            px(img, x1, y, SLATE)
            px(img, x1 - 1, y, SLATE)
    # drip-band shadows under the bulges
    for bi in (6, 10, 15):
        by, bx0, bx1 = rows[bi]
        hline(img, bx0 + 1, bx1 - 2, by + 2, SLATE)
    # wet sheen running from the tip
    px(img, 7, 2, WHITE)
    px(img, 8, 2, WHITE)
    px(img, 7, 3, WHITE)
    px(img, 6, 6, WHITE)
    px(img, 5, 11, WHITE)
    px(img, 4, 16, WHITE)
    return outline(img)

# ---- geode_open: split rock with an amethyst heart, 16x16 ---------------------------------------
def _dpe_draw_geode():
    img = S(16, 16)
    rows = ((5, 5, 10), (6, 3, 12), (7, 2, 13), (8, 2, 13), (9, 1, 14), (10, 1, 14),
            (11, 2, 13), (12, 2, 13), (13, 3, 12), (14, 5, 10))
    for y, x0, x1 in rows:
        hline(img, x0, x1, y, GREY)
    hline(img, 5, 8, 5, GREY_L)
    px(img, 3, 6, GREY_L)
    px(img, 2, 7, GREY_L)
    for y, x0, x1 in rows[5:]:
        px(img, x1, y, SLATE)
    hline(img, 5, 10, 14, SLATE)
    # the split cavity
    cav = ((7, 5, 11), (8, 4, 12), (9, 4, 12), (10, 4, 12), (11, 5, 11), (12, 6, 10))
    for y, x0, x1 in cav:
        hline(img, x0, x1, y, PLUM)
    # crystal teeth (checkered sparkle)
    for y, x0, x1 in cav:
        for cx in range(x0, x1 + 1):
            if (cx + y) % 2 == 0:
                px(img, cx, y, PURPLE)
    px(img, 8, 9, WHITE)
    px(img, 6, 11, WHITE)
    return outline(img)

# ---- sulfur_mound: crusted yellow fumarole mound, 16x16 -----------------------------------------
def _dpe_draw_sulfur_mound():
    img = S(16, 16)
    rows = ((8, 6, 9), (9, 4, 11), (10, 3, 12), (11, 2, 13), (12, 1, 13), (13, 1, 14), (14, 1, 14))
    for y, x0, x1 in rows:
        hline(img, x0, x1, y, TAN)
    # sulfur crust, lit from the top-left
    hline(img, 6, 8, 8, YELLOW)
    for sx, sy in ((4, 9), (5, 9), (7, 9), (3, 10), (6, 10), (2, 11), (5, 12), (10, 9), (12, 11)):
        px(img, sx, sy, YELLOW)
    # shade bottom-right
    for y, x0, x1 in rows[3:]:
        px(img, x1, y, BRONZE)
        px(img, x1 - 1, y, BRONZE)
    hline(img, 4, 13, 14, BRONZE)
    # fumarole hole
    rect(img, 8, 10, 9, 11, OUT)
    px(img, 10, 11, YELLOW)
    px(img, 7, 12, YELLOW)
    return outline(img)

# ---- magma_crawler: cracked basalt shell over a molten core, char 16x16, 2f ---------------------
def _dpe_draw_magma_crawler(hot):
    img = S(16, 16)
    body = ((6, 4, 10), (7, 3, 12), (8, 2, 13), (9, 2, 14), (10, 2, 14), (11, 3, 13), (12, 4, 12))
    for y, x0, x1 in body:
        hline(img, x0, x1, y, SLATE)
    # segment ridge bumps
    for bx in (5, 7, 9):
        px(img, bx, 5, SLATE)
    # top-left light on the shell
    hline(img, 4, 9, 6, GREY)
    px(img, 3, 7, GREY)
    px(img, 2, 8, GREY)
    px(img, 5, 5, GREY)
    # molten seams between the plates
    for i, sx in enumerate((5, 8, 11)):
        vline(img, sx, 7, 12, ORANGE)
        px(img, sx, 9 if (i % 2 == 0) == hot else 11, YELLOW)
    # belly glow line
    hline(img, 4, 11, 12, ORANGE)
    px(img, 6 if hot else 9, 12, YELLOW)
    # eye
    px(img, 14, 9, YELLOW if hot else ORANGE)
    # legs
    for lx in (4, 7, 10, 12):
        px(img, lx, 13, SLATE)
        px(img, lx, 14, SLATE)
    return outline(img)

# ---- beetle_cave: slate-shelled cave beetle, char 16x16 -----------------------------------------
def _dpe_draw_beetle():
    img = S(16, 16)
    body = ((3, 6, 9), (4, 4, 11), (5, 4, 11), (6, 3, 12), (7, 3, 12), (8, 3, 12),
            (9, 3, 12), (10, 4, 11), (11, 5, 10))
    for y, x0, x1 in body:
        hline(img, x0, x1, y, SLATE)
    # head + mandibles (front-facing, below the shell)
    hline(img, 5, 10, 12, SLATE)
    hline(img, 6, 9, 13, SLATE)
    px(img, 6, 14, SLATE)
    px(img, 9, 14, SLATE)
    # legs
    for lx, ly in ((2, 6), (1, 7), (2, 9), (1, 10), (4, 12), (3, 13),
                   (13, 6), (14, 7), (13, 9), (14, 10), (11, 12), (12, 13)):
        px(img, lx, ly, SLATE)
    # elytra split + shading
    vline(img, 8, 3, 11, OUT)
    px(img, 6, 3, GREY)
    px(img, 7, 3, GREY)
    px(img, 5, 4, GREY)
    px(img, 4, 5, GREY)
    px(img, 3, 6, GREY)
    px(img, 5, 6, GREY_L)                              # sheen
    px(img, 12, 8, OUT)
    px(img, 11, 10, OUT)
    px(img, 10, 11, OUT)
    # glowing eyes
    px(img, 6, 12, CYAN)
    px(img, 9, 12, CYAN)
    return outline(img)

# ---- salamander_fire: red cave salamander, char 16x16 -------------------------------------------
def _dpe_draw_salamander():
    img = S(16, 16)
    # curled tail with a hot tip
    for tx, ty in ((2, 9), (1, 8), (1, 7), (2, 6)):
        px(img, tx, ty, ORANGE)
    px(img, 2, 5, YELLOW)
    # body + head (facing right)
    hline(img, 12, 14, 7, ORANGE)                      # snout top
    hline(img, 4, 14, 8, ORANGE)                       # lit back
    hline(img, 3, 14, 9, RED)
    hline(img, 3, 14, 10, RED)
    hline(img, 4, 13, 11, RED)
    for ux in range(10, 14):
        px(img, ux, 11, BLOOD)                         # under-jaw shade
    hline(img, 5, 12, 12, YELLOW)                      # belly
    # markings + eye
    px(img, 5, 9, YELLOW)
    px(img, 8, 9, YELLOW)
    px(img, 11, 9, YELLOW)
    px(img, 13, 8, WHITE)                              # eye
    # legs
    for lx in (5, 11):
        px(img, lx, 13, RED)
        px(img, lx, 14, RED)
    return outline(img)

# ---- registration -------------------------------------------------------------------------------
register("obsidian_shard", "prop", [_dpe_draw_obsidian_shard()],
         "a knapped shard of volcanic glass, edges still razor", ["volcanic", "cavern", "underdark"],
         "deepearth")
register("obsidian_spire", "prop", [_dpe_draw_obsidian_spire()],
         "a twin-fanged spire of black volcanic glass", ["volcanic", "cavern"], "deepearth")
register("basalt_column", "prop", [_dpe_draw_basalt_column()],
         "stepped hexagonal basalt columns", ["volcanic", "cavern", "underdark"], "deepearth")
register("vent_volcanic", "prop", [_dpe_draw_vent(False), _dpe_draw_vent(True)],
         "a cracked fumarole cone, magma pulsing in the fissure", ["volcanic", "cavern"],
         "deepearth", light=True, fps=3)
register("geyser_sulfur", "prop", [_dpe_draw_geyser(True), _dpe_draw_geyser(False)],
         "a sulfur geyser venting a scalding plume", ["volcanic", "cavern"], "deepearth", fps=2)
register("crystal_blue", "prop", [_dpe_draw_crystal_blue(0), _dpe_draw_crystal_blue(1)],
         "a faceted blue crystal outcrop, softly luminous", ["underdark", "cavern"], "deepearth",
         light=True, fps=3)
register("crystal_purple", "prop", [_dpe_draw_crystal_purple(0), _dpe_draw_crystal_purple(1)],
         "a violet crystal outcrop, softly luminous", ["underdark", "cavern"], "deepearth",
         light=True, fps=3)
register("crystal_cluster", "prop", [_dpe_draw_crystal_cluster(0), _dpe_draw_crystal_cluster(1)],
         "a low bed of mixed blue and violet crystals", ["underdark", "cavern"], "deepearth",
         light=True, fps=3)
register("mushroom_glowcap", "prop", [_dpe_draw_glowcap(False), _dpe_draw_glowcap(True)],
         "a giant glowcap mushroom, gills pulsing pale light", ["underdark", "cavern"], "deepearth",
         footW=2, light=True, fps=2)
register("mushroom_shelf", "prop", [_dpe_draw_mushroom_shelf()],
         "bracket fungi shelving off a damp boulder", ["underdark", "cavern"], "deepearth")
register("stalagmite_tall", "prop", [_dpe_draw_stalagmite_tall()],
         "a tall drip-banded stalagmite, tip still wet", ["underdark", "cavern"], "deepearth")
register("geode_open", "prop", [_dpe_draw_geode()],
         "a split geode, amethyst teeth glinting inside", ["underdark", "cavern"], "deepearth")
register("sulfur_mound", "prop", [_dpe_draw_sulfur_mound()],
         "a crusted yellow sulfur mound with a fumarole hole", ["volcanic", "cavern"], "deepearth")
register("magma_crawler", "character",
         [_dpe_draw_magma_crawler(False), bob(_dpe_draw_magma_crawler(True))],
         "a magma crawler — cracked basalt shell over a molten core", ["volcanic", "cavern"],
         "deepearth", fps=3)
register("beetle_cave", "character", [_dpe_draw_beetle(), bob(_dpe_draw_beetle())],
         "a cave beetle with a slate carapace and cyan eyes", ["underdark", "cavern"],
         "deepearth", fps=3)
register("salamander_fire", "character", [_dpe_draw_salamander(), bob(_dpe_draw_salamander())],
         "a fire salamander, ember-red with a yellow belly", ["volcanic", "cavern"],
         "deepearth", fps=3)

# ===== section: 12-wilds.py (19 assets) =====
# =================================================================================================
# WILDS — forest / farmland kit (section prefix _wld_)
# =================================================================================================

def _wld_fill_rows(img, rows, c):
    for y, x0, x1 in rows:
        hline(img, x0, x1, y, c)


# ---- birch (16x24) + birch_tall (16x32) ---------------------------------------------------------
def _wld_draw_birch(h, tall=False):
    img = S(16, h)
    if tall:
        crown = [(1, 6, 9), (2, 4, 11), (3, 3, 12), (4, 2, 13), (5, 2, 13), (6, 2, 13),
                 (7, 2, 13), (8, 2, 13), (9, 3, 12), (10, 3, 12), (11, 4, 11), (12, 5, 10)]
    else:
        crown = [(1, 6, 9), (2, 4, 11), (3, 3, 12), (4, 2, 13), (5, 2, 13), (6, 2, 13),
                 (7, 2, 13), (8, 3, 12), (9, 4, 11), (10, 5, 10)]
    _wld_fill_rows(img, crown, GREEN)
    last = crown[-1][0]
    # shade: right rim + underside (light top-left)
    for y, x0, x1 in crown:
        px(img, x1, y, GREEN_D)
        px(img, x1 - 1, y, GREEN_D)
        if y >= last - 1:
            hline(img, x0 + 2, x1, y, GREEN_D)
    # inner leaf dapple
    for x, y in ((9, 4), (6, 6), (10, 6), (5, 8), (8, 5)):
        px(img, x, y, GREEN_D)
    # sunlit flecks top-left (birches go golden)
    for x, y in ((6, 1), (4, 2), (3, 3), (2, 4), (5, 3)):
        px(img, x, y, YELLOW)
    # white trunk, bark ticks
    for y in range(last + 1, h):
        px(img, 7, y, WHITE)
        px(img, 8, y, BONE)
    i = 0
    for y in range(last + 3, h - 1, 2):
        px(img, 7 if i % 2 == 0 else 8, y, OUT)
        i += 1
    # base flare
    px(img, 6, h - 1, WHITE)
    px(img, 9, h - 1, BONE)
    return outline(img)

register("birch", "prop", [_wld_draw_birch(24)],
         "a slender birch — white ticked trunk, light green crown",
         ["forest", "village", "farm"], "wilds")

register("birch_tall", "prop", [_wld_draw_birch(32, tall=True)],
         "a tall birch, golden-flecked crown high on a white trunk",
         ["forest", "village"], "wilds")


# ---- oak_ancient (32x32, footW=2) ---------------------------------------------------------------
def _wld_draw_oak_ancient():
    img = S(32, 32)
    # gnarled trunk first (canopy overwrites its top)
    trunk = [(16, 13, 18), (17, 13, 18), (18, 13, 18), (19, 12, 19), (20, 12, 19), (21, 12, 19),
             (22, 12, 19), (23, 12, 19), (24, 11, 20), (25, 11, 20), (26, 11, 20), (27, 10, 21),
             (28, 10, 21), (29, 9, 22), (30, 8, 22), (31, 7, 23)]
    _wld_fill_rows(img, trunk, BROWN)
    for y, x0, x1 in trunk:
        px(img, x0, y, TAN)             # left edge catches light
        px(img, x1, y, BRONZE_D)
        px(img, x1 - 1, y, BRONZE_D)
    # bark crevices + knothole
    for y in range(19, 27):
        px(img, 15, y, OUT)
    for y in range(21, 25):
        px(img, 17, y, BRONZE_D)
    px(img, 14, 27, OUT)
    # root separation notches
    for x, y in ((12, 30), (12, 31), (19, 30), (19, 31)):
        px(img, x, y, OUT)
    # massive lumpy canopy
    canopy = [(0, [(12, 19)]), (1, [(9, 23)]), (2, [(7, 25)]), (3, [(5, 27)]), (4, [(4, 28)]),
              (5, [(3, 29)]), (6, [(2, 29)]), (7, [(1, 30)]), (8, [(1, 30)]), (9, [(1, 30)]),
              (10, [(1, 30)]), (11, [(2, 29)]), (12, [(2, 29)]), (13, [(3, 28)]), (14, [(4, 27)]),
              (15, [(5, 10), (13, 26)]), (16, [(6, 9), (15, 25)]), (17, [(17, 22)])]
    for y, segs in canopy:
        for x0, x1 in segs:
            hline(img, x0, x1, y, GREEN_D)
    # deep shadow: right rim + underside
    for y, segs in canopy:
        for x0, x1 in segs:
            px(img, x1, y, GREEN_DD)
            px(img, x1 - 1, y, GREEN_DD)
            if y >= 14:
                hline(img, max(x0, x0 + (x1 - x0) // 2), x1, y, GREEN_DD)
    for x, y in ((20, 12), (24, 10), (10, 13), (16, 15), (27, 8), (6, 12), (14, 11)):
        px(img, x, y, GREEN_DD)
    # sunlit blotches top-left
    for bx, by in ((4, 4), (8, 2), (13, 1), (6, 7), (11, 5), (3, 8), (16, 3), (9, 8)):
        rect(img, bx, by, bx + 1, by + 1, GREEN)
    for x, y in ((19, 2), (22, 5), (7, 10), (14, 7), (18, 6)):
        px(img, x, y, GREEN)
    return outline(img)

register("oak_ancient", "prop", [_wld_draw_oak_ancient()],
         "an ancient oak — gnarled flaring trunk under a vast dark crown",
         ["forest", "village"], "wilds", footW=2, footH=1)


# ---- tree_dead (16x24) --------------------------------------------------------------------------
def _wld_draw_tree_dead():
    img = S(16, 24)
    # trunk
    for y in range(9, 24):
        px(img, 7, y, BROWN)
        px(img, 8, y, BRONZE_D)
    # base flare
    px(img, 6, 23, BROWN)
    px(img, 9, 23, BRONZE_D)
    px(img, 5, 23, BROWN)
    # left clawed branch
    for x, y in ((6, 8), (5, 7), (4, 6), (3, 5), (3, 4)):
        px(img, x, y, BROWN)
    px(img, 2, 3, BROWN)
    px(img, 2, 2, BROWN)   # long claw
    px(img, 4, 3, BROWN)   # short claw
    # right clawed branch
    for x, y in ((9, 8), (10, 7), (11, 6), (12, 5)):
        px(img, x, y, BRONZE_D)
    px(img, 13, 4, BRONZE_D)
    px(img, 13, 3, BRONZE_D)
    px(img, 11, 4, BRONZE_D)
    # centre spike with fork
    px(img, 7, 8, BROWN)
    px(img, 7, 7, BROWN)
    px(img, 7, 6, BROWN)
    px(img, 6, 5, BROWN)
    px(img, 6, 4, BROWN)
    px(img, 8, 5, BRONZE_D)
    # broken stub on the trunk
    px(img, 9, 14, BRONZE_D)
    px(img, 10, 13, BRONZE_D)
    # top-left light on trunk
    for y in range(10, 16):
        px(img, 7, y, TAN if y % 3 == 1 else BROWN)
    return outline(img)

register("tree_dead", "prop", [_wld_draw_tree_dead()],
         "a dead tree, bare clawed branches raking the sky",
         ["forest", "swamp", "crypt"], "wilds")


# ---- stump (16x16) ------------------------------------------------------------------------------
def _wld_draw_stump():
    img = S(16, 16)
    # cut top face (low, wide ellipse)
    face = [(6, 5, 10), (7, 4, 11), (8, 3, 12), (9, 3, 12), (10, 4, 11)]
    _wld_fill_rows(img, face, TAN)
    # one open growth ring (TAN heart left showing)
    hline(img, 6, 9, 7, BRONZE_D)
    px(img, 5, 8, BRONZE_D)
    px(img, 10, 8, BRONZE_D)
    hline(img, 6, 9, 9, BRONZE_D)
    # short bark sides
    rect(img, 4, 11, 11, 15, BROWN)
    px(img, 3, 11, BROWN)
    px(img, 12, 11, BRONZE_D)
    for y in range(11, 16):
        px(img, 4, y, TAN)          # lit left edge
        px(img, 11, y, BRONZE_D)
        px(img, 10, y, BRONZE_D)
    # staggered short bark grooves
    for x, y in ((6, 12), (6, 13), (8, 13), (8, 14)):
        px(img, x, y, OUT)
    # root flare on the ground row
    px(img, 3, 15, BROWN)
    px(img, 12, 15, BRONZE_D)
    return outline(img)

register("stump", "prop", [_wld_draw_stump()],
         "a cut stump, growth rings on the sawn face",
         ["forest", "village", "farm"], "wilds")


# ---- log_fallen (32x16, footW=2) ----------------------------------------------------------------
def _wld_draw_log_fallen():
    img = S(32, 16)
    body = [(9, 2, 29), (10, 1, 30), (11, 1, 30), (12, 1, 30), (13, 1, 30), (14, 1, 30), (15, 2, 29)]
    _wld_fill_rows(img, body, BROWN)
    # top edge catches light
    hline(img, 4, 29, 9, TAN)
    # left cut face
    rect(img, 1, 10, 3, 14, TAN)
    px(img, 1, 10, BROWN)
    px(img, 1, 14, BROWN)
    for y in range(11, 14):
        px(img, 2, y, BRONZE_D)     # ring
    px(img, 2, 12, BROWN)           # heart
    # bark texture + knot
    hline(img, 8, 11, 11, BRONZE_D)
    hline(img, 14, 18, 13, BRONZE_D)
    hline(img, 22, 25, 12, BRONZE_D)
    px(img, 19, 11, OUT)
    # broken branch stub
    px(img, 26, 8, BROWN)
    px(img, 26, 7, BROWN)
    px(img, 27, 8, BRONZE_D)
    # moss draped on top
    hline(img, 6, 10, 8, GREEN_D)
    hline(img, 18, 23, 8, GREEN_D)
    hline(img, 5, 12, 9, GREEN_D)
    hline(img, 17, 25, 9, GREEN_D)
    px(img, 7, 10, GREEN_D)
    px(img, 21, 10, GREEN_D)
    px(img, 6, 8, GREEN)
    px(img, 19, 8, GREEN)
    px(img, 10, 9, GREEN)
    # ground shadow side
    hline(img, 2, 29, 15, BRONZE_D)
    hline(img, 18, 30, 14, BRONZE_D)
    return outline(img)

register("log_fallen", "prop", [_wld_draw_log_fallen()],
         "a fallen log, moss draped over the bark",
         ["forest", "swamp"], "wilds", footW=2, footH=1)


# ---- log_pile (16x16) ---------------------------------------------------------------------------
def _wld_log_end(img, x0, y0):
    rows = [(0, 1, 4), (1, 0, 5), (2, 0, 5), (3, 0, 5), (4, 0, 5), (5, 1, 4)]
    for dy, a, b in rows:
        hline(img, x0 + a, x0 + b, y0 + dy, BROWN)
    rect(img, x0 + 1, y0 + 1, x0 + 4, y0 + 4, TAN)
    px(img, x0 + 1, y0 + 1, BROWN)
    px(img, x0 + 4, y0 + 1, BROWN)
    px(img, x0 + 1, y0 + 4, BROWN)
    px(img, x0 + 4, y0 + 4, BRONZE_D)
    # heartwood ring
    px(img, x0 + 2, y0 + 2, BRONZE_D)
    px(img, x0 + 3, y0 + 2, BRONZE_D)
    px(img, x0 + 2, y0 + 3, BRONZE_D)

def _wld_draw_log_pile():
    img = S(16, 16)
    _wld_log_end(img, 1, 10)
    _wld_log_end(img, 8, 10)
    _wld_log_end(img, 4, 5)
    # moss specks on the top log
    px(img, 5, 5, GREEN_D)
    px(img, 8, 6, GREEN_D)
    return outline(img)

register("log_pile", "prop", [_wld_draw_log_pile()],
         "stacked cut logs, pale ring faces out",
         ["village", "farm", "forest"], "wilds")


# ---- bush_berry (16x16) -------------------------------------------------------------------------
def _wld_draw_bush_berry():
    img = S(16, 16)
    rows = [(4, 6, 9), (5, 4, 11), (6, 3, 12), (7, 2, 13), (8, 2, 13), (9, 2, 13), (10, 2, 13),
            (11, 3, 12), (12, 3, 12), (13, 4, 11), (14, 4, 11), (15, 5, 10)]
    _wld_fill_rows(img, rows, GREEN_D)
    # top-left lit leaves
    for x, y in ((6, 4), (7, 4), (4, 5), (5, 5), (6, 5), (3, 6), (4, 6), (5, 7), (3, 7), (4, 8)):
        px(img, x, y, GREEN)
    # deep shadow underside + right
    for y, x0, x1 in rows:
        px(img, x1, y, GREEN_DD)
        if y >= 13:
            hline(img, x0 + 2, x1, y, GREEN_DD)
    for x, y in ((11, 9), (9, 11), (12, 8), (7, 13)):
        px(img, x, y, GREEN_DD)
    # berries
    for x, y in ((7, 6), (10, 6), (12, 9), (5, 9), (8, 10), (10, 12), (4, 11)):
        px(img, x, y, RED)
    px(img, 7, 5, WHITE)  # dew glint
    return outline(img)

register("bush_berry", "prop", [_wld_draw_bush_berry()],
         "a berry bush, red fruit in dark leaves",
         ["forest", "farm", "village"], "wilds")


# ---- wildflowers (16x16, walk-over) -------------------------------------------------------------
def _wld_draw_wildflowers():
    img = S(16, 16)
    # stems
    vline(img, 3, 12, 15, GREEN)
    vline(img, 7, 13, 15, GREEN)
    vline(img, 11, 12, 15, GREEN)
    vline(img, 13, 14, 15, GREEN)
    vline(img, 5, 14, 15, GREEN)
    # leaves
    px(img, 2, 14, GREEN_D)
    px(img, 8, 14, GREEN_D)
    px(img, 12, 13, GREEN_D)
    # heads
    rect(img, 2, 10, 3, 11, YELLOW)
    rect(img, 6, 11, 7, 12, RED)
    rect(img, 11, 10, 12, 11, WHITE)
    px(img, 13, 13, YELLOW)
    px(img, 5, 13, WHITE)
    # ground tufts
    px(img, 1, 15, GREEN_D)
    px(img, 9, 15, GREEN_D)
    px(img, 14, 15, GREEN_D)
    return outline(img)

register("wildflowers", "prop", [_wld_draw_wildflowers()],
         "scattered wildflowers — yellow, red and white heads",
         ["forest", "farm", "village"], "wilds", blocks=False)


# ---- apple_tree (16x24) -------------------------------------------------------------------------
def _wld_draw_apple_tree():
    img = S(16, 24)
    crown = [(1, 5, 10), (2, 3, 12), (3, 2, 13), (4, 1, 14), (5, 1, 14), (6, 1, 14), (7, 1, 14),
             (8, 1, 14), (9, 2, 13), (10, 3, 12), (11, 5, 10)]
    _wld_fill_rows(img, crown, GREEN)
    for y, x0, x1 in crown:
        px(img, x1, y, GREEN_D)
        px(img, x1 - 1, y, GREEN_D)
        if y >= 10:
            hline(img, x0 + 2, x1, y, GREEN_D)
    for x, y in ((8, 5), (5, 7), (11, 8), (7, 9), (12, 4)):
        px(img, x, y, GREEN_D)
    for x, y in ((4, 2), (3, 3), (5, 1), (2, 4)):
        px(img, x, y, YELLOW)
    # apples
    for x, y in ((4, 4), (9, 3), (12, 6), (6, 7), (10, 9), (3, 7)):
        px(img, x, y, RED)
    # trunk
    for y in range(12, 24):
        px(img, 7, y, BROWN)
        px(img, 8, y, BRONZE_D)
    px(img, 6, 23, BROWN)
    px(img, 9, 23, BRONZE_D)
    return outline(img)

register("apple_tree", "prop", [_wld_draw_apple_tree()],
         "an apple tree, red fruit dotting the round crown",
         ["farm", "village", "forest"], "wilds")


# ---- scarecrow_field (16x24) --------------------------------------------------------------------
def _wld_draw_scarecrow_field():
    img = S(16, 24)
    # crossarm pole
    hline(img, 1, 14, 9, BROWN)
    # sack head
    head = [(2, 6, 9), (3, 5, 10), (4, 5, 10), (5, 5, 10), (6, 6, 9)]
    _wld_fill_rows(img, head, TAN)
    px(img, 7, 1, BRONZE_D)   # sack tie
    px(img, 8, 1, BRONZE_D)
    px(img, 6, 4, OUT)        # stitched eyes
    px(img, 9, 4, OUT)
    px(img, 7, 6, OUT)        # stitch mouth
    px(img, 10, 3, BROWN)     # head shade
    px(img, 10, 4, BROWN)
    px(img, 10, 5, BROWN)
    # coat body + sleeves
    rect(img, 5, 8, 10, 16, BROWN)
    rect(img, 2, 8, 4, 10, BROWN)
    rect(img, 11, 8, 13, 10, BROWN)
    for y in range(8, 17):
        px(img, 10, y, BRONZE_D)
    hline(img, 11, 13, 10, BRONZE_D)
    # patch on the coat
    rect(img, 6, 12, 7, 13, TAN)
    # straw hands + fringe
    vline(img, 1, 9, 10, YELLOW)
    vline(img, 14, 9, 10, YELLOW)
    for x in (5, 7, 9, 10):
        px(img, x, 17, YELLOW)
    px(img, 6, 18, YELLOW)
    # post down to the ground
    for y in range(17, 24):
        px(img, 7, y, BROWN)
        px(img, 8, y, BRONZE_D)
    return outline(img)

register("scarecrow_field", "prop", [_wld_draw_scarecrow_field()],
         "a scarecrow on a cross-pole — sack head, patched coat, straw fringe",
         ["farm"], "wilds")


# ---- hay_bale (16x16) ---------------------------------------------------------------------------
def _wld_draw_hay_bale():
    img = S(16, 16)
    face = [(0, 3, 6), (1, 1, 8), (2, 0, 9), (3, 0, 9), (4, 0, 9), (5, 0, 9), (6, 0, 9),
            (7, 0, 9), (8, 1, 8), (9, 3, 6)]
    x0, y0 = 1, 6
    for dy, a, b in face:
        hline(img, x0 + a, x0 + b, y0 + dy, YELLOW)
        # cylinder side behind the face
        xe = 13 if dy in (0, 9) else 14
        hline(img, x0 + b + 1, xe, y0 + dy, YELLOW)
        # rim arc separating face from side
        px(img, x0 + b, y0 + dy, BRONZE)
    # rolled spiral on the face (rings + heart)
    for x, y in ((5, 8), (6, 8), (3, 9), (8, 9), (2, 10), (9, 10), (2, 11), (9, 11),
                 (3, 12), (8, 12), (5, 13), (6, 13), (7, 10)):
        px(img, x, y, TAN)
    rect(img, 5, 10, 6, 11, TAN)
    # straw streaks along the side
    hline(img, 11, 13, 8, TAN)
    hline(img, 11, 14, 11, TAN)
    # shading: underside + right end
    hline(img, 10, 14, 14, BRONZE)
    hline(img, 8, 13, 15, BRONZE)
    px(img, 4, 15, BRONZE)
    px(img, 5, 15, BRONZE)
    vline(img, 14, 9, 13, BRONZE)
    return outline(img)

register("hay_bale", "prop", [_wld_draw_hay_bale()],
         "a rolled hay bale, spiral showing on the cut face",
         ["farm", "village"], "wilds")


# ---- wheat_shock (16x16) ------------------------------------------------------------------------
def _wld_draw_wheat_shock():
    img = S(16, 16)
    # ear-tip spikes fanning up
    for x, y in ((3, 4), (5, 3), (7, 2), (9, 3), (11, 4), (7, 3), (4, 4), (10, 4)):
        px(img, x, y, YELLOW)
    # fan of ears: WIDE at the top, pinching to the tie
    ears = [(4, 3, 12), (5, 3, 12), (6, 4, 11), (7, 5, 10), (8, 5, 10), (9, 6, 9)]
    _wld_fill_rows(img, ears, YELLOW)
    # grain flecks + right shade
    for x, y in ((6, 5), (9, 6), (7, 7), (5, 6), (10, 5), (8, 8), (11, 5), (12, 4), (10, 7)):
        px(img, x, y, BRONZE)
    # rope tie at the narrow waist
    hline(img, 6, 9, 10, BROWN)
    px(img, 6, 10, BRONZE_D)
    # flaring stalks below
    stalks = [(11, 5, 10), (12, 5, 10), (13, 4, 11), (14, 4, 11), (15, 3, 12)]
    _wld_fill_rows(img, stalks, TAN)
    vline(img, 6, 11, 15, BRONZE)
    vline(img, 9, 12, 15, BRONZE)
    px(img, 11, 13, BRONZE)
    px(img, 11, 14, BRONZE)
    px(img, 12, 15, BRONZE)
    return outline(img)

register("wheat_shock", "prop", [_wld_draw_wheat_shock()],
         "a tied standing sheaf of wheat",
         ["farm", "village"], "wilds")


# ---- beehive (16x16, slow bee) ------------------------------------------------------------------
def _wld_draw_beehive(shift=False):
    img = S(16, 16)
    dome = [(3, 6, 9), (4, 5, 10), (5, 4, 11), (6, 3, 12), (7, 3, 12), (8, 2, 13), (9, 2, 13),
            (10, 2, 13), (11, 2, 13), (12, 2, 13), (13, 2, 13), (14, 2, 13), (15, 3, 12)]
    _wld_fill_rows(img, dome, TAN)
    # coiled straw bands
    for y in (5, 8, 11, 14):
        x0, x1 = [r[1:] for r in dome if r[0] == y][0]
        hline(img, x0, x1, y, BRONZE)
    # light left, shade right
    for y, x0, x1 in dome:
        if y <= 9:
            px(img, x0, y, BONE)
        px(img, x1, y, BRONZE_D)
        if y >= 9:
            px(img, x1 - 1, y, BRONZE_D)
    # entrance
    rect(img, 7, 12, 8, 13, OUT)
    # the bee
    if shift:
        px(img, 13, 4, YELLOW)
    else:
        px(img, 14, 5, YELLOW)
    return outline(img)

register("beehive", "prop", [_wld_draw_beehive(False), _wld_draw_beehive(True)],
         "a straw skep beehive, one bee circling",
         ["farm", "village", "forest"], "wilds", fps=2)


# ---- stag (character 16x16) ---------------------------------------------------------------------
def _wld_draw_stag():
    img = S(16, 16)
    # two separated branched antlers, tips forking at the top edge
    for x, y in ((2, 3), (2, 2), (2, 1), (1, 0), (3, 0), (5, 3), (5, 2), (5, 1), (4, 0), (6, 0)):
        px(img, x, y, BONE)
    # head + muzzle (facing left)
    head = [(4, 2, 5), (5, 1, 5), (6, 1, 5), (7, 3, 5)]
    _wld_fill_rows(img, head, TAN)
    px(img, 6, 4, TAN)   # ear
    px(img, 3, 5, OUT)   # eye
    # neck + body
    _wld_fill_rows(img, [(7, 3, 7), (8, 4, 13), (9, 5, 13), (10, 5, 13), (11, 6, 13)], TAN)
    hline(img, 5, 12, 8, BONE)       # lit back
    hline(img, 6, 12, 11, BROWN)     # belly shade
    px(img, 13, 9, BROWN)
    px(img, 13, 10, BROWN)
    px(img, 14, 8, WHITE)            # tail
    # legs
    for lx in (5, 7, 11, 13):
        vline(img, lx, 12, 14, TAN)
        px(img, lx, 15, BROWN)
    return outline(img)

_wld_stag_f = _wld_draw_stag()
register("stag", "character", [_wld_stag_f, bob(_wld_stag_f)],
         "a wary stag, bone antlers raised",
         ["forest"], "wilds", fps=3)


# ---- hare (character 16x16) ---------------------------------------------------------------------
def _wld_draw_hare():
    img = S(16, 16)
    # two clearly separated ears
    rect(img, 3, 1, 4, 4, TAN)
    rect(img, 6, 2, 7, 5, TAN)
    px(img, 4, 1, BROWN)
    px(img, 7, 2, BROWN)
    # head + sitting body
    body = [(5, 3, 7), (6, 2, 7), (7, 2, 12), (8, 3, 13), (9, 4, 13), (10, 4, 13),
            (11, 4, 13), (12, 4, 13), (13, 4, 13), (14, 4, 12), (15, 3, 12)]
    _wld_fill_rows(img, body, TAN)
    px(img, 3, 6, OUT)     # eye
    px(img, 2, 7, WHITE)   # muzzle
    # haunch arc
    for x, y in ((11, 9), (10, 10), (10, 11), (10, 12), (11, 13)):
        px(img, x, y, BROWN)
    # belly + chest
    px(img, 5, 10, WHITE)
    px(img, 5, 11, WHITE)
    px(img, 6, 12, WHITE)
    # tail
    px(img, 14, 11, WHITE)
    # ground shade
    hline(img, 9, 12, 14, BROWN)
    return outline(img)

_wld_hare_f = _wld_draw_hare()
register("hare", "character", [_wld_hare_f, bob(_wld_hare_f)],
         "a brown hare sitting up, ears pricked",
         ["forest", "farm", "village"], "wilds", fps=3)


# ---- badger (character 16x16) -------------------------------------------------------------------
def _wld_draw_badger():
    img = S(16, 16)
    # low long body
    body = [(8, 6, 12), (9, 5, 13), (10, 5, 14), (11, 4, 14), (12, 4, 14), (13, 5, 13)]
    _wld_fill_rows(img, body, SLATE)
    # legs
    rect(img, 5, 13, 6, 15, SLATE)
    rect(img, 11, 13, 12, 15, SLATE)
    # white face with the black eye-stripe
    face = [(9, 2, 4), (10, 1, 4), (11, 0, 4), (12, 1, 4)]
    _wld_fill_rows(img, face, WHITE)
    hline(img, 1, 4, 10, OUT)   # stripe through the eye
    px(img, 0, 11, OUT)         # nose
    px(img, 4, 8, SLATE)        # ear
    # grizzled back
    hline(img, 6, 12, 8, GREY_L)
    for x, y in ((7, 9), (9, 9), (11, 9), (8, 10), (12, 10), (10, 11)):
        px(img, x, y, GREY_L)
    # short tail + belly shadow
    px(img, 15, 10, GREY_L)
    px(img, 15, 11, GREY_L)
    hline(img, 7, 13, 13, PLUM)
    return outline(img)

_wld_badger_f = _wld_draw_badger()
register("badger", "character", [_wld_badger_f, bob(_wld_badger_f)],
         "a badger, white face stripe over a slate body",
         ["forest", "farm"], "wilds", fps=3)

# ===== section: 13-structure.py (19 assets) =====
# =================================================================================================
# SECTION 13: RUINS / STRUCTURAL KIT — arches, broken walls, columns, bridges, fences, stairs
# =================================================================================================
_str_B = ["ruin", "dungeon", "town", "village"]


def _str_draw_arch_stone():
    img = S(32, 24)
    # arch band (outer curve painted, inner opening left transparent)
    hline(img, 11, 20, 2, GREY_L)          # crown catches the light
    hline(img, 8, 23, 3, GREY)
    hline(img, 6, 25, 4, GREY)
    hline(img, 5, 11, 5, GREY)
    hline(img, 20, 26, 5, GREY)
    hline(img, 4, 9, 6, GREY)
    hline(img, 22, 27, 6, GREY)
    hline(img, 4, 8, 7, GREY)
    hline(img, 23, 27, 7, GREY)
    # piers + plinth bases
    rect(img, 3, 8, 8, 20, GREY)
    rect(img, 23, 8, 28, 20, GREY)
    rect(img, 2, 21, 9, 23, GREY)
    rect(img, 22, 21, 29, 23, GREY)
    # light from the top-left
    px(img, 8, 3, GREY_L)
    px(img, 9, 3, GREY_L)
    px(img, 10, 3, GREY_L)
    px(img, 6, 4, GREY_L)
    px(img, 7, 4, GREY_L)
    px(img, 5, 5, GREY_L)
    px(img, 4, 6, GREY_L)
    vline(img, 3, 8, 20, GREY_L)
    vline(img, 2, 21, 22, GREY_L)
    hline(img, 2, 9, 21, GREY_L)
    hline(img, 22, 29, 21, GREY_L)
    # shadow right side
    px(img, 23, 3, SLATE)
    px(img, 25, 4, SLATE)
    px(img, 26, 5, SLATE)
    px(img, 27, 6, SLATE)
    px(img, 27, 7, SLATE)
    vline(img, 28, 8, 20, SLATE)
    vline(img, 29, 22, 23, SLATE)
    # soffit shadow over the opening + inner-curve shade
    hline(img, 12, 19, 4, SLATE)
    px(img, 11, 5, SLATE)
    px(img, 20, 5, SLATE)
    px(img, 9, 6, SLATE)
    px(img, 22, 6, SLATE)
    px(img, 8, 7, SLATE)
    px(img, 23, 7, SLATE)
    # keystone (over the soffit line)
    rect(img, 14, 2, 17, 4, GREY_L)
    vline(img, 13, 2, 4, SLATE)
    vline(img, 18, 2, 4, SLATE)
    # masonry courses on the piers
    for y in (11, 15, 18):
        hline(img, 4, 8, y, SLATE)
        hline(img, 23, 27, y, SLATE)
    px(img, 6, 13, SLATE)
    px(img, 5, 16, SLATE)
    px(img, 25, 13, SLATE)
    px(img, 26, 16, SLATE)
    # a little moss on the old stone
    px(img, 4, 19, GREEN_D)
    px(img, 24, 12, GREEN_D)
    return outline(img)


def _str_draw_wall_ruin_stub():
    img = S(16, 16)
    tops = [7, 6, 6, 9, 9, 9, 4, 4, 5, 7, 8, 8, 10, 10, 12, 12]
    for x in range(16):
        vline(img, x, tops[x], 15, GREY)
        px(img, x, tops[x], GREY_L)
    # weathered low end sits in shadow
    vline(img, 14, 13, 15, SLATE)
    vline(img, 15, 13, 15, SLATE)
    # masonry courses only where the wall still stands
    for y in (8, 11, 14):
        for x in range(16):
            if tops[x] < y:
                px(img, x, y, SLATE)
    # staggered head joints
    for jx, jy in ((3, 9), (3, 10), (9, 9), (9, 10), (6, 12), (6, 13), (13, 12), (13, 13), (2, 15), (11, 15)):
        px(img, jx, jy, SLATE)
    # crack down from the break + moss
    px(img, 7, 6, PLUM)
    px(img, 7, 7, PLUM)
    px(img, 1, 14, GREEN_D)
    px(img, 10, 12, GREEN_D)
    px(img, 5, 15, GREEN_D)
    return outline(img)


def _str_draw_wall_ruin_corner():
    img = S(16, 16)
    # vertical arm runs off the bottom edge
    rect(img, 0, 0, 6, 15, GREY)
    # horizontal arm with a jagged broken right end
    rect(img, 7, 0, 9, 6, GREY)
    vline(img, 10, 0, 4, GREY)
    vline(img, 11, 0, 5, GREY)
    vline(img, 12, 0, 2, GREY)
    vline(img, 13, 0, 3, GREY)
    # light: top edge + left edge
    hline(img, 0, 13, 0, GREY_L)
    vline(img, 0, 1, 15, GREY_L)
    # broken-end shade + underside shadow
    px(img, 10, 4, SLATE)
    px(img, 11, 5, SLATE)
    px(img, 12, 2, SLATE)
    px(img, 13, 3, SLATE)
    hline(img, 7, 9, 6, SLATE)
    vline(img, 6, 7, 15, SLATE)
    # masonry courses + staggered joints
    hline(img, 1, 11, 3, SLATE)
    for y in (7, 10, 13):
        hline(img, 1, 5, y, SLATE)
    for jx, jy in ((3, 1), (3, 2), (8, 4), (8, 5), (3, 8), (3, 9), (2, 11), (2, 12), (4, 14), (4, 15)):
        px(img, jx, jy, SLATE)
    # moss
    px(img, 1, 13, GREEN_D)
    px(img, 8, 2, GREEN_D)
    return outline(img)


def _str_draw_column_intact():
    img = S(16, 24)
    # capital
    hline(img, 3, 12, 1, GREY_L)
    hline(img, 3, 12, 2, GREY)
    px(img, 3, 2, GREY_L)
    px(img, 12, 2, SLATE)
    rect(img, 4, 3, 11, 4, GREY)
    px(img, 4, 3, GREY_L)
    vline(img, 11, 3, 4, SLATE)
    # shadow tucked under the capital
    hline(img, 5, 10, 5, SLATE)
    # fluted shaft: alternating ridges, cylinder shade on the right
    for fx, fc in ((5, GREY_L), (6, GREY), (7, GREY_L), (8, GREY), (9, SLATE), (10, SLATE)):
        vline(img, fx, 6, 19, fc)
    # chipped flute
    px(img, 5, 9, GREY)
    px(img, 5, 10, GREY)
    # stepped base
    hline(img, 4, 11, 20, GREY_L)
    hline(img, 4, 11, 21, GREY)
    px(img, 11, 21, SLATE)
    hline(img, 3, 12, 22, GREY_L)
    hline(img, 3, 12, 23, GREY)
    px(img, 12, 22, SLATE)
    px(img, 12, 23, SLATE)
    # moss
    px(img, 10, 16, GREEN_D)
    return outline(img)


def _str_draw_column_broken():
    img = S(16, 16)
    # snapped shaft, jagged break line
    for fx, ft, fc in ((5, 6, GREY_L), (6, 4, GREY), (7, 7, GREY_L), (8, 5, GREY), (9, 8, SLATE), (10, 9, SLATE)):
        vline(img, fx, ft, 11, fc)
        px(img, fx, ft, GREY_L if fc != SLATE else GREY)
    # stepped base
    hline(img, 4, 11, 12, GREY_L)
    hline(img, 4, 11, 13, GREY)
    px(img, 11, 13, SLATE)
    hline(img, 3, 12, 14, GREY_L)
    hline(img, 3, 12, 15, GREY)
    px(img, 12, 14, SLATE)
    px(img, 12, 15, SLATE)
    # fallen drum fragment + scattered debris
    rect(img, 14, 13, 15, 15, GREY)
    px(img, 14, 13, GREY_L)
    px(img, 15, 15, SLATE)
    px(img, 0, 15, SLATE)
    px(img, 1, 15, GREY)
    # moss in the break
    px(img, 9, 11, GREEN_D)
    return outline(img)


def _str_draw_bridge_plank_h():
    img = S(16, 16)
    # plank deck spanning left-right (seams cut the planks)
    rect(img, 0, 4, 15, 11, BROWN)
    hline(img, 0, 15, 4, TAN)
    hline(img, 0, 15, 11, BRONZE_D)
    for sx in (3, 7, 11):
        vline(img, sx, 4, 11, PLUM)
    # sagging rope rails
    for x in range(16):
        ytop = 1 if (x < 4 or x > 11) else 2
        ybot = 13 if (x < 4 or x > 11) else 14
        px(img, x, ytop, TAN)
        px(img, x, ybot, TAN)
    px(img, 6, 2, BROWN)
    px(img, 10, 2, BROWN)
    px(img, 6, 14, BROWN)
    px(img, 10, 14, BROWN)
    # corner posts
    rect(img, 0, 0, 1, 2, BROWN)
    hline(img, 0, 1, 0, TAN)
    rect(img, 14, 0, 15, 2, BROWN)
    hline(img, 14, 15, 0, TAN)
    rect(img, 0, 13, 1, 15, BROWN)
    hline(img, 0, 1, 13, TAN)
    rect(img, 14, 13, 15, 15, BROWN)
    hline(img, 14, 15, 13, TAN)
    return outline(img)


def _str_draw_bridge_plank_v():
    img = S(16, 16)
    # plank deck spanning top-bottom
    rect(img, 4, 0, 11, 15, BROWN)
    vline(img, 4, 0, 15, TAN)
    vline(img, 11, 0, 15, BRONZE_D)
    for sy in (3, 7, 11):
        hline(img, 4, 11, sy, PLUM)
    # bowed rope rails
    for y in range(16):
        xl = 1 if (y < 4 or y > 11) else 2
        xr = 14 if (y < 4 or y > 11) else 13
        px(img, xl, y, TAN)
        px(img, xr, y, TAN)
    px(img, 2, 6, BROWN)
    px(img, 2, 9, BROWN)
    px(img, 13, 6, BROWN)
    px(img, 13, 9, BROWN)
    # corner posts
    rect(img, 0, 0, 2, 1, BROWN)
    hline(img, 0, 2, 0, TAN)
    rect(img, 13, 0, 15, 1, BROWN)
    hline(img, 13, 15, 0, TAN)
    rect(img, 0, 14, 2, 15, BROWN)
    hline(img, 0, 2, 14, TAN)
    rect(img, 13, 14, 15, 15, BROWN)
    hline(img, 13, 15, 14, TAN)
    return outline(img)


def _str_draw_stepping_stones():
    img = S(16, 16)
    # three flat rounded stones, staggered diagonally
    hline(img, 3, 5, 1, GREY_L)
    hline(img, 2, 6, 2, GREY)
    hline(img, 2, 6, 3, GREY)
    hline(img, 3, 5, 4, SLATE)
    px(img, 2, 2, GREY_L)
    hline(img, 7, 10, 6, GREY_L)
    hline(img, 6, 11, 7, GREY)
    hline(img, 6, 11, 8, GREY)
    hline(img, 6, 11, 9, GREY)
    hline(img, 7, 10, 10, SLATE)
    px(img, 6, 7, GREY_L)
    px(img, 11, 9, SLATE)
    hline(img, 4, 7, 11, GREY_L)
    hline(img, 3, 8, 12, GREY)
    hline(img, 3, 8, 13, GREY)
    hline(img, 3, 8, 14, GREY)
    hline(img, 4, 7, 15, SLATE)
    px(img, 3, 12, GREY_L)
    px(img, 8, 14, SLATE)
    return outline(img)


def _str_draw_fence_wood_h():
    img = S(16, 16)
    # two split rails running full width
    rect(img, 0, 5, 15, 6, BROWN)
    hline(img, 0, 15, 5, TAN)
    rect(img, 0, 10, 15, 11, BROWN)
    hline(img, 0, 15, 10, TAN)
    px(img, 0, 6, BRONZE_D)
    px(img, 15, 6, BRONZE_D)
    px(img, 0, 11, BRONZE_D)
    px(img, 15, 11, BRONZE_D)
    # posts in front, feet on the ground
    rect(img, 2, 3, 3, 15, BROWN)
    vline(img, 2, 3, 15, TAN)
    px(img, 3, 3, TAN)
    rect(img, 12, 3, 13, 15, BROWN)
    vline(img, 12, 3, 15, TAN)
    px(img, 13, 3, TAN)
    px(img, 3, 15, BRONZE_D)
    px(img, 13, 15, BRONZE_D)
    return outline(img)


def _str_draw_fence_wood_v():
    img = S(16, 16)
    # two rails running full height
    rect(img, 5, 0, 6, 15, BROWN)
    vline(img, 5, 0, 15, TAN)
    rect(img, 9, 0, 10, 15, BROWN)
    vline(img, 9, 0, 15, TAN)
    # cross post seen side-on
    rect(img, 3, 7, 12, 9, BROWN)
    hline(img, 3, 12, 7, TAN)
    hline(img, 3, 12, 9, BRONZE_D)
    px(img, 12, 8, BRONZE_D)
    return outline(img)


def _str_draw_fence_post():
    img = S(16, 16)
    rect(img, 6, 4, 9, 15, BROWN)
    vline(img, 6, 4, 15, TAN)
    vline(img, 9, 5, 15, BRONZE_D)
    hline(img, 6, 9, 4, TAN)
    # knots + ground shadow
    px(img, 8, 8, BRONZE_D)
    px(img, 7, 12, BRONZE_D)
    px(img, 9, 15, PLUM)
    return outline(img)


def _str_draw_gate_wood():
    img = S(16, 16)
    # frame: lintel + posts
    hline(img, 0, 15, 1, TAN)
    hline(img, 0, 15, 2, BROWN)
    rect(img, 0, 3, 2, 15, BROWN)
    vline(img, 0, 3, 15, TAN)
    rect(img, 13, 3, 15, 15, BROWN)
    vline(img, 13, 3, 15, TAN)
    px(img, 2, 15, BRONZE_D)
    px(img, 15, 15, BRONZE_D)
    # double gate leaves
    rect(img, 3, 5, 12, 14, BROWN)
    hline(img, 3, 12, 5, TAN)
    vline(img, 8, 5, 14, PLUM)          # the split between the leaves
    vline(img, 5, 6, 14, BRONZE_D)      # plank seams
    vline(img, 11, 6, 14, BRONZE_D)
    hline(img, 3, 7, 9, BRONZE_D)       # battens
    hline(img, 9, 12, 9, BRONZE_D)
    # hinges + handles
    px(img, 3, 6, SLATE)
    px(img, 3, 12, SLATE)
    px(img, 12, 6, SLATE)
    px(img, 12, 12, SLATE)
    px(img, 7, 11, SLATE)
    px(img, 9, 11, SLATE)
    return outline(img)


def _str_draw_stairs_stone():
    img = S(16, 16)
    # four treads descending toward the bottom, each with a lit nosing + riser shadow
    rect(img, 0, 0, 15, 3, GREY_L)
    hline(img, 0, 15, 0, WHITE)
    hline(img, 0, 15, 3, GREY)
    rect(img, 0, 4, 15, 7, GREY)
    hline(img, 0, 15, 4, GREY_L)
    hline(img, 0, 15, 7, SLATE)
    rect(img, 0, 8, 15, 11, SLATE)
    hline(img, 0, 15, 8, GREY)
    hline(img, 0, 15, 11, PLUM)
    rect(img, 0, 12, 15, 15, PLUM)
    hline(img, 0, 15, 12, SLATE)
    # worn cracks
    px(img, 5, 2, GREY)
    px(img, 11, 6, SLATE)
    px(img, 3, 10, PLUM)
    px(img, 9, 14, OUT)
    return outline(img)


def _str_draw_ladder_wood():
    img = S(16, 16)
    # rungs
    for ry in (2, 5, 8, 11, 14):
        hline(img, 5, 10, ry, TAN)
        hline(img, 5, 10, ry + 1, BROWN)
    # side rails over the rung ends
    rect(img, 3, 0, 4, 15, BROWN)
    vline(img, 3, 0, 15, TAN)
    rect(img, 11, 0, 12, 15, BROWN)
    vline(img, 11, 0, 15, TAN)
    return outline(img)


def _str_draw_platform_wood():
    img = S(16, 16)
    # raised decking: four plank courses with staggered butt joints
    rect(img, 0, 0, 15, 15, BROWN)
    for py in (0, 4, 8, 12):
        hline(img, 0, 15, py, TAN)
    for py in (3, 7, 11, 15):
        hline(img, 0, 15, py, BRONZE_D)
    for jx, jy in ((9, 0), (4, 4), (12, 8), (6, 12)):
        vline(img, jx, jy, jy + 3, BRONZE_D)
    # nail heads
    px(img, 1, 1, SLATE)
    px(img, 14, 5, SLATE)
    px(img, 2, 9, SLATE)
    px(img, 13, 13, SLATE)
    return outline(img)


def _str_draw_rubble_pile():
    img = S(16, 16)
    # left chunk catches the light
    rect(img, 1, 9, 6, 15, GREY)
    hline(img, 1, 6, 9, GREY_L)
    vline(img, 1, 10, 15, GREY_L)
    vline(img, 6, 13, 15, SLATE)
    # right chunk sits in shadow
    rect(img, 9, 11, 14, 15, SLATE)
    hline(img, 9, 14, 11, GREY)
    px(img, 9, 11, GREY_L)
    # centre chunk stacked on top
    rect(img, 5, 7, 10, 12, GREY)
    hline(img, 5, 10, 7, GREY_L)
    px(img, 5, 8, GREY_L)
    vline(img, 10, 8, 12, SLATE)
    # capstone offset to the lit side
    rect(img, 4, 4, 7, 6, GREY_L)
    vline(img, 7, 4, 6, GREY)
    hline(img, 4, 7, 6, GREY)
    # small stone on the shadow side
    rect(img, 11, 9, 13, 10, GREY)
    px(img, 11, 9, GREY_L)
    px(img, 13, 10, SLATE)
    # snapped roof beam poking out of the heap
    px(img, 10, 6, BROWN)
    px(img, 11, 5, BROWN)
    px(img, 11, 6, BRONZE_D)
    px(img, 12, 4, TAN)
    # dark crevice between the chunks + scattered debris
    rect(img, 7, 13, 8, 15, PLUM)
    px(img, 0, 15, SLATE)
    px(img, 15, 15, SLATE)
    # cracks + moss
    px(img, 3, 12, PLUM)
    px(img, 12, 13, PLUM)
    px(img, 2, 10, GREEN_D)
    px(img, 9, 12, GREEN_D)
    return outline(img)


def _str_draw_statue_weathered():
    img = S(16, 24)
    # plinth
    rect(img, 3, 20, 12, 23, GREY)
    hline(img, 3, 12, 20, GREY_L)
    vline(img, 12, 21, 23, SLATE)
    hline(img, 3, 12, 23, SLATE)
    px(img, 3, 21, GREY_L)
    px(img, 3, 22, GREY_L)
    # hood (narrower than the shoulders so the figure tapers)
    hline(img, 7, 9, 2, GREY)
    px(img, 7, 2, GREY_L)
    rect(img, 6, 3, 10, 7, GREY)
    px(img, 6, 3, GREY_L)
    px(img, 6, 4, GREY_L)
    px(img, 6, 5, GREY_L)
    vline(img, 10, 3, 7, SLATE)
    px(img, 5, 6, GREY)
    px(img, 5, 7, GREY)
    px(img, 11, 6, SLATE)
    px(img, 11, 7, SLATE)
    # the hollow of the hood
    rect(img, 7, 4, 9, 6, PLUM)
    # shoulders + torso
    rect(img, 5, 8, 10, 11, GREY)
    vline(img, 5, 8, 11, GREY_L)
    vline(img, 10, 8, 11, SLATE)
    # praying hands catching the light
    rect(img, 7, 10, 8, 11, GREY_L)
    # robe skirt flaring to the plinth
    rect(img, 4, 12, 11, 19, GREY)
    vline(img, 4, 12, 19, GREY_L)
    vline(img, 11, 12, 19, SLATE)
    vline(img, 8, 13, 18, SLATE)
    hline(img, 4, 11, 19, SLATE)
    # weather pits + moss flecks
    px(img, 6, 15, SLATE)
    px(img, 9, 16, SLATE)
    px(img, 10, 9, GREEN_D)
    px(img, 4, 13, GREEN_D)
    px(img, 4, 14, GREEN)
    px(img, 5, 18, GREEN_D)
    px(img, 3, 21, GREEN_D)
    px(img, 11, 22, GREEN_D)
    return outline(img)


register("arch_stone", "prop", [_str_draw_arch_stone()],
         "a freestanding grey stone archway with a keystone — tokens pass beneath",
         _str_B, "structure", footW=2, footH=1, blocks=False)
register("wall_ruin_stub", "prop", [_str_draw_wall_ruin_stub()],
         "a broken wall stump with a jagged top and mossy masonry",
         _str_B, "structure", blocks=True)
register("wall_ruin_corner", "prop", [_str_draw_wall_ruin_corner()],
         "an L-corner wall stub, one arm snapped off jagged",
         _str_B, "structure", blocks=True)
register("column_intact", "prop", [_str_draw_column_intact()],
         "an intact fluted stone column with capital and stepped base",
         _str_B, "structure", blocks=True)
register("column_broken", "prop", [_str_draw_column_broken()],
         "a snapped column shaft with a fallen drum fragment",
         _str_B, "structure", blocks=True)
register("bridge_plank_h", "prop", [_str_draw_bridge_plank_h()],
         "a plank footbridge spanning left-right with sagging rope rails",
         _str_B, "structure", blocks=False, platform=True)
register("bridge_plank_v", "prop", [_str_draw_bridge_plank_v()],
         "a plank footbridge spanning top-bottom with rope rails",
         _str_B, "structure", blocks=False, platform=True)
register("stepping_stones", "prop", [_str_draw_stepping_stones()],
         "three flat stepping stones staggered across the tile",
         _str_B, "structure", blocks=False, platform=True)
register("fence_wood_h", "prop", [_str_draw_fence_wood_h()],
         "a split-rail wooden fence running left-right",
         _str_B, "structure", blocks=True)
register("fence_wood_v", "prop", [_str_draw_fence_wood_v()],
         "a split-rail wooden fence running top-bottom",
         _str_B, "structure", blocks=True)
register("fence_post", "prop", [_str_draw_fence_post()],
         "a single weathered fence post with knots",
         _str_B, "structure", blocks=True)
register("gate_wood", "prop", [_str_draw_gate_wood()],
         "a hinged double wooden gate set in a post-and-lintel frame",
         _str_B, "structure", blocks=True)
register("stairs_stone", "prop", [_str_draw_stairs_stone()],
         "stone steps descending into shadow, lit nosings",
         _str_B, "structure", blocks=False)
register("ladder_wood", "prop", [_str_draw_ladder_wood()],
         "a wooden ladder with five rungs",
         _str_B, "structure", blocks=False)
register("platform_wood", "prop", [_str_draw_platform_wood()],
         "raised wooden decking with staggered plank joints and nail heads",
         _str_B, "structure", blocks=False, platform=True)
register("rubble_pile", "prop", [_str_draw_rubble_pile()],
         "a heap of grey and slate masonry chunks with a snapped beam",
         _str_B, "structure", blocks=True)
register("statue_weathered", "prop", [_str_draw_statue_weathered()],
         "a weathered hooded stone figure on a plinth, moss-flecked",
         _str_B, "structure", blocks=True)

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

# ===== section: 7-foundation.py (124 assets) =====
# =================================================================================================
# FOUNDATION (batch 2) — BIOME TERRAIN FAMILIES, generated from two generic stampers so every
# family knits identically. Ground families follow the grass/water EDGED suffix convention
# (base + _t/_b/_l/_r/_tl/_tr/_bl/_br); wall families follow the wall/wall_wood convention consumed
# by wallTagFor. All full-bleed 16x16, no outline, no transparency.
# =================================================================================================
EDGE_SUFFIXES = ["t", "b", "l", "r", "tl", "tr", "bl", "br"]

def edged_family(name, texture_fn, lit, shadow, desc, biomes, walkable=True):
    """Stamp a 9-tile EDGED ground family: texture_fn paints the centre; edges add a lit band
    (top/left) or shadow band (bottom/right) OVER the same texture so tiles knit with the centre."""
    def tile(suffix=None):
        img = S(16, 16)
        texture_fn(img)
        if suffix:
            if suffix in ("t", "tl", "tr"):
                hline(img, 0, 15, 0, lit)
                for x in range(0, 16, 3):
                    px(img, x, 1, lit)
            if suffix in ("b", "bl", "br"):
                hline(img, 0, 15, 15, shadow)
                for x in range(1, 16, 3):
                    px(img, x, 14, shadow)
            if suffix in ("l", "tl", "bl"):
                vline(img, 0, 0, 15, lit)
                for y in range(0, 16, 3):
                    px(img, 1, y, lit)
            if suffix in ("r", "tr", "br"):
                vline(img, 15, 0, 15, shadow)
                for y in range(1, 16, 3):
                    px(img, 14, y, shadow)
        return img
    register(name, "terrain", [tile()], desc, biomes, "terrain2", walkable=walkable)
    for sfx in EDGE_SUFFIXES:
        register(name + "_" + sfx, "terrain", [tile(sfx)], desc + " (" + sfx + " edge)", biomes, "terrain2", walkable=walkable)

def wall_family(name, face, face_lit, face_dark, mortar, desc, biomes):
    """Stamp a 9-tile WALL family (the wall/wall_wood suffix convention wallTagFor consumes):
    a coursed block face; edge tiles get a cap highlight / footing shadow."""
    def tile(suffix=None):
        img = S(16, 16)
        rect(img, 0, 0, 15, 15, face)
        for y in (3, 7, 11, 15):
            hline(img, 0, 15, y, mortar)
        for row, off in ((0, 5), (4, 10), (8, 3), (12, 8)):
            vline(img, off, row, row + 2, mortar)
            vline(img, (off + 8) % 16, row, row + 2, mortar)
        for x, y in ((2, 1), (9, 5), (5, 9), (12, 13)):
            px(img, x, y, face_lit)
        for x, y in ((13, 2), (4, 6), (10, 10), (2, 14)):
            px(img, x, y, face_dark)
        if suffix:
            if suffix in ("t", "tl", "tr"):
                hline(img, 0, 15, 0, face_lit)
                hline(img, 0, 15, 1, face_lit)
            if suffix in ("b", "bl", "br"):
                hline(img, 0, 15, 15, OUT)
                hline(img, 0, 15, 14, face_dark)
            if suffix in ("l", "tl", "bl"):
                vline(img, 0, 0, 15, face_lit)
            if suffix in ("r", "tr", "br"):
                vline(img, 15, 0, 15, face_dark)
        return img
    register(name, "terrain", [tile()], desc, biomes, "terrain2", walkable=False)
    for sfx in EDGE_SUFFIXES:
        register(name + "_" + sfx, "terrain", [tile(sfx)], desc + " (" + sfx + ")", biomes, "terrain2", walkable=False)

def _tx_snow(img):
    rect(img, 0, 0, 15, 15, WHITE)
    for x, y in ((2, 3), (7, 1), (12, 4), (4, 8), (10, 9), (14, 12), (1, 13), (8, 14), (13, 7), (5, 5)):
        px(img, x, y, GREY_L)
    for x, y in ((6, 11), (11, 2), (3, 6)):
        px(img, x, y, CYAN)

def _tx_ice(img):
    rect(img, 0, 0, 15, 15, CYAN)
    for i in range(5):
        px(img, 2 + i, 3 + i, WHITE)
        px(img, 9 + i, 8 + i, BLUE)
    for x, y in ((12, 2), (4, 12), (14, 10), (1, 8)):
        px(img, x, y, WHITE)
    for x, y in ((7, 5), (10, 13), (3, 1)):
        px(img, x, y, BLUE)

def _tx_swamp(img):
    rect(img, 0, 0, 15, 15, GREEN_DD)
    for x in range(0, 16, 5):
        hline(img, x, min(15, x + 2), (x * 7) % 16, GREEN_D)
    for x, y in ((3, 4), (11, 7), (6, 12), (13, 2)):
        px(img, x, y, GREEN)
    px(img, 8, 9, NAVY)

def _tx_mud(img):
    rect(img, 0, 0, 15, 15, BRONZE_D)
    for x, y in ((2, 2), (8, 4), (13, 8), (5, 10), (10, 13), (1, 7), (14, 3)):
        px(img, x, y, BROWN)
    for x, y in ((4, 6), (11, 11), (7, 1)):
        px(img, x, y, PLUM)
    hline(img, 3, 6, 13, PLUM)

def _tx_ash(img):
    rect(img, 0, 0, 15, 15, SLATE)
    for x, y in ((2, 5), (9, 2), (13, 6), (6, 9), (11, 12), (3, 14)):
        px(img, x, y, GREY)
    for x, y in ((7, 7), (14, 11)):
        px(img, x, y, ORANGE)
    px(img, 1, 2, GREY_L)

def _tx_blight(img):
    rect(img, 0, 0, 15, 15, PLUM)
    for x, y in ((3, 3), (10, 5), (6, 11), (13, 13), (1, 9)):
        px(img, x, y, PURPLE)
    px(img, 8, 8, PURPLE)
    px(img, 9, 8, PURPLE)
    for x, y in ((5, 7), (12, 2)):
        px(img, x, y, GREEN_DD)

def _tx_sand2(img):
    rect(img, 0, 0, 15, 15, BONE)
    for y in (3, 9, 14):
        for x in range(0, 16, 4):
            px(img, x + (y % 3), y, BRONZE)
            px(img, x + (y % 3) + 1, y, BONE_D)
    for x, y in ((6, 6), (12, 11), (2, 12)):
        px(img, x, y, WHITE)

def _tx_farmland(img):
    rect(img, 0, 0, 15, 15, BROWN)
    for y in range(1, 16, 4):
        hline(img, 0, 15, y, BRONZE_D)
        for x in range(0, 16, 2):
            px(img, x + (y % 4) // 2, y + 1, BRONZE)
    for x, y in ((4, 3), (11, 7), (7, 11), (13, 15)):
        px(img, x, y, GREEN_D)

edged_family("snow", _tx_snow, WHITE, GREY_L, "wind-packed snowfield", ["arctic", "mountain"], walkable=True)
edged_family("ice", _tx_ice, WHITE, NAVY, "cracked lake ice", ["arctic"], walkable=True)
edged_family("swamp", _tx_swamp, GREEN_D, OUT, "black bog-water", ["swamp", "fen"], walkable=False)
edged_family("mud", _tx_mud, BROWN, PLUM, "sucking wet mud", ["swamp", "riverbank"], walkable=True)
edged_family("ash", _tx_ash, GREY, OUT, "volcanic ash and cinders", ["volcanic"], walkable=True)
edged_family("blight", _tx_blight, PURPLE, OUT, "corrupted, cursed ground", ["blight", "cursed"], walkable=True)
edged_family("sand", _tx_sand2, WHITE, BRONZE, "wind-rippled desert sand", ["desert", "coast"], walkable=True)
edged_family("farmland", _tx_farmland, TAN, PLUM, "tilled furrows, seedlings showing", ["farm", "village"], walkable=True)

wall_family("wall_sandstone", ORANGE, TAN, BRONZE, BRONZE_D, "sun-baked sandstone blocks", ["desert", "ruin"])
wall_family("wall_moss", GREY, GREEN, SLATE, GREEN_DD, "old stone swallowed by moss", ["ruin", "forest"])
wall_family("wall_obsidian", PLUM, PURPLE, OUT, OUT, "volcanic glass, knapped and mortared", ["volcanic", "dungeon"])
wall_family("wall_bone", BONE, WHITE, BONE_D, BONE_D, "a wall mortared from stacked bones", ["crypt", "necropolis"])
wall_family("wall_ice", CYAN, WHITE, BLUE, NAVY, "blue glacier ice, cut in blocks", ["arctic"])

def _floor(tag, painter, desc, biomes, walkable=True):
    img = S(16, 16)
    painter(img)
    register(tag, "terrain", [img], desc, biomes, "terrain2", walkable=walkable)

def _tx_marble(img):
    rect(img, 0, 0, 15, 15, WHITE)
    for i in range(4):
        px(img, 3 + i * 3, 2 + i * 4, GREY_L)
        px(img, 4 + i * 3, 3 + i * 4, GREY_L)
    hline(img, 0, 15, 7, GREY_L)
    vline(img, 7, 0, 15, GREY_L)

def _tx_marble_dark(img):
    rect(img, 0, 0, 15, 15, SLATE)
    for i in range(4):
        px(img, 2 + i * 4, 3 + i * 3, GREY)
        px(img, 3 + i * 4, 4 + i * 3, GREY)
    hline(img, 0, 15, 7, OUT)
    vline(img, 7, 0, 15, OUT)

def _tx_sandstone_floor(img):
    rect(img, 0, 0, 15, 15, ORANGE)
    for y in (5, 11):
        hline(img, 0, 15, y, BRONZE)
    vline(img, 5, 0, 5, BRONZE)
    vline(img, 11, 6, 11, BRONZE)
    vline(img, 3, 12, 15, BRONZE)
    for x, y in ((2, 2), (9, 8), (13, 13)):
        px(img, x, y, TAN)

def _tx_obsidian_floor(img):
    rect(img, 0, 0, 15, 15, PLUM)
    hline(img, 0, 15, 7, OUT)
    vline(img, 7, 0, 7, OUT)
    vline(img, 11, 8, 15, OUT)
    for x, y in ((3, 3), (10, 6), (6, 12), (13, 2), (1, 9)):
        px(img, x, y, PURPLE)
    for x, y in ((5, 10), (14, 13), (9, 1)):
        px(img, x, y, SLATE)

def _tx_moss_floor(img):
    rect(img, 0, 0, 15, 15, GREY)
    for y in (5, 11):
        hline(img, 0, 15, y, SLATE)
    for x, y in ((2, 2), (7, 7), (12, 3), (4, 13), (10, 12), (14, 8), (1, 6)):
        px(img, x, y, GREEN_D)
    for x, y in ((3, 2), (11, 12), (13, 8)):
        px(img, x, y, GREEN)

_floor("marble", _tx_marble, "veined white marble", ["temple", "palace"])
_floor("marble_dark", _tx_marble_dark, "veined black marble", ["temple", "crypt"])
_floor("sandstone_floor", _tx_sandstone_floor, "worn sandstone paving", ["desert", "ruin"])
_floor("obsidian_floor", _tx_obsidian_floor, "polished volcanic glass underfoot", ["volcanic", "dungeon"])
_floor("moss_floor", _tx_moss_floor, "flagstones furred with moss", ["ruin", "forest"])

# ===== section: 8-arctic.py (18 assets) =====
# =================================================================================================
# ARCTIC / TUNDRA KIT — ice, snow, frozen flora, and the beasts that survive it
# =================================================================================================

_ARC_BIOMES = ["arctic", "mountain"]


def _arc_draw_ice_spike():
    img = S(16, 24)
    profile = [
        (7, 7), (7, 8), (6, 8), (6, 9), (7, 9), (6, 10), (6, 10), (5, 10),
        (5, 11), (6, 11), (5, 11), (5, 12), (4, 12), (4, 12), (4, 13), (3, 13),
        (4, 13), (3, 13), (3, 12), (3, 12), (4, 11), (4, 11),
    ]
    for i, (x0, x1) in enumerate(profile):
        y = 2 + i
        hline(img, x0, x1, y, CYAN)
        px(img, x0, y, WHITE)                 # lit left facet
        if x1 - x0 >= 3:
            px(img, x1, y, BLUE)              # shaded right edge
            px(img, x1 - 1, y, BLUE)
        if i < 8 and x1 - x0 >= 2:
            px(img, x0 + 1, y, WHITE)         # wider lit facet near the tip
    vline(img, 9, 10, 23, BLUE)               # core shadow vein
    vline(img, 8, 15, 23, BLUE)
    px(img, 5, 12, WHITE)                     # facet sparkles
    px(img, 6, 17, WHITE)
    return outline(img)


register("ice_spike", "prop", [_arc_draw_ice_spike()],
         "a jagged translucent ice spike, man-high", _ARC_BIOMES, "arctic")


def _arc_tri(img, apex_x, apex_y, base_y, spread_l, spread_r):
    """A small ice shard: apex widening to a base, lit left facet, shaded right."""
    h = base_y - apex_y
    for i in range(h + 1):
        y = apex_y + i
        x0 = apex_x - (i * spread_l) // h
        x1 = apex_x + (i * spread_r) // h
        hline(img, x0, x1, y, CYAN)
        if i <= (2 * h) // 3:
            px(img, x0, y, WHITE)          # lit facet on the upper left only
        if x1 - x0 >= 2 and i >= h // 3:
            px(img, x1, y, BLUE)           # shade the lower right only
    px(img, apex_x, apex_y, WHITE)


def _arc_draw_ice_spikes():
    img = S(16, 16)
    _arc_tri(img, 8, 3, 15, 3, 3)     # centre, tallest
    _arc_tri(img, 3, 7, 15, 2, 2)     # left
    _arc_tri(img, 13, 9, 15, 2, 1)    # right
    vline(img, 8, 11, 15, BLUE)       # core shadow in the centre shard
    px(img, 3, 10, WHITE)
    return outline(img)


register("ice_spikes", "prop", [_arc_draw_ice_spikes()],
         "a cluster of three jagged ice shards", _ARC_BIOMES, "arctic")


def _arc_draw_ice_boulder():
    img = S(16, 16)
    prof = ((6, 10), (4, 12), (3, 13), (2, 13), (2, 14), (1, 14), (1, 14),
            (1, 14), (2, 14), (2, 13), (3, 12))
    for i, (x0, x1) in enumerate(prof):
        y = 5 + i
        hline(img, x0, x1, y, CYAN)
        px(img, x1, y, BLUE)
        if i >= 3:
            px(img, x1 - 1, y, BLUE)
    # top-left sheen
    hline(img, 6, 9, 5, WHITE)
    hline(img, 4, 7, 6, WHITE)
    hline(img, 3, 5, 7, WHITE)
    px(img, 2, 8, WHITE)
    # bottom shade
    hline(img, 5, 12, 15, BLUE)
    hline(img, 7, 12, 14, BLUE)
    # cracks
    for x, y in ((9, 6), (8, 7), (9, 8), (9, 9), (10, 10), (9, 11), (10, 12),
                 (10, 13), (8, 9), (7, 10), (6, 11)):
        px(img, x, y, NAVY)
    return outline(img)


register("ice_boulder", "prop", [_arc_draw_ice_boulder()],
         "a rounded boulder of cracked glacier ice", _ARC_BIOMES, "arctic")


def _arc_draw_snow_drift():
    img = S(16, 16)
    prof = ((6, 9), (4, 11), (2, 13), (1, 14), (1, 14), (1, 14))
    for i, (x0, x1) in enumerate(prof):
        hline(img, x0, x1, 10 + i, WHITE)
    # wind-shadow on the lee side
    px(img, 13, 12, GREY_L)
    hline(img, 12, 14, 13, GREY_L)
    hline(img, 10, 14, 14, GREY_L)
    hline(img, 8, 14, 15, GREY_L)
    px(img, 2, 15, GREY_L)
    # icy glints
    px(img, 5, 12, CYAN)
    px(img, 9, 13, CYAN)
    return outline(img)


register("snow_drift", "prop", [_arc_draw_snow_drift()],
         "a low wind-piled snow drift", _ARC_BIOMES, "arctic", blocks=False)


def _arc_draw_tree_frozen():
    img = S(16, 24)
    # trunk
    vline(img, 7, 10, 23, BROWN)
    vline(img, 8, 10, 23, PLUM)
    px(img, 6, 22, BROWN)
    px(img, 6, 23, BROWN)
    px(img, 9, 22, PLUM)
    px(img, 9, 23, PLUM)
    limbs = (
        (7, 9), (6, 8), (6, 7), (5, 6), (5, 5), (4, 4),        # crown left fork (taller)
        (8, 9), (9, 8), (10, 7), (11, 6),                      # crown right fork (shorter)
        (6, 12), (5, 11), (4, 10), (3, 9), (2, 8), (2, 7),     # left limb
        (4, 9), (4, 8),                                        # left twig
        (9, 14), (10, 13), (11, 12), (12, 11), (13, 10), (13, 9),  # right limb
        (11, 11), (11, 10),                                    # right twig
        (6, 17), (5, 16),                                      # low broken stub
    )
    for x, y in limbs:
        px(img, x, y, BROWN)
    # snow lining every upward-facing edge
    src = img.copy()
    for y in range(1, img.height):
        for x in range(img.width):
            if src.getpixel((x, y))[3] > 0 and src.getpixel((x, y - 1))[3] == 0:
                px(img, x, y - 1, WHITE)
    # drifts at the roots
    hline(img, 3, 5, 23, WHITE)
    hline(img, 10, 12, 23, WHITE)
    px(img, 4, 22, WHITE)
    px(img, 11, 22, WHITE)
    return outline(img)


register("tree_frozen", "prop", [_arc_draw_tree_frozen()],
         "a dead tree, every bare limb lined with snow", _ARC_BIOMES, "arctic")


def _arc_pine_tier(img, cx, y_top, h, half_w, cap_rows=0):
    """One conifer tier: green triangle, snow-lined lit slope, optional full snow cap."""
    for i in range(h):
        t = (i * half_w) // (h - 1)
        y = y_top + i
        x0, x1 = cx - t, cx + 1 + t
        if i < cap_rows:
            hline(img, x0, x1, y, WHITE)
            px(img, x1, y, GREY_L)
        else:
            hline(img, x0, x1, y, GREEN_D)
            px(img, x1, y, GREEN_DD)
            if x1 - x0 >= 4:
                px(img, x1 - 1, y, GREEN_DD)
                px(img, x0 + 1, y, GREEN)
            if i < h - 1:
                px(img, x0, y, WHITE)      # snow on the lit slope
    # snow-laden bottom fringe with branch tips poking through
    yb = y_top + h - 1
    hline(img, cx - half_w, cx + 1 + half_w, yb, WHITE)
    px(img, cx + half_w, yb, GREY_L)
    px(img, cx + 1 + half_w, yb, GREY_L)
    px(img, cx - 2, yb, GREEN_DD)
    px(img, cx + 3, yb, GREEN_DD)


def _arc_draw_pine_snowy():
    img = S(16, 24)
    _arc_pine_tier(img, 7, 7, 10, 6)             # lower tier
    _arc_pine_tier(img, 7, 2, 8, 4, cap_rows=3)  # snow-capped top tier
    vline(img, 7, 17, 23, BROWN)
    vline(img, 8, 17, 23, PLUM)
    hline(img, 4, 6, 23, WHITE)                  # drift at the roots
    hline(img, 9, 11, 23, WHITE)
    return outline(img)


register("pine_snowy", "prop", [_arc_draw_pine_snowy()],
         "a snow-capped conifer", ["arctic", "mountain", "forest"], "arctic")


def _arc_draw_pine_snowy_tall():
    img = S(16, 32)
    _arc_pine_tier(img, 7, 13, 12, 6)            # bottom tier
    _arc_pine_tier(img, 7, 7, 11, 5)             # middle tier
    _arc_pine_tier(img, 7, 2, 9, 3, cap_rows=3)  # snow-capped crown
    vline(img, 7, 25, 31, BROWN)
    vline(img, 8, 25, 31, PLUM)
    hline(img, 4, 6, 31, WHITE)
    hline(img, 9, 11, 31, WHITE)
    return outline(img)


register("pine_snowy_tall", "prop", [_arc_draw_pine_snowy_tall()],
         "a tall three-tiered snowy pine", ["arctic", "mountain", "forest"], "arctic")


def _arc_draw_igloo():
    img = S(32, 24)
    profile = (
        (13, 18), (11, 20), (9, 22), (8, 23), (7, 24), (6, 25), (5, 26),
        (4, 27), (4, 27), (3, 28), (3, 28), (3, 28), (2, 29), (2, 29),
        (2, 29), (2, 29), (2, 29), (2, 29), (2, 29),
    )
    for i, (x0, x1) in enumerate(profile):
        y = 5 + i
        hline(img, x0, x1, y, WHITE)
        n = 2 if i < 7 else 3
        for k in range(n):
            px(img, x1 - k, y, GREY_L)         # bottom-right shading
    # block course lines
    for y in (8, 12, 16, 20):
        x0, x1 = profile[y - 5]
        hline(img, x0 + 1, x1 - 1, y, GREY_L)
    # staggered vertical joints per course band
    joints = ((6, 7, (12, 19)), (9, 11, (8, 15, 22)), (13, 15, (5, 11, 18, 25)),
              (17, 19, (8, 14, 21, 27)), (21, 23, (5, 24)))
    for y0, y1, xs in joints:
        for x in xs:
            for y in range(y0, y1 + 1):
                bx0, bx1 = profile[y - 5]
                if bx0 < x < bx1:
                    px(img, x, y, GREY_L)
    # entrance arch
    hline(img, 13, 18, 15, GREY)               # rim top
    px(img, 12, 16, GREY)
    px(img, 19, 16, GREY)
    vline(img, 12, 17, 23, GREY)
    vline(img, 19, 17, 23, GREY)
    hline(img, 14, 17, 16, NAVY)               # dim inner ceiling
    rect(img, 13, 17, 18, 23, OUT)             # dark interior
    vline(img, 13, 17, 19, NAVY)               # lit-side inner wall
    return outline(img)


register("igloo", "prop", [_arc_draw_igloo()],
         "a snow-block igloo with a dark entrance arch", ["arctic"], "arctic",
         footW=2, footH=1)


def _arc_draw_whale_ribs():
    img = S(32, 24)
    # snow bed
    hline(img, 0, 31, 23, WHITE)
    for x0, x1 in ((0, 4), (9, 13), (18, 22), (27, 31)):
        hline(img, x0, x1, 22, WHITE)
    for x in (7, 16, 25):
        px(img, x, 23, GREY_L)
    # half-buried spine between the tall ribs
    rect(img, 13, 21, 18, 22, BONE)
    hline(img, 13, 18, 22, BONE_D)
    px(img, 14, 21, BONE_D)
    px(img, 16, 21, BONE_D)
    # rib arcs as explicit point chains — strong parenthesis curves, tips bending inward
    ribs = (
        # tall left rib: base (6,23) sweeping to a hooked tip at (14,5)
        (((6, 23), (6, 22), (6, 21), (6, 20), (7, 19), (7, 18), (7, 17), (8, 16),
          (8, 15), (8, 14), (9, 13), (9, 12), (9, 11), (10, 10), (10, 9), (11, 8),
          (11, 7), (12, 6), (13, 5), (14, 5)), 1),
        # tall right rib: base (25,23) sweeping to (18,7) — the arch is broken, tips never meet
        (((25, 23), (25, 22), (25, 21), (25, 20), (24, 19), (24, 18), (24, 17),
          (23, 16), (23, 15), (23, 14), (22, 13), (22, 12), (22, 11), (21, 10),
          (21, 9), (20, 8), (19, 7), (18, 7)), -1),
        # shorter outer pair
        (((1, 23), (1, 22), (1, 21), (2, 20), (2, 19), (2, 18), (3, 17), (3, 16),
          (4, 15), (4, 14), (5, 13), (6, 12)), 1),
        (((30, 23), (30, 22), (30, 21), (29, 20), (29, 19), (29, 18), (28, 17),
          (28, 16), (27, 15), (27, 14), (26, 13)), -1),
    )
    for pts, d in ribs:
        for x, y in pts:
            lx = x if d > 0 else x - 1
            px(img, lx, y, BONE)
            px(img, lx + 1, y, BONE_D)
        tx, ty = pts[-1]
        px(img, tx if d > 0 else tx - 1, ty, WHITE)   # sun-bleached tip
    return outline(img)


register("whale_ribs", "prop", [_arc_draw_whale_ribs()],
         "a whale ribcage arching out of the snow", ["arctic"], "arctic",
         footW=2, footH=1, blocks=False)


def _arc_draw_sled_wood():
    img = S(16, 16)
    # deck planks
    hline(img, 2, 13, 8, TAN)
    hline(img, 2, 13, 9, BROWN)
    hline(img, 2, 13, 10, PLUM)
    px(img, 5, 9, PLUM)
    px(img, 9, 9, PLUM)
    # rear rail
    rect(img, 12, 5, 13, 7, BROWN)
    px(img, 12, 5, TAN)
    # lashed cargo bundle
    rect(img, 5, 6, 8, 7, TAN)
    px(img, 5, 6, WHITE)
    vline(img, 7, 6, 7, BROWN)                 # rope lash
    px(img, 8, 7, BROWN)
    # struts down to the runner
    vline(img, 3, 11, 13, BROWN)
    vline(img, 11, 11, 13, BROWN)
    # iron-shod runner, upturned nose at the front (left)
    hline(img, 1, 14, 14, GREY)
    hline(img, 2, 14, 15, SLATE)
    px(img, 1, 13, GREY)
    px(img, 1, 12, GREY_L)
    px(img, 2, 11, GREY_L)
    return outline(img)


register("sled_wood", "prop", [_arc_draw_sled_wood()],
         "a wooden sledge on iron-shod runners", _ARC_BIOMES, "arctic")


_ARC_XTAL_FACETS = ((5, WHITE), (6, CYAN), (7, CYAN), (8, BLUE), (9, CYAN), (10, BLUE))


def _arc_draw_ice_crystal(flicker):
    img = S(16, 24)
    for x, c in _ARC_XTAL_FACETS:
        vline(img, x, 6, 20, c)
    hline(img, 7, 8, 3, WHITE)                 # apex
    for y in (4, 5):
        hline(img, 6, 9, y, CYAN)
        px(img, 6, y, WHITE)
        px(img, 9, y, BLUE)
    # companion shard
    comp = ((13, 13), (12, 13), (12, 14), (12, 14), (12, 14), (12, 14), (12, 14))
    for j, (x0, x1) in enumerate(comp):
        y = 15 + j
        hline(img, x0, x1, y, CYAN)
        px(img, x0, y, WHITE)
    vline(img, 14, 18, 21, BLUE)
    # animated inner glimmer
    if flicker:
        px(img, 7, 12, WHITE)
        px(img, 9, 16, WHITE)
    else:
        px(img, 7, 9, WHITE)
        px(img, 10, 15, WHITE)
    # snow mound at the base
    hline(img, 4, 11, 21, WHITE)
    hline(img, 3, 12, 22, WHITE)
    hline(img, 2, 14, 23, WHITE)
    px(img, 10, 21, GREY_L)
    px(img, 11, 22, GREY_L)
    hline(img, 12, 14, 23, GREY_L)
    return outline(img)


register("ice_crystal", "prop", [_arc_draw_ice_crystal(False), _arc_draw_ice_crystal(True)],
         "a glowing ice crystal rooted in a snow mound", _ARC_BIOMES, "arctic",
         light=True, fps=2)


def _arc_draw_snowman():
    img = S(16, 24)
    balls = (
        (15, ((5, 10), (4, 11), (3, 12), (3, 12), (2, 13), (2, 13), (3, 12), (4, 11), (5, 10))),
        (9, ((6, 9), (5, 10), (4, 11), (4, 11), (4, 11), (5, 10), (6, 9))),
        (3, ((6, 9), (5, 10), (5, 10), (5, 10), (5, 10), (6, 9))),
    )
    for y0, prof in balls:
        for i, (x0, x1) in enumerate(prof):
            y = y0 + i
            hline(img, x0, x1, y, WHITE)
            px(img, x1, y, GREY_L)
            if i >= len(prof) - 2:
                px(img, x1 - 1, y, GREY_L)
    # heavier ground shadow on the base ball
    hline(img, 8, 12, 22, GREY_L)
    hline(img, 7, 10, 23, GREY_L)
    # face
    px(img, 6, 5, OUT)                          # coal eyes
    px(img, 9, 5, OUT)
    px(img, 7, 6, ORANGE)                       # carrot nose
    px(img, 8, 6, ORANGE)
    # coal buttons
    px(img, 8, 11, OUT)
    px(img, 8, 13, OUT)
    # stick arms
    for x, y in ((3, 11), (2, 10), (1, 9), (1, 10), (12, 11), (13, 10), (14, 9), (14, 10)):
        px(img, x, y, BROWN)
    return outline(img)


register("snowman", "prop", [_arc_draw_snowman()],
         "a three-ball snowman with coal eyes and stick arms", ["arctic", "village"], "arctic")


def _arc_draw_cairn_stone():
    img = S(16, 16)
    stones = (
        (3, 12, 12, 15),   # bottom
        (5, 12, 9, 11),    # second, shifted right
        (4, 9, 6, 8),      # third, shifted left
        (6, 9, 3, 5),      # capstone
    )
    for x0, x1, y0, y1 in stones:
        rect(img, x0, y0, x1, y1, GREY)
        hline(img, x0, x1, y0, GREY_L)
        vline(img, x1, y0 + 1, y1, SLATE)
        hline(img, x0 + 1, x1, y1, SLATE)
    # snow on the exposed ledges + crown
    hline(img, 6, 9, 3, WHITE)
    hline(img, 4, 5, 6, WHITE)
    hline(img, 10, 12, 9, WHITE)
    hline(img, 3, 4, 12, WHITE)
    # cracks
    px(img, 7, 13, SLATE)
    px(img, 8, 10, SLATE)
    # drift at the foot
    hline(img, 1, 2, 15, WHITE)
    hline(img, 13, 14, 15, WHITE)
    return outline(img)


register("cairn_stone", "prop", [_arc_draw_cairn_stone()],
         "a stacked-stone trail cairn dusted with snow", _ARC_BIOMES, "arctic")


def _arc_draw_hare_snow():
    img = S(16, 16)
    # ears
    rect(img, 4, 1, 5, 5, WHITE)
    rect(img, 7, 1, 8, 5, WHITE)
    vline(img, 5, 2, 4, GREY_L)
    vline(img, 8, 2, 4, GREY_L)
    # head (facing left)
    head = ((4, 8), (3, 9), (2, 9), (2, 9), (3, 10))
    for i, (x0, x1) in enumerate(head):
        hline(img, x0, x1, 5 + i, WHITE)
    # body / haunch
    body = ((3, 12), (3, 13), (4, 14), (4, 14), (5, 13))
    for i, (x0, x1) in enumerate(body):
        hline(img, x0, x1, 9 + i, WHITE)
    # haunch shading arc
    for x, y in ((11, 10), (12, 11), (12, 12), (11, 13), (10, 13)):
        px(img, x, y, GREY_L)
    # tail puff
    px(img, 14, 9, WHITE)
    px(img, 14, 10, GREY_L)
    # front leg + big hind foot
    vline(img, 4, 13, 15, WHITE)
    px(img, 3, 15, WHITE)
    hline(img, 8, 13, 14, WHITE)
    hline(img, 7, 13, 15, WHITE)
    px(img, 12, 15, GREY_L)
    px(img, 13, 15, GREY_L)
    # eye + nose
    px(img, 4, 7, OUT)
    px(img, 2, 8, GREY_L)
    return outline(img)


def _arc_reg_hare():
    f = _arc_draw_hare_snow()
    register("hare_snow", "character", [f, bob(f)],
             "a snow hare, ears up, mid-crouch", _ARC_BIOMES, "arctic")


_arc_reg_hare()


def _arc_draw_owl_snowy():
    img = S(16, 16)
    prof = ((6, 9), (5, 10), (4, 11), (4, 11), (4, 11), (4, 11), (4, 11),
            (4, 11), (4, 11), (4, 11), (5, 10), (5, 10))
    for i, (x0, x1) in enumerate(prof):
        hline(img, x0, x1, 2 + i, WHITE)
        px(img, x1, 2 + i, GREY_L)
    # yellow eyes, pupils toward the beak
    px(img, 5, 5, YELLOW)
    px(img, 6, 5, OUT)
    px(img, 10, 5, YELLOW)
    px(img, 9, 5, OUT)
    # beak
    px(img, 7, 6, SLATE)
    px(img, 8, 6, SLATE)
    # barring speckles
    for x, y in ((5, 8), (9, 8), (7, 9), (10, 10), (6, 11), (9, 12)):
        px(img, x, y, GREY_L)
    # tail + talons
    px(img, 7, 14, GREY_L)
    px(img, 8, 14, GREY_L)
    vline(img, 6, 14, 15, SLATE)
    vline(img, 9, 14, 15, SLATE)
    return outline(img)


def _arc_reg_owl():
    f = _arc_draw_owl_snowy()
    register("owl_snowy", "character", [f, bob(f)],
             "a snowy owl, yellow-eyed, perched", _ARC_BIOMES, "arctic")


_arc_reg_owl()


def _arc_draw_wolf_winter():
    img = S(16, 16)
    # body (facing left)
    body = ((6, 12), (6, 13), (6, 13), (6, 13), (7, 13), (7, 12))
    for i, (x0, x1) in enumerate(body):
        hline(img, x0, x1, 6 + i, GREY_L)
    hline(img, 6, 12, 6, WHITE)                # lit back
    hline(img, 7, 12, 10, GREY)                # belly shadow
    hline(img, 8, 12, 11, GREY)
    # head + snout
    head = ((4, 6), (3, 6), (1, 6), (2, 6), (3, 6))
    for i, (x0, x1) in enumerate(head):
        hline(img, x0, x1, 4 + i, GREY_L)
    hline(img, 4, 6, 4, WHITE)                 # lit crown
    px(img, 2, 7, WHITE)                       # white jaw
    px(img, 3, 5, YELLOW)                      # eye
    # ears
    px(img, 4, 3, GREY_L)
    px(img, 6, 3, GREY_L)
    # white chest ruff
    vline(img, 6, 7, 9, WHITE)
    # bushy tail, raised
    px(img, 13, 6, GREY_L)
    px(img, 13, 5, GREY_L)
    px(img, 14, 5, GREY_L)
    px(img, 13, 4, GREY_L)
    px(img, 14, 4, GREY_L)
    px(img, 14, 3, WHITE)
    # legs + paws
    rect(img, 6, 12, 7, 14, GREY_L)
    rect(img, 11, 12, 12, 14, GREY_L)
    vline(img, 12, 12, 14, GREY)
    hline(img, 6, 7, 15, WHITE)
    hline(img, 11, 12, 15, WHITE)
    return outline(img)


def _arc_reg_wolf():
    f = _arc_draw_wolf_winter()
    register("wolf_winter", "character", [f, bob(f)],
             "a winter wolf, white-ruffed, yellow-eyed", _ARC_BIOMES, "arctic")


_arc_reg_wolf()

# ===== section: 9-desert.py (18 assets) =====
# ===== section: 9-desert.py — DESERT / BADLANDS kit =====

# -------------------------------------------------------------------- palm (16x32)
def _des_palm():
    img = S(16, 32)
    # trunk: gentle left curve, ringed
    _tx = {31: 8, 30: 8, 29: 8, 28: 8, 27: 8, 26: 8, 25: 7, 24: 7, 23: 7, 22: 7, 21: 7,
           20: 7, 19: 6, 18: 6, 17: 6, 16: 6, 15: 6, 14: 6, 13: 6, 12: 6, 11: 6, 10: 6}
    for y, x in _tx.items():
        px(img, x, y, BROWN)
        px(img, x + 1, y, BRONZE_D)
    for y in (28, 24, 20, 16, 12):          # ring bands
        px(img, _tx[y], y, PLUM)
        px(img, _tx[y] + 1, y, PLUM)
    for y in (26, 22, 18, 14):              # lit left flecks
        px(img, _tx[y], y, TAN)
    # crown core
    rect(img, 5, 6, 9, 8, GREEN_D)
    px(img, 5, 6, GREEN)
    px(img, 6, 6, GREEN)
    px(img, 5, 7, GREEN)
    # coconuts + crown->trunk join
    px(img, 6, 9, BRONZE)
    px(img, 7, 9, BROWN)
    px(img, 8, 9, BRONZE_D)
    # fronds — lit on the left/top, shaded low-right
    for x, y in ((5, 7), (4, 7), (3, 8), (2, 8), (1, 9)):
        px(img, x, y, GREEN)                # left
    for x, y in ((10, 7), (11, 7), (12, 8), (13, 8), (14, 9)):
        px(img, x, y, GREEN_D)              # right
    for x, y in ((5, 5), (4, 4), (3, 4)):
        px(img, x, y, GREEN)                # up-left
    for x, y in ((9, 5), (10, 4), (11, 4)):
        px(img, x, y, GREEN_D)              # up-right
    for x, y in ((7, 5), (7, 4), (8, 3)):
        px(img, x, y, GREEN_D)              # up
    for x, y in ((4, 9), (3, 10), (2, 11)):
        px(img, x, y, GREEN_DD)             # droop-left
    for x, y in ((11, 9), (12, 10), (13, 11)):
        px(img, x, y, GREEN_DD)             # droop-right
    return outline(img)

register("palm", "prop", [_des_palm()],
         "a desert palm — curved ringed trunk, frond starburst, two coconuts",
         ["desert"], "desert", blocks=True)

# -------------------------------------------------------------------- palm_bent (16x32)
def _des_palm_bent():
    img = S(16, 32)
    # trunk bowing hard to the right in the wind
    _tx = {31: 4, 30: 4, 29: 4, 28: 5, 27: 5, 26: 5, 25: 6, 24: 6, 23: 6, 22: 7, 21: 7,
           20: 7, 19: 8, 18: 8, 17: 8, 16: 9, 15: 9, 14: 9, 13: 10, 12: 10}
    for y, x in _tx.items():
        px(img, x, y, BROWN)
        px(img, x + 1, y, BRONZE_D)
    for y in (29, 25, 21, 17):
        px(img, _tx[y], y, PLUM)
        px(img, _tx[y] + 1, y, PLUM)
    for y in (27, 23, 19, 15):
        px(img, _tx[y], y, TAN)
    # crown, blown to the right
    rect(img, 9, 9, 12, 11, GREEN_D)
    px(img, 9, 9, GREEN)
    px(img, 10, 9, GREEN)
    px(img, 9, 12, BRONZE)                  # coconut tucked under
    # fronds streaming right
    for x, y in ((8, 9), (7, 9), (6, 10)):
        px(img, x, y, GREEN)                # short windward stub
    for x, y in ((13, 9), (14, 10), (15, 10)):
        px(img, x, y, GREEN_D)
    for x, y in ((11, 8), (12, 7), (13, 7), (14, 8)):
        px(img, x, y, GREEN)                # lit upper streamer
    for x, y in ((13, 11), (14, 12), (15, 13)):
        px(img, x, y, GREEN_DD)
    for x, y in ((12, 12), (13, 13)):
        px(img, x, y, GREEN_DD)
    return outline(img)

register("palm_bent", "prop", [_des_palm_bent()],
         "a wind-bent palm leaning hard over, fronds streaming downwind",
         ["desert"], "desert", blocks=True)

# -------------------------------------------------------------------- cactus_saguaro (16x24)
def _des_cactus_saguaro():
    img = S(16, 24)
    # trunk
    rect(img, 7, 4, 9, 23, GREEN_D)
    px(img, 8, 3, GREEN_D)
    vline(img, 7, 4, 23, GREEN)             # lit rib
    vline(img, 9, 5, 23, GREEN_DD)          # shade rib
    px(img, 8, 2, WHITE)                    # crown bloom
    # left arm (lower elbow)
    rect(img, 3, 10, 4, 15, GREEN_D)
    vline(img, 3, 10, 15, GREEN)
    px(img, 3, 9, GREEN)
    px(img, 4, 9, GREEN_D)
    rect(img, 5, 14, 6, 15, GREEN_D)        # elbow connector
    hline(img, 5, 6, 15, GREEN_DD)
    # right arm (higher elbow)
    rect(img, 11, 7, 12, 12, GREEN_D)
    vline(img, 12, 7, 12, GREEN_DD)
    px(img, 11, 6, GREEN)
    px(img, 12, 6, GREEN_D)
    rect(img, 10, 11, 10, 12, GREEN_D)      # elbow connector
    # spines
    for x, y in ((8, 6), (7, 9), (8, 12), (7, 15), (8, 18), (7, 21), (3, 12), (12, 9)):
        px(img, x, y, TAN)
    return outline(img)

register("cactus_saguaro", "prop", [_des_cactus_saguaro()],
         "a two-armed saguaro cactus — ribbed, spined, blooming at the crown",
         ["desert"], "desert", blocks=True)

# -------------------------------------------------------------------- cactus_barrel (16x16)
def _des_cactus_barrel():
    img = S(16, 16)
    rect(img, 5, 6, 10, 6, GREEN_D)
    rect(img, 4, 7, 11, 13, GREEN_D)
    rect(img, 5, 14, 10, 14, GREEN_D)
    rect(img, 6, 15, 9, 15, GREEN_DD)
    # rib furrows / lit ridges
    for x in (5, 7, 9, 11):
        vline(img, x, 7, 13, GREEN_DD)
    for x in (4, 6, 8):
        vline(img, x, 7, 10, GREEN)
    vline(img, 10, 11, 13, GREEN_DD)
    hline(img, 5, 9, 6, GREEN)              # lit crown
    # spines
    for x, y in ((4, 6), (6, 6), (8, 6), (10, 6), (4, 11), (8, 12), (6, 14)):
        px(img, x, y, TAN)
    # bloom on top
    px(img, 7, 5, YELLOW)
    px(img, 8, 5, ORANGE)
    return outline(img)

register("cactus_barrel", "prop", [_des_cactus_barrel()],
         "a squat ribbed barrel cactus with a yellow bloom",
         ["desert"], "desert", blocks=True)

# -------------------------------------------------------------------- agave (16x16)
def _des_agave():
    img = S(16, 16)
    # base clump
    rect(img, 6, 13, 9, 15, GREEN_D)
    # center spike
    vline(img, 7, 7, 12, GREEN_D)
    vline(img, 8, 8, 12, GREEN_DD)
    px(img, 7, 6, TAN)
    # inner left (lit)
    for x, y in ((6, 12), (6, 11), (6, 10), (5, 9), (5, 8)):
        px(img, x, y, GREEN)
    px(img, 4, 7, TAN)
    # inner right (shade)
    for x, y in ((9, 12), (9, 11), (9, 10), (10, 9), (10, 8)):
        px(img, x, y, GREEN_DD)
    px(img, 11, 7, TAN)
    # outer left (lit)
    for x, y in ((5, 14), (4, 13), (3, 12), (2, 11)):
        px(img, x, y, GREEN)
    px(img, 1, 10, TAN)
    # outer right
    for x, y in ((10, 14), (11, 13), (12, 12), (13, 11)):
        px(img, x, y, GREEN_D)
    px(img, 14, 10, TAN)
    # front droopers
    px(img, 5, 15, GREEN_D)
    px(img, 10, 15, GREEN_DD)
    return outline(img)

register("agave", "prop", [_des_agave()],
         "a spiked agave rosette, pale thorn tips on every leaf",
         ["desert"], "desert", blocks=True)

# -------------------------------------------------------------------- tumbleweed (16x16, 2f)
def _des_tumbleweed(roll=False):
    img = S(16, 16)
    # rim — a rough sphere of dry twigs
    hline(img, 6, 10, 5, BRONZE)
    px(img, 4, 6, BRONZE)
    px(img, 5, 6, BRONZE)
    px(img, 11, 6, BRONZE_D)
    px(img, 12, 6, BRONZE_D)
    px(img, 3, 7, BRONZE)
    px(img, 13, 7, BRONZE_D)
    for y in (8, 9, 10, 11, 12):
        px(img, 3, y, BRONZE)
        px(img, 13, y, BRONZE_D)
    px(img, 4, 13, BRONZE)
    px(img, 12, 13, BRONZE_D)
    px(img, 5, 14, BRONZE)
    px(img, 6, 14, BRONZE)
    px(img, 10, 14, BRONZE_D)
    px(img, 11, 14, BRONZE_D)
    hline(img, 7, 9, 15, BRONZE_D)
    # inner tangle rotates between frames
    if not roll:
        for x, y in ((6, 8), (7, 9), (8, 10), (9, 11), (10, 12), (10, 7), (9, 8),
                     (6, 12), (5, 11), (8, 6), (11, 10)):
            px(img, x, y, BRONZE_D)
        for x, y in ((5, 7), (7, 6), (4, 9), (6, 10), (9, 13)):
            px(img, x, y, TAN)
    else:
        for x, y in ((10, 8), (9, 9), (8, 10), (7, 11), (6, 12), (6, 7), (7, 8),
                     (10, 12), (11, 11), (8, 6), (5, 10)):
            px(img, x, y, BRONZE_D)
        for x, y in ((9, 6), (11, 7), (4, 10), (8, 12), (6, 13)):
            px(img, x, y, TAN)
    return outline(img)

register("tumbleweed", "prop", [_des_tumbleweed(False), _des_tumbleweed(True)],
         "a dry tumbleweed, tangle turning as it rolls",
         ["desert", "ruin"], "desert", blocks=False, fps=3)

# -------------------------------------------------------------------- ox_skull (16x16)
def _des_ox_skull():
    img = S(16, 16)
    # left horn (lit) — thick at the base, sweeping out then up
    for x, y in ((4, 5), (4, 6), (3, 5), (3, 6), (2, 4), (2, 5), (1, 4)):
        px(img, x, y, BONE)
    px(img, 1, 3, WHITE)
    # right horn (shade)
    for x, y in ((11, 5), (11, 6), (12, 5), (12, 6), (13, 4), (13, 5), (14, 4)):
        px(img, x, y, BONE_D)
    px(img, 14, 3, BONE)
    # skull
    rect(img, 5, 5, 10, 9, BONE)            # brow + face
    rect(img, 6, 10, 9, 12, BONE)           # snout
    px(img, 5, 5, WHITE)
    px(img, 6, 5, WHITE)
    px(img, 7, 5, WHITE)
    vline(img, 10, 6, 9, BONE_D)
    px(img, 9, 10, BONE_D)
    # eye sockets
    px(img, 6, 7, OUT)
    px(img, 9, 7, OUT)
    px(img, 6, 8, PLUM)
    px(img, 9, 8, PLUM)
    # nasal slits
    vline(img, 7, 10, 11, BONE_D)
    px(img, 8, 11, OUT)
    # sand drift burying the jaw
    rect(img, 2, 13, 13, 15, TAN)
    hline(img, 3, 8, 12, TAN)
    hline(img, 2, 6, 13, WHITE)             # lit lip
    px(img, 11, 13, BRONZE_D)
    px(img, 12, 14, BRONZE_D)
    hline(img, 4, 13, 15, BRONZE)           # base shadow
    return outline(img)

register("ox_skull", "prop", [_des_ox_skull()],
         "a longhorn ox skull, jaw lost in the drifted sand",
         ["desert", "ruin"], "desert", blocks=False)

# -------------------------------------------------------------------- obelisk (16x32)
def _des_obelisk():
    img = S(16, 32)
    # pyramidion
    px(img, 7, 2, WHITE)                    # sun glint at the tip
    px(img, 8, 2, ORANGE)
    rect(img, 7, 3, 8, 3, ORANGE)
    rect(img, 6, 4, 9, 5, ORANGE)
    px(img, 9, 4, BRONZE)
    px(img, 9, 5, BRONZE_D)
    # shaft, tapering
    rect(img, 6, 6, 9, 15, BRONZE)
    rect(img, 5, 16, 10, 25, BRONZE)
    vline(img, 6, 6, 15, ORANGE)
    vline(img, 5, 16, 25, ORANGE)
    vline(img, 9, 6, 15, BRONZE_D)
    vline(img, 10, 16, 25, BRONZE_D)
    # plinth + base
    rect(img, 4, 26, 11, 28, BRONZE)
    hline(img, 4, 11, 26, ORANGE)
    vline(img, 11, 27, 28, BRONZE_D)
    rect(img, 3, 29, 12, 31, BRONZE_D)
    hline(img, 3, 12, 29, BRONZE)
    # carved glyph column
    for x, y in ((7, 7), (8, 8), (7, 9), (7, 11), (8, 11), (8, 13), (7, 14),
                 (7, 17), (8, 17), (7, 18), (8, 19), (7, 21), (8, 22), (7, 23)):
        px(img, x, y, PLUM)
    # crack near the base
    px(img, 6, 24, PLUM)
    px(img, 5, 25, PLUM)
    return outline(img)

register("obelisk", "prop", [_des_obelisk()],
         "a sandstone obelisk, glyph column carved down its face",
         ["desert", "ruin"], "desert", blocks=True)

# -------------------------------------------------------------------- ruin_sandstone (16x16)
def _des_ruin_sandstone():
    img = S(16, 16)
    # big fallen block
    rect(img, 1, 9, 8, 15, ORANGE)
    hline(img, 1, 8, 9, TAN)
    px(img, 1, 9, WHITE)
    vline(img, 8, 10, 15, BRONZE_D)
    hline(img, 3, 6, 12, PLUM)              # broken carving groove
    px(img, 4, 13, PLUM)
    px(img, 5, 13, PLUM)
    hline(img, 1, 7, 15, BRONZE)            # ground shade
    # tipped block, right
    rect(img, 9, 11, 14, 15, BRONZE)
    hline(img, 9, 14, 11, ORANGE)
    px(img, 9, 11, TAN)
    vline(img, 14, 12, 15, BRONZE_D)
    # capstone fragment on top
    rect(img, 3, 5, 7, 8, ORANGE)
    hline(img, 3, 7, 5, TAN)
    px(img, 3, 5, WHITE)
    vline(img, 7, 6, 8, BRONZE_D)
    # chips
    px(img, 12, 10, BRONZE_D)
    px(img, 13, 10, BRONZE_D)
    px(img, 15, 14, BRONZE_D)
    px(img, 15, 15, BRONZE_D)
    return outline(img)

register("ruin_sandstone", "prop", [_des_ruin_sandstone()],
         "collapsed sandstone blocks, a broken carving in the rubble",
         ["desert", "ruin"], "desert", blocks=True)

# -------------------------------------------------------------------- dune_crest (16x16)
def _des_dune_crest():
    img = S(16, 16)
    hline(img, 8, 11, 11, TAN)
    hline(img, 5, 12, 12, TAN)
    hline(img, 3, 13, 13, TAN)
    hline(img, 2, 14, 14, TAN)
    hline(img, 1, 14, 15, TAN)
    # wind-lit lip along the crest
    hline(img, 8, 11, 11, WHITE)
    px(img, 7, 12, WHITE)
    px(img, 6, 12, WHITE)
    px(img, 4, 13, WHITE)
    # lee-side shadow
    px(img, 12, 12, BRONZE)
    px(img, 13, 13, BRONZE)
    px(img, 12, 13, BRONZE)
    px(img, 14, 14, BRONZE)
    px(img, 13, 14, BRONZE)
    hline(img, 9, 14, 15, BRONZE)
    # ripples
    px(img, 4, 14, BRONZE)
    px(img, 7, 14, BRONZE)
    px(img, 3, 15, BRONZE)
    px(img, 2, 14, WHITE)
    return outline(img)

register("dune_crest", "prop", [_des_dune_crest()],
         "a low dune crest, sun-bright lip and shadowed lee",
         ["desert"], "desert", blocks=False)

# -------------------------------------------------------------------- urn_clay (16x16)
def _des_urn_clay():
    img = S(16, 16)
    # rim + neck
    hline(img, 5, 10, 2, ORANGE)
    px(img, 5, 2, TAN)
    rect(img, 7, 3, 8, 4, BRONZE)
    # handles
    for x, y in ((5, 3), (4, 4), (4, 5)):
        px(img, x, y, BRONZE_D)
    for x, y in ((10, 3), (11, 4), (11, 5)):
        px(img, x, y, BRONZE_D)
    # shoulder + belly
    rect(img, 5, 5, 10, 5, ORANGE)
    rect(img, 4, 6, 11, 10, ORANGE)
    vline(img, 4, 6, 9, TAN)                # lit left
    vline(img, 11, 6, 10, BRONZE_D)         # shade right
    vline(img, 10, 8, 10, BRONZE)
    # painted band + meander dots
    hline(img, 5, 10, 7, PLUM)
    px(img, 5, 9, PLUM)
    px(img, 7, 9, PLUM)
    px(img, 9, 9, PLUM)
    # taper to the foot
    rect(img, 5, 11, 10, 11, BRONZE)
    rect(img, 6, 12, 9, 12, BRONZE)
    rect(img, 7, 13, 8, 13, BRONZE_D)
    rect(img, 6, 14, 9, 14, BRONZE)
    rect(img, 5, 15, 10, 15, BRONZE_D)
    return outline(img)

register("urn_clay", "prop", [_des_urn_clay()],
         "a clay amphora on a foot ring, plum-painted band",
         ["desert", "ruin"], "desert", blocks=True)

# -------------------------------------------------------------------- bones_halfburied (16x16)
def _des_bones_halfburied():
    img = S(16, 16)
    # rib arcs — three ribs, wide-spaced so daylight shows between them
    vline(img, 3, 8, 12, BONE)
    px(img, 3, 8, WHITE)
    px(img, 4, 7, BONE)
    px(img, 5, 7, BONE_D)
    vline(img, 7, 5, 12, BONE)
    px(img, 7, 5, WHITE)
    px(img, 8, 4, BONE)
    px(img, 9, 5, BONE_D)
    vline(img, 11, 7, 12, BONE)
    px(img, 12, 6, BONE)
    px(img, 13, 7, BONE_D)
    # a last rib nub, almost swallowed
    px(img, 14, 11, BONE_D)
    px(img, 14, 12, BONE_D)
    # sand
    rect(img, 1, 13, 14, 15, TAN)
    hline(img, 2, 8, 12, TAN)               # drift lapping the rib bases
    px(img, 1, 13, WHITE)
    px(img, 2, 12, WHITE)
    hline(img, 3, 14, 15, BRONZE)           # base shadow
    px(img, 4, 13, BRONZE)
    px(img, 7, 13, BRONZE)
    px(img, 10, 13, BRONZE)
    px(img, 13, 13, BRONZE)
    # vertebrae poking through
    px(img, 5, 14, BONE_D)
    px(img, 8, 14, BONE_D)
    return outline(img)

register("bones_halfburied", "prop", [_des_bones_halfburied()],
         "a ribcage arcing out of the sand, vertebrae poking through",
         ["desert", "ruin"], "desert", blocks=False)

# -------------------------------------------------------------------- camel (character 16x16)
def _des_camel():
    img = S(16, 16)
    # body
    rect(img, 3, 9, 13, 12, TAN)
    hline(img, 4, 12, 12, BRONZE)           # belly shade
    vline(img, 13, 9, 12, BRONZE)           # rear shade
    # hump
    rect(img, 8, 6, 9, 6, TAN)
    rect(img, 7, 7, 10, 7, TAN)
    rect(img, 6, 8, 11, 8, TAN)
    px(img, 8, 6, WHITE)
    px(img, 10, 7, BRONZE)
    px(img, 11, 8, BRONZE)
    # neck + head
    rect(img, 3, 5, 4, 8, TAN)
    px(img, 4, 8, BRONZE)
    rect(img, 1, 3, 4, 4, TAN)
    px(img, 4, 2, BRONZE_D)                 # ear
    px(img, 2, 4, OUT)                      # eye
    px(img, 1, 5, BRONZE)                   # drooping muzzle
    # tail
    px(img, 14, 9, BRONZE)
    px(img, 14, 10, BRONZE_D)
    px(img, 14, 11, BRONZE_D)
    # legs
    vline(img, 4, 13, 15, BRONZE)
    vline(img, 11, 13, 15, BRONZE)
    vline(img, 6, 13, 14, BRONZE_D)
    vline(img, 13, 13, 14, BRONZE_D)
    return outline(img)

_des_tmp = _des_camel()
register("camel", "character", [_des_tmp, bob(_des_tmp)],
         "a dromedary camel, hump high over a lean tan frame",
         ["desert"], "desert", fps=3)

# -------------------------------------------------------------------- scorpion_giant (character 16x16)
def _des_scorpion_giant():
    img = S(16, 16)
    # side view, facing left: low body, claw forward, tail arched over the back
    # body
    rect(img, 4, 11, 11, 13, BRONZE_D)
    hline(img, 4, 11, 11, BRONZE)           # lit back
    for x in (6, 8, 10):                    # segment plates
        px(img, x, 12, PLUM)
    px(img, 4, 12, RED)                     # eye
    # tail: up at the rear, hooking forward over the body — daylight under the arch
    px(img, 12, 10, BRONZE_D)
    px(img, 13, 9, BRONZE_D)
    px(img, 13, 8, BRONZE_D)
    px(img, 13, 7, BRONZE)
    px(img, 12, 6, BRONZE)
    px(img, 11, 5, BRONZE)
    px(img, 10, 4, BRONZE_D)
    # plum stinger stabbing down-forward
    px(img, 9, 4, PLUM)
    px(img, 9, 5, PLUM)
    px(img, 8, 6, PLUM)
    # big forward pincer
    px(img, 3, 11, BRONZE)                  # arm
    rect(img, 1, 9, 3, 10, BRONZE)          # fixed finger + hand
    hline(img, 1, 3, 9, TAN)                # lit top
    px(img, 1, 12, BRONZE_D)                # moving finger (gap at y11)
    px(img, 2, 12, BRONZE_D)
    # legs
    vline(img, 5, 14, 15, BRONZE)
    vline(img, 8, 14, 15, BRONZE)
    vline(img, 11, 14, 15, BRONZE_D)
    return outline(img)

_des_tmp = _des_scorpion_giant()
register("scorpion_giant", "character", [_des_tmp, bob(_des_tmp)],
         "a giant scorpion, pincers spread and plum stinger raised",
         ["desert", "ruin"], "desert", fps=3)

# -------------------------------------------------------------------- vulture (character 16x16)
def _des_vulture():
    img = S(16, 16)
    # hunched body / folded wings
    rect(img, 5, 7, 10, 7, SLATE)
    rect(img, 4, 8, 11, 11, SLATE)
    rect(img, 5, 12, 10, 12, SLATE)
    hline(img, 5, 7, 7, GREY)               # lit shoulder
    px(img, 4, 8, GREY)
    px(img, 5, 8, GREY)
    hline(img, 6, 10, 12, PLUM)             # under-shade
    for x, y in ((6, 9), (7, 10), (8, 11)):
        px(img, x, y, PLUM)                 # wing fold
    px(img, 11, 11, SLATE)                  # tail
    px(img, 12, 12, PLUM)
    # ruff collar
    px(img, 4, 7, BONE)
    px(img, 5, 6, BONE)
    # bare neck + bald head
    px(img, 3, 6, BONE_D)
    px(img, 3, 5, BONE_D)
    rect(img, 2, 3, 4, 4, BONE)
    px(img, 2, 3, OUT)                      # eye
    px(img, 1, 4, BONE_D)                   # beak
    px(img, 1, 5, OUT)                      # hooked tip
    # legs + toes
    vline(img, 6, 13, 15, BONE_D)
    vline(img, 9, 13, 15, BONE_D)
    px(img, 5, 15, BONE_D)
    px(img, 10, 15, BONE_D)
    return outline(img)

_des_tmp = _des_vulture()
register("vulture", "character", [_des_tmp, bob(_des_tmp)],
         "a hunched vulture, bald bone-pale head on slate wings",
         ["desert", "ruin"], "desert", fps=3)

# -------------------------------------------------------------------- jackal (character 16x16)
def _des_jackal():
    img = S(16, 16)
    # ears
    px(img, 3, 2, TAN)
    px(img, 3, 3, TAN)
    px(img, 5, 2, TAN)
    px(img, 5, 3, BRONZE_D)
    # head, muzzle left
    rect(img, 2, 4, 5, 6, TAN)
    px(img, 1, 5, TAN)
    px(img, 1, 6, BRONZE_D)
    px(img, 3, 5, OUT)                      # eye
    # lean body
    rect(img, 5, 7, 12, 10, TAN)
    px(img, 4, 7, TAN)                      # chest slope
    hline(img, 7, 12, 7, BRONZE_D)          # dark saddle
    hline(img, 5, 12, 10, BRONZE)           # belly
    px(img, 5, 8, BONE)                     # pale throat
    # hanging tail, clear of the rear leg
    px(img, 13, 9, BRONZE_D)
    px(img, 13, 10, BRONZE_D)
    px(img, 14, 11, BRONZE_D)
    px(img, 14, 12, BRONZE_D)
    # legs — three visible, lean
    vline(img, 6, 11, 15, TAN)
    vline(img, 11, 11, 15, TAN)
    vline(img, 8, 11, 14, BRONZE)
    return outline(img)

_des_tmp = _des_jackal()
register("jackal", "character", [_des_tmp, bob(_des_tmp)],
         "a lean tan jackal, tall ears and a dark saddle",
         ["desert", "ruin"], "desert", fps=3)
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
                             category=a["category"], fps=a["fps"], platform=a.get("platform", False)))
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
