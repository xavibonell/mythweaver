#!/usr/bin/env python3
"""
build-sprite-index.py — the DawnLike SPRITE INDEX (authoring layer behind the curated catalog).

Parses tommyettinger's DawnLikeAtlas (raw-packs/DawnLike-atlas/) — the libGDX .atlas coordinate
manifest + image_names.tsv category grid — into:
  1. assets/dawnlike-index.json  — lean, machine-usable: every named sprite with category + coords.
  2. apps/web/public/sprite-index.html — a self-contained searchable gallery (embedded sheet + CSS
     sprite thumbnails); type a name, filter by category, click a sprite to copy a ready-to-paste
     library.json record so promoting a sprite into the live catalog is copy → tweak tag → extract.

The atlas is the ONLY thing we take from tommyettinger (his repacked Dawnlike.png doubles as a crop
source: from:{pack:"DawnLike-atlas", crop:"Dawnlike.png", rect:[x,y,16,16]}). CC-BY 4.0 — credit
DragonDePlatino & DawnBringer. Run: python3 scripts/build-sprite-index.py
"""
import base64
import json
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "raw-packs" / "DawnLike-atlas"
ATLAS = SRC / "Dawnlike.atlas"
TSV = SRC / "image_names.tsv"
SHEET = SRC / "Dawnlike.png"
LIB = ROOT / "assets" / "library.json"
OUT_JSON = ROOT / "assets" / "dawnlike-index.json"
OUT_HTML = ROOT / "apps" / "web" / "public" / "sprite-index.html"

# category (original DawnLike sheet family) -> our library `kind` hint for the copy-snippet
CHAR_CATS = {"Aquatic0", "Aquatic1", "Avian", "Cat", "Dog", "Demon", "Elemental", "Humanoid0",
             "Humanoid1", "Humanoid2", "Humanoid3", "Pest", "Pet", "Reptile", "Rodent", "Undead",
             "Slime", "Plant", "Quadruped", "Fish", "Insect", "Mystic", "Player0", "Player1"}
TERRAIN_CATS = {"Floor", "Ground0", "Ground1", "Tile", "Hills", "Wall"}


def parse_atlas(path):
    """name -> {frames:[(x,y),...] by index, w, h}. Animated names appear once per frame."""
    sprites = {}
    name = None
    cur = None
    with open(path, encoding="utf-8") as f:
        lines = f.read().splitlines()
    # skip the 6-line page header (blank, Dawnlike.png, size, format, filter, repeat)
    for line in lines[6:]:
        if not line:
            continue
        if not line.startswith(" ") and not line.startswith("\t"):
            name = line
            cur = sprites.setdefault(name, {"frames": [], "w": 16, "h": 16})
            continue
        key, _, val = line.strip().partition(":")
        val = val.strip()
        if key == "xy":
            x, y = (int(v) for v in val.split(","))
            cur["_xy"] = (x, y)
        elif key == "size":
            w, h = (int(v) for v in val.split(","))
            cur["w"], cur["h"] = w, h
        elif key == "index":
            cur["frames"].append((int(val), cur.pop("_xy")))
    # order frames by index, drop the index number
    for s in sprites.values():
        s["frames"] = [xy for _, xy in sorted(s["frames"], key=lambda t: t[0])]
    return sprites


def parse_categories(path):
    """name -> category. The tsv is a grid: a blank row, a lone category header, then rows of names."""
    name_cat = {}
    cats = []
    cur = "uncategorized"
    prev_blank = True
    with open(path, encoding="utf-8") as f:
        rows = f.read().splitlines()
    for row in rows[1:]:  # skip the Column1..Column21 header
        cells = [c.strip() for c in row.split("\t")]
        nonempty = [c for c in cells if c]
        if not nonempty:
            prev_blank = True
            continue
        if len(nonempty) == 1 and prev_blank:
            cur = nonempty[0]
            if cur not in cats:
                cats.append(cur)
            prev_blank = False
            continue
        for c in nonempty:
            name_cat.setdefault(c, cur)
        prev_blank = False
    return name_cat, cats


def kind_for(cat):
    if cat in CHAR_CATS:
        return "character"
    if cat in TERRAIN_CATS:
        return "terrain"
    return "prop"


def slug(name):
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


def main():
    for p in (ATLAS, TSV, SHEET):
        if not p.exists():
            raise SystemExit(f"missing source: {p} — run the download step first")

    sprites = parse_atlas(ATLAS)
    name_cat, cat_order = parse_categories(TSV)

    # existing library tags (best-effort exact-name coverage flag)
    lib_tags = set()
    if LIB.exists():
        lib = json.loads(LIB.read_text())
        for a in lib.get("assets", []):
            if isinstance(a.get("tag"), str):
                lib_tags.add(a["tag"].lower())

    index = []
    matched_cat = 0
    for name in sorted(sprites):
        s = sprites[name]
        if not s["frames"]:
            continue
        cat = name_cat.get(name, "uncategorized")
        if cat != "uncategorized":
            matched_cat += 1
        x, y = s["frames"][0]
        index.append({
            "name": name,
            "slug": slug(name),
            "category": cat,
            "kind": kind_for(cat),
            "x": x, "y": y, "w": s["w"], "h": s["h"],
            "frames": len(s["frames"]),
            "framesXY": s["frames"] if len(s["frames"]) > 1 else None,
            "inLibrary": slug(name) in lib_tags or name.lower() in lib_tags,
        })

    # category histogram (only cats that actually have indexed sprites), preserving tsv order
    used = {}
    for e in index:
        used[e["category"]] = used.get(e["category"], 0) + 1
    cats = [{"name": c, "count": used[c]} for c in cat_order if c in used]
    if "uncategorized" in used:
        cats.append({"name": "uncategorized", "count": used["uncategorized"]})

    payload = {
        "source": "tommyettinger/DawnLikeAtlas (Dawnlike.atlas)",
        "sheet": "raw-packs/DawnLike-atlas/Dawnlike.png",
        "license": "CC-BY 4.0 — DawnLike by DragonDePlatino & DawnBringer; atlas by Tommy Ettinger",
        "tile": 16,
        "count": len(index),
        "inLibrary": sum(1 for e in index if e["inLibrary"]),
        "categories": cats,
        "sprites": index,
    }
    OUT_JSON.write_text(json.dumps(payload, indent=0))

    # ---- HTML gallery (one embedded sheet, CSS-sprite thumbnails, vanilla JS search/filter) ----
    sheet_b64 = base64.b64encode(SHEET.read_bytes()).decode()
    from PIL import Image
    sw, sh = Image.open(SHEET).size
    js_sprites = json.dumps([
        {"n": e["name"], "s": e["slug"], "c": e["category"], "k": e["kind"],
         "x": e["x"], "y": e["y"], "f": e["frames"], "L": 1 if e["inLibrary"] else 0}
        for e in index
    ], separators=(",", ":"))
    js_cats = json.dumps(cats, separators=(",", ":"))
    html = HTML_TEMPLATE
    html = html.replace("__COUNT__", str(len(index)))
    html = html.replace("__INLIB__", str(payload["inLibrary"]))
    html = html.replace("__SHEET_W__", str(sw)).replace("__SHEET_H__", str(sh))
    html = html.replace("__SHEET_B64__", sheet_b64)
    html = html.replace("__SPRITES__", js_sprites)
    html = html.replace("__CATS__", js_cats)
    OUT_HTML.write_text(html)

    print(f"parsed {len(sprites)} atlas names -> {len(index)} indexed sprites")
    print(f"category-matched: {matched_cat}/{len(index)}  ({len(cats)} categories)")
    print(f"exact-name-in-library: {payload['inLibrary']}")
    print(f"wrote {OUT_JSON.relative_to(ROOT)}  ({OUT_JSON.stat().st_size//1024} KB)")
    print(f"wrote {OUT_HTML.relative_to(ROOT)}  ({OUT_HTML.stat().st_size//1024} KB)")
    print("open: http://localhost:6985/sprite-index.html (web server) or the file directly")


HTML_TEMPLATE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DawnLike sprite index</title>
<style>
  :root{--sheet:url(data:image/png;base64,__SHEET_B64__);--z:3}
  *{box-sizing:border-box}
  body{margin:0;font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#14161a;color:#e6e8ec}
  header{position:sticky;top:0;z-index:5;background:#1b1e24;border-bottom:1px solid #2a2f38;padding:10px 14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  header h1{font-size:15px;font-weight:600;margin:0;color:#fff}
  header .muted{color:#8a92a0;font-size:12px}
  #q{flex:1;min-width:180px;background:#0f1115;border:1px solid #2a2f38;color:#e6e8ec;border-radius:6px;padding:7px 10px;font-size:14px}
  #q:focus{outline:none;border-color:#4b7bec}
  select,button{background:#0f1115;border:1px solid #2a2f38;color:#e6e8ec;border-radius:6px;padding:7px 9px;font-size:13px;cursor:pointer}
  #grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(84px,1fr));gap:6px;padding:12px}
  .card{background:#1b1e24;border:1px solid #232833;border-radius:7px;padding:8px 4px 5px;text-align:center;cursor:pointer;transition:border-color .1s,background .1s;overflow:hidden;content-visibility:auto;contain-intrinsic-size:auto 100px}
  .card:hover{border-color:#4b7bec;background:#20242c}
  .card.lib{border-color:#2e7d5b}
  .thumb{width:calc(16px*var(--z));height:calc(16px*var(--z));margin:0 auto 5px;background-image:var(--sheet);background-repeat:no-repeat;image-rendering:pixelated;background-size:calc(__SHEET_W__px*var(--z)) calc(__SHEET_H__px*var(--z))}
  .nm{font-size:10.5px;line-height:1.25;color:#c3c9d2;word-break:break-word;max-height:2.5em;overflow:hidden}
  .card:hover .nm{color:#fff}
  .badge{display:inline-block;font-size:9px;color:#5fd0a0;margin-top:2px}
  .anim{position:relative}
  .anim::after{content:"◆";position:absolute;top:3px;right:5px;font-size:8px;color:#c9a227}
  #toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:#2e7d5b;color:#fff;padding:9px 16px;border-radius:8px;font-size:13px;opacity:0;pointer-events:none;transition:opacity .18s;z-index:20;max-width:80vw}
  #toast.show{opacity:1}
  #empty{padding:40px;text-align:center;color:#6b7280}
  kbd{background:#0f1115;border:1px solid #2a2f38;border-radius:4px;padding:1px 5px;font-size:11px}
</style></head><body>
<header>
  <h1>DawnLike sprite index</h1>
  <input id="q" placeholder="search names… (e.g. campfire, kobold, chest, cliff)" autofocus>
  <select id="cat"></select>
  <label class="muted"><input type="checkbox" id="onlylib"> in library</label>
  <button id="zoom">zoom</button>
  <span class="muted" id="stat"></span>
</header>
<div id="grid"></div>
<div id="empty" hidden>no sprites match — try a shorter query</div>
<div id="toast"></div>
<script>
const SPRITES=__SPRITES__, CATS=__CATS__, TOTAL=__COUNT__, INLIB=__INLIB__;
let Z=3;
const grid=document.getElementById('grid'), q=document.getElementById('q'), catSel=document.getElementById('cat'),
      onlylib=document.getElementById('onlylib'), stat=document.getElementById('stat'),
      empty=document.getElementById('empty'), toast=document.getElementById('toast');
catSel.innerHTML='<option value="">all categories ('+TOTAL+')</option>'+CATS.map(c=>'<option value="'+c.name+'">'+c.name+' ('+c.count+')</option>').join('');
function snippet(s){
  const art="/assets/dawnlike/"+(s.k==='terrain'?'terrain':s.k==='character'?'char':'props')+"/"+s.s+".png";
  const rec={kind:s.k,tag:s.s,desc:s.n,biomes:[],art,frameW:16,frameH:16};
  if(s.k==='prop'){rec.blocks=true;rec.footW=1;rec.footH=1;}
  if(s.k==='terrain'){rec.walkable=true;}
  if(s.f>1)rec.frames=s.f;
  rec.from={pack:"DawnLike-atlas",crop:"Dawnlike.png",rect:[s.x,s.y,16,16]};
  rec.license="CC-BY 4.0";rec.attribution="DawnLike by DragonDePlatino & DawnBringer (CC-BY 4.0)";
  return JSON.stringify(rec,null,2);
}
function show(msg){toast.textContent=msg;toast.classList.add('show');clearTimeout(show._t);show._t=setTimeout(()=>toast.classList.remove('show'),1600);}
const CAP=400;
function render(){
  const term=q.value.trim().toLowerCase(), cat=catSel.value, lib=onlylib.checked;
  const frag=document.createDocumentFragment(); let n=0, drawn=0;
  for(const s of SPRITES){
    if(cat&&s.c!==cat)continue;
    if(lib&&!s.L)continue;
    if(term&&!(s.n.toLowerCase().includes(term)||s.c.toLowerCase().includes(term)))continue;
    n++;
    if(drawn>=CAP)continue;
    drawn++;
    const d=document.createElement('div');
    d.className='card'+(s.L?' lib':'')+(s.f>1?' anim':'');
    d.title=s.n+'  ·  '+s.c+'  ·  ('+s.x+','+s.y+')'+(s.f>1?'  ·  '+s.f+' frames':'')+'\nclick to copy library.json record';
    d.innerHTML='<div class="thumb" style="background-position:-'+(s.x*Z)+'px -'+(s.y*Z)+'px"></div><div class="nm">'+s.n+'</div>'+(s.L?'<div class="badge">in lib</div>':'');
    d.onclick=()=>{navigator.clipboard.writeText(snippet(s)).then(()=>show('copied: '+s.s));};
    frag.appendChild(d);
  }
  grid.replaceChildren(frag);
  empty.hidden=n>0; grid.hidden=n===0;
  stat.textContent=(drawn<n?('showing '+drawn+' of '+n+' — refine to narrow'):(n+' shown'))+' · '+TOTAL+' total · '+INLIB+' in library';
}
q.oninput=catSel.onchange=onlylib.onchange=render;
document.getElementById('zoom').onclick=()=>{Z=Z>=5?2:Z+1;document.documentElement.style.setProperty('--z',Z);render();};
render();
</script></body></html>"""


if __name__ == "__main__":
    main()
