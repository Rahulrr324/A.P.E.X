/**
 * STARK Phase 1 (M0): affinity instrumentation regression tests.
 *
 * Verifies that the minimal affinity instrumentation behaves honestly:
 *   - queryable where supported
 *   - request-and-verify reports applied only when effective affinity is confirmed
 *   - unsupported/failed cases are reported as such, never as pinned
 *   - provenance serialization is well-formed
 *
 * These tests do NOT touch the frozen 30-record G7 campaign.
 */

#include <algorithm>
#include <string>

#ifdef _WIN32
#include <windows.h>
#endif

#include "test_harness.h"
#include "common/HardwareAffinity.h"

using namespace stark_p1;

int main() {
    test::set_test_name("test_phase1_affinity");

    // --- query support and honesty ---
    AffinityInfo q = HardwareAffinity::query();
    JsonValue jq = HardwareAffinity::effectiveMaskJson(q);

    CHECK(jq.isObject());
    CHECK_MSG(jq.has("supported"), "affinity json has supported");
    CHECK_MSG(jq.has("query_ok"), "affinity json has query_ok");
    CHECK_MSG(jq.has("effective_logical_cpus"), "affinity json has effective_logical_cpus");
    CHECK_MSG(jq.has("reason"), "affinity json has reason");

    bool supported = q.supported;
    CHECK(supported == jq.get("supported").asBool());

    if (supported) {
        CHECK(q.query_ok);
        CHECK(jq.get("query_ok").asBool());
        const JsonValue& arr = jq.get("effective_logical_cpus");
        CHECK(arr.isArray());
        size_t n = arr.items().size();
        CHECK(n >= 1);
        CHECK(q.effective.size() == n);
        for (size_t i = 0; i < n; ++i) {
            CHECK(arr.items()[i].asUInt() == q.effective[i]);
        }

        // Also round-trip effectiveMaskJson through the same code path used by
        // BenchResult::affinity_provenance_json().
        JsonValue j2 = HardwareAffinity::effectiveMaskJson(q);
        CHECK(j2.get("effective_logical_cpus").items().size() == n);
    } else {
        const JsonValue& r = jq.get("reason");
        CHECK(r.isNull() == false);
        CHECK(r.type() == JsonValue::Type::String);
        CHECK(!r.asString().empty());
    }

    // --- request-and-verify honesty ---
    AffinityInfo rv = HardwareAffinity::requestAndVerifyFirstCpu();
    JsonValue jrv = HardwareAffinity::effectiveMaskJson(rv);

    CHECK(jrv.isObject());
    CHECK_MSG(jrv.has("set_ok"), "request_and_verify json has set_ok");

    if (supported) {
        CHECK(rv.set_ok || !rv.reason.empty());

        if (rv.set_ok) {
            // Truthful representation invariant:
            // If the set call succeeded but verified single-CPU affinity was NOT
            // confirmed, effective must equal the ACTUAL post-set queried mask,
            // not the requested/assumed mask. Do not assert size==1 here: on this
            // host the post-set mask can legitimately remain multi-CPU (e.g. an
            // SMT/affinity-group sibling), and claiming size==1 would misrepresent
            // the actual OS state.
            if (rv.reason.find("effective affinity differs after set") != std::string::npos) {
                // Verification failed: effective must be the real post-set query.
                AffinityInfo post = HardwareAffinity::query();
                CHECK(post.query_ok);
                CHECK(post.effective == rv.effective);
                // And it must NOT be a single requested CPU (that is exactly what
                // failed). This is host-dependent and is NOT a patch failure.
                CHECK_MSG(rv.effective.size() != 1 || rv.effective.front() != q.effective.front(),
                          "on this host post-set mask differs from requested single CPU");
            } else {
                // Set succeeded AND verified: effective is the confirmed single CPU.
                CHECK(rv.effective.size() == 1);
                CHECK(q.effective.front() == rv.effective.front());
            }
            const JsonValue& arr = jrv.get("effective_logical_cpus");
            CHECK(arr.isArray());
            CHECK(arr.items().size() == rv.effective.size());
            for (size_t i = 0; i < rv.effective.size(); ++i) {
                CHECK(arr.items()[i].asUInt() == rv.effective[i]);
            }
        } else {
            CHECK(!jrv.get("set_ok").asBool());
            const JsonValue& r = jrv.get("reason");
            CHECK(r.isNull() == false);
            CHECK(r.type() == JsonValue::Type::String);
            CHECK(!r.asString().empty());
        }
    } else {
        CHECK(!rv.set_ok);
        CHECK(rv.reason == q.reason);
    }

    // --- failure-path effective-mask invariant (explicit) ---
    // When set_ok==true but verification fails, the returned effective must be the
    // actual post-set queried mask, and the failure reason must remain present.
    if (supported && rv.set_ok && !rv.reason.empty() &&
        rv.reason.find("effective affinity differs after set") != std::string::npos) {
        AffinityInfo post = HardwareAffinity::query();
        CHECK(post.query_ok);
        CHECK(rv.effective == post.effective);              // truthful: real post-set mask
        CHECK(rv.effective.size() >= 1);
        std::string jtxt2 = jrv.dump();
        CHECK(jtxt2.find("pinned") == std::string::npos); // no false pinning claim
    }

    // --- no false 'pinned' claim anywhere ---
    std::string jtxt = jq.dump();
    CHECK(jtxt.find("pinned") == std::string::npos);

    // --- deterministic mask-enumeration regression (64-bit shift correctness) ---
    // Regression for the bug where affinity_query_windows() enumerated a 64-bit
    // DWORD_PTR mask using a 32-bit shift (1u << i), which is UB for i>=32 and
    // fabricates spurious high-bit CPUs (e.g. bit0 -> CPU32).
    {
        // Helper: enumerate a DWORD_PTR mask the way the production path does,
        // using a 64-bit shift, so we can assert expected CPU lists directly.
        auto enumerateDWordPtr = [](DWORD_PTR mask) -> std::vector<uint32_t> {
            std::vector<uint32_t> cpus;
            for (uint32_t i = 0; i < sizeof(DWORD_PTR) * 8; ++i) {
                if (mask & (DWORD_PTR(1) << i)) {
                    cpus.push_back(i);
                }
            }
            return cpus;
        };

        // Case A: single-bit mask 0x1
        {
            DWORD_PTR mask = DWORD_PTR(1);
            auto cpus = enumerateDWordPtr(mask);
            CHECK(cpus.size() == 1);
            CHECK(cpus[0] == 0);
            // CPU 32 must NOT be fabricated.
            CHECK(std::find(cpus.begin(), cpus.end(), 32) == cpus.end());
        }

        // Case B: multi-bit mask 0xFFF (CPUs 0..11)
        {
            DWORD_PTR mask = DWORD_PTR(0xFFF);
            auto cpus = enumerateDWordPtr(mask);
            CHECK(cpus.size() == 12);
            for (uint32_t i = 0; i < 12; ++i) {
                CHECK(cpus[i] == i);
            }
            // CPU 32 must NOT be fabricated.
            CHECK(std::find(cpus.begin(), cpus.end(), 32) == cpus.end());

            // Negative control: a mask with bit 32 set should be enumerated
            // correctly (bit32 -> CPU32, nothing else fabricated).
            {
                DWORD_PTR mask2 = DWORD_PTR(1) << 32;
                auto cpus2 = enumerateDWordPtr(mask2);
                CHECK(cpus2.size() == 1);
                CHECK(cpus2[0] == 32);
            }
        }

        // Case C: real production path agrees with the helper for the current
        // process mask (must not fabricate CPUs >=32 when only low bits are set).
        {
            AffinityInfo q = HardwareAffinity::query();
            CHECK(q.query_ok);
            // Re-enumerate the raw process mask via GetProcessAffinityMask using
            // the 64-bit-shift helper and confirm the production path agrees.
            DWORD_PTR rawProc = 0, rawSys = 0;
            BOOL got = GetProcessAffinityMask(GetCurrentProcess(), &rawProc, &rawSys);
            CHECK(got);
            auto expected = enumerateDWordPtr(rawProc);
            CHECK(expected == q.effective);
            // If only low bits are set, there must be no CPU >= 32.
            if (rawProc < (DWORD_PTR(1) << 32)) {
                for (uint32_t c : q.effective) {
                    CHECK(c < 32);
                }
            }
        }
    }

    std::printf("test_phase1_affinity: %d assertions, %d failures\n",
                test::assertions, test::failures);
    return test::report();
}
