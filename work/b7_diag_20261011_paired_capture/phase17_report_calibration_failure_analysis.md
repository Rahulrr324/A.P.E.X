# Phase 17 — Explaining the B7 Calibration Failure

**status:** analysis complete. No diagnostic execution, no source/exe/CSV/manifest/threshold change,
nothing staged, committed, pushed, or cleaned.
**date_utc:** 2026-10-14
**subject:** `work/b7_diag_20261011_paired_capture/run2/paired_samples.csv`
(sha256 `818bf1a541b8115f2393a3da2b912eb3757b7f187199d5e9b60beca4e167998f`, 12766 bytes, 300 data rows)
**repo:** `E:\My Local AI`, branch `main`, HEAD `f2f910e`.

---

## 0. Headline

The frozen calibration **FAILs**, and that result stands unchanged. The evidence shows the failure is
**not caused by the instrumentation the diagnostic is supposed to measure**: at the code level the
instrumented and minimal conditions execute *identical work* and differ only by four `steady_clock::now()`
calls, worth roughly **0.001 %** of the measured interval — about four orders of magnitude less than the
observed 8.5506 %. The gap between the two conditions is instead dominated by a **time-varying machine
state at the start of the run** (clearly visible as a *monotonic rise within a single 50-iteration block*)
plus a heavy-tailed per-iteration distribution.

**Root cause of the calibration failure: partially supported.** The dominant contributor is identified and
its signature is proven from the data shape; the residual tail that keeps `worst_case_overhead_pct` above
10 % is not yet attributed.

---

## 1. Evidence preservation

Hashes recorded **before** analysis (`phase17_analysis/00_evidence_hashes_before_analysis.txt`). No
analysed artifact was written to.

| artifact | sha256 |
|---|---|
| **new CSV** (subject) | `818bf1a541b8115f2393a3da2b912eb3757b7f187199d5e9b60beca4e167998f` |
| historical CSV `build/bm_b7_diagnostic/run_1791799501127597800_0/paired_samples.csv` | `d0fca204c9443ef2d0113c12884dfc0fbfc1d64f08c3903f89c98c0c4bf5163a` |
| source `bm_b7_diagnostic.cpp` | `aeb31eb2250d05e66a805597624db62f7d66090c7e9b5140b38f9c6f5955ca2b` |
| `stark/CMakeLists.txt` | `575fe264921512f41d30267c1c659e3662bbcfd92e71623720f9d047b7dddcc8` |
| new exe (this run) | `86ee9f3ee2c1daac8f2815be4516e2ea03fd19273166978cbf09e6d69ca09d88` |
| old exe | `a2e9e0ada6df0f10a91681e96349349166a081dcca0570312c6d175ad0691bd6` |
| run stdout | `33f7b52f74b948d8a9e54794b3419b9d11ecb6bac66d85eeb1b18c6186d419d6` |
| run stderr (empty) | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `gate_results/G7.json` | `9e090fda4e42ad342a11606060a602d1f4d9211539b3cd1e0e2898a192c77c50` |
| `m0_acceptance_matrix.json` | `869ea3fc620567bdb6a2a04deb0359d6e427c55d66f3bbb80aaae6a5504bc795` |
| `source_change_manifest.json` | `533f01ebbea8bc32c69007a22fe945dff3cb52e9cd5440011121f010240c8aa2` |
| phase16 report | `e4bda22f0870124f6d182e678603fd30feaf1653c6eb95aa440ef68e8aa85c35` |

All match their previously recorded values. Note for the record: between Phase 16 and Phase 17 an
outside commit `f2f910e` ("some chnages") was added by another actor, which committed the build
directories, the Phase-16 evidence, and `run2/paired_samples.csv`. HEAD therefore moved from `1b7616f`
to `f2f910e`. This phase made no commit and no working-tree change to any tracked file.

---

## 2. Independently recomputed metrics (from the CSV alone)

`phase17_analysis/analyze.py` → `01_recomputed_metrics.json`, `01_recomputation_report.txt`.
Computed from the file bytes; the diagnostic's own stdout numbers were used only as a cross-check.

### 2.1 The three frozen metrics — reproduced exactly

| metric | formula (verbatim from source) | recomputed | diagnostic stdout | limit |
|---|---|---|---|---|
| `mean_overhead_pct` | `100*(meanB − meanA)/meanA` | **8.5506** | 8.5506 | ≤ 2.0 |
| `worst_case_overhead_pct` | `max_j 100*(B_j − A_j)/A_j` | **109.0882** | 109.0882 | ≤ 10.0 |
| `median_deviation_pct` | `100*|medianB − medianA|/medianA` | **2.1161** | 2.1161 | ≤ 2.0 |

Pooled values: mean minimal `14761.781 us`, mean instrumented `16024.001 us`; median minimal
`15469.850 us`, median instrumented `15797.200 us`. All four reproduce the report exactly. The single
worst pair is **replicate 0, iteration 28**: `9801.700 → 20494.200 us`, `+109.0882 %`.

### 2.2 Integrity / anomaly scan — **0 real anomalies**

| check | result |
|---|---|
| malformed rows / wrong field count | 0 |
| non-finite values | 0 |
| zero minimal or instrumented time | 0 |
| negative times | 0 |
| duplicate `(replicate, iteration)` keys | 0 (300 unique of an exact `{0..5}×{0..49}` set) |
| exact duplicate data rows | 0 |
| out-of-range replicate / iteration | 0 |
| per-row formula inconsistencies | **0** (see below) |
| parse / line structure | 300 data rows + header, LF endings, 12766 bytes |

**On the formula check.** A first pass with a `1e-9` relative tolerance flagged 89 rows. Those are
**not defects**: the CSV serialises with `"%#.9g"` (9 significant digits), so `100*(b−a)/a` recomputed
from the *stored* rounded fields cannot reproduce the value the diagnostic computed from full-precision
doubles. The observed deviations are **max 3.97e-07 percentage points (max relative 4.7e-09)** — purely
floating-point serialisation rounding. With the tolerance set to `1e-6` relative (≈100× above the
observed deviation, still ≈4 orders of magnitude tighter than any real defect) there are zero violations.
The data is formula-consistent to serialisation precision. **No zero, negative, non-finite, duplicate,
malformed, or formula-inconsistent sample exists.**

### 2.3 Formula contrast — why the three metrics disagree so strongly

The three frozen metrics are *different statistics on different scales*, and the data separates them
sharply:

| statistic | value (%) | what it is |
|---|---|---|
| `mean_overhead_pct` (FROZEN) | 8.5506 | **ratio of means**: `100*(meanB−meanA)/meanA` |
| mean of the 300 pair ratios | 10.9510 | mean of `100*(B_j−A_j)/A_j` |
| `median_deviation_pct` (FROZEN) | 2.1161 | **ratio of medians**: `100*|medianB−medianA|/medianA` |
| median of the 300 pair ratios | 2.9823 | median of `100*(B_j−A_j)/A_j` |
| trimmed mean of pair ratios (drop 1 each end) | 10.8235 | outlier-insensitive mean of ratios |
| `worst_case_overhead_pct` (FROZEN) | 109.0882 | **single most extreme pair**, signed, unclamped |

Two things follow. First, ratio-of-means (8.55) and mean-of-ratios (10.95) differ because they are
genuinely different functionals (Jensen's inequality); likewise ratio-of-medians (2.12) ≠ median-of-ratios
(2.98). The diagnostic uses ratio-of-means and ratio-of-medians — that is a design choice, not an error,
and it is unchanged here. Second, the **mean-type statistics sit at ~9–11 % while the median-type
statistics sit at ~2–3 %**: the distribution is strongly right-skewed, so the mean is dragged up by the
tail while the median is not.

### 2.4 Distribution of the 300 per-pair signed overheads (%)

| min | p1 | p5 | p10 | Q1 | median | Q3 | p90 | p95 | p99 | max |
|---|---|---|---|---|---|---|---|---|---|---|
| −49.199 | −30.559 | −14.117 | −7.538 | −2.780 | 2.982 | 17.670 | 45.151 | 60.247 | 96.934 | 109.088 |

mean 10.951, stdev **24.161**, IQR **20.450**. Counts: **106 negative**, 0 exactly zero, 194 positive;
164 pairs > 2 %; **96 pairs > 10 %**; 25 pairs > 50 %.

A standard deviation of 24 percentage points against a central tendency of ~3 % means the
**per-iteration paired measurement is noise-dominated**. The most negative pair is −49.199 %
(replicate 1, iteration 41: `19050.4 → 9677.8 us`) — the minimal condition took nearly twice as long as
its instrumented partner. That cannot be instrumentation cost; the same work with *less* code took longer.

### 2.5 Extremes

**Ten highest** signed pair overheads:

| replicate | iteration | minimal us | instrumented us | overhead % |
|---|---|---|---|---|
| 0 | 28 | 9801.700 | 20494.200 | 109.0882 |
| 2 | 37 | 15474.500 | 31875.600 | 105.9879 |
| 0 | 15 | 9956.700 | 19671.900 | 97.5745 |
| 0 | 16 | 9971.200 | 19636.000 | 96.9272 |
| 0 | 14 | 10056.600 | 18829.200 | 87.2323 |
| 0 | 0 | 9311.600 | 17329.600 | 86.1077 |
| 0 | 31 | 10046.300 | 18567.500 | 84.8193 |
| 0 | 6 | 10028.600 | 17895.800 | 78.4476 |
| 0 | 17 | 9638.800 | 16972.200 | 76.0821 |
| 0 | 26 | 10413.700 | 17666.000 | 69.6419 |

**Ten lowest**:

| replicate | iteration | minimal us | instrumented us | overhead % |
|---|---|---|---|---|
| 1 | 41 | 19050.400 | 9677.800 | −49.1990 |
| 1 | 21 | 15280.100 | 9773.400 | −36.0384 |
| 0 | 45 | 18985.700 | 12572.600 | −33.7786 |
| 1 | 42 | 16552.800 | 11499.900 | −30.5260 |
| 1 | 22 | 13975.900 | 10382.200 | −25.7135 |
| 1 | 1 | 15174.100 | 11377.400 | −25.0209 |
| 1 | 18 | 12947.900 | 9717.800 | −24.9469 |
| 0 | 43 | 16449.300 | 12730.600 | −22.6070 |
| 0 | 47 | 14937.400 | 11574.700 | −22.5119 |
| 1 | 48 | 16360.000 | 12934.600 | −20.9377 |

Note the structure: **9 of the 10 worst positives are replicate 0**, and **7 of the 10 largest negatives are
replicate 1**. In both lists the *minimal* side is the odd one out — either unusually fast (rep 0, ~9.3–10.4 ms)
or unusually slow (rep 1, ~12.9–19.1 ms) relative to the ~15.5 ms steady state.

### 2.6 Clustering

- **Top-10 replicates:** `[0,0,0,0,0,0,0,0,0,2]` — 9/10 in replicate 0. Iterations scattered
  (0, 6, 14, 15, 16, 17, 26, 28, 31) → not confined to one iteration region.
- **Bottom-10 replicates:** `[0,0,0,1,1,1,1,1,1,1]`.
- **Pairs > 10 % by replicate:** `[35, 20, 27, 6, 1, 7]` — 82 of 96 come from replicates 0–2.
- **Negative pairs by replicate:** `[10, 22, 12, 19, 21, 22]`.
- **Replicate medians (minimal us):** `[11559.3, 13001.7, 15523.5, 15788.1, 15968.9, 15490.1]`
- **Replicate medians (instrumented us):** `[15559.4, 14225.5, 17633.7, 15941.0, 15994.9, 15655.4]`

**The decisive observation** — within-block drift (first 10 vs last 10 measured iterations):

| replicate | condition | first10 us | last10 us | Δ | slope us/iteration |
|---|---|---|---|---|---|
| **0** | **MINIMAL** | **11222.7** | **15614.0** | **+4391.3** | **+82.7 (rising)** |
| 0 | INSTRUMENTED | 14844.0 | 14213.1 | −630.9 | −34.6 (falling) |
| **1** | **MINIMAL** | **12105.0** | **16244.0** | **+4138.9** | **+121.9 (rising)** |
| 1 | INSTRUMENTED | 15145.9 | 15076.8 | −69.1 | +34.6 (flat) |
| 2 | MINIMAL | 16056.9 | 15159.9 | −897.0 | −21.5 (falling) |
| 2 | INSTRUMENTED | 15666.3 | 18397.5 | +2731.2 | +113.1 (rising) |
| 3 | MINIMAL | 16141.2 | 15668.3 | −472.9 | −6.1 (falling) |
| 3 | INSTRUMENTED | 17099.6 | 16156.2 | −943.4 | −23.7 (falling) |
| 4 | MINIMAL | 15958.4 | 15618.2 | −340.3 | −6.7 (falling) |
| 4 | INSTRUMENTED | 16146.5 | 15714.4 | −432.1 | −8.2 (falling) |
| 5 | MINIMAL | 15565.7 | 15501.6 | −64.1 | −1.7 (falling) |
| 5 | INSTRUMENTED | 16541.5 | 15330.8 | −1210.6 | −27.8 (falling) |

**This is the single most important result in the phase.** In replicates 0 and 1 the MINIMAL block *starts*
at ~11.2–12.1 ms and *climbs monotonically* to ~15.6–16.2 ms — a ~+4.2 to +4.4 ms (≈ +37 %) ramp within one
50-iteration loop — while the INSTRUMENTED block in the same replicates was *already* at ~14.8–15.1 ms and
stayed flat or fell. By replicates 3–5 every block is flat or falling and all four conditions sit at
~15.3–16.1 ms; the MINIMAL last-10 values (15618, 15502) match the INSTRUMENTED last-10 values
(15714, 15331) to within ~1 %.

By the end of the run the MINIMAL and INSTRUMENTED conditions are **measuring the same number**.
The apparent overhead is therefore concentrated entirely in the early run, where MINIMAL was
*unrepresentatively fast*, not where INSTRUMENTED was slow.

### 2.7 Per-replicate metrics

| rep | pooled mean overhead % | median deviation % | worst signed overhead % | median pair ratio % | negatives | pairs > 10 % |
|---|---|---|---|---|---|---|
| 0 | 27.171 | 34.605 | 109.088 | 30.423 | 10 | 35 |
| 1 | 5.447 | 9.413 | 65.452 | 5.217 | 22 | 20 |
| 2 | 18.473 | 13.593 | 105.988 | 16.305 | 12 | 27 |
| 3 | 2.273 | 0.968 | 25.573 | 1.221 | 19 | 6 |
| 4 | 0.243 | 0.163 | 10.283 | 0.646 | 21 | 1 |
| 5 | 1.337 | 1.067 | 16.631 | 1.996 | 22 | 7 |

Both magnitudes decay with replicate index: the minimal-first replicates are `[34.6, 13.6, 0.16]` and the
instrumented-first replicates are `[−8.6, −1.0, −1.1]`.

### 2.8 Subset recomputation — EXPLANATORY ONLY

**The frozen metric was not replaced by any of these.** They exist only to locate where the failure lives.

| subset | mean % | worst % | median dev % | all ≤ thresholds? |
|---|---|---|---|---|
| **ALL 6 replicates (the frozen basis)** | **8.5506** | **109.0882** | **2.1161** | **no** |
| replicates 0–2 (early run) | 16.9180 | 109.0882 | 4.2430 | no |
| replicates 3–5 (later run) | 1.2814 | 25.5727 | 0.8927 | no (worst only) |
| replicate 0 excluded | 5.5360 | 105.9879 | 1.6084 | no |
| replicates 0 and 2 excluded | 2.1864 | 65.4523 | 0.6802 | no |
| even reps only (MINIMAL runs first) | 14.2940 | 109.0882 | 3.9186 | no |
| odd reps only (INSTRUMENTED runs first) | 2.8828 | 65.4523 | 0.5241 | no |

Two conclusions. (a) Dropping the early transient is enough to bring **mean overhead and median deviation
inside their thresholds** (1.28 % and 0.89 % on replicates 3–5), which is direct evidence that the
mean/median failures are a run-start artifact. (b) It is **not** enough for
`worst_case_overhead_pct`: even on replicates 3–5 the worst single pair is 25.57 %, and **14 pairs** across
replicates 3–5 still exceed 10 % (6 + 1 + 7, out of 96 such pairs overall; the other 82 lie in replicates
0–2). The worst-case metric fails on its own, on steady-state data, because it is a single maximum over a
heavy tail. That part of the failure remains unexplained.

### 2.9 Order effect — real but confounded

| condition | median when run first | median when run second | Δ |
|---|---|---|---|
| MINIMAL | 14350.55 us | 14759.97 us | +409.42 us (+2.85 %) |
| INSTRUMENTED | 15273.95 us | 16395.97 us | +1122.02 us (+7.35 %) |

Both conditions are slower when they run second, and apparent overhead is 16.12 % when MINIMAL runs first
vs 3.82 % when INSTRUMENTED runs first — directionally consistent with a position penalty. **But the design
cannot separate position from elapsed time**: "INSTRUMENTED second" happens in replicates 0, 2, 4 (early)
and "INSTRUMENTED first" in 1, 3, 5. The decaying magnitudes across replicate index (`[34.6, 13.6, 0.16]`
and `[−8.6, −1.0, −1.1]`) track run order at least as well as they track position. This is recorded as an
**association, not a cause**.

---

## 3. Measurement implementation — code-level findings

Read from `stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp` and
`stark/src/phase1/bench/{BenchmarkHarness.cpp,TinyDenseModel.cpp}`.

### 3.1 What each timed interval contains — PROVEN

`run_replicate()` (lines 598–672) times each measured iteration with a single outer pair:

```cpp
const auto tA = Clock::now();          // line 630
if (mode == Mode::INSTRUMENTED) instrumented_op(blob_path, loader, comp);
else                            minimal_op(blob_path, loader);
const auto tB = Clock::now();          // line 635
```

`minimal_op()` (lines 474–484) — **no internal timing at all**:

```cpp
std::ifstream f(path, std::ios::binary);
if (!f) throw std::runtime_error("cannot open weight blob");
std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(f)),
                           std::istreambuf_iterator<char>());
loader.deserializeWeights(bytes);
```

`instrumented_op()` (lines 486–506) executes **the identical statement sequence** plus
`t0..t3 = Clock::now()` at the three stage boundaries and three `duration<double>` conversions.

So the *only* difference between the two conditions is **four `Clock::now()` calls and three duration
conversions**. `Clock` is `std::chrono::steady_clock` (line 148).

### 3.2 Magnitude of the instrumentation — the decisive number

Four `steady_clock::now()` calls on Windows resolve to `QueryPerformanceCounter`, on the order of tens of
nanoseconds each. Even at a deliberately pessimistic **1 µs each**, the instrumentation adds ≈ 4 µs to an
interval of ≈ 15 500 µs — that is **≈ 0.026 %**. Compared with the observed `mean_overhead_pct` of
**8.5506 %**, the instrumentation is too small by a factor of ~300. The conclusion is robust to the exact
clock cost: **the four timer reads cannot account for the observed overhead.** This is reinforced by the
shape of the data — a static instrumentation cost cannot produce a monotonic *rise within a block*
(+4.4 ms in rep 0 MINIMAL) or a *decay across replicates*, and the observed pattern is overwhelmingly
temporal.

### 3.3 Work inside the timed region — variable and allocation-heavy (in BOTH conditions)

- **Allocation: yes.** `std::vector<uint8_t> bytes(istreambuf_iterator<char>(f), istreambuf_iterator<char>())`
  is a **range constructor from an input iterator**, so the vector cannot pre-size itself; it grows by
  repeated reallocation (amortised doubling) while reading the file one character at a time. For a
  1 051 664-byte blob that is a long chain of `realloc` + `memcpy` (≈ 2n bytes copied) plus ~1 M
  iterator/`sgetc`/`uflow` calls. **This is inside the timed interval and is the dominant cost.**
- `deserializeWeights()` (`TinyDenseModel.cpp` lines 108–122) performs **no allocation** — it is four
  `memcpy` calls into `w1_/b1_/w2_/b2_`, which are sized in the constructor **outside** all timed regions
  (`TinyDenseModel loader(1);`, line 601/606: "constructed outside all timed regions").
- **Destruction is inside the interval too**: `bytes` and `ifstream f` are locals of the op, so their
  destructors (freeing ~1 MB, closing the handle) run before `tB` is taken. Symmetric in both conditions.
- **Logging: none** inside either op or in the measured loop.
- **Synchronisation: none** — the diagnostic is single-threaded.
- **Scheduling / affinity: uncontrolled.** The diagnostic states this itself
  ("no CPU affinity control"); there is no thread pinning and no priority change.
- **Timer resolution: not a limitation.** At ~15 ms intervals, QPC resolution (~100 ns) is irrelevant.

Corroboration from the run's own component decomposition: `open` ≈ 264 µs, **`read` ≈ 15 180 µs (≈ 95 % of
the total)**, `deserialize` ≈ 139 µs, residual ≈ 177 µs. The measurement is overwhelmingly the
iterator-driven read+growth path, which is exactly the allocation-heavy part.

### 3.4 Fidelity to production — PROVEN

`bench_model_load_time()` in `BenchmarkHarness.cpp` (lines 297–316) runs the **byte-identical** statement
sequence with the same `istreambuf_iterator` idiom, tagged
`{"blob_bytes", …}, {"mode", "warm_cache"}`. So `minimal_op()` is a faithful reproduction of the production
B7 operation, and the instrumentation under test is the only addition. The heavy allocation-driven read
path is **production behaviour**, not a diagnostic artifact.

### 3.5 Warm-up, iteration order, replicate boundaries — could they influence observations?

- **Warm-up:** 10 untimed iterations per replicate, of the *same* op as that replicate's measurement
  (`kWarmupIterations = 10`, lines 153/608). 10 iterations of a ~15 ms op is only ~150 ms of warm-up, and it
  occurs **once per replicate** — there is **no discarded warm-up replicate** before the first measured
  replicate. Given the observed +4.4 ms intra-block ramp, 10 iterations of warm-up was evidently
  insufficient to reach steady state at run start.
- **Iteration order:** strictly sequential per condition; the schedule counterbalances condition order
  (even replicates MINIMAL-first). The order effect in §2.9 is real but confounded (§2.9).
- **Replicate boundaries:** replicates run sequentially **in the same process**, each with a fresh loader;
  the previous replicate's state (allocator free lists, page cache, CPU/thermal state) carries over — which
  is precisely the mechanism by which "later replicates are slower/faster" can appear. Truncation at
  replicate boundaries is **not** a source of the failure, but carry-over between replicates **is** a
  plausible mechanism for the transient.

### 3.6 Is there evidence of a measurement *defect*?

**No defect is evidenced.** The measurement is correctly engineered for its stated purpose: independent
outer timer bracketing identical work, no logging/synchronisation/allocation asymmetry, faithful production
reproduction, symmetric destruction, unambiguous units, and a `total_sec >= 0` clock-sanity check. The
failures are **quality-of-measurement** problems — insufficient warm-up before the first replicate and a
noise-dominated tail on an I/O- and allocation-heavy operation — not correctness defects. The current data
therefore establishes **a calibration failure plus a strong transient hypothesis**; it does not establish a
code defect.

---

## 4. The toolchain caveat, stated precisely

**Facts.** The executable under test was built with **MSVC 19.29.30159** (toolset 14.29.30133). Flags
verified from the generated project and the compile tlog:
`/O2 /Ob2 /DNDEBUG /EHsc /MD /GS /fp:precise /Zc:wchar_t /Zc:forScope /Zc:inline /std:c++17` — a genuine
optimised Release build (`<Optimization>MaxSpeed</Optimization>`), not a misoptimised or debug build.
Historical G7CAM records were produced with **GCC 16.1.0**
(`stark/build/g7-campaign-frozen-20261008/G7CAM-B7-E5-11933807.json` → `software.compiler`), and the
Oct-12 MinGW-GCC diagnostic run measured a minimal pooled median of **4 689.7 µs**.

**Observed absolute levels:**

| build | B7 minimal median |
|---|---|
| GCC 16.x, frozen campaign (2026-10-08) | 5 721.90 µs |
| GCC (MinGW) diagnostic run (2026-10-12) | 4 689.70 µs |
| **MSVC 19.29, this run** | **15 469.85 µs** |

That is a **~2.7–3.3× absolute difference**.

**What IS valid from this run.**

1. **The paired MINIMAL-vs-INSTRUMENTED comparison is internally valid.** Both conditions were compiled by
   the same compiler with the same flags, use the same STL, and ran in the same process on the same blob
   within the same run. The ratio therefore does not depend on which compiler built it.
2. **The conclusion that the 8.55 % is not instrumentation cost is compiler-independent.** The four
   `Clock::now()` calls are visible in the source and their cost is bounded by four QPC reads; that bound
   does not become 8.55 % under any reasonable compiler. No compiler would make four nullary timer reads
   cost 1.3 ms.
3. **The temporal shape is compiler-independent.** A monotonic +4.4 ms rise inside one 50-iteration loop,
   and a decay of the condition gap across replicates, are *state* effects. Code generation is constant
   across iterations, so it cannot produce either pattern.
4. **The failure verdict itself is compiler-independent**, because it is computed from this run's own paired
   data against the frozen thresholds.

**What is NOT valid.**

1. **Any absolute comparison with the historical 5 721.90 µs reference is invalid** — and the diagnostic
   itself already flags this (no warm-cache or CPU-affinity equivalence claimed). A 2.7–3.3× gap is of the
   size one expects from a different STL implementation of the `istreambuf_iterator` read-growth idiom,
   but it is **also** consistent with a different machine state (frequency/thermal/power plan, storage
   path). **This phase cannot attribute the gap to the compiler**, because there was no A/B experiment and
   no GCC toolchain is currently installed (the WinLibs GCC was deleted). Treating it as "MSVC is 3× slower"
   would be unsupported.
2. **The overhead percentage cannot be transferred to the production/campaign path** as a like-for-like
   number, because it is a ratio whose numerator is state-driven noise and whose denominator is
   implementation-sensitive. The *mechanism* (transient + tail) transfers; the *value* does not.
3. **The heavy tails and the transient magnitude may themselves be toolchain- or environment-dependent.**
   A different STL's allocation pattern could change both.

**Additional confound worth naming:** the frozen campaign records were produced with **CPU affinity pinned
to a single core** (`G7CAM-B7-E5-11933807.json` → `provenance.affinity.effective_logical_cpus = [0]`,
`verified_single_cpu = true`), whereas this diagnostic explicitly runs **unpinned**. Unpinned execution on a
12-logical-core hybrid CPU with a power-managed governor is a plausible contributor to both the run-start
ramp and the per-iteration tail, and it is a genuine methodological difference from the historical
campaign — independent of the compiler question.

**Bottom line:** the compiler difference does **not** invalidate the paired result, and it does **not**
explain the 8.55 %; but it **does** invalidate absolute and like-for-like comparison with historical
timings, and it remains an unquantified confound for the *magnitude* of the transient and the tail.

---

## 5. Recommended next experiment — DO NOT EXECUTE

Not launched. No CSV created. Requires separate authorization.

### 5.1 Hypothesis to test

**H1 (primary):** the calibration failure is dominated by an **insufficiently warmed run start**, not by
instrumentation cost. Steady-state instrumentation overhead is ≈ 0–1 % (the frozen mean and median-deviation
metrics are ~1.28 % and ~0.89 % on replicates 3–5). A protocol that reaches steady state before the first
*measured* replicate should bring `mean_overhead_pct` and `median_deviation_pct` within threshold.
**H1 is falsified** if the same pattern (early-only elevation, ~8.5 % mean) reappears after adequate
pre-warm.

**H2 (co-primary, tests repeatability):** the residual `worst_case_overhead_pct` failure is a
**reproducible tail property** of this workload rather than a one-off. **H2 is falsified** if the worst
pair's magnitude and the count of pairs > 10 % do not reproduce across independent runs.
Note the code-level bound: genuine instrumentation cost cannot be the cause (§3.2), so H1/H2 partition the
space between *setup/transient* and *noise/tail* — exactly the distinction requested.

### 5.2 What would remain unchanged

Source, executable (or a rebuild of the identical source with identical flags), the 10-warmup/50-measured/
6-replicate protocol, the counterbalanced order, the paired design, the CSV format and writer, the
isolation rules, the **frozen thresholds (2 / 10 / 2)**, and the **three frozen formulas**. No formula,
threshold, or acceptance rule is touched.

### 5.3 The single variable that changes

**The amount of untimed work executed before the first measured replicate** — specifically, one discarded
**warm-up replicate** (a full `warmup_count` + `measurement_count` cycle per condition, executed and
discarded) before replicate 0. Nothing else changes. Rationale: this is the minimal, most direct test of
the transient hypothesis, it needs no new statistic, and it leaves the frozen metric definitions intact.

### 5.4 Controls and measurements required

- **Controls:** same binary and argv; same cwd (`E:\My Local AI`); same diagnostic dir pattern; a **fresh
  host-capture filename per run** (exclusive creation forbids reuse); record machine state at start
  (power plan, AC/battery, ambient) since none is currently controlled; do not introduce affinity pinning
  in this experiment (that would be a second variable).
- **Repeat:** run the single configuration **3 times** — repetition is the only way to distinguish a
  repeatable effect from one-off noise, and it costs one variable-free change.
- **Measurements:** the three frozen metrics per run; the per-replicate table; the ten highest and ten
  lowest pairs per run; and the within-block **first-10 vs last-10** drift per replicate/condition
  (the diagnostic here would need a sequence index emitted per row, or the drift computed from the
  existing row order, which is already recoverable from the CSV as shown in §2.6).
- **Record** the residual unexplained quantity explicitly (§2.8b: pairs > 10 % on replicates 3–5).

### 5.5 Application of the existing thresholds and formulas

Identical to the frozen definitions — `100*(meanB−meanA)/meanA`, `max_j 100*(B_j−A_j)/A_j`,
`100*|medianB−medianA|/medianA` against 2 % / 10 % / 2 %. The pre-warm replicate is **discarded, not
added**, so the metric basis stays 6 measured replicates per condition and 300 paired rows, preserving
comparability with the existing CSV.

### 5.6 What would support or weaken H1 / H2

| outcome | interpretation |
|---|---|
| mean ≈ ≤2 % and median-dev ≈ ≤2 %, worst still ≫10 %, **and** the three runs agree closely | **H1 supported** (transient explains the mean/median failure). **H2 supported** (tail is reproducible) → the residual is a real tail property of the workload, and the next question is what produces the tail (allocation churn / unpinned scheduling / storage), not instrumentation. |
| mean still ≈ 8–9 % with early-replicate elevation intact | **H1 weakened/falsified** → the effect is not pre-warm-limited; escalate to a codegen/structural investigation (disassemble `minimal_op` vs `instrumented_op`; test an explicit pre-sized read to isolate the `istreambuf_iterator` idiom). |

(Arithmetic note for the reader: 96 pairs overall exceed 10 %, of which 82 lie in replicates 0–2 and
14 in replicates 3–5.)
| metrics scatter widely across the 3 runs, transient magnitude not reproducible | **Neither supported**; the measurement is noise-dominated at this protocol size → the remedy is more replication or a different statistic, and **that** would require an explicit decision to change the frozen acceptance criteria (out of scope; would need authorization). |
| worst-case disappears only after pre-warm | **H1 supported**, **H2 weakened** → the tail is also warm-up-bound. |

### 5.7 Cheaper static controls worth doing before any run

1. **Disassemble** `minimal_op` vs `instrumented_op` in
   `stark/build-b7diag-vs2019b/Release/bm_b7_diagnostic.exe` to confirm the only difference is the timer
   call sites (rules out a codegen/inlining asymmetry). Read-only; no run.
2. **A/B the read idiom** out-of-tree (a throwaway benchmark, not the diagnostic): compare the
   `istreambuf_iterator` range constructor against a pre-sized `f.read()` into a reserved buffer. This
   would quantify the allocation-driven cost and test whether the 2.7–3.3× absolute gap is an STL-idiom
   effect rather than a compiler effect. This is the only way to settle §4's open question.

---

## 6. Limitations

The following bound how far the findings above can be taken. They are stated as limits, not caveats to be
argued away.

1. **Single run — no estimate of run-to-run variability.** The authorized run was exactly one execution
   (as required). Every figure here describes *that* run. Nothing in this data distinguishes a one-off from
   a reproducible effect; only the repeat experiment in §5 can.
2. **Machine state was never controlled or recorded.** Power plan, AC/battery, ambient and thermal state are
   unknown for this run. The diagnostic itself disclaims cache-state and CPU-affinity equivalence, and it
   runs **unpinned**, whereas the frozen campaign records pinning to CPU 0. The transient and the tail are
   therefore plausibly environment-driven in ways this phase cannot quantify.
3. **The MSVC-vs-GCC difference is unquantified.** The ~2.7–3.3× absolute gap is an *observation*, not an
   attribution: there was no A/B, and no GCC toolchain is currently installed (the WinLibs GCC was deleted),
   so the compiler component cannot be separated from machine state. The 2.7× and 3.3× figures also compare
   against two *different* GCC builds (the frozen campaign and the Oct-12 MinGW run), which are not
   themselves identical.
4. **The instrumentation-cost bound is an order-of-magnitude argument, not a measurement on this host.**
   It rests on the source (four `Clock::now()` calls) plus QPC latency being tens of nanoseconds to ~1 µs.
   The argument is deliberately robust — even the pessimistic 1 µs/read bound is ~300× too small — but no
   clock overhead was directly measured here.
5. **Order/position effects are confounded with elapsed time.** The counterbalanced design places
   "INSTRUMENTED second" in replicates 0/2/4 and "INSTRUMENTED first" in 1/3/5, so position and run order
   cannot be separated with 6 replicates. §2.9's figures are associations only.
6. **No per-pair component data.** The CSV carries only `minimal_sec`, `instrumented_sec` and
   `signed_overhead_pct`. The `open`/`read`/`deserialize`/`residual` decomposition exists only as pooled
   summaries in the run stdout, so the tail cannot be attributed to a specific stage pair-by-pair.
7. **Execution order is reconstructed, not recorded.** The 12-block ordering in §2.6 assumes the documented
   sequential schedule (even replicates MINIMAL-first). The CSV contains no timestamps or sequence index, so
   within-block position is inferred from row order.
8. **The residual worst-case failure remains unexplained.** §2.8b (25.57 % on replicates 3–5; 14 pairs >10 %
   in steady state) is stated as an open item, not explained away.
9. **No outlier was removed and no substitute statistic was used for the frozen metrics.** Every subset
   figure in §2.8 is labelled EXPLANATORY ONLY; the frozen verdict uses the full 300 pairs and the unchanged
   formulas.

---

## 7. Final status distinctions

| dimension | verdict | basis |
|---|---|---|
| **Diagnostic execution** | **PASS** | Process launched and completed normally: exit code 0, stderr empty, all 6 replicates valid in both conditions, 300/300 measured pairs recorded, run-owned blob and run directory cleaned up, host CSV written and persisted. No launch, protocol, or completion defect. |
| **CSV integrity** | **PASS** | 300 rows, exact header, 300 unique `(replicate, iteration)` keys covering `{0..5}×{0..49}`, no zero/negative/non-finite/duplicate/malformed/out-of-range values, formula-consistent to serialisation precision (max relative deviation 4.7e-09). Reproduced every reported metric exactly from the file alone. |
| **Calibration** | **FAIL** | mean `8.5506 %` > 2 %; worst signed `109.0882 %` > 10 %; median deviation `2.1161 %` > 2 %. All three frozen thresholds exceeded on unchanged formulas. Classification `INCONCLUSIVE`. |
| **Root cause of the calibration failure** | **PARTIALLY SUPPORTED** | *Established:* the 8.55 % cannot be instrumentation cost — the conditions differ by four `Clock::now()` calls (≈0.026 % even at a 1 µs/call over-bound), and the observed pattern is temporal (monotonic +4.4 ms rise inside replicate 0's MINIMAL block; gap decaying to ~0.2–1.3 % by replicates 4–5). *Established:* the mean and median-deviation failures vanish when the early transient is excluded (1.28 % / 0.89 % on replicates 3–5). *Not established:* the residual `worst_case_overhead_pct` failure — 25.57 % even on replicates 3–5, with 14 pairs still >10 % — is unattributed and needs the repeat experiment in §5. |

Nothing was executed in this phase, no formula or threshold was altered, no outlier was removed, and no
evidence file was modified.
