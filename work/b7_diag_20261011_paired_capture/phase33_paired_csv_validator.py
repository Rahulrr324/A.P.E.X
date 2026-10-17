# Phase 33 - Hardened Paired-CSV Validator (adversarial-input hardening of Phase 32)
#
# PURPOSE
#   Validates the B7 diagnostic paired timing CSV
#   (columns: replicate,iteration,minimal_sec,instrumented_sec,signed_overhead_pct)
#   so that malformed or internally inconsistent data CANNOT be accepted as
#   valid evidence. Structural validity and calibration status are reported
#   SEPARATELY; calibration is computed ONLY after structural validation passes.
#
#   This file is a NEW, SEPARATE validator. It does not modify or replace the
#   Phase 32 validator (phase32_paired_csv_validator.py), the Phase 19
#   validator (phase19_planning/phase19_validate.py), or the Phase 30
#   validator (phase28_b7_read_path/phase30_validate.py).
#
# PROFILES (explicit, unchanged from Phase 32)
#   six   : 6 replicates x 50 iterations = 300 data rows (+1 header line)
#   eight : 8 replicates x 50 iterations = 400 data rows (+1 header line)
#
# ROW-ORDERING CONTRACT (documented requirement)
#   Row order is NOT required. Rows may appear in any order. Pairs are
#   aligned by the (replicate, iteration) key BEFORE any paired metric is
#   computed; the validator never pairs rows by file position. Within the
#   validator, metric arrays are built in sorted key order for determinism.
#
# STRUCTURAL CHECKS (all must pass; any failure => structural FAIL, no metrics)
#   file_readable, file_non_empty, utf8_decodable, no_utf8_bom,
#   header_exact, all_rows_have_exact_field_count,
#   replicate_iteration_canonical_integers, keys_in_expected_range,
#   pair_keys_unique, pair_keys_exact_set, data_row_count, total_line_count,
#   per_replicate_counts, numeric_fields_parse, all_values_finite,
#   minimal_sec_positive, instrumented_sec_positive, row_formula_pct_matches
#
# NUMERIC PARSING (hardened vs. Phase 32, which used float() directly)
#   Timing/overhead fields must match the plain decimal/scientific literal
#   regex  ^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$  (no whitespace, no
#   underscores) AND parse via float() AND be finite. "nan", "inf", "-inf",
#   "1e400" (overflows to inf), "1_0", and " 1.0 " are all REJECTED.
#   replicate/iteration must be canonical non-negative decimal integers
#   (regex ^\d+$ with no leading zeros: str(int(x)) == x). "1.0", "abc",
#   "+1", "007", " 1 " are all REJECTED.
#
# OVERHEAD-FORMULA TOLERANCE (consistent with Phase 19 / Phase 30 validators)
#   For every row: recorded signed_overhead_pct must satisfy
#       |p - 100*(instrumented_sec - minimal_sec)/minimal_sec|
#           <= 1e-6 * max(1.0, |p|)
#   Otherwise the row_formula_pct_matches check fails (structural).
#
# FROZEN CALIBRATION FORMULAS (verbatim from bm_b7_diagnostic.cpp calibrate();
# identical to Phase 16/19/30/32 validators; NOT adjusted anywhere)
#   mean_overhead_pct       = 100*(fmean(instr) - fmean(min)) / fmean(min)
#   worst_case_overhead_pct = max over ALIGNED (by key) pairs of
#                             100*(instr - min)/min   (signed, unclamped)
#   median_deviation_pct    = 100*|median(instr) - median(min)| / median(min)
#
# FROZEN THRESHOLDS (unchanged): mean <= 2 %, worst <= 10 %, median-dev <= 2 %.
#
# EXIT CODES
#   0 : structural PASS and calibration PASS (all three thresholds hold)
#   1 : structural FAIL (metrics NOT computed; calibration NOT_EVALUATED)
#   2 : structural PASS, calibration FAIL (a legitimate result of the data)
#   3 : usage or internal error (unexpected exception; JSON error object emitted)
#   Malformed input never causes an unhandled traceback: the whole run is
#   wrapped and any unexpected exception is reported as JSON with exit 3.
#
# SAFETY
#   Read-only: this script only reads the CSV and prints JSON to stdout.
#   It never writes, moves, or modifies any file.
#
# USAGE (run from repo root):
#   python work/b7_diag_20261011_paired_capture/phase33_paired_csv_validator.py \
#       --csv work/b7_diag_20261011_paired_capture/phase28_b7_read_path/probe/pr30_probe_warm/paired_samples.csv \
#       --profile six

import argparse
import csv
import io
import json
import math
import pathlib
import re
import statistics
import sys

VALIDATOR_NAME = "phase33_paired_csv_validator"

EXPECTED_HEADER = ["replicate", "iteration", "minimal_sec",
                   "instrumented_sec", "signed_overhead_pct"]
EXPECTED_FIELDS = len(EXPECTED_HEADER)
MEASUREMENTS_PER_REPLICATE = 50

PROFILES = {"six": 6, "eight": 8}

# FROZEN. Not adjusted anywhere in this file.
THRESHOLDS = {"mean_overhead_pct": 2.0, "worst_case_overhead_pct": 10.0,
              "median_deviation_pct": 2.0}

# Hardened numeric literal: no whitespace, no underscores; rejects nan/inf.
NUMERIC_RE = re.compile(r"^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$")
# Canonical non-negative integer keys: no sign, no whitespace, no leading zeros.
INT_KEY_RE = re.compile(r"^\d+$")

# Documented tolerance, identical to Phase 19 / Phase 30 validators.
PCT_TOL_REL = 1e-6
PCT_TOL_ABS_FLOOR = 1.0

ORDERING_CONTRACT = (
    "row order is NOT required; pairs are aligned by (replicate, iteration) "
    "key before any paired metric is computed (never by file position)"
)

MAX_DETAILS_PER_CHECK = 25  # cap emitted detail samples per failing check


class _Parser(argparse.ArgumentParser):
    """ArgumentParser whose usage errors exit 3 (not argparse's default 2),
    keeping exit code 2 reserved exclusively for calibration FAIL."""

    def error(self, message):
        self.print_usage(sys.stderr)
        print(json.dumps({"validator": VALIDATOR_NAME, "fatal": True,
                          "error": f"usage error: {message}",
                          "exit_code": 3}), file=sys.stderr)
        raise SystemExit(3)


def _strict_float(text):
    """Parse a hardened numeric literal. Returns (value, error_string)."""
    if not isinstance(text, str) or NUMERIC_RE.match(text) is None:
        return None, f"not a plain numeric literal: {text!r}"
    try:
        v = float(text)
    except ValueError as e:
        return None, f"float() failed for {text!r}: {e}"
    if not math.isfinite(v):
        return None, f"non-finite value: {text!r}"
    return v, None


def _canonical_int(text):
    """Parse a canonical non-negative integer key. Returns (value, error)."""
    if not isinstance(text, str) or INT_KEY_RE.match(text) is None:
        return None, f"not a canonical integer key: {text!r}"
    v = int(text)
    if str(v) != text:  # rejects leading zeros such as '007'
        return None, f"non-canonical integer key: {text!r}"
    return v, None


def validate_csv(csv_path, profile):
    """Validate csv_path under the given profile. Never raises for bad data."""
    replicates = PROFILES[profile]
    expected_rows = replicates * MEASUREMENTS_PER_REPLICATE
    expected_total = expected_rows + 1
    expected_keys = {(r, i)
                     for r in range(replicates)
                     for i in range(MEASUREMENTS_PER_REPLICATE)}

    result = {
        "validator": VALIDATOR_NAME,
        "csv_path": str(csv_path),
        "profile": profile,
        "replicates": replicates,
        "iterations_per_replicate": MEASUREMENTS_PER_REPLICATE,
        "expected_data_rows": expected_rows,
        "ordering_contract": ORDERING_CONTRACT,
        "pair_alignment": "(replicate, iteration)",
        "overhead_formula_tolerance":
            f"|recorded - 100*(instr-min)/min| <= {PCT_TOL_REL} * "
            f"max({PCT_TOL_ABS_FLOOR}, |recorded|)",
        "structural_pass": False,
        "checks": {},
        "failed_checks": [],
        "calibration": {
            "status": "NOT_EVALUATED",
            "mean_overhead_pct": None,
            "worst_case_overhead_pct": None,
            "median_deviation_pct": None,
            "thresholds": THRESHOLDS,
            "mean_ok": None,
            "worst_ok": None,
            "median_ok": None,
        },
    }
    checks = result["checks"]
    fails = result["failed_checks"]

    def chk(name, ok, detail=""):
        checks[name] = {"ok": bool(ok), "detail": detail}
        if not ok:
            fails.append(name)

    # ---- file access -------------------------------------------------------
    p = pathlib.Path(csv_path)
    try:
        raw = p.read_bytes()
    except Exception as e:
        chk("file_readable", False, f"{type(e).__name__}: {e}")
        return result
    chk("file_readable", True, f"{len(raw)} bytes")
    chk("file_non_empty", len(raw) > 0, f"{len(raw)} bytes")
    if len(raw) == 0:
        return result

    try:
        text = raw.decode("utf-8")
        chk("utf8_decodable", True)
    except UnicodeDecodeError as e:
        chk("utf8_decodable", False, str(e))
        return result
    chk("no_utf8_bom", not text.startswith("\ufeff"),
        "UTF-8 BOM present (would corrupt first header field)"
        if text.startswith("\ufeff") else "")

    lines = text.splitlines()
    chk("total_line_count", len(lines) == expected_total,
        f"expected {expected_total} lines (header + {expected_rows} rows), "
        f"got {len(lines)}")

    # ---- CSV parsing (strict quoting; NUL-safe) ----------------------------
    parsed_rows = []
    parse_error = None
    try:
        reader = csv.reader(io.StringIO(text, newline=""), strict=True)
        for row in reader:
            parsed_rows.append(row)
    except csv.Error as e:
        parse_error = f"csv parse error: {e}"
    chk("csv_parse_strict", parse_error is None, parse_error or "")

    if parse_error is not None:
        return result

    # ---- header ------------------------------------------------------------
    header = parsed_rows[0] if parsed_rows else None
    chk("header_exact", header == EXPECTED_HEADER,
        f"expected {EXPECTED_HEADER}, got {header}")
    data_rows = parsed_rows[1:]

    chk("data_row_count", len(data_rows) == expected_rows,
        f"expected {expected_rows} data rows, got {len(data_rows)}")

    # ---- per-row field count ----------------------------------------------
    bad_width = [(idx, len(r)) for idx, r in enumerate(data_rows)
                 if len(r) != EXPECTED_FIELDS]
    chk("all_rows_have_exact_field_count", not bad_width,
        f"{len(bad_width)} rows with != {EXPECTED_FIELDS} fields "
        f"(first few: {bad_width[:MAX_DETAILS_PER_CHECK]})")
    well_formed = [r for r in data_rows if len(r) == EXPECTED_FIELDS]

    # ---- key parsing (canonical integers) ----------------------------------
    keys = []
    key_errors = []
    for idx, r in enumerate(well_formed):
        rep, e1 = _canonical_int(r[0])
        it, e2 = _canonical_int(r[1])
        if e1 or e2:
            key_errors.append((idx, e1 or e2))
        else:
            keys.append((rep, it))
    chk("replicate_iteration_canonical_integers", not key_errors,
        f"{len(key_errors)} malformed keys "
        f"(first few: {key_errors[:MAX_DETAILS_PER_CHECK]})")

    # ---- key set / uniqueness / range / per-replicate counts ---------------
    unique = len(set(keys)) == len(keys)
    dup_count = len(keys) - len(set(keys))
    chk("pair_keys_unique", unique, f"{dup_count} duplicate keys")

    expected_present = set(keys) == expected_keys if unique else False
    missing = expected_keys - set(keys)
    extra = set(keys) - expected_keys
    chk("pair_keys_exact_set", expected_present,
        f"missing={len(missing)} extra={len(extra)} "
        f"(missing sample: {sorted(missing)[:MAX_DETAILS_PER_CHECK]}, "
        f"extra sample: {sorted(extra)[:MAX_DETAILS_PER_CHECK]})")

    out_of_range = sorted(k for k in set(keys)
                          if k[0] >= replicates
                          or k[1] >= MEASUREMENTS_PER_REPLICATE)
    chk("keys_in_expected_range", not out_of_range,
        f"{len(out_of_range)} keys outside replicate[0..{replicates - 1}] x "
        f"iteration[0..{MEASUREMENTS_PER_REPLICATE - 1}] "
        f"(sample: {out_of_range[:MAX_DETAILS_PER_CHECK]})")

    counts = {}
    for rep, _ in keys:
        counts[rep] = counts.get(rep, 0) + 1
    bad_counts = {r: counts.get(r, 0) for r in range(replicates)
                  if counts.get(r, 0) != MEASUREMENTS_PER_REPLICATE}
    chk("per_replicate_counts",
        not bad_counts and set(counts) <= set(range(replicates)),
        f"replicates with wrong row count: "
        f"{dict(list(sorted(bad_counts.items()))[:MAX_DETAILS_PER_CHECK])}")

    # ---- numeric fields (strict literal + finite) --------------------------
    numeric_errors = []
    records = []  # (key, min, instr, pct) for rows whose numerics all parsed
    for idx, r in enumerate(well_formed):
        if len(r) != EXPECTED_FIELDS:
            continue
        min_v, e1 = _strict_float(r[2])
        ins_v, e2 = _strict_float(r[3])
        pct_v, e3 = _strict_float(r[4])
        errs = [e for e in (e1, e2, e3) if e]
        if errs:
            numeric_errors.append((idx, errs[0]))
            continue
        key = None
        rep, e1k = _canonical_int(r[0])
        it, e2k = _canonical_int(r[1])
        if not e1k and not e2k:
            key = (rep, it)
        records.append((key, min_v, ins_v, pct_v))
    chk("numeric_fields_parse", not numeric_errors,
        f"{len(numeric_errors)} rows with unparsable/non-finite numerics "
        f"(first few: {numeric_errors[:MAX_DETAILS_PER_CHECK]})")
    # all_values_finite is enforced inside _strict_float; kept as an explicit
    # named check for reporting parity with the Phase 19/30 validators.
    chk("all_values_finite", not numeric_errors,
        "non-finite values are rejected by the strict parser"
        if numeric_errors else "")

    # ---- positivity --------------------------------------------------------
    nonpos_min = [(k, m) for k, m, _, _ in records if m <= 0.0]
    chk("minimal_sec_positive", not nonpos_min,
        f"{len(nonpos_min)} rows with minimal_sec <= 0 "
        f"(sample: {nonpos_min[:MAX_DETAILS_PER_CHECK]})")
    nonpos_ins = [(k, i) for k, _, i, _ in records if i <= 0.0]
    chk("instrumented_sec_positive", not nonpos_ins,
        f"{len(nonpos_ins)} rows with instrumented_sec <= 0 "
        f"(sample: {nonpos_ins[:MAX_DETAILS_PER_CHECK]})")

    # ---- per-row overhead formula -----------------------------------------
    violations = []
    for k, m, i, p in records:
        if m <= 0.0:  # division guard; positivity already failed above
            continue
        recomputed = 100.0 * (i - m) / m
        if abs(p - recomputed) > PCT_TOL_REL * max(PCT_TOL_ABS_FLOOR, abs(p)):
            violations.append((k, p, round(recomputed, 8)))
    chk("row_formula_pct_matches", not violations,
        f"{len(violations)} rows where recorded signed_overhead_pct != "
        f"100*(instr-min)/min within tolerance "
        f"(sample: {violations[:MAX_DETAILS_PER_CHECK]})")

    # ---- structural verdict ------------------------------------------------
    result["structural_pass"] = not fails

    # ---- calibration: computed ONLY after structural PASS ------------------
    if result["structural_pass"]:
        # Re-align pairs by (replicate, iteration) key, sorted for determinism.
        aligned = sorted(records, key=lambda t: t[0])
        mn = [t[1] for t in aligned]
        ins = [t[2] for t in aligned]

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

        cal = result["calibration"]
        cal["mean_overhead_pct"] = round(mean_overhead, 6)
        cal["worst_case_overhead_pct"] = round(worst, 6)
        cal["median_deviation_pct"] = round(median_dev, 6)
        cal["mean_ok"] = mean_ok
        cal["worst_ok"] = worst_ok
        cal["median_ok"] = median_ok
        cal["status"] = "PASS" if (mean_ok and worst_ok and median_ok) else "FAIL"

        result["metrics"] = {
            "n_pairs": len(mn),
            "mean_minimal_sec": round(mean_min, 12),
            "mean_instrumented_sec": round(mean_ins, 12),
            "median_minimal_sec": round(med_min, 12),
            "median_instrumented_sec": round(med_ins, 12),
            "min_pair_overhead_pct":
                round(min(100.0 * (b - a) / a for a, b in zip(mn, ins)), 6),
            "count_pairs_over_10pct":
                sum(1 for a, b in zip(mn, ins)
                    if 100.0 * (b - a) / a > 10.0),
        }
    return result


def main(argv=None):
    parser = _Parser(
        description="Hardened validator for B7 paired timing CSVs (Phase 33).")
    parser.add_argument("--csv", required=True,
                        help="Path to the CSV file to validate")
    parser.add_argument("--profile", choices=sorted(PROFILES), required=True,
                        help="'six' = 6x50 (300 rows), 'eight' = 8x50 (400 rows)")
    args = parser.parse_args(argv)

    try:
        result = validate_csv(pathlib.Path(args.csv), args.profile)
    except Exception as e:  # never emit an unhandled traceback
        err = {"validator": VALIDATOR_NAME, "fatal": True,
               "error": f"{type(e).__name__}: {e}",
               "structural_pass": False,
               "calibration": {"status": "NOT_EVALUATED"}}
        print(json.dumps(err, indent=2))
        return 3

    print(json.dumps(result, indent=2))

    if not result["structural_pass"]:
        return 1
    if result["calibration"]["status"] == "PASS":
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
