#!/usr/bin/env python3
"""APEX M0 v2.2 — independent G7 recomputation.

Reads raw records only (no v2.1 summary files) and recomputes:
  - stored vs recomputed median (production convention: pos = 0.5*(n-1), linear interp)
  - mean / min / max / stdev (sample, n-1) / CV% / MAD
  - config-group all-pairs symmetric relative diff%  = |a-b|/max(|a|,|b|)*100
    with production tolerances (15% timing, 20% B3/B5)
"""
import json, glob, os, math, statistics as st

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
AGG = os.path.join(ROOT, "..", "archive_recovery", "aggregator_input")
DIAG = os.path.join(ROOT, "..", "archive_recovery", "v21_diagnostics")


def median_pos(s):
    a = sorted(s); n = len(a)
    if n == 0: return float("nan")
    if n == 1: return a[0]
    pos = 0.5 * (n - 1)
    lo = int(pos); hi = min(lo + 1, n - 1); frac = pos - lo
    return a[lo] + frac * (a[hi] - a[lo])


def sym(a, b):
    if a == 0 and b == 0: return 0.0
    if a == 0 or b == 0: return 100.0
    return abs(a - b) / max(abs(a), abs(b)) * 100.0


def load_dir(d):
    out = []
    for f in sorted(glob.glob(os.path.join(d, "*.json"))):
        with open(f) as fh:
            out.append(json.load(fh))
    return out


def cfg_key(r):
    return json.dumps(r.get("configuration"), sort_keys=True)


def bench(r):
    c = r.get("configuration") or {}
    return c.get("benchmark_id", "")


print("=" * 100)
print("PART A — the nine recovered historical records")
print("=" * 100)
recs = load_dir(AGG)
print(f"loaded {len(recs)} records from aggregator_input")
hdr = f"{'record_id':22} {'bench':5} {'n':>3} {'stored_med':>12} {'recomp_med':>12} {'mean':>12} {'min':>10} {'max':>10} {'stdev_s':>10} {'stdev_p':>10} {'CV%':>7} {'MAD':>9}"
print(hdr)
for r in recs:
    s = (r.get("statistics") or {})
    samples = s.get("samples")
    if not samples:
        print(f"{r['record_id']:22} NO SAMPLES")
        continue
    n = len(samples)
    rm = median_pos(samples)
    mean = sum(samples) / n
    sd_s = st.stdev(samples) if n > 1 else 0.0
    sd_p = st.pstdev(samples)
    cv = sd_s / mean * 100.0
    med = s.get("median")
    mad = median_pos([abs(x - mean) for x in samples])
    # production MAD uses median, not mean. Recompute vs median:
    mad_med = median_pos([abs(x - rm) for x in samples])
    print(f"{r['record_id']:22} {bench(r):5} {n:3d} {med:12.4f} {rm:12.4f} {mean:12.4f} "
          f"{min(samples):10.4f} {max(samples):10.4f} {sd_s:10.4f} {sd_p:10.4f} {cv:7.2f} {mad_med:9.4f}")
    print(f"      stored==recomp: {abs(med-rm) < 1e-9}   report_sd={s.get('stdev')}  report_mean={s.get('mean')}")

print()
print("=" * 100)
print("PART B — historical config-group all-pairs (production metric)")
print("=" * 100)
groups = {}
for r in recs:
    if r.get("status") != "PASSED": continue
    if r.get("kind") not in ("benchmark", "baseline"): continue
    k = cfg_key(r)
    groups.setdefault(k, []).append((r["record_id"], (r["statistics"] or {}).get("median")))
for k, runs in sorted(groups.items(), key=lambda kv: bench(json.loads('{"configuration":%s}' % kv[0]))):
    b = bench({"configuration": json.loads(k)})
    allowed = 20.0 if b in ("B3", "B5") else 15.0
    fails = 0; total = 0; lines = []
    for i in range(len(runs)):
        for j in range(i + 1, len(runs)):
            d = sym(runs[i][1], runs[j][1]); total += 1
            if d > allowed:
                fails += 1
                lines.append(f"    runs {i+1} & {j+1} ({runs[i][0]} vs {runs[j][0]}): {d:.2f}% > {allowed}%  FAIL")
    print(f"[{b}] group size {len(runs)}  pairs={total}  fails={fails}")
    for l in lines: print(l)
    for idx, (rid, m) in enumerate(runs, 1):
        print(f"    run {idx}: {rid}  median={m}")

print()
print("=" * 100)
print("PART C — fresh diagnostics: config groups, all-pairs, spread")
print("=" * 100)
frecs = load_dir(DIAG)
print(f"loaded {len(frecs)} fresh records")
fgroups = {}
for r in frecs:
    if r.get("status") != "PASSED": continue
    if r.get("kind") not in ("benchmark", "baseline"): continue
    fgroups.setdefault(cfg_key(r), []).append((r["record_id"], (r["statistics"] or {}).get("median")))
for k, runs in sorted(fgroups.items(), key=lambda kv: bench(json.loads('{"configuration":%s}' % kv[0]))):
    b = bench({"configuration": json.loads(k)})
    allowed = 20.0 if b in ("B3", "B5") else 15.0
    meds = [m for _, m in runs]
    spread = (max(meds) - min(meds)) / max(meds) * 100.0
    fails = 0; total = 0
    for i in range(len(meds)):
        for j in range(i + 1, len(meds)):
            total += 1
            if sym(meds[i], meds[j]) > allowed: fails += 1
    print(f"[{b}] group size {len(runs)}  medians={[round(m,2) for m in meds]}")
    print(f"    spread(max-min)/max = {spread:.2f}%   all-pairs fails = {fails}/{total}")
