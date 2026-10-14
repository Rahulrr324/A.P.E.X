#!/usr/bin/env python3
"""
Independent validation of the B7 paired_samples.csv produced by the single
authorized run. Recomputes every reported metric from the CSV bytes alone and
compares against the diagnostic's stdout report and the frozen thresholds.

Reimplemented from the source definitions (bm_b7_diagnostic.cpp calibrate()):
  mean_overhead_pct       = 100*(meanInstr - meanMin)/meanMin        (pooled)
  worst_case_overhead_pct = max over pairs of 100*(instr-min)/min    (signed, unclamped)
  median_deviation_pct    = 100*|medianInstr - medianMin|/medianMin  (pooled, linear-interp median)
Thresholds (frozen, unchanged): mean <= 2%, worst <= 10%, median-dev <= 2%
"""
import csv
import json
import math
import pathlib
import statistics
import sys

ROOT = pathlib.Path(r"E:\My Local AI")
CSV = ROOT / "work/b7_diag_20261011_paired_capture/run2/paired_samples.csv"
STDOUT_REPORT = ROOT / "work/b7_diag_20261011_paired_capture/phase16_vs2019/run_expected/stdout.txt"
OUT = ROOT / "work/b7_diag_20261011_paired_capture/phase16_vs2019/csv_validation.json"

EXPECTED_HEADER = ["replicate", "iteration", "minimal_sec", "instrumented_sec", "signed_overhead_pct"]
EXPECTED_REPLICATES = 6
EXPECTED_MEASUREMENTS = 50
EXPECTED_ROWS = EXPECTED_REPLICATES * EXPECTED_MEASUREMENTS   # 300

# Values printed by the diagnostic in this run (independent-verification targets)
REPORTED = {"mean_overhead_pct": 8.5506, "worst_case_overhead_pct": 109.0882, "median_deviation_pct": 2.1161}
REPORTED_REP_MEDIAN_US = {
    "minimal": [11559.300, 13001.700, 15523.500, 15788.100, 15968.850, 15490.100],
    "instrumented": [15559.350, 14225.500, 17633.650, 15940.950, 15994.900, 15655.400],
}
REPORTED_POOLED = {"median_minimal_us": 15469.850, "median_instrumented_us": 15797.200,
                   "mean_minimal_us": 14761.781, "mean_instrumented_us": 16024.001}

FORBIDDEN = ["g7-campaign", "g7cam", "reports", "records", ".jsonl",
             "evidence_manifest", "gate_results", "tiny_dense_2l_weights.bin"]

results = {"csv": str(CSV), "checks": {}, "metrics": {}, "verdict": {}}
fail = []


def chk(name, ok, detail=""):
    results["checks"][name] = {"ok": bool(ok), "detail": detail}
    if not ok:
        fail.append(name)
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f"  -- {detail}" if detail else ""))


print("=" * 78)
print("INDEPENDENT CSV VALIDATION")
print("=" * 78)

if not CSV.is_file():
    print("FATAL: CSV not found"); sys.exit(1)

raw = CSV.read_bytes()
results["csv_bytes"] = len(raw)
import hashlib
results["csv_sha256"] = hashlib.sha256(raw).hexdigest()

text = raw.decode("utf-8")
lines = text.splitlines()
chk("csv_non_empty", len(raw) > 0, f"{len(raw)} bytes")

rows = list(csv.DictReader(text.splitlines()))
with open(CSV, newline="", encoding="utf-8") as f:
    hdr = next(csv.reader(f))
chk("header_exact", hdr == EXPECTED_HEADER, f"header={hdr}")

chk("exactly_300_data_rows", len(rows) == EXPECTED_ROWS, f"data rows={len(rows)}")
chk("total_lines_301_incl_header", len(lines) == 301, f"lines={len(lines)}")

# --- pair keys ---
keys = [(int(r["replicate"]), int(r["iteration"])) for r in rows]
chk("pair_keys_unique", len(set(keys)) == len(keys), f"unique={len(set(keys))}")
expected_keys = {(r, i) for r in range(EXPECTED_REPLICATES) for i in range(EXPECTED_MEASUREMENTS)}
chk("pair_keys_exact_set", set(keys) == expected_keys,
    f"missing={len(expected_keys - set(keys))} extra={len(set(keys) - expected_keys)}")
counts = {}
for r, _ in keys:
    counts[r] = counts.get(r, 0) + 1
chk("per_replicate_counts_50", all(v == 50 for v in counts.values()) and sorted(counts) == list(range(6)),
    f"counts={dict(sorted(counts.items()))}")

# --- numeric sanity ---
mn = [float(r["minimal_sec"]) for r in rows]
ins = [float(r["instrumented_sec"]) for r in rows]
pct = [float(r["signed_overhead_pct"]) for r in rows]
chk("all_values_finite", all(math.isfinite(v) for v in mn + ins + pct))
chk("minimal_sec_positive", all(v > 0.0 for v in mn))
chk("instrumented_sec_positive", all(v > 0.0 for v in ins))

# --- per-row formula ---
bad = [i for i, (a, b, p) in enumerate(zip(mn, ins, pct))
       if abs(p - 100.0 * (b - a) / a) > 1e-6 * max(1.0, abs(p))]
chk("row_formula_pct_matches", not bad, f"violations={len(bad)}")

# --- recomputed metrics ---
mean_min, mean_ins = statistics.fmean(mn), statistics.fmean(ins)
mean_overhead = 100.0 * (mean_ins - mean_min) / mean_min
worst = max(100.0 * (b - a) / a for a, b in zip(mn, ins))
med_min, med_ins = statistics.median(mn), statistics.median(ins)
median_dev = 100.0 * abs(med_ins - med_min) / med_min

results["metrics"] = {
    "n_samples_per_condition": len(mn),
    "mean_minimal_us": round(mean_min * 1e6, 6),
    "mean_instrumented_us": round(mean_ins * 1e6, 6),
    "median_minimal_us": round(med_min * 1e6, 6),
    "median_instrumented_us": round(med_ins * 1e6, 6),
    "mean_overhead_pct": round(mean_overhead, 6),
    "worst_case_overhead_pct": round(worst, 6),
    "median_deviation_pct": round(median_dev, 6),
}

# --- cross-check against the diagnostic's own stdout ---
for k in ("mean_overhead_pct", "worst_case_overhead_pct", "median_deviation_pct"):
    chk(f"recomputed_matches_reported_{k}", abs(results["metrics"][k] - REPORTED[k]) < 0.0002,
        f"recomputed={results['metrics'][k]} reported={REPORTED[k]}")
for k in ("median_minimal_us", "median_instrumented_us", "mean_minimal_us", "mean_instrumented_us"):
    chk(f"recomputed_matches_reported_{k}", abs(results["metrics"][k] - REPORTED_POOLED[k]) < 0.01,
        f"recomputed={results['metrics'][k]} reported={REPORTED_POOLED[k]}")

# --- per-replicate medians from the CSV vs the report ---
for cond, vals in REPORTED_REP_MEDIAN_US.items():
    src = mn if cond == "minimal" else ins
    got = []
    for r in range(6):
        got.append(statistics.median([src[i] for i, (rr, _) in enumerate(keys) if rr == r]) * 1e6)
    ok = all(abs(g - e) < 0.01 for g, e in zip(got, vals))
    chk(f"per_replicate_medians_{cond}", ok,
        f"recomputed={[round(g,3) for g in got]} reported={vals}")

# --- report text cross-check ---
rep = STDOUT_REPORT.read_text(encoding="utf-8", errors="replace")
for needle in ("mean_overhead_pct       = 8.5506 %", "worst_case_overhead_pct = 109.0882 %",
               "median_deviation_pct    = 2.1161 %", "classification: INCONCLUSIVE",
               "historical comparison reference: 5721.90 us"):
    chk(f"report_contains[{needle[:40]}]", needle in rep)

# --- forbidden markers ---
low_path = str(CSV).lower()
chk("no_forbidden_marker_in_path", not any(f in low_path for f in FORBIDDEN))
chk("no_forbidden_marker_in_contents", not any(f in text.lower() for f in FORBIDDEN))

# --- FROZEN THRESHOLDS (unchanged) ---
mean_ok = abs(mean_overhead) <= 2.0
worst_ok = worst <= 10.0
median_ok = median_dev <= 2.0
results["verdict"] = {
    "threshold_mean_le_2pct": {"value": round(mean_overhead, 4), "ok": mean_ok},
    "threshold_worst_le_10pct": {"value": round(worst, 4), "ok": worst_ok},
    "threshold_median_dev_le_2pct": {"value": round(median_dev, 4), "ok": median_ok},
    "calibration_status": "PASS" if (mean_ok and worst_ok and median_ok) else "FAIL",
}
chk("threshold_mean_le_2pct", mean_ok, f"{mean_overhead:.4f} %")
chk("threshold_worst_le_10pct", worst_ok, f"{worst:.4f} %")
chk("threshold_median_dev_le_2pct", median_ok, f"{median_dev:.4f} %")

results["all_checks_passed"] = not fail
results["failed_checks"] = fail

OUT.write_text(json.dumps(results, indent=2), encoding="utf-8")
print("=" * 78)
print(f"STRUCTURAL VALIDITY : {'PASS' if not fail else 'FAIL'}  ({len(results['checks'])} checks, {len(fail)} failed)")
print(f"CALIBRATION VERDICT : {results['verdict']['calibration_status']}")
print(f"mean={mean_overhead:.4f}%  worst={worst:.4f}%  median_dev={median_dev:.4f}%")
print(f"wrote {OUT}")
print("=" * 78)
sys.exit(0 if not fail else 2)
