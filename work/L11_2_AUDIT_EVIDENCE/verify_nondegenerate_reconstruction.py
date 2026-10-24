#!/usr/bin/env python3
"""
STARK-L11.2 audit — non-degenerate verification of routing/retrieval separability.

Why this exists: the committed tool `work/l11_2_prototype/recompute_metrics.py`
requires a `calls_*.csv` sidecar. The R7 arm of `spec_ratification_20261024` was
produced by an older harness revision that did not emit one, so the tool cannot
be pointed at it. This script reproduces the same reconstruction *without* the
sidecar, by grouping on the (task, call) columns present in the trial rows.

It is AUDIT EVIDENCE, not a repair of the tool. The tool's sidecar requirement is
recorded as a limitation in the audit report.

Purpose: exercise routing/retrieval separation on a NON-DEGENERATE arm. The
default frozen arm saturates at accuracy 1.0 / routing 1.0, where any
reconstruction incidentally matches; R7 has routing 0.0 with accuracy > 0.

Usage: python3 verify_nondegenerate_reconstruction.py <dir>
"""
import csv
import gzip
import json
import os
import sys
from collections import defaultdict


def rows(path):
    op = gzip.open if path.endswith(".gz") else open
    with op(path, "rt", newline="") as fh:
        return list(csv.DictReader(fh))


def main(d):
    out = {"R7_dir": d, "seeds": {}, "all_match": True}
    for name in sorted(os.listdir(d)):
        if not name.startswith("trials_") or "_R7" not in name:
            continue
        seed = [p for p in name.replace(".gz", "").split("_") if p.isdigit()]
        if not seed:
            continue
        seed = seed[-1]
        mf = os.path.join(d, "metrics_tasks_T3_K3_%s_R7.csv" % seed)
        pub = {int(r["step_task"]): r for r in rows(mf)}
        per = defaultdict(list)
        for r in rows(os.path.join(d, name)):
            if r["eval_kind"] != "0":
                continue
            per[(int(r["task"]), int(r["call"]))].append(r)

        cells = {}
        for (t, c), rs in sorted(per.items()):
            n = len(rs)
            routed = sum(int(x["bank_is_task_bank"]) for x in rs)
            correct = sum(int(x["correct"]) for x in rs)
            c_r = sum(int(x["correct"]) for x in rs if int(x["bank_is_task_bank"]) == 1)
            c_w = sum(int(x["correct"]) for x in rs if int(x["bank_is_task_bank"]) == 0)
            cells["%d:%d" % (t, c)] = {
                "n": n,
                "routing": routed / n,
                "accuracy": correct / n,
                "acc_given_routed": (c_r / routed) if routed else None,
                "acc_given_unrouted": (c_w / (n - routed)) if n - routed else None,
            }
            if c == t:  # the acquisition call is the one the aggregate reports
                pr, pa = float(pub[t]["routing"]), float(pub[t]["acquisition"])
                cells["%d:%d" % (t, c)]["published_routing"] = pr
                cells["%d:%d" % (t, c)]["published_acquisition"] = pa
                # The harness writes aggregates with fixed 6-decimal precision,
                # so the only defensible tolerance is 1e-6 (max rounding error
                # 5e-7). An earlier 1e-9 check in this audit produced two FALSE
                # mismatches at 0.166667 vs 0.1666666... - recorded in the report.
                ok = abs(routed / n - pr) < 1e-6 and abs(correct / n - pa) < 1e-6
                cells["%d:%d" % (t, c)]["match"] = ok
                if not ok:
                    out["all_match"] = False
        out["seeds"][seed] = cells
    print(json.dumps(out, indent=2, sort_keys=True))
    return 0 if out["all_match"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
