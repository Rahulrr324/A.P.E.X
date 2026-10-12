# APEX M0 — v1.8 Corrective Remediation & Verification — Final Report

**Date:** 2026-10-04
**Repository:** `stark/` (STARK-006), preserved original source tree
**Supersedes:** `M0_FINAL_REPORT_v1.6.md` and `M0_FINAL_REPORT_v1.1.md`
(both preserved intact in `reports/historical/superseded/`)
**Scope:** M0 corrective remediation only. No M1 work, no APEX features, no
threshold or acceptance-gate changes.

---

## 0. Headline

| Area | Result |
|---|---|
| Toolchain repair | **PASS** — real C++17 compiler with `<optional>` established; fresh configure+build+CTest in both configs |
| §1 Active G7 test source corrected | **PASS** — `samplesB` declaration live; all 9 spec checks asserted |
| §2 Deserialization-boundary tests | **PASS** — full §2 coverage matrix through the real production path; 328 assertions total (**+139** vs the 189-assertion pre-v1.8 baseline) |
| §3 G7 production behavior verified | **PASS** — inspected from source; thresholds unchanged; **2 fail-closed defects found & fixed** |
| §4 Historical archive recovery | **BLOCKED** — named archive not present on this host (evidence below) |
| §5 Build environment repaired | **PASS** — 103/103 targets × 2 configs; 6/6 CTest × 2 configs; exit 0 |
| §6 Real aggregator execution | **PASS** — 48 runs, all inputs, both configs, exact exit codes captured |
| §7 Evidence reconciled | **PASS** — this report + 5 manifests + gate JSONs + SHA-256 list |
| §8 M0 overall | **BLOCKED** — single blocker: §4 archive unavailable. All other criteria PASS. |

**M0 is BLOCKED on §4 only. M1 remains locked.**

---

## 1. Corrected active G7 test source (`tests/test_phase1_gates.cpp`)

The v1.7 different-distributions regression had `samplesB` declared inside a
`//` comment, so the block did not compile as intended. Corrected by restoring
the declaration as live code. Test data and assertions were **not** weakened.

Verified against the spec's nine requirements (all asserted as `CHECK`s):

| Spec requirement | Assertion | Result |
|---|---|---|
| Distribution A ≥10 finite samples | `CHECK(stA.samples.size() == 10)`, `CHECK(std::isfinite(stA.median))` | PASS |
| Distribution B ≥10 finite samples | `CHECK(stB.samples.size() == 10)`, `CHECK(std::isfinite(stB.median))` | PASS |
| Two raw distributions genuinely different | `CHECK(samplesA != samplesB)` | PASS |
| Both recomputed medians **exactly 1.0** | `CHECK(medianA == medianB)`, `CHECK(medianA == 1.0)`, `CHECK(medianB == 1.0)` | PASS |
| Same serialized configuration | `CHECK(r1.configuration.dump() == r2.configuration.dump())` | PASS |
| Distinct record IDs | `CHECK(r1.record_id != r2.record_id)` | PASS |
| `evaluate_gates()` returns G7 PASS | `CHECK(gate_pass(recs, "G7"))` | PASS |
| Separate pair outside tolerance → G7 FAIL | medians 1.0 vs 3.0 → 66.7% ≫ 15%: `CHECK(!gate_pass(recs, "G7"))` | PASS |
| Not replaced by identical/constant helper arrays | Both blocks use two distinct literal arrays of 10 values each | PASS |

A = `{0.4,0.6,0.7,0.8,0.95,1.05,1.1,1.2,1.3,1.6}` (sorted indices 4,5 = 0.95,1.05)
B = `{0.1,0.4,0.65,0.85,0.9,1.1,1.25,1.45,1.6,1.85}` (sorted indices 4,5 = 0.9,1.1)

Production convention confirmed by a standalone probe against
`compute_statistics()`:
`medianA=1  medianB=1  A exactly 1.0? YES  B exactly 1.0? YES  equal? YES`

The order-independence block (reordered samples → same verdict) and the
same-pattern FAIL pair remain intact.

---

## 2. Deserialization-boundary regression tests

Added to `tests/test_phase1_gates.cpp` (the file the spec names). Every case
runs through the **real production path** — nothing is reimplemented:

- `JsonValue::parse` → `Statistics::from_json()`
- `ExperimentRecord::parse()`
- `RecordStore::loadAll()` + `ExperimentRecord::validate()`
- aggregator record loading + strict-mode decision (mirrors `aggregate.cpp`
  exactly, using the same production functions; the CLI itself is exercised in §6)

### Coverage matrix (behaviour confirmed by probe before asserting)

| # | Case | Production behaviour | Test |
|---|---|---|---|
| A | Numeric samples | decodes, 10 samples, median preserved | accepted |
| B | String / bool / null / object / nested-array **inside samples** | `json: expected number` → **rejected** | rejected |
| B | `samples` missing | `json: missing key 'samples'` → rejected | rejected |
| B | `samples` not an array | `json: items() on non-array` → rejected | rejected |
| C | Empty `samples` | parses, `computed=false`, **never fabricated** | asserted |
| C | 9 samples | parses (schema-valid) but never enough for G7 | asserted |
| C | Empty samples on PASSED record | `validate()` rejects → never reaches a gate | `!accepted_as_evidence` |
| D | `nan`/`NaN`/`inf`/`Infinity`/`1e400` in text | parser rejects each (`std::runtime_error`) | rejected |
| D | NaN / +inf / −inf **constructed** in memory | G7 **FAIL** (fail closed) | `!gate_pass` |
| D | Non-finite **stored median** constructed | G7 FAIL | `!gate_pass` |
| E | Missing / string / bool / null / object / malformed median | all rejected at decoder, **never coerced to 0** | rejected |
| F | Correctly typed but **incorrect** stored median | decodes, `validate()` empty, **G7 still FAIL** | `!gate_pass` |
| G | `computed` missing / string / int / null | rejected, never defaulted | rejected |
| G | `computed=false` constructed | G7 FAIL | `!gate_pass` |
| H | Correct valid record | decode → validate empty → **G7 PASS** | `gate_pass` |
| I | PASSED record with `statistics: null` | rejected by `validate()` or parser | `!accepted` |
| J | `RecordStore::loadAll` with malformed files | **reported** (`parse_ok=false`, non-empty error), siblings still load, nothing silently dropped | asserted |
| J | Aggregator strict contract | invalid > 0 ⇒ strict exit 1; non-strict governed by gates only | asserted |
| J2 | Real passing dataset + malformed sibling | all gates PASS, `invalid=1` ⇒ non-strict **0**, strict **1** | asserted |
| K | No records at all | G7 **FAIL** (fails closed) | `!gate_pass` |

**Result: 328 assertions, 0 failures, Debug and Release.**

Two tautological assertions found during self-review
(`CHECK(!x || true)`, `CHECK(true)` in a catch) were rewritten into real
either-or invariants before finalizing.

---

## 3. G7 production behavior verified from source

Inspected directly in `src/phase1/gates.cpp` (sha256 `7fd240a8…`), not inferred
from reports.

| Requirement | Source evidence | Status |
|---|---|---|
| Telemetry/profiler can't enter benchmark groups | `if (r.kind != "benchmark" && r.kind != "baseline") continue;` then `if (bench.empty()) continue;` | PASS |
| Only benchmark + baseline qualify | same guard | PASS |
| ≥10 finite raw samples | `verify_median_consistency` → `validate_samples` (size < 10 → fail; `!std::isfinite` → fail) | PASS |
| Stored median independently recomputed | `recompute_median()` re-derives from raw samples | PASS |
| Median consistency tolerance **0.001%** | `G7_MEDIAN_TOLERANCE_PCT = 0.001` (line 25) | PASS |
| ≥2 distinct record IDs per group | `std::set<std::string> seen` dedupe by `record_id`, then `valid_runs.size() < 2` → fail | PASS |
| Every pair compared | nested `i<j` all-pairs loop over `valid_runs` | PASS |
| Timing tolerance **15%** | `allowed = bandwidth ? 20.0 : 15.0` | PASS |
| B3/B5 bandwidth **20%** | `bench == "B3" \|\| bench == "B5"` → 20.0 | PASS |
| Failing group can't be overwritten | `overall_pass` starts true, only ever assigned `false`; diagnostics accumulate | PASS |
| Missing/invalid evidence fails closed | no-statistics / not-computed / <10 samples / bad median each set `overall_pass = false` | PASS |

**Thresholds were not modified.** Confirmed by diffing the constants above
against the pre-change source hash `0cbb31dc…` → post-change `7fd240a8…`;
the only delta is the two fail-closed `try/catch` blocks in §3.1.

### 3.1 Defect found & fixed: two fail-open crash paths

While auditing §3's "missing or invalid evidence fails closed" requirement, I
found evidence that **passes `ExperimentRecord::validate()` but crashes
`evaluate_gates()`** — an uncaught `std::runtime_error` aborts the aggregator
(exit 127, both configs), which violates §2 ("no crash") and §3 ("fail closed").

Reproduced with real fixtures through the **real aggregator binary**:

```
fixtures/probe-malformed-profile      → exit=127  what(): json: missing key 'cpu_model'
fixtures/probe-malformed-accounting   → exit=127  what(): json: expected uint
```

Root cause — two unguarded decoders inside `evaluate_gates`:

- **G1:** `StaticHardwareProfile::from_json(hw_rec.hardware)` — throws on any
  missing required key (guarded only by `!hardware.isNull()` upstream).
- **G5:** `ParameterAccounting::from_json(r.accounting)` — throws on a
  wrong-typed value (guarded only by `isObject()` upstream).

**Fix:** wrap both decoders in `try/catch`; on exception the gate is set to
`FAIL` with a `malformed …` detail string. No threshold, tolerance, or
acceptance condition changed.

After the fix (both configs, real aggregator):

```
probe-malformed-profile     exit=1  [FAIL] G1  malformed PROFILE hardware snapshot: json: missing key 'cpu_model'
probe-malformed-accounting  exit=1  [FAIL] G5  E1: malformed accounting block: json: expected uint
```

Audit of every other `.get()` in `gates.cpp` (lines 135–280): all are preceded
by `.has()` or a type check — G1/G5 were the only unguarded sites.
Regression tests assert **no throw escapes** and that both gates **fail closed
with a reason**.

---

## 4. Historical record recovery — BLOCKED

**Requested archive:** `My Local AI(20261003-134219).zip`
**Required SHA-256:** `cb5e85e8b446ef0a0c0acf64f4151142489a73c9a9cb0cb5c6f5d28e92fdc733`
**Claimed contents:** 24 historical JSON records + `tiny_dense_2l_weights.bin`

### Search performed

| Check | Result |
|---|---|
| Exact filename, both mounted drives (only `C:` and `E:` exist — `df` confirms) | **not found** |
| `find` by timestamp token `*134219*` / `*20261003-134219*`, depth 6 across `/c/Users/rahul` + `/e` | **0 hits** |
| SHA-256 of every `.zip` on `E:` (root, project, recycle bin `$R*.zip` ×11) | **no match** (all recorded in §4.1) |
| SHA-256 of both nested project archives (`stark-M0-v1.4/v1.5-source.zip`) | no match |
| `E:/My Local AI.zip` (132,646,864 B) full entry listing — 2,531 entries, 177 JSON | **no named archive entry, no nested zip other than the two source snapshots, no 24-record directory** |
| Directories holding 20–40 JSON files | none matching a 24-record set |
| ZIP integrity (`unzip -t`) of all 3 available archives | OK (but none is the requested one) |
| `archive_recovery/` (created for this step) | present, **empty** |

### 4.1 Checksums actually observed

```
target  cb5e85e8b446ef0a0c0acf64f4151142489a73c9a9cb0cb5c6f5d28e92fdc733   NOT FOUND
E:/My Local AI.zip            7140bd2dfb48c879fae344d51d57d81f1ce1705f3fb3ac3c67890f5dc9bf8eb7
stark-M0-v1.4-source.zip      8a36448e8903b66ca3af02f5c6a1c095be85e3cb3d7c07d9a5794a930114af25
stark-M0-v1.5-source.zip      d0790ed03262f109c340ccb2eb282728cce3bf9857c5c13ee802b250b7b41d0a
$R0D91TC.zip 1f21ce6d…   $R40N2LB.zip a4807b67…   $RCCNQMF.zip 63bb5c7c…
$RFQUATV.zip d7a09878…   $RGZFRLX.zip 48cfbe76…   $RHIN5WP.zip dfa887f9…
$RHLGTBA.zip 1fd7f71b…   $RKORPON.zip d0eae8ca…   $RKQ1DSM.zip 21867564…
$RQA95VK.zip 7d82d533…   $RXZVCGE.zip db4419ea…   $RZZJEBG.zip 863bc77f…
```

The spec's guard — *"never label the historical dataset unrecoverable while the
original archive is available"* — is **not** triggered: the archive is not
available on this host, so the honest BLOCKED classification applies. This is a
**data-availability blocker resolvable only by supplying the archive**; no
amount of tooling can synthesize the original 24 records.

### 4.2 Recovery inventory

| Category | Count | Detail |
|---|---|---|
| **Recovered** (from archive) | **0** | archive absent → extraction impossible |
| **Missing** | **24 JSON** + archive's `tiny_dense_2l_weights.bin` | cannot be enumerated without the archive; per-file comparison not possible |
| **Duplicates** (recovered vs current) | **0 comparisons possible** | requires both sides |
| **Regenerated** | **6** | `build/historical-regen/` — E1/E5 × B6/B7/B9, from preserved source, **clearly labelled regenerated, never presented as historical** |
| Surviving originals | **3** | `build/results/` — E1 × B6/B7/B9 (pre-existing; untouched) |
| Weights file in working tree | **12 copies** | not the archive's copy |

**No historical measurement was overwritten, moved, or fabricated.** Regenerated
records live only in `build/historical-regen/`.

---

## 5. Build environment repaired (no hand-edited `build.ninja`)

### 5.1 Root cause

The default `g++` is **MinGW.org GCC 6.3.0-1** (`C:/MinGW/bin/g++.exe`,
target `mingw32`), whose libstdc++ ships **no `<optional>`** — only
`<experimental/optional>`, and that header's `experimental/type_traits` lacks
the `std::is_void_v` / `is_integral_v` aliases the tree needs. Confirmed by
probe: `fatal error: optional: No such file or directory`.

### 5.2 Verified replacement toolchain

| Item | Value |
|---|---|
| `g++` path | `C:/Users/rahul/AppData/Local/Microsoft/WinGet/Packages/BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe/mingw64/bin/g++.exe` |
| `g++ --version` | `g++.exe (MinGW-W64 x86_64-ucrt-posix-seh, built by Brecht Sanders, r4) 16.1.0` |
| `-dumpmachine` | `x86_64-w64-mingw32` |
| C++17 stdlib | `mingw64/include/c++/16.1.0/optional` present |
| Standalone `#include <optional>` probe | **compile exit 0, run exit 0** (incl. `std::is_void_v`, `std::is_integral_v`) |
| Include search (`g++ -E -x c++ -v`) | first entry `…/include/c++/16.1.0` (full list captured in `toolchain_manifest.json`) |
| CMake | 4.4.1 |
| Ninja | 1.13.2.git.kitware.jobserver-pipe-1 |
| CMake compiler identification | `The CXX compiler identification is GNU 16.1.0` |
| CMake cache toolchain | `CMAKE_CXX_COMPILER:STRING=C:/Users/…/mingw64/bin/g++.exe`, `CMAKE_GENERATOR:INTERNAL=Ninja` |

### 5.3 Fresh configure/build/test (both configs)

Directories were **deleted and recreated** before configuring. No generated
build file was hand-edited.

```
cmake -S . -B build-v18-debug -G Ninja \
  -DCMAKE_CXX_COMPILER="$WINLIBS/bin/g++.exe" \
  -DCMAKE_C_COMPILER="$WINLIBS/bin/gcc.exe" \
  -DCMAKE_MAKE_PROGRAM="$(which ninja)" -DCMAKE_BUILD_TYPE=Debug \
  -DCMAKE_CXX_STANDARD=17 -DCMAKE_CXX_STANDARD_REQUIRED=ON -DCMAKE_CXX_EXTENSIONS=OFF
  → configure_debug_exit=0   (compiler identification GNU 16.1.0)

cmake --build build-v18-debug   → build_debug_exit=0   [103/103]  errors: 0
ctest --test-dir build-v18-debug --output-on-failure → ctest_debug_exit=0  100% passed, 6/6

cmake -S . -B build-v18-release … -DCMAKE_BUILD_TYPE=Release
  → configure_release_exit=0
cmake --build build-v18-release → build_release_exit=0  [103/103]  errors: 0
ctest --test-dir build-v18-release --output-on-failure → ctest_release_exit=0  100% passed, 6/6
```

Registered tests actually **executed** (6/6, both configs):
`test_phase1_profiler`, `test_phase1_accounting`, `test_phase1_budget`,
`test_phase1_records`, `test_phase1_reproducibility`, `test_phase1_gates`.

Direct runs: `test_phase1_gates.exe` → `PASS: test_phase1_gates (328 assertions)`
in both Debug and Release, exit 0.

Logs: `build-v18-{debug,release}/{configure,build,ctest}.log`.

> The superseded v1.1 report claimed "GCC 16.1.0 cannot execute any compiled
> executable … Release loads-fail". **That claim is now false**: all 24
> executables in both configs run correctly (every CTest test and 48 aggregator
> invocations executed successfully).

---

## 6. Real aggregator execution

`aggregate.exe` (production binary from `src/phase1/aggregate.cpp`) run over
every required input in **both** configs, **normal + `--strict`** = 48 runs.
Reproducible driver: `scripts/run_aggregator_matrix_v18.sh`.
Full logs + per-run TSVs: `reports/v18-aggregator/`.
**Debug and Release outputs are byte-identical.**

| Input | Purpose | exit (normal) | exit (strict) | Gates | invalid |
|---|---|---|---|---|---|
| `build/historical-regen` | current **regenerated** records | 1 | 1 | G1,G3,G7 FAIL | 0 |
| `build/results` | 3 surviving originals | 1 | 1 | G1,G2,G3,G4,G7 FAIL | 0 |
| `fixtures/v14-valid` | fresh production runs | 1 | 1 | G7 FAIL | 0 |
| `fixtures/controlled-valid` | controlled **valid** | **0** | **0** | **all 7 PASS** | 0 |
| `fixtures/controlled-invalid-g2` | controlled invalid **G2** | 1 | 1 | G2,G4,G7 FAIL | 0 |
| `fixtures/controlled-invalid-g4` | controlled invalid **G4** | 1 | 1 | G4 FAIL | 0 |
| `fixtures/controlled-invalid-g7` | controlled invalid **G7** | 1 | 1 | G7 FAIL | 0 |
| `fixtures/controlled-g7-endpoint-outlier` | endpoint-outlier G7 | 1 | 1 | G7 FAIL | 0 |
| `fixtures/controlled-invalid-raw-sample` | **invalid raw-sample** | 0 | **1** | all PASS (bad record excluded) | **1** |
| `fixtures/controlled-incorrect-stored-median` | **incorrect stored median** | 1 | 1 | G7 FAIL | 0 |
| `fixtures/probe-malformed-profile` | G1 fail-closed (§3.1) | 1 | 1 | G1 FAIL | 0 |
| `fixtures/probe-malformed-accounting` | G5 fail-closed (§3.1) | 1 | 1 | G5 FAIL | 0 |
| **Recovered original historical records** | §4 requirement | — | — | **BLOCKED — 0 records; archive absent** | — |

Key observations:

- **`controlled-invalid-raw-sample`**: the malformed record is reported as
  `INVALID RECORDS (1): … json: expected number` — never coerced, never
  silently dropped, never forms a group. Non-strict exits 0 (gates over the
  remaining valid records all pass); **`--strict` exits 1**. Exactly the
  specified contract.
- **`controlled-incorrect-stored-median`**: G7 rejects the record through
  independent recomputation — `stored=0.000851, recomputed=0.000284
  (diff=66.666667%, allowed=0.001000%)` → exit 1.
- **`historical-regen` real G7 failure (honest):**
  `B6 medians differ 16.13% (allowed 15.00%)`, `B7 18.38%`, `B9 28.18%` → G7
  **FAIL**, plus G1 (no PROFILE record) and G3 (no E2 record) in that directory.
- **`controlled-valid`** proves the gate set can pass: G1–G7 all PASS, exit 0
  in both configs and both modes.

**No historical benchmark result was fabricated, and no G7 success is claimed
on the basis of synthetic fixtures alone.**

---

## 7. Evidence reconciliation

| Artifact | Path |
|---|---|
| This report | `reports/M0_FINAL_REPORT_v1.8.md` |
| Evidence manifest | `reports/evidence_manifest.json` |
| Toolchain manifest | `reports/toolchain_manifest.json` |
| Source-change manifest | `reports/source_change_manifest.json` |
| Historical-artifact inventory | `reports/historical_artifact_inventory.json` |
| Gate result JSONs | `reports/gate_results/G2.json`, `G4.json`, `G7.json` |
| Aggregator matrix + 48 logs | `reports/v18-aggregator/` |
| Build/CTest evidence | `build-v18-debug/`, `build-v18-release/` (`configure.log`, `build.log`, `ctest.log`) |
| SHA-256 list | `reports/sha256sums_v18.txt` |
| Superseded reports (preserved) | `reports/historical/superseded/M0_FINAL_REPORT_v1.1.md`, `…_v1.6.md` |

Every claim above maps to a source hash, a captured exit code, or a log file.

---

## 8. Final decision table

Categories are stated explicitly as required.

| # | Criterion | Category | Decision |
|---|---|---|---|
| 1 | `samplesB` declaration corrected without weakening test data | Source inspection | **PASS** |
| 2 | A/B ≥10 finite samples, genuinely different, medians exactly 1.0 | CTest execution | **PASS** |
| 3 | Same serialized config + distinct record IDs | CTest execution | **PASS** |
| 4 | `evaluate_gates()` returns G7 PASS for that pair | CTest execution | **PASS** |
| 5 | Out-of-tolerance pair returns G7 FAIL | CTest execution | **PASS** |
| 6 | Tests not replaced with identical/constant helper arrays | Source inspection | **PASS** |
| 7 | Boundary tests through `Statistics::from_json` | CTest execution | **PASS** |
| 8 | Boundary tests through `ExperimentRecord::parse` | CTest execution | **PASS** |
| 9 | Boundary tests through `RecordStore::loadAll` | CTest execution | **PASS** |
| 10 | Aggregator record loading + strict-mode handling | CTest execution | **PASS** |
| 11 | Full §2 coverage matrix (328 assertions, 0 failures, 2 configs) | Successful compilation + CTest | **PASS** |
| 12 | Malformed input rejected: no crash / coercion / silent drop / accidental G7 PASS | CTest + aggregator | **PASS** |
| 13 | JSON schema preserved (no unapproved schema change) | Source inspection | **PASS** |
| 14 | G7: telemetry/profiler excluded; only benchmark/baseline qualify | Source inspection | **PASS** |
| 15 | G7: ≥10 finite samples; independent median recompute | Source inspection | **PASS** |
| 16 | Median tolerance remains 0.001% | Source inspection | **PASS** |
| 17 | ≥2 distinct record IDs; every pair compared | Source inspection | **PASS** |
| 18 | Timing 15% / B3-B5 bandwidth 20% unchanged | Source inspection | **PASS** |
| 19 | Failing group cannot be overwritten by a later passing group | Source inspection + CTest | **PASS** |
| 20 | Missing/invalid evidence fails closed | Source inspection + aggregator | **PASS** (2 defects found & fixed, §3.1) |
| 21 | Verify archive checksum + ZIP integrity | Source inspection | **BLOCKED** — file absent |
| 22 | Extract original results to separate recovery dir | — | **BLOCKED** — archive absent |
| 23 | Preserve original archive unchanged | — | **NOT APPLICABLE** — archive not present to modify |
| 24 | Compare recovered vs current dataset | — | **BLOCKED** — 0 recovered |
| 25 | Exact inventory: recovered/missing/duplicate/regenerated | Source inspection | **PASS** — produced (§4.2), with archive-absent annotations |
| 26 | Never label unrecoverable while archive available | Source inspection | **PASS** — archive verified unavailable first |
| 27 | Never overwrite historical measurements with regenerated data | Source inspection | **PASS** — regen isolated to `build/historical-regen/` |
| 28 | Exact `g++.exe` path / version / C++17 availability recorded | Source inspection | **PASS** |
| 29 | Standalone `#include <optional>` probe + include search paths | Successful compilation | **PASS** |
| 30 | CMake compiler identity + toolchain recorded | Source inspection | **PASS** |
| 31 | Fresh `build-v18-debug` + `build-v18-release` from scratch | Successful compilation | **PASS** — 103/103 × 2, exit 0 |
| 32 | All six CTest tests executed, both configs, `--output-on-failure` | Successful CTest execution | **PASS** — 6/6 × 2, exit 0 |
| 33 | Configure/build/CTest logs + exit codes captured | Source inspection | **PASS** |
| 34 | Source hashes for the tested tree recorded | Source inspection | **PASS** |
| 35 | No hand-edited `build.ninja`; no configure-only dir counted | Source inspection | **PASS** |
| 36 | Aggregator on recovered historical records | Production aggregator | **BLOCKED** — 0 records available |
| 37 | Aggregator on current regenerated records | Production aggregator | **PASS** — exit 1 (G1/G3/G7 FAIL, reported honestly) |
| 38 | Aggregator on controlled valid fixture | Production aggregator | **PASS** — exit 0, all 7 gates PASS |
| 39 | Aggregator on controlled invalid **G2** fixture | Production aggregator | **PASS** — exit 1, G2 FAIL |
| 40 | Aggregator on controlled invalid **G4** fixture | Production aggregator | **PASS** — exit 1, G4 FAIL |
| 41 | Aggregator on controlled invalid **G7** fixture | Production aggregator | **PASS** — exit 1, G7 FAIL |
| 42 | Aggregator on endpoint-outlier G7 fixture | Production aggregator | **PASS** — exit 1, G7 FAIL |
| 43 | Aggregator on invalid raw-sample fixture | Production aggregator | **PASS** — exit 0 normal / 1 strict, 1 invalid reported |
| 44 | Aggregator on incorrect stored-median fixture | Production aggregator | **PASS** — exit 1, G7 median-mismatch |
| 45 | Exact outputs + exit codes captured; both configs agree | Source inspection | **PASS** — 48 runs |
| 46 | No fabricated historical results / no fixture-only G7 claim | Source inspection | **PASS** |
| 47 | `M0_FINAL_REPORT_v1.8.md` produced | Source inspection | **PASS** |
| 48 | Evidence/toolchain/source-change/inventory manifests + gate JSONs updated | Source inspection | **PASS** |
| 49 | Superseded reports moved (not deleted) | Source inspection | **PASS** — v1.1, v1.6 preserved |
| 50 | Debug + Release build/test evidence present | Source inspection | **PASS** |
| 51 | Every claim tied to source hashes, logs, archive state | Source inspection | **PASS** |
| 52 | **Real historical gate results (G2/G4/G7 over the 24 archive records)** | Real historical gate results | **BLOCKED** — archive absent; see G2/G4/G7 JSONs |
| 53 | No thresholds / neural interfaces / acceptance gates modified | Source inspection | **PASS** |

### Summary (53 rows, numbered 1–53, machine-tallied from the table above)

- **PASS:** 47
- **BLOCKED:** 5 (#21, #22, #24, #36, #52 — all traceable to the single absent archive)
- **FAIL:** 0
- **NOT APPLICABLE:** 1 (#23 — the archive is not present to preserve)

### M0 verdict

**BLOCKED** — solely on §4 (original archive `My Local AI(20261003-134219).zip`
not available on this host). The other 47 criteria are PASS with captured
evidence; nothing is FAIL.

Real historical G7 **does fail** on the data that does exist, and is reported
that way:

- `build/historical-regen` (regenerated): G7 **FAIL** — 16.13% / 18.38% /
  28.18% vs 15% allowed.
- `build/results` (3 surviving originals): G7 **FAIL** — no independent repeat
  for B6/B7/B9 (only 1 valid execution each).
- G2/G4/G7 over the **24 archive records**: **BLOCKED**, not PASS and not
  silently downgraded.

**Do not begin M1. Do not implement APEX features. Do not modify protected
neural interfaces, historical measurements, or acceptance thresholds.**
