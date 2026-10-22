# G7 Feasibility Pair — Pre-registration (written before any build or run)

Date: 2026-10-22 (Asia/Calcutta)
Branch: arena/ae9d3c5a-a-p-e-x
Git HEAD: 83dd10a2a8c0e35c2f00e9684a38e9cac87d1e6e (root commit "63")
Purpose: one (1) pre-registered G7 feasibility pair — two same-config suite
passes — evaluated by the production aggregator/gate evaluator. Not an M0
acceptance submission. No reruns after this pair without documented rationale.

## Frozen rules being tested (verified against source)

- Spec: stark/design/V009_phase1_M0_specification.md §G line 328 (G7):
  "Full re-run of the same suite with same config: every benchmark median within
  ±15% of the recorded median (memory bandwidth ±20%)."
- Production implementation: stark/src/phase1/gates.cpp, G7 block (line ~773):
  groups by serialized `configuration` (benchmark_id, warmup_count,
  measurement_count, thread_count, batch_size, sequence_length, workload_params),
  requires >=2 distinct record_id per group, all-pairs symmetric rel-diff
  |x-y|/max(|x|,|y|) * 100 <= 15.0 (20.0 for bench B3/B5).
- NOT the gate: gates.cpp G7_MEDIAN_TOLERANCE_PCT=0.001 is the stored-vs-recomputed
  median integrity check (verify_median_consistency), an internal consistency rule,
  not the G7 reproducibility tolerance.
- NOT the gate: B7 diagnostic calibration thresholds (2/10/2%) in
  bm_b7_diagnostic.cpp / Phase-33 validator — diagnostic procedure, absent from
  spec §G G1..G8. B7 calibration work is out of scope.

## Baseline determination (task item: do not invent a baseline)

- There is NO external golden-baseline table in the production path. G7 compares
  same-config repeats inside the record store (all-pairs). "The recorded median"
  is the median stored in the earlier record(s) of the group.
- M0_FINAL_ACCEPTANCE.md §3: a NEW baseline is permitted as new evidence (§B:
  n>=10 configurable, >=3 warmup, recorded affinity); none exists today; the
  historical nine (archive_recovery/original_historical_records) permanently
  fail G7-C (16.13-48.04% spreads) and cannot be redeemed.
- Therefore the pair's PASS-1 records ARE the contract-permitted new baseline;
  PASS 2 is the re-run; G7's all-pairs comparison is the gate input. Historical
  medians (B6/B7/B9) will be reported as REFERENCE-ONLY deviations, clearly
  labeled non-gate (cross-machine, cross-epoch).
- B1/B2/B3 (incl. memory bandwidth B3): NO recorded baseline exists in any
  evidence set (verified by inventory of all 616 STARKP1 records). The new pair
  establishes their first baseline via the same frozen mechanism.
- G7CAM records: NOT used (task constraint). Production path run_baseline +
  aggregate only.

## Environment (recorded, identical for both passes)

- Machine: Linux e2b.local 6.1.158+ x86_64 container, nproc=2 (shared host;
  validity caveat vs the original Windows/MSVC dev machine — noted, not hidden).
- Build: g++ -std=c++17 -O2 -DNDEBUG, unmodified production sources
  (STARK_PHASE1_SOURCES + one CLI main each), cmake unavailable in sandbox.
- OS pinning: `taskset -c 0` on every run command (single-CPU pin, both passes
  identical). NOTE: run_baseline does NOT populate configuration.affinity nor
  provenance.affinity (apply_campaign_affinity is called only by G7Campaign) —
  a verified production gap; pinning is external and recorded in run logs.
- thread_count: --threads 1 (spec §B single-thread variant). All-core variant
  is out of scope for this feasibility pair (would form separate config groups).

## Suite scope (identical commands in both passes)

Timed (run per pass):
  run_baseline --baseline E1 --out STORE --threads 1   -> B6,B7,B9 records
  run_baseline --baseline E5 --out STORE --threads 1   -> B6,B7,B9 records
  run_baseline --baseline B1 --out STORE --threads 1   -> B1 (warm=10, meas=30 fixed in code)
  run_baseline --baseline B2 --out STORE --threads 1   -> B2
  run_baseline --baseline B3 --out STORE --threads 1   -> B3

Environment/attestation (run ONCE — verified fixed record_ids P1-E2-skip,
P1-B4-skip, P1-B5-skip, P1-E4-notattempted, P1-PROFILE-*, P1-TELEMETRY-* would
be OVERWRITTEN by a second invocation (RecordStore::append removes+renames);
task forbids overwriting records):
  profiler_cli --out STORE
  run_baseline --baseline E2 --out STORE   (E2/B4/B5 SKIPPED + structured attestation)
  run_baseline --baseline E4 --out STORE   (NOT_ATTEMPTED disposition)

EXCLUDED with rationale:
  E3: no gate (G1-G7) requires it; the project's own gold evidence set
  (stark/reports/v2.3/evidence/v23-valid) omits it; an E3 record carries
  benchmark_id B6 with identical configuration to E1/E5-B6 and would join that
  G7 group (config-block design), adding a different-precision member with no
  mandate. Including it is reserved for the formal acceptance campaign if the
  gate owner requires §E completeness.

## Expected evidence files

STORE = build/results-g7pair-20261022/  (fresh append-only store; historical
stores untouched; B7's tiny_dense_2l_weights.bin scratch input is created new
inside STORE by bench_model_load_time, deterministic content, no overwrite of
any existing artifact).

Expected records after both passes (24 .json):
  P1-PROFILE-<n>, P1-TELEMETRY-<n>                      (1 set)
  P1-E2-skip, P1-B4-skip, P1-B5-skip, P1-E4-notattempted (1 set)
  P1-E1-B6/B7/B9-<h>  x2 passes   (6)
  P1-E5-B6/B7/B9-<h>  x2 passes   (6)
  P1-B1-<h>, P1-B2-<h>, P1-B3-<h> x2 passes             (6)

G7 groups expected: B6 (4 records: E1x2+E5x2), B7 (4), B9 (4), B1 (2), B2 (2), B3 (2).
Record-id collision (<=23 files) => STOP and report (RecordStore would have
overwritten; do not re-run silently).

## Pass/fail calculation (pre-registered)

1. Per group: every record must have >=10 finite raw samples and stored median
   matching recomputed median within 0.001% (gates.cpp internal check).
2. Per group: all-pairs symmetric rel-diff of medians <= 15.0% (B3: <= 20.0%).
   Report each pair; the worst pair is the group verdict.
3. Also report per-benchmark pass2-vs-pass1 median deviation in the
   "100*(new-base)/base" signed form AND the symmetric form, plus
   reference-only deviations vs the historical nine (non-gate).
4. Aggregate: `aggregate --out STORE` and `aggregate --out STORE --strict`;
   G7 PASS requires all groups pass; M0-level "all G1-G8" additionally requires
   G1-G6 PASS and a G8 inventory audit (verified: gates.cpp implements G1-G7
   only; G8 has no automated evaluator — assessed by record inventory).
5. If any benchmark fails: report it; NO immediate rerun.

## Stop rules (from the task, restated)

- Exactly one pair. A second pair requires documented rationale from these results.
- Do not change thresholds/validators/gates/spec; no historical writes; no
  G7CAM records; no M0/M1 state changes; no commits/pushes.
