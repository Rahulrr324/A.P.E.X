# Phase 26 — Read-Path Experiment Protocol and Execution Readiness

**Status:** execution-readiness protocol, not execution  
**Created artifacts:** only this report  
**Decision:** `READY FOR USER AUTHORIZATION`

---

## 0. Purpose and non-purpose

This report turns the Phase 25 design into one precise, reproducible experiment protocol that can distinguish variability in:

1. file open/setup,
2. blob reading,
3. post-read processing / deserialization,
4. timing instrumentation and execution order,
5. CPU scheduling and environment state.

It is **not** an authorization to run anything. It does not build, execute, or time anything, and it does not create any G7CAM record. It specifies the exact protocol that a future authorized run would follow, the artifacts it would create, the validation rules it would satisfy, and the integrity checks that must precede any execution.

All proposals are isolated to a new phase directory. No existing file, binary, CSV, report, formula, threshold, or M0/M1 state is modified by this document.

---

## 1. Actual Git state and working-tree status at protocol time

Recorded directly from the repository at protocol time, not assumed from any prior report.

- Branch: `main`
- HEAD: `9795c35983e7084cc8cd21f653aa833818d80b99`
- Upstream: `origin/main` (`refs/heads/main`)
- Local vs upstream: local HEAD is at or ahead of upstream (`merge-base --is-ancestor HEAD origin/main` is true)
- `git status --porcelain`:

```
?? stark/nul
```

- Recent log top-6:

```
9795c35 (HEAD -> main, origin/main, origin/HEAD) w
d9911e8 w
50dd636 w
d7594b2 w
9e74837 a
831aba6 Checks that passed on the final edited file: the post-write integrity re-hash above (exit 0) and the final link check (exit 0). No file was modified after that, so no repeated checks are needed.
```

### 1.1 Interpretation

- The working tree is clean except for the pre-existing untracked `stark/nul`, which is preserved.
- HEAD moved again since Phase 25: Phase 25 read `d9911e8…`; this protocol reads `9795c35…`. The prior frozen hashes remain the authoritative identity anchors; the branch tip is recorded here for provenance.
- No commit in the inspected recent log corresponds to Phase 26 work; this protocol is a new read-only artifact.

---

## 2. Artifact and evidence state carried into this protocol

From the Phase 24 audit and the Phase 24/25 re-checks:

- Present and intact: diagnostic source `aeb31eb2…`, CMake `575fe264…`, benchmark harness `1b37e95f…`, Phase 19 plan `1451f1cb…`, Phase 22 report `e6ea3fa1…`.
- Present and intact via compensating evidence: the frozen executable `86ee9f3e…` exists on the `vs2019b` path `stark/build-b7diag-vs2019b/Release/bm_b7_diagnostic.exe` and is recorded in Phase 16 expected metadata.
- Missing on the audited paths: Phase 16 deliverable CSV, historical frozen CSV.
- Phase 23 report: present; SHA-256 `34045b5d6844…`.
- Phase 24 report: present; SHA-256 `e441c615e809…`.
- Phase 25 design: present; SHA-256 `86d69ffa26a4…`.

These are the working constraints for any future run.

---

## 3. The measurement being decomposed, verbatim

The operational target is the production B7 statement sequence from `BenchModelHarness.cpp bench_model_load_time()`:

```
std::ifstream f(path, std::ios::binary);
if (!f) throw std::runtime_error("cannot open weight blob");
std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(f)),
                             std::istreambuf_iterator<char>());
loader.deserializeWeights(bytes);
```

The existing diagnostic already reproduces this verbatim in both conditions. The existing instrumented decomposition already separates:

- `open_sec`: after `ifstream` construction and the open-failure check, to just before the `istreambuf_iterator` fill.
- `read_sec`: the `istreambuf_iterator` vector fill.
- `deser_sec`: `deserializeWeights(bytes)`.
- `residual_sec`: independent outer total minus the sum of those three.

This protocol therefore does **not** propose inventing the first-level decomposition from scratch. It proposes extending the existing one in a controlled, additive way and using the existing paired-sample grain as the anchor.

---

## 4. Anchored total timing and additive finer components

### 4.1 Total anchor

The total anchor is unchanged from the existing diagnostic:

- **minimal total**: the single outer `steady_clock` pair around the minimal condition.
- **instrumented total**: the independent outer `steady_clock` pair around the instrumented condition.

All decomposition columns must be additive components of the instrumented total, and the existing residual must remain defined as:

```text
residual_sec = total_sec - (open_sec + read_sec + deser_sec)
```

### 4.2 Proposed additive finer components

The protocol defines the following finer components **in addition to**, not instead of, the existing ones:

1. **`open_pre_stream_sec`** — from `steady_clock` before `std::ifstream` construction to just after construction before any use.
2. **`open_post_check_sec`** — from after the `if (!f)` check to just before the iterator fill begins. Combined with `open_pre_stream_sec`, this reproduces the existing `open_sec`.
3. **`read_traversal_sec`** — the `istreambuf_iterator` fill, identical to the existing `read_sec` in this protocol. If a future run further splits this, it must record the split explicitly.
4. **`deser_call_sec`** — from just before `deserializeWeights(bytes)` to just after it returns, identical to the existing `deser_sec`.
5. **`instrument_clock_overhead_sec`** — a direct estimate of the extra clock-read cost introduced by the finer instrumentation, estimated by bracketing the extra reads where feasible. This is descriptive, not a redefinition of calibration.

Every new column must be defined with:

- exactly what is inside it,
- exactly what is excluded,
- its unit (seconds, raw),
- and how it sums into the existing buckets.

No existing bucket may be silently redefined.

---

## 5. Instrumentation overhead: measurement, not assumption

### 5.1 Overhead reference points

The protocol keeps three calibration-relevant reference points:

- **minimal condition** as the least-instrumented reference,
- **existing instrumented condition** as the already-calibrated overhead baseline,
- **finer instrumented condition** as the new descriptive instrumented variant.

Any finer instrumentation must report its **additional** clock cost relative to the existing instrumented condition, not just assume it away.

### 5.2 What must be reported

For each run, the protocol requires reporting:

- the existing calibration metrics from the existing grain,
- the descriptive finer-component summary statistics,
- and an explicit note on whether the finer instrumentation changed the instrumented total beyond calibration's measured overhead tolerance.

If the finer instrumentation materially changes the instrumented total, the protocol requires that fact to be recorded, not hidden inside the decomposition.

### 5.3 Semantics preservation rule

Semantics are preserved if:

- the minimal total is unchanged,
- the instrumented total remains a bracketed measurement of the same operation,
- the existing calibration still compares existing-grain paired samples,
- and the new columns are labeled descriptive unless computed under the frozen calibration logic.

---

## 6. Sample count, run order, affinity policy, and state contexts

### 6.1 Chosen sample count

**Chosen protocol baseline: `measurement_count = 50` and `macro_replicates_per_condition = 8`.**

Justification:

- `measurement_count = 50` preserves the existing within-replicate resolution and the existing CSV grain, so the protocol stays directly comparable to Phase 19/23.
- `macro_replicates_per_condition = 8` is chosen over the existing `6` because the existing 3-per-condition evidence in Phase 19 was too few for strong claims, and the Phase 25/26 goal is to characterize spread within each bucket, not merely to repeat the existing ambiguity. Eight is a deliberately larger within-phase replication than the existing minimum, while remaining a concrete, finite number rather than an open-ended campaign.

This is a **protocol choice**, not a claim that 8 replicates per condition is sufficient for any particular conclusion. Final adequacy is an analysis question for after the data are collected; this protocol only fixes a concrete, reproducible baseline.

### 6.2 Conditions and total replicates

- **Two conditions**: `MINIMAL` and `INSTRUMENTED`, exactly as the existing diagnostic uses.
- **Total replicates per run**: `8 MINIMAL + 8 INSTRUMENTED = 16` macro-replicates.
- **Total measured iterations per run**: `16 * 50 = 800`.

That is the concrete baseline the protocol specifies.

### 6.3 Run order

The protocol uses a **counterbalanced alternating schedule** on the existing `build_schedule` idea, but extended to 8 replicates:

- even replicate indices run `MINIMAL` first, then `INSTRUMENTED`;
- odd replicate indices run `INSTRUMENTED` first, then `MINIMAL`;
- the executed order is recorded verbatim per replicate.

Rationale: this keeps the existing order-balancing discipline and prevents a trivial all-minimal-first or all-instrumented-first confound within a single run.

### 6.4 Affinity policy

The protocol specifies **two affinity contexts** because affinity is one of the five variability sources it must distinguish:

- **Context A — unpinned**: the diagnostic runs under the system mask, as in Phase 19 unpinned runs.
- **Context B — pinned**: the diagnostic runs with the existing Phase 19 enforcement primitive, pinned to logical CPU 0 (`mask = 0x1`), verified before resume and checked for drift.

The protocol does **not** claim this is identical to the historical in-process affinity method. It explicitly records the difference and treats Context B as the current external whole-process mask, not as a historical reproduction.

### 6.5 State contexts and why two are required

The protocol specifies **two state contexts**, because a single context cannot distinguish environment-driven variability from bucket-driven variability:

- **Warm state**: repeated operation after the blob has been touched, matching the existing warm-cache baseline.
- **Attempted-cold state**: an attempt to observe the operation before the blob is in a warmed state, **only if** the machine can support such a contrast without changing the measurement semantics.

The warm-state observation is the safe default. The attempted-cold observation is conditional and must be reported honestly as attempted-cold, with any claimed coldness supported by captured evidence, not by assertion.

---

## 7. Cache-state treatment: warm vs attempted-cold, with honesty rules

### 7.1 Default: warm-cache

The protocol's default measurement posture is **warm-cache**, matching the existing diagnostic's stated posture. Under this posture:

- no cache flush is performed,
- no claim of cache-state control is made,
- and replicates remain sequential, process-local, not independent machine/session replications.

### 7.2 Attempted-cold only with verification

If the protocol is executed with an attempted-cold contrast:

- the attempt must be described concretely,
- a pre-measurement environment snapshot must be captured,
- a post-measurement snapshot must be captured,
- and any claim that the state differed must be based on those snapshots, not on intent alone.

If no verifiable difference can be captured, the protocol requires the contrast to be labeled **attempted but unverified**, not controlled.

### 7.3 Filesystem and media

The protocol treats filesystem/media effects as a first-class unknown:

- the measurement blob is diagnostic-owned and isolated,
- the exact blob path and size are recorded,
- and any open/setup variability may come from the filesystem, the media, the OS cache, or the process. The protocol does not assume it can fully separate those without explicit controls.

---

## 8. Environment capture strategy, per run and per transition

Each run must capture the following, stored per run, not reconstructed later:

- run identifier and order,
- condition and affinity context,
- executable path and SHA-256 before the run,
- pre-run snapshot using the existing runner snapshot discipline: timestamp, system CPU busy fraction, self-process mask, system mask, AC/power status, active power scheme, thermal probe when available, and CPU topology including P/E cores and shared caches,
- post-run snapshot with the same fields,
- affinity verification evidence: mask intended, mask observed while suspended, mask observed after resume, mask observed at exit, and any drift,
- `stdout.txt` and `stderr.txt` paths and SHA-256,
- the host-captured paired CSV path, size, and SHA-256,
- confirmation that the historical CSV was unchanged before and after the run,
- and the exact protocol version used.

If any field is unavailable, the protocol requires it to be recorded as unavailable, not omitted or invented.

---

## 9. Exact commands and artifact paths

### 9.1 Working assumptions for commands

The protocol assumes the existing Phase 19 runner and validator are reused where applicable. If a future authorized execution uses them, it must record the exact interpreter version, exact working directory, and exact arguments.

### 9.2 Precondition checks before any run

Before each run, the executor must run, at minimum:

- `git status --porcelain` and record it,
- the protected-artifact hash check against the known prefixes for source/config/report artifacts,
- the executable existence and SHA-256 check against the frozen executable hash,
- the historical CSV unchanged check,
- and a confirmation that the intended host-capture directory does not already exist.

### 9.3 Representative run command shape

A representative command shape for one run, using the existing runner conventions, is:

```text
python phase19_runner.py \
  --run-id <run_id> \
  --condition <pinned|unpinned> \
  --mask <hex-or-none> \
  --order <1-based order>
```

The protocol does not fix the exact invocation as the only possible one; it requires that the exact invocation used be recorded in the run manifest.

### 9.4 Validation command shape

After a run, the protocol requires validation with the existing validator:

```text
python phase19_validate.py --run-dir <run_dir>
```

If a future run uses the existing paired-sample grain, the existing validator rules apply verbatim.

### 9.5 Isolated artifact root

All new artifacts for this protocol go under:

- `work/b7_diag_20261011_paired_capture/phase26_read_path/`

No new artifacts go into `phase16_vs2019`, `phase19_runs`, or any other prior phase directory.

### 9.6 Per-run artifact shape

For each run, the protocol expects:

- one run directory under the phase root,
- inside it: `ops/` containing `exec_meta.json`, `pre_state.json`, `post_state.json`, `stdout.txt`, `stderr.txt`, `exitcode.txt`,
- the host-captured `paired_samples.csv` under the run's host-capture directory,
- and a run manifest entry recording the executable, build path, protocol version, run order, condition, affinity context, state context, and artifact hashes.

If the finer decomposition is implemented, each run also produces a decomposition CSV with the same `(replicate, iteration)` grain and the new descriptive columns clearly separated from the frozen grain.

---

## 10. Expected schemas

### 10.1 Existing paired-sample schema

```text
replicate,iteration,minimal_sec,instrumented_sec,signed_overhead_pct
```

Exactly the existing header, exactly 300 rows for the existing 6x50 protocol. For the 8x50 protocol, the existing validator's expected-row constant would need to be set to the actual protocol value and recorded in the manifest; this protocol does not silently change the existing validator constant without stating that change.

### 10.2 Proposed decomposition schema

The protocol proposes a decomposition CSV whose first five columns are identical to the existing grain:

```text
replicate,iteration,minimal_sec,instrumented_sec,signed_overhead_pct,
open_sec,open_pre_stream_sec,open_post_check_sec,
read_traversal_sec,deser_call_sec,
residual_sec,instrument_clock_overhead_sec
```

The first five columns are the frozen grain. The remaining columns are descriptive extensions. Any future run must state clearly which columns are the frozen grain and which are new.

---

## 11. Validation rules

### 11.1 Frozen-grain validation

For the existing grain, the protocol requires the existing validator rules verbatim:

- header exact match,
- expected row count for the protocol's replicate/measurement counts,
- exact `(replicate, iteration)` key set for the protocol's replicate count,
- per-replicate counts,
- finiteness and positivity,
- per-row `signed_overhead_pct` formula consistency,
- and frozen metric recomputation from CSV bytes.

### 11.2 New-column validation

For each new descriptive column, the protocol requires:

- a written definition,
- the exact formula,
- the unit,
- the valid-only precondition,
- and a separate validation check so new columns cannot corrupt the frozen grain.

### 11.3 Failure handling

- If any artifact fails validation, the failure is recorded and the artifact is not silently promoted.
- If a run fails to produce a valid artifact, the protocol records the failure and does not overwrite existing artifacts.
- If a validation rule cannot be applied, the protocol records the gap.

---

## 12. Integrity checks and protected-evidence gates

### 12.1 Before execution

Before any run, the protocol requires:

- `git status --porcelain` recorded,
- protected source/config/report hashes checked against known prefixes,
- executable existence and hash checked,
- historical CSV unchanged check recorded,
- and the intended host-capture directory confirmed absent.

### 12.2 After execution

After any run, the protocol requires:

- re-check of the same protected hashes,
- `git status --porcelain` recorded again,
- confirmation that no protected file changed,
- and confirmation that no staging, commit, push, reset, clean, or discard occurred.

### 12.3 Independent reconciliation

All produced CSVs must be independently reconciled from raw bytes before any conclusion is trusted, using the same discipline as Phase 24.

---

## 13. M0, M1, and G7 status under this protocol

- M0 remains **FAIL** under this protocol because the protocol does not alter any measurement that would change the existing calibration outcomes.
- M1 remains **LOCKED**; this protocol does not unlock it.
- No G7 campaign is run, and no G7CAM record is created.

---

## 14. Execution checklist

### 14.1 Authorization and preconditions

- [ ] Separate explicit authorization to execute this protocol is obtained.
- [ ] The exact protocol version, sample counts, affinity contexts, and state contexts to be used are fixed in writing before execution.
- [ ] The exact executable to be used is chosen and its hash matches the frozen executable hash, or the difference is explicitly declared and authorized.

### 14.2 Pre-run integrity

- [ ] `git status --porcelain` recorded.
- [ ] Protected source/config/report hashes verified.
- [ ] Executable existence and SHA-256 verified.
- [ ] Historical CSV unchanged verified.
- [ ] Target host-capture directory confirmed absent.

### 14.3 Per-run steps

- [ ] Run identifier and order assigned.
- [ ] Affinity context and state context recorded before the run.
- [ ] Pre-run snapshot captured.
- [ ] Run executed with the exact command recorded.
- [ ] Post-run snapshot captured.
- [ ] Affinity verification evidence recorded.
- [ ] `stdout.txt`, `stderr.txt`, `exitcode.txt`, and paired CSV produced and hashed.
- [ ] Historical CSV unchanged verified after the run.

### 14.4 Post-run validation

- [ ] Existing-grain validator run and passed.
- [ ] New descriptive columns validated against their definitions.
- [ ] Run manifest completed with all artifact hashes.
- [ ] Protected hashes re-verified.
- [ ] `git status --porcelain` recorded again.

### 14.5 Analysis gates before any conclusion

- [ ] All runs independently reconciled from raw CSV bytes.
- [ ] Any missing evidence recorded as a gap, not fabricated.
- [ ] Any conclusion explicitly labeled descriptive or calibration-relevant, as appropriate.

---

## 15. What this protocol does not authorize

- It does not authorize building the diagnostic.
- It does not authorize running any diagnostic or benchmark.
- It does not authorize any affinity experiment outside the two contexts specified here.
- It does not authorize any G7 activity.
- It does not authorize modifying the existing source, CMake, binary, CSVs, reports, formulas, thresholds, or M0/M1 state.
- It does not authorize staging, committing, pushing, resetting, cleaning, or discarding any file.

---

## 16. Decision

The protocol is concrete, reproducible, anchored to the existing measurement semantics, isolated from protected evidence, and explicit about its own gaps and honest limitations.

**Decision:** `READY FOR USER AUTHORIZATION`

This decision concerns the proposed protocol only. It does not authorize execution, building, or measurement.
