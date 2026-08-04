#!/usr/bin/env python3
"""STEP 3a merge — fold the vision-labeled DawnLike records into assets/library.json.

Reads /tmp/dawnlike-3a/records.json (from the labeling workflow) + candidates.json (art + from +
frames), keeps only keep=true rows, dedups tags (vs the live library AND within the batch), and
writes proper library entries. Idempotent by tag. Then re-run `npm run assets:embed` so retrieval
sees them, and rebuild the gallery.
"""
import json
import os
import re

ROOT = os.path.join(os.path.dirname(__file__), "..")
LIB = os.path.join(ROOT, "assets/library.json")
records = json.load(open("/tmp/dawnlike-3a/records.json"))
cands = {c["slug"]: c for c in json.load(open("/tmp/dawnlike-3a/candidates.json"))}
lib = json.load(open(LIB))
existing = {a["tag"]: i for i, a in enumerate(lib["assets"])}

TAG_RE = re.compile(r"[^a-z0-9_]+")
def clean_tag(t):
    return TAG_RE.sub("_", (t or "").strip().lower()).strip("_")

by_i = {}  # global index → candidate slug (records reference i)
cand_list = json.load(open("/tmp/dawnlike-3a/candidates.json"))
for idx, c in enumerate(cand_list):
    by_i[idx] = c["slug"]

added, skipped, collided, dropped = 0, 0, 0, 0
seen = set()
report = []
for r in records:
    if not r.get("keep"):
        skipped += 1
        continue
    slug = by_i.get(r["i"])
    cand = cands.get(slug) if slug else None
    if not cand:
        dropped += 1
        continue
    tag = clean_tag(r.get("tag") or slug)
    if not tag:
        dropped += 1
        continue
    if tag in existing or tag in seen:
        collided += 1
        report.append(f"collision: {tag} (from {slug}) — skipped")
        continue
    seen.add(tag)
    kind = "character" if r.get("kind") == "character" else "prop"
    frames = cand["frames"]
    entry = {
        "kind": kind,
        "tag": tag,
        "desc": (r.get("desc") or cand["name"]).strip(),
        "biomes": r.get("biomes") or [],
        "art": cand["art"],
        "frameW": 16,
        "frameH": 16,
        "from": {"pack": "DawnLike-atlas", **cand["from"]},
        "license": "CC0 (DawnLike, DragonDePlatino & DawnBringer)",
        "attribution": "DawnLike 1.4 (CC0) via DawnLikeAtlas",
    }
    if kind == "character":
        entry["idleFrames"] = frames
        if frames > 1:
            entry["fps"] = 3
    else:
        entry["frames"] = frames
        if frames > 1:
            entry["fps"] = 3
        entry["footW"] = int(r.get("footW") or 1)
        entry["footH"] = int(r.get("footH") or 1)
        entry["blocks"] = bool(r.get("blocks", True))
        if r.get("light"):
            entry["light"] = True
    lib["assets"].append(entry)
    added += 1

json.dump(lib, open(LIB, "w"), indent=2)
open("/tmp/dawnlike-3a/merge-report.txt", "w").write("\n".join(report))
print(f"merge: +{added} added, {skipped} skipped(keep=false), {collided} tag-collisions, {dropped} dropped(no cand/tag)")
print(f"library total: {len(lib['assets'])}")
