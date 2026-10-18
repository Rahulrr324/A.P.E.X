# Phase 46 — Independent Paired-Data Forensics

**Mode:** read-only analysis of the completed Phase 45 evidence.  
**Scope:** recompute frozen metrics independently from the five raw `paired_samples.csv` files and compare the result to the existing Phase 45 validation records. No build, no launch, no new measurement, no file edits.

**Protected evidence preserved (unchanged hashes verified):**  
- validator `phase33_paired_csv_validator.py` → `9f6d6c29a1b1c1e59ddec1fa4ad4b6499cb2b2f8c692e421bf94c10fc6a1e8e6`  
- executable `bm_b7_diagnostic.exe` → `f50fda5a3486fa7d3225869d978a841c2d1fa10f92413530b1cda067b1000147`  
- source `bm_b7_diagnostic.cpp` → `aeb31eb2250d05e66a805597624db62f7d66090c7e9b5140b38f9c6f5955ca2b`  
- cmake `CMakeLists.txt` → `575fe264921512f41d30267c1c659e3662bbcfd92e71623720f9d047b7dddcc8`  
- historical Phase 36 CSV `pr35r1/paired_samples.csv` → `a09a0d3c37168dc88ecce79013d6e523c5aa2d101c726bb1ad0edadc0e89706d`  

M0 = FAIL, M1 = LOCKED preserved.

---

## 1. Integrity checks

Each Phase 45 CSV was re-read and re-hashed independently.

| Run | rows | lines | bytes | SHA-256 (recomputed) | matches Phase 45 record | structural validation.json |
|---|---|---|---|---|---|---|
| p44r1 | 300 | 301 | 12861 | `9ade00aaeefb06878c29b06cae0727fb683a520c0937c3ae51324001c839e1bc` | ✅ | PASS (all 18 checks OK) |
| p44r2 | 300 | 301 | 12864 | `6fba8677890374fa80ce6badf1bc7f144952afc07e8e9a81f7de85aea59b75aa` | ✅ | PASS (all 18 checks OK) |
| p44r3 | 300 | 301 | 12870 | `90273ab3afd6785a6d10dc7a29396cd50c8f1dcf44c119cc88763236250d930c` | ✅ | PASS (all 18 checks OK) |
| p44r4 | 300 | 301 | 12860 | `32d6540b01de7355fd6f34ced4db4dd0df2852a2790419dd7e63c44b87b0b541` | ✅ | PASS (all 18 checks OK) |
| p44r5 | 300 | 301 | 12868 | `ddb3a92b10957118aa88516b81bd959f0f25cf75b4ffaaa26d56a6703f58fee0` | ✅ | PASS (all 18 checks OK) |

Independent recompute confirms: each CSV is exactly `6 × 50 = 300` data rows plus one header, header is the frozen five-column contract (`replicate,iteration,minimal_sec,instrumented_sec,signed_overhead_pct`), all numeric fields finite, minimal/instrumented strictly positive, and the recorded `signed_overhead_pct` matches `100 × (instrumented − minimal) / minimal` within the frozen tolerance for every row. Pair alignment uses the `(replicate, iteration)` key, not file position. This is consistent with the existing validation records.

**Key-alignment finding:** all five runs contain exactly the full key set `replicate ∈ [0,5] × iteration ∈ [0,49]` with no missing or duplicate pairs.

---

## 2. Per-run frozen metrics (independently recomputed)

Formulas unchanged:  
- Mean overhead = `100 × (mean_instrumented − mean_minimal) / mean_minimal`, PASS ≤ 2%  
- Worst signed paired overhead = `max over aligned pairs of 100 × (instrumented − minimal) / minimal`, PASS ≤ 10%  
- Median deviation = `100 × |median_instrumented − median_minimal| / median_minimal`, PASS ≤ 2%

### p44r1
- mean minimal `0.015268547 s`, mean instrumented `0.014996979 s`  
- median minimal `0.0158103 s`, median instrumented `0.015331 s`  
- mean overhead **`-1.778611 %`** → PASS ≤ 2%  
- worst signed pair **`94.165583 %`** → FAIL ≤ 10%  
- median deviation **`3.031568 %`** → FAIL ≤ 2%  
- frozen verdict: **FAIL**  
- counts: above +10% = 73, below −10% = 86, |overhead| > 10% = 159  
- quantiles p50 / p90 / p95 / p99 / max / min:  
  `-2.175099 / 23.116016 / 41.457885 / 79.243181 / 94.165583 / -44.100161 %`  
- maximum pair: replicate **2**, iteration **9**, minimal `0.0101484 s`, instrumented `0.0197047 s`, overhead `94.165583 %`  
- minimum pair: replicate **1**, iteration **22**, minimal `0.0166013 s`, instrumented `0.0092801 s`, overhead `-44.100161 %`

### p44r2
- mean minimal `0.014451033 s`, mean instrumented `0.0148844453 s`  
- median minimal `0.01474435 s`, median instrumented `0.0154837 s`  
- mean overhead **`2.999179 %`** → FAIL ≤ 2%  
- worst signed pair **`111.692960 %`** → FAIL ≤ 10%  
- median deviation **`5.014463 %`** → FAIL ≤ 2%  
- frozen verdict: **FAIL**  
- counts: above +10% = 85, below −10% = 67, |overhead| > 10% = 152  
- quantiles: `0.883139 / 35.563190 / 57.905784 / 88.693523 / 111.692960 / -51.653786 %`  
- maximum pair: replicate **2**, iteration **11**, minimal `0.0091089 s`, instrumented `0.0192829 s`, overhead `111.692960 %`  
- minimum pair: replicate **5**, iteration **39**, minimal `0.0312616 s`, instrumented `0.0151138 s`, overhead `-51.653786 %`

### p44r3
- mean minimal `0.0144311767 s`, mean instrumented `0.014771898 s`  
- median minimal `0.0153447 s`, median instrumented `0.01561205 s`  
- mean overhead **`2.361009 %`** → FAIL ≤ 2%  
- worst signed pair **`116.175456 %`** → FAIL ≤ 10%  
- median deviation **`1.742295 %`** → PASS ≤ 2%  
- frozen verdict: **FAIL** (mean and worst fail even though median passes)  
- counts: above +10% = 77, below −10% = 70, |overhead| > 10% = 147  
- quantiles: `0.815121 / 39.147392 / 60.827018 / 109.463353 / 116.175456 / -52.052288 %`  
- maximum pair: replicate **2**, iteration **11**, minimal `0.0099991 s`, instrumented `0.0216156 s`, overhead `116.175456 %`  
- minimum pair: replicate **0**, iteration **23**, minimal `0.0209303 s`, instrumented `0.0100356 s`, overhead `-52.052288 %`

### p44r4
- mean minimal `0.014523488 s`, mean instrumented `0.0154927513 s`  
- median minimal `0.01458965 s`, median instrumented `0.01571275 s`  
- mean overhead **`6.673764 %`** → FAIL ≤ 2%  
- worst signed pair **`207.327580 %`** → FAIL ≤ 10%  
- median deviation **`7.697923 %`** → FAIL ≤ 2%  
- frozen verdict: **FAIL**  
- counts: above +10% = 106, below −10% = 77, |overhead| > 10% = 183  
- quantiles: `3.306944 / 52.450494 / 91.851835 / 142.651011 / 207.327580 / -40.527978 %`  
- maximum pair: replicate **3**, iteration **37**, minimal `0.014253 s`, instrumented `0.0438034 s`, overhead `207.327580 %`  
- minimum pair: replicate **3**, iteration **1**, minimal `0.0238154 s`, instrumented `0.0141635 s`, overhead `-40.527978 %`

### p44r5
- mean minimal `0.014249461 s`, mean instrumented `0.0153235197 s`  
- median minimal `0.0145489 s`, median instrumented `0.0154265 s`  
- mean overhead **`7.537539 %`** → FAIL ≤ 2%  
- worst signed pair **`221.943024 %`** → FAIL ≤ 10%  
- median deviation **`6.032071 %`** → FAIL ≤ 2%  
- frozen verdict: **FAIL**  
- counts: above +10% = 133, below −10% = 71, |overhead| > 10% = 204  
- quantiles: `6.687727 / 57.925461 / 81.278191 / 137.377040 / 221.943024 / -65.937733 %`  
- maximum pair: replicate **2**, iteration **15**, minimal `0.0095233 s`, instrumented `0.0306596 s`, overhead `221.943024 %`  
- minimum pair: replicate **4**, iteration **38**, minimal `0.0531644 s`, instrumented `0.018109 s`, overhead `-65.937733 %`

---

## 3. Distribution comparison across run order

The ordering here is temporal within one collection session: `p44r1 → p44r2 → p44r3 → p44r4 → p44r5`. I report observed ordering only; I do not claim this is controlled replication.

### Central tendency
- **Mean minimal timing** is fairly stable across runs, roughly `0.0142–0.0153 s`. There is no large monotonic drift in the minimal condition by itself.  
- **Mean instrumented timing** is also in a similar band, but the *difference* between instrumented and minimal rises across run order:
  - p44r1 mean overhead ≈ −1.78% (instrumented slightly faster on average)  
  - p44r2 ≈ +3.00%  
  - p44r3 ≈ +2.36%  
  - p44r4 ≈ +6.67%  
  - p44r5 ≈ +7.54%  
- The pooled mean overhead does **not** behave as a stable constant across run order; it is non-monotonic but trends upward overall from p44r1 to p44r5.

### Median behavior
- Median deviation passes only for p44r3 (`1.74%`); it fails for the other four runs.  
- The median-centered view therefore does **not** track the mean-view consistently: p44r3 is the only run where median deviation is within threshold, yet it still fails on mean and worst-case.

### Tail behavior
- Worst signed pair overhead climbs markedly across run order:
  - p44r1 `94.17%`  
  - p44r2 `111.69%`  
  - p44r3 `116.18%`  
  - p44r4 `207.33%`  
  - p44r5 `221.94%`  
- The count of pairs above +10% also rises across run order: 73 → 85 → 77 → 106 → 133.  
- The count of pairs with |overhead| > 10% rises: 159 → 152 → 147 → 183 → 204.  
- The negative tail (below −10%) is largest in p44r1 (`86`) and generally smaller in later runs; the positive tail grows more dominant later.

### Quantile comparison
Quantile pattern (p50 / p90 / p95 / p99) by run:
- p44r1: `-2.18 / 23.12 / 41.46 / 79.24 %`  
- p44r2: `0.88 / 35.56 / 57.91 / 88.69 %`  
- p44r3: `0.82 / 39.15 / 60.83 / 109.46 %`  
- p44r4: `3.31 / 52.45 / 91.85 / 142.65 %`  
- p44r5: `6.69 / 57.93 / 81.28 / 137.38 %`

The upper quantiles (p90–p99) generally rise from p44r1 to p44r4 and stay high in p44r5. p44r3 already shows a higher p99 than p44r4/p44r5 despite a smaller worst case, so the worst-case escalation is not the whole story: tail mass can increase before the single worst pair jumps.

### Pair-level overlap
Across the five runs, the maximum paired overhead repeatedly lands on **replicate 2**, iterations 9/11/15, and on **replicate 3** for p44r4. This is an observation about where the most extreme values happened to occur in these particular samples; it is not proof that replicate 2 is inherently pathological. The negative tail maximums also vary across replicates and iterations.

### What changes systematically vs what does not
- **Systematic-appearing (observed, not proven causal):** central tendency is stable in absolute timing, but the *signed* overhead mean and the upper-tail mass trend worse across run order in this particular sequence.  
- **Not systematic in any proven sense:** the sequence is short, unordered with respect to any controlled experimental variable, and run-local effects (cache, scheduling, iteration alignment, transient system load) are confounded with run index. I cannot separate “run order caused drift” from “these five draws happened to drift.”

---

## 4. Environment / metadata / stdout inspection

What was available in the Phase 45 evidence tree:
- Each run directory contains `paired_samples.csv`, `validation.json`, and `validation_exit.txt`.  
- There are **no** `stdout.txt`, `stderr.txt`, `exitcode.txt`, `hashes.txt`, or `exec_meta.json` files in the five Phase 45 run directories.  

That means:
- I **cannot** independently compare executable identity, affinity, working directory, arguments, wall-clock launch timestamps, or structured environment metadata across the five runs from the Phase 45 run directories.  
- I also cannot independently verify per-run launch stdout/stderr content or exit-code persistence from files in the capture tree.  
- Per-run structural and calibration status **is** available from `validation.json`, and that is sufficient to confirm the validator's own per-run report.  
- The only executable-related identity I can verify is the frozen SHA-256 of the already-built executable that produced the Phase 45 sequence (`f50fda5a...`), which is unchanged from the prior phases.

Inference limit: because per-run launch metadata is absent from the Phase 45 capture directories, I can observe that the five CSVs differ and that their frozen metrics differ, but I **cannot** directly attribute those differences to any measured change in executable, affinity, working directory, or invocation environment from the captured evidence alone.

---

## 5. Observations vs causal conclusions

### Directly measured
- All five CSVs are structurally valid and contain 300 row-aligned pairs each.  
- All five frozen metric sets recompute to the same calibration status as the existing validation records: **all five are FAIL**.  
- Worst-case signed overhead fails in all five runs, by a wide margin.  
- Median deviation fails in four of five; mean overhead fails in four of five (p44r1 mean passes, but p44r1 still FAILs on worst-case and median).  
- The worst-case overhead increases across run order in this particular sequence.  
- The upper-tail mass (|overhead| > 10%) trends upward in later runs.

### Inferred but not proven
- The observed run-order drift is consistent with within-run temporal dependence and uncontrolled environment/implementation noise. It is **not** independent replication.  
- The repeated appearance of extreme values on a small set of replicates/iterations is suggestive of sensitivity to specific timing samples, not proof of a fixed per-replicate pathology.  
- The fact that both positive and negative extreme overheads occur in the same runs shows the phenomenon is not one-directional; it is not simply “instrumented is always slower.”

### Still unproven
- Whether the extreme paired ratios are caused by instrumentation overhead, by minimal-timing instability, by system scheduling, by cache effects, by iteration alignment, or by some combination. Extreme paired ratios alone do not establish instrumentation-caused overhead.  
- Whether any of these five runs is representative of a stable underlying distribution. Five sequential runs in one session cannot establish that.  
- Whether the Phase 45 fresh executable would produce the same outcome under different execution conditions. That is outside this phase's scope and guardrails.

---

## 6. Frozen verdict summary

| Run | structural | mean ≤ 2% | worst ≤ 10% | median ≤ 2% | frozen verdict |
|---|---|---|---|---|---|
| p44r1 | PASS | PASS | FAIL | FAIL | **FAIL** |
| p44r2 | PASS | FAIL | FAIL | FAIL | **FAIL** |
| p44r3 | PASS | FAIL | FAIL | PASS | **FAIL** |
| p44r4 | PASS | FAIL | FAIL | FAIL | **FAIL** |
| p44r5 | PASS | FAIL | FAIL | FAIL | **FAIL** |

### Five-run worst-case range
Worst signed paired overheads (signed):
- `94.165583% / 111.692960% / 116.175456% / 207.327580% / 221.943024%`
- Full range: **94.17% – 221.94%** (signed), all far above the 10% worst-case threshold.

### Five-run range on all three frozen metrics
- Mean overhead: `-1.778611%` to `+7.537539%`  
- Worst signed pair: `94.17%` to `221.94%`  
- Median deviation: `1.742295%` to `7.697923%`

### Five-run replication summary (does not overwrite individual verdicts)
All five runs are structurally PASS and calibration FAIL. The replication-level observation is **calibration FAIL, consistent in direction with Phase 36 FAIL**, measured here on the fresh Phase 45 executable rather than the historical Phase 36 binary. This is an observation about the completed Phase 45 evidence set; it does **not** change the individual run verdicts and does **not** allege that the fresh executable is the historical Phase 36 binary.

---

## 7. Limitations of this phase

- No per-run launch metadata (`stdout.txt`, `stderr.txt`, `exitcode.txt`, `hashes.txt`, `exec_meta.json`) exists in the Phase 45 run directories, so environment/executable/invocation differences cannot be independently inspected from those captures.  
- The five runs are sequential within one collection session; run-to-run differences are temporally dependent, not independent replications.  
- Extreme paired ratios are reported as measured; causation is not established.  
- No source, CMake, validator, threshold, or evidence files were modified; no new measurements were taken; M0 = FAIL and M1 = LOCKED remain unchanged.

---

## 8. Conclusion

Phase 46 independently recomputed the frozen metrics from the five Phase 45 CSVs and confirmed the existing validation records. All five runs are structurally sound, with 300 key-aligned pairs each and matching SHA-256 across independent recomputation. Under the frozen formulas and thresholds, **all five runs FAIL calibration**, driven primarily by worst-case signed paired overhead far above 10% and, in most runs, also by mean or median deviation above threshold. The upper tail and worst-case maximum trend worse across run order in this sequence, but that pattern is an observed within-session drift, not established causation and not independent replication. The evidence supports a FAIL conclusion for this Phase 45 set without altering Phase 36's historical verdict.
