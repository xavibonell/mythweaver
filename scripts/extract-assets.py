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


GENERATORS = {"water": gen_water, "water_deep": gen_water_deep, "sand": gen_sand, "boat": gen_boat, "house": gen_house, "fountain": gen_fountain}


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
    # `frame2`: a second sheet (DawnLike's *1.png) holding the next animation frame at the SAME rect.
    # Emit a horizontal 2-frame strip the renderer plays as a looping idle anim.
    f2rel = frm.get("frame2")
    if f2rel:
        src2 = os.path.join(PACKS, frm.get("pack", ""), f2rel)
        if not os.path.exists(src2):
            return False, f"missing frame2 {frm.get('pack')}/{f2rel}"
        f1 = Image.open(src2).convert("RGBA").crop((x, y, x + cw, y + ch))
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
