#pragma once

/**
 * STARK Phase 1 (M0): minimal CPU affinity instrumentation.
 *
 * Provides a small, platform-aware query/set helper so benchmark provenance can
 * represent affinity honestly:
 *   - requested affinity
 *   - whether the request was attempted/applied
 *   - the effective process affinity mask
 *   - unsupported / failed with reason
 *
 * This is instrumentation/control only. It does not change benchmark timing,
 * statistics, G7 formula, or gate logic.
 *
 * Ground rule (V009 §A): do not fabricate. If affinity cannot be queried or set
 * on a platform, report supported=false with a reason.
 */

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "common/ExperimentRecord.h"

namespace stark_p1 {

struct AffinityInfo {
    bool supported = false;
    bool query_ok = false;
    bool set_ok = false;
    std::vector<uint32_t> effective;
    std::string reason;

    // Raw OS API evidence captured along the production path (instrumentation
    // only; never fabricated). A field stays nullopt when the platform cannot
    // provide it (e.g. Windows-specific fields on POSIX).
    std::optional<uint32_t> requested_cpu;        // CPU passed to requestSingleCpu()
    std::optional<int64_t> set_api_return;        // raw return of the OS set-affinity call
    std::optional<uint32_t> set_api_last_error;   // GetLastError() immediately after the set (Windows)
    std::optional<uint64_t> raw_process_mask;     // raw process affinity mask last observed (Windows)
    std::optional<uint64_t> raw_system_mask;      // raw system affinity mask last observed (Windows)
    bool verified_single_cpu = false;             // requestAndVerifyFirstCpu() predicate result
};

std::string affinity_reason_from_errno(int err);

#ifdef _WIN32
AffinityInfo affinity_query_windows();
AffinityInfo affinity_set_windows(uint32_t cpu_index);
#else
AffinityInfo affinity_query_posix();
AffinityInfo affinity_set_posix(uint32_t cpu_index);
#endif

class HardwareAffinity {
public:
    static AffinityInfo query();
    static AffinityInfo requestSingleCpu(uint32_t cpu_index);
    static AffinityInfo requestAndVerifyFirstCpu();
    static JsonValue effectiveMaskJson(const AffinityInfo& info);
};

} // namespace stark_p1
