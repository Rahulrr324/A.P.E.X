#!/usr/bin/env python3
"""Read-only structural analysis of the EXISTING g7-campaign-affinityfix records.

Nothing is modified; no campaign is rerun. For every record:
  - chronological order, independent-run index, idle-gap flag (>=29s since the
    previous record's created_utc)
  - within-run sample shape: CV, first/last, first10 vs last10 median,
    spike count (>1.5x median), timer quantization, band occupancy
  - cluster assignment per benchmark
Also prints idle-gap contingency and inferred-frequency ratios (LABELED as
inference from timing — never as measured frequency).
"""
import json
import math
import statistics
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

d = sys.argv[1] if len(sys.argv) > 1 else "build/g7-campaign-affinityfix"
files = sorted(p for p in Path(d).glob("*.json"))

recs = []
for p in files:
    r = json.loads(p.read_text())
    st = r.get("statistics") or {}
    samples = st.get("samples") or []
    ts = r.get("created_utc", "")
    recs.append({
        "file": p.name,
        "id": r.get("record_id"),
        "exp": r.get("experiment_id"),
        "bench": r.get("configuration", {}).get("benchmark_id"),
        "ts": ts,
        "t": datetime.strptime(ts, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc),
        "median_us": (st.get("median") or 0) * 1e6,
        "samples": [s * 1e6 for s in samples],
        "run_suffix": (r.get("provenance") or {}).get("run_suffix"),
    })
recs.sort(key=lambda x: x["t"])

def med(v):
    v = sorted(v)
    n = len(v)
    if n == 0: return float("nan")
    return v[n // 2] if n % 2 else 0.5 * (v[n // 2 - 1] + v[n // 2])

# idle-gap flags
gap = [False] * len(recs)
for i, r in enumerate(recs):
    if i == 0:
        r["gap"] = None  # unknown: process start
        continue
    dt = (r["t"] - recs[i - 1]["t"]).total_seconds()
    r["gap"] = dt >= 29.0
    r["gap_s"] = dt

print("=== chronological records ===")
print(f"{'#':>2} {'created':26} {'bench':4} {'exp':3} {'gap?':>5} {'dt_s':>6} {'median':>8} {'cv%':>6} "
      f"{'first':>8} {'last':>8} {'f10med':>8} {'l10med':>8} {'spk':>3} {'q_ns':>7} bands")
for i, r in enumerate(recs):
    s = r["samples"]
    n = len(s)
    m = r["median_us"]
    mean = statistics.fmean(s) if s else float("nan")
    sd = statistics.pstdev(s) if n > 1 else 0.0
    cv = sd / mean * 100 if mean else 0
    f10, l10 = med(s[:10]), med(s[-10:])
    spk = sum(1 for v in s if v > 1.5 * m)
    ss = sorted(s)
    deltas = [b - a for a, b in zip(ss, ss[1:]) if b - a > 1e-9]
    q = min(deltas) if deltas else float("nan")
    # band occupancy per benchmark
    bands = ""
    if r["bench"] in ("B6", "B9"):
        b = [("<200" if v < 200 else "200-250" if v <= 250 else ">250") for v in s]
    else:
        b = [("<3100" if v < 3100 else ">=3100") for v in s]
    bc = Counter(b)
    bands = " ".join(f"{k}:{c}" for k, c in sorted(bc.items()))
    gapstr = "?" if r["gap"] is None else ("GAP" if r["gap"] else ".")
    dt = r.get("gap_s", -1)
    print(f"{i:>2} {r['ts']:26} {r['bench']:4} {r['exp']:3} {gapstr:>5} {dt:>6.1f} {m:>8.2f} {cv:>6.2f} "
          f"{s[0]:>8.2f} {s[-1]:>8.2f} {f10:>8.2f} {l10:>8.2f} {spk:>3} {q*1000:>7.1f} {bands}")

# cluster definitions (from observed data, descriptive)
def cluster(r):
    m = r["median_us"]
    if r["bench"] in ("B6", "B9"):
        if m < 200: return "A_fast(~180us)"
        if m <= 250: return "B_mid(~221us)"
        return "C_slow(>300us)"
    if r["bench"] == "B7":
        return "L(~2900-3000)" if m < 3100 else "H(~3200-3342)"
    return "?"

print("\n=== cluster x idle-gap contingency ===")
rows = {}
for r in recs:
    g = "start" if r["gap"] is None else ("post-gap" if r["gap"] else "within-run")
    rows.setdefault((r["bench"], cluster(r)), {"post-gap": 0, "within-run": 0, "start": 0})[g] += 1
for (bench, cl), cnt in sorted(rows.items()):
    print(f"{bench} {cl:16} post-gap={cnt['post-gap']} within-run={cnt['within-run']} process-start={cnt['start']}")

print("\n=== post-gap records (first exec after >=29s idle) ===")
for i, r in enumerate(recs):
    if r["gap"] is True:
        print(f"  #{i} {r['bench']} {r['exp']} median={r['median_us']:.2f}us cluster={cluster(r)}")

print("\n=== within-run band occupancy (bimodal run => mid-run state transition) ===")
for r in recs:
    s = r["samples"]
    if r["bench"] in ("B6", "B9"):
        c = Counter(("<200" if v < 200 else "200-250" if v <= 250 else ">250") for v in s)
    else:
        c = Counter(("<3100" if v < 3100 else ">=3100") for v in s)
    if len(c) > 1:
        print(f"  MIXED {r['bench']} {r['exp']} {r['id']}: {dict(c)}")
print("  (no MIXED lines above => every run occupied exactly one band for its whole window)")

# inferred-frequency ratios (INFERENCE FROM TIMING — not measured)
print("\n=== inferred frequency ratios (INFERENCE from timing, constant-work assumption) ===")
for bench, ref_band in (("B6", "A_fast(~180us)"), ("B9", "A_fast(~180us)")):
    groups = {}
    for r in recs:
        if r["bench"] == bench:
            groups.setdefault(cluster(r), []).append(r["median_us"])
    ref_min = min(groups.get(ref_band, [1])) if ref_band in groups else min(min(v) for v in groups.values())
    for cl, vals in sorted(groups.items()):
        gm = statistics.geometric_mean(vals)
        print(f"  {bench} {cl:16} geometric-mean-median={gm:8.2f}us  inferred_f_ratio_vs_fastest={ref_min/gm:.3f}x")
print("  (ratios assume identical work per exec — INFERENCE, not telemetry)")

print("\n=== per-run independent-run summary (run_suffix groups) ===")
order, groups = [], {}
for r in recs:
    k = r["run_suffix"]
    if k not in groups:
        groups[k] = []; order.append(k)
    groups[k].append(r)
for i, k in enumerate(order, 1):
    for r in groups[k]:
        print(f"  run{i} {r['bench']:3} {r['exp']:3} median={r['median_us']:8.2f} cluster={cluster(r)} gap={r['gap']}")
