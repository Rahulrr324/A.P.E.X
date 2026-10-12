# STARK Phase 1 (M0) — Final Report v2.3

**Date:** 2026-10-05
**Scope:** Correct the two concrete weaknesses established by the v2.2 audit:
1. G3 accepted arbitrary `SKIPPED` / `NOT_ATTEMPTED` records whenever CUDA was
   unavailable (any non-empty `status_reason` passed).
2. Physical GPU detection via `EnumDisplayDevicesA` over-counted adapters and
   could accept virtual display adapters as real hardware.

**Decision: M0 = FAIL (BLOCKED). M1 = LOCKED.**
No M0 acceptance is manufactured. G4 and G7 remain FAIL on the frozen rule set.

> This report is a new v2.3 artifact. All v2.0 / v2.1 / v2.2 evidence and reports
> are preserved unchanged; the nine recovered historical records, the G7
> threshold and the G7 grouping rule are untouched.

---

## 1. What changed (exact source files)

| File | Change |
|---|---|
| `src/phase1/common/ExperimentRecord.h` | New optional field `JsonValue skip_attestation;` on `ExperimentRecord` (v2.3 structured skip attestation). |
| `src/phase1/common/ExperimentRecord.cpp` | Serialize/parse `skip_attestation` (absent in older records → null, still valid); `validate()` now rejects a non-object, non-null `skip_attestation`. |
| `src/phase1/gates.h` | Documented rev 1.5 G3 semantics; new test seam `evaluate_gates_with_cuda(records, cuda_available)`. |
| `src/phase1/gates.cpp` | New `validate_no_cuda_skip()`; G3 no-CUDA branch now requires a structured attestation; `evaluate_gates()` now delegates to the seam with the real CUDA probe. |
| `src/phase1/common/HardwareProfiler.h` | New `DisplayAdapterInfo` / `GpuPresenceResult`; new public `classifyDisplayAdapters()`. |
| `src/phase1/common/HardwareProfiler.cpp` | `collectPhysicalGpuPresence()` now gathers the raw inventory and defers to `classifyDisplayAdapters()` (dedupe + real-vs-virtual classification); new pure classifier. |
| `src/phase1/baselines/run_baseline.cpp` | E2/B4/B5 skip path now emits `skip_attestation` (single `cudaRuntimeAvailable()` probe per run). |
| `tests/test_phase1_gates.cpp` | +77 assertions: 12 G3 cases (both branches) and 11 GPU-detection cases. |
| `CMakeLists.txt` | **UNCHANGED** (hash `cf8c7ad6…`, identical to v2.0/v2.1/v2.2). |
| `fixtures/make_v23_skip_attestation.py` | New fixture updater: adds the v2.3 attestation to the controlled fixtures' skip records (does not touch `fixtures/v21/*` or the recovered nine). |

Source SHA-256 (new):

```
34f52ce981f59bc666e1294c82b6774577862a5bf4e7551c7ed5a565938fe4a7  src/phase1/gates.cpp
f3fd459f12ba1f526204479184c59443291d76ace60401c558de27d6f370d323  src/phase1/gates.h
c732f16d4c827f75606f19ac3ade957cb7663a7aa39620116643197180d1a9b1  src/phase1/common/ExperimentRecord.h
7a068d693d03cc426c180c8ab174b83d6c8c19c08c6611f060b025e19b9e6fdc  src/phase1/common/ExperimentRecord.cpp
2f7972a81f36a44cec3e93424a2683c7e42feef9540bb2d2ae9326cf6d754023  src/phase1/common/HardwareProfiler.h
e20fa39aabcf1563599cb47994175de96bcceac537c3e6f07d27c056eaedc61a  src/phase1/common/HardwareProfiler.cpp
5f7701e5b7aebc4ba1ca21e4e14479441d8a78531ca83993730c26cb209d87ef  src/phase1/baselines/run_baseline.cpp
a5fc9e66f2781b618e8e0eb24ce16959f0bdd5e5d0f4633812b76e42ac97b0c7  tests/test_phase1_gates.cpp
```

---

## 2. G3: old vs new semantics

**Frozen spec G3** (`design/V009_phase1_M0_specification.md`): *"If CUDA exists:
GPU baselines (E2 + B4/B5) produce complete records; if no CUDA: records exist
with `status: skipped` + reason. Either branch passes; missing-GPU must not fail
the suite."*

The frozen text is the outer contract; the *representation of "reason"* is an
implementation choice, and the v2.2 audit proved the old choice (any non-empty
string) was near-vacuous. v2.3 tightens the representation without changing the
frozen branch structure or thresholds.

| | v2.2 (old) | v2.3 (new) |
|---|---|---|
| No-CUDA branch requirement | record exists, status ∈ {SKIPPED, NOT_ATTEMPTED}, `status_reason` non-empty | record exists, status ∈ {SKIPPED, NOT_ATTEMPTED}, `status_reason` non-empty **AND** a valid structured `skip_attestation` object |
| Arbitrary reason `"x"` | **PASS** | **FAIL** |
| `"lorem ipsum"` | **PASS** | **FAIL** |
| Contradictory `cuda_available=true` | **PASS** | **FAIL** |
| Missing provenance | n/a (no provenance existed) | **FAIL** |
| CUDA-present branch | E2/B4/B5 must be PASSED | **unchanged** (still PASSED-only; SKIPPED cannot satisfy it) |
| Missing E2/B4/B5 | FAIL | FAIL |

### Valid skip-evidence format (v2.3)

A no-CUDA skip is accepted only when `skip_attestation` is an object containing:

```json
{
  "schema": "STARKP1 skip-attestation 1",
  "reason_code": "cuda_unavailable",
  "capability_state": "cuda_unavailable",
  "execution_availability": "not_available",
  "capability_source": "cudaGetDeviceCount (HardwareProfiler::cudaRuntimeAvailable)",
  "producer": "stark_p1::run_baseline (E2/B4/B5 GPU branch skip path)",
  "cuda_available": false
}
```

`reason_code`, `capability_state`, `execution_availability` must equal the exact
recognized values above; `capability_source` and `producer` must be non-empty;
`cuda_available` must be a boolean `false`. The record's own
`hardware.cuda_available` must not be `true`.

### Invalid skip examples (all FAIL closed)

- no `skip_attestation` at all (free text alone) — the v2.1/v2.2 candidate and the
  nine recovered records;
- `reason_code` not `cuda_unavailable` (e.g. `"because_i_said_so"`);
- `capability_state` = `cuda_available`;
- empty `capability_source` / `producer`;
- `cuda_available` missing, non-boolean, or `true`;
- `hardware.cuda_available == true` alongside a skip;
- `skip_attestation` not an object (also a malformed record under `validate()`).

### CUDA-present branch (unchanged, strict)

Verified by the deterministic seam `evaluate_gates_with_cuda()` (test-only; no CUDA
runtime is faked):
- skipped E2/B4/B5 → **FAIL** (`E2 missing or not PASSED (CUDA available)`);
- all three PASSED → **PASS** (`CUDA present: E2/B4/B5 records required PASSED`).

### Host observation (GPU present, CUDA unavailable)

`gpu_present = true`, `cuda_available = false`. G3 follows the frozen skipped
branch (structured skip accepted); the record is **not** downgraded to a CPU-only
classification and G3 does not fail merely because a GPU is physically present.

---

## 3. Physical GPU detection (v2.3)

Old behaviour: the raw `EnumDisplayDevicesA` list was treated as the adapter set;
substring filtering only removed `Microsoft Basic` / `Remote` / `Basic Render`.
On this host that produced **5 raw entries** (Intel ×4 + NVIDIA ×1) — an over-count
— and Parsec/SpaceDesk-style virtual adapters were accepted as real.

New behaviour (`classifyDisplayAdapters()`, pure/deterministic):
1. **Dedupe** by stable identity (PNP `DeviceID`, else friendly name).
2. **Exclude** known virtual/remote/basic adapters and software-enumerated
   devices (`ROOT\`, `Basic Display`, `Remote`, `Parsec`, `SpaceDesk`, `IddSample`,
   `Citrix`, `Meta Virtual`, `USB Display`, `DisplayLink`, …).
3. **Confirm physical** only via a PCI device id (`PCI\` device path) or a known
   GPU vendor name (NVIDIA/GeForce/RTX/GTX/Quadro, AMD/Radeon, Intel UHD/Iris/Arc).
4. Anything left → **Unknown (`nullopt`)**, never `false`. Only a fully
   virtual/basic inventory yields `false` (confirmed non-GPU).

Host result after the fix:

```
gpu_present = true
provenance: ... | physical: Intel(R) UHD Graphics | NVIDIA GeForce RTX 2050 |
            raw_entries: 5 | unique_adapters: 2
```

**Honest limitation:** `EnumDisplayDevices` is not a hardware-database API. The
classification is best-effort: an unrecognized vendor with a PCI id is accepted
(physical evidence), and an adapter with neither a PCI id nor a known vendor is
reported as Unknown rather than guessed. This cannot guarantee perfect detection,
and it deliberately errs toward Unknown (fail closed) instead of CPU-only.

CUDA build/runtime availability stays independent of `gpu_present` throughout.

---

## 4. Backward compatibility

- `skip_attestation` is optional in the JSON. All historical records parse
  unchanged; the nine recovered records still load with **0 invalid records**.
- Records that predate v2.3 (no attestation) **fail closed at G3** — they are not
  retroactively trusted as valid skip evidence. This is intentional and disclosed.
- No historical record, raw sample, G7 threshold, G7 grouping rule, or prior
  report was modified.

---

## 5. Fresh build & test results

Fresh builds `build-v23-debug/` and `build-v23-release/` (WinLibs GCC 16.1.0,
C++17, EXTENSIONS=OFF, CMake 4.4.1 / Ninja):

| Config | Configure | Build | Warnings | Errors | Edges | NDEBUG |
|---|---|---|---|---|---|---|
| Debug | exit 0 | exit 0 | 0 | 0 | 96/96 | 0 |
| Release | exit 0 | exit 0 | 0 | 0 | 96/96 | 103 |

CTest (6 registered Phase-1 suites), both configs: **6/6 passed, exit 0.**

Assertion counts (identical Debug/Release):

| Suite | Assertions |
|---|---|
| test_phase1_profiler | 35 |
| test_phase1_accounting | 67 |
| test_phase1_budget | 55 |
| test_phase1_records | 54 |
| test_phase1_reproducibility | 37 |
| test_phase1_gates | **417** (was 340; +77) |

Debug/Release aggregator logs are **byte-identical** on every v2.3 evidence set.

---

## 6. Gate results (v2.3)

### G3 — fixed

| Evidence set | G3 | Detail |
|---|---|---|
| nine recovered (`aggregator_input`) | **FAIL** | `E2 record missing entirely (must record skipped status)` |
| v2.1 candidate (`v21_evidence`, no attestation) | **FAIL** | `E2 skipped without structured skip attestation …` |
| v2.3 valid candidate (fresh, attested) | **PASS** | `B5: SKIPPED (cuda_unavailable) — …` |
| v23-attested | **PASS** | structured skip accepted |
| v23-fabricated (`"x"`/`"because"`/`"lorem ipsum"`) | **FAIL** | `E2 skipped without structured skip attestation …` |
| v23-contradictory (`cuda_available=true`) | **FAIL** | `E2 skip attestation contradicts itself: cuda_available=true on a no-CUDA skip` |
| v23-missing-e2 | **FAIL** | `E2 record missing entirely …` |
| v23-malformed (non-object attestation) | **FAIL** | record invalid + `E2 record missing entirely …` |
| CUDA-present seam, skipped E2/B4/B5 | **FAIL** | `E2 missing or not PASSED (CUDA available)` |
| CUDA-present seam, all PASSED | **PASS** | `CUDA present: E2/B4/B5 records required PASSED` |

### G4 — still FAIL

Re-run after the GPU-detection change. G4 is unchanged by design (the frozen
interpretation requires *measured* VRAM on GPU-capable hardware).

| Evidence | G4 | Detail |
|---|---|---|
| nine recovered | **FAIL** | `E5: hardware GPU capability unknown …; refusing to classify as CPU-only` |
| v2.3 valid candidate | **FAIL** | `E5: GPU-capable hardware but vram_measured is false` |
| `fixtures/v21/controlled-gpu-cuda-off` | **FAIL** | `E5: GPU-capable hardware but vram_measured is false` |
| `fixtures/v21/controlled-gpu-vram-measured` | **PASS** | measured VRAM present |
| `fixtures/v21/controlled-unknown-capability` | **FAIL** | `hardware GPU capability unknown …` |

Improved physical-GPU detection does **not** make G4 pass: the recovered records
carry no measured VRAM. The frozen spec G4 line literally requires measured
RAM/VRAM and flags estimated peaks; the "GPU-capable ⇒ measured VRAM" rule is the
stricter fail-closed interpretation retained from v2.1.

### G7 — still FAIL (unchanged, not rebaselined)

Historical config groups reproduce v2.2 exactly:

```
B6 medians differ 16.13% (allowed 15.00%) between runs 1 and 3
B7 medians differ 18.38% / 21.26% (allowed 15.00%)
B9 medians differ 27.65% / 28.18% / 48.04% (allowed 15.00%)
```

No G7 threshold, grouping rule, or sample was touched.

---

## 7. Remaining M0 blockers

1. **G4 FAIL** — the nine recovered baseline records have no *measured* VRAM and
   no `gpu_present` device-inventory evidence; under the frozen rule set G4 cannot
   pass without measured VRAM evidence on GPU-capable hardware (or a recorded
   CPU-only classification).
2. **G7 FAIL** — the historical raw samples genuinely violate the frozen ±15%
   same-config median tolerance; the historical set fails permanently under the
   frozen rule. This is a real, unfixed measurement-reproducibility gap.
3. **G3** — now correct and fail-closed, but the nine recovered records carry no
   structured attestation, so G3 also FAILs on the recovered set (the recovered
   nine never contained E2/B4/B5 skip records).

M0 remains **FAIL/BLOCKED**. M1 remains **LOCKED**.

---

## 8. Evidence classification

- **Historical recovered records:** `../archive_recovery/aggregator_input/` and
  `original_historical_records/` (frozen; never modified).
- **New candidate records:** `reports/v2.3/evidence/v23-valid/` (fresh, produced by
  the v2.3 binaries; carries the structured attestation).
- **Deterministic fixtures:** `reports/v2.3/evidence/v23-{attested,fabricated,
  contradictory,missing-e2,malformed}/`, `fixtures/controlled-*/`,
  `fixtures/v21/controlled-*`.
- **Host observations:** `gpu_present=true`, `cuda_available=false`, raw 5 → 2
  unique adapters on the HP Victus i5-12450H / RTX 2050 host.

See `reports/v2.3/{g3_integrity_audit.md, gpu_detection_audit.md, test_matrix.md,
evidence_manifest.json}` and `reports/sha256sums_v23.txt`.