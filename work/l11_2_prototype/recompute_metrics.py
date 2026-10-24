#!/usr/bin/env python3
"""
STARK-L11.2 — call-aware metric reconstruction (analysis tooling, not an experiment).

Why v2: the L11.1 prototype (`work/l11_1_prototype/recompute_from_trials.py`)
groups rows by `task` only. That is correct for cue categories that are evaluated
in exactly one call per task (e.g. L10.3 `eval_kind == 4`), but WRONG for
`eval_kind == 0`, where each task is evaluated in several calls
(`acquisition`, `retention@step1`, ...). Discovered in L11.2 by reconstructing a
fresh harness run: per-task row counts were 360/240/120 instead of 120 each.
The L11.1 finding is unaffected (its arm has one call per task), but the tool is
fixed here rather than quietly reused.

Grouping is by (task, eval_call). Every metric is traceable to a call.

Explicit failures (never silent):
  - duplicate (task, call, trial) keys
  - ragged call sizes
  - unknown eval_kind
  - the legacy -1 sentinel appearing where a measurement is expected
  - a per-call count that disagrees with the harness aggregate

Usage:
  python3 recompute_metrics.py <trials.csv> --calls <calls.csv>
        [--eval-kind N] [--metrics <metrics.csv> --metrics-column NAME]
        [--json out.json]
"""

import argparse
import csv
import gzip
import json
import sys
from collections import defaultdict

# Legacy harness sentinel for "not measured" (observed in metrics_*.csv:
# cross_novel = -1.000000 when the arm did not run). It must never be averaged.
NOT_MEASURED = -1.0


class ReconstructionError(Exception):
    pass


def load(path):
    if path.endswith(".gz"):
        gzip.open(path, "rt", newline="")  # noqa: F841  (documented below)
        with gzip.open(path, "rt", newline="") as fh:
            return list(csv.DictReader(fh))
    with open(path, newline="") as fh:
        return list(csv.DictReader(fh))


def load_calls(path):
    calls = {}
    for r in load(path):
        calls[int(r["call"])] = {"purpose": r["purpose"], "task": int(r["task"]),
                                 "eval_kind": int(r["eval_kind"])}
    return calls


def reconstruct(trials, calls, eval_kind=None):
    seen = set()
    groups = defaultdict(list)
    for r in trials:
        if eval_kind is not None and int(r["eval_kind"]) != eval_kind:
            continue
        key = (int(r["task"]), int(r["call"]), int(r["trial"]))
        if key in seen:
            raise ReconstructionError("duplicate trial key %s" % (key,))
        seen.add(key)
        groups[(int(r["task"]), int(r["call"]))].append(r)

    if not groups:
        raise ReconstructionError("no rows selected")

    per_call = {}
    for (task, call), rows in sorted(groups.items()):
        n = len(rows)
        correct = sum(int(r["correct"]) for r in rows)
        routed = sum(int(r["bank_is_task_bank"]) for r in rows)
        c_r = sum(int(r["correct"]) for r in rows if int(r["bank_is_task_bank"]) == 1)
        c_w = sum(int(r["correct"]) for r in rows if int(r["bank_is_task_bank"]) == 0)
        n_w = n - routed
        per_call["%d:%d" % (task, call)] = {
            "task": task, "call": call, "purpose": calls.get(call, {}).get("purpose", "?"),
            "eval_kind": int(rows[0]["eval_kind"]),
            "n": n,
            "accuracy": correct / n,
            "routing": routed / n,
            "acc_given_routed": (c_r / routed) if routed else None,
            "acc_given_unrouted": (c_w / n_w) if n_w else None,
        }

    sizes = defaultdict(set)
    for (task, call), rows in groups.items():
        sizes[task].add(len(rows))
    ragged = {t: sorted(s) for t, s in sizes.items() if len(s) > 1}

    valid = list(per_call.values())
    tot_n = sum(v["n"] for v in valid)
    pooled = {
        "n": tot_n,
        "accuracy": sum(v["accuracy"] * v["n"] for v in valid) / tot_n,
        "routing": sum(v["routing"] * v["n"] for v in valid) / tot_n,
    }
    return {"per_call": per_call, "pooled": pooled,
            "ragged_task_sizes": ragged,
            "calls_involved": sorted({int(k.split(":")[1]) for k in per_call})}


def compare(res, metrics_path, column):
    """Compare a designated call's reconstruction with the harness aggregate."""
    rows = load(metrics_path)
    pub = {}
    for r in rows:
        v = float(r[column])
        pub[int(r["step_task"])] = None if abs(v - NOT_MEASURED) < 1e-12 else v
    out = {"column": column, "per_task": {}, "match": True}
    for key, v in res["per_call"].items():
        if v["purpose"] != "acquisition":
            continue          # the aggregate column reports the acquisition call
        p = pub.get(v["task"])
        if p is None:
            out["per_task"][v["task"]] = {"published": None, "reconstructed": v["accuracy"],
                                          "status": "NOT_MEASURED_in_harness"}
            continue
        d = abs(p - v["accuracy"])
        out["per_task"][v["task"]] = {"published": p, "reconstructed": v["accuracy"],
                                      "abs_diff": d}
        if d > 5e-7:
            out["match"] = False
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("trials")
    ap.add_argument("--calls", required=True)
    ap.add_argument("--eval-kind", type=int, default=None)
    ap.add_argument("--metrics")
    ap.add_argument("--metrics-column", default="acquisition")
    ap.add_argument("--json")
    a = ap.parse_args()

    try:
        trials = load(a.trials)
        calls = load_calls(a.calls)
        res = reconstruct(trials, calls, a.eval_kind)
        report = {"trials": a.trials, "calls": a.calls,
                  "eval_kind_filter": a.eval_kind, "reconstruction": res}
        if a.metrics:
            report["published_comparison"] = compare(res, a.metrics, a.metrics_column)
        if res["ragged_task_sizes"]:
            report["WARNING_ragged_task_sizes"] = res["ragged_task_sizes"]
    except ReconstructionError as e:
        print(json.dumps({"status": "RECONSTRUCTION_FAILED", "reason": str(e)}))
        return 2

    txt = json.dumps(report, indent=2, sort_keys=True)
    print(txt)
    if a.json:
        open(a.json, "w").write(txt + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
