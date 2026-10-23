# G7 Remediation Round 2 — Pre-Registration (written BEFORE measurements, 2026-10-23)

Status: PRE-REGISTERED. Nothing in this document was edited after measurements
began. Round-1 record (`work/g7_acceptance_campaign_20261022/ACCEPTANCE_RECORD.md`)
is preserved unchanged; verdict there: FAIL on G7 (PASS-1 E5 outlier, B6 median
199.668 µs, deviations 16.44–22.78% vs allowed 15%).

## Question

Is the Round-1 E5 outlier (one anomalously fast all-core invocation) transient
environmental noise or systematic non-reproducibility under the designated
machine/configuration?

## Fixed scope (unchanged frozen contract)

- Authorization: project owner campaign authorization 2026-10-22 + this
  remediation round (A.P.E.X task "G7 Remediation Round 2 ... and Push").
- Scope rulings: U1–U10 + E3 (authorized Q&A 2026-10-22), addendum §5.
- Machine (U1): Linux x86_64 container, Intel Xeon @ 2.60GHz, 2 logical CPUs
  (identical container class as Round 1; exact `cpu_model`/`ram_total_bytes`
  in the PROFILE record of the store).
- Store (U8): fresh `build/results/` (created clean this round; verified absent
  before population). Round-1 partial reconstruction preserved separately at
  `build/results-round1-g7fail-20261022/` (see ROUND1_STORE_PRESERVATION.md).
- Independence (U6): distinct process invocations.
- Affinity (U3): external `taskset` pinning + run-log attestation.
- E3: disposition record only, produced pre-measurement (already done); E3 is
  never executed.
- Thresholds (frozen, V009 L328): same-config time-medians ±15% (B3/B5 group
  ±20%); production evaluator arithmetic governs (U7). **No threshold change.**

## Store state at pre-registration

25 records: 24 archived transfers (hash-verified 24/24 against
`DRYRUN_TRANSFER_MANIFEST.sha256`; single-thread E1/E5/B1/B2/B3 pair, thr=1) +
1 E3 disposition (`P1-E3-notattempted`, NOT_ATTEMPTED, no statistics).
Baseline snapshot: `logs/SNAP_R2_after_transfer.sha256` (25 hashes).

## Campaign (exactly once; identical to Round-1 commands)

- Build: g++ -std=c++17 -O2 -DNDEBUG -include cstring -include sys/statvfs.h
  (identical flags/sources as Round 1; run_baseline via the 7-rename portability
  shim generated from the committed patched source).
- Configuration: `--threads 2`, `taskset -c 0,1` (all-core pair).
- Workload/seed: fixed Phase-1 workloads and seeds (fixed ids/workloads per
  frozen code; identical to Round 1).
- PASS 1 then identical PASS 2, each:
  `taskset -c 0,1 build/round2_bin/run_baseline --baseline {E1,E5,B1,B2,B3} --out build/results --threads 2`
- Expected new records: 18 (6 per E1/E5 invocation — 3 E1-exp + 3 E5-exp — and
  1 per B1/B2/B3 invocation; ×2 passes). Expected store total: **43**.
- No per-record reruns, no selective repeats, no outlier handling of any kind.

## Evaluation (pre-declared)

`build/round2_bin/aggregate --out build/results` and `--strict`; §K five tests;
§M M1–M10; manual G8 checklist. Pre-declared classification:

1. **G7 PASS on Round 2** — fresh store meets all applicable production criteria.
2. **G7 FAIL, similar outlier recurs** — an all-core record again deviates
   >15% against same-config peers in the same all-core groups (B6/B7/B9 family)
   → evidence supports systematic non-reproducibility under U1/U2 config.
3. **G7 FAIL, different failure pattern** — report the new pattern, no causal
   claim.
4. **INCONCLUSIVE** — insufficient evidence for 1–3.

Success would establish G7 for this store only; it does not prove universal
stability, and it does not by itself accept M0 (full contract + sign-off still
required). Failure of class 2 would make the U1 machine designation the
decision point for the owner (tolerances must not change).

## Stop conditions (as authorized)

Hash mismatch; unexpected record in store; overwrite risk; required test
failure; configuration conflict with the frozen contract.
