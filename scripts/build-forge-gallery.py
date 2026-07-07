#!/usr/bin/env python3
"""The FORGE REVIEW gallery — a temporary validation page for the new procedural assets.

Reads /tmp/forge-manifest.json and writes apps/web/public/asset-review.html: every new asset at
4x and 8x zoom on a checkerboard, ANIMATED via CSS steps() for multi-frame sheets, grouped by
category, with tag/kind/size captions. Open at http://localhost:6985/asset-review.html
"""
import json
import os

ROOT = os.path.join(os.path.dirname(__file__), "..")
manifest = json.load(open("/tmp/forge-manifest.json"))

groups = {}
for m in manifest:
    groups.setdefault(m["category"], []).append(m)

ORDER = ["terrain2", "structure", "arctic", "desert", "swampland", "deepearth", "wilds",
         "campaign", "dungeon", "haunt", "nature", "beast", "boss", "gore"]
TITLES = {
    "terrain2": "Biome foundations — ground families, wall families & floors (batch 2)",
    "structure": "Ruins & structural — arches, fences, bridges, gates",
    "arctic": "Arctic & tundra",
    "desert": "Desert & badlands",
    "swampland": "Swamp & jungle",
    "deepearth": "Volcanic & underdark",
    "wilds": "Forest & farmland",
    "campaign": "Campaign — the drowned bell & the waterfront",
    "dungeon": "Dungeon & crypt",
    "haunt": "The undead house (abandoned interiors)",
    "nature": "Wilderness, labyrinth hedges & camp",
    "beast": "Animals & human foes",
    "boss": "Bosses & big foes",
    "gore": "Blood, webs & magic",
}

# The terrain2 category is 9-tile FAMILIES (base + 8 edges) + plain floors. Isolated edge tiles are
# unreadable as cards — compose each family into a 3x3 knit-preview PNG and show ONE card per family.
EDGE_SUFFIXES = ("tl", "t", "tr", "l", "r", "bl", "b", "br")
def collapse_terrain_families(items):
    from PIL import Image
    prev_dir = os.path.join(ROOT, "apps/web/public/assets/proc/terrain")
    by_tag = {m["tag"]: m for m in items}
    fams = sorted({t[: -(len(sfx) + 1)] for t in by_tag for sfx in EDGE_SUFFIXES if t.endswith("_" + sfx) and t[: -(len(sfx) + 1)] in by_tag})
    used, out = set(), []
    for fam in fams:
        block = Image.new("RGBA", (48, 48))
        layout = [["tl", "t", "tr"], ["l", None, "r"], ["bl", "b", "br"]]
        for r, row in enumerate(layout):
            for c, sfx in enumerate(row):
                tag = fam if sfx is None else f"{fam}_{sfx}"
                block.paste(Image.open(os.path.join(prev_dir, tag + ".png")), (c * 16, r * 16))
                used.add(tag)
        prev = f"_family_{fam}.png"
        block.save(os.path.join(prev_dir, prev))
        base = by_tag[fam]
        out.append({**base, "tag": f"{fam} (9-tile family)", "art": f"assets/proc/terrain/{prev}",
                    "frameW": 48, "frameH": 48, "frames": 1,
                    "desc": base["desc"] + " — base + 8 autotile edges, shown knitted"})
    out.extend(m for m in items if m["tag"] not in used)
    return out

def card(m):
    w, h, n = m["frameW"], m["frameH"], m["frames"]
    anim = ""
    if n > 1:
        # steps() animation over the horizontal sheet.
        dur = n / max(1, m.get("fps", 3))
        anim = f"animation: fr-{m['tag']} {dur:.2f}s steps({n}) infinite;"
    style4 = f"width:{w*4}px;height:{h*4}px;background-image:url('{m['art']}');background-size:{w*n*4}px {h*4}px;{anim.replace('fr-', 'f4-') if anim else ''}"
    style8 = f"width:{w*8}px;height:{h*8}px;background-image:url('{m['art']}');background-size:{w*n*8}px {h*8}px;{anim.replace('fr-', 'f8-') if anim else ''}"
    keyframes = ""
    if n > 1:
        keyframes = (f"@keyframes f4-{m['tag']} {{ to {{ background-position: -{w*n*4}px 0; }} }}"
                     f"@keyframes f8-{m['tag']} {{ to {{ background-position: -{w*n*8}px 0; }} }}")
    flags = []
    if m.get("light"): flags.append("light")
    if n > 1: flags.append(f"{n}f anim")
    if m["kind"] == "terrain": flags.append("walkable" if m.get("walkable") else "solid")
    elif not m.get("blocks", True): flags.append("walk-over")
    if m.get("footW", 1) > 1 or m.get("footH", 1) > 1: flags.append(f"{m['footW']}x{m['footH']} feet")
    return f"""<style>{keyframes}</style>
<div class="card" data-tag="{m['tag']}">
  <div class="frames"><div class="sp checker" style="{style4}"></div><div class="sp checker" style="{style8}"></div></div>
  <div class="cap"><b>{m['tag']}</b> <span class="k">{m['kind']} · {w}x{h}{' · ' + ' · '.join(flags) if flags else ''}</span></div>
  <div class="desc">{m['desc']}</div>
</div>"""

if "terrain2" in groups:
    groups["terrain2"] = collapse_terrain_families(groups["terrain2"])

sections = []
for g in ORDER:
    if g not in groups:
        continue
    cards = "\n".join(card(m) for m in groups[g])
    sections.append(f'<h2>{TITLES.get(g, g)} <span class="count">{len(groups[g])}</span></h2>\n<div class="grid">{cards}</div>')

html = f"""<!doctype html><html><head><meta charset="utf-8"><title>MythWeaver — Asset Forge review</title>
<style>
  body {{ background:#15130f; color:#e8e2d6; font:14px/1.5 ui-sans-serif,-apple-system,sans-serif; margin:0; padding:32px 40px 80px; }}
  h1 {{ font:600 26px ui-serif,Georgia,serif; color:#c9a227; margin:0 0 4px; }}
  .sub {{ color:#9a8f7d; margin:0 0 28px; }}
  h2 {{ font:600 17px ui-serif,Georgia,serif; color:#d9d2c3; border-bottom:1px solid #2b2822; padding-bottom:6px; margin:36px 0 14px; }}
  .count {{ color:#6b7080; font-size:13px; }}
  .grid {{ display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:14px; }}
  .card {{ background:#1c1a15; border:1px solid #2b2822; border-radius:8px; padding:12px; }}
  .frames {{ display:flex; gap:14px; align-items:flex-end; justify-content:safe center; min-height:96px; padding:8px 0 10px; overflow-x:auto; }}
  .sp {{ image-rendering:pixelated; background-repeat:no-repeat; flex:none; }}
  .checker {{ background-color:#26231d; box-shadow:0 0 0 1px #000 inset;
    background-blend-mode:normal; }}
  .cap {{ font-size:13px; }}
  .cap .k {{ color:#6b7080; font-size:11.5px; }}
  .desc {{ color:#9a8f7d; font-size:12px; margin-top:2px; }}
</style></head><body>
<h1>Asset Forge — review</h1>
<p class="sub">{len(manifest)} new procedural assets (DB16 / DawnLike style). Left = 4x, right = 8x. Animated sprites play at their real fps. Tell me which to redraw.</p>
{''.join(sections)}
</body></html>"""

out = os.path.join(ROOT, "apps/web/public/asset-review.html")
open(out, "w").write(html)
print(f"gallery -> {out} ({len(manifest)} assets)")
