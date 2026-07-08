#!/usr/bin/env python3
"""STEP 3a — extract the creature + prop candidates from the DawnLike atlas and build labeled contact
sheets for the vision-labeling workflow.

Reads assets/dawnlike-index.json (names + atlas coords + frames), filters to the creature/prop
buckets (dedup vs the live library, drop GUI/Map/terrain-families/junk), crops each sprite from
raw-packs/DawnLike-atlas/Dawnlike.png (composing multi-frame into a horizontal sheet), and writes:
  - apps/web/public/assets/dawnlike-atlas/{char,props}/<slug>.png  (the art)
  - /tmp/dawnlike-3a/candidates.json                                (metadata + from-record)
  - /tmp/dawnlike-3a/sheets/chunk-NN.png                            (labeled 5x contact sheets, ~40/sheet)
"""
import json
import os
from PIL import Image, ImageDraw

ROOT = os.path.join(os.path.dirname(__file__), "..")
ATLAS = Image.open(os.path.join(ROOT, "raw-packs/DawnLike-atlas/Dawnlike.png")).convert("RGBA")
OUT_CHAR = os.path.join(ROOT, "apps/web/public/assets/dawnlike-atlas/char")
OUT_PROP = os.path.join(ROOT, "apps/web/public/assets/dawnlike-atlas/props")
for d in (OUT_CHAR, OUT_PROP):
    os.makedirs(d, exist_ok=True)
SHEETS = "/tmp/dawnlike-3a/sheets"
os.makedirs(SHEETS, exist_ok=True)

idx = json.load(open(os.path.join(ROOT, "assets/dawnlike-index.json")))
lib = json.load(open(os.path.join(ROOT, "assets/library.json")))
libtags = {a["tag"] for a in lib["assets"]}

CREATURE_CATS = {"Humanoid0", "Reptile0", "Avian0", "Demon0", "Undead0", "Elemental0", "Pest0",
                 "Quadruped0", "Aquatic0", "Dog0", "Cat0", "Slime0", "Rodent0", "Player0"}
PROP_CATS = {"Decor", "Flesh", "Plant0", "Fence", "Door_Closed", "Door_Open", "Chest_Closed",
             "Chest_Open", "Trap", "Light", "Ground", "Rock", "Ore0", "Misc0", "Tool", "Music",
             "Icons", "uncategorized"}
# Deferred to later passes: item-clutter (recolor-heavy inventory) + terrain autotile families.

def bucket(cat):
    if cat in CREATURE_CATS:
        return "char"
    if cat in PROP_CATS:
        return "prop"
    return None  # clutter / terrain-family / GUI / Map → not this pass

def frame_positions(s):
    if s.get("framesXY"):
        return [(x, y) for x, y in s["framesXY"]]
    return [(s["x"], s["y"])]

def extract(s):
    """Crop the sprite; multi-frame → a horizontal N-frame sheet. Returns (image, nframes)."""
    fps = frame_positions(s)
    w, h = s["w"], s["h"]
    if len(fps) == 1:
        return ATLAS.crop((fps[0][0], fps[0][1], fps[0][0] + w, fps[0][1] + h)), 1
    sheet = Image.new("RGBA", (w * len(fps), h), (0, 0, 0, 0))
    for i, (x, y) in enumerate(fps):
        sheet.paste(ATLAS.crop((x, y, x + w, y + h)), (i * w, 0))
    return sheet, len(fps)

# ── directional-suffix collapse ──────────────────────────────────────────────────────────────────
# DawnLike encodes two different things with directional suffixes:
#   • AUTOTILE features (volcano/tree/pool connectivity) — have DIAGONAL suffixes (_ne/_nw/_se/_sw) or
#     many members. These are terrain FAMILIES → deferred to the 3b pass, dropped here.
#   • Creature FACINGS (mage_n/s/e/w) — only the 4 cardinals. Our engine uses one idle sprite (+flipX),
#     so keep ONE canonical facing (prefer _s / front), promoted under the family base name.
import re as _re
DIR = _re.compile(r"_(n|s|e|w|ne|nw|se|sw)$")
DIAG = _re.compile(r"_(ne|nw|se|sw)$")
by_slug = {s["slug"]: s for s in idx["sprites"]}
fam_members = {}
for s in idx["sprites"]:
    if DIR.search(s["slug"]):
        base = DIR.sub("", s["slug"])
        fam_members.setdefault(base, []).append(s["slug"])

def facing_keeper(slug):
    """For a plain-cardinal creature-facing family, the canonical slug to keep (else None = drop)."""
    m = DIR.search(slug)
    if not m:
        return None  # not directional
    base = DIR.sub("", slug)
    members = fam_members.get(base, [])
    autotile = any(DIAG.search(x) for x in members) or len(members) > 4 or base in by_slug
    if autotile:
        return "DROP"  # terrain-autotile family / redundant with a plain base → defer/skip
    # creature facing: keep _s if present else the first member alphabetically, rename → base
    pick = base + "_s" if base + "_s" in members else sorted(members)[0]
    return base if slug == pick else "DROP"

candidates = []
for s in idx["sprites"]:
    if s["w"] != 16 or s["h"] != 16:
        continue  # the two atlas-junk entries
    if s["slug"] in libtags or s["inLibrary"]:
        continue  # already promoted
    b = bucket(s["category"])
    if not b:
        continue
    promote_slug = s["slug"]
    keep = facing_keeper(s["slug"])
    if keep == "DROP":
        continue
    if keep:  # a creature facing kept under its family base name
        promote_slug = keep
    img, nframes = extract(s)
    if not img.getbbox():
        continue  # fully transparent → skip
    sub = OUT_CHAR if b == "char" else OUT_PROP
    art = os.path.join(sub, promote_slug + ".png")
    img.save(art)
    candidates.append({
        "slug": promote_slug, "name": s["name"], "category": s["category"], "kind": b,
        "frames": nframes, "art": "/" + art.split("apps/web/public/")[-1],
        "from": {"pack": "DawnLike-atlas", "crop": "Dawnlike.png", "frames": frame_positions(s), "wh": [16, 16]},
    })

json.dump(candidates, open("/tmp/dawnlike-3a/candidates.json", "w"), indent=1)
print(f"extracted {len(candidates)} candidates ({sum(c['kind']=='char' for c in candidates)} char, {sum(c['kind']=='prop' for c in candidates)} prop)")

# ── labeled contact sheets (frame-1 only, 5x, ~40 per sheet) for the vision agents ──
Z, PER, COLS = 5, 40, 8
cell_w, cell_h = 16 * Z + 8, 16 * Z + 20
chunks = [candidates[i:i + PER] for i in range(0, len(candidates), PER)]
for ci, chunk in enumerate(chunks):
    rows = (len(chunk) + COLS - 1) // COLS
    sheet = Image.new("RGBA", (COLS * cell_w + 8, rows * cell_h + 8), (26, 24, 30, 255))
    d = ImageDraw.Draw(sheet)
    for i, c in enumerate(chunk):
        gx, gy = 8 + (i % COLS) * cell_w, 8 + (i // COLS) * cell_h
        art = Image.open(os.path.join(ROOT, "apps/web/public" + c["art"]))
        f0 = art.crop((0, 0, 16, 16)).resize((16 * Z, 16 * Z), Image.NEAREST)
        sheet.paste(f0, (gx, gy), f0)
        gi = ci * PER + i  # GLOBAL index into candidates.json
        d.text((gx, gy + 16 * Z + 1), f"{gi}", fill=(240, 220, 120, 255))
        d.text((gx + 18, gy + 16 * Z + 1), c["slug"][:14], fill=(210, 210, 200, 255))
    sheet.save(os.path.join(SHEETS, f"chunk-{ci:02d}.png"))
print(f"{len(chunks)} contact sheets -> {SHEETS}")
