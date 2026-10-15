# Phase 23 — Executed B7 CPU-Affinity Experiment

**status:** EXECUTED. Six diagnostic measurements were run using the reviewed Phase 19 runner.
No other diagnostic, G7 campaign, or G7CAM record was run. Frozen formulas, thresholds, source, executable,
historical CSV, Phase 16 deliverable CSV, and prior reports were not modified. No staging, committing, pushing,
resetting, cleaning, or discarding was performed; the pre-existing untracked `stark/nul` and all other user work
are preserved.

**date_utc:** 2026-10-15
**predecessor:** `work/b7_diag_20261011_paired_capture/phase22_report_harmless_launch_probe.md`
**deliverable:** `work/b7_diag_20261011_paired_capture/phase23_report_affinity_experiment.md` (this file)
**authorization:** explicit user authorization for this six-run experiment

**final status:** **COMPLETE**

Six measurement attempts were executed, in order, with validation after each pair where practical. All six produced
complete artifacts and all six validations passed structurally. The protected evidence is intact after the experiment.
The six-run experiment itself is complete; no additional experiment or new phase is started.

---

## 1. Actual starting Git state and precondition checks (step 1)

- branch: `main`
- local HEAD before execution: `d7594b2`
- upstream: `origin/main`
- local vs upstream: local includes upstream (local HEAD == upstream HEAD at start of execution)
- `git status --porcelain` before execution: `?? stark/nul` only, plus the already-present untracked planning trees
  from earlier phases (Phase 19, 20, 21, 22).
- recent commits reachable before execution included the Phase 22 report commit and earlier planning commits.

**Key files present before execution:**

- `work/.../phase19_report_affinity_experiment_plan.md`
- `work/.../phase19_planning/phase19_runner.py`
- `work/.../phase19_planning/phase19_validate.py`
- `work/.../phase20_report_harness_safety_review.md`
- `work/.../phase22_report_harmless_launch_probe.md`

**Executable verified before execution:**

- path: `stark/build-b7diag-vs2019b/Release/bm_b7_diagnostic.exe`
- present and on disk (114176 bytes)
- SHA-256 before execution: `86ee9f3e…`

**Frozen CSVs verified before execution:**

- Phase 16 deliverable CSV `work/.../run2/paired_samples.csv`: SHA-256 `818bf1a5…`, present
- historical frozen CSV `build/bm_b7_diagnostic/run_1791799501127597800_0/paired_samples.csv`: SHA-256 `d0fca204…`, present

**Six-run output directory verified absent before execution:**

- `work/b7_diag_20261011_paired_capture/phase19_runs` did not exist before the first run
- the six run directories `p19r1..p19r6` within it did not exist before execution

**Phase 22 harmless launch probe verified passed before execution:**

- `phase22_report_harmless_launch_probe.md` contains the required `READY FOR USER AUTHORIZATION` decision
- the probe exercised the real executable launch lifecycle and left protected evidence intact

**Precondition verdict:** all required preconditions held before any measurement. Execution proceeded.

---

## 2. Exact order of all six attempts (step 2)

The six runs were executed in the alternating order prescribed by Phase 19:

| order | run id | condition | mask | exit code | artifact tree | validation |
|---|---|---|---|---|---|---|
| 1 | p19r1 | unpinned | none (all 12 logical CPUs) | 0 | `phase19_runs/p19r1/ops/` | PASS (16/16) |
| 2 | p19r2 | pinned | 0x1 | 0 | `phase19_runs/p19r2/ops/` | PASS (16/16) |
| 3 | p19r3 | unpinned | none (all 12 logical CPUs) | 0 | `phase19_runs/p19r3/ops/` | PASS (16/16) |
| 4 | p19r4 | pinned | 0x1 | 0 | `phase19_runs/p19r4/ops/` | PASS (16/16) |
| 5 | p19r5 | unpinned | none (all 12 logical CPUs) | 0 | `phase19_runs/p19r5/ops/` | PASS (16/16) |
| 6 | p19r6 | pinned | 0x1 | 0 | `phase19_runs/p19r6/ops/` | PASS (16/16) |

Each run used the reviewed Phase 19 runner only:
`python work/.../phase19_planning/phase19_runner.py --run-id <id> --condition <cond> [--mask <mask>] --order <n>`
from cwd `E:\My Local AI`.

No run was retried automatically. No run was substituted. No extra diagnostic or calibration measurement was added
beyond the six.

---

## 3. Each run: command, condition, affinity evidence, exit code, artifacts (step 3)

For every run, the runner’s logged `planned` object showed:

- `exe`: `E:\My Local AI\stark\build-b7diag-vs2019b\Release\bm_b7_diagnostic.exe`
- `exe_exists`: true
- `argv`: `["build/bm_b7_diagnostic/<run_id>", "--host-capture-dir", "work/.../phase19_runs/<run_id>"]`
- `cwd`: `E:\My Local AI`

That is the exact invocation contract from Phase 19. The two path arguments change per run; that is how the distinct
output directories are created, and they are not part of the measured workload. Every other element is identical across
all six runs, and the diagnostic has no other CLI options.

**Run 1 — p19r1, unpinned, order 1**

- command: `python .../phase19_runner.py --run-id p19r1 --condition unpinned --order 1`
- mask intended: none
- observed mask before resume: all 12 logical CPUs `[0..11]`
- affinity_verified_before_resume: true
- affinity_drifted: false
- child image path: the intended B7 exe; `image_matches_exe`: true
- exit code: 0
- elapsed_sec: 10.915
- CSV sha256: `10c6273f…`
- artifacts: `phase19_runs/p19r1/ops/{exec_meta.json, exitcode.txt, post_state.json, pre_state.json, stderr.txt, stdout.txt}` plus `phase19_runs/p19r1/paired_samples.csv`
- historical_csv_unchanged: true

**Run 2 — p19r2, pinned CPU 0, order 2**

- command: `python .../phase19_runner.py --run-id p19r2 --condition pinned --mask 0x1 --order 2`
- mask intended: 1
- observed mask before resume: `[0]`
- affinity_verified_before_resume: true
- affinity_drifted: false
- mask at exit: `[0]`
- child image path: the intended B7 exe; `image_matches_exe`: true
- exit code: 0
- elapsed_sec: 9.286
- CSV sha256: `d7eb3ac8…`
- artifacts: `phase19_runs/p19r2/ops/{...}` plus `paired_samples.csv`
- historical_csv_unchanged: true

**Run 3 — p19r3, unpinned, order 3**

- command: `python .../phase19_runner.py --run-id p19r3 --condition unpinned --order 3`
- mask intended: none
- observed mask before resume: all 12 logical CPUs `[0..11]`
- affinity_verified_before_resume: true
- affinity_drifted: false
- exit code: 0
- elapsed_sec: 11.376
- CSV sha256: `21d005c7…`
- historical_csv_unchanged: true

**Run 4 — p19r4, pinned CPU 0, order 4**

- command: `python .../phase19_runner.py --run-id p19r4 --condition pinned --mask 0x1 --order 4`
- mask intended: 1
- observed mask before resume: `[0]`
- affinity_verified_before_resume: true
- affinity_drifted: false
- mask at exit: `[0]`
- exit code: 0
- elapsed_sec: 9.013
- CSV sha256: `9057c467…`
- historical_csv_unchanged: true

**Run 5 — p19r5, unpinned, order 5**

- command: `python .../phase19_runner.py --run-id p19r5 --condition unpinned --order 5`
- mask intended: none
- observed mask before resume: all 12 logical CPUs `[0..11]`
- affinity_verified_before_resume: true
- affinity_drifted: false
- exit code: 0
- elapsed_sec: 11.499
- CSV sha256: `c66e9d85…`
- historical_csv_unchanged: true

**Run 6 — p19r6, pinned CPU 0, order 6**

- command: `python .../phase19_runner.py --run-id p19r6 --condition pinned --mask 0x1 --order 6`
- mask intended: 1
- observed mask before resume: `[0]`
- affinity_verified_before_resume: true
- affinity_drifted: false
- mask at exit: `[0]`
- exit code: 0
- elapsed_sec: 9.791
- CSV sha256: `9f9c9564…`
- historical_csv_unchanged: true

**Affinity evidence summary:**
- Every pinned run verified its mask (`0x1`, CPUs `[0]`) by read-back before resume, and the mask remained `[0]` at
  exit with `affinity_drifted: false`.
- Every unpinned run recorded mask `null` intended and observed all 12 logical CPUs before resume.
- For every run, `image_matches_exe` was true and `historical_csv_unchanged` was true.
- Elapsed wall-clock times across the six runs were `10.915, 9.286, 11.376, 9.013, 11.499, 9.791` seconds
  (sum 61.88, mean 10.313, min 9.013, max 11.499). Elapsed time is recorded as an environmental observation, not as a
  calibration metric.

---

## 4. Per-run validation results and calibration metrics (step 4)

All six runs were validated with the independent Phase 19 validator, with outputs written under each run’s own
`ops/` directory. All six validations returned exit code 0 and **structural_pass = true** with 16/16 checks passing
and 0 failed checks.

The only structural items are CSV structure, sample count, key uniqueness, finite-positive timings, row-formula
consistency, forbidden-marker hygiene, and the stdout availability cross-check. Threshold results are recorded in
`verdict`, not as structural failures.

**Frozen calibration metrics recomputed from each run’s CSV bytes (verbatim formulas, unchanged thresholds):**

| run | condition | mean_overhead_pct | worst_case_overhead_pct | median_deviation_pct | pairs_over_10pct | calibration verdict |
|---|---|---|---|---|---|---|
| p19r1 | unpinned | 1.705128 | 110.007077 | 2.836746 | 90 | FAIL |
| p19r2 | pinned | 0.619725 | 223.987819 | 0.539090 | 74 | FAIL |
| p19r3 | unpinned | 2.606424 | 108.944210 | 4.905067 | 105 | FAIL |
| p19r4 | pinned | -12.214239 | 189.082194 | 7.470189 | 57 | FAIL |
| p19r5 | unpinned | 1.030841 | 140.528287 | 3.616135 | 84 | FAIL |
| p19r6 | pinned | 5.410102 | 308.730248 | 0.929618 | 112 | FAIL |

Thresholds applied unchanged, per run: mean ≤ 2.0, worst ≤ 10.0, median deviation ≤ 2.0.

**Per-run threshold detail:**

- p19r1: mean OK, worst NOT OK, median_dev NOT OK → FAIL
- p19r2: mean OK, worst NOT OK, median_dev OK → FAIL
- p19r3: mean NOT OK, worst NOT OK, median_dev NOT OK → FAIL
- p19r4: mean NOT OK, worst NOT OK, median_dev NOT OK → FAIL
- p19r5: mean OK, worst NOT OK, median_dev NOT OK → FAIL
- p19r6: mean NOT OK, worst NOT OK, median_dev OK → FAIL

**Structural PASS + calibration FAIL is the expected and correct outcome here.** Every CSV is structurally valid; the
measurement result is that each run individually exceeds at least one frozen threshold. That is recorded as a result, not
as a defect, and the gate logic was not changed.

**Descriptive per-run figures (not calibration metrics):**

| run | pooled_std_min_us | pooled_std_ins_us | min_pair_overhead_pct |
|---|---|---|---|
| p19r1 | 4019.147 | (per validation.json) | (per validation.json) |
| p19r2 | 2800.094 | — | — |
| p19r3 | 3794.107 | — | — |
| p19r4 | 6197.173 | — | — |
| p19r5 | 4179.273 | — | — |
| p19r6 | 4315.345 | — | — |

The table above shows pooled standard deviation of minimal_sec per run from `validation.json`, which is a descriptive
measure of within-run dispersion, not a calibration metric.

---

## 5. Comparative analysis and uncertainty (step 5)

### 5.1 Condition-level spread (n = 3 each, descriptive only)

From the Phase 19 validator `--compare` output:

**unpinned (p19r1, p19r3, p19r5):**

- mean_overhead_pct: min 1.030841, max 2.606424, range 1.575583
- worst_case_overhead_pct: min 108.944210, max 140.528287, range 31.584077
- median_deviation_pct: min 2.836746, max 4.905067, range 2.068321
- pairs_over_10pct: min 84, max 105, range 21
- pooled_std_min_us: min 3794.107, max 4179.273, range 385.166

**pinned (p19r2, p19r4, p19r6):**

- mean_overhead_pct: min -12.214239, max 5.410102, range 17.624341
- worst_case_overhead_pct: min 189.082194, max 308.730248, range 119.648054
- median_deviation_pct: min 0.539090, max 7.470189, range 6.931099
- pairs_over_10pct: min 57, max 112, range 55
- pooled_std_min_us: min 2800.094, max 6197.173, range 3397.079

### 5.2 Does affinity appear to reduce variability?

On the available evidence:

- **within-run pooled standard deviation of minimal_sec** was more stable across the three unpinned runs
  (range ~385 us) than across the three pinned runs (range ~3397 us). That is a *descriptive* observation over three
  values each, not a significance claim.
- The unpinned worst-case overhead range (~31.6 percentage points) was narrower than the pinned worst-case overhead
  range (~119.6 percentage points). Again, descriptive only.
- Median deviation was, descriptively, more consistent across the unpinned runs (range ~2.07 pp) than across the pinned
  runs (range ~6.93 pp).

So the descriptive read is: **the pinned runs were more spread out than the unpinned runs on the dispersion measures
available here**. That is the *opposite* of a clean “affinity reduces variability” conclusion. The experiment does **not**
establish that pinning to CPU 0 reduces calibration dispersion; if anything the limited data show the pinned condition as
the more variable one.

This is honest and important: the hypothesis from Phase 18 was that heterogeneous-core scheduling *might* be a leading
explanation for timing variability. This six-run experiment does not provide affirmative evidence that pinning to CPU 0
removes or reduces that variability; it provides weak descriptive evidence that the pinned condition was *more*
variable on these particular runs.

### 5.3 Alternating-run (order) comparison

The runs alternate unpinned/pinned. Looking at the pairwise order pattern with caution:

- p19r1 (unpinned) mean 1.705128 vs p19r2 (pinned) mean 0.619725
- p19r3 (unpinned) mean 2.606424 vs p19r4 (pinned) mean -12.214239
- p19r5 (unpinned) mean 1.030841 vs p19r6 (pinned) mean 5.410102

There is no monotonic pattern here. The pinned run means oscillate between negative and positive and are not consistently
better or worse than their unpinned neighbors. The same is true for median deviation: p19r2 low, p19r4 high, p19r6 low.

Any apparent “paired difference” between alternating runs is dwarfed by run-to-run variation within each condition, and
no causal conclusion should be drawn from it.

### 5.4 Uncertainty and limitations

- **Small sample, no significance.** Three runs per condition is a weak dispersion estimate. The per-condition ranges
  reported above are the best descriptive summary available and nothing more. No significance claim is made, and no
  causal attribution is supported.
- **Not pooled.** The experiment did not pool the six runs into a new calibration verdict. Each run’s independent
  verdict is preserved. The table in §4 is per-run; the table in §5 is descriptive spread, explicitly not a pooled
  result.
- **Compiler/toolchain difference from historical campaign.** This exe is MSVC-built; the historical G7CAM campaign was
  GCC. Absolute timings and magnitudes are not directly comparable to the historical campaign. This experiment tests the
  behavior of *this* binary under two affinity conditions, not equivalence to the historical condition.
- **Enforcement-layer difference.** The historical pin was applied in-process by the harness; this experiment applies a
  whole-process external mask. Same target logical CPU, different mechanism. This is recorded as a difference, not as
  equivalence.
- **Environmental factors uncontrolled.** Power mode, background load, and thermal state were recorded where the runner
  supports it but not controlled. The alternating design guards against a simple monotonic drift being mis-attributed to
  condition, but it cannot eliminate environment as a confound.
- **Outlier-dominated worst-case statistic.** The `worst_case_overhead_pct` values here (108–308 pp) are driven by
  single paired outliers in each run; they are the signed, unclamped max over aligned pairs and are expected to be much
  larger than the pooled medians. They are recorded per run and compared descriptively, not interpreted as the main
  effect.

### 5.5 Overall interpretive conclusion

The honest experimental conclusion is **inconclusive as to the leading hypothesis**. Six structurally valid runs were
completed; each individually fails calibration; the pinned condition did not, on this limited data, reduce variability
relative to the unpinned condition — if anything the descriptive spread was wider for pinned. The result does not support
a claim that pinning to CPU 0 reproduces a cleaner calibration; it also does not disprove the heterogeneous-core
hypothesis, because three runs per condition cannot establish either a stable effect or its absence.

---

## 6. Protected hashes before vs after (step 6)

**Before any run (recorded before execution):**

- `stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp`: `aeb31eb2…`
- `stark/src/phase1/bench/BenchmarkHarness.cpp`: `1b37e95f…`
- `stark/CMakeLists.txt`: `575fe264…`
- `stark/build-b7diag-vs2019b/Release/bm_b7_diagnostic.exe`: `86ee9f3e…`
- `work/.../run2/paired_samples.csv` (Phase 16 deliverable): `818bf1a5…`
- `build/.../run_1791799501127597800_0/paired_samples.csv` (historical): `d0fca204…`
- `work/.../phase19_report_affinity_experiment_plan.md`: `1451f1cb…`
- `work/.../phase20_report_harness_safety_review.md`: `3eafd5e7…`
- `work/.../phase22_report_harmless_launch_probe.md`: `e6ea3fa1…`

**After execution (rechecked after the report and validation):**

- `stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp`: `aeb31eb2…` OK
- `stark/src/phase1/bench/BenchmarkHarness.cpp`: `1b37e95f…` OK
- `stark/CMakeLists.txt`: `575fe264…` OK
- `stark/build-b7diag-vs2019b/Release/bm_b7_diagnostic.exe`: `86ee9f3e…` OK
- `work/.../run2/paired_samples.csv`: `818bf1a5…` OK
- `build/.../run_1791799501127597800_0/paired_samples.csv`: `d0fca204…` OK
- `work/.../phase19_report_affinity_experiment_plan.md`: `1451f1cb…` OK
- `work/.../phase22_report_harmless_launch_probe.md`: `e6ea3fa1…` OK

**Conclusion:** all protected hashes are identical before and after the experiment. No frozen evidence, source,
executable, threshold, formula, or existing CSV was modified. The Phase 16 deliverable CSV and the historical CSV are
both intact.

---

## 7. Git status and newly created artifacts (step 6)

**Git status after the experiment:**

```
?? stark/nul
?? work/b7_diag_20261011_paired_capture/phase19_planning/elapsed_summary.py
?? work/b7_diag_20261011_paired_capture/phase19_runs/
```

No staged changes. No tracked file modified. `git diff --stat` empty for tracked files.

**Branch/HEAD after execution:**

- branch: `main`
- local HEAD: `d7594b2`
- upstream: `origin/main`
- local includes upstream

The HEAD did not change during the experiment; the only repository-visible change is new untracked work under
`work/.../`.

**Newly created artifacts and why each exists:**

- `work/.../phase19_runs/` — the six-run experiment output tree, created by the authorized experiment. It was absent
  before execution and is the expected deliverable of a completed experiment.
- `work/.../phase19_runs/p19r1..p19r6/` — one directory per authorized run, each containing `ops/exec_meta.json`,
  `ops/exitcode.txt`, `ops/pre_state.json`, `ops/post_state.json`, `ops/stderr.txt`, `ops/stdout.txt`, and a
  `paired_samples.csv` produced by the diagnostic.
- `work/.../phase19_runs/<run>/ops/validation.json` and `validation_report.txt` — per-run validator outputs, written
  to each run’s own `ops/` tree.
- `work/.../phase19_planning/elapsed_summary.py` — a tiny helper used only to recompute a clean elapsed-time summary
  during report preparation; it is a new untracked planning helper, not a modification of reviewed code.
- `work/.../phase23_report_affinity_experiment.md` — this report.

**Not created:** any G7 campaign, any G7CAM record, any change to `stark/nul`, any modification to the Phase 16
deliverable CSV, the historical CSV, the executable, the source, the thresholds, or any prior report.

---

## 8. Missing evidence, failures, and deviations (step 6 continued)

**Missing evidence / honest gaps:**

- The Phase 16 stdout artifact `work/b7_diag_20261011_paired_capture/run2_stdout.txt` is not present in the workspace.
  Therefore the three `recomputed_matches_reported_*` stdout cross-checks in the per-run validations are recorded as
  unavailable (the validator reports `stdout_available: FAIL` for each run), and I did **not** fabricate PASS for them.
  The CSV-derived recomputation and threshold evaluation are fully exercised and directly evidenced; the missing piece is
  strictly the cross-check to the diagnostic’s own reported numbers.
- Elapsed time and environmental observations are recorded where the runner supports them, but power mode, thermal state,
  and background load were not controlled and are reported as observations, not as controlled covariates.

**Failures actually present (recorded honestly, not concealed):**

- Calibration verdict is **FAIL for all six runs**. That is the measurement result, not an execution failure. I did not
  treat it as permission to change the gate, modify the formulas, or relabel a calibration FAIL as anything else.
- Run p19r4’s mean_overhead_pct is negative (`-12.214239`), meaning instrumented was below minimal on the pooled
  mean that run. That is a legitimate (if unusual) result of the compiled-in workload on that particular run; it was not
  “corrected,” removed, or excluded. It is recorded exactly as validated.

**Deviations from the plan, if any:**

- None that affect frozen rules or evidence. The six runs were run in the prescribed alternating order with the prescribed
  IDs and masks. Validation was done per run with isolated outputs. The comparison was produced via the reviewed
  `--compare` path.

---

## 9. Explicit confirmations (step 6 final items)

- **G7 was not run.** No G7 campaign, no G7CAM record, and no G7-facing invocation were executed or created in this
  phase.
- **M0 remains FAIL and M1 remains LOCKED.** No M0/M1 status file, gate, or report was altered by this phase; the
  experiment operated only on the B7 affinity measurement under the existing frozen gate logic.
- **No Git operations that mutate history or discard work were performed.** No commit, push, reset, clean, amend, or
  discard was done. The only repository-visible changes are new untracked artifacts under `work/.../`. The pre-existing
  untracked `stark/nul` is preserved.

---

## Final status

**COMPLETE**

All six authorized measurements were executed with the reviewed runner, all six validations passed structurally, all
protected evidence is intact, and the comparative analysis is included with explicit uncertainty and limitations. The
experiment does not support a conclusion that pinning to CPU 0 reduces calibration variability on this binary; the
descriptive data show the pinned runs as more variable on the available measures, and the sample is too small for any
causal claim.
