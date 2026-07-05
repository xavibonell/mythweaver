#!/usr/bin/env python3
"""
pull-dawnlike-roster.py — promote a curated batch of DawnLike sprites into assets/library.json.

For each pick it recovers the sprite's coordinates in the ORIGINAL DawnLike sheet by exact
template-match (tommyettinger's combined sheet is pixel-identical to the originals), so the new
records crop from raw-packs/DawnLike/<dir>/<Sheet>0.png with frame2:<Sheet>1.png — i.e. properly
2-frame animated, exactly like our existing DawnLike creatures. Skips tags that already exist.

Run: python3 scripts/pull-dawnlike-roster.py   (then npm run assets:extract)
"""
import json
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
IDX = json.loads((ROOT / "assets/dawnlike-index.json").read_text())
COMBINED = Image.open(ROOT / "raw-packs/DawnLike-atlas/Dawnlike.png").convert("RGBA")
LIB_PATH = ROOT / "assets/library.json"
ATTR = "DawnLike by DragonDePlatino & DawnBringer (CC-BY 4.0); keep the bundled Platino sprite"

# (tag, exact index name, desc, biomes)
CREATURES = [
    ("kobold",      "kobold",       "a small reptilian kobold",        ["dungeon", "wild", "ruins"]),
    ("hobgoblin",   "hobgoblin",    "a disciplined hobgoblin soldier", ["dungeon", "wild", "ruins"]),
    ("bugbear",     "bugbear",      "a hulking bugbear",               ["dungeon", "wild", "ruins"]),
    ("ogre",        "ogre",         "a brutish ogre",                  ["wild", "dungeon", "ruins"]),
    ("troll",       "troll",        "a regenerating troll",            ["wild", "dungeon", "cave"]),
    ("minotaur",    "minotaur",     "a horned minotaur",               ["dungeon", "ruins"]),
    ("cyclops",     "cyclops",      "a one-eyed cyclops",              ["wild", "cave", "ruins"]),
    ("ettin",       "ettin",        "a two-headed ettin",              ["wild", "dungeon"]),
    ("giant_hill",  "hill giant",   "a hill giant",                    ["wild", "mountain", "ruins"]),
    ("giant_frost", "frost giant",  "a frost giant",                   ["wild", "mountain", "snow"]),
    ("giant_stone", "stone giant",  "a stone giant",                   ["wild", "mountain", "cave"]),
    ("bandit",      "bandit",       "a road bandit",                   ["village", "road", "wild"]),
    ("guard",       "guard",        "a town guard",                    ["village", "town", "castle"]),
    ("ghoul",       "ghoul",        "a flesh-eating ghoul",            ["dungeon", "ruins", "graveyard"]),
    ("wraith",      "wraith",       "a shrouded wraith",               ["dungeon", "ruins", "graveyard"]),
    ("ghost",       "ghost",        "a pale ghost",                    ["dungeon", "ruins", "graveyard"]),
    ("lich",        "lich",         "an undead lich",                  ["dungeon", "ruins"]),
    ("mummy",       "dwarf mummy",  "a bandaged mummy",                ["dungeon", "ruins", "desert"]),
    ("rat_giant",   "giant rat",    "a giant rat",                     ["dungeon", "sewer", "cave"]),
    ("spider_giant","giant spider", "a giant spider",                  ["dungeon", "cave", "forest"]),
    ("imp",         "imp",          "a darting imp",                   ["dungeon", "ruins"]),
    ("devil_bone",  "bone devil",   "a skeletal bone devil",           ["dungeon", "ruins"]),
    ("orc_shaman",  "orc shaman",   "an orc shaman",                   ["wild", "dungeon", "ruins"]),
]
# (tag, exact index name, desc, biomes, blocks)
PROPS = [
    ("sign_inn",    "inn sign",       "a hanging inn sign",       ["village", "town"], False),
    ("sign_smithy", "smithy sign",    "a blacksmith's sign",      ["village", "town"], False),
    ("sign_church", "church sign",    "a church sign",            ["village", "town"], False),
    ("sign_shop",   "empty shop sign","a blank shop sign",        ["village", "town"], False),
    ("sign_pub",    "pub sign",       "a tavern/pub sign",        ["village", "town"], False),
    ("sign_armory", "armory sign",    "an armory sign",           ["village", "town", "castle"], False),
    ("lantern",     "brass lantern",  "a brass lantern",          ["village", "dungeon", "interior"], False),
]

by_name = {s["name"]: s for s in IDX["sprites"]}


def cellmaps(dirs):
    """{'Dir/Stem': {tilebytes:(ox,oy)}} for every frame-0 (*0.png) sheet under the given dirs."""
    out = {}
    for d in dirs:
        for p in sorted((ROOT / "raw-packs/DawnLike" / d).glob("*0.png")):
            im = Image.open(p).convert("RGBA")
            W, H = im.size
            m = {}
            for gy in range(H // 16):
                for gx in range(W // 16):
                    m.setdefault(im.crop((gx*16, gy*16, gx*16+16, gy*16+16)).tobytes(), (gx*16, gy*16))
            out[f"{d}/{p.stem}"] = m
    return out


def match(sprite, maps):
    tile = COMBINED.crop((sprite["x"], sprite["y"], sprite["x"]+16, sprite["y"]+16)).tobytes()
    for key, m in maps.items():
        if tile in m:
            d, stem = key.split("/")
            sib = ROOT / "raw-packs/DawnLike" / d / f"{stem[:-1]}1.png"
            ox, oy = m[tile]
            return d, stem, ox, oy, (f"{d}/{stem[:-1]}1.png" if sib.exists() else None)
    return None


def main():
    lib = json.loads(LIB_PATH.read_text())
    existing = {a.get("tag") for a in lib["assets"]}
    char_maps = cellmaps(["Characters"])
    prop_maps = cellmaps(["Objects", "Items"])

    added, skipped, failed = [], [], []
    new_records = []

    def build(tag, name, desc, biomes, maps, kind, blocks=None):
        if tag in existing:
            skipped.append(f"{tag} (exists)"); return
        s = by_name.get(name)
        if not s:
            failed.append(f"{tag} ← '{name}' (not in index)"); return
        hit = match(s, maps)
        if not hit:
            failed.append(f"{tag} ← '{name}' (no sheet match)"); return
        d, stem, ox, oy, frame2 = hit
        animated = frame2 is not None and s["frames"] > 1
        art = f"/assets/dawnlike/{'char' if kind=='character' else 'props'}/{tag}.png"
        rec = {"kind": kind, "tag": tag, "desc": desc, "biomes": biomes, "art": art,
               "frameW": 16, "frameH": 16}
        if kind == "character":
            rec["idleFrames"] = 2 if animated else 1
            rec["fps"] = 3
        else:
            rec["frames"] = 2 if animated else 1
            if animated: rec["fps"] = 3
            rec["footW"] = 1; rec["footH"] = 1; rec["blocks"] = bool(blocks)
        frm = {"pack": "DawnLike", "crop": f"{d}/{stem}.png", "rect": [ox, oy, 16, 16]}
        if animated: frm["frame2"] = frame2
        rec["from"] = frm
        rec["license"] = "CC-BY-4.0"
        rec["attribution"] = ATTR
        new_records.append(rec); existing.add(tag)
        added.append(f"{tag:14} {d}/{stem}.png ({ox},{oy}){'  anim' if animated else ''}")

    for tag, name, desc, biomes in CREATURES:
        build(tag, name, desc, biomes, char_maps, "character")
    for tag, name, desc, biomes, blocks in PROPS:
        build(tag, name, desc, biomes, prop_maps, "prop", blocks)

    lib["assets"].extend(new_records)
    LIB_PATH.write_text(json.dumps(lib, indent=2, ensure_ascii=True) + "\n")

    print(f"ADDED {len(added)}:")
    for a in added: print("  +", a)
    if skipped: print(f"\nSKIPPED {len(skipped)}: " + ", ".join(skipped))
    if failed: print(f"\nFAILED {len(failed)}:\n  " + "\n  ".join(failed))
    print(f"\nlibrary.json now has {len(lib['assets'])} records")


if __name__ == "__main__":
    main()
