# Phase 29 — Final B7 Read-Path Execution Safety Review

**Status:** read-only safety review  
**Created artifacts:** only this report  
**Decision:** `READY FOR USER AUTHORIZATION`

---

## 0. Purpose

This is a strictly read-only safety review of the finalized B7 read-path experiment design in Phase 28, cross-checked against the actual Phase 25–27 documents, the diagnostic source, the Phase 19 runner, and the existing Phase 19 validator. It verifies the measurement arithmetic, the two-launch design, the proposed validator profile, the instrumentation design, the execution preconditions, the evidence integrity, and the scope/interpretation constraints.

It does not build, execute, measure, or create anything. It does not modify source, runner, validator, CMake, binaries, existing CSVs, or prior reports. It does not create the proposed eight-replicate validator profile. It does not stage, commit, push, reset, clean, or discard files. This review did not stage any file. It preserves `stark/nul` and all existing user work.

---

## 1. Actual Git state and evidence state at review time

### 1.1 Git state

Recorded directly from the repository at review time:

- Branch: `main`
- HEAD: `99b7ea4712fa76596fb4c0b73e5f28b45d0b5e7b`
- Upstream: `origin/main` (`refs/heads/main`)
- Local vs upstream: local HEAD is at or ahead of upstream (`merge-base --is-ancestor HEAD origin/main` is true)
- `git status --porcelain`:

```
?? stark/nul
```

- Recent log top-4:

```
99b7ea4 (HEAD -> main, origin/main, origin/HEAD) a
9e4eeb5 a
acd85db a
9795c35 w
```

Interpretation: working tree clean except for the pre-existing untracked `stark/nul`, which is preserved. HEAD moved again since Phase 28; branch tips are recorded for provenance only.

### 1.2 Protected hashes re-checked before writing this review

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
- Phase 28 matrix present: `53bf913fd802…`
- Phase 19 runner present: `21b51e4592b1…`
- Phase 19 validator present: `6285cc12bd03…`

All present protected source/config/report artifacts intact. No protected artifact modified by this review.

### 1.3 Inherited gaps carried into this review

- Phase 16 deliverable CSV missing on the audited path.
- Historical frozen CSV missing on the audited path.
- Phase 16 stdout artifact absent, so the validator's stdout cross-checks cannot be re-exercised from the workspace.
- Frozen executable `86ee9f3e…` evidenced on the `vs2019b` path, not on the `vsc-direct` path.

These are recorded as gaps, not reconstructed.

---

## 2. Measurement arithmetic

### 2.1 The numbers in Phase 28

Phase 28 sets:

- `macro_replicates_per_condition = 8`
- `measurement_count = 50`

The arithmetic stated in Phase 28 is:

- per launch: 8 MINIMAL macro-replicates + 8 INSTRUMENTED macro-replicates = 16 macro-replicates
- per launch: 16 × 50 = 800 measured iterations
- primary experiment: 2 launches → 2 × 800 = 1600 measured iterations
- primary experiment totals: 800 minimal rows + 800 instrumented rows = 1200 measured rows
- per launch CSV: 400 minimal rows + 400 instrumented rows = 800 measured rows

### 2.2 Reconciliation of the distinct concepts

It is important to keep these distinct:

- **Measured operations** are the individual calls of `minimal_op()` or `instrumented_op()` inside a `run_replicate()` measured loop. Each is one `tA/tB` bracketed sample.
- **Paired samples** are the aligned `(replicate, iteration)` pairs used by `calibrate()`. A paired sample is one minimal iteration and one instrumented iteration with the same `(replicate, iteration)` key.
- **Condition observations** are the set of samples belonging to one condition. In a launch, the MINIMAL condition produces 400 minimal samples and the INSTRUMENTED condition produces 400 instrumented samples.
- **CSV data rows** are the `replicate,iteration,minimal_sec,instrumented_sec,signed_overhead_pct` rows in the host CSV. In a launch CSV there are 800 measured rows, each row being one measurement that carries both a minimal and an instrumented value for that pair.
- **Header line** is the single CSV header row: `replicate,iteration,minimal_sec,instrumented_sec,signed_overhead_pct`.

### 2.3 Per-launch CSV shape

For one launch under the 8×50 design:

- header line: 1
- data rows: 800
- minimal rows: 400
- instrumented rows: 400
- `(replicate, iteration)` keys for each condition: `{(0..7, 0..49)}`
- per-replicate counts: 50 per replicate, for replicates 0 through 7

So one launch CSV has **1 header line and 800 data rows**, not 300 rows and not 6 replicates.

### 2.4 Primary experiment totals

For the full primary experiment of two launches:

- header lines total: 2 (one per CSV)
- data rows total: 1600
- minimal rows total: 800
- instrumented rows total: 800

### 2.5 Consistency of the paired-grain count with the macro-replicate count

Each macro-replicate contributes one `(replicate, iteration)` key per iteration. With 8 replicates per condition and 50 iterations per replicate, each condition has 8 × 50 = 400 keys. Each launch therefore contains 400 paired samples per condition, 800 paired samples total, which matches 800 CSV data rows.

There is no arithmetic contradiction between:

- 8 macro-replicates per condition,
- 50 measurements per macro-replicate,
- 800 measured iterations per launch,
- 400 minimal + 400 instrumented = 800 CSV rows per launch,
- and 1600 total measured iterations across two launches.

---

## 3. Two-launch design

### 3.1 How each launch captures both conditions

Each launch is one process created by the Phase 19 runner's `launch_suspended()` under a single affinity context. Inside that process, the diagnostic's `run_bm_b7_diagnostic()` runs the counterbalanced schedule, which produces both conditions:

- each schedule entry produces one MINIMAL macro-replicate and one INSTRUMENTED macro-replicate,
- with the first/second order determined per entry by `entry.minimal_first`,
- and both conditions recorded inside the same launch.

So each launch captures both MINIMAL and INSTRUMENTED, while applying only one affinity context to the whole process.

### 3.2 One affinity context per process

Affinity is a process-level property. A single process launch cannot be both unpinned and pinned. Therefore:

- Launch 1 covers Context A (unpinned) and contains both MINIMAL and INSTRUMENTED.
- Launch 2 covers Context B (pinned, mask `0x1`) and contains both MINIMAL and INSTRUMENTED.

This is why the primary experiment needs exactly two launches for the two affinity contexts.

### 3.3 Planned launch order and why it is appropriate

The matrix does not assign affinity context to a first/second position inside a launch, because affinity is between-launch. The natural planned order is:

1. Launch 1: Context A, unpinned.
2. Launch 2: Context B, pinned.

This order is appropriate because:

- it keeps the two affinity contexts cleanly separated,
- it preserves the within-launch counterbalancing for each launch independently,
- and it avoids any attempt to cross affinity with first/second position inside one launch, which the design cannot do.

The matrix does not claim affinity is counterbalanced with order; it only claims order is counterbalanced within each launch.

### 3.4 Safety check on the launch order

The review confirms:

- the within-launch schedule is the existing `build_schedule()` counterbalanced schedule,
- the between-launch affinity assignment is explicit and separate,
- and the design does not conflate the two.

No launch order problem was found.

---

## 4. Validator correctness

### 4.1 Existing six-replicate validator

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

This validator validates exactly the existing 6×50 grain: 6 replicates per condition, 50 measurements per replicate, 300 rows per condition, 600 rows total per CSV.

### 4.2 The mismatch the eight-replicate profile must resolve

An 8×50 launch CSV has:

- 8 replicates per condition,
- 50 measurements per replicate,
- 400 rows per condition,
- 800 rows total per CSV,
- keys `{(0..7, 0..49)}` per condition.

If the existing validator's constants were applied verbatim to that CSV, the row-count and replicate-key checks would fail. The matrix therefore proposes a separate profile rather than editing the existing validator.

### 4.3 Proposed eight-replicate profile

The proposed profile reuses:

- the same header,
- the same frozen formulas,
- the same frozen thresholds,

and changes only:

- `EXPECTED_REPLICATES = 8`
- `EXPECTED_ROWS = 400`

It validates one 8×50 launch CSV against the 8-replicate grain.

### 4.4 Exact row counts and replicate keys in the proposed profile

For one launch CSV under the 8-replicate profile:

- expected replicates per condition: 8
- expected measurements per replicate: 50
- expected rows per condition: 8 × 50 = 400
- expected total rows per CSV: 800
- expected header line: 1
- expected `(replicate, iteration)` keys per condition: `{(0..7, 0..49)}`
- expected per-replicate counts: 50 for each of replicates 0 through 7

The profile's replicate-key check must use `range(8)` and `range(50)`, not the existing `range(6)` and `range(50)`.

### 4.5 Preservation of the existing validator

The review confirms:

- the existing six-replicate validator is preserved unchanged,
- the proposed eight-replicate profile is additive and separate,
- no new formula or threshold is introduced,
- the frozen formulas and thresholds remain exactly the existing ones.

This satisfies the constraint that the existing validator be preserved unchanged.

### 4.6 CSV schema match

The proposed eight-replicate profile validates the same CSV schema as the existing validator:

- `replicate,iteration,minimal_sec,instrumented_sec,signed_overhead_pct`

The schema is unchanged; only the replication constants differ for the new grain. This is the correct separation: schema and formulas are preserved, replication constants are adapted for the new grain under a separate profile.

---

## 5. Instrumentation design

### 5.1 Existing component boundaries in source

The existing `instrumented_op()` is:

```text
void instrumented_op(const std::string& path, TinyDenseModel& loader,
                     ComponentTimings& t) {
    const auto t0 = Clock::now();
    std::ifstream f(path, std::ios::binary);
    if (!f) throw std::runtime_error("cannot open weight blob");
    const auto t1 = Clock::now();
    std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(f)),
                               std::istreambuf_iterator<char>());
    const auto t2 = Clock::now();
    loader.deserializeWeights(bytes);
    const auto t3 = Clock::now();
    t.open_sec = duration(t1 - t0);
    t.read_sec = duration(t2 - t1);
    t.deser_sec = duration(t3 - t2);
    t.residual_sec = 0.0;
}
```

The existing outer total in `run_replicate()` is:

```text
const auto tA = Clock::now();
if (mode == Mode::INSTRUMENTED)
    instrumented_op(blob_path, loader, comp);
else
    minimal_op(blob_path, loader);
const auto tB = Clock::now();
total_sec = duration(tB - tA);
```

So the existing buckets are:

- `open_sec` = `t1 - t0` (includes `ifstream` construction and the open-failure check)
- `read_sec` = `t2 - t1` (the iterator fill)
- `deser_sec` = `t3 - t2` (`deserializeWeights(bytes)`)
- `residual_sec` = `total_sec - (open_sec + read_sec + deser_sec)`

This review confirms the same boundaries the Phase 28 matrix relied on.

### 5.2 Additive identities the finer instrumentation must preserve

The finer components proposed in Phase 28 must satisfy:

- `open_pre_stream_sec + open_post_check_sec == open_sec`
- `read_traversal_sec == read_sec`
- `deser_call_sec == deser_sec`
- and therefore:
  `open_pre_stream_sec + open_post_check_sec + read_traversal_sec + deser_call_sec + residual_sec == total_sec`

The review confirms these are the identities the design depends on. If a future implementation introduces extra clock reads for the finer buckets, the identities must still hold or be re-derived and recorded explicitly.

### 5.3 How the finer-instrumentation comparison is distinguished from existing overhead

The review distinguishes two comparisons:

1. **Existing instrumentation overhead:** existing instrumented vs minimal. This is the existing frozen calibration.
2. **Finer instrumentation overhead:** finer instrumented vs existing instrumented, with the operation held constant.

The Phase 28 matrix requires both steps to be reported. The review confirms that this two-step framing is the correct way to isolate the marginal cost of the finer instrumentation, and that it does not conflate existing overhead with finer overhead.

### 5.4 Semantic preservation

The review confirms the semantics are preserved if:

- the minimal total is unchanged,
- the existing instrumented outer total still brackets the same operation,
- the existing calibration still compares the existing grain,
- and the finer components are additive descriptive extensions.

If the finer instrumentation changes the existing instrumented total, that change is evidence and must be reported, not absorbed silently. The review notes this as a required discipline for any future implementation.

---

## 6. Execution preconditions

### 6.1 Executable path and hash checks

Before any launch, the runner's `do_run()` checks:

- the executable exists,
- the executable SHA-256 matches the expected frozen executable hash,
- the host directory does not already exist,
- the host CSV does not already exist,
- the wrapper itself is not pinned,
- and the requested pinned mask is inside the system mask.

The review confirms these are the correct preconditions for the matrix, because they come from the existing runner and they enforce no-overwrite and affinity-safety before any launch.

### 6.2 Affinity verification

For the pinned launch, the runner applies the mask while the child is suspended, verifies it before resume, resumes, and later checks for drift after resume and at exit. A failed verification is fail-closed. The review confirms this matches the matrix's Context B requirement.

### 6.3 Output-directory absence

The runner requires the host directory to be previously absent and fails closed otherwise. The matrix's no-overwrite precondition is consistent with this.

### 6.4 Unique run IDs

Each launch must have a unique run ID, recorded in the per-launch manifest and used as the host-capture directory name. The review confirms this is required for isolation and traceability.

### 6.5 Failure handling

The review confirms the failure policy from Phase 28 is consistent with the runner:

- a failed launch produces no CSV and is recorded as failed,
- an affinity verification failure is fail-closed and recorded as failed,
- a missing or invalid CSV is recorded as invalid and not promoted,
- missing stdout records the stdout cross-checks as unavailable,
- invalid samples are recorded as failed checks by the validator profile,
- environmental anomalies are recorded as caveats, not ignored.

### 6.6 Evidence capture

Each launch must capture:

- run ID and order,
- affinity context,
- executable path and SHA-256 before the run,
- pre/post snapshots,
- affinity verification evidence,
- stdout/stderr/exitcode paths and hashes,
- host CSV path, size, and SHA-256,
- historical CSV unchanged confirmation,
- protected-hash pre/post confirmation,
- and the eight-replicate profile hash if that profile is used.

The review confirms this is the correct evidence-capture set and that it is stored per launch, not reconstructed later.

---

## 7. Evidence integrity

### 7.1 Git state

At review time:

- `main`, HEAD `99b7ea4…`, upstream `origin/main`, local at-or-ahead.
- `git status --porcelain`: only `?? stark/nul`.

No staged changes. No tracked file modified.

### 7.2 Protected hashes

All present protected artifacts re-checked and intact, as listed in §1.2.

### 7.3 Missing artifacts

The inherited gaps remain:

- Phase 16 deliverable CSV missing on the audited path.
- Historical frozen CSV missing on the audited path.
- Phase 16 stdout artifact absent, so the validator's stdout cross-checks cannot be re-exercised from the workspace.
- Frozen executable evidenced on the `vs2019b` path, not on the `vsc-direct` path.

The review records these as gaps, not reconstructed, and does not treat their absence as evidence of tampering.

---

## 8. Scope and interpretation

### 8.1 Warm-cache-only primary scope

The primary experiment scope is warm-cache only. Attempted-cold is excluded from the primary experiment. The review confirms this is stated in Phase 28 and carried into this safety review.

### 8.2 No claim of historical affinity equivalence

The review confirms the matrix does not claim Context B is a reproduction of the historical in-process affinity method. It is the current external whole-process mask, recorded as such.

### 8.3 Unchanged thresholds and formulas

The thresholds and formulas are unchanged. The only proposed change is the creation of a separate eight-replicate profile that reuses them. The review confirms this satisfies the constraint.

### 8.4 No G7

No G7 campaign is run, no G7CAM record is created, and no G7 activity is authorized by this report.

### 8.5 M0 and M1

- M0 remains **FAIL**, because this review is design-only and produces no new calibration evidence.
- M1 remains **LOCKED**, because this review does not unlock it and does not change any classification logic.

---

## 9. Decision

The Phase 28 matrix is internally consistent with the actual diagnostic source, runner, validator, and prior evidence. Its arithmetic, launch design, validator profile, instrumentation design, preconditions, failure handling, and scope constraints all check out against the actual artifacts. No modification, execution, measurement, G7 activity, or history change is required or authorized by this review.

**Decision:** `READY FOR USER AUTHORIZATION`

This is a design review decision only. It does not authorize building, executing, measuring, or modifying anything.
