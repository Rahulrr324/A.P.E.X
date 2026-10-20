# Phase 63 — Test Coarse-Grained Component Timing

## Summary

**Classification: PARTIAL**

I tested the hypothesis that per-operation stage clock reads inside
`instrumented_op_batch()` are responsible for the B7 diagnostic's
instrumentation overhead. I added a controlled coarse-grained component-timing
mode that performs **no** per-operation clock reads during the measured batch,
while preserving the exact production open/read/deserialize statement sequence
and the independent outer batch timer. I rebuilt the diagnostic from source,
ran both modes under the same protocol (6 replicates × 50 measured iterations,
batch 50, INTERLEAVED), and validated each resulting CSV with the **unchanged,
frozen** Phase 33 validator (profile `six`) plus an independent recompute.

**Result: the hypothesis is not supported by the data.** Removing the clock
reads did **not** bring calibration within the frozen thresholds in either
direction. Both modes fail all three thresholds, and the coarse mode does not
reliably reduce the worst-case signed overhead relative to the fine mode. The
instrumented condition continues to behave inconsistently with the minimal
condition in a way that per-operation timer cost alone cannot explain.

Because the gate remains unsatisfied and the controlled comparison does not
isolate a clear timer-perturbation win, M0 stays FAIL and M1 stays LOCKED. No
validator, formula, threshold, historical evidence, or M0/M1 state was modified.

---

## 1. Starting and Final Git Status

### Starting state (Phase 63 entry)
- `git rev-parse HEAD` = `76466a8f15ca16d0bef0e83559b931e45b61a3f2` (commit `62`)
- `git status --short` (start of Phase 63, after the previous session resumed):
  the working tree carried the Phase 62 edits plus several pre-existing untracked
  directories; the **committed** source under test was at `76466a8` (commit `62`).
- The Phase 62 working tree already contained the Phase 63 edit to
  `bm_b7_diagnostic.cpp` from the earlier interrupted session. I verified this by
  reading the file and by `git diff` against `HEAD`.

### Final state (after this phase)
- `git rev-parse HEAD` = `76466a8f15ca16d0bef0e83559b931e45b61a3f2` (unchanged; no commit, no push)
- `git status --short` (final, see §7):
  - `M stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp`
  - `M stark/build-b7diag-fresh-p39b/Release/bm_b7_diagnostic.exe`
  - `M stark/build-b7diag-fresh-p39b/bm_b7_diagnostic.dir/Release/bm_b7_diagnostic.obj`
  - several `??` untracked artifacts (build run dirs, scratch smoke dirs, the
    repro build tree, and this phase's capture/output files). The **committed**
    history is unchanged.

The only source file changed by Phase 63 is
`stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp`. The Phase 33 validator,
frozen formulas/thresholds, historical reports, and all prior captures were not
touched.

---

## 2. Changed-File Inventory and Source Diff

### Changed files (Phase 63)
- `stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp` — **one file**, the only
  intentional source change of this phase.
- Build products updated to match: the rebuilt `bm_b7_diagnostic.exe` and
  `bm_b7_diagnostic.obj` in `stark/build-b7diag-fresh-p39b/`. These are build
  outputs, not source; they are tracked here for provenance.
- Untracked artifacts added during the phase: the `phase63_*` capture directories
  and their provenance files, the `stark/build-b7diag-repro-p63/` from-source
  rebuild tree and its runtime log, and scratch smoke directories that were
  removed before the final report was written.

### Source diff (committed `76466a8` → working tree)
The full diff is preserved in
[phase63_source_diff.txt](work/b7_diag_20261011_paired_capture/phase63_source_diff.txt)
(225 lines, 97 insertions, 12 deletions). The change is a single coordinated
addition; the structural summary is:

1. **New enum and protocol field**
   - `ComponentTiming { FINE, COARSE }` (lines ~188–189), with a comment
     documenting what each mode measures and what it does not.
   - `Protocol::component_timing`, default `FINE` (line ~196), so the
     production behavior is unchanged unless the flag is passed.

2. **`instrumented_op_batch()` — COARSE branch** (lines ~546–580)
   - When `timing == ComponentTiming::COARSE`, the function runs exactly the
     same per-iteration statement sequence as the fine mode:
     ```
     std::ifstream f(path, std::ios::binary);
     if (!f) throw std::runtime_error("cannot open weight blob");
     std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(f)),
                                  std::istreambuf_iterator<char>());
     loader.deserializeWeights(bytes);
     ```
     repeated `batch_size` times, with **no** stage clock reads.
   - The caller's independent outer timer still brackets the whole call, so the
     total batch timing is unaffected and identical in structure to the fine mode.
   - `open_sec`, `read_sec`, `deser_sec`, and `residual_sec` are set to
     `quiet_NaN()` as an explicit **"not measured"** marker. These NaN values are
     never summarized: the render path guards on
     `component_timing == ComponentTiming::COARSE` and prints a plain text
     "NOT MEASURED" note instead. No decomposition is estimated, scaled, or
     fabricated from the fine mode.

3. **`instrumented_op()` — COARSE forwarding** (lines ~597–607)
   - For `timing == COARSE`, `instrumented_op()` delegates to
     `instrumented_op_batch(..., timing)` regardless of batch granularity, so
     no stage clocks are emitted for single-op or batch calls.

4. **Thread the flag through the run paths** (lines ~716–877)
   - All `instrumented_op(...)` call sites in `run_replicate_interleaved()` and
     `run_replicate()` pass `proto.component_timing`, including the warmup discards.

5. **Render the mode in the report** (lines ~1217–1295)
   - The `measurement_mode=...` line now also prints
     `component_timing=FINE (...)` or `component_timing=COARSE (...)`.
   - The component-decomposition block is conditional: COARSE prints
     "NOT MEASURED — ..." and FINE prints the pooled component summary, so the
     report identifies which mode produced each result.

6. **CLI: `--component-timing` flag** (lines ~1713–1829)
   - Accepted values: `fine` or `coarse`.
   - Rejects missing value, option-as-value, duplicate, and invalid value with
     exit code 2. Default is `fine`.

### What I did **not** change
- The production open/read/deserialize statement sequence is identical in both
  modes.
- The independent outer batch timer in `run_replicate_interleaved()` and
  `run_replicate()` is unchanged.
- Total batch time, CSV columns, the frozen calibration formulas, the validator,
  and all thresholds are unchanged.
- No other file was modified.

### Limitation I did **not** overcome
- Accurate per-operation open/read/deserialize decomposition **cannot** be
  obtained in COARSE mode without per-operation timers. That is the point of the
  mode: it trades decomposition for reduced timer-call perturbation. The report
  states this explicitly. I did not invent a decomposition and did not claim that
  COARSE isolates individual stages.

---

## 3. Build Commands, Logs, Exit Codes, and Hashes

### Build configuration (verified)
- CMake generator: `Visual Studio 16 2019`, platform `x64` (from
  `stark/build-b7diag-fresh-p39b/CMakeCache.txt`).
- Toolchain found on this machine for a clean reconfigure:
  - `cmake.exe` = `C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe`
  - `MSBuild.exe` = `C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\MSBuild\Current\Bin\MSBuild.exe`

### The capture executable used for the two main captures
- Built in the prior session and reused here:
  - Path: `stark/build-b7diag-fresh-p39b/Release/bm_b7_diagnostic.exe`
  - SHA-256: `b547d3ecacd8da0f4ca61c09da8a1115fe555808964e5abca8531c63e1a6120d`
  - Size: 131,072 B
  - mtime: 2026-10-19 21:03 (UTC+0530)
- Note: the Phase 61 report records a **provenance gap** for that build — no
  build stdout log and no build exit-code file were captured at the time. The
  executable is used as-is for the two main captures in this phase; its behavior
  (correct protocol, correct CSV shape, correct CLI parsing) is independently
  evidenced by the artifacts below. I also performed a **clean from-source
  rebuild** in this phase to close that gap for at least one executable; see the
  repro build below.

### Clean from-source rebuild performed in this phase (prose/repro build)
To obtain a build whose stdout, exit code, and compile command are all preserved
on disk, I reconfigured and built `bm_b7_diagnostic` from a clean directory.

**Command (PowerShell, `p63_rebuild8.ps1` style, finally successful as
`p63_rebuild10.ps1`):**
```
cmake.exe -S stark -B stark/build-b7diag-repro-p63
    -G "Visual Studio 16 2019" -A x64
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_STANDARD=17
MSBuild.exe stark/build-b7diag-repro-p63/STARK-006.sln
    /t:bm_b7_diagnostic /p:Configuration=Release /p:Platform=x64
    /maxcpucount /nodeReuse:false
```

**Preserved log:** `stark/build-b7diag-repro-p63/rebuild_runtime.log`
(SHA-256 `31ce726f11603579bffc8ad11051c9be48a0fc2e7982e962fe84a87ce8b8f8a0`).

**Log excerpt (key lines):**
```
CMAKE_OK
...
MSBUILD_EXIT=0
BUILD_OK
...
bm_b7_diagnostic.vcxproj -> E:\My Local AI\stark\build-b7diag-repro-p63\Release\bm_b7_diagnostic.exe
...
SHA256=57DE42C2F878DD1E48D8A7FCBD0397FC5339ADCC14A7B474A8056CB6F68F7030
```

**Compile command recorded in the log (cl.exe invocation):**
```
cl /c /I"E:\My Local AI\stark\src"
   /I"E:\My Local AI\stark\src\phase1"
   /nologo /W1 /WX- /diagnostics:column /O2 /Ob2
   /D WIN32 /D _WINDOWS /D NDEBUG /D "CMAKE_INTDIR=\"Release\""
   /D _MBCS /Gm- /EHsc /MD /GS /fp:precise /Zc:wchar_t
   /Zc:forScope /Zc:inline /GR /std:c++17
   /Fo"bm_b7_diagnostic.dir\Release\"
   /Fd"bm_b7_diagnostic.dir\Release\vc142.pdb"
   /external:W1 /Gd /TP /errorReport:queue
   "E:\My Local AI\stark\src\phase1\diagnostics\bm_b7_diagnostic.cpp"
   "E:\My Local AI\stark\src\phase1\bench\TinyDenseModel.cpp"
   "E:\My Local AI\stark\src\phase1\bench\ParameterAccounting.cpp"
   "E:\My Local AI\stark\src\phase1\common\ExperimentRecord.cpp"
```
followed by a link step that produced the `.exe`.

**Build result:**
- MSBuild exit code: `0` (recorded in the log as `MSBUILD_EXIT=0` and
  `BUILD_OK`).
- Warnings: 2 (both `LNK4044: unrecognized option '/static-libgcc'/'/static-libstdc++'`,
  pre-existing and harmless for this MSVC link).
- Errors: 0.
- Resulting executable on disk:
  - Path: `stark/build-b7diag-repro-p63/Release/bm_b7_diagnostic.exe`
  - SHA-256: `57de42c2f878dd1e48d8a7fcbd0397fc5339adcc14a7b474a8056cb6f68f7030`
  - Size: 138,752 B

**Two-executable provenance note:** the from-source rebuild produced an
executable with a **different** SHA-256 than the prior `build-b7diag-fresh-p39b`
executable (`57de...` vs `b547...`). This is expected and benign: the prior build
was made with a different CMake run (different intermediate paths/timestamps/link
environment) and is not bit-identical to a clean reconfigure. Both executables
implement the same source tree and pass the same smoke/validation checks below.
For the two main protocol captures I used the prior executable
(`b547...`, `build-b7diag-fresh-p39b`) because it was already present and
evidenced; for the final self-contained artifact set I also ran the repro
executable (`57de...`) in both modes so the report carries a capture whose build
is fully on disk.

### Build exit codes
- `build-b7diag-fresh-p39b` executable: build exit code not preserved (prior
  session provenance gap; see above).
- `build-b7diag-repro-p63` executable: build exit code `0`, preserved in
  `rebuild_runtime.log`.

---

## 4. Exact Timing Modes and Protocol Settings

Both captures were run with the same protocol; only `component_timing` differs.

| Setting | Value | Notes |
|---|---|---|
| `warmup_count` | 30 (untimed) | from `kWarmupIterations` |
| `measurement_count` | 50 | matches Phase 33 validator profile `six`/`eight` (50 iterations/replicate) |
| `macro_replicates_per_condition` | 6 | minimum required by the protocol |
| `mode` | `INTERLEAVED` | paired replicates, counterbalanced order within the run |
| `batch_size` | 50 | 50 operations per timed sample |
| `component_timing` | `FINE` or `COARSE` | the only difference between the two captures |
| `measurement_mode` line in stdout | `INTERLEAVED batch_size=50 component_timing=FINE (...)` or `...COARSE (...)` | identifies which mode produced the result |
| Machine / executable / build | same for both | same host, same executable tree, same build |

Counterbalanced order (recorded in both stdout files):
```
replicate 0: MINIMAL then INSTRUMENTED
replicate 1: INSTRUMENTED then MINIMAL
replicate 2: MINIMAL then INSTRUMENTED
replicate 3: INSTRUMENTED then MINIMAL
replicate 4: MINIMAL then INSTRUMENTED
replicate 5: INSTRUMENTED then MINIMAL
```

### Capture executable and exact commands (the two main captures)

**FINE capture:**
```
stark/build-b7diag-fresh-p39b/Release/bm_b7_diagnostic.exe
    --measured-iterations 50 --batch-size 50 --component-timing fine
    --host-capture-dir work/b7_diag_20261011_paired_capture/phase63_fine_50
```
- Saved command: [phase63_fine_50_cmd.txt](work/b7_diag_20261011_paired_capture/phase63_fine_50_cmd.txt)
- Exit code: `0` ([phase63_fine_50_exit.txt](work/b7_diag_20261011_paired_capture/phase63_fine_50_exit.txt))
- Stderr: empty ([phase63_fine_50_stderr.txt](work/b7_diag_20261011_paired_capture/phase63_fine_50_stderr.txt))
- Stdout: [phase63_fine_50_stdout.txt](work/b7_diag_20261011_paired_capture/phase63_fine_50_stdout.txt) (4955 B)
- CSV: [phase63_fine_50/paired_samples.csv](work/b7_diag_20261011_paired_capture/phase63_fine_50/paired_samples.csv)
- CSV SHA-256: `88443bb26238de3bd4b0ff61aa0ecf16fba8a77dcd8027ac4ead0c5ba97cc706`
  ([phase63_fine_50_csv_sha256.txt](work/b7_diag_20261011_paired_capture/phase63_fine_50_csv_sha256.txt))
- Run-owned blob path recorded in stdout:
  `build/bm_b7_diagnostic/run_17924811424771468_0/bm_b7_diagnostic_weights.bin`,
  1,051,664 bytes.

**COARSE capture:**
```
stark/build-b7diag-fresh-p39b/Release/bm_b7_diagnostic.exe
    --measured-iterations 50 --batch-size 50 --component-timing coarse
    --host-capture-dir work/b7_diag_20261011_paired_capture/phase63_coarse_50
```
- Saved command: [phase63_coarse_50/cmd.txt](work/b7_diag_20261011_paired_capture/phase63_coarse_50/cmd.txt)
- Exit code: `0` ([phase63_coarse_50/exitcode.txt](work/b7_diag_20261011_paired_capture/phase63_coarse_50/exitcode.txt))
- Stderr: empty ([phase63_coarse_50/stderr.txt](work/b7_diag_20261011_paired_capture/phase63_coarse_50/stderr.txt))
- Stdout: [phase63_coarse_50_stdout.txt](work/b7_diag_20261011_paired_capture/phase63_coarse_50_stdout.txt) (4451 B);
  also duplicated in the capture dir as [phase63_coarse_50/stdout.txt](work/b7_diag_20261011_paired_capture/phase63_coarse_50/stdout.txt)
- CSV: [phase63_coarse_50/paired_samples.csv](work/b7_diag_20261011_paired_capture/phase63_coarse_50/paired_samples.csv)
- CSV SHA-256: `521a56f5012c4681daaf98d8843e52b24d17a250c1c12088f7caf01964eab7da`
  ([phase63_coarse_50/csv_sha256.txt](work/b7_diag_20261011_paired_capture/phase63_coarse_50/csv_sha256.txt))
- Run-owned blob path recorded in stdout:
  `build/bm_b7_diagnostic/run_17924785322393415_0/bm_b7_diagnostic_weights.bin`,
  1,051,664 bytes.

Both captures run sequentially and process-locally (not independent machine/session
replications); cache state is not controlled (warm-cache); no CPU affinity control;
no claim of cache-state or CPU-affinity equivalence with the historical campaign.
These limitations are stated in both stdout files and reused here verbatim.

### Counterbalanced condition order
Both captures used the same interleaved, counterbalanced per-replicate order
(MINIMAL-first on replicates 0,2,4; INSTRUMENTED-first on replicates 1,3,5). This
is the protocol's existing order; I did not add a new cross-run counterbalance
because both captures were run on the same machine with the same executable in the
same session.

---

## 5. Capture Provenance and Validation Results

### Structural validity (frozen Phase 33 validator, profile `six`, unmodified)

| Capture | Validator exit | `structural_pass` | `failed_checks` |
|---|---|---|---|
| FINE ([phase63_fine_50/paired_samples.csv](work/b7_diag_20261011_paired_capture/phase63_fine_50/paired_samples.csv)) | 2 | `true` | none (all 20 checks `ok`) |
| COARSE ([phase63_coarse_50/paired_samples.csv](work/b7_diag_20261011_paired_capture/phase63_coarse_50/paired_samples.csv)) | 2 | `true` | none (all 20 checks `ok`) |

Both CSVs are 301 lines (1 header + 300 data rows), exact header
`replicate,iteration,minimal_sec,instrumented_sec,signed_overhead_pct`, 300 unique
canonical `(replicate, iteration)` keys = {0..5}×{0..49}, all numerics finite,
all `minimal_sec` and `instrumented_sec` positive, and 0 row-formula violations
against `100*(instr-min)/min` within tolerance. Structural validity is **PASS** for
both.

### Calibration (frozen thresholds, unmodified)

| Mode | Validator `mean_overhead_pct` | Validator `worst_case_overhead_pct` | Validator `median_deviation_pct` | Independent recompute (mean / worst / median-dev) | Thresholds | Result |
|---|---|---|---|---|---|---|
| FINE | -4.807769% | 15.352377% | 4.642623% | -4.8078% / 15.3524% / 4.6426% | mean ≤2%, worst ≤10%, median-dev ≤2% | **FAIL** (all three) |
| COARSE | -6.384453% | 13.462879% | 6.491725% | -6.3845% / 13.4629% / 6.4917% | mean ≤2%, worst ≤10%, median-dev ≤2% | **FAIL** (all three) |

Validator exit code is **2** for both (structural PASS + calibration FAIL).

Supporting figures from the validator:
- FINE: `n_pairs=300`, `mean_minimal_sec=0.484073168`, `mean_instrumented_sec=0.460800048`,
  `median_minimal_sec=0.48041695`, `median_instrumented_sec=0.458113`,
  `min_pair_overhead_pct=-22.506842`, `count_pairs_over_10pct=2`.
- COARSE: `n_pairs=300`, `mean_minimal_sec=0.501471397`, `mean_instrumented_sec=0.469455189333`,
  `median_minimal_sec=0.49752335`, `median_instrumented_sec=0.4652255`,
  `min_pair_overhead_pct=-24.657842`, `count_pairs_over_10pct=1`.

The diagnostic's own stdout calibration lines agree with the validator to the
displayed precision:
- FINE stdout: `mean_overhead_pct = -4.8078 %`, `worst_case_overhead_pct = 15.3524 %`,
  `median_deviation_pct = 4.6426 %`.
- COARSE stdout: `mean_overhead_pct = -6.3845 %`, `worst_case_overhead_pct = 13.4629 %`,
  `median_deviation_pct = 6.4917 %`.

No outliers were clipped, filtered, or discarded.

### Independent recompute
I recomputed all three metrics directly from each CSV with Python's
`statistics.fmean` / `statistics.median`, using the frozen formulas verbatim:
```
mean_overhead_pct       = 100*(fmean(instr) - fmean(min)) / fmean(min)
worst_case_overhead_pct = max over aligned (by key) pairs of 100*(instr - min)/min   (signed, unclamped)
median_deviation_pct    = 100*|median(instr) - median(min)| / median(min)
```
The recompute matches the validator to 4–6 decimals in every case (see §5 table).
The independent recompute script and its output are preserved as part of the
command history that produced this report.

### Validation results: structural vs calibration (stated separately)
- Structural validation: **PASS** for both captures.
- Calibration acceptance: **FAIL** for both captures, on all three frozen
  thresholds.
- The gate is therefore unsatisfied for both modes.

---

## 6. All Three Metrics for Each Mode

### FINE mode (`component_timing=fine`, 4 stage clock reads per operation,
decomposition measured)
- Mean overhead: **-4.8078%** (≤2% required) → **FAIL**
- Worst signed aligned-pair overhead: **15.3524%** (≤10% required) → **FAIL**
- Median deviation: **4.6426%** (≤2% required) → **FAIL**

### COARSE mode (`component_timing=coarse`, no per-operation stage clock reads
during the measured batch, decomposition not measured, never estimated)
- Mean overhead: **-6.3845%** (≤2% required) → **FAIL**
- Worst signed aligned-pair overhead: **13.4629%** (≤10% required) → **FAIL**
- Median deviation: **6.4917%** (≤2% required) → **FAIL**

### Comparison to the Phase 61 baseline (same protocol family, different run)
Phase 61 (`phase61_test_b50`, FINE, batch 50, 6×50):
- Mean: 5.796377%, worst: 15.812366%, median-dev: 5.667681%.

Both Phase 63 modes are in the same broad range as Phase 61, and neither satisfies
the gate. The signs differ run to run (FINE negative here, positive in Phase 61),
which is itself evidence that run-to-run system variability dominates the observed
mean overhead.

---

## 7. Evidence for or against the Timer-Perturbation Hypothesis

### What the fine mode's own component decomposition says
In the FINE capture, the pooled INSTRUMENTED component decomposition (µs, pooled
across valid replicates) is:
- open: median 102.229 µs, mean 105.194 µs, stdev 27.095 µs
- read: median 8910.537 µs, mean 8955.472 µs, stdev 443.153 µs
- deserialize: median 69.682 µs, mean 70.697 µs, stdev 7.563 µs
- residual = total − (open+read+deserialize): median 84.631 µs, mean 84.638 µs,
  stdev 6.988 µs, CV 8.26%, max 134.738 µs

So per-operation residual (clock reads + call/return + stream teardown) is on the
order of **~85 µs/op**, and the per-operation read stage dominates the measured
batch at ~8,900 µs/op. The **difference between conditions** in this capture is
large and negative in the mean: INSTRUMENTED pooled mean 460,800 µs vs MINIMAL
pooled mean 484,073 µs, i.e. the instrumented condition ran **faster** on average
here. That already shows per-operation clock reads are not a simple additive
penalty that uniformly inflates the instrumented condition.

### What the coarse mode says
In the COARSE capture, the instrumented condition's pooled mean is 469,455 µs vs
the minimal pooled mean of 501,471 µs — again instrumented is faster on average,
and the worst signed pair is 13.46% (one pair over 10%).

If the hypothesis were "per-operation clock reads are the dominant cause of the
instrumented overhead and removing them brings the gate back within limits," the
coarse mode should have:
1. removed the residual/component timing cost from the instrumented condition,
2. left the minimal condition essentially unchanged (same production sequence,
   same independent total timer),
3. and therefore moved the mean overhead, worst-case pair, and median deviation
   toward (or into) the thresholds.

None of those happened in a gate-passing way:
- The mean overhead moved from -4.81% (FINE) to -6.38% (COARSE) — i.e. the
  instrumented condition became **more** negative relative to minimal, not closer
  to zero.
- The worst signed pair moved from 15.35% (FINE) to 13.46% (COARSE) — a small
  reduction, but still above the 10% threshold and with only one pair over 10% in
  the coarse capture versus two in the fine capture. This is not a reliable
  improvement; it is within run-to-run variability.
- The median deviation moved from 4.64% (FINE) to 6.49% (COARSE) — worse, not
  better.

### The key observation: the minimal condition also moves
The minimal condition's pooled mean moved from 484,073 µs (FINE capture) to
501,471 µs (COARSE capture) — a ~17,398 µs shift in the **minimal** condition
between the two runs. Since the minimal condition has no component timers in either
mode, this shift is **not** explainable by the clock-read change. It is run-to-run
system variability (warm-cache loading, scheduler, background load, memory layout,
etc.). That variability is large enough to swamp the ~85 µs/op residual we would
hypothesize from clock reads.

### Conclusion on the hypothesis
- The controlled comparison **does not support** the hypothesis that per-operation
  stage clock reads are the dominant cause of the B7 diagnostic's calibration
  failure.
- Removing the clock reads did not produce a gate-passing capture in either mode.
- The minimal condition varies by far more between the two runs than the
  per-operation residual we would attribute to clock reads, so the experiment
  cannot isolate a small timer-perturbation effect against this background — it can
  only show that removing the reads did not produce an obvious win.
- I did not prove the hypothesis false in an absolute sense; I proved that, under
  this protocol and on this machine with this executable, the coarse mode is not a
  reliable calibration improvement and does not, by itself, resolve the failure.

### What would be needed to settle it
A proper isolation would require either:
- a within-run crossover where the same replicatescompare FINE vs COARSE on the
  minimal condition as a control (which the current protocol does not provide, and
  which would itself need careful construction to avoid confounds), or
- a much larger number of replicates/runs to separate clock-read cost from system
  variability, or
- a different instrumentation strategy that removes the perturbation without
  changing the measured operation's cache/branch/IO behavior.

The current experiment is a controlled comparison, not a measurement of the
clock-read cost in isolation.

---

## 8. Limitations and the Next Engineering Step

### Limitations of this phase
1. **Two runs, one per mode.** Each mode is a single 6×50 interleaved run. There is
   no within-mode replication across independent runs, so the comparison is
   confounded by run-to-run system variability. The minimal condition's ~17,000 µs
   shift between the two runs is the clearest symptom.
2. **No within-run FINE-vs-COARSE crossover on the same replicate set.** The two
   captures are separate invocations. A genuine controlled test of the hypothesis
   would need the same replicates measured under both timing granularities, with
   the minimal condition as a control in both.
3. **Single machine, warm-cache, no affinity control.** As stated in the
   diagnostic's own limitations and repeated here.
4. **Provenance gap for one executable.** The main capture executable
   (`build-b7diag-fresh-p39b`) was built in a prior session with no captured build
   stdout/exit code. I closed that gap partially by performing and preserving a
   clean from-source rebuild (`build-b7diag-repro-p63`, log on disk), and I ran
   that repro executable in both modes as a final self-contained artifact set (see
   below). The two main protocol captures still use the earlier executable.
5. **COARSE mode cannot provide a decomposition.** By construction, open/read/
   deserialize/residual are unavailable in COARSE mode and are never estimated from
   FINE-mode values. So COARSE can test total-overhead behavior but cannot isolate
   which stage dominates.

### Preserved final self-contained artifact set (from-source rebuild executable,
both modes)
To give the report a fully on-disk build provenance, I also ran the clean
from-source rebuilt executable in both modes with the identical protocol:

- Repro executable: `stark/build-b7diag-repro-p63/Release/bm_b7_diagnostic.exe`
  SHA-256 `57de42c2f878dd1e48d8a7fcbd0397fc5339adcc14a7b474a8056cb6f68f7030`
- Repro build log: `stark/build-b7diag-repro-p63/rebuild_runtime.log`
  SHA-256 `31ce726f11603579bffc8ad11051c9be48a0fc2e7982e962fe84a87ce8b8f8a0`
- FINE repro capture: `p63final_fine/paired_samples.csv`
  SHA-256 `b79550aa0d1af5f5b08705717021c498fc53e0d538f2c55052760c38125fb6f9`
  - Validator exit 2, structural PASS, calibration FAIL:
    mean -11.596987%, worst 20.336247%, median-dev 11.980082%.
- COARSE repro capture: `p63final_coarse/paired_samples.csv`
  SHA-256 `43f0cd2290f8b17ef003f590ca5261073781ff2be4839d79c53d080f3dfa144f`
  - Validator exit 2, structural PASS, calibration FAIL:
    mean -4.089356%, worst 14.418567%, median-dev 4.398359%.

These are consistent with the main captures: both modes fail, and the coarse mode
does not reliably improve the worst-case pair. The repro run's FINE mean (-11.60%)
and worst (20.34%) are even farther from the gate than the main FINE capture,
underscoring run-to-run variability.

### Next meaningful engineering step
The hypothesis that per-operation clock reads alone explain the B7 calibration
failure is **not supported** by this controlled comparison. The next step is not to
chase the gate by swapping timing granularity, but to test a stronger isolation:
a within-run design that measures the same replicate set under FINE and COARSE with
the minimal condition as a control, or a larger number of independent runs, so that
clock-read cost can be separated from system variability. If a future experiment
still shows no reliable coarse-mode win, the more likely remaining causes are
instrumented-path cache/branch/IO behavior differences and run-to-run variability,
and the next engineering work should target those rather than the clock reads
themselves.

---

## 9. Verified vs Unverified, Blockers, Classification

### Verified (this phase, with actual results)
- Git state: HEAD `76466a8`; final `git status --short` listed above (§1, §9).
- Source change: one file, `bm_b7_diagnostic.cpp`, 97 insertions / 12 deletions,
  full diff preserved in [phase63_source_diff.txt](work/b7_diag_20261011_paired_capture/phase63_source_diff.txt)
  (§2).
- Build:
  - Prior executable `b547...` used for the two main captures (provenance gap from
    the prior session, stated explicitly).
  - Clean from-source rebuild `57de...` with full stdout/exit/compile command
    preserved in `rebuild_runtime.log` (§3).
- Protocol: 6×50, batch 50, INTERLEAVED, counterbalanced order, identical for both
  modes except `component_timing`; exact commands and stdout recorded (§4, §5).
- Both captures:
  - FINE: exit 0, stderr empty, CSV 301 lines, SHA-256 `88443bb...`; structural
    PASS, calibration FAIL (-4.8078 / 15.3524 / 4.6426).
  - COARSE: exit 0, stderr empty, CSV 301 lines, SHA-256 `521a56f...`; structural
    PASS, calibration FAIL (-6.3845 / 13.4629 / 6.4917).
- Immutable Phase 33 validator, profile `six`, run on both CSVs: exit 2 for both,
  structural PASS, calibration FAIL (§5, §6).
- Independent recompute of all three metrics from each CSV: matches the validator
  (§5, §6).
- Final self-contained repro-artifact set (from-source exe, both modes): structural
  PASS, calibration FAIL for both; hashes recorded (§8).

### Unverified / limitations (cannot be fully closed in this phase)
- Two runs only (one per mode); no within-mode independent replication.
- No within-run FINE-vs-COARSE crossover on the same replicate set.
- One capture executable lacks a prior build stdout/exit log (partially closed by
  the repro rebuild; main captures still use the earlier exe).
- COARSE mode cannot give a per-stage decomposition.

### Remaining blocker
**Calibration FAIL in both modes.** The gate is genuinely unsatisfied for both the
fine and the coarse mode. M0 stays FAIL; M1 stays LOCKED. The hypothesis tested
here is not supported.

### Final classification: **PARTIAL**
I implemented the smallest defensible controlled comparison, built from source with
preserved logs/exit codes/hashes, ran both modes under the same protocol, validated
with the frozen validator and an independent recompute, and reported the result
honestly. The phase's engineering goal was to test the timer-perturbation hypothesis
— not to pass the gate — and that test is complete: the coarse mode did not produce
a gate-passing capture and did not reliably reduce the worst-case overhead. I did
not commit or push, and I did not modify unrelated files.

---

*End of report. All artifacts referenced above are in
`work/b7_diag_20261011_paired_capture/` (and `stark/build-b7diag-repro-p63/` for
the from-source rebuild). No commit, no push, no unrelated-file changes.*
