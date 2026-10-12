#!/usr/bin/env python3
"""
Build the v2.3 evidence manifest and the v2.3 sha256sums list.

Covers:
  - v2.3 report artifacts (this report + v2.3/*)
  - v2.3 evidence sets (reports/v2.3/evidence/**)
  - v2.3 aggregator logs (reports/v2.3/aggregator/**)
  - v2.3 tests (reports/v2.3/tests/**)
  - changed/new source files (the exact v2.3 source edits)
  - new/changed fixtures

Writes reports/v2.3/evidence_manifest.json and reports/sha256sums_v23.txt.
"""

import hashlib
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))  # stark/


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def rel(path):
    return os.path.relpath(path, ROOT).replace("\\", "/")


def collect():
    files = []

    # Top-level v2.3 report.
    files.append(os.path.join(ROOT, "reports", "M0_FINAL_REPORT_v2.3.md"))

    # v2.3 report directory (markdown, json, scripts, logs, tests, evidence).
    v23 = os.path.join(ROOT, "reports", "v2.3")
    for base, _dirs, names in os.walk(v23):
        for n in sorted(names):
            # The manifest cannot hash itself consistently; it is excluded and
            # listed in the report instead.
            if n == "evidence_manifest.json":
                continue
            files.append(os.path.join(base, n))

    # Changed / new source files.
    for s in [
        "src/phase1/gates.cpp",
        "src/phase1/gates.h",
        "src/phase1/common/ExperimentRecord.h",
        "src/phase1/common/ExperimentRecord.cpp",
        "src/phase1/common/HardwareProfiler.h",
        "src/phase1/common/HardwareProfiler.cpp",
        "src/phase1/baselines/run_baseline.cpp",
        "tests/test_phase1_gates.cpp",
    ]:
        files.append(os.path.join(ROOT, s))

    # New fixture updater + the controlled fixtures it rewrote.
    files.append(os.path.join(ROOT, "fixtures", "make_v23_skip_attestation.py"))
    for d in ["v14-valid", "controlled-valid", "controlled-invalid-g2",
              "controlled-invalid-g4", "controlled-invalid-g7",
              "controlled-g7-endpoint-outlier", "controlled-incorrect-stored-median",
              "controlled-invalid-raw-sample", "probe-malformed-accounting",
              "probe-malformed-profile"]:
        for n in ["P1-E2-skip.json", "P1-B4-skip.json", "P1-B5-skip.json"]:
            p = os.path.join(ROOT, "fixtures", d, n)
            if os.path.isfile(p):
                files.append(p)

    # Preserved evidence integrity anchors.
    for s in ["reports/sha256sums_v22.txt", "reports/sha256sums_v21.txt",
              "reports/sha256sums_v20.txt"]:
        files.append(os.path.join(ROOT, s))

    seen = set()
    out = []
    for f in files:
        if not os.path.isfile(f):
            continue
        r = rel(f)
        if r in seen:
            continue
        seen.add(r)
        out.append((r, sha256(f)))
    out.sort()
    return out


def main():
    entries = collect()

    manifest = {
        "report": "STARK Phase 1 (M0) v2.3 evidence manifest",
        "date": "2026-10-05",
        "decision": "M0 = FAIL (BLOCKED); M1 = LOCKED",
        "note": "New v2.3 artifacts only. v2.0/v2.1/v2.2 evidence and reports are "
                "preserved unchanged; the nine recovered records, the G7 threshold "
                "and the G7 grouping rule are untouched.",
        "artifact_count": len(entries),
        "artifacts": [{"path": p, "sha256": h} for p, h in entries],
    }
    with open(os.path.join(HERE, "evidence_manifest.json"), "w", encoding="utf-8",
              newline="\n") as f:
        json.dump(manifest, f, indent=2)
    print("wrote evidence_manifest.json:", len(entries), "artifacts")

    sums = os.path.join(ROOT, "reports", "sha256sums_v23.txt")
    with open(sums, "w", encoding="utf-8", newline="\n") as f:
        for p, h in entries:
            f.write(f"{h} *{p}\n")
    print("wrote sha256sums_v23.txt:", len(entries), "entries")


if __name__ == "__main__":
    main()