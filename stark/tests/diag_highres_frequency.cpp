/**
 * Diagnostic: high-resolution CPU performance telemetry for the G7
 * reproducibility investigation. (Investigation only — not a G7 campaign.)
 *
 * Purpose: determine whether the residual 6.8974% exec-window
 * % Processor Performance spread under High Performance is
 *   A. genuine within-execution frequency variation, or
 *   B. a PDH sampling-window resolution artifact, or
 *   C. mixed/indeterminate.
 *
 * Rules honored:
 *   - Production benchmark semantics UNCHANGED: the same
 *     stark_p1::run_benchmark() path with campaign-equivalent configs
 *     (warmup=10, samples=50, thread=1, batch=1, seq=0, FP32).
 *   - Writes NO STARKP1 records; touches NO record store.
 *   - Per-iteration brackets are taken by THIS process around its own
 *     op() calls with QPC (same timer class as the production harness);
 *     the production harness median for the same exec is reported for
 *     parity but the per-iteration brackets are diagnostic-only.
 *   - Collector: one dedicated background thread, own PDH query
 *     (PDH queries are not thread-safe), tight loop, QPC timestamps on
 *     every sample.
 *   - ASCII-safe console output only.
 * Version history (predeclarations live alongside the report tree):
 *   v5 (2026-10-07): measurement-architecture fix — process affinity is no
 *     longer narrowed to CPU0; worker is explicitly pinned to CPU0, the
 *     collector to a separate logical CPU, both verified by readback +
 *     observed-CPU samples. Adds an A/B perturbation check.
 *   v6 (2026-10-07): physical-core separation — the collector target is
 *     chosen by the v6 rule (lowest LP that does not share a physical core
 *     with CPU0) and self-validated from GetLogicalProcessorInformationEx.
 *   v7 (2026-10-07): race-free gating + paced sampling (500 us) — fixes the
 *     pre-exec coverage race and the ~50 kHz rate perturbation; records
 *     per-exec collector diagnostics so any coverage shortfall is observable.
 *   v8 (2026-10-08): two tightly-controlled diagnostics only. (1) B6:
 *     position-matched A/B perturbation at the validated 500 us cadence,
 *     order alternated across N_PAIR adjacent pairs, repeated under the same
 *     thermal/power/background conditions; the predeclared 2.0% materiality
 *     criterion is not interpreted away. (2) B9: repeated identical B-side
 *     executions at the 500 us cadence, each recording the full exec-level
 *     evidence, with a mechanism probe for the prior 10-13 sample floor.
 * v8 does not change any G7 threshold, formula, benchmark timing semantics,
 * production binary, frozen 30 records, or the v7 finding.
 */

// ---- v8 operational scope (do not touch G7 spec / frozen artifacts) ----
// This diagnostic runs under session-scoped High Performance only if/when required
// by the B9 frequency-stability evidence; the exact original power scheme is
// captured before any change and independently restored and verified after.
// The diagnostic itself does not change G7 thresholds, formulas, benchmark timing
// semantics, production binaries, the frozen 30 records, or the v7 finding.
// ---- v8 control constants (predeclared, frozen for this diagnostic) ----

#define DIAG_VERSION "v8"
#define V8_B6_N_PAIRS 8
#define V8_B9_N_EXECS 8

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601  // GetCurrentProcessorNumber needs Vista+
#endif
#include <windows.h>
#include <pdh.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <functional>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "bench/BenchmarkHarness.h"
#include "bench/TinyDenseModel.h"
#include "common/ExperimentRecord.h"
#include "common/HardwareAffinity.h"

using namespace stark_p1;
using Clock = std::chrono::steady_clock;

static uint64_t qpc_us() {
    return static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::microseconds>(
            Clock::now().time_since_epoch())
            .count());
}

static std::string utc_now_ms() { return RecordStore::utc_timestamp_now(); }

// ---------------------------------------------------------------------------
// PDH collector (tight loop, dedicated thread, own query)
// ---------------------------------------------------------------------------
struct Sample {
    uint64_t t_us = 0;
    double pct_perf = 0;
    uint32_t cpu = 0;   // v5: logical CPU this sample was observed on
};

static std::vector<Sample> g_samples;
static std::mutex g_mu;
static std::atomic<bool> g_stop{false};
static std::atomic<uint64_t> g_cycles{0};
// Predeclared addendum 2 / C1 (v7: paced, gate-before-spawn): collector
// samples ONLY while an exec is in progress (500 us cadence spun on QPC)
// and sleeps between execs. Pinned to a separate physical core (v6), so it
// cannot steal execution resources from the measured thread.
static std::atomic<bool> g_exec_active{false};

// ---- v5: two-CPU separation evidence (machine-verified, not assumed) ----
static uint64_t g_system_mask = 0;          // system mask BEFORE any set
static uint64_t g_process_mask_before = 0;  // process mask BEFORE any set
static uint64_t g_process_mask_after = 0;   // process mask after {CPU0,CPU1}
static long g_worker_pin_ret = -1;          // SetThreadAffinityMask returned?
static uint32_t g_worker_pin_err = 0;       // GetLastError right after set
static uint64_t g_worker_pin_readback = 0;  // 2nd set returns current mask
static std::atomic<long> g_collector_pin_ret{-1};
static std::atomic<uint32_t> g_collector_pin_err{0};
static std::atomic<uint64_t> g_collector_pin_readback{0};
static std::atomic<bool> g_collector_ready{false};  // pinned + first sample
static std::thread g_coll_thread;  // v5: started/stopped per exec (A/B)

// ---- v6: topology-verified collector target (different PHYSICAL core) ----
// v5 pinned the collector to CPU1, which this machine's topology proves is
// CPU0's SMT sibling (P-core 0 = LP{0,1}): the collector was then starved
// during compute-bound execs (zero coverage) and stole execution resources
// from the worker when it did run. v6 selects the collector CPU with the
// predeclared rule from highres_v6_predeclaration_addendum.txt (lowest LP
// in the system mask that does NOT share a physical core with CPU0).
struct CoreLps {
    std::vector<uint32_t> lps;
    int eff = 0;
    int smt = 0;
};
static std::vector<CoreLps> g_cores;          // validated physical-core map
static uint32_t g_collector_target_cpu = 1;   // selected in main() before run
static uint64_t g_collector_target_mask = 1ull << 1;
static bool g_cpu1_shares_core_with_cpu0 = false;  // v5's failure, recorded

// ---- v7: paced sampling + per-exec collector diagnostics ----
// External probe (v7 addendum sec.1): a ~50 kHz tight PDH loop costs the
// measured thread ~25% even from another physical core; paced <=2 kHz
// showed no measurable loss. 500 us guarantees >=13 samples in the
// shortest observed B exec (~6.8 ms) while sitting 25x below the
// perturbing rate.
static const uint64_t k_pace_period_us = 500;  // cadence during B execs
static std::atomic<uint64_t> g_diag_loops{0};
static std::atomic<uint64_t> g_diag_ok{0};
static std::atomic<uint64_t> g_diag_fail_collect{0};
static std::atomic<uint64_t> g_diag_fail_format{0};
static std::atomic<uint64_t> g_diag_cstatus_neg{0};
static std::atomic<uint32_t> g_diag_last_err{0};
static std::atomic<uint64_t> g_diag_max_call_us{0};

static void diag_reset() {
    g_diag_loops.store(0, std::memory_order_relaxed);
    g_diag_ok.store(0, std::memory_order_relaxed);
    g_diag_fail_collect.store(0, std::memory_order_relaxed);
    g_diag_fail_format.store(0, std::memory_order_relaxed);
    g_diag_cstatus_neg.store(0, std::memory_order_relaxed);
    g_diag_last_err.store(0, std::memory_order_relaxed);
    g_diag_max_call_us.store(0, std::memory_order_relaxed);
}

static void diag_max_call(uint64_t us) {
    uint64_t prev = g_diag_max_call_us.load(std::memory_order_relaxed);
    while (us > prev &&
           !g_diag_max_call_us.compare_exchange_weak(
               prev, us, std::memory_order_relaxed)) {
    }
}

static void collector_main(PDH_HQUERY q, PDH_HCOUNTER perf) {
    // v6: explicitly pin the collector to the topology-selected target CPU
    // (a DIFFERENT physical core than the worker's CPU0 -- selected and
    // self-validated in main before this thread was started). Separation is
    // then VERIFIED, not assumed:
    //   (a) SetThreadAffinityMask readback -- a second identical set call
    //       returns the mask currently in effect, which must equal `want`;
    //   (b) every sample records GetCurrentProcessorNumber(), so the actual
    //       CPU the collector ran on is observable per exec in the JSON.
    const DWORD_PTR want = static_cast<DWORD_PTR>(g_collector_target_mask);
    SetLastError(0);
    DWORD_PTR prev1 = SetThreadAffinityMask(GetCurrentThread(), want);
    const DWORD err1 = GetLastError();
    DWORD_PTR prev2 = SetThreadAffinityMask(GetCurrentThread(), want);  // readback
    g_collector_pin_ret.store(prev1 ? 1 : 0, std::memory_order_relaxed);
    g_collector_pin_err.store(prev1 ? 0u : static_cast<uint32_t>(err1),
                              std::memory_order_relaxed);
    g_collector_pin_readback.store(static_cast<uint64_t>(prev2),
                                   std::memory_order_relaxed);
    while (!g_stop.load(std::memory_order_relaxed)) {
        const bool tight = g_exec_active.load(std::memory_order_relaxed);
        const uint64_t t_in = qpc_us();
        PDH_FMT_COUNTERVALUE v{};
        const DWORD rc = PdhCollectQueryData(q);
        const uint64_t t_out = qpc_us();
        diag_max_call(t_out - t_in);
        bool got = false;
        if (rc == ERROR_SUCCESS) {
            const DWORD frc = PdhGetFormattedCounterValue(
                perf, PDH_FMT_DOUBLE, nullptr, &v);
            if (frc == ERROR_SUCCESS) {
                if (static_cast<LONG>(v.CStatus) >= 0) {
                    got = true;
                } else {
                    g_diag_cstatus_neg.fetch_add(1, std::memory_order_relaxed);
                }
            } else {
                g_diag_fail_format.fetch_add(1, std::memory_order_relaxed);
                g_diag_last_err.store(frc, std::memory_order_relaxed);
            }
        } else {
            g_diag_fail_collect.fetch_add(1, std::memory_order_relaxed);
            g_diag_last_err.store(rc, std::memory_order_relaxed);
        }
        if (got) {
            Sample s;
            s.t_us = qpc_us();
            s.pct_perf = v.doubleValue;
            s.cpu = static_cast<uint32_t>(GetCurrentProcessorNumber());
            {
                std::lock_guard<std::mutex> lk(g_mu);
                g_samples.push_back(s);
            }
            g_diag_ok.fetch_add(1, std::memory_order_relaxed);
            g_collector_ready.store(true, std::memory_order_release);
        }
        g_cycles.fetch_add(1, std::memory_order_relaxed);
        g_diag_loops.fetch_add(1, std::memory_order_relaxed);
        if (tight) {
            // v7: spin to the next cadence boundary anchored on this
            // sample's start (g_stop checked inside: <=1-iteration stop lag)
            const uint64_t due = t_in + k_pace_period_us;
            while (!g_stop.load(std::memory_order_relaxed) &&
                   qpc_us() < due) {
            }
        } else {
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
        }
    }
}

// ---------------------------------------------------------------------------
// Plateau decomposition (predeclared: consecutive samples within +/-1% of
// the run's mean form a plateau; changes between plateaus with means
// differing by >1% are transitions)
// ---------------------------------------------------------------------------
struct Plateau {
    size_t begin = 0, end = 0;  // [begin, end) into the sample vector
    double mean = 0;
};

static std::vector<Plateau> plateaus_of(const std::vector<Sample>& ss) {
    std::vector<Plateau> out;
    if (ss.empty()) return out;
    double total = 0;
    for (const auto& s : ss) total += s.pct_perf;
    const double run_mean = total / static_cast<double>(ss.size());

    size_t i = 0;
    while (i < ss.size()) {
        double acc = ss[i].pct_perf;
        size_t j = i + 1;
        // grow the run while every value stays within 1% of the run mean
        while (j < ss.size() &&
               std::fabs(ss[j].pct_perf - run_mean) <=
                   0.01 * std::fabs(run_mean) &&
               std::fabs((acc + ss[j].pct_perf) /
                             static_cast<double>(j - i + 1) -
                         run_mean) <= 0.01 * std::fabs(run_mean)) {
            acc += ss[j].pct_perf;
            ++j;
        }
        Plateau p;
        p.begin = i;
        p.end = j;
        p.mean = acc / static_cast<double>(j - i);
        out.push_back(p);
        i = j;
    }
    return out;
}

static int count_transitions(const std::vector<Plateau>& ps) {
    int t = 0;
    for (size_t i = 1; i < ps.size(); ++i)
        if (std::fabs(ps[i].mean - ps[i - 1].mean) >
            0.01 * std::max(std::fabs(ps[i].mean), std::fabs(ps[i - 1].mean)))
            ++t;
    return t;
}

static double spread_max(const std::vector<double>& v) {
    if (v.size() < 2) return 0.0;
    double mn = v[0], mx = v[0];
    for (double x : v) {
        mn = std::min(mn, x);
        mx = std::max(mx, x);
    }
    return (mx - mn) / mx * 100.0;
}

static double median_of(std::vector<double> v) {
    if (v.empty()) return 0.0;
    std::sort(v.begin(), v.end());
    size_t n = v.size();
    return n % 2 ? v[n / 2] : 0.5 * (v[n / 2 - 1] + v[n / 2]);
}

// ---------------------------------------------------------------------------
// One exec: production harness run + per-iteration QPC brackets, with the
// collector running throughout (v5: collector is STARTED before a
// collector-active (B) exec and fully STOPPED (thread joined) for a
// no-collector (A) exec -- all lifecycle work happens OUTSIDE the timed
// region; no sleeps are added inside [t0,t1] of any measured iteration.
// ---------------------------------------------------------------------------
static JsonValue run_exec(const char* bench_id, bool collector_on,
                          bool after_idle_gap, int cycle,
                          PDH_HQUERY q, PDH_HCOUNTER perf,
                          const std::function<void()>& op,
                          std::vector<double>& iter_us_out) {
    JsonValue e = JsonValue::object();
    e.set("bench", JsonValue::str(bench_id));
    e.set("collector_active", JsonValue::boolean(collector_on));
    e.set("condition", JsonValue::str(collector_on ? "B_collector" : "A_no_collector"));
    e.set("after_idle_gap", JsonValue::boolean(after_idle_gap));
    e.set("cycle", JsonValue::integer(cycle));

    // ---- collector lifecycle (v5/v6/v7): absent for A, present for B ----
    // v7 FIX (gate-before-spawn): store g_exec_active BEFORE spawning the
    // collector, so its very first loop iteration reads tight=true and it
    // can never take the pre-exec sleep that (with Windows' 15.6 ms timer
    // granularity) outlived whole ~7 ms execs in v6 -> zero coverage.
    g_exec_active.store(collector_on, std::memory_order_relaxed);
    long ready_wait_ms = -1;
    if (collector_on) {
        if (!g_coll_thread.joinable()) {
            g_stop.store(false, std::memory_order_relaxed);
            g_collector_ready.store(false, std::memory_order_relaxed);
            diag_reset();
            const uint64_t t_spawn = qpc_us();
            g_coll_thread = std::thread(collector_main, q, perf);
            // bounded wait: collector pins itself to the target CPU and
            // produces its first PDH sample before the timed region begins
            for (int i = 0; i < 5000 &&
                           !g_collector_ready.load(std::memory_order_acquire); ++i) {
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
            }
            ready_wait_ms = static_cast<long>((qpc_us() - t_spawn) / 1000);
        }
    } else if (g_coll_thread.joinable()) {
        g_stop.store(true, std::memory_order_relaxed);
        g_coll_thread.join();
        g_stop.store(false, std::memory_order_relaxed);
    }

    // clear samples accumulated before this exec (the collector is already
    // running in paced mode for B; for A no collector thread exists), then
    // snapshot this exec's diagnostics baseline
    uint64_t t_ref = 0;
    {
        std::lock_guard<std::mutex> lk(g_mu);
        g_samples.clear();
    }
    t_ref = qpc_us();
    const uint64_t d_loops0 = g_diag_loops.load(std::memory_order_relaxed);
    const uint64_t d_ok0 = g_diag_ok.load(std::memory_order_relaxed);
    const uint64_t d_fc0 =
        g_diag_fail_collect.load(std::memory_order_relaxed);
    const uint64_t d_ff0 = g_diag_fail_format.load(std::memory_order_relaxed);
    const uint64_t d_cs0 = g_diag_cstatus_neg.load(std::memory_order_relaxed);

    uint64_t worker_cpu_bits = 0;  // observed CPUs of the worker thread

    const int WARMUP = 10;
    const int MEAS = 50;

    JsonValue iters = JsonValue::array();
    std::vector<double> prod_parity;  // production-harness-style durations
    std::vector<std::pair<uint64_t, uint64_t>> prod_parity_bounds;

    // ---- production warmup (unchanged count, un-timed here) ----
    worker_cpu_bits |= (uint64_t{1} << GetCurrentProcessorNumber());
    for (int i = 0; i < WARMUP; ++i) op();

    // ---- 50 measured iterations, each bracketed with QPC ----
    for (int i = 0; i < MEAS; ++i) {
        // observed worker CPU sampled OUTSIDE the [t0,t1] bracket so the
        // timing semantics of op() are unchanged
        worker_cpu_bits |= (uint64_t{1} << GetCurrentProcessorNumber());
        uint64_t t0 = qpc_us();
        op();
        uint64_t t1 = qpc_us();
        worker_cpu_bits |= (uint64_t{1} << GetCurrentProcessorNumber());
        prod_parity_bounds.emplace_back(t0, t1);
        JsonValue o = JsonValue::object();
        o.set("i", JsonValue::integer(i));
        o.set("t0_us", JsonValue::uinteger(t0));
        o.set("t1_us", JsonValue::uinteger(t1));
        o.set("dur_us", JsonValue::number(static_cast<double>(t1 - t0)));
        iters.append(o);
        prod_parity.push_back(static_cast<double>(t1 - t0));
    }
    iter_us_out = prod_parity;

    e.set("t_start_utc", JsonValue::str(utc_now_ms()));
    e.set("t_end_utc", JsonValue::str(utc_now_ms()));

    // production parity: same statistic the harness computes (median)
    e.set("median_us_this_path",
          JsonValue::number(median_of(prod_parity)));
    double m = median_of(prod_parity);
    long spikes = 0;
    for (double d : prod_parity)
        if (d > 1.5 * m) ++spikes;
    e.set("samples_gt_150pct_median", JsonValue::integer(spikes));

    // per-iteration drift (predeclared: first 25 vs last 25 medians)
    std::vector<double> head(prod_parity.begin(),
                             prod_parity.begin() + 25);
    std::vector<double> tail(prod_parity.end() - 25, prod_parity.end());
    double mh = median_of(head), mt = median_of(tail);
    e.set("first25_median_us", JsonValue::number(mh));
    e.set("last25_median_us", JsonValue::number(mt));
    e.set("iteration_drift_pct",
          JsonValue::number(std::fabs(mt - mh) / std::fabs(mh) * 100.0));

    e.set("iterations", std::move(iters));

    // End the tight-loop window, stop the collector (thread joined BEFORE
    // the snapshot so no sample can arrive mid-computation), then snapshot
    // THIS exec's samples and compute exec-only statistics in-process (C2).
    g_exec_active.store(false, std::memory_order_relaxed);
    if (collector_on && g_coll_thread.joinable()) {
        g_stop.store(true, std::memory_order_relaxed);
        g_coll_thread.join();
        g_stop.store(false, std::memory_order_relaxed);
    }
    {
        std::lock_guard<std::mutex> lk(g_mu);
        std::vector<Sample> snap = g_samples;

        // iteration brackets [t0_first .. t1_last]
        uint64_t exec_t0 = UINT64_MAX, exec_t1 = 0;
        for (const auto& j : prod_parity_bounds) {
            exec_t0 = std::min(exec_t0, j.first);
            exec_t1 = std::max(exec_t1, j.second);
        }

        std::vector<Sample> inside;
        for (const auto& s : snap)
            if (s.t_us >= exec_t0 && s.t_us <= exec_t1) inside.push_back(s);

        // R2 artifact filter: usable iff 20.0 <= pct_perf <= 240.0
        std::vector<Sample> usable;
        long artifacts = 0;
        for (const auto& s : inside) {
            if (s.pct_perf >= 20.0 && s.pct_perf <= 240.0) usable.push_back(s);
            else ++artifacts;
        }

        e.set("n_collector_samples", JsonValue::uinteger(snap.size()));
        e.set("exec_t0_us", JsonValue::uinteger(exec_t0));
        e.set("exec_t1_us", JsonValue::uinteger(exec_t1));
        e.set("exec_span_us",
              exec_t0 == UINT64_MAX
                  ? JsonValue::null()
                  : JsonValue::number(static_cast<double>(exec_t1 - exec_t0)));
        e.set("n_samples_in_exec", JsonValue::uinteger(inside.size()));
        e.set("n_samples_usable", JsonValue::uinteger(usable.size()));
        e.set("n_artifacts_excluded", JsonValue::integer(artifacts));
        e.set("artifact_rate_pct",
              inside.empty()
                  ? JsonValue::null()
                  : JsonValue::number(100.0 * artifacts /
                                      static_cast<double>(inside.size())));

        // ---- v7: per-exec collector diagnostics (B execs only) ----
        if (collector_on) {
            uint64_t gap_max = 0;
            for (size_t k = 1; k < snap.size(); ++k)
                gap_max = std::max(gap_max, snap[k].t_us - snap[k - 1].t_us);
            JsonValue dg = JsonValue::object();
            dg.set("ready_wait_ms", JsonValue::integer(
                                        static_cast<int>(ready_wait_ms)));
            dg.set("pace_period_us",
                   JsonValue::uinteger(k_pace_period_us));
            dg.set("loops",
                   JsonValue::uinteger(g_diag_loops.load() - d_loops0));
            dg.set("pdh_ok",
                   JsonValue::uinteger(g_diag_ok.load() - d_ok0));
            dg.set("pdh_fail_collect",
                   JsonValue::uinteger(g_diag_fail_collect.load() - d_fc0));
            dg.set("pdh_fail_format",
                   JsonValue::uinteger(g_diag_fail_format.load() - d_ff0));
            dg.set("cstatus_neg",
                   JsonValue::uinteger(g_diag_cstatus_neg.load() - d_cs0));
            dg.set("last_err",
                   JsonValue::uinteger(g_diag_last_err.load()));
            dg.set("max_single_pdh_call_us",
                   JsonValue::uinteger(g_diag_max_call_us.load()));
            dg.set("first_sample_delay_us",
                   snap.empty()
                       ? JsonValue::null()
                       : JsonValue::number(
                             static_cast<double>(snap.front().t_us) -
                             static_cast<double>(t_ref)));
            dg.set("max_sample_gap_us", JsonValue::uinteger(gap_max));
            e.set("collector_diag", std::move(dg));
        } else {
            e.set("collector_diag", JsonValue::null());
        }

        // ---- v5: first/last in-window %perf + ramp flag + coverage floor ----
        if (!usable.empty()) {
            e.set("first_in_window_pct_perf",
                  JsonValue::number(usable.front().pct_perf));
            e.set("last_in_window_pct_perf",
                  JsonValue::number(usable.back().pct_perf));
        } else {
            e.set("first_in_window_pct_perf", JsonValue::null());
            e.set("last_in_window_pct_perf", JsonValue::null());
        }

        // ---- v5: observed affinity evidence per exec ----
        {
            JsonValue warr = JsonValue::array();
            for (uint32_t c = 0; c < 64; ++c)
                if (worker_cpu_bits & (uint64_t{1} << c))
                    warr.append(JsonValue::uinteger(c));
            e.set("effective_worker_cpus", std::move(warr));

            uint64_t coll_bits = 0;
            for (const auto& s : snap)
                coll_bits |= (uint64_t{1} << s.cpu);
            JsonValue carr = JsonValue::array();
            for (uint32_t c = 0; c < 64; ++c)
                if (coll_bits & (uint64_t{1} << c))
                    carr.append(JsonValue::uinteger(c));
            e.set("effective_collector_cpus", std::move(carr));
            if (collector_on) {
                // v6: readback must equal the topology-selected target mask,
                // at least one sample must have been observed, and every
                // observed sample CPU must be inside that mask (v5's vacuous
                // truth for zero-sample execs is deliberately removed)
                e.set("collector_pin_verified",
                      JsonValue::boolean(
                          g_collector_pin_readback.load() ==
                              g_collector_target_mask &&
                          coll_bits != 0 &&
                          (coll_bits & ~g_collector_target_mask) == 0));
            } else {
                e.set("collector_pin_verified", JsonValue::null());
            }
            JsonValue pj = JsonValue::object();
            pj.set("worker_set_api_return",
                   JsonValue::integer(g_worker_pin_ret));
            pj.set("worker_set_api_last_error",
                   JsonValue::uinteger(g_worker_pin_err));
            pj.set("worker_pin_readback_mask",
                   JsonValue::uinteger(g_worker_pin_readback));
            pj.set("collector_set_api_return",
                   JsonValue::integer(g_collector_pin_ret.load()));
            pj.set("collector_set_api_last_error",
                   JsonValue::uinteger(g_collector_pin_err.load()));
            pj.set("collector_target_cpu",
                   JsonValue::uinteger(g_collector_target_cpu));
            pj.set("collector_pin_readback_mask",
                   JsonValue::uinteger(g_collector_pin_readback.load()));
            pj.set("process_mask_raw", JsonValue::uinteger(g_process_mask_after));
            pj.set("system_mask_raw", JsonValue::uinteger(g_system_mask));
            e.set("pin_evidence", std::move(pj));
        }

        if (!usable.empty()) {
            std::vector<double> vals;
            std::vector<double> ts;
            for (const auto& s : usable) {
                vals.push_back(s.pct_perf);
                ts.push_back(static_cast<double>(s.t_us));
            }
            e.set("exec_only_min", JsonValue::number(*std::min_element(vals.begin(), vals.end())));
            e.set("exec_only_max", JsonValue::number(*std::max_element(vals.begin(), vals.end())));
            double sum = 0;
            for (double x : vals) sum += x;
            e.set("exec_only_mean", JsonValue::number(sum / vals.size()));
            e.set("exec_only_median", JsonValue::number(median_of(vals)));
            e.set("exec_only_spread_max_pct",
                  JsonValue::number(spread_max(vals)));
            auto ps = plateaus_of(usable);
            e.set("exec_only_n_plateaus", JsonValue::uinteger(ps.size()));
            const int ntr = count_transitions(ps);
            e.set("exec_only_n_transitions", JsonValue::integer(ntr));
            // predeclared in-exec ramp: >1 transition OR spread >5.0%
            e.set("in_exec_ramp",
                  JsonValue::boolean(ntr > 1 ||
                                     spread_max(vals) > 5.0));
            // predeclared coverage floor: >=10 usable in-window samples
            e.set("coverage_ok",
                  JsonValue::boolean(usable.size() >= 10));

            // C3: per-iteration mean usable %perf + Pearson r(dur, %perf)
            JsonValue per_iter = JsonValue::array();
            std::vector<double> it_mean, it_dur;
            for (size_t k = 0; k < prod_parity_bounds.size(); ++k) {
                uint64_t a = prod_parity_bounds[k].first;
                uint64_t b = prod_parity_bounds[k].second;
                std::vector<double> cov;
                for (const auto& s : usable)
                    if (s.t_us >= a && s.t_us <= b) cov.push_back(s.pct_perf);
                if (!cov.empty()) {
                    double m = 0;
                    for (double x : cov) m += x;
                    m /= static_cast<double>(cov.size());
                    it_mean.push_back(m);
                    it_dur.push_back(prod_parity[k]);
                    JsonValue jo = JsonValue::object();
                    jo.set("i", JsonValue::integer(static_cast<int>(k)));
                    jo.set("dur_us", JsonValue::number(prod_parity[k]));
                    jo.set("mean_pct_perf", JsonValue::number(m));
                    jo.set("n_covering", JsonValue::uinteger(cov.size()));
                    per_iter.append(jo);
                }
            }
            e.set("per_iteration", std::move(per_iter));
            e.set("n_iterations_with_coverage",
                  JsonValue::uinteger(it_mean.size()));
            if (it_mean.size() >= 5) {
                double n = static_cast<double>(it_mean.size());
                double md = 0, mm = 0;
                for (size_t k = 0; k < it_mean.size(); ++k) {
                    md += it_dur[k];
                    mm += it_mean[k];
                }
                md /= n; mm /= n;
                double sxy = 0, sxx = 0, syy = 0;
                for (size_t k = 0; k < it_mean.size(); ++k) {
                    double dx = it_dur[k] - md, dy = it_mean[k] - mm;
                    sxy += dx * dy;
                    sxx += dx * dx;
                    syy += dy * dy;
                }
                e.set("r_dur_vs_pctperf",
                      (sxx > 0 && syy > 0)
                          ? JsonValue::number(sxy / std::sqrt(sxx * syy))
                          : JsonValue::null());
            } else {
                e.set("r_dur_vs_pctperf", JsonValue::null());
            }

            // C4: downsampled trace (max 400 samples) as evidence
            JsonValue trace = JsonValue::array();
            size_t step = std::max<size_t>(1, usable.size() / 400);
            for (size_t k = 0; k < usable.size(); k += step) {
                JsonValue to = JsonValue::object();
                to.set("t_us", JsonValue::uinteger(usable[k].t_us));
                to.set("pct_perf", JsonValue::number(usable[k].pct_perf));
                trace.append(to);
            }
            e.set("trace", std::move(trace));
        } else {
            e.set("exec_only_min", JsonValue::null());
            e.set("exec_only_max", JsonValue::null());
            e.set("exec_only_mean", JsonValue::null());
            e.set("exec_only_median", JsonValue::null());
            e.set("exec_only_spread_max_pct", JsonValue::null());
            e.set("exec_only_n_plateaus", JsonValue::null());
            e.set("exec_only_n_transitions", JsonValue::null());
            e.set("r_dur_vs_pctperf", JsonValue::null());
            e.set("n_iterations_with_coverage", JsonValue::uinteger(0));
            e.set("in_exec_ramp", JsonValue::null());
            e.set("coverage_ok", JsonValue::boolean(false));
        }
    }
    return e;
}

// ---------------------------------------------------------------------------
// P1: PDH response probe (tight-loop collection for a fixed wall duration)
// ---------------------------------------------------------------------------
static JsonValue pdh_probe(PDH_HQUERY q, PDH_HCOUNTER perf, int seconds) {
    JsonValue p = JsonValue::object();
    std::vector<Sample> local;
    const uint64_t t_end = qpc_us() +
                           static_cast<uint64_t>(seconds) * 1000000ull;

    uint64_t last_change_t = qpc_us();
    double last_val = -1;
    std::vector<double> stable_intervals_us;

    while (qpc_us() < t_end) {
        PDH_FMT_COUNTERVALUE v{};
        if (PdhCollectQueryData(q) == ERROR_SUCCESS &&
            PdhGetFormattedCounterValue(perf, PDH_FMT_DOUBLE, nullptr, &v) ==
                ERROR_SUCCESS &&
            static_cast<LONG>(v.CStatus) >= 0) {
            Sample s;
            s.t_us = qpc_us();
            s.pct_perf = v.doubleValue;
            local.push_back(s);
            if (last_val >= 0 && std::fabs(s.pct_perf - last_val) > 1e-9) {
                stable_intervals_us.push_back(
                    static_cast<double>(s.t_us - last_change_t));
                last_change_t = s.t_us;
            }
            last_val = s.pct_perf;
        }
    }

    std::vector<double> cycle_times;
    for (size_t i = 1; i < local.size(); ++i)
        cycle_times.push_back(static_cast<double>(local[i].t_us -
                                                  local[i - 1].t_us));

    p.set("n_samples", JsonValue::uinteger(local.size()));
    p.set("duration_s", JsonValue::integer(seconds));
    if (!cycle_times.empty()) {
        p.set("cycle_interval_min_us", JsonValue::number(*std::min_element(
                                           cycle_times.begin(), cycle_times.end())));
        p.set("cycle_interval_median_us",
              JsonValue::number(median_of(cycle_times)));
        p.set("cycle_interval_max_us", JsonValue::number(*std::max_element(
                                           cycle_times.begin(), cycle_times.end())));
    }
    if (!stable_intervals_us.empty()) {
        p.set("distinct_change_interval_min_us",
              JsonValue::number(*std::min_element(stable_intervals_us.begin(),
                                                  stable_intervals_us.end())));
        p.set("distinct_change_interval_median_us",
              JsonValue::number(median_of(stable_intervals_us)));
        p.set("n_distinct_changes", JsonValue::uinteger(stable_intervals_us.size()));
    }
    auto ps = plateaus_of(local);
    p.set("n_plateaus", JsonValue::uinteger(ps.size()));
    p.set("n_transitions", JsonValue::integer(count_transitions(ps)));
    JsonValue pj = JsonValue::array();
    // report the 12 longest plateaus as a compact response-time picture
    std::vector<Plateau> sorted = ps;
    std::sort(sorted.begin(), sorted.end(), [](const Plateau& a, const Plateau& b) {
        return (a.end - a.begin) > (b.end - b.begin);
    });
    for (size_t k = 0; k < std::min<size_t>(12, sorted.size()); ++k) {
        JsonValue o = JsonValue::object();
        const auto& pl = sorted[k];
        o.set("n_samples", JsonValue::uinteger(pl.end - pl.begin));
        o.set("mean_pct_perf", JsonValue::number(pl.mean));
        o.set("start_us", JsonValue::uinteger(local[pl.begin].t_us));
        o.set("end_us", JsonValue::uinteger(local[pl.end - 1].t_us));
        o.set("duration_us",
              JsonValue::number(static_cast<double>(
                  local[pl.end - 1].t_us - local[pl.begin].t_us)));
        pj.append(o);
    }
    p.set("longest_plateaus", std::move(pj));
    return p;
}

// ---------------------------------------------------------------------------
// P2: step-transition response test (load thread toggles, probe latency)
// ---------------------------------------------------------------------------
struct StepResult {
    double latency_ms = -1;   // time from toggle to first plateau change
    int n_plateaus_idle = 0;
    int n_plateaus_load = 0;
    double idle_mean = 0, load_mean = 0;
    std::vector<double> seg_means;
    bool first_val_missing = false;
};

static StepResult step_test(PDH_HQUERY q, PDH_HCOUNTER perf) {
    StepResult r;
    std::atomic<bool> load{false};
    // v6: the process mask spans {CPU0, collector CPU}; the worker (this
    // thread) was pinned to CPU0 in main. Only verify placement here --
    // never narrow the process mask (that would break the collector's pin).
    if (GetCurrentProcessorNumber() != 0) {
        std::cerr << "step_test: main thread not on CPU0\n";
        return r;
    }

    // Load thread: explicitly pinned to CPU0 (the counter under test is
    // Processor Information(0,0); an unpinned load thread could otherwise
    // land on another LP and never move CPU0's counter).
    std::thread lt([&load] {
        SetThreadAffinityMask(GetCurrentThread(),
                              static_cast<DWORD_PTR>(1));
        while (!g_stop.load(std::memory_order_relaxed)) {
            if (load.load(std::memory_order_relaxed)) {
                volatile double x = 1.0;
                for (int i = 0; i < 200000; ++i) x = x * 1.0000001 + 1.0;
            } else {
                std::this_thread::yield();
            }
        }
    });

    // Phase 1: idle baseline 1.0 s
    g_samples.clear();
    {
        std::vector<Sample> local;
        const uint64_t t_end = qpc_us() + 1000000ull;
        while (qpc_us() < t_end) {
            PDH_FMT_COUNTERVALUE v{};
            if (PdhCollectQueryData(q) == ERROR_SUCCESS &&
                PdhGetFormattedCounterValue(perf, PDH_FMT_DOUBLE, nullptr,
                                            &v) == ERROR_SUCCESS &&
                static_cast<LONG>(v.CStatus) >= 0) {
                Sample s;
                s.t_us = qpc_us();
                s.pct_perf = v.doubleValue;
                local.push_back(s);
            }
        }
        auto ps = plateaus_of(local);
        r.n_plateaus_idle = static_cast<int>(ps.size());
        if (!ps.empty()) r.idle_mean = ps.back().mean;
    }

    // Phase 2: switch load ON, probe until the reported level moves
    uint64_t t_toggle = qpc_us();
    load.store(true, std::memory_order_relaxed);
    double first_val = 0;
    bool moved = false;
    std::vector<Sample> during_load;
    {
        const uint64_t t_limit = qpc_us() + 3000000ull;
        double ref = r.idle_mean;
        while (qpc_us() < t_limit) {
            PDH_FMT_COUNTERVALUE v{};
            if (PdhCollectQueryData(q) == ERROR_SUCCESS &&
                PdhGetFormattedCounterValue(perf, PDH_FMT_DOUBLE, nullptr,
                                            &v) == ERROR_SUCCESS &&
                static_cast<LONG>(v.CStatus) >= 0) {
                Sample s;
                s.t_us = qpc_us();
                s.pct_perf = v.doubleValue;
                during_load.push_back(s);
                if (!moved && ref > 0 &&
                    std::fabs(s.pct_perf - ref) >
                        0.05 * std::fabs(ref)) {
                    moved = true;
                    first_val = s.pct_perf;
                    r.latency_ms = static_cast<double>(s.t_us - t_toggle) / 1000.0;
                    break;
                }
            }
        }
    }
    // Phase 3: collect 1.0 s in loaded state for plateau structure
    {
        const uint64_t t_end = qpc_us() + 1000000ull;
        while (qpc_us() < t_end) {
            PDH_FMT_COUNTERVALUE v{};
            if (PdhCollectQueryData(q) == ERROR_SUCCESS &&
                PdhGetFormattedCounterValue(perf, PDH_FMT_DOUBLE, nullptr,
                                            &v) == ERROR_SUCCESS &&
                static_cast<LONG>(v.CStatus) >= 0) {
                Sample s;
                s.t_us = qpc_us();
                s.pct_perf = v.doubleValue;
                during_load.push_back(s);
            }
        }
        auto ps = plateaus_of(during_load);
        r.n_plateaus_load = static_cast<int>(ps.size());
        for (const auto& p : ps)
            if (p.mean > 50.0) r.seg_means.push_back(p.mean);
        if (!ps.empty()) r.load_mean = ps.back().mean;
    }
    if (!moved) r.first_val_missing = true;
    load.store(false, std::memory_order_relaxed);
    g_stop.store(true, std::memory_order_relaxed);
    lt.join();
    g_stop.store(false, std::memory_order_relaxed);
    (void)first_val;
    return r;
}

// ---------------------------------------------------------------------------
// v6: physical-core topology query (self-validating) -- the collector CPU
// is never chosen from an unvalidated topology
// ---------------------------------------------------------------------------
static bool query_core_topology(uint64_t system_mask, std::string& err) {
    DWORD sz = 0;
    GetLogicalProcessorInformationEx(RelationProcessorCore, nullptr, &sz);
    if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || sz == 0) {
        err = "size query failed err=" + std::to_string(GetLastError());
        return false;
    }
    std::vector<unsigned char> buf(sz);
    if (!GetLogicalProcessorInformationEx(
            RelationProcessorCore,
            reinterpret_cast<PSYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX>(
                buf.data()),
            &sz)) {
        err = "query failed err=" + std::to_string(GetLastError());
        return false;
    }
    g_cores.clear();
    uint64_t uni = 0;
    size_t off = 0;
    while (off + 8 <= sz) {
        const auto* e = reinterpret_cast<
            const SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX*>(buf.data() + off);
        if (e->Size < 8 || off + e->Size > sz) break;
        if (e->Relationship == RelationProcessorCore) {
            CoreLps c;
            c.eff = e->Processor.EfficiencyClass;
            c.smt = (e->Processor.Flags & LTP_PC_SMT) ? 1 : 0;
            for (WORD g = 0; g < e->Processor.GroupCount; ++g) {
                const GROUP_AFFINITY& ga = e->Processor.GroupMask[g];
                for (unsigned b = 0; b < 64; ++b)
                    if (ga.Mask & (static_cast<uint64_t>(1) << b))
                        c.lps.push_back(static_cast<uint32_t>(b));
            }
            uint64_t cm = 0;
            if (c.lps.empty()) {
                err = "core entry with empty LP set";
                return false;
            }
            for (uint32_t lp : c.lps) {
                if (lp >= 64 || (cm & (1ull << lp))) {
                    err = "duplicate LP within a core";
                    return false;
                }
                cm |= 1ull << lp;
            }
            if (uni & cm) {
                err = "overlapping LP sets across cores";
                return false;
            }
            uni |= cm;
            g_cores.push_back(std::move(c));
        }
        off += e->Size;
    }
    if (g_cores.empty()) {
        err = "no RelationProcessorCore entries";
        return false;
    }
    if (uni != system_mask) {
        char b[96];
        std::snprintf(b, sizeof(b),
                      "core union 0x%llX != system mask 0x%llX",
                      static_cast<unsigned long long>(uni),
                      static_cast<unsigned long long>(system_mask));
        err = b;
        return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
int main(int argc, char** argv) {
    std::string out_path =
        "reports/g7-campaign-affinityfix/highres_frequency.json";
    uint32_t idle_seconds = 30;

    for (int i = 1; i < argc; ++i) {
        std::string s = argv[i];
        if (s == "--out" && i + 1 < argc) out_path = argv[++i];
        else if (s == "--idle" && i + 1 < argc)
            idle_seconds = static_cast<uint32_t>(std::stoul(argv[++i]));
        else {
            std::cerr << "unknown arg: " << s << "\n";
            return 2;
        }
    }

    try {
        std::cout << "=== High-resolution frequency diagnostic ===\n";

        // ---- v5: verify the machine's REAL logical-CPU mask FIRST ----
        DWORD_PTR pmask = 0, smask = 0;
        if (!GetProcessAffinityMask(GetCurrentProcess(), &pmask, &smask)) {
            std::cerr << "GetProcessAffinityMask failed; cannot verify CPU mask\n";
            return 3;
        }
        g_system_mask = static_cast<uint64_t>(smask);
        g_process_mask_before = static_cast<uint64_t>(pmask);
        const bool has_cpu0 = (smask & static_cast<DWORD_PTR>(1)) != 0;
        const bool has_cpu1 =
            (smask & (static_cast<DWORD_PTR>(1) << 1)) != 0;
        std::cout << "system_mask=0x" << std::hex << smask << std::dec
                  << " cpu0_present=" << has_cpu0
                  << " cpu1_present=" << has_cpu1 << "\n";
        if (!has_cpu0) {
            std::cerr << "machine logical-CPU mask lacks CPU0; "
                         "cannot pin the worker (documented limitation)\n";
            return 3;
        }

        // ---- v6: verify the REAL physical-core topology BEFORE choosing
        // the collector CPU. Predeclared rule (v6 addendum): lowest-numbered
        // LP in the system mask that does NOT share a physical core with
        // CPU0. CPU1 is excluded on this machine by measured topology
        // (P-core 0 = LP{0,1}; CPU1 is CPU0's SMT sibling -- the root cause
        // of v5's zero coverage and ~2x worker slowdown). The topology is
        // self-validated (non-empty disjoint core LP sets whose union equals
        // the system mask); on any failure the run ABORTS rather than
        // pinning from an assumed topology.
        {
            std::string topo_err;
            if (!query_core_topology(g_system_mask, topo_err)) {
                std::cerr << "core topology query failed: " << topo_err
                          << "\n";
                return 3;
            }
            for (const auto& c : g_cores)
                g_cpu1_shares_core_with_cpu0 =
                    g_cpu1_shares_core_with_cpu0 ||
                    (std::find(c.lps.begin(), c.lps.end(), 0u) !=
                         c.lps.end() &&
                     std::find(c.lps.begin(), c.lps.end(), 1u) !=
                         c.lps.end());
            uint32_t target = 0xFFFFFFFFu;
            for (uint32_t lp = 0; lp < 64 && target == 0xFFFFFFFFu; ++lp) {
                if (!(g_system_mask & (1ull << lp)) || lp == 0) continue;
                bool same_core_as_cpu0 = false;
                for (const auto& c : g_cores) {
                    const bool has0 =
                        std::find(c.lps.begin(), c.lps.end(), 0u) !=
                        c.lps.end();
                    const bool haslp =
                        std::find(c.lps.begin(), c.lps.end(), lp) !=
                        c.lps.end();
                    if (has0 && haslp) {
                        same_core_as_cpu0 = true;
                        break;
                    }
                }
                if (!same_core_as_cpu0) target = lp;
            }
            if (target == 0xFFFFFFFFu) {
                std::cerr << "no logical CPU exists on a different physical "
                             "core than CPU0; cannot separate collector\n";
                return 3;
            }
            g_collector_target_cpu = target;
            g_collector_target_mask = 1ull << target;
            std::cout << "collector target=CPU" << target
                      << " (separate physical core); "
                         "cpu1_shares_core_with_cpu0="
                      << (g_cpu1_shares_core_with_cpu0 ? "true" : "false")
                      << "\n";
        }

        // Confine this process to {CPU0, collector CPU} so BOTH per-thread
        // pins below are realizable. Separation itself is established by the
        // per-thread pins and proven by observed-CPU verification -- never by
        // the process mask alone.
        const DWORD_PTR want_proc =
            static_cast<DWORD_PTR>(1) |
            static_cast<DWORD_PTR>(g_collector_target_mask);
        if (!SetProcessAffinityMask(GetCurrentProcess(), want_proc)) {
            std::cerr << "SetProcessAffinityMask({CPU0,collector}) failed err="
                      << GetLastError() << "\n";
            return 3;
        }
        {
            DWORD_PTR pm2 = 0, sm2 = 0;
            GetProcessAffinityMask(GetCurrentProcess(), &pm2, &sm2);
            g_process_mask_after = static_cast<uint64_t>(pm2);
            if (pm2 != want_proc) {
                std::cerr << "process mask readback 0x" << std::hex << pm2
                          << " != expected 0x" << want_proc << std::dec
                          << "\n";
                return 3;
            }
        }

        // Pin the worker (main thread) to CPU0; verify by readback -- the
        // SECOND identical SetThreadAffinityMask returns the mask installed
        // by the first, so readback == 1 proves the effective mask.
        SetLastError(0);
        DWORD_PTR wprev1 = SetThreadAffinityMask(GetCurrentThread(),
                                                  static_cast<DWORD_PTR>(1));
        const DWORD werr = GetLastError();
        g_worker_pin_ret = wprev1 ? 1 : 0;
        g_worker_pin_err = wprev1 ? 0u : static_cast<uint32_t>(werr);
        DWORD_PTR wprev2 = SetThreadAffinityMask(GetCurrentThread(),
                                                  static_cast<DWORD_PTR>(1));
        g_worker_pin_readback = static_cast<uint64_t>(wprev2);
        if (!wprev1 || wprev2 != static_cast<DWORD_PTR>(1)) {
            std::cerr << "worker pin to CPU0 failed (set_ret=" << wprev1
                      << " readback=0x" << std::hex << wprev2 << std::dec
                      << ")\n";
            return 3;
        }
        const DWORD wobs = GetCurrentProcessorNumber();
        if (wobs != 0) {
            std::cerr << "worker observed on CPU" << wobs
                      << " after pin to CPU0; aborting\n";
            return 3;
        }
        std::cout << "worker pinned CPU0 (observed CPU0); collector target CPU"
                  << g_collector_target_cpu
                  << " (separate physical core, machine-verified)\n";

        JsonValue root = JsonValue::object();
        JsonValue stat = JsonValue::object();
        stat.set("diagnostic", JsonValue::str("highres-frequency"));
        stat.set("created_utc", JsonValue::str(utc_now_ms()));
        stat.set("idle_gap_seconds", JsonValue::uinteger(idle_seconds));
        stat.set("timer", JsonValue::str("std::chrono::steady_clock (QPC)"));
        // v6 architecture evidence (machine-verified, not assumed)
        stat.set("architecture", JsonValue::str(
            "v6: worker=CPU0, collector=topology-selected non-sibling CPU "
            "(different physical core), per-thread pins + observed-CPU "
            "verification"));
        stat.set("system_mask_raw", JsonValue::uinteger(g_system_mask));
        stat.set("process_mask_before",
                 JsonValue::uinteger(g_process_mask_before));
        stat.set("process_mask_after",
                 JsonValue::uinteger(g_process_mask_after));
        stat.set("cpu0_present",
                 JsonValue::boolean((g_system_mask & 1ull) != 0));
        stat.set("cpu1_present",
                 JsonValue::boolean((g_system_mask & 2ull) != 0));
        stat.set("worker_set_api_return", JsonValue::integer(g_worker_pin_ret));
        stat.set("worker_set_api_last_error",
                 JsonValue::uinteger(g_worker_pin_err));
        stat.set("worker_pin_readback_mask",
                 JsonValue::uinteger(g_worker_pin_readback));
        stat.set("collector_target_cpu",
                 JsonValue::uinteger(g_collector_target_cpu));
        stat.set("cpu1_shares_core_with_cpu0",
                 JsonValue::boolean(g_cpu1_shares_core_with_cpu0));
        stat.set("topology_source", JsonValue::str(
            "GetLogicalProcessorInformationEx(RelationProcessorCore); "
            "self-validated: non-empty disjoint core LP sets whose union "
            "equals the system mask"));
        stat.set("pace_period_us", JsonValue::uinteger(k_pace_period_us));
        stat.set("pace_mode", JsonValue::str(
            "v7: QPC spin between samples while an exec is active "
            "(external probe: 500us pacing worker-ratio 1.02, "
            "~50kHz tight loop ratio 0.75)"));
        {
            JsonValue topo = JsonValue::array();
            for (const auto& c : g_cores) {
                JsonValue o = JsonValue::object();
                JsonValue lps = JsonValue::array();
                for (uint32_t lp : c.lps) lps.append(JsonValue::uinteger(lp));
                o.set("logical_cpus", std::move(lps));
                o.set("efficiency_class", JsonValue::integer(c.eff));
                o.set("smt", JsonValue::boolean(c.smt != 0));
                topo.append(o);
            }
            stat.set("core_topology", std::move(topo));
        }
        root.set("static", stat);

        PDH_HQUERY q = nullptr;
        PDH_HCOUNTER perf = nullptr;
        if (PdhOpenQueryW(nullptr, 0, &q) != ERROR_SUCCESS) {
            std::cerr << "pdh open failed\n";
            return 4;
        }
        if (PdhAddCounterW(
                q, L"\\Processor Information(0,0)\\% Processor Performance", 0,
                &perf) != ERROR_SUCCESS) {
            std::cerr << "pdh add counter failed\n";
            return 4;
        }
        PdhCollectQueryData(q);  // prime

        // ---- P1: response probe (idle) ----
        std::cout << "P1: PDH response probe (idle, 2 s) ...\n" << std::flush;
        root.set("pdh_probe_idle", pdh_probe(q, perf, 2));

        // ---- P2: step-transition test ----
        std::cout << "P2: step-transition test ...\n" << std::flush;
        {
            StepResult st = step_test(q, perf);
            JsonValue o = JsonValue::object();
            o.set("transition_latency_ms", JsonValue::number(st.latency_ms));
            o.set("idle_plateaus", JsonValue::integer(st.n_plateaus_idle));
            o.set("load_plateaus", JsonValue::integer(st.n_plateaus_load));
            o.set("idle_mean_pct_perf", JsonValue::number(st.idle_mean));
            o.set("load_mean_pct_perf", JsonValue::number(st.load_mean));
            root.set("step_test", std::move(o));
        }

        // ---- P3 (v8): PREDECLARED SCHEDULE -- two diagnostics only ----
        // (1) B6: V8_B6_N_PAIRS adjacent A/B pairs, order alternated
        //     (even pair: A then B; odd pair: B then A), all back-to-back
        //     under one thermal/power/background condition block.
        //     A = no collector; B = collector active at the 500 us pace.
        // (2) one 30 s idle; (3) B9: V8_B9_N_EXECS identical B-side execs
        //     (collector active; first flagged after the idle gap).
        // No B7 and no extra execs in v8. Nothing else changed from v7.
        JsonValue execs = JsonValue::array();
        auto idle = [&] {
            std::cout << "idle " << idle_seconds << "s ...\n" << std::flush;
            std::this_thread::sleep_for(std::chrono::seconds(idle_seconds));
        };

        auto run_b6 = [&](bool collector_on, bool gap, int pair) {
            TinyDenseModel model(1);
            BenchConfig cfg;
            cfg.benchmark_id = "B6";
            cfg.warmup_count = 10;
            cfg.measurement_count = 50;
            cfg.thread_count = 1;
            cfg.batch_size = 1;
            cfg.sequence_length = 0;
            cfg.precision = "FP32";
            cfg.storage_format = "FP32";
            cfg.deterministic_mode_requested = true;
            cfg.workload_params = {{"model", "TINY-DENSE-2L"},
                                   {"logical_params", "262912"}};
            std::vector<double> iters;
            JsonValue e = run_exec("B6", collector_on, gap, pair, q, perf,
                                   [&] { model.forward(); }, iters);
            e.set("exec_index", JsonValue::integer(execs.items().size()));
            std::cout << "B6 " << (collector_on ? "B" : "A")
                      << " pair=" << pair << " gap=" << gap
                      << " median_us="
                      << e.get("median_us_this_path").asDouble() << "\n";
            execs.append(e);
        };

        for (int pair = 0; pair < V8_B6_N_PAIRS; ++pair) {
            if ((pair % 2) == 0) {
                run_b6(false, false, pair);   // A -> B
                run_b6(true, false, pair);
            } else {
                run_b6(true, false, pair);    // B -> A
                run_b6(false, false, pair);
            }
        }

        idle();

        // B9: shared model + bit-identical check (op unchanged from v7);
        // all v8 B9 execs are B-side (collector active) at 500 us pace.
        {
            TinyDenseModel model(1);
            BenchConfig cfg;
            cfg.benchmark_id = "B9";
            cfg.warmup_count = 10;
            cfg.measurement_count = 50;
            cfg.thread_count = 1;
            cfg.batch_size = 1;
            cfg.sequence_length = 0;
            cfg.precision = "FP32";
            cfg.storage_format = "FP32";
            cfg.deterministic_mode_requested = true;
            cfg.workload_params = {{"model", "TINY-DENSE-2L"}, {"repeats", "200"}};
            std::vector<float> reference;
            bool bit_identical = true;
            auto run_b9 = [&](bool gap, int idx) {
                std::vector<double> iters;
                JsonValue e = run_exec(
                    "B9", true, gap, idx, q, perf,
                    [&] {
                        model.forward();
                        auto out = model.output();
                        if (reference.empty()) reference = out;
                        else if (reference != out) bit_identical = false;
                    }, iters);
                e.set("bit_identical", JsonValue::boolean(bit_identical));
                e.set("exec_index", JsonValue::integer(execs.items().size()));
                std::cout << "B9 B pair=" << idx << " gap=" << gap
                          << " median_us="
                          << e.get("median_us_this_path").asDouble() << "\n";
                execs.append(e);
            };
            for (int k = 0; k < V8_B9_N_EXECS; ++k) run_b9(k == 0, k);
        }

        // safety: no collector thread may survive P3
        if (g_coll_thread.joinable()) {
            g_stop.store(true);
            g_coll_thread.join();
            g_stop.store(false);
        }
        root.set("execs", execs);

        std::ofstream out(out_path);
        if (!out) {
            std::cerr << "cannot write " << out_path << "\n";
            return 4;
        }
        out << root.dump(2) << "\n";

        std::cout << "execs=" << execs.items().size() << " wrote " << out_path
                  << "\n";
        return 0;
    } catch (const std::exception& ex) {
        std::cerr << "diag_highres_frequency: " << ex.what() << "\n";
        return 1;
    }
}
