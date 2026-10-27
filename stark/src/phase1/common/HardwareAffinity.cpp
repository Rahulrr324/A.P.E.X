#include "common/HardwareAffinity.h"

#include <algorithm>
#include <string>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#else
#include <errno.h>
#include <sched.h>
#include <stdlib.h>
#include <string.h>   // strerror() used by affinity_reason_from_errno()
#include <unistd.h>
#endif

namespace stark_p1 {

std::string affinity_reason_from_errno(int err) {
    const char* msg = "unknown OS error";
#ifdef _WIN32
    (void)err;
    msg = "Windows affinity API failed";
#else
    if (err == 0) return "";
    msg = strerror(err);
#endif
    return msg;
}

#ifdef _WIN32
AffinityInfo affinity_query_windows() {
    AffinityInfo info;
    DWORD_PTR processMask = 0;
    DWORD_PTR systemMask = 0;
    if (!GetProcessAffinityMask(GetCurrentProcess(), &processMask, &systemMask)) {
        info.supported = true;
        info.reason = "failed: GetProcessAffinityMask returned false";
        return info;
    }
    info.supported = true;
    info.query_ok = true;
    info.raw_process_mask = static_cast<uint64_t>(processMask);
    info.raw_system_mask = static_cast<uint64_t>(systemMask);
    for (uint32_t i = 0; i < sizeof(processMask) * 8; ++i) {
        if (processMask & (DWORD_PTR(1) << i)) {
            info.effective.push_back(i);
        }
    }
    return info;
}

AffinityInfo affinity_set_windows(uint32_t cpu_index) {
    AffinityInfo info;
    info.requested_cpu = cpu_index;
    DWORD_PTR processMask = 0;
    DWORD_PTR systemMask = 0;
    if (!GetProcessAffinityMask(GetCurrentProcess(), &processMask, &systemMask)) {
        info.supported = true;
        info.reason = "failed: GetProcessAffinityMask returned false (during set)";
        return info;
    }
    info.raw_process_mask = static_cast<uint64_t>(processMask);
    info.raw_system_mask = static_cast<uint64_t>(systemMask);
    if (cpu_index >= sizeof(systemMask) * 8) {
        info.supported = true;
        info.reason = "failed: requested cpu_index exceeds system affinity width";
        return info;
    }
    DWORD_PTR newMask = DWORD_PTR(1) << cpu_index;
    if (newMask & systemMask) {
        // Capture the raw API return value and GetLastError immediately after
        // the set call, then re-read the raw masks so the evidence shows the
        // actual post-set OS state regardless of the outcome.
        SetLastError(0);
        BOOL set_ret = SetProcessAffinityMask(GetCurrentProcess(), newMask);
        DWORD set_err = GetLastError();
        info.set_api_return = set_ret ? 1 : 0;
        info.set_api_last_error = static_cast<uint32_t>(set_err);
        {
            DWORD_PTR pm2 = 0, sm2 = 0;
            if (GetProcessAffinityMask(GetCurrentProcess(), &pm2, &sm2)) {
                info.raw_process_mask = static_cast<uint64_t>(pm2);
                info.raw_system_mask = static_cast<uint64_t>(sm2);
            }
        }
        if (set_ret) {
            info.supported = true;
            info.set_ok = true;
            info.effective.push_back(cpu_index);
            return info;
        } else {
            info.supported = true;
            info.reason = "failed: SetProcessAffinityMask returned false";
            return info;
        }
    } else {
        info.supported = true;
        info.reason = "failed: requested cpu is not in system affinity mask";
        return info;
    }
}
#else
AffinityInfo affinity_query_posix() {
    AffinityInfo info;
    long ncpus = sysconf(_SC_NPROCESSORS_CONF);
    if (ncpus <= 0) {
        info.supported = false;
        info.reason = "unavailable: sysconf(_SC_NPROCESSORS_CONF) <= 0";
        return info;
    }
    cpu_set_t* set = nullptr;
    int err = 0;
    for (size_t size = CPU_SETSIZE; ; size *= 2) {
        set = reinterpret_cast<cpu_set_t*>(malloc(size));
        if (!set) {
            info.supported = true;
            info.reason = "failed: cannot allocate cpu_set_t";
            return info;
        }
        CPU_ZERO_S(size, set);
        err = sched_getaffinity(0, size, set);
        if (err == 0) break;
        free(set);
        set = nullptr;
        if (err != EINVAL) {
            info.supported = true;
            info.reason = "failed: sched_getaffinity returned " + std::to_string(err);
            return info;
        }
    }
    info.supported = true;
    info.query_ok = true;
    size_t size = CPU_SETSIZE;
    for (size_t i = 0; i < (size_t)ncpus && i < size; ++i) {
        if (CPU_ISSET_S(i, size, set)) {
            info.effective.push_back(static_cast<uint32_t>(i));
        }
    }
    free(set);
    return info;
}

AffinityInfo affinity_set_posix(uint32_t cpu_index) {
    AffinityInfo info;
    long ncpus = sysconf(_SC_NPROCESSORS_CONF);
    if (ncpus <= 0) {
        info.supported = false;
        info.reason = "unavailable: sysconf(_SC_NPROCESSORS_CONF) <= 0 (during set)";
        return info;
    }
    cpu_set_t* set = nullptr;
    int err = 0;
    for (size_t size = CPU_SETSIZE; ; size *= 2) {
        set = reinterpret_cast<cpu_set_t*>(malloc(size));
        if (!set) {
            info.supported = true;
            info.reason = "failed: cannot allocate cpu_set_t";
            return info;
        }
        CPU_ZERO_S(size, set);
        err = sched_getaffinity(0, size, set);
        if (err == 0) break;
        free(set);
        set = nullptr;
        if (err != EINVAL) {
            info.supported = true;
            info.reason = "failed: sched_getaffinity returned " + std::to_string(err);
            return info;
        }
    }
    size_t size = CPU_SETSIZE;
    if (cpu_index >= (size_t)ncpus || cpu_index >= size) {
        free(set);
        info.supported = true;
        info.reason = "failed: requested cpu_index not present in affinity set";
        return info;
    }
    if (!CPU_ISSET_S(cpu_index, size, set)) {
        free(set);
        info.supported = true;
        info.reason = "failed: requested cpu is not in current effective affinity";
        return info;
    }
    CPU_ZERO_S(size, set);
    CPU_SET_S(cpu_index, size, set);
    err = sched_setaffinity(0, size, set);
    free(set);
    if (err != 0) {
        info.supported = true;
        info.reason = "failed: sched_setaffinity returned " + std::to_string(err);
        return info;
    }
    info.supported = true;
    info.set_ok = true;
    info.effective.push_back(cpu_index);
    return info;
}
#endif

AffinityInfo HardwareAffinity::query() {
#ifdef _WIN32
    return affinity_query_windows();
#else
    return affinity_query_posix();
#endif
}

AffinityInfo HardwareAffinity::requestSingleCpu(uint32_t cpu_index) {
#ifdef _WIN32
    return affinity_set_windows(cpu_index);
#else
    return affinity_set_posix(cpu_index);
#endif
}

AffinityInfo HardwareAffinity::requestAndVerifyFirstCpu() {
    AffinityInfo q = query();
    if (!q.supported || q.effective.empty()) {
        return q;
    }
    AffinityInfo s = requestSingleCpu(q.effective.front());
    if (s.set_ok) {
        AffinityInfo v = query();
        if (v.query_ok && v.effective.size() == 1 && v.effective.front() == q.effective.front()) {
            s.effective = v.effective;
            s.query_ok = v.query_ok;
            s.raw_process_mask = v.raw_process_mask;
            s.raw_system_mask = v.raw_system_mask;
            s.verified_single_cpu = true;
            return s;
        }
        s.effective = v.effective;
        s.query_ok = v.query_ok;
        s.raw_process_mask = v.raw_process_mask;
        s.raw_system_mask = v.raw_system_mask;
        s.reason = "failed: requested single cpu but effective affinity differs after set";
        return s;
    }
    return s;
}

JsonValue HardwareAffinity::effectiveMaskJson(const AffinityInfo& info) {
    JsonValue o = JsonValue::object();
    o.set("supported", JsonValue::boolean(info.supported));
    o.set("query_ok", JsonValue::boolean(info.query_ok));
    o.set("set_ok", JsonValue::boolean(info.set_ok));
    JsonValue arr = JsonValue::array();
    for (uint32_t i : info.effective) {
        arr.append(JsonValue::uinteger(i));
    }
    o.set("effective_logical_cpus", std::move(arr));
    o.set("reason", info.reason.empty() ? JsonValue::null() : JsonValue::str(info.reason));
    return o;
}

} // namespace stark_p1
