#!/usr/bin/env python3
"""Stability-gate analysis for the session-scoped power-scheme control.

Reads ONLY:
  reports/g7-campaign-affinityfix/frequency_evidence_hp.json   (controlled run)
  reports/g7-campaign-affinityfix/frequency_evidence.json      (baseline, read-only)
  reports/g7-campaign-affinityfix/power_scheme_session.json    (apply/restore evidence)

Applies EXACTLY the gate predeclared in gate_predeclaration.txt (written
before the run). Writes reports/g7-campaign-affinityfix/power_control_gate.txt.
ASCII-only output. Exit 0 always (classification is decided by the caller
from the printed numbers); nonzero only on input errors.
"""

import json
import math
import pathlib
import statistics
import sys

BASE = pathlib.Path(__file__).resolve().parent
HP_JSON = BASE / "frequency_evidence_hp.json"
BASELINE_JSON = BASE / "frequency_evidence.json"
SESSION_JSON = BASE / "power_scheme_session.json"
OUT = BASE / "power_control_gate.txt"

GATE_PCT = 5.0          # predeclared, fixed before the run
RAMP_PCT = 5.0          # predeclared material-ramp threshold


def load(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def exec_windows(doc):
    out = []
    for i, e in enumerate(doc.get("execs", [])):
        perf = (e.get("pdh_after") or {}).get("observed_pct_perf_cpu0")
        if perf is None:
            continue
        out.append(
            {
                "idx": i,
                "bench": e.get("bench"),
                "gap": bool(e.get("after_idle_gap")),
                "perf": float(perf),
                "perf_before": (e.get("pdh_before") or {}).get(
                    "observed_pct_perf_cpu0"
                ),
                "median_us": e.get("median_us"),
                "first10": e.get("first10_median_us"),
                "last10": e.get("last10_median_us"),
                "aff": e.get("affinity") or {},
                "wall_s": e.get("wall_s"),
            }
        )
    return out


def pct(a, b):
    return abs(a - b) / abs(b) * 100.0


def main():
    hp = load(HP_JSON)
    base = load(BASELINE_JSON)
    session = load(SESSION_JSON)

    rows = exec_windows(hp)
    vals = [r["perf"] for r in rows]
    if len(vals) < 3:
        print("ERROR: fewer than 3 exec-window values")
        return 1

    n = len(vals)
    vmin, vmax = min(vals), max(vals)
    vmean = statistics.fmean(vals)
    vmed = statistics.median(vals)
    vstdev = statistics.stdev(vals) if n > 1 else 0.0
    cv = vstdev / vmean * 100.0 if vmean else float("nan")

    spread_max = (vmax - vmin) / vmax * 100.0      # PRIMARY gate (G7 form)
    spread_mean = (vmax - vmin) / vmean * 100.0    # secondary
    spread_min = (vmax - vmin) / vmin * 100.0      # secondary

    gate_pass = spread_max <= GATE_PCT

    # ---- in-execution ramp checks (predeclared) ----
    ramp_rows = []
    for r in rows:
        a = {}
        if r["first10"] and r["last10"]:
            a["timing_drift_pct"] = pct(r["last10"], r["first10"])
        if r["perf_before"]:
            a["bracket_perf_change_pct"] = pct(r["perf"], r["perf_before"])
        material = (
            a.get("timing_drift_pct", 0.0) > RAMP_PCT
            or a.get("bracket_perf_change_pct", 0.0) > RAMP_PCT
        )
        a["material"] = material
        a["row"] = r
        ramp_rows.append(a)

    material_ramps = [a for a in ramp_rows if a["material"]]
    max_drift = max((a.get("timing_drift_pct", 0.0) for a in ramp_rows), default=0.0)
    max_bracket = max(
        (a.get("bracket_perf_change_pct", 0.0) for a in ramp_rows), default=0.0
    )

    # ---- gap vs warm ----
    gaps = [r["perf"] for r in rows if r["gap"]]
    warms = [r["perf"] for r in rows if not r["gap"]]

    # ---- timeline samples inside exec windows (coverage check) ----
    timeline = hp.get("timeline", [])
    in_window = 0
    for e in hp.get("execs", []):
        t0, t1 = e.get("t_start_utc"), e.get("t_end_utc")
        if not t0 or not t1:
            continue
        for s in timeline:
            u = s.get("utc")
            if u and t0 <= u <= t1:
                in_window += 1

    # ---- baseline (pre-control) comparison, read-only ----
    brows = exec_windows(base)
    bvals = [r["perf"] for r in brows]
    bspread = (max(bvals) - min(bvals)) / max(bvals) * 100.0 if bvals else 0.0
    btiming = [
        r["median_us"] for r in brows if r["median_us"] is not None
    ]
    hptiming = [r["median_us"] for r in rows if r["median_us"] is not None]

    # ---- affinity / scheme provenance ----
    aff_ok = all(
        r["aff"].get("verified_single_cpu") and r["aff"].get("effective_logical_cpus") == [0]
        if isinstance(r["aff"].get("effective_logical_cpus"), list)
        else r["aff"].get("verified_single_cpu")
        for r in rows
    )
    aff_count = sum(1 for r in rows if r["aff"].get("verified_single_cpu"))
    child_scheme = (hp.get("static", {}).get("power_scheme") or {}).get(
        "os_reported_scheme_guid"
    )
    apply_ok = session.get("apply", {}).get("ok")
    restore_ok = session.get("restore", {}).get("matches_original")
    orig_guid = session.get("original", {}).get("guid")
    after_guid = session.get("restore", {}).get("scheme_after")

    if not apply_ok:
        classification = "C"
    elif not restore_ok:
        classification = "C"
    elif not gate_pass or material_ramps:
        classification = "B"
    else:
        classification = "A"

    L = []
    L.append("STABILITY-GATE RESULT (predeclared formulas; see gate_predeclaration.txt)")
    L.append("")
    L.append("CONTROL")
    L.append("  original scheme      : %s" % orig_guid)
    L.append("  requested            : %s" % session.get("apply", {}).get("requested_guid"))
    L.append("  apply status         : %s (ok=%s)" % (session.get("apply", {}).get("status"), apply_ok))
    L.append("  scheme after apply   : %s" % session.get("apply", {}).get("scheme_after"))
    L.append("  scheme seen by child : %s" % child_scheme)
    L.append("  restore status       : %s (matches_original=%s)" % (session.get("restore", {}).get("status"), restore_ok))
    L.append("  scheme after restore : %s" % after_guid)
    L.append("  child exit           : %s" % session.get("child", {}).get("exit_code"))
    L.append("")
    L.append("SAMPLES")
    L.append("  exec-window samples  : %d (n=%d)" % (n, n))
    L.append("  benches              : %s" % ", ".join(
        "%s x%d" % (b, sum(1 for r in rows if r["bench"] == b))
        for b in dict.fromkeys(r["bench"] for r in rows)))
    L.append("  verified_single_cpu  : %d/%d" % (aff_count, n))
    L.append("")
    L.append("EXEC-WINDOW %% PROCESSOR PERFORMANCE (controlled run)")
    for r in rows:
        L.append(
            "  exec#%-2d %-3s gap=%-5s perf=%8.3f  before=%s  median_us=%s  first10=%s last10=%s"
            % (
                r["idx"],
                r["bench"],
                "yes" if r["gap"] else "no",
                r["perf"],
                ("%.3f" % r["perf_before"]) if r["perf_before"] else "n/a",
                ("%.2f" % r["median_us"]) if r["median_us"] else "n/a",
                ("%.2f" % r["first10"]) if r["first10"] else "n/a",
                ("%.2f" % r["last10"]) if r["last10"] else "n/a",
            )
        )
    L.append("  min    = %.3f" % vmin)
    L.append("  max    = %.3f" % vmax)
    L.append("  mean   = %.3f" % vmean)
    L.append("  median = %.3f" % vmed)
    L.append("  stdev  = %.3f (sample, n-1)" % vstdev)
    L.append("  CV     = %.3f %%" % cv)
    L.append("")
    L.append("SPREAD")
    L.append("  PRIMARY  (max-min)/max*100      = %.4f %%   [GATE <= %.1f %%]" % (spread_max, GATE_PCT))
    L.append("  secondary (max-min)/mean*100    = %.4f %% (non-gating)" % spread_mean)
    L.append("  secondary (max-min)/min*100     = %.4f %% (non-gating)" % spread_min)
    L.append("  GATE RESULT                     : %s" % ("PASS" if gate_pass else "FAIL"))
    L.append("")
    L.append("POST-GAP VS WARM (exec-window %%perf)")
    if gaps:
        L.append("  post-gap n=%d mean=%.3f min=%.3f max=%.3f" % (
            len(gaps), statistics.fmean(gaps), min(gaps), max(gaps)))
    if warms:
        L.append("  warm     n=%d mean=%.3f min=%.3f max=%.3f" % (
            len(warms), statistics.fmean(warms), min(warms), max(warms)))
    if gaps and warms:
        L.append("  delta (warm - post-gap) = %.3f pp" % (
            statistics.fmean(warms) - statistics.fmean(gaps)))
        L.append("  relative gap penalty     = %.3f %%" % pct(
            statistics.fmean(warms), statistics.fmean(gaps)))
    if gaps and warms:
        L.append("  baseline (pre-control): post-gap mean vs warm mean from frequency_evidence.json = 113.2 vs 147.1")
    L.append("")
    L.append("IN-EXECUTION RAMP (threshold: %.1f %%)" % RAMP_PCT)
    L.append("  max |last10-first10|/first10 = %.3f %%" % max_drift)
    L.append("  max |perf_after-perf_before|/perf_before = %.3f %%" % max_bracket)
    L.append("  execs with MATERIAL ramp     : %d/%d" % (len(material_ramps), n))
    for a in material_ramps:
        r = a["row"]
        L.append("    exec#%d %s drift=%s bracket=%s" % (
            r["idx"], r["bench"],
            ("%.3f" % a["timing_drift_pct"]) if "timing_drift_pct" in a else "n/a",
            ("%.3f" % a["bracket_perf_change_pct"]) if "bracket_perf_change_pct" in a else "n/a"))
    L.append("  timeline samples inside exec windows: %d (sampler period 100 ms; execs are ~ms-scale)" % in_window)
    L.append("")
    L.append("BASELINE (pre-control, read-only) FOR CONTEXT")
    L.append("  baseline exec-window %%perf: n=%d min=%.3f max=%.3f spread(G7 form)=%.4f %%" % (
        len(bvals), min(bvals), max(bvals), bspread))
    if btiming and hptiming:
        L.append("  baseline B6/B9/B7 medians us: %s" % ", ".join("%.1f" % t for t in btiming))
        L.append("  controlled medians us        : %s" % ", ".join("%.1f" % t for t in hptiming))
    L.append("")
    L.append("CLASSIFICATION: %s" % classification)
    L.append("  A = apply+restore OK AND spread<=5.0%% AND no material in-exec ramp")
    L.append("  B = apply+restore OK but gate failed")
    L.append("  C = apply or restore failed")

    text = "\n".join(L) + "\n"
    with open(OUT, "w", encoding="ascii", errors="replace") as f:
        f.write(text)
    print(text)
    print("wrote %s" % OUT)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as ex:  # noqa: BLE001
        print("ERROR: %s" % ex)
        sys.exit(2)
