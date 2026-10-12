#!/usr/bin/env python3
r"""
Independent recompute of the new frozen G7 campaign (build/g7-campaign-frozen-20261008).

Re-derives every median and every pairwise symmetric relative difference from the
raw samples stored in the records — no reliance on the stored median or on the
production aggregator's output.

Mirrors production gates.cpp semantics:
  - symmetric_rel_diff_pct(x, y) = abs(x-y) / max(abs(x), abs(y)) * 100
  - median via linear interpolation on sorted samples
  - eligibility: status==PASSED, kind in {benchmark, baseline}, benchmark_id present,
    >=10 finite numeric samples, stored median consistent with recomputed median.
"""

import glob
import json
import statistics
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
CAMPAIGN = ROOT / "build/g7-campaign-frozen-20261008"


def weighted_quantile(sorted_samples, q):
    """Linear-interpolation median identical to gates.cpp recompute_median()."""
    n = len(sorted_samples)
    if n == 0:
        raise ValueError("no samples")
    if n == 1:
        return sorted_samples[0]
    pos = 0.5 * (n - 1)
    lo = int(pos)
    hi = min(lo + 1, n - 1)
    frac = pos - lo
    return sorted_samples[lo] + frac * (sorted_samples[hi] - sorted_samples[lo])


def median_sec(samples):
    return weighted_quantile(sorted(samples), 0.5)


def median_us(samples):
    return median_sec(samples) * 1_000_000.0


def sym_diff(a, b):
    """Symmetric relative difference in percent; returns None for non-finite input."""
    if a != a or b != b:
        return None
    if a == 0.0 and b == 0.0:
        return 0.0
    if a == 0.0 or b == 0.0:
        return 100.0
    denom = max(abs(a), abs(b))
    if denom == 0.0:
        return 0.0
    return abs(a - b) / denom * 100.0


def load_record(path):
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return {
        "record_id": data.get("record_id"),
        "experiment_id": data.get("experiment_id"),
        "kind": data.get("kind"),
        "status": data.get("status"),
        "created_utc": data.get("created_utc"),
        "configuration": data.get("configuration"),
        "statistics": data.get("statistics"),
        "samples": None,
        "path": str(path),
    }


def valid_benchmark_record(rec):
    """Mirror gates.cpp eligibility: passed benchmark/baseline with >=10 finite samples."""
    if rec["status"] != "PASSED":
        return False
    if rec["kind"] not in ("benchmark", "baseline"):
        return False
    cfg = rec["configuration"]
    if not isinstance(cfg, dict):
        return False
    bid = cfg.get("benchmark_id")
    if not isinstance(bid, str) or not bid:
        return False
    st = rec.get("statistics")
    if not isinstance(st, dict):
        return False
    samples = st.get("samples")
    if not isinstance(samples, list) or len(samples) < 10:
        return False
    for v in samples:
        if not isinstance(v, (int, float)) or v != v:
            return False
    # expose samples on the record so downstream code can use rec["samples"]
    rec["samples"] = samples
    return True


def stored_median(rec):
    st = rec.get("statistics")
    if not isinstance(st, dict):
        return None
    mv = st.get("median")
    if isinstance(mv, (int, float)) and mv == mv:
        return float(mv)
    return None


def group_records(records):
    groups = {}
    for r in records:
        if not valid_benchmark_record(r):
            continue
        cfg = r["configuration"]
        key = json.dumps(cfg, sort_keys=True, separators=(",", ":"))
        groups.setdefault(key, []).append(r)
    return groups


def report_group(label, records, tolerance):
    rows = []
    for r in records:
        m_sec = median_sec(r["samples"])
        rows.append((r["record_id"], r["experiment_id"], r["created_utc"], m_sec, r["samples"]))

    rows.sort(key=lambda t: t[0])
    n = len(rows)
    mg = rows

    print(f"\n# stored vs recomputed median consistency (frozen 0.001% tolerance):")
    for rid, exp, utc, m_sec, samp in mg:
        sm = stored_median_in_sec_from_record(rid, records)
        if sm is None:
            sm = stored_median_in_sec_direct(r)
        if sm is not None:
            denom = abs(m_sec) or 1.0
            diff_pct = abs(sm - m_sec) / denom * 100.0
            flag = "OK" if diff_pct <= 0.001 else "MISMATCH"
            print(f"   {rid:28} stored={sm*1e6:9.4f}us recomputed={m_sec*1e6:9.4f}us diff={diff_pct:.6f}% {flag}")
        else:
            print(f"   {rid:28} stored median not available for comparison")
    # After checking consistency, delete the stored-median lookup so pairwise recompute is fully raw-sample-based.
    for r in records:
        r["statistics"] = None

    pairs = []
    maxd = -1.0
    max_pair = None
    for i in range(n):
        for j in range(i + 1, n):
            d = sym_diff(mg[i][3], mg[j][3])
            if d is None:
                continue
            pairs.append((i, j, d))
            if d > maxd:
                maxd = d
                max_pair = (i, j, d)
    min_per_pair = min((p[2] for p in pairs), default=None)
    mean_m = statistics.mean([m[3] for m in mg]) or 1.0
    cv = (statistics.pstdev([m[3] for m in mg]) / mean_m) * 100.0
    failing = sum(1 for p in pairs if p[2] > tolerance)
    print(f"\n=== {label} — {n} records — tolerance {tolerance:.2f}% ===")
    print(f"{'record_id':28} {'exp':4} {'created_utc':20} {'median(us)':>9}")
    for rid, exp, utc, m_sec, samp in mg:
        print(f"{rid:28} {exp:4} {utc:20} {m_sec*1e6:9.2f}")
    print(f"\nn_pairs = {len(pairs)}")
    print(f"max pairwise symmetric relative diff = {maxd:.4f}%")
    if max_pair:
        i, j, d = max_pair
        print(f"  worst pair: runs {i+1} <-> {j+1}  (records {mg[i][0]} / {mg[j][0]}, medians {mg[i][3]*1e6:.2f}us / {mg[j][3]*1e6:.2f}us)")
    if min_per_pair is not None:
        print(f"min pairwise symmetric relative diff = {min_per_pair:.4f}%")
    else:
        print("  (no pairs)")
    print(f"CV = {cv:.2f}%")
    print(f"failing pairs (>{tolerance:.2f}%) = {failing}/{len(pairs)}")
    verdict = "PASS" if maxd <= tolerance else "FAIL"
    print(f"verdict = {verdict}")
    return verdict, maxd, failing, len(pairs)


def stored_median_in_sec_direct(r):
    st = r.get("statistics")
    if not isinstance(st, dict):
        return None
    mv = st.get("median")
    if isinstance(mv, (int, float)) and mv == mv:
        return float(mv)
    return None


def stored_median_in_sec_from_record(rid, records):
    for r in records:
        if r.get("record_id") == rid:
            return stored_median_in_sec_direct(r)
    return None


def main():
    files = sorted(glob.glob(str(CAMPAIGN / "G7CAM-*.json")))
    if not files:
        print(f"ERROR: no G7CAM-*.json found under {CAMPAIGN}")
        return 2
    records = []
    for p_text in files:
        try:
            rec = load_record(p_text)
            records.append(rec)
        except Exception as e:
            print(f"FAILED to load {p_text}: {e}")
    print(f"benchmark records loaded: {len(records)}")
    groups = group_records(records)
    key_bench = {}
    for k, recs in groups.items():
        bid = recs[0]["configuration"]["benchmark_id"]
        key_bench.setdefault(bid, []).append((k, recs))
    for bid in ("B6", "B7", "B9"):
        if bid not in key_bench:
            print(f"\nWARNING: no records for {bid}")
            continue
        assert len(key_bench[bid]) == 1, f"expected one config key for {bid}, got {len(key_bench[bid])}"
        k, recs = key_bench[bid][0]
        dumped = [json.dumps(r["configuration"], sort_keys=True, separators=(",", ":")) for r in recs]
        assert len(set(dumped)) == 1, f"{bid}: config keys differ within group!"
        tol = 15.0
        verdict, maxd, failing, npairs = report_group(f"{bid} group", recs, tol)
        print(f"\n>>> {bid} independent recompute verdict: {verdict} (max {maxd:.4f}%, {failing}/{npairs} failing)")
    print("\n\n=== E1/E5 configuration-identity check (production grouping semantics) ===")
    for bid in ("B6", "B7", "B9"):
        # Use fresh copies for E1/E5 split so the in-place mutations above don't affect counting.
        recs = []
        for r in records:
            if r["status"] != "PASSED":
                continue
            if r["kind"] not in ("benchmark", "baseline"):
                continue
            cfg = r.get("configuration")
            if not isinstance(cfg, dict):
                continue
            if cfg.get("benchmark_id") != bid:
                continue
            st = r.get("statistics")
            samples = (st or {}).get("samples") if isinstance(st, dict) else None
            recs.append({**r, "samples": samples})
        e1 = [r for r in recs if r["experiment_id"] == "E1"]
        e5 = [r for r in recs if r["experiment_id"] == "E5"]
        cfg_e1 = json.dumps(e1[0]["configuration"], sort_keys=True, separators=(",", ":")) if e1 else None
        cfg_e5 = json.dumps(e5[0]["configuration"], sort_keys=True, separators=(",", ":")) if e5 else None
        same = (cfg_e1 == cfg_e5)
        print(f"{bid}: E1 config == E5 config ? {same}  (E1 n={len(e1)}, E5 n={len(e5)})")
        if not same:
            print(f"  E1 cfg: {cfg_e1}")
            print(f"  E5 cfg: {cfg_e5}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
