#!/usr/bin/env python3
"""Phase 53 - read-only condition-order / marginal-shift analysis.

Question: are the unresolved mean/median differences in the six B7 captures
associated with CONDITION EXECUTION ORDER (which condition ran first within a
replicate), rather than with the condition itself?

Design facts (source-verified):
  - build_schedule() (bm_b7_diagnostic.cpp) sets minimal_first = (i % 2 == 0):
    EVEN replicate index -> MINIMAL runs first, then INSTRUMENTED.
    ODD  replicate index -> INSTRUMENTED runs first, then MINIMAL.
  - Within a replicate the two conditions run as SEPARATE sequential 50-iteration
    blocks (plus 10 untimed warmups each). The CSV has no timestamps and no
    chronology column.

2x2 structure (3 replicates per cell) at the replicate level:
                     first position     second position
  MINIMAL            even replicates    odd replicates
  INSTRUMENTED       odd replicates     even replicates

Per-replicate paired delta: d[i] = median(INSTRUMENTED_i) - median(MINIMAL_i).
  d_even = INST(2nd) - MIN(1st)
  d_odd  = INST(1st) - MIN(2nd)
Difference-in-differences: DID = mean(d_even) - mean(d_odd) ~ 2 * position shift.
Condition effect ~ (mean(d_even) + mean(d_odd)) / 2.

Unit of analysis is the REPLICATE (block). The 50 iterations inside a block are
repeated measures, NOT 50 independent executions; iteration-level values are
used only inside per-replicate robust summaries.

Read-only. Does not modify any artifact. Writes results.json next to itself.
"""
import csv
import hashlib
import itertools
import json
import math
import pathlib
import statistics as st

import numpy as np

ROOT = pathlib.Path(r"E:/My Local AI")
OUT_DIR = ROOT / "work/b7_diag_20261011_paired_capture/phase53_order_effect"
OUT_DIR.mkdir(parents=True, exist_ok=True)
SEED_BASE = 20261019
N_BOOT = 20000

RUNS = [
    ("p44r1", "work/b7_diag_20261011_paired_capture/phase45_fresh_baseline/p44r1/paired_samples.csv",
     "9ade00aaeefb06878c29b06cae0727fb683a520c0937c3ae51324001c839e1bc", "A"),
    ("p44r2", "work/b7_diag_20261011_paired_capture/phase45_fresh_baseline/p44r2/paired_samples.csv",
     "6fba8677890374fa80ce6badf1bc7f144952afc07e8e9a81f7de85aea59b75aa", "A"),
    ("p44r3", "work/b7_diag_20261011_paired_capture/phase45_fresh_baseline/p44r3/paired_samples.csv",
     "90273ab3afd6785a6d10dc7a29396cd50c8f1dcf44c119cc88763236250d930c", "A"),
    ("p44r4", "work/b7_diag_20261011_paired_capture/phase45_fresh_baseline/p44r4/paired_samples.csv",
     "32d6540b01de7355fd6f34ced4db4dd0df2852a2790419dd7e63c44b87b0b541", "A"),
    ("p44r5", "work/b7_diag_20261011_paired_capture/phase45_fresh_baseline/p44r5/paired_samples.csv",
     "ddb3a92b10957118aa88516b81bd959f0f25cf75b4ffaaa26d56a6703f58fee0", "A"),
    ("p49r01", "work/b7_diag_20261011_paired_capture/phase49_single_capture/r01/paired_samples.csv",
     "5dc78fc5b1b82fdd7c5a52eb21d90572f89acb3c345ce37bfe50537dd208618b", "B"),
]

REPLICATES = 6
ITERATIONS = 50
THRESH = {"mean": 2.0, "worst": 10.0, "meddev": 2.0}


def jsonable(obj):
    if isinstance(obj, np.generic):
        return obj.item()
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    if isinstance(obj, bool):
        return bool(obj)
    if isinstance(obj, dict):
        return {k: jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [jsonable(v) for v in obj]
    if isinstance(obj, (int, float, str)) or obj is None:
        return obj
    raise TypeError(f"not jsonable: {type(obj)}")


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def load_run(path):
    rows = {}
    with open(ROOT / path, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            rows[(int(r["replicate"]), int(r["iteration"]))] = (
                float(r["minimal_sec"]), float(r["instrumented_sec"]))
    minmat = np.zeros((REPLICATES, ITERATIONS))
    instmat = np.zeros((REPLICATES, ITERATIONS))
    for rep in range(REPLICATES):
        for it in range(ITERATIONS):
            mn, ins = rows[(rep, it)]
            minmat[rep, it] = mn
            instmat[rep, it] = ins
    return minmat, instmat


def trimmed_mean(x, prop=0.10):
    x = sorted(x)
    k = int(math.floor(prop * len(x)))
    y = x[k:len(x) - k] if len(x) - 2 * k > 0 else x
    return float(sum(y) / len(y))


def frozen_metrics(minmat, instmat):
    am, ai = minmat.ravel(), instmat.ravel()
    mean_over = 100.0 * (st.fmean(ai) - st.fmean(am)) / st.fmean(am)
    med_dev = 100.0 * abs(st.median(ai) - st.median(am)) / st.median(am)
    pcts = 100.0 * (instmat - minmat) / minmat
    worst = float(pcts.max())
    return {
        "mean_overhead_pct": round(mean_over, 6),
        "mean_ok": abs(mean_over) <= THRESH["mean"],
        "worst_pct": round(worst, 6),
        "worst_ok": worst <= THRESH["worst"],
        "median_deviation_pct": round(med_dev, 6),
        "median_ok": med_dev <= THRESH["meddev"],
        "verdict": "FAIL" if not (abs(mean_over) <= THRESH["mean"] and worst <= THRESH["worst"]
                                  and med_dev <= THRESH["meddev"]) else "PASS",
    }


def robust_summary(samples_sec):
    x = [s * 1e6 for s in samples_sec]  # microseconds
    s = sorted(x)
    n = len(s)

    def q(p):
        pos = p * (n - 1)
        lo = math.floor(pos)
        hi = min(lo + 1, n - 1)
        return s[lo] + (pos - lo) * (s[hi] - s[lo])
    return {"n": n, "median_us": float(st.median(x)), "trimmed_mean_10pct_us": trimmed_mean(x),
            "p25_us": float(q(0.25)), "p75_us": float(q(0.75)),
            "iqr_us": float(q(0.75) - q(0.25)), "min_us": float(min(x)), "max_us": float(max(x))}


def exact_perm_did(d, parity):
    """Exact permutation test of the DID by parity.

    Statistic: DID = mean(d_even) - mean(d_odd). Under the null of no
    position/parity association, the 6 replicate deltas are exchangeable with
    respect to which 3 are labelled 'even'. There are C(6,3)=20 assignments.
    Two-sided p = fraction of assignments with |DID_perm| >= |DID_obs|.
    Assumptions: the per-replicate deltas are fixed measurements and parity
    labels are the only thing permuted (no iteration-level independence used).
    """
    idx = list(range(len(d)))
    even = [i for i in idx if parity[i] == 0]
    obs = float(np.mean([d[i] for i in even]) - np.mean([d[i] for i in idx if parity[i] == 1]))
    perm = []
    for comb in itertools.combinations(idx, 3):
        ce = set(comb)
        me = float(np.mean([d[i] for i in comb]))
        mo = float(np.mean([d[i] for i in idx if i not in ce]))
        perm.append(me - mo)
    perm = np.array(perm)
    ge = int((np.abs(perm) >= abs(obs) - 1e-12).sum())
    return {"did_observed_us": obs, "n_permutations": len(perm),
            "perm_min_us": float(perm.min()), "perm_max_us": float(perm.max()),
            "perm_median_us": float(np.median(perm)),
            "count_as_or_more_extreme": ge,
            "p_two_sided": ge / len(perm)}


def bootstrap_did_ci(d, parity, rng, n_boot=N_BOOT, alpha=0.05):
    even = np.array([d[i] for i in range(len(d)) if parity[i] == 0])
    odd = np.array([d[i] for i in range(len(d)) if parity[i] == 1])
    be = rng.choice(even, size=(n_boot, len(even)), replace=True).mean(axis=1)
    bo = rng.choice(odd, size=(n_boot, len(odd)), replace=True).mean(axis=1)
    did = be - bo
    lo, hi = np.percentile(did, [100 * alpha / 2, 100 * (1 - alpha / 2)])
    return {"ci95_low_us": float(lo), "ci95_high_us": float(hi),
            "boot_median_us": float(np.median(did)), "n_boot": n_boot}


def slope_of_d_on_index(d, index):
    x = np.array(index, dtype=float)
    y = np.array(d, dtype=float)
    xm, ym = x.mean(), y.mean()
    denom = ((x - xm) ** 2).sum()
    slope = float(((x - xm) * (y - ym)).sum() / denom) if denom else float("nan")
    # pearson r
    r = float(np.corrcoef(x, y)[0, 1]) if y.std() > 0 else float("nan")
    return {"slope_us_per_replicate": slope, "pearson_r_d_vs_index": r}


def main():
    results = {"script": "phase53_analysis.py", "seed_base": SEED_BASE, "n_boot": N_BOOT,
               "unit_of_analysis": "replicate (6 blocks); iterations are repeated measures",
               "thresholds": THRESH, "runs": []}

    for run_idx, (name, path, exp_hash, session) in enumerate(RUNS):
        h = sha256_file(str(ROOT / path))
        if h != exp_hash:
            raise SystemExit(f"HASH MISMATCH {name}: got {h} expected {exp_hash}")
        minmat, instmat = load_run(path)
        rec = {"run": name, "session": session, "csv_sha256_ok": True,
               "frozen": frozen_metrics(minmat, instmat)}

        # schedule / position labels
        parity = [0 if r % 2 == 0 else 1 for r in range(REPLICATES)]  # 0=even(MIN first),1=odd(INST first)
        min_med = [float(np.median(minmat[r]) * 1e6) for r in range(REPLICATES)]
        inst_med = [float(np.median(instmat[r]) * 1e6) for r in range(REPLICATES)]
        d = [inst_med[r] - min_med[r] for r in range(REPLICATES)]

        rec["schedule"] = {
            "even_indices": [0, 2, 4], "even_order": "MINIMAL then INSTRUMENTED",
            "odd_indices": [1, 3, 5], "odd_order": "INSTRUMENTED then MINIMAL",
            "source_ref": "bm_b7_diagnostic.cpp build_schedule(): minimal_first=(i%2==0)"}

        rec["replicate_level_us"] = {
            "minimal_median_us": min_med, "instrumented_median_us": inst_med, "delta_us": d,
            "parity": parity}

        # condition x position cells (descriptive pooled summaries; dependence noted)
        cells = {
            "MINIMAL_first": [minmat[r][j] for r in (0, 2, 4) for j in range(ITERATIONS)],
            "MINIMAL_second": [minmat[r][j] for r in (1, 3, 5) for j in range(ITERATIONS)],
            "INSTRUMENTED_first": [instmat[r][j] for r in (1, 3, 5) for j in range(ITERATIONS)],
            "INSTRUMENTED_second": [instmat[r][j] for r in (0, 2, 4) for j in range(ITERATIONS)],
        }
        rec["cells"] = {k: robust_summary(v) for k, v in cells.items()}

        # position effect estimated within each condition, at replicate level
        min_first = float(np.mean([min_med[r] for r in (0, 2, 4)]))
        min_second = float(np.mean([min_med[r] for r in (1, 3, 5)]))
        inst_first = float(np.mean([inst_med[r] for r in (1, 3, 5)]))
        inst_second = float(np.mean([inst_med[r] for r in (0, 2, 4)]))
        rec["position_effect_us"] = {
            "MINIMAL_second_minus_first": min_second - min_first,
            "INSTRUMENTED_second_minus_first": inst_second - inst_first,
        }
        rec["condition_effect_us"] = float(np.mean(inst_med) - np.mean(min_med))

        # within-run drift diagnostics: replicates run sequentially (index 0..5),
        # so replicate index is the run's internal time order. A drift here is a
        # confound for any parity/position contrast.
        def drift(series):
            x = np.arange(REPLICATES, dtype=float)
            y = np.array(series, dtype=float)
            xm, ym = x.mean(), y.mean()
            slope = float(((x - xm) * (y - ym)).sum() / ((x - xm) ** 2).sum())
            r = float(np.corrcoef(x, y)[0, 1]) if y.std() > 0 else float("nan")
            first3 = float(np.mean(series[:3]))
            last3 = float(np.mean(series[3:]))
            return {"slope_us_per_replicate": slope, "pearson_r_vs_index": r,
                    "mean_first3_us": first3, "mean_last3_us": last3,
                    "last3_minus_first3_us": last3 - first3,
                    "last3_over_first3": last3 / first3 if first3 else float("nan")}
        rec["within_run_drift"] = {"minimal": drift(min_med), "instrumented": drift(inst_med)}

        # DID (2x2) + exact permutation + bootstrap
        d_even = [d[r] for r in (0, 2, 4)]
        d_odd = [d[r] for r in (1, 3, 5)]
        did = float(np.mean(d_even) - np.mean(d_odd))
        perm = exact_perm_did(d, parity)
        rng = np.random.default_rng(SEED_BASE + run_idx * 1000 + 53)
        boot = bootstrap_did_ci(d, parity, rng)
        slope = slope_of_d_on_index(d, range(REPLICATES))
        rec["order_test"] = {
            "mean_delta_even_us": float(np.mean(d_even)),
            "mean_delta_odd_us": float(np.mean(d_odd)),
            "did_us": did, "did_half_us": did / 2.0,  # DID/2 estimates the position shift
            "exact_permutation": perm, "bootstrap_did": boot,
            "replicate_delta_vs_index": slope,
            "n_positive_deltas": int(sum(1 for v in d if v > 0)),
        }

        results["runs"].append(rec)
        print(f"[done] {name} (session {session})  mean={rec['frozen']['mean_overhead_pct']:+.3f}% "
              f"meddev={rec['frozen']['median_deviation_pct']:.3f}%  DID={did:+.1f}us  p_perm={perm['p_two_sided']:.3f}")

    out = OUT_DIR / "results.json"
    out.write_text(json.dumps(jsonable(results), indent=2) + "\n", encoding="utf-8")
    print("wrote", out)


if __name__ == "__main__":
    main()