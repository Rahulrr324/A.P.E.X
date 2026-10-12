// ============================================================================
// bm_b7_diagnostic.cpp — isolated B7 (model-load) diagnostic
// ============================================================================
//
// PURPOSE
//   Re-derived, isolated diagnostic for the B7 operation: open a
//   diagnostic-owned serialized weight blob, read its bytes, and deserialize
//   them with the existing production API (TinyDenseModel::deserializeWeights),
//   with total + component timing, a decomposition residual, a minimal-timing
//   control condition, a measurable instrumentation-overhead calibration, and
//   predeclared classifications.
//
//   This file was written FRESH from the actual production sources:
//     - src/phase1/bench/BenchmarkHarness.cpp (bench_model_load_time, the
//       production B7 operation)
//     - src/phase1/bench/TinyDenseModel.{h,cpp} (serializeWeights /
//       deserializeWeights)
//     - src/phase1/common/ExperimentRecord.{h,cpp} (compute_statistics, the
//       production linear-interpolation median convention)
//   It does NOT reconstruct or claim to recover any prior diagnostic source.
//
// PRODUCTION OPERATION BEING REPRODUCED (verbatim structure)
//   BenchmarkHarness.cpp bench_model_load_time():
//       std::ifstream f(path, std::ios::binary);
//       if (!f) throw std::runtime_error("cannot open weight blob");
//       std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(f)),
//                                  std::istreambuf_iterator<char>());
//       loader.deserializeWeights(bytes);
//   The diagnostic's minimal (least-instrumented) condition executes exactly
//   this statement sequence (see minimal_op()). The instrumented condition
//   executes the same sequence with steady_clock reads at stage boundaries
//   (see instrumented_op()); the open-failure check and exception type/message
//   are identical in both conditions.
//   KNOWN EQUIVALENCE CAVEAT: the campaign path (G7Campaign.cpp
//   run_b7_campaign) omits the explicit `if (!f)` check; on an unreadable file
//   it fails later inside deserializeWeights ("weight blob too small"). This
//   diagnostic follows the bench_model_load_time form (explicit open-failure
//   throw) because the approved requirement is to preserve production's
//   open-failure behavior. On a successfully opened file the two forms are
//   identical. This is an assumption for review, not a verified equivalence.
//
// ISOLATION AND OUTPUT OWNERSHIP
//   - All diagnostic paths live under build/bm_b7_diagnostic/ only. The blob
//     file name (bm_b7_diagnostic_weights.bin) differs from the production
//     blob name (tiny_dense_2l_weights.bin), so it cannot collide with a
//     production/campaign blob even if directories were confused.
//   - validate_diagnostic_path() refuses, before ANY read or write: paths
//     outside build/bm_b7_diagnostic/, absolute paths, ".." segments, and any
//     path containing campaign/historical markers ("g7-campaign", "g7cam",
//     "reports", "records", ".jsonl", "evidence_manifest", "gate_results",
//     the production blob filename). Historical campaign records are never
//     opened, read, appended, or overwritten by this source.
//   - The ONLY files this source writes live in a UNIQUE, RUN-OWNED
//     directory (build/bm_b7_diagnostic/run_<stamp>_<attempt>/) created with
//     an EXCLUSIVE mkdir, containing one weight blob created with EXCLUSIVE
//     file creation (O_CREAT|O_EXCL). A pre-existing blob or run directory is
//     NEVER truncated, opened for writing, or reused — a name collision
//     preserves the existing item and tries the next name, and if exclusive
//     creation cannot be performed the run FAILS CLOSED (no overwrite
//     fallback). Cleanup removes only the exact blob file created by this
//     invocation, then the run directory only if it is empty (rmdir), so all
//     other diagnostic files are preserved. The report is rendered to an
//     in-memory string and printed to stdout; this source writes NO report,
//     record, manifest, or artifact files. Any FUTURE persistence must go
//     under the same validated diagnostic directory and must not target
//     production or historical paths.
//   - NO hash or provenance digest is computed here. Do not report a blob
//     hash from this source; the only blob facts reported are the path and the
//     byte count (real values from the created blob).
//
// WHAT IS NOT DONE (honest limitations)
//   - Not compiled, linked, executed, or timed in the task that produced this
//     file. Build integration is intentionally absent (CMakeLists.txt lists
//     sources explicitly, so this file is inert until a separately authorized
//     build adds a target). No buildability or runtime claim is made.
//   - Cache state is not controlled: the op runs warm-cache, matching the
//     production workload param {mode: warm_cache}. No cache flush is
//     performed, so the results are SEQUENTIAL, PROCESS-LOCAL
//     macro-replications within one run — NOT independent machine- or
//     session-level replications. No cache-state equivalence with the
//     historical campaign is claimed.
//   - No CPU affinity control is applied (the production campaign pinned a
//     single CPU via HardwareAffinity). No CPU-affinity equivalence with the
//     historical campaign conditions is claimed; this is a documented
//     difference, not a match.
//   - Instrumentation overhead is MEASURED by the calibration below, never
//     assumed negligible.
//   - Uses std::chrono::steady_clock, the same clock as production
//     (BenchmarkHarness.cpp), not QPC/high-resolution counters.
//
// TIMING DISCIPLINE
//   No logging, formatting, statistics, or unrelated allocation occurs inside
//   timed regions: timed regions contain only the production op's own work
//   (stream construction, the vector allocation the read inherently requires,
//   deserializeWeights) plus, in the instrumented condition, four clock reads.
//   All bookkeeping, summarization, and rendering happen after all timing.
//   Residual = total − (open + read + deserialize); a non-zero residual is the
//   expected home of call/return + stream-destruction + clock-read overhead
//   and is reported, not hidden.
//
// UNITS
//   Raw samples are stored as double seconds (steady_clock duration<double>).
//   Displayed values use microseconds: µs = seconds × 1,000,000 (exact
//   conversion, applied after computation; no rounding before classification).
//
// HISTORICAL REFERENCE (comparison only)
//   5721.90 µs = stored median of frozen campaign record G7CAM-B7-E5-11933807
//   (reports/g7-campaign-affinityfix/recompute_raw.txt: stored == recomputed).
//   Used ONLY as a comparison datum for the elevation classification below.
//   It is never a pass/fail threshold for this diagnostic's own data, and the
//   process exit code does not encode it.
// ============================================================================

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <exception>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <iterator>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#ifdef _WIN32
#include <direct.h>
#include <fcntl.h>
#include <io.h>
#include <sys/stat.h>
#else
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

#include "bench/TinyDenseModel.h"
#include "common/ExperimentRecord.h"

namespace stark_p1 {
namespace b7diag {

using Clock = std::chrono::steady_clock;

// ---------------------------------------------------------------------------
// Predeclared protocol defaults (approved diagnostic plan)
// ---------------------------------------------------------------------------
constexpr uint32_t kWarmupIterations = 10;      // untimed warmups per replicate
constexpr uint32_t kMeasuredIterations = 50;    // measured iterations per replicate
constexpr uint32_t kMinMacroReplicates = 6;     // sequential, process-local macro-replicates PER CONDITION
constexpr double kHistoricalReferenceMedianUs = 5721.90;  // comparison datum ONLY
constexpr double kCalibMeanOverheadThresholdPct = 2.0;    // mean overhead <= 2%
constexpr double kCalibWorstOverheadThresholdPct = 10.0;  // worst-case overhead <= 10%
constexpr double kCalibMedianDeviationThresholdPct = 2.0; // median deviation <= 2%

// Isolation: the only directory this diagnostic may touch.
constexpr const char* kDiagnosticDir = "build/bm_b7_diagnostic";
constexpr const char* kBlobFileName = "bm_b7_diagnostic_weights.bin";

// ---------------------------------------------------------------------------
// Unit conversion (documented, exact)
// ---------------------------------------------------------------------------
inline double sec_to_us(double sec) { return sec * 1000000.0; }  // 1 s = 1e6 µs

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------
struct Protocol {
    uint32_t warmup_count = kWarmupIterations;       // untimed
    uint32_t measurement_count = kMeasuredIterations;
    uint32_t macro_replicates = kMinMacroReplicates; // per condition
    std::vector<std::string> validate() const {
        std::vector<std::string> errs;
        if (warmup_count < 3)
            errs.push_back("warmup_count must be >= 3 (spec §B floor; plan default 10)");
        if (measurement_count < 10)
            errs.push_back("measurement_count must be >= 10 (spec §B floor; plan default 50)");
        if (macro_replicates < kMinMacroReplicates)
            errs.push_back("macro_replicates must be >= 6 (sequential, process-local macro-replicates per condition)");
        return errs;
    }
};

// ---------------------------------------------------------------------------
// Isolation: path construction and validation
// ---------------------------------------------------------------------------
inline std::string to_lower(std::string s) {
    for (char& c : s)
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    return s;
}

/// Returns an empty string when the path is acceptable for diagnostic use,
/// otherwise a human-readable refusal reason. Checked BEFORE any read/write.
std::string validate_diagnostic_path(const std::string& raw) {
    if (raw.empty()) return "path empty";
    if (raw.find(':') != std::string::npos)
        return "absolute paths are not allowed (drive letters / schemes)";
    if (!raw.empty() && (raw[0] == '/' || raw[0] == '\\'))
        return "absolute paths are not allowed";
    if (raw.find("..") != std::string::npos)
        return "'..' path traversal is not allowed";

    const std::string prefix = std::string(kDiagnosticDir) + "/";
    if (raw.rfind(prefix, 0) != 0)
        return "path must live under " + prefix + " (diagnostic-owned directory only)";

    // Defense in depth: never touch campaign/historical/production artifacts.
    static const char* kForbidden[] = {
        "g7-campaign", "g7cam", "reports", "records", ".jsonl",
        "evidence_manifest", "gate_results", "tiny_dense_2l_weights.bin",
    };
    const std::string low = to_lower(raw);
    for (const char* f : kForbidden) {
        if (low.find(to_lower(f)) != std::string::npos)
            return std::string("path contains forbidden marker '") + f +
                   "' (historical/production data must never be touched)";
    }
    return "";
}

std::string make_blob_path(const std::string& dir) {
    if (!dir.empty() && dir.back() == '/') return dir + kBlobFileName;
    return dir + "/" + kBlobFileName;
}

struct DiagnosticPaths {
    // Base directory only: the run-owned subdirectory and blob name are
    // assigned at exclusive creation, so no path here can pre-exist as a file.
    std::string directory = kDiagnosticDir;
};

// ---------------------------------------------------------------------------
// Collision-safe, run-owned storage (never inside a timed region)
// ---------------------------------------------------------------------------
// A pre-existing blob or run directory is NEVER truncated, opened for
// writing, or reused. The run directory is created with an EXCLUSIVE mkdir
// (the name is refused if it already exists; collisions are resolved by
// trying the NEXT name, preserving anything already present), and the blob
// file is created with O_CREAT|O_EXCL (refused if the file exists). If
// exclusive creation is not supported or fails, the run FAILS CLOSED — there
// is no overwrite fallback. Ownership is tracked explicitly: cleanup removes
// only the exact blob file created by this invocation, then the run
// directory only if it is empty (rmdir semantics), preserving all other
// diagnostic files.

enum class DirCreateResult { CREATED, EXISTS, ERROR };

DirCreateResult create_directory_exclusive(const std::string& p) {
#ifdef _WIN32
    if (_mkdir(p.c_str()) == 0) return DirCreateResult::CREATED;
#else
    if (mkdir(p.c_str(), 0755) == 0) return DirCreateResult::CREATED;
#endif
    return errno == EEXIST ? DirCreateResult::EXISTS : DirCreateResult::ERROR;
}

bool ensure_directory(const std::string& p) {  // base area only (a directory, not a file)
    return create_directory_exclusive(p) != DirCreateResult::ERROR;
}

std::string validate_diagnostic_dir(const std::string& dir) {
    std::string d = dir;
    while (!d.empty() && (d.back() == '/' || d.back() == '\\')) d.pop_back();
    if (d.empty()) return "directory empty";
    if (d.find(':') != std::string::npos)
        return "absolute paths are not allowed";
    if (d[0] == '/' || d[0] == '\\')
        return "absolute paths are not allowed";
    if (d.find("..") != std::string::npos)
        return "'..' path traversal is not allowed";
    if (!(d == kDiagnosticDir || d.rfind(std::string(kDiagnosticDir) + "/", 0) == 0))
        return std::string("directory must be ") + kDiagnosticDir +
               " or a subdirectory of it";
    return "";
}

/// Exclusive file creation: returns a writable fd, or -1 (including when the
/// file already exists). Failure is always safe — nothing is truncated.
int exclusive_create_file(const std::string& p) {
#ifdef _WIN32
    return _open(p.c_str(), _O_WRONLY | _O_CREAT | _O_EXCL | _O_BINARY,
                 _S_IREAD | _S_IWRITE);
#else
    return ::open(p.c_str(), O_WRONLY | O_CREAT | O_EXCL, 0644);
#endif
}

bool write_all_fd(int fd, const uint8_t* data, size_t n) {
    size_t off = 0;
    while (off < n) {
        const size_t remaining = n - off;
        const size_t chunk = remaining > (1u << 20) ? (1u << 20) : remaining;
#ifdef _WIN32
        const int w = _write(fd, data + off, static_cast<unsigned>(chunk));
#else
        const ssize_t w = ::write(fd, data + off, chunk);
#endif
        if (w <= 0) return false;
        off += static_cast<size_t>(w);
    }
    return true;
}

constexpr uint32_t kMaxRunDirAttempts = 1000;

struct RunOwnedBlob {
    bool owns_run_dir = false;    // exclusively created by THIS invocation
    bool owns_blob_file = false;  // exclusively created by THIS invocation
    std::string failure;          // non-empty when storage could not be created
    std::string run_dir;
    std::string blob_path;
    size_t blob_bytes = 0;
    bool ok() const { return owns_run_dir && owns_blob_file && failure.empty(); }
};

RunOwnedBlob create_run_owned_blob(const DiagnosticPaths& paths) {
    RunOwnedBlob out;

    const std::string derr = validate_diagnostic_dir(paths.directory);
    if (!derr.empty()) {
        out.failure = "refusing to create run storage: " + derr;
        return out;
    }
    if (!ensure_directory(paths.directory)) {
        out.failure = "cannot create diagnostic base directory: " + paths.directory;
        return out;
    }

    // Unique run-owned directory: exclusive creation; on a name collision the
    // existing directory is PRESERVED and the next name is tried.
    const std::string stamp = std::to_string(
        std::chrono::system_clock::now().time_since_epoch().count());
    bool dir_created = false;
    for (uint32_t attempt = 0; attempt < kMaxRunDirAttempts && !dir_created; ++attempt) {
        out.run_dir = paths.directory + "/run_" + stamp + "_" + std::to_string(attempt);
        // Validate the exact candidate path BEFORE any filesystem call.
        const std::string perr = validate_diagnostic_path(make_blob_path(out.run_dir));
        if (!perr.empty()) {
            out.run_dir.clear();
            out.failure = "refusing run directory path: " + perr;
            return out;
        }
        const DirCreateResult r = create_directory_exclusive(out.run_dir);
        if (r == DirCreateResult::CREATED) {
            out.owns_run_dir = true;
            dir_created = true;
        } else if (r == DirCreateResult::ERROR) {
            out.failure = "cannot create run directory: " + out.run_dir;
            out.run_dir.clear();
            return out;
        }
        // EXISTS: preserve the existing directory, try the next name.
    }
    if (!dir_created) {
        out.failure = "no unique run directory after " +
                      std::to_string(kMaxRunDirAttempts) + " attempts";
        out.run_dir.clear();
        return out;
    }

    // Blob file: EXCLUSIVE creation only. A pre-existing file can never be
    // truncated or reused; failure closes the run without overwriting.
    out.blob_path = make_blob_path(out.run_dir);
    const std::string perr = validate_diagnostic_path(out.blob_path);
    if (!perr.empty()) {
        out.failure = "refusing blob path: " + perr;
        return out;  // owned (empty) run dir removed by cleanup
    }
    const int fd = exclusive_create_file(out.blob_path);
    if (fd < 0) {
        out.failure = "cannot exclusively create blob (exists or exclusive "
                      "creation unsupported); nothing overwritten: " + out.blob_path;
        out.blob_path.clear();
        return out;
    }
    out.owns_blob_file = true;  // we own this exact file, even if the write fails

    TinyDenseModel writer(1);
    std::vector<uint8_t> blob = writer.serializeWeights();
    const bool written = write_all_fd(fd, blob.data(), blob.size());
#ifdef _WIN32
    const bool closed = (_close(fd) == 0);
#else
    const bool closed = (::close(fd) == 0);
#endif
    if (!written || !closed) {
        out.failure = "failed writing run-owned blob: " + out.blob_path;
        return out;  // cleanup removes the owned (possibly partial) file
    }
    out.blob_bytes = blob.size();  // real byte count; NO hash is computed
    return out;
}

/// Cleanup: removes ONLY files/directories created by this invocation.
/// Idempotent, re-validates every path before removal, never throws, and
/// records what happened. The run directory is removed only when empty, so
/// any file this invocation does not own is preserved.
struct BlobCleanup {
    RunOwnedBlob owned;
    bool attempted = false;
    bool removed_blob = false;
    bool removed_dir = false;
    std::string note = "cleanup not attempted";
    void perform() {
        if (attempted) return;
        attempted = true;
        if (!owned.owns_run_dir && !owned.owns_blob_file) {
            note = "no run-owned storage was created; nothing removed";
            return;
        }
        note.clear();
        bool first = true;
        auto add = [&](const std::string& s) {
            if (!first) note += "; ";
            note += s;
            first = false;
        };
        if (owned.owns_blob_file && !owned.blob_path.empty()) {
            const std::string verr = validate_diagnostic_path(owned.blob_path);
            if (!verr.empty()) {
                add("refused to remove blob: failed isolation validation: " + verr);
            } else if (std::remove(owned.blob_path.c_str()) == 0) {
                removed_blob = true;
                add("run-owned blob removed (created by this invocation)");
            } else {
                add("run-owned blob not removed (absent or remove failed)");
            }
        }
        if (owned.owns_run_dir && !owned.run_dir.empty()) {
            const std::string derr = validate_diagnostic_dir(owned.run_dir);
            if (!derr.empty()) {
                add("refused to remove run dir: failed isolation validation: " + derr);
            } else {
#ifdef _WIN32
                const bool dir_removed = (_rmdir(owned.run_dir.c_str()) == 0);
#else
                const bool dir_removed = (::rmdir(owned.run_dir.c_str()) == 0);
#endif
                if (dir_removed) {
                    removed_dir = true;
                    add("run dir removed (empty; a non-empty dir is always kept)");
                } else {
                    add("run dir kept (not empty or remove failed)");
                }
            }
        }
    }
};

// ---------------------------------------------------------------------------
// Production-faithful operations
// ---------------------------------------------------------------------------

/// Decomposition components for ONE instrumented iteration (all double sec).
/// total_sec is measured by an INDEPENDENT outer timer in run_replicate()
/// (bracketing the call), so residual = total − sum(components) is a real,
/// reported quantity (call/return + stream destruction + clock-read overhead).
struct ComponentTimings {
    double open_sec = 0.0;
    double read_sec = 0.0;
    double deser_sec = 0.0;
    double residual_sec = 0.0;
};

/// MINIMAL (least-instrumented) condition. Verbatim production B7 statement
/// sequence from BenchmarkHarness.cpp bench_model_load_time(); the caller
/// brackets this call with a single steady_clock pair, exactly as
/// run_benchmark() does. Contains no internal timing at all.
void minimal_op(const std::string& path, TinyDenseModel& loader) {
    std::ifstream f(path, std::ios::binary);
    if (!f) throw std::runtime_error("cannot open weight blob");
    std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(f)),
                               std::istreambuf_iterator<char>());
    loader.deserializeWeights(bytes);
}

/// INSTRUMENTED condition. Identical statement sequence and identical
/// open-failure behavior to minimal_op(), with four steady_clock reads at
/// stage boundaries. No other instrumentation, no logging, no allocation
/// beyond what the production op itself performs.
void instrumented_op(const std::string& path, TinyDenseModel& loader,
                     ComponentTimings& t) {
    const auto t0 = Clock::now();
    std::ifstream f(path, std::ios::binary);
    if (!f) throw std::runtime_error("cannot open weight blob");
    const auto t1 = Clock::now();
    std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(f)),
                               std::istreambuf_iterator<char>());
    const auto t2 = Clock::now();
    loader.deserializeWeights(bytes);
    const auto t3 = Clock::now();
    t.open_sec = std::chrono::duration<double>(t1 - t0).count();
    t.read_sec = std::chrono::duration<double>(t2 - t1).count();
    t.deser_sec = std::chrono::duration<double>(t3 - t2).count();
    // residual_sec is filled by the caller once the independent total exists.
    t.residual_sec = 0.0;
}

// ---------------------------------------------------------------------------
// Statistics (production-compatible median; explicit units)
// ---------------------------------------------------------------------------
struct Summary {
    bool valid = false;
    size_t n = 0;
    double mean_us = 0.0;
    double median_us = 0.0;
    double stdev_us = 0.0;
    double cv_pct = 0.0;
    double min_us = 0.0;
    double max_us = 0.0;
    double p95_us = 0.0;
    double p25_us = 0.0;
    double p75_us = 0.0;
    double iqr_us = 0.0;
};

/// Linear-interpolation quantile with the SAME convention as
/// stark_p1::compute_statistics (ExperimentRecord.cpp: pos = q*(n-1),
/// interpolate between order statistics). Used only for p25/p75 (IQR);
/// the median itself comes from the production function directly.
double linear_quantile_sorted(const std::vector<double>& sorted, double q) {
    const size_t n = sorted.size();
    if (n == 0) return 0.0;
    if (n == 1) return sorted[0];
    const double pos = q * static_cast<double>(n - 1);
    const size_t lo = static_cast<size_t>(pos);
    const size_t hi = std::min(lo + 1, n - 1);
    const double frac = pos - static_cast<double>(lo);
    return sorted[lo] + frac * (sorted[hi] - sorted[lo]);
}

/// Summarize raw samples (seconds) → µs. Delegates mean/median/p95/stdev/
/// min/max to the PRODUCTION compute_statistics() so the median convention
/// cannot drift from production. Empty input → valid=false (never fabricated).
Summary summarize(const std::vector<double>& samples_sec) {
    Summary s;
    if (samples_sec.empty()) {
        s.valid = false;
        return s;
    }
    const Statistics st = compute_statistics(samples_sec);  // production convention
    if (!st.computed) {
        s.valid = false;
        return s;
    }
    s.valid = true;
    s.n = st.samples.size();
    s.mean_us = sec_to_us(st.mean);
    s.median_us = sec_to_us(st.median);
    s.stdev_us = sec_to_us(st.stdev);
    s.min_us = sec_to_us(st.min);
    s.max_us = sec_to_us(st.max);
    s.p95_us = sec_to_us(st.p95);
    s.cv_pct = (st.mean > 0.0) ? 100.0 * st.stdev / st.mean : 0.0;
    std::vector<double> sorted = samples_sec;
    std::sort(sorted.begin(), sorted.end());
    s.p25_us = sec_to_us(linear_quantile_sorted(sorted, 0.25));
    s.p75_us = sec_to_us(linear_quantile_sorted(sorted, 0.75));
    s.iqr_us = s.p75_us - s.p25_us;
    return s;
}

// ---------------------------------------------------------------------------
// Conditions, replicates, protocol execution
// ---------------------------------------------------------------------------
enum class Mode { MINIMAL, INSTRUMENTED };

const char* mode_name(Mode m) {
    return m == Mode::MINIMAL ? "MINIMAL" : "INSTRUMENTED";
}

struct ReplicateResult {
    Mode mode = Mode::MINIMAL;
    uint32_t index = 0;
    bool valid = false;                  // warmup + ALL measured iterations ok
    std::string failure_reason;          // empty iff valid
    uint32_t failed_iterations = 0;
    std::vector<double> total_samples_sec;   // exactly measurement_count iff valid
    std::vector<ComponentTimings> components;  // INSTRUMENTED only
    Summary summary;                     // valid only when replicate valid
};

/// One sequential, process-local macro-replicate: fresh loader, fresh
/// untimed warmups, fresh measured loop, executed in-process after the
/// previous replicate. A failed warmup or a failed/invalid iteration marks
/// the WHOLE replicate invalid (partial samples are retained for the record
/// but are never summarized or classified). Replicates are NOT independent
/// machine/session replications.
ReplicateResult run_replicate(Mode mode, uint32_t index,
                              const std::string& blob_path,
                              const Protocol& proto) {
    ReplicateResult r;
    r.mode = mode;
    r.index = index;

    TinyDenseModel loader(1);  // constructed outside all timed regions

    try {
        for (uint32_t i = 0; i < proto.warmup_count; ++i) {  // UNTIMED
            if (mode == Mode::INSTRUMENTED) {
                ComponentTimings discard;
                instrumented_op(blob_path, loader, discard);
            } else {
                minimal_op(blob_path, loader);
            }
        }
    } catch (const std::exception& ex) {
        r.valid = false;
        r.failure_reason = std::string("warmup failed: ") + ex.what();
        return r;
    }

    r.total_samples_sec.reserve(proto.measurement_count);
    if (mode == Mode::INSTRUMENTED)
        r.components.reserve(proto.measurement_count);

    for (uint32_t i = 0; i < proto.measurement_count; ++i) {
        double total_sec = 0.0;
        ComponentTimings comp;
        try {
            const auto tA = Clock::now();  // independent outer total timer
            if (mode == Mode::INSTRUMENTED)
                instrumented_op(blob_path, loader, comp);
            else
                minimal_op(blob_path, loader);
            const auto tB = Clock::now();
            total_sec = std::chrono::duration<double>(tB - tA).count();
        } catch (const std::exception& ex) {
            r.failed_iterations += 1;
            r.valid = false;
            r.failure_reason = "iteration " + std::to_string(i) +
                               " failed: " + ex.what();
            return r;  // partial samples retained, NEVER summarized
        }
        if (!(total_sec >= 0.0)) {  // clock sanity (mirrors production)
            r.failed_iterations += 1;
            r.valid = false;
            r.failure_reason = "iteration " + std::to_string(i) +
                               " produced a non-monotonic/invalid timer sample";
            return r;
        }
        r.total_samples_sec.push_back(total_sec);
        if (mode == Mode::INSTRUMENTED) {
            comp.residual_sec =
                total_sec - (comp.open_sec + comp.read_sec + comp.deser_sec);
            r.components.push_back(comp);
        }
    }

    if (r.total_samples_sec.size() != static_cast<size_t>(proto.measurement_count)) {
        r.valid = false;
        r.failure_reason = "sample count mismatch after measured loop";
        return r;
    }
    r.summary = summarize(r.total_samples_sec);
    if (!r.summary.valid) {
        r.valid = false;
        r.failure_reason = "empty or unsummarizable sample set";
        return r;
    }
    r.valid = true;
    return r;
}

// ---------------------------------------------------------------------------
// Balanced (counterbalanced) condition ordering, recorded
// ---------------------------------------------------------------------------
struct ScheduleEntry {
    uint32_t replicate = 0;
    bool minimal_first = true;
};

/// Counterbalanced: even replicate indices run MINIMAL first, odd indices run
/// INSTRUMENTED first, so with the default (even) macro-replicate count each
/// condition appears equally often in each execution position. The executed
/// order is recorded verbatim in the report.
std::vector<ScheduleEntry> build_schedule(uint32_t replicates) {
    std::vector<ScheduleEntry> s;
    s.reserve(replicates);
    for (uint32_t i = 0; i < replicates; ++i)
        s.push_back(ScheduleEntry{i, (i % 2u) == 0u});
    return s;
}

// ---------------------------------------------------------------------------
// Calibration: MEASURED instrumentation overhead (never assumed)
// ---------------------------------------------------------------------------
struct CalibrationResult {
    enum class Status { PASS, FAIL, INCONCLUSIVE };
    Status status = Status::INCONCLUSIVE;
    bool computable = false;
    double mean_overhead_pct = 0.0;
    double worst_case_overhead_pct = 0.0;
    double median_deviation_pct = 0.0;
    bool mean_ok = false;
    bool worst_ok = false;
    bool median_ok = false;
    std::string note = "calibration not computed";
};

const char* calibration_status_name(CalibrationResult::Status s) {
    switch (s) {
        case CalibrationResult::Status::PASS: return "PASS";
        case CalibrationResult::Status::FAIL: return "FAIL";
        case CalibrationResult::Status::INCONCLUSIVE: return "INCONCLUSIVE";
    }
    return "INCONCLUSIVE";
}

/// Computes, from actual paired data (replicate i MINIMAL vs replicate i
/// INSTRUMENTED, same index, counterbalanced order):
///   - mean_overhead_pct      = 100 * (meanInstr − meanMin) / meanMin
///                              (pooled over all valid samples; |value|
///                              compared against the 2% threshold)
///   - worst_case_overhead_pct = maximum OBSERVED SIGNED paired overhead over
///                              aligned (replicate, iteration) pairs,
///                              100*(instr − min)/min (threshold <= 10%).
///                              Never clamped: if every paired overhead is
///                              negative (instrumented faster), the reported
///                              maximum is negative, not zero.
///   - median_deviation_pct    = 100 * |medianInstr − medianMin| / medianMin
///                              (pooled medians; <= 2%)
/// Status = PASS iff all three computed AND all three within threshold;
/// FAIL iff all three computed AND any exceeds threshold;
/// INCONCLUSIVE otherwise (insufficient/invalid data, non-positive or
/// non-finite denominators). Success is NEVER hard-coded.
CalibrationResult calibrate(const std::vector<ReplicateResult>& minimal,
                            const std::vector<ReplicateResult>& instrumented,
                            uint32_t required_replicates) {
    CalibrationResult c;
    auto inconclusive = [&](const std::string& why) {
        c.status = CalibrationResult::Status::INCONCLUSIVE;
        c.computable = false;
        c.note = why;
        return c;
    };
    if (minimal.size() < required_replicates ||
        instrumented.size() < required_replicates)
        return inconclusive("insufficient replication for calibration");
    for (const auto& r : minimal)
        if (!r.valid) return inconclusive("a MINIMAL replicate is invalid: " + r.failure_reason);
    for (const auto& r : instrumented)
        if (!r.valid) return inconclusive("an INSTRUMENTED replicate is invalid: " + r.failure_reason);

    // Pooled means.
    double sum_min = 0.0, sum_instr = 0.0;
    size_t n_min = 0, n_instr = 0;
    for (const auto& r : minimal)
        for (double v : r.total_samples_sec) { sum_min += v; ++n_min; }
    for (const auto& r : instrumented)
        for (double v : r.total_samples_sec) { sum_instr += v; ++n_instr; }
    if (n_min == 0 || n_instr == 0)
        return inconclusive("empty sample pool");
    const double mean_min = sum_min / static_cast<double>(n_min);
    const double mean_instr = sum_instr / static_cast<double>(n_instr);
    if (!(mean_min > 0.0) || !std::isfinite(mean_min) || !std::isfinite(mean_instr))
        return inconclusive("non-positive or non-finite minimal-condition mean");
    c.mean_overhead_pct = 100.0 * (mean_instr - mean_min) / mean_min;

    // Worst case over aligned (replicate, iteration) pairs: the maximum
    // OBSERVED SIGNED paired overhead. Values are never clamped — when every
    // paired overhead is negative (instrumented iteration faster than its
    // minimal partner), the reported maximum is negative, not zero. The 10%
    // threshold applies to the signed maximum unchanged (any negative maximum
    // trivially satisfies "overhead <= 10%").
    double worst = 0.0;
    bool have_pair = false;
    for (size_t i = 0; i < minimal.size(); ++i) {
        const auto& a = minimal[i].total_samples_sec;
        const auto& b = instrumented[i].total_samples_sec;
        if (a.size() != b.size())
            return inconclusive("paired sample-count mismatch between conditions");
        for (size_t j = 0; j < a.size(); ++j) {
            if (!(a[j] > 0.0) || !std::isfinite(a[j]) || !std::isfinite(b[j]))
                return inconclusive("non-positive or non-finite paired sample");
            const double pct = 100.0 * (b[j] - a[j]) / a[j];
            if (!std::isfinite(pct))
                return inconclusive("non-finite paired overhead");
            if (!have_pair || pct > worst) {
                worst = pct;
                have_pair = true;
            }
        }
    }
    if (!have_pair)
        return inconclusive("no comparable pairs for worst-case overhead");
    if (!std::isfinite(worst))
        return inconclusive("non-finite worst-case overhead");
    c.worst_case_overhead_pct = worst;

    // Pooled medians (production convention via summarize()).
    std::vector<double> pooled_min, pooled_instr;
    for (const auto& r : minimal)
        pooled_min.insert(pooled_min.end(), r.total_samples_sec.begin(),
                          r.total_samples_sec.end());
    for (const auto& r : instrumented)
        pooled_instr.insert(pooled_instr.end(), r.total_samples_sec.begin(),
                            r.total_samples_sec.end());
    const Summary s_min = summarize(pooled_min);
    const Summary s_instr = summarize(pooled_instr);
    if (!s_min.valid || !s_instr.valid || !(s_min.median_us > 0.0))
        return inconclusive("pooled median unavailable or non-positive");
    c.median_deviation_pct =
        100.0 * std::fabs(s_instr.median_us - s_min.median_us) / s_min.median_us;

    c.computable = true;
    c.mean_ok = std::fabs(c.mean_overhead_pct) <= kCalibMeanOverheadThresholdPct;
    c.worst_ok = c.worst_case_overhead_pct <= kCalibWorstOverheadThresholdPct;
    c.median_ok = c.median_deviation_pct <= kCalibMedianDeviationThresholdPct;
    if (c.mean_ok && c.worst_ok && c.median_ok) {
        c.status = CalibrationResult::Status::PASS;
        c.note = "all three thresholds satisfied by measured data";
    } else {
        c.status = CalibrationResult::Status::FAIL;
        c.note = "instrumentation overhead exceeds threshold(s): " +
                 std::string(c.mean_ok ? "" : "mean ") +
                 std::string(c.worst_ok ? "" : "worst-case ") +
                 std::string(c.median_ok ? "" : "median-deviation ");
    }
    return c;
}

// ---------------------------------------------------------------------------
// Classification (predeclared decision rules, verbatim)
// ---------------------------------------------------------------------------
//   Rule 0 (reproducibility is a REPLICA-level property): elevation is decided
//     ONLY from per-replicate MEDIANS (each built from a full measured loop of
//     `measurement_count` iterations). Per-iteration samples are NEVER
//     classified. A single slow iteration can therefore never establish
//     reproducible elevation.
//   Rule 1 — INSUFFICIENT_REPLICATION: either condition has fewer than
//     `macro_replicates` (>= 6) valid sequential, process-local
//     macro-replicates, or any replicate is invalid (failed iteration, empty
//     samples, warmup failure).
//   Rule 2 — a replicate is "elevated" iff its median (µs) >
//     kHistoricalReferenceMedianUs (5721.90 µs), the historical comparison
//     datum. This is a comparison, not a pass/fail gate on the run itself.
//   Rule 3 — REPRODUCIBLE_ELEVATION: Rule 1 fails (replication sufficient)
//     AND calibration status is PASS AND EVERY valid replicate in BOTH
//     conditions is elevated AND the pooled median of BOTH conditions exceeds
//     the reference. (Calibration must PASS because unvalidated instrumentation
//     overhead could fabricate or mask elevation.)
//   Rule 4 — NOT_ELEVATED: Rule 1 fails AND ZERO replicates in either
//     condition are elevated. (Calibration status is irrelevant here: overhead
//     can only inflate timings, so it cannot manufacture a false
//     "not elevated" from elevated-looking data — and insufficient calibration
//     never blocks reporting the conservative direction.)
//   Rule 5 — INCONCLUSIVE: everything else (replication sufficient but
//     elevation is mixed across replicates, or elevation is observed while
//     calibration is not PASS).
enum class Classification {
    INSUFFICIENT_REPLICATION,
    INCONCLUSIVE,
    NOT_ELEVATED,
    REPRODUCIBLE_ELEVATION,
};

const char* classification_name(Classification c) {
    switch (c) {
        case Classification::INSUFFICIENT_REPLICATION: return "INSUFFICIENT_REPLICATION";
        case Classification::INCONCLUSIVE: return "INCONCLUSIVE";
        case Classification::NOT_ELEVATED: return "NOT_ELEVATED";
        case Classification::REPRODUCIBLE_ELEVATION: return "REPRODUCIBLE_ELEVATION";
    }
    return "INSUFFICIENT_REPLICATION";
}

bool replicate_elevated(const ReplicateResult& r, double reference_us) {
    return r.valid && r.summary.valid && r.summary.median_us > reference_us;
}

Classification classify(const CalibrationResult& cal,
                        const std::vector<ReplicateResult>& minimal,
                        const std::vector<ReplicateResult>& instrumented,
                        uint32_t required_replicates,
                        double reference_us) {
    // Rule 1: sufficient sequential, process-local replication in BOTH conditions.
    if (minimal.size() < required_replicates ||
        instrumented.size() < required_replicates)
        return Classification::INSUFFICIENT_REPLICATION;
    for (const auto& r : minimal)
        if (!r.valid || !r.summary.valid) return Classification::INSUFFICIENT_REPLICATION;
    for (const auto& r : instrumented)
        if (!r.valid || !r.summary.valid) return Classification::INSUFFICIENT_REPLICATION;

    size_t elev_min = 0, elev_instr = 0;
    for (const auto& r : minimal) elev_min += replicate_elevated(r, reference_us) ? 1u : 0u;
    for (const auto& r : instrumented) elev_instr += replicate_elevated(r, reference_us) ? 1u : 0u;

    std::vector<double> pooled_min, pooled_instr;
    for (const auto& r : minimal)
        pooled_min.insert(pooled_min.end(), r.total_samples_sec.begin(),
                          r.total_samples_sec.end());
    for (const auto& r : instrumented)
        pooled_instr.insert(pooled_instr.end(), r.total_samples_sec.begin(),
                            r.total_samples_sec.end());
    const Summary ps_min = summarize(pooled_min);
    const Summary ps_instr = summarize(pooled_instr);

    const bool all_elevated =
        elev_min == minimal.size() && elev_instr == instrumented.size();
    const bool none_elevated = elev_min == 0 && elev_instr == 0;
    const bool pooled_elevated = ps_min.valid && ps_instr.valid &&
                                 ps_min.median_us > reference_us &&
                                 ps_instr.median_us > reference_us;

    if (all_elevated && pooled_elevated &&
        cal.status == CalibrationResult::Status::PASS)
        return Classification::REPRODUCIBLE_ELEVATION;          // Rule 3
    if (none_elevated) return Classification::NOT_ELEVATED;      // Rule 4
    return Classification::INCONCLUSIVE;                          // Rule 5
}

// ---------------------------------------------------------------------------
// Report (rendered entirely OUTSIDE timed regions; stdout only)
// ---------------------------------------------------------------------------
struct DiagnosticReport {
    bool completed = false;            // false => aborted; never "successful"
    std::string abort_reason;
    Protocol protocol;
    size_t blob_bytes = 0;             // real value from the created blob
    std::string blob_path;
    std::vector<std::string> executed_order;  // recorded balanced order
    std::vector<ReplicateResult> minimal;
    std::vector<ReplicateResult> instrumented;
    CalibrationResult calibration;
    Classification classification = Classification::INSUFFICIENT_REPLICATION;
    std::string cleanup_note = "cleanup not attempted";
};

void append_summary_block(std::ostringstream& os, const char* title,
                          const Summary& s) {
    os << "  " << title << ":\n";
    if (!s.valid) {
        os << "    (no valid samples — not computed; nothing fabricated)\n";
        return;
    }
    os << "    n=" << s.n
       << "  median=" << std::fixed << std::setprecision(3) << s.median_us << " us"
       << "  mean=" << s.mean_us << " us"
       << "  stdev=" << s.stdev_us << " us"
       << "  cv=" << std::setprecision(2) << s.cv_pct << " %\n"
       << "    min=" << std::setprecision(3) << s.min_us << " us"
       << "  p95=" << s.p95_us << " us"
       << "  max=" << s.max_us << " us"
       << "  iqr=" << s.iqr_us << " us\n";
}

std::string render_report(const DiagnosticReport& rep) {
    std::ostringstream os;
    os << "=== B7 isolated diagnostic report ===\n";
    os << "units: raw samples stored as seconds; displayed in us "
          "(us = s * 1e6, applied after computation, no pre-classification rounding)\n";
    os << "protocol: warmup=" << rep.protocol.warmup_count
       << " (untimed), measured=" << rep.protocol.measurement_count
       << ", macro_replicates_per_condition=" << rep.protocol.macro_replicates
       << " (min " << kMinMacroReplicates
       << "; SEQUENTIAL, PROCESS-LOCAL replications within one run — not "
          "independent machine/session replications)\n";
    if (rep.blob_bytes > 0) {
        os << "diagnostic blob: path=" << rep.blob_path
           << "  bytes=" << rep.blob_bytes
           << "  (run-owned, exclusively created — pre-existing files never "
              "overwritten; real byte count; NO hash/provenance digest is "
              "computed by this source)\n";
    } else {
        os << "diagnostic blob: (no run-owned blob was created)\n";
    }
    os << "executed condition order (recorded):\n";
    for (const auto& line : rep.executed_order) os << "  " << line << "\n";
    os << "conditions run SEQUENTIALLY and process-locally (not independent "
          "machine/session replications); cache state is not controlled "
          "(warm-cache) and no cache-state or CPU-affinity equivalence with "
          "the historical campaign is claimed.\n";

    if (!rep.completed) {
        os << "status: ABORTED — " << rep.abort_reason << "\n";
        os << "classification: " << classification_name(rep.classification)
           << " (incomplete run is NOT reported as success)\n";
        os << "cleanup: " << rep.cleanup_note << "\n";
        return os.str();
    }

    auto dump_condition = [&](const char* title, const std::vector<ReplicateResult>& rs) {
        os << title << " (" << rs.size() << " macro-replicates):\n";
        for (const auto& r : rs) {
            os << "  replicate " << r.index << ": "
               << (r.valid ? "VALID" : "INVALID");
            if (r.summary.valid) {
                os << "  median_us=" << std::fixed << std::setprecision(3)
                   << r.summary.median_us;
            } else {
                os << "  median_us=(none — not computed)";
            }
            if (!r.valid)
                os << "  reason=" << r.failure_reason
                   << "  failed_iterations=" << r.failed_iterations;
            os << "\n";
        }
        std::vector<double> pooled;
        for (const auto& r : rs)
            if (r.valid)
                pooled.insert(pooled.end(), r.total_samples_sec.begin(),
                              r.total_samples_sec.end());
        append_summary_block(os, "pooled (valid replicates only)", summarize(pooled));
    };
    dump_condition("MINIMAL condition (production op, single outer timer)", rep.minimal);
    dump_condition("INSTRUMENTED condition (op + component timers)", rep.instrumented);

    // Component decomposition (INSTRUMENTED only).
    {
        os << "component decomposition (INSTRUMENTED, pooled across valid replicates):\n";
        // UNIT FIX: store raw seconds (not us). The vectors are later passed to
        // summarize(), which accepts seconds and applies sec_to_us() to its
        // summary statistics, so the displayed medians/statistics are now in
        // microseconds rather than being inflated by ~1e6.
        std::vector<double> open, read, deser, resid;
        for (const auto& r : rep.instrumented) {
            if (!r.valid) continue;
            for (const auto& c : r.components) {
                open.push_back(c.open_sec);
                read.push_back(c.read_sec);
                deser.push_back(c.deser_sec);
                resid.push_back(c.residual_sec);
            }
        }
        append_summary_block(os, "open", summarize(open));
        append_summary_block(os, "read", summarize(read));
        append_summary_block(os, "deserialize", summarize(deser));
        append_summary_block(os, "residual = total - (open+read+deserialize)",
                             summarize(resid));
        os << "  residual is expected >= 0 (call/return + stream destruction + "
              "clock-read overhead); it is reported, never hidden.\n";
    }

    // Calibration.
    const auto& c = rep.calibration;
    os << "calibration (instrumentation overhead, measured not assumed):\n";
    if (c.computable) {
        os << "  mean_overhead_pct       = " << std::fixed << std::setprecision(4)
           << c.mean_overhead_pct << " %   (threshold <= "
           << kCalibMeanOverheadThresholdPct << " %)\n";
        os << "  worst_case_overhead_pct = " << c.worst_case_overhead_pct
           << " %   (max SIGNED paired overhead; threshold <= "
           << kCalibWorstOverheadThresholdPct << " %)\n";
        os << "  median_deviation_pct    = " << c.median_deviation_pct
           << " %   (threshold <= " << kCalibMedianDeviationThresholdPct << " %)\n";
        os << "  threshold checks: mean " << (c.mean_ok ? "OK" : "NOT OK")
           << ", worst-case " << (c.worst_ok ? "OK" : "NOT OK")
           << ", median-deviation " << (c.median_ok ? "OK" : "NOT OK") << "\n";
        os << "  worst-case is the maximum SIGNED paired overhead; negative "
              "values (instrumented faster) are reported as observed, never "
              "clamped to zero.\n";
    } else {
        os << "  metrics: (not computed — no values are reported without data)\n";
    }
    os << "  status: " << calibration_status_name(c.status)
       << " — " << c.note << "\n";

    // Historical reference: comparison only.
    os << "historical comparison reference: " << std::fixed << std::setprecision(2)
       << kHistoricalReferenceMedianUs << " us"
       << " (frozen record G7CAM-B7-E5-11933807)\n";
    os << "  NOTE: comparison datum only — NOT a pass/fail claim about this "
          "diagnostic's data, and not encoded in the process exit code.\n";

    os << "classification: " << classification_name(rep.classification) << "\n";
    os << "  rules: elevation is judged ONLY on replicate medians across ALL "
          "valid macro-replicates (one slow iteration never establishes "
          "reproducibility); INSUFFICIENT_REPLICATION when either condition has "
          "< " << kMinMacroReplicates << " valid replicates; REPRODUCIBLE_ELEVATION "
          "requires calibration PASS + every replicate elevated in BOTH conditions "
          "+ pooled medians elevated; NOT_ELEVATED when zero replicates are "
          "elevated; otherwise INCONCLUSIVE.\n";

    os << "cleanup: " << rep.cleanup_note << "\n";
    os << "limitations: sequential process-local macro-replicates (not "
          "independent machine/session replications); warm-cache, no cache "
          "control; no CPU affinity control and NO cache-state or "
          "CPU-affinity equivalence with the historical campaign is claimed; "
          "steady_clock (production clock).\n";
    return os.str();
}

// ---------------------------------------------------------------------------
// Paired-sample capture (output-only; added for one authorized evidence run).
// Captures the SAME (replicate, iteration) pairs used by calibrate(), using the
// EXACT same paired-overhead formula, and persists them BEFORE the run-owned
// blob/run dir are cleaned up and BEFORE any stdout report is rendered.
//
// Fields are stored RAW (seconds + signed pct), matching the calibration source
// of truth. No rounding is applied before writing; the file is a CSV with a
// header line. This source does NOT change which pairs are formed, the
// protocol, calibration, classification, thresholds, or exit codes.
//
// WRITE DISCIPLINE:
//   - Written to a unique, no-overwrite path under the SAME validated diagnostic
//     directory (build/bm_b7_diagnostic/), so it cannot collide with production
//     or historical evidence and cannot overwrite an existing file.
//   - Written ONLY when every replicate in BOTH conditions is valid (the same
//     pre-condition calibrate() requires for the worst-case statistic), so the
//     file is not produced for a partial/invalid run.
//   - Written BEFORE cleanup (so the blob/run dir still exist) and BEFORE main()
//     renders the stdout report.
//   - Failure to write is recorded in the report and printed on stderr; it does
//     NOT truncate/retry-overwrite anything and does NOT change exit codes.
// ---------------------------------------------------------------------------

struct PairedSample {
    uint32_t replicate = 0;
    uint32_t iteration = 0;
    double minimal_sec = 0.0;     // a in calibrate()
    double instrumented_sec = 0.0; // b in calibrate()
    double signed_overhead_pct = 0.0; // 100*(b-a)/a, exact formula from calibrate()
};

std::string make_paired_artifact_path(const std::string& run_dir) {
    // Unique, no-overwrite CSV under the validated diagnostic dir.
    if (!run_dir.empty() && run_dir.back() == '/') return run_dir + "paired_samples.csv";
    return run_dir + "/" + "paired_samples.csv";
}

// Returns OK / not-tried / failed-with-note. Never throws; never overwrites.
struct PairedArtifact {
    bool attempted = false;
    bool written = false;
    std::string path;        // empty until successfully opened for exclusive write
    std::string note;        // empty when written
    void write(const std::string& run_dir,
               const std::vector<ReplicateResult>& minimal,
               const std::vector<ReplicateResult>& instrumented) {
        if (attempted) return;
        attempted = true;
        if (minimal.size() != instrumented.size()) {
            note = "refused to write paired artifact: condition replicate counts differ " +
                   std::to_string(minimal.size()) + " vs " + std::to_string(instrumented.size());
            return;
        }
        // Mirror calibrate()'s validity pre-condition: write only when every
        // replicate in BOTH conditions is valid.
        for (const auto& r : minimal)
            if (!r.valid) {
                note = "refused to write paired artifact: a MINIMAL replicate is invalid";
                return;
            }
        for (const auto& r : instrumented)
            if (!r.valid) {
                note = "refused to write paired artifact: an INSTRUMENTED replicate is invalid";
                return;
            }
        const std::string path = make_paired_artifact_path(run_dir);
        const std::string perr = validate_diagnostic_path(path);
        if (!perr.empty()) {
            note = "refused to write paired artifact: isolation validation failed: " + perr;
            return;
        }
        const int fd = exclusive_create_file(path);
        if (fd < 0) {
            note = "cannot create paired artifact (exists or exclusive creation unsupported); nothing overwritten: " +
                   path;
            return;
        }
        // Write to the fd through a std::ostream for formatting; ownership of fd
        // is transferred to a small RAII closer so the file is closed on every
        // exit path. The closer uses a lambda deleter so the platform-specific
        // close call is selected with an ordinary runtime if/else (no #ifdef
        // inside a function body).
        FILE* f = nullptr;
#ifdef _WIN32
        f = _fdopen(fd, "wb");
#else
        f = fdopen(fd, "wb");
#endif
        if (!f) {
            this->path = path;
            this->note = "paired artifact fdopen failed; nothing overwritten: " + path;
            return;
        }
        auto close_f = [&]() {
            if (f) {
#ifdef _WIN32
                _close(_fileno(f));
#else
                fclose(f);
#endif
                f = nullptr;
            }
        };
        fprintf(f, "replicate,iteration,minimal_sec,instrumented_sec,signed_overhead_pct\n");
        for (size_t i = 0; i < minimal.size(); ++i) {
            const auto& a = minimal[i].total_samples_sec;
            const auto& b = instrumented[i].total_samples_sec;
            for (size_t j = 0; j < a.size(); ++j) {
                const double pct = 100.0 * (b[j] - a[j]) / a[j];
                fprintf(f, "%u,%zu,%#.9g,%#.9g,%#.9g\n",
                        minimal[i].index, j, a[j], b[j], pct);
            }
        }
        if (fflush(f) != 0) {
            close_f();
            this->path = path;
            this->note = "paired artifact fflush failed; nothing overwritten: " + path;
            return;
        }
#ifdef _WIN32
        int err = _commit(fd);
#else
        int err = fsync(fd);
#endif
        close_f();
        if (err == 0) {
            this->path = path;
            this->written = true;
            this->note.clear();
            return;
        }
        this->path = path;
        this->note = "paired artifact created but not confirmed durable on disk (flush/sync failed)";
    }
};

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
void abort_report(DiagnosticReport& rep, const std::string& why) {
    rep.completed = false;
    rep.abort_reason = why;
    rep.classification = Classification::INSUFFICIENT_REPLICATION;
}

// ---------------------------------------------------------------------------
// Paired-sample capture wiring (output-only; added for one authorized evidence
// run). Thin wrapper around PairedArtifact::write(); kept separate so the
// capture point in run_bm_b7_diagnostic stays readable.
// ---------------------------------------------------------------------------
void write_paired_artifact_if_valid(PairedArtifact& art,
                                    const std::string& run_dir,
                                    const std::vector<ReplicateResult>& minimal,
                                    const std::vector<ReplicateResult>& instrumented) {
    art.write(run_dir, minimal, instrumented);
}

DiagnosticReport run_bm_b7_diagnostic(const Protocol& proto,
                                      const DiagnosticPaths& paths) {
    DiagnosticReport rep;
    rep.protocol = proto;
    rep.blob_path = "(run-owned path assigned at exclusive creation)";

    const auto perrs = proto.validate();
    if (!perrs.empty()) {
        std::string why = "invalid protocol:";
        for (const auto& e : perrs) why += " " + e + ";";
        abort_report(rep, why);
        return rep;
    }
    const std::string derr = validate_diagnostic_dir(paths.directory);
    if (!derr.empty()) {
        abort_report(rep, "path isolation check failed: " + derr);
        return rep;
    }

    BlobCleanup cleanup;
    PairedArtifact paired;

    try {
        const RunOwnedBlob blob = create_run_owned_blob(paths);
        cleanup.owned = blob;
        if (!blob.ok()) {
            // FAIL CLOSED: a pre-existing blob or run directory is never
            // truncated, opened for writing, or reused.
            abort_report(rep, "run-owned storage could not be created "
                              "(nothing overwritten): " + blob.failure);
        } else {
            rep.blob_path = blob.blob_path;
            rep.blob_bytes = blob.blob_bytes;

            const auto schedule = build_schedule(proto.macro_replicates);
            for (const auto& entry : schedule) {
                const Mode first =
                    entry.minimal_first ? Mode::MINIMAL : Mode::INSTRUMENTED;
                const Mode second =
                    entry.minimal_first ? Mode::INSTRUMENTED : Mode::MINIMAL;
                rep.executed_order.push_back(
                    "replicate " + std::to_string(entry.replicate) + ": " +
                    mode_name(first) + " then " + mode_name(second));

                ReplicateResult a =
                    run_replicate(first, entry.replicate, blob.blob_path, proto);
                ReplicateResult b =
                    run_replicate(second, entry.replicate, blob.blob_path, proto);
                if (first == Mode::MINIMAL) {
                    rep.minimal.push_back(std::move(a));
                    rep.instrumented.push_back(std::move(b));
                } else {
                    rep.instrumented.push_back(std::move(a));
                    rep.minimal.push_back(std::move(b));
                }
            }

            // Paired-sample capture: write AFTER all pairing data exists and
            // BEFORE cleanup + stdout rendering. Uses the same (replicate,
            // iteration) pairs and the same formula as calibrate().
            write_paired_artifact_if_valid(paired, blob.run_dir, rep.minimal,
                                            rep.instrumented);

            rep.calibration = calibrate(rep.minimal, rep.instrumented,
                                        proto.macro_replicates);
            rep.classification = classify(rep.calibration, rep.minimal,
                                          rep.instrumented,
                                          proto.macro_replicates,
                                          kHistoricalReferenceMedianUs);
            rep.completed = true;  // completed != successful: see classification
        }
    } catch (const std::exception& ex) {
        abort_report(rep, std::string("unhandled failure during run: ") + ex.what());
    } catch (...) {
        abort_report(rep, "unhandled non-std exception during run");
    }

    cleanup.perform();
    rep.cleanup_note = cleanup.note;
    return rep;
}

}  // namespace b7diag
}  // namespace stark_p1

// ---------------------------------------------------------------------------
// Entry point (for a SEPARATELY authorized future build; not built here).
// Exit codes — deliberately independent of the historical reference:
//   0 = run completed with sufficient replication (classification is reported
//       in the report, whatever it is — INCONCLUSIVE / NOT_ELEVATED /
//       REPRODUCIBLE_ELEVATION are findings, not process failures)
//   2 = invalid arguments, or the run aborted before producing evidence
//   3 = completed but INSUFFICIENT_REPLICATION (incomplete evidence is never
//       reported as success)
// The exit code never encodes a pass/fail verdict against 5721.90 us.
// ---------------------------------------------------------------------------
int main(int argc, char** argv) {
    using stark_p1::b7diag::DiagnosticPaths;
    using stark_p1::b7diag::DiagnosticReport;
    using stark_p1::b7diag::Protocol;
    using stark_p1::b7diag::Classification;
    using stark_p1::b7diag::render_report;
    using stark_p1::b7diag::run_bm_b7_diagnostic;

    DiagnosticPaths paths;
    if (argc == 2) {
        paths.directory = argv[1];
    } else if (argc != 1) {
        std::cerr << "usage: " << argv[0] << " [diagnostic-directory]\n"
                  << "  default directory: build/bm_b7_diagnostic/ "
                     "(diagnostic-owned; isolation is validated at run time)\n";
        return 2;
    }

    const DiagnosticReport rep = run_bm_b7_diagnostic(Protocol{}, paths);
    std::cout << render_report(rep);

    // The paired-sample artifact (if produced) is the authoritative persistent
    // record; its presence/absence is confirmed by the filesystem under the
    // validated diagnostic directory. This does not change exit-code semantics.
    if (!rep.completed) return 2;
    if (rep.classification == Classification::INSUFFICIENT_REPLICATION) return 3;
    return 0;
}
