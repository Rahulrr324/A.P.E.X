# G7 Cross-Run Variance — Root-Cause Investigation

**Status of the underlying G7 outcome:** unchanged — the new frozen G7 campaign
(`build/g7-campaign-frozen-20261008/`) has already been executed and aggregated.
The production result is **G7 FAIL**; the production aggregator exit code and the
independent verifier exit code are recorded in §9 and are not re-derived here.

This document determines which execution-path factors plausibly explain the
observed cross-run median variance and which hypotheses are actually supported
by measurements. It does not attempt to make G7 pass.

> Exit codes in this document are those of the analysis tooling executed during
> this investigation, plus the already-captured campaign/aggregator/verifier exit
> codes, which are restated (not re-run) for completeness.

---

## 1. Executive conclusion

The new frozen G7 campaign produces **genuine cross-run median disagreement** in
all three groups: the independent recompute confirms B6 50.2921%, B7 52.2676%,
B9 31.0940% maximum pairwise symmetric relative differences, each over the 15%
frozen tolerance. The disagreement is **not** caused by a median-consistency
defect: every stored median matches its recomputed raw-sample median to 0.0000%.

The disagreement is **not** cleanly explained by the E1-vs-E5 split: the E1 and
E5 configuration dumps are **identical** (production grouping semantics), and the
mean-E1-vs-mean-E5 gaps (B6 14.62%, B7 21.69%, B9 6.80%) are all smaller than
the worst-pair values. Two of the three worst pairs (B6 and B9) are **internal
to a single experiment designation** (within E1 for B6, within E5 for B9),
which rules out a systematic “E1 differs from E5” explanation.

The two most plausible, mutually compatible, evidence-supported hypotheses are:

1. **Run-context sensitivity, most pronounced for the I/O-bound B7 benchmark.**
   B7 (`warm_cache`, file read + deserialize per iteration) has the largest
   cross-run spread (52.27%) and the largest within-E5 spread (49.96%); its
   measured operation is file-system/cache-state-sensitive by construction. The
   timing-path trace shows B7 measures **each iteration’s** `ifstream` read +ㅜ
   `deserializeWeights`, so per-iteration cache/OS I/O state is in-band for the
    median. This is consistent with the observed B7 distribution but is
   **correlational, not proven** — the records contain no per-sample I/O or
   cache telemetry, so the records alone cannot discriminate a transient I/O
   outlier from other sources of variation.

2. **Isolated high-magnitude outlier records within an otherwise tight core.**
   In all three groups most records form a tight cluster (±1–19%), and the
   worst pairs are driven by one or two outliers that sit far outside that core
   (B6: 359.50 µs vs ~219 µs core; B7: 5721.90 µs vs ~2800–4150 µs core;
   B9: 260.50 µs vs ~180 µs core). This is an **observed pattern in the
   records**, not a hypothesis about an unmeasured mechanism.

The **within-execution** frequency diagnostics from the historical v7/v8
investigation are **different measurements from different scopes** and cannot be
substituted for the new campaign’s cross-run median differences. They are
retained as historical context only; they do not validate or invalidate a
frequency hypothesis for this campaign, because this campaign was run with no
frequency gate and no frequency telemetry.

**Bottom line:** the records establish **what** failed and **which** records
drive it; they do **not** uniquely establish **why** those specific runs were
outliers. The conclusion is therefore
**MULTIPLE CONTRIBUTING FACTORS IDENTIFIED — CAUSAL WEIGHTS UNRESOLVED**, with
the smallest justified next diagnostic recorded in §8.

This investigation does **not** change M0 status: **M0 remains FAIL** and
**M1 remains LOCKED**.

---

## 2. Recomputed per-group statistics and worst pairs

Source: `scripts/recompute_g7_frozen.py` (exit 0), raw output
`reports/g7-campaign-affinityfix/recompute_raw.txt`. All medians and pairwise
symmetric relative differences were recomputed from the raw samples stored in the
30 records; no stored median or production aggregator output was used as input to
the recompute. Every stored median matched its recomputed median to 0.0000%.

### B6 — 10 records — tolerance 15% — FAIL (recompute)

| record_id | exp | created_utc | median (µs) |
|---|---|---|---|
| G7CAM-B6-E1-9007430 | E1 | 2026-10-08T15:14:58.398Z | 359.50 |
| G7CAM-B6-E1-11933807 | E1 | 2026-10-08T15:15:59.411Z | 219.45 |
| G7CAM-B6-E1-39872860 | E1 | 2026-10-08T15:15:28.832Z | 219.80 |
| G7CAM-B6-E1-41851871 | E1 | 2026-10-08T15:17:00.763Z | 219.80 |
| G7CAM-B6-E1-76656589 | E1 | 2026-10-08T15:16:30.197Z | 178.70 |
| G7CAM-B6-E5-9007430 | E5 | 2026-10-08T15:14:58.610Z | 181.50 |
| G7CAM-B6-E5-11933807 | E5 | 2026-10-08T15:15:59.723Z | 221.35 |
| G7CAM-B6-E5-39872860 | E5 | 2026-10-08T15:15:29.094Z | 219.95 |
| G7CAM-B6-E5-41851871 | E5 | 2026-10-08T15:17:01.028Z | 220.00 |
| G7CAM-B6-E5-76656589 | E5 | 2026-10-08T15:16:30.458Z | 179.45 |

- n_pairs = 45; max pairwise symmetric relative diff = **50.2921%**
- worst pair: runs 4 ↔ 5 — **G7CAM-B6-E1-76656589 (178.70 µs) ↔
  G7CAM-B6-E1-9007430 (359.50 µs)** — both E1
- min pairwise diff = 0.0000%; CV = 22.19%; failing pairs = 27/45
- **verdict = FAIL**

Group note: within-E1 spread = 50.29%, within-E5 spread = 18.93%;
mean-E1 = 239.45 µs vs mean-E5 = 204.45 µs (cross diff 14.62%). The worst pair
is internal to E1.

### B7 — 10 records — tolerance 15% — FAIL (recompute)

| record_id | exp | created_utc | median (µs) |
|---|---|---|---|
| G7CAM-B7-E1-9007430 | E1 | 2026-10-08T15:14:58.582Z | 2731.20 |
| G7CAM-B7-E1-11933807 | E1 | 2026-10-08T15:15:59.674Z | 3339.05 |
| G7CAM-B7-E1-39872860 | E1 | 2026-10-08T15:15:29.062Z | 3300.85 |
| G7CAM-B7-E1-41851871 | E1 | 2026-10-08T15:17:00.997Z | 3242.55 |
| G7CAM-B7-E1-76656589 | E1 | 2026-10-08T15:16:30.408Z | 2814.60 |
| G7CAM-B7-E5-9007430 | E5 | 2026-10-08T15:14:58.799Z | 2863.35 |
| G7CAM-B7-E5-11933807 | E5 | 2026-10-08T15:16:00.149Z | 5721.90 |
| G7CAM-B7-E5-39872860 | E5 | 2026-10-08T15:15:29.356Z | 4147.15 |
| G7CAM-B7-E5-41851871 | E5 | 2026-10-08T15:17:01.237Z | 3075.55 |
| G7CAM-B7-E5-76656589 | E5 | 2026-10-08T15:16:30.716Z | 3892.45 |

- n_pairs = 45; max pairwise symmetric relative diff = **52.2676%**
- worst pair: runs 5 ↔ 6 — **G7CAM-B7-E1-9007430 (2731.20 µs, E1) ↔
  G7CAM-B7-E5-11933807 (5721.90 µs, E5)**
- min pairwise diff = 1.1440%; CV = 24.30%; failing pairs = 26/45
- **verdict = FAIL**

Group note: within-E1 spread = 18.20%, within-E5 spread = 49.96%;
mean-E1 = 3085.65 µs vs mean-E5 = 3940.08 µs (cross diff 21.69%). The worst
pair crosses experiment designations, but the larger **within-E5** spread shows
the variation is not confined to an E1-vs-E5 boundary; the largest single
contributor is G7CAM-B7-E5-11933807 at 5721.90 µs, which is >90% above the
9-record core (2731.20–4147.15 µs).

### B9 — 10 records — tolerance 15% — FAIL (recompute)

| record_id | exp | created_utc | median (µs) |
|---|---|---|---|
| G7CAM-B9-E1-9007430 | E1 | 2026-10-08T15:14:58.596Z | 181.75 |
| G7CAM-B9-E1-11933807 | E1 | 2026-10-08T15:15:59.698Z | 223.80 |
| G7CAM-B9-E1-39872860 | E1 | 2026-10-08T15:15:29.077Z | 187.55 |
| G7CAM-B9-E1-41851871 | E1 | 2026-10-08T15:17:01.012Z | 222.65 |
| G7CAM-B9-E1-76656589 | E1 | 2026-10-08T15:16:30.429Z | 180.60 |
| G7CAM-B9-E5-9007430 | E5 | 2026-10-08T15:14:58.814Z | 182.15 |
| G7CAM-B9-E5-11933807 | E5 | 2026-10-08T15:16:00.181Z | 260.50 |
| G7CAM-B9-E5-39872860 | E5 | 2026-10-08T15:15:29.371Z | 223.80 |
| G7CAM-B9-E5-41851871 | E5 | 2026-10-08T15:17:01.254Z | 223.10 |
| G7CAM-B9-E5-76656589 | E5 | 2026-10-08T15:16:30.736Z | 179.50 |

- n_pairs = 45; max pairwise symmetric relative diff = **31.0940%**
- worst pair: runs 6 ↔ 9 — **G7CAM-B9-E5-11933807 (260.50 µs, E5) ↔
  G7CAM-B9-E5-76656589 (179.50 µs, E5)** — both E5
- min pairwise diff = 0.0000%; CV = 12.82%; failing pairs = 25/45
- **verdict = FAIL**

Group note: within-E1 spread = 19.30%, within-E5 spread = 31.09%;
mean-E1 = 199.27 µs vs mean-E5 = 213.81 µs (cross diff 6.80%). The worst pair
is internal to E5, and the E1-vs-E5 mean gap is the smallest of the three groups.

---

## 3. Run-order and E1/E5 comparisons

### 3.1 Configuration identity (production grouping semantics)

Each benchmark’s E1 and E5 configuration dumps are **identical** as JSON text
(`configuration.dump()` matches), so E1 and E5 share one same-configuration group
of 10 records per benchmark. This is the unchanged production grouping semantics
(`experiment_id` and `affinity` are not part of the grouping key), not a campaign
choice.

| benchmark | E1 config == E5 config | E1 n | E5 n | E1 mean median (µs) | E5 mean median (µs) | E1↔E5 mean diff |
|---|---|---|---|---|---|---|
| B6 | True | 5 | 5 | 239.45 | 204.45 | 14.62% |
| B7 | True | 5 | 5 | 3085.65 | 3940.08 | 21.69% |
| B9 | True | 5 | 5 | 199.27 | 213.81 | 6.80% |

The E1-vs-E5 mean gaps are all smaller than the worst-pair values, so a
systematic “E1 is different from E5” hypothesis is **not supported** as the
dominant explanation for any group.

### 3.2 Run-order correlation

Records ordered by `created_utc` show no monotonic trend in median for any group:
the lowest and highest medians in each group are not at the start or end of the
timeline, and the worst pairs are not adjacent in time. Example for B6 by
`created_utc` (median in µs): 359.50, 181.50, 219.80, 219.95, 219.45, 221.35,
178.70, 179.45, 219.80, 220.00 — the largest (359.50) and one of the smallest
(178.70) are early, not late. The same is true for B7 and B9: the outlier
medians are interleaved among the tight cluster rather than monotonically
drifting.

Conclusion: **no simple run-order / time-of-execution correlation is supported
by the records.** If warm-up/cool-down of some unmeasured OS resource were the
sole cause, one would expect a directional trend; none is visible.

### 3.3 Outlier structure

Across all three groups the distribution is **core + outliers**, not a single
broad cloud:

- B6 core ≈ 178.70–221.35 µs across 8 records; two E1 outliers (359.50 and —
  relative to that core — the low 178.70/179.45 pair is only ~19% below the
  219–220 µs core, while the high 359.50 is ~50% above it).
- B7 core ≈ 2731.20–4147.15 µs across 9 records; one E5 outlier at 5721.90 µs.
- B9 core ≈ 179.50–223.80 µs across 9 records; one E5 outlier at 260.50 µs.

The pattern is repeated across benchmarks: **most runs agree within a modest
band**, and **one or two runs are far outside that band**. That is a real
structure in the evidence and is the most defensible descriptive finding.

### 3.4 Per-record outlier table (read from recompute_raw.txt)

For each group, the table lists every record’s recomputed median, its distance
from the group’s core median band, and whether it is a worst-pair contributor.
Core band is defined descriptively as the tightest cluster that contains the
majority of records; it is not a fitted model.

#### B6 — core ≈ 178.70–221.35 µs

| record_id | exp | created_utc | median (µs) | distance from core | worst-pair role |
|---|---|---|---|---|---|
| G7CAM-B6-E1-9007430 | E1 | 2026-10-08T15:14:58.398Z | 359.50 | ~63% above core | yes (max pair, with G7CAM-B6-E1-76656589) |
| G7CAM-B6-E1-76656589 | E1 | 2026-10-08T15:16:30.197Z | 178.70 | low edge of core | yes (max pair, with G7CAM-B6-E1-9007430) |
| G7CAM-B6-E5-9007430 | E5 | 2026-10-08T15:14:58.610Z | 181.50 | low edge of core | no (not in max pair) |
| G7CAM-B6-E5-76656589 | E5 | 2026-10-08T15:16:30.458Z | 179.45 | low edge of core | no |
| G7CAM-B6-E1-11933807 | E1 | 2026-10-08T15:15:59.411Z | 219.45 | inside core | no |
| G7CAM-B6-E1-39872860 | E1 | 2026-10-08T15:15:28.832Z | 219.80 | inside core | no |
| G7CAM-B6-E1-41851871 | E1 | 2026-10-08T15:17:00.763Z | 219.80 | inside core | no |
| G7CAM-B6-E5-39872860 | E5 | 2026-10-08T15:15:29.094Z | 219.95 | inside core | no |
| G7CAM-B6-E5-41851871 | E5 | 2026-10-08T15:17:01.028Z | 220.00 | inside core | no |
| G7CAM-B6-E5-11933807 | E5 | 2026-10-08T15:15:59.723Z | 221.35 | inside core | no |

Note: the “outside core” record is the single high outlier G7CAM-B6-E1-9007430
(359.50 µs); the B6 max pair is high-outlier-vs-low-core-edge, not high-vs-high.

#### B7 — core ≈ 2731.20–4147.15 µs

| record_id | exp | created_utc | median (µs) | distance from core | worst-pair role |
|---|---|---|---|---|---|
| G7CAM-B7-E5-11933807 | E5 | 2026-10-08T15:16:00.149Z | 5721.90 | ~38% above core top | yes (max pair, with G7CAM-B7-E1-9007430) |
| G7CAM-B7-E1-9007430 | E1 | 2026-10-08T15:14:58.582Z | 2731.20 | low edge of core | yes (max pair, with G7CAM-B7-E5-11933807) |
| G7CAM-B7-E1-76656589 | E1 | 2026-10-08T15:16:30.408Z | 2814.60 | inside core (low side) | no |
| G7CAM-B7-E5-9007430 | E5 | 2026-10-08T15:14:58.799Z | 2863.35 | inside core (low side) | no |
| G7CAM-B7-E5-41851871 | E5 | 2026-10-08T15:17:01.237Z | 3075.55 | inside core | no |
| G7CAM-B7-E1-41851871 | E1 | 2026-10-08T15:17:00.997Z | 3242.55 | inside core | no |
| G7CAM-B7-E1-39872860 | E1 | 2026-10-08T15:15:29.062Z | 3300.85 | inside core | no |
| G7CAM-B7-E1-11933807 | E1 | 2026-10-08T15:15:59.674Z | 3339.05 | inside core | no |
| G7CAM-B7-E5-76656589 | E5 | 2026-10-08T15:16:30.716Z | 3892.45 | inside core (high side) | no |
| G7CAM-B7-E5-39872860 | E5 | 2026-10-08T15:15:29.356Z | 4147.15 | top edge of core | no |

Note: B7 has a single strong high outlier (G7CAM-B7-E5-11933807) that sits well
above even the high side of the core; the max pair is that outlier against the low
core edge (G7CAM-B7-E1-9007430).

#### B9 — core ≈ 179.50–223.80 µs

| record_id | exp | created_utc | median (µs) | distance from core | worst-pair role |
|---|---|---|---|---|---|
| G7CAM-B9-E5-11933807 | E5 | 2026-10-08T15:16:00.181Z | 260.50 | ~16% above core top | yes (max pair, with G7CAM-B9-E5-76656589) |
| G7CAM-B9-E5-76656589 | E5 | 2026-10-08T15:16:30.736Z | 179.50 | low edge of core | yes (max pair, with G7CAM-B9-E5-11933807) |
| G7CAM-B9-E1-76656589 | E1 | 2026-10-08T15:16:30.429Z | 180.60 | inside core (low side) | no |
| G7CAM-B9-E5-9007430 | E5 | 2026-10-08T15:14:58.814Z | 182.15 | inside core (low side) | no |
| G7CAM-B9-E1-9007430 | E1 | 2026-10-08T15:14:58.596Z | 181.75 | inside core (low side) | no |
| G7CAM-B9-E1-39872860 | E1 | 2026-10-08T15:15:29.077Z | 187.55 | inside core | no |
| G7CAM-B9-E5-41851871 | E5 | 2026-10-08T15:17:01.254Z | 223.10 | inside core (high side) | no |
| G7CAM-B9-E1-41851871 | E1 | 2026-10-08T15:17:01.012Z | 222.65 | inside core (high side) | no |
| G7CAM-B9-E5-39872860 | E5 | 2026-10-08T15:15:29.371Z | 223.80 | top edge of core | no |
| G7CAM-B9-E1-11933807 | E1 | 2026-10-08T15:15:59.698Z | 223.80 | top edge of core | no |

Note: the B9 max pair is **both-E5**, and the high side of the core and the outlier
are separated by ~36.70 µs; the low side is shared with several E1 and E5 records,
so the outlier is specific to G7CAM-B9-E5-11933807.

Across all three groups, the worst-pair contributors are specific records, not
whole experiment designations: the max pair is high-outlier-vs-low-edge in B6 and
B7, and high-E5-vs-low-E5 in B9.

---

## 4. Production timing-path trace

The production benchmark implementations are in
`src/phase1/bench/BenchmarkHarness.cpp` and
`src/phase1/campaign/G7Campaign.cpp`. The measured metric is the wall duration of
one iteration of the timed op, captured with `std::chrono::steady_clock` around
the op call only (setup/teardown/warmup are outside the timed region).

### 4.1 What is timed, per benchmark

- **B6** (`bench_tiny_inference`): each timed iteration calls `model.forward()`
  once on a `TINY-DENSE-2L` model. No file I/O in the timed op; the model is
  already constructed. Warmup is 10 iterations outside the timed region;
  measurement is 50 iterations, each timed individually.
- **B7** (`bench_model_load_time`): each timed iteration opens the serialized
  weight blob (`std::ifstream`), reads the entire blob into a `vector<uint8_t>`,
  and calls `loader.deserializeWeights(bytes)`. The weight file is written once
  before the first B7 iteration of a run by `bench_model_load_time` (same path
  used by all iterations), and the record’s configuration carries
  `workload_params.mode = "warm_cache"`. So **every timed iteration does I/O**.
- **B9** (`bench_inference_stability`): each timed iteration calls
  `model.forward()` once (200-repeat stability check is part of the op but the
  timed region is the whole op call). No file I/O in the timed op.

### 4.2 What is **not** timed

Per `run_benchmark` in `BenchmarkHarness.cpp`:

- warmup iterations (10) are before the timed loop;
- peak memory (`sample_peak_memory`) is sampled **after** the timed loop, not
  inside each iteration;
- affinity is applied **before** any timed work (`apply_campaign_affinity`), so
  affinity setup is not in the timed samples (but the provenance block records
  the result);
- the per-iteration timer brackets only the `op()` call and its return.

### 4.3 Affinity and thread model

The campaign uses `thread_count = 1`, and per-run affinity is verified by
`HardwareAffinity::requestAndVerifyFirstCpu()` before timing. Every benchmark
record in this campaign carries `provenance.affinity.verified_single_cpu = true`
with `raw_process_mask = 1` (CPU0). Thread-count is a policy field, not an OS
guarantee, but the records honestly capture the verified single-CPU outcome.

### 4.4 Implications for the variance hypotheses

Because B7’s timed op **includes file I/O and deserialization every iteration**,
its median is specifically sensitive to whatever affects that path on a given run
(OS cache state, disk subsystem, antivirus/intercept, file-system cache, page
fault behavior, etc.). B6 and B9’s timed ops are pure in-memory forward passes,
so they are less directly tied to I/O state. This is a **construction-level fact
about the timed region**, not a measurement of I/O in the records; it makes the
I/O/cache hypothesis **structurally plausible for B7 more than for B6/B9**, and
the data are consistent with that (B7 has the largest spread and the largest
within-E5 spread). It does **not** prove that I/O caused any specific outlier,
because the records do not contain per-sample I/O or cache telemetry.

---

## 5. Evidence-supported findings versus unproven hypotheses

### Supported by the records (measured facts)

1. **All groups fail the frozen G7 tolerance** on fresh current-machine evidence,
   confirmed by the production aggregator, the original independent verifier, and
   the recompute in this investigation (identical max diffs).
2. **No median-consistency defect**: stored medians match recomputed medians to
   0.0000% for all 30 records, so the failures are real cross-run median
   disagreement.
3. **E1 and E5 share the identical configuration dump** (identical grouping key),
   and mean-E1-vs-mean-E5 gaps are smaller than the worst pairs, so the failure
   is not a clean E1-vs-E5 split.
4. **Worst pairs are driven by outlier records within a tight core.** B6 worst
   pair is within E1; B9 worst pair is within E5; B7 worst pair crosses
   designations but the largest within-group spread is within E5.
5. **No monotonic run-order trend** is visible in any group.

### Plausible but not proven by the records (hypotheses)

1. **B7 I/O/cache-state sensitivity.** Supported structurally by the timed region
   (file read + deserialize every iteration) and consistent with B7’s larger
   spread, but **not directly measured** in the records; no per-sample I/O or
   cache state is stored. Cannot be confirmed as the cause from these records
   alone.
2. **Transient outlier runs.** The outlier records exist; what caused each
   specific outlier run (I/O, scheduling, OS background activity, frequency
   transition, memory-pressure event, etc.) is **not recorded** in the
   benchmark records. The records cannot discriminate among these.
3. **Frequency variation.** Available only from the historical v7/v8 diagnostics,
   which are a **different measurement scope** (exec-window and in-exec frequency
   snapshots), not per-benchmark median timing attribution. Those diagnostics
   predate this campaign and did not gate it; they are cited here only as
   historical context, **not** as evidence about the cause of these specific
   30 records. No frequency gate was applied to this campaign.

### Explicitly not supported

- A systematic E1-vs-E5 difference (mean gaps too small; worst pairs internal to
  one designation in two of three groups).
- A run-order trend (no monotonicity).
- A median-computation error (0.0000% stored-vs-recomputed everywhere).
- Any conclusion that the 5% frequency criterion is relevant here (it was retired
  as a gate and is not part of the frozen G7 contract; this investigation does not
  reintroduce it).

---

## 6. Historical v7/v8 comparison with measurement-scope distinctions

The historical diagnostics are in `reports/g7-campaign-affinityfix/`:

- `highres_predeclaration.txt`, `highres_analysis.txt`, `highres_v8_analysis.txt`,
  `CPU_FREQUENCY_CAUSE_INVESTIGATION.md`, `power_control_gate.txt`,
  `gate_predeclaration.txt` — these are **frequency/stability diagnostics**
  collected under a controlled power-scheme experiment, predeclared and run as a
  frequency investigation.

Measurement scope distinction (critical):

- The **historical diagnostics** measure **CPU frequency** (via PDH
  `% Processor Performance` and in-exec sampling) around and during benchmark
  executions. They characterize **frequency variation**, not benchmark median
  reproducibility.
- The **new campaign** measures **benchmark median timing reproducibility**
  (cross-run median symmetric relative difference) under the frozen G7 contract,
  with **no frequency gate** and **no frequency telemetry** in the records.

These are **different quantities**. A between-execution frequency spread in a
historical controlled experiment is not the same measurement as cross-run median
timing differences in this campaign, and the historical diagnostics do **not**
measure the thing G7 is testing here. They are retained as historical context and
are **not** used as evidence that frequency caused this campaign’s failures, nor
as evidence that it did not.

---

## 7. Ranked candidate causes with supporting and contradicting evidence

### 7.1 Run-context sensitivity of the I/O-bound B7 benchmark (highest plausibility
for B7 specifically)

- **Supporting evidence:** B7’s timed op is file read + deserialize every
  iteration (`BenchmarkHarness.cpp:bench_model_load_time`); B7 has the largest
  cross-run spread (52.27%) and the largest within-E5 spread (49.96%); B7’s
  outlier (5721.90 µs) is the single largest deviation from its core in absolute
  terms. This is structurally consistent with I/O/cache-state sensitivity.
- **Contradicting / limiting evidence:** the records contain no per-sample I/O or
  cache telemetry, so this cannot be confirmed as the cause of the B7 outlier
  from these records alone; and B6 and B9 also fail, so whatever explains B7’s
  outlier is not the full explanation for all three groups.

### 7.2 Isolated high-magnitude outlier runs (across all groups)

- **Supporting evidence:** all three groups show a tight core plus one or two
  outliers; worst pairs are identified to specific outlier records; within-group
  spreads outside the outliers are much smaller (e.g., B9 within-core is ~19%,
  B6 core is ~1%).
- **Contradicting / limiting evidence:** the records do not record what made those
  specific runs outliers; multiple mechanisms (I/O, scheduling, OS background
  activity, memory pressure, frequency transitions, etc.) are compatible with the
  observed pattern, and the records cannot discriminate among them.

### 7.3 Systematic E1-vs-E5 difference (not supported)

- **Supporting evidence:** none beyond the existence of two experiment designations.
- **Contradicting evidence:** E1 and E5 config dumps are identical; mean-E1-vs-mean-E5
  gaps (6.80%–21.69%) are smaller than worst pairs; two of three worst pairs are
  internal to a single designation.

### 7.4 Frequency variation as the cause (not established here)

- **Supporting evidence (limited):** historical diagnostics documented
  between-execution frequency variation in a controlled experiment.
- **Contradicting evidence (for this campaign):** the historical measurements are a
  different scope; this campaign had no frequency gate and no frequency telemetry;
  frequency variation is neither required nor ruled out by these records. This
  candidate is **not adjudicated** by this investigation.

---

## 8. Smallest justified next diagnostic

If a single non-destructive diagnostic is justified to discriminate among the
remaining hypotheses, the smallest one that adds **new, discriminative evidence**
would be a **diagnostic rerun of the already-failed outlier runs only**, with
auxiliary per-run context captured alongside the existing record schema **without
changing the production benchmark, timing semantics, grouping, or thresholds**. The
discriminative value would come from correlating each run’s median with
machine-visible context that is currently absent from the records (for example,
per-run OS cache/file-system state markers, per-run scheduling/foreground-load
markers, or — carefully scoped — frequency snapshots taken during that specific
run).

This is **not** a new G7 campaign and does **not** change the G7 result. It is a
targeted diagnostic to explain the already-recorded FAIL. It is justified only if
the goal is to move from “multiple compatible factors, weights unresolved” to a
more specific cause; it is **not** justified if the goal is to obtain a PASS.

If no such diagnostic is desired, the honest conclusion stands: the records
establish the failure and the outlier structure, but not a unique root cause.

---

## 9. Integrity before/after results and exit codes

### 9.1 Analysis tooling exit codes (this investigation)

| Tool / action | Exit |
|---|---|
| `python scripts/recompute_g7_frozen.py` (independent recompute + E1/E5/run-order analysis) | **0** (reporting OK; verdict FAIL) |

Raw recompute output: `reports/g7-campaign-affinityfix/recompute_raw.txt`.

### 9.2 Already-captured campaign/integrity exit codes (restated, not re-run)

| Step | Command (summary) | Exit |
|---|---|---|
| Campaign | `build-v24-release/g7_campaign.exe --out build/g7-campaign-frozen-20261008 --samples 50 --warmup 10 --runs 5 --threads 1` | **0** |
| Production aggregation | `build-v24-release/aggregate.exe --out build/g7-campaign-frozen-20261008` | **1** (G7 FAIL) |
| Independent verifier (original) | `python reports/g7-campaign/verify_g7.py build/g7-campaign-frozen-20261008` | **1** (FAIL; agrees) |
| Frozen-30 integrity (before and after) | `verify_frozen30.py` | **0** (30/30, manifest unchanged) |
| Power scheme restore | `powercfg /getactivescheme` (unchanged `dfe97760…`) | **0** |

### 9.3 State protected by this investigation

No campaign record, production binary, source file, `evidence_manifest.json`, or
historical G7CAM record was modified by this investigation. The only new analysis
artifacts are `scripts/recompute_g7_frozen.py` and
`reports/g7-campaign-affinityfix/recompute_raw.txt`, both derived by reading the
existing records. The new campaign directory `build/g7-campaign-frozen-20261008/`
and the existing report
`stark/reports/g7-campaign-affinityfix/G7_FROZEN_CAMPAIGN_RESULT.md` are
untouched by this document beyond the report’s own text.

---

## Final required status

MULTIPLE CONTRIBUTING FACTORS IDENTIFIED — CAUSAL WEIGHTS UNRESOLVED

**M0 status: M0 remains FAIL.** **M1 remains LOCKED.** This investigation does not
execute a new campaign, does not modify any threshold/formula/grouping/median/configuration
/affinity/historical record, and does not change M0 or M1 state.
