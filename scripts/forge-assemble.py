#!/usr/bin/env python3
"""Assemble the artists' sections into gen-forge-proc.py.

Reads /tmp/forge-sections/<name>.py, SYNTAX+EXEC-checks each in isolation against the harness header
(so one broken section can't kill the batch), splices the good ones at the FORGE_SECTIONS marker,
and reports per-section status. Broken sections are left out with their error printed for repair.
"""
import os
import sys
import traceback

ROOT = os.path.join(os.path.dirname(__file__), "..")
GEN = os.path.join(ROOT, "scripts/gen-forge-proc.py")
SECTIONS_DIR = "/tmp/forge-sections"
MARK = "# FORGE_SECTIONS"

src = open(GEN).read()
header = src.split(MARK)[0]
tail_marker = src.split(MARK)[1].split("# --- END AGENT SECTIONS")[1]

ok_sections, bad = [], []
for f in sorted(os.listdir(SECTIONS_DIR)):
    if not f.endswith(".py"):
        continue
    code = open(os.path.join(SECTIONS_DIR, f)).read()
    # strip accidental fences / imports the rules forbid
    lines = [l for l in code.splitlines() if not l.strip().startswith("```")]
    code = "\n".join(lines)
    probe = header + "\n" + code + "\n"
    env = {"__file__": GEN}
    try:
        exec(compile(probe, f, "exec"), env)  # noqa: S102 — trusted local build step
        n = len(env.get("ASSETS", []))
        ok_sections.append((f, code, n))
        print(f"  OK   {f}: {n} assets register cleanly")
    except Exception:
        err = traceback.format_exc().splitlines()[-1]
        bad.append((f, err))
        print(f"  FAIL {f}: {err}")

body = "\n\n".join(f"# ===== section: {name} ({n} assets) =====\n{code}" for name, code, n in ok_sections)
out = header + MARK + "\n" + body + "\n# --- END AGENT SECTIONS" + tail_marker
open(GEN, "w").write(out)
print(f"\nassembled {len(ok_sections)} sections into gen-forge-proc.py ({len(bad)} failed)")
sys.exit(0 if not bad else 2)
