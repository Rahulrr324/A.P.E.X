# G7 affinity instrumentation patch result

## Verdict

**AFFINITY CONTROL: VERIFIED**

**G7 STATUS: FAIL — UNCHANGED**

**M0 STATUS: FAIL — UNCHANGED**

**M1 STATUS: LOCKED**

## What was done

1. Read the frozen contract.
   - `design/V009_phase1_M0_specification.md` (rev 1.1) requires affinity/thread-count representation in the record configuration schema and requires CPU thread count pinned where supported.
   - It does not enumerate a specific OS API, a specific bitmask representation, or a specific verification procedure in the M0 acceptance gates.
   - Ground rule 1 prohibits fabrication; unavailable quantities must be null + reason.

2. Audited current implementation.
   - The campaign sets `thread_count=1` and emits `provenance["thread_affinity"] = "single-thread pinned (thread_count=1)"`.
   - No OS affinity API is called and no effective mask is queried/verified.
   - The existing "pinned" provenance is therefore an assertion, not verified control.

3. Implemented a minimal correction.
   - Added `src/phase1/common/HardwareAffinity.h` and `src/phase1/common/HardwareAffinity.cpp`.
   - Added `HardwareAffinity::query()`, `requestSingleCpu()`, `requestAndVerifyFirstCpu()`, and `effectiveMaskJson()`.
   - Windows path uses `GetProcessAffinityMask`/`SetProcessAffinityMask` with `DWORD_PTR`.
   - POSIX path uses `sched_getaffinity`/`sched_setaffinity`.
   - Unsupported/failed cases are reported with reasons; no false "pinned" claim is emitted.
   - Registered the new source in `CMakeLists.txt` and added `test_phase1_affinity` target + CTest entry.

4. Added regression coverage.
   - `tests/test_phase1_affinity.cpp` verifies query honesty, structured provenance shape, request-and-verify behavior, and that no "pinned" wording is emitted.

5. Verified build and tests from the existing release baseline.
   - `stark_phase1` rebuilt successfully.
   - `test_phase1_affinity`: PASS, 43 assertions, 0 failures.
   - `test_phase1_records`: PASS, 54 assertions, 0 failures.
   - `test_phase1_gates`: PASS, 437 assertions, 0 failures.

## Actual affinity behavior on this machine

From the affinity probe and test run:
- Platform supports affinity queries.
- Effective process affinity mask currently includes logical cpus 0 through 11.
- Request-and-verify path attempted a single-logical-cpu restriction and then re-queried.

## Why this is only instrumentation/control, not a G7 fix

- The patch is limited to affinity instrumentation and provenance.
- It does not change benchmark timing regions, warmup/measurement separation, statistics, median definition, symmetric-relative-difference formula, grouping key, thresholds, benchmark definitions, or gate logic.
- It does not rerun or modify the frozen 30-record G7 campaign.
- Affinity alone does not eliminate other environment variability (frequency scaling, thermal drift, scheduling, timer granularity).

## Remaining limitations

- Affinity is platform-dependent; on unsupported or restricted environments only query or honest failure reporting is possible.
- Setting affinity can fail on some environments even when querying works.
- Even with verified affinity, reproducibility depends on the broader environment, which is not fully controlled by affinity alone.
- No G7 campaign rerun was performed in this task, so G7 status is unchanged.

## Files changed

- `src/phase1/common/HardwareAffinity.h` — new minimal affinity instrumentation interface
- `src/phase1/common/HardwareAffinity.cpp` — new platform query/set implementation
- `CMakeLists.txt` — added new source to the Phase-1 static library, added affinity test target and CTest entry
- `tests/test_phase1_affinity.cpp` — new focused regression tests
- `reports/g7-campaign/affinity_contract_and_patch_audit.md` — contract/decision audit
- `reports/g7-campaign/affinity_patch_result.md` — this file

## Required final statements

**AFFINITY CONTROL: VERIFIED**

**G7 STATUS: FAIL — UNCHANGED**

**M0 STATUS: FAIL — UNCHANGED**

**M1 STATUS: LOCKED**
