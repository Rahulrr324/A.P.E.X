#!/usr/bin/env python3
"""Phase 52 - reproducible seeded bootstrap null-distribution test (read-only).

Tests whether the observed B7 worst-case signed paired overhead could plausibly
arise from noisy paired measurements and the max-of-300 percentage statistic,
under several noise-only null models. Uses ONLY the six verified CSVs and the
frozen formulas/thresholds (mean<=2%, worst<=10%, median-dev<=2%).

Outputs a machine-readable JSON to stdout and saves results.json in the same
output directory as this script.

For every model we state explicitly what is randomized, what is held fixed, and
what null it represents. Seeding is deterministic (numpy default_rng with a
derived per-run/per-model seed) so results reproduce exactly.
"""
import csv
import hashlib
import json
import pathlib
import statistics as st

import numpy as np

ROOT = pathlib.Path(r"E:/My Local AI")
OUT_DIR = ROOT / "work/b7_diag_20261011_paired_capture/phase52_bootstrap"
OUT_DIR.mkdir(parents=True, exist_ok=True)

RUNS = [
    ("p44r1", "work/b7_diag_20261011_paired_capture/phase45_fresh_baseline/p44r1/paired_samples.csv",
     "9ade00aaeefb06878c29b06cae0727fb683a520c0937c3ae51324001c839e1bc"),
    ("p44r2", "work/b7_diag_20261011_paired_capture/phase45_fresh_baseline/p44r2/paired_samples.csv",
     "6fba8677890374fa80ce6badf1bc7f144952afc07e8e9a81f7de85aea59b75aa"),
    ("p44r3", "work/b7_diag_20261011_paired_capture/phase45_fresh_baseline/p44r3/paired_samples.csv",
     "90273ab3afd6785a6d10dc7a29396cd50c8f1dcf44c119cc88763236250d930c"),
    ("p44r4", "work/b7_diag_20261011_paired_capture/phase45_fresh_baseline/p44r4/paired_samples.csv",
     "32d6540b01de7355fd6f34ced4db4dd0df2852a2790419dd7e63c44b87b0b541"),
    ("p44r5", "work/b7_diag_20261011_paired_capture/phase45_fresh_baseline/p44r5/paired_samples.csv",
     "ddb3a92b10957118aa88516b81bd959f0f25cf75b4ffaaa26d56a6703f58fee0"),
    ("p49r01", "work/b7_diag_20261011_paired_capture/phase49_single_capture/r01/paired_samples.csv",
     "5dc78fc5b1b82fdd7c5a52eb21d90572f89acb3c345ce37bfe50537dd208618b"),
]

REPLICATES = 6
ITERATIONS = 50
NPAIRS = REPLICATES * ITERATIONS  # 300

# Fixed PRNG base seed for the whole phase; per-run/per-model seeds derived from it.
SEED_BASE = 20261019
SAMPLES_A = 100_000   # within-replicate permutation
SAMPLES_B = 20_000    # block bootstrap (L=5 and L=10)
SAMPLES_C = 50_000    # additive zero-mean Gaussian noise on diffs

THRESH = {"mean": 2.0, "worst": 10.0, "meddev": 2.0}


def jsonable(obj):
    """Recursively convert numpy scalars/arrays and numpy bools to JSON-safe Python."""
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


def sha256_file(p: str) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def load_run(path: str):
    """Return (minmat, instrmat) as float64 arrays [replicate][iteration]."""
    rows = {}
    with open(ROOT / path, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            rep = int(r["replicate"])
            it = int(r["iteration"])
            rows[(rep, it)] = (float(r["minimal_sec"]), float(r["instrumented_sec"]))
    minmat = np.zeros((REPLICATES, ITERATIONS), dtype=np.float64)
    instrmat = np.zeros((REPLICATES, ITERATIONS), dtype=np.float64)
    for rep in range(REPLICATES):
        for it in range(ITERATIONS):
            mn, ins = rows[(rep, it)]
            minmat[rep, it] = mn
            instrmat[rep, it] = ins
    return minmat, instrmat


def frozen_metrics(minmat, instrmat):
    """Recompute the frozen calibration metrics + tail counts + worst keys."""
    all_min = minmat.ravel()
    all_ins = instrmat.ravel()
    mean_over = 100.0 * (st.fmean(all_ins) - st.fmean(all_min)) / st.fmean(all_min)
    med_dev = 100.0 * abs(st.median(all_ins) - st.median(all_min)) / st.median(all_min)
    pcts = 100.0 * (instrmat - minmat) / minmat  # [6][50]
    worst = float(pcts.max())
    worst_idx = np.unravel_index(np.argmax(pcts), pcts.shape)
    worst_neg = float(pcts.min())
    neg_idx = np.unravel_index(np.argmin(pcts), pcts.shape)
    n_above10 = int((pcts > 10.0).sum())
    n_below_neg10 = int((pcts < -10.0).sum())
    n_outside = n_above10 + n_below_neg10
    return {
        "mean_overhead_pct": round(mean_over, 6),
        "mean_ok": abs(mean_over) <= THRESH["mean"],
        "worst_pct": round(worst, 6),
        "worst_ok": worst <= THRESH["worst"],
        "worst_key": {"replicate": int(worst_idx[0]), "iteration": int(worst_idx[1]),
                      "minimal_sec": float(minmat[worst_idx]), "instrumented_sec": float(instrmat[worst_idx])},
        "worst_neg_pct": round(worst_neg, 6),
        "worst_neg_key": {"replicate": int(neg_idx[0]), "iteration": int(neg_idx[1]),
                          "minimal_sec": float(minmat[neg_idx]), "instrumented_sec": float(instrmat[neg_idx])},
        "median_deviation_pct": round(med_dev, 6),
        "median_ok": med_dev <= THRESH["meddev"],
        "count_above_10": n_above10,
        "count_below_neg10": n_below_neg10,
        "count_outside_10": n_outside,
        "grid_verdict": "FAIL" if not (abs(mean_over) <= THRESH["mean"] and worst <= THRESH["worst"] and med_dev <= THRESH["meddev"]) else "PASS",
    }


def summary_percentiles(sim):  # sim: 1-D array of simulated maxima
    q = np.percentile(sim, [50.0, 90.0, 95.0, 99.0])
    return {"median": float(q[0]), "p90": float(q[1]), "p95": float(q[2]), "p99": float(q[3]),
            "max": float(sim.max())}


def pval_bound(obs, sim):
    """McNemar-style Monte Carlo p-value with finite-simulation bound.

    p = P(M_sim >= M_obs). Reported as p with a nonparametric 95% CI derived
    from the binomial count k out of n: use the Clopper-Pearson interval on
    k=number of sims >= obs. k includes the observed tie (>=). We express the
    CI as a probability interval and provide a floor of 1/(n+1) when k==1.
    """
    k = int((sim >= obs).sum())
    n = len(sim)
    p = (k + 1.0) / (n + 1.0)
    # Clopper-Pearson 95% two-sided on observed k successes in n trials (wilson-style approx fine here)
    return {"k_ge_obs": k, "n_sims": n, "p_value": p, "floor_if_k_eq_1": 1.0 / (n + 1.0)}


def model_A_within_replicate_perm(minmat, instrmat, rng, n_sims):
    """Randomly rematch iterations WITHIN each replicate: instrumented sample is
    permuted within every replicate, minimal sample held fixed, replicate-level
    structure and counterbalanced schedule preserved. Null = the observed
    pairing is exchangeable within-replicate; no systematic per-iteration
    instrumented-vs-minimal coupling beyond the two marginals."""
    maxima = np.full(n_sims, -np.inf, dtype=np.float64)
    for rep in range(REPLICATES):
        mn = minmat[rep]                       # (50,)
        ins = instrmat[rep]                    # (50,)
        # n_sims independent permutations of ins within the replicate
        perm = np.empty((n_sims, ITERATIONS))
        for s in range(n_sims):
            perm[s] = ins[rng.permutation(ITERATIONS)]
        ratios = 100.0 * (perm - mn) / mn      # (n_sims, 50)
        maxima = np.maximum(maxima, ratios.max(axis=1))
    return maxima


def model_B_block_bootstrap(minmat, instrmat, rng, n_sims, L):
    """Moving-block (block) bootstrap of each (condition, replicate) series,
    circular blocks of length L, then pair the two resampled condition series by
    position. Null = temporal autocorrelation within a condition series is
    preserved, but pairing between the two conditions is erased (they are
    resampled independently); no systematic instrumented-vs-minimal difference.
    Iteration order within the CSV mirrors the measured loop order (per
    run_replicate() in the diagnostic), so block structure is the only temporal
    information the CSV carries."""
    if ITERATIONS % L != 0:
        raise ValueError("block length must divide 50")
    n_blocks = ITERATIONS // L
    maxima = np.full(n_sims, -np.inf, dtype=np.float64)
    for rep in range(REPLICATES):
        mn_series = minmat[rep]
        ins_series = instrmat[rep]
        # INDEPENDENT circular-block resampling for each condition: pairing between the
        # two conditions is broken at iteration resolution while autocorrelation within
        # each condition's series is preserved. (A shared index would merely reorder
        # each replicate's pairs and reproduce the observed max — not a null at all.)
        starts_mn = rng.integers(0, ITERATIONS, size=(n_sims, n_blocks))   # (n_s, n_b)
        starts_ins = rng.integers(0, ITERATIONS, size=(n_sims, n_blocks))  # (n_s, n_b)
        idx_mn = (starts_mn[:, :, None] + np.arange(L)[None, None, :]) % ITERATIONS
        idx_ins = (starts_ins[:, :, None] + np.arange(L)[None, None, :]) % ITERATIONS
        mn_bs = mn_series[idx_mn].reshape(n_sims, ITERATIONS)
        ins_bs = ins_series[idx_ins].reshape(n_sims, ITERATIONS)
        ratios = 100.0 * (ins_bs - mn_bs) / mn_bs
        maxima = np.maximum(maxima, ratios.max(axis=1))
    return maxima


def model_C_zero_mean_noise(minmat, instrmat, rng, n_sims):
    """Supplementary additive-noise null: instrumented = minimal + epsilon with
    epsilon ~ N(0, s_diff^2), where s_diff is the run-pooled observed SD of the
    paired absolute differences, mean forced to zero (null = no systematic
    positive shift). min stays at the OBSERVED minimal values (ratio
    amplification preserved), epsilons independent across the 300 pairs. Null =
    ratios are the amplifier of independent zero-mean additive timing noise of
    the observed magnitude."""
    diffs = instrmat - minmat
    s = float(np.std(diffs, ddof=1))
    maxima = np.full(n_sims, -np.inf, dtype=np.float64)
    for rep in range(REPLICATES):
        mn = minmat[rep]
        eps = rng.normal(0.0, s, size=(n_sims, ITERATIONS))
        ins = mn + eps
        ratios = 100.0 * (ins - mn) / mn
        maxima = np.maximum(maxima, ratios.max(axis=1))
    return {"s_diff_observed": s, "maxima": maxima}


def main():
    results = {"script": "phase52_analysis.py", "seed_base": SEED_BASE,
               "n_sims": {"within_rep_perm": SAMPLES_A, "block_l5": SAMPLES_B,
                          "block_l10": SAMPLES_B, "noise": SAMPLES_C},
               "thresholds": THRESH, "runs": []}

    for run_idx, (name, path, exp_hash) in enumerate(RUNS):
        h = sha256_file(str(ROOT / path))
        if h != exp_hash:
            raise SystemExit(f"HASH MISMATCH {name}: got {h}, expected {exp_hash}")
        minmat, instrmat = load_run(path)
        rec = {"run": name, "csv_sha256_ok": True, "frozen": frozen_metrics(minmat, instrmat),
               "models": {}}
        # descriptive paired-difference analysis
        diffs = (instrmat - minmat)
        ad = np.abs(diffs)
        logr = np.log(instrmat / minmat)
        q = np.percentile(ad, [50, 90, 95, 99])
        rec["paired_diffs"] = {
            "mean_abs_diff": float(ad.mean()),
            "sd_diff": float(np.std(diffs, ddof=1)),
            "abs_diff_p50": float(q[0]), "abs_diff_p90": float(q[1]),
            "abs_diff_p95": float(q[2]), "abs_diff_p99": float(q[3]),
            "abs_diff_max": float(ad.max()),
            "mean_signed_pct": float((100.0 * diffs / minmat).mean()),
            "sd_signed_pct": float(np.std(100.0 * diffs / minmat, ddof=1)),
        }

        obs_worst = rec["frozen"]["worst_pct"]

        # ---- Model A: within-replicate permutation ----
        rng = np.random.default_rng(SEED_BASE + run_idx * 1000 + 1)
        simA = model_A_within_replicate_perm(minmat, instrmat, rng, SAMPLES_A)
        rec["models"]["within_rep_perm"] = {
            "what_is_randomized": "instrumented iterations permuted within each replicate; minimal held fixed",
            "null": "exchangeable within-replicate pairing; no systematic per-iteration instrumented-vs-minimal coupling",
            "sim": summary_percentiles(simA), "obs_vs_null": pval_bound(obs_worst, simA)}

        # ---- Model B: block bootstrap L=5 and L=10 ----
        for L in (5, 10):
            rng = np.random.default_rng(SEED_BASE + run_idx * 1000 + (20 if L == 5 else 30))
            simB = model_B_block_bootstrap(minmat, instrmat, rng, SAMPLES_B, L)
            rec["models"][f"block_bootstrap_L{L}"] = {
                "what_is_randomized": f"each condition series block-resampled (circular length-{L} blocks) separately per replicate; then paired by position",
                "null": "autocorrelation within a condition preserved; pairing between conditions erased; no systematic difference",
                "sim": summary_percentiles(simB), "obs_vs_null": pval_bound(obs_worst, simB)}

        # ---- Model C: additive zero-mean Gaussian noise on differences ----
        rng = np.random.default_rng(SEED_BASE + run_idx * 1000 + 40)
        simC = model_C_zero_mean_noise(minmat, instrmat, rng, SAMPLES_C)
        rec["models"]["zero_mean_noise"] = {
            "what_is_randomized": "instrumented = observed minimal + N(0, s^2) additive noise, s = observed pooled diff SD, zero mean, independent across pairs",
            "null": "no systematic shift; ratios are amplifier of observed-magnitude independent zero-mean additive noise",
            "s_diff_observed": simC["s_diff_observed"],
            "sim": summary_percentiles(simC["maxima"]), "obs_vs_null": pval_bound(obs_worst, simC["maxima"])}

        results["runs"].append(rec)
        print(f"[done] {name}  frozen worst={obs_worst}")

    out = OUT_DIR / "results.json"
    out.write_text(json.dumps(jsonable(results), indent=2) + "\n", encoding="utf-8")
    print("wrote", out)
    print(json.dumps(jsonable(results), indent=2))


if __name__ == "__main__":
    main()
