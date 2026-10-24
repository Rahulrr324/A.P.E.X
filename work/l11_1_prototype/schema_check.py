#!/usr/bin/env python3
"""
STARK-L11.1 — PROTOTYPE ONLY (not part of any official evaluation).

Two jobs, neither of which runs an experiment:

 1. Declare the L11 trial-record schema in an executable form and validate
    records against it (types, allowed values, null semantics).
 2. Report coverage: which required L11 fields the *existing* L10 trial CSV
    actually contains, so the instrumentation gap is measured rather than
    asserted.

Usage:
  python3 schema_check.py --selftest
  python3 schema_check.py --coverage <existing_trials.csv[.gz]>
"""

import argparse
import csv
import gzip
import json
import sys

# ---------------------------------------------------------------- schema
# kind: "int" | "float" | "str" | "cue" (semicolon-separated ints, may be empty)
# nullable: True means an empty CSV field is a legal, *recorded* absence
#           (encoded as the empty string / JSON null) -- never as 0.
FIELDS = [
    # --- run provenance (constant per file) ---
    ("run_id", "str", False),                 # unique run identifier
    ("protocol_sha256", "str", False),        # hash of the registered protocol
    ("arm", "str", False),                    # declared arm name
    ("master", "int", False),                 # master seed
    ("model_hash", "str", False),             # hash of the serialized agent at run start
    # --- trial identity ---
    ("task", "int", False),                   # intended task index
    ("phase", "int", False),                  # 1 = training/commit, 2 = post-commit, 0 = eval
    ("trial", "int", False),                  # index within the stream
    ("eval_call", "int", True),               # evaluation call id; null for training
    ("eval_kind", "int", False),              # cue category code
    # --- cue ---
    ("cue_features", "cue", False),           # active feature indices (sorted, unique); empty = no cue
    ("cue_id", "str", False),                 # stable identifier, e.g. "T1:0-2" or "X:0-2|1-3"
    ("cue_category", "str", False),           # TRAIN/HOLDOUT/CROSS/PARTIAL/AMBIG/MISLEAD/OFF/SHUFFLED
    ("cue_modified", "int", False),           # 1 if the cue was altered from the intended one
    ("held_out", "int", False),               # 1 if this cue combination was withheld from training
    # --- routing ---
    ("intended_bank", "int", True),           # bank that owns the intended task; null if undefined
    ("selected_bank", "int", False),          # bank actually used (-1 = none available)
    ("routing_correct", "int", True),         # null when intended_bank is undefined
    ("bank_score_margin", "float", True),     # top1 - top2 router score; null if not computed
    # --- retrieval ---
    ("intended_slot", "int", True),           # channel slot implied by the mapping's phi
    ("selected_slot", "int", True),           # channel slot the attention sample took
    ("queried", "int", False),                # identity driven into the bank
    ("choice", "int", False),                 # emitted response
    ("correct", "int", False),                # choice == perm[queried]
    ("scoring_window", "int", False),         # decision-window length used for scoring
    # --- memory state ---
    ("active_bank", "int", False),            # writable bank at trial time (-1 = none)
    ("bank_state", "str", False),             # comma list of per-bank state codes
    ("plastic_write", "int", False),          # was the write executed
    ("update_mass_intended", "float", True),  # |dW| on (bank, queried); null if not measured
    ("update_mass_other", "float", True),     # |dW| elsewhere in the bank; null if not measured
    # --- learning ---
    ("reward", "float", False),
    ("advantage", "float", True),             # reward - baseline; null when router did not learn
    ("router_update_l1", "float", True),      # sum |dW_router| this trial; null if none
    # --- checkpoint ---
    ("checkpoint_id", "str", True),           # null unless a checkpoint was written at this trial
    ("resume_from_trial", "int", True),       # null unless this trial follows a resume
]

FIELD_INDEX = {name: (kind, nullable) for name, kind, nullable in FIELDS}
REQUIRED = [f[0] for f in FIELDS]

VALID_CATEGORIES = {"TRAIN", "HOLDOUT", "CROSS", "PARTIAL", "AMBIG", "MISLEAD",
                    "OFF", "SHUFFLED"}

# Field names of the existing L10 harness trial CSV (17 columns), verified in
# work/l10_raw/context_contribution_20261024/KC_cross/trials_*.csv.gz.
L10_COLUMNS = ["master", "task", "phase", "trial", "queried", "choice", "bank",
               "bank_is_task_bank", "correct", "reward", "forced", "writable",
               "eval_kind", "call", "single", "active", "opp"]

# How the L10 columns would be renamed/absorbed into the L11 schema.
L10_TO_L11 = {
    "master": "master", "task": "task", "phase": "phase", "trial": "trial",
    "queried": "queried", "choice": "choice", "bank": "selected_bank",
    "bank_is_task_bank": "routing_correct", "correct": "correct",
    "reward": "reward", "active": "active_bank", "eval_kind": "eval_kind",
    "call": "eval_call",
    # deliberately unmapped: forced / writable / single / opp are L10-specific
    # sealing telemetry with no L11 meaning.
}


class SchemaError(Exception):
    pass


def _parse_int(v, name):
    try:
        return int(v)
    except (TypeError, ValueError):
        raise SchemaError("%s: expected int, got %r" % (name, v))


def _parse_float(v, name):
    try:
        return float(v)
    except (TypeError, ValueError):
        raise SchemaError("%s: expected float, got %r" % (name, v))


def validate_row(row):
    """Validate one record. Raises SchemaError on the first violation."""
    missing = [n for n in REQUIRED if n not in row]
    if missing:
        raise SchemaError("missing fields: %s" % ",".join(missing))

    for name, kind, nullable in FIELDS:
        v = row[name]
        empty = (v is None) or (isinstance(v, str) and v.strip() == "")
        if empty and kind != "cue":   # an empty cue is a value (context absent)
            if not nullable:
                raise SchemaError("%s: empty value but field is not nullable "
                                  "(missing measurements must be null, never 0)" % name)
            continue
        if kind == "cue":
            # An empty cue is a legal, meaningful value (context absent), not a
            # missing measurement -- but it must still be an explicit field.
            if isinstance(v, str):
                parts = [q for q in v.split(";") if q != ""]
                ints = [_parse_int(q, name) for q in parts]
                if ints != sorted(set(ints)):
                    raise SchemaError("%s: cue features must be sorted and unique" % name)
                continue
            raise SchemaError("%s: expected ';'-joined ints" % name)
        if kind == "int":
            _parse_int(v, name)
        elif kind == "float":
            _parse_float(v, name)
        elif kind == "cue":
            if isinstance(v, str):
                parts = [p for p in v.split(";") if p != ""]
                ints = [_parse_int(p, name) for p in parts]
                if ints != sorted(set(ints)):
                    raise SchemaError("%s: cue features must be sorted and unique" % name)
            else:
                raise SchemaError("%s: expected ';'-joined ints" % name)

    if row["cue_category"] not in VALID_CATEGORIES:
        raise SchemaError("cue_category: %r not in %s"
                          % (row["cue_category"], sorted(VALID_CATEGORIES)))

    # Cross-field invariants that make later metric reconstruction sound.
    if _parse_int(row["cue_modified"], "cue_modified") not in (0, 1):
        raise SchemaError("cue_modified must be 0 or 1")
    if _parse_int(row["held_out"], "held_out") not in (0, 1):
        raise SchemaError("held_out must be 0 or 1")
    if _parse_int(row["correct"], "correct") not in (0, 1):
        raise SchemaError("correct must be 0 or 1")
    if row["intended_bank"] in (None, "") and row["routing_correct"] not in (None, ""):
        raise SchemaError("routing_correct must be null when intended_bank is null")
    if row["cue_category"] == "OFF" and str(row["cue_features"]).strip() != "":
        raise SchemaError("OFF rows must carry an empty cue_features")
    # Routing consistency: when both the intended and the selected bank are
    # recorded, routing_correct must agree with them (catches writer bugs where
    # a renamed/relabelled bank silently breaks the derived metric).
    if (row["intended_bank"] not in (None, "")
            and row["routing_correct"] not in (None, "")):
        ib = _parse_int(row["intended_bank"], "intended_bank")
        sb = _parse_int(row["selected_bank"], "selected_bank")
        rc = _parse_int(row["routing_correct"], "routing_correct")
        if rc != (1 if ib == sb else 0):
            raise SchemaError("routing_correct=%d inconsistent with "
                              "intended_bank=%d selected_bank=%d" % (rc, ib, sb))
    if row["cue_category"] == "CROSS":
        n = len([p for p in str(row["cue_features"]).split(";") if p])
        if n < 2:
            raise SchemaError("CROSS rows must carry features of at least two signatures")
    return True


def valid_row(**over):
    base = {
        "run_id": "L11-PROTOTYPE", "protocol_sha256": "0" * 64, "arm": "CROSS-BAL",
        "master": "123456789", "model_hash": "f" * 64,
        "task": "1", "phase": "0", "trial": "7", "eval_call": "12", "eval_kind": "4",
        "cue_features": "2;9", "cue_id": "X:T1-0|T2-1", "cue_category": "CROSS",
        "cue_modified": "0", "held_out": "1",
        "intended_bank": "", "selected_bank": "2", "routing_correct": "",
        "bank_score_margin": "0.0412",
        "intended_slot": "1", "selected_slot": "1", "queried": "3", "choice": "4",
        "correct": "0", "scoring_window": "40",
        "active_bank": "2", "bank_state": "2,2,1", "plastic_write": "0",
        "update_mass_intended": "", "update_mass_other": "",
        "reward": "-1", "advantage": "", "router_update_l1": "",
        "checkpoint_id": "", "resume_from_trial": "",
    }
    base.update({k: str(v) for k, v in over.items()})
    return base


def selftest():
    checks = []

    def expect_ok(name, row):
        try:
            validate_row(row)
            checks.append((name, True, ""))
        except SchemaError as e:
            checks.append((name, False, str(e)))

    def expect_fail(name, row):
        try:
            validate_row(row)
            checks.append((name, False, "accepted an invalid row"))
        except SchemaError as e:
            checks.append((name, True, str(e)))

    expect_ok("valid CROSS row accepted", valid_row())
    expect_ok("valid OFF row accepted",
              valid_row(cue_category="OFF", cue_features="", cue_id="OFF",
                        held_out="0", intended_bank="", routing_correct=""))

    # negative controls: each must be rejected for the named reason
    r = valid_row(); del r["selected_slot"]
    expect_fail("missing field rejected", r)
    expect_fail("non-integer int rejected", valid_row(trial="seven"))
    expect_fail("non-numeric float rejected", valid_row(reward="nan-ish"))
    expect_fail("unknown category rejected", valid_row(cue_category="MIXED"))
    expect_fail("unsorted cue rejected", valid_row(cue_features="9;2"))
    expect_fail("duplicate cue feature rejected", valid_row(cue_features="2;2"))
    expect_fail("inconsistent routing_correct rejected",
                valid_row(intended_bank="2", selected_bank="2", routing_correct="0"))
    expect_fail("routing_correct without intended_bank rejected",
                valid_row(intended_bank="", routing_correct="1"))
    expect_fail("missing non-nullable measurement encoded as empty rejected",
                valid_row(reward=""))
    expect_fail("OFF with cue features rejected",
                valid_row(cue_category="OFF", cue_features="2;9"))
    expect_fail("CROSS with one feature rejected",
                valid_row(cue_category="CROSS", cue_features="2"))
    expect_fail("correct outside {0,1} rejected", valid_row(correct="2"))
    expect_fail("cue_modified outside {0,1} rejected", valid_row(cue_modified="3"))

    # A nullable field must accept an explicit absence (recorded, not imputed).
    try:
        validate_row(valid_row(bank_score_margin=""))
        checks.append(("nullable field accepts explicit null", True,
                       "empty accepted as designed"))
    except SchemaError as e:
        checks.append(("nullable field accepts explicit null", False, str(e)))

    expect_ok("consistent routing_correct accepted",
              valid_row(intended_bank="2", selected_bank="2", routing_correct="1"))

    passed = sum(1 for _, ok, _ in checks if ok)
    for name, ok, note in checks:
        print(("PASS " if ok else "FAIL ") + name + (("  [" + note + "]") if note else ""))
    print("\n%d/%d schema self-tests passed" % (passed, len(checks)))
    return 0 if passed == len(checks) else 1


def coverage(path):
    op = gzip.open if path.endswith(".gz") else open
    with op(path, "rt", newline="") as fh:
        cols = next(csv.reader(fh))
    mapped = {L10_TO_L11[c] for c in cols if c in L10_TO_L11}
    present_literal = [f for f in REQUIRED if f in cols]
    present = [f for f in REQUIRED if f in cols or f in mapped]
    missing = [f for f in REQUIRED if f not in cols and f not in mapped]
    rep = {
        "inspected_file": path,
        "source_columns": len(cols),
        "l11_required_fields": len(REQUIRED),
        "present_literal": present_literal,
        "present_after_rename": sorted(set(present) - set(present_literal)),
        "present": present,
        "missing": missing,
        "coverage": len(present) / float(len(REQUIRED)),
        "unmappable_l10_columns": [c for c in cols if c not in L10_TO_L11],
    }
    print(json.dumps(rep, indent=2))
    return rep


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--coverage")
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    if a.coverage:
        coverage(a.coverage)
        return 0
    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
