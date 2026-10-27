# STARK-L11.3 — `test_phase1_affinity` Portability Plan

**Status: UNAPPLIED.** `stark/tests/test_phase1_affinity.cpp` is **unmodified** in
this milestone — sha256 `9dab81ee7c0b825f96b3a4dc8d33859c8cb84814ec1efa9a65bc6a7250a76561`
(203 lines). The test's own status is **UNKNOWN / UNEXECUTED** on this platform: it
**does not build**, so it has neither passed nor failed.

This document specifies the port. It does not perform it, and it records no
result for it.

---

## 1. Current state, established from source and from the recorded build log

`work/l10_raw/independent_validation_20261024/regression/test_phase1_affinity_build_failure.txt`
records six errors, all the same cause:

```
tests/test_phase1_affinity.cpp:138:37: error: 'DWORD_PTR' has not been declared
tests/test_phase1_affinity.cpp:140:45: ... 150:13 ... 160:13 ... 172:17 ... 186:13
```

Source inspection explains it exactly:

| Region | Lines | Portable? | Why |
|---|---|---|---|
| includes | 12–17 | **yes** | `windows.h` is already behind `#ifdef _WIN32` |
| query-support honesty | 28–62 | **yes** | pure `AffinityInfo` / `JsonValue` |
| request-and-verify honesty | 64–112 | **yes** | pure |
| failure-path invariant + no-`pinned` | 114–130 | **yes** | pure |
| mask-enumeration regression | 132–200 | **NO** | `DWORD_PTR`, `GetProcessAffinityMask`, `GetCurrentProcess` are **unguarded** |

So the defect is a single missing `#ifdef`. The *test logic* is portable; one block
is Windows-specific and was never wrapped.

Also relevant: on POSIX the production code returns `supported = false` with a
reason (`HardwareAffinity.cpp` lines ~107, ~147), so the `else` branches of the
portable sections are live, meaningful assertions — they verify the honest
unsupported path. **They must not be skipped.**

---

## 2. Separation rule

```
PORTABLE   = logic that holds on every platform
WINDOWS    = requires Win32 APIs or the DWORD_PTR width
```

| Block | Class | Disposition |
|---|---|---|
| query support / honesty (28–62) | PORTABLE | keep verbatim |
| request-and-verify (64–112) | PORTABLE | keep verbatim |
| failure-path invariant (114–130) | PORTABLE | keep verbatim |
| Case A single-bit (150–158) | WINDOWS (as written) | split — see §3 |
| Case B 0xFFF + bit32 (160–183) | WINDOWS (as written) | split — see §3 |
| Case C production agreement (185–199) | WINDOWS-only | guard with `#ifdef _WIN32` |

---

## 3. The exact port

### 3.1 Keep every existing assertion

No assertion is deleted, weakened, or reordered. The three honesty sections stay
byte-identical.

### 3.2 Re-express the shift-correctness regression in portable integer types

```
#if defined(_WIN32) || defined(_WIN64)
    using mask_t = DWORD_PTR;          // preserves the original test exactly
#else
    using mask_t = std::uint64_t;      // same width, same arithmetic, no Win32
#endif
```
with `enumerateMask(mask_t)` replacing `enumerateDWordPtr`, and the loop bound
`sizeof(mask_t) * 8`.

Cases A and B then run on **every** platform. `mask_t(1) << 32` is well-defined
for `uint64_t`.

### 3.3 Guard Case C

```
#ifdef _WIN32
    // Case C: production path agreement against GetProcessAffinityMask
    ...
#endif
```
Case C is genuinely Windows-specific: it compares `HardwareAffinity::query()`
against the OS mask. On POSIX `query()` reports `supported = false` with no
`effective` vector, so there is nothing to compare.

### 3.4 Do not fabricate Win32 behaviour

- No stub `DWORD_PTR`, no stub `GetProcessAffinityMask`, no `#define` shim.
- On POSIX the unsupported path is asserted **as unsupported** (§4).
- No `#ifdef` may be used to make an assertion disappear without a documented
  reason. Each guard is recorded in the port's manifest entry.

---

## 4. Supported / unsupported behaviour — the contract after the port

| Platform | `supported` | What the test asserts |
|---|---|---|
| Windows | `true` after a successful `GetProcessAffinityMask` | every existing assertion, including Case C |
| Windows, API fails | `false` + non-empty `reason` | `!set_ok`, `reason == q.reason`, `supported == false`, no `"pinned"` substring |
| POSIX | `false` + non-empty `reason` | the same unsupported-path assertions + Cases A/B on `uint64_t` |

**The honest-unsupported path is a first-class result, not a skip.** A POSIX run
that prints `supported=false` and passes is a *pass* about honesty. It is **not**
evidence that affinity works on that machine, and the test's output must not be
read as such.

---

## 5. What the port proves and does not prove

| Proves | Does **not** prove |
|---|---|
| the honesty invariants hold on every platform | that affinity control works on POSIX — it does not exist there |
| the 64-bit shift arithmetic is correct for `mask_t` | that Windows `DWORD_PTR` enumeration in *production* is correct on a 32-bit build (Case C covers Win64 only) |
| an unsupported platform reports `supported=false` rather than pretending | that any benchmark was ever pinned |
| the no-`pinned`-claim invariant | anything about timing, G7, or the frozen 30-record campaign |

---

## 6. Test-status semantics (the point of this milestone's insistence)

Permitted states for `test_phase1_affinity`, with the exact wording required:

| State | Wording |
|---|---|
| not built | `test_phase1_affinity: UNEXECUTED (build failure: DWORD_PTR undeclared)` |
| built, not run | `UNEXECUTED` |
| ran, all assertions pass | `PASSED (n assertions, 0 failures) on <platform>` |
| ran, failures | `FAILED (n assertions, k failures)` |

`UNKNOWN`/`UNEXECUTED` **may not** be upgraded to "passing" because the failure is
a compile error rather than a semantic error. A test that does not run has not
passed — that rule is exactly why this milestone reports the affinity test as
unexecuted rather than green.

---

## 7. Regression battery to rerun after the port

The port touches a test file only, but a compile change can surface latent issues,
so the full battery is rerun and reported, not just the ported test:

| # | Target | Why after this change |
|---|---|---|
| 1 | `test_phase1_affinity` | the ported test itself |
| 2 | `test_production_affinity_evidence` | shares `HardwareAffinity` |
| 3 | `test_windows_affinity_diag` | *Windows-only; skipped on Linux and reported as skipped, never as passed* |
| 4 | `test_phase1_records` | affinity provenance is serialized into records |
| 5 | `test_phase1_reproducibility` | unmodified-binary check |
| 6 | L10.1 determinism (18-file double run) | the harness is not involved, but the claim "nothing moved" needs the anchor |
| 7 | `ctest -R phase1` | breadth |

Registration: `stark/CMakeLists.txt:511` (`add_test(NAME test_phase1_affinity ...)`),
unchanged by the port.

---

## 8. Gate conditions before this port is applied

1. Owner approves the scope: **one test file, no production source** (the R2
   approval in principle covers exactly this and nothing more).
2. The port diff is reviewed against §3.1 — **zero assertions removed**.
3. `test_windows_affinity_diag` is confirmed to remain Windows-gated so the port
   cannot be mistaken for a cross-platform affinity claim.
4. A recorded before/after: before = `UNEXECUTED (build failure)`; after = the
   actually-observed state. If the after state is "still does not build", that is
   what gets recorded.

**Current state: none of these conditions has been acted on. The file is
byte-identical to the audited commit and the test remains UNEXECUTED.**
