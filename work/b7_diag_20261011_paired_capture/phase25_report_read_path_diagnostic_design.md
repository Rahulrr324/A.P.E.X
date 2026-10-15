# Phase 25 — Read-Path Diagnostic Design Review

**Status:** design-only  
**Created artifacts:** only this report  
**Decision:** `READY FOR USER AUTHORIZATION`

---

## 0. What this phase is, and what it is not

This is a **design-only review**. It does not propose running anything, does not change any existing artifact, and does not authorize any measurement. It takes the Phase 24 recommendation — a narrowly scoped read-path timing decomposition — and turns it into a concrete, auditable measurement design with explicit competing predictions, minimum sample requirements, measurement boundaries, environment capture, observer-overhead handling, artifact layout, validation rules, failure handling, and protected-evidence checks.

All proposals are isolated to a new phase directory. No source file, CMake target, binary, historical CSV, prior report, threshold, formula, or M0/M1 state is modified by this document.

---

## 1. Actual Git state and working-tree status at design time

Recorded directly from the repository at design time, not assumed from any prior report.

- Branch: `main`
- HEAD: `d9911e803eba31c14f122132138e8a855e78baf4`
- Upstream: `origin/main` (`refs/heads/main`)
- Local vs upstream: local HEAD is at or ahead of upstream (`merge-base --is-ancestor HEAD origin/main` is true)
- `git status --porcelain`:

```
?? stark/nul
```

- Recent log top-8:

```
d9911e8 (HEAD -> main, origin/main, origin/HEAD) w
50dd636 w
d7594b2 w
9e74837 a
831aba6 Checks that passed on the final edited file: the post-write integrity re-hash above (exit 0) and the final link check (exit 0). No file was modified after that, so no repeated checks are needed.
4e7acc7 2
30742b1 2
f8b1d13 1
```

### 1.1 Interpretation

- The working tree is clean except for the pre-existing untracked `stark/nul`, which is preserved.
- HEAD moved again since Phase 24: Phase 24 read `50dd636…`; this design reads `d9911e8…`. The prior reports' frozen hashes remain the authoritative identity anchors; the branch tip is recorded here for provenance.
- No commit in the inspected recent log unambiguously corresponds to Phase 25 work; this design is a new read-only artifact, not a continuation of any existing commit.

### 1.2 Protected-artifact state carried into this design

From the Phase 24 audit and re-checked before writing this design:

- Present and intact: diagnostic source `aeb31eb2…`, CMake `575fe264…`, benchmark harness `1b37e95f…`, Phase 19 plan `1451f1cb…`, Phase 22 report `e6ea3fa1…`.
- Present and intact via compensating evidence: the frozen executable `86ee9f3e…` exists on the `vs2019b` path and is recorded in Phase 16 metadata, even though the audit-specified `vsc-direct` path is missing that file.
- Missing on the audited paths: Phase 16 deliverable CSV, historical frozen CSV.

These are carried forward as constraints on any future run: a future decomposition must either use a byte-identical frozen executable or explicitly declare and authorize a different baseline.

---

## 2. Actual measurement boundary in the existing diagnostic

This design is grounded in the actual source, not in the Phase 24 summary alone.

### 2.1 Production operation being reproduced

The diagnostic is built to reproduce, verbatim, the production B7 statement sequence from `BenchModelHarness.cpp bench_model_load_time()`:

```
std::ifstream f(path, std::ios::binary);
if (!f) throw std::runtime_error("cannot open weight blob");
std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(f)),
                             std::istreambuf_iterator<char>());
loader.deserializeWeights(bytes);
```

The minimal condition runs exactly this sequence with a single outer `steady_clock` pair. The instrumented condition runs the same sequence with four internal `steady_clock` reads bracketing open, read, and deserialize.

### 2.2 The existing decomposition and its boundaries

The existing instrumented decomposition already separates:

- `open_sec`: from `t0` to `t1`, after `ifstream` construction and the open-failure check.
- `read_sec`: from `t1` to `t2`, over the `istreambuf_iterator` vector fill.
- `deser_sec`: from `t2` to `t3`, over `deserializeWeights(bytes)`.
- `residual_sec`: `total_sec - (open_sec + read_sec + deser_sec)`, where `total_sec` is an independent outer timer bracketing the whole `instrumented_op` call.

That means the existing code already contains the **first-level** decomposition needed: open vs read vs deserialize vs residual. The existing paired-sample CSV captures exactly the `(replicate, iteration)` pairs used by `calibrate()`, with the identical formula `100*(instrumented - minimal)/minimal`.

### 2.3 What the existing design does and does not isolate

What is already isolated:

- The read is isolated from deserialize.
- Stream open and open-failure behavior are isolated from the read.
- The total includes a residual bucket that absorbs call/return, stream destruction, and clock overhead.

What is **not** isolated by the existing code, and is therefore the real design question for Phase 25:

- **File-open/setup** beyond `ifstream` construction: path resolution, existence/setup effects, stream state initialization, and whatever OS open cost is folded into `open_sec`.
- **Blob read** is isolated in principle, but only as a single bucket. Within that bucket, the existing design does not separate the cost of the `istreambuf_iterator` traversal itself from any buffering, allocation, or filesystem-read effects folded into the same timer span.
- **Post-read processing** is isolated as `deser_sec`, which is good, but the decomposition does not currently separate any subsequent per-byte or structural work inside `deserializeWeights` from the call overhead.
- **Timing instrumentation overhead** is measured by calibration, not assumed, which is correct; but the existing calibration measures the overhead of the instrumented vs minimal **whole operations**, not the cost of the four extra clock reads in isolation.

### 2.4 The concrete design implication

The Phase 24 recommendation said: separate open/setup, blob read, post-read processing, and instrumentation overhead. The actual source shows those four buckets are already mostly present, but they are **coarse**. The highest-value design question is therefore not "add open/read/deserialize timing," because that already exists. The highest-value question is: **can we split the existing coarse buckets enough to tell whether variability is concentrated in the read traversal itself, or whether it leaks in from open/setup, post-read deserialization, or clock/instrumentation overhead?**

---

## 3. Competing hypotheses the design must distinguish

The design should distinguish, at minimum, these explanations for the observed variability.

### H1 — Blob-read traversal dominates variability

**Prediction:** most run-to-run variability is concentrated in the read bucket. The open and deserialize buckets should be comparatively stable; the residual should be comparatively stable per sample size; the paired overhead variability should track the read bucket.

### H2 — Open/setup or filesystem effects dominate variability

**Prediction:** the `open_sec` bucket is unstable across repeats, especially across cold/warm transitions, path resolution events, or storage-medium state changes. The read bucket may look noisy too, but primarily because it follows an unstable open.

### H3 — Post-read deserialization or allocator effects dominate variability

**Prediction:** `deser_sec` or the residual is unstable across repeats, possibly due to allocator reuse, internal branch behavior in deserialize, or memory-layout effects. The read bucket would be comparatively stable.

### H4 — Clock-read / instrumentation / order effects dominate variability

**Prediction:** variability is not concentrated in any production work bucket; instead it appears in the residual, in the difference between instrumented and minimal conditions, or in the order of execution. This would show up as calibration-relevant noise rather than as read-path noise.

### H5 — Affinity/scheduling/environment noise dominates variability

**Prediction:** variability moves with machine state and/or affinity condition, not with the internal bucket structure. Under this hypothesis, a better-characterized environment and/or a more faithful affinity reproduction may reduce variability without changing the read-path decomposition.

### 3.1 Why these are the right competitors

Because the existing decomposition already has open, read, deserialize, and residual, the design does not need to ask "which component exists?" It needs to ask "which component's variability tracks the overall variability, and under what environment/affinity/order controls?" That is a more precise and more testable question than "does pinning help?"

---

## 4. Predicted observations under each hypothesis

For each hypothesis, the design should be able to predict at least one observable pattern that would support it and one that would weaken it.

### H1 — read-dominated

- Supported if: across repeats within a stable-enough environment, the read bucket has materially more spread than open and deserialize, and the per-pair overhead variability is strongly associated with read-time variability.
- Weakened if: read bucket is stable while another bucket is unstable, or if worst-case pairs are concentrated in non-read buckets.

### H2 — open/setup or filesystem

- Supported if: `open_sec` varies substantially, especially with path state, medium state, or cold/warm transitions, and the subsequent read variability correlates with open variability.
- Weakened if `open_sec` is stable and small relative to total variability.

### H3 — deserialize/allocator

- Supported if `deser_sec` or residual has material spread not explained by read/open, especially if it correlates with allocation patterns or repeated-deserialize state.
- Weakened if deserialize is stable given the same blob.

### H4 — instrumentation/order

- Supported if instrumented-vs-minimal differences, residual, or order position explain material variance, and the production buckets are comparatively quiet.
- Weakened if calibration overhead is small and stable and the production buckets still show the variability.

### H5 — environment/affinity

- Supported if variability changes with environment snapshots or affinity condition in a way not explained by the bucket decomposition alone.
- Weakened if variability stays large and unstructured across environment snapshots and affinity conditions once bucket-level noise is separated.

---

## 5. Minimum sample design

This section states a **minimum**, not a final sample plan. The exact numbers should be set by the separate authorization.

### 5.1 Unit of analysis

The unit of analysis is the **paired (replicate, iteration)** sample, exactly as in the existing CSV and calibration. That is the measurement unit that the existing formulas, validator, and Phase 19/23 reconciliation already use. The design should preserve that unit so that any future result is directly comparable to the existing evidence.

### 5.2 Replicates vs iterations

- **Iterations** are the within-replicate measured samples.
- **Replicates** are the sequential, process-local macro-replicates already used by the diagnostic.

The design must make clear that replicates in this diagnostic are **sequential, process-local**, not independent machine/session replications. That is an existing, honest limitation, and the decomposition design must not silently upgrade it to independent replication.

### 5.3 Minimum structure

A minimal design that can actually distinguish the hypotheses must include:

1. **At least two environment/state contexts**, where feasible, so that the design can see whether variability tracks environment state rather than bucket structure. A genuine cold vs warm distinction is the most informative low-cost contrast, if the machine can support it without changing the measurement semantics.
2. **Enough replicates per context** to characterize spread within each bucket, not just a single replicate per bucket. The existing three-per-condition design was too few for strong claims; the decomposition design should explicitly plan for more.
3. **Balanced/counterbalanced order** across the factors that are varied, so that order effects are not confounded with the factor of interest.
4. **An uninstrumented total baseline** separate from the instrumented decomposition, so the design can compare the instrumented bucket sum plus residual with the minimal-condition total.

### 5.4 What "minimum" does and does not mean

Minimum means: fewer observations than a broad campaign, but enough that the design can actually discriminate between the competing predictions in §4. If a proposed sample would only reproduce the existing ambiguity, it is not minimal — it is just small. The authorization should set the final count, but the design should make the discrimination requirement explicit.

---

## 6. Measurement boundaries for the decomposition

### 6.1 Preserving the existing total

Any decomposition must keep the existing **total** measurement as the anchor. Concretely:

- The existing minimal condition with its single outer timer is the baseline for "what is the total cost of the operation under least instrumentation."
- The existing instrumented total must remain comparable to that baseline, with calibration quantifying the instrumentation overhead.

The design must not redefine the total by silently moving clock reads or by changing what is inside the timed region.

### 6.2 Proposed finer buckets, with explicit ownership

The design should propose finer buckets only as **additional** measurements layered on top of, not replacing, the existing ones. One reasonable finer decomposition is:

1. **Open/setup time**: from `steady_clock` before `ifstream` construction to the point after the stream is open and the open-failure check has passed. This isolates work before the actual traversal.
2. **Traversal/read time**: from just before the `istreambuf_iterator` fill begins to just after it ends, excluding the stream open and excluding deserialize.
3. **Deserialize time**: from just before `deserializeWeights(bytes)` to just after it returns.
4. **Residual**: independent outer total minus the sum of the instrumented sub-components, preserving the existing residual semantics.

If any finer bucket is added, the design must record:

- exactly what is inside it,
- exactly what is excluded,
- what extra clock reads it introduces,
- and how those extra reads are handled in calibration.

### 6.3 What must not move

- The production statement sequence itself must not be altered in a way that changes what is being measured.
- The blob used for measurement must remain diagnostic-owned and isolated from production/historical paths, as the existing source already requires.
- The frozen formulas and thresholds must remain the formulas and thresholds used for any calibration statement; a decomposition may add descriptive sub-metrics, but it must not silently redefine pass/fail.

---

## 7. Cache-state and filesystem effects: controlled only if the design actually controls them

This is an explicit requirement: the design must not claim cache state is controlled unless it actually controls and verifies it.

### 7.1 Honest baseline

The existing diagnostic already states the honest baseline:

- It runs warm-cache.
- It performs no cache flush.
- Its replicates are sequential, process-local, not independent machine/session replications.
- It does not claim cache-state or CPU-affinity equivalence with the historical campaign.

The decomposition design must inherit that honesty. If a future run changes cache state, it must say so explicitly and must not retroactively pretend the earlier warm-cache runs were controlled.

### 7.2 How to control cache state, if attempted

If the design aims to characterize cold vs warm, it must specify a concrete, auditable method, such as:

- a documented pre-measurement step that attempts to move the relevant state toward cold, with a recorded verification snapshot,
- a recorded warm-state observation after repeated reads,
- and, critically, a measurement of whether the media/cache behavior actually changed between those contexts.

If no such verification is possible, the design must say the cache-state contrast is attempted but unverified, not that it is controlled.

### 7.3 Filesystem effects

The design should treat filesystem effects as a first-class possibility, not as a side note. At minimum, it should record:

- the exact path used for the measurement blob,
- that the blob is diagnostic-owned and isolated,
- and that any observed open/ready variability could come from the filesystem, the media, the OS cache, or the process, with the current evidence unable to fully separate those.

If the design wants to separate filesystem from process, it needs an explicit control or contrast, not an assumption.

---

## 8. Environment capture spec

The design should specify what environment information is captured with each run and with each state transition. Based on what already exists in the Phase 19 runner, a reasonable capture set includes:

- timestamp of each measurement phase,
- the pre-run and post-run system snapshots already implemented in the Phase 19 runner (system CPU busy fraction, self-process mask, system mask, AC/power status, active power scheme, thermal probe when available, topology including P/E cores and shared caches),
- the affinity condition actually used, including the verification evidence already produced by the runner (mask observed before resume, after resume, and at exit),
- any failure or drift in affinity verification,
- the executable identity and hash before the run,
- and confirmation that the historical CSV was unchanged before and after the run.

The design should also require that environment capture be stored **per run**, not summarized later from memory. That is what makes a future result auditable.

### 8.1 What must remain captured as gaps if unmeasurable

If a machine cannot expose a measurement (for example thermal), the design must record it as unavailable rather than inventing one. The existing runner already does this for thermal and for some power information; the decomposition design should preserve that discipline.

---

## 9. Observer overhead: assessment and preservation of measurement semantics

### 9.1 The core concern

The decomposition adds more clock reads. More clock reads can add overhead and can add noise. The design must therefore:

1. measure the overhead of the added instrumentation rather than assume it is negligible,
2. keep the added overhead small relative to the buckets being measured,
3. and preserve the meaning of the existing total so earlier results stay comparable.

### 9.2 How to assess observer overhead

The cleanest assessment is to treat the existing minimal condition as the reference and to treat the existing instrumented condition as the already-calibrated overhead baseline. Any finer decomposition should:

- report the additional clock-read cost explicitly,
- show that the instrumented total with the finer buckets still calibrates against the minimal total using the same calibration logic,
- and avoid making the finer buckets depend on clock reads that dominate the bucket they are meant to measure.

If a finer bucket would be so small that added clock reads change its meaning, the design should either not split that far or should explicitly label the result as instrumentation-limited.

### 9.3 Preserving semantics

Semantics are preserved if:

- the minimal total is unchanged,
- the instrumented total is still a bracketed measurement of the same operation,
- calibration still compares instrumented vs minimal paired samples,
- and any new sub-metric is labeled as descriptive unless it is computed under the frozen calibration logic.

The design must state this preservation requirement explicitly, because it is easy to introduce a finer decomposition that measures something real but different from what the earlier phases measured.

---

## 10. Instrumented decomposition vs uninstrumented baseline

Both are needed, and both have limitations.

### 10.1 Uninstrumented baseline

The uninstrumented minimal condition gives the least-distorted view of the total operation cost. Its strength is semantic closeness to the original production operation. Its limitation is resolution: it does not, by itself, tell you which sub-component varies.

### 10.2 Instrumented decomposition

The instrumented decomposition gives resolution: it can attribute time to open, read, deserialize, residual, and possibly finer sub-buckets. Its limitation is that it is instrumentation; its overhead must be quantified and its added noise must be acknowledged.

### 10.3 The comparison that matters

The design is strongest if it can show that the instrumented decomposition is consistent with the uninstrumented total after calibration, and then use the instrumented decomposition only for the attribution questions the uninstrumented total cannot answer.

If the instrumented decomposition and the uninstrumented total disagree beyond what calibration explains, that disagreement is itself evidence — not a reason to hide one of them.

### 10.4 Limitations to state plainly

- The decomposition can attribute variability only as finely as the buckets allow.
- Some effects may be smeared across buckets by timing granularity, cache effects, or code motion.
- A stable bucket does not prove the underlying work is deterministic; it only proves the bucket was stable under the measured conditions.
- An unstable bucket does not by itself prove the instability source; it only localizes the measurement.

---

## 11. Proposed isolated artifact layout

Everything below is proposal-only and must be placed under a new isolated phase directory, not under the frozen evidence trees.

### 11.1 Directory root

A new root such as:

- `work/b7_diag_20261011_paired_capture/phase25_read_path_decomposition/`

No new files go into `phase16_vs2019`, `phase19_runs`, or any other prior phase directory.

### 11.2 Per-run structure

A reasonable per-run layout:

- one run directory per run, with an opaque unique name,
- inside it: `ops/` with `exec_meta.json`, `pre_state.json`, `post_state.json`, `stdout.txt`, `stderr.txt`, `exitcode.txt`,
- the run-owned diagnostic artifact directory under `build/bm_b7_diagnostic/` if any diagnostic-owned artifact is created,
- and the host-captured paired CSV under the run's host-capture directory.

### 11.3 Decomposition-specific outputs

If the run produces a finer decomposition, the design should require an explicit structured output, for example:

- a decomposition CSV with the same `(replicate, iteration)` grain as the existing paired CSV,
- extra columns for the finer buckets,
- and a clear statement of which columns are the existing frozen grain and which are new descriptive columns.

### 11.4 Manifest and hashes

The design should include a manifest with:

- the executable used and its hash,
- the build path,
- the protocol used,
- the exact artifact paths,
- the environment snapshots,
- the run order and factor assignments,
- and SHA-256 hashes of all produced artifacts.

That makes the run self-contained and auditable without relying on later memory.

---

## 12. Validation rules for the proposed design

The decomposition should reuse, not reinvent, the existing validation discipline.

### 12.1 Reused rules

For the existing paired grain, reuse the existing validator logic verbatim:

- exact header,
- exactly 300 rows for the existing protocol,
- exact `(replicate, iteration)` key set,
- per-replicate counts,
- finiteness and positivity checks,
- per-row `signed_overhead_pct` formula consistency,
- and the frozen metrics recomputed from CSV bytes.

### 12.2 New rules for new columns

For any new descriptive columns, the design should require:

- an explicit definition of the column,
- the exact formula,
- the unit,
- the pre-condition under which it is valid,
- and a separate validation path so that new descriptive columns cannot accidentally corrupt the frozen grain.

### 12.3 Failure handling

If a run fails to produce a valid artifact:

- the failure is recorded,
- no overwrite of an existing artifact occurs,
- and the run does not claim evidence it did not produce.

If a run cannot be validated, it is recorded as invalid and is not silently promoted to evidence.

---

## 13. Protected-evidence checks before any future execution

Before any future run, the design should require a protected-evidence check that mirrors Phase 24:

- confirm the executable used is the intended one and hash it,
- confirm the diagnostic source, CMake, and harness source are unchanged if they are considered protected,
- confirm any frozen CSV that must not be touched is unchanged,
- confirm prior reports are unchanged,
- and record all of that before the run, not after.

If the chosen executable is not byte-identical to the previously frozen one, the design must say so explicitly and must not treat the historical numbers as directly comparable without a separate decision.

---

## 14. What this design deliberately does not commit to

- It does not commit to any particular sample count.
- It does not commit to any particular cache-control method beyond requiring honesty about whether cache state is controlled.
- It does not commit to reproducing historical affinity exactly; it says the design must state explicitly which affinity model it uses.
- It does not commit to compiler or build changes; it says any such change is a separate authorization.
- It does not guarantee that the decomposition will identify a root cause; it only improves localization.

---

## 15. Decision

The design is internally consistent with the existing evidence and source, isolates all proposals, preserves the frozen measurement semantics, and states its own limitations without overclaiming.

**Decision:** `READY FOR USER AUTHORIZATION`

This decision concerns the proposed design only. It does not authorize any execution, build, or measurement.
