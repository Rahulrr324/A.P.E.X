#!/usr/bin/env python3
"""Append section 6 (R4 classification) to highres_v8_analysis.txt."""
import json
from pathlib import Path

R = Path("stark/reports/g7-campaign-affinityfix")
d = json.loads((R / "highres_frequency_v8.json").read_text(encoding="utf-8"))
rows = [e for e in d["execs"] if e["collector_active"]]


def cls(e):
    s, tr = e["exec_only_spread_max_pct"], e["exec_only_n_transitions"]
    dr, cov = e["iteration_drift_pct"], e["n_samples_usable"]
    if cov < 10:
        return "C (coverage<10)"
    if s <= 2.0 and tr <= 1:
        return "B"
    if s > 5.0:
        return "A (spread>5.0)"
    if tr >= 2 and dr > 5.0:
        return "A (transitions+drift)"
    return "C (otherwise)"


L = []
L.append("6. CLASSIFICATION (existing framework ONLY -- R4 rules verbatim)")
L.append("   B: spread <=2.0% AND <=1 transition;  A: spread >5.0% or")
L.append("   >=2 transitions corroborated by drift >5.0%;  C: otherwise or")
L.append("   coverage <10 filtered samples/exec.  No rule was changed.")
L.append("     exec bench  spread   tr  drift  usable  class")
for i, e in enumerate(rows):
    L.append(f"     {i:>4} {e['bench']:>4}  {e['exec_only_spread_max_pct']:6.2f}% "
             f"{e['exec_only_n_transitions']:>3} {e['iteration_drift_pct']:6.2f}% "
             f"{e['n_samples_usable']:>6}   {cls(e)}")
from collections import Counter
c = Counter(cls(e).split(" ")[0] for e in rows)
na = sum(1 for e in rows if e["exec_only_spread_max_pct"] > 5.0)
exceed = sum(1 for e in rows if e["exec_only_spread_max_pct"] > 6.8974)
L.append(f"   Aggregate over the 16 covered B execs: {c['A']} A-side, "
         f"{c['B']} B-side, {c['C']} C-zone (1 C for coverage<10).")
L.append(f"   A-side spreads 5.65..17.12%; {exceed}/16 execs exceed the")
L.append("   production 6.8974% gate value INSIDE a single ~7 ms exec.")
L.append("")

out = R / "highres_v8_analysis.txt"
out.write_text(out.read_text(encoding="utf-8") + "\n".join(L) + "\n", encoding="utf-8")
print("\n".join(L))
print("[section 6 appended]")
