#!/usr/bin/env python3
"""
Build the v2.4 evidence manifest and the v2.4 sha256sums list.

Covers:
  - v2.4 report artifacts (this report + v2.4/* except the manifest itself)
  - changed source files (the exact v2.4 source edits) + unchanged source anchors
  - CMakeLists.txt (unchanged since v2.0) and prior sha256 lists (integrity anchors)
  - the evaluated fixtures (v21 G4 fixtures, invalid-g4 / controlled-valid controls)
  - the nine recovered historical records (direct byte-identity entries)

Writes reports/v2.4/evidence_manifest.json and reports/sha256sums_v24.txt (LF only).
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

    # Top-level v2.4 report.
    files.append(os.path.join(ROOT, "reports", "M0_FINAL_REPORT_v2.4.md"))

    # v2.4 report directory (markdown, json, scripts, logs).
    v24 = os.path.join(ROOT, "reports", "v2.4")
    for base, _dirs, names in os.walk(v24):
        for n in sorted(names):
            # The manifest cannot hash itself consistently; it is excluded.
            if n == "evidence_manifest.json":
                continue
            files.append(os.path.join(base, n))

    # v2.4 source edits.
    for s in [
        "src/phase1/gates.cpp",
        "src/phase1/gates.h",
        "tests/test_phase1_gates.cpp",
    ]:
        files.append(os.path.join(ROOT, s))

    # Unchanged source anchors (must remain byte-identical to v2.3 / v2.0).
    for s in [
        "src/phase1/common/ExperimentRecord.h",
        "src/phase1/common/ExperimentRecord.cpp",
        "src/phase1/common/HardwareProfiler.h",
        "src/phase1/common/HardwareProfiler.cpp",
        "src/phase1/baselines/run_baseline.cpp",
        "CMakeLists.txt",
    ]:
        files.append(os.path.join(ROOT, s))

    # Prior checksum lists (integrity anchors for all earlier evidence).
    for s in [
        "reports/sha256sums_v23.txt",
        "reports/sha256sums_v22.txt",
        "reports/sha256sums_v21.txt",
        "reports/sha256sums_v20.txt",
    ]:
        files.append(os.path.join(ROOT, s))

    # Evaluated fixtures (inputs to the v2.4 gate runs; never modified).
    for d in ["v21/controlled-gpu-cuda-off", "v21/controlled-unknown-capability",
              "v21/controlled-gpu-vram-measured", "controlled-invalid-g4",
              "controlled-valid"]:
        fdir = os.path.join(ROOT, "fixtures", d)
        if os.path.isdir(fdir):
            for n in sorted(os.listdir(fdir)):
                p = os.path.join(fdir, n)
                if os.path.isfile(p):
                    files.append(p)

    # The nine recovered historical records — direct byte-identity entries so
    # `sha256sum -c sha256sums_v24.txt` re-verifies preservation by itself.
    nine_dir = os.path.join(ROOT, "..", "archive_recovery", "aggregator_input")
    if os.path.isdir(nine_dir):
        for n in sorted(os.listdir(nine_dir)):
            if n.endswith(".json"):
                files.append(os.path.join(nine_dir, n))

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
        "report": "STARK Phase 1 (M0) v2.4 evidence manifest",
        "date": "2026-10-05",
        "decision": "M0 = FAIL (BLOCKED); M1 = LOCKED",
        "note": "New v2.4 artifacts plus the v2.4 source edits (gates.cpp, gates.h, "
                "tests/test_phase1_gates.cpp) and direct byte-identity entries for the "
                "nine recovered historical records. v2.0-v2.3 evidence, all records, "
                "raw samples, G7 thresholds and grouping rules are preserved unchanged. "
                "The manifest excludes its own hash (self-reference), matching the "
                "v2.3 convention.",
        "artifact_count": len(entries),
        "artifacts": [{"path": p, "sha256": h} for p, h in entries],
    }
    with open(os.path.join(HERE, "evidence_manifest.json"), "w", encoding="utf-8",
              newline="\n") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")
    print("wrote evidence_manifest.json:", len(entries), "artifacts")

    sums = os.path.join(ROOT, "reports", "sha256sums_v24.txt")
    with open(sums, "w", encoding="utf-8", newline="\n") as f:
        for p, h in entries:
            f.write(f"{h} *{p}\n")
    print("wrote sha256sums_v24.txt:", len(entries), "entries")


if __name__ == "__main__":
    main()
