#!/usr/bin/env python3
"""STEP 3b+3c merge — fold the vision-labeled terrain + item records into assets/library.json.

Reads /tmp/dawnlike-bc/records.json + candidates.json. Handles kind=prop AND kind=terrain
(terrain must emit variants[].art + walkable — a flat `art` renders as grass). Dedups by tag
vs the live library and within the batch. Idempotent by tag.
"""
import json
import os
import re

ROOT = os.path.join(os.path.dirname(__file__), "..")
LIB = os.path.join(ROOT, "assets/library.json")
records = json.load(open("/tmp/dawnlike-bc/records.json"))
cand_list = json.load(open("/tmp/dawnlike-bc/candidates.json"))
lib = json.load(open(LIB))
existing = {a["tag"] for a in lib["assets"]}

by_i = {i: c for i, c in enumerate(cand_list)}
clean = lambda t: re.sub(r"[^a-z0-9_]+", "_", (t or "").strip().lower()).strip("_")

added, skipped, collided, dropped = 0, 0, 0, 0
seen, report = set(), []
for r in records:
    if not r.get("keep"):
        skipped += 1
        continue
    cand = by_i.get(r["i"])
    if not cand:
        dropped += 1
        continue
    tag = clean(r.get("tag") or cand["tag"])
    if not tag:
        dropped += 1
        continue
    if tag in existing or tag in seen:
        collided += 1
        report.append(f"collision: {tag} (from {cand['tag']}) — skipped")
        continue
    seen.add(tag)
    kind = r.get("kind")
    if kind not in ("prop", "terrain"):
        kind = cand["kind"]
    frm = {"pack": "DawnLike-atlas", **cand["from"]}
    entry = {
        "kind": kind,
        "tag": tag,
        "desc": (r.get("desc") or cand["name"]).strip(),
        "biomes": r.get("biomes") or [],
        "license": "CC0 (DawnLike, DragonDePlatino & DawnBringer)",
        "attribution": "DawnLike 1.4 (CC0) via DawnLikeAtlas",
    }
    if kind == "terrain":
        # the renderers resolve terrain art from variants[].art (a flat `art` falls back to grass)
        entry["walkable"] = bool(r.get("walkable", True))
        entry["variants"] = [{"art": cand["art"], "from": frm}]
    else:
        entry["art"] = cand["art"]
        entry["from"] = frm
        entry["frameW"] = 16
        entry["frameH"] = 16
        entry["frames"] = cand["frames"]
        if cand["frames"] > 1:
            entry["fps"] = 3
        entry["footW"] = int(r.get("footW") or 1)
        entry["footH"] = int(r.get("footH") or 1)
        entry["blocks"] = bool(r.get("blocks", False))
        if r.get("light"):
            entry["light"] = True
    lib["assets"].append(entry)
    added += 1

json.dump(lib, open(LIB, "w"), indent=2)
open("/tmp/dawnlike-bc/merge-report.txt", "w").write("\n".join(report))
print(f"merge: +{added} added ({sum(1 for r in records if r.get('keep') and (by_i.get(r['i']) or {}).get('kind')=='terrain')} terrain-ish), {skipped} skipped, {collided} collisions, {dropped} dropped")
print(f"library total: {len(lib['assets'])}")
