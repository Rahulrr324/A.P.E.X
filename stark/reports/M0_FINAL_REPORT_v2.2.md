# APEX M0 — v2.2 Independent Verification of v2.1 — Final Report

**Date:** 2026-10-05
**Repository:** `stark/` (STARK-006) — no `.git` directory; source identity by SHA-256
**Supersedes (for audit purposes):** `M0_FINAL_REPORT_v2.1.md` (preserved unchanged)
**Scope:** Independent verification and correction of the v2.1 deliverables. M0 decision only. No M1
work, no architecture expansion, no threshold or acceptance-criteria change. No external archive was
searched, requested, extracted, restored, or referenced.

---

## 0. Headline

| Gate | Over the **original nine recovered records** | Over the separate **v2.1 candidate evidence set** | v2.2 independent verdict |
|---|---|---|---|
| G1 | FAIL (no PROFILE record) | PASS (genuine PROFILE) | **FAIL(historical) / PASS(candidate)** |
| G2 | PASS | PASS | **PASS** |
| G3 | FAIL (no E2/B4/B5) | PASS — *but near-vacuous* (see §3) | **FAIL(historical) / PASS(candidate, weak)** |
| G4 | FAIL (capability Unknown → fail closed) | FAIL (GPU-capable host, VRAM not measured) | **FAIL** |
| G5 | PASS | PASS | **PASS** |
| G6 | PASS | PASS | **PASS** |
| G7 | FAIL (16.13–48.04% vs 15%) | FAIL (genuine) | **FAIL** |
| Historical completeness | — | — | **UNRESOLVED** |
| Build & Phase-1 tests | — | 6/6 CTest, 340 gate assertions, 0 fail | **PASS (Phase-1 only)** |
| **M0 overall** | | | **FAIL** |
| **M1** | | | **LOCKED** |

> The independent audit **confirms** G4 = FAIL (corrected from v2.0), **confirms** G7 = FAIL is
> genuine, **confirms** the v2.1 G1/G3 passes are literally valid over the candidate set, and
> **qualifies** G3 as evidentially weak. Nothing was changed to manufacture a pass. **M0 = FAIL, M1 = LOCKED.**

---

## 1. Evidence taxonomy (read first)

- **[V] Verified fact** — independently re-derived from files/binaries in this project by a v2.2 command.
- **[T] Test observation** — produced by a v2.2 test/aggregator run.
- **[I] Inference** — a supported conclusion, not a direct measurement.
- **[U] Unresolved limitation** — not established by the available evidence.
- **[S] Spec text** — from the frozen `design/V009_phase1_M0_specification.md`.

---

## 2. What is original vs what is new (the two evidence sets)

The task requires separating the *original recovered set* from the *newer v2.1 candidate set*.

| Set | Location | Contents | Status |
|---|---|---|---|
| **Original recovered set** | `archive_recovery/aggregator_input/` (and `archive_recovery/original_historical_records/`) | the **9** historical JSON records + `tiny_dense_2l_weights.bin` (+ `RECOVERY_MANIFEST.json` in the records dir) | **FROZEN / unchanged** — hashes in the v2.0 and v2.2 lists match **[V]** |
| **v2.1 candidate evidence set** | `archive_recovery/v21_evidence/` | the same 9 records + a genuine `PROFILE` + `TELEMETRY` + **new** `E2/B4/B5` SKIPPED receipts = **14** records | **authored in v2.1**, not historical |
| **v2.1 fresh diagnostics** | `archive_recovery/v21_diagnostics/` | **36** freshly executed records (6×E1 + 6×E5 per benchmark, Release build) | **authored in v2.1**, diagnostic only |

**[V]** The nine recovered records are byte-identical across `original_historical_records`,
`aggregator_input`, and the copies inside `v21_evidence` (same SHA-256 in `sha256sums_v20.txt` and
`sha256sums_v21.txt`). No recovered record was modified in v2.1 or v2.2.

**Consequence:** G1 and G3 **pass only over the v2.1 candidate set**. Over the original nine-record
recovery they remain **FAIL**. The candidate set is *legitimate new evidence*, but it is **not** part
of the historical archive, and satisfying G1/G3 with it does not repair the historical gap.

---

## 3. G3 SKIPPED semantics — independent audit

Full detail: `reports/v2.2/g3_skip_semantics_audit.md`.

**Frozen spec [S]** (`V009:324`): *"If CUDA exists: GPU baselines (E2 + B4/B5) produce complete
records; if no CUDA: records exist with `status: skipped` + reason. Either branch passes; missing-GPU
must not fail the suite."*

**Production implementation [V]** (`src/phase1/gates.cpp:403-444`): the branch is chosen by the
**aggregator binary's own** `HardwareProfiler::cudaRuntimeAvailable()`:
- CUDA present → E2, B4, B5 must each exist and be `PASSED`;
- no CUDA → E2, B4, B5 must each exist, be `SKIPPED`/`NOT_ATTEMPTED`, and have a **non-empty**
  `status_reason`.

**Answers (with sources):**

1. **What G3 requires:** all three of E2/B4/B5 to satisfy one branch selected by the local CUDA probe. **[V]**
2. **Does a SKIPPED E2 satisfy G3?** In the no-CUDA branch, **yes — it is the required evidence**; it is not merely a documentary note. **[V]**
3. **Legitimate skip vs missing experiment?** It **does** distinguish *present* from *missing*
   (`"record missing entirely"`), but **does not** distinguish a legitimate skip from an arbitrary one. **[V][T]**
4. **Does it validate the reason / provenance?** **No** — only `status_reason.empty()`. No content,
   provenance, or consistency check. **[V][T]**
5. **Can arbitrary SKIPPED records pass?** **Yes.** Three records with ids E2/B4/B5, status
   SKIPPED/NOT_ATTEMPTED, and any non-empty text pass — demonstrated with `"x"`, `"because"`,
   `"lorem ipsum"`, and with a record whose own `cuda_available=true` contradicts its SKIPPED status. **[T]**
6. **Does it require GPU execution on a GPU-capable host?** **No.** It never consults physical
   presence; on a CUDA-less build the execution branch is unreachable. **[V]**
7. **E2/B4/B5 separate or combined?** Three separate id requirements combined into the single G3 gate. **[V]**

**Regression tests (new, v2.2):** `reports/v2.2/tests/test_v22_g3_semantics.cpp` — 10 checks, 0
failures, exercising valid skip, NOT_ATTEMPTED, missing record, empty reason, wrong status, arbitrary
reason, and contradictory capability evidence. Source stays outside the frozen v2.1 suite. **[T]**

**Verdict:** the v2.1 **G3 = PASS is literally valid but near-vacuous**. It certifies only that three
skip receipts with non-empty text exist; it carries no weight about hardware, execution, or the
truthfulness of the reason. **Interpretation corrected; no rule changed.** Over the historical nine
records, G3 = **FAIL** (verified). **[V][T]**

---

## 4. Windows physical GPU detection — independent audit

Full detail: `reports/v2.2/gpu_detection_audit.md`.

**[V]** `collectPhysicalGpuPresence` (`HardwareProfiler.cpp:44-80`) enumerates display adapters with
`EnumDisplayDevicesA(NULL, i, …)`, filters three substrings (`Microsoft Basic`, `Remote`,
`Basic Render`), and sets a tri-state `std::optional<bool> gpu_present`. Serialization is
`true`/`false` as a bare boolean and `{value:null,reason}` when unknown; parse restores all three
states; malformed/absent → Unknown. `device_capability()` (`gates.cpp:140-166`) classifies CPU-only
**only** on `gpu_present == false`, and fails G4 closed on Unknown.

Findings: adapter-not-driving-a-display is only partially covered; virtual/mirror adapters are filtered
only by three weak substrings (Parsec/SpaceDesk/IddSampleDriver would be counted as real); multiple
GPUs are collapsed to one boolean and **over-counted per display output** (the host's single Intel
adapter is listed 4× — an OS inventory of 2 adapters vs 5 enumerated strings); enumeration errors are
handled safely by failing closed to Unknown; the tri-state, missing/null→Unknown, CUDA-independent
presence, and backward-compatible fail-closed behaviour are all **correct**.

**[H]** Host inventory (`Win32_VideoController`): Intel UHD + **NVIDIA RTX 2050 (~4.0 GiB)**;
production profiler reports `gpu_present = true`. Two sources agree the host is **GPU-capable**. This
is *presence only* — it does not imply driver health, CUDA availability (`cuda_available=false` here),
CUDA build support, measured VRAM, or GPU-execution capability. The current implementation is
conservative and **cannot produce a false PASS**; a proposal for the smallest safe hardening
(distinct-adapter counting and an expanded virtual-adapter filter) is recorded but **not applied**.

---

## 5. G7 statistics — independent verification

Full detail: `reports/v2.2/g7_statistical_verification.md`; script `reports/v2.2/verify_g7.py`.

**[V]** Recomputed from raw samples only:

- **Stored median == recomputed median for all 9/9 records.** ✅
- **Historical config groups (3 runs each)**, production `symmetric_rel_diff_pct`, 15% tolerance:
  B6 → 16.13% (1 pair fails); B7 → 18.38% / 21.26% (2 fail); B9 → 27.65% / 28.18% / 48.04% (3 fail).
  Matches the v2.1 report and the aggregator's own G7 detail text. ✅
- **Fresh repeats** (12 runs/benchmark → 66 pairs): **B6 35/66**, **B7 5/66**, **B9 19/66** exceed
  15%; spreads **59.06% / 19.03% / 59.78%**. Independently reproduced exactly. ✅

**[V] Documentation discrepancy:** the v2.1 `g7_stats_raw.txt` `stdev`/`CV%` columns use the
**population** convention (`ddof=0`; e.g. E1-B6-24899 = 161.99 µs / 15.35%), while the record's
stored `stdev` field is the **sample** stdev (170.76 µs / 16.18%). Medians and verdict unaffected;
recorded so the CV range is not misread.

**Wording corrected.** The defensible statement is: *"Under the frozen ±15% rule the recovered
historical dataset fails permanently; fresh diagnostic repeats under the same minimal configuration
also fail; a future, better-controlled measurement campaign is not yet established; retroactive
historical acceptance is not permitted."* The stronger claim that "the harness/methodology can never
pass G7" is **not established** — only the frozen dataset and the same-config fresh repeats fail. **[U]**

**Measured vs inferred.** Measured: intra-run sample CV 6.1–28.6%, max/median up to ~2.2×,
`thread_count=0`, warm-up=3, n=10, two historical batches ~23 s apart, `outputs_bit_identical=true`
for B6/B9. Plausible but **unproven** contributors: scheduler/timer jitter at 200 µs–1 ms, thermal /
CPU-frequency drift with no pinning, minimal warm-up, small-n median sampling error. **No root cause
is claimed as proven.** Data corruption, grouping error, and stored-median drift are ruled out. **[V][I]**

---

## 6. Legacy test coverage — independent audit

Full detail: `reports/v2.2/legacy_test_coverage.md`.

**[V][T]** 15 test executables; **CTest registers only the 6 Phase-1 suites** (6/6 pass, exit 0,
**340** assertions in `test_phase1_gates`, Release-preserved). The 9 legacy executables build and
return 0 when run directly in both builds — but exit 0 is **not** treated as coverage:

- 7 of them carry real, Release-preserved assertions: `test_stdp` (255), `test_homeostasis` (403),
  `test_three_factor` (80), `test_serialization` (98) via `abort()` on failure; `test_synapse` (38),
  `test_integration` (23), `test_network` (58) via a failed-count return.
- **`test_params` is diagnostic-only (zero assertions).**
- **`test_neuron` uses `<cassert> assert()`; the Release build defines `-DNDEBUG` (confirmed in
  `build-v21-release/build.ninja`), so its 38 assertions are compiled out in Release.**

**No "full project test coverage" claim is supported.** Assertion counts are not code coverage. **[U]**

---

## 7. v2.1 evidence integrity — independent verification

| Check | Result |
|---|---|
| Every file in `reports/sha256sums_v21.txt` exists and matches | **106/106 OK, 0 FAILED, exit 0** **[V]** |
| Duplicate path entries inflating the count | **none** (`uniq -d` empty) **[V]** |
| Manifest count == actual list length | manifest says **106**; list has **106** **[V]** |
| Debug/Release outputs correctly paired | **36/36 pairs byte-identical, 0 differing** **[V]** |
| Historical records unchanged | 9/9 match v2.0 hashes **[V]** |
| v2.0 evidence preserved | report/manifest/sha list/inventory hashes all match v2.0 **[V]** |
| v2.1 source changes vs v2.0 | intentional & documented (gates.cpp, HardwareProfiler.{h,cpp}, run_baseline.cpp, tests, fixtures); `CMakeLists.txt` unchanged. **Not corruption.** **[V]** |
| Build dirs current | `build-v21-{debug,release}` → `ninja: no work to do` **[V]** |

**[U]** The manifest's own claim `entries_in_list: 106` matches the list; the manifest does **not**
self-hash its list, so the list is the authoritative count.

**G4 interpretation note.** The frozen G4 text (`V009:325`) requires every baseline's peak RAM/VRAM to
be *measured* and fails if a peak-memory field is estimated; it does not literally mandate measured
VRAM on a GPU-capable host with no CUDA. The v2.1 rule (GPU-capable → require measured VRAM) is a
**stricter, fail-closed interpretation** layered on the spec. Under v2.0's literal CPU-only reading
the nine records passed; under the v2.1 conservative reading they fail. Because M0 requires all gates
to pass and one honest reading fails — and because the recovered records carry **no** physical-capability
evidence — the conservative verdict **G4 = FAIL** is retained. The recovered records do satisfy the
*RAM* half (`ram_measured=true`, positive finite peak) and document VRAM unavailability with a reason;
the failure is purely the unresolved physical-capability question. **[V][I]**

---

## 8. Final decision

```
M0 = FAIL
M1 = LOCKED
```

**Corrected G1–G7 status:**

- **G1: FAIL** over the original nine recovered records (no PROFILE); **PASS** over the **separate**
  v2.1 candidate set (genuine PROFILE, independently reproduced).
- **G2: PASS** (both sets).
- **G3: FAIL** over the original nine; **PASS** over the v2.1 candidate set — **literally valid but
  evidentially weak** (three non-empty skip receipts is all it certifies).
- **G4: FAIL** (both sets). The v2.0 PASS is withdrawn; the host is GPU-capable and the recovered
  records carry no physical-capability evidence or measured VRAM.
- **G5, G6: PASS.**
- **G7: FAIL**, genuine and reproducible; historical set fails permanently under the frozen rule;
  fresh repeats fail too; no future campaign or retroactive acceptance is established.

**Why M0 stays FAIL:** G4 and G7 are unmet over the evidence that actually matters; G1 and G3 are met
only over a *new* candidate set, not over the recovered historical records; historical completeness
(24 observed / 9 recovered / 15 missing) is unresolved. No threshold, sample, record, or acceptance
rule was altered.

**M1 remains LOCKED.** This is the end of the v2.2 audit; no M1, architecture, or APEX implementation
work was begun.

---

## 9. v2.2 deliverables

- `reports/M0_FINAL_REPORT_v2.2.md` (this report)
- `reports/v2.2/g3_skip_semantics_audit.md`
- `reports/v2.2/gpu_detection_audit.md`
- `reports/v2.2/g7_statistical_verification.md`
- `reports/v2.2/legacy_test_coverage.md`
- `reports/v2.2/evidence_manifest.json`
- `reports/sha256sums_v22.txt`
- `reports/v2.2/verify_g7.py`, `reports/v2.2/tests/test_v22_g3_semantics.cpp` (+ built `.exe`)

**Preserved unchanged:** the v2.1 report/source/records/fixtures/logs/checksums, the nine recovered
records, G7 thresholds/grouping, historical samples, and the v2.0 report and evidence.
