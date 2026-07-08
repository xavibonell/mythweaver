#!/usr/bin/env python3
"""Validation gallery for the promoted DawnLike-atlas assets → apps/web/public/dawnlike-promoted.html.
Groups by source category; each card shows the sprite (4x + 8x, animated at fps), tag, kind, params,
and the retrieval description. So the promotion can be eyeballed end to end."""
import json
import os
from collections import defaultdict

ROOT = os.path.join(os.path.dirname(__file__), "..")
lib = json.load(open(os.path.join(ROOT, "assets/library.json")))
nu = [a for a in lib["assets"] if a.get("from", {}).get("pack") == "DawnLike-atlas"]
groups = defaultdict(list)
for a in nu:
    # recover the source category from the atlas index for grouping
    groups[a["kind"]].append(a)

def card(a):
    fr = a.get("frames") or a.get("idleFrames") or 1
    w = h = 16
    anim = ""
    kf = ""
    if fr > 1:
        dur = fr / max(1, a.get("fps", 3))
        anim = f"animation: fr-{a['tag']} {dur:.2f}s steps({fr}) infinite;"
        kf = (f"@keyframes f4-{a['tag']}{{to{{background-position:-{w*fr*4}px 0}}}}"
              f"@keyframes f8-{a['tag']}{{to{{background-position:-{w*fr*8}px 0}}}}")
    s4 = f"width:{w*4}px;height:{h*4}px;background-image:url('{a['art']}');background-size:{w*fr*4}px {h*4}px;{anim.replace('fr-','f4-') if anim else ''}"
    s8 = f"width:{w*8}px;height:{h*8}px;background-image:url('{a['art']}');background-size:{w*fr*8}px {h*8}px;{anim.replace('fr-','f8-') if anim else ''}"
    flags = [a["kind"]]
    if fr > 1: flags.append(f"{fr}f")
    if a["kind"] == "prop":
        flags.append("solid" if a.get("blocks", True) else "walk-over")
        if a.get("light"): flags.append("light")
    if a.get("biomes"): flags.append("·".join(a["biomes"]))
    return f"""<style>{kf}</style><div class="card">
<div class="fr"><div class="sp" style="{s4}"></div><div class="sp" style="{s8}"></div></div>
<div class="cap"><b>{a['tag']}</b> <span class="k">{' · '.join(flags)}</span></div>
<div class="d">{a.get('desc','')}</div></div>"""

sections = []
for k in ("character", "prop"):
    items = sorted(groups.get(k, []), key=lambda a: a["tag"])
    title = "Creatures" if k == "character" else "Props & scene dressing"
    sections.append(f'<h2>{title} <span class="c">{len(items)}</span></h2><div class="grid">{"".join(card(a) for a in items)}</div>')

html = f"""<!doctype html><html><head><meta charset="utf-8"><title>DawnLike promotion — review</title><style>
body{{background:#15130f;color:#e8e2d6;font:14px/1.5 ui-sans-serif,-apple-system,sans-serif;margin:0;padding:28px 36px 80px}}
h1{{font:600 24px ui-serif,Georgia,serif;color:#c9a227;margin:0 0 2px}} .sub{{color:#9a8f7d;margin:0 0 24px}}
h2{{font:600 17px ui-serif,Georgia,serif;color:#d9d2c3;border-bottom:1px solid #2b2822;padding-bottom:6px;margin:32px 0 14px}}
.c{{color:#6b7080;font-size:13px}} .grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}}
.card{{background:#1c1a15;border:1px solid #2b2822;border-radius:8px;padding:10px}}
.fr{{display:flex;gap:12px;align-items:flex-end;justify-content:center;min-height:80px;padding:6px 0 8px}}
.sp{{image-rendering:pixelated;background-repeat:no-repeat;flex:none;box-shadow:0 0 0 1px #000 inset;background-color:#26231d}}
.cap{{font-size:13px}} .cap .k{{color:#6b7080;font-size:11px}} .d{{color:#9a8f7d;font-size:12px;margin-top:2px}}
</style></head><body><h1>DawnLike promotion — {len(nu)} new assets</h1>
<p class="sub">Creatures + props mass-promoted from the DawnLike atlas (CC0) into the library + retrieval index. Left 4x, right 8x; animated at real fps. Descriptions are the retrieval embedding text.</p>
{''.join(sections)}</body></html>"""
out = os.path.join(ROOT, "apps/web/public/dawnlike-promoted.html")
open(out, "w").write(html)
print(f"gallery -> {out} ({len(nu)} assets)")
