#!/usr/bin/env python3
"""Correlate frequency/power-state telemetry with benchmark timing (read-only).

Joins each diagnostic exec with:
  - PDH observed counters taken immediately before/after the exec
    (% Processor Performance vs nominal, Processor Frequency MHz, % Utility)
  - NT CallNtPowerInformation snapshots (OS-reported current MHz / limit)
  - background timeline samples inside/near the exec window
  - idle-state telemetry (timeline in the last 5 s before a gap exec)
  - whether the exec immediately followed the 30 s idle gap

Frequencies are printed with their provenance label; nothing is inferred from
timing here (inference is a separate, labeled step).
"""
import json
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

path = sys.argv[1] if len(sys.argv) > 1 else \
    "reports/g7-campaign-affinityfix/frequency_evidence.json"
doc = json.loads(Path(path).read_text())

stat = doc.get("static", {})
execs = doc.get("execs", [])
timeline = doc.get("timeline", [])

def pt(s):
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)

print("=== static / provenance-labeled environment ===")
print(f"  nominal registry ~MHz          = {stat.get('nominal_registry_mhz')}")
print(f"  nominal CPUID brand            = {stat.get('nominal_cpuid_brand')}")
ps = stat.get("power_scheme", {})
print(f"  OS power scheme                = {ps.get('os_reported_scheme_name')} ({ps.get('os_reported_scheme_guid')})")
ca = stat.get("counters_available", {})
print(f"  counters available             = {json.dumps(ca)}")
nt0 = stat.get("nt_at_start", {}).get("per_cpu", [])
if nt0:
    c0 = nt0[0]
    print(f"  NT @start cpu0: max={c0['os_reported_max_mhz']}MHz current={c0['os_reported_current_mhz']}MHz limit={c0['os_reported_mhz_limit']}MHz")
aff = stat.get("affinity_at_start", {})
print(f"  affinity: verified={aff.get('verified_single_cpu')} effective={aff.get('effective_logical_cpus')} raw_mask={aff.get('raw_process_mask')}")

# timeline levels observed
lv = sorted({round(s.get("observed_pct_perf_cpu0"), 1)
             for s in timeline if s.get("observed_pct_perf_cpu0") is not None})
print(f"  distinct observed %perf(cpu0) levels in timeline (rounded 0.1): {lv}")
temps = [s.get("observed_thermal_c") for s in timeline if s.get("observed_thermal_c") is not None]
if temps:
    print(f"  observed thermal: min={min(temps):.1f}C max={max(temps):.1f}C first={temps[0]:.1f}C last={temps[-1]:.1f}C")

def nearest_after(t):
    cand = [s for s in timeline if pt(s["utc"]) >= t]
    return min(cand, key=lambda s: pt(s["utc"])) if cand else None

def window_stats(t0, t1):
    """Samples whose 100ms interval ENDS inside [t0,t1] (partial overlap,
    mostly pre-exec time — labeled partial)."""
    vals, freqs = [], []
    for s in timeline:
        ts = pt(s["utc"])
        if t0 <= ts <= t1:
            if s.get("observed_pct_perf_cpu0") is not None:
                vals.append(s["observed_pct_perf_cpu0"])
            if s.get("observed_freq_mhz_cpu0") is not None:
                freqs.append(s["observed_freq_mhz_cpu0"])
    return vals, freqs

def covering_stats(t0, t1, period_ms=100):
    """Samples whose 100ms averaging interval fully contains the exec window:
    sample time t in [t1, t0 + period_ms]. Each such value is an observed
    %perf average over an interval that includes the ENTIRE exec (loaded)."""
    from datetime import timedelta
    vals = []
    for s in timeline:
        ts = pt(s["utc"])
        if t1 <= ts <= t0 + timedelta(milliseconds=period_ms):
            if s.get("observed_pct_perf_cpu0") is not None:
                vals.append((s["utc"], s["observed_pct_perf_cpu0"],
                             s.get("observed_freq_mhz_cpu0")))
    return vals

def idle_tail(t, secs=5):
    vals = []
    for s in timeline:
        ts = pt(s["utc"])
        if t - __import__("datetime").timedelta(seconds=secs) <= ts < t:
            if s.get("observed_pct_perf_cpu0") is not None:
                vals.append(s["observed_pct_perf_cpu0"])
    return vals

print("\n=== per-exec telemetry correlation (frequencies labeled by provenance) ===")
print(f"{'#':>2} {'bench':4} {'gap':>4} {'median_us':>9} | "
      f"{'obs%%perf before':>15} {'after':>7} {'win_n':>5} | "
      f"{'obsMHz before':>12} {'after':>6} | {'osCurMHz b/a':>13} {'osLimit':>7} | {'util% a':>7} {'tempC':>6}")
rows = []
for i, e in enumerate(execs):
    t0, t1 = pt(e["t_start_utc"]), pt(e["t_end_utc"])
    pb, pa = e["pdh_before"], e["pdh_after"]
    nb = e["nt_before"].get("per_cpu", [{}])[0] if e["nt_before"].get("ok") else {}
    na = e["nt_after"].get("per_cpu", [{}])[0] if e["nt_after"].get("ok") else {}
    wv, wf = window_stats(t0, t1)
    cov = covering_stats(t0, t1)
    gap = "GAP" if e["after_idle_gap"] else "."
    cov_str = ",".join(f"{v:.1f}" for _, v, _ in cov) if cov else "-"
    print(f"{i:>2} {e['bench']:4} {gap:>4} {e.get('median_us', float('nan')):9.2f} | "
          f"{str(pb.get('observed_pct_perf_cpu0')):>15} {str(pa.get('observed_pct_perf_cpu0')):>7} {len(wv):>5} | "
          f"{str(pb.get('observed_freq_mhz_cpu0')):>12} {str(pa.get('observed_freq_mhz_cpu0')):>6} | "
          f"{str(nb.get('os_reported_current_mhz'))}/{str(na.get('os_reported_current_mhz')):>6} "
          f"{str(nb.get('os_reported_mhz_limit')):>7} | "
          f"{str(pa.get('observed_pct_util_cpu0')):>7} {str(pa.get('observed_thermal_c')):>6}")
    print(f"    covering-sample observed %%perf (100ms interval containing ENTIRE exec): "
          f"{cov_str}" + ("  <-- exec-load observed frequency" if cov else ""))
    it = idle_tail(t0)
    rows.append({
        "i": i, "bench": e["bench"], "gap": e["after_idle_gap"],
        "median": e.get("median_us"),
        "perf_before": pb.get("observed_pct_perf_cpu0"),
        "perf_after": pa.get("observed_pct_perf_cpu0"),
        "freq_before": pb.get("observed_freq_mhz_cpu0"),
        "freq_after": pa.get("observed_freq_mhz_cpu0"),
        "os_before": nb.get("os_reported_current_mhz"),
        "os_after": na.get("os_reported_current_mhz"),
        "limit": nb.get("os_reported_mhz_limit"),
        "idle_tail_perf": (statistics.mean(it) if it else None),
        "win": wv, "cv_win": (statistics.pstdev(wv) / statistics.fmean(wv) * 100 if len(wv) > 1 else None),
        "covering": [(v) for _, v, _ in cov],
        "wall_s": e.get("wall_s"),
        "cpu_util": e.get("thread_cpu_util_pct"),
        "f10": e.get("first10_median_us"), "l10": e.get("last10_median_us"),
        "spk": e.get("samples_gt_150pct_median"),
        "nt_before": nb, "nt_after": na,
    })

print("\n=== idle-state telemetry (timeline in last 5s before each GAP exec) ===")
for r in rows:
    if r["gap"]:
        print(f"  exec#{r['i']} {r['bench']}: idle_tail_obs_pct_perf = {r['idle_tail_perf']}")

print("\n=== B6 detail (fast vs slow median vs observed state) ===")
for r in rows:
    if r["bench"] == "B6":
        print(f"  exec#{r['i']} gap={r['gap']} median={r['median']:.2f}us "
              f"obs%perf(before->{r['perf_before']}, after->{r['perf_after']}) "
              f"obsMHz(before->{r['freq_before']}, after->{r['freq_after']}) "
              f"osMHz(before->{r['os_before']}, after->{r['os_after']}) limit={r['limit']} "
              f"first10={r['f10']:.1f} last10={r['l10']:.1f} cpu_util={r['cpu_util']:.1f}%")

print("\n=== association: median vs EXEC-WINDOW observed %perf ===")
print("  (snapshot-query interval [collect_before, collect_after] ~ the exec itself;")
print("   PDH % Processor Performance = hardware-derived effective-clock ratio vs nominal)")
import math
def pearson(xs, ys):
    n = len(xs)
    mx, my = sum(xs)/n, sum(ys)/n
    sxy = sum((x-mx)*(y-my) for x, y in zip(xs, ys))
    sxx = sum((x-mx)**2 for x in xs)
    syy = sum((y-my)**2 for y in ys)
    return sxy / math.sqrt(sxx*syy)

b6 = [r for r in rows if r["bench"] == "B6" and r["perf_after"] is not None]
xs = [r["perf_after"] for r in b6]
ys = [r["median"] for r in b6]
print(f"  B6 (n={len(b6)}): pearson r(median, exec-window %perf) = {pearson(xs, ys):.3f}")
prods = [(r["i"], r["median"] * r["perf_after"]) for r in b6]
print(f"  B6 t*x%perf products (constant iff exact t ~ 1/f): "
      + ", ".join(f"#{i}:{p/1000:.1f}k" for i, p in prods))
pvals = [p for _, p in prods]
print(f"  product mean={statistics.mean(pvals)/1000:.1f}k  cv="
      f"{statistics.pstdev(pvals)/statistics.fmean(pvals)*100:.1f}%  "
      f"(raw median spread across same execs = {max(ys)/min(ys):.2f}x)")
print("  per-exec mapping:")
for r in rows:
    if r["bench"] == "B6":
        print(f"    exec#{r['i']} gap={str(r['gap']):5} median={r['median']:7.2f}us  "
              f"exec-window obs%perf={r['perf_after']:6.1f}  "
              f"~{r['perf_after']*20:.0f}MHz (of nominal 2000MHz)")
print("  gap vs no-gap exec-window observed %perf:")
for lbl, sel in (("post-gap", True), ("warm/back-to-back", False)):
    v = [r["perf_after"] for r in rows if r["gap"] == sel and r["perf_after"] is not None]
    if v:
        print(f"    {lbl:18} n={len(v)} mean={statistics.mean(v):.1f}%  "
              f"range=[{min(v):.1f}, {max(v):.1f}]  ~{statistics.mean(v)*20:.0f}MHz")

print("\n=== within-exec sample-window telemetry (timeline samples inside exec window) ===")
for r in rows:
    if r["win"] or r["covering"]:
        print(f"  exec#{r['i']} {r['b' 'ench'] if False else r['bench']}: in-window="
              f"{[round(v,1) for v in r['win']]} covering={ [round(v,1) for v in r['covering']] }")

print("\n=== B6/B9: exec median vs covering observed %perf (direct association) ===")
for r in rows:
    if r["covering"]:
        cp = statistics.mean(r["covering"])
        print(f"  exec#{r['i']} {r['bench']} gap={r['gap']} median={r['median']:.2f}us "
              f"covering_obs%perf={cp:.1f}  (nominal 2000MHz => ~{cp*20:.0f}MHz observed)")

print("\n=== thread CPU utilization during exec (scheduling alternative-cause probe) ===")
for r in rows:
    print(f"  exec#{r['i']} {r['bench']} gap={r['gap']}: wall={r['wall_s']:.4f}s "
          f"thread_cpu_util={r['cpu_util']:.1f}%  spikes>1.5xmedian={r['spk']}")
