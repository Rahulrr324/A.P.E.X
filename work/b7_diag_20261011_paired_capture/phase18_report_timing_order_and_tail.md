# Phase 18 — Timing-Order and Residual-Tail Investigation

**status:** read-only investigation complete. The B7 diagnostic was **not** re-run; no source, executable,
CSV, threshold, or frozen evidence was modified; nothing was staged, committed, pushed, or cleaned.
**date_utc:** 2026-10-14
**subject:** `work/b7_diag_20261011_paired_capture/run2/paired_samples.csv` (unchanged, sha256 `818bf1a5…`)
**predecessor:** `phase17_report_calibration_failure_analysis.md`

---

## 0. Headline — Phase 17's reading is partly revised

Two Phase 17 statements do **not** survive closer analysis, and one new mechanism is strongly supported:

1. **Revised — the early-block "ramps" are not ramps.** Per-iteration inspection shows step/bimodal regime
   changes with an intra-block range of **2.04–2.19×**. The largest single-iteration step is 1.3× to 90×
   larger than the net first-10-vs-last-10 change. "Rising/falling" block labels are artifacts of which
   decile happened to land in which regime.
2. **Revised — the >10 % tail is not a warm-up effect.** It is distributed *uniformly* over the measured
   loop (median iteration index **24.5**, exactly the uniform expectation) and is **under**-represented at
   block starts (20.8 % at iterations 0–1 vs a 32.0 % base rate). Insufficient per-block warm-up is
   therefore **not supported**; the data show the first iterations are unusually *clean*.
3. **New, strongly supported — the machine does not run in one steady state.** The CPU is a **hybrid
   Intel i5-12450H (8 cores / 12 threads = 4 P-cores with HT + 4 E-cores)** in an HP Victus laptop, the
   active power scheme is an OEM "Performance Mode", and this diagnostic runs **unpinned** — while the
   frozen historical campaign pinned to a single logical CPU. Thread migration across heterogeneous
   P/E cores, plus power-state changes, predicts every feature observed: ~2× discrete intra-block jumps,
   block-level regime shifts, and a tail that is uniform in iteration position.

The frozen verdict is unchanged: **calibration FAIL** (8.5506 % / 109.0882 % / 2.1161 %).

---

## 1. Recorded state (step 1)

Recorded before any investigation, in `phase18_analysis/00_state_before.txt`.

| item | value |
|---|---|
| branch / HEAD | `main` / `f8b1d135b9043930a61ed1493b87fbf95115b70d` ("1") |
| B7 CSV (subject) | `818bf1a541b8115f2393a3da2b912eb3757b7f187199d5e9b60beca4e167998f` |
| historical CSV | `d0fca204c9443ef2d0113c12884dfc0fbfc1d64f08c3903f89c98c0c4bf5163a` |
| `bm_b7_diagnostic.cpp` | `aeb31eb2250d05e66a805597624db62f7d66090c7e9b5140b38f9c6f5955ca2b` |
| `BenchmarkHarness.cpp` | `1b37e95f0cc47568839727bc0ef8836397f705255b47fe85ebe4b988867b4414` |
| `TinyDenseModel.cpp` | `d458e4c9cd8c14bdf340452aa46200c4c0e357989e7cdb536b6bee77eb99f099` |
| `CMakeLists.txt` | `575fe264921512f41d30267c1c659e3662bbcfd92e71623720f9d047b7dddcc8` |
| new exe (subject of the run) | `86ee9f3ee2c1daac8f2815be4516e2ea03fd19273166978cbf09e6d69ca09d88` |
| old exe | `a2e9e0ada6df0f10a91681e96349349166a081dcca0570312c6d175ad0691bd6` |
| phase17 report | `e7f42b36b5e8220a120fbbc98ba2b5b911bd658b501c1e4ab42dd648900b3789` |
| phase16 report | `e4bda22f0870124f6d182e678603fd30feaf1653c6eb95aa440ef68e8aa85c35` |
| run stdout / exec_meta | `33f7b52f…` / `77e2d496…` |
| `G7.json` / `m0_acceptance_matrix.json` / `source_change_manifest.json` | `9e090fda…` / `869ea3fc…` / `533f01eb…` (all MATCH) |

All previously recorded hashes are unchanged. Git status showed only the pre-existing untracked `stark/nul`
and this phase's new `phase18_analysis/` directory. For the record, HEAD has advanced twice between phases
(`f2f910e`, then `f8b1d13`) through commits made by another actor, which swept the Phase-16/17 artifacts into
version control. This phase made no commit.

---

## 2. Timing implementation and execution order (step 2)

All references are to `stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp`.

### 2.1 Is the condition order fixed? — **No. Directly established.**

`build_schedule()` (lines 686–692):

```cpp
for (uint32_t i = 0; i < replicates; ++i)
    s.push_back(ScheduleEntry{i, (i % 2u) == 0u});   // even index => MINIMAL first
```

The main loop (lines 1346–1365) builds `first`/`second` from `entry.minimal_first` and calls
`run_replicate(first, …)` then `run_replicate(second, …)`. So the order is **counterbalanced**: replicates
0/2/4 run MINIMAL-then-INSTRUMENTED, replicates 1/3/5 run INSTRUMENTED-then-MINIMAL. The executed order is
recorded verbatim in `rep.executed_order` and printed in the run stdout, which matches.

Consequence: **position-within-replicate is already balanced across the run**, so "add order balancing" is
*not* a missing control — it is present. A position effect and an elapsed-time effect are nonetheless not
separated by this design with only 6 replicates (see §4.3).

### 2.2 Scope of each timed interval, and is the work identical? — **Identical work. Directly established.**

`run_replicate()` (lines 626–637) brackets every measured iteration with one outer clock pair:

```cpp
const auto tA = Clock::now();                 // line 630
if (mode == Mode::INSTRUMENTED) instrumented_op(blob_path, loader, comp);   // 633
else                            minimal_op(blob_path, loader);               // 635
const auto tB = Clock::now();                 // 636
total_sec = duration<double>(tB - tA);        // 637
```

`minimal_op()` (lines 474–484) and `instrumented_op()` (lines 486–506) execute the **same statement
sequence** — `ifstream` open, `if (!f) throw`, the `istreambuf_iterator` range-construction of a
`std::vector<uint8_t>`, then `loader.deserializeWeights(bytes)`. `instrumented_op` adds only
`t0..t3 = Clock::now()` at three stage boundaries plus three `duration<double>` conversions.
`Clock` = `steady_clock` (line 148).

Therefore the instrumentation delta is **four clock reads**, bounded at ≈ 4 µs even at a pessimistic
1 µs/read on a ≈ 15 500 µs interval — **≈ 0.026 %**, about 300× below the observed 8.5506 %.

### 2.3 Does the reported iteration index reflect actual execution order? — **Yes. Directly established.**

`run_replicate` pushes samples in loop order (`r.total_samples_sec.push_back(total_sec)`, line 648) inside
`for (uint32_t i = 0; i < proto.measurement_count; ++i)` (line 626). The CSV writer emits
`minimal[i].index` as `replicate` and the inner loop counter `j` as `iteration`. So `iteration` is the
**position in that condition's 50-sample measured loop**, i.e. its true execution order within the block.
It does **not** encode a global run position — which is exactly the gap that matters (§2.7).

### 2.4 How replicates are initialised and separated — **fresh loader; no other separation.**

`run_replicate` constructs `TinyDenseModel loader(1);` at line 605, commented *"constructed outside all
timed regions"* — so the model's weight buffers are allocated per replicate, outside the timer. Each
replicate then reserves its result vectors (lines 622–624). There is **no** other separation: replicates run
sequentially **in the same process**, back-to-back, sharing the allocator state, the OS page cache, and the
CPU's power/thermal state. Each replicate inherits whatever regime the previous one left behind.

### 2.5 Setup, reads, allocation, page faults, cache effects, timer calls, cleanup — inside or outside?

| activity | inside the timed interval? | evidence |
|---|---|---|
| `ifstream` open (handle + create/destroy of the stream buffer) | **inside** | between `tA` and `tB`; `open_sec` measures it (≈ 264–282 µs pooled) |
| file read + `std::vector<uint8_t>` growth from `istreambuf_iterator` | **inside** — dominant cost | `read_sec` ≈ 15 180 µs pooled ≈ 95 % of total |
| **allocation**: vector growth (repeated `realloc` + copy, amortised doubling) | **inside** — the only allocation | range-ctor from an input iterator cannot pre-size |
| **page faults** from newly committed heap pages | **inside** (a consequence of the above) | not separately measured |
| `deserializeWeights` | **inside**, but **allocation-free** | `TinyDenseModel.cpp` lines 108–122: four `memcpy` into pre-sized `w1_/b1_/w2_/b2_`; ≈ 139 µs |
| vector + stream **destruction** (free ~1 MB, close handle) | **inside** | locals of the op; destructors run before `tB` |
| the four `Clock::now()` calls (INSTRUMENTED only) | **inside** | lines 492–500 |
| **10 untimed warm-ups** | outside (per block) | lines 608–615, before the measured loop |
| `TinyDenseModel loader` construction | outside | line 605 |
| **blob write** | outside all replicates | `create_run_owned_blob` called once (line 1334) before the schedule loop (line 1346) |
| run-dir creation, `TinyDenseModel writer(1)`, `serializeWeights` | outside | lines 338–399 |
| host-CSV write, cleanup (blob + run-dir removal) | outside (after all replicates) | lines 1373, cleanup in `BlobCleanup::perform` |
| **logging / synchronisation inside an interval** | **none** | no logging API in either op; single-threaded |
| **CPU affinity / priority control** | **none anywhere** | no `SetProcessAffinityMask`/`SetThreadAffinityMask`/`SetPriorityClass` in the file |

**A new code-level finding:** the blob write path has **no durability call**. `write_all_fd` (lines
297–311) writes in ≤1 MiB chunks with `_write`, then `_close(fd)` (line 397). The only `_commit`/`fsync` in
the entire file is at lines 1239/1241, inside `PairedArtifact::write()` for the **host CSV**, not the blob.
So ≈ 1 MB of dirty pages are handed to the OS for asynchronous writeback that may overlap the earliest
replicates.

### 2.6 Is the output sufficient to distinguish these effects? — **No.**

The CSV records only `replicate, iteration, minimal_sec, instrumented_sec, signed_overhead_pct`. It carries
**no timestamps, no global sequence index, no CPU/core or frequency/thermal data, no per-component per-pair
timing** (the `open/read/deserialize/residual` breakdown exists only as pooled summaries in the stdout), and
**no memory or page-fault counters**. Any statement about *when* a sample ran, *which core* executed it, or
*what clock* it ran at is therefore inference from ordering, not observation. This is the binding
limitation of the whole phase and is carried into §6.

### 2.7 Fidelity to the production/campaign path

`BenchmarkHarness.cpp` `bench_model_load_time()` (lines 297–316) runs the **byte-identical** statement
sequence, tagged `{"blob_bytes", …}, {"mode", "warm_cache"}`. The heavy iterator-driven read is production
behaviour, not a diagnostic artifact. **One methodological divergence from the campaign is material:** the
frozen campaign pinned execution to a single logical CPU
(`G7CAM-B7-E5-11933807.json` → `provenance.affinity`: `raw_system_mask: 4095`,
`effective_logical_cpus: [0]`, `requested_cpu: 0`, `set_ok: true`, `verified_single_cpu: true`), whereas
this diagnostic explicitly claims no affinity control and contains none.

---

## 3. Recomputed results (step 3)

`phase18_analysis/trajectory_tail.py` → `01_trajectory_tail.json` / `01_trajectory_tail_report.txt`.
Frozen formulas reproduced verbatim; the CSV was opened read-only.

### 3.1 Frozen metrics still reproduce exactly — and still FAIL

| metric | recomputed | reported | thresholds | verdict |
|---|---|---|---|---|
| `mean_overhead_pct` | 8.5506 | 8.5506 | ≤ 2.0 | **NOT OK** |
| `worst_case_overhead_pct` | 109.0882 | 109.0882 | ≤ 10.0 | **NOT OK** |
| `median_deviation_pct` | 2.1161 | 2.1161 | ≤ 2.0 | **NOT OK** |

`calibrate()` computes them at lines 767 / 798 / 812 of the source, compared at lines 816–818 against the
unchanged constants 2.0 / 10.0 / 2.0 (lines 157–159). **No formula or threshold was touched.**

### 3.2 Timing trajectory — 12 blocks, deciles (µs), execution order

| # | block | pos | median | D1 | D2 | D3 | D4 | D5 | slope |
|---|---|---|---|---|---|---|---|---|---|
| 0 | rep0_MINIMAL | 1 | 11559 | 11223 | 11261 | 12608 | 11001 | **15614** | +82.7 |
| 1 | rep0_INSTRUMENTED | 2 | 15559 | 14844 | 17651 | 16459 | 15305 | 14213 | −34.6 |
| 2 | rep1_INSTRUMENTED | 1 | 14226 | 15146 | **12637** | **11051** | 15452 | 15077 | +34.6 |
| 3 | rep1_MINIMAL | 2 | 13002 | 12105 | **10811** | **11261** | 15359 | **16244** | +121.8 |
| 4 | rep2_MINIMAL | 1 | 15524 | 16057 | 15938 | 15591 | 15643 | 15160 | −21.4 |
| 5 | rep2_INSTRUMENTED | 2 | 17634 | 15666 | 15732 | **21423** | **21652** | 18398 | +113.1 |
| 6 | rep3_INSTRUMENTED | 1 | 15941 | 17100 | 16153 | 15878 | 15804 | 16156 | −23.7 |
| 7 | rep3_MINIMAL | 2 | 15788 | 16141 | 15654 | 15890 | 15934 | 15668 | −6.1 |
| 8 | rep4_MINIMAL | 1 | 15969 | 15958 | 16207 | 15903 | 16178 | 15618 | −6.7 |
| 9 | rep4_INSTRUMENTED | 2 | 15995 | 16147 | 16046 | 16033 | 16119 | 15714 | −8.2 |
| 10 | rep5_INSTRUMENTED | 1 | 15655 | 16542 | 15846 | 15633 | 15516 | 15331 | −27.8 |
| 11 | rep5_MINIMAL | 2 | 15490 | 15566 | 15591 | 15351 | 15818 | 15502 | −1.7 |

Blocks 6–11 (replicates 3–5) are stable: deciles vary by only a few percent. The large deviations are
confined to blocks 0–5.

### 3.3 The deviations are step/bimodal, not smooth ramps — **directly established**

Per-iteration series of the four deviant blocks (`02_regime_and_start_effects_report.txt`):

- **rep0_MINIMAL** — `min 9312, max 18986` → **max/min = 2.04×**. Values oscillate between ≈ 9.3 k and
  ≈ 19 k throughout all 50 iterations; the last decile (13924, 12747, 17028, 16449, 18021, 18986, 10898,
  14937, 17397, 15752) happens to sit high while D4 (≈ 11 000) is the *lowest* decile. Not a ramp.
- **rep1_MINIMAL** — `min 9391, max 20550` → **2.19×**. Sits at ≈ 16 k for iterations 0–2, drops to
  ≈ 9.5–10.2 k for iterations 3–29, then jumps to ≈ 15–20.6 k from iteration 30 onward. A **bimodal
  regime change at iteration ≈ 30**, not a drift.
- **rep1_INSTRUMENTED** — `min 9502, max 19980` → **2.10×**. Oscillates across the whole loop with no
  single regime; the largest single step (−6194 µs at iteration 48) is **89.6×** the net
  first-10-vs-last-10 change (−69 µs). The "ramp" statistic is meaningless for this block.
- **rep2_INSTRUMENTED** — `min 14832, max 31876` → **2.15×**. Steady at ≈ 15.2 k for iterations 0–18,
  then a sustained ≈ 21–22 k regime for iterations 19–39 (peak **31 876 µs** at iteration 37), then mixed.

Across these blocks the largest single-iteration step is 1.31×–89.6× the net decile change. **The early
"ramps" reported in Phase 17 are therefore a decile-binning artifact; the underlying process is a
step/multimodal one with ≈ 2× amplitude.**

### 3.4 The >10 % tail is uniform in iteration position — **directly established**

| subset | slots | >10 % | base rate | iterations 0–1 rate | enrichment |
|---|---|---|---|---|---|
| all 12 blocks | 300 | 96 | 32.00 % | 20.83 % (5/24) | **0.65×** |
| replicates 0–2 | 150 | 82 | 54.67 % | 16.67 % (2/12) | **0.30×** |
| replicates 3–5 | 150 | 14 | 9.33 % | 25.00 % (3/12) | 2.68× (n=3) |

Iteration indices of all 96 >10 % pairs: **median 24.5** (uniform expectation 24.5), mean 23.4, Q1 = 12,
Q3 = 34; decile counts `[20, 20, 23, 18, 15]` against a uniform expectation of 19.2.

Interpretation: the tail is **stationary in iteration position**, and at block starts it is
*under*-represented, not over-represented. The replicates 3–5 figure rests on 3 pairs out of 12 slots and
is not evidence of an effect. **A per-block warm-up deficit is not supported** — the first iterations of
each measured block are the *cleanest*.

### 3.5 Negative pairs

106 of 300 pairs are negative (instrumented *faster* than its minimal partner) — replicate distribution
`{0:10, 1:22, 2:12, 3:19, 4:21, 5:22}`, decile distribution `[19, 20, 18, 23, 26]` — again **uniform in
iteration position**. Most negative: rep1 iter41 `19050 → 9678 µs` (**−49.199 %**), rep1 iter21
`−36.038 %`, rep0 iter45 `−33.779 %`, rep1 iter42 `−30.526 %`, rep1 iter22 `−25.714 %`. These are
impossible as instrumentation cost: the interval with *more* code ran in half the time.

### 3.6 Residual tail in replicates 3–5 — the part warm-up cannot explain

14 pairs exceed 10 % in the already-settled regime; max **25.573 %**; by replicate `{3:6, 4:1, 5:7}`;
iteration range **0–49**.

| rep | iter | minimal µs | instrumented µs | overhead % |
|---|---|---|---|---|
| 3 | 1 | 16130.1 | 20255.0 | 25.573 |
| 3 | 0 | 15794.9 | 19614.7 | 24.184 |
| 5 | 1 | 15799.2 | 18426.7 | 16.631 |
| 5 | 7 | 15173.3 | 17554.7 | 15.695 |
| 5 | 44 | 14633.6 | 16610.9 | 13.512 |
| 5 | 28 | 14545.7 | 16369.0 | 12.535 |
| 3 | 49 | 15036.9 | 16839.0 | 11.985 |
| 3 | 18 | 15864.8 | 17760.1 | 11.947 |
| 5 | 14 | 15773.3 | 17635.3 | 11.805 |
| 5 | 5 | 15092.5 | 16778.1 | 11.168 |
| 3 | 41 | 14919.7 | 16549.2 | 10.922 |
| 5 | 12 | 15255.7 | 16842.0 | 10.398 |
| 4 | 25 | 15162.6 | 16721.8 | 10.283 |
| 3 | 20 | 15365.3 | 16939.6 | 10.246 |

Three of the top four sit at iterations 0–1, but the remaining eleven span iterations 5–49, so no single
region dominates. Worst pair overall remains **rep0 iter28, 109.0882 %** (`9801.7 → 20494.2 µs`); top three
are 109.0882 / 105.9879 / 97.5745 — and the third (97.57 %) is also replicate 0.

---

## 4. Plausible explanations, with explicit confidence (step 4)

### 4.1 Directly established by code or data

1. Condition order is **counterbalanced**, not fixed (source §2.1); position is already balanced.
2. `iteration` is the **within-block execution order** of that condition's measured loop (source §2.3).
3. Both conditions execute **identical work**; the only delta is four `steady_clock::now()` calls
   (source §2.2), bounded at ≈ 0.026 %.
4. The blob is written **once before** the replicate loop, and its write path has **no `_commit`/`fsync`**
   (source §2.5). Run-dir creation, deserialize, and cleanup involve no allocation inside the interval;
   the vector growth is the only allocation and it is inside.
5. The process has **no affinity or priority control** anywhere (source §2.5).
6. Intra-block range is **2.04–2.19×** in the deviant blocks; the "ramps" are step/bimodal, with the
   largest single step 1.3×–90× the net decile change (data §3.3).
7. The >10 % tail and the negative pairs are **uniform in iteration position**; block-start enrichment is
   **0.30–0.65×** for the bulk subsets (data §3.4, §3.5).
8. The machine is a **hybrid** i5-12450H, 8 cores / 12 threads, on an HP Victus laptop, with an OEM
   "Performance Mode" power scheme active and the unit on AC (`phase18_analysis/03_environment_probe.txt`).
9. The frozen campaign pinned execution to one logical CPU; this diagnostic does not (source §2.7).

### 4.2 Supported but not proven

**H-migration (leading): heterogeneous-core scheduling / power-state changes.**
An unpinned thread on a 4P+4E hybrid laptop is free to migrate between P-cores (≈ turbo, high IPC) and
E-cores (substantially slower), and to be affected by package power limits and the OEM power scheme. This
single mechanism predicts *all* the established features: discrete ≈2× jumps (§3.3), block-level regime
shifts that come and go (§3.3), and a tail that is **uniform in iteration position and sparse in time**
(§3.4, §3.5) because migration is a stochastic external event rather than a function of loop position.
*Why not proven:* there is no per-sample core, frequency, or timestamp data; the CSV cannot distinguish
migration from thermal drift, cache contention, or another process. The 2.04–2.19× amplitude is at the
upper end of a typical P/E ratio, so the mechanism is plausible rather than certain.

**H-regime (supporting): the first ~2–3 replicates ran in a different machine regime.**
MINIMAL block medians are 11 559 / 13 002 / 15 524 / 15 788 / 15 969 / 15 490 µs — the first two are
≈ 25–28 % faster than the settled ≈ 15.5–16.0 k. Because condition **position is balanced** across
replicates, a decay of the gap with *replicate index* is evidence for an **elapsed-time / global-state**
effect rather than a fixed positional one. *Why not proven:* positional and temporal effects remain
partially confounded with 6 replicates, and no environmental series exists.

**H-cache (candidate, and partly contradicted by the data).**
The blob is written once and then read **720 times** (6 replicates × 2 conditions × (10 warm-ups + 50
measured)), so its pages should be OS-page-cache resident for essentially the whole run and the reads
should be cache hits rather than disk traffic. What does vary is the *working set*: each iteration
reallocates and copies a 1–2 MB byte vector, so L2/L3 pressure and allocator free-list state change from
iteration to iteration and carry over between blocks. Two observations bear on this. (i) **Within-replicate
cache inheritance predicts the wrong sign:** if the first condition in a replicate warmed the cache for the
second, the second should be *faster*; the paired position data show the opposite — both conditions are
slower when run second (MINIMAL +2.85 %, INSTRUMENTED +7.35 %; Phase 17 §2.9). So plain per-replicate cache warming does
**not** explain the positional asymmetry. (ii) Cache *capacity* effects (L3 contention when the thread
migrates, allocator free-list reuse) remain consistent with the ≈2× steps and cannot be ruled out.
*Why unresolved:* the CSV records no cache, memory, page-fault, or allocator counters, and the shape of the
tail (uniform in iteration position) fits an external event better than a monotone cache-fill curve.

**H-writeback (minor, plausible): the un-synced ≈1 MB blob write.**
Dirty pages left for asynchronous writeback could contend with the earliest reads, giving a decaying
early-run effect. *Why not proven:* the blob was just written, so reads should be cache hits; no I/O
counters were captured; and it cannot explain the intra-block 2× steps in later replicates.

**H-per-block warm-up (revised to: not supported for the tail).**
Phase 17 proposed insufficient warm-up (only 10 untimed iterations per block, no discarded warm-up
replicate). The data contradict this for the tail: iterations 0–1 exceed 10 % at 0.65× the base rate,
not above it. It remains *possible* that the very first **replicate** needed more warming than a block
warm-up can provide — that part is untested, not refuted.

### 4.3 Unknown because the CSV lacks the necessary observations

- Whether the ≈2× steps coincide with **core migration**, **frequency change**, or **power-limit**
  events — no core/frequency/thermal telemetry exists, and samples carry no timestamps.
- Whether the regime shifts are **temporal** (clock time) or **ordinal** (batch index) — the CSV has no
  timestamp, so "which happened when in wall-clock terms" is unknowable.
- Whether the tail is **reproducible** at all — a single authorized run cannot separate a reproducible
  property from a one-off. This is the single largest gap.
- Whether **page-fault or allocator** behaviour contributes — no memory counters.
- What share of the tail lives in `open` vs `read` vs `deserialize` **pair-by-pair** — the component
  breakdown is pooled-only in the stdout.

---

## 5. Is the proposed discarded warm-up replicate sufficient? (step 5)

**Assessment: necessary as a component, but not sufficient on its own to test the leading hypothesis.**

Reasons, in order of weight:

1. **It cannot address the worst-case failure at all.** The residual tail occurs in replicates 3–5 — the
   *already-warmed* part of the run — with 14 pairs above 10 % and a max of 25.57 %. A discarded warm-up
   replicate precedes replicate 0 and therefore cannot move a metric that still fails after the transient
   has decayed. Phase 17 already showed this: on replicates 3–5 the mean is 1.28 % and the median
   deviation 0.89 % (both inside threshold) while the worst case is 25.57 % (outside).
2. **It cannot separate warm-up from elapsed time.** Adding pre-work is, operationally, just running the
   measurement later. Since the supported mechanism is a *global* state effect, a warm-up replicate would
   likely "work" while leaving the cause unidentified — the same confound, now hidden.
3. **It adds no observations.** By design it changes only how much untimed work precedes replicate 0. The
   binding limitation established in §2.6 is that the output carries no timestamps, no core/frequency data,
   and no per-component per-pair timing. A warm-up replicate does not reduce that limitation.
4. **Execution-order balancing is not the missing control — it is already implemented** (§2.1). The
   counterbalanced schedule gives each condition 3 blocks in each position. What is missing is not
   balancing but **repetition** and **environmental control/telemetry**.

**Conclusion.** A discarded warm-up replicate is a reasonable cheap probe for the mean/median part of the
failure, and it is worth including as one arm. But it is **not sufficient** to test the leading hypothesis,
and the task's own framing — "distinguish repeatable instrumentation overhead from timing noise or a setup
issue" — requires (a) **repetition**, because "repeatable" cannot be assessed from one run, and (b)
**control of the execution environment**, because the supported mechanism is environmental. A separate
timing-control experiment is necessary.

---

## 6. Recommended next experiment (step 6) — **NOT EXECUTED**

### 6.1 Hypothesis

**H-migration:** the ≈2× intra-block steps, the block-level regime shifts, and the iteration-uniform tail
are caused by **uncontrolled processor scheduling on a heterogeneous (P-core/E-core) CPU** — thread
migration and/or power-state changes — rather than by instrumentation, which is bounded at ≈ 0.026 % by the
source. If H-migration holds, **pinning the process to a single logical CPU** (the methodology the frozen
campaign already used) will collapse the intra-block range, remove the block-level regime shifts, and
reduce the tail — including the residual 25.57 %.

**Explicitly not claimed:** that pinning will make all three frozen thresholds pass. The mean/median part
of the failure may also have a genuine warm-up component; that is H-regime, tested by the second arm below.

### 6.2 Controlled variables (must be identical)

Same binary (`86ee9f3e…`, verified by hash before launch each time), same argv
(`build/bm_b7_diagnostic --host-capture-dir <fresh dir>`), same cwd (`E:\My Local AI`), same protocol
(10 untimed warm-ups, 50 measured, 6 replicates, counterbalanced), same isolation rules, same CSV format,
and the **same frozen thresholds (2 / 10 / 2) and formulas** applied per run. Same machine, same power
scheme, on AC. Each run writes to a **new** host-capture directory (exclusive creation forbids reuse).

### 6.3 The single variable changed

**Processor affinity: pinned to one logical CPU vs unpinned.** Nothing else changes. This is the single
known methodological divergence between this diagnostic and the frozen campaign (§2.7), and it is the
direct lever on the leading hypothesis.

### 6.4 Number of runs needed

**Six runs: 3 unpinned and 3 pinned, alternating** (unpinned, pinned, ×3) to cancel slow drift.
Justification: "repeatable" is a property of a *distribution*, so one run per arm cannot decide anything.
With n = 3 per arm the arm-level medians can be compared against the within-arm spread; with n = 2 they
cannot. Each run takes ≈ 11 s of measurement, so the total measurement cost is ≈ 70 s plus setup, which is
small relative to a decisive answer. If only one run per arm is authorised, the experiment should be
reported as exploratory and not as a test of H-migration.

**Per-run analysis (do not pool runs, do not change thresholds):** apply the frozen three metrics to each
run's own 300 pairs, then compare the six values. Add, as *descriptive* outputs only: the intra-block
max/min ratio, the decile table, and the >10 % count.

### 6.5 Observations that would confirm or weaken H-migration

| observation | interpretation |
|---|---|
| Pinned runs show intra-block max/min ≈ 1.0–1.1× (vs 2.0–2.2×), no block-level regime shifts, and lower >10 % counts, consistently across all 3 pinned runs | **H-migration supported** — the variance source is scheduling. Next question becomes whether the frozen worst-case is even *reachable* on this hardware, which would be a measurement-design discussion, not a code fix. |
| Pinned runs still show ≈2× steps and a comparable tail | **H-migration weakened** — the variance source is intrinsic to the workload (allocator/page-fault/GC-like behaviour). The follow-up would be a read-path experiment isolating the `istreambuf_iterator` growth against a pre-sized read. |
| Pinned and unpinned runs are statistically indistinguishable, and the six runs scatter widely | Neither mechanism dominant; the measurement is simply noise-dominated at this protocol size. That would raise a **design** question (more replication or a different statistic), which would require authorization because it touches the frozen acceptance criteria. |
| The mean/median elevation persists in pinned runs only | H-regime remains live and a warm-up component is indicated — then the discarded warm-up replicate (§5) becomes the right second arm. |
| Pinned runs are *slower* overall but much more stable | Expected and still supportive: pinning trades peak throughput for determinism, which is exactly what the campaign did. |

### 6.6 Cheaper read-only controls to do first (no run, no source change)

1. **Report the environment per run** — active power scheme, AC/battery state, and the logical-CPU count —
   so any future run is anchored to a described machine state. §4's biggest gap is missing telemetry.
2. **Compute the same trajectory/decile/tail statistics automatically** for each future CSV, so the
   intra-block range and iteration-uniformity tests are produced every time rather than inferred.
3. If a future authorization permits an **output-only** change, add a per-sample sequence number and a
   `steady_clock` timestamp to the CSV. That alone would make §4.3 testable without altering any measured
   value, threshold, or formula.

---

## 7. Limitations

1. **One run.** No run-to-run variability can be estimated; "repeatable" is untestable from this data. This
   is the largest limitation and the main reason the experiment in §6 needs repetition.
2. **No environmental telemetry.** No frequency, thermal, core-placement, power-state, or I/O counters
   were captured during the run; the topology and power scheme in §4.1(8) were read *afterwards* and are
   therefore context, not run-time state.
3. **No timestamps or sequence index.** Wall-clock alignment of regime shifts is unknowable; the 12-block
   execution order is reconstructed from the documented schedule (`build_schedule`, counterbalanced),
   not observed.
4. **The component breakdown is pooled-only.** `open/read/deserialize/residual` cannot be attributed
   pair-by-pair, so the residual tail cannot be assigned to a specific stage from the CSV.
5. **The "ramp" statistics are unstable.** Decile means change materially depending on binning because the
   process is step-like; the per-iteration series in §3.3 is the honest representation, and Phase 17's
   smooth-ramp wording is superseded.
6. **Small-n tail conclusions.** The replicates 3–5 enrichment figure rests on 3 pairs; it is reported as
   not-evidence. No outlier was removed and no substitute statistic replaced the frozen metrics anywhere.
7. **MSVC vs GCC remains an unquantified confound** for absolute magnitudes (carried over from Phase 17):
   the paired comparison is internally valid, but absolute times are not comparable to the GCC campaign.

---

## 8. Status

| dimension | verdict |
|---|---|
| Diagnostic execution | **PASS** (unchanged from Phase 16; not re-run here) |
| CSV integrity | **PASS** (unchanged; metrics reproduce exactly) |
| Calibration | **FAIL** (8.5506 % / 109.0882 % / 2.1161 % vs 2 / 10 / 2) |
| Root cause — mean/median failure | **SUPPORTED**: an early-run machine-regime difference; mean 1.28 % and median deviation 0.89 % on replicates 3–5 |
| Root cause — worst-case tail | **PARTIALLY SUPPORTED**: stationary, iteration-uniform, ≈2×-amplitude steps consistent with heterogeneous-core scheduling; mechanism not yet proven |
| Phase 17 "smooth ramp" and "insufficient per-block warm-up" | **REVISED / NOT SUPPORTED** for the tail; superseded by §3.3–§3.4 |

No diagnostic run, no source or executable change, no threshold change, no new CSV, no commit.
