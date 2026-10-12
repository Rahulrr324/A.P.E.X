#!/usr/bin/env python3
"""Chronological reproducibility analysis of the affinity-fix campaign (read-only).

Orders every record by created_utc, reconstructs the independent-run sequence,
and prints per-benchmark medians over time to expose the structure of the
remaining run-to-run spread (no campaign is rerun; nothing is modified).
"""
import json
import sys
from pathlib import Path

d = sys.argv[1] if len(sys.argv) > 1 else "build/g7-campaign-affinityfix"
base = Path(d)
files = sorted(p for p in base.glob("*.json") if p.name != "campaign_config.json")

recs = []
for p in files:
    r = json.loads(p.read_text())
    recs.append({
        "file": p.name,
        "id": r.get("record_id"),
        "exp": r.get("experiment_id"),
        "bench": r.get("configuration", {}).get("benchmark_id"),
        "created": r.get("created_utc"),
        "median_us": r.get("statistics", {}).get("median", 0) * 1e6,
        "n": len(r.get("statistics", {}).get("samples", [])),
        "run_suffix": (r.get("provenance") or {}).get("run_suffix"),
    })

recs.sort(key=lambda x: x["created"] or "")
print(f"records: {len(recs)}  span: {recs[0]['created']} .. {recs[-1]['created']}")
print()
print(f"{'#':>2} {'created_utc':24} {'bench':5} {'exp':3} {'median_us':>10}  run_suffix")
for i, r in enumerate(recs, 1):
    print(f"{i:>2} {r['created']:24} {r['bench']:5} {r['exp']:3} {r['median_us']:>10.2f}  {r['run_suffix']}")

# Chronological independent-run groups (shared run_suffix)
print()
print("=== per independent run (by run_suffix): medians in us ===")
order = []
groups = {}
for r in recs:
    key = r["run_suffix"]
    if key not in groups:
        groups[key] = []
        order.append(key)
    groups[key].append(r)
print(f"{'run':>3} {'created':24} {'B6/E1':>9} {'B6/E5':>9} {'B7/E1':>9} {'B7/E5':>9} {'B9/E1':>9} {'B9/E5':>9}")
for i, key in enumerate(order, 1):
    row = {}
    for r in groups[key]:
        row[(r["bench"], r["exp"])] = r["median_us"]
    def g(b, e):
        return f"{row.get((b, e), float('nan')):.2f}"
    created = min(r["created"] for r in groups[key])
    print(f"{i:>3} {created:24} {g('B6','E1'):>9} {g('B6','E5'):>9} "
          f"{g('B7','E1'):>9} {g('B7','E5'):>9} {g('B9','E1'):>9} {g('B9','E5'):>9}")

# Structure: do E1/E5 within the same independent run agree more than across runs?
print()
print("=== bimodality check per benchmark (medians sorted) ===")
for b in ("B6", "B7", "B9"):
    meds = sorted((r["median_us"], r["exp"], r["run_suffix"]) for r in recs if r["bench"] == b)
    lo = [m for m, _, _ in meds[:3]]
    hi = [m for m, _, _ in meds[-3:]]
    print(f"{b}: lowest3 = {[round(x,2) for x in lo]}  highest3 = {[round(x,2) for x in hi]}")

# within-run |E1-E5| vs across-run for each benchmark
print()
print("=== within-independent-run E1 vs E5 symmetric rel diff (%) ===")
for b in ("B6", "B7", "B9"):
    diffs = []
    for key in order:
        row = {}
        for r in groups[key]:
            if r["bench"] == b:
                row[r["exp"]] = r["median_us"]
        if "E1" in row and "E5" in row:
            x, y = row["E1"], row["E5"]
            d = 0.0 if x == 0 and y == 0 else (100.0 if (x == 0 or y == 0) else abs(x - y) / max(abs(x), abs(y)) * 100)
            diffs.append(d)
    if diffs:
        print(f"{b}: diffs per run = {[round(x,2) for x in diffs]}  max = {max(diffs):.2f}%")
