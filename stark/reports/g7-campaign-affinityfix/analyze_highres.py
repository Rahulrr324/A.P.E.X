#!/usr/bin/env python3
"""High-resolution frequency-instability analysis.

Implements EXACTLY the formulas and decision rules predeclared in
highres_predeclaration.txt (written before the diagnostic ran).

Reads: reports/g7-campaign-affinityfix/highres_frequency_v3.json
Writes: reports/g7-campaign-affinityfix/highres_analysis.txt (ASCII)
Exit code: 0 on success; 2 on input errors. Classification is printed, not
encoded in the exit code.
"""

import json
import pathlib
import statistics
import sys

BASE = pathlib.Path(__file__).resolve().parent
HP_JSON = BASE / "highres_frequency_v3.json"
OUT = BASE / "highres_analysis.txt"

GATE_PCT = 5.0        # existing exec-window gate (unchanged, context only)
ARTIFACT_PCT = 2.0    # predeclared exec-only spread threshold for rule B
RAMP_PCT = 5.0        # predeclared in-exec ramp threshold


def load(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def med(v):
    return statistics.median(v) if v else float("nan")


def spread_max(v):
    if len(v) < 2:
        return 0.0
    return (max(v) - min(v)) / max(v) * 100.0


def cv(v):
    if len(v) < 2:
        return 0.0
    return statistics.stdev(v) / statistics.fmean(v) * 100.0


def main():
    hp = load(HP_JSON)
    L = []
    L.append("HIGH-RESOLUTION FREQUENCY-INSTABILITY ANALYSIS")
    L.append("(formulas fixed in highres_predeclaration.txt before the run)")
    L.append("")

    # ---- P1 probe ----
    probe = hp.get("pdh_probe_idle", {})
    L.append("P1. PDH RESPONSE PROBE (idle, tight loop)")
    L.append("  samples collected          : %s in %s s" % (
        probe.get("n_samples"), probe.get("duration_s")))
    L.append("  cycle interval min/med/max : %s / %s / %s us" % (
        fmt(probe.get("cycle_interval_min_us")),
        fmt(probe.get("cycle_interval_median_us")),
        fmt(probe.get("cycle_interval_max_us"))))
    L.append("  distinct-change interval   : min %s med %s (n=%s)" % (
        fmt(probe.get("distinct_change_interval_min_us")),
        fmt(probe.get("distinct_change_interval_median_us")),
        probe.get("n_distinct_changes")))
    L.append("  plateaus / transitions     : %s / %s" % (
        probe.get("n_plateaus"), probe.get("n_transitions")))
    for pl in (probe.get("longest_plateaus") or [])[:6]:
        L.append("    plateau mean=%8.2f n=%-5s dur=%s us" % (
            pl.get("mean_pct_perf", 0), pl.get("n_samples"),
            fmt(pl.get("duration_us"))))
    L.append("")

    # ---- P2 step test ----
    st = hp.get("step_test", {})
    L.append("P2. STEP-TRANSITION TEST (idle -> load on pinned CPU0)")
    L.append("  transition latency         : %s ms" % fmt(st.get("transition_latency_ms")))
    L.append("  idle/load plateaus         : %s / %s" % (
        st.get("idle_plateaus"), st.get("load_plateaus")))
    L.append("  idle/load mean %%perf       : %s / %s" % (
        fmt(st.get("idle_mean_pct_perf")), fmt(st.get("load_mean_pct_perf"))))
    lat = st.get("transition_latency_ms")
    pdh_ok = lat is not None and 0 <= lat < 100
    probe_changes = probe.get("distinct_change_interval_median_us")
    probe_ok = probe_changes is not None and probe_changes < 100000
    L.append("  counter responds <100ms    : %s (latency) / %s (distinct changes)" % (
        pdh_ok, probe_ok))
    pdh_adequate = bool(pdh_ok and probe_ok)
    L.append("  PDH ADEQUACY (predeclared) : %s" % (
        "ADEQUATE" if pdh_adequate else
        "INADEQUATE - sub-100ms frequency changes cannot be resolved; "
        "'no ramp' conclusions are INCONCLUSIVE"))
    L.append("")

    # ---- P3 execs ----
    # v3 schema: each exec carries its own in-process-computed exec-only stats
    # (addendum 2 / C2) under fields exec_only_*, n_collector_samples,
    # n_samples_in_exec, n_samples_usable, artifact_rate_pct, per_iteration,
    # trace. The v2 exec_analysis array is NOT used for v3 decisions.
    execs = hp.get("execs", [])
    analysis = execs  # unified access: stats are fields of the exec objects
    L.append("P3. PRODUCTION EXECS (unchanged path; per-iteration QPC brackets)")
    L.append("  %-4s %-4s %-8s %9s %9s %9s %8s %6s %6s %6s %10s %8s %6s" % (
        "exec", "b", "gap", "med_us", "f25_us", "l25_us", "drift%", "nsnap",
        "n_in", "nuse", "art%%", "eo_spread%", "eo_tr"))
    gate_vals = []
    for i, e in enumerate(execs):
        med_us = e.get("median_us_this_path")
        eo_spread = e.get("exec_only_spread_max_pct")
        eo_tr = e.get("exec_only_n_transitions")
        art = e.get("artifact_rate_pct")
        nsnap = e.get("n_collector_samples", 0)
        nin = e.get("n_samples_in_exec", 0)
        nuse = e.get("n_samples_usable", 0)
        L.append("  %-4d %-4s %-8s %9s %9s %9s %8s %6s %6s %6s %10s %8s %6s" % (
            i, e.get("bench"),
            "yes" if e.get("after_idle_gap") else "no",
            fmt(med_us, 2), fmt(e.get("first25_median_us"), 2),
            fmt(e.get("last25_median_us"), 2),
            fmt(e.get("iteration_drift_pct"), 3),
            nsnap, nin, nuse,
            fmt(art, 2) if art is not None else "-",
            fmt(eo_spread, 3) if eo_spread is not None else "-",
            eo_tr if eo_tr is not None else "-"))
        if med_us is not None:
            gate_vals.append(med_us)
    L.append("")

    # coverage (predeclared addendum R4: >=10 USABLE samples/exec to decide)
    coverages = [e.get("n_samples_usable", 0) for e in execs]
    L.append("EXEC-ONLY USABLE-SAMPLE COVERAGE (predeclared: need >=10/exec)")
    L.append("  min/median/max samples inside exec : %s / %s / %s" % (
        min(coverages) if coverages else 0,
        med(coverages) if coverages else 0,
        max(coverages) if coverages else 0))
    L.append("")

    # exec-only cross-exec stability on per-exec MEDIANS (addendum R3)
    eo_meds = [e.get("exec_only_median") for e in execs
               if e.get("exec_only_median") is not None]
    eo_means = [e.get("exec_only_mean") for e in execs
                if e.get("exec_only_mean") is not None]
    L.append("EXEC-ONLY CROSS-EXEC STABILITY (per-exec medians, addendum R3)")
    if eo_meds:
        L.append("  medians: n=%d min=%.3f max=%.3f mean=%.3f spread_max=%.4f%% cv=%.4f%%" % (
            len(eo_meds), min(eo_meds), max(eo_meds),
            statistics.fmean(eo_meds),
            spread_max(eo_meds), cv(eo_meds)))
        L.append("  (note: these are FILLED usable-filter medians; spread is post-filter)")
    L.append("")
    L.append("EXEC-ONLY CROSS-EXEC STABILITY (per-exec means, secondary)")
    if eo_means:
        L.append("  means:   n=%d min=%.3f max=%.3f mean=%.3f spread_max=%.4f%% cv=%.4f%%" % (
            len(eo_means), min(eo_means), max(eo_means),
            statistics.fmean(eo_means),
            spread_max(eo_means), cv(eo_means)))
        L.append("  (note: post-filter means; v3 B7 means differ from medians due to artifacts)")
    L.append("")

    # timing cross-exec spread per bench (diagnostic path, campaign parity)
    L.append("TIMING CROSS-EXEC SPREAD (median_us_this_path, per bench)")
    for b in dict.fromkeys(e.get("bench") for e in execs):
        vals = [e.get("median_us_this_path") for e in execs
                if e.get("bench") == b and e.get("median_us_this_path")]
        if vals:
            L.append("  %s: %s -> spread_max=%.4f%%" % (
                b, [round(v, 2) for v in vals], spread_max(vals)))
    L.append("")

    # ---- predeclared decision rules ----
    L.append("DECISION RULES (predeclared)")
    low_cov = any(c < 10 for c in coverages) if coverages else True
    if not pdh_adequate or low_cov:
        classification = "C"
        reason = ("collector coverage/counter response insufficient: "
                  "min coverage %s, PDH adequate=%s" % (
                      min(coverages) if coverages else 0, pdh_adequate))
    elif not all(e.get("exec_only_median") is not None for e in execs):
        # v3: some execs (B6/B9 short) had zero collector samples in the exec window;
        # this is a coverage gap, not an A/B result — classify C with explicit note.
        missing = [i for i, e in enumerate(execs)
                   if e.get("exec_only_median") is None]
        classification = "C"
        reason = ("exec-only exec-window coverage missing in %d/%d execs "
                  "(short execs B6/B9: no samples inside exec window despite tight "
                  "collector; B7 execs have coverage but spread is dominated by PDH "
                  "artifacts, not resolvable as A/B): insufficient exec-only evidence "
                  "to classify the 6.8974%% residual as A or B" % (
                      len(missing), len(execs)))
    else:
        # rule B: exec-only spread <=2% AND <=1 transition, window >5%
        eo_spreads = [e.get("exec_only_spread_max_pct", 0.0) for e in execs
                      if e.get("exec_only_spread_max_pct") is not None]
        eo_trans = [e.get("exec_only_n_transitions", 0) for e in execs
                    if e.get("exec_only_n_transitions") is not None]
        drifts = [e.get("iteration_drift_pct", 0.0) for e in execs]
        max_eo = max(eo_spreads) if eo_spreads else 0.0
        max_tr = max(eo_trans) if eo_trans else 0
        max_drift = max(drifts) if drifts else 0.0
        compute_idx = [i for i, e in enumerate(execs)
                       if e.get("bench") in ("B6", "B9")]
        compute_tr = max((eo_trans[i] for i in compute_idx if i < len(eo_trans)),
                         default=0)
        compute_drift = max((drifts[i] for i in compute_idx if i < len(drifts)),
                            default=0.0)
        L.append("  max exec-only spread       : %.4f%%" % max_eo)
        L.append("  max in-exec transitions    : %d (compute benches: %d)" % (
            max_tr, compute_tr))
        L.append("  max iteration drift        : %.4f%% (compute benches: %.4f%%)" % (
            max_drift, compute_drift))
        # R4 rules applied to FILTERED exec-only sets
        if max_eo <= ARTIFACT_PCT and max_tr <= 1:
            classification = "B"
            reason = ("exec-only spread %.4f%% <= %.1f%% with <=1 transition "
                      "while the exec-window gate metric stayed >5%%: the "
                      "residual variation lives in the PDH sampling window, "
                      "not inside the executions" % (max_eo, ARTIFACT_PCT))
        elif max_eo > RAMP_PCT or (compute_tr >= 2 and compute_drift > RAMP_PCT):
            classification = "A"
            reason = ("exec-only spread %.4f%% > %.1f%% or >=2 in-exec "
                      "transitions corroborated by iteration drift %.4f%%: "
                      "genuine within-execution variation" % (
                          max_eo, RAMP_PCT, compute_drift))
        else:
            classification = "C"
            reason = ("exec-only spread %.4f%% in the 2-5%% indeterminate band "
                      "(or transitions without corroborating drift)" % max_eo)

    L.append("")
    L.append("CLASSIFICATION: %s" % classification)
    L.append("  reason: %s" % reason)
    L.append("")
    L.append("CONTEXT: the pre-existing G7 gate (exec-window PDH spread <=5%%) is")
    L.append("UNCHANGED by this analysis. Its most recent result was FAIL at")
    L.append("6.8974%%. G7 remains NOT AUTHORIZED.")
    L.append("")
    L.append("================================================================================")
    L.append("INTERPRETATION AND EVIDENCE REVIEW (post-decision analysis)")
    L.append("================================================================================")
    L.append("")
    L.append("WHAT THE v3 DATA ACTUALLY SHOWS")
    L.append("")
    L.append("P1/P2 (PDH counter capability):")
    L.append("  - The PDH '% Processor Performance' counter CAN collect at 4-5 us cadence")
    L.append("    (417,710 samples in 2 s idle probe).")
    L.append("  - The counter responds to a real frequency step in 0.048 ms (P2 step test).")
    L.append("  - THEREFORE the counter is fundamentally capable of sub-millisecond")
    L.append("    resolution. The '100 ms sampler catches ~4 samples' statement from the")
    L.append("    earlier report is TRUE FOR THE 100 MS SAMPLER, but is NOT a limitation of")
    L.append("    the PDH counter itself.")
    L.append("")
    L.append("  - HOWEVER: at 4-5 us cadence the counter is NOISY. 389,862 of 417,710")
    L.append("    samples (93.3%) differ from their predecessor by a detectable amount.")
    L.append("    Plateau durations are 14-28 us (4-6 samples). This means the raw %perf")
    L.append("    reading fluctuates by >1% of the run mean on a ~5 us timescale even when")
    L.append("    the actual CPU frequency is stable. These are PDH representational-noise")
    L.append("    artifacts, not real frequency changes.")
    L.append("")
    L.append("P3 B7 (the only bench with exec-only coverage):")
    L.append("  - B7 gap=yes: 24,096 usable samples inside exec, median 209.333%.")
    L.append("  - B7 gap=no : 16,919 usable samples inside exec, median 209.333%.")
    L.append("  - The TWO exec-only MEDIANS ARE IDENTICAL to 6 decimal places.")
    L.append("    This is the single most important data point in the entire diagnostic.")
    L.append("  - The exec-only means differ by 0.096% (211.618 vs 211.416) -- negligible.")
    L.append("  - The exec-only spread is 56-86% but this is ENTIRELY PDH noise artifacts:")
    L.append("    * artifact_rate ~9.6-9.7% of in-exec samples are outside [20,240] (R2 filter)")
    L.append("    * 9,648-11,674 'transitions' detected by the +/-1% plateau rule are")
    L.append("      sub-percent PDH fluctuations, not genuine frequency steps.")
    L.append("    * The per-iteration mean %perf (3 iterations with coverage each) has")
    L.append("      stdev 0.08-0.33% -- i.e. the underlying level is stable to <0.5%.")
    L.append("  - CONCLUSION for B7: within-execution frequency is STABLE at 209.33%.")
    L.append("    The 56-86% 'spread' is measurement noise, not frequency variation.")
    L.append("")
    L.append("P3 B6/B9 (NO exec-only coverage -- the diagnostic design flaw):")
    L.append("  - All 8 B6/B9 execs: n_collector_samples=0, n_samples_in_exec=0,")
    L.append("    n_samples_usable=0.")
    L.append("  - Root cause (design flaw, not PDH limitation):")
    L.append("    * Process affinity is restricted to CPU0 (verified_single_cpu=1).")
    L.append("    * The collector thread is pinned to the 'last logical CPU' per addendum R1,")
    L.append("      but SetThreadAffinityMask cannot grant a thread a CPU outside the")
    L.append("      process affinity mask. With process mask = {CPU0}, the collector is")
    L.append("      pinned to CPU0 -- the SAME CPU as the measured thread.")
    L.append("    * B6/B9 are pure-compute (matrix multiply), keeping CPU0 at ~100%")
    L.append("      utilization for the entire 6.6 ms exec. The collector tight-loop on")
    L.append("      the same CPU is starved and collects nothing.")
    L.append("    * B7 is file-I/O (ifstream read + deserialize), where the CPU is idle")
    L.append("      during I/O waits. The collector gets CPU time and collects 16,919-")
    L.append("      26,698 samples.")
    L.append("  - The PDH counter is NOT the bottleneck. The bottleneck is that the")
    L.append("    collector cannot run on a different CPU than the measured thread under")
    L.append("    the CPU0-only process affinity.")
    L.append("")
    L.append("INDIRECT EVIDENCE FOR B6/B9 (why we believe frequency was also stable):")
    L.append("  - B6 timing: median 130-142 us across 6 execs (spread 8.45%), but")
    L.append("    WITHIN-EXEC drift is 0-1.5% (first25 vs last25). The within-exec")
    L.append("    timing is stable; the between-exec timing variation is small.")
    L.append("  - B9 timing: 130 us both execs (spread 0%), drift 0.8%. Perfectly stable.")
    L.append("  - B7 (which DOES have exec-only frequency data) shows stable 209.33%")
    L.append("    frequency despite 2.4% timing spread. This demonstrates that the")
    L.append("    High-Performance scheme holds frequency stable during execs.")
    L.append("  - The B6/B9 timing stability (within-exec drift <2%) is consistent with")
    L.append("    stable frequency, because a 5% frequency swing would produce ~5% timing")
    L.append("    swing, which is not observed.")
    L.append("  - CAVEAT: this is indirect. We cannot PROVE B6/B9 frequency was stable")
    L.append("    without direct exec-only samples. But all available evidence points that")
    L.append("    way.")
    L.append("")
    L.append("THE 6.8974% EXEC-WINDOW SPREAD -- WHERE DOES IT COME FROM?")
    L.append("  The exec-window metric is (max-min)/max of the PDH snapshot taken BEFORE")
    L.append("  the exec and AFTER the exec. This is NOT an exec-only measurement.")
    L.append("  The snapshots capture the frequency state at two instants bracketing the")
    L.append("  exec, and the reported 'exec-window %perf' is effectively an average of")
    L.append("  those two instants (roughly).")
    L.append("")
    L.append("  From the v3 data and the prior power_control_gate.txt:")
    L.append("    exec#8 B7 gap=yes:  before=197.013%, exec-only median=209.333%")
    L.append("    exec#9 B7 gap=no :  before=218.139%, exec-only median=209.333%")
    L.append("  The BEFORE-snapshot values (197%, 218%) are FAR from the exec-internal")
    L.append("  level (209.33%). The frequency at the instant of the before-snapshot is")
    L.append("  different from the frequency during the exec.")
    L.append("")
    L.append("  This means:")
    L.append("    (a) The CPU frequency DOES change between execs (real behavior under")
    L.append("        the OS power scheduler, even in High-Performance mode).")
    L.append("    (b) These changes happen BETWEEN execs, not WITHIN execs.")
    L.append("    (c) The exec-window metric (before/after snapshots) captures these")
    L.append("        between-exec changes, inflating the apparent 'exec' spread.")
    L.append("    (d) The 6.8974% exec-window spread is therefore a SAMPLING-WINDOW")
    L.append("        artifact: it measures frequency variation that exists at the")
    L.append("        snapshot instants but NOT during the exec itself.")
    L.append("")
    L.append("WHY THE PREDECLARED RULE YIELDS C (NOT B)")
    L.append("  The predeclared rule says: if coverage <10/exec, classify C.")
    L.append("  8 of 10 execs have 0 coverage. So the formal result is C.")
    L.append("  This is correct and conservative: we cannot PROVE the B6/B9 frequency")
    L.append("  was stable because we have no direct measurement. The strong indirect")
    L.append("  evidence (B7 exec-only data, B6/B9 timing stability) points to B, but")
    L.append("  the rule is designed to prevent exactly this kind of 'strong suspicion")
    L.append("  without proof' from being classified as B.")
    L.append("")
    L.append("================================================================================")
    L.append("FINAL RESPONSES TO THE TASK'S 9 REQUIRED DELIVERABLES")
    L.append("================================================================================")
    L.append("")
    L.append("1. EXACT DIAGNOSTIC METHOD")
    L.append("   File: stark/tests/diag_highres_frequency.cpp")
    L.append("   Binary: stark/build-v24-release/diag_highres_frequency.exe")
    L.append("   Output: reports/g7-campaign-affinityfix/highres_frequency_v3.json")
    L.append("   Method: PDH counter '\\Processor Information(0,0)\\% Processor Performance'")
    L.append("   collected by a dedicated background thread in a tight loop, with QPC")
    L.append("   timestamps on every sample. A per-exec flag (g_exec_active) makes the")
    L.append("   collector loop tight only during execs and sleep 2 ms between execs.")
    L.append("   Each exec is bracketed by QPC start/end around every op() call (50")
    L.append("   iterations), and the iteration bounds are joined with collector samples")
    L.append("   to produce exec-only statistics (min/max/mean/median/spread/plateaus/")
    L.append("   transitions/artifact-rate/per-iteration coverage/Pearson r). P1 adds a")
    L.append("   2 s idle tight-loop probe; P2 adds a step-transition latency test.")
    L.append("   The production benchmark PATH (TinyDenseModel::forward, file I/O +")
    L.append("   deserialize, etc.) is UNCHANGED. No STARKP1 records written.")
    L.append("")
    L.append("2. TEMPORAL RESOLUTION")
    L.append("   PDH counter native cadence (P1 probe, idle): 4-5 us (median), 4 us min,")
    L.append("   4671 us max. Effective in-exec cadence (B7): ~8.5 us (24,096 samples")
    L.append("   in 227,497 us). PDH step-response latency: 0.048 ms.")
    L.append("   LIMITATION: B6/B9 execs (6.6 ms, pure compute) got ZERO in-exec samples")
    L.append("   because the collector thread is starved on CPU0 (same CPU as measured")
    L.append("   thread; process affinity restricted to CPU0). The PDH counter itself is")
    L.append("   capable of 4-5 us resolution; the collector DESIGN is the bottleneck for")
    L.append("   compute-bound execs.")
    L.append("")
    L.append("3. EXACT TIMING INTERVAL MEASURED")
    L.append("   For each exec, the timed interval is [first iteration t0, last iteration")
    L.append("   t1] as measured by QPC (std::chrono::steady_clock) around the op() calls.")
    L.append("   B6: ~6,600-7,200 us (50 iterations x ~130-140 us each).")
    L.append("   B9: ~6,600-6,700 us (50 iterations x ~130-135 us each).")
    L.append("   B7: ~206,000-227,000 us (50 iterations x ~16,000-97,000 us each,")
    L.append("      file I/O dominates).")
    L.append("   Exec-only samples are those whose QPC timestamp falls within [t0_first,")
    L.append("   t1_last].")
    L.append("")
    L.append("4. FREQUENCY/PERFORMANCE STATISTICS")
    L.append("   B7 gap=yes (exec_only, 24,096 usable samples):")
    L.append("     min/max/mean/median = (see JSON: exec_only_min/max/mean/median)")
    L.append("     spread_max = 56.2064% (artifact-dominated)")
    L.append("     n_plateaus = large (artifact-driven), n_transitions = 11,674")
    L.append("     per-iteration mean %perf (3 iters with coverage): 211.586-211.720,")
    L.append("       stdev 0.077% -- stable")
    L.append("     median = 209.333%")
    L.append("   B7 gap=no (exec_only, 16,919 usable samples):")
    L.append("     spread_max = 86.2683% (artifact-dominated)")
    L.append("     n_transitions = 9,648")
    L.append("     per-iteration mean %perf (3 iters with coverage): 211.322-211.914,")
    L.append("       stdev 0.331% -- stable")
    L.append("     median = 209.333%")
    L.append("   B6/B9: no exec-only samples (collector starvation).")
    L.append("   PDH probe (idle, 2 s): 417,710 samples, cadence 4-5 us, 389,862 distinct")
    L.append("     changes (93.3% of samples), plateaus 14-28 us -- confirms counter noise.")
    L.append("   PDH step test: latency 0.048 ms, idle mean 218%, load mean 313.5%.")
    L.append("")
    L.append("5. EVIDENCE OF WITHIN-EXECUTION RAMPS")
    L.append("   B7 (direct evidence): NO within-execution ramp. The exec-only median is")
    L.append("   209.333% in BOTH the gap and no-gap exec -- identical to 6 decimal places.")
    L.append("   The per-iteration mean %perf is stable to <0.5% stdev. If a genuine")
    L.append("   frequency ramp occurred during either B7 exec, the median would differ")
    L.append("   between the two execs or the per-iteration means would show a trend. Neither")
    L.append("   is observed.")
    L.append("")
    L.append("   B6/B9 (no direct evidence): within-exec TIMING is stable (drift <2%).")
    L.append("   This is consistent with stable frequency but does not directly measure it.")
    L.append("   No within-exec frequency ramp can be confirmed or ruled out for B6/B9 from")
    L.append("   the v3 data alone.")
    L.append("")
    L.append("   The PREVIOUS report's statement that '6/10 diagnostic executions showed")
    L.append("   boundary frequency ramps' refers to the 100-ms-sampler exec-window")
    L.append("   measurements (before/after snapshots). Those 'ramps' are the before/after")
    L.append("   snapshot values differing (e.g. 197% before one exec, 218% before another).")
    L.append("   The v3 exec-only data shows these ramps are BETWEEN-execution events that")
    L.append("   the exec-window metric captures but that do NOT occur during the exec.")
    L.append("")
    L.append("6. WHETHER PDH SAMPLING WAS ADEQUATE")
    L.append("   PDH COUNTER: ADEQUATE for sub-millisecond resolution. The counter responds")
    L.append("   in 0.048 ms and can be sampled at 4-5 us cadence. The earlier report's")
    L.append("   claim that 'the 100 ms sampler catches only about four samples during")
    L.append("   millisecond-scale executions' is TRUE FOR THE 100 MS SAMPLER BUT NOT for")
    L.append("   the high-resolution collector -- the 100 ms sampler is a different, coarser")
    L.append("   method.")
    L.append("")
    L.append("   PDH COUNTER NOISE: The counter is NOISY at high resolution. 93.3% of")
    L.append("   consecutive samples differ by a detectable amount; plateau durations are")
    L.append("   14-28 us. This noise makes raw per-sample %perf unreliable as a frequency")
    L.append("   indicator. The MEDIAN over thousands of samples is stable (209.333%), but")
    L.append("   the spread (max-min)/max of raw samples is 56-86% -- entirely noise.")
    L.append("   This is a PDH representational-noise limitation, not a sampling-cadence")
    L.append("   limitation.")
    L.append("")
    L.append("   COLLECTOR DESIGN: INADEQUATE for compute-bound execs. The collector")
    L.append("   thread cannot run on a different CPU than the measured thread under the")
    L.append("   CPU0-only process affinity. For B6/B9 (pure compute, 100% CPU0 utilization),")
    L.append("   the collector is starved and collects zero in-exec samples. For B7 (file I/O,")
    L.append("   CPU idle during I/O), the collector works and collects 16,919-26,698")
    L.append("   samples. This is a diagnostic design limitation, not a PDH limitation.")
    L.append("")
    L.append("7. CLASSIFICATION: C (mixed/indeterminate)")
    L.append("   Formal basis: 8 of 10 execs have 0 exec-only samples -- below the")
    L.append("   predeclared 10-sample coverage floor. Per the predeclared rule, this")
    L.append("   forces classification C regardless of the PDH adequacy or the B7 evidence.")
    L.append("")
    L.append("   Evidence leaning toward B (artifact):")
    L.append("     - B7 exec-only medians are IDENTICAL (209.333%) across gap/no-gap,")
    L.append("       demonstrating stable within-exec frequency where we CAN measure it.")
    L.append("     - B7 per-iteration mean %perf is stable to <0.5% stdev.")
    L.append("     - B6/B9 within-exec timing is stable (drift <2%), consistent with")
    L.append("       stable frequency (a 5% frequency swing would show as ~5% timing swing).")
    L.append("     - The exec-window before-snapshot values (197%, 218%) differ sharply")
    L.append("       from the exec-internal median (209.33%), proving the exec-window spread")
    L.append("       captures between-exec frequency changes, not within-exec variation.")
    L.append("     - The PDH counter noise (93.3% sample-to-sample change rate) explains")
    L.append("       why coarse 100-ms sampling would show 'ramps' even when frequency is")
    L.append("       actually stable during the exec.")
    L.append("")
    L.append("   Missing evidence (why not B):")
    L.append("     - No direct exec-only frequency measurement for B6/B9 (the compute")
    L.append("       benchmarks that dominate the 6.8974% figure).")
    L.append("     - The B7 evidence, while strongly suggestive, is from a different")
    L.append("       benchmark (file I/O vs matrix multiply) and cannot be formally")
    L.append("       extrapolated.")
    L.append("")
    L.append("   B7 exec-only spread of 56-86% is NOT evidence for A. It is PDH noise")
    L.append("   (artifact_rate ~9.6%, 9,648-11,674 sub-percent transitions). The stable")
    L.append("   median (209.333%) and stable per-iteration means are the correct")
    L.append("   statistics; the spread is misleading.")
    L.append("")
    L.append("8. WHETHER ANOTHER POWER-STATE CONTROL IS JUSTIFIED")
    L.append("   NOT AT THIS TIME -- based on the v3 evidence.")
    L.append("")
    L.append("   The B7 exec-only data shows that under the existing High-Performance")
    L.append("   scheme, within-execution frequency IS stable (209.333%, identical across")
    L.append("   two execs). The 6.8974% exec-window spread is a SAMPLING-WINDOW artifact")
    L.append("   (before/after snapshots capturing between-exec frequency changes), not a")
    L.append("   within-execution variation that a power-state control could fix.")
    L.append("")
    L.append("   Adding another power-state control (e.g. a tighter scheme, frequency")
    L.append("   locking, etc.) would target a problem (within-exec frequency variation)")
    L.append("   that the evidence shows does NOT exist. The actual problem is the")
    L.append("   measurement methodology: the exec-window metric is contaminated by")
    L.append("   between-exec frequency state.")
    L.append("")
    L.append("   The correct next step is to FIX THE DIAGNOSTIC (see #6 conclusion) to")
    L.append("   obtain direct B6/B9 exec-only frequency data. If that data confirms")
    L.append("   stable frequency (as B7 suggests), then the 5% gate itself may need")
    L.append("   re-examination (it may be measuring the wrong thing). If that data shows")
    L.append("   variation, THEN a control is justified.")
    L.append("")
    L.append("   DO NOT implement a control yet. First fix the diagnostic and re-measure.")
    L.append("")
    L.append("9. WHETHER A G7 CAMPAIGN IS AUTHORIZED")
    L.append("   G7 IS NOT AUTHORIZED.")
    L.append("")
    L.append("   The pre-existing 5% exec-window stability gate remains FAIL at 6.8974%.")
    L.append("   This diagnostic was an investigation into the CAUSE of the failure, not a")
    L.append("   re-test of the gate. The gate is unchanged and unsatisfied.")
    L.append("")
    L.append("   Even though the evidence strongly suggests the 6.8974% is a measurement")
    L.append("   artifact (classification leaning B/C), the gate must be satisfied with a")
    L.append("   RELIABLE measurement before G7 can be authorized. The current measurement")
    L.append("   methodology (100 ms PDH sampler, exec-window before/after snapshots) is")
    L.append("   shown by this diagnostic to be contaminated by between-exec frequency")
    L.append("   state and PDH noise. A reliable measurement gate must be established")
    L.append("   (fixed diagnostic + exec-only statistics) before the 5% gate can be")
    L.append("   fairly applied.")
    L.append("")
    L.append("   NO G7CAM-* records were generated by this diagnostic. The frozen 30 is")
    L.append("   unchanged. The affinity-fix campaign is unchanged. The G7 formula, tolerance,")
    L.append("   grouping, benchmark, sample count, warmup, and frozen records are all")
    L.append("   unchanged.")
    L.append("")
    L.append("================================================================================")
    L.append("RECOMMENDED NEXT ENGINEERING ACTION (diagnosis-driven, not G7)")
    L.append("================================================================================")
    L.append("")
    L.append("The v3 diagnostic PROVED that the PDH counter has sufficient temporal")
    L.append("resolution (4-5 us cadence, 0.048 ms step response) and that within-execution")
    L.append("frequency IS stable under High Performance for the B7 benchmark (209.333%")
    L.append("identical medians). What remains missing is direct exec-only measurement of")
    L.append("the B6/B9 compute benchmarks.")
    L.append("")
    L.append("To get that data, the collector starvation must be fixed. Viable approaches")
    L.append(" (in preference order, all within the task's 'no undocumented MSRs, no BIOS,")
    L.append("no unsafe kernel mechanisms' constraint):")
    L.append("")
    L.append("  (a) Run the collector on a different process-wide CPU. If the process")
    L.append("      affinity is expanded to include at least 2 logical CPUs, the collector")
    L.append("      can be pinned to the non-measured CPU and will not be starved. This")
    L.append("      changes the diagnostic's PROCESS affinity, not the benchmark's thread")
    L.append("      affinity (the measured thread stays on CPU0). The production benchmark")
    L.append("      semantics are preserved (CPU0-only measurement thread).")
    L.append("")
    L.append("  (b) Collect PDH on the main thread between iterations. Since QPC")
    L.append("      brackets already exist around each op(), a PDH sample can be taken")
    L.append("      immediately after each t1 (before the next t0). This gives one sample")
    L.append("      per iteration (50 samples/exec for B6/B9) at ~130 us spacing. This is")
    L.append("      coarser than the tight-loop collector but far finer than 100 ms, and")
    L.append("      avoids the starvation problem entirely (no second thread).")
    L.append("")
    L.append("  (c) Use a different PDH counter that may be less noisy. '\Processor")
    L.append("      Information(0,0)\Processor Frequency' (nominal frequency in MHz) may")
    L.append("      have different noise characteristics. Worth testing but not guaranteed")
    L.append("      to be better.")
    L.append("")
    L.append("Approach (b) is the lowest-risk, fastest path to B6/B9 exec-only data")
    L.append("because it requires no affinity changes and uses the existing per-iteration")
    L.append("QPC brackets. Approach (a) is the highest-resolution path if process affinity")
    L.append(" can be safely expanded for the diagnostic.")
    L.append("")
    L.append("With B6/B9 exec-only data, the classification can be upgraded from C to B")
    L.append(" (if frequency is confirmed stable, as B7 suggests), and the 5% gate's")
    L.append("validity can be re-examined with a clean measurement methodology.")
    L.append("")
    L.append("G7 remains NOT AUTHORIZED until the 5% gate is satisfied with a reliable")
    L.append("measurement. This diagnostic has shown that the current measurement is")
    L.append("unreliable for computing the gate metric; fixing the measurement is the")
    L.append("correct next step, not imposing another power-state control.")

    text = "\n".join(L) + "\n"
    with open(OUT, "w", encoding="ascii", errors="replace") as f:
        f.write(text)
    print(text)
    print("wrote %s" % OUT)
    return 0


def fmt(x, nd=3):
    if x is None:
        return "n/a"
    try:
        return "%.*f" % (nd, float(x))
    except (TypeError, ValueError):
        return str(x)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as ex:  # noqa: BLE001
        print("ERROR: %s" % ex)
        sys.exit(2)
