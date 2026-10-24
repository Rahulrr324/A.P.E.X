#!/usr/bin/env python3
"""STARK-L10.4 — independent official evaluation of L10-K1.

Recomputes CAA, CRA and every L10-K1 clause from raw per-trial rows (and the
forced-bank sweep CSV). It does not read the harness's aggregate columns, and it
does not share code with the harness.

Usage:
  l10_k1_evaluate.py <run_dir> <suffix> <perm_csv> [--json]

Disposition rule (registered before the run, protocol section 10):
  for EACH primary seed: (a) CAA_pooled >= 0.40, (b) CAA(t) >= 0.25 on >= 2 of 3
  tasks, (c) CRA_pooled >= 0.50;  L10-K1 PASS iff all three hold on all seeds.
"""
import csv
import glob
import json
import os
import statistics as st
import sys
from collections import defaultdict

TASKS = 3
SEEDS = [123456789, 218213831, 171473193]
THR_CAA = 0.40
THR_TASK = 0.25
THR_CRA = 0.50


def load_rows(run, suffix):
    rows = []
    for f in sorted(glob.glob(os.path.join(run, "trials_*%s.csv.gz" % suffix))) + \
             sorted(glob.glob(os.path.join(run, "trials_*%s.csv" % suffix))):
        import gzip
        op = gzip.open if f.endswith(".gz") else open
        with op(f, "rt") as fh:
            rows += list(csv.DictReader(fh))
    return rows


def load_sweep(run, suffix):
    A = defaultdict(dict)
    for f in glob.glob(os.path.join(run, "ctxperbank_*%s.csv" % suffix)):
        with open(f) as fh:
            for r in csv.DictReader(fh):
                A[(int(r["master"]), int(r["task"]))][int(r["bank"])] = (float(r["acc_cue_off"]),)
    return A


def load_perm(path):
    out = {}
    with open(path) as fh:
        for r in csv.DictReader(fh):
            out[(int(r["master"]), int(r["task"]))] = [int(r["pi%d" % i]) for i in range(6)]
    return out


def main():
    run, suffix, perm_csv = sys.argv[1], sys.argv[2], sys.argv[3]
    rows = [r for r in load_rows(run, suffix) if r["eval_kind"] != "-1"]
    sweep = load_sweep(run, suffix)
    perm = load_perm(perm_csv)
    seeds = sorted({int(r["master"]) for r in rows})
    K = 3

    cell = defaultdict(list)
    for r in rows:
        cell[(int(r["master"]), int(r["task"]), r["eval_kind"])].append(r)

    # ---------- validity ----------
    # Every evaluation CALL is a 120-trial schedule. Task t is evaluated with the
    # correct cue at its acquisition step and again at each later retention step,
    # so eval_kind 0 legitimately holds 120/240/360 rows for tasks 2/1/0. The
    # scored cell is the FINAL evaluation of the task (protocol v1.1, section 16).
    problems = []
    final_cell = {}
    for m in sorted(seeds):        # scored cell for every seed present
        for t in range(TASKS):
            rs0 = cell.get((m, t, "0"), [])
            if rs0:
                last = max(int(r["call"]) for r in rs0)
                final_cell[(m, t)] = [r for r in rs0 if int(r["call"]) == last]
    for m in SEEDS:              # strict validity for the registered primary seeds
        if m not in seeds:
            problems.append("seed %d missing" % m)
            continue
        for t in range(TASKS):
            for kind in ("0", "1", "2", "3", "5", "6"):
                rs = cell.get((m, t, kind), [])
                if not rs:
                    problems.append("seed %d task %d eval_kind %s absent" % (m, t, kind))
                    continue
                per_call = defaultdict(int)
                for r in rs:
                    per_call[int(r["call"])] += 1
                for call, n in sorted(per_call.items()):
                    if n != 120:
                        problems.append("seed %d task %d eval_kind %s call %d has %d rows (want 120)"
                                        % (m, t, kind, call, n))
            if (m, t) not in sweep:
                problems.append("seed %d task %d missing forced-bank sweep" % (m, t))

    # ---------- per-cell metrics ----------
    detail = {}
    for m in sorted(seeds):   # every seed present; the criterion is applied to the registered ones
        detail[m] = {}
        for t in range(TASKS):
            corr = final_cell[(m, t)]
            acc_correct = sum(int(r["correct"]) for r in corr) / len(corr)
            routed = sum(int(r["bank_is_task_bank"]) for r in corr) / len(corr)
            A = {k: sweep[(m, t)][k][0] for k in sorted(sweep[(m, t)])}
            acc_null = sum(A.values()) / K
            detail[m][t] = {"n_correct_cue": len(corr),
                            "acc_correct": acc_correct,
                            "A": A,
                            "acc_null": acc_null,
                            "CAA": acc_correct - acc_null,
                            "R_correct": routed,
                            "CRA": routed - 1.0 / K,
                            "bank_agreement_predicted": {
                                k: sum(1 for i in range(6) if perm[(m, k)][i] == perm[(m, t)][i]) / 6
                                for k in range(K)}}

    # ---------- criterion ----------
    result = {"run": os.path.abspath(run), "suffix": suffix, "valid": not problems,
              "problems": problems, "seeds": {}, "overall": None}
    all_ok = not problems
    registered = [m for m in detail if m in SEEDS]
    if not registered:
        result["overall"] = {"L10-K1": "NOT APPLICABLE",
                             "note": "exploratory seeds only; no registered primary seed in this run"}
        all_ok = False
    for m in registered:
        caa = [detail[m][t]["CAA"] for t in range(TASKS)]
        cra = [detail[m][t]["CRA"] for t in range(TASKS)]
        caa_pooled = st.mean(caa)
        cra_pooled = st.mean(cra)
        a = caa_pooled >= THR_CAA
        b = sum(1 for x in caa if x >= THR_TASK) >= 2
        c = cra_pooled >= THR_CRA
        result["seeds"][m] = {"CAA_per_task": caa, "CAA_pooled": caa_pooled,
                              "CRA_per_task": cra, "CRA_pooled": cra_pooled,
                              "a_CAA_pooled": a, "b_two_tasks": b, "c_CRA_pooled": c,
                              "seed_pass": a and b and c}
        all_ok = all_ok and (a and b and c)

    pool = registered if registered else list(detail)
    grand_caa = st.mean([detail[m][t]["CAA"] for m in pool for t in range(TASKS)]) if pool else None
    grand_cra = st.mean([detail[m][t]["CRA"] for m in pool for t in range(TASKS)]) if pool else None
    result["overall"] = {"L10-K1": "PASS" if (all_ok and registered) else ("FAIL" if registered else "NOT APPLICABLE"),
                         "grand_CAA": grand_caa, "grand_CRA": grand_cra,
                         "exploratory_seeds": [m for m in detail if m not in SEEDS],
                         "rule": "per-seed (a) CAA_pooled>=0.40, (b) CAA(t)>=0.25 on >=2/3, (c) CRA_pooled>=0.50, all registered seeds"}
    result["detail"] = {str(m): {str(t): detail[m][t] for t in detail[m]} for m in detail}

    # ---------- null checks ----------
    result["forced_bank_model_check"] = {
        "cells": sum(1 for m in detail for t in range(TASKS) for k in range(K)),
        "deviating": [{"master": m, "task": t, "bank": k,
                       "measured": detail[m][t]["A"][k],
                       "predicted": detail[m][t]["bank_agreement_predicted"][k],
                       "delta_trials": round((detail[m][t]["A"][k] - detail[m][t]["bank_agreement_predicted"][k]) * 120, 2)}
                      for m in detail for t in range(TASKS) for k in range(K)
                      if abs(detail[m][t]["A"][k] - detail[m][t]["bank_agreement_predicted"][k]) > 0.5 / 120]}

    if "--json" in sys.argv:
        print(json.dumps(result, indent=2))
        return

    print(f"run {run}  suffix {suffix}  valid={result['valid']}")
    for p in problems:
        print("  INVALID:", p)
    print(f"\n{'seed':>10} {'task':>4} {'acc_correct':>11} {'acc_null':>9} {'CAA':>8} {'R':>7} {'CRA':>8}")
    for m in detail:
        for t in range(TASKS):
            d = detail[m][t]
            print(f"{m:>10} {t:>4} {d['acc_correct']:>11.4f} {d['acc_null']:>9.4f} "
                  f"{d['CAA']:>8.4f} {d['R_correct']:>7.4f} {d['CRA']:>8.4f}")
    print(f"\n{'seed':>10} {'CAA_pooled':>10} {'(a)':>5} {'CRA_pooled':>10} {'(c)':>5} "
          f"{'tasks>=0.25':>11} {'(b)':>5} {'seed':>5}")
    for m, r in result["seeds"].items():
        tag = "" if m in SEEDS else "   (exploratory, no criterion)"
        ok = sum(1 for x in r["CAA_per_task"] if x >= THR_TASK)
        print(f"{m:>10} {r['CAA_pooled']:>10.4f} {str(r['a_CAA_pooled']):>5} "
              f"{r['CRA_pooled']:>10.4f} {str(r['c_CRA_pooled']):>5} {ok:>11} "
              f"{str(r['b_two_tasks']):>5} {('PASS' if r['seed_pass'] else 'FAIL'):>5}{tag}")
    o = result["overall"]
    print(f"\ngrand pooled CAA {o['grand_CAA']:.4f}   grand pooled CRA {o['grand_CRA']:.4f}")
    print(f"L10-K1 = {o['L10-K1']}")
    dev = result["forced_bank_model_check"]["deviating"]
    print(f"\nforced-bank model check: {result['forced_bank_model_check']['cells']} cells, "
          f"{len(dev)} deviating")
    for d in dev:
        print("   ", d)


if __name__ == "__main__":
    main()
