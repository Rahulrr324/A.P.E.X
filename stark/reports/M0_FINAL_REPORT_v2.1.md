# APEX M0 — v2.1 G4 Hardware-Capability Audit, Missing-Gate Evidence & G7 Root-Cause — Final Report

**Date:** 2026-10-05
**Repository:** `stark/` (STARK-006)
**Supersedes:** `M0_FINAL_REPORT_v2.0.md` (preserved unchanged)
**Scope:** M0 investigation and correction only. No M1 work, no APEX features, no threshold or acceptance-criteria changes.

---

## 0. Headline

| Area | Outcome |
|---|---|
| Physical host GPU | **VERIFIED GPU-CAPABLE** (NVIDIA GeForce RTX 2050) |
| G4 physical-capability classification | **CORRECTED** — cuda_available=false no longer read as CPU-only |
| **G4 (corrected)** | **FAIL** (was PASS in v2.0) |
| G1 | **PASS** over the v2.1 candidate evidence set (genuine PROFILE) |
| G2 | **PASS** |
| G3 | **PASS** over the v2.1 candidate evidence set (genuine SKIPPED receipts) |
| G5 / G6 | **PASS** |
| G7 | **FAIL** (genuine, reproducible; unchanged) |
| Historical completeness | **UNRESOLVED** (24 observed / 9 recovered / 15 missing) |
| Build / tests | **PASS** — fresh Debug + Release, 6/6 CTest each, 0 failures |
| **M0 overall** | **FAIL** |
| M1 | **LOCKED** |

> The v2.0 G4 PASS is **withdrawn**. The host is a GPU-capable machine; the recovered records carry no physical-GPU evidence and no measured VRAM, so G4 fails.

---

## 1. Evidence taxonomy (read this first)

Every claim below is tagged:

- **[V] Verified fact** — re-derived from files/binaries in this project, or reproduced by a command in this report.
- **[H] Host observation** — read from the OS device inventory on the current machine.
- **[E] Historical evidence** — from the recovered nine records / preserved reports.
- **[N] New measurement** — produced in v2.1 into a separate directory.
- **[I] Inference** — a supported conclusion, not a direct measurement.
- **[U] Unresolved limitation**.

---

## 2. G4 hardware-capability audit — CORRECTED to FAIL

### 2.1 The defect [V]

`device_capability()` in `src/phase1/gates.cpp` classified a record as **CPU-only whenever `cuda_available == false`**. But the recovered records' provenance says CUDA was unavailable because the binary was built without CUDA (`STARK_ENABLE_CUDA=OFF`). **CUDA build/runtime availability is not physical GPU absence.** A CUDA-disabled build on a GPU host was therefore mis-classified as CPU-only, which let the records bypass the measured-VRAM requirement and produced the v2.0 G4 PASS.

### 2.2 Physical hardware [H][V]

**OS device inventory** (`Get-CimInstance Win32_VideoController`):
- Intel(R) UHD Graphics — driver 32.0.101.5542
- **NVIDIA GeForce RTX 2050 — AdapterRAM 4,293,918,720 B (~4.0 GiB), driver 32.0.16.1714**

**Production profiler** (new, `[N]`): the generated PROFILE record
`archive_recovery/v21_evidence/P1-PROFILE-24-0.json` reports
`hardware.gpu_present = true` with provenance
`source: EnumDisplayDevices display-adapter enumeration | adapters: … | NVIDIA GeForce RTX 2050`.

Two independent sources agree: **the host is GPU-capable.** The spec itself names this target (HP Victus, i5-12450H, RTX 2050 4 GB). **[V]**

### 2.3 The minimal source change [V]

The smallest correct change is to separate **physical presence** from the **CUDA build flag**:

| File | Change |
|---|---|
| `src/phase1/common/HardwareProfiler.h` | add `std::optional<bool> gpu_present` (tri-state: true / false / unknown) |
| `src/phase1/common/HardwareProfiler.cpp` | populate it from `EnumDisplayDevices` (real vs basic/remote adapters); serialize/parse; non-Windows ⇒ unknown + reason |
| `src/phase1/gates.cpp` | `device_capability()`: GPU if `gpu_present==true` **or** `cuda_available==true` **or** an authoritative GPU field; **CPU only if `gpu_present==false`**; else Unknown |
| `src/phase1/baselines/run_baseline.cpp` | E2/B4/B5 SKIPPED reason made build-scoped and precise (no CPU-only inference) |
| `tests/test_phase1_gates.cpp` | helper + 6 capability regression blocks (328 → 340 assertions) |
| `fixtures/make_controlled_fixtures.py`, `fixtures/make_v21_capability_fixtures.py` | fixtures declare capability explicitly; new capability fixtures |

No frozen threshold, grouping key, or historical record changed. The added field is **additive**. **[V]**

### 2.4 Regression coverage [V]

Added cases (all pass): physical GPU present + CUDA build disabled → G4 FAIL; physical GPU present + CUDA enabled + VRAM measured → G4 PASS; confirmed CPU-only → G4 PASS (CPU workload under the frozen rule); unknown capability (`cuda_available=false` alone, or malformed `gpu_present`) → G4 FAIL; GPU workload with unavailable VRAM → G4 FAIL.

End-to-end fixtures:

| Fixture | records | G4 | overall |
|---|---|---|---|
| `fixtures/v21/controlled-gpu-cuda-off` | 7 | **FAIL** | exit 1 |
| `fixtures/v21/controlled-gpu-vram-measured` | 7 | PASS | **exit 0** |
| `fixtures/v21/controlled-unknown-capability` | 7 | **FAIL** | exit 1 |

### 2.5 Corrected G4 verdict [V]

Over the **unchanged nine recovered records** (`archive_recovery/aggregator_input/`):

```
[FAIL] G4 peak memory measured
       E5: hardware GPU capability unknown (no gpu_present device-inventory evidence
       and no authoritative GPU field); refusing to classify as CPU-only
```

**G4 = FAIL.** This is a *correction*, not a broadening: the classification was wrong, and with it corrected the records cannot satisfy the measured-memory requirement on a GPU-capable host.

### 2.6 Backward-compatibility limitation [U]

Records that predate `gpu_present` have no physical-capability evidence. They are now classified **Unknown** and fail G4 closed. There is no way to retroactively derive physical presence for such a record, so it can neither regain a CPU-only classification nor satisfy the measured-VRAM requirement. This is intentional (fail closed) and is the honest handling of the frozen rule.

Detailed audit: `reports/v2.1/g4_hardware_capability_audit.json`.

---

## 3. G1 and G3 — genuine evidence produced

New evidence was written to a **separate directory** (`archive_recovery/v21_evidence/`); the nine recovered records were not touched. **[V]**

### 3.1 G1 — PROFILE [N]
```
./build-v18-debug/profiler_cli.exe --out ../archive_recovery/v21_evidence
profile record: P1-PROFILE-24-0 status=PASSED   (exit 0)
```
Result: `[PASS] G1 hardware profile collected — cpu=12th Gen Intel(R) Core(TM) i5-12450H, ram_total=25392844800`.

### 3.2 G3 — SKIPPED receipts [N]
```
./build-v18-debug/run_baseline.exe --baseline E2 --out ../archive_recovery/v21_evidence
```
Produced `P1-E2-skip.json`, `P1-B4-skip.json`, `P1-B5-skip.json`, each with the precise reason:

> `skipped: CUDA unavailable in this build (STARK_ENABLE_CUDA=OFF / no CUDA toolkit); this does NOT imply the machine has no GPU -- physical GPU presence is recorded independently in hardware.gpu_present`

Result: `[PASS] G3 GPU branch complete-or-skipped with reason`.

### 3.3 Status
- **G1 = PASS** over the v2.1 candidate evidence set (the recovered nine alone still have no PROFILE → G1 FAIL there).
- **G3 = PASS** over the v2.1 candidate evidence set (the recovered nine alone still have no E2/B4/B5 → G3 FAIL there).
- No record was fabricated; the GPU branch legitimately cannot run because **this build has no CUDA** — which the frozen G3 rule permits via SKIPPED receipts.

Detail: `reports/v2.1/missing_gate_evidence.md`.

---

## 4. G7 root-cause — FAIL retained

**G7 remains FAIL** (B6 16.13%; B7 18.38%/21.26%; B9 27.65%/28.18%/48.04% vs 15%). Thresholds, grouping key, samples, and records are unchanged. **[E][V]**

### 4.1 Per-record statistics [E]
All nine records: n=10, warmup=3, Debug build, `thread_count=0`. Stored medians **equal** independently recomputed medians (9/9). Intra-run coefficient of variation ranges **5.8%–27.1%** (e.g. E1-B9-24899 CV 27.11%; min 944.6 µs, max 2204.4 µs). Full table: `reports/v2.1-aggregator/g7_stats_raw.txt`.

### 4.2 Fresh controlled repeats [N]
Six fresh E1 + six fresh E5 runs (Release binary, same machine, same config) in `archive_recovery/v21_diagnostics/`:

| Group | runs | median spread | pairs > 15% |
|---|---|---|---|
| B6 | 12 | **59.06%** | 35/66 |
| B7 | 12 | **19.03%** | 5/66 |
| B9 | 12 | **59.78%** | 19/66 |

Fresh, uncontaminated repeats **also fail G7**. The historical failure is a property of the **methodology**, not of the recovered files. Output: `reports/v2.1-aggregator/g7_fresh_repeats.txt`.

### 4.3 Root cause [I]
With CV ≈ c and n samples, the median's sampling error is ≈ `0.396·c`; for c=15% that is ≈5.9%, so a ±15% gate between two runs is only ≈1.8σ and is exceeded routinely. Contributing duty-cycle factors: scheduler/timer jitter on 200 µs–1 ms operations, no CPU affinity or power pinning (`thread_count=0`), warm-up of only 3 iterations, turbo/thermal drift, and a ~23 s separation between the two historical batches. It is **not** a grouping error and **not** corrupted data. Detail: `reports/v2.1/g7_root_cause_analysis.md`.

### 4.4 Consequence for the frozen rule [I][U]
Under the frozen ±15% rule at n=10, the existing historical set **permanently fails**; no reanalysis can repair it. Remediation exists only for **future** measurements (raise `measurement_count` well above 10, longer warm-up, CPU affinity, fixed power plan, batched timing). Loosening the tolerance is **explicitly rejected**.

---

## 5. Historical completeness — wording corrected

| Quantity | Value | Status |
|---|---|---|
| Records observed in the original archive | **24** | reviewer-supplied external observation |
| Records currently recovered here | **9** | verified against the recovery manifest |
| Records missing from the current set | **15** | **unresolved; not recovered, not validated, not used** |

The nine-record set is **not** claimed complete. The 15 missing records were not fabricated or inferred. The source-archive digest is preserved as previously recorded (`cb5e85e8…`) and remains **manifest-asserted only** (no independent re-hash). No search for, request of, or extraction of the external archive was performed. **[U]**

---

## 6. Build, test and aggregator evidence

Fresh from-scratch builds (source changed in v2.1): **[V]**

| | Debug (`build-v21-debug`) | Release (`build-v21-release`) |
|---|---|---|
| configure / build exit | 0 / 0 | 0 / 0 |
| targets | 103/103 | 103/103 |
| CTest | **6/6** (exit 0) | **6/6** (exit 0) |
| `test_phase1_gates` | **340 assertions, 0 failures** | **340 assertions, 0 failures** |

Aggregator matrix: **17 inputs × Debug/Release × normal/strict = 68 runs**, **byte-identical Debug/Release**, **0 crashes** (`reports/v2.1-aggregator/matrix.txt`). The fresh v2.1 binaries reproduce the `build-v18-*` output byte-for-byte.

**Legacy test coverage caveat [V]:** CTest registers **only the six Phase-1 suites**. Nine other test executables (`test_neuron`, `test_params`, `test_synapse`, `test_integration`, `test_network`, `test_stdp`, `test_homeostasis`, `test_three_factor`, `test_serialization`) build and exit 0 when run directly, but are **not** exercised by `ctest`. The Phase-1 CTest result must not be read as full project test coverage. Detail: `reports/v2.1/build_test_matrix.md`.

---

## 7. Explicit outcomes

| Item | Outcome |
|---|---|
| G1 (v2.1 candidate set) | **PASS** |
| G1 (nine recovered only) | **FAIL** |
| G2 | **PASS** |
| G3 (v2.1 candidate set) | **PASS** |
| G3 (nine recovered only) | **FAIL** |
| **G4** | **FAIL** (corrected from v2.0 PASS) |
| G5 | **PASS** |
| G6 | **PASS** |
| G7 | **FAIL** |
| Historical completeness | **BLOCKED / UNRESOLVED** |
| Build & Phase-1 tests | **PASS** |
| Legacy test CTest coverage | **NOT APPLICABLE** (not registered) |

---

## 8. Deliverables (v2.1)

- `reports/M0_FINAL_REPORT_v2.1.md` (this report)
- `reports/v2.1/g4_hardware_capability_audit.json`
- `reports/v2.1/g7_root_cause_analysis.md`
- `reports/v2.1/missing_gate_evidence.md`
- `reports/v2.1/build_test_matrix.md`
- `reports/v2.1/evidence_manifest.json`
- `reports/sha256sums_v21.txt` (106 entries)
- `reports/v2.1-aggregator/` (matrix + logs + G7 statistics)
- `archive_recovery/v21_evidence/` (G1/G3 new evidence), `archive_recovery/v21_diagnostics/` (fresh G7 repeats)
- `fixtures/v21/` (3 capability fixtures)

### Source files changed
`src/phase1/gates.cpp`, `src/phase1/common/HardwareProfiler.h`, `src/phase1/common/HardwareProfiler.cpp`, `src/phase1/baselines/run_baseline.cpp`, `tests/test_phase1_gates.cpp`, `fixtures/make_controlled_fixtures.py`, `fixtures/make_v21_capability_fixtures.py` (new). `CMakeLists.txt` **unchanged**.

---

## 9. Final decision

```
M0 = FAIL
M1 = LOCKED
```

Rationale: **G4 is invalid** (corrected to FAIL), **G7 remains failed** (genuine, reproducible), and **G1/G3 evidence is incomplete** for the historical nine-record set (it exists only over the separate v2.1 candidate set). Historical completeness is unresolved. No measurement or threshold was changed to manufacture a pass. Per the final decision rule, M0 stays **FAIL** and **M1 remains LOCKED**.
