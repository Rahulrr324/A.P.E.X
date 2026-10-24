#!/usr/bin/env python3
"""STARK-L10.3 — independent recomputation of the context-contribution diagnostics.

Reads ONLY:
  * per-trial rows emitted by the harness (trials_*.csv)
  * the task permutations (perm.csv)
  * the forced-bank sweep (ctxperbank_*.csv)

It never reads the harness's aggregate columns (acquisition/context_off/...),
so every number it prints is reproduced independently of the code that produced
the run.

Usage: context_contribution.py <run_dir> <suffix> [<perm_csv>]
"""
import csv
import glob
import json
import os
import statistics
import sys
from collections import Counter, defaultdict

COND = {"0": "correct", "1": "holdout", "2": "off", "3": "shuffled",
        "4": "cross", "5": "partial", "6": "off_uniform"}


def load_trials(run, suffix):
    rows = []
    for f in sorted(glob.glob(os.path.join(run, "trials_*%s.csv" % suffix))):
        with open(f) as fh:
            rows += list(csv.DictReader(fh))
    return rows


def load_perm(path):
    perm = {}
    with open(path) as fh:
        for r in csv.DictReader(fh):
            perm[(int(r["master"]), int(r["task"]))] = [int(r["pi%d" % i]) for i in range(6)]
    return perm


def load_perbank(run, suffix):
    A = defaultdict(dict)
    for f in glob.glob(os.path.join(run, "ctxperbank_*%s.csv" % suffix)):
        with open(f) as fh:
            for r in csv.DictReader(fh):
                A[(int(r["master"]), int(r["task"]))][int(r["bank"])] = float(r["acc_cue_off"])
    return A


def main():
    run, suffix = sys.argv[1], sys.argv[2]
    perm_csv = sys.argv[3] if len(sys.argv) > 3 else None
    rows = load_trials(run, suffix)
    A = load_perbank(run, suffix)
    masters = sorted({int(r["master"]) for r in rows})
    K = max(int(r["bank"]) for r in rows) + 1
    K = max(K, 3)

    # ---- per (seed, task, condition) accuracy + routing ---------------------
    cell = defaultdict(list)
    for r in rows:
        if r["eval_kind"] == "-1":      # training rows are not an evaluation condition
            continue
        cell[(int(r["master"]), int(r["task"]), r["eval_kind"])].append(r)

    out = {"run": os.path.abspath(run), "suffix": suffix, "seeds": masters, "K": K,
           "conditions": {}, "per_seed": {}, "pooled": {}, "notes": []}

    conds = sorted({k[2] for k in cell})
    for kind in conds:
        name = COND.get(kind, "kind" + kind)
        per_seed = {}
        for m in masters:
            tasks = {}
            for t in range(3):
                rs = cell.get((m, t, kind), [])
                if not rs:
                    continue
                tasks[t] = {"n": len(rs),
                            "acc": sum(int(x["correct"]) for x in rs) / len(rs),
                            "routing": sum(int(x["bank_is_task_bank"]) for x in rs) / len(rs),
                            "banks": dict(sorted(Counter(int(x["bank"]) for x in rs).items()))}
            if tasks:
                per_seed[m] = tasks
        cat = [v["acc"] for ms in per_seed.values() for v in ms.values()]
        out["conditions"][name] = {
            "per_seed": per_seed,
            "pooled_acc": statistics.mean(cat) if cat else None,
            "pooled_routing": statistics.mean(
                [v["routing"] for ms in per_seed.values() for v in ms.values()]) if cat else None}

    # ---- CAA / CRA ---------------------------------------------------------
    caa_seed, cra_seed = {}, {}
    for m in masters:
        caa, cra = [], []
        for t in range(3):
            rs = cell.get((m, t, "0"), [])
            if not rs or (m, t) not in A:
                continue
            acc_correct = sum(int(x["correct"]) for x in rs) / len(rs)
            acc_null = sum(A[(m, t)][k] for k in range(K)) / K
            caa.append(acc_correct - acc_null)
            cra.append(sum(int(x["bank_is_task_bank"]) for x in rs) / len(rs) - 1.0 / K)
        if caa:
            caa_seed[m] = round(statistics.mean(caa), 6)
            cra_seed[m] = round(statistics.mean(cra), 6)
            out["per_seed"][m] = {
                "CAA": caa_seed[m], "CRA": cra_seed[m],
                "CAA_per_task": [round(x, 6) for x in caa],
                "acc_null_per_task": [round(sum(A[(m, t)][k] for k in range(K)) / K, 6)
                                      for t in range(3)]}
    out["pooled"]["CAA"] = round(statistics.mean(caa_seed.values()), 6) if caa_seed else None
    out["pooled"]["CRA"] = round(statistics.mean(cra_seed.values()), 6) if cra_seed else None

    # ---- degradation profile ----------------------------------------------
    base = out["conditions"]["correct"]["pooled_acc"]
    out["pooled"]["degradation"] = {
        name: round(base - c["pooled_acc"], 6)
        for name, c in out["conditions"].items() if name != "correct"}

    # ---- analytic null from the permutations ------------------------------
    if perm_csv and os.path.exists(perm_csv):
        perm = load_perm(perm_csv)
        analytic = {}
        check = []
        for m in masters:
            per_task = []
            for t in range(3):
                vals = [sum(1 for i in range(6) if perm[(m, k)][i] == perm[(m, t)][i]) / 6.0
                        for k in range(K)]
                per_task.append(sum(vals) / K)
                for k in range(K):
                    if (m, t) in A and k in A[(m, t)]:
                        check.append((m, t, k, A[(m, t)][k], vals[k]))
            analytic[m] = {"acc_null_per_task": [round(x, 6) for x in per_task],
                           "CAA_predicted": round(1.0 - statistics.mean(per_task), 6),
                           "acc_off_predicted_from_fallback":
                               [round(sum(1 for i in range(6)
                                          if perm[(m, 0)][i] == perm[(m, t)][i]) / 6.0, 6)
                                for t in range(3)]}
        out["analytic"] = analytic
        out["model_check"] = {
            "cells": len(check),
            "max_abs_deviation": max(abs(a - b) for _, _, _, a, b in check),
            "deviating_cells": [{"master": m, "task": t, "bank": k, "measured": a,
                                 "predicted": round(b, 6), "delta_trials": round((a - b) * 120, 2)}
                                for m, t, k, a, b in check if abs(a - b) > 1e-6]}

    # ---- fallback descriptors ---------------------------------------------
    fb = {}
    for name in ("off", "off_uniform"):
        if name not in out["conditions"]:
            continue
        banks = Counter()
        n = 0
        for ms in out["conditions"][name]["per_seed"].values():
            for v in ms.values():
                for b, c in v["banks"].items():
                    banks[b] += c
                    n += c
        top = banks.most_common(1)[0]
        fb[name] = {"share_by_bank": {str(b): round(c / n, 4) for b, c in sorted(banks.items())},
                    "modal_bank": top[0], "modal_share": round(top[1] / n, 4)}
    out["fallback"] = fb

    print(json.dumps(out, indent=2))
    return out


if __name__ == "__main__":
    main()
