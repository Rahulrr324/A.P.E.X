#!/usr/bin/env python3
"""v8 analysis: B6 position-matched A/B pairs + B9 repeated B-side coverage.

Reads stark/reports/g7-campaign-affinityfix/highres_frequency_v8.json and the
v7 JSON for continuity comparison. Writes
stark/reports/g7-campaign-affinityfix/highres_v8_analysis.txt.

Metric (predeclared application, same as v7):
- per-exec duration = median_us_this_path (median of the 50 measured
  iteration durations; the same statistic the production harness computes)
- per-pair signed relative difference = (B - A) / A * 100 (positive = B slower)
- predeclared materiality criterion: 2.0% (unchanged). Applied to the
  aggregate of per-pair signed relative differences (median AND mean) and,
  for continuity with v7's pooled headline, to the pooled-median comparison.
"""
from __future__ import annotations

import json
import statistics as st
from pathlib import Path

REPORTS = Path("stark/reports/g7-campaign-affinityfix")
V8 = REPORTS / "highres_frequency_v8.json"
V7 = REPORTS / "highres_frequency_v7.json"
OUT = REPORTS / "highres_v8_analysis.txt"

MATERIALITY = 2.0
FLOOR = 10
PACE = 500

L: list[str] = []


def p(s: str = "") -> None:
    L.append(s)


def fmt(x, nd=2):
    if x is None:
        return "n/a"
    if isinstance(x, float):
        return f"{x:.{nd}f}"
    return str(x)


def main() -> None:
    d8 = json.loads(V8.read_text(encoding="utf-8"))
    d7 = json.loads(V7.read_text(encoding="utf-8"))
    execs8 = d8["execs"]
    stat8 = d8["static"]

    b6 = [e for e in execs8 if e["bench"] == "B6"]
    b9 = [e for e in execs8 if e["bench"] == "B9"]

    p("=" * 78)
    p("HIGH-RESOLUTION FREQUENCY DIAGNOSTIC -- v8 ANALYSIS (FINAL FOR THIS STEP)")
    p("Date: 2026-10-08. Investigation only: NO G7 campaign was run; G7")
    p("thresholds/formulas, benchmark timing semantics, frozen 30 records,")
    p("records_sha256.txt, evidence_manifest.json, production binaries, v7")
    p("evidence, and historical records were NOT modified.")
    p("Predeclaration: tests/diag_highres_frequency.cpp v8 header + control")
    p("constants (DIAG_VERSION=v8, V8_B6_N_PAIRS=8, V8_B9_N_EXECS=8).")
    p("Evidence: reports/g7-campaign-affinityfix/highres_frequency_v8.json")
    p("Session: power_scheme_session_highres_v8.json")
    p("=" * 78)
    p()
    p("0. RUN / INTEGRITY (exit codes; detail in work/scripts/v8_*integrity.json)")
    p("   ninja build (diag_highres_frequency.exe only) = 0")
    p("   harness smoke run (temp output, excluded from evidence) = 0")
    p("   power_scheme_control run: wrapper=0, child_exit=0, restore_status=0,")
    p("     scheme_after_apply=8C5E7FDA (High performance),")
    p("     scheme_after_restore=DFE97760 (Performance Mode),")
    p("     restore_matches_original=true")
    p("   independent powercfg restore check (post-run) exit=0, guid match=true")
    p("   pre-run integrity: verify_frozen30=0, records_sha256 -c=0,")
    p("     manifest sha match, 5 production hashes captured, powercfg=0")
    p("   post-run integrity: verify_frozen30=0, records_sha256 -c=0,")
    p("     manifest sha match, 5 production binaries changed=[],")
    p("     G7CAM created/modified=0")
    p()
    p("1. STATIC / AFFINITY EVIDENCE")
    p(f"   system_mask=0x{stat8['system_mask_raw']:x} "
      f"process_mask_after=0x{stat8['process_mask_after']:x}")
    p(f"   worker pin: set_api_return={stat8['worker_set_api_return']} "
      f"readback=0x{stat8['worker_pin_readback_mask']:x} (expect 0x1)")
    p(f"   collector target CPU={stat8['collector_target_cpu']} (expect 2); "
      f"cpu1_shares_core_with_cpu0={stat8['cpu1_shares_core_with_cpu0']}")
    p(f"   pace_period_us={stat8['pace_period_us']} (expect {PACE})")
    p()

    # ---------------- B6 ----------------
    p("2. B6 POSITION-MATCHED A/B PAIRS (V8_B6_N_PAIRS=8, order alternated)")
    p("   duration per exec = median_us_this_path (median of 50 iteration durs)")
    p("   signed rel diff = (B - A) / A * 100;  positive = B (collector) slower")
    p()
    p("   pair order      A_us    B_us   signed%  abs%  A_span  B_span  A_wcpu  "
      "B_wcpu B_ccpu B_pin B_pdhfail A_fr A_la A_mn A_mx A_med B_fr B_la B_mn "
      "B_mx B_med A_ramp B_ramp anom")
    pairs: dict[int, list] = {}
    for e in b6:
        pairs.setdefault(e["cycle"], []).append(e)

    signed: list[float] = []
    absd: list[float] = []
    order_means = {"A->B": [], "B->A": []}
    anomalies: dict[int, list[str]] = {}

    for pn in sorted(pairs):
        group = pairs[pn]
        a = next(e for e in group if not e["collector_active"])
        b = next(e for e in group if e["collector_active"])
        order = "A->B" if group[0] is a else "B->A"
        da = a["median_us_this_path"]
        db = b["median_us_this_path"]
        rel = (db - da) / da * 100.0
        signed.append(rel)
        absd.append(abs(rel))
        order_means[order].append(rel)

        anom = []
        cd = b.get("collector_diag") or {}
        pdh_fail = (cd.get("pdh_fail_collect", 0) + cd.get("pdh_fail_format", 0)
                    + cd.get("cstatus_neg", 0))
        if pdh_fail:
            anom.append(f"pdh_fail={pdh_fail}")
        if b.get("collector_pin_verified") is not True:
            anom.append("B_pin_unverified")
        if a.get("effective_worker_cpus") != [0]:
            anom.append(f"A_wcpu={a.get('effective_worker_cpus')}")
        if b.get("effective_worker_cpus") != [0]:
            anom.append(f"B_wcpu={b.get('effective_worker_cpus')}")
        if b.get("effective_collector_cpus") != [2]:
            anom.append(f"B_ccpu={b.get('effective_collector_cpus')}")
        if a.get("samples_gt_150pct_median", 0) or b.get("samples_gt_150pct_median", 0):
            anom.append(f"spikes A={a.get('samples_gt_150pct_median')} "
                        f"B={b.get('samples_gt_150pct_median')}")
        if a.get("n_artifacts_excluded"):
            anom.append(f"A_art={a['n_artifacts_excluded']}")
        anomalies[pn] = anom

        p(f"   {pn}   {order}  {da:7.1f} {db:7.1f} {rel:+7.2f}  "
          f"{abs(rel):5.2f}  {a['exec_span_us']:6.0f} {b['exec_span_us']:6.0f}  "
          f"{a['effective_worker_cpus']} {b['effective_worker_cpus']} "
          f"{b['effective_collector_cpus']}  {str(b.get('collector_pin_verified')):5}"
          f"  {pdh_fail:3d}")
        p(f"        freq A: first={fmt(a.get('first_in_window_pct_perf'))} "
          f"last={fmt(a.get('last_in_window_pct_perf'))} "
          f"min={fmt(a.get('exec_only_min'))} max={fmt(a.get('exec_only_max'))} "
          f"med={fmt(a.get('exec_only_median'))} "
          f"spread={fmt(a.get('exec_only_spread_max_pct'))}% "
          f"tr={a.get('exec_only_n_transitions')} ramp={a.get('in_exec_ramp')}")
        p(f"        freq B: first={fmt(b.get('first_in_window_pct_perf'))} "
          f"last={fmt(b.get('last_in_window_pct_perf'))} "
          f"min={fmt(b.get('exec_only_min'))} max={fmt(b.get('exec_only_max'))} "
          f"med={fmt(b.get('exec_only_median'))} "
          f"spread={fmt(b.get('exec_only_spread_max_pct'))}% "
          f"tr={b.get('exec_only_n_transitions')} ramp={b.get('in_exec_ramp')}; "
          f"B_usable={b.get('n_samples_usable')} "
          f"in_win={b.get('n_samples_in_exec')} raw={b.get('n_collector_samples')} "
          f"art={b.get('n_artifacts_excluded')}")
        p(f"        anomalies: {anom if anom else 'none'}")

    p()
    med_signed = st.median(signed)
    mean_signed = st.fmean(signed)
    mn_signed, mx_signed = min(signed), max(signed)
    spread_signed = mx_signed - mn_signed
    med_abs = st.median(absd)
    mean_abs = st.fmean(absd)
    n_over = sum(1 for x in signed if abs(x) > MATERIALITY)
    pct_over = 100.0 * n_over / len(signed)

    p("   AGGREGATE over the 8 paired signed relative differences (%):")
    p(f"     values: {', '.join(f'{x:+.2f}' for x in signed)}")
    p(f"     paired median = {med_signed:+.2f}%")
    p(f"     paired mean   = {mean_signed:+.2f}%")
    p(f"     min = {mn_signed:+.2f}%  max = {mx_signed:+.2f}%  "
      f"spread(max-min) = {spread_signed:.2f} pp")
    p(f"     abs rel diff: median = {med_abs:.2f}%  mean = {mean_abs:.2f}%")
    p(f"     pairs exceeding +/-2.0%: {n_over}/{len(signed)} "
      f"= {pct_over:.1f}%")
    p(f"     by order: A->B pairs mean = "
      f"{st.fmean(order_means['A->B']):+.2f}% "
      f"(n={len(order_means['A->B'])}), B->A pairs mean = "
      f"{st.fmean(order_means['B->A']):+.2f}% "
      f"(n={len(order_means['B->A'])})")

    # pooled (v7 headline continuity): all 400 A iteration durations vs 400 B
    it_a = [it["dur_us"] for e in b6 if not e["collector_active"]
            for it in e["iterations"]]
    it_b = [it["dur_us"] for e in b6 if e["collector_active"]
            for it in e["iterations"]]
    pa, pb = st.median(it_a), st.median(it_b)
    pooled_rel = (pb - pa) / pa * 100.0
    p(f"   pooled iterations (v7 continuity): A median={pa:.1f} us (n={len(it_a)}),"
      f" B median={pb:.1f} us (n={len(it_b)}), "
      f"signed = {pooled_rel:+.2f}%")

    v7b6 = [e for e in d7["execs"] if e["bench"] == "B6"]
    v7a = [it["dur_us"] for e in v7b6 if not e["collector_active"]
           for it in e["iterations"]]
    v7b = [it["dur_us"] for e in v7b6 if e["collector_active"]
           for it in e["iterations"]]
    v7p = (st.median(v7b) - st.median(v7a)) / st.median(v7a) * 100.0
    p(f"   v7 same metric for reference: A={st.median(v7a):.1f} "
      f"B={st.median(v7b):.1f} signed = {v7p:+.2f}% (reported -5.71%)")

    p()
    p("   PREDECLARED 2.0% MATERIALITY CRITERION (unchanged):")
    crit = (abs(med_signed) <= MATERIALITY and abs(mean_signed) <= MATERIALITY
            and abs(pooled_rel) <= MATERIALITY)
    p(f"     |paired median| {abs(med_signed):.2f}% <= 2.0 -> "
      f"{abs(med_signed) <= MATERIALITY}")
    p(f"     |paired mean|   {abs(mean_signed):.2f}% <= 2.0 -> "
      f"{abs(mean_signed) <= MATERIALITY}")
    p(f"     |pooled signed| {abs(pooled_rel):.2f}% <= 2.0 -> "
      f"{abs(pooled_rel) <= MATERIALITY}")
    p(f"     => B6 COLLECTOR-PERTURBATION CRITERION: "
      f"{'PASS' if crit else 'FAIL'}")
    p()

    # ---------------- B9 ----------------
    p("3. B9 REPEATED B-SIDE EXECUTIONS (V8_B9_N_EXECS=8, collector active, "
      "500 us pace)")
    p("   exec  QPC_t0   QPC_t1   span_us raw inwin usable rejected(why) "
      "pdhfail first last   min    max    med    tr ramp cadence wpin cpin "
      "wcpu ccpu cover")
    usable_counts = []
    for i, e in enumerate(b9):
        cd = e.get("collector_diag") or {}
        pdh_fail = (cd.get("pdh_fail_collect", 0) + cd.get("pdh_fail_format", 0)
                    + cd.get("cstatus_neg", 0))
        usable_counts.append(e["n_samples_usable"])
        span = e["exec_span_us"]
        expected = int(span // PACE) + 1
        p(f"   {i}  {e['exec_t0_us']:8d} {e['exec_t1_us']:8d} {span:7.0f} "
          f"{e['n_collector_samples']:3d} {e['n_samples_in_exec']:4d} "
          f"{e['n_samples_usable']:6d} "
          f"{e['n_artifacts_excluded']:8d}(R2 20..240 filter) "
          f"{pdh_fail:7d} "
          f"{fmt(e.get('first_in_window_pct_perf'),1):5} "
          f"{fmt(e.get('last_in_window_pct_perf'),1):5} "
          f"{fmt(e.get('exec_only_min'),1):5} "
          f"{fmt(e.get('exec_only_max'),1):5} "
          f"{fmt(e.get('exec_only_median'),1):5} "
          f"{e.get('exec_only_n_transitions'):2} "
          f"{str(e.get('in_exec_ramp')):5} "
          f"{cd.get('pace_period_us'):3}us "
          f"{str(e.get('collector_pin_verified')):5} "
          f"{e['effective_worker_cpus']} {e['effective_collector_cpus']} "
          f"{'OK' if e['coverage_ok'] else 'FAIL'}")
        p(f"        mechanism: span/pace slots={expected} raw={e['n_collector_samples']} "
          f"loops={cd.get('loops')} first_sample_delay={cd.get('first_sample_delay_us')}us "
          f"max_gap={cd.get('max_sample_gap_us')}us "
          f"max_pdh_call={cd.get('max_single_pdh_call_us')}us "
          f"in_window={e['n_samples_in_exec']} (loss outside window="
          f"{e['n_collector_samples'] - e['n_samples_in_exec']}) "
          f"artifacts={e['n_artifacts_excluded']} "
          f"spread={fmt(e.get('exec_only_spread_max_pct'))}% "
          f"drift={fmt(e.get('iteration_drift_pct'))}% "
          f"gap_after_idle={e['after_idle_gap']}")
    p()
    p(f"   usable samples per exec: {usable_counts}")
    p(f"   min={min(usable_counts)} max={max(usable_counts)} "
      f"median={st.median(usable_counts)} mean={st.fmean(usable_counts):.1f}")
    p(f"   execs >= 10-sample floor: {sum(1 for x in usable_counts if x >= 10)}"
      f"/{len(usable_counts)}")
    p(f"   min margin above floor: {min(usable_counts) - FLOOR} samples")
    p(f"   spans (us): {[int(e['exec_span_us']) for e in b9]}")
    p(f"   span/500 theoretical max slots: "
      f"{[int(e['exec_span_us'] // PACE) + 1 for e in b9]}")
    p(f"   PDH failures total: "
      f"{sum((e['collector_diag']['pdh_fail_collect'] + e['collector_diag']['pdh_fail_format'] + e['collector_diag']['cstatus_neg']) for e in b9)}")
    p(f"   bit_identical: {all(e.get('bit_identical') for e in b9)}")
    p()

    # ---------------- P1/P2 counter adequacy ----------------
    p("4. COUNTER ADEQUACY (unchanged rules)")
    p1 = d8.get("pdh_probe_idle", {})
    p(f"   P1 idle probe: n={p1.get('n_samples')} in {p1.get('duration_s')}s, "
      f"cycle median={fmt(p1.get('cycle_interval_median_us'),1)}us, "
      f"distinct-change median="
      f"{fmt(p1.get('distinct_change_interval_median_us'),1)}us, "
      f"n_transitions={p1.get('n_transitions')}")
    stt = d8.get("step_test", {})
    p(f"   P2 step test: latency={fmt(stt.get('transition_latency_ms'),3)}ms, "
      f"idle_mean={fmt(stt.get('idle_mean_pct_perf'),1)} -> "
      f"load_mean={fmt(stt.get('load_mean_pct_perf'),1)}")
    p()

    # ---------------- v7 frequency finding survival ----------------
    p("5. V7 FREQUENCY FINDING SURVIVAL CHECK (B execs only, R2-filtered)")
    rows = [e for e in execs8 if e["collector_active"]]
    n_ramp = sum(1 for e in rows if e.get("in_exec_ramp"))
    n_spread_gt5 = sum(1 for e in rows
                       if (e.get("exec_only_spread_max_pct") or 0) > 5.0)
    p(f"   B execs with in_exec_ramp (tr>1 or spread>5%): {n_ramp}/{len(rows)}")
    p(f"   B execs with spread > 5.0%: {n_spread_gt5}/{len(rows)}")
    p("   per exec:")
    for i, e in enumerate(rows):
        p(f"     {i} {e['bench']:2} spread={fmt(e.get('exec_only_spread_max_pct'))}%"
          f" tr={e.get('exec_only_n_transitions')} "
          f"ramp={e.get('in_exec_ramp')} "
          f"usable={e['n_samples_usable']} "
          f"first={fmt(e.get('first_in_window_pct_perf'),1)} "
          f"last={fmt(e.get('last_in_window_pct_perf'),1)}")
    p()

    OUT.write_text("\n".join(L) + "\n", encoding="utf-8")
    print("\n".join(L))
    print(f"\n[wrote {OUT}]")


if __name__ == "__main__":
    main()
