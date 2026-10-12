#!/usr/bin/env python3
"""
Independent G7 verification (outside the production aggregator).

Reads all STARKP1 records under a directory, groups PASSED benchmark/baseline
records by their serialized configuration, recomputes medians from raw samples,
validates each record's stored median against the recomputed median within the
G7 median-consistency tolerance, and then checks every pair within each group
with the frozen symmetric relative difference formula.

Outputs:
  - per-group statistics (medians, pairwise diffs, max/min spread, dispersion)
  - per-record median validation
  - independent G7 verdict

Tolerances (frozen contract):
  - median consistency: 0.001% relative (G7_MEDIAN_TOLERANCE_PCT)
  - timing groups: 15%
  - bandwidth groups (B3/B5): 20%
"""

import json
import math
import sys
from collections import defaultdict
from pathlib import Path

G7_MEDIAN_TOLERANCE_PCT = 0.001  # frozen median-consistency tolerance
TIMING_TOLERANCE_PCT = 15.0       # frozen G7 timing tolerance
BANDWIDTH_TOLERANCE_PCT = 20.0    # frozen G7 bandwidth tolerance (B3/B5)


def symmetric_rel_diff_pct(x, y):
    """abs(x-y)/max(abs(x),abs(y))*100, with 0/0 -> 0 and one-zero -> 100."""
    if not (math.isfinite(x) and math.isfinite(y)):
        return None
    if x == 0.0 and y == 0.0:
        return 0.0
    if x == 0.0 or y == 0.0:
        return 100.0
    denom = max(abs(x), abs(y))
    if denom == 0.0:
        return 0.0
    return abs(x - y) / denom * 100.0


def recompute_median(samples):
    s = sorted(samples)
    n = len(s)
    if n == 0:
        return float("nan")
    if n == 1:
        return s[0]
    pos = 0.5 * (n - 1)
    lo = int(pos)
    hi = min(lo + 1, n - 1)
    frac = pos - lo
    return s[lo] + frac * (s[hi] - s[lo])


def median_consistency(stored, samples):
    """Return (ok, rel_diff_pct or reason)."""
    if not samples or len(samples) < 10:
        return False, f"insufficient samples ({len(samples)})"
    for i, v in enumerate(samples):
        if not math.isfinite(v):
            return False, f"non-finite sample at index {i}: {v}"
    if not math.isfinite(stored):
        return False, f"non-finite stored median: {stored}"
    recomputed = recompute_median(samples)
    abs_diff = abs(stored - recomputed)
    max_val = max(abs(stored), abs(recomputed))
    rel = (abs_diff / max_val * 100.0) if max_val > 0.0 else 0.0
    if rel > G7_MEDIAN_TOLERANCE_PCT:
        return False, f"stored {stored} != recomputed {recomputed} ({rel:.6f}% > {G7_MEDIAN_TOLERANCE_PCT}%)"
    return True, None


def load_records(directory):
    base = Path(directory)
    records = []
    for p in sorted(base.glob("*.json")):
        try:
            rec = json.loads(p.read_text())
            records.append((p.name, rec))
        except Exception as e:
            print(f"WARN: failed to parse {p.name}: {e}", file=sys.stderr)
    return records


def benchmark_id_of(rec):
    cfg = rec.get("configuration")
    if not isinstance(cfg, dict):
        return None
    b = cfg.get("benchmark_id")
    if not isinstance(b, str):
        return None
    return b


def main():
    if len(sys.argv) < 2:
        print(f"usage: {sys.argv[0]} <record_dir> [aggregator_gate_file]", file=sys.stderr)
        sys.exit(2)
    directory = sys.argv[1]
    aggregator_gate_file = sys.argv[2] if len(sys.argv) > 2 else None

    records = load_records(directory)
    print(f"Loaded {len(records)} JSON records from {directory}")

    # Group PASSED benchmark/baseline records by serialized configuration
    groups = defaultdict(list)          # config_key -> list of (record, parsed)
    bench_of_key = {}
    rejected = []

    for name, rec in records:
        status = rec.get("status")
        if status != "PASSED":
            continue
        kind = rec.get("kind")
        if kind not in ("benchmark", "baseline"):
            continue
        bench = benchmark_id_of(rec)
        if not bench:
            continue
        stats = rec.get("statistics")
        if not isinstance(stats, dict):
            rejected.append((name, bench, "no statistics"))
            continue
        samples = stats.get("samples")
        if not isinstance(samples, list) or len(samples) < 10:
            rejected.append((name, bench, f"insufficient samples ({len(samples) if isinstance(samples,list) else 'none'})"))
            continue
        # Median consistency
        stored_med = stats.get("median")
        ok, reason = median_consistency(stored_med, samples)
        if not ok:
            rejected.append((name, bench, reason))
            continue
        recomputed = recompute_median(samples)
        cfg = rec.get("configuration")
        cfg_key = json.dumps(cfg, sort_keys=True, ensure_ascii=False)
        groups[cfg_key].append((rec, {
            "record_id": rec.get("record_id"),
            "benchmark": bench,
            "experiment_id": rec.get("experiment_id"),
            "samples": samples,
            "stored_median": stored_med,
            "recomputed_median": recomputed,
            "n": len(samples),
        }))
        bench_of_key[cfg_key] = bench

    # Independent per-group computation
    print("\n=== Independent G7 verification ===\n")
    all_pass = True
    group_summary = []

    for cfg_key, runs in groups.items():
        bench = bench_of_key[cfg_key]
        # Deduplicate by record_id
        seen = {}
        for rec, info in runs:
            rid = info["record_id"]
            seen[rid] = info
        unique = list(seen.values())
        medians = [m["recomputed_median"] for m in unique]
        n_runs = len(unique)
        tolerance = BANDWIDTH_TOLERANCE_PCT if bench in ("B3", "B5") else TIMING_TOLERANCE_PCT

        pairwise = []
        for i in range(n_runs):
            for j in range(i + 1, n_runs):
                d = symmetric_rel_diff_pct(medians[i], medians[j])
                if d is None:
                    all_pass = False
                    print(f"FAIL {bench}: non-finite median between runs {i+1} and {j+1}")
                    continue
                pairwise.append((i + 1, j + 1, d))

        if n_runs < 2:
            all_pass = False
            print(f"FAIL {bench}: insufficient independent repeats ({n_runs}); need >=2")
            group_summary.append((bench, cfg_key, unique, pairwise, None, None, None, n_runs, False))
            continue

        diffs = [d for _, _, d in pairwise]
        max_diff = max(diffs) if diffs else None
        min_diff = min(diffs) if diffs else None
        passed = (max_diff is not None) and (max_diff <= tolerance)

        if not passed:
            all_pass = False
            print(f"FAIL {bench}: max pairwise diff {max_diff:.4f}% > {tolerance:.1f}% (n={n_runs}, samples/group shown below)")
        else:
            print(f"PASS {bench}: max pairwise diff {max_diff:.4f}% <= {tolerance:.1f}% (n={n_runs})")

        # Dispersion
        mean_med = sum(medians) / len(medians)
        if len(medians) > 1 and mean_med != 0:
            cv = (math.sqrt(sum((m - mean_med) ** 2 for m in medians) / (len(medians) - 1)) / abs(mean_med)) * 100.0
        else:
            cv = None

        group_summary.append((bench, cfg_key, unique, pairwise, max_diff, min_diff, cv, n_runs, passed))

        # Detail table
        print(f"  benchmark={bench}  config_key={cfg_key[:90]}...")
        cv_str = f"{cv:.2f}%" if cv is not None else "n/a"
        print(f"  runs={n_runs}  tolerance={tolerance}%  max_diff={max_diff:.4f}%  min_diff={min_diff:.4f}%  cv={cv_str}")
        for m in unique:
            print(f"    {m['record_id']}  exp={m['experiment_id']}  n={m['n']}  "
                  f"median={m['recomputed_median']*1e6:.4f}us  stored={m['stored_median']*1e6:.4f}us")
        for i, j, d in pairwise:
            print(f"    pair ({i},{j}): {d:.4f}%")
        print()

    # Rejected records
    if rejected:
        print("=== Rejected records (median validation) ===")
        for name, bench, reason in rejected:
            print(f"  {name}  bench={bench}  reason={reason}")
        print()
        all_pass = False

    # Independent verdict
    independent_verdict = "PASS" if all_pass else "FAIL"
    print(f"=== Independent G7 verdict: {independent_verdict} ===\n")

    # Compare with aggregator if provided. Accept aggregator outputs that are
    # either a flat gate list or a wrapper with a "gates" key (the campaign dump
    # wrote aggregator_g7.json as the raw stdout text, which may be either form).
    if aggregator_gate_file:
        try:
            raw = Path(aggregator_gate_file).read_text()
            agg = json.loads(raw)
            gates = agg.get("gates", None)
            if gates is None and isinstance(agg, list):
                gates = agg
            agg_g7 = None
            if isinstance(gates, list):
                for g in gates:
                    if isinstance(g, dict) and g.get("gate", "").startswith("G7"):
                        agg_g7 = g
                        break
            if agg_g7 is None:
                print("WARN: no G7 gate found in aggregator output", file=sys.stderr)
            else:
                agg_pass = bool(agg_g7.get("pass", False))
                print(f"Aggregator G7: pass={agg_pass}")
                print(f"Independent G7: pass={all_pass}")
                if agg_pass == all_pass:
                    print("AGREE: aggregator and independent calculator match")
                else:
                    print("MISMATCH: aggregator and independent calculator disagree")
                    sys.exit(3)
        except Exception as e:
            print(f"WARN: failed to read aggregator gate file: {e}", file=sys.stderr)

    # Summary table
    print("\n=== Group summary ===")
    print(f"{'benchmark':8} {'n_runs':7} {'tolerance':10} {'max_diff':10} {'min_diff':10} {'cv%':9} verdict")
    for bench, cfg_key, unique, pairwise, max_diff, min_diff, cv, n_runs, passed in group_summary:
        tol = BANDWIDTH_TOLERANCE_PCT if bench in ("B3", "B5") else TIMING_TOLERANCE_PCT
        md = f"{max_diff:.4f}%" if max_diff is not None else "n/a"
        mnd = f"{min_diff:.4f}%" if min_diff is not None else "n/a"
        cvs = f"{cv:.2f}" if cv is not None else "n/a"
        print(f"{bench:8} {n_runs:<7} {tol:<10.1f} {md:<10} {mnd:<10} {cvs:<9} {'PASS' if passed else 'FAIL'}")

    return 0 if all_pass else 1


if __name__ == "__main__":
    sys.exit(main())
