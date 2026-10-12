# APEX M0 v2.1 — Missing-Gate Evidence (G1 / G3) and Historical Completeness Wording

**Date:** 2026-10-05
**Scope:** Produce genuine G1/G3 evidence into a separate directory; correct the historical-completeness statement. The nine recovered historical records were not modified.

---

## 1. G1 — hardware profile collected

### 1.1 What G1 requires (frozen spec)
`HardwareProfiler::collectStatic()` returns a complete profile; cpu_model, OS, RAM total, storage non-null; every null field carries a provenance reason. The aggregator locates an `experiment_id = "PROFILE"` record, which must be `PASSED` and whose embedded hardware snapshot must survive `StaticHardwareProfile::validate()`.

### 1.2 What was produced
Command (from `stark/`):

```
./build-v18-debug/profiler_cli.exe --out ../archive_recovery/v21_evidence
```

Result:

```
profile record: P1-PROFILE-24-0 status=PASSED
telemetry record: P1-TELEMETRY-24-1
exit code: 0
```

The generated record is a genuine measurement of the current host (nothing fabricated), written to a **separate v2.1 directory** (`archive_recovery/v21_evidence/`), never into the nine-record recovery directory.

### 1.3 Independent physical-GPU verification recorded in that PROFILE
The PROFILE record's embedded hardware snapshot now carries the new field:

- `hardware.gpu_present = true`
- `hardware.provenance.gpu_present = "source: EnumDisplayDevices display-adapter enumeration | adapters: Intel(R) UHD Graphics | … | NVIDIA GeForce RTX 2050"`
- `hardware.cuda_available = false` (build fact: no CUDA toolkit)

This independently matches the OS device inventory (`Get-CimInstance Win32_VideoController` → "NVIDIA GeForce RTX 2050"). See `reports/v2.1/g4_hardware_capability_audit.json`.

### 1.4 G1 outcome
Over the v2.1 candidate evidence set (`archive_recovery/v21_evidence/`, 14 records):

```
[PASS] G1 hardware profile collected
       cpu=12th Gen Intel(R) Core(TM) i5-12450H, ram_total=25392844800
```

**G1 = PASS** with genuine evidence. (Over the original nine-record recovery directory alone, G1 is still FAIL — there is no PROFILE record in the historical set; that fact is unchanged.)

---

## 2. G3 — GPU branch complete-or-skipped with reason

### 2.1 What G3 requires (frozen spec)
"If CUDA exists: GPU baselines (E2 + B4/B5) produce complete records; if no CUDA: records exist with `status: skipped` + reason. Either branch passes; missing-GPU must not fail the suite."

G3 keys on **CUDA availability** (a build/runtime fact), **not** on whether the machine physically has a GPU. This distinction is now made explicit in the generated evidence.

### 2.2 What was produced
Command:

```
./build-v18-debug/run_baseline.exe --baseline E2 --out ../archive_recovery/v21_evidence
```

Result (exit code 0), three genuine SKIPPED records: `P1-E2-skip.json`, `P1-B4-skip.json`, `P1-B5-skip.json`, each with the precise reason:

> `skipped: CUDA unavailable in this build (STARK_ENABLE_CUDA=OFF / no CUDA toolkit); this does NOT imply the machine has no GPU -- physical GPU presence is recorded independently in hardware.gpu_present (spec G3 skipped-branch)`

No E2 record was fabricated and no GPU result was invented. The skip is because **this binary was built without CUDA**, which the frozen G3 rule explicitly permits.

### 2.3 Physical GPU vs CUDA build — resolved
- **Physical GPU present:** yes (RTX 2050), independently verified (OS inventory + production profiler).
- **CUDA usable by this build:** no (`STARK_ENABLE_CUDA=OFF`); therefore the GPU branch cannot run and the correct G3 evidence is the SKIPPED receipt.
- The old reason string "no CUDA device / binary built without CUDA" conflated the two; it has been replaced with the precise, build-scoped reason above (source change in `src/phase1/baselines/run_baseline.cpp`).

### 2.4 G3 outcome
```
[PASS] G3 GPU branch complete-or-skipped with reason
       B5: SKIPPED — skipped: CUDA unavailable in this build …
```
**G3 = PASS** over the v2.1 candidate evidence set, with genuine SKIPPED records. (Over the original nine-record recovery directory alone, G3 is still FAIL — no E2/B4/B5 records exist there.)

---

## 3. Historical completeness wording correction

### 3.1 The three distinct numbers
| Quantity | Value | Status |
|---|---|---|
| JSON records **previously observed** in the original source archive | **24** (reviewer-supplied independent inspection, counted under `build/results/`) | reported by an external inspection of the original archive |
| JSON records **currently recovered** in this project | **9** | verified against `RECOVERY_MANIFEST.json`; all checksums match |
| JSON records **not present** in the current recovered set | **15** | **unresolved / recoverability not established** |

### 3.2 What is claimed and what is not
- The project's recovery package contains **exactly nine** JSON experiment records plus one weights binary. That is what exists here and what was audited.
- An earlier independent inspection counted **24** records under `build/results/` in the original archive. That count is **recorded here as an external observation**; it cannot be re-derived from anything present in this project.
- **Fifteen records are missing.** They were **not** recovered, **not** validated, and **not** used. Nothing about their contents is inferred or fabricated.
- **Historical completeness is UNRESOLVED.** The nine-record subset is **not** a proven-complete historical dataset.
- The source-archive digest is preserved as previously recorded: `cb5e85e8b446ef0a0c0acf64f4151142489a73c9a9cb0cb5c6f5d28e92fdc733`, **manifest-asserted only** (the original `.zip` is not present in this workspace for an independent re-hash).

### 3.3 Per instruction
No search for, request of, extraction of, or reference to the external ZIP archive was performed. The reviewer's independent count is used only as a stated external observation, clearly separated from project-verified facts.

---

## 4. Summary table

| Gate | Over the nine-record recovery alone | Over the v2.1 candidate evidence set |
|---|---|---|
| G1 | FAIL (no PROFILE record) | **PASS** (genuine PROFILE) |
| G3 | FAIL (no E2/B4/B5 records) | **PASS** (genuine SKIPPED receipts, precise reason) |
| G4 | FAIL (Unknown physical capability; fail closed) | **FAIL** (GPU-capable host; VRAM not measured) |
| G7 | FAIL | **FAIL** (genuine; see g7_root_cause_analysis.md) |
