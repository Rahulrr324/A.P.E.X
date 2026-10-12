#!/usr/bin/env python3
"""Per-run affinity evidence extraction for the affinity-fix G7 campaign (read-only).

For every record in the campaign directory prints the required evidence:
requested CPU, SetProcessAffinityMask return, GetLastError, raw process mask
after set, raw system mask, production effective CPU list, production query_ok,
and the production single-CPU verification result.

Exit 0 only if EVERY record demonstrates truthful single-CPU affinity.
"""
import json
import os
import sys
from pathlib import Path

d = sys.argv[1] if len(sys.argv) > 1 else "build/g7-campaign-affinityfix"
base = Path(d)
files = sorted(p for p in base.glob("*.json") if p.name != "campaign_config.json")

print(f"records: {len(files)}")
all_ok = True
rows = []
for p in files:
    r = json.loads(p.read_text())
    aff = (r.get("provenance") or {}).get("affinity")
    if not isinstance(aff, dict):
        all_ok = False
        rows.append((p.name, "MISSING AFFINITY BLOCK", None))
        continue
    req = aff.get("requested_cpu")
    eff = aff.get("effective_logical_cpus")
    good = (
        aff.get("supported") is True
        and aff.get("query_ok") is True
        and aff.get("set_ok") is True
        and aff.get("verified_single_cpu") is True
        and aff.get("set_api_return") == 1
        and aff.get("set_api_last_error") == 0
        and isinstance(req, int)
        and eff == [req]
        and aff.get("raw_process_mask") == (1 << req) if isinstance(req, int) else False
    )
    if not good:
        all_ok = False
    rows.append((p.name, r.get("experiment_id"), r.get("configuration", {}).get("benchmark_id"),
                 r.get("record_id"), r.get("created_utc"), req,
                 aff.get("set_api_return"), aff.get("set_api_last_error"),
                 aff.get("raw_process_mask"), aff.get("raw_system_mask"),
                 eff, aff.get("query_ok"), aff.get("verified_single_cpu"), good))

print(f"{'file':40} {'exp':4} {'bench':5} {'req':>3} {'setret':>6} {'gle':>4} {'pmask':>6} {'smask':>6} {'eff':>6} {'qok':>4} {'ver':>4} ok")
for row in rows:
    if row[1] == "MISSING AFFINITY BLOCK":
        print(f"{row[0]:40} {row[1]}")
        continue
    name, exp, bench, rid, ts, req, sr, gle, pm, sm, eff, qok, ver, good = row
    print(f"{name:40} {exp:4} {bench:5} {req!s:>3} {sr!s:>6} {gle!s:>4} {pm!s:>6} {sm!s:>6} "
          f"{','.join(map(str, eff)):>6} {qok!s:>4} {ver!s:>4} {'OK' if good else 'BAD'}")

n_ok = sum(1 for r in rows if len(r) > 13 and r[13])
print(f"\nrecords with truthful single-CPU evidence: {n_ok}/{len(files)}")
if not all_ok or n_ok != len(files) or len(files) != 30:
    print("AFFINITY EVIDENCE CHECK: FAILED")
    sys.exit(1)
print("AFFINITY EVIDENCE CHECK: PASSED (all 30 runs)")
sys.exit(0)
