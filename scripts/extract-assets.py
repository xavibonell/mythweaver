#!/usr/bin/env python3
"""
Asset extractor — the one command that turns the declarative asset library into served PNGs.

Reads assets/library.json. For each asset (and each of its `variants`) with a `from` spec, it
produces the `art` file under apps/web/public from a raw pack in raw-packs/<pack>/:
  - {"pack":"kenney-tiny-town","copy":"Tiles/tile_0000.png"}     -> copy the whole image
  - {"pack":"pixel-crawler","crop":"<rel>","rect":[x,y,w,h]}     -> crop a sub-region (atlases)
  - {"gen":"water"}                                              -> procedurally generated

Terrain entries carry `variants: [{art, from}]` (one served PNG per interchangeable tile); the
renderer picks one per cell by seeded noise. To add an asset: add a record (with a `from`), then:
    npm run assets:extract        (== python3 scripts/extract-assets.py)

Idempotent. Raw packs live under raw-packs/ (gitignored).
"""
import json
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PACKS = os.path.join(ROOT, "raw-packs")
LIB = os.path.join(ROOT, "assets", "library.json")
WEB_PUBLIC = os.path.join(ROOT, "apps", "web", "public")

try:
    from PIL import Image
except ImportError:
    print("error: Pillow (PIL) is required — pip install Pillow", file=sys.stderr)
    sys.exit(1)


def dest_path(art: str) -> str:
    return os.path.join(WEB_PUBLIC, art.lstrip("/"))  # art is web-root, e.g. "/assets/tiny/.."


def _town_tile(n: int):
    from PIL import Image as _I

    return _I.open(os.path.join(PACKS, "kenney-tiny-town", "Tiles", "tile_%04d.png" % n)).convert("RGBA")


def gen_water(dst: str, frm: dict) -> None:
    """A flat, Kenney-ish water tile: deep blue with a couple of lighter ripple pixels."""
    im = Image.new("RGBA", (16, 16), (58, 110, 165, 255))
    rip = (96, 150, 200, 255)
    for y in range(16):
        for x in range(16):
            if (x * 3 + y * 5) % 16 in (0, 1) or (x + y * 2) % 13 == 0:
                im.putpixel((x, y), rip)
    im.save(dst)


def gen_water_deep(dst: str, frm: dict) -> None:
    """A darker 'deep / dark water' variant — same ripple grammar as gen_water, dimmer palette."""
    im = Image.new("RGBA", (16, 16), (28, 54, 92, 255))
    rip = (52, 86, 130, 255)
    for y in range(16):
        for x in range(16):
            if (x * 3 + y * 5) % 16 in (0, 1) or (x + y * 2) % 13 == 0:
                im.putpixel((x, y), rip)
    im.save(dst)


def gen_lava(dst: str, frm: dict) -> None:
    """A molten lava tile: dark-red crust with glowing orange cracks + yellow-hot flecks."""
    im = Image.new("RGBA", (16, 16), (90, 24, 12, 255))  # dark crust
    glow = (230, 120, 30, 255)  # orange crack
    hot = (250, 210, 70, 255)  # yellow-hot
    for y in range(16):
        for x in range(16):
            if (x * 3 + y * 5) % 16 in (0, 1) or (x + y * 2) % 13 == 0:
                im.putpixel((x, y), glow)
            elif (x * 5 + y * 3) % 17 == 0:
                im.putpixel((x, y), hot)
    im.save(dst)


def gen_sand(dst: str, frm: dict) -> None:
    """A flat sandy/beach tile: warm tan with a few lighter + darker grains (Kenney-ish speckle)."""
    im = Image.new("RGBA", (16, 16), (214, 192, 138, 255))
    light, dark = (230, 212, 165, 255), (190, 166, 112, 255)
    for y in range(16):
        for x in range(16):
            if (x * 5 + y * 3) % 17 == 0:
                im.putpixel((x, y), light)
            elif (x * 2 + y * 7) % 19 == 0:
                im.putpixel((x, y), dark)
    im.save(dst)


def gen_boat(dst: str, frm: dict) -> None:
    """A simple top-down wooden boat the party can stand on (a platform). Sized footW x footH tiles."""
    from PIL import ImageDraw

    w = int(frm.get("footW", 3)) * 16
    h = int(frm.get("footH", 2)) * 16
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    hull_d, hull, deck = (74, 52, 33, 255), (110, 78, 49, 255), (150, 112, 70, 255)
    # pointed hull (bow at the right), rounded stern at the left
    d.polygon([(2, 3), (w - 3, h // 2), (2, h - 4)], fill=hull_d)
    d.polygon([(4, 5), (w - 7, h // 2), (4, h - 6)], fill=hull)
    d.polygon([(6, 7), (w - 12, h // 2), (6, h - 8)], fill=deck)
    im.save(dst)


def gen_house(dst: str, frm: dict) -> None:
    """Compose a cottage by stacking Tiny Town tiles top-to-bottom: roof gable, wall(s), door."""
    parts = frm["parts"]
    im = Image.new("RGBA", (16, 16 * len(parts)), (0, 0, 0, 0))
    for i, n in enumerate(parts):
        im.alpha_composite(_town_tile(n), (0, i * 16))
    im.save(dst)


def gen_fountain(dst: str, frm: dict) -> None:
    """A 2x2 stone basin with water + central spout (no fountain exists in the CC0 packs)."""
    from PIL import ImageDraw

    base = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
    stone = _town_tile(109)
    for y in (0, 16):
        for x in (0, 16):
            base.alpha_composite(stone, (x, y))
    d = ImageDraw.Draw(base)
    rim, rim_d = (120, 120, 130, 255), (80, 80, 92, 255)
    water, water_l = (58, 110, 165, 255), (96, 150, 200, 255)
    d.ellipse([3, 4, 28, 29], fill=rim_d)
    d.ellipse([4, 5, 27, 28], fill=rim)
    d.ellipse([7, 9, 24, 26], fill=water)
    d.ellipse([13, 8, 18, 15], fill=rim)
    d.ellipse([14, 7, 17, 12], fill=rim_d)
    d.point([(15, 18), (16, 19), (15, 20), (17, 17)], fill=water_l)
    base.save(dst)


# DawnBringer-16 — the DawnLike palette. House/stall generators draw in it so our composited
# settlement props (which DawnLike, being dungeon-centric, ships no flat-facade art for) sit
# cohesively beside the real DawnLike tiles instead of reintroducing palette drift.
DB16 = {
    "black": (20, 12, 28, 255), "maroon": (68, 36, 52, 255), "navy": (48, 52, 109, 255),
    "dgrey": (78, 74, 78, 255), "brown": (133, 76, 48, 255), "dgreen": (52, 101, 36, 255),
    "red": (208, 70, 72, 255), "grey": (117, 113, 97, 255), "blue": (89, 125, 206, 255),
    "orange": (210, 125, 44, 255), "lgrey": (133, 149, 161, 255), "lgreen": (109, 170, 44, 255),
    "tan": (210, 170, 153, 255), "cyan": (109, 194, 202, 255), "yellow": (218, 212, 94, 255),
    "cream": (222, 238, 214, 255),
}


def _db(name: str):
    return DB16[name]


def gen_dlhouse(dst: str, frm: dict) -> None:
    """A DawnBringer-palette cottage facade: a peaked gable roof (variant colour) over a brick
    wall with a door + window. `roof` = a DB16 colour name; `tiles` = total height in tiles."""
    from PIL import ImageDraw

    roof = _db(frm.get("roof", "red"))
    roof_d = tuple(max(0, c - 45) if i < 3 else c for i, c in enumerate(roof))
    wall, mortar, door, door_d = _db("tan"), _db("grey"), _db("brown"), _db("maroon")
    h = int(frm.get("tiles", 3))
    W, H = 16, h * 16
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    eave = 13  # walls start a little below the top so the gable roof overhangs upward
    d.rectangle([1, eave, 14, H - 1], fill=wall)
    d.rectangle([1, eave, 14, H - 1], outline=door_d)
    for y in range(eave + 3, H - 1, 4):  # brick courses
        d.line([(2, y), (13, y)], fill=mortar)
    # peaked gable roof
    d.polygon([(0, eave + 1), (8, 0), (15, eave + 1)], fill=roof)
    d.line([(0, eave + 1), (8, 0)], fill=roof_d)
    d.line([(8, 0), (15, eave + 1)], fill=roof_d)
    d.line([(0, eave + 1), (15, eave + 1)], fill=roof_d)
    # door (base, centred) + a window above it
    d.rectangle([6, H - 8, 10, H - 1], fill=door)
    d.rectangle([6, H - 8, 10, H - 1], outline=door_d)
    d.rectangle([3, H - 12, 5, H - 10], fill=_db("cyan"))
    d.rectangle([11, H - 12, 13, H - 10], fill=_db("cyan"))
    im.save(dst)


def gen_wall(dst: str, frm: dict) -> None:
    """A flat DawnBringer brick wall tile with a dark outline on its EXPOSED edges, so a room's
    perimeter reads as a crisp outlined wall with turned corners — without DawnLike's dungeon-style
    black depth-faces (which look like holes in a bright, roofless top-down room). `edges` ⊆ "tblr"
    names the exposed sides (t=top/b=bottom/l=left/r=right); the Cartographer picks the variant by
    the cell's position on the building/room rectangle."""
    from PIL import ImageDraw

    edges = frm.get("edges", "")
    mat = frm.get("mat", "brick")
    im = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if mat == "wood":
        # horizontal timber planks — warm brown with darker seams (log-cabin look)
        base, seam, cap = _db("brown"), _db("maroon"), _db("black")
        d.rectangle([0, 0, 15, 15], fill=base)
        for y in range(0, 16, 4):
            d.line([(0, y), (15, y)], fill=seam)
        for y in range(2, 16, 4):  # a highlight streak mid-plank
            d.line([(1, y), (14, y)], fill=_db("orange"))
    else:
        base, brick, mortar, cap = _db("lgrey"), _db("grey"), _db("dgrey"), _db("maroon")
        d.rectangle([0, 0, 15, 15], fill=base)
        for y in range(0, 16, 4):  # horizontal mortar courses
            d.line([(0, y), (15, y)], fill=mortar)
        for y in range(0, 16, 8):  # staggered vertical joints (brick bond)
            for x in range(0, 16, 8):
                d.line([(x, y), (x, y + 3)], fill=mortar)
        for y in range(4, 16, 8):
            for x in range(4, 16, 8):
                d.line([(x, y), (x, y + 3)], fill=mortar)
        d.point([(2, 2), (10, 6), (6, 10), (14, 14)], fill=brick)  # a few highlight bricks
    if "t" in edges:
        d.rectangle([0, 0, 15, 1], fill=cap)
    if "b" in edges:
        d.rectangle([0, 14, 15, 15], fill=cap)
    if "l" in edges:
        d.rectangle([0, 0, 1, 15], fill=cap)
    if "r" in edges:
        d.rectangle([14, 0, 15, 15], fill=cap)
    im.save(dst)


def gen_pebble(dst: str, frm: dict) -> None:
    """A few small grey pebbles (non-blocking ground decal) for lived-in dirt/sand detail."""
    from PIL import ImageDraw

    im = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    g, dg = _db("grey"), _db("dgrey")
    for x, y in [(4, 8), (9, 5), (11, 11), (6, 12)]:
        d.rectangle([x, y, x + 1, y + 1], fill=g)
        d.point([(x, y + 2)], fill=dg)
    im.save(dst)


def gen_tuft(dst: str, frm: dict) -> None:
    """A small tuft of grass blades (non-blocking decal) breaking up flat grass."""
    from PIL import ImageDraw

    im = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    g, lg = _db("dgreen"), _db("lgreen")
    for x in (5, 8, 11):
        d.line([(x, 13), (x, 8)], fill=g)
        d.point([(x, 7)], fill=lg)
    im.save(dst)


def gen_flowers(dst: str, frm: dict) -> None:
    """A small wild-flower tuft decal (non-blocking) scattered on settlement grass for colour."""
    from PIL import ImageDraw

    im = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    stem = _db("dgreen")
    for x, y, col in [(4, 11, "red"), (8, 9, "yellow"), (11, 12, "cream"), (6, 13, "red"), (12, 8, "blue")]:
        d.line([(x, y), (x, y + 2)], fill=stem)  # stem
        d.point([(x, y - 1), (x - 1, y), (x + 1, y)], fill=_db(col))  # petals
    im.save(dst)


def gen_stall(dst: str, frm: dict) -> None:
    """A market stall: a striped awning over a wooden counter with a few goods. DB16 palette."""
    from PIL import ImageDraw

    W, H = 16, 32
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    stripe_a, stripe_b = _db("red"), _db("cream")
    counter, counter_d = _db("brown"), _db("maroon")
    # awning: scalloped striped roof across the top ~10px
    for x in range(0, W, 4):
        d.rectangle([x, 1, x + 1, 9], fill=stripe_a)
        d.rectangle([x + 2, 1, x + 3, 9], fill=stripe_b)
    d.line([(0, 1), (15, 1)], fill=counter_d)
    for x in range(0, W, 2):  # scalloped lower edge
        d.point([(x, 10)], fill=stripe_a)
    # posts + counter
    d.line([(1, 10), (1, 31)], fill=counter_d)
    d.line([(14, 10), (14, 31)], fill=counter_d)
    d.rectangle([0, 24, 15, 31], fill=counter)
    d.rectangle([0, 24, 15, 31], outline=counter_d)
    # goods on the counter
    d.ellipse([3, 20, 6, 23], fill=_db("lgreen"))
    d.ellipse([7, 20, 10, 23], fill=_db("orange"))
    d.ellipse([10, 19, 13, 23], fill=_db("red"))
    im.save(dst)


GENERATORS = {
    "water": gen_water, "water_deep": gen_water_deep, "lava": gen_lava, "sand": gen_sand, "boat": gen_boat,
    "house": gen_house, "fountain": gen_fountain, "dlhouse": gen_dlhouse, "stall": gen_stall, "wall": gen_wall, "flowers": gen_flowers,
    "pebble": gen_pebble, "tuft": gen_tuft,
}


def extract_one(art: str, frm: dict) -> tuple[bool, str]:
    """Returns (ok, note). Produces `art` from `frm`."""
    dst = dest_path(art)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if "gen" in frm:
        fn = GENERATORS.get(frm["gen"])
        if not fn:
            return False, f"unknown generator {frm['gen']}"
        fn(dst, frm)
        return True, f"gen:{frm['gen']}"
    rel = frm.get("copy") or frm.get("crop")
    src = os.path.join(PACKS, frm.get("pack", ""), rel) if rel else ""
    if not src or not os.path.exists(src):
        return False, f"missing source {frm.get('pack')}/{rel}"
    if "copy" in frm:
        shutil.copyfile(src, dst)
        w, h = Image.open(dst).size
        return True, f"{w}x{h}"
    x, y, cw, ch = frm["rect"]
    f0 = Image.open(src).convert("RGBA").crop((x, y, x + cw, y + ch))
    # `flipH`/`flipV`: mirror the crop, so one source sprite yields its mirrored orientations (e.g. a
    # head-left bed -> head-right; a head-up bed -> head-down) without needing a separate source tile.
    if frm.get("flipH"):
        f0 = f0.transpose(Image.FLIP_LEFT_RIGHT)
    if frm.get("flipV"):
        f0 = f0.transpose(Image.FLIP_TOP_BOTTOM)
    # `frame2`: a second sheet (DawnLike's *1.png) holding the next animation frame at the SAME rect.
    # Emit a horizontal 2-frame strip the renderer plays as a looping idle anim.
    f2rel = frm.get("frame2")
    if f2rel:
        src2 = os.path.join(PACKS, frm.get("pack", ""), f2rel)
        if not os.path.exists(src2):
            return False, f"missing frame2 {frm.get('pack')}/{f2rel}"
        f1 = Image.open(src2).convert("RGBA").crop((x, y, x + cw, y + ch))
        if frm.get("flipH"):
            f1 = f1.transpose(Image.FLIP_LEFT_RIGHT)
        if frm.get("flipV"):
            f1 = f1.transpose(Image.FLIP_TOP_BOTTOM)
        strip = Image.new("RGBA", (cw * 2, ch), (0, 0, 0, 0))
        strip.alpha_composite(f0, (0, 0))
        strip.alpha_composite(f1, (cw, 0))
        strip.save(dst)
        return True, f"{cw}x{ch} 2-frame anim @{x},{y}"
    f0.save(dst)
    return True, f"{cw}x{ch} crop@{x},{y}"


def main() -> int:
    with open(LIB) as f:
        lib = json.load(f)
    made, skipped, warned = 0, 0, 0
    for a in lib["assets"]:
        tag = a.get("tag", "?")
        jobs = []
        if a.get("from"):
            jobs.append((a["art"], a["from"]))
        for v in a.get("variants", []):
            if isinstance(v, dict) and v.get("from"):
                jobs.append((v["art"], v["from"]))
        if not jobs:
            skipped += 1
            continue
        for art, frm in jobs:
            ok, note = extract_one(art, frm)
            if ok:
                made += 1
            else:
                warned += 1
                print(f"  ✗ {tag}: {note}")
        print(f"  ✓ {tag:18} {a['kind']:9} ({len(jobs)} file{'s' if len(jobs) > 1 else ''})")
    print(f"\nextracted {made} files, skipped {skipped} (no `from`), warnings {warned}")
    return 1 if warned else 0


if __name__ == "__main__":
    sys.exit(main())
