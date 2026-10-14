#!/usr/bin/env python3
"""
Phase 18 - read-only timing-trajectory and residual-tail investigation.

Recomputes the frozen metrics from the CSV alone (must reproduce the reported
8.5506 / 109.0882 / 2.1161) and then characterises:

  * the per-block timing trajectory (12 blocks x 50 iterations, in execution order)
  * the within-block ramp (first decile vs last decile)
  * where the >10% pairs sit in the iteration loop
  * the residual tail in replicates 3-5 (the frozen worst-case still fails there)
  * the negative (instrumented-faster) pairs

Frozen formulas, reproduced verbatim and NOT altered:
  mean_overhead_pct       = 100*(meanB - meanA)/meanA              pooled, all pairs
  worst_case_overhead_pct = max_j 100*(B_j - A_j)/A_j              signed, unclamped
  median_deviation_pct    = 100*|medianB - medianA|/medianA        pooled
Thresholds: 2.0 / 10.0 / 2.0  (unchanged)

Read-only: writes only into phase18_analysis/.
"""
import csv
import json
import math
import pathlib
import statistics as st

ROOT = pathlib.Path(r"E:\My Local AI")
CSV = ROOT / "work/b7_diag_20261011_paired_capture/run2/paired_samples.csv"
OUT = ROOT / "work/b7_diag_20261011_paired_capture/phase18_analysis"
OUT.mkdir(parents=True, exist_ok=True)

T_MEAN, T_WORST, T_MEDDEV = 2.0, 10.0, 2.0
REPORTED = {"mean_overhead_pct": 8.5506, "worst_case_overhead_pct": 109.0882, "median_deviation_pct": 2.1161}

# ---- order is counterbalanced: even replicate index runs MINIMAL first ----
# Source: build_schedule(), bm_b7_diagnostic.cpp line 690: ScheduleEntry{i, (i % 2u) == 0u}
def minimal_first(rep):
    return rep % 2 == 0

rows = list(csv.DictReader(CSV.read_text(encoding="utf-8").splitlines()))
by = {}
for r in rows:
    by.setdefault(int(r["replicate"]), {})[int(r["iteration"])] = (
        float(r["minimal_sec"]), float(r["instrumented_sec"]), float(r["signed_overhead_pct"]))

REPS = sorted(by)
MIN = {r: [by[r][i][0] for i in sorted(by[r])] for r in REPS}
INS = {r: [by[r][i][1] for i in sorted(by[r])] for r in REPS}
PCT = {r: [by[r][i][2] for i in sorted(by[r])] for r in REPS}

res = {"csv": str(CSV), "replicates": REPS,
       "order_per_replicate": {r: ("MINIMAL first" if minimal_first(r) else "INSTRUMENTED first") for r in REPS}}

# ------------------------------------------------------- 1. frozen metrics
A = [a for r in REPS for a in MIN[r]]
B = [b for r in REPS for b in INS[r]]
mean_a, mean_b = st.fmean(A), st.fmean(B)
frozen = {
    "mean_overhead_pct": 100.0 * (mean_b - mean_a) / mean_a,
    "worst_case_overhead_pct": max(100.0 * (b - a) / a for a, b in zip(A, B)),
    "median_deviation_pct": 100.0 * abs(st.median(B) - st.median(A)) / st.median(A),
}
res["frozen_recomputed"] = {k: round(v, 6) for k, v in frozen.items()}
res["frozen_matches_reported"] = {
    k: {"recomputed": round(frozen[k], 4), "reported": REPORTED[k],
        "ok": abs(frozen[k] - REPORTED[k]) < 0.0002} for k in frozen}
res["frozen_verdict"] = {
    "mean": "NOT OK" if abs(frozen["mean_overhead_pct"]) > T_MEAN else "OK",
    "worst": "NOT OK" if frozen["worst_case_overhead_pct"] > T_WORST else "OK",
    "median_dev": "NOT OK" if frozen["median_deviation_pct"] > T_MEDDEV else "OK",
    "calibration": "PASS" if (abs(frozen["mean_overhead_pct"]) <= T_MEAN
                              and frozen["worst_case_overhead_pct"] <= T_WORST
                              and frozen["median_deviation_pct"] <= T_MEDDEV) else "FAIL",
}

# --------------------------------- 2. 12 blocks in execution order + trajectory
def blocks():
    out = []
    for r in REPS:
        order = ["MINIMAL", "INSTRUMENTED"] if minimal_first(r) else ["INSTRUMENTED", "MINIMAL"]
        for pos, cond in enumerate(order, start=1):
            out.append({"rep": r, "cond": cond, "position": pos,
                        "vals_us": [(MIN if cond == "MINIMAL" else INS)[r][i] * 1e6 for i in range(50)]})
    return out

bl = blocks()
for gi, b in enumerate(bl):
    b["global_block_index"] = gi
    b["median_us"] = round(st.median(b["vals_us"]), 2)
    b["mean_us"] = round(st.fmean(b["vals_us"]), 2)
    # 5 decile bins
    b["deciles_us"] = [round(st.fmean(b["vals_us"][k * 10:(k + 1) * 10]), 2) for k in range(5)]
    b["first5_us"] = round(st.fmean(b["vals_us"][:5]), 2)
    v = b["vals_us"]
    n = len(v); mx = st.fmean(range(n)); my = st.fmean(v)
    b["slope_us_per_iter"] = round(sum((i - mx) * (v[i] - my) for i in range(n)) / sum((i - mx) ** 2 for i in range(n)), 2)
    b["ramp_last10_minus_first10_us"] = round(st.fmean(v[-10:]) - st.fmean(v[:10]), 2)
    b["direction"] = "rising" if b["slope_us_per_iter"] > 5 else ("falling" if b["slope_us_per_iter"] < -5 else "flat")
res["blocks_in_execution_order"] = bl

res["ramps"] = {
    "rising_blocks": [f"rep{b['rep']}_{b['cond']}" for b in bl if b["direction"] == "rising"],
    "falling_blocks": [f"rep{b['rep']}_{b['cond']}" for b in bl if b["direction"] == "falling"],
    "flat_blocks": [f"rep{b['rep']}_{b['cond']}" for b in bl if b["direction"] == "flat"],
    "largest_ramp": max(bl, key=lambda b: b["ramp_last10_minus_first10_us"])["rep"],
    "note": "slope threshold +/-5 us/iteration used to label a block as rising/falling",
}

# --------------------------------------------- 3. where do the >10% pairs sit?
pairs = [{"rep": r, "iter": i, "min_us": MIN[r][i] * 1e6, "ins_us": INS[r][i] * 1e6, "pct": PCT[r][i]}
         for r in REPS for i in range(50)]
over10 = [p for p in pairs if p["pct"] > 10.0]
over10_by_iter = {i: sum(1 for p in over10 if p["iter"] == i) for i in range(50)}
res["tail_location"] = {
    "n_over_10pct": len(over10),
    "uniform_expectation_per_iteration_index": round(len(over10) / 50.0, 3),
    "count_by_iteration_index": over10_by_iter,
    "count_by_iteration_decile": [sum(over10_by_iter[i] for i in range(k * 10, (k + 1) * 10)) for k in range(5)],
    "count_by_replicate": {r: sum(1 for p in over10 if p["rep"] == r) for r in REPS},
    "iterations_0_to_4_count": sum(over10_by_iter[i] for i in range(5)),
    "iterations_45_to_49_count": sum(over10_by_iter[i] for i in range(45, 50)),
}
res["negatives"] = {
    "n_negative": sum(1 for p in pairs if p["pct"] < 0),
    "by_replicate": {r: sum(1 for p in pairs if p["rep"] == r and p["pct"] < 0) for r in REPS},
    "by_iteration_decile": [sum(1 for p in pairs if p["pct"] < 0 and k * 10 <= p["iter"] < (k + 1) * 10) for k in range(5)],
    "most_negative": sorted(pairs, key=lambda p: p["pct"])[:5],
}

# ------------------------------------- 4. residual tail in replicates 3-5 only
late = [p for p in over10 if p["rep"] in (3, 4, 5)]
res["residual_tail_reps_3_5"] = {
    "n_pairs_over_10pct": len(late),
    "pairs": sorted(late, key=lambda p: -p["pct"]),
    "max_pct": round(max(p["pct"] for p in late), 4) if late else None,
    "by_replicate": {r: sum(1 for p in late if p["rep"] == r) for r in (3, 4, 5)},
    "by_iteration_index": {p["iter"]: round(p["pct"], 3) for p in sorted(late, key=lambda p: p["iter"])},
    "iteration_range": [min(p["iter"] for p in late), max(p["iter"] for p in late)] if late else None,
}
# how much of the frozen worst-case comes from early vs late replicates
worst_pair = max(pairs, key=lambda p: p["pct"])
res["worst_pair"] = worst_pair
res["worst_case_decomposition_history"] = {
    "1st": sorted(pairs, key=lambda p: -p["pct"])[0]["pct"],
    "2nd": sorted(pairs, key=lambda p: -p["pct"])[1]["pct"],
    "3rd": sorted(pairs, key=lambda p: -p["pct"])[2]["pct"],
    "worst_in_reps_3_5": res["residual_tail_reps_3_5"]["max_pct"],
}

(OUT / "01_trajectory_tail.json").write_text(json.dumps(res, indent=2), encoding="utf-8")

# ------------------------------------------------------------------- print
print("=" * 104)
print("PHASE 18 - FROZEN METRIC RECOMPUTATION (must reproduce the reported values)")
print("=" * 104)
for k, v in res["frozen_matches_reported"].items():
    print(f"  {k:<26} recomputed={v['recomputed']:<12} reported={v['reported']:<10} {'MATCH' if v['ok'] else 'MISMATCH'}")
print(f"  frozen calibration verdict: {res['frozen_verdict']['calibration']}")

print("\n" + "=" * 104)
print("12 BLOCKS IN EXECUTION ORDER (us); deciles D1..D5 each 10 iterations")
print("=" * 104)
print(f"  {'#':>2} {'block':<20} {'pos':>3} {'median':>10} {'mean':>10} {'D1':>9} {'D2':>9} {'D3':>9} {'D4':>9} {'D5':>9} {'slope':>8}  dir")
for b in bl:
    print(f"  {b['global_block_index']:>2} {'rep'+str(b['rep'])+'_'+b['cond']:<20} {b['position']:>3}"
          f" {b['median_us']:>10.1f} {b['mean_us']:>10.1f} " + " ".join(f"{d:>9.1f}" for d in b["deciles_us"])
          + f" {b['slope_us_per_iter']:>8.1f}  {b['direction']}")
print(f"  rising: {res['ramps']['rising_blocks']}")
print(f"  falling: {res['ramps']['falling_blocks']}")
print(f"  flat: {res['ramps']['flat_blocks']}")

print("\n" + "=" * 104)
print("WHERE THE >10% PAIRS SIT")
print("=" * 104)
t = res["tail_location"]
print(f"  total >10%: {t['n_over_10pct']}   uniform expectation per iteration index: {t['uniform_expectation_per_iteration_index']}")
print(f"  by iteration decile (0-9,10-19,...): {t['count_by_iteration_decile']}")
print(f"  iterations 0-4 total: {t['iterations_0_to_4_count']}   iterations 45-49 total: {t['iterations_45_to_49_count']}")
print(f"  by replicate: {t['count_by_replicate']}")
print("  count by iteration index (0..49):")
print("   ", t["count_by_iteration_index"])

print("\n" + "=" * 104)
print("NEGATIVE PAIRS (instrumented faster than its minimal partner)")
print("=" * 104)
n = res["negatives"]
print(f"  n={n['n_negative']}  by replicate={n['by_replicate']}  by decile={n['by_iteration_decile']}")
for p in n["most_negative"]:
    print(f"    rep{p['rep']} iter{p['iter']:>2}  {p['min_us']:>9.1f} -> {p['ins_us']:>9.1f} us   {p['pct']:>9.3f} %")

print("\n" + "=" * 104)
print("RESIDUAL TAIL IN REPLICATES 3-5 (frozen worst-case still fails here)")
print("=" * 104)
r = res["residual_tail_reps_3_5"]
print(f"  pairs >10%: {r['n_pairs_over_10pct']}   max: {r['max_pct']} %   by replicate: {r['by_replicate']}")
print(f"  iteration range: {r['iteration_range']}")
print(f"  {'rep':>3} {'iter':>4} {'minimal us':>11} {'instrumented us':>16} {'overhead %':>11}")
for p in r["pairs"]:
    print(f"  {p['rep']:>3} {p['iter']:>4} {p['min_us']:>11.1f} {p['ins_us']:>16.1f} {p['pct']:>11.3f}")
print(f"\n  worst pair overall: rep{worst_pair['rep']} iter{worst_pair['iter']}  {worst_pair['pct']:.4f} %")
print(f"  top3 = {res['worst_case_decomposition_history']['1st']:.4f}, "
      f"{res['worst_case_decomposition_history']['2nd']:.4f}, "
      f"{res['worst_case_decomposition_history']['3rd']:.4f}")
print("=" * 104)
