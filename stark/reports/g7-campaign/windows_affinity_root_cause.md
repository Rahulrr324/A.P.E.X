# Windows Affinity Root Cause — Final Determination

**Date:** 2026-10-06
**Scope:** Why `affinity_query_windows()` reported post-set `[0,32]`, and whether single-CPU process affinity is achievable on this machine.
**Classification:** **benchmark/instrumentation implementation defect** — NOT an environment reproducibility limitation.

---

## 1. Root cause

The root cause is a **benchmark/instrumentation implementation defect** inside our own
affinity probe, not an OS, job-object, thread, or environment constraint.

The faulty expression was:

```cpp
if (processMask & (1u << i))
```

`1u` is a 32-bit `unsigned int`, so the shift is performed in 32-bit arithmetic.
On this build `DWORD_PTR` is **64-bit** (the process/system masks are 64-bit),
and the enumeration loop iterates `i` over all 64 bit positions. For `i >= 32`
the expression `1u << i` is undefined behavior; on this compiler it wraps and
behaves as `1u << (i % 32)`, so each low bit `k` is *also* observed at position
`k + 32`.

Consequence: the enumeration **fabricated CPUs 32–43** from the real bits 0–11.
The earlier reported result `post-set = [0,32]` was a pure measurement artifact:

- real post-set mask was `0x1` (bit 0 only) → enumeration reported `[0, 32]`
  because bit 0 was additionally observed at position 32.

The same defect on the pre-set mask `0xFFF` (bits 0–11) reported 24 CPUs
(`[0..11]` plus fabricated `[32..43]`).

### What the evidence actually showed

| Quantity | Actual value |
|---|---|
| GetProcessAffinityMask pre-set process mask | `0xFFF` |
| GetProcessAffinityMask post-set process mask | `0x1` |
| SetProcessAffinityMask to `0x1` | success (`1`, `GetLastError = 0`) |
| Logical CPUs on this machine | 12 (bits 0–11) |
| CPU 32 | **NOT an actual detected CPU** — fabricated by the enumeration |

CPU 32 was **NOT** an SMT sibling and was never proven to be one. The earlier
SMT / Windows-affinity explanation for `[0,32]` was **invalid** and is
retracted. No OS, job-object, CPU-set, or thread constraint explains `[0,32]`;
it was purely the 32-bit-shift measurement artifact.

Single-CPU process affinity **is achievable on this machine** — demonstrated
below through the real production path.

---

## 2. Verification predicate vs. measurement

The verification predicate itself was **correct** and was not changed:

```cpp
v.query_ok && v.effective.size() == 1 && v.effective.front() == requested
```

The **measurement feeding that predicate was defective**: `query()` enumerated
the mask with `1u << i`, producing spurious entries (e.g. `32`), which made
`v.effective.size() == 1` false even when the OS had actually pinned the
process to a single CPU. The predicate rejected a truthful result because it
was fed a fabricated one.

---

## 3. The correction

File: `src/phase1/common/HardwareAffinity.cpp`

Query enumeration:

```diff
-        if (processMask & (1u << i)) {
+        if (processMask & (DWORD_PTR(1) << i)) {
```

Set-mask construction (same defect class in `affinity_set_windows()`):

```diff
-    DWORD_PTR newMask = 1u << cpu_index;
+    DWORD_PTR newMask = DWORD_PTR(1) << cpu_index;
```

`DWORD_PTR(1)` makes the shift a 64-bit shift in `DWORD_PTR` arithmetic — the
shift is *performed* in 64-bit arithmetic (not merely cast afterward), so every
bit of the actual 64-bit mask is represented correctly.

Provenance correction preserved unchanged in `requestAndVerifyFirstCpu()`:

```cpp
s.effective = v.effective;
s.query_ok = v.query_ok;
```

The verification predicate was **not weakened**.

---

## 4. Raw affinity evidence (real production path, post-fix)

Captured by `tests/test_production_affinity_evidence.cpp`, which exercises the
actual `HardwareAffinity` production code (the same path M0 uses), not a
standalone API probe:

```text
[1] Baseline query (production path):
    supported   = true
    query_ok    = true
    effective   = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]      <- pre-set mask 0xFFF
    reason      = (none)

[2] requestSingleCpu(0) (production path):
    set_ok      = true
    effective   = [0]
    reason      = (none)

[3] requestAndVerifyFirstCpu() (production path — what M0 uses):
    set_ok      = true
    query_ok    = true
    effective   = [0]
    reason      = (none)
    verification_result = true (single-CPU affinity to CPU0 confirmed)

[4] Raw API cycle: SetProcessAffinityMask -> GetProcessAffinityMask:
    SetProcessAffinityMask(0x1) return = 1 (SUCCESS)
    GetLastError after set            = 0x00000000
    requested CPU = 0
    GetProcessAffinityMask returned = 1
    GetLastError after query        = 0x00000000 (NO_ERROR)
    process mask = 0x0000000000000001
    system mask  = 0x0000000000000fff
    effective CPUs (1ULL<<i enumeration): [0]
    CPU 32 fabricated? = NO (correct)
    single-CPU verification (production) = true
```

Match against expected result:

```text
requested = 0                    -> requested = 0                     MATCH
set_ok = true                    -> set_ok = true                     MATCH
raw post-set process mask = 0x1   -> process mask = 0x0000000000000001 MATCH
effective = [0]                   -> effective = [0]                   MATCH
single-CPU verification = true    -> verification_result = true        MATCH
```

This result comes from the real production path after the fix; it was not
manufactured.

---

## 5. Thread-affinity note

No permanent thread-affinity implementation was introduced. M0 continues to
use process affinity. A process mask of exactly `0x1` constrains every thread
in the process to CPU 0, and no contradictory external constraint was found
(see §6). The earlier thread-level diagnostic that crashed
(`test_windows_affinity_diag.exe`, exit 139 / segfault) is treated strictly as
**diagnostic failure — not as evidence**. The unreliable
`SetThreadAffinityMask(..., 0xFFFFFFFF)` probe was not used as a query
mechanism.

---

## 6. External constraints

Checked only because a contradictory readback would matter. Direct Windows
evidence already showed `SetProcessAffinityMask → success` and
`GetProcessAffinityMask → 0x1`:

- `SetProcessAffinityMask(process, 0x1)` returned `1` (success), `GetLastError = 0`.
- `GetProcessAffinityMask` read back `0x1` with `GetLastError = 0` (`NO_ERROR`).
- The widen-probe to `0xFFF` was previously accepted by the OS, so no job
  object constrains CPU affinity here.

No Job Object / CPU Set contradiction exists, so no further investigation cycle
was spent there.

---

## 7. Regression coverage

New deterministic mask-width regression added to `tests/test_phase1_affinity.cpp`
(uses a 64-bit `DWORD_PTR` enumerator mirroring the production expression, plus
a cross-check of the production `query()` against the raw OS mask):

- `mask = 0x1` → expected CPUs = `[0]` (size 1, front 0, CPU 32 NOT present)
- `mask = 0xFFF` → expected CPUs = `[0..11]` (size 12, exact order, CPU 32 NOT present)
- negative control: `mask = 1 << 32` → expected CPUs = `[32]` (bit 32 maps correctly when genuinely set)
- production cross-check: `HardwareAffinity::query()` equals the 64-bit
  enumeration of the raw `GetProcessAffinityMask` mask; when only low bits are
  set, no reported CPU is `>= 32`.

---

## 8. Rebuild and regression results (release baseline `build-v24-release`)

Rebuilt from the current release baseline with the minimal correction:
`ninja stark_phase1 test_phase1_affinity test_phase1_records test_phase1_gates`
→ exit 0, no warnings-as-errors.

| Test | Assertions | Failures | Result | Exit code |
|---|---|---|---|---|
| `test_phase1_affinity` (incl. mask-width regression) | 56 | 0 | PASS | 0 |
| `test_phase1_records` | 72 | 0 | PASS | 0 |
| `test_phase1_gates` | 437 | 0 | PASS | 0 |

CTest (`ctest -R "test_phase1_affinity|test_phase1_records|test_phase1_gates"`):
`100% tests passed out of 3`, exit code 0.

Notes on execution context:

- `test_phase1_gates` must run with working directory = source root (as CTest
  registers it); run from the build directory it fails its `copy_file`
  fixtures (19 failures) because fixture paths are relative. From the correct
  working directory: 437 assertions, 0 failures.
- The deterministic mask-enumeration regression runs inside
  `test_phase1_affinity` (it is part of the 56 assertions; 0 failures).

---

## 9. Frozen evidence protection (frozen 30 G7 records)

Verification script: `reports/g7-campaign/verify_frozen30.py` (read-only).

| Check | Result |
|---|---|
| Records present in `build/g7-campaign` | 30 / 30 |
| Manifest `record_count` | 30 |
| Every record SHA matches manifest | 30 / 30 match |
| Missing records | none |
| Unexpected replacements | none |
| `evidence_manifest.json` hash vs frozen sum | `7a8dd9de17c4effdc9153ac4505a6f6f95ed662ef204cab52ad279c4bf01fc5a` — unchanged |

`FROZEN RECORD VERIFICATION: PASSED` (script exit 0). No frozen record was
regenerated or modified; G7 was not rerun.

(Note: source-file entries in `reports/sha256sums_g7_campaign.txt` reflect the
pre-correction source snapshot; they are historical entries and were left
untouched. Record-integrity verification covers the 30 records and the
manifest, which are unchanged.)

---

## 10. Final determination

```text
AFFINITY ENUMERATION: FIXED
AFFINITY PROVENANCE: TRUTHFUL
SINGLE-CPU AFFINITY: VERIFIED
FROZEN 30 RECORDS: UNCHANGED
G7: NOT YET RERUN
M0: STILL FAIL
M1: LOCKED
```

G7 has **not** been rerun and is **not** claimed to pass. No new G7 campaign
was launched as part of this correction.

### Is a final G7 campaign justified?

**Yes — from the instrumentation side the blocker is cleared.** The affinity
probe defect that fabricated CPUs 32–43 is fixed and regression-covered, the
provenance path reports the true OS state, and single-CPU process affinity is
verified through the production path on this machine. A final G7 campaign run
would therefore be operating on truthful instrumentation. It remains to be
launched as an explicit, separate step (the frozen 30 records must stay as
they are, and M0 stays FAIL until a fresh campaign produces a new verdict).
