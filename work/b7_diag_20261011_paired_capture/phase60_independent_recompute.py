#!/usr/bin/env python3
"""Phase 60 - Independent recomputation of paired CSV metrics.

Recomputes mean, worst-case, median-deviation from capture CSVs using
the frozen formulas from phase33_paired_csv_validator.py calibrate().

Usage:
  python phase60_independent_recompute.py <csv_path>

Reads CSV, aligns pairs by (replicate, iteration) key, computes:
  mean_overhead_pct       = 100*(fmean(instr) - fmean(min)) / fmean(min)
  worst_case_overhead_pct = max over aligned pairs of 100*(instr - min)/min
  median_deviation_pct    = 100*|median(instr) - median(min)| / median(min)

Thresholds (frozen): mean <= 2%, worst <= 10%, median-dev <= 2%
"""
import csv
import io
import pathlib
import statistics
import sys


THRESHOLDS = {
    "mean_overhead_pct": 2.0,
    "worst_case_overhead_pct": 10.0,
    "median_deviation_pct": 2.0,
}


def recompute(csv_path):
    p = pathlib.Path(csv_path)
    rows = []
    with open(p, newline="") as f:
        reader = csv.reader(io.StringIO(f.read()))
        header = next(reader)
        for row in reader:
            rep = int(row[0])
            it = int(row[1])
            min_sec = float(row[2])
            instr_sec = float(row[3])
            pct = float(row[4])
            # Verify formula
            recomputed_pct = 100.0 * (instr_sec - min_sec) / min_sec
            assert abs(pct - recomputed_pct) < 1e-4, f"Formula mismatch at ({rep},{it})"
            rows.append((rep, it, min_sec, instr_sec))

    # Align by key (replicate, iteration)
    pairs = {}
    key_errors = 0
    for rep, it, min_sec, instr_sec in rows:
        key = (rep, it)
        if key in pairs:
            key_errors += 1
        pairs[key] = (min_sec, instr_sec)

    # Sort by key for deterministic ordering
    sorted_keys = sorted(pairs.keys())
    mn = [pairs[k][0] for k in sorted_keys]
    ins = [pairs[k][1] for k in sorted_keys]

    # Compute metrics
    mean_min = statistics.fmean(mn)
    mean_ins = statistics.fmean(ins)
    mean_overhead = 100.0 * (mean_ins - mean_min) / mean_min

    worst = max(100.0 * (b - a) / a for a, b in zip(mn, ins))

    med_min = statistics.median(mn)
    med_ins = statistics.median(ins)
    median_dev = 100.0 * abs(med_ins - med_min) / med_min

    mean_ok = abs(mean_overhead) <= THRESHOLDS["mean_overhead_pct"]
    worst_ok = worst <= THRESHOLDS["worst_case_overhead_pct"]
    median_ok = median_dev <= THRESHOLDS["median_deviation_pct"]

    overall_pass = mean_ok and worst_ok and median_ok

    result = {
        "csv_path": str(csv_path),
        "n_pairs": len(pairs),
        "n_replicates": max(k[0] for k in pairs) + 1,
        "max_iteration": max(k[1] for k in pairs),
        "key_errors": key_errors,
        "mean_minimal_sec": mean_min,
        "mean_instrumented_sec": mean_ins,
        "mean_overhead_pct": round(mean_overhead, 6),
        "mean_ok": mean_ok,
        "worst_case_overhead_pct": round(worst, 6),
        "worst_ok": worst_ok,
        "median_minimal_sec": med_min,
        "median_instrumented_sec": med_ins,
        "median_deviation_pct": round(median_dev, 6),
        "median_ok": median_ok,
        "overall_pass": overall_pass,
    }
    return result


def main():
    if len(sys.argv) != 2:
        print("Usage: python phase60_independent_recompute.py <csv_path>")
        sys.exit(1)
    result = recompute(sys.argv[1])
    for k, v in result.items():
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()