#!/usr/bin/env python3
"""
STARK-L11.1 — PROTOTYPE ONLY (not part of any official evaluation).

Purpose
-------
Prove that the proposed L11 trial schema carries enough information to
reconstruct every primary metric independently, by reconstructing one *existing*
L10.3 aggregate from raw L10.3 trial rows.

It does NOT run an experiment, does NOT touch frozen evidence (read-only), and
does NOT produce an official L11 result. Its only claim is methodological:
"routing and retrieval are separable from trial rows, and the separation
reproduces the published aggregate".

Usage:
  python3 recompute_from_trials.py <trials.csv[.gz]> --eval-kind 4 \
      [--metrics <metrics.csv>] [--metrics-column cross_novel] [--json out.json]
"""

import argparse
import csv
import gzip
import json
import sys
from collections import defaultdict


def open_maybe_gz(path):
    if path.endswith(".gz"):
        return gzip.open(path, "rt", newline="")
    return open(path, "rt", newline="")


def load_rows(path, eval_kind):
    rows = []
    with open_maybe_gz(path) as fh:
        for r in csv.DictReader(fh):
            if eval_kind is not None and int(r["eval_kind"]) != eval_kind:
                continue
            rows.append(r)
    return rows


def reconstruct(rows):
    """Reconstruct routing and retrieval metrics from trial rows only.

    Definitions (identical to the L11 protocol definitions):
      accuracy      = mean(correct)
      routing       = mean(bank_is_task_bank)
      acc|routed    = mean(correct | bank_is_task_bank == 1)
      acc|unrouted  = mean(correct | bank_is_task_bank == 0)
    Trials with a missing bank (-1) are counted as routing failures, never
    dropped and never imputed to zero correctness.
    """
    per_task = defaultdict(lambda: {"n": 0, "correct": 0, "routed": 0,
                                    "correct_routed": 0, "n_unrouted": 0,
                                    "correct_unrouted": 0})
    for r in rows:
        t = int(r["task"])
        d = per_task[t]
        c = int(r["correct"])
        b = int(r["bank_is_task_bank"])
        d["n"] += 1
        d["correct"] += c
        if b == 1:
            d["routed"] += 1
            d["correct_routed"] += c
        else:
            d["n_unrouted"] += 1
            d["correct_unrouted"] += c

    out = {"per_task": {}, "pooled": {}}
    tn = tc = tr = 0
    for t in sorted(per_task):
        d = per_task[t]
        out["per_task"][t] = {
            "n": d["n"],
            "accuracy": d["correct"] / d["n"],
            "routing": d["routed"] / d["n"],
            "acc_given_routed": (d["correct_routed"] / d["routed"]) if d["routed"] else None,
            "acc_given_unrouted": (d["correct_unrouted"] / d["n_unrouted"]) if d["n_unrouted"] else None,
        }
        tn += d["n"]; tc += d["correct"]; tr += d["routed"]
    out["pooled"] = {"n": tn, "accuracy": tc / tn if tn else None,
                     "routing": tr / tn if tn else None}
    return out


def compare_with_published(res, metrics_path, column):
    """Compare the reconstruction with the harness's own aggregate."""
    with open(metrics_path, "rt", newline="") as fh:
        pub = {int(r["step_task"]): float(r[column]) for r in csv.DictReader(fh)}
    diffs = {}
    for t, d in res["per_task"].items():
        diffs[t] = {"published": pub.get(t), "reconstructed": d["accuracy"],
                    "abs_diff": abs(pub.get(t, 0.0) - d["accuracy"])}
    ok = all(v["abs_diff"] < 5e-7 for v in diffs.values())
    return {"column": column, "per_task": diffs, "match": ok}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("trials")
    ap.add_argument("--eval-kind", type=int, default=4)
    ap.add_argument("--metrics")
    ap.add_argument("--metrics-column", default="cross_novel")
    ap.add_argument("--json")
    a = ap.parse_args()

    rows = load_rows(a.trials, a.eval_kind)
    if not rows:
        print("no rows for eval_kind=%d" % a.eval_kind, file=sys.stderr)
        return 2
    res = reconstruct(rows)
    report = {"trials": a.trials, "eval_kind": a.eval_kind,
              "n_rows": len(rows), "reconstruction": res}
    if a.metrics:
        report["published_comparison"] = compare_with_published(res, a.metrics, a.metrics_column)
    txt = json.dumps(report, indent=2, sort_keys=True)
    print(txt)
    if a.json:
        with open(a.json, "w") as fh:
            fh.write(txt + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
