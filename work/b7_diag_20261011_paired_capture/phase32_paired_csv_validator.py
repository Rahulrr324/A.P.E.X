# Phase 32 - Corrected Paired-CSV Validator
#
# This validator validates CSV files that contain paired timing rows with the columns:
#   replicate,iteration,minimal_sec,instrumented_sec,signed_overhead_pct
# It supports two grain profiles:
#   - six-replicate profile (6 replicates, 50 iterations each, 300 data rows total)
# - - eight-replicate profile (8 replicates, 50 iterations, 400 data rows total)
#
# The validator performs two distinct checks:
#   1. Structural validation – header, row count, unique keys, per‑replicate counts, etc.
#   2. Calibration validation – computes frozen formulas and thresholds. Structural PASS is required before calibration.
#
# It never modifies any existing files; it only reads the CSV and prints results.
#
# Usage example (run from repo root):
#   python work/b7_diag_20261011_paired_capture/phase32_paired_csv_validator.py \
#       --csv work/b7_diag_20261011_paired_capture/phase28_b7_read_path/probe/pr30_probe_warm/paired_samples.csv \
#       --profile eight   # or "six"
#
# The script exits with code 0 on overall PASS (structural PASS && calibration PASS),
# code 1 on structural FAIL, and code 2 on calibration FAIL (structural PASS but calibration thresholds violated).

import argparse
import csv
import json
import math
import pathlib
import sys
import statistics
from typing import Dict, List, Tuple

# Frozen thresholds (identical to the original Phase‑30 validator)
THRESHOLDS = {
    "mean_overhead_pct": 2.0,
    "worst_case_overhead_pct": 10.0,
    "median_deviation_pct": 2.0,
}

EXPECTED_HEADER = ["replicate", "iteration", "minimal_sec", "instrumented_sec", "signed_overhead_pct"]
MEASUREMENTS_PER_REPLICATE = 50

def compute_statistics(values: List[float]):
    """Return a dict with mean, median, stdev, min, max, p95, etc.
    Uses the same production conventions as the original diagnostic.
    """
    if not values:
        return {}
    mean = sum(values) / len(values)
    median = statistics.median(values)
    stdev = statistics.pstdev(values) if len(values) > 1 else 0.0
    min_v = min(values)
    max_v = max(values)
    # 95th percentile using linear interpolation (same as the original code's approach)
    sorted_vals = sorted(values)
    n = len(sorted_vals)
    p = 0.95 * (n - 1)
    lo = int(math.floor(p))
    hi = int(math.ceil(p))
    if lo == hi:
        p95 = sorted_vals[lo]
    else:
        frac = p - lo
        p95 = sorted_vals[lo] + frac * (sorted_vals[hi] - sorted_vals[lo])
    return {
        "mean": mean,
        "median": median,
        "stdev": stdev,
        "min": min_v,
        "max": max_v,
        "p95": p95,
        "count": n,
    }

def validate_csv(csv_path: pathlib.Path, profile: str) -> Dict:
    """Validate a CSV file according to the chosen profile ('six' or 'eight')."""
    # Determine expected counts based on profile
    if profile == "six":
        replicates = 6
    elif profile == "eight":
        replicates = 8
    else:
        raise ValueError(f"Unsupported profile: {profile}")

    expected_data_rows = replicates * MEASUREMENTS_PER_REPLICATE
    expected_total_rows = expected_data_rows + 1  # + header

    result: Dict = {
        "profile": profile,
        "structural_pass": False,
        "structural_failures": [],
        "calibration": {
            "status": "INCONCLUSIVE",
            "mean_overhead_pct": None,
            "worst_case_overhead_pct": None,
            "median_deviation_pct": None,
            "thresholds": THRESHOLDS,
            "mean_ok": None,
            "worst_ok": None,
            "median_ok": None,
        },
        "csv_path": str(csv_path),
    }

    # Load CSV
    try:
        raw = csv_path.read_bytes()
    except Exception as e:
        result["structural_failures"].append(f"cannot read CSV: {e}")
        return result

    # Basic non‑empty check
    if len(raw) == 0:
        result["structural_failures"].append("CSV empty")
        return result

    text = raw.decode("utf-8", errors="replace")
    lines = text.splitlines()
    # Header check
    reader = csv.DictReader(lines)
    header = reader.fieldnames
    if header != EXPECTED_HEADER:
        result["structural_failures"].append(f"header mismatch: {header}")
    # Row count check
    data_rows = list(reader)
    if len(data_rows) != expected_data_rows:
        result["structural_failures"].append(
            f"expected {expected_data_rows} data rows for profile {profile}, got {len(data_rows)}"
        )
    # Total line count (including header)
    if len(lines) != expected_total_rows:
        result["structural_failures"].append(
            f"total line count mismatch: expected {expected_total_rows}, got {len(lines)}"
        )
    # Validate per‑replicate counts and keys
    keys = [(int(r["replicate"]), int(r["iteration"])) for r in data_rows]
    expected_keys = {(r, i) for r in range(replicates) for i in range(MEASUREMENTS_PER_REPLICATE)}
    if set(keys) != expected_keys:
        missing = expected_keys - set(keys)
        extra = set(keys) - expected_keys
        result["structural_failures"].append(
            f"key set mismatch (missing={len(missing)} extra={len(extra)})"
        )
    # Per‑replicate row count verification
    counts: Dict[int, int] = {}
    for r, _ in keys:
        counts[r] = counts.get(r, 0) + 1
    for rep in range(replicates):
        if counts.get(rep, 0) != MEASUREMENTS_PER_REPLICATE:
            result["structural_failures"].append(
                f"replicate {rep} has {counts.get(rep,0)} rows, expected {MEASUREMENTS_PER_REPLICATE}"
            )
    # Finite and positive checks
    minimal_vals = []
    instrumented_vals = []
    signed_overhead_vals = []
    for row in data_rows:
        try:
            min_val = float(row["minimal_sec"])
            instr_val = float(row["instrumented_sec"])
            pct_val = float(row["signed_overhead_pct"])
        except Exception as e:
            result["structural_failures"].append(f"non‑numeric value: {e}")
            continue
        if not (math.isfinite(min_val) and math.isfinite(instr_val) and math.isfinite(pct_val)):
            result["structural_failures"].append("non‑finite value detected")
        if min_val <= 0.0:
            result["structural_failures"].append("minimal_sec not positive")
        minimal_vals.append(min_val)
        instrumented_vals.append(instr_val)
        signed_overhead_vals.append(pct_val)
    # Structural pass flag
    result["structural_pass"] = not result["structural_failures"]

    # Calibration (only if structural PASS)
    if result["structural_pass"]:
        # Compute mean overhead
        mean_min = sum(minimal_vals) / len(minimal_vals)
        mean_instr = sum(instrumented_vals) / len(instrumented_vals)
        mean_overhead = 100.0 * (mean_instr - mean_min) / mean_min
        # Worst signed pair overhead (max signed value)
        worst_overhead = max(
            100.0 * (instr - min_val) / min_val
            for min_val, instr in zip(minimal_vals, instrumented_vals)
        )
        # Median deviation
        median_min = statistics.median(minimal_vals)
        median_instr = statistics.median(instrumented_vals)
        median_dev = 100.0 * abs(median_instr - median_min) / median_min
        # Populate calibration dict
        cal = result["calibration"]
        cal["mean_overhead_pct"] = round(mean_overhead, 6)
        cal["worst_case_overhead_pct"] = round(worst_overhead, 6)
        cal["median_deviation_pct"] = round(median_dev, 6)
        # Threshold checks
        cal["mean_ok"] = abs(mean_overhead) <= THRESHOLDS["mean_overhead_pct"]
        cal["worst_ok"] = worst_overhead <= THRESHOLDS["worst_case_overhead_pct"]
        cal["median_ok"] = median_dev <= THRESHOLDS["median_deviation_pct"]
        # Overall status
        if cal["mean_ok"] and cal["worst_ok"] and cal["median_ok"]:
            cal["status"] = "PASS"
        else:
            cal["status"] = "FAIL"
        # Mark computable
        cal["computable"] = True
    else:
        # No calibration performed – leave defaults (INCONCLUSIVE)
        pass

    return result

def main():
    parser = argparse.ArgumentParser(description="Validate paired CSV files for B7 diagnostic.")
    parser.add_argument("--csv", required=True, help="Path to the CSV file to validate")
    parser.add_argument(
        "--profile",
        choices=["six", "eight"],
        required=True,
        help="Profile to use: 'six' for 6×50 (300 rows), 'eight' for 8×50 (400 rows)",
    )
    args = parser.parse_args()

    csv_path = pathlib.Path(args.csv)
    result = validate_csv(csv_path, args.profile)
    # Pretty‑print JSON for human consumption
    print(json.dumps(result, indent=2))
    # Exit code signalling
    if not result["structural_pass"]:
        sys.exit(1)
    # structural pass – now look at calibration status
    cal = result["calibration"]
    if cal.get("status") == "PASS":
        sys.exit(0)
    else:
        # calibration FAIL or INCONCLUSIVE
        sys.exit(2)

if __name__ == "__main__":
    main()
