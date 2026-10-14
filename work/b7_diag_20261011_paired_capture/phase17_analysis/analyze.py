#!/usr/bin/env python3
"""
Phase 17 - independent analysis of the B7 paired_samples.csv.

Recomputes every frozen metric from the CSV bytes alone (no reuse of the
diagnostic's own stdout numbers), characterises the distribution, locates the
extremes, and contrasts the three frozen formulas against plausible alternative
statistics - WITHOUT changing the frozen acceptance criteria.

Read-only with respect to all evidence: writes only into phase17_analysis/.
"""
import csv
import hashlib
import json
import math
import pathlib
import statistics as st

ROOT = pathlib.Path(r"E:\My Local AI")
CSV = ROOT / "work/b7_diag_20261011_paired_capture/run2/paired_samples.csv"
OUT = ROOT / "work/b7_diag_20261011_paired_capture/phase17_analysis"
OUT.mkdir(parents=True, exist_ok=True)

# Frozen thresholds - referenced only for the verdict, never altered.
T_MEAN, T_WORST, T_MEDDEV = 2.0, 10.0, 2.0
REPORTED = {"mean_overhead_pct": 8.5506, "worst_case_overhead_pct": 109.0882, "median_deviation_pct": 2.1161}

raw = CSV.read_bytes()
text = raw.decode("utf-8")
lines = text.splitlines()
res = {"csv": str(CSV), "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw),
       "line_ending_crlf": b"\r\n" in raw, "line_count": len(lines)}


def pct(a, b):                       # frozen per-pair formula
    return 100.0 * (b - a) / a


def q(sorted_vals, p):
    """Same linear-interpolation percentile convention the diagnostic's
    summarize()/median helper uses (pos = p*(n-1), interpolate)."""
    n = len(sorted_vals)
    if n == 1:
        return sorted_vals[0]
    pos = p * (n - 1)
    lo = int(math.floor(pos))
    hi = min(lo + 1, n - 1)
    frac = pos - lo
    return sorted_vals[lo] + frac * (sorted_vals[hi] - sorted_vals[lo])


# ---------------------------------------------------------------- parse & scan
rows = list(csv.DictReader(text.splitlines()))
header = next(csv.reader(text.splitlines()))
anomalies = {"malformed_field_counts": [], "non_finite": [], "zero_minimal": [], "zero_instrumented": [],
             "negative_times": [], "duplicate_keys": [], "formula_inconsistent": [],
             "out_of_range_replicate": [], "out_of_range_iteration": []}

mins, inss, pcts, keys = [], [], [], []
formula_devs = []
seen = set()
for i, r in enumerate(rows):
    try:
        a, b, p = float(r["minimal_sec"]), float(r["instrumented_sec"]), float(r["signed_overhead_pct"])
        rep, it = int(r["replicate"]), int(r["iteration"])
    except (KeyError, ValueError, TypeError) as e:
        anomalies["malformed_field_counts"].append({"row": i + 2, "error": str(e)})
        continue
    if len(r) != 5 or any(v is None for v in r.values()):
        anomalies["malformed_field_counts"].append({"row": i + 2, "dict": r})
    if not all(math.isfinite(v) for v in (a, b, p)):
        anomalies["non_finite"].append({"row": i + 2, "a": r["minimal_sec"], "b": r["instrumented_sec"], "p": r["signed_overhead_pct"]})
    if a == 0.0:
        anomalies["zero_minimal"].append(i + 2)
    if b == 0.0:
        anomalies["zero_instrumented"].append(i + 2)
    if a < 0 or b < 0:
        anomalies["negative_times"].append(i + 2)
    if not (0 <= rep <= 5):
        anomalies["out_of_range_replicate"].append(rep)
    if not (0 <= it <= 49):
        anomalies["out_of_range_iteration"].append(it)
    k = (rep, it)
    if k in seen:
        anomalies["duplicate_keys"].append(k)
    seen.add(k)
    # Tolerance: the CSV serialises with "%#.9g" (9 significant digits), so a
    # recomputation from the *stored* fields cannot reproduce the value the
    # diagnostic computed from full-precision doubles better than ~1e-8
    # relative. 1e-6 relative is ~100x above the observed max deviation
    # (4.7e-09) and still ~4 orders of magnitude tighter than any real defect.
    if a > 0:
        dev = abs(p - pct(a, b))
        formula_devs.append(dev)
        if dev > 1e-6 * max(1.0, abs(p)):
            anomalies["formula_inconsistent"].append({"row": i + 2, "stored": p, "recomputed": pct(a, b)})
    mins.append(a); inss.append(b); pcts.append(p); keys.append(k)

res["parsed_rows"] = len(rows)
res["pair_keys_unique"] = len(seen)
res["anomalies"] = anomalies
res["anomaly_total"] = sum(len(v) for v in anomalies.values())
res["formula_tolerance"] = "1e-6 relative (CSV serialises to %#.9g = 9 significant digits)"
res["formula_max_abs_deviation_pct"] = max(formula_devs) if formula_devs else None
res["formula_max_rel_deviation"] = (max(d / max(1.0, abs(p)) for d, p in zip(formula_devs, pcts))
                                    if formula_devs else None)
res["formula_consistent_to_serialization_precision"] = (len(anomalies["formula_inconsistent"]) == 0)

# exact duplicate data rows (same 5 values)
duprows = {}
for i, r in enumerate(rows):
    t = (r["replicate"], r["iteration"], r["minimal_sec"], r["instrumented_sec"], r["signed_overhead_pct"])
    duprows.setdefault(t, []).append(i + 2)
res["exact_duplicate_rows"] = {f"row{k}": v for k, v in duprows.items() if len(v) > 1}

# ------------------------------------------------------- frozen global metrics
mean_min, mean_ins = st.fmean(mins), st.fmean(inss)
g_mean_ovh = 100.0 * (mean_ins - mean_min) / mean_min                     # ratio of means
med_min, med_ins = st.median(mins), st.median(inss)
g_meddev = 100.0 * abs(med_ins - med_min) / med_min                       # ratio of medians
pair_ovh = [pct(a, b) for a, b in zip(mins, inss)]
g_worst = max(pair_ovh)                                                   # max signed pair overhead
g_worst_idx = pair_ovh.index(g_worst)

res["global"] = {
    "n_per_condition": len(mins),
    "mean_minimal_us": round(mean_min * 1e6, 6), "mean_instrumented_us": round(mean_ins * 1e6, 6),
    "median_minimal_us": round(med_min * 1e6, 6), "median_instrumented_us": round(med_ins * 1e6, 6),
    "FROZEN_mean_overhead_pct": round(g_mean_ovh, 6),
    "FROZEN_worst_case_overhead_pct": round(g_worst, 6),
    "FROZEN_median_deviation_pct": round(g_meddev, 6),
    "worst_pair_key": {"replicate": keys[g_worst_idx][0], "iteration": keys[g_worst_idx][1],
                       "minimal_sec": mins[g_worst_idx], "instrumented_sec": inss[g_worst_idx]},
}

# ------------------------------------------- alternative statistics (contrast)
alt = {
    "mean_of_pair_ratios_pct": st.fmean(pair_ovh),
    "median_of_pair_ratios_pct": st.median(pair_ovh),
    "ratio_of_means_pct (== FROZEN mean_overhead)": g_mean_ovh,
    "ratio_of_medians_pct (== FROZEN median_deviation)": g_meddev,
    "trimmed_mean_pair_ratios_pct (drop top1+bottom1)": st.fmean(sorted(pair_ovh)[1:-1]),
}
res["alternative_statistics"] = {k: round(v, 6) for k, v in alt.items()}
res["formula_note"] = {
    "mean_overhead_pct": "100*(meanB-meanA)/meanA  -- RATIO OF MEANS, not mean of ratios",
    "worst_case_overhead_pct": "max_j 100*(B_j-A_j)/A_j  -- signed, unclamped, single most extreme pair",
    "median_deviation_pct": "100*|medianB-medianA|/medianA  -- RATIO OF MEDIANS, not median of ratios",
}

# --------------------------------------------------------- per-replicate table
per_rep = []
for r in range(6):
    idx = [i for i, k in enumerate(keys) if k[0] == r]
    a_r = [mins[i] for i in idx]; b_r = [inss[i] for i in idx]
    pr = [pcts[i] for i in idx]
    mm, mi = st.fmean(a_r), st.fmean(b_r)
    dm, di = st.median(a_r), st.median(b_r)
    wj = max(range(len(idx)), key=lambda j: pr[j])
    per_rep.append({
        "replicate": r,
        "n_pairs": len(idx),
        "mean_minimal_us": round(mm * 1e6, 3), "mean_instrumented_us": round(mi * 1e6, 3),
        "median_minimal_us": round(dm * 1e6, 3), "median_instrumented_us": round(di * 1e6, 3),
        "pooled_mean_overhead_pct": round(100.0 * (mi - mm) / mm, 4),
        "median_deviation_pct": round(100.0 * abs(di - dm) / dm, 4),
        "worst_signed_overhead_pct": round(pr[wj], 4),
        "worst_pair_iteration": keys[idx[wj]][1],
        "median_of_pair_ratios_pct": round(st.median(pr), 4),
        "n_negative_pairs": sum(1 for p in pr if p < 0),
        "n_pairs_over_10pct": sum(1 for p in pr if p > 10.0),
    })
res["per_replicate"] = per_rep

# ------------------------------------------------------------ extremes & dist
order = sorted(range(len(pcts)), key=lambda i: pcts[i])
def rec(i):
    return {"replicate": keys[i][0], "iteration": keys[i][1],
            "minimal_us": round(mins[i] * 1e6, 3), "instrumented_us": round(inss[i] * 1e6, 3),
            "signed_overhead_pct": round(pcts[i], 4)}
res["top10_signed_overhead"] = [rec(i) for i in order[::-1][:10]]
res["bottom10_signed_overhead"] = [rec(i) for i in order[:10]]

sp = sorted(pair_ovh)
res["distribution_pair_signed_overhead_pct"] = {
    "min": round(sp[0], 4), "p1": round(q(sp, .01), 4), "p5": round(q(sp, .05), 4),
    "p10": round(q(sp, .10), 4), "q1": round(q(sp, .25), 4), "median": round(q(sp, .50), 4),
    "p75_q3": round(q(sp, .75), 4), "p90": round(q(sp, .90), 4), "p95": round(q(sp, .95), 4),
    "p99": round(q(sp, .99), 4), "max": round(sp[-1], 4),
    "mean": round(st.fmean(pair_ovh), 4), "stdev": round(st.stdev(pair_ovh), 4),
    "iqr": round(q(sp, .75) - q(sp, .25), 4),
    "n_negative": sum(1 for p in pair_ovh if p < 0),
    "n_zero": sum(1 for p in pair_ovh if p == 0),
    "n_positive": sum(1 for p in pair_ovh if p > 0),
    "n_gt_2pct": sum(1 for p in pair_ovh if p > 2.0),
    "n_gt_10pct": sum(1 for p in pair_ovh if p > 10.0),
    "n_gt_50pct": sum(1 for p in pair_ovh if p > 50.0),
}

# ------------------------------------------------------------------ clustering
top10_idx = order[::-1][:10]
bot10_idx = order[:10]
res["clustering"] = {
    "top10_replicates": sorted(keys[i][0] for i in top10_idx),
    "top10_iterations": sorted(keys[i][1] for i in top10_idx),
    "bottom10_replicates": sorted(keys[i][0] for i in bot10_idx),
    "bottom10_iterations": sorted(keys[i][1] for i in bot10_idx),
    "n_negatives_by_replicate": [sum(1 for i, k in enumerate(keys) if k[0] == r and pcts[i] < 0) for r in range(6)],
    "n_pairs_gt_10pct_by_replicate": [sum(1 for i, k in enumerate(keys) if k[0] == r and pcts[i] > 10.0) for r in range(6)],
    "replicate_median_minimal_us": [round(st.median([mins[i] for i, k in enumerate(keys) if k[0] == r]) * 1e6, 2) for r in range(6)],
    "replicate_median_instrumented_us": [round(st.median([inss[i] for i, k in enumerate(keys) if k[0] == r]) * 1e6, 2) for r in range(6)],
}
# iteration-position effect: mean pair overhead by iteration index, and halves
by_iter = {j: [pcts[i] for i, k in enumerate(keys) if k[1] == j] for j in range(50)}
res["clustering"]["mean_overhead_by_iteration"] = {j: round(st.fmean(v), 3) for j, v in sorted(by_iter.items())}
half = []
for r in range(6):
    idx = [i for i, k in enumerate(keys) if k[0] == r]
    fh = [pcts[i] for i in idx if keys[i][1] < 25]
    sh = [pcts[i] for i in idx if keys[i][1] >= 25]
    half.append({"replicate": r, "first_half_mean_pct": round(st.fmean(fh), 3), "second_half_mean_pct": round(st.fmean(sh), 3)})
res["clustering"]["first_vs_second_half_of_measurement_loop"] = half
res["clustering"]["overall_first_half_mean_pct"] = round(st.fmean([pcts[i] for i, k in enumerate(keys) if k[1] < 25]), 3)
res["clustering"]["overall_second_half_mean_pct"] = round(st.fmean([pcts[i] for i, k in enumerate(keys) if k[1] >= 25]), 3)

# sensitivity (EXPLANATORY ONLY - not a substitute for the frozen metric)
res["sensitivity_explanatory_only"] = {
    "frozen_worst_case_pct": round(g_worst, 4),
    "2nd_largest_pair_pct": round(sp[-2], 4),
    "3rd_largest_pair_pct": round(sp[-3], 4),
    "worst_case_without_the_single_max_pct": round(sp[-2], 4),
    "n_pairs_above_10pct": res["distribution_pair_signed_overhead_pct"]["n_gt_10pct"],
    "pct_of_pairs_driving_the_worst_case": round(100.0 * 1 / len(pair_ovh), 4),
    "note": "Reported for explanation only. The frozen metric is the single maximum and is NOT replaced anywhere.",
}

# ------------------------------------------------------------- frozen verdict
mean_ok = abs(g_mean_ovh) <= T_MEAN
worst_ok = g_worst <= T_WORST
medd_ok = g_meddev <= T_MEDDEV
res["frozen_verdict"] = {
    "mean_overhead_pct": {"value": round(g_mean_ovh, 4), "limit": T_MEAN, "ok": mean_ok},
    "worst_case_overhead_pct": {"value": round(g_worst, 4), "limit": T_WORST, "ok": worst_ok},
    "median_deviation_pct": {"value": round(g_meddev, 4), "limit": T_MEDDEV, "ok": medd_ok},
    "calibration": "PASS" if (mean_ok and worst_ok and medd_ok) else "FAIL",
}

(OUT / "01_recomputed_metrics.json").write_text(json.dumps(res, indent=2), encoding="utf-8")

# ---------------------------------------------------------------- print report
print("=" * 88)
print("PHASE 17 - INDEPENDENT RECOMPUTATION FROM CSV")
print("=" * 88)
print(f"csv sha256 {res['sha256']}  bytes={res['bytes']}  lines={res['line_count']}  CRLF={res['line_ending_crlf']}")
print(f"parsed rows={res['parsed_rows']}  unique keys={res['pair_keys_unique']}  anomalies={res['anomaly_total']}")
print()
print("--- FROZEN GLOBAL METRICS (recomputed, independent of stdout) ---")
g = res["global"]
print(f"  mean_overhead_pct       = {g['FROZEN_mean_overhead_pct']:>10.4f}   (limit <= {T_MEAN})   {'OK' if mean_ok else 'NOT OK'}")
print(f"  worst_case_overhead_pct = {g['FROZEN_worst_case_overhead_pct']:>10.4f}   (limit <= {T_WORST})  {'OK' if worst_ok else 'NOT OK'}")
print(f"  median_deviation_pct    = {g['FROZEN_median_deviation_pct']:>10.4f}   (limit <= {T_MEDDEV})   {'OK' if medd_ok else 'NOT OK'}")
print(f"  worst pair = replicate {g['worst_pair_key']['replicate']} iteration {g['worst_pair_key']['iteration']}"
      f"  ({g['worst_pair_key']['minimal_sec']*1e6:.2f} -> {g['worst_pair_key']['instrumented_sec']*1e6:.2f} us)")
print(f"  vs diagnostic stdout: mean {REPORTED['mean_overhead_pct']} / worst {REPORTED['worst_case_overhead_pct']} / meddev {REPORTED['median_deviation_pct']}")
print()
print("--- FORMULA CONTRAST (ratio-of-means/medians vs mean/median-of-ratios) ---")
for k, v in res["alternative_statistics"].items():
    print(f"  {k:<52} {v:>10.4f}")
print()
print("--- PER-REPLICATE ---")
print(f"  {'rep':>3} {'mean_ovh%':>10} {'median_dev%':>12} {'worst_signed%':>14} {'med_pair_ratio%':>16} {'neg':>5} {'>10%':>6}")
for p in per_rep:
    print(f"  {p['replicate']:>3} {p['pooled_mean_overhead_pct']:>10.3f} {p['median_deviation_pct']:>12.3f}"
          f" {p['worst_signed_overhead_pct']:>14.3f} {p['median_of_pair_ratios_pct']:>16.3f}"
          f" {p['n_negative_pairs']:>5} {p['n_pairs_over_10pct']:>6}")
print()
print("--- TOP 10 SIGNED PAIR OVERHEADS ---")
for r in res["top10_signed_overhead"]:
    print(f"  rep{r['replicate']} iter{r['iteration']:>2}  {r['minimal_us']:>10.3f} -> {r['instrumented_us']:>10.3f} us   {r['signed_overhead_pct']:>12.4f} %")
print("--- BOTTOM 10 SIGNED PAIR OVERHEADS ---")
for r in res["bottom10_signed_overhead"]:
    print(f"  rep{r['replicate']} iter{r['iteration']:>2}  {r['minimal_us']:>10.3f} -> {r['instrumented_us']:>10.3f} us   {r['signed_overhead_pct']:>12.4f} %")
print()
print("--- DISTRIBUTION OF PER-PAIR SIGNED OVERHEAD (%) ---")
for k, v in res["distribution_pair_signed_overhead_pct"].items():
    print(f"  {k:<10} {v}")
print()
print("--- CLUSTERING ---")
c = res["clustering"]
print(f"  top10 replicates {c['top10_replicates']}  iterations {c['top10_iterations']}")
print(f"  bottom10 replicates {c['bottom10_replicates']}  iterations {c['bottom10_iterations']}")
print(f"  negatives per replicate {c['n_negatives_by_replicate']}")
print(f"  pairs >10% per replicate {c['n_pairs_gt_10pct_by_replicate']}")
print(f"  rep median minimal us {c['replicate_median_minimal_us']}")
print(f"  rep median instrumented us {c['replicate_median_instrumented_us']}")
print(f"  first-half mean {c['overall_first_half_mean_pct']} %   second-half mean {c['overall_second_half_mean_pct']} %")
print()
print("--- SENSITIVITY (EXPLANATORY ONLY; frozen metric NOT replaced) ---")
for k, v in res["sensitivity_explanatory_only"].items():
    print(f"  {k:<44} {v}")
print()
print(f"FROZEN CALIBRATION VERDICT: {res['frozen_verdict']['calibration']}")
print("=" * 88)
