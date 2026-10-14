# Phase 19 — Controlled CPU-Affinity Experiment: Plan and Review

**status:** PREPARATION AND REVIEW ONLY. **No diagnostic run was executed.** No paired-samples CSV was
created. No source file, executable, threshold, formula, or frozen artifact was modified. Nothing was
staged, committed, pushed, or cleaned.
**date_utc:** 2026-10-14
**subject:** `work/b7_diag_20261011_paired_capture/run2/paired_samples.csv` (unchanged, sha256 `818bf1a5…`)
**predecessor:** `phase18_report_timing_order_and_tail.md`
**builds on:** `phase16_report_vs2019_resolved.md` (the launch recipe and the deliverable), `phase17_report_calibration_failure_analysis.md` (the failure being investigated)
**requires:** separate, explicit approval before any of the six runs (see §7)

---

## 0. What this phase establishes

Phase 18 identified **heterogeneous-core scheduling** as the leading but unproven explanation for the B7
timing variability, and noted that the frozen campaign pinned to one logical CPU
(`raw_process_mask: 1`, `verified_single_cpu: true`) while this diagnostic runs unpinned. This phase
prepares the smallest experiment that can address that: three unpinned runs and three pinned runs, same
executable, same workload, same arguments, six distinct previously-absent output directories.

Four things were **done and verified** here, not merely proposed:

1. **CPU identification is now evidence-based, not assumed.** The CPU is a hybrid part; the topology probe
   proves CPUs 0–7 are P-cores and CPUs 8–11 are E-cores via Windows `EfficiencyClass`.
2. **A race-free external affinity mechanism exists and has been tested.** A suspended-process wrapper sets
   and *verifies* the child's affinity before the child executes a single instruction.
3. **The per-run validator has been validated against the frozen data.** It reproduces `8.550597 /
   109.088219 / 2.116052` exactly from the frozen CSV while leaving that CSV and its directory untouched.
4. **The start state is recorded and every preserved artifact re-verified as MATCH.**

---

## 1. Recorded state (step 1)

Full record: [`phase19_planning/00_state_before.txt`](work/b7_diag_20261011_paired_capture/phase19_planning/00_state_before.txt),
produced by [`phase19_planning/00_record_state.sh`](work/b7_diag_20261011_paired_capture/phase19_planning/00_record_state.sh).

| item | value | status |
|---|---|---|
| branch / HEAD | `main` / `30742b15ce7f32e27f0b121a513b2cc6a187c160` ("2") | external commit, not ours |
| **B7 deliverable CSV** | `work/…/run2/paired_samples.csv` → `818bf1a541b8115f2393a3da2b912eb3757b7f187199d5e9b60beca4e167998f` | **MATCH** |
| **historical frozen CSV** | `build/bm_b7_diagnostic/run_1791799501127597800_0/paired_samples.csv` → `d0fca204c9443ef2d0113c12884dfc0fbfc1d64f08c3903f89c98c0c4bf5163a` | **MATCH** |
| diagnostic exe (used for the deliverable) | `stark/build-b7diag-vs2019b/Release/bm_b7_diagnostic.exe` → `86ee9f3ee2c1daac8f2815be4516e2ea03fd19273166978cbf09e6d69ca09d88` | **MATCH** |
| older MinGW diagnostic build (unused here) | `stark/build-b7diag-20261011/bm_b7_diagnostic.exe` → `a2e9e0ada6df0f10a91681e96349349166a081dcca0570312c6d175ad0691bd6` | **MATCH** |
| `bm_b7_diagnostic.cpp` | `aeb31eb2250d05e66a805597624db62f7d66090c7e9b5140b38f9c6f5955ca2b` | **MATCH** |
| `BenchmarkHarness.cpp` | `1b37e95f0cc47568839727bc0ef8836397f705255b47fe85ebe4b988867b4414` | **MATCH** |
| `TinyDenseModel.cpp` / `.h` | `d458e4c9…` / `05f83b7d…` | **MATCH** |
| `CMakeLists.txt` | `575fe264921512f41d30267c1c659e3662bbcfd92e71623720f9d047b7dddcc8` | **MATCH** |
| phase 18 report | `37a074c4df15be29f9f2de6b11c60ed63cce118a435d481d8a8f9df2cf03a845` | recorded |
| `*/paired_samples.csv` repo-wide | exactly **two** (historical + deliverable) | unchanged |
| `phase19_runs/` | **absent** | no run executed |

`git status --porcelain` shows only the pre-existing untracked `stark/nul` and this phase's new
`phase19_planning/` directory. HEAD advanced twice between phases (`f8b1d13`, then `30742b1`) through
commits made by another actor; this phase made no commit.

---

## 2. Implementation inspection and the safest affinity mechanism (step 2)

### 2.1 The invocation contract, exactly

`main()` ([`bm_b7_diagnostic.cpp:1408`](stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp#L1408)) accepts:

```
bm_b7_diagnostic.exe [diagnostic-directory] [--host-capture-dir <relative-dir>]
```

- **There is no workload, iteration, replicate, or threshold argument.** The protocol is compiled in
  (`Protocol{}`: 6 macro-replicates × 50 measurements; thresholds are `constexpr` at lines 157–159:
  `2.0 / 10.0 / 2.0`). The CLI can only change *where* output goes, never *what* is measured.
- The positional directory must be `build/bm_b7_diagnostic` **or a subdirectory of it**
  (`validate_diagnostic_dir`, lines 270–284). The diagnostic itself creates the base directory
  (`ensure_directory`, line 333), then a unique run-owned subdirectory by exclusive `mkdir`, then the blob
  by `O_CREAT|O_EXCL`, and removes only its own artifacts at cleanup.
- The host-capture directory must be **relative**, non-traversal, colon-free, and free of the forbidden
  markers `g7-campaign, g7cam, reports, records, .jsonl, evidence_manifest, gate_results,
  tiny_dense_2l_weights.bin` (`validate_host_capture_path`, lines 1266–1286). It must exist before the run;
  `paired_samples.csv` is created **exclusively and never overwritten**.

### 2.2 Why an external wrapper is the only acceptable mechanism

The diagnostic applies **no affinity control at all**, and says so in its own header:

> "No CPU affinity control is applied (the production campaign pinned a single CPU via HardwareAffinity).
> No CPU-affinity equivalence with the historical campaign is claimed."

The historical mechanism was in-process: `HardwareAffinity::requestAndVerifyFirstCpu()`, recorded as
process affinity `{CPU0}` with `verified_single_cpu=1`
(evidence: [`stark/reports/g7-campaign-affinityfix/highres_v4_analysis.txt`](stark/reports/g7-campaign-affinityfix/highres_v4_analysis.txt),
lines 37, 99, 234).

So affinity must be imposed **from outside**, and the request forbids editing source or executable. An
external launcher is therefore not merely preferred — it is the only option that leaves the timed workload,
the formulas, the thresholds and the historical evidence untouched.

### 2.3 The mechanism, and why it has no race

[`phase19_planning/phase19_runner.py`](work/b7_diag_20261011_paired_capture/phase19_planning/phase19_runner.py)
uses the canonical suspended-start sequence:

```
CreateProcessW(exe, argv, CREATE_SUSPENDED)   # child exists, has NOT executed anything
SetProcessAffinityMask(child, mask)           # pinned only (unpinned: not called)
GetProcessAffinityMask(child)                 # VERIFY -> mismatch aborts, fail closed
ResumeThread(child)                           # first child instruction is already pinned
```

`CREATE_SUSPENDED` is the point: affinity is established while the child is not schedulable, so there is
**no window in which the process can run unpinned**. A naive `Start-Process` + `ProcessorAffinity` would
have exactly such a window (process running between create and set).

Both conditions use the **same** create flags and the **same** code path; the *only* difference is whether
`SetProcessAffinityMask` is called. The wrapper also **fails closed**: if the observed mask does not equal
the intended mask before resume, the child is never resumed.

### 2.4 The mechanism is verified, not assumed

`--self-test` launches a **harmless child** — this same script in `--probe-child` mode, which reports its
*own* `GetProcessAffinityMask` from inside the process. It never launches the diagnostic and creates no CSV.
Result (`phase19_planning/self_test.json`):

| case | mask requested | mask the **child itself reports** | match |
|---|---|---|---|
| unpinned | none | `4095` (0xFFF = all 12 logical CPUs) | ✅ |
| pinned CPU 0 | `0x1` | `1` (logical CPU 0 only) | ✅ |
| pinned CPU 8 | `0x100` | `256` (logical CPU 8, an E-core) | ✅ |

Three conclusions, each empirically established rather than asserted: the mask is in force **from the
child's first instruction**; the child's own view confirms it; and the harness can distinguish a P-core
from an E-core.

`--dry-run` additionally validates the launch preconditions without starting anything (executable present
and hash-matching, host directory previously absent, CSV absent, wrapper itself unpinned, requested mask
inside the system mask). It was run for all six planned runs: **all six cleared**.

---

## 3. The experiment, defined precisely (step 3)

### 3.1 Fixed settings — identical for every run

| element | value |
|---|---|
| working directory | `E:\My Local AI` (same as the deliverable run) |
| executable | `stark/build-b7diag-vs2019b/Release/bm_b7_diagnostic.exe` — the exact binary that produced the deliverable |
| executable hash | must equal `86ee9f3e…`; re-verified per run, abort if not |
| protocol / workload | compiled in, unchanged: 6 replicates × 50 measurements per condition, warm-cache |
| measurement formulas | unchanged (see §4) |
| thresholds | unchanged: `2.0 % / 10.0 % / 2.0 %` |
| launcher | `phase19_runner.py`, no shell |

**On "the same command-line arguments for every run":** the two *path* arguments necessarily differ per
run — that difference is precisely how the distinct-output-directory requirement is met, and the paths are
not part of the measured workload. Every other element of the invocation is identical, and the diagnostic
has no other options at all, so no measurement parameter can vary between the six runs. This is called out
explicitly because a literal reading of "same arguments" and "distinct output directory" cannot both hold.

### 3.2 Output layout — six distinct, previously-absent directories

For run `p19rN`, both directories are **new** and neither can inherit state from another run:

| purpose | path (relative to project root) |
|---|---|
| diagnostic-owned base | `build/bm_b7_diagnostic/p19rN` — a valid subdirectory of `kDiagnosticDir`, auto-created |
| **host capture (deliverable)** | `work/b7_diag_20261011_paired_capture/phase19_runs/p19rN/` |
| CSV | `…/phase19_runs/p19rN/paired_samples.csv` |
| run records | `…/phase19_runs/p19rN/ops/{exec_meta.json,stdout.txt,stderr.txt,exitcode.txt,pre_state.json,post_state.json,validation.json,validation_report.txt}` |

The preserved historical directory `build/bm_b7_diagnostic/run_1791799501127597800_0/` is a **sibling** of
the new `p19rN` directories; the diagnostic's cleanup removes only its own run-owned directory, so the
historical data cannot be reached by any of these runs.

### 3.3 Run order — alternating, three per condition

| order | run id | condition | mask |
|---|---|---|---|
| 1 | `p19r1` | unpinned | none (verified to be all 12 logical CPUs) |
| 2 | `p19r2` | pinned | `0x1` |
| 3 | `p19r3` | unpinned | none |
| 4 | `p19r4` | pinned | `0x1` |
| 5 | `p19r5` | unpinned | none |
| 6 | `p19r6` | pinned | `0x1` |

Unpinned first, so the first run is a direct continuation of the condition that produced the original
failure. Alternating guards against a monotonic drift (warming, thermal, background load) being attributed
to the condition. Runs are separated by a fixed settle interval and no other heavy work is performed
between them.

### 3.4 Per-run records

Written by the runner into `ops/exec_meta.json`: run id and **order**; condition; intended mask and the
**CPUs actually granted**; `affinity_verified_before_resume`, `affinity_drifted`, and the mask observed
after resume and at exit; child pid/tid; the kernel-reported image path with a match flag; start/end local
timestamps and elapsed seconds; **exit code**; stdout/stderr bytes and sha256; CSV bytes and sha256; a
pre-run and post-run snapshot (active power scheme via `powercfg /getactivescheme`, AC/battery status via
`GetSystemPowerStatus`, whole-machine busy fraction via `GetSystemTimes`, best-effort thermal via
`MSAcpi_ThermalZoneTemperature`); the **CPU topology as seen at that moment** — per-core logical CPUs with
OS `EfficiencyClass` and the shared L3 — so each run's record is self-contained and the topology can be
confirmed unchanged across all six runs; and a re-hash of the historical CSV proving it is unchanged.

### 3.5 CPU selection — logical CPU 0, chosen on evidence

Topology probe: [`phase19_planning/topology_probe.ps1`](work/b7_diag_20261011_paired_capture/phase19_planning/topology_probe.ps1),
output [`topology_probe_out.txt`](work/b7_diag_20261011_paired_capture/phase19_planning/topology_probe_out.txt).
It uses `GetLogicalProcessorInformationEx(RelationProcessorCore)` and reports the Windows
**`EfficiencyClass`** — so P-cores are identified by the operating system, not assumed. An earlier draft
had a `UIntPtr` formatting error on the mask lines; the core and cache records printed correctly, and the
mask is independently confirmed by the self-test (`4095` = 12 logical CPUs).

| physical core | logical CPUs | `EfficiencyClass` | class |
|---|---|---|---|
| core 0 | 0, 1 | 1 | **P-core** (HT) |
| core 1 | 2, 3 | 1 | P-core (HT) |
| core 2 | 4, 5 | 1 | P-core (HT) |
| core 3 | 6, 7 | 1 | P-core (HT) |
| core 4 | 8 | 0 | E-core |
| core 5 | 9 | 0 | E-core |
| core 6 | 10 | 0 | E-core |
| core 7 | 11 | 0 | E-core |

Cache: one **12 MiB L3 shared by all 12 logical CPUs**; each P-core has a private 1 MiB L2; the four
E-cores share a 2 MiB L2.

The runner reproduces this table **independently**, through its own ctypes implementation, and writes it
into every run's pre- and post-run snapshot (`runner_topology.txt` is the standalone rendering). Two
independent implementations agreeing — PowerShell P/Invoke and Python ctypes — is why the classification is
reported as established rather than assumed.

**Selection: logical CPU 0.** Verified to exist (it is in both the process and system mask, and the
harmless-child self-test reported `cpus=[0]` when pinned to `0x1`). Two independent reasons:

1. It **is** a P-core — established from `EfficiencyClass=1`, not from the assumption the brief warns about.
2. It is **the exact CPU the frozen production campaign pinned to** (`{CPU0}`, `verified_single_cpu=1`).
   That makes the pinned condition a faithful reproduction of the historical *timing* condition, which is
   what §5 item 6 needs in order to be answerable at all.

**Documented caveat:** CPU 0 has SMT sibling CPU 1 sharing the same physical core, and Windows may still
schedule *other* processes on CPU 1. Pinning therefore does not guarantee exclusive use of the physical
core. This is also true of the historical `{CPU0}` pin, so it is fidelity rather than a defect — but it is
a residual confound and is recorded as one.

Rejected alternatives: **CPU 8** (an E-core with no SMT sibling — the cleanest possible isolation, since it
removes both migration *and* sibling contention, but it is a different core class from the historical pin
and is more exposed to power-state effects); **mask `0x3`** (P-core 0 with both threads — deviates from the
documented single-logical-CPU historical mechanism).

---

## 4. Per-run validation plan (step 4)

Validator: [`phase19_planning/phase19_validate.py`](work/b7_diag_20261011_paired_capture/phase19_planning/phase19_validate.py).
A **new** file; the frozen Phase 16 validator is not modified.

### 4.1 Structural integrity, per run

Header exactly `replicate,iteration,minimal_sec,instrumented_sec,signed_overhead_pct`; **300 data rows**
(301 lines); pair keys **unique** and exactly `{0..5} × {0..49}`; 50 rows per replicate; all values finite;
`minimal_sec` and `instrumented_sec` strictly positive; per-row formula consistency with **0 violations**.

### 4.2 Frozen formulas, reproduced verbatim

```
row   signed_overhead_pct = 100*(instrumented_sec - minimal_sec)/minimal_sec
mean_overhead_pct        = 100*(fmean(instr) - fmean(min)) / fmean(min)          (pooled)
worst_case_overhead_pct  = max over aligned pairs of 100*(instr-min)/min         (signed, unclamped)
median_deviation_pct     = 100*|median(instr) - median(min)| / median(min)       (linear interpolation)
```

### 4.3 Thresholds — unchanged, applied per run

`mean_overhead_pct ≤ 2.0`, `worst_case_overhead_pct ≤ 10.0`, `median_deviation_pct ≤ 2.0`.

Threshold results are recorded in `verdict` and are deliberately **not** counted as structural failures:
a legitimate calibration FAIL is a *result* of a valid run, not a defect in the artifact. (The first draft
conflated them and reported the known-good frozen CSV as "structurally FAIL"; that was fixed and re-verified.)

### 4.4 Reporting rules

Every run is reported **independently, including failures**. No outlier is removed from any run. Each
run's recomputed metrics are independently cross-checked against that same run's own stdout, so the
diagnostic's arithmetic is verified per run rather than trusted.

### 4.5 The comparison is descriptive, never pooled

`--compare` produces one table plus per-condition spread (min / max / range / median over the three runs)
and records, in the artifact itself, these limits:

- it is **not** a pooled six-run calibration result and must not be presented as one;
- **n = 3 per condition gives very limited statistical power** — a range over three values is a weak
  dispersion estimate, and no significance claim is made;
- the frozen thresholds are applied **per run**, unchanged; no outlier is removed.

### 4.6 The validator itself is verified

Run against the frozen deliverable CSV (outputs redirected, so the deliverable directory was not written
to): **16/16 structural checks PASS**, `structural_pass = true`, and the three metrics recomputed from the
raw bytes match the diagnostic's own reported values — `8.550597` vs `8.5506`, `109.088219` vs `109.0882`,
`2.116052` vs `2.1161`. Calibration verdict `FAIL`, as expected. The `run2/` directory still contains
exactly its original five files, and its CSV hash is still `818bf1a5…`.

The `--compare` aggregation path was exercised separately on a clearly-named fixture under
`phase19_planning/compare_selftest/` (`SELFTEST_*`), so no code path ships untested.

---

## 5. Safety and validity risks (step 5)

| # | question | assessment |
|---|---|---|
| 1 | **Same executable and workload for both conditions?** | **Yes, verified.** The exe hash is re-checked per run and the kernel-reported image path is compared to the intended binary; argv differs only in output paths; the protocol is compiled in and has no CLI surface. The only applied difference is the affinity call itself. |
| 2 | **Does the affinity mechanism take effect before the timed process begins?** | **Yes, structurally and empirically.** `CREATE_SUSPENDED` means the child is non-schedulable when the mask is set — there is no race window — and the mask is *verified by read-back* before resume, failing closed. The harmless-child self-test confirms the child's own view of its affinity. **Residual:** nothing in the source calls an affinity API, so drift is not expected, but the runner re-reads the mask after resume and at exit and records any drift rather than assuming none. |
| 3 | **Is the pinned CPU identified correctly?** | **Yes.** CPU 0 exists in both masks; OS-reported `EfficiencyClass=1` makes it a P-core; the child self-reports `cpus=[0]`. |
| 4 | **Are capture paths validated and outputs unique?** | **Yes.** Host directories are required to be *previously absent* (fail closed), CSVs absent, forbidden markers avoided, diagnostic directories are distinct fresh subdirs of `kDiagnosticDir`, and the diagnostic itself refuses to overwrite (`O_EXCL`) and removes only its own run directory. The historical directory is a preserved sibling. |
| 5 | **Can power mode, background load, thermal state, and scheduling still confound?** | **Yes — this is the principal residual risk.** They are *recorded* (pre- and post-run snapshots) but **not controlled**. Three runs per condition cannot separate a condition effect from slow machine drift. The unpinned runs are deliberately exposed to the migration Phase 18 hypothesised — that is the point of the experiment — which also means run-to-run variance necessarily includes machine drift that pinning cannot remove. |
| 6 | **Does a single pinned logical CPU create a different condition from the historical GCC campaign?** | **Yes, and equivalence must not be claimed.** Two differences: (a) **compiler** — this exe is MSVC 19.29, while every frozen G7CAM record is GCC 16.x, so absolute timings are not comparable (Phase 16 recorded this already); (b) **enforcement layer** — the historical pin was applied *in-process* by the harness to the measured thread, whereas here a whole-process mask is applied *externally* to the same logical CPU. Same target CPU, different mechanism. Additionally, the affinityfix analysis notes the historical *diagnostic* process needed ≥2 logical CPUs while the measured thread stayed on CPU 0, so "the historical condition" is not a single uncontested mask. |

Two further validity notes: each run's directories are new, so no run can inherit another's state; and a
single pinned logical CPU with an SMT sibling does not guarantee exclusive use of the physical core (§3.5).

---

## 6. Exact planned commands

Preconditions, once (already cleared by `--dry-run` for all six):

```bash
cd "E:/My Local AI"
sha256sum stark/build-b7diag-vs2019b/Release/bm_b7_diagnostic.exe   # must be 86ee9f3e…
ls work/b7_diag_20261011_paired_capture/phase19_runs 2>&1           # must not exist
```

The six runs, in order (each creates its own previously-absent directory; run them one at a time, with a
fixed settle interval between runs and no other heavy work in between):

```bash
R=work/b7_diag_20261011_paired_capture/phase19_planning/phase19_runner.py
python "$R" --order 1 --run-id p19r1 --condition unpinned
python "$R" --order 2 --run-id p19r2 --condition pinned --mask 0x1
python "$R" --order 3 --run-id p19r3 --condition unpinned
python "$R" --order 4 --run-id p19r4 --condition pinned --mask 0x1
python "$R" --order 5 --run-id p19r5 --condition unpinned
python "$R" --order 6 --run-id p19r6 --condition pinned --mask 0x1
```

Validation, per run (independently), then the descriptive comparison:

```bash
V=work/b7_diag_20261011_paired_capture/phase19_planning/phase19_validate.py
for r in p19r1 p19r2 p19r3 p19r4 p19r5 p19r6; do
  python "$V" --run-dir "work/b7_diag_20261011_paired_capture/phase19_runs/$r"
done
python "$V" --compare
```

Post-run integrity check — the historical CSV and the deliverable CSV must both still hash-match:

```bash
sha256sum build/bm_b7_diagnostic/run_1791799501127597800_0/paired_samples.csv   # d0fca204…
sha256sum work/b7_diag_20261011_paired_capture/run2/paired_samples.csv          # 818bf1a5…
```

---

## 7. Approval required before execution

**Requested:** approval to execute the **six runs in §6**, then their validation, and to report the results.

**Not requested, and not done:** no source or executable edit; no threshold or formula change; no staging,
commit, push, or cleanup; no replacement, deletion, or "correction" of the existing deliverable CSV. The
original recalibrated CSV at `run2/paired_samples.csv` **remains the deliverable of record** — Phase 19
adds six new, separately-reported runs and does not supersede it. Repository cleanup and the fresh push
remain deferred.

**Deliberately not executed:** the six diagnostic runs. The only child processes started during this phase
were the harmless self-test child, read-only `powercfg`, a read-only CIM thermal query, and read-only
`sha256sum`/`git` invocations. No diagnostic process was ever created and no paired-samples CSV was written.

**Artifacts produced by this phase** (all new, all inside `work/…/phase19_planning/`):

| path | purpose |
|---|---|
| `phase19_runner.py` | external, race-free affinity launch wrapper (`--run-id/--condition/--mask/--order`, plus `--self-test`, `--probe-child`, `--dry-run`) |
| `phase19_validate.py` | per-run validator reproducing the frozen formulas; `--compare` for the descriptive comparison |
| `topology_probe.ps1`, `topology_probe_out.txt` | `EfficiencyClass` P-core/E-core evidence (PowerShell implementation) |
| `runner_topology.txt` | the same classification from the runner's own ctypes implementation, captured per run |
| `00_record_state.sh`, `00_state_before.txt` | step-1 state record and hash verification |
| `self_test.json`, `self_test_*.txt` | affinity-mechanism verification on a harmless child |
| `validator_selftest_run2/` | proof the validator reproduces the frozen metrics, without writing into the deliverable directory |
| `compare_selftest/` | fixture exercising the aggregation path (`SELFTEST_*` names) |

---

## 8. Honest limitations

- **The experiment has not been run, so nothing here is a result.** The plan's value is that its two
  instruments — the affinity mechanism and the validator — have been executed and verified.
- **The power-mode and thermal context is measured, not controlled.** The pre/post snapshots bracket each
  run and may themselves perturb it slightly (they sample CPU counters and spawn `powercfg`), though they
  run outside the measured region.
- **The `EfficiencyClass` probe was taken now, not during the original B7 run.** It establishes the current
  topology; Phase 18's caveat that the original run's environment was never recorded still stands.
- **Two commands could not be fully verified before approval:** the real six-run invocation (by design) and
  the `--compare` output on real data. The comparison *logic* is verified on a fixture; its real-data
  behaviour can only be confirmed after the runs. The comparison is in any case descriptive, not a verdict.
- **Three runs per condition cannot establish repeatability of the *original* failure.** This experiment
  tests whether pinning changes the *dispersion* of a single-condition measurement. Nothing here should be
  reported as a fixed, reproducible effect on the basis of six runs.
- **The `worst_case_overhead_pct` statistic remains outlier-dominated** (109.09 % originally, versus pooled
  medians 15 469.85 / 15 797.20 µs). Pin-stability will be most visible in the spread and the >10 % pair
  count, not in the mean alone; both are recorded per run.
