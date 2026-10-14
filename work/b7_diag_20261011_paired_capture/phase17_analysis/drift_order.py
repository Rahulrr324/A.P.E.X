#!/usr/bin/env python3
"""
Phase 17 - position / warm-up / drift analysis.

Tests three competing explanations for the calibration failure:
  H-warm-up : a run-start transient makes early replicates unrepresentative
  H-order   : the counterbalanced position within a replicate biases the pair
  H-instr   : genuine instrumentation cost (the 4 steady_clock reads)

The frozen acceptance metrics are NOT modified anywhere; all subset figures
below are clearly labelled EXPLANATORY.
"""
import csv
import json
import math
import pathlib
import statistics as st

ROOT = pathlib.Path(r"E:\My Local AI")
CSV = ROOT / "work/b7_diag_20261011_paired_capture/run2/paired_samples.csv"
OUT = ROOT / "work/b7_diag_20261011_paired_capture/phase17_analysis"

rows = list(csv.DictReader(CSV.read_text(encoding="utf-8").splitlines()))
data = [(int(r["replicate"]), int(r["iteration"]), float(r["minimal_sec"]), float(r["instrumented_sec"]))
        for r in rows]
by = {}
for rep, it, a, b in data:
    by.setdefault(rep, {})[it] = (a, b)

# Counterbalanced schedule read from the run stdout (replicate 0 MINIMAL first, alternating).
minimal_first = {r: (r % 2 == 0) for r in range(6)}

res = {"note": "All subset figures are EXPLANATORY ONLY; frozen metrics unchanged."}

# ---------------------------------------------------- 1. reconstruction /series
seq = []
for r in range(6):
    order = ["MINIMAL", "INSTRUMENTED"] if minimal_first[r] else ["INSTRUMENTED", "MINIMAL"]
    for cond in order:
        vals = [by[r][i][0 if cond == "MINIMAL" else 1] for i in range(50)]
        m = st.median(vals) * 1e6
        seq.append({"block": f"rep{r}_{cond}", "replicate": r, "condition": cond,
                    "position_in_replicate": order.index(cond) + 1,
                    "median_us": round(m, 3), "mean_us": round(st.fmean(vals) * 1e6, 3),
                    "first10_mean_us": round(st.fmean(vals[:10]) * 1e6, 3),
                    "last10_mean_us": round(st.fmean(vals[-10:]) * 1e6, 3)})
res["block_series_in_execution_order"] = seq

# ------------------------------------------- 2. position effect (2nd vs 1st)
pos = []
for r in range(6):
    mf = minimal_first[r]
    first_vals = [by[r][i][0 if mf else 1] for i in range(50)]
    second_vals = [by[r][i][1 if mf else 0] for i in range(50)]
    first_med, second_med = st.median(first_vals), st.median(second_vals)
    pos.append({"replicate": r, "first_condition": "MINIMAL" if mf else "INSTRUMENTED",
                "second_condition": "INSTRUMENTED" if mf else "MINIMAL",
                "first_median_us": round(first_med * 1e6, 3), "second_median_us": round(second_med * 1e6, 3),
                "second_vs_first_pct": round(100.0 * (second_med - first_med) / first_med, 3)})
res["position_effect_second_vs_first"] = pos

mf_reps = [p for p in pos if p["first_condition"] == "MINIMAL"]
if_reps = [p for p in pos if p["first_condition"] == "INSTRUMENTED"]
res["position_summary"] = {
    "minimal_runs_first_replicates": [p["replicate"] for p in mf_reps],
    "instrumented_runs_first_replicates": [p["replicate"] for p in if_reps],
    "mean_overhead_pct_when_MINIMAL_first": round(st.fmean(
        [100.0 * (st.median([by[r][i][1] for i in range(50)]) - st.median([by[r][i][0] for i in range(50)]))
         / st.median([by[r][i][0] for i in range(50)]) for r in (0, 2, 4)]), 4),
    "mean_overhead_pct_when_INSTRUMENTED_first": round(st.fmean(
        [100.0 * (st.median([by[r][i][1] for i in range(50)]) - st.median([by[r][i][0] for i in range(50)]))
         / st.median([by[r][i][0] for i in range(50)]) for r in (1, 3, 5)]), 4),
}

# ------------------------------- 3. condition-specific position (min/ins each)
condpos = {}
for cond, idx in (("MINIMAL", 0), ("INSTRUMENTED", 1)):
    when_first = [st.median([by[r][i][idx] for i in range(50)]) * 1e6
                  for r in range(6) if (minimal_first[r] == (cond == "MINIMAL"))]
    when_second = [st.median([by[r][i][idx] for i in range(50)]) * 1e6
                   for r in range(6) if (minimal_first[r] != (cond == "MINIMAL"))]
    condpos[cond] = {"median_us_when_run_first": round(st.fmean(when_first), 2),
                     "median_us_when_run_second": round(st.fmean(when_second), 2),
                     "second_minus_first_us": round(st.fmean(when_second) - st.fmean(when_first), 2),
                     "second_vs_first_pct": round(100.0 * (st.fmean(when_second) - st.fmean(when_first)) / st.fmean(when_first), 3)}
res["condition_x_position"] = condpos

# ------------------------------------------------------- 4. within-block drift
drift = []
for r in range(6):
    for cond, idx in (("MINIMAL", 0), ("INSTRUMENTED", 1)):
        v = [by[r][i][idx] * 1e6 for i in range(50)]
        n = len(v)
        mx, my = st.fmean(range(n)), st.fmean(v)
        cov = sum((i - mx) * (v[i] - my) for i in range(n))
        vx = sum((i - mx) ** 2 for i in range(n))
        slope = cov / vx
        drift.append({"replicate": r, "condition": cond,
                      "first10_mean_us": round(st.fmean(v[:10]), 2), "last10_mean_us": round(st.fmean(v[-10:]), 2),
                      "last10_minus_first10_us": round(st.fmean(v[-10:]) - st.fmean(v[:10]), 2),
                      "slope_us_per_iteration": round(slope, 2),
                      "direction": "rising" if slope > 0 else "falling"})
res["within_block_drift"] = drift
res["blocks_rising"] = sum(1 for d in drift if d["direction"] == "rising")
res["blocks_falling"] = sum(1 for d in drift if d["direction"] == "falling")

# ------------------------------- 5. subset recomputation (EXPLANATORY ONLY)
def metrics(reps):
    A = [by[r][i][0] for r in reps for i in range(50)]
    B = [by[r][i][1] for r in reps for i in range(50)]
    ma, mb = st.fmean(A), st.fmean(B)
    dm, db = st.median(A), st.median(B)
    return {"replicates": list(reps),
            "mean_overhead_pct": round(100.0 * (mb - ma) / ma, 4),
            "worst_case_overhead_pct": round(max(100.0 * (b - a) / a for a, b in zip(A, B)), 4),
            "median_deviation_pct": round(100.0 * abs(db - dm) / dm, 4)}
res["subset_metrics_explanatory_only"] = [
    {"label": "ALL 6 replicates (the frozen metric basis)", **metrics(range(6))},
    {"label": "replicates 0-2 only (early run)", **metrics([0, 1, 2])},
    {"label": "replicates 3-5 only (later run)", **metrics([3, 4, 5])},
    {"label": "replicate 0 excluded", **metrics([1, 2, 3, 4, 5])},
    {"label": "replicates 0 and 2 excluded", **metrics([1, 3, 4, 5])},
    {"label": "same-position pairs only: even reps (min first)", **metrics([0, 2, 4])},
    {"label": "same-position pairs only: odd reps (ins first)", **metrics([1, 3, 5])},
]

# 6. interpretation checks
ins_first_overhead = res["position_summary"]["mean_overhead_pct_when_MINIMAL_first"]
ins_second = res["position_summary"]["mean_overhead_pct_when_INSTRUMENTED_first"]
res["order_hypothesis_test"] = {
    "prediction": "if the SECOND condition in a replicate is penalised, MINIMAL-first reps should show "
                  "inflated apparent overhead and INSTRUMENTED-first reps should show understated apparent overhead",
    "observed_minimal_first_mean_overhead_pct": ins_first_overhead,
    "observed_instrumented_first_mean_overhead_pct": ins_second,
    "consistent_with_prediction": ins_first_overhead > ins_second,
    "note": "association only - the design cannot separate position from elapsed time",
}

(OUT / "02_drift_order.json").write_text(json.dumps(res, indent=2), encoding="utf-8")

# --------------------------------------------------------------------- print
print("=" * 100)
print("PHASE 17 - POSITION / WARM-UP / DRIFT ANALYSIS")
print("=" * 100)
print("\n--- 12 blocks in reconstructed execution order ---")
print(f"  {'block':<22}{'median_us':>12}{'mean_us':>12}{'first10_us':>12}{'last10_us':>12}")
for s in seq:
    print(f"  {s['block']:<22}{s['median_us']:>12.2f}{s['mean_us']:>12.2f}{s['first10_mean_us']:>12.2f}{s['last10_mean_us']:>12.2f}")

print("\n--- position effect within each replicate (2nd median vs 1st median) ---")
print(f"  {'rep':>3} {'1st cond':<14}{'2nd cond':<14}{'1st_us':>10}{'2nd_us':>10}{'2nd vs 1st %':>14}")
for p in pos:
    print(f"  {p['replicate']:>3} {p['first_condition']:<14}{p['second_condition']:<14}"
          f"{p['first_median_us']:>10.2f}{p['second_median_us']:>10.2f}{p['second_vs_first_pct']:>14.3f}")

print("\n--- condition x position (median us) ---")
for k, v in condpos.items():
    print(f"  {k:<14} first={v['median_us_when_run_first']:>10.2f}  second={v['median_us_when_run_second']:>10.2f}"
          f"  delta={v['second_minus_first_us']:>+9.2f} us ({v['second_vs_first_pct']:+.3f} %)")

print("\n--- order-hypothesis test ---")
for k, v in res["order_hypothesis_test"].items():
    print(f"  {k}: {v}")

print("\n--- within-block drift (is time rising or falling across the 50-iteration loop?) ---")
print(f"  {'rep':>3} {'cond':<14}{'first10_us':>12}{'last10_us':>12}{'last-first':>12}{'slope us/it':>14}  dir")
for d in drift:
    print(f"  {d['replicate']:>3} {d['condition']:<14}{d['first10_mean_us']:>12.2f}{d['last10_mean_us']:>12.2f}"
          f"{d['last10_minus_first10_us']:>+12.2f}{d['slope_us_per_iteration']:>14.2f}  {d['direction']}")
print(f"  rising blocks: {res['blocks_rising']}   falling blocks: {res['blocks_falling']}")

print("\n--- SUBSET METRICS (EXPLANATORY ONLY - frozen metric NOT replaced) ---")
print(f"  {'subset':<52}{'mean%':>10}{'worst%':>11}{'meddev%':>10}   {'all<=thr?':>10}")
for m in res["subset_metrics_explanatory_only"]:
    ok = (abs(m['mean_overhead_pct']) <= 2 and m['worst_case_overhead_pct'] <= 10 and m['median_deviation_pct'] <= 2)
    print(f"  {m['label']:<52}{m['mean_overhead_pct']:>10.4f}{m['worst_case_overhead_pct']:>11.4f}"
          f"{m['median_deviation_pct']:>10.4f}   {'YES' if ok else 'no':>10}")
print("=" * 100)
