# STARK-L11.1 — Validation and Regression Plan

**Status:** plan. Tests marked **EXECUTED** ran in L11.1; the rest are specified
for L11.2 (implementation) and must not be claimed as run.
**Scope:** validates the *instrumentation and metrics*, not the capability. No test
here can demonstrate compositional generalization.

---

## 1. Test set

| ID | Test | Purpose | Method | Pass condition | Status |
|---|---|---|---|---|---|
| **T1** | Schema conformance | every required field present, typed, ordered | `schema_check.py --selftest` (17 cases) | 17/17 | **EXECUTED — 17/17 PASS** |
| **T2** | Malformed-trial rejection | missing field, bad int/float, unsorted or duplicate cue, bad enum, `routing_correct` inconsistent with banks, `OFF` with features, `CROSS21` with 1 feature, boolean out of range | negative controls inside T1 | every case rejected with a named reason | **EXECUTED — all 13 negative controls reject** |
| **T3** | Missing ≠ zero | a nullable field accepts an explicit empty; a non-nullable field may not be empty | T1 cases | absent values representable, never `0` | **EXECUTED** |
| **T4** | Metric reconstruction | routing, accuracy, `Read`, `WrongBankAcc`, `Null` recomputed from rows only | `recompute_from_trials.py` on L10.3 `KC_cross` trials | per-seed per-task values reproduce the published aggregate (< 5e-7) | **EXECUTED — 3/3 seeds match** |
| **T5** | Independent cross-check of the L10 number | pooled cross accuracy equals the published 0.5611 | T4 output, averaged over seeds | \|pooled − 0.5611\| < 1e-4 | **EXECUTED — 0.5611 reproduced** |
| **T6** | Instrumentation coverage audit | how much of the L11 schema the L10 record already satisfies | `schema_check.py --coverage` | report only (13/35 measured) | **EXECUTED** |
| **T7** | Writer round-trip | writer emits a file the validator accepts, with nulls preserved | build the instrumented harness, emit one short run, validate every row | 100 % rows valid; zero nulls silently written as `0` | L11.2 |
| **T8** | Non-interference (on/off) | instrumentation does not change the experiment | paired runs, same seed, `--emit-schema l11` on/off; project to the 17 L10 columns and diff **per trial** | byte-identical rows **and** identical aggregates | L11.2 |
| **T9** | Deterministic ordering / serialization | two runs of the same arm+seed are identical | sha256 of trial CSVs across two reruns | identical hashes | L11.2 |
| **T10** | Checkpoint / resume continuity | resume reproduces the remaining stream | checkpoint at a task boundary, resume, compare the post-resume rows | byte-identical from the checkpoint onward | L11.2 |
| **T11** | R-majority prediction unit test | the writer's `intended_bank` agrees with the declared rule | enumerate all `CROSS21`/`CROSS31` cues for T=3,K=3 and compare with the rule table | 100 % agreement (pure arithmetic, no model) | L11.2 |
| **T12** | Negative controls (should fail for known reasons) | the metrics can detect failure | `MISLEAD` must route to the wrong group's bank and score at the wrong-bank floor; `A10` (zero router) must route everything to the lowest allocated bank; `SHUFFLED` must sit at the floor | each arm lands where the mechanism predicts, within its interval | L11.2 (official arms) |
| **T13** | Positive control / attainable ceiling | the task is solvable at all | `TRAIN` and `HOLDOUT` arms must reproduce L10 (≈1.0000 and ≈0.9981) | ≥0.95 on both | L11.2 (official arms) |
| **T14** | Full regression | no new failures | the L10 battery (§3) plus the L11 test set | no new failures vs the inherited baseline | L11.2 |

## 2. Existing suites that must be included in the L11 gate

Inherited from L10.4 (**not re-run in L11.1**; no source changed in L11.1, so the
inherited status is expected to hold — expectation, not measurement):

`test_l10_1_sealing` (276 assertions), `n_way_learned_relevance_loop_L8`,
`test_phase1_profiler` (34), `test_phase1_accounting` (67), `test_phase1_budget`
(55), `test_phase1_records` (72), `test_phase1_reproducibility` (37),
`test_phase1_gates` (437), plus the remaining targets in the 26-target battery.

Build note (environment-verified): no `cmake` in this container, so targets are
built with explicit `g++ -O2 -std=c++17 -Isrc` (and `-Isrc/phase1` for the phase-1
tests) from `stark/`.

## 3. `test_phase1_affinity` — disposition and exact plan

**Current status: UNKNOWN / UNEXECUTED on this platform.** Not a pass, not a
failure, and must never be counted as either.

**Diagnosis (verified by compiling in this task):**

- `tests/test_phase1_affinity.cpp` has 44 `CHECK` assertions.
- It includes `<windows.h>` only under `_WIN32`, but uses `DWORD_PTR` in **10
  places** (lines 138–192) and calls the live Win32 API
  `GetProcessAffinityMask(GetCurrentProcess(), …)` in Case C — both **outside any
  platform guard**.
- Compiling with `-Isrc/phase1` on Linux fails at the first `DWORD_PTR`, confirming
  the report: failure is a portability defect of the *test*, not of the library
  (`src/phase1/common/HardwareAffinity.h` guards itself correctly with `#ifdef
  _WIN32`).
- A type alias alone is **not sufficient**: substituting
  `using DWORD_PTR = std::uintptr_t;` (semantically identical — `DWORD_PTR` is
  `ULONG_PTR`, i.e. pointer-width unsigned) advances the compile and then fails on
  `BOOL` / `GetProcessAffinityMask`. Verified by compiling a patched copy in
  `/tmp`; the repository file was **not** modified.

**Minimal legitimate fix (proposed, not applied):** split the test into
- a **portable section** — Cases A and B, the deterministic mask-enumeration
  regression, with a portable mask type (`std::uintptr_t`) — runs everywhere;
- a **Windows-only section** — Case C, the live-API agreement check — guarded by
  `#ifdef _WIN32` and otherwise printing `SKIPPED (Win32-only)` and *returning
  success only if the portable section passed*.

**Why it is not applied in L11.1:** it changes a test unrelated to L11, and the
choice between "port + skip" and "declare permanently Windows-only" is a
maintainer decision, not an agent decision.

**Required owner decision (one of):**
- **(a)** apply the split above in L11.2 — the portable regression then runs on
  Linux and the Win32 check is honestly reported as SKIPPED; or
- **(b)** record the target as **Windows-only, permanently excluded** from the
  Linux gate, with the exclusion written into the L11 specification.

**Evidence needed to close the gap** under (a): the ported test compiled and run on
this container, its assertion count, and the printed SKIPPED line for Case C; under
(b): the written exclusion plus a statement that the Win32 path remains unverified.

## 4. Anti-fraud rules for the L11.2 run

1. No arm, seed, task or trial may be excluded after its result is seen.
2. If a criterion is missed, the miss is reported with its number; the protocol is
   not re-run with a different configuration and presented as the same result.
3. `PASS` may be claimed only from a run whose rows carry the registered
   `protocol_sha256`.
4. Aggregates are derived; the reconstruction (T4) is authoritative.
5. A pooled number may never appear without its per-cell breakdown.

## 5. What this plan cannot establish

T1–T6 validate the *measuring instrument*. They say nothing about whether the
system composes context. That question belongs to the L11 official run, which has
not happened.
