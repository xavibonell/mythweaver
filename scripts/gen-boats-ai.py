#!/usr/bin/env python3
"""
gen-boats-ai.py — EXPERIMENT: generate a DawnLike-fitting boat set via an image-gen API + a
downscale-to-grid + DB16-palette-quantize pipeline (the real work is the post-process, not the prompt).

Pipeline: gpt-image-1 (transparent bg) -> raw sheet -> split 5 -> alpha-crop -> box-downscale to a
few tiles -> quantize to DawnLike's 16-colour palette. Writes to scratchpad for review (NOT the repo).
"""
import base64, json, os, re, sys, urllib.request
from pathlib import Path
from PIL import Image

SP = "/private/tmp/claude-501/-Users-xavierbonell-dev-mythweaver/82a9a5f0-4e38-4edd-9f14-bb9554599615/scratchpad"
env = {}
for line in open(".env"):
    m = re.match(r"^([A-Z0-9_]+)=(.*)$", line.strip())
    if m: env[m.group(1)] = m.group(2).strip()
KEY = env["OPENAI_API_KEY"]

DB16 = [(20,12,28),(68,36,52),(48,52,109),(78,74,78),(133,76,48),(52,101,36),(208,70,72),(117,113,97),
        (89,125,206),(210,125,44),(133,149,161),(109,170,44),(210,170,153),(109,194,202),(218,212,94),(222,238,214)]

PROMPT = (
    "A horizontal sprite sheet of five wooden boats seen from DIRECTLY ABOVE (top-down bird's-eye view), drawn as if at a "
    "tiny 32x48 pixel resolution — LARGE CHUNKY blocky pixels, so each boat is bold and simple. Fully TRANSPARENT background. "
    "Left to right: a rowboat with two oars, a fishing boat, a sailboat with one triangular sail, a small cargo boat with "
    "crates, a raft of lashed logs. Each boat is an ELONGATED oval hull with a clearly POINTED BOW at the top and a squared "
    "stern at the bottom (canoe-shaped, NOT round). VERY THICK solid black outline around each hull. Flat SOLID fill colors "
    "only — 2 or 3 wood browns plus a tan deck — NO anti-aliasing, NO gradients, NO blur, hard pixel edges. Minimal interior "
    "detail (just a couple of plank lines and a bench or crate). High contrast, clean, retro 16-bit RPG tileset sprites, each "
    "centered in its own equal cell in a single evenly spaced row."
)

def generate():
    body = json.dumps({"model": "gpt-image-1", "prompt": PROMPT, "size": "1536x1024",
                       "background": "transparent", "quality": "high", "n": 1}).encode()
    req = urllib.request.Request("https://api.openai.com/v1/images/generations", data=body,
                                 headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    try:
        resp = json.load(urllib.request.urlopen(req, timeout=240))
    except urllib.error.HTTPError as e:
        print("HTTPError:", e.code, e.read().decode()[:500]); sys.exit(1)
    b64 = resp["data"][0]["b64_json"]
    Path(f"{SP}/boats_raw.png").write_bytes(base64.b64decode(b64))
    print("generated raw sheet ->", f"{SP}/boats_raw.png", "| usage:", resp.get("usage"))

def nearest_db16(px):
    r, g, b, a = px
    if a < 100: return (0, 0, 0, 0)
    best = min(DB16, key=lambda c: (c[0]-r)**2 + (c[1]-g)**2 + (c[2]-b)**2)
    return (*best, 255)

def alpha_bbox(im):
    return im.getbbox()

def process():
    sheet = Image.open(f"{SP}/boats_raw.png").convert("RGBA")
    W, H = sheet.size
    boats = []
    for i in range(5):
        col = sheet.crop((i * W // 5, 0, (i + 1) * W // 5, H))
        bb = col.getbbox()
        if not bb: continue
        crop = col.crop(bb)
        # downscale so the boat is ~3 tiles tall (48px), KEEPING native aspect; LANCZOS keeps edges sharper than BOX
        th = 48
        tw = max(12, round(crop.width * th / crop.height))
        small = crop.resize((tw, th), Image.LANCZOS)
        # quantize to DB16
        q = Image.new("RGBA", (tw, th), (0, 0, 0, 0))
        for y in range(th):
            for x in range(tw):
                q.putpixel((x, y), nearest_db16(small.getpixel((x, y))))
        # crisp 1px dark outline around the silhouette (DawnLike convention) — any opaque pixel touching
        # a transparent one gets re-drawn in DB16 black, so the boat reads sharply against water.
        black = (*DB16[0], 255)
        op = [[q.getpixel((x, y))[3] > 0 for x in range(tw)] for y in range(th)]
        for y in range(th):
            for x in range(tw):
                if op[y][x]:
                    edge = any(0 <= x+dx < tw and 0 <= y+dy < th and not op[y+dy][x+dx] for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)))
                    if not (0 <= x-1) or not (0 <= y-1): edge = True
                    if edge: q.putpixel((x, y), black)
        boats.append(q)
    # contact sheet: raw crops (top) vs DB16-quantized tiles (bottom), scaled up
    Z = 6
    cw = max(b.width for b in boats) * Z + 12
    ch = 32 * Z + 20
    out = Image.new("RGBA", (cw * len(boats) + 8, ch + 8), (24, 26, 30, 255))
    from PIL import ImageDraw
    d = ImageDraw.Draw(out)
    for i, b in enumerate(boats):
        big = b.resize((b.width * Z, b.height * Z), Image.NEAREST)
        x = 8 + i * cw
        out.alpha_composite(big, (x, 8))
        d.text((x, 8 + b.height * Z + 2), f"{['rowboat','fishing','sailboat','cargo','raft'][i]} {b.width}x{b.height}", fill=(220, 220, 220, 255))
        b.save(f"{SP}/boat_{['rowboat','fishing','sailboat','cargo','raft'][i]}.png")
    out.save(f"{SP}/boats_processed.png")
    print(f"processed {len(boats)} boats -> {SP}/boats_processed.png")

if __name__ == "__main__":
    if "--process-only" not in sys.argv:
        generate()
    process()
