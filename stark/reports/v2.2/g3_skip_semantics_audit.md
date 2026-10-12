# APEX M0 v2.2 — G3 SKIPPED Semantics Audit

**Date:** 2026-10-05
**Scope:** Independent trace of the frozen G3 gate, source-referenced answers, and empirical regression tests. No frozen rule was changed; the v2.1 source is preserved byte-for-byte (hashes in `reports/sha256sums_v22.txt`).

**Evidence tag legend:** **[V]** verified from source/files, **[T]** test observation, **[I]** inference, **[S]** spec text, **[U]** unresolved limitation.

---

## 1. Frozen specification

`design/V009_phase1_M0_specification.md:324` **[S]**:

> **G3** | If CUDA exists: GPU baselines (E2 + B4/B5) produce complete records; if no CUDA: records exist with `status: skipped` + reason. Either branch passes; missing-GPU must not fail the suite.

The spec keys G3 on **CUDA availability**, not on physical GPU presence, and permits a skip record as the whole of the no-CUDA branch.

---

## 2. Production implementation trace

G3 is one of the seven gates in `evaluate_gates()`; it is the block beginning at
`src/phase1/gates.cpp:403` (`g.gate = "G3 GPU branch complete-or-skipped with reason"`) and running to line 444. **[V]**

```
bool cuda = HardwareProfiler::cudaRuntimeAvailable();     // gates.cpp:405
bool pass = true;
if (cuda) {
    detail = "CUDA present: E2/B4/B5 records required PASSED";
    for (id in {E2,B4,B5}) {
        if (missing || status != PASSED) { pass=false; break; }   // gates.cpp:411-414
    }
} else {
    for (id in {E2,B4,B5}) {
        if (missing)            { pass=false; detail="<id> record missing entirely (must record skipped status)"; break; }  // 420-424
        if (status != SKIPPED && status != NOT_ATTEMPTED) { pass=false; detail="<id> present but not marked skipped"; break; } // 426-429
        if (status_reason.empty()) { pass=false; detail="<id> skipped without reason"; break; }  // 431-434
        detail = "<id>: SKIPPED — " + status_reason;                                                  // 435
    }
}
```

Supporting call sites:

- `HardwareProfiler::cudaRuntimeAvailable()` — a build/runtime probe of **the aggregator binary itself**. On the v2.1 build (no CUDA toolkit, `STARK_ENABLE_CUDA=OFF`) it returns `false`. **[V]**
- The no-CUDA skip receipts are produced by `run_baseline --baseline E2` at
  `src/phase1/baselines/run_baseline.cpp:326-360`; the `status_reason` is computed at runtime from
  `HardwareProfiler::cudaRuntimeAvailable()` (`:332`, `:347`). **[V]**
- G3 reads records through `latest_by_experiment()` (`gates.cpp:227`), i.e. the newest record per
  `experiment_id` (newest `created_utc`, tie-broken by `record_id`). **[V]**

---

## 3. Answers to the seven questions

**Q1 — What exactly does G3 require?**
G3 requires, for each of the three ids E2, B4, B5, that a record exists and satisfies
**one of two mutually exclusive branches selected by the aggregator's own CUDA probe**:
- CUDA present → the record must exist and be `PASSED`;
- no CUDA → the record must exist, be `SKIPPED`/`NOT_ATTEMPTED`, and carry a **non-empty** `status_reason`.
All three ids must satisfy the same branch. **[V]**

**Q2 — Does a SKIPPED E2 record satisfy G3, or does it only document why execution did not occur?**
It does **both**. In the no-CUDA branch a `SKIPPED` E2 record is exactly the required evidence — it
makes G3 pass. It is not merely a documentary footnote; it *is* the deliverable. **[V]**

**Q3 — Does it distinguish a legitimate unsupported-environment skip from a missing experiment?**
**Yes for missing vs present** (`gates.cpp:420-424` fails an absent record with "record missing
entirely"), **no for legitimate vs arbitrary**. The gate never inspects *why* the skip happened
beyond the string being non-empty. **[V]**

**Q4 — Does it validate the skip reason and its provenance?**
**No.** The only test is `status_reason.empty()` (`gates.cpp:431`). There is no schema for the
reason, no cross-check against the record's own `hardware.cuda_available`, no check that the skip
was warranted, and no provenance requirement. **[V][T]**

**Q5 — Can arbitrary SKIPPED records make G3 PASS?**
**Yes.** Three records whose `experiment_id` ∈ {E2,B4,B5}, `status` ∈ {SKIPPED,NOT_ATTEMPTED}, and
`status_reason` is any non-empty string pass G3. **[T]** Case 6 of the regression test passes with
the reasons `"x"`, `"because"`, `"lorem ipsum"`; case 7 passes even when the E2 record's own
hardware block claims `cuda_available=true`, directly contradicting its SKIPPED status.

**Q6 — Does G3 require actual GPU execution on a physically GPU-capable host?**
**No.** The branch is chosen by the aggregator build's CUDA probe, never by the physical host. On
any CUDA-less build the "GPU execution" branch is unreachable, so G3 can be satisfied with zero GPU
work and without the host even being a GPU machine. It does not consult `hardware.gpu_present`. **[V]**

**Q7 — Are E2, B4, and B5 separate requirements or one combined requirement?**
Three **separate** ids, each required to exist and satisfy the branch, combined into the **single**
gate G3. (The spec writes "E2 + B4/B5"; the implementation requires B4 and B5 individually.) **[V]**

---

## 4. Regression tests (new, v2.2 evidence)

Source: `reports/v2.2/tests/test_v22_g3_semantics.cpp` — kept outside the frozen v2.1 suite so the
v2.1 test source is untouched. It calls the production seam `evaluate_gates()` directly.

Build/run (WinLibs GCC 16.1.0, from `stark/`):

```
g++ -std=c++17 -I src -I src/phase1 -I . \
    reports/v2.2/tests/test_v22_g3_semantics.cpp \
    -o reports/v2.2/tests/test_v22_g3_semantics.exe \
    build-v21-debug/libstark_phase1.a -static-libgcc -static-libstdc++
./reports/v2.2/tests/test_v22_g3_semantics.exe
```

Observed output **[T]** (`cudaRuntimeAvailable() = false` on this build):

```
[1] three valid SKIPPED records      -> PASS | B5: SKIPPED — skipped: no CUDA in this build
[2] NOT_ATTEMPTED accepted           -> PASS | B5: SKIPPED — not attempted: no CUDA build
[3] B4 record missing                -> FAIL | B4 record missing entirely (must record skipped status)
[4] E2 SKIPPED with empty reason     -> FAIL | E2 skipped without reason
[5] E2 PASSED (no CUDA expected)     -> FAIL | E2 present but not marked skipped (no CUDA available)
[6] arbitrary fabricated reasons     -> PASS | B5: SKIPPED — lorem ipsum
[7] contradictory capability evidence-> PASS | B5: SKIPPED — skipped: no CUDA in this build
[8] no E2/B4/B5 records at all       -> FAIL | E2 record missing entirely (must record skipped status)
v2.2 G3 semantics test: 10 checks, 0 failures
```

Coverage requested by the task: valid skip (1), valid execution — the CUDA-present branch is
**unreachable on this build**, so it is verified by reading only (Q1) and cannot be exercised
here **[U]**; unsupported skip (1,2); missing record (3,8); malformed/empty reason (4); contradictory
capability evidence (7); arbitrary reason (6); wrong status (5).

---

## 5. Verdict on the v2.1 G3 = PASS claim

- Over the **original nine recovered records**, G3 = **FAIL** (no E2/B4/B5 records). Independently
  reproduced: `aggregate --out ../archive_recovery/aggregator_input` →
  `[FAIL] G3 … E2 record missing entirely`. **[V]**
- Over the **v2.1 candidate evidence set** (`archive_recovery/v21_evidence/`, which adds genuine
  `P1-E2-skip.json`, `P1-B4-skip.json`, `P1-B5-skip.json` produced by `run_baseline`), G3 = **PASS**
  under the frozen rule. Independently reproduced. **[V]**

**Correction of interpretation (not of the rule):** the v2.1 G3 = PASS is *literally valid*, but it
is a **weak, near-vacuous pass**. It certifies only that three skip receipts with non-empty text
exist. It does **not** establish that GPU work was attempted and legitimately blocked, that the host
is GPU-capable, that the reason is true, or that the skip is not fabricated. The report's framing
("genuine SKIPPED receipts") is defensible for the files it generated, but the gate's pass carries
**no hardware or execution evidentiary weight**. No frozen rule was changed; the v2.1 PASS stands as
a pass by the letter of the rule, with the above qualification recorded.

**[U] Cosmetic defect (not fixed):** for `NOT_ATTEMPTED` records the detail string still prints
`"<id>: SKIPPED — …"` (`gates.cpp:289`/`:435`), mislabelling the status in the human-readable
output. This is display-only and does not affect the pass/fail boolean.
