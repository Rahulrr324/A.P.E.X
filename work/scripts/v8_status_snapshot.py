#!/usr/bin/env python3
"""Snapshot current v8 prep state: harness constants, power scheme, freeze snapshots present."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

Root = Path("stark")
Work = Path("work") / "scripts"

HARness = Root / "tests" / "diag_highres_frequency.cpp"
SCHEME_START = Work / "power_scheme_start.json"
M_TIME_START = Work / "freeze30_mtimes_start.json"
VERIFY_END = Work / "verify_freeze30_end.py"

snapshot = {
    "harness_constants": {},
    "harness_doc_contains_v8": False,
    "harness_control_block_line_present": False,
    "start_scheme_present": False,
    "start_scheme_guid": None,
    "mtime_snapshot_present": False,
    "mtime_snapshot_file_count": 0,
    "verify_end_present": False,
    "diag_highres_frequency_present": False,
}


def _run(cmd):
    import subprocess
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.returncode, r.stdout, r.stderr


def _scheme_guid():
    rc, out, err = _run(["powercfg", "/getactivescheme"])
    if rc != 0:
        return None
    m = re.search(r"Power Scheme GUID:\s+([0-9A-Fa-f\-]+)", out)
    return m.group(1) if m else None


def main() -> int:
    hp_text = HARness.read_text(encoding="utf-8") if HARness.exists() else ""
    snapshot["diag_highres_frequency_present"] = HARness.exists()

    if hp_text:
        snapshot["harness_doc_contains_v8"] = "v8 (2026-10-08): two tightly-controlled diagnostics only" in hp_text
        snapshot["harness_control_block_line_present"] = "// ---- v8 control constants (predeclared, frozen for this diagnostic) ----" in hp_text
        for key in ("DIAG_VERSION", "V8_B6_N_PAIRS", "V8_B9_N_EXECS"):
            m = re.search(rf'#define {key}\s+"?([0-9a-zA-Z_]+)"?', hp_text)
            snapshot["harness_constants"][key] = m.group(1) if m else None

    if SCHEME_START.exists():
        snapshot["start_scheme_present"] = True
        snapshot["start_scheme_guid"] = json.loads(SCHEME_START.read_text(encoding="utf-8")).get("guid")
    snapshot["current_scheme_guid"] = _scheme_guid()

    if M_TIME_START.exists():
        snapshot["mtime_snapshot_present"] = True
        snapshot["mtime_snapshot_file_count"] = len(json.loads(M_TIME_START.read_text(encoding="utf-8")))
    snapshot["verify_end_present"] = VERIFY_END.exists()

    blob = json.dumps(snapshot, indent=2)
    print(blob)
    Path("work/scripts/v8_prep_snapshot.json").write_text(blob, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
