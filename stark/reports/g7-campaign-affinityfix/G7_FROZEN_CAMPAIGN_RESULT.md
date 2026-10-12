# Frozen M0 G7 Campaign — Result

**Date:** 2026-10-08
**Objective:** Produce fresh production-semantic evidence for frozen M0 §G **G7** and
determine whether G7 PASSES or FAILS under the existing, unchanged contract.
**Campaign directory:** `build/g7-campaign-frozen-20261008/` (new; historical campaigns untouched).
**Result:** **G7 FAILS** under the frozen contract (production aggregator, exit 1).

---

## 1. Contract

Frozen authority: `design/V009_phase1_M0_specification.md` rev 1.1, §G line 328
(verbatim):

> **G7** | Full re-run of the same suite with same config: every benchmark median
> within ±15% of the recorded median (memory bandwidth ±20%). Determinism check per
> rev-1.1: CPU FP32 deterministic-mode records must be `outputs_bit_identical == true`;
> GPU records evaluated per declared mode (`deterministic_mode_available == false` ⇒
> bit-identity not required). Tolerance is defined here once — later phases may not
> loosen it silently.

**Frozen G7 as implemented (unchanged):** same-configuration **benchmark-median
reproducibility**;

- normal benchmarks: **±15%**; memory-bandwidth benchmarks (B3/B5): **±20%**;
- comparison across independent runs sharing **exactly the production grouping key
  `configuration.dump()`**;
- **all-pairs** within each group (not adjacent-only);
- **≥2 independent records** (distinct `record_id`);
- per-record **≥10 samples**; stored median verified against recomputed raw-sample
  median within the frozen **0.001%** consistency tolerance.

G7 is **not** a CPU-frequency-stability test. No frequency gate was applied.

---

## 2. Campaign design

| Item | Value |
|---|---|
| Harness | `build-v24-release/g7_campaign.exe` (unmodified production binary) |
| Command | `g7_campaign.exe --out build/g7-campaign-frozen-20261008 --samples 50 --warmup 10 --runs 5 --threads 1` |
| Independent runs | **5** (≥2 required) with 30 s inter-run delay |
| Executions per run | 6 = {E1,E5} × {B6,B7,B9} |
| Total campaign records | **30** |
| Samples (`measurement_count`) | **50** per record (≥10 required) |
| Warmup (`warmup_count`) | **10** (≥3 required) |
| thread_count / batch_size / sequence_length | 1 / 1 / 0 |
| Precision | FP32 |
| Affinity | per-run single-CPU pin, recorded in `provenance.affinity`; **verified CPU0 on all 30** (`verified_single_cpu=true`, `raw_process_mask=1`) |

**Configurations (grouping identity = `configuration.dump()`):**

- **B6** `{"batch_size":1,"benchmark_id":"B6","measurement_count":50,"sequence_length":0,"thread_count":1,"warmup_count":10,"workload_params":{"logical_params":"262912","model":"TINY-DENSE-2L"}}` — group = **10 records** (5 × E1 + 5 × E5).
- **B7** `{"...","benchmark_id":"B7","workload_params":{"blob_bytes":"<n>","mode":"warm_cache"}}` — group = **10 records**.
- **B9** `{"...","benchmark_id":"B9","workload_params":{"model":"TINY-DENSE-2L","repeats":"200"}}` — group = **10 records**.

E1/E5 designate baseline experiments; because `experiment_id` and `affinity` are **not**
part of the production grouping key, the E1 and E5 records of each benchmark form the
**same** same-configuration group (10 records each). This is the unchanged production
grouping semantics.

Additionally, for the current-M0 evidence model, the established production CLIs were
used (no fabrication): `profiler_cli` → `P1-PROFILE-24-0` (kind profiler) and
`run_baseline --baseline E2` → `P1-E2-skip`, `P1-B4-skip`, `P1-B5-skip` (structured
no-CUDA skip attestation), plus `P1-TELEMETRY-24-1`.

---

## 3. Integrity before

Captured at `2026-10-08T15:14:48Z` (raw: `work/scripts/g7frozen_before.txt`).

| Protected item | State |
|---|---|
| Frozen 30 (`build/g7-campaign/`) | **30/30 SHA, manifest count 30 — PASSED, exit 0** |
| `reports/evidence_manifest.json` | sha `14975fa285362d4bb6f92f08840841de6edfad88b29dfd101107075731d473d3` |
| `design/V009_phase1_M0_specification.md` | sha `2c8c730ce590000afc8c9ed22929c2538bf8b38b20cbce245f6d34fc2ef3d55b` |
| `src/phase1/gates.cpp` | sha `c4ff3a91d51090427a5ed1bbbefe40796c88f57adc7714e4eb7fc67b21a0ef4b` (matches `sha256sums_v24.txt`) |
| `src/phase1/aggregate.cpp` | sha `6c372e70ecd0e9dcd6f651c3275b605f78160d357fc31644fa1d5a172afeaf9d` |
| Production binaries | `g7_campaign.exe 2667719f…`, `aggregate.exe 2f4600a6…`, `run_baseline.exe 61e2d123…`, `profiler_cli.exe b3539413…`, `libstark_phase1.a 426a8102…` |
| Active power scheme | `dfe97760-471c-4d01-bd06-b8b04c50ecd8 (Performance Mode)` |
| `build/g7-campaign/` (frozen 30) | 30 records, mtimes 2026-10-05 only |
| `build/g7-campaign-affinityfix/` (historical campaign) | 30 records, mtimes 2026-10-06 only |

**Invariants verified before execution:** (1) §G unchanged; (2) thresholds exactly
±15%/±20%; (3) grouping exactly `configuration.dump()`; (4) median calculation
unchanged; (5) symmetric-relative-difference unchanged; (6) G7 gate implementation
unchanged (`gates.cpp` hash matches the frozen v2.4 hash); (7)–(9) frozen records /
manifest / binaries intact; (10) no frequency criterion introduced — the run used only
`g7_campaign.exe`; (11) no timing/config-identity change — unmodified binaries, frozen
config; (12) no prior failed evidence deleted/regenerated. **All satisfied → campaign proceeded.**

---

## 4. Results

Durations are medians in microseconds (`median_us`); every record has **n = 50** samples.

### B6 group — 10 records — tolerance 15% — **FAIL**

| record_id | exp | n | median (µs) |
|---|---|---|---|
| G7CAM-B6-E1-9007430 | E1 | 50 | 359.50 |
| G7CAM-B6-E1-11933807 | E1 | 50 | 219.45 |
| G7CAM-B6-E1-39872860 | E1 | 50 | 219.80 |
| G7CAM-B6-E1-41851871 | E1 | 50 | 219.80 |
| G7CAM-B6-E1-76656589 | E1 | 50 | 178.70 |
| G7CAM-B6-E5-9007430 | E5 | 50 | 181.50 |
| G7CAM-B6-E5-11933807 | E5 | 50 | 221.35 |
| G7CAM-B6-E5-39872860 | E5 | 50 | 219.95 |
| G7CAM-B6-E5-41851871 | E5 | 50 | 220.00 |
| G7CAM-B6-E5-76656589 | E5 | 50 | 179.45 |
- **B6 note:** 2 of 10 records (G7CAM-B6-E1-9007430 at 359.50 µs and G7CAM-B6-E1-11933807 at 219.45 µs vs its 5-record E1 cluster at ~219–219.80 µs) are the main drivers; the E1 sub-cluster excluding those two sits at ~219 µs across 3 records, while the matching E5 sub-cluster (219.95/220.00/221.35) sits at ~220 µs — these 6 records agree within ~1%. The failure is not E1-vs-E5; it is two E1 outliers that are ~50% above the rest of the group and one E5 record (G7CAM-B6-E5-9007430 at 181.50 µs) that is ~19% below the tight ~220 µs core. Recorded as observed; the E1→E5 median gap is ~14.62% (see §4 recompute).

- **max pairwise diff = 50.2921%** (between runs 4 and 5) — allowed 15.00% → violation
- min pairwise diff = 0.0000%; CV = 23.39%; **26 of 45 pairs** exceed 15%
- **Group verdict: FAIL**

### B7 group — 10 records — tolerance 15% — **FAIL**

| record_id | exp | n | median (µs) |
|---|---|---|---|
| G7CAM-B7-E1-9007430 | E1 | 50 | 2731.20 |
| G7CAM-B7-E1-11933807 | E1 | 50 | 3339.05 |
| G7CAM-B7-E1-39872860 | E1 | 50 | 3300.85 |
| G7CAM-B7-E1-41851871 | E1 | 50 | 3242.55 |
| G7CAM-B7-E1-76656589 | E1 | 50 | 2814.60 |
| G7CAM-B7-E5-9007430 | E5 | 50 | 2863.35 |
| G7CAM-B7-E5-11933807 | E5 | 50 | 5721.90 |
| G7CAM-B7-E5-39872860 | E5 | 50 | 4147.15 |
| G7CAM-B7-E5-41851871 | E5 | 50 | 3075.55 |
| G7CAM-B7-E5-76656589 | E5 | 50 | 3892.45 |
- **B7 note:** the worst pair (G7CAM-B7-E1-9007430 2731.20 µs ↔ G7CAM-B7-E5-11933807 5721.90 µs) is a within-run-pair (E1 of run 1 vs E5 of run 2) but the spread is not run-order-driven: within-E1 spread is 18.20%, within-E5 spread is 49.96%, and the E1 mean (3085.65 µs) vs E5 mean (3940.08 µs) gap is ~21.69% (see §4). The largest single contributor is G7CAM-B7-E5-11933807 at 5721.90 µs (more than 90% above the group's 9-record core of ~2800–4150 µs).

- **max pairwise diff = 52.2676%** (between runs 5 and 6) — allowed 15.00% → violation
- min pairwise diff = 1.1440%; CV = 25.61%; **26 of 45 pairs** exceed 15%
- **Group verdict: FAIL**

### B9 group — 10 records — tolerance 15% — **FAIL**

| record_id | exp | n | median (µs) |
|---|---|---|---|
| G7CAM-B9-E1-9007430 | E1 | 50 | 181.75 |
| G7CAM-B9-E1-11933807 | E1 | 50 | 223.80 |
| G7CAM-B9-E1-39872860 | E1 | 50 | 187.55 |
| G7CAM-B9-E1-41851871 | E1 | 50 | 222.65 |
| G7CAM-B9-E1-76656589 | E1 | 50 | 180.60 |
| G7CAM-B9-E5-9007430 | E5 | 50 | 182.15 |
| G7CAM-B9-E5-11933807 | E5 | 50 | 260.50 |
| G7CAM-B9-E5-39872860 | E5 | 50 | 223.80 |
| G7CAM-B9-E5-41851871 | E5 | 50 | 223.10 |
| G7CAM-B9-E5-76656589 | E5 | 50 | 179.50 |
- **B9 note:** the worst pair (G7CAM-B9-E5-11933807 260.50 µs ↔ G7CAM-B9-E5-76656589 179.50 µs) is within E5; within-E5 spread is 31.09% vs within-E1 spread of 19.30%. The E1 mean (199.27 µs) vs E5 mean (213.81 µs) gap is only ~6.80% — the failure is internal to E5, not an E1-vs-E5 split.

- **max pairwise diff = 31.0940%** (between runs 6 and 9) — allowed 15.00% → violation
- min pairwise diff = 0.0000%; CV = 13.52%; **25 of 45 pairs** exceed 15%
- **Group verdict: FAIL**

**No group PASSES.** Every record's stored median equals its recomputed raw-sample
median to 0.0000% (independent recompute, `scripts/recompute_g7_frozen.py`, §4), so all 30
records cleared the frozen median-consistency and ≥10-sample checks; the failures are genuine
cross-run median disagreement, not a median-consistency defect.

Independent recompute raw output: `reports/g7-campaign-affinityfix/recompute_raw.txt`.
Production pairwise listings: `build/g7-campaign-frozen-20261008/aggregator.txt` and
`build/g7-campaign-frozen-20261008/verify_g7.txt`.

### E1/E5 configuration-identity confirmation (production grouping semantics)

Each benchmark's E1 and E5 configuration dumps are **identical** (`configuration.dump()`
matches), so E1 and E5 share one same-configuration group of 10 records per benchmark.
This is the unchanged production grouping semantics, not a campaign choice:

| benchmark | E1 config == E5 config | E1 n | E5 n | E1 mean median (µs) | E5 mean median (µs) | E1↔E5 mean diff |
|---|---|---|---|---|---|---|
| B6 | True | 5 | 5 | 239.45 | 204.45 | 14.62% |
| B7 | True | 5 | 5 | 3085.65 | 3940.08 | 21.69% |
| B9 | True | 5 | 5 | 199.27 | 213.81 | 6.80% |

Mean-E1-vs-mean-E5 gaps are all under the 50–52% worst-pair values, so the worst pairs
are driven by individual outlier records within a single experiment designation (not by
a systematic E1-vs-E5 split).

---

## 5. Production gate result

`build-v24-release/aggregate.exe --out build/g7-campaign-frozen-20261008` → **exit 1**.

```
records found: 35   (30 benchmark + PROFILE + TELEMETRY + E2/B4/B5 skips)
[PASS] G1 hardware profile collected
[PASS] G2 CPU baselines present and complete
[PASS] G3 GPU branch complete-or-skipped with reason
[PASS] G4 peak memory measured
[PASS] G5 parameter accounting consistent
[PASS] G6 budget evaluator rejects over-budget demands
[FAIL] G7 same-config medians reproducible across repeats
       B6 medians differ 50.29% (allowed 15.00%)  [max pair: runs 4 and 5]
       B7 medians differ 52.27% (allowed 15.00%)  [max pair: runs 5 and 6]
       B9 medians differ 31.09% (allowed 15.00%)  [max pair: runs 6 and 9]
OVERALL: FAIL (1 gate(s) failed)
```

**Production G7 verdict: FAIL.**

---

## 6. Independent cross-check

`python reports/g7-campaign/verify_g7.py build/g7-campaign-frozen-20261008` → **exit 1**.

```
benchmark n_runs  tolerance  max_diff   min_diff   cv%     verdict
B6       10      15.0       50.2921%   0.0000%    23.39   FAIL
B7       10      15.0       52.2676%   1.1440%    25.61   FAIL
B9       10      15.0       31.0940%   0.0000%    13.52   FAIL
Independent G7 verdict: FAIL
```

A second independent recompute (`scripts/recompute_g7_frozen.py`) re-derives every
median and every pairwise symmetric relative difference directly from the raw samples in the
30 records, with no reliance on the stored medians or on the production aggregator output.
It **agrees with the production result exactly**: B6 50.2921% / B7 52.2676% / B9 31.0940%,
FAIL; every stored median matches its recomputed median to 0.0000%; all 45 pairs per group
recomputed. The recompute script itself exits 0 only because it reports the values and the
verdict without asserting the gate outcome; the gate verdict it computes is FAIL.

| benchmark | production aggregator max diff | independent recompute max diff | agree |
|---|---|---|---|
| B6 | 50.2921% | 50.2921% | yes |
| B7 | 52.2676% | 52.2676% | yes |
| B9 | 31.0940% | 31.0940% | yes |

Both independent checks agree with the production G7 verdict (FAIL).

---

## 7. M0 consequence

**G7 FAILS under the frozen contract on fresh current-machine production evidence.**

Therefore **M0 remains FAIL**: the mandatory §G G7 gate is not satisfied. No threshold,
formula, grouping, median, sample count, timing semantic, configuration identity,
affinity evidence, or historical record was changed to alter this outcome, and a FAIL
is recorded as valid evidence. **M1 remains LOCKED** (unchanged by this campaign).

---

## 8. Integrity after

Captured after the campaign (raw: `work/scripts/g7frozen_after.txt`). The
before/after diff is **identical except for the timestamp line**:

- Frozen 30: **30/30 SHA, manifest unchanged, PASSED, exit 0**.
- `reports/evidence_manifest.json`: **unchanged** (same sha).
- All protected source files and production binaries: **unchanged** (identical hashes
  to §3).
- Active power scheme: **unchanged** — `dfe97760-471c-4d01-bd06-b8b04c50ecd8 (Performance Mode)`.
- `build/g7-campaign/` (frozen 30): **untouched** (30 records, mtimes 2026-10-05).
- `build/g7-campaign-affinityfix/` (historical campaign): **untouched** (30 records, mtimes 2026-10-06); no historical G7CAM record modified.
- Existing record-id inventory hash: **unchanged**.

**Newly created artifacts (all under the new campaign directory `build/g7-campaign-frozen-20261008/`):**

```
30 × G7CAM-{B6,B7,B9}-{E1,E5}-<hash>.json      (new campaign records)
P1-PROFILE-24-0.json, P1-TELEMETRY-24-1.json    (current-machine profile)
P1-E2-skip.json, P1-B4-skip.json, P1-B5-skip.json (structured no-CUDA skips)
campaign_run.log  (CAMPAIGN_EXIT=0)
profiler_cli.log, run_baseline_E2.log
tiny_dense_2l_weights.bin  (B7 warm-cache blob written by the harness)
aggregator.txt, verify_g7.txt
```

No existing artifact outside this new directory was created or modified.

---

## 9. Limitations

- **Observed only.** The campaign ran under the machine's already-active power scheme
  (`dfe97760`, Performance Mode); it was captured before and after and is unchanged. No
  power-scheme control was applied and no frequency criterion was used — the retired 5%
  precondition was deliberately **not** reintroduced.
- **Group composition.** E1 and E5 records share one configuration group per benchmark
  (10 records) because `experiment_id` and `affinity` are not part of the production
  grouping key; this is the unchanged production semantics, not a campaign choice.
- **B7 spread is the largest** (max 52.27%); B7 is file-I/O-bound (`warm_cache`), so its
  medians are additionally sensitive to I/O/cache state. Recorded as observed, not adjusted.
- **Worst-pair drivers.** The worst pairs are dominated by individual outlier records within
  a single experiment designation (B6: E1 outlier 359.50 µs and E5 outlier 181.50 µs; B7:
  E5 outlier 5721.90 µs; B9: E5 outlier 260.50 µs / 179.50 µs) rather than a clean
  E1-vs-E5 split. This is reported from the independent recompute; the underlying per-run
  cause of those outlier medians is the subject of the companion investigation
  (`G7_VARIANCE_ROOT_CAUSE.md`).
- **G1–G6 pass** on this store; only G7 fails. The PROFILE and no-CUDA skip records were
  produced by the established production CLIs so the full M0 gate picture is present.
- **No CUDA** on this build: G3 is satisfied through the production skip path
  (`skip_attestation`), not an arbitrary generic SKIPPED result.
- No other limitations were observed during this campaign.

---

## Final required status

G7 FROZEN CONTRACT FAIL — M0 G7 GATE NOT SATISFIED

**M0 status: M0 remains FAIL** (the frozen §G G7 gate is not satisfied by this fresh
current-machine campaign). **M1 remains LOCKED** — this campaign does not modify the M1
lock state and no M1 work is authorized.

---

## Verification output — exit codes

| Step | Command (summary) | Exit |
|---|---|---|
| Campaign | `build-v24-release/g7_campaign.exe --out build/g7-campaign-frozen-20261008 --samples 50 --warmup 10 --runs 5 --threads 1` | **0** |
| Current-machine profile | `profiler_cli` → `P1-PROFILE-24-0` | **0** |
| Structured no-CUDA skip (E2/B4/B5) | `run_baseline.exe --baseline E2` | **0** |
| Production aggregation | `build-v24-release/aggregate.exe --out build/g7-campaign-frozen-20261008` | **1** (G7 FAIL) |
| Independent verifier (original) | `python reports/g7-campaign/verify_g7.py build/g7-campaign-frozen-20261008` | **1** (FAIL; agrees) |
| Independent recompute (this investigation) | `python scripts/recompute_g7_frozen.py` | **0** (recompute OK; verdict FAIL) |
| Frozen-30 integrity before | `verify_frozen30.py` (captured pre-run) | **0** |
| Frozen-30 integrity after | `verify_frozen30.py` (captured post-run) | **0** |
| Power scheme restore | `powercfg /getactivescheme` (unchanged `dfe97760…`) | **0** |

All exit codes were captured from the actual tool runs during the campaign and this
investigation; the production gate and verifier exit 1 because G7 FAILS, which is the
reported result, not a tooling failure.
