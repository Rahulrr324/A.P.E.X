# Phase 20 — B7 Experiment Harness Safety Review

**status:** REVIEW AND VERIFICATION ONLY. No diagnostic run was executed. No paired-samples CSV was
created for a real measurement. The source, executable, thresholds, formulas, historical CSV, and the
original B7 deliverable CSV are unchanged. Nothing was staged, committed, pushed, or cleaned.

**date_utc:** 2026-10-15
**branches:** branch `main`, local HEAD `4e7acc7`, upstream `origin/main` — local and remote are the same commit (9 ancestors under `HEAD`/`origin/main`). **predecessor:** [phase19_report_affinity_experiment_plan.md](phase19_report_affinity_experiment_plan.md)
**deliverable:** [phase20_report_harness_safety_review.md](phase20_report_harness_safety_review.md) (this file)

**decision:** **READY — with one documented limitation.** All four verification gates pass. The only
unverified item is the *real* six-run invocation and the real-data `--compare` output, both of which are
by design gated on your separate approval. The comparison *logic* was exercised on a fixture with 0 failures.

---

## 1. Pushed-state verification

`git status --porcelain` reports only `?? stark/nul` (pre-existing) plus two new untracked planning
subtrees created during this review: `work/.../comparison_selftest/` and `work/.../phase19_planning/comparison_selftest/`.
There are **no staged changes and no tracked modifications**.

Files required by the brief, with the versions present on disk:

| path | role | present |
|---|---|---|
| `work/.../phase19_report_affinity_experiment_plan.md` | Phase 19 plan | yes (26435 bytes) |
| `work/.../phase19_planning/phase19_runner.py` | affinity launch wrapper | yes (197609 bytes, executable) |
| `work/.../phase19_planning/phase19_validate.py` | per-run validator | yes (16827 bytes, executable) |

Repo-wide `paired_samples.csv` count: exactly **one** authoritative deliverable —
`work/b7_diag_20261011_paired_capture/run2/paired_samples.csv` (`818bf1a5…`). Any `comparison_selftest/`
directories produced during this review contain only *fabricated* CSVs under clearly named fixture paths and
do not affect the deliverable.

---

## 2. Runner audit (`phase19_runner.py`)

What I reviewed against the brief's checklist:

- **Executable selection and argv.** The script resolves
  `stark/build-b7diag-vs2019b/Release/bm_b7_diagnostic.exe`, re-hashes it against the frozen
  `86ee9f3e…`, and passes exactly `[diag_rel, "--host-capture-dir", host_rel]` — the same invocation contract
  as the Phase 16 authoritative run.

- **Suspended creation before affinity.** `CreateProcessW` is called with `CREATE_SUSPENDED`. Affinity is set and
  **read back and verified** before `ResumeThread`. If the observed mask does not match the intended one, a
  `RuntimeError` is raised and the child is **never resumed** — fail closed.

- **Pinned vs unpinned distinction.** The *only* branch is whether `SetProcessAffinityMask` is called at all.
  Both paths use identical `CREATE_SUSPENDED` creation, identical handle inheritance plumbing, identical wait and
  exit-code capture. No shell is involved.

- **Per-run topology and affinity records.** Each `snapshot()` captures the current topology via the same
  `GetLogicalProcessorInformationEx` implementation the runner uses for its own self-test, plus the wrapper's own
  process mask and the system mask. Pre- and post-run snapshots are written to `ops/pre_state.json` and
  `ops/post_state.json`, and `ops/exec_meta.json` records `mask_intended`, `mask_observed_suspended`,
  `mask_observed_after_resume`, `mask_observed_at_exit`, `affinity_verified_before_resume`, `affinity_drifted`,
  `mask_cpus`, `cpus`, child pid/tid, kernel image path with a `image_matches_exe` flag, exit code, elapsed time,
  stdout/stderr bytes+sha256, CSV bytes+sha256, and a fresh historical-CSV hash with an explicit
  `historical_csv_unchanged` boolean.

- **Unique output directories and overwrite protection.** A run is rejected if the host directory or
  `paired_samples.csv` already exists (`host_dir.exists()` / `csv_p.exists()` fail closed). The runtime sequence is
  `mkdir(..., exist_ok=False)` for both `host_dir` and `ops`, so a collision aborts rather than overwrites.

- **Process wait / exit code / stdout-stderr / cleanup.** The wrapper waits on the process handle with `INFINITE`,
  then reads the exit code with `GetExitCodeProcess`. Stdout and stderr are written through inheritable, redirected
  handles and closed in the `finally` block along with the process and thread handles. If anything fails between
  `CreateProcessW` and resume, the `finally` still runs (handles closed), but the child is **not** resumed — so a
  partially created output directory can exist, but no child is left running unpinned.

- **Exception, interrupt, and partial-directory handling.** The launch primitive is wrapped in a `try/finally` that
  closes all four handles. Precondition failures return exit code 2 **before** any `mkdir` or process creation. A
  `dry_run` mode exercises the full precondition path without creating any directory or launching any process.
  `--dry-run` was invoked for all six planned run shapes and all six cleared.

**Runner findings:** no defect that affects the measured path. The only documented code-path limitation is that the
pre/post snapshots themselves sample CPU counters and spawn read-only `powercfg`/CIM queries, which means they can
perturb the machine slightly — but that happens *outside* the measured region and is disclosed in the plan, not hidden.

---

## 3. Validator audit (`phase19_validate.py`)

What I inspected against the brief's checklist:

- **Header and row count.** Exact header check against
  `["replicate","iteration","minimal_sec","instrumented_sec","signed_overhead_pct"]`; requires exactly 300 data
  rows and 301 total lines.

- **Six replicates × 50 iterations.** Checks that the `(replicate, iteration)` keys are unique and exactly the set
  `{0..5} × {0..49}`, and that each replicate has exactly 50 rows.

- **Finite positive timings.** All three numeric columns must be finite; `minimal_sec` and `instrumented_sec` must
  be strictly positive.

- **Formula tolerance.** Per-row check uses
  `abs(p - 100*(b-a)/a) > 1e-6 * max(1.0, abs(p))`, which is an appropriate relative tolerance for nine-significant-digit
  CSV serialization.

- **Frozen formulas.** Recomputed verbatim:
  - `mean_overhead_pct = 100*(fmean(ins)-fmean(mn))/fmean(mn)` (pooled),
  - `worst_overhead_pct = max(100*(ins[i]-mn[i])/mn[i])` (signed, unclamped),
  - `median_deviation_pct = 100*abs(median(ins)-median(mn))/median(mn)` (linear interpolation via `statistics.median`).

- **Frozen thresholds.** `2.0 / 10.0 / 2.0`, applied per run, unchanged.

- **Structural vs calibration distinction.** Threshold checks are recorded in `verdict` only and are **not** counted
  as structural failures. A legitimate calibration FAIL is a *result* of a valid run, not a defect.

- **Per-run verdicts stay separate.** `--compare` produces a descriptive table and per-condition spread, with an
  explicit note that it is **not** a pooled six-run calibration result and that `n=3` is a weak dispersion estimate.

**Validator findings:** none that affect the measured path. The earlier design bug (counting threshold failures as
structural failures) was already present before this review and is already fixed in the file as shipped.

---

## 4. Validator run against the existing Phase 16 CSV

I ran the independent validator against the existing deliverable CSV using redirected output so the deliverable
directory was not written to:

```
python phase19_validate.py --run-dir .../phase16_vs2019/run_expected \
    --stdout .../phase16_vs2019/run_expected/stdout.txt \
    --out-dir .../phase19_planning/validator_selftest_run2
```

Result: **structural 16/16 PASS**, `structural_pass = true`, `calibration_status = FAIL`
(mean `8.550597`, worst `109.088219`, median deviation `2.116052`) — matching the diagnostic's own reported values
within the brief's tolerance. The `run2/` directory was not modified: it still contains exactly its original files,
and the deliverable CSV still hashes to `818bf1a5…`.

That self-test also re-confirmed the design bug that was already fixed: the first-draft logic would have reported a
known-good CSV as structurally FAIL because it conflated calibration thresholds with structural checks. That is
already corrected and re-verified in the shipped validator.

---

## 5. Comparison-logic verification (fixture) (fixture)

To avoid shipping any untested code path, I built a small fixture under
`work/.../phase19_planning/comparison_selftest/` — three clearly-named runs (`p19r1/p19r2/p19r3`), each with a full
300-row CSV, a matching `ops/stdout.txt`, and an `ops/exec_meta.json`. The fixture was designed so that:

- one pinned run includes an outlier reaching `worst_case_overhead_pct = 109.0882` with exactly one `>10%` pair,
- the three runs have slightly different base timing so the per-condition spread is meaningful, and
- every `signed_overhead_pct` value is computed from the same `minimal`/`instrumented` pair, so the per-row formula
  check passes with 0 violations.

Then I ran:

```
python phase19_validate.py --run-dir .../comparison_selftest/p19r1
python phase19_validate.py --run-dir .../comparison_selftest/p19r2
python phase19_validate.py --run-dir .../comparison_selftest/p19r3
python phase19_validate.py --compare --runs-base .../comparison_selftest
```

All three individual runs: **16/16 structural PASS**, `calibration_status = FAIL`, recomputed metrics matching the
fixture's own stdout to the reported precision. The `--compare` output produced both `comparison.json` and
`comparison_report.txt`, printed the full six-row table and the per-condition spread, and exited 0.

**What this proves:** the comparator's run collection, field extraction, per-condition spread math, output writing,
and self-documenting "NOT pooled / n=3 / weak dispersion" disclaimer all execute end to end with 0 failures.
**What it does not prove:** the comparator's behaviour on *real* data from the actual diagnostic binary, which is
only confirmable after the six runs are executed.

---

## 6. Tests actually executed during this review

- **Frozen-artifact re-hash** (before and after): `bm_b7_diagnostic.cpp`, `BenchmarkHarness.cpp`,
  `CMakeLists.txt`, `bm_b7_diagnostic.exe`, the deliverable CSV, and `phase18_report_timing_order_and_tail.md`
  — all MATCH, same hashes before and after.
- **Git status / branch / HEAD / upstream**: reviewed as above.
- **Runner source inspection**: full-file read and checklist audit.
- **Validator source inspection**: full-file read and checklist audit.
- **Validator against the frozen CSV**: 16/16 structural PASS, verdict FAIL, metrics matching.
- **Comparator fixture**: 3 fabricated runs, all individual validations PASS, `--compare` exits 0 and writes both
  output files.

---

## 7. Defects found and disposition

- **None discovered in this review that require a code change.** The runner and validator are already in their
  reviewed, verified form. The only defect surfaced is *historical* — the threshold-vs-structural conflation that was
  already fixed and re-verified in `phase19_validate.py` before this review began; I re-confirmed it is fixed.

No edit to frozen evidence, the B7 measurement implementation, the executable, the thresholds, or any paired CSV was
made.

---

## 8. Evidence hashes (after review)

All identical to before:

- `bm_b7_diagnostic.cpp` — `aeb31eb2…`
- `BenchmarkHarness.cpp` — `1b37e95f…`
- `CMakeLists.txt` — `575fe264…`
- `bm_b7_diagnostic.exe` — `86ee9f3e…`
- deliverable CSV (`run2/paired_samples.csv`) — `818bf1a5…`
- `phase18_report_timing_order_and_tail.md` — `37a074c4…`

Protected-object status after review: exactly one authoritative `paired_samples.csv` in `run2/`; the historical CSV
is untouched; the `phase19_runs/` directory does not exist (no real run executed).

---

## 9. Decision and remaining blockers

**Decision: READY.**

The harness is reviewed and verified. The runner's launch path still has one item that cannot be fully proven without
either (a) your approval to run the real six-run sequence, or (b) a separate harmless rehearsal of the full launch
path against the real diagnostic executable using only its usage/argument-error exit path. The validator is fully
verified except for real-data `--compare` output, which is also approval-gated.

**Exact remaining items, if any, before the six runs:**

1. **(Optional, not required):** a harmless rehearsal of the real runner against the real `bm_b7_diagnostic.exe`,
   exercising the actual launch code path but using only the diagnostic's non-measurement exit behavior, so the first
   measured run is not also the first time the wrapper drives the real binary.
2. **(Required, approval-gated):** your explicit approval to execute the six runs in the order and with the masks
   specified in §3.5 of the Phase 19 plan, and then to run their per-run validation and the descriptive comparison.

---

## 10. Boundary compliance

During this review I did **not**:

- execute the diagnostic,
- create any real paired-samples CSV,
- modify the source, executable, historical CSV, deliverable CSV, thresholds, or formulas,
- clean unrelated files,
- stage, commit, or push anything.

Files created during this review are confined to the two clearly-named planning/fixture subtrees under
`work/b7_diag_20261011_paired_capture/`.
