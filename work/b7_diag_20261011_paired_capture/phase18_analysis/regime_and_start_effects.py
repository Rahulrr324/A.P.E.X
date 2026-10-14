#!/usr/bin/env python3
"""
Phase 18 supplementary - two discriminating questions:

  Q1. Are the early-block "ramps" smooth drifts or discrete step/regime changes?
      (print the actual per-iteration series for the affected blocks)

  Q2. Is the >10% tail enriched at the START of a measured block, i.e. is it a
      per-block warm-up effect? Each block runs 10 UNTIMED warm-up iterations
      before its 50 measured ones (source: run_replicate, warmup_count=10), so a
      warm-up deficit should over-represent iterations 0..k.

Read-only. Frozen metrics untouched.
"""
import csv
import json
import pathlib
import statistics as st

ROOT = pathlib.Path(r"E:\My Local AI")
CSV = ROOT / "work/b7_diag_20261011_paired_capture/run2/paired_samples.csv"
OUT = ROOT / "work/b7_diag_20261011_paired_capture/phase18_analysis"

rows = list(csv.DictReader(CSV.read_text(encoding="utf-8").splitlines()))
MIN, INS, PCT = {}, {}, {}
for r in rows:
    rep, it = int(r["replicate"]), int(r["iteration"])
    MIN.setdefault(rep, {})[it] = float(r["minimal_sec"]) * 1e6
    INS.setdefault(rep, {})[it] = float(r["instrumented_sec"]) * 1e6
    PCT.setdefault(rep, {})[it] = float(r["signed_overhead_pct"])
REPS = sorted(MIN)

out = {}

# ---------------------------------------------------------------- Q1: shape
print("=" * 100)
print("Q1. SHAPE OF THE EARLY-BLOCK DEVIATIONS (per-iteration, us)")
print("=" * 100)
focus = [(0, "MINIMAL", MIN), (1, "MINIMAL", MIN), (1, "INSTRUMENTED", INS), (2, "INSTRUMENTED", INS)]
for rep, cond, src in focus:
    v = [src[rep][i] for i in range(50)]
    lo, hi = min(v), max(v)
    print(f"\n  rep{rep}_{cond}:  min={lo:.0f}  max={hi:.0f}  median={st.median(v):.0f}  "
          f"max/min={hi/lo:.2f}x")
    for k in range(0, 50, 10):
        seg = v[k:k + 10]
        print("    iter %2d-%2d: " % (k, k + 9) + " ".join(f"{x:7.0f}" for x in seg))
    out[f"rep{rep}_{cond}"] = {
        "series_us": [round(x, 1) for x in v],
        "min": round(lo, 1), "max": round(hi, 1), "median": round(st.median(v), 1),
        "max_over_min": round(hi / lo, 3),
    }

# step detection: largest single-iteration jump and where
print("\n  Largest single-iteration jumps within these blocks:")
jumps = {}
for rep, cond, src in focus:
    v = [src[rep][i] for i in range(50)]
    d = [(v[i + 1] - v[i], i + 1) for i in range(49)]
    biggest = max(d, key=lambda t: abs(t[0]))
    jumps[f"rep{rep}_{cond}"] = {"jump_us": round(biggest[0], 1), "at_iteration": biggest[1]}
    print(f"    rep{rep}_{cond:<14} largest step {biggest[0]:+8.1f} us at iteration {biggest[1]}")
out["largest_intra_block_steps"] = jumps

# how much of the 50-iteration range is covered by a single step?
print("\n  Compare: single largest step vs whole-block ramp (first10 vs last10):")
for rep, cond, src in focus:
    v = [src[rep][i] for i in range(50)]
    d = max(((abs(v[i + 1] - v[i]), v[i + 1] - v[i]) for i in range(49)))
    ramp = st.fmean(v[-10:]) - st.fmean(v[:10])
    print(f"    rep{rep}_{cond:<14} first10-vs-last10 = {ramp:+8.1f} us ; "
          f"largest single step = {d[1]:+8.1f} us ; ratio={abs(d[1])/abs(ramp) if ramp else float('nan'):.2f}")

# ------------------------------------------------- Q2: block-start enrichment
print("\n" + "=" * 100)
print("Q2. IS THE >10% TAIL ENRICHED AT THE START OF A MEASURED BLOCK?")
print("=" * 100)
# A 'measured block' = one (replicate, condition). There are 12 blocks, 50 iters each.
# Iteration index is the position inside that block's measured loop.
def enrichment(subset_reps, label):
    total = 0
    early = 0          # iterations 0..4
    first2 = 0         # iterations 0..1
    over = 0
    over_early = 0
    over_first2 = 0
    for r in subset_reps:
        for i in range(50):
            for src in (MIN, INS):
                pass
            # two conditions per replicate -> count each condition's tape
    # simpler: walk the pair list but treat each side separately
    n_pairs = 0
    for r in subset_reps:
        for i in range(50):
            n_pairs += 1
            total += 2
            if i < 5:
                early += 2
            if i < 2:
                first2 += 2
            if PCT[r][i] > 10.0:
                over += 1
                if i < 5:
                    over_early += 1
                if i < 2:
                    over_first2 += 1
    print(f"\n  {label}")
    print(f"    pairs total={n_pairs}  pairs >10%={over}  base rate={100.0*over/n_pairs:.2f}%")
    print(f"    iterations 0-1 : {first2} iteration-slots, {over_first2} exceed 10% "
          f"-> rate {100.0*over_first2/first2 if first2 else 0:.2f}%")
    print(f"    iterations 0-4 : {early} iteration-slots, {over_early} exceed 10% "
          f"-> rate {100.0*over_early/early if early else 0:.2f}%")
    return {"pairs": n_pairs, "over10": over, "base_rate_pct": round(100.0 * over / n_pairs, 2),
            "first2_rate_pct": round(100.0 * over_first2 / first2, 2) if first2 else None,
            "first5_rate_pct": round(100.0 * over_early / early, 2) if early else None,
            "first2_enrichment_x": round((over_first2 / first2) / (over / n_pairs), 2) if first2 and over else None,
            "first5_enrichment_x": round((over_early / early) / (over / n_pairs), 2) if early and over else None}


out["start_enrichment_all"] = enrichment(REPS, "ALL replicates (12 blocks)")
out["start_enrichment_late"] = enrichment([3, 4, 5], "replicates 3-5 only (6 blocks)")
out["start_enrichment_early"] = enrichment([0, 1, 2], "replicates 0-2 only (6 blocks)")

print("\n  Interpretation: a per-block warm-up deficit would show first2/first5 enrichment")
print("  well above 1.0x. A stationary heavy tail shows ~1.0x.")

# quantiles of the |>10%| pairs' iteration indices
it10 = sorted(i for r in REPS for i in range(50) if PCT[r][i] > 10.0)
print(f"\n  iteration indices of all 96 >10% pairs: median={st.median(it10):.1f}  "
      f"mean={st.fmean(it10):.1f}  (uniform on 0..49 would give median 24.5, mean 24.5)")
print(f"  quartiles: Q1={it10[len(it10)//4]}, Q3={it10[3*len(it10)//4]}")
out["over10_iteration_index_stats"] = {
    "n": len(it10), "median": st.median(it10), "mean": round(st.fmean(it10), 2),
    "q1": it10[len(it10) // 4], "q3": it10[3 * len(it10) // 4],
    "uniform_median_would_be": 24.5,
}

(OUT / "02_regime_and_start_effects.json").write_text(json.dumps(out, indent=2), encoding="utf-8")
print("\n" + "=" * 100)
