# Phase 28 — Finalize B7 Experiment Matrix and Validator Profile

**Status:** design-only  
**Created artifacts:** only this report  
**Decision:** `READY FOR USER AUTHORIZATION`

---

## 0. Purpose

This report resolves the remaining pre-experiment design decisions that the Phase 25 design, Phase 26 protocol, and Phase 27 consistency audit left as parameters or caveats. It nails down scope, topology, sample counts, validator profile, instrumentation comparison, output isolation, failure policy, and interpretation boundaries.

It is design-only. It does not edit source, validator, runner, CMake, binaries, CSVs, or prior reports. It does not build, execute, benchmark, or collect measurements. It does not run G7, does not create G7CAM records, and does not authorize any G7 activity. It does not change thresholds, calibration formulas, M0, or M1. It does not stage, commit, push, reset, clean, or discard files. It preserves `stark/nul` and all existing user work.

---

## 1. Actual Git state and evidence state used as inputs

### 1.1 Git state at design time

Recorded directly from the repository at design time:

- Branch: `main`
- HEAD: `9e4eeb5f588f319204f5f79f86c759e471efd52a`
- Upstream: `origin/main` (`refs/heads/main`)
- Local vs upstream: local HEAD is at or ahead of upstream (`merge-base --is-ancestor HEAD origin/main` is true)
- `git status --porcelain`:

```
?? stark/nul
```

- Recent log top-4:

```
9e4eeb5 (HEAD -> main, origin/main, origin/HEAD) a
acd85db a
9795c35 w
d9911e8 w
```

Interpretation: working tree clean except for the pre-existing untracked `stark/nul`, which is preserved. HEAD moved again since Phase 27; branch tips are recorded for provenance only.

### 1.2 Protected hashes re-checked before writing this report

- Diagnostic source `aeb31eb2…` — OK
- CMake configuration `575fe264…` — OK
- Benchmark harness source `1b37e95f…` — OK
- Phase 19 plan `1451f1cb…` — OK
- Phase 22 report `e6ea3fa1…` — OK
- Phase 23 report present: `34045b5d6844…`
- Phase 24 audit present: `e441c615e809…`
- Phase 25 design present: `86d69ffa26a4…`
- Phase 26 protocol present: `1343ad6529b1…`
- Phase 27 audit present: `eb8a96a7e030…`
- Phase 19 runner present: `21b51e4592b1…`
- Phase 19 validator present: `6285cc12bd03…`

All present protected artifacts intact. No protected artifact modified by this report.

### 1.3 Inherited gaps carried into this matrix

- Phase 16 deliverable CSV missing on the audited path.
- Historical frozen CSV missing on the audited path.
- Phase 16 stdout artifact absent, so the validator's stdout cross-checks cannot be re-exercised from the workspace.
- Frozen executable `86ee9f3e…` evidenced on the `vs2019b` path, not on the `vsc-direct` path.

These are recorded as gaps, not reconstructed.

---

## 2. Primary scope: warm-cache only

### 2.1 Decision

The primary experiment scope is **warm-cache only**. Attempted-cold is excluded from the primary experiment.

### 2.2 Justification

The primary objective is to localize where variability lives inside the existing measurement, using the existing measurement semantics. Warm-cache is the posture the existing diagnostic, existing runner, and existing prior phases already use. Making warm-cache the primary scope keeps the experiment closest to the evidence it is meant to explain, and it avoids introducing a second state variable that the current evidence cannot support.

Attempted-cold remains a separate future possibility only. If it is ever executed, it must be:

- concretely described,
- pre/post captured,
- and labeled attempted/unverified unless a verifiable state difference is captured.

### 2.3 What this decision removes

It removes state-context as a factor in the primary matrix. The primary matrix therefore has one state context: warm-cache. It does not claim cache state is controlled; it only says the primary experiment observes the system in its default warm posture without performing cache flushes or claiming cache equivalence with any earlier campaign.

---

## 3. Affinity contexts

### 3.1 Decision

Two affinity contexts:

- Context A: unpinned, running under the system mask.
- Context B: pinned to logical CPU 0, mask `0x1`, using the existing verified launch procedure.

### 3.2 Why these two

These are the only two affinity contexts that the existing Phase 19 runner already implements and verifies. Using them keeps the matrix inside the proven enforcement primitive: `CREATE_SUSPENDED`, `SetProcessAffinityMask` while suspended, `GetProcessAffinityMask` verification before resume, resume, and drift checks after resume and at exit.

### 3.3 Historical-equivalence caveat

The matrix does not claim Context B is a reproduction of the historical in-process affinity method. It is the current external whole-process mask, recorded as such. That distinction remains explicit.

### 3.4 Affinity as a between-launch factor

Affinity context is between-launch, not within-launch. A single process launch is created under one mask; it cannot be both unpinned and pinned. Therefore the matrix has exactly one launch per affinity context, not one launch covering both.

---

## 4. Within-launch structure and counterbalancing

### 4.1 Decision

- `measurement_count = 50`
- `macro_replicates_per_condition = 8`
- Two conditions per launch: MINIMAL and INSTRUMENTED.
- Counterbalanced schedule: even replicate indices run MINIMAL first then INSTRUMENTED; odd replicate indices run INSTRUMENTED first then MINIMAL.

### 4.2 Source grounding

This matches the existing `build_schedule()` rule in `bm_b7_diagnostic.cpp`:

- even replicate indices: `minimal_first = true`
- odd replicate indices: `minimal_first = false`

and the existing loop in `run_bm_b7_diagnostic()`:

```text
const auto schedule = build_schedule(proto.macro_replicates);
for (const auto& entry : schedule) {
    const Mode first  = entry.minimal_first ? Mode::MINIMAL : Mode::INSTRUMENTED;
    const Mode second = entry.minimal_first ? Mode::INSTRUMENTED : Mode::MINIMAL;
```

The source therefore supports the matrix's within-launch structure generically for 8 replicates.

### 4.3 What this balances

Within one launch:

- first-position vs second-position is balanced across MINIMAL and INSTRUMENTED,
- each macro-replicate is separately timed and recorded,
- executed order is recorded verbatim.

It does **not** balance affinity across first/second position inside one launch, because affinity is between-launch.

---

## 5. Exact launch count, CSVs, rows, and sufficiency framing

### 5.1 Exact numbers

For the primary experiment:

- Affinity contexts: 2
- State contexts in primary scope: 1 (warm-cache)
- Launches: 2 (one per affinity context)
- Macro-replicates per launch: 16 (8 MINIMAL + 8 INSTRUMENTED)
- Measured iterations per launch: 800 (16 × 50)
- Host-captured `paired_samples.csv` files: 2
- `ops/` directories: 2
- Run directories under the isolated root: 2, one per launch
- Total measured iterations across the primary experiment: 1600 (2 × 800)
- Total host CSV measured rows across the primary experiment: 1200
- Minimal rows across the primary experiment: 800
- Instrumented rows across the primary experiment: 800

The row arithmetic:

- per launch: 8 MINIMAL macro-replicates × 50 = 400 minimal rows, 8 INSTRUMENTED macro-replicates × 50 = 400 instrumented rows
- per launch: 800 measured rows
- two launches: 800 + 800 = 1600 measured rows
- minimal total across experiment: 400 + 400 = 800 rows
- instrumented total across experiment: 400 + 400 = 800 rows

### 5.2 Per-launch CSV shape

Each launch's host CSV has:

- 400 minimal rows
- 400 instrumented rows
- 800 measured rows total
- `(replicate, iteration)` keys `{(0..7, 0..49)}` for each condition

This is the direct 8-replicate analogue of the existing 6-replicate CSV shape.

### 5.3 Why 2 launches is the right primary size

Two launches is the minimum coherent matrix for the stated objective: one unpinned and one pinned, with identical within-launch structure. That is enough to:

- reproduce the existing paired-grain structure at a larger replicate count,
- separate condition effects from within-launch order effects,
- and localize variability across the existing coarse buckets under two affinity contexts,

without turning the experiment into a broad open-ended campaign.

### 5.4 What this does and does not claim

It claims enough structure to localize variability and to compare affinity contexts under an otherwise identical protocol.

It does **not** claim in advance that two launches are sufficient for statistical significance, for a root-cause conclusion, or for any particular magnitude of inference. Sufficiency for strong claims is an analysis question for after the data are collected, not a premise of the design.

---

## 6. Validator profile

### 6.1 Existing validator assumptions

The existing Phase 19 validator hardcodes:

- `EXPECTED_REPLICATES = 6`
- `EXPECTED_MEASUREMENTS = 50`
- `EXPECTED_ROWS = 300`
- header `["replicate", "iteration", "minimal_sec", "instrumented_sec", "signed_overhead_pct"]`
- frozen formulas:
  - `signed_overhead_pct = 100*(instrumented_sec - minimal_sec)/minimal_sec`
  - `mean_overhead_pct = 100*(fmean(instr) - fmean(min))/fmean(min)`
  - `worst_case_overhead_pct = max over aligned pairs of 100*(instr-min)/min` (signed, unclamped)
  - `median_deviation_pct = 100*abs(median(instr) - median(min))/median(min)`
- frozen thresholds: mean `2.0`, worst `10.0`, median deviation `2.0`

The existing validator therefore validates exactly the existing 6×50 grain.

### 6.2 The mismatch to resolve

An 8×50 primary experiment produces per-launch CSVs with 8 replicates per condition and 400 rows per condition. The existing validator constants would reject those CSVs if applied verbatim. The matrix must therefore either:

- adjust the existing validator's constants, or
- use a separate eight-replicate profile.

### 6.3 Decision: separate isolated eight-replicate profile

The matrix chooses a **separate, isolated eight-replicate validator profile**, not a modification of the existing validator.

### 6.4 What the eight-replicate profile contains

It reuses exactly the same frozen formulas and thresholds as the existing validator:

- same header,
- same per-row formula,
- same mean/worst/median formulas,
- same thresholds: 2.0, 10.0, 2.0,

and changes only the replication constants for the new grain:

- `EXPECTED_REPLICATES = 8`
- `EXPECTED_MEASUREMENTS = 50`
- `EXPECTED_ROWS = 400`

It validates one launch's host CSV against the 8-replicate grain.

### 6.5 What is preserved

- The existing 6-replicate validator is preserved unchanged and remains usable for existing 6×50 evidence.
- The frozen formulas are preserved.
- The thresholds are preserved.
- The existing calibration semantics are preserved.

### 6.6 What is not done

- The existing validator file is not edited.
- The existing six-replicate validation behavior is not altered.
- No new threshold or formula is introduced.
- The eight-replicate profile is additive, not a substitute.

### 6.7 Artifact rule for the eight-replicate profile

The eight-replicate profile itself must be stored under the same isolated phase root as the experiment outputs, and its own hash must be recorded in the experiment manifest. That keeps the profile auditable and separate from the frozen validator.

---

## 7. Instrumentation comparison

### 7.1 Objective

Estimate the effect of finer instrumentation against the existing instrumented baseline, without confusing that estimate with the existing instrumented-vs-minimal calibration.

### 7.2 Minimum comparison

The minimum comparison is two-step:

1. existing instrumented vs minimal → existing instrumentation overhead, using the frozen calibration.
2. finer instrumented vs existing instrumented → additional overhead from the finer instrumentation.

The matrix requires both steps to be reported, because only step 2 isolates the marginal cost of the extra clock reads.

### 7.3 What counts as the finer instrumented baseline

The finer instrumented condition is the same operation, same total bracketing, same existing instrumented outer total, plus extra internal clock reads for the finer components. If the finer instrumentation changes the existing instrumented total, that change must be reported explicitly as evidence, not absorbed into the decomposition.

### 7.4 Descriptive vs calibration status

The finer-component summary statistics are descriptive. They are not a replacement for the frozen calibration. The frozen calibration is computed from the existing grain and reported separately.

---

## 8. Output isolation

### 8.1 Isolated root

All primary experiment outputs go under a new, unique output root with no-overwrite behavior: each host-capture directory must be previously absent before a launch is created, and no retry may overwrite an existing host directory or CSV. Output root:

- `work/b7_diag_20261011_paired_capture/phase28_b7_read_path/`

No outputs go into `phase16_vs2019`, `phase19_runs`, or any other prior phase directory.

### 8.2 Per-launch artifact shape

- `work/b7_diag_20261011_paired_capture/phase28_b7_read_path/`

No outputs go into `phase16_vs2019`, `phase19_runs`, or any other prior phase directory.

### 8.2 Per-launch artifact shape

For each launch:

- one launch directory with a unique name,
- `ops/` containing `exec_meta.json`, `pre_state.json`, `post_state.json`, `stdout.txt`, `stderr.txt`, `exitcode.txt`,
- the host-captured `paired_samples.csv` under the launch's host-capture directory,
- the eight-replicate validator profile output for that launch, if that profile is used,
- and a per-launch manifest entry.

### 8.3 Exact primary experiment totals

- Launches: 2 launches (one per affinity context).
- Host-captured `paired_samples.csv` files: 2.
- `ops/` directories: 2.
- Run directories under the isolated root: 2.
- Total measured iterations: 1600.
- Total measured rows: 1200.
- Minimal rows total: 800.
- Instrumented rows total: 800.

Each launch contributes:

- 400 minimal rows,
- 400 instrumented rows,
- 800 measured rows.


If the finer decomposition is implemented, each launch also produces a decomposition CSV with the frozen grain first and the descriptive columns clearly separated.

### 8.3 No-overwrite behavior

- Each host-capture directory must be previously absent.
- Each run-owned diagnostic directory must be created exclusively.
- No retry may overwrite an existing host directory or CSV.
- If a launch fails before producing a valid artifact, the failure is recorded and the partial state is not promoted.

### 8.4 Manifests

Each launch gets a manifest recording:

- run id and launch order,
- affinity context,
- state context,
- executable path and SHA-256,
- protocol version,
- exact command used,
- pre/post snapshots,
- affinity verification evidence,
- stdout/stderr/exitcode paths and hashes,
- host CSV path, size, and SHA-256,
- eight-replicate profile hash, if used,
- historical CSV unchanged confirmation,
- and protected-hash pre/post confirmation.

An experiment-level manifest aggregates the per-launch manifests.

---

## 9. Failure policy

## 9. Failure policy

- No G7 campaign is run, no G7CAM record is created, and no G7 activity is authorized by this report.
- This report does not authorize building, executing, benchmarking, or collecting measurements.
- This report does not authorize staging, committing, pushing, resetting, cleaning, or discarding files. It did not stage any file and it preserves `stark/nul` and all existing user work.
- This report does not change thresholds, calibration formulas, M0, or M1.

### 9.1 Launch failures

If `launch_suspended()` raises or the child fails to start cleanly, the launch is recorded as failed and no CSV is produced for it. It is not retried into an existing directory.

### 9.2 Affinity verification failures

If affinity verification before resume fails, the runner fails closed and the launch is recorded as failed. A launch with a failed affinity verification is not valid evidence for the pinned context.

### 9.3 Incomplete CSVs

If a CSV is missing, incomplete, or does not match the expected 8×50 shape, the launch is recorded as invalid for the frozen-grain analysis and not promoted.

### 9.4 Missing stdout

If `stdout.txt` is missing or unreadable, the stdout cross-checks are recorded as unavailable, not passed or failed silently.

### 9.5 Invalid samples

If any sample is non-finite, non-positive, or violates the per-row formula, the eight-replicate profile records those as failed checks. Such a CSV is not treated as a valid frozen-grain artifact.

### 9.6 Environmental anomalies

If a pre/post snapshot or affinity read-back shows an anomaly worth noting, the launch is still recorded, but the anomaly is recorded explicitly as a caveat. The experiment does not silently ignore anomalies.

### 9.7 M0/M1 and G7 under this matrix

- M0 remains **FAIL** because this matrix is design-only and produces no new calibration evidence.
- M1 remains **LOCKED** because this matrix does not unlock it and does not change any classification logic.
- No G7 campaign is run, no G7CAM record is created, and no G7 activity is authorized by this report.

### 9.8 Stopping

The primary experiment stops when the two planned launches are complete, or earlier if a launch fails in a way that cannot be recovered without violating the no-overwrite or affinity-verification rules. In either case, the artifacts produced so far are reconciled independently before any interpretation.

---

## 10. Interpretation boundaries

### 10.1 What the experiment can support

The primary experiment can support:

- a localized descriptive comparison of variability across the existing coarse buckets under two affinity contexts,
- a within-launch separation of condition effects from first/second-position order effects,
- a between-launch comparison of unpinned vs pinned under identical warm-cache structure,
- and an estimate of finer-instrumentation overhead relative to the existing instrumented baseline.

### 10.2 What remains out of scope

The primary experiment does not, by itself, establish:

- a root cause,
- statistical significance in advance,
- cache-state control or cache equivalence with any earlier campaign,
- historical in-process affinity equivalence,
- or any conclusion that depends on a cold-state contrast.

### 10.3 How conclusions must be labeled

Any conclusion must be labeled either:

- descriptive, or
- calibration-relevant under the frozen formulas,

and no descriptive observation may be presented as a frozen-gate verdict.

---

## 11. Decision

The matrix resolves the remaining pre-experiment decisions into one coherent, warm-cache-only, two-affinity-context, 8×50, two-launch primary design, with a separate isolated eight-replicate validator profile that preserves the existing validator, formulas, and thresholds.

**Decision:** `READY FOR USER AUTHORIZATION`

This decision concerns the finalized experiment matrix and validator profile only. It does not authorize building, executing, measuring, or modifying anything.
