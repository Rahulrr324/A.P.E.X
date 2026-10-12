/**
 * Diagnostic: direct CPU frequency / power-state evidence for the G7
 * reproducibility investigation. (Investigation only — not a G7 campaign.)
 *
 * Rules honored by this file:
 *   - Benchmark measurement semantics are UNCHANGED: every measured exec calls
 *     the production stark_p1::run_benchmark() with campaign-equivalent op
 *     code (warmup=10, samples=50, thread_count=1, batch=1, seq=0, FP32).
 *   - It writes NO STARKP1 records and touches NO record store; it never
 *     modifies the frozen 30 or the affinity-fix 30.
 *   - Frequency fields are labeled by provenance:
 *       nominal_*     : nominal/base frequency (registry ~MHz, CPUID brand,
 *                       NT MaxMhz)
 *       os_reported_* : OS instantaneous view (NT CurrentMhz / MhzLimit)
 *       observed_*    : hardware-derived via Windows perf counters
 *                       (% Processor Performance vs nominal; Processor
 *                       Frequency MHz; % Processor Utility)
 *       inferred_*    : never computed here; inference happens only in the
 *                       analysis script and is labeled there.
 *
 * Output: reports/g7-campaign-affinityfix/frequency_evidence.json
 */

#include <windows.h>
#include <pdh.h>
#include <cpuid.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <functional>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "bench/BenchmarkHarness.h"
#include "bench/TinyDenseModel.h"
#include "common/ExperimentRecord.h"
#include "common/HardwareAffinity.h"

using namespace stark_p1;
using Clock = std::chrono::steady_clock;

// ---------------------------------------------------------------------------
// powrprof.dll: header absent in this toolchain — declare the documented APIs
// manually (layouts match the Windows SDK).
// ---------------------------------------------------------------------------
extern "C" {
LONG WINAPI CallNtPowerInformation(ULONG InformationLevel, PVOID InputBuffer,
                                   ULONG InputBufferSize, PVOID OutputBuffer,
                                   ULONG OutputBufferSize);
DWORD WINAPI PowerGetActiveScheme(HKEY UserRootKey, GUID** ActiveSchemeGuid);
DWORD WINAPI PowerReadFriendlyName(HKEY RootKey, const GUID* SchemeGuid,
                                   const GUID* SubGroupGuid,
                                   const GUID* SettingGuid, PBYTE* Buffer,
                                   DWORD* BufferSize);
}
#ifndef ProcessorInformation
#define ProcessorInformation 11
#endif
struct PROCESSOR_POWER_INFORMATION_WIN {
    ULONG Number;
    ULONG MaxMhz;
    ULONG CurrentMhz;
    ULONG MhzLimit;
    ULONG MaxIdleState;
    ULONG CurrentIdleState;
};

static std::string utc_now_ms() { return RecordStore::utc_timestamp_now(); }

static uint64_t qpc_us() {
    return static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::microseconds>(
            Clock::now().time_since_epoch())
            .count());
}

static uint64_t filetime_delta_100ns(const FILETIME& a, const FILETIME& b) {
    ULARGE_INTEGER ua{}, ub{};
    ua.LowPart = a.dwLowDateTime; ua.HighPart = a.dwHighDateTime;
    ub.LowPart = b.dwLowDateTime; ub.HighPart = b.dwHighDateTime;
    return ub.QuadPart >= ua.QuadPart ? ub.QuadPart - ua.QuadPart : 0;
}

// ---------------------------------------------------------------------------
// Static / OS-reported state (provenance-labeled)
// ---------------------------------------------------------------------------
static DWORD registry_nominal_mhz() {
    HKEY key = nullptr;
    if (RegOpenKeyExW(HKEY_LOCAL_MACHINE,
                      L"HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0",
                      0, KEY_READ, &key) != ERROR_SUCCESS)
        return 0;
    DWORD val = 0, sz = sizeof(val), type = 0;
    LONG rc = RegQueryValueExW(key, L"~MHz", nullptr, &type,
                               reinterpret_cast<LPBYTE>(&val), &sz);
    RegCloseKey(key);
    return (rc == ERROR_SUCCESS && type == REG_DWORD) ? val : 0;
}

static std::string cpuid_brand() {
    char brand[49] = {0};
    unsigned regs[4] = {0, 0, 0, 0};
    if (__get_cpuid(0x80000000u, &regs[0], &regs[1], &regs[2], &regs[3]) &&
        regs[0] >= 0x80000004u) {
        __get_cpuid(0x80000002u, &regs[0], &regs[1], &regs[2], &regs[3]);
        std::memcpy(brand + 0, regs, 16);
        __get_cpuid(0x80000003u, &regs[0], &regs[1], &regs[2], &regs[3]);
        std::memcpy(brand + 16, regs, 16);
        __get_cpuid(0x80000004u, &regs[0], &regs[1], &regs[2], &regs[3]);
        std::memcpy(brand + 32, regs, 16);
    }
    std::string s(brand);
    while (!s.empty() && (s.front() == ' ' || s.front() == '\0')) s.erase(s.begin());
    while (!s.empty() && (s.back() == ' ' || s.back() == '\0')) s.pop_back();
    return s;
}

struct NtFreq {  // OS-reported instantaneous view
    bool ok = false;
    std::vector<PROCESSOR_POWER_INFORMATION_WIN> cpus;
};
static NtFreq nt_freq_snapshot() {
    NtFreq nf;
    ULONG n = GetActiveProcessorCount(ALL_PROCESSOR_GROUPS);
    if (n == 0 || n > 512) return nf;
    std::vector<PROCESSOR_POWER_INFORMATION_WIN> buf(n);
    LONG rc = CallNtPowerInformation(ProcessorInformation, nullptr, 0, buf.data(),
                                     n * sizeof(PROCESSOR_POWER_INFORMATION_WIN));
    if (rc == 0) {  // STATUS_SUCCESS
        nf.ok = true;
        nf.cpus = std::move(buf);
    }
    return nf;
}

struct PowerScheme {
    bool ok = false;
    std::string guid;
    std::string name;
};
static PowerScheme power_scheme() {
    PowerScheme ps;
    GUID* g = nullptr;
    if (PowerGetActiveScheme(nullptr, &g) != ERROR_SUCCESS || !g) return ps;
    char guid_str[80];
    snprintf(guid_str, sizeof(guid_str),
             "%08lX-%04X-%04X-%02X%02X-%02X%02X%02X%02X%02X%02X",
             static_cast<unsigned long>(g->Data1), g->Data2, g->Data3,
             g->Data4[0], g->Data4[1], g->Data4[2], g->Data4[3], g->Data4[4],
             g->Data4[5], g->Data4[6], g->Data4[7]);
    ps.guid = guid_str;
    PBYTE name_buf = nullptr;
    DWORD name_sz = 0;
    if (PowerReadFriendlyName(nullptr, g, nullptr, nullptr, &name_buf,
                              &name_sz) == ERROR_SUCCESS &&
        name_buf) {
        std::wstring w(reinterpret_cast<wchar_t*>(name_buf));
        ps.name.assign(w.begin(), w.end());
        LocalFree(name_buf);
    }
    LocalFree(g);
    ps.ok = true;
    return ps;
}

// ---------------------------------------------------------------------------
// PDH observed-frequency telemetry (hardware-derived via perf counters)
// ---------------------------------------------------------------------------
struct PdhSet {
    PDH_HQUERY query = nullptr;
    PDH_HCOUNTER p0_perf = nullptr;
    PDH_HCOUNTER p0_freq = nullptr;
    PDH_HCOUNTER p0_util = nullptr;
    PDH_HCOUNTER tot_perf = nullptr;
    PDH_HCOUNTER thermal = nullptr;
    bool has_p0_perf = false, has_p0_freq = false, has_p0_util = false;
    bool has_tot_perf = false, has_thermal = false;
    bool open = false;
};

static void add_counter(PdhSet& p, LPCWSTR path, PDH_HCOUNTER& out, bool& present) {
    PDH_HCOUNTER h = nullptr;
    PDH_STATUS st = PdhAddCounterW(p.query, path, 0, &h);
    out = (st == ERROR_SUCCESS) ? h : nullptr;
    present = (out != nullptr);
}

static PdhSet pdh_open() {
    PdhSet p;
    if (PdhOpenQueryW(nullptr, 0, &p.query) != ERROR_SUCCESS) {
        p.query = nullptr;
        return p;
    }
    p.open = true;
    add_counter(p, L"\\Processor Information(0,0)\\% Processor Performance",
                p.p0_perf, p.has_p0_perf);
    add_counter(p, L"\\Processor Information(0,0)\\Processor Frequency",
                p.p0_freq, p.has_p0_freq);
    add_counter(p, L"\\Processor Information(0,0)\\% Processor Utility",
                p.p0_util, p.has_p0_util);
    add_counter(p, L"\\Processor Information(_Total)\\% Processor Performance",
                p.tot_perf, p.has_tot_perf);
    DWORD chars = 0;
    LONG rc = PdhExpandWildCardPathW(nullptr,
                                     L"\\Thermal Zone Information(*)\\Temperature",
                                     nullptr, &chars, 0);
    if (rc == ERROR_SUCCESS && chars > 1) {
        std::vector<WCHAR> buf(chars);
        if (PdhExpandWildCardPathW(nullptr,
                                   L"\\Thermal Zone Information(*)\\Temperature",
                                   buf.data(), &chars, 0) == ERROR_SUCCESS) {
            std::wstring first(buf.data());
            if (!first.empty()) {
                PDH_HCOUNTER th = nullptr;
                if (PdhAddCounterW(p.query, first.c_str(), 0, &th) == ERROR_SUCCESS) {
                    p.thermal = th;
                    p.has_thermal = (p.thermal != nullptr);
                }
            }
        }
    }
    PdhCollectQueryData(p.query);  // prime; first formatted read may still fail
    return p;
}

static bool pdh_read(PDH_HCOUNTER c, bool present, double& out) {
    if (!present) return false;
    PDH_FMT_COUNTERVALUE v{};
    if (PdhGetFormattedCounterValue(c, PDH_FMT_DOUBLE, nullptr, &v) != ERROR_SUCCESS)
        return false;
    // PDH success statuses are non-negative; error statuses (e.g.
    // PDH_INVALID_DATA) have the high bit set. mingw's pdh.h defines no
    // CSTATUS constants, so test the sign bit directly.
    if (static_cast<LONG>(v.CStatus) < 0) return false;
    out = v.doubleValue;
    return true;
}

struct Reading {
    bool has_p0_perf = false;  double p0_perf = 0;
    bool has_p0_freq = false;  double p0_freq = 0;
    bool has_p0_util = false;  double p0_util = 0;
    bool has_tot_perf = false; double tot_perf = 0;
    bool has_thermal = false;  double thermal = 0;
};
static Reading pdh_collect(PdhSet& p) {
    Reading r;
    if (!p.open) return r;
    PdhCollectQueryData(p.query);
    r.has_p0_perf = pdh_read(p.p0_perf, p.has_p0_perf, r.p0_perf);
    r.has_p0_freq = pdh_read(p.p0_freq, p.has_p0_freq, r.p0_freq);
    r.has_p0_util = pdh_read(p.p0_util, p.has_p0_util, r.p0_util);
    r.has_tot_perf = pdh_read(p.tot_perf, p.has_tot_perf, r.tot_perf);
    r.has_thermal = pdh_read(p.thermal, p.has_thermal, r.thermal);
    return r;
}

// ---------------------------------------------------------------------------
// Timeline sampler (background thread, 100 ms, own PDH query — PDH queries
// are not thread-safe, so the sampler never shares the snapshot query)
// ---------------------------------------------------------------------------
struct TimelineSample {
    std::string utc;
    uint64_t qpc_us = 0;
    Reading r;
};
static std::vector<TimelineSample> g_timeline;
static std::mutex g_timeline_mu;
static bool g_sampler_stop = false;

static void sampler_main(PdhSet* pdh) {
    while (!g_sampler_stop) {
        TimelineSample s;
        s.utc = utc_now_ms();
        s.qpc_us = qpc_us();
        s.r = pdh_collect(*pdh);
        {
            std::lock_guard<std::mutex> lk(g_timeline_mu);
            g_timeline.push_back(s);
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------
static JsonValue reading_json(const Reading& r) {
    JsonValue o = JsonValue::object();
    auto put = [&](const char* k, bool has, double v) {
        o.set(k, has ? JsonValue::number(v) : JsonValue::null());
    };
    put("observed_pct_perf_cpu0", r.has_p0_perf, r.p0_perf);
    put("observed_freq_mhz_cpu0", r.has_p0_freq, r.p0_freq);
    put("observed_pct_util_cpu0", r.has_p0_util, r.p0_util);
    put("observed_pct_perf_total", r.has_tot_perf, r.tot_perf);
    put("observed_thermal_c", r.has_thermal, r.thermal);
    return o;
}

static JsonValue nt_json(const NtFreq& nf) {
    JsonValue o = JsonValue::object();
    o.set("ok", JsonValue::boolean(nf.ok));
    JsonValue arr = JsonValue::array();
    for (const auto& c : nf.cpus) {
        JsonValue e = JsonValue::object();
        e.set("cpu", JsonValue::uinteger(c.Number));
        e.set("os_reported_max_mhz", JsonValue::uinteger(c.MaxMhz));
        e.set("os_reported_current_mhz", JsonValue::uinteger(c.CurrentMhz));
        e.set("os_reported_mhz_limit", JsonValue::uinteger(c.MhzLimit));
        e.set("os_reported_max_idle_state", JsonValue::uinteger(c.MaxIdleState));
        e.set("os_reported_current_idle_state",
              JsonValue::uinteger(c.CurrentIdleState));
        arr.append(e);
    }
    o.set("per_cpu", std::move(arr));
    return o;
}

static JsonValue affinity_json(const AffinityInfo& a) {
    JsonValue o = JsonValue::object();
    o.set("supported", JsonValue::boolean(a.supported));
    o.set("query_ok", JsonValue::boolean(a.query_ok));
    o.set("set_ok", JsonValue::boolean(a.set_ok));
    o.set("verified_single_cpu", JsonValue::boolean(a.verified_single_cpu));
    JsonValue arr = JsonValue::array();
    for (uint32_t c : a.effective) arr.append(JsonValue::uinteger(c));
    o.set("effective_logical_cpus", std::move(arr));
    o.set("requested_cpu",
          a.requested_cpu ? JsonValue::uinteger(*a.requested_cpu) : JsonValue::null());
    o.set("set_api_return",
          a.set_api_return ? JsonValue::integer(*a.set_api_return) : JsonValue::null());
    o.set("set_api_last_error",
          a.set_api_last_error ? JsonValue::uinteger(*a.set_api_last_error)
                               : JsonValue::null());
    o.set("raw_process_mask",
          a.raw_process_mask ? JsonValue::uinteger(*a.raw_process_mask)
                             : JsonValue::null());
    o.set("raw_system_mask",
          a.raw_system_mask ? JsonValue::uinteger(*a.raw_system_mask)
                            : JsonValue::null());
    o.set("reason", a.reason.empty() ? JsonValue::null() : JsonValue::str(a.reason));
    return o;
}

// ---------------------------------------------------------------------------
// One measured exec through the PRODUCTION harness, with telemetry around it
// ---------------------------------------------------------------------------
static JsonValue run_exec(PdhSet& snap, const char* bench_id, bool after_idle_gap,
                          int cycle, const BenchConfig& cfg,
                          const std::function<void()>& op) {
    JsonValue e = JsonValue::object();
    e.set("bench", JsonValue::str(bench_id));
    e.set("after_idle_gap", JsonValue::boolean(after_idle_gap));
    e.set("cycle", JsonValue::integer(cycle));

    // Same per-exec affinity action the campaign performs (idempotent when
    // already pinned) — recorded, never assumed.
    AffinityInfo aff = HardwareAffinity::requestAndVerifyFirstCpu();
    e.set("affinity", affinity_json(aff));

    FILETIME ct0, et0, kt0, ut0;
    GetThreadTimes(GetCurrentThread(), &ct0, &et0, &kt0, &ut0);
    NtFreq nt_before = nt_freq_snapshot();
    Reading r_before = pdh_collect(snap);
    e.set("t_start_utc", JsonValue::str(utc_now_ms()));
    uint64_t start_qpc = qpc_us();

    BenchResult res = run_benchmark(cfg, op);  // PRODUCTION path, unchanged

    uint64_t end_qpc = qpc_us();
    e.set("t_end_utc", JsonValue::str(utc_now_ms()));
    FILETIME ct1, et1, kt1, ut1;
    GetThreadTimes(GetCurrentThread(), &ct1, &et1, &kt1, &ut1);
    NtFreq nt_after = nt_freq_snapshot();
    Reading r_after = pdh_collect(snap);

    e.set("ok", JsonValue::boolean(res.ok));
    e.set("n_samples", JsonValue::uinteger(res.stats.samples.size()));
    if (res.ok && res.stats.computed && !res.stats.samples.empty()) {
        e.set("median_us", JsonValue::number(res.stats.median * 1e6));
        e.set("mean_us", JsonValue::number(res.stats.mean * 1e6));
        e.set("min_us", JsonValue::number(res.stats.min * 1e6));
        e.set("max_us", JsonValue::number(res.stats.max * 1e6));
        e.set("stdev_us", JsonValue::number(res.stats.stdev * 1e6));
        const auto& s = res.stats.samples;
        e.set("first_sample_us", JsonValue::number(s.front() * 1e6));
        e.set("last_sample_us", JsonValue::number(s.back() * 1e6));
        size_t spikes = 0;
        for (double v : s)
            if (v > 1.5 * res.stats.median) ++spikes;
        e.set("samples_gt_150pct_median", JsonValue::uinteger(spikes));
        // first-10 vs last-10 medians (ramp detection), computed read-only
        std::vector<double> head(s.begin(), s.begin() + std::min<size_t>(10, s.size()));
        std::vector<double> tail(s.end() - std::min<size_t>(10, s.size()), s.end());
        auto med = [](std::vector<double> v) {
            std::sort(v.begin(), v.end());
            size_t n = v.size();
            return n % 2 ? v[n / 2] : 0.5 * (v[n / 2 - 1] + v[n / 2]);
        };
        e.set("first10_median_us", JsonValue::number(med(head) * 1e6));
        e.set("last10_median_us", JsonValue::number(med(tail) * 1e6));
    }

    double wall_s = static_cast<double>(end_qpc - start_qpc) / 1e6;
    double user_s = static_cast<double>(filetime_delta_100ns(ut0, ut1)) / 1e7;
    double kern_s = static_cast<double>(filetime_delta_100ns(kt0, kt1)) / 1e7;
    e.set("wall_s", JsonValue::number(wall_s));
    e.set("thread_user_s", JsonValue::number(user_s));
    e.set("thread_kernel_s", JsonValue::number(kern_s));
    e.set("thread_cpu_util_pct",
          wall_s > 0 ? JsonValue::number((user_s + kern_s) / wall_s * 100.0)
                     : JsonValue::null());

    e.set("nt_before", nt_json(nt_before));
    e.set("nt_after", nt_json(nt_after));
    e.set("pdh_before", reading_json(r_before));
    e.set("pdh_after", reading_json(r_after));
    return e;
}

// ---------------------------------------------------------------------------
// Campaign-equivalent configs and op code (semantics copied, not modified)
// ---------------------------------------------------------------------------
static BenchConfig base_cfg(const std::string& id, bool deterministic) {
    BenchConfig c;
    c.benchmark_id = id;
    c.warmup_count = 10;
    c.measurement_count = 50;
    c.thread_count = 1;
    c.batch_size = 1;
    c.sequence_length = 0;
    c.precision = "FP32";
    c.storage_format = "FP32";
    c.deterministic_mode_requested = deterministic;
    return c;
}

int main(int argc, char** argv) {
    std::string out_path = "reports/g7-campaign-affinityfix/frequency_evidence.json";
    uint32_t idle_seconds = 30;
    for (int i = 1; i < argc; ++i) {
        std::string s = argv[i];
        if (s == "--out" && i + 1 < argc) {
            out_path = argv[++i];
        } else if (s == "--idle" && i + 1 < argc) {
            idle_seconds = static_cast<uint32_t>(std::stoul(argv[++i]));
        } else {
            std::cerr << "diag_frequency_evidence: unknown argument: " << s << "\n";
            return 2;
        }
    }

    try {
        std::cout << "=== Frequency/power-state evidence diagnostic ===\n";

        JsonValue stat = JsonValue::object();
        stat.set("diagnostic", JsonValue::str("frequency-evidence"));
        stat.set("created_utc", JsonValue::str(utc_now_ms()));
        stat.set("idle_gap_seconds", JsonValue::uinteger(idle_seconds));
        stat.set("nominal_registry_mhz",
                 JsonValue::uinteger(registry_nominal_mhz()));
        stat.set("nominal_cpuid_brand", JsonValue::str(cpuid_brand()));
        {
            PowerScheme ps = power_scheme();
            JsonValue o = JsonValue::object();
            o.set("ok", JsonValue::boolean(ps.ok));
            o.set("os_reported_scheme_guid",
                  ps.ok ? JsonValue::str(ps.guid) : JsonValue::null());
            o.set("os_reported_scheme_name",
                  ps.ok ? JsonValue::str(ps.name) : JsonValue::null());
            stat.set("power_scheme", o);
        }
        stat.set("nt_at_start", nt_json(nt_freq_snapshot()));
        stat.set("build_flags", JsonValue::str("-O3 -DNDEBUG -std=gnu++17 (no LTO, no -march, no fast-math)"));
        stat.set("timer", JsonValue::str("std::chrono::steady_clock (QPC on Windows)"));

        // --- Pin to CPU 0 through the production path (campaign parity) ---
        AffinityInfo aff0 = HardwareAffinity::requestAndVerifyFirstCpu();
        stat.set("affinity_at_start", affinity_json(aff0));
        std::cout << "affinity verified_single_cpu="
                  << aff0.verified_single_cpu << "\n";
        if (!(aff0.supported && aff0.query_ok && aff0.set_ok &&
              aff0.verified_single_cpu && aff0.effective.size() == 1)) {
            std::cerr << "diagnostic requires verified single-CPU affinity; aborting\n";
            return 3;
        }

        PdhSet snap = pdh_open();   // for per-exec snapshots
        PdhSet samp = pdh_open();   // for the background sampler
        {
            JsonValue o = JsonValue::object();
            o.set("pdh_query_open", JsonValue::boolean(snap.open));
            o.set("counter_p0_pct_perf", JsonValue::boolean(snap.has_p0_perf));
            o.set("counter_p0_freq_mhz", JsonValue::boolean(snap.has_p0_freq));
            o.set("counter_p0_pct_util", JsonValue::boolean(snap.has_p0_util));
            o.set("counter_total_pct_perf", JsonValue::boolean(snap.has_tot_perf));
            o.set("counter_thermal", JsonValue::boolean(snap.has_thermal));
            stat.set("counters_available", o);
        }

        std::thread sampler(sampler_main, &samp);

        JsonValue execs = JsonValue::array();
        auto idle = [&](void) {
            std::cout << "idle " << idle_seconds << "s ...\n" << std::flush;
            std::this_thread::sleep_for(std::chrono::seconds(idle_seconds));
        };

        // ---- B6 (campaign-equivalent op: model.forward()) ----
        {
            auto run_b6 = [&](bool gap, int cycle) {
                TinyDenseModel model(1);
                BenchConfig cfg = base_cfg("B6", true);
                cfg.workload_params = {{"model", "TINY-DENSE-2L"},
                                       {"logical_params", "262912"}};
                JsonValue e = run_exec(snap, "B6", gap, cycle, cfg,
                                       [&] { model.forward(); });
                std::cout << "B6 gap=" << gap << " cycle=" << cycle
                          << " median_us=" << e.get("median_us").asDouble() << "\n";
                execs.append(e);
            };
            run_b6(false, 0);  // warm baseline (process already warm)
            for (int c = 1; c <= 3; ++c) { idle(); run_b6(true, c); }
            run_b6(false, 1);
            run_b6(false, 2);  // back-to-back pair
        }

        // ---- B9 (campaign-equivalent op: forward + reference compare) ----
        {
            auto run_b9 = [&](bool gap, int cycle) {
                TinyDenseModel model(1);
                BenchConfig cfg = base_cfg("B9", true);
                cfg.workload_params = {{"model", "TINY-DENSE-2L"},
                                       {"repeats", "200"}};
                std::vector<float> reference;
                bool bit_identical = true;
                JsonValue e = run_exec(snap, "B9", gap, cycle, cfg, [&] {
                    model.forward();
                    if (reference.empty()) reference = model.output();
                    else if (reference != model.output()) bit_identical = false;
                });
                e.set("bit_identical", JsonValue::boolean(bit_identical));
                std::cout << "B9 gap=" << gap << " cycle=" << cycle
                          << " median_us=" << e.get("median_us").asDouble() << "\n";
                execs.append(e);
            };
            idle(); run_b9(true, 1);
            run_b9(false, 1);
        }

        // ---- B7 (campaign-equivalent op: file read + deserializeWeights) ----
        {
            const std::string blob_path = "build/diag_freq_weights.bin";
            auto run_b7 = [&](bool gap, int cycle) {
                TinyDenseModel writer(1);
                std::vector<uint8_t> blob = writer.serializeWeights();
                {
                    std::ofstream f(blob_path, std::ios::binary | std::ios::trunc);
                    f.write(reinterpret_cast<const char*>(blob.data()),
                            static_cast<std::streamsize>(blob.size()));
                }
                BenchConfig cfg = base_cfg("B7", false);
                cfg.workload_params = {{"blob_bytes", std::to_string(blob.size())},
                                       {"mode", "warm_cache"}};
                TinyDenseModel loader(1);
                JsonValue e = run_exec(snap, "B7", gap, cycle, cfg, [&] {
                    std::ifstream f(blob_path, std::ios::binary);
                    std::vector<uint8_t> bytes(
                        (std::istreambuf_iterator<char>(f)),
                        std::istreambuf_iterator<char>());
                    loader.deserializeWeights(bytes);
                });
                std::cout << "B7 gap=" << gap << " cycle=" << cycle
                          << " median_us=" << e.get("median_us").asDouble() << "\n";
                execs.append(e);
            };
            idle(); run_b7(true, 1);
            run_b7(false, 1);
        }

        g_sampler_stop = true;
        sampler.join();

        JsonValue timeline = JsonValue::array();
        {
            std::lock_guard<std::mutex> lk(g_timeline_mu);
            for (const auto& s : g_timeline) {
                JsonValue o = JsonValue::object();
                o.set("utc", JsonValue::str(s.utc));
                o.set("qpc_us", JsonValue::uinteger(s.qpc_us));
                JsonValue r = reading_json(s.r);
                for (const auto& [k, v] : r.entries()) o.set(k, v);
                timeline.append(o);
            }
        }

        JsonValue root = JsonValue::object();
        root.set("static", stat);
        root.set("execs", execs);
        root.set("timeline", timeline);

        std::ofstream out(out_path);
        if (!out) {
            std::cerr << "cannot write " << out_path << "\n";
            return 4;
        }
        out << root.dump(2) << "\n";
        out.close();

        std::cout << "execs=" << execs.items().size()
                  << " timeline_samples=" << timeline.items().size()
                  << "\nwrote " << out_path << "\n";
        return 0;
    } catch (const std::exception& ex) {
        std::cerr << "diag_frequency_evidence: " << ex.what() << "\n";
        return 1;
    }
}
