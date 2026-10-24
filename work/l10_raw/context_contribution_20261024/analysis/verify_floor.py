#!/usr/bin/env python3
"""STARK-L10.3 — analytic floor and criterion-null calculations.

Everything here is derived from the task permutations only (plus, when given,
the measured forced-bank matrix for a consistency check). No harness aggregate
is read.

Sections
  A. fixed-point distribution of a uniform random permutation of 6 elements
  B. the deterministic bank-0 fallback: what L10-E's context-off half measures,
     its expected value and the exact probability that a PERFECT router passes
     the 0.40 threshold (single seed and pooled over 3 seeds)
  C. the null and the pass probability of the proposed L10-K1 statistic CAA
  D. consistency check of A(k,t) against agreement(perm_k, perm_t)/6

Usage: verify_floor.py [perm.csv] [ctxperbank_dir] [suffix]
"""
import csv
import glob
import itertools
import os
import sys
from collections import Counter
from math import comb, factorial

N_IDS = 6


def fixed_point_pmf(n=N_IDS):
    """P(a = k) for the number of fixed points of a uniform random permutation."""
    counts = []
    for k in range(n + 1):
        d = 0
        for j in range(n - k + 1):
            d += (-1) ** j / factorial(j)
        counts.append(comb(n, k) * round(factorial(n - k) * d))
    total = sum(counts)
    assert total == factorial(n), (total, factorial(n))
    return counts, [c / total for c in counts]


def pmf_conv(p, k):
    out = {0: 1.0}
    for _ in range(k):
        nxt = Counter()
        for s, v in out.items():
            for s2, v2 in enumerate(p):
                nxt[s + s2] += v * v2
        out = nxt
    return out


def main():
    print("== A. fixed-point distribution (n = 6) ==")
    counts, p = fixed_point_pmf()
    print("  counts D(6,k):", counts, " total", sum(counts))
    print("  pmf:", [round(x, 6) for x in p])
    print("  E[a] =", round(sum(k * v for k, v in enumerate(p)), 6))

    print("\n== B. deterministic bank-0 fallback (what L10-E's context-off half measures) ==")
    print("  acc_off(t) = A(0,t) = fixed-point agreement of pi_0 and pi_t / 6")
    print("  acc_off(0) = 1 exactly; each t != 0 has E = 1/6")
    print("  E[per-seed context-off mean] = (1 + 2/6)/3 =", round((1 + 2 / 6) / 3, 6))
    # X = a1 + a2 for one seed
    X = Counter()
    for a1 in range(N_IDS + 1):
        for a2 in range(N_IDS + 1):
            X[a1 + a2] += p[a1] * p[a2]
    p_single = sum(v for k, v in X.items() if (N_IDS + k) / 18 <= 0.40 + 1e-12)
    print("  P(single seed pooled <= 0.40) =", round(p_single, 6))
    # three seeds: sum over seeds of (6 + X) / 54 <= 0.40
    tot = Counter()
    for combo in itertools.product(range(2 * N_IDS + 1), repeat=3):
        tot[sum(combo)] += X[combo[0]] * X[combo[1]] * X[combo[2]]
    p_pool = sum(v for s, v in tot.items() if (18 + s) / 54 <= 0.40 + 1e-12)
    print("  P(pooled over 3 seeds <= 0.40) =", round(p_pool, 6),
          "  <-- a PERFECT router passes only this often")
    print("  attainable range of the pooled mean: [1/3, 1]")

    print("\n== C. proposed L10-K1 (CAA) under a perfect router ==")
    Y = pmf_conv(p, 3)          # sum of the 3 pairwise agreement counts of one seed
    print("  E[sum of 3 pairwise agreements] =", round(sum(k * v for k, v in Y.items()), 6))
    # CAA_seed = 1 - (3 + sum/3)/9 ; criterion: mean over 3 seeds >= 0.40
    # mean over the 27 (seed, k, t) cells = (9 + sum_of_9_pairwise_agreements/3) / 27
    tot2 = pmf_conv(p, 9)       # 9 pairwise agreement counts over 3 seeds
    p_caa = sum(v for s, v in tot2.items() if 1 - (9 + s / 3) / 27 >= 0.40 - 1e-12)
    print("  P(CAA_pooled >= 0.40) for a perfect router =", round(p_caa, 6))
    print("  E[CAA_pooled] =", round(1 - (9 + 9 * (1 / 3)) / 27, 6),
          " (ceiling for K=3 and perfect routing: 5/9 =", round(5 / 9, 6), ")")
    print("  P(CAA_pooled >= 0.40) under the null (context ignored) = 0 by construction")
    print("  null (context ignored): CAA = 0 by construction")

    if len(sys.argv) > 1 and os.path.exists(sys.argv[1]):
        print("\n== D. A(k,t) vs agreement(perm_k, perm_t)/6 ==")
        perm = {}
        with open(sys.argv[1]) as fh:
            for r in csv.DictReader(fh):
                perm[(int(r["master"]), int(r["task"]))] = [int(r["pi%d" % i]) for i in range(N_IDS)]
        A = {}
        if len(sys.argv) > 2:
            for f in glob.glob(os.path.join(sys.argv[2], "ctxperbank_*%s.csv" % (sys.argv[3] if len(sys.argv) > 3 else ""))):
                with open(f) as fh:
                    for r in csv.DictReader(fh):
                        A[(int(r["master"]), int(r["task"]), int(r["bank"]))] = float(r["acc_cue_off"])
        dev = []
        cells = 0
        for (m, t) in perm:
            for k in range(3):
                pred = sum(1 for i in range(N_IDS) if perm[(m, k)][i] == perm[(m, t)][i]) / N_IDS
                key = (m, t, k)
                if key in A:
                    cells += 1
                    if abs(A[key] - pred) > 1e-6:
                        dev.append((m, t, k, A[key], pred, round((A[key] - pred) * 120, 2)))
        print("  cells checked:", cells, " deviating:", len(dev))
        for d in dev:
            print("   ", d)


if __name__ == "__main__":
    main()
