#!/usr/bin/env python3
"""Merge /tmp/forge-manifest.json (from gen-forge-proc.py) into assets/library.json.

Idempotent: entries are keyed by tag — an existing proc entry with the same tag is REPLACED
(re-running the forge updates art in place); DawnLike entries are never touched unless the tag
collides, which the forge avoids by design.
"""
import json
import os

ROOT = os.path.join(os.path.dirname(__file__), "..")
LIB = os.path.join(ROOT, "assets/library.json")

manifest = json.load(open("/tmp/forge-manifest.json"))
lib = json.load(open(LIB))
by_tag = {a["tag"]: i for i, a in enumerate(lib["assets"])}

added, replaced = 0, 0
for m in manifest:
    entry = {
        "kind": m["kind"],
        "tag": m["tag"],
        "desc": m["desc"],
        "biomes": m["biomes"],
        "art": m["art"],
        "frameW": m["frameW"],
        "frameH": m["frameH"],
    }
    if m["kind"] == "character":
        entry["idleFrames"] = m["frames"]
        entry["fps"] = m.get("fps", 3)
    else:
        entry["frames"] = m["frames"]
        if m.get("fps") and m["frames"] > 1:
            entry["fps"] = m["fps"]
    if m["kind"] == "prop":
        entry["footW"] = m["footW"]
        entry["footH"] = m["footH"]
        entry["blocks"] = m["blocks"]
        if m.get("light"):
            entry["light"] = True
        if m.get("platform"):
            entry["platform"] = True  # footprint becomes WALKABLE over water (bridges/decking/stepping stones)
    if m["kind"] == "terrain":
        if m.get("walkable") is not None:
            entry["walkable"] = m["walkable"]
        # The renderers (manifest.ts + headless-render.ts) resolve terrain art from variants[].art —
        # a terrain entry with only a flat `art` field is INVISIBLE (falls back to grass).
        entry["variants"] = [{"art": m["art"]}]
        del entry["art"]
    entry["from"] = {"pack": "proc", "gen": "scripts/gen-forge-proc.py"}
    entry["license"] = "procedural (MythWeaver)"
    entry["attribution"] = "procedural asset (MythWeaver)"
    if m["tag"] in by_tag:
        lib["assets"][by_tag[m["tag"]]] = entry
        replaced += 1
    else:
        lib["assets"].append(entry)
        added += 1

json.dump(lib, open(LIB, "w"), indent=2)
print(f"library: +{added} added, {replaced} replaced -> {len(lib['assets'])} total")
