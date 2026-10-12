#!/usr/bin/env python3
"""Turn-start freeze-30 snapshot + current power scheme capture.

Persists:
- mtimes of all files under build/g7-campaign and build/g7-campaign-affinityfix
- current active power scheme GUID
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

Root = Path("stark")

M_TIMES_PATH = Path("work") / "scripts" / "freeze30_mtimes_start.json"
SCHEME_PATH = Path("work") / "scripts" / "power_scheme_start.json"


def _run(cmd):
    import subprocess
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.returncode, r.stdout, r.stderr


def _mtimes_under(*roots: Path) -> dict[str, float]:
    out: dict[str, float] = {}
    for root in roots:
        if not root.exists():
            continue
        for p in root.rglob("*"):
            if p.is_file():
                out[str(p.resolve())] = p.stat().st_mtime
    return out


def _active_scheme_guid() -> str | None:
    rc, out, err = _run(["powercfg", "/getactivescheme"])
    if rc != 0:
        print("powercfg /getactivescheme failed", file=sys.stderr)
        return None
    m = re.search(r"Power Scheme GUID:\s+([0-9A-Fa-f\-]+)", out)
    return m.group(1) if m else None


def main() -> int:
    mtimes = _mtimes_under(Root / "build" / "g7-campaign",
                           Root / "build" / "g7-campaign-affinityfix")
    M_TIMES_PATH.write_text(json.dumps(mtimes, indent=2), encoding="utf-8")
    print("Wrote mtime snapshot:", M_TIMES_PATH, "files:", len(mtimes))

    guid = _active_scheme_guid()
    if guid is None:
        return 1
    SCHEME_PATH.write_text(json.dumps({"guid": guid}, indent=2), encoding="utf-8")
    print("Wrote start power scheme:", guid)
    return 0


if __name__ == "__main__":
    sys.exit(main())
