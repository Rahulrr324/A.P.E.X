#!/usr/bin/env python3
"""Compare the production aggregator's G7 verdict with the independent
verifier's G7 verdict, extracted from their raw output files (no recompute).

Exit 0 = AGREE, 3 = MISMATCH.
"""
import re
import sys

agg_file, ver_file = sys.argv[1], sys.argv[2]
agg = open(agg_file).read()
ver = open(ver_file).read()

m = re.search(r"\[(PASS|FAIL)\] G7 ", agg)
agg_g7 = m.group(1) if m else None
m2 = re.search(r"=== Independent G7 verdict: (PASS|FAIL) ===", ver)
ver_g7 = m2.group(1) if m2 else None

print(f"Aggregator G7 (production gates.cpp): {agg_g7}")
print(f"Independent G7 (verify_g7.py):        {ver_g7}")
if agg_g7 is None or ver_g7 is None:
    print("MISMATCH: could not extract a verdict")
    sys.exit(3)
if agg_g7 == ver_g7:
    print("AGREE: aggregator and independent calculator match")
    sys.exit(0)
print("MISMATCH: aggregator and independent calculator disagree")
sys.exit(3)
