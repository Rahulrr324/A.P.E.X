# Phase 48 — Experiment Design and Evidence-Gap Review

**Mode:** read-only planning and source review. No build, launch, or measurement.

**Evidence reviewed (read-only):**
- [phase46_forensics_report.md](work/b7_diag_20261011_paired_capture/phase46_forensics_report.md)
- [phase47_timing_pattern_report.md](work/b7_diag_20261011_paired_capture/phase47_timing_pattern_report.md)
- [bm_b7_diagnostic.cpp](stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp) — read from source lines
- [phase33_paired_csv_validator.py](work/b7_diag_20261011_paired_capture/phase33_paired_csv_validator.py) — frozen validator
- [CMakeLists.txt](stark/CMakeLists.txt) — build integration
- prior protocol/planning docs referenced for context only

**Preserved frozen artifacts (hashes unchanged):**
- validator `9f6d6c29a1b1c1e59ddec1fa4ad4b6499cb2b2f8c692e421bf94c10fc6a1e8e6`
- exe `f50fda5a3486fa7d3225869d978a841c2d1fa10f92413530b1cda067b1000147`
- source `aeb31eb2250d05e66a805597624db62f7d66090c7e9b5140b38f9c6f5955ca2b`
- cmake `575fe264921512f41d30267c1c659e3662bbcfd92e71623720f9d047b7dddcc8`
- historical Phase 36 CSV `a09a0d3c37168dc88ecce79013d6e523c5aa2d101c726bb1ad0edadc0e89706d`

M0 = FAIL, M1 = LOCKED preserved.

---

## 1. How minimal and instrumented timings are ordered, paired, and summarized

### Source-verified structure

From [bm_b7_diagnostic.cpp](stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp):

- **Protocol defaults (constexpr, source of truth):**
  - `kWarmupIterations = 10` (untimed)
  - `kMeasuredIterations = 50` (measured)
  - `kMinMacroReplicates = 6` (per condition, sequential, process-local)
  - `kCalibMeanOverheadThresholdPct = 2.0`
  - `kCalibWorstOverheadThresholdPct = 10.0`
  - `kCalibMedianDeviationThresholdPct = 2.0`

- **One macro-replicate (`run_replicate`):**
  - Each replicate has an index and a mode (`minimal` or `instrumented`).
  - It runs `warmup_count` untimed iterations first (any warmup failure invalidates the whole replicate).
  - Then it runs `measurement_count` measured iterations.
  - Each measured iteration is bracketed by a single outer `steady_clock` pair, so each sample is `total_sec` for that iteration.
  - Replicates are recorded as `total_samples_sec` vectors; a replicate is valid only if it has exactly `measurement_count` samples and no warmup/failure.

- **Condition ordering (`build_schedule`):**
  - The schedule is counterbalanced by replicate index: even-indexed replicates run MINIMAL first, odd-indexed replicates run INSTRUMENTED first.
  - The executed order is recorded in the report via `executed_order`.
  - Pairing for calibration is by replicate index: replicate `i` MINIMAL is paired with replicate `i` INSTRUMENTED.

- **Calibration (`calibrate`):**
  - Requires `required_replicates` valid replicates in BOTH conditions.
  - Pooled mean overhead = `100 * (mean_instr − mean_min) / mean_min`, pooled over all valid samples.
  - Worst-case overhead = maximum signed `100 * (instr − min) / min` over aligned `(replicate, iteration)` pairs; never clamped to zero; if every paired overhead is negative, the reported max is negative.
  - Median deviation = `100 * abs(median_instr − median_min) / median_min`, using pooled medians via `summarize()`.
  - Status is PASS only when all three computed and within threshold; FAIL when all three computed and any exceeds threshold; INCONCLUSIVE otherwise.
  - This is the exact source-of-truth formula that the CSV `signed_overhead_pct` column and the frozen thresholds reuse.

- **Paired CSV write (`PairedArtifact::write`):**
  - Emits one row per aligned `(replicate, iteration)` pair: `replicate,iteration,minimal_sec,instrumented_sec,signed_overhead_pct`.
  - Written only when every replicate in BOTH conditions is valid (the same pre-condition `calibrate()` requires for worst-case).
  - Formula used when writing is exactly `100.0 * (b[j] − a[j]) / a[j]`.
  - Write is exclusive/no-overwrite, to a caller-configured host path; if that directory does not exist, exclusive creation fails and nothing is persisted.

### Important consequence for design

The diagnostic pairs replicate `i` MINIMAL with replicate `i` INSTRUMENTED within a single process execution. That means:
- Pairing is **within-run**, by replicate index, not across runs.
- A single process execution produces one CSV with one replicate→instrumented pairing schedule.
- Cross-run comparisons in Phases 45–47 are comparisons of **separate process executions**, not of within-run replicate pairs. That is why those runs are temporally dependent process-local macro-replications rather than independent replicates of one paired schedule.

---

## 2. Evidence gaps identified from the existing reports and source

### 2.1 No per-run launch metadata in Phase 45 captures

Each Phase 45 run directory contains only:
- `paired_samples.csv`
- `validation.json`
- `validation_exit.txt`

Absent in all five runs:
- `stdout.txt`
- `stderr.txt`
- `exitcode.txt`
- `hashes.txt`
- `exec_meta.json`

This was already documented in Phases 46–47. The practical gap is that we cannot independently reconstruct, for each run:
- the exact argv used
- the working directory at launch
- the executable SHA-256 at launch
- the wall-clock launch timestamp
- any affinity/policy state that may have been in effect
- whether the host-capture directory existed before launch or was created as part of preflight

We **can** reconstruct the CSV and validator results, but not the run-local execution context that would let us attribute run-to-run differences.

### 2.2 Within-run order effects are only partially recorded

The source records the executed condition order per replicate in the stdout report, but the Phase 45 CSVs do **not** contain a condition-order column. The CSV is a paired `(replicate, iteration)` table, not a chronological log. That means:
- We can see the final paired outcome.
- We cannot directly re-derive, from the CSV alone, which condition ran first on a given replicate in a given run.
- Counterbalancing exists in the source, but its effect cannot be checked from the persisted CSV without the report metadata.

### 2.3 Ratio sensitivity to small denominators is a real confound

From source: the paired overhead formula uses `minimal_sec` in the denominator. Phases 46–47 show that extreme positive ratios often coincide with very small minimal values and large instrumented values. That is not a bug; it is a property of the chosen metric. The design gap is that the existing data do not include an auxiliary view that separates:
- genuine systematic shift in instrumented vs minimal, from
- ratio amplification caused by small minimal denominators.

### 2.4 The current executable is a fresh binary, not the historical Phase 36 binary

Source, cmake, validator, and the fresh exe are unchanged and verified. But the already-built `bm_b7_diagnostic.exe` is the Phase 45 fresh executable, and Phase 45/46/47 explicitly do not claim it equals the historical Phase 36 binary. That is a fact about the evidence set, not a defect, but it constrains any historical comparison.

### 2.5 Warm-cache, no affinity control, process-local replications

The source explicitly documents these as limitations and does not claim equivalence to the historical campaign’s cache/affinity conditions. Any new design must treat those as known confounds, not as controlled factors, unless they are explicitly added and recorded.

---

## 3. Smallest experiment that can distinguish the four concerns

The smallest useful experiment is a **single process execution that still records enough metadata to be interpretable later**, plus a **small counterbalanced repetition under one frozen binary**, designed so each concern has a visible discriminant.

### 3.1 What must be distinguishable

1. **General timing drift / system load:** shift in both conditions together over time, across repetitions, or across the session.
2. **Order effects between minimal and instrumented:** whether the first-run condition in a replicate tends to differ from the second, beyond pairing.
3. **Unusually small minimal timings inflating percentage ratios:** whether worst-case positive overhead concentrates in low-minimal pairs.
4. **Instrumentation-specific overhead:** whether the paired difference is attributable to the steady_clock reads / instrumentation structure rather than to non-instrumentation noise.

### 3.2 Why each is hard with the existing data

- Drift/load: we do not have timestamps or repeated back-to-back executions under recorded conditions, so we cannot separate session drift from one-off noise.
- Order effects: CSVs lack chronological order; without order metadata we cannot test first-vs-second condition bias directly.
- Small-minimal inflation: existing data show it is plausible, but existing analysis only describes it; a design that bins by minimal magnitude or uses a ratio-insensitive auxiliary metric would test it.
- Instrumentation-specific overhead: the existing design already measures it in principle via the calibration, but the calibration is dominated by tail behavior; a design that also records component decomposition and per-sample residuals would let us see whether worst-case ratios come from the instrumentation structure or from unrelated timing noise.

### 3.3 Smallest discriminating design idea

A minimal discriminating design is **not one giant run**. It is a small set of **short, fully recorded, counterbalanced paired runs** under the same frozen binary, where each run preserves:
- exact argv
- working directory
- executable SHA-256
- launch timestamp
- condition order per replicate
- the same paired CSV
- component decomposition data if available
- exit code and validation result

With that, each concern gets a visible handle:
- Drift/load: visible in run-to-run shifts when context is known.
- Order effects: visible because condition order is recorded per replicate.
- Small-minimal inflation: visible if analyzed with bins or ratio-insensitive summaries alongside the frozen ratio.
- Instrumentation overhead: visible through calibration plus decomposition, not assumed.

---

## 4. Proposed counterbalanced sequence design

This is a specification for a future authorized phase, not executed here.

### 4.1 Fixed frozen contract

- Binary: use one verified executable, with SHA-256 recorded before every launch.
- Protocol: keep `warmup = 10`, `measured = 50`, `macro_replicates_per_condition = 6` unless a future authorization explicitly changes them.
- Frozen formulas and thresholds unchanged:
  - Mean overhead ≤ 2%
  - Worst signed paired overhead ≤ 10%
  - Median deviation ≤ 2%
  - PASS only when all three pass.
- Pairing: replicate `i` MINIMAL vs replicate `i` INSTRUMENTED, per source.
- Counterbalancing: even replicates MINIMAL-first, odd replicates INSTRUMENTED-first, per source.

### 4.2 Per-run provenance recorded in every run directory

Every run directory must contain, at minimum:
- `argv.txt` — exact argv vector used
- `cwd.txt` — working directory at launch
- `exec_sha256.txt` — executable SHA-256 at launch
- `launch_ts.txt` — wall-clock launch timestamp
- `source_rev.txt` — source revision identifier available at plan time, e.g. git describe/commit hash and relevant file paths
- `build_config.txt` — compiler and CMake/build configuration available at plan time
- `system_state.txt` — whatever system-state metadata is available and safe to record (for example OS-reported clock/time context, and a note about what is NOT controlled)
- `condition_order.json` — per-replicate `{replicate, minimal_first, condition_first, condition_second}`
- `paired_samples.csv` — same schema as existing
- `stdout.txt`, `stderr.txt`, `exitcode.txt`
- `validation.json`, `validation_exit.txt`
- `hashes.txt` — CSV SHA-256 and other captured artifact hashes
- `exec_meta.json` — compact run meta: run id, sequence index, binary hash, protocol, timestamps

### 4.3 Sequence

A minimal counterbalanced sequence could be something like:

1. **Run A:** one full paired execution under frozen binary A, everything recorded.
2. **Run B:** second full paired execution under same binary, back-to-back if feasible, everything recorded.
3. **Run C:** optional third execution to check repeatability of tail behavior.

If the goal includes testing order-effect sensitivity more directly, the sequence should include **alternating condition-order strategy variants only if the source supports a different schedule**, or more realistically, treat the existing counterbalancing as the fixed order structure and test whether results are stable across repetitions under that fixed structure.

The important point is: **small, fully recorded, reproducible in provenance, not large and unrecorded.**

---

## 5. Persistence and directory creation rules

### 5.1 Create directories before launch

For each planned run `rN`, pre-create:
- `<sequence_root>/rN/`

and confirm it is empty before launch.

This directly addresses the Phase 43 persistence failure root cause: `PairedArtifact::write()` uses exclusive file creation into a caller-supplied host directory; if that directory does not exist, the write cannot create the CSV and the run persists nothing. Pre-creating the destination is a run-setup step, not a source change.

### 5.2 Persist everything, every run

For each run:
- Capture stdout, stderr, exit code.
- Compute and store CSV SHA-256 immediately after write.
- Run the frozen Phase 33 validator and store its output and exit code.
- Store executable hash before and after.
- Store the run-local metadata listed above.

### 5.3 No overwrite, no retry on persistence failure

If a run’s CSV does not appear, or validation fails to run, or any required artifact is missing, stop and preserve evidence. Do not retry into the same directory. Do not overwrite an existing capture.

---

## 6. Pre-registered analysis plan

### 6.1 Metrics (frozen)

- Mean overhead
- Worst signed paired overhead
- Median deviation
- Counts:
  - pairs above +10%
  - pairs below −10%
  - pairs with |overhead| > 10%
- Overhead quantiles: p50, p90, p95, p99, max, min
- Per-replicate mean overhead and extreme range
- Optional ratio-insensitive auxiliary view: for example bin pairs by minimal magnitude and report overhead distribution within bins; report absolute instrumented−minimal differences alongside ratios.

### 6.2 Per-run verdict

Each run gets its own verdict under the frozen rules. No run is represented by a pooled verdict that overrides it.

### 6.3 Tail summary

For each run, report worst-case and upper quantiles, and the exact `(replicate, iteration)` keys and raw timings for the largest positive and negative ratios.

### 6.4 Order comparison

If condition order is recorded per replicate, compare first-condition vs second-condition behavior within runs where possible, and compare across runs where the same counterbalanced schedule is used. Label any cross-run comparison as temporally dependent unless the design explicitly controls for it.

### 6.5 Small-minimal analysis

Pre-specify a minimal-magnitude binning or threshold analysis for the positive tail, so that “worst case is large” is not the only reported fact. The point is to test whether the worst positive ratios are concentrated in a small-minimal regime or are spread more broadly.

### 6.6 Exclusions

Pre-specify that any run missing required artifacts is excluded from metric reporting and treated as a stop event, not silently patched.

### 6.7 Stop conditions

Stop and preserve evidence if:
- any run fails to launch
- any run’s CSV is missing or malformed
- any run’s validation cannot be run
- any required metadata artifact is missing
- persistence fails again

No retries into the same capture directory.

---

## 7. Source changes that would be required — identified, not implemented

### 7.1 Nothing in the current source prevents a fully recorded run, but nothing in the current source currently writes the proposed run-metadata files either

The source already writes:
- the stdout report
- the paired CSV under a configured host path

It does **not** currently write, by itself:
- `argv.txt`, `cwd.txt`, `exec_sha256.txt`, `launch_ts.txt`, etc.

So a fully metadata-rich capture currently depends on an external harness writing those artifacts around the launch, or on extending the diagnostic to emit them. Either is a change; this phase does not choose or implement one.

### 7.2 The CSV schema is already correct for paired analysis

The CSV header and formula are already aligned with `calibrate()`. No schema change is needed for the frozen metrics. Auxiliary analyses can be done downstream from the same CSV.

### 7.3 Order metadata is the main schema-adjacent gap

Because `paired_samples.csv` is a paired table and not a chronological log, order-effect analysis needs either:
- the report’s `executed_order` captured as a file, or
- an explicit per-replicate order artifact written by the harness or the diagnostic.

That is the most important schema-adjacent addition if order effects are to be tested directly.

### 7.4 Component decomposition already exists in the source for the instrumented condition

`ComponentTimings` and the decomposition report already exist in source. If the design wants to use decomposition as an auxiliary diagnostic for instrumentation overhead, the capability is largely present in source; the gap is mainly whether it is persisted for later forensics.

### 7.5 No change to calibration formulas or thresholds is proposed or needed here

This phase keeps them frozen verbatim. Any proposal to change them would be a different kind of decision and is out of scope for this read-only design review.

---

## 8. What is source-verified, measured, hypothesized, and proposed

### Source-verified
- Protocol constants and the counterbalanced schedule logic in `build_schedule`.
- Pairing is by replicate index within one process execution.
- Calibration formulas and thresholds are computed in source as documented.
- Paired CSV write is exclusive/no-overwrite and requires both conditions fully valid.
- Host-capture persistence depends on the caller-provided directory existing.

### Measured (from existing evidence)
- The five Phase 45 runs all FAIL under frozen thresholds.
- Worst-case and tail mass trend worse in temporal run order in that set.
- Positive extremes cluster in small-minimal-plus-large-instrumented combinations; negative extremes in small-instrumented-relative-to-larger-minimal combinations.
- Replicate 2 dominates positive-tail mass across those runs, with p44r4 as a replicate-3 exception.

### Hypothesized (not proven)
- Run-to-run drift in Phases 45–47 is confounded with run order and uncontrolled conditions.
- Replicate 2 may be more sensitive in these draws, but not provably inherently pathological.
- Small-minimal denominators amplify some positive ratios, but do not fully explain both tails.

### Proposed (design only, not executed)
- A small, fully recorded, counterbalanced sequence under one frozen binary.
- Per-run metadata captured for every run.
- Tail-aware and ratio-insensitive auxiliary analysis alongside the frozen metrics.
- Stop-on-persistence-failure discipline with no overwrite/retry.

---

## 9. Recommendation for the next authorized phase

If the next step is authorized, the most useful next phase is a **small, fully recorded, counterbalanced paired run set under the already-verified frozen executable**, with explicit per-run metadata capture and stop-on-persistence-failure discipline.

That next phase should:
1. Pre-create each run directory and confirm emptiness before launch.
2. Record executable SHA-256 before each launch and after.
3. Persist argv, cwd, launch timestamp, source revision, build configuration, and available system-state metadata.
4. Persist the executed condition order per replicate alongside the CSV.
5. Persist stdout, stderr, exit code, CSV SHA-256, and the Phase 33 validation output and exit code for every run.
6. Pre-register the frozen metrics, per-run verdicts, tail summaries, order comparisons, exclusions, and stop conditions before any launch.
7. Stop immediately if any artifact is missing or any persistence/validation failure occurs.

The smallest experiment that distinguishes the four concerns is therefore not a larger uncontrolled batch, but a smaller fully-instrumented one: enough runs to see whether results are stable under repetition, with enough metadata to know what changed between runs.
