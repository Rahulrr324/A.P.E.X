#!/usr/bin/env python3
"""
Probe: is a malformed PROFILE hardware block reachable through the REAL
aggregator (ExperimentRecord::validate -> evaluate_gates)?

Creates a record directory holding a PROFILE record whose hardware block is
non-null but lacks cpu_model (so ExperimentRecord::validate() accepts it), plus
valid E1/E5 baselines, then the caller runs aggregate.exe against it.

CONTROLLED PROBE INPUT — not a measurement.
"""
import json
import os
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "controlled-valid")
DST = os.path.join(HERE, "probe-malformed-profile")

if os.path.isdir(DST):
    shutil.rmtree(DST)
os.makedirs(DST)

for name in os.listdir(SRC):
    if not name.endswith(".json"):
        continue
    with open(os.path.join(SRC, name), encoding="utf-8") as f:
        rec = json.load(f)
    # Corrupt ONLY the PROFILE record's hardware block: non-null, missing
    # required cpu_model. Every other field stays schema-valid.
    if rec.get("experiment_id") == "PROFILE":
        rec["hardware"] = {"cuda_available": False}
    with open(os.path.join(DST, name), "w", encoding="utf-8") as f:
        json.dump(rec, f, indent=2, sort_keys=True)

with open(os.path.join(DST, "README.txt"), "w", encoding="utf-8") as f:
    f.write(
        "CONTROLLED PROBE INPUT (not a measurement). Identical to "
        "controlled-valid except the PROFILE record's hardware block was "
        "replaced with {\"cuda_available\": false}: non-null (so "
        "ExperimentRecord::validate() accepts it) but missing required "
        "cpu_model (so StaticHardwareProfile::from_json() throws). Used to "
        "determine whether malformed hardware evidence fails closed or "
        "crashes the aggregator.\n"
    )

print("wrote", DST)
