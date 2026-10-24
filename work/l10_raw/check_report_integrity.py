#!/usr/bin/env python3
"""Regression check for the L10 report-serialization defect found in validation.

Defect (STARK-L10 validation): the benchmark serialized the shuffled-cue and
context-off controls as 0.0 for every arm that never evaluated them, which is
indistinguishable from a measured 0%. Fixed in the driver by emitting `null`
plus an explicit `context_controls_measured` flag.

This checker enforces the invariant that survived the fix:
  * an arm either reports a number for both controls and flags them measured,
    or reports `null` for both and flags them unmeasured;
  * the two context-control arms never claim the general controls.

Usage:  python3 check_report_integrity.py <report.json>
Exit:   0 = consistent, 1 = inconsistent (prints the offending arms).
"""
import json
import sys


def check(path):
    doc = json.load(open(path))
    problems = []
    for arm, body in doc.get("results", {}).items():
        pooled = body.get("pooled", {})
        has_flag = "context_controls_measured" in pooled
        measured = pooled.get("context_controls_measured")
        sh = pooled.get("shuffled_cue_mean")
        off = pooled.get("context_off_mean")
        if not has_flag:
            problems.append(f"{arm}: no context_controls_measured flag (pre-fix report?)")
            continue
        if measured is True:
            if sh is None or off is None:
                problems.append(f"{arm}: flagged measured but controls are null")
            elif not (0.0 <= float(sh) <= 1.0 and 0.0 <= float(off) <= 1.0):
                problems.append(f"{arm}: control outside [0,1]: shuffled={sh} off={off}")
        elif measured is False:
            if sh is not None or off is not None:
                problems.append(f"{arm}: flagged unmeasured but controls are numeric "
                                f"(shuffled={sh} off={off})")
        else:
            problems.append(f"{arm}: flag is neither true nor false ({measured!r})")
        # per-seed consistency with the pooled flag
        for seed in body.get("per_seed", []):
            s_sh, s_off = seed.get("shuffled"), seed.get("ctx_off")
            if measured is False and (s_sh is not None or s_off is not None):
                problems.append(f"{arm}/{seed.get('master')}: unmeasured arm has per-seed values")
            if measured is True and (s_sh is None or s_off is None):
                problems.append(f"{arm}/{seed.get('master')}: measured arm has null per-seed values")
    return problems


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    problems = check(sys.argv[1])
    if problems:
        print(f"INCONSISTENT: {sys.argv[1]}")
        for p in problems:
            print("  -", p)
        return 1
    print(f"OK: {sys.argv[1]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
