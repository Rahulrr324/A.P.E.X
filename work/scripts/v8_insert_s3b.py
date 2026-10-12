#!/usr/bin/env python3
"""Insert B9 supplement (mean/tr/ramp per exec) after the bit_identical line."""
import json
from pathlib import Path

R = Path("stark/reports/g7-campaign-affinityfix")
d = json.loads((R / "highres_frequency_v8.json").read_text(encoding="utf-8"))
b9 = [e for e in d["execs"] if e["bench"] == "B9"]

blk = ["   3b. B9 supplement: mean %perf, transitions, ramp (per exec)",
       "   exec   mean%perf  min    max    median  tr  ramp   drift  gt150  trace_n"]
for i, e in enumerate(b9):
    tr = e.get("exec_only_n_transitions")
    blk.append(
        f"   {i:>4}  {e['exec_only_mean']:9.2f} {e['exec_only_min']:6.2f} "
        f"{e['exec_only_max']:6.2f} {e['exec_only_median']:7.2f} "
        f"{tr:>3}  {str(e['in_exec_ramp']):5}  {e['iteration_drift_pct']:5.2f}% "
        f"{e['samples_gt_150pct_median']:>5}  {len(e['trace'])}"
    )
blk.append("")

p = R / "highres_v8_analysis.txt"
text = p.read_text(encoding="utf-8")
anchor = "bit_identical: True\n"
assert anchor in text, "anchor not found"
idx = text.index(anchor) + len(anchor)
# find end of that line (anchor includes \n) -> insert right after
new = text[:idx] + "\n".join(blk) + "\n" + text[idx:]
p.write_text(new, encoding="utf-8")
print("inserted 3b block:")
print("\n".join(blk))
