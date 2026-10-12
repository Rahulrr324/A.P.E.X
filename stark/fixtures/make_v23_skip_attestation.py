#!/usr/bin/env python3
"""
v2.3 fixture updater: add the STRUCTURED skip attestation to controlled fixtures.

Background
----------
Before v2.3, gate G3 accepted a no-CUDA skip whenever the record's free-text
`status_reason` was non-empty. The v2.2 audit showed that any arbitrary string
("x", "lorem ipsum") therefore satisfied G3. v2.3 requires a machine-verifiable
`skip_attestation` object instead (see src/phase1/gates.cpp
validate_no_cuda_skip()).

This script rewrites ONLY the three CUDA-skip records in the *controlled* test
fixtures so they carry a valid no-CUDA attestation:

  P1-E2-skip.json, P1-B4-skip.json, P1-B5-skip.json

It touches:
  fixtures/v14-valid/                  (source of the controlled fixtures)
  fixtures/controlled-*/               (derived controlled fixtures)
  fixtures/probe-*/                    (probe fixtures)

It does NOT touch:
  - the nine recovered historical records (../archive_recovery/...)
  - fixtures/v21/*  (v2.1 capability fixtures, hash-frozen by v2.2)
  - any report, gate threshold, or grouping rule

The edit is disclosed in a README in each directory it rewrites.
"""

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SKIP_FILES = ["P1-E2-skip.json", "P1-B4-skip.json", "P1-B5-skip.json"]

ATTESTATION = {
    "schema": "STARKP1 skip-attestation 1",
    "reason_code": "cuda_unavailable",
    "capability_state": "cuda_unavailable",
    "execution_availability": "not_available",
    "capability_source": "cudaGetDeviceCount (HardwareProfiler::cudaRuntimeAvailable)",
    "producer": "stark_p1::run_baseline (E2/B4/B5 GPU branch skip path)",
    "cuda_available": False,
}

# Directories that contain E2/B4/B5 skip records.
TARGET_DIRS = [
    "v14-valid",
    "controlled-valid",
    "controlled-invalid-g2",
    "controlled-invalid-g4",
    "controlled-invalid-g7",
    "controlled-g7-endpoint-outlier",
    "controlled-incorrect-stored-median",
    "controlled-invalid-raw-sample",
    "probe-malformed-accounting",
    "probe-malformed-profile",
]


def main():
    touched = []
    for d in TARGET_DIRS:
        full = os.path.join(HERE, d)
        if not os.path.isdir(full):
            continue
        n = 0
        for name in SKIP_FILES:
            path = os.path.join(full, name)
            if not os.path.isfile(path):
                continue
            with open(path, encoding="utf-8") as f:
                rec = json.load(f)
            # Only rewrite genuine no-CUDA skips; never invent a skip.
            if rec.get("status") != "SKIPPED":
                continue
            hw = rec.get("hardware") or {}
            if hw.get("cuda_available") is True:
                continue
            rec["skip_attestation"] = dict(ATTESTATION)
            with open(path, "w", encoding="utf-8") as f:
                json.dump(rec, f, indent=2, sort_keys=True)
            n += 1
        if n:
            touched.append((d, n))
    print("v2.3 attestation fixtures updated:")
    for d, n in touched:
        print(f"  {d}: {n} skip record(s)")
    if not touched:
        print("  (nothing to update)")


if __name__ == "__main__":
    main()