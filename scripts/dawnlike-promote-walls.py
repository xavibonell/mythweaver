#!/usr/bin/env python3
"""STEP 3d — promote the DawnLike WALL material families (the last content gap).

DawnLike walls are 13-tile CONNECTIVITY autotiles named by which sides have a wall neighbour
(center/left_right/up_down/left_up/…). Our bake (bakeWoodWalls + building + wallTagFor) expects the
9-tile suffix family base + _t/_b/_l/_r/_tl/_tr/_bl/_br. The mapping is geometric (falsified on brick):
  base <- center      _t,_b <- left_right    _l,_r <- up_down
  _tl <- right_down   _tr <- left_down       _bl <- right_up    _br <- left_up
48 wall "materials" = 4 lighting levels x 12 true materials; keep the BRIGHT level (the engine's own
lighting darkens it), skip 'ice' (forge already has wall_ice). Registers each as internal terrain
(walkable=false) — walls are engine-assigned via a theme's wallMat, never named by the Director, so
they stay OUT of the retrieval menu (the theme axis carries them; see themes.ts WallMat).
"""
import json
import os
from PIL import Image

ROOT = os.path.join(os.path.dirname(__file__), "..")
ATLAS = Image.open(os.path.join(ROOT, "raw-packs/DawnLike-atlas/Dawnlike.png")).convert("RGBA")
OUT = os.path.join(ROOT, "apps/web/public/assets/dawnlike-atlas/terrain")
os.makedirs(OUT, exist_ok=True)
idx = json.load(open(os.path.join(ROOT, "assets/dawnlike-index.json")))
byslug = {s["slug"]: s for s in idx["sprites"]}
LIB = os.path.join(ROOT, "assets/library.json")
lib = json.load(open(LIB))
existing = {a["tag"] for a in lib["assets"]}

SUFFIX_POS = {"": "center", "_t": "left_right", "_b": "left_right", "_l": "up_down", "_r": "up_down",
              "_tl": "right_down", "_tr": "left_down", "_bl": "right_up", "_br": "left_up"}
LIGHT = "bright"
MATERIALS = {  # material -> retrieval-style description (for provenance/docs; not embedded)
    "acid": "a corroded, acid-etched green stone wall",
    "blue": "a cold blue-grey dungeon wall",
    "brick": "a wall of laid masonry brick",
    "deep": "a wall of deep dark stone, far underground",
    "fort": "a heavy fitted-stone fortress wall",
    "heat": "a heat-scorched dark stone wall",
    "infernal": "a hellish wall of blackened infernal stone",
    "mine": "a rough-hewn mine-shaft wall",
    "orange": "a warm sandstone-orange dungeon wall",
    "rock": "a natural rough rock cavern wall",
    "snow": "a wall of packed snow and frost",
}

def crop(slug):
    s = byslug[slug]
    return ATLAS.crop((s["x"], s["y"], s["x"] + 16, s["y"] + 16))

added, skipped = 0, 0
for mat, desc in MATERIALS.items():
    base_tag = f"wall_{mat}"
    if base_tag in existing:
        skipped += 1
        print(f"  skip {base_tag} (exists)")
        continue
    for suf, pos in SUFFIX_POS.items():
        tag = base_tag + suf
        src = f"{LIGHT}_{mat}_wall_{pos}"
        if src not in byslug:
            print(f"  MISSING atlas sprite {src}")
            continue
        art_rel = f"assets/dawnlike-atlas/terrain/{tag}.png"
        crop(src).save(os.path.join(ROOT, "apps/web/public", art_rel))
        lib["assets"].append({
            "kind": "terrain", "tag": tag, "desc": desc,
            "walkable": False, "internal": True,  # engine-assigned via theme.wallMat, not Director-painted
            "biomes": [], "variants": [{"art": "/" + art_rel,
                        "from": {"pack": "DawnLike-atlas", "crop": "Dawnlike.png", "src": src, "wh": [16, 16]}}],
            "license": "CC0 (DawnLike, DragonDePlatino & DawnBringer)",
            "attribution": "DawnLike 1.4 (CC0) via DawnLikeAtlas",
        })
        added += 1
    print(f"  + {base_tag} (9 tiles)")

json.dump(lib, open(LIB, "w"), indent=2)
print(f"\nwall families: +{added} tiles ({added // 9} materials), {skipped} skipped -> library {len(lib['assets'])}")
