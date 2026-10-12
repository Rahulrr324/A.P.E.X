#!/usr/bin/env python3
"""
Generate the two deserialization/evidence-boundary aggregator fixtures required
by M0 v1.8 section 6. These are CONTROLLED TEST INPUTS, not measurements.

Both start from the real controlled-valid records (PROFILE, TELEMETRY, the
E2/B4/B5 skip records, E1-B6, E5-B6) and add exactly one disclosed defect each:

  controlled-invalid-raw-sample/
      Adds P1-B2-badraw.json whose statistics.samples array contains a
      non-numeric (string) element. The record must be REJECTED at the
      deserialization boundary -- it can never enter a benchmark group, never
      silently coerce, and never produce an accidental G7 PASS.

  controlled-incorrect-stored-median/
      Copies the real E1-B6 record to a second record id (P1-E1-B6-copy) so the
      group has two distinct ids, then sets that copy's stored statistics.median
      to a value that disagrees with its OWN raw samples (correctly typed, but
      wrong). G7 must reject it via the independent median recomputation
      (tolerance 0.001%).

Every generated directory carries a README.txt stating exactly what was changed.
"""

import json
import os
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "controlled-valid")

PROFILE = "P1-PROFILE-24-0.json"
TELEMETRY = "P1-TELEMETRY-24-1.json"
SKIPS = ["P1-E2-skip.json", "P1-B4-skip.json", "P1-B5-skip.json"]
E1_B6 = "P1-E1-B6-52043.json"
E5_B6 = "P1-E5-B6-7336.json"


def load(name):
    with open(os.path.join(SRC, name), encoding="utf-8") as f:
        return json.load(f)


def write(dirname, records, readme):
    d = os.path.join(HERE, dirname)
    if os.path.isdir(d):
        shutil.rmtree(d)
    os.makedirs(d)
    for name, rec in records.items():
        with open(os.path.join(d, name), "w", encoding="utf-8") as f:
            json.dump(rec, f, indent=2, sort_keys=True)
    with open(os.path.join(d, "README.txt"), "w", encoding="utf-8") as f:
        f.write(readme + "\n")
    print("wrote", dirname, "->", sorted(records))


def common_records():
    recs = {}
    for name in [PROFILE, TELEMETRY] + SKIPS:
        recs[name] = load(name)
    recs[E1_B6] = load(E1_B6)
    recs[E5_B6] = load(E5_B6)
    return recs


def main():
    # --- controlled-invalid-raw-sample ---
    badraw = common_records()
    bad = json.loads(json.dumps(load(E1_B6)))
    bad["record_id"] = "P1-B2-badraw"
    bad["experiment_id"] = "B2"
    bad["kind"] = "benchmark"
    bad["configuration"] = {"benchmark_id": "B2"}
    # Keep >=10 entries so ONLY the non-numeric element is the defect.
    samples = bad["statistics"]["samples"]
    while len(samples) < 10:
        samples.append(samples[-1])
    samples[3] = "not-a-number"
    bad["statistics"]["samples"] = samples
    badraw["P1-B2-badraw.json"] = bad
    write(
        "controlled-invalid-raw-sample",
        badraw,
        "CONTROLLED TEST INPUT (not a measurement). Identical to controlled-valid "
        "plus one added record P1-B2-badraw.json whose statistics.samples[3] is the "
        "string \"not-a-number\" instead of a number. That record must be rejected "
        "cleanly at the deserialization boundary: it is reported as an INVALID "
        "RECORD, never coerced, never silently dropped, and never allowed to form "
        "or pass a benchmark group. All gates over the remaining valid records are "
        "expected to PASS (exit 0 non-strict, exit 1 --strict).",
    )

    # --- controlled-incorrect-stored-median ---
    wrong = common_records()
    copy = json.loads(json.dumps(load(E1_B6)))
    copy["record_id"] = "P1-E1-B6-copy"
    med = copy["statistics"]["median"]
    # Correctly typed double, but disagreeing with the record's OWN raw samples.
    copy["statistics"]["median"] = med * 3.0 if med else 1.0
    wrong["P1-E1-B6-copy.json"] = copy
    write(
        "controlled-incorrect-stored-median",
        wrong,
        "CONTROLLED TEST INPUT (not a measurement). Identical to controlled-valid "
        "plus one added record P1-E1-B6-copy.json: a copy of the real E1-B6 record "
        "under a distinct record id whose statistics.median is set to 3x its own "
        "recomputed median. The median is correctly typed (a finite double) but "
        "factually wrong. G7 must reject it via the independent median "
        "recomputation (tolerance 0.001%), so G7 is expected to FAIL (exit 1).",
    )


if __name__ == "__main__":
    main()
