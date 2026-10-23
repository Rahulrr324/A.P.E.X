# C1 Decision Note — 2026-10-23 (uncommitted; awaiting owner authorization)

## Conformance verification answers (verified against source at `f0eeef1`)

1. **Operational meaning of V009 §B:** B6 (L122) "single-stream latency
   distribution over N=200 inferences" = the reported distribution must be
   formed from 200 timed single-stream inferences. B9 (L125) "Same input 200×;
   report p50/p95/p99" = 200 timed repeats of one input, percentiles over
   those 200, plus the determinism triple.
2. **`measurement_count = 200` satisfies both** — B6: 3 warmups + 200 timed
   forwards, statistics over 200 (median/p95/p99 already emitted). B9: 3
   warmups + 200 timed identity-checked forwards (203 compared outputs ≥ 200
   under any reading of "200×"). **No separate B9 structural fix is needed**;
   its `"repeats":"200"` metadata becomes truthful automatically. Suggested
   cosmetic: update the uncertain comment (run_baseline.cpp L282).
3. **`repeats: 200` vs 13 forwards = both defects.** Inaccurate metadata
   (BenchmarkHarness.cpp L327–330 writes "200" unconditionally; run_benchmark
   executes warmup_count+measurement_count = 13) **and**, if the table governs,
   a workload defect. The L282 comment ("200 repeats handled by repeated
   measurement? spec: 200 inferences") records the implementer's uncertainty.
4. **Effect scope:** all three E1/E5 records (B6, B7, B9) via `make_cfg`
   (run_baseline.cpp L253–262, used at L269). B1/B2/B3 are protected by their
   own overrides (L312–314: warmup 10, measurement 30 — already applied "so
   the median is stable run-to-run (G7)"), verified in records (B1 config
   measurement_count=30). E3's execution block (L442) would inherit 200 but E3
   is disposition-only. Warm-up counts unchanged; timing boundaries unchanged;
   aggregation unchanged. **Grouping:** `measurement_count` IS part of the
   evaluator's group key (`configuration.dump()`; verified in record keys), so
   n=200 records form their own groups; a **fresh store is still required**
   because any retained n=10 failing group makes G7 fail for the store.
   *(This corrects the claim in G7_ROOTCAUSE_INVESTIGATION §4 that
   measurement_count is not part of Configuration — the operational conclusion
   (fresh store) is unchanged, the mechanism differs.)*
5. **B7 warm AND cold cache (V009 L123): NOT satisfied by C1.** Implementation
   measures warm only (`mode: "warm_cache"`, BenchmarkHarness.cpp L310; no
   cold-cache code exists). Separate unresolved conformance issue (D3) —
   spec authority must authorize a cold-cache variant or annotate the row.
6. **§B general line vs table:** they can both be satisfied — "≥10 timed
   iterations (configurable)" (L111) is a floor; "N=200/200×" is the fixed
   workload size; running 200 conforms to both. What the spec authority must
   clarify (not resolved here): whether the table's N is normative — which
   would characterize rounds 1–2 as under-sized workloads — or the ≥10
   configurable floor governs sampling, in which case rounds 1–2 were
   conformant but under-powered. C1 is conformant either way.

## Minimal diff (prepared, NOT applied)

```diff
--- a/stark/src/phase1/baselines/run_baseline.cpp
+++ b/stark/src/phase1/baselines/run_baseline.cpp
@@ L256 (inside make_cfg)
-        c.measurement_count = 10;
+        c.measurement_count = 200;   // V009 §B L122/L125: N=200 (B6), 200× (B9)
```
Optional cosmetic: replace the L282 comment with "B9: stability; 200 timed
repeats per V009 §B (L125)".

## Requirements satisfied / not satisfied

Satisfied: B6 N=200; B9 200× + p50/p95/p99 (already emitted); §B ≥10 floor;
G2 ≥10; warmup ≥3; frozen thresholds/gates/evaluator untouched; B1–B3
workloads unchanged. Not satisfied: B7 cold-cache (D3, separate); spec-authority
clarification of §B table-vs-floor (Q6) outstanding.

## Expected effect on G7 (evidence-based, NOT guaranteed)

Record medians would span ~2–6 s windows instead of ~50 ms; the observed host
plateaus (~60 ms, F1/F4 of the investigation) would occupy a minority of
samples instead of defining the median. The B1/B2/B3 comment block shows the
same strategy already stabilizing those groups. Expected: G7 PASS is likely on
a fresh store if host states remain sub-second; **not guaranteed** — sustained
multi-second states can still fail the frozen ±15%.

## Approval requirement

**Yes — owner authorization required** (benchmark-methodology change; no
authorization exists as of this note: PR #2 has 0 reviews/comments; the
current task is explicitly conditional). Exact wording needed:

> "I authorize C1 as scoped in `work/C1_DECISION_NOTE_20261023.md`: the
> one-line `measurement_count 10→200` change in `make_cfg` (plus the L282
> comment cleanup), §K regression, and one fresh-store acceptance campaign
> (both variants per U2, E3 disposition-only, frozen gates/thresholds)."

Status: M0 = FAIL; M1 = LOCKED; nothing signed; no source changed.
