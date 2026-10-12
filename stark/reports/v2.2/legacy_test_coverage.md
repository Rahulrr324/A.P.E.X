# APEX M0 v2.2 — Legacy Test Coverage Audit

**Date:** 2026-10-05
**Scope:** Enumerate every test executable produced by the v2.1 build, determine CTest registration,
fresh-build status, actual execution, exit code, assertion content vs diagnostic-only output, and
Release assertion preservation.

**Legend:** **[V]** verified from source/build/files, **[T]** execution observation.

**Key rule honoured:** a zero exit code is **not** treated as proof of coverage. Each executable is
classified by the assertions actually present in its source and compiled binary.

---

## 1. Test executable inventory

The v2.1 build produces **15 test executables** (plus 5 demos, `stark_002`, and the 3 Phase-1 CLIs;
24 `.exe` total in `build-v21-debug/`). **[V]**

| Executable | CTest-registered | Freshly built in v2.1 | Executed (v2.2) | Exit (Debug / Release) | Assertion mechanism | Release preserves? | Classification |
|---|---|---|---|---|---|---|---|
| test_phase1_profiler | **yes** | yes | yes | 0 / 0 | `CHECK` (test_main.cpp) | yes (not NDEBUG-gated) | 35 real assertions |
| test_phase1_accounting | **yes** | yes | yes | 0 / 0 | `CHECK` | yes | 67 real assertions |
| test_phase1_budget | **yes** | yes | yes | 0 / 0 | `CHECK` | yes | 55 real assertions |
| test_phase1_records | **yes** | yes | yes | 0 / 0 | `CHECK` | yes | 54 real assertions |
| test_phase1_reproducibility | **yes** | yes | yes | 0 / 0 | `CHECK` | yes | 37 real assertions |
| test_phase1_gates | **yes** | yes | yes | 0 / 0 | `CHECK` | yes | **340** real assertions |
| test_neuron | **no** | yes | yes | 0 / 0 | **`assert()` (`<cassert>`)** | **NO — compiled out under `-DNDEBUG`** | 38 asserts (Debug only) |
| test_params | **no** | yes | yes | 0 / 0 | **none** | n/a | **diagnostic-only** |
| test_synapse | **no** | yes | yes | 0 / 0 | `run_test(name,cond)` counter, `return failed>0?1:0` | yes | 38 checks |
| test_integration | **no** | yes | yes | 0 / 0 | `run_test` counter | yes | 23 checks |
| test_network | **no** | yes | yes | 0 / 0 | `run_test` counter | yes | 58 checks |
| test_stdp | **no** | yes | yes | 0 / 0 | `CHECK`/`CHECK_NEAR` → `std::abort()` | yes | 255 checks |
| test_homeostasis | **no** | yes | yes | 0 / 0 | `CHECK`/`CHECK_NEAR` → `std::abort()` | yes | 403 checks |
| test_three_factor | **no** | yes | yes | 0 / 0 | `CHECK`/`CHECK_NEAR` → `std::abort()` | yes | 80 checks |
| test_serialization | **no** | yes | yes | 0 / 0 | `CHECK`/`CHECK_NEAR` → `std::abort()` | yes | 98 checks |

**[T]** All 15 were executed directly in both `build-v21-debug/` and `build-v21-release/`; all
returned exit 0. Assertion totals above are the executables' own reported totals
("Total assertions: N", "Synapse Tests: 38 passed, 0 failed", etc.). **[T]**

---

## 2. CTest registration

`build-v21-debug/CTestTestfile.cmake` registers **exactly six** tests — the six `test_phase1_*`
suites. **[V]** `ctest` in both builds: **6/6 passed, exit 0** (Debug 0.52 s, Release 0.38 s). **[T]**

The nine non-registered executables (`test_neuron`, `test_params`, `test_synapse`,
`test_integration`, `test_network`, `test_stdp`, `test_homeostasis`, `test_three_factor`,
`test_serialization`) are **not** exercised by `ctest`. **[V]** The v2.1 report's caveat to this
effect is **accurate**.

---

## 3. If these legacy tests were registered, would they be meaningful?

**[V] Meaningful assertions (7 of 9):**
- `test_stdp`, `test_homeostasis`, `test_three_factor`, `test_serialization` use a custom
  `CHECK`/`CHECK_NEAR` macro that calls `std::abort()` on failure — a hard failure in **both**
  Debug and Release. Totals 255/403/80/98.
- `test_synapse`, `test_integration`, `test_network` use a `run_test(name, condition)` counter and
  `return failed > 0 ? 1 : 0` — genuine (if coarse) pass/fail signalling, preserved in Release.
  Totals 38/23/58.

**[V] Not a meaningful automated test:**
- **`test_params`** contains **zero assertions**. It prints ten parameter scenarios and always
  `return 0`. Its exit 0 is pure diagnostic output and proves nothing. It should not be counted as
  coverage.
- **`test_neuron`** has 38 `assert()` calls from `<cassert>`. CMake's Release configuration adds
  `-DNDEBUG` (confirmed: 103 `NDEBUG` occurrences in `build-v21-release/build.ninja`, **0** in the
  Debug build, flags `-O3 -DNDEBUG -std=gnu++17`). Therefore **the Release build of `test_neuron`
  compiles the assertions away** and its exit 0 is diagnostic-only. Only the Debug build retains the
  38 assertions.

So of the nine legacy executables, **one is diagnostic-only in both configs (`test_params`)** and
**one loses its assertions in Release (`test_neuron`)**. A blanket "nine legacy tests exit 0
directly" statement, if used as coverage evidence, would overstate the case for those two.

---

## 4. Coverage conclusion

- The **only** tests wired into CI-style execution (`ctest`) are the six Phase-1 suites (all real
  assertions, Release-preserved) — **6/6 pass, 0 failures**. This is genuine but **Phase-1 only**.
- The nine STARK-001..007 legacy executables build and return 0 when run manually. Seven carry real
  assertions preserved in Release; `test_params` is diagnostic-only; `test_neuron`'s assertions are
  Debug-only.
- **No claim of "full project test coverage" is supported.** The correct statement is: *"Phase-1 has
  six CTest-wired suites (all passing); nine legacy executables exist outside CTest, of which seven
  carry Release-preserved assertions, one is diagnostic-only, and one loses assertions in Release."*
- **[U]** No measurement is made here of *code coverage* (line/branch %). "Assertion count" is not
  "coverage"; this audit deliberately does not conflate them.
