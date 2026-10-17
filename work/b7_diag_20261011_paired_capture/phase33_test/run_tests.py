# Phase 33 - adversarial test runner for the hardened validator.
#
# Runs phase33_paired_csv_validator.py against every fixture in phase33_test/,
# captures exit code + JSON, and asserts expected structural/calibration
# outcomes. Writes results to phase33_test/test_results.json and prints a
# summary. Does not modify any existing repository artifact.

import json
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
VALIDATOR = HERE.parent / "phase33_paired_csv_validator.py"

# fixture -> (profile, expected_exit, structural_pass_expected,
#             calibration_status_expected, note)
CASES = [
    ("valid_six.csv",             "six",   0, True,  "PASS", "valid six-replicate"),
    ("valid_eight.csv",           "eight", 0, True,  "PASS", "valid eight-replicate"),
    ("dup_key.csv",               "six",   1, False, "NOT_EVALUATED", "duplicate pair key"),
    ("missing_key.csv",           "six",   1, False, "NOT_EVALUATED", "missing pair key"),
    ("unexpected_key.csv",        "six",   1, False, "NOT_EVALUATED", "unexpected replicate"),
    ("wrong_row_count.csv",       "six",   1, False, "NOT_EVALUATED", "301 rows"),
    ("wrong_header.csv",          "six",   1, False, "NOT_EVALUATED", "wrong header names"),
    ("missing_column.csv",        "six",   1, False, "NOT_EVALUATED", "4-field row"),
    ("malformed_row.csv",         "six",   1, False, "NOT_EVALUATED", "6-field row"),
    ("non_integer_key.csv",       "six",   1, False, "NOT_EVALUATED", "non-integer keys"),
    ("non_numeric_timing.csv",    "six",   1, False, "NOT_EVALUATED", "non-numeric timing"),
    ("bad_minimal_sec_nan.csv",   "six",   1, False, "NOT_EVALUATED", "NaN minimal"),
    ("bad_minimal_sec_inf.csv",   "six",   1, False, "NOT_EVALUATED", "inf minimal"),
    ("bad_instrumented_sec_nan.csv", "six", 1, False, "NOT_EVALUATED", "NaN instrumented"),
    ("bad_instrumented_sec_inf.csv", "six", 1, False, "NOT_EVALUATED", "inf instrumented"),
    ("bad_instrumented_sec_neginf.csv", "six", 1, False, "NOT_EVALUATED", "-inf instrumented"),
    ("bad_signed_overhead_pct_nan.csv", "six", 1, False, "NOT_EVALUATED", "NaN pct"),
    ("bad_signed_overhead_pct_inf.csv", "six", 1, False, "NOT_EVALUATED", "inf pct"),
    ("zero_minimal.csv",          "six",   1, False, "NOT_EVALUATED", "zero minimal"),
    ("negative_minimal.csv",      "six",   1, False, "NOT_EVALUATED", "negative minimal"),
    ("zero_instrumented.csv",     "six",   1, False, "NOT_EVALUATED", "zero instrumented"),
    ("negative_instrumented.csv", "six",   1, False, "NOT_EVALUATED", "negative instrumented"),
    ("bad_overhead_pct.csv",      "six",   1, False, "NOT_EVALUATED", "wrong recorded pct"),
    ("reordered_six.csv",         "six",   0, True,  "PASS", "reordered rows, key-aligned"),
    ("fail_calibration.csv",      "six",   2, True,  "FAIL", "structurally valid, fails thresholds"),
]


def run_case(name, profile, expect_exit, expect_struct, expect_cal, note):
    csv_path = HERE / name
    if not csv_path.is_file():
        return {
            "fixture": name, "profile": profile, "note": note,
            "expected_exit": expect_exit, "actual_exit": None,
            "expected_structural_pass": expect_struct,
            "actual_structural_pass": None,
            "expected_calibration": expect_cal, "actual_calibration": None,
            "traceback_in_stderr": False,
            "parse_error": f"fixture file missing: {csv_path}",
            "failed_checks": [], "pass": False,
        }
    proc = subprocess.run(
        [sys.executable, str(VALIDATOR), "--csv", str(csv_path),
         "--profile", profile],
        capture_output=True, text=True)
    ok = proc.returncode == expect_exit
    parsed = None
    parse_err = None
    try:
        parsed = json.loads(proc.stdout)
    except Exception as e:
        parse_err = f"stdout not valid JSON: {e}"
        ok = False
    struct = parsed.get("structural_pass") if parsed else None
    cal = (parsed.get("calibration", {}) or {}).get("status") if parsed else None
    if struct is not expect_struct:
        ok = False
    if cal != expect_cal:
        ok = False
    return {
        "fixture": name,
        "profile": profile,
        "note": note,
        "expected_exit": expect_exit,
        "actual_exit": proc.returncode,
        "expected_structural_pass": expect_struct,
        "actual_structural_pass": struct,
        "expected_calibration": expect_cal,
        "actual_calibration": cal,
        "traceback_in_stderr": "Traceback" in proc.stderr,
        "parse_error": parse_err,
        "failed_checks": (parsed or {}).get("failed_checks", []),
        "pass": ok and "Traceback" not in proc.stderr,
    }


def main():
    results = []
    for case in CASES:
        r = run_case(*case)
        results.append(r)
        status = "PASS" if r["pass"] else "FAIL"
        print(f"[{status}] {r['fixture']:<34} exit={r['actual_exit']} "
              f"structural={r['actual_structural_pass']} cal={r['actual_calibration']}")
        if not r["pass"]:
            print(f"        failed_checks={r['failed_checks']} "
                  f"parse_err={r['parse_error']}")

    out = HERE / "test_results.json"
    out.write_text(json.dumps(results, indent=2), encoding="utf-8")
    n_fail = sum(1 for r in results if not r["pass"])
    print(f"\n{len(results)} cases, {n_fail} failures -> {out}")
    return 1 if n_fail else 0


if __name__ == "__main__":
    sys.exit(main())
