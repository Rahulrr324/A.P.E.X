/** Production-affinity evidence capture (post-fix).
 *
 * Exercises the actual production path:
 *   HardwareAffinity::query()
 *   HardwareAffinity::requestSingleCpu(0)
 *   HardwareAffinity::requestAndVerifyFirstCpu()
 *
 * Captures the raw values the benchmark would record. This is the real
 * production path, not a standalone API probe.
 */
#include <cstdio>
#include <cstdint>
#include <vector>
#include <string>

#include <windows.h>

#include "common/HardwareAffinity.h"

using namespace stark_p1;

static std::string last_error_str() {
    DWORD e = GetLastError();
    if (e == 0) return "NO_ERROR";
    char buf[256];
    FormatMessageA(FORMAT_MESSAGE_FROM_SYSTEM, NULL, e, 0, buf, (DWORD)sizeof(buf), NULL);
    return std::string(buf);
}

int main() {
    printf("=== PRODUCTION AFFINITY EVIDENCE (post-fix) ===\n\n");

    // 1. Baseline query before any set
    {
        AffinityInfo q = HardwareAffinity::query();
        printf("[1] Baseline query (production path):\n");
        printf("    supported   = %s\n", q.supported ? "true" : "false");
        printf("    query_ok    = %s\n", q.query_ok ? "true" : "false");
        printf("    effective   = [");
        for (size_t i = 0; i < q.effective.size(); ++i) {
            if (i) printf(", ");
            printf("%u", q.effective[i]);
        }
        printf("]\n");
        printf("    reason      = %s\n", q.reason.empty() ? "(none)" : q.reason.c_str());
    }

    // 2. Request CPU0 and read back via production path
    {
        printf("\n[2] requestSingleCpu(0) (production path):\n");
        AffinityInfo s = HardwareAffinity::requestSingleCpu(0);
        printf("    set_ok      = %s\n", s.set_ok ? "true" : "false");
        printf("    effective   = [");
        for (size_t i = 0; i < s.effective.size(); ++i) {
            if (i) printf(", ");
            printf("%u", s.effective[i]);
        }
        printf("]\n");
        printf("    reason      = %s\n", s.reason.empty() ? "(none)" : s.reason.c_str());
    }

    // 3. Full requestAndVerifyFirstCpu (the path the benchmark uses)
    {
        printf("\n[3] requestAndVerifyFirstCpu() (production path — what M0 uses):\n");
        AffinityInfo v = HardwareAffinity::requestAndVerifyFirstCpu();
        printf("    set_ok      = %s\n", v.set_ok ? "true" : "false");
        printf("    query_ok    = %s\n", v.query_ok ? "true" : "false");
        printf("    effective   = [");
        for (size_t i = 0; i < v.effective.size(); ++i) {
            if (i) printf(", ");
            printf("%u", v.effective[i]);
        }
        printf("]\n");
        printf("    reason      = %s\n", v.reason.empty() ? "(none)" : v.reason.c_str());

        // Verification result
        bool verified = v.set_ok && v.query_ok &&
                        v.effective.size() == 1 &&
                        v.effective.front() == 0;
        printf("\n    verification_result = %s\n",
               verified ? "true (single-CPU affinity to CPU0 confirmed)" : "false");
    }

    // 4. Direct raw mask readback (showing the fix is in effect)
    {
        printf("\n[4] Raw API cycle: SetProcessAffinityMask -> GetProcessAffinityMask:\n");
        // Raw set to CPU0 with the exact return value the production path gates on.
        SetLastError(0);
        BOOL set_ret = SetProcessAffinityMask(GetCurrentProcess(), DWORD_PTR(1));
        DWORD set_err = GetLastError();
        printf("    SetProcessAffinityMask(0x1) return = %d (%s)\n",
               (int)set_ret, set_ret ? "SUCCESS" : "FAILURE");
        printf("    GetLastError after set            = 0x%08x\n", (unsigned)set_err);
        printf("    requested CPU = 0\n");

        SetLastError(0);
        DWORD_PTR proc = 0, sys = 0;
        BOOL ok = GetProcessAffinityMask(GetCurrentProcess(), &proc, &sys);
        DWORD q_err = GetLastError();
        printf("    GetProcessAffinityMask returned = %d\n", (int)ok);
        printf("    GetLastError after query        = 0x%08x (%s)\n",
               (unsigned)q_err, last_error_str().c_str());

        // Enumerate using the FIXED 64-bit shift (matching production code)
        printf("    process mask = 0x%016llx\n", (unsigned long long)proc);
        printf("    system mask  = 0x%016llx\n", (unsigned long long)sys);
        printf("    effective CPUs (1ULL<<i enumeration): [");
        bool first = true;
        for (uint32_t i = 0; i < 64; ++i) {
            if (proc & (DWORD_PTR(1) << i)) {
                if (!first) printf(", ");
                printf("%u", i);
                first = false;
            }
        }
        if (first) printf("(none)");
        printf("]\n");

        // Confirm no fabricated CPU 32
        bool has32 = proc & (DWORD_PTR(1) << 32);
        printf("    CPU 32 fabricated? = %s\n", has32 ? "YES (BUG)" : "NO (correct)");

        // Final verification via the production path
        AffinityInfo v = HardwareAffinity::requestAndVerifyFirstCpu();
        bool verified = v.set_ok && v.query_ok &&
                        v.effective.size() == 1 && v.effective.front() == 0;
        printf("    single-CPU verification (production) = %s\n",
               verified ? "true" : "false");
    }

    printf("\n=== END ===\n");
    return 0;
}
