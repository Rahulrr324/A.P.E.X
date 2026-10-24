#!/usr/bin/env python3
"""STARK-L10.3 — independent recomputation of the context-contribution results.

Reads ONLY per-trial rows, the task permutations and the forced-bank sweep.
Never reads the harness aggregate columns.

Usage: recompute.py <run_dir> <suffix> <perm_csv> [<extra_dir:suffix> ...]
"""
import csv
import glob
import os
import statistics as st
import sys
from collections import Counter, defaultdict

COND = {"0": "correct", "1": "holdout", "2": "off", "3": "shuffled",
        "4": "cross", "5": "partial", "6": "off_uniform"}


def trials(d, suf):
    out = []
    for f in sorted(glob.glob(os.path.join(d, "trials_*%s.csv" % suf))):
        with open(f) as fh:
            out += list(csv.DictReader(fh))
    return out


def perbank(d, suf):
    A = defaultdict(dict)
    for f in glob.glob(os.path.join(d, "ctxperbank_*%s.csv" % suf)):
        with open(f) as fh:
            for r in csv.DictReader(fh):
                A[(int(r["master"]), int(r["task"]))][int(r["bank"])] = float(r["acc_cue_off"])
    return A


def perms(path):
    out = {}
    with open(path) as fh:
        for r in csv.DictReader(fh):
            out[(int(r["master"]), int(r["task"]))] = [int(r["pi%d" % i]) for i in range(6)]
    return out


def main():
    d, suf, perm_csv = sys.argv[1], sys.argv[2], sys.argv[3]
    rows = [r for r in trials(d, suf) if r["eval_kind"] != "-1"]
    A = perbank(d, suf)
    P = perms(perm_csv)
    seeds = sorted({int(r["master"]) for r in rows})
    cell = defaultdict(list)
    for r in rows:
        cell[(int(r["master"]), int(r["task"]), r["eval_kind"])].append(r)

    def acc(m, t, kind):
        rs = cell.get((m, t, kind))
        if not rs:
            return None
        return sum(int(x["correct"]) for x in rs) / len(rs)

    def rout(m, t, kind):
        rs = cell.get((m, t, kind))
        if not rs:
            return None
        return sum(int(x["bank_is_task_bank"]) for x in rs) / len(rs)

    print("run:", os.path.abspath(d), "suffix:", suf, "seeds:", seeds)

    print("\n== 1. conditions: pooled accuracy / routing ==")
    print(f"{'condition':>12} {'acc':>8} {'routing':>8} {'n':>6}")
    for kind in sorted({k[2] for k in cell}):
        a = [v for m in seeds for t in range(3) if (v := acc(m, t, kind)) is not None]
        r = [v for m in seeds for t in range(3) if (v := rout(m, t, kind)) is not None]
        if a:
            print(f"{COND.get(kind, kind):>12} {st.mean(a):>8.4f} {st.mean(r):>8.4f} {len(a)*120:>6}")

    print("\n== 2. CAA / CRA per seed ==")
    print(f"{'seed':>10} {'CAA_t0':>8} {'CAA_t1':>8} {'CAA_t2':>8} {'CAA':>8} {'CRA':>8}")
    caa_all, cra_all = [], []
    for m in seeds:
        caa, cra = [], []
        for t in range(3):
            a = acc(m, t, "0")
            if a is None or (m, t) not in A:
                continue
            null = sum(A[(m, t)][k] for k in range(3)) / 3
            caa.append(a - null)
            cra.append(rout(m, t, "0") - 1 / 3)
        if caa:
            caa_all.append(st.mean(caa))
            cra_all.append(st.mean(cra))
            print(f"{m:>10} " + " ".join(f"{x:>8.4f}" for x in caa) +
                  f" {st.mean(caa):>8.4f} {st.mean(cra):>8.4f}")
    print(f"{'POOLED':>10} " + " " * 27 + f" {st.mean(caa_all):>8.4f} {st.mean(cra_all):>8.4f}")

    print("\n== 3. context-off vs the analytic fallback floor ==")
    print(f"{'seed':>10} {'task':>4} {'measured':>9} {'analytic':>9} {'excess':>9} {'margin':>7}")
    worst = 0.0
    for m in seeds:
        for t in range(3):
            off = acc(m, t, "2")
            if off is None:
                continue
            an = sum(1 for i in range(6) if P[(m, 0)][i] == P[(m, t)][i]) / 6
            worst = max(worst, abs(off - an))
            print(f"{m:>10} {t:>4} {off:>9.4f} {an:>9.4f} {off-an:>+9.4f} {acc(m,t,'0')-off:>7.4f}")
    print(f"max |measured - analytic| = {worst:.3g}")

    print("\n== 4. forced-bank competence A(k,t) (context removed) ==")
    print(f"{'seed':>10} {'task':>4} {'bank0':>7} {'bank1':>7} {'bank2':>7} {'agreement':>28}")
    for m in seeds:
        for t in range(3):
            if (m, t) not in A:
                continue
            ag = [round(sum(1 for i in range(6) if P[(m, k)][i] == P[(m, t)][i]) / 6, 4) for k in range(3)]
            print(f"{m:>10} {t:>4} " + " ".join(f"{A[(m,t)][k]:>7.4f}" for k in range(3)) +
                  f"   {str(ag):>25}")

    print("\n== 5. fallback behaviour ==")
    for kind in ("2", "6"):
        banks = Counter()
        for m in seeds:
            for t in range(3):
                for r in cell.get((m, t, kind), []):
                    banks[int(r["bank"])] += 1
        n = sum(banks.values())
        if n:
            print(f"  eval_kind {kind} ({COND.get(kind)}): " +
                  ", ".join(f"bank{b}={c/n:.3f}" for b, c in sorted(banks.items())) +
                  f"  modal={banks.most_common(1)[0][0]}")


if __name__ == "__main__":
    main()
