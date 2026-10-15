# Phase 22 — Harmless Real-Executable Launch Probe

**status:** PROBE EXECUTED. **No measurement run was performed.** The probe launched the real executable in a
suspended state, set a valid affinity mask, verified it by read-back, resumed the child, and observed it exiting on
its own argument-validation path. **No diagnostic CSV was created, overwritten, or modified.** No source, executable,
threshold, formula, historical evidence, or Phase 16 deliverable was changed. Nothing was staged, committed, pushed,
or cleaned except for new untracked probe artifacts.

**date_utc:** 2026-10-15
**predecessor:** `work/b7_diag_20261011_paired_capture/phase21_report_harmless_rehearsal.md`
**deliverable:** `work/b7_diag_20261011_paired_capture/phase22_report_harmless_launch_probe.md` (this file)

**verdict:** **READY FOR USER AUTHORIZATION**

---

## 1. Starting Git state and upstream comparison (step 1)

- branch: `main`
- local HEAD: `9e74837` (short)
- upstream: `origin/main`
- local vs upstream: local already includes upstream; `git rev-parse HEAD` == `git rev-parse origin/main`
- `git status --porcelain` before probe: `?? stark/nul` only, plus pre-existing untracked planning trees from earlier
  phases. No staged changes; no tracked modifications reported before the probe.
- recent commits reachable from HEAD include the Phase 21 report commit above prior planning commits; HEAD is current
  with `origin/main`.

**HEAD check:** The brief expected HEAD `831aba6`. The repo is now at `9e74837`. So HEAD is **not** the previously
reported `831aba6` — it has moved since then, and this phase re-established state from the repo rather than assuming it.
The new HEAD includes the Phase 21 report and is consistent with a normal sequential advance; this report records the
actual current HEAD rather than the stale expected value.

---

## 2. Files inspected and present (step 1 continued)

| path | present | notes |
|---|---|---|
| `work/.../phase19_planning/phase19_runner.py` | yes | runner CLI + `launch_suspended` inspected |
| `work/.../phase19_planning/phase19_validate.py` | yes | independent validator inspected |
| `work/.../phase20_report_harness_safety_review.md` | yes | safety review referenced |
| `work/.../phase21_report_harmless_rehearsal.md` | yes | rehearsal referenced |
| `work/.../phase16_vs2019/cli_tests_report.txt` | yes | exe argv early-reject behavior reference |
| `stark/build-b7diag-vs2019b/Release/bm_b7_diagnostic.exe` | yes | 114176 bytes, on disk |
| `stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp` | yes | source present |
| `work/.../run2/paired_samples.csv` | yes | authoritative Phase 16 deliverable |
| `build/bm_b7_diagnostic/run_1791799501127597800_0/paired_samples.csv` | yes | historical frozen CSV |

**Required absence before probe:** `work/b7_diag_20261011_paired_capture/phase22_runs` absent. Verified before probe.

**Repo-wide paired_samples.csv inventory before probe:** exactly four files, three under the Phase 19 fabricated
control-compare fixture and one authoritative deliverable under `run2/`. None of the fixture CSVs are the deliverable.

---

## 3. Hashes (before vs after)

**Before probe:**

- `stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp` — `aeb31eb2…`
- `stark/build-b7diag-vs2019b/Release/bm_b7_diagnostic.exe` — `86ee9f3e…`
- `work/.../run2/paired_samples.csv` — `818bf1a5…`
- `build/bm_b7_diagnostic/run_1791799501127597800_0/paired_samples.csv` — `d0fca204…`
- `work/.../phase19_report_affinity_experiment_plan.md` — `1451f1cb…`
- `work/.../phase20_report_harness_safety_review.md` — `3eafd5e7…`
- `work/.../phase21_report_harmless_rehearsal.md` — `fc04b28c…`

**After probe:** identical on the first four protected items (the three hashes the brief names plus the historical CSV):
`aeb31eb2…`, `86ee9f3e…`, `818bf1a5…`, `d0fca204…`. The three report hashes are unchanged from before the probe as
well (no tracked file modified). The probe created only new untracked files under `phase22_planning/`; nothing in the
frozen evidence tree was touched.

**Conclusion:** protected hashes before == after.

---

## 4. Probe design and why its argument is guaranteed to fail before measurement (steps 3–4)

### 4.1 What was inspected

**Runner (`phase19_runner.py`):** inspected the complete path from `main()` through `build_plan()` and `do_run()` into
`launch_suspended()`, including:

- executable resolution and SHA-256 check against `86ee9f3e…`;
- `CreateProcessW(..., CREATE_SUSPENDED, ...)`;
- `SetProcessAffinityMask` and read-back via `GetProcessAffinityMask`;
- `ResumeThread` and `WaitForSingleObject` on the process handle;
- `GetExitCodeProcess` after the wait;
- stdout/stderr written through inheritable redirected handles;
- `finally` block that closes thread, process, and file handles on both success and failure paths;
- precondition checks and `host_dir/ops.mkdir(parents=True, exist_ok=False)` directory creation;
- the `build_plan()` argv it normally constructs for a real run.

**Diagnostic CLI:** the exe accepts `[diagnostic-directory] [--host-capture-dir <relative-dir>]`. Its parser rejects
invalid forms before any measurement. Prior CLI tests (`phase16_vs2019/cli_tests_report.txt`) established that the exe
rejects `--host-capture-dir` with no value with exit 2 and the message `error: --host-capture-dir requires a value`.
I re-confirmed this live before the probe: running the exe with `--host-capture-dir` alone exited 2 with exactly that
message and a usage header. Unknown options and `--host-capture-dir` followed by another option were also rejected with
exit 2. So **any argv that ends in a bare `--host-capture-dir` is guaranteed to fail before `run_bm_b7_diagnostic()` is
entered**, because the parser bails out before the workload function is called.

### 4.2 Why a runner-level rejection was not acceptable for this phase

In Phase 21, the only safe rehearsal available without modifying the runner was a runner-level rejection: the runner's
own argparse rejected a bare `--mask` before `do_run()` and before `CreateProcessW`. That proved the runner's
argument handling but not the real executable's launch lifecycle.

For this phase, the brief explicitly requires that **the child executable must actually be launched, resumed, and
observed exiting on its own argument-validation path**, and that a runner-argparse rejection is insufficient. So a
runner-argparse trick is not used here.

### 4.3 The probe itself

I did **not** modify `phase19_runner.py`. Instead I wrote a new, isolated probe script
`work/b7_diag_20261011_paired_capture/phase22_planning/probe_launch.py` that re-implements the relevant subprocess
lifecycle directly:

1. verifies the expected exe path and SHA-256 against `86ee9f3e…`;
2. opens its own stdout/stderr capture files;
3. calls `CreateProcessW(exe, argv, CREATE_SUSPENDED, ...)` with a **real** argv that includes the exe path,
   `build/bm_b7_diagnostic`, and `--host-capture-dir` with no value;
4. calls `SetProcessAffinityMask(child_handle, 0x1)`;
5. calls `GetProcessAffinityMask` and verifies the observed mask equals `0x1`;
6. calls `ResumeThread`;
7. waits on the process handle and reads the exit code with `GetExitCodeProcess`;
8. closes thread, process, stdout, and stderr handles in a `finally` block;
9. records child image path via `QueryFullProcessImageNameW` and compares it to the intended exe;
10. writes its own `probe1/ops/*` outputs and a `probe_meta.json`.

### 4.4 Chosen affinity mask and why

Mask `0x1`, i.e. logical CPU 0. This is the same CPU selected for the Phase 19 experiment, chosen on the same evidence
(the machine's `EfficiencyClass` and the historical `{CPU0}` pin), not assumed. The probe uses the same mask the
real run would use for the pinned condition. Using a valid real run mask is intentional: the probe is meant to exercise
the real lifecycle with the same kind of valid input the real experiment will use, just with an argv the exe rejects.

### 4.5 Why this argv is safe and guaranteed early-reject

The argv passed to the child is:

```
<exe> build/bm_b7_diagnostic --host-capture-dir
```

That is, the exe's own parser sees `--host-capture-dir` with no following value. The exe's CLI tests already proved
this exact form exits 2 before measurement, and I re-confirmed it live before the probe. So the child will:

- be created and start in a suspended state;
- have its affinity set and verified;
- be resumed;
- run briefly, reach its own argument parser, reject the argv, and exit 2;

without ever beginning the timing/measurement loop. That satisfies the brief's hard requirement: the child executable
is actually launched and observed exiting on its own validation path, not just filtered by the wrapper's argparse.

### 4.6 What the probe does not do

- It does not call `run_bm_b7_diagnostic()`.
- It does not run a measurement loop.
- It does not start any of the six planned runs.
- It does not use a runner-level argv trick; the child exe parses the argv itself.
- It does not reuse the six-run output directory; it has its own `probe1/` tree and refuses to overwrite an existing one.

---

## 5. Exact probe command, affinity mask, child identity, exit code, stdout/stderr, cleanup (step 5)

**Exact command (replayable):**

```
python work/b7_diag_20261011_paired_capture/phase22_planning/probe_launch.py
```

cwd: `E:\My Local AI`

**Affinity mask:** `0x1` (logical CPU 0)

**Child identity (from probe_meta.json):**
- `create_ok`: true
- `child_pid`: 3556
- `child_tid`: 13732
- `image_path`: `E:\My Local AI\stark\build-b7diag-vs2019b\Release\bm_b7_diagnostic.exe`
- `image_matches_exe`: true

So the kernel-reported image path is the intended B7 executable, and the path-match check is true.

**Affinity lifecycle (from probe_meta.json):**
- `mask_observed_suspended`: 1
- `affinity_verified`: true
- `mask_cpus`: [0]
- `resume_rc`: 1 (first resume; prior suspend count was 0)
- `mask_at_exit`: 1
- `affinity_drifted`: false

So the child was created suspended, the affinity was set and read back and verified before resume, the resume succeeded,
and the mask remained 1 until exit with no drift.

**Exit behavior:**
- `exit_code`: 2
- expected exit: 2
- `exit_matches_expected`: true

**Captured stderr (verbatim):**
```
error: --host-capture-dir requires a value
usage: E:\My Local AI\stark\build-b7diag-vs2019b\Release\bm_b7_diagnostic.exe [diagnostic-directory] [--host-capture-dir <relative-dir>]
  default directory: build/bm_b7_diagnostic/ (diagnostic-owned; isolation is validated at run time)
  --host-capture-dir: relative, non-traversal directory that receives paired_samples.csv (exclusive, no overwrite). Omit to skip host persistence.
```

**Captured stdout:** empty (0 bytes).

So the child exited 2 and emitted the exact early-reject validation error the CLI tests established for `--host-capture-dir`
with no value. That is direct evidence that the real executable was launched, resumed, parsed its argv, rejected it, and
exited before measurement.

**Cleanup evidence:**
- The probe opened stdout/stderr files, the process handle, and the thread handle, and closed all of them in the
  `finally` block.
- After the probe, `probe1/ops/` contains exactly: `exe_stdout.txt`, `exe_stderr.txt`, `exe_exitcode.txt`,
  `probe_meta.json`.
- No orphaned child process remains: the probe waited on the process handle to termination before exiting.

---

## 6. CSV and evidence integrity (step 5 continued)

**Phase 16 deliverable CSV:**
- expected sha256: `818bf1a5…`
- after-probe sha256: `818bf1a5…`
- unchanged: true
- exists: true

**Historical CSV:**
- expected sha256: `d0fca204…`
- after-probe sha256: `d0fca204…`
- unchanged: true

**Probe output directory CSV check:**
- `probe_csv_created`: false — the probe dir did **not** create a `paired_samples.csv`.

**Protected hashes before vs after:** identical on all checked items (source, exe, deliverable CSV, historical CSV).

**Six-run output directory:** `phase22_runs` absent after probe.

**Working tree after probe:** `git status --porcelain` reports only `?? stark/nul` plus the new untracked
`work/.../phase22_planning/`. No staged files; no tracked file modified. The only files created are under
`phase22_planning/`:
- `phase22_planning/probe_launch.py` (the probe)
- `phase22_planning/probe1/ops/{exe_stdout.txt,exe_stderr.txt,exe_exitcode.txt,probe_meta.json}`

**Conclusion:** no diagnostic CSV was created, overwritten, or modified; no frozen evidence changed; no six-run
directory created; no unexpected tracked changes.

---

## 7. Validator results (step 5, continued; and step 6 requirement)

I re-ran the independent validator against the existing Phase 16 CSV with outputs redirected to an isolated directory
under the Phase 22 planning tree:

```
python work/.../phase19_planning/phase19_validate.py \
    --run-dir work/.../run2 \
    --stdout work/.../run2_stdout.txt \
    --out-dir work/.../phase22_planning/validator_selftest
```

**CSV-derived recomputation (from CSV bytes, the part that matters):**
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
- `stdout_available` FAIL — `work/.../run2_stdout.txt` is absent from the workspace

**Frozen metrics recomputed from CSV bytes:**
- `mean_overhead_pct = 8.550597` (threshold ≤ 2.0 → NOT OK)
- `worst_case_overhead_pct = 109.088219` (threshold ≤ 10.0 → NOT OK)
- `median_deviation_pct = 2.116052` (threshold ≤ 2.0 → NOT OK)
- `calibration_status = FAIL`

**Descriptive figures (not calibration metrics):**
- pooled median minimal/instrumented us: 15469.85 / 15797.2
- pooled stdev minimal/instrumented us: 2228.857 / 2530.213
- min pair overhead %: -49.198967
- pairs over 10%: 96 / 300

**Structural-vs-calibration distinction preserved:** the only failed check is `stdout_available`, which is a
cross-check-to-stdout availability issue, not a structural CSV defect. The three threshold checks are recorded as
calibration results (NOT OK), not as structural failures.

**Validator outputs written to isolated tree:**
- `phase22_planning/validator_selftest/validation.json` (2851 bytes)
- `phase22_planning/validator_selftest/validation_report.txt` (1145 bytes)

Deliverable CSV untouched after validator run: still `818bf1a5…`.

**Missing-artifact limitation (documented, not fabricated):**
The Phase 16 stdout artifact `work/.../run2_stdout.txt` is not present in the current workspace, so the validator's
three `recomputed_matches_reported_*` checks could not run. This is a capture precondition gap, not a validator defect.
I did **not** fabricate a PASS for those cross-checks. The CSV-derived recomputation and the threshold comparison are
fully exercised and directly evidenced; the stdout cross-check is absent.

---

## 8. Changed/untracked files and why each exists (step 6)

- `work/.../phase22_planning/probe_launch.py` — the new isolated probe script. Exists because the brief required an
  isolated probe that exercises the real launch lifecycle; modifying `phase19_runner.py` was not necessary and was
  avoided.
- `work/.../phase22_planning/probe1/ops/exe_stdout.txt` — captured child stdout (empty for this early-reject argv).
- `work/.../phase22_planning/probe1/ops/exe_stderr.txt` — captured child stderr (early-reject message + usage).
- `work/.../phase22_planning/probe1/ops/exe_exitcode.txt` — captured child exit code (2).
- `work/.../phase22_planning/probe1/ops/probe_meta.json` — structured probe record.
- `work/.../phase22_planning/validator_selftest/validation.json` — validator JSON output.
- `work/.../phase22_planning/validator_selftest/validation_report.txt` — validator report output.
- `work/.../phase22_planning/...` itself — new untracked planning tree for this phase only.

No file under frozen-evidence trees was created, modified, or deleted.

---

## 9. Explicit verdict (step 6 final requirement)

**READY FOR USER AUTHORIZATION**

The probe safely exercised the full real lifecycle against the real executable:

- exe path and hash verified;
- child created suspended;
- valid affinity mask set and read back and verified before resume;
- child resumed and observed to terminate on its own argument-validation path;
- child exit code 2 and expected early-reject stderr captured;
- handles cleaned up;
- no CSV created/modified;
- protected hashes identical before and after;
- historical and Phase 16 deliverable untouched;
- six-run output directory absent;
- working tree changed only by new untracked probe artifacts.

The one honest limitation is that this probe uses an argv the exe rejects at parse time. That is exactly what the brief
asked for ("an argument that is guaranteed to fail before the measurement function is entered"), so the probe meets the
brief as written. If a later phase wants to observe the child's behavior on an argv that passes the exe's parser but
still avoids measurement, that would be a different capability and would need its own safe design — this probe does not
claim it.

The six-run affinity experiment still requires separate explicit authorization and is **not** begun by this phase.

---

## 10. Boundary compliance

- No `run_bm_b7_diagnostic()` execution.
- No measurement loop.
- No `paired_samples.csv` created, overwritten, or modified.
- No six-run experiment started.
- No G7 campaign or G7CAM record.
- No threshold, formula, historical evidence, Phase 16 CSV, or production binary changed.
- No commit, push, stage, reset, clean, or discard of user changes.
- Existing untracked `stark/nul` preserved.

Stop after writing this report. The probe passed; the six-run experiment is still unauthorized.
