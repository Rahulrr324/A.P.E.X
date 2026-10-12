# G7 Campaign Rerun (Affinity-Fix) — Report

**Campaign ID:** G7CAM-AF2-20261006
**Date:** 2026-10-06
**Objective:** Exactly ONE controlled G7 rerun under the corrected production
affinity instrumentation (`DWORD_PTR(1) << i` enumeration fix).

---

## 1. Campaign identity and storage

| Item | Value |
|---|---|
| Command | `g7_campaign.exe --out build/g7-campaign-affinityfix --samples 50 --warmup 10 --runs 5 --threads 1` |
| New campaign directory | `build/g7-campaign-affinityfix/` (30 records + `campaign_run.log` + `tiny_dense_2l_weights.bin`) |
| Config (pre-measurement, frozen) | `reports/g7-campaign-affinityfix/campaign_config.json` |
| Campaign log | `build/g7-campaign-affinityfix/campaign_run.log` (exit marker `CAMPAIGN_EXIT=0`) |
| Record time span | `2026-10-06T12:18:02.699Z` .. `2026-10-06T12:20:05.355Z` |
| Independent runs | 5 (30 s inter-run delay), 6 executions per run = 30 records |
| Design | E1/E5 × B6/B7/B9 × 5 runs, n=50, warmup=10, thread_count=1 |

Frozen constraints NOT changed: G7 formula, symmetric relative-difference
definition, 15%/20% tolerances, grouping key (`r.configuration.dump()`),
benchmark identity, E1/E5 definitions, warmup/sample requirements, frozen 30
records, frozen campaign manifest and its hashes. The frozen 30 records live in
`build/g7-campaign/` and were never written to by this campaign (separate store).

## 2. Pre-campaign regression (after instrumentation edits, before launch)

| Check | Result | Exit |
|---|---|---|
| `ctest -R "affinity\|records\|gates"` | 100% passed, 3/3 | 0 |
| `test_phase1_affinity` | 56 assertions, 0 failures | 0 |
| `test_phase1_records` | 72 assertions, 0 failures | 0 |
| `test_phase1_gates` | 437 assertions, 0 failures | 0 |
| Frozen-30 verification (pre-campaign) | 30/30 SHA match, manifest unchanged | 0 |

The only source change between the affinity fix and this campaign was
additive instrumentation capture (raw API evidence fields + the campaign's
stop-if-not-truthful check). No formula, tolerance, grouping, sample, or
benchmark code changed.

## 3. Frozen-30 verification (pre AND post campaign)

```
manifest record_count = 30
records on disk = 30
SHA matches: 30/30
evidence_manifest.json sha actual   = 7a8dd9de17c4effdc9153ac4505a6f6f95ed662ef204cab52ad279c4bf01fc5a
evidence_manifest.json sha (frozen) = 7a8dd9de17c4effdc9153ac4505a6f6f95ed662ef204cab52ad279c4bf01fc5a
FROZEN RECORD VERIFICATION: PASSED  (exit 0, run both before and after the campaign)
```

No missing records, no unexpected replacements, manifest hash unchanged.

## 4. Per-run affinity evidence (all 30 runs)

Extracted from `provenance.affinity` in every record
(`reports/g7-campaign-affinityfix/verify_affinity_evidence.py`, exit 0;
verbatim per-row table preserved in `affinity_evidence.txt`):

| Field | Value in ALL 30 records |
|---|---|
| requested_cpu | 0 |
| set_api_return (raw `SetProcessAffinityMask` return) | 1 (SUCCESS) |
| set_api_last_error (`GetLastError` after set) | 0 |
| raw_process_mask (post-set) | 1 (0x1) |
| raw_system_mask | 4095 (0xFFF) |
| effective_logical_cpus (production query) | [0] |
| query_ok | true |
| verified_single_cpu (production verification) | true |

`records with truthful single-CPU evidence: 30/30 — AFFINITY EVIDENCE CHECK: PASSED`.
The campaign also enforced this live: each run printed an `affinity_evidence`
line and the runner throws (stopping the campaign) if any run fails the
truthful-single-CPU predicate. No stop occurred; `CAMPAIGN_EXIT=0`.

## 5. Verdicts

### Production aggregator (`aggregate --out build/g7-campaign-affinityfix`, exit 1)

| Gate | Result | Detail |
|---|---|---|
| G1 | FAIL | no PROFILE record (campaign-store scope; same as prior campaign) |
| G2 | PASS | E1 and E5 present, distinct, each >=10 samples |
| G3 | FAIL | E2 record missing (campaign-store scope; same as prior campaign) |
| G4 | PASS | every PASSED baseline: RAM measured; VRAM measured/structured unavailability |
| G5 | PASS | all accounting records consistent |
| G6 | PASS | VRAM-only violation detected; compute informational |
| G7 | FAIL | B6 pairs up to 50.17%, B9 pairs up to 18.66% (allowed 15.00%) |
| overall | **FAIL (3 gates failed)** | `reports/g7-campaign-affinityfix/aggregator.txt` |

### Independent verifier (`verify_g7.py build/g7-campaign-affinityfix`, exit 1)

```
=== Independent G7 verdict: FAIL ===
benchmark n_runs  tolerance  max_diff   min_diff   cv%       verdict
B6       10      15.0       50.1666%   0.0227%    26.79     FAIL
B7       10      15.0       13.1327%   0.0599%    5.53      PASS
B9       10      15.0       18.6597%   0.0226%    8.60      FAIL
```

(`reports/g7-campaign-affinityfix/verifier.txt` contains all 45 pairwise
differences per group verbatim.)

### Agreement check (`compare_verdicts.py`, exit 0)

```
Aggregator G7 (production gates.cpp): FAIL
Independent G7 (verify_g7.py):        FAIL
AGREE: aggregator and independent calculator match
```

## 6. Per-group medians (grouping key = serialized configuration; 10 runs each = 5 E1 + 5 E5)

Chronological order (independent run 1..5, E1 then E5 within each run), medians in µs:

| run | B6/E1 | B6/E5 | B7/E1 | B7/E5 | B9/E1 | B9/E5 |
|---|---|---|---|---|---|---|
| 1 | 181.15 | 179.50 | 2925.55 | 2999.20 | 180.40 | 180.25 |
| 2 | 360.20 | 219.85 | 3341.65 | 3326.35 | 220.85 | 191.40 |
| 3 | 219.60 | 219.90 | 3249.00 | 3230.90 | 221.35 | 221.40 |
| 4 | 221.45 | 221.20 | 3207.25 | 3337.20 | 220.20 | 221.60 |
| 5 | 337.00 | 185.75 | 2902.80 | 3339.65 | 219.60 | 220.80 |

Group summaries (config groups; all-pairs rule; tolerance 15.0% timing):

| group | n runs | medians (µs) | max pair | min pair | cv | verdict |
|---|---|---|---|---|---|---|
| B6 (E1+E5, one config group) | 10 | 179.50, 181.15, 185.75, 219.60, 219.85, 219.90, 221.20, 221.45, 337.00, 360.20 | 50.1666% | 0.0227% | 26.79% | **FAIL** |
| B7 (E1+E5, one config group) | 10 | 2902.80, 2925.55, 2999.20, 3207.25, 3230.90, 3249.00, 3326.35, 3337.20, 3339.65, 3341.65 | 13.1327% | 0.0599% | 5.53% | **PASS** |
| B9 (E1+E5, one config group) | 10 | 180.25, 180.40, 191.40, 219.60, 220.20, 220.80, 220.85, 221.35, 221.40, 221.60 | 18.6597% | 0.0226% | 8.60% | **FAIL** |

Stored medians matched independently recomputed medians for all 30 records
(0 rejected records; median-consistency tolerance 0.001%).

Worst pairs per group:

- B6: (5,6) 50.1666%, (1,5) 49.7085%, (3,6) 46.7359%, (1,3) 46.2463%, (4,5) 38.5203%
- B7: (3,5) 13.1327%, (3,8) 13.0807%, (3,9) 13.0169%, (5,6) 10.2479%, (6,8) 10.1942%
- B9: (6,9) 18.6597%, (1,9) 18.5921%, (6,7) 18.5863%, (2,6) 18.5679%, (1,7) 18.5185%

## 7. G1–G8 / M0 / M1 status

- **G1–G8 all pass? NO.** G7 FAIL on the new evidence (plus G1/G3, which are
  store-scoped to a campaign-only directory containing only E1/E5 records —
  identical to the previous campaign's store composition).
- G8 (store completeness/parseability): all 30 records parse and validate; 0
  invalid records in the store (see unexpected conditions below for the
  config-file incident).
- **M0: FAIL** — G7 remains unsatisfied; this rerun did not pass.
- **M1: LOCKED** — unchanged; no M1 work performed or started.
- The full G1–G8 acceptance aggregation conditioned on a G7 PASS was therefore
  NOT triggered.

## 8. Unexpected conditions encountered

1. **`campaign_config.json` counted as an invalid record.** The documentation
   config was initially written into the record directory; the first aggregator
   run reported `campaign_config.json: missing key 'schema_version'` (1 invalid
   record). The file is not a measurement artifact — it was relocated to
   `reports/g7-campaign-affinityfix/campaign_config.json`. Only the aggregator
   and verifier were re-run afterwards (both are required outputs); **no
   campaign re-run, no record touched, no measurement code changed.** The G7
   verdict is identical before and after the relocation.
2. **No campaign stop occurred** — all 30 runs met the truthful-single-CPU
   predicate on the first attempt.

## 9. Remaining reproducibility cause (read-only analysis, before any future campaign)

`reports/g7-campaign-affinityfix/analyze_spread.py` (exit 0; verbatim output
preserved in `spread_analysis.txt`) shows the spread is
**structured, not random**, and NOT an affinity artifact:

1. **Two dominant performance levels per benchmark**, persisting across both E1
   and E5 within an independent run:
   - B9: ~180.3 µs (run 1) vs ~220–221.6 µs (runs 2–5) → ~22% step
   - B7: ~2903–2999 µs vs ~3207–3342 µs → ~12% step
   - B6: ~179.5–185.8 µs vs ~219.6–221.5 µs → ~23% step
   The step ratios (≈1.22–1.24×) are consistent with a CPU core moving between
   turbo and base frequency states (power/frequency scaling), which the frozen
   campaign config explicitly lists as **not guaranteed**
   (`power_state_guaranteed: false`). Affinity is pinned and verified
   (effective=[0], raw mask 0x1 in 30/30 runs), so **core migration is ruled
   out** as a cause.
2. **Two extreme B6 outliers** (360.20 µs run 2, 337.00 µs run 5 — both the
   FIRST measurement after each 30 s inter-run idle gap) push B6's max spread
   to 50.17%. Both occurred on the E1 execution immediately after idle,
   consistent with a frequency-ramp / C-state-exit transient on the pinned
   core rather than a measurement defect.
3. **B6 within-run E1-vs-E5 disagreement** (38.96% run 2, 44.88% run 5, all
   others <1%) is driven entirely by those two E1 outliers.
4. **B9's failure is a pure level-shift**: every run 2–5 pair vs run 1 sits at
   17.85–18.66%; within any single level, pairs are <1%.
5. Affinity instrumentation is exonerated: the fixed production path reports
   and verifies CPU 0 for every run, and the previous `[0,32]` artifact does
   not exist in this data (fabricated CPUs absent from all 30 records).

**Conclusion:** G7 FAIL is a genuine measurement outcome under the frozen
rule set, caused by uncontrolled CPU frequency/power-state transitions
(including first-execution-after-idle transients) on the pinned core — not by
affinity, thresholds, grouping, or sample handling. No threshold, formula,
grouping, tolerance, or frozen record was changed, and the frozen 30 remain
byte-identical. Per the frozen process, this cause must be addressed (e.g.,
locked performance state) before any further campaign is proposed.
