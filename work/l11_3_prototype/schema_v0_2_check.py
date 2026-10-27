#!/usr/bin/env python3
"""
STARK-L11.3 — schema v0.2 executable specification and validator.
PROTOTYPE_ONLY. Documentation support tooling, not an experiment.

Purpose
-------
1. Make the v0.2 invariants in stark/design/l11_trial_schema_v0_2.md executable,
   so the document cannot silently drift from the rules.
2. Self-test those invariants with positive and negative cases.
3. Audit a candidate row set (e.g. a future trials11_*.csv) and report the
   eligibility/metric consequences.

It runs no model and touches no frozen artifact.

Usage:
  python3 schema_v0_2_check.py --selftest
  python3 schema_v0_2_check.py --audit <trials11.csv>
  python3 schema_v0_2_check.py --print-eligibility
"""

import argparse
import csv
import json
import sys

SCHEMA_VERSION = "L11-TRIAL-v0.2"

FIELDS = [
    ("schema_version", "str", "req"), ("run_id", "str", "req"),
    ("protocol_sha256", "hash", "req"), ("schema_sha256", "hash", "req"),
    ("arm", "str", "req"), ("master", "int", "req"), ("model_hash", "hash", "req"),
    ("record_class", "enum", "req"), ("record_status", "enum", "req"),
    ("task", "int", "req"), ("phase", "int", "req"), ("trial", "int", "req"),
    ("eval_call", "int", "opt"), ("eval_kind", "int", "req"),
    ("call_purpose", "str", "opt"),
    ("cue_features", "semi", "req"), ("cue_id", "str", "req"),
    ("cue_category", "enum", "req"), ("cue_modified", "bool", "req"),
    ("held_out", "bool", "req"),
    ("task_bank", "int", "opt"), ("rule_bank", "int", "opt"),
    ("forced_bank", "int", "opt"), ("selected_bank", "int", "req"),
    ("routing_correct", "bool", "opt"), ("rule_compliant", "bool", "opt"),
    ("bank_score_margin", "float", "opt"),
    ("presented_ids", "semi", "req"), ("intended_slot", "int", "req"),
    ("selected_slot", "int", "opt"), ("queried", "int", "req"),
    ("choice", "int", "req"), ("correct", "bool", "req"),
    ("choice_matches_resolved_bank_map", "bool", "opt"), ("scoring_window", "int", "req"),
    ("metric_eligibility", "semi", "req"), ("active_bank", "int", "req"),
    ("bank_state", "csv", "req"), ("plastic_write", "bool", "req"),
    ("update_mass_intended", "float", "opt"),
    ("update_mass_other_in_bank", "float", "opt"),
    ("update_mass_other_banks", "float", "opt"),
    ("reward", "float", "req"), ("advantage", "float", "opt"),
    ("router_update_l1", "float", "opt"),
    ("checkpoint_id", "str", "opt"), ("resume_from_trial", "int", "opt"),
]
FIELD_NAMES = [f[0] for f in FIELDS]

RECORD_CLASSES = {"LEARNING", "EVALUATION", "DIAGNOSTIC_REDERIVATION"}
RECORD_STATUS = {"OK", "INVALID"}
CATEGORIES = {"TRAIN", "HOLDOUT", "CROSS21", "CROSS31", "AMBIG11",
              "PARTIAL", "MISLEAD", "OFF", "SHUFFLED", "ORDERPERM"}
NA_CODES = {"SINGLE_CANDIDATE", "RULE_UNDEFINED", "NO_TASK_BANK", "NO_PERM",
            "NO_DENOM", "STRUCT_ZERO", "NOT_ROUTED"}

# Fields that are indices or booleans and therefore have no legitimate "-1".
# reward, advantage and bank_score_margin are genuine measurements and MAY be
# negative; update_mass_* are magnitudes and may not.
NO_MINUS_ONE = {"task_bank", "rule_bank", "forced_bank", "routing_correct",
                "rule_compliant", "selected_slot", "intended_slot", "eval_call",
                "resume_from_trial", "update_mass_intended",
                "update_mass_other_in_bank", "update_mass_other_banks"}
METRICS = {"ACC", "ROUTE", "RULE", "READ", "MAPCHECK"}

# Section 5 of the schema document. The validator enforces this table exactly.
ELIGIBILITY = {
    "TRAIN":     {"ACC", "ROUTE", "RULE", "READ", "MAPCHECK"},
    "HOLDOUT":   {"ACC", "ROUTE", "RULE", "READ", "MAPCHECK"},
    "PARTIAL":   {"ACC", "ROUTE", "RULE", "READ", "MAPCHECK"},
    "CROSS21":   {"ACC", "ROUTE", "RULE", "READ", "MAPCHECK"},
    "CROSS31":   {"ACC", "ROUTE", "RULE", "READ", "MAPCHECK"},
    "ORDERPERM": {"ACC", "ROUTE", "RULE", "READ", "MAPCHECK"},
    "AMBIG11":   {"ROUTE", "RULE", "READ", "MAPCHECK"},
    "MISLEAD":   {"RULE", "MAPCHECK"},
    "SHUFFLED":  {"ACC", "ROUTE", "READ", "MAPCHECK"},
    "OFF":       {"ACC", "ROUTE", "READ", "MAPCHECK"},
}
# Categories whose rule_compliant may feed Comp (section 5: SHUFFLED is barred).
COMP_CATEGORIES = {"CROSS21", "CROSS31", "ORDERPERM", "AMBIG11"}


class SchemaError(Exception):
    pass


def is_na(v):
    """Accept bare NA (not applicable, no code needed) and NA:<code>."""
    return isinstance(v, str) and (v == "NA" or v.startswith("NA:"))


def na_code(v):
    if not is_na(v):
        return None
    return v.split(":", 1)[1] if ":" in v else ""


def is_absent(v):
    return v is None or (isinstance(v, str) and v.strip() == "") or v in ("NM", "MISSING", "INVALID") or is_na(v)


def num(v, name):
    try:
        return int(v)
    except (TypeError, ValueError):
        raise SchemaError("%s: expected int, got %r" % (name, v))


def nums(v):
    if v is None or v == "":
        return []
    return [int(p) for p in str(v).split(";") if p != ""]


def validate(row):
    """Return normalized dict or raise SchemaError. Enforces every v0.2 rule."""
    missing = [n for n in FIELD_NAMES if n not in row]
    if missing:
        raise SchemaError("missing columns: %s" % ",".join(missing))

    if row["schema_version"] != SCHEMA_VERSION:
        raise SchemaError("schema_version must be %s" % SCHEMA_VERSION)
    if row["record_class"] not in RECORD_CLASSES:
        raise SchemaError("record_class %r invalid" % row["record_class"])
    if row["record_status"] not in RECORD_STATUS:
        raise SchemaError("record_status %r invalid" % row["record_status"])
    if row["cue_category"] not in CATEGORIES:
        raise SchemaError("cue_category %r invalid" % row["cue_category"])

    # --- token legality (rule 1, 3) ---
    for name, kind, _ in FIELDS:
        v = row[name]
        if is_na(v):
            code = na_code(v)
            if code and code not in NA_CODES:
                raise SchemaError("%s: NA code %r not in closed set" % (name, code))
        elif v == "-1" and name in NO_MINUS_ONE:
            raise SchemaError("%s: bare -1 is not a legal absence token" % name)

    # --- rule 2: invalid tokens poison the record ---
    if any(row[n] in ("MISSING", "INVALID") for n, _, _ in FIELDS) and row["record_status"] != "INVALID":
        raise SchemaError("row contains MISSING/INVALID but record_status is not INVALID")

    # --- cue rules (rule 4) ---
    feats = nums(row["cue_features"])
    if feats != sorted(set(feats)):
        raise SchemaError("cue_features must be sorted and unique")
    if row["cue_category"] == "OFF" and feats:
        raise SchemaError("OFF rows must carry an empty cue_features")

    # --- slot / candidate rules (rules 10, 11) ---
    presented = [p for p in str(row["presented_ids"]).split(";") if p != ""]
    live = [p for p in presented if p != "X"]
    single = (len(live) == 1)
    sel_slot = row["selected_slot"]
    if single and not (is_na(sel_slot) and na_code(sel_slot) == "SINGLE_CANDIDATE"):
        raise SchemaError("single-candidate trial must carry NA:SINGLE_CANDIDATE")
    if not single and is_na(sel_slot):
        raise SchemaError("multi-candidate trial must carry a numeric selected_slot")
    if not single and presented:
        islot = num(row["intended_slot"], "intended_slot")
        if 0 <= islot < len(presented) and presented[islot] != "X":
            if num(row["queried"], "queried") != int(presented[islot]):
                raise SchemaError("queried != presented_ids[intended_slot]")

    # --- routing / rule independence (rules 5-9) ---
    tb, rb, sb = row["task_bank"], row["rule_bank"], row["selected_bank"]
    rc, rcomp = row["routing_correct"], row["rule_compliant"]

    if is_absent(tb):
        if not (is_na(tb) and na_code(tb) == "NO_TASK_BANK"):
            raise SchemaError("task_bank absence must be NA:NO_TASK_BANK")
        if not (is_na(rc) and na_code(rc) == "NO_TASK_BANK"):
            raise SchemaError("routing_correct must be NA:NO_TASK_BANK when task_bank is")
    else:
        tb_i, sb_i = num(tb, "task_bank"), num(sb, "selected_bank")
        if is_absent(rc):
            raise SchemaError("routing_correct must be numeric when task_bank is")
        if int(rc) != (1 if tb_i == sb_i else 0):
            raise SchemaError("routing_correct inconsistent with task_bank/selected_bank")

    if is_absent(rb):
        if not (is_na(rb) and na_code(rb) == "RULE_UNDEFINED"):
            raise SchemaError("rule_bank absence must be NA:RULE_UNDEFINED")
        if not (is_na(rcomp) and na_code(rcomp) == "RULE_UNDEFINED"):
            raise SchemaError("rule_compliant must be NA:RULE_UNDEFINED when rule_bank is")
    else:
        rb_i, sb_i = num(rb, "rule_bank"), num(sb, "selected_bank")
        if is_absent(rcomp):
            raise SchemaError("rule_compliant must be numeric when rule_bank is")
        if int(rcomp) != (1 if rb_i == sb_i else 0):
            raise SchemaError("rule_compliant inconsistent with rule_bank/selected_bank")

    # --- eligibility (rules 15, 16) ---
    elig = set(p for p in str(row["metric_eligibility"]).split(";") if p)
    if not elig <= METRICS:
        raise SchemaError("metric_eligibility contains unknown metric")
    if row["record_class"] == "DIAGNOSTIC_REDERIVATION" and (elig & {"ACC", "ROUTE", "RULE", "READ"}):
        raise SchemaError("diagnostic rows must not carry accuracy/routing/rule/read eligibility")
    if elig != ELIGIBILITY[row["cue_category"]]:
        raise SchemaError("metric_eligibility %s != declared set %s for %s"
                          % (sorted(elig), sorted(ELIGIBILITY[row["cue_category"]]),
                             row["cue_category"]))

    for f in ("update_mass_intended", "update_mass_other_in_bank", "update_mass_other_banks"):
        if not is_absent(row[f]) and float(row[f]) < 0.0:
            raise SchemaError("%s must be a magnitude (>= 0)" % f)

    # --- learning/mass rules (rules 14, 17, 18) ---
    if num(sb, "selected_bank") == -1:
        if row["plastic_write"] != "0":
            raise SchemaError("selected_bank -1 implies plastic_write 0")
        for f in ("update_mass_intended", "update_mass_other_in_bank", "update_mass_other_banks"):
            if is_absent(row[f]) or float(row[f]) != 0.0:
                raise SchemaError("%s must be 0.0 when no bank was selected" % f)

    if row["record_class"] == "EVALUATION":
        for f in ("update_mass_intended", "update_mass_other_in_bank",
                  "update_mass_other_banks", "advantage", "router_update_l1"):
            if not (row[f] == "NM"):
                raise SchemaError("%s must be NM on evaluation rows (learning disabled)" % f)

    # --- call identity (rules 19, 20) ---
    if num(row["phase"], "phase") != 0:
        if not is_na(row["eval_call"]):
            raise SchemaError("eval_call must be NA on non-evaluation rows")
    if not is_absent(row["forced_bank"]) and row["call_purpose"] != "forced_bank":
        raise SchemaError("forced_bank numeric only on forced_bank calls")

    return {k: row[k] for k in FIELD_NAMES}


# ---------------------------------------------------------------- metrics
def compute_metrics(rows):
    """Recompute the v0.2 metrics from rows alone. NA is never zero."""
    out = {}
    ok = [r for r in rows if r["record_status"] == "OK"]

    def rate(sel, metric):
        den = [r for r in ok if metric in r["metric_eligibility"].split(";")]
        if not den:
            return {"status": "NA:NO_DENOM", "value": None, "n": 0}
        if metric == "RULE":
            vals = [int(r["rule_compliant"]) for r in den if not is_absent(r["rule_compliant"])]
        elif metric == "ROUTE":
            vals = [int(r["routing_correct"]) for r in den if not is_absent(r["routing_correct"])]
        else:
            vals = [int(r["correct"]) for r in den]
        if not vals:
            return {"status": "NA:NO_DENOM", "value": None, "n": 0}
        return {"status": "OBSERVED", "value": sum(vals) / len(vals), "n": len(vals)}

    cats = sorted({r["cue_category"] for r in ok})
    for c in cats:
        sub = [r for r in ok if r["cue_category"] == c]
        out[c] = {"acc": rate(sub, "ACC"), "routing": rate(sub, "ROUTE"),
                  "comp": rate(sub, "RULE") if c in COMP_CATEGORIES
                          else {"status": "NA:STRUCT_ZERO", "value": None, "n": 0}}

        # Read: correct | routing_correct == 1
        routed = [r for r in sub if r["routing_correct"] == "1"]
        if "READ" not in ELIGIBILITY[c]:
            out[c]["read"] = {"status": "NA:STRUCT_ZERO", "value": None, "n": 0}
        elif not routed:
            out[c]["read"] = {"status": "NA:NO_DENOM", "value": None, "n": 0}
        else:
            out[c]["read"] = {"status": "OBSERVED",
                              "value": sum(int(r["correct"]) for r in routed) / len(routed),
                              "n": len(routed)}
    return out


# ---------------------------------------------------------------- selftest
def base_row(**over):
    r = {
        "schema_version": SCHEMA_VERSION, "run_id": "L11-TEST-A2-123456789-x",
        "protocol_sha256": "0" * 64, "schema_sha256": "1" * 64,
        "arm": "A2", "master": "123456789", "model_hash": "2" * 64,
        "record_class": "EVALUATION", "record_status": "OK",
        "task": "1", "phase": "0", "trial": "7", "eval_call": "17",
        "eval_kind": "4", "call_purpose": "cross",
        "cue_features": "2;5;9", "cue_id": "X2:2|1-0|2-1", "cue_category": "CROSS21",
        "cue_modified": "0", "held_out": "1",
        "task_bank": "1", "rule_bank": "1", "forced_bank": "NA",
        "selected_bank": "1", "routing_correct": "1", "rule_compliant": "1",
        "bank_score_margin": "NM",
        "presented_ids": "3;5", "intended_slot": "1", "selected_slot": "0",
        "queried": "5", "choice": "2", "correct": "1",
        "choice_matches_resolved_bank_map": "1", "scoring_window": "6",
        "metric_eligibility": "ACC;ROUTE;RULE;READ;MAPCHECK",
        "active_bank": "1", "bank_state": "2,1,2", "plastic_write": "0",
        "update_mass_intended": "NM", "update_mass_other_in_bank": "NM",
        "update_mass_other_banks": "NM", "reward": "-1",
        "advantage": "NM", "router_update_l1": "NM",
        "checkpoint_id": "NA", "resume_from_trial": "NA",
    }
    r.update({k: str(v) for k, v in over.items()})
    return r


def selftest():
    checks = []

    def ok(name, row):
        try:
            validate(row); checks.append((name, True, ""))
        except SchemaError as e:
            checks.append((name, False, str(e)))

    def bad(name, row, expect=None):
        try:
            validate(row)
            checks.append((name, False, "accepted an invalid row"))
        except SchemaError as e:
            msg = str(e)
            good = (expect is None) or (expect in msg)
            checks.append((name, good, msg))

    ok("valid CROSS21 row accepted", base_row())
    ok("negative score margin accepted (a genuine measurement)", base_row(bank_score_margin="-0.25"))
    ok("MISLEAD row accepted (RULE;MAPCHECK only)",
       base_row(cue_category="MISLEAD", metric_eligibility="RULE;MAPCHECK",
                task_bank="1", rule_bank="0", selected_bank="0",
                routing_correct="0", rule_compliant="1", held_out="0"))
    ok("OFF row accepted (empty cue, NA rule)",
       base_row(cue_category="OFF", cue_features="", cue_id="OFF",
                metric_eligibility="ACC;ROUTE;READ;MAPCHECK",
                rule_bank="NA:RULE_UNDEFINED", rule_compliant="NA:RULE_UNDEFINED",
                held_out="0"))
    ok("single-candidate trial accepted",
       base_row(presented_ids="3;X", selected_slot="NA:SINGLE_CANDIDATE", intended_slot="0"))
    ok("SHUFFLED row accepted without RULE eligibility",
       base_row(cue_category="SHUFFLED", metric_eligibility="ACC;ROUTE;READ;MAPCHECK",
                task_bank="1", rule_bank="0", selected_bank="0",
                routing_correct="0", rule_compliant="1"))

    # negative controls, one per invariant class
    bad("missing column rejected", {k: v for k, v in base_row().items() if k != "rule_bank"},
        "missing columns")
    bad("bare -1 on an index field rejected",
        base_row(selected_slot="-1"), "bare -1")
    bad("unknown NA code rejected",
        base_row(rule_bank="NA:WHATEVER", rule_compliant="NA:WHATEVER"), "closed set")
    bad("routing_correct inconsistent with task_bank rejected",
        base_row(task_bank="2", routing_correct="1"), "routing_correct inconsistent")
    bad("rule_compliant inconsistent with rule_bank rejected",
        base_row(rule_bank="2", rule_compliant="1"), "rule_compliant inconsistent")
    bad("task_bank NA without matching routing NA rejected",
        base_row(task_bank="NA:NO_TASK_BANK", routing_correct="1"), "NA:NO_TASK_BANK")
    bad("rule NA without matching compliance NA rejected",
        base_row(rule_bank="NA:RULE_UNDEFINED", rule_compliant="1"), "NA:RULE_UNDEFINED")
    bad("eligibility mismatch rejected",
        base_row(metric_eligibility="ACC;ROUTE"), "declared set")
    bad("MISLEAD claiming ACC eligibility rejected",
        base_row(cue_category="MISLEAD", metric_eligibility="ACC;RULE;MAPCHECK"),
        "declared set")
    bad("SHUFFLED claiming RULE eligibility rejected",
        base_row(cue_category="SHUFFLED", metric_eligibility="ACC;ROUTE;RULE;READ;MAPCHECK"),
        "declared set")
    bad("diagnostic row claiming accuracy eligibility rejected",
        base_row(record_class="DIAGNOSTIC_REDERIVATION"), "diagnostic rows")
    bad("single-candidate without NA slot token rejected",
        base_row(presented_ids="3;X", selected_slot="0"), "SINGLE_CANDIDATE")
    bad("multi-candidate with NA slot token rejected",
        base_row(selected_slot="NA:SINGLE_CANDIDATE"), "numeric selected_slot")
    bad("queried != presented[intended_slot] rejected",
        base_row(queried="3"), "presented_ids[intended_slot]")
    bad("evaluation row carrying update mass rejected",
        base_row(update_mass_intended="0.5"), "must be NM on evaluation")
    bad("OFF with cue features rejected", base_row(cue_category="OFF"), "empty cue_features")
    bad("unsorted cue rejected", base_row(cue_features="9;2;5"), "sorted and unique")
    bad("MISSING token without INVALID status rejected",
        base_row(choice="MISSING"), "record_status is not INVALID")
    bad("forced_bank on a non-forced call rejected",
        base_row(forced_bank="2"), "forced_bank numeric only")
    bad("eval_call present on a training row rejected",
        base_row(phase="1", eval_call="3"), "eval_call must be NA")

    # metric layer
    rows = [
        base_row(trial="0", correct="1", routing_correct="1", rule_compliant="1"),
        base_row(trial="1", correct="1", routing_correct="1", rule_compliant="1"),
        base_row(trial="2", selected_bank="2", routing_correct="0",
                 rule_compliant="0", correct="0"),
    ]
    m = compute_metrics([validate(r) for r in rows])
    acc = m["CROSS21"]["acc"]["value"]
    checks.append(("metrics: acc = 2/3", abs(acc - 2 / 3) < 1e-12, "%.6f" % acc))
    checks.append(("metrics: Read conditioned on routing_correct == 1",
                   abs(m["CROSS21"]["read"]["value"] - 1.0) < 1e-12,
                   str(m["CROSS21"]["read"])))

    mis = compute_metrics([validate(base_row(
        cue_category="MISLEAD", metric_eligibility="RULE;MAPCHECK", task_bank="1",
        rule_bank="0", selected_bank="0", routing_correct="0", rule_compliant="1"))])
    checks.append(("metrics: MISLEAD Read is NA, never 0",
                   mis["MISLEAD"]["read"]["status"] == "NA:STRUCT_ZERO"
                   and mis["MISLEAD"]["read"]["value"] is None,
                   str(mis["MISLEAD"]["read"])))
    checks.append(("metrics: MISLEAD acc is NA, never 0",
                   mis["MISLEAD"]["acc"]["status"] == "NA:NO_DENOM"
                   and mis["MISLEAD"]["acc"]["value"] is None,
                   str(mis["MISLEAD"]["acc"])))
    sh = compute_metrics([validate(base_row(
        cue_category="SHUFFLED", metric_eligibility="ACC;ROUTE;READ;MAPCHECK",
        task_bank="1", rule_bank="0", selected_bank="0", routing_correct="0",
        rule_compliant="1"))])
    checks.append(("metrics: SHUFFLED never contributes to Comp",
                   sh["SHUFFLED"]["comp"]["status"] == "NA:STRUCT_ZERO",
                   str(sh["SHUFFLED"]["comp"])))
    checks.append(("metrics: a routed miss is still an observed 0, not NA",
                   sh["SHUFFLED"]["acc"]["status"] == "OBSERVED",
                   str(sh["SHUFFLED"]["acc"])))

    passed = sum(1 for _, good, _ in checks if good)
    for name, good, note in checks:
        print(("PASS " if good else "FAIL ") + name + (("  [" + note + "]") if note and not good else ""))
    print("\n%d/%d v0.2 self-tests passed" % (passed, len(checks)))
    return 0 if passed == len(checks) else 1


def audit(path):
    with open(path, newline="") as fh:
        raw = list(csv.DictReader(fh))
    good, bad_rows = [], []
    for i, r in enumerate(raw):
        try:
            good.append(validate(r))
        except SchemaError as e:
            bad_rows.append({"row": i, "reason": str(e)})
    rep = {"file": path, "rows": len(raw), "valid": len(good), "invalid": len(bad_rows),
           "invalid_detail": bad_rows[:20],
           "metrics": compute_metrics(good) if good else {}}
    print(json.dumps(rep, indent=2, sort_keys=True))
    return 0 if not bad_rows else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--audit")
    ap.add_argument("--print-eligibility", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    if a.audit:
        return audit(a.audit)
    if a.print_eligibility:
        print(json.dumps({k: sorted(v) for k, v in ELIGIBILITY.items()}, indent=2, sort_keys=True))
        return 0
    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
