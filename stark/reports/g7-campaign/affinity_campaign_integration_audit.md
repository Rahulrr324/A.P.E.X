# G7 — Affinity Campaign Integration Audit

## Purpose

Document the integration of the verified `HardwareAffinity` control into the **actual G7 campaign / harness provenance path**, and record what was verified about placement, provenance honesty, serialization compatibility, regression coverage, and remaining limitations.

This audit is about **integration of the instrumentation into the provenance path**, not about rerunning or resolving the G7 campaign. No new G7 campaign evidence was produced and the frozen 30 records were not touched.

## Status (unchanged)

- G7: **FAIL — UNCHANGED**
- M0: **FAIL — UNCHANGED**
- M1: **LOCKED**
- Frozen 30 G7 records: **UNCHANGED** (sha256-verified against `reports/g7-campaign/evidence_manifest.json`)

## 1. Exact integration point

Path traced end-to-end:

```
G7Campaign::main
  → run_b*_campaign(...)               // per-benchmark campaign helper
      → BenchResult harness_result;
      → harness_result.config = bench;            // policy config (thread_count=1, etc.)
      → apply_campaign_affinity(harness_result);  // <-- affinity established HERE
      → bench_tiny_inference(bench, model)        // timed benchmark work begins AFTERWARDS
         (or run_benchmark(...) for B7/B9)
      → result.optional_affinity_provenance =
             harness_result.optional_affinity_provenance;   // carry verified result
      → make_benchmark_record(...)                // assemble ExperimentRecord
          → rec.provenance["affinity"] =
                 result.affinity_provenance_json();        // structured provenance block
      → store.append(rec);                        // write <record_id>.json
```

The smallest integration point is therefore:

- **call site**: `src/phase1/bench/BenchmarkHarness.cpp` — `apply_campaign_affinity(BenchResult&)`
- **carrier**: `BenchResult::optional_affinity_provenance` (`std::optional<AffinityProvenance>`)
- **serialization**: `ExperimentRecord::provenance["affinity"]` (optional structured object)

The campaign helpers in `src/phase1/campaign/G7Campaign.cpp` do not call OS affinity APIs directly. They delegate to `apply_campaign_affinity()`, which delegates to the verified `HardwareAffinity` implementation (`HardwareAffinity::query()` + `requestAndVerifyFirstCpu()`).

## 2. Timing/placement relative to benchmark execution

Affinity is established **before** any timed benchmark work begins:

1. `harness_result.config` is set.
2. `apply_campaign_affinity(harness_result)` runs. This:
   - queries the effective affinity (`HardwareAffinity::query()`),
   - if supported and queryable and non-empty, attempts the intended single-CPU restriction (`requestAndVerifyFirstCpu()`), which itself sets then re-queries,
   - stores the honest result into `harness_result.optional_affinity_provenance`.
3. Only **after** step 2 does the benchmark begin: `bench_tiny_inference()` / `run_benchmark()` / the B9 timed op.
4. The timed op is unchanged; the timed region itself is not modified.
5. Affinity setup cost is outside the measured samples: it happens before `run_benchmark`'s warmup loop, so it is not included in any warmup or measurement sample.

Placement constraint check:

- **Before timed execution?** Yes.
- **Before worker/thread creation?** The G7 campaign benchmarks (B6/B7/B9) are single-threaded: `TinyDenseModel(1)` and a single `model.forward()` / single deserialization op. There are no worker threads created by the benchmark to inherit affinity. Therefore the question of worker inheritance does not arise for the current benchmark architecture; affinity is process-level and is established before the single timed thread runs.
- **Without changing the timed region?** Yes.
- **Without introducing affinity setup cost into measured samples?** Yes.

If the benchmark architecture were to create worker threads whose affinity must be independently controlled, that would be a separate constraint; for the current B6/B7/B9 implementation it is not required.

## 3. Worker threads / inheritance

For the current G7 campaign benchmarks:

- B6: single-threaded forward on `TinyDenseModel(1)`.
- B7: single-threaded weight load/deserialize.
- B9: single-threaded forward with a stability loop (200 repeats in-process).

No benchmark spawns worker threads. Affinity is therefore applied at the process level before the single timed execution thread runs. There are no additional worker threads whose affinity would need separate enforcement.

This is a **property of the current benchmark implementation**, not a general guarantee. The audit records it explicitly rather than claiming a general inheritance guarantee.

## 4. Exact provenance fields

### 4.1 Struct (in memory)

`AffinityProvenance` (`src/phase1/bench/BenchmarkHarness.h`):

- `supported` (bool) — whether the platform supports affinity control at all
- `query_ok` (bool) — whether the effective-affinity query succeeded
- `set_ok` (bool) — whether the single-CPU set request succeeded
- `effective_logical_cpus` (`std::vector<uint32_t>`) — effective logical CPU mask queried after the attempt
- `reason` (string) — empty when OK; `"unavailable: ..."` / `"failed: ..."` otherwise

### 4.2 JSON shape (in the record)

`rec.provenance["affinity"]` is an object with exactly:

- `"supported": true/false`
- `"query_ok": true/false`
- `"set_ok": true/false`
- `"effective_logical_cpus": [ ... ]`
- `"reason": null` or `"..."`

This is produced by `BenchResult::affinity_provenance_json()` and is isomorphic to `HardwareAffinity::effectiveMaskJson(...)`.

### 4.3 Honesty rules enforced

- A record **never** asserts single-thread pinning unless the effective affinity was successfully verified as a single logical CPU.
- `thread_count=1` is recorded separately in `configuration.thread_count` and is a **policy field**, not an OS affinity guarantee. It is **not** interchangeable with affinity verification.
- If affinity cannot be established or verified, the record states that explicitly via `reason` and the relevant `_*_ok` flags, and proceeds without a false claim.
- On the current host, the dry-run records show the honest outcome: the set call succeeded (`set_ok: true`) but the post-set query still returned more than one logical CPU, so verification failed and the record carries
  ```
  "reason": "failed: requested single cpu but effective affinity differs after set"
  ```
  with `effective_logical_cpus` reflecting the actual queried mask. No "pinned" claim is emitted.

## 5. Compatibility impact

### 5.1 Serialization / deserialization

- The affinity block is an **optional** entry in `ExperimentRecord.provenance`.
- `ExperimentRecord::parse` loads **all** `provenance` entries generically; records without `"affinity"` parse unchanged.
- `ExperimentRecord::has(key)` / `::get(key)` accessors (added to support provenance access) operate on the provenance map only.
- The `STARKP1 1` schema version is unchanged.

### 5.2 Frozen historical records

- The frozen 30 records in `build/g7-campaign/` were **not** modified.
- Integrity check performed: all 30 record files match their sha256 in `evidence_manifest.json` (0 mismatches).
- These records remain parseable by the existing loader; they simply lack the optional `"affinity"` key.

### 5.3 Gate compatibility

- The M0 gates (`src/phase1/gates.cpp`, G1–G7) do **not** read `provenance["affinity"]`.
- Affinity provenance does not affect G7 grouping, median comparison, tolerance, or acceptance logic.
- `test_phase1_gates` passes at **437 assertions**, confirming gate behavior is unchanged.

## 6. Tests performed

### 6.1 Build (existing release baseline)

- Built from `build-v24-release` (Release, existing baseline).
- Targets built: `stark_phase1`, `test_phase1_affinity`, `test_phase1_records`, `test_phase1_gates`, `g7_campaign`.
- Build result: **success**.

### 6.2 Affinity regression tests

- `test_phase1_affinity`: **PASS**, 44 assertions, 0 failures.
- Verifies: query honesty, structured provenance shape, request-and-verify behavior, no "pinned" wording emitted.

### 6.3 Records tests

- `test_phase1_records`: **PASS**, 72 assertions, 0 failures.
- Verifies: full record round-trip, **additive affinity provenance round-trips cleanly and stays optional**, no false "pinned" claim in a record that carries affinity, schema mismatch rejection, failed/skipped record validity, malformed JSON rejection, store append/load, statistics.

### 6.4 Gates tests

- `test_phase1_gates`: **PASS**, 437 assertions, 0 failures.
- Verifies: G2/G4/G7 mechanics, deserialization-boundary paths, aggregator strict-mode contract, structured skip attestation, physical GPU classification, and fail-closed on undecodable evidence. Affinity is not part of gate logic.

### 6.5 Controlled dry invocation (integration inspection only)

- Invoked `g7_campaign.exe --runs 3 --samples 10 --warmup 3 --out build/g7-dry`.
- This is a **non-record-producing-for-G7** inspection run into an isolated directory (`build/g7-dry`). It does **not** modify `build/g7-campaign/` or the frozen 30 records.
- Result: 18 records written (3 runs × 6 benchmarks), all with `provenance["affinity"]` present.
- Verified across all 18 dry-run records:
  - `supported: true`
  - `query_ok: true`
  - `set_ok: true`
  - `effective_logical_cpus: [0]`
  - `reason: "failed: requested single cpu but effective affinity differs after set"`
  - `thread_count: 1` present separately in configuration
  - **no** "pinned" claim in any record

This confirms the full chain on this host: **requested → applied (set call succeeded) → queried → effective mask (multi-CPU) → provenance records the honest result**.

### 6.6 CTest / Debug-binary note

The required tests were run using the existing **release** binaries in `build-v24-release/` directly. This release tree builds only the Release configuration (`CMAKE_BUILD_TYPE=Release`); there is no matching Debug binary tree available in this workspace for the same source state. If CTest-based execution of `test_phase1_affinity` / `test_phase1_records` / `test_phase1_gates` is desired in a Debug configuration, a separate Debug build tree must first be configured and built; the existing CTest configuration in `build-v24-release` references the Release binaries. This limitation is reported explicitly rather than worked around by swapping build types.

## 7. What changed (minimum necessary)

- `src/phase1/common/HardwareAffinity.h` — moved `AffinityInfo` definition before the functions that return it (compile-order correctness); otherwise unchanged in API.
- `src/phase1/bench/BenchmarkHarness.h` — added `#include "common/HardwareAffinity.h"` so the harness translation unit sees `AffinityInfo` (the header already referenced `HardwareAffinity` in comments but did not include it).
- `src/phase1/common/ExperimentRecord.h` — added `has(key)` / `get(key)` provenance accessors (additive; operate on the provenance map only).
- `src/phase1/common/ExperimentRecord.cpp` — defined the new accessors.
- `stark/reports/g7-campaign/affinity_campaign_integration_audit.md` — this file.

No changes to: frozen 30 records, thresholds, symmetric-relative-difference formula, grouping semantics, median definition, benchmark definitions B6/B7/B9, timed-region semantics, sample count, warmup count, gate logic, acceptance logic, historical records, or M0 acceptance status.

## 8. Remaining limitations

1. **Platform dependence.** Affinity control depends on the OS APIs available in the build. On unsupported or restricted environments, only query or honest failure reporting is possible.
2. **Set can succeed while verification fails.** As observed on this host, the OS may accept a single-CPU set call yet still report a multi-CPU effective mask afterward. The implementation correctly treats that as unverified and reports it honestly. This is a host/OS behavior, not a bug in the instrumentation.
3. **Affinity is not a complete reproducibility fix.** Even with verified affinity, reproducibility also depends on frequency scaling, thermal drift, scheduler behavior, timer granularity, and other environmental factors not controlled by affinity alone. This is consistent with the prior root-cause classification as an environment reproducibility limitation.
4. **Worker-thread affinity is not a general guarantee.** The current G7 benchmarks are single-threaded, so process-level affinity before the timed thread is sufficient. If a future benchmark spawns workers, per-worker affinity would need separate handling.
5. **No G7 rerun performed.** G7 status remains FAIL — UNCHANGED. This integration does not constitute a new G7 campaign and does not re-evaluate G7 against the frozen tolerance.
6. **Debug-build CTest path.** The verification used existing Release binaries; a Debug CTest run requires a separate Debug build tree (see §6.6).

## 9. Files referenced

- `src/phase1/common/HardwareAffinity.h`
- `src/phase1/common/HardwareAffinity.cpp`
- `src/phase1/bench/BenchmarkHarness.h`
- `src/phase1/bench/BenchmarkHarness.cpp`
- `src/phase1/campaign/G7Campaign.cpp`
- `src/phase1/common/ExperimentRecord.h`
- `src/phase1/common/ExperimentRecord.cpp`
- `src/phase1/gates.cpp`
- `tests/test_phase1_affinity.cpp`
- `tests/test_phase1_records.cpp`
- `tests/test_phase1_gates.cpp`
- `build/g7-campaign/` (frozen 30 records — not modified; sha256-verified)
- `reports/g7-campaign/evidence_manifest.json`
- `reports/g7-campaign/affinity_patch_result.md` (prior patch-level audit; superseded in specifics by this integration audit where the on-disk behavior differs)
- `reports/sha256sums_g7_campaign.txt`
- `build/g7-dry/` (controlled dry-run output — inspection only, not G7 evidence)
