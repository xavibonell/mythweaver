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

ORDER = ["campaign", "dungeon", "haunt", "nature", "beast", "boss", "gore"]
TITLES = {
    "campaign": "Campaign — the drowned bell & the waterfront",
    "dungeon": "Dungeon & crypt",
    "haunt": "The undead house (abandoned interiors)",
    "nature": "Wilderness, labyrinth hedges & camp",
    "beast": "Animals & human foes",
    "boss": "Bosses & big foes",
    "gore": "Blood, webs & magic",
}

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
  .frames {{ display:flex; gap:14px; align-items:flex-end; justify-content:center; min-height:96px; padding:8px 0 10px; }}
  .sp {{ image-rendering:pixelated; background-repeat:no-repeat; }}
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
