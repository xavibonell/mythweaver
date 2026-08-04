#!/usr/bin/env python3
"""STEP 3b+3c — extract the terrain-family canon tiles + tree types (3b) and the item-clutter (3c)
from the DawnLike atlas, cluster recolors onto shared sheets, and build contact sheets for labeling.

3b: keep only the CANONICAL tile per material (Floor *_c, Hill *_c/_alone, Pit *_center, Tree *_dense,
Tile singles) — the directional/connectivity pieces are dropped (we render these as flat fills, not
autotiled). Wall is skipped (recolor-heavy + would need bake wiring; the forge already gives walls).
Time-of-day prefixes (day/dusk/morning/night) are stripped — they're lighting, which the engine owns.
3c: the inventory item categories, as occasional scene LOOT/dressing (collapse recolors hard).

Recolors are CLUSTER-SORTED (by trailing noun) so palette-swaps land on the same sheet and the vision
agents can collapse them (per-sheet dedup only sees its own sheet).
Writes apps/web/public/assets/dawnlike-atlas/{char,props,terrain}/<tag>.png + /tmp/dawnlike-bc/{candidates.json,chunk-NN.json,sheets/}.
"""
import json
import os
import re
from PIL import Image, ImageDraw

ROOT = os.path.join(os.path.dirname(__file__), "..")
ATLAS = Image.open(os.path.join(ROOT, "raw-packs/DawnLike-atlas/Dawnlike.png")).convert("RGBA")
OUTP = {"prop": os.path.join(ROOT, "apps/web/public/assets/dawnlike-atlas/props"),
        "terrain": os.path.join(ROOT, "apps/web/public/assets/dawnlike-atlas/terrain")}
for d in OUTP.values():
    os.makedirs(d, exist_ok=True)
SHEETS = "/tmp/dawnlike-bc/sheets"
os.makedirs(SHEETS, exist_ok=True)

idx = json.load(open(os.path.join(ROOT, "assets/dawnlike-index.json")))
lib = json.load(open(os.path.join(ROOT, "assets/library.json")))
libtags = {a["tag"] for a in lib["assets"]}
TIMES = re.compile(r"^(day|dusk|night|morning|evening|dawn|noon|twilight|midnight)_")
COLOR = re.compile(r"^(blue|brown|green|dark|gray|grey|white|red|black)_")

def canon(s):
    """→ (tag, kind, section) for a 3b/3c candidate, else None."""
    cat, slug = s["category"], s["slug"]
    if cat == "Tree" and slug.endswith("_dense"):
        return slug[:-6], "prop", "3b-tree"
    if cat == "Floor" and slug.endswith("_c"):
        return TIMES.sub("", slug[:-2]), "terrain", "3b-floor"
    if cat == "Tile":
        return slug, "terrain", "3b-floor"
    if cat == "Hill" and slug.endswith("_c"):
        return COLOR.sub("", slug[:-2]) or slug[:-2], "terrain", "3b-hill"
    if cat == "Hill" and slug.endswith("_alone"):
        return COLOR.sub("", slug[:-6]) or slug[:-6], "prop", "3b-hill"
    if cat == "Pit" and slug.endswith("_center"):
        return slug[:-7], "terrain", "3b-pit"
    ITEMS = {"Book", "Money", "Armor", "Wand", "Ring", "Scroll", "Food", "Potion", "LongWep",
             "ShortWep", "MedWep", "Ammo", "Amulet", "Hat", "Boots", "Glove", "Key", "Shield"}
    if cat in ITEMS:
        return slug, "prop", "3c-item"
    return None  # Wall / already-3a / GUI / creatures → not this pass

def frames_xy(s):
    return [(x, y) for x, y in s["framesXY"]] if s.get("framesXY") else [(s["x"], s["y"])]

def crop(fps):
    if len(fps) == 1:
        return ATLAS.crop((fps[0][0], fps[0][1], fps[0][0] + 16, fps[0][1] + 16)), 1
    sh = Image.new("RGBA", (16 * len(fps), 16), (0, 0, 0, 0))
    for i, (x, y) in enumerate(fps):
        sh.paste(ATLAS.crop((x, y, x + 16, y + 16)), (i * 16, 0))
    return sh, len(fps)

seen, rows = set(), []
for s in idx["sprites"]:
    if s["w"] != 16 or s["h"] != 16:
        continue
    c = canon(s)
    if not c:
        continue
    tag, kind, section = c
    if tag in libtags or tag in seen:
        continue
    fps = frames_xy(s)
    img, nf = crop(fps)
    if not img.getbbox():
        continue
    seen.add(tag)
    rows.append({"tag": tag, "slug": s["slug"], "name": s["name"], "category": s["category"],
                 "kind": kind, "section": section, "frames": nf, "fps": fps})

# CLUSTER-SORT: (section, trailing-noun, tag) so recolors of one item/material are adjacent.
rows.sort(key=lambda r: (r["section"], list(reversed(r["tag"].split("_"))), r["tag"]))

candidates = []
for r in rows:
    img, nf = crop(r["fps"])
    art = os.path.join(OUTP[r["kind"]], r["tag"] + ".png")
    img.save(art)
    candidates.append({
        "tag": r["tag"], "slug": r["slug"], "name": r["name"], "category": r["category"],
        "kind": r["kind"], "section": r["section"], "frames": nf,
        "art": "/" + art.split("apps/web/public/")[-1],
        "from": {"pack": "DawnLike-atlas", "crop": "Dawnlike.png", "frames": r["fps"], "wh": [16, 16]},
    })

os.makedirs("/tmp/dawnlike-bc", exist_ok=True)
json.dump(candidates, open("/tmp/dawnlike-bc/candidates.json", "w"), indent=1)
from collections import Counter
print(f"extracted {len(candidates)} candidates:", dict(Counter(c["section"] for c in candidates)))

# per-chunk metadata + labeled contact sheets
PER, Z, COLS = 40, 5, 8
cw, ch = 16 * Z + 8, 16 * Z + 20
for ci in range(0, len(candidates), PER):
    chunk = candidates[ci:ci + PER]
    meta = [{"i": ci + j, "tag": c["tag"], "kind": c["kind"], "section": c["section"],
             "frames": c["frames"], "category": c["category"]} for j, c in enumerate(chunk)]
    json.dump(meta, open(f"/tmp/dawnlike-bc/chunk-{ci // PER:02d}.json", "w"), indent=0)
    r = (len(chunk) + COLS - 1) // COLS
    sheet = Image.new("RGBA", (COLS * cw + 8, r * ch + 8), (26, 24, 30, 255))
    d = ImageDraw.Draw(sheet)
    for j, c in enumerate(chunk):
        gx, gy = 8 + (j % COLS) * cw, 8 + (j // COLS) * ch
        f0 = Image.open(os.path.join(ROOT, "apps/web/public" + c["art"])).crop((0, 0, 16, 16)).resize((16 * Z, 16 * Z), Image.NEAREST)
        sheet.paste(f0, (gx, gy), f0)
        d.text((gx, gy + 16 * Z + 1), f"{ci + j}", fill=(240, 220, 120, 255))
        d.text((gx + 18, gy + 16 * Z + 1), c["tag"][:14], fill=(210, 210, 200, 255))
    sheet.save(os.path.join(SHEETS, f"chunk-{ci // PER:02d}.png"))
print(f"{(len(candidates) + PER - 1) // PER} contact sheets -> {SHEETS}")
