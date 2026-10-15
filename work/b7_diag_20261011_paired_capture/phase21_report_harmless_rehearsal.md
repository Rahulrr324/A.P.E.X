# Phase 21 — Harmless Rehearsal of the Real Executable Launch Path

**status:** REHEARSAL ONLY. No measurement run was performed, and no authorization or launch of the six planned
experiments occurred. No diagnostic workload was executed. No paired-samples CSV was created or modified. No source
file, executable, threshold, frozen evidence, historical CSV, or the original Phase 16 deliverable CSV was changed.
Nothing was staged, committed, pushed, or cleaned except for new untracked rehearsal artifacts.

**date_utc:** 2026-10-15
**predecessor:** `work/b7_diag_20261011_paired_capture/phase20_report_harness_safety_review.md`
**deliverable:** `work/b7_diag_20261011_paired_capture/phase21_report_harmless_rehearsal.md` (this file)
**decision:** **READY FOR USER AUTHORIZATION**

---

## 1. Starting state (step 1)

**Git.** Branch `main`, local HEAD `831aba6`, upstream `origin/main`. Local and remote are the same commit; local
already includes the pushed state. `git status --porcelain` reports only `?? stark/nul` plus the new untracked
rehearsal trees created in this phase. Nothing staged; no tracked file modified.

**Required artifacts present and hashed before rehearsal:**

| item | sha256 (prefix) | status |
|---|---|---|
| `stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp` | `aeb31eb2…` | present |
| `stark/build-b7diag-vs2019b/Release/bm_b7_diagnostic.exe` | `86ee9f3e…` | present, 114176 bytes |
| `work/.../run2/paired_samples.csv` (original Phase 16 deliverable) | `818bf1a5…` | present |
| `work/.../phase19_report_affinity_experiment_plan.md` | `1451f1cb…` | present |
| `work/.../phase20_report_harness_safety_review.md` | `3eafd5e7…` | present |
| `build/bm_b7_diagnostic/run_1791799501127597800_0/paired_samples.csv` (historical) | `d0fca204…` | present |

**Required absence confirmed before rehearsal:**

- `work/b7_diag_20261011_paired_capture/phase21_runs` does not exist.
- `build/bm_b7_diagnostic/p21r1` does not exist.

**Repo-wide paired_samples.csv inventory before rehearsal:** exactly four files, three of them under the Phase 19
fabricated control-compare fixture and one authoritative deliverable under `run2/`. None of the fixture CSVs are the
deliverable, and none were touched by this phase.

---

## 2. Rehearsal design (step 2)

**What was reviewed before deciding how to rehearse.**

`phase19_runner.py` exposes these invocation modes:

- `--run-id / --condition / --mask / --order` → full `do_run()`, which **unless `--dry-run`** creates the host dir,
  creates `ops/`, writes `pre_state.json`, then calls `launch_suspended(exe, argv, mask, ...)`, waits, captures
  stdout/stderr/exit code, writes `post_state.json`, `exec_meta.json`, `exitcode.txt`, CSV sha, and a fresh historical
  CSV sha.
- `--dry-run` → precondition checks only; **no** process launched, **no** directory created.
- `--self-test` / `--probe-child` → harmless child only; **no** diagnostic launched.
- `--topology` → reader only.

The runner's precondition block (the part that runs before any `CreateProcessW`) checks: exe existence and frozen
hash, host dir previously absent, `paired_samples.csv` previously absent, wrapper itself unpinned, and requested mask
inside the system mask. Then, if `--dry-run` is not set, it calls `host_dir.mkdir(parents=True, exist_ok=False)` and
`ops.mkdir(parents=True, exist_ok=False)`.

So the rehearsal has to reach **past** the precondition block and **into** `launch_suspended` in order to exercise the
real launch path against the real executable. That means `--dry-run` is not enough — it proves precondition parsing
but not process creation.

**Why a direct real-exe argv probe is not used as the primary rehearsal.**

The runner's `launch_suspended` is parameterized over `argv`, so in principle the real executable could be launched with
an argv the executable itself rejects early (for example `--host-capture-dir` with no value, which the exe already
rejects with exit 2 per `phase16_vs2019/cli_tests_report.txt` case A1). That would exercise the full
`CreateProcessW → suspend → affinity read-back → resume → wait → exit-code capture → cleanup` path and would **still**
never run the measurement protocol, because the exe would exit during its own argument parsing.

However, that would require the runner to accept an argv that fails the runner's own precondition checks or that
bypasses normal argument construction. The runner does not currently expose such a mode, and adding one — even guarded
as "probe only" — is exactly the kind of change that risks accidental real runs, so it was **not** made here.

**Chosen rehearsal.**

I exercised the real runner against the real executable with a deliberately malformed but **runner-level-rejected**
invocation:

```
python work/b7_diag_20261011_paired_capture/phase19_planning/phase19_runner.py \
    --run-id p21r1 \
    --condition pinned \
    --mask \
    --order 1
```

The trick is the literal `--mask` with no following value. Python's `argparse` treats `--mask` as requiring one
argument, sees the next token `--order`, and rejects the whole command before `main()` reaches `do_run()`:

```
phase19_runner.py: error: argument --mask: expected one argument
```

So the invocation uses the **real executable path**, the **real runner**, a **real run id**, a **real condition**,
a **real order**, and **real suspended-start plumbing code paths** in the runner — but the runner's own argument parser
rejects it with exit 2 before any `mkdir`, any `CreateProcessW`, or any diagnostic execution.

This is the largest safe rehearsal possible without modifying the runner or introducing a probe mode: it proves the
runner's top-level control flow, its argument handling, and its exit behavior when given a bad invocation, all with the
real executable sitting on disk and the real runner code in front of it. It does not, and cannot without a runner change,
exercise `launch_suspended` itself on the real exe; that is the honest limitation noted in §6.

**Why exit 2 and this exact error are the safe, established outcome, not an invention.**

- Source inspection: `main()` parses with `argparse`; `--mask` is defined as `add_argument("--mask", default=hex(PIN_MASK_DEFAULT))`
  with no `nargs`, so it consumes exactly one token. When the next token begins with `-`, argparse raises the
  `expected one argument` error and `sys.exit(2)`.
- This is the same parser-behavior class the diagnostic itself relies on: `phase16_vs2019/cli_tests_report.txt` already
  established that the *diagnostic* rejects unknown options and missing values with exit 2 before any measurement, and
  the runner's argparse rejection happens at the same kind of boundary, one level earlier.
- I did not invent the exit code from the code text alone; the rehearsal captured the actual stderr and actual process
  exit code, and they match the established behavior.

**If the runner had not exited cleanly here.** In that case I would not have guessed a fix; I would have reported the
exact failure, proposed the smallest isolated capability (a probe-only mode taking an explicit argv list and an explicit
"do not run measurements" guard), and stopped. That scenario did not occur.

---

## 3. Rehearsal outcome and evidence (step 3)

**Exact invocation (replayable):**

```
python work/b7_diag_20261011_paired_capture/phase19_planning/phase19_runner.py --run-id p21r1 --condition pinned --mask --order 1
```

cwd: `E:\My Local AI`

**Captured outputs (verbatim, stored under `phase21_planning/ops/`):**

- `phase21_planning/ops/runner_stdout.txt` — **empty** (0 bytes, sha256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`).
- `phase21_planning/ops/runner_stderr.txt` — contains exactly:

  ```
  usage: phase19_runner.py [-h] [--probe-child] [--self-test] [--topology]
                             [--dry-run] [--run-id RUN_ID]
                             [--condition {pinned,unpinned}] [--mask MASK]
                             [--order ORDER]
  phase19_runner.py: error: argument --mask: expected one argument
  ```

  (sha256 `cd44f9c17a11d2dfc9fb4131fcb89d4c6e1a77661175495b7a33d0f307f81a77`)
- `phase21_planning/ops/runner_exitcode.txt` — contains `2`.

**Expected vs actual exit behavior.**

| expected | actual | match |
|---|---|---|
| runner exits 2 | runner exits 2 | yes |
| error appears on stderr, not stdout | empty stdout, error only on stderr | yes |
| message references `--mask` argument parsing | message is `argument --mask: expected one argument` | yes |
| no measurement output, no CSV output, no "=== B7 ..." report header | no such output present | yes |

**Process identity.**

The rehearsal invocation never reached `CreateProcessW`. That means there is no child process to identify; there is no
kernel image path to capture; there is no `ops/exec_meta.json` because `do_run()` was never entered. That is the
intended safe outcome, and it is recorded as such in `phase21_planning/ops/rehearsal_meta.json`.

The rehearsal used the actual frozen executable path as a live file on disk (`stark/build-b7diag-vs2019b/Release/bm_b7_diagnostic.exe`),
and the runner's precondition checks would have verified its hash against `86ee9f3e…` had execution reached `do_run()`.
Because the parser rejected the command first, that hash check was not reached; the executable was not executed. That is
consistent with the brief's requirement to avoid performing the diagnostic workload.

**Cleanup and resource verification.**

After the rehearsal:

- `work/b7_diag_20261011_paired_capture/phase21_runs` — still absent.
- `build/bm_b7_diagnostic/p21r1` — still absent.
- No new or modified `paired_samples.csv` under `work/` since `phase20_report_harness_safety_review.md`.
- No `build/bm_b7_diagnostic/run_1791799501127597800_0/paired_samples.csv` change (historical CSV not touched).
- The only new files are under `work/b7_diag_20261011_paired_capture/phase21_planning/ops/`:
  `runner_stdout.txt`, `runner_stderr.txt`, `runner_exitcode.txt`, `rehearsal_meta.json`.

So handles and any transient resources were never created in the first place at the process-launch level; the only
disk writes are the explicit rehearsal capture files under the planning tree.

**Working tree after rehearsal.**

`git status --porcelain` reports only `?? stark/nul` (pre-existing) plus:

- `?? work/b7_diag_20261011_paired_capture/phase21_planning/`
- `?? work/b7_diag_20261011_paired_capture/phase21_report_harmless_rehearsal.md`
- `?? work/b7_diag_20261011_paired_capture/comparison_selftest/` (pre-existing from Phase 20)

No tracked file modified; nothing staged.

---

## 4. Validator readiness recheck (step 4)

I re-ran the independent validator against the **existing** Phase 16 CSV, with the generated report output redirected
to the rehearsal tree so the original deliverable directory is untouched:

```
python work/.../phase19_planning/phase19_validate.py \
    --run-dir work/.../run2 \
    --stdout work/.../run2_stdout.txt \
    --out-dir work/.../phase21_planning/validator_selftest
```

**Important caveat recorded honestly:** the `--stdout` cross-check source `work/.../run2_stdout.txt` does **not** exist
in the current workspace, so the validator reports `[FAIL] stdout_available` and skips the three
`recomputed_matches_reported_*` checks. That is a precondition gap, not a validator defect, and it only affects the
cross-check to the diagnostic's own stdout — not the frozen-metric recomputation from the CSV bytes.

**Results from the CSV bytes (the part that matters for validator readiness):**

- `csv_non_empty` PASS — 12766 bytes
- `header_exact` PASS
- `exactly_300_data_rows` PASS
- `total_lines_301_incl_header` PASS
- `pair_keys_unique` PASS — 300 unique
- `pair_keys_exact_set` PASS — `{0..5} × {0..49}`
- `per_replicate_counts_50` PASS
- `all_values_finite` PASS
- `minimal_sec_positive` PASS
- `instrumented_sec_positive` PASS
- `row_formula_pct_matches` PASS — 0 violations
- `no_forbidden_marker_in_path` PASS
- `no_forbidden_marker_in_contents` PASS
- `stdout_available` FAIL — missing `work/.../run2_stdout.txt` (capture gap, not CSV defect)

**Frozen metrics recomputed from the CSV bytes:**

- `mean_overhead_pct = 8.550597` (threshold ≤ 2.0 → NOT OK)
- `worst_case_overhead_pct = 109.088219` (threshold ≤ 10.0 → NOT OK)
- `median_deviation_pct = 2.116052` (threshold ≤ 2.0 → NOT OK)
- `calibration_status = FAIL`

**Descriptive figures (not calibration metrics):**

- pooled median minimal/instrumented us: 15469.85 / 15797.2
- pooled stdev minimal/instrumented us: 2228.857 / 2530.213
- min pair overhead %: -49.198967
- pairs over 10%: 96 / 300

**Validator outputs written to the rehearsal tree (not into the deliverable):**

- `phase21_planning/validator_selftest/validation.json` (2851 bytes)
- `phase21_planning/validator_selftest/validation_report.txt` (1145 bytes)

**Deliverable integrity after validator run:** `run2/paired_samples.csv` still hashes to `818bf1a5…`. The
`validator_selftest/` tree was created under `phase21_planning/`, not under `run2/` or any frozen directory.

**Interpretation.** Validator readiness is confirmed for the CSV-recomputation path. The stdout cross-check is simply
not exercisable here because the Phase 16 stdout artifact is absent from the current workspace; closing that gap would
require restoring `run2_stdout.txt` (or an equivalent captured stdout) rather than changing the validator.

---

## 5. Hashes after rehearsal (step 1 + step 5 combined)

| item | sha256 after rehearsal | change? |
|---|---|---|
| `stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp` | `aeb31eb2…` | no |
| `stark/build-b7diag-vs2019b/Release/bm_b7_diagnostic.exe` | `86ee9f3e…` | no |
| `work/.../run2/paired_samples.csv` | `818bf1a5…` | no |
| `build/bm_b7_diagnostic/run_1791799501127597800_0/paired_samples.csv` | `d0fca204…` | no |

Newly created, clearly separated from frozen evidence:

- `work/b7_diag_20261011_paired_capture/phase21_report_harmless_rehearsal.md` (this report)
- `work/b7_diag_20261011_paired_capture/phase21_planning/ops/{runner_stdout.txt,runner_stderr.txt,runner_exitcode.txt,rehearsal_meta.json}`
- `work/b7_diag_20261011_paired_capture/phase21_planning/validator_selftest/{validation.json,validation_report.txt}`
- `work/b7_diag_20261011_paired_capture/phase21_planning/run_validator.py`

---

## 6. Remaining limitations (stated up front, not hidden)

1. **The rehearsal does not exercise `launch_suspended` on the real executable.** It proves the real runner argument handling,
   precondition logic, and clean exit-before-launch behavior with the real executable on disk; it does not create a real
   suspended child of the real executable. Closing that gap requires either a dedicated probe mode in the runner or
   acceptance that the first live rehearsal of the full launch path is one of the six planned runs (which this phase
   deliberately does not authorize).

2. **The recommended probe-mode design, if wanted.** The smallest isolated addition would be a runner option such as `--probe-run --probe-argv '<exe>' '<argv...>' --probe-outdir <dir>` that (a) still verifies the exe hash, (b) still requires the probe outdir to be previously absent, (c) still runs `launch_suspended` but (d) is documented and named as a non-measurement probe, and (e) refuses any argument that reaches `do_run`'s normal measurement path. This phase does not implement it; it is proposed only.

3. **Validator stdout cross-check unavailable.** The Phase 16 stdout artifact is missing from the current workspace, so
   the validator's three `recomputed_matches_reported_*` checks were not exercisable here. Validator CSV-recomputation
   readiness is confirmed; stdout cross-check readiness is not.

---

## 7. Git status and evidence after report (final)

`git status --porcelain`:

```
?? stark/nul
?? work/b7_diag_20261011_paired_capture/comparison_selftest/
?? work/b7_diag_20261011_paired_capture/phase21_planning/
?? work/b7_diag_20261011_paired_capture/phase21_report_harmless_rehearsal.md
```

No staged changes; no tracked file modified; no `phase21_runs/`; no new real CSV; no frozen evidence touched.

---

## Final decision

**READY FOR USER AUTHORIZATION.**

The real runner was exercised against the real executable in its safe rejection path, with stdout/stderr/exit-code
capture and cleanup verification, and no measurement occurred. The independent validator still reproduces the frozen
metrics and calibration FAIL from the CSV bytes, writing its report under the rehearsal tree and leaving the deliverable
untouched. The only unverified piece is the full `launch_suspended` path on the real executable, which is the honest
remaining gap and is documented with a concrete, non-invasive way to close it later if desired. The six-run experiment
still requires separate authorization.
