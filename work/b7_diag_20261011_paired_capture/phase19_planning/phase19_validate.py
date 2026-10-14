#!/usr/bin/env python3
"""
Phase 19 - per-run validation of the six planned B7 diagnostic runs.

WHAT THIS DOES
    Validates ONE run's paired_samples.csv in isolation, reproducing the frozen
    formulas verbatim. Six runs are reported INDEPENDENTLY: there is no pooled
    six-run calibration result, by design.

FROZEN FORMULAS (reproduced verbatim from bm_b7_diagnostic.cpp calibrate();
identical to the Phase 16 validator, which is NOT modified by this file)
    row  signed_overhead_pct = 100*(instrumented_sec - minimal_sec)/minimal_sec
    mean_overhead_pct       = 100*(fmean(instr) - fmean(min)) / fmean(min)
    worst_case_overhead_pct = max over aligned pairs of 100*(instr-min)/min
                              (signed, unclamped by design)
    median_deviation_pct    = 100*|median(instr) - median(min)| / median(min)
                              (statistics.median, linear interpolation)

FROZEN THRESHOLDS (unchanged): mean <= 2 %, worst <= 10 %, median-dev <= 2 %.

USAGE
    python phase19_validate.py --run-dir work/.../phase19_runs/p19r1
    python phase19_validate.py --compare
"""

import argparse
import csv
import datetime
import hashlib
import json
import math
import pathlib
import re
import statistics
import sys

ROOT = pathlib.Path(r"E:\My Local AI")
RUNS_BASE = ROOT / "work/b7_diag_20261011_paired_capture/phase19_runs"

EXPECTED_HEADER = ["replicate", "iteration", "minimal_sec", "instrumented_sec",
                   "signed_overhead_pct"]
EXPECTED_REPLICATES = 6
EXPECTED_MEASUREMENTS = 50
EXPECTED_ROWS = EXPECTED_REPLICATES * EXPECTED_MEASUREMENTS      # 300

# FROZEN. Not adjusted anywhere in this file.
THRESHOLDS = {"mean_overhead_pct": 2.0, "worst_case_overhead_pct": 10.0,
              "median_deviation_pct": 2.0}

FORBIDDEN = ["g7-campaign", "g7cam", "reports", "records", ".jsonl",
             "evidence_manifest", "gate_results", "tiny_dense_2l_weights.bin"]

REPORTED_PATTERNS = {
    "mean_overhead_pct": r"mean_overhead_pct\s*=\s*([-0-9.]+)\s*%",
    "worst_case_overhead_pct": r"worst_case_overhead_pct\s*=\s*([-0-9.]+)\s*%",
    "median_deviation_pct": r"median_deviation_pct\s*=\s*([-0-9.]+)\s*%",
}


def validate_run(run_dir, verbose=True, stdout_override=None):
    csv_path = run_dir / "paired_samples.csv"
    stdout_path = (pathlib.Path(stdout_override) if stdout_override
                   else run_dir / "ops" / "stdout.txt")
    res = {"run_dir": str(run_dir), "csv": str(csv_path), "checks": {}, "metrics": {},
           "verdict": {},
           "at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")}
    fails = []

    def chk(name, ok, detail=""):
        res["checks"][name] = {"ok": bool(ok), "detail": detail}
        if not ok:
            fails.append(name)
        if verbose:
            print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f"  -- {detail}" if detail else ""))

    if not csv_path.is_file():
        res["fatal"] = f"CSV not found: {csv_path}"
        fails.append("csv_exists")
        if verbose:
            print(f"[FAIL] csv_exists -- {res['fatal']}")
        res["failed_checks"] = fails
        res["structural_pass"] = False
        return res

    raw = csv_path.read_bytes()
    res["csv_bytes"] = len(raw)
    res["csv_sha256"] = hashlib.sha256(raw).hexdigest()
    text = raw.decode("utf-8")
    lines = text.splitlines()

    # ---- structure ----
    rows = list(csv.DictReader(text.splitlines()))
    with open(csv_path, newline="", encoding="utf-8") as f:
        hdr = next(csv.reader(f))

    chk("csv_non_empty", len(raw) > 0, f"{len(raw)} bytes")
    chk("header_exact", hdr == EXPECTED_HEADER, f"header={hdr}")
    chk("exactly_300_data_rows", len(rows) == EXPECTED_ROWS, f"data rows={len(rows)}")
    chk("total_lines_301_incl_header", len(lines) == 301, f"lines={len(lines)}")

    keys = [(int(r["replicate"]), int(r["iteration"])) for r in rows]
    expected_keys = {(r, i) for r in range(EXPECTED_REPLICATES)
                     for i in range(EXPECTED_MEASUREMENTS)}
    chk("pair_keys_unique", len(set(keys)) == len(keys), f"unique={len(set(keys))}")
    chk("pair_keys_exact_set", set(keys) == expected_keys,
        f"missing={len(expected_keys - set(keys))} extra={len(set(keys) - expected_keys)}")
    counts = {}
    for r, _ in keys:
        counts[r] = counts.get(r, 0) + 1
    chk("per_replicate_counts_50",
        all(v == 50 for v in counts.values()) and sorted(counts) == list(range(EXPECTED_REPLICATES)),
        f"counts={dict(sorted(counts.items()))}")

    # ---- numerics ----
    mn = [float(r["minimal_sec"]) for r in rows]
    ins = [float(r["instrumented_sec"]) for r in rows]
    pct = [float(r["signed_overhead_pct"]) for r in rows]
    chk("all_values_finite", all(math.isfinite(v) for v in mn + ins + pct))
    chk("minimal_sec_positive", all(v > 0.0 for v in mn))
    chk("instrumented_sec_positive", all(v > 0.0 for v in ins))
    bad = [i for i, (a, b, p) in enumerate(zip(mn, ins, pct))
           if abs(p - 100.0 * (b - a) / a) > 1e-6 * max(1.0, abs(p))]
    chk("row_formula_pct_matches", not bad, f"violations={len(bad)}")

    # ---- frozen metric recomputation (CSV bytes only) ----
    mean_min, mean_ins = statistics.fmean(mn), statistics.fmean(ins)
    mean_overhead = 100.0 * (mean_ins - mean_min) / mean_min
    worst = max(100.0 * (b - a) / a for a, b in zip(mn, ins))
    med_min, med_ins = statistics.median(mn), statistics.median(ins)
    median_dev = 100.0 * abs(med_ins - med_min) / med_min

    res["metrics"] = {
        "n_samples_per_condition": len(mn),
        "mean_minimal_us": round(mean_min * 1e6, 6),
        "mean_instrumented_us": round(mean_ins * 1e6, 6),
        "median_minimal_us": round(med_min * 1e6, 6),
        "median_instrumented_us": round(med_ins * 1e6, 6),
        "mean_overhead_pct": round(mean_overhead, 6),
        "worst_case_overhead_pct": round(worst, 6),
        "median_deviation_pct": round(median_dev, 6),
        # descriptive extras (NOT calibration metrics)
        "pooled_std_minimal_us": round(statistics.pstdev(mn) * 1e6, 3),
        "pooled_std_instrumented_us": round(statistics.pstdev(ins) * 1e6, 3),
        "min_pair_overhead_pct": round(min(100.0 * (b - a) / a for a, b in zip(mn, ins)), 6),
        "count_pairs_over_10pct": sum(1 for a, b in zip(mn, ins)
                                      if 100.0 * (b - a) / a > 10.0),
    }

    # ---- independent cross-check against this run's own stdout ----
    if stdout_path.is_file():
        rep = stdout_path.read_text(encoding="utf-8", errors="replace")
        for k, pat in REPORTED_PATTERNS.items():
            m = re.search(pat, rep)
            if m:
                reported = float(m.group(1))
                res.setdefault("reported", {})[k] = reported
                chk(f"recomputed_matches_reported_{k}",
                    abs(res["metrics"][k] - reported) < 0.0002,
                    f"recomputed={res['metrics'][k]} reported={reported}")
            else:
                chk(f"reported_{k}_parsed", False, "metric line not found in stdout")
    else:
        chk("stdout_available", False, f"missing {stdout_path}")

    # ---- path/content hygiene ----
    chk("no_forbidden_marker_in_path",
        not any(f in str(csv_path).lower() for f in FORBIDDEN))
    chk("no_forbidden_marker_in_contents",
        not any(f in text.lower() for f in FORBIDDEN))

    # ---- FROZEN thresholds, unchanged ----
    mean_ok = abs(mean_overhead) <= THRESHOLDS["mean_overhead_pct"]
    worst_ok = worst <= THRESHOLDS["worst_case_overhead_pct"]
    med_ok = median_dev <= THRESHOLDS["median_deviation_pct"]
    res["verdict"] = {
        "threshold_mean_le_2pct": {"value": round(mean_overhead, 4), "ok": mean_ok},
        "threshold_worst_le_10pct": {"value": round(worst, 4), "ok": worst_ok},
        "threshold_median_dev_le_2pct": {"value": round(median_dev, 4), "ok": med_ok},
        "calibration_status": "PASS" if (mean_ok and worst_ok and med_ok) else "FAIL",
        "thresholds_used": THRESHOLDS,
        "note": "reported per run; the diagnostic's own verdict is not altered",
    }
    # Threshold results are recorded in verdict ONLY: a legitimate calibration
    # FAIL is a RESULT of the run, not a defect in the artifact. Counting it as
    # a structural failure would misreport valid data as malformed.
    if verbose:
        print(f"[THRESHOLD] mean_overhead_pct       {mean_overhead:.4f} %  <= 2      -> "
              f"{'OK' if mean_ok else 'NOT OK'}")
        print(f"[THRESHOLD] worst_case_overhead_pct {worst:.4f} %  <= 10     -> "
              f"{'OK' if worst_ok else 'NOT OK'}")
        print(f"[THRESHOLD] median_deviation_pct    {median_dev:.4f} %  <= 2      -> "
              f"{'OK' if med_ok else 'NOT OK'}")

    res["failed_checks"] = fails
    res["structural_pass"] = not fails
    return res


def write_run_outputs(run_dir, res, out_dir=None):
    ops = pathlib.Path(out_dir) if out_dir else run_dir / "ops"
    ops.mkdir(parents=True, exist_ok=True)
    (ops / "validation.json").write_text(json.dumps(res, indent=2), encoding="utf-8")
    m = res.get("metrics", {})
    v = res.get("verdict", {})
    txt = [
        "=" * 78,
        f"PHASE 19 PER-RUN VALIDATION  {run_dir.name}",
        "=" * 78,
        f"csv                 : {res.get('csv')}",
        f"csv sha256          : {res.get('csv_sha256')}",
        f"structural checks   : {'PASS' if res.get('structural_pass') else 'FAIL'}"
        f" ({len(res.get('checks', {}))} checks, {len(res.get('failed_checks', []))} failed)",
        f"failed checks       : {res.get('failed_checks')}",
        "  (calibration thresholds are reported below and are NOT structural checks)",
        "",
        "FROZEN METRICS (recomputed from CSV bytes)   [threshold]",
        f"  mean_overhead_pct       = {m.get('mean_overhead_pct')}   [<= 2.0]",
        f"  worst_case_overhead_pct = {m.get('worst_case_overhead_pct')}   [<= 10.0]",
        f"  median_deviation_pct    = {m.get('median_deviation_pct')}   [<= 2.0]",
        "",
        "DESCRIPTIVE (not calibration metrics)",
        f"  pooled median minimal/instrumented us : {m.get('median_minimal_us')} / {m.get('median_instrumented_us')}",
        f"  pooled stdev minimal/instrumented us  : {m.get('pooled_std_minimal_us')} / {m.get('pooled_std_instrumented_us')}",
        f"  min pair overhead %                   : {m.get('min_pair_overhead_pct')}",
        f"  pairs over 10%                        : {m.get('count_pairs_over_10pct')} / 300",
        "",
        f"CALIBRATION VERDICT : {v.get('calibration_status')}",
        "=" * 78,
    ]
    (ops / "validation_report.txt").write_text("\n".join(txt) + "\n", encoding="utf-8")
    return ops


def collect(runs_base=None):
    base = pathlib.Path(runs_base) if runs_base else RUNS_BASE
    out = []
    if not base.is_dir():
        return out
    for d in sorted(base.iterdir()):
        vp = d / "ops" / "validation.json"
        mp = d / "ops" / "exec_meta.json"
        if not vp.is_file():
            continue
        v = json.loads(vp.read_text(encoding="utf-8"))
        m = json.loads(mp.read_text(encoding="utf-8")) if mp.is_file() else {}
        out.append({"run": d.name, "validation": v, "meta": m})
    return out


def compare(runs_base=None):
    base = pathlib.Path(runs_base) if runs_base else RUNS_BASE
    runs = collect(runs_base)
    if not runs:
        print("no validated runs found under", base)
        return 2

    rows = []
    for r in runs:
        m, meta = r["validation"].get("metrics", {}), r["meta"]
        rows.append({
            "run": r["run"],
            "order": meta.get("order"),
            "condition": meta.get("condition"),
            "mask_intended": (meta.get("launch") or {}).get("mask_intended"),
            "mask_cpus": (meta.get("launch") or {}).get("mask_cpus"),
            "affinity_verified_before_resume":
                (meta.get("launch") or {}).get("affinity_verified_before_resume"),
            "exit_code": (meta.get("launch") or {}).get("exit_code"),
            "csv_sha256": r["validation"].get("csv_sha256"),
            "mean_overhead_pct": m.get("mean_overhead_pct"),
            "worst_case_overhead_pct": m.get("worst_case_overhead_pct"),
            "median_deviation_pct": m.get("median_deviation_pct"),
            "pairs_over_10pct": m.get("count_pairs_over_10pct"),
            "pooled_std_minimal_us": m.get("pooled_std_minimal_us"),
            "calibration_status": r["validation"].get("verdict", {}).get("calibration_status"),
        })

    def spread(cond, key):
        vals = sorted(x[key] for x in rows if x["condition"] == cond and x[key] is not None)
        if not vals:
            return None
        return {"n": len(vals), "values": vals, "min": vals[0], "max": vals[-1],
                "range": round(vals[-1] - vals[0], 6),
                "median": round(statistics.median(vals), 6)}

    summary = {
        "at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "runs": rows,
        "per_condition_spread": {
            c: {k: spread(c, k) for k in
                ("mean_overhead_pct", "worst_case_overhead_pct", "median_deviation_pct",
                 "pairs_over_10pct", "pooled_std_minimal_us")}
            for c in ("unpinned", "pinned")
        },
        "IMPORTANT": [
            "This is a DESCRIPTIVE comparison of six independent runs. It is NOT a",
            "pooled calibration result and must not be presented as one.",
            "n=3 per condition gives very limited statistical power: with 3 values a",
            "range is a weak dispersion estimate and no significance claim is made.",
            "The frozen thresholds are applied PER RUN, unchanged, in each run's own",
            "validation.json. No outlier is removed from any run.",
        ],
    }
    base.mkdir(parents=True, exist_ok=True)
    (base / "comparison.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")

    def fmt_cpus(c):
        if not c:
            return "n/a"
        if len(c) > 4:
            return f"all({len(c)})"
        return ",".join(str(i) for i in c)

    lines = ["=" * 96, "PHASE 19 - SIX INDEPENDENT RUNS (descriptive; NOT pooled)", "=" * 96,
             f"{'run':<8}{'ord':<5}{'condition':<11}{'mask':<7}{'cpu':<9}"
             f"{'mean%':>11}{'worst%':>11}{'meddev%':>11}{'>10%':>7}{'verdict':>9}"]
    for x in sorted(rows, key=lambda z: (z["order"] if z["order"] is not None else 99)):
        lines.append(
            f"{x['run']:<8}{str(x['order']):<5}{str(x['condition']):<11}"
            f"{hex(x['mask_intended']) if isinstance(x['mask_intended'], int) else 'none':<7}"
            f"{fmt_cpus(x['mask_cpus']):<9}"
            f"{x['mean_overhead_pct']:>11}{x['worst_case_overhead_pct']:>11}"
            f"{x['median_deviation_pct']:>11}{x['pairs_over_10pct']:>7}"
            f"{x['calibration_status']:>9}")
    lines += ["", "per-condition spread (n=3 each; weak dispersion estimate)"]
    for c, d in summary["per_condition_spread"].items():
        for k, s in d.items():
            if s:
                lines.append(f"  {c:<9} {k:<26} min={s['min']:<12} max={s['max']:<12} range={s['range']}")
    lines += ["", *summary["IMPORTANT"], "=" * 96]
    (base / "comparison_report.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))
    return 0


def main():
    ap = argparse.ArgumentParser(description="Phase 19 per-run CSV validation")
    ap.add_argument("--run-dir")
    ap.add_argument("--compare", action="store_true")
    ap.add_argument("--stdout", help="override the stdout.txt cross-check source")
    ap.add_argument("--out-dir", help="override where validation outputs are written")
    ap.add_argument("--runs-base", help="override the run collection root (for --compare)")
    a = ap.parse_args()
    if a.compare:
        return compare(runs_base=a.runs_base)
    if not a.run_dir:
        ap.error("--run-dir or --compare is required")
    rd = pathlib.Path(a.run_dir)
    if not rd.is_absolute():
        rd = ROOT / rd
    so = a.stdout
    if so and not pathlib.Path(so).is_absolute():
        so = ROOT / so
    res = validate_run(rd, stdout_override=so)
    write_run_outputs(rd, res, out_dir=a.out_dir)
    m = res.get("metrics", {})
    print(f"structural: {'PASS' if res.get('structural_pass') else 'FAIL'} "
          f"({len(res.get('checks', {}))} checks, {len(res.get('failed_checks', []))} failed)")
    print(f"calibration verdict: {res.get('verdict', {}).get('calibration_status')} "
          f"mean={m.get('mean_overhead_pct')}% worst={m.get('worst_case_overhead_pct')}% "
          f"median_dev={m.get('median_deviation_pct')}%")
    return 0 if res.get("structural_pass") else 2


if __name__ == "__main__":
    sys.exit(main())
