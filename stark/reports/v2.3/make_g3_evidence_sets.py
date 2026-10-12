#!/usr/bin/env python3
"""
v2.3 G3 evidence-set builder.

Builds the deterministic G3 evidence sets used by the v2.3 audit from records
that already exist in the project (NO external archive is consulted):

  source A: ../archive_recovery/aggregator_input/   (the frozen nine recovered)
  source B: ../archive_recovery/v21_evidence/       (v2.1/v2.2 candidate evidence)

Outputs (under reports/v2.3/evidence/):
  v23-attested/       v21_evidence + valid structured attestation on the skips
                      -> G3 PASS
  v23-fabricated/     v21_evidence with arbitrary skip reasons, NO attestation
                      ("x"/"because"/"lorem ipsum") -> G3 FAIL
  v23-contradictory/  v21_evidence + attestation whose cuda_available=true -> G3 FAIL
  v23-missing-e2/     v21_evidence with the E2 record removed -> G3 FAIL
  v23-malformed/      v21_evidence + non-object skip_attestation -> G3 FAIL (+invalid)

The frozen nine and the v2.1 evidence are only READ; never modified.
"""

import json
import os
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
EVID = os.path.join(HERE, "evidence")
V21 = os.path.normpath(os.path.join(HERE, "..", "..", "..", "archive_recovery", "v21_evidence"))
SKIPS = ["P1-E2-skip.json", "P1-B4-skip.json", "P1-B5-skip.json"]

GOOD_ATT = {
    "schema": "STARKP1 skip-attestation 1",
    "reason_code": "cuda_unavailable",
    "capability_state": "cuda_unavailable",
    "execution_availability": "not_available",
    "capability_source": "cudaGetDeviceCount (HardwareProfiler::cudaRuntimeAvailable)",
    "producer": "stark_p1::run_baseline (E2/B4/B5 GPU branch skip path)",
    "cuda_available": False,
}


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def dump(dirname, records):
    d = os.path.join(EVID, dirname)
    if os.path.isdir(d):
        shutil.rmtree(d)
    os.makedirs(d)
    for name, rec in records.items():
        with open(os.path.join(d, name), "w", encoding="utf-8") as f:
            json.dump(rec, f, indent=2, sort_keys=True)
    print("wrote", dirname, "->", len(records), "records")


def v21_records():
    recs = {}
    for name in sorted(os.listdir(V21)):
        if name.endswith(".json"):
            recs[name] = load(os.path.join(V21, name))
    return recs


def main():
    os.makedirs(EVID, exist_ok=True)

    # v23-attested: add a valid attestation to the three skips.
    recs = v21_records()
    for name in SKIPS:
        if name in recs:
            recs[name]["skip_attestation"] = dict(GOOD_ATT)
    dump("v23-attested", recs)

    # v23-fabricated: arbitrary reasons, no attestation.
    recs = v21_records()
    for name in SKIPS:
        if name in recs:
            recs[name].pop("skip_attestation", None)
    recs["P1-E2-skip.json"]["status_reason"] = "x"
    recs["P1-B4-skip.json"]["status_reason"] = "because"
    recs["P1-B5-skip.json"]["status_reason"] = "lorem ipsum"
    dump("v23-fabricated", recs)

    # v23-contradictory: attestation claims cuda_available=true.
    recs = v21_records()
    bad = dict(GOOD_ATT)
    bad["cuda_available"] = True
    recs["P1-E2-skip.json"]["skip_attestation"] = bad
    for name in ["P1-B4-skip.json", "P1-B5-skip.json"]:
        recs[name]["skip_attestation"] = dict(GOOD_ATT)
    dump("v23-contradictory", recs)

    # v23-missing-e2: remove the E2 record entirely.
    recs = v21_records()
    recs.pop("P1-E2-skip.json", None)
    for name in ["P1-B4-skip.json", "P1-B5-skip.json"]:
        recs[name]["skip_attestation"] = dict(GOOD_ATT)
    dump("v23-missing-e2", recs)

    # v23-malformed: non-object attestation (a bare string).
    recs = v21_records()
    recs["P1-E2-skip.json"]["skip_attestation"] = "not-an-object"
    for name in ["P1-B4-skip.json", "P1-B5-skip.json"]:
        recs[name]["skip_attestation"] = dict(GOOD_ATT)
    dump("v23-malformed", recs)


if __name__ == "__main__":
    main()