#!/usr/bin/env python3
"""STARK-L10.2 — independent recomputation of every registered metric.

Reads ONLY the per-trial CSVs (never the metrics CSV) and reconstructs
acquisition, final retention, forgetting, routing accuracy, conditional
accuracy and the context-off fallback distribution. Then compares with the
driver's own metrics CSV and reports any disagreement.

Usage: recompute.py <dir> <tag> <seeds>
"""
import csv, sys, os, collections, statistics

def load_calls(path):
    calls = {}
    with open(path) as f:
        for r in csv.DictReader(f):
            calls[int(r["call"])] = (r["purpose"], int(r["task"]), int(r["eval_kind"]))
    return calls

def eval_groups(trials_path):
    """call -> list of (correct, bank_is_task_bank, bank, task)"""
    g = collections.defaultdict(list)
    with open(trials_path) as f:
        for r in csv.DictReader(f):
            c = int(r["call"])
            if c < 0: continue
            g[c].append((int(r["correct"]), int(r["bank_is_task_bank"]), int(r["bank"]), int(r["task"])))
    return g

def metrics_rows(path):
    out = {}
    with open(path) as f:
        for r in csv.DictReader(f):
            out[(int(r["master"]), int(r["step_task"]))] = r
    return out

def main(d, tag, seeds, suffix=""):
    problems = 0
    print(f"{'seed':>10} {'task':>4} {'acq':>7} {'acq_rc':>7} {'fin':>7} {'fin_rc':>7} "
          f"{'forget':>7} {'forget_rc':>9} {'route':>6} {'acc|right':>9} {'acc|wrong':>9} {'fallback':>8}")
    S = [int(x) for x in seeds.split(",")]
    pooled = {}
    for m in S:
        calls = load_calls(f"{d}/calls_{tag}_{m}{suffix}.csv")
        groups = eval_groups(f"{d}/trials_{tag}_{m}{suffix}.csv")
        met = metrics_rows(f"{d}/metrics_{tag}_{m}{suffix}.csv")
        nsteps = max(t for (mm, t) in met if mm == m) + 1
        acq = {}; fin = {}; route = {}; cr = []; cw = []; fb = collections.Counter()
        for cid, (purpose, task, kind) in calls.items():
            rows = groups.get(cid, [])
            if not rows: continue
            acc = sum(r[0] for r in rows) / len(rows)
            if kind == 0:
                if purpose == "acquisition":
                    acq[task] = acc
                    route[task] = sum(r[1] for r in rows) / len(rows)
                    cr += [r[0] for r in rows if r[1] == 1]
                    cw += [r[0] for r in rows if r[1] == 0]
                elif purpose.startswith("retention@step"):
                    fin[task] = acc
            if kind == 2:                      # context-off
                for r in rows: fb[r[2]] += 1
        for t in range(nsteps):
            if t == nsteps - 1: fin.setdefault(t, acq[t])
            mr = met[(m, t)]
            a, f_ = float(mr["acquisition"]), float(mr["final_retention"])
            fo = float(mr["forgetting"])
            da, df, dfo = abs(a - acq[t]), abs(f_ - fin[t]), abs(fo - (acq[t] - fin[t]))
            if max(da, df, dfo) > 1e-6: problems += 1
            print(f"{m:>10} {t:>4} {a:7.4f} {acq[t]:7.4f} {f_:7.4f} {fin[t]:7.4f} "
                  f"{fo:7.4f} {acq[t]-fin[t]:9.4f} {route[t]:6.4f} "
                  f"{(statistics.mean(cr) if cr else -1):9.4f} {(statistics.mean(cw) if cw else float('nan')):9.4f} "
                  f"{(fb.most_common(1)[0] if fb else ('-',0))}")
        pooled[m] = (statistics.mean(acq.values()), statistics.mean(fin.values()),
                     statistics.mean(acq[t]-fin[t] for t in range(nsteps)))
    print("\npooled (recomputed from trial rows):")
    for m, (a, f_, fo) in pooled.items():
        print(f"  seed {m}: acq={a:.6f} final={f_:.6f} forgetting={fo:.6f}")
    print(f"\ncomparison with driver metrics CSV: {'ALL MATCH' if problems==0 else str(problems)+' MISMATCHES'}")
    return problems

if __name__ == "__main__":
    sys.exit(1 if main(sys.argv[1], sys.argv[2], sys.argv[3],
                       sys.argv[4] if len(sys.argv) > 4 else "") else 0)
