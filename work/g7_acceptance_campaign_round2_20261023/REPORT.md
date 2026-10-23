# G7 Remediation Round 2 — Report (2026-10-23)

**Classification (pre-registered, PREREGISTRATION.md §Evaluation): 2 — G7 FAIL,
similar outlier recurs.** Evidence supports systematic non-reproducibility of
same-config time-medians under the designated machine/configuration (U1/U2):
both authorized rounds produced exactly one all-core record deviating beyond
the frozen ±15% band against same-config peers in the B6/B7/B9 family, with
the other three records of the group agreeing. M0 remains **FAIL**; M1 remains
**LOCKED**. This round does not accept M0.

## 1. Pre-registration and environment

- `PREREGISTRATION.md` written before any measurement (25-record store state,
  expected 43, fixed commands, classification rules).
- Host: Linux x86_64 container, Intel Xeon @ 2.60GHz, 2 logical CPUs,
  4,131,278,848 bytes RAM (PROFILE record in store; run header in
  `logs/run_log.txt`).
- Build: identical g++ flags/sources as Round 1 (`-std=c++17 -O2 -DNDEBUG
  -include cstring -include sys/statvfs.h`; run_baseline via the 7-rename
  portability shim generated from the committed patched source at `460f295`).
- Configuration (all-core): `taskset -c 0,1`, `--threads 2`; two identical
  passes of `--baseline {E1,E5,B1,B2,B3}`; workload/seed fixed by frozen code.
- E3: one `--disposition` record pre-measurement (`P1-E3-notattempted`,
  NOT_ATTEMPTED, no statistics). E3 never executed.

## 2. Evidence stores and manifests

| Item | Path | Integrity |
|---|---|---|
| Round-2 store (designated, U8) | `build/results/` (43 JSONs) | `logs/SNAP_R2_after_transfer.sha256` (25 pre-existing, verified OK after all appends) + `STORE_MANIFEST.sha256` (43) |
| Round-1 preservation (partial) | `build/results-round1-g7fail-20261022/` (24 JSONs) | `logs/round1_recovered_check.sha256` 24/24 vs Round-1 SNAP0; loss of the 18 all-core + E3 originals disclosed in `ROUND1_STORE_PRESERVATION.md` and ACCEPTANCE_RECORD §10 |
| Feasibility archive (frozen) | `build/results-g7pair-20261022/` | `MANIFEST.sha256` 41/41 OK before and after |
| Round-1 record | `work/g7_acceptance_campaign_20261022/ACCEPTANCE_RECORD.md` | unchanged (git diff vs `affecc4` = 0); cross-reference is this report only |

## 3. Commands and exit codes

Full log `logs/run_log.txt` (timestamps + affinity). PASS 1 and PASS 2
(identical, 10 invocations): `taskset -c 0,1 build/round2_bin/run_baseline
--baseline {E1,E5,B1,B2,B3} --out build/results --threads 2` — all exit 0.
Store: 25 → 34 → 43 records; 0 overwrites. Aggregate normal exit 1, strict
exit 1 (`logs/aggregate_normal.txt`, `logs/aggregate_strict.txt` — full
evaluator output preserved verbatim).

## 4. Gate results and full G7 deviation table

G1 PASS · G2 PASS · G3 PASS (B5 SKIPPED, cuda_unavailable, structured
attestation) · G4 PASS · G5 PASS · G6 PASS · **G7 FAIL** · OVERALL FAIL.

G7 violations (production evaluator, allowed 15.00%):

| Group | Pair | Deviation |
|---|---|---|
| B7 | runs 1–3 | 16.35% |
| B7 | runs 2–3 | **25.50%** |
| B7 | runs 3–4 | 21.83% |

Complete all-core same-config medians (µs) and within-group max pairwise
deviation:

| Group | Medians (record) | Worst pair | Allowed | Result |
|---|---|---|---|---|
| B6 | 311.33 (E1 P1), 299.12 (E1 P2), 296.86 (E5 P2), 294.47 (E5 P1) | 5.73% | 15% | PASS |
| B7 | 3500.37 (E1 P1), 3117.59 (E1 P2), **4184.47 (E5 P2 = outlier)**, 3270.81 (E5 P1) | 25.50% | 15% | **FAIL** |
| B9 | 338.46 (E1 P1), 294.41 (E1 P2), 297.19 (E5 P2), 298.04 (E5 P1) | 13.02% | 15% | PASS (near-miss) |
| B1 | 2409.07, 2355.28 (ms-scale model-load pair) | 2.28% | 15% | PASS |
| B2 | 54.99, 55.15 (ms) | 0.30% | 15% | PASS |
| B3 | 65.76, 67.48 (ms) | 2.64% | 20% | PASS |
| single-thread groups (transferred) | unchanged from Round-1 evaluation | ≤11.62% | 15% | PASS |

Outlier identity (fact): `P1-E5-B7-67375` — the model-load (B7) record of the
PASS-2 E5 invocation, on the **slow** side (4184.47 vs peers 3117–3500 µs).
The same invocation's B6/B9 records were normal. Same E5-pattern check: an
E5 record is again the deviant one (2/2 rounds), but the pattern differs —
Round 1 = one invocation anomalously fast across all three groups
(16.44–22.78%); Round 2 = one record anomalously slow in B7 only
(16.35–25.50%), with B9 near-miss (13.02%).

## 5. §K, §M, G8

- §K: 5/5 PASS — profiler 34, accounting 67, budget 55, records 72,
  reproducibility 37 (265 assertions, 0 failures).
- §M: M1–M10 all PASS as standing properties, verified against this campaign's
  evidence (units, budget↔demand dimensions, theoretical/measured separation,
  exact parameter counts, quantized overhead, no machine-specific assumptions,
  CPU-first/offline, STARK-001..007 untouched, determinism triple, optimizer
  zero-state).
- Manual G8 checklist (U5): PASS — 43/43 records at the designated path
  (38 PASSED / 3 SKIPPED / 2 NOT_ATTEMPTED), all parseable by the production
  reader (aggregate enumerated 43/43, no malformed records), schema-valid,
  append-only (SNAP chain intact), inventory complete.

## 6. Comparison with Round 1

| | Round 1 (2026-10-22) | Round 2 (2026-10-23) |
|---|---|---|
| Verdict | G7 FAIL | G7 FAIL |
| Failing groups | B6, B7, B9 | B7 only |
| Outlier | E5 PASS-1 record (fast, −16…−23% vs peers across 3 groups) | E5 PASS-2 B7 record (slow, +16…+25% vs peers, one group) |
| Other three records | agree ≤6% | agree ≤12% (B7 peers 3117–3500 span 12.3%); B9 near-miss 13.0% |
| G1–G6, G8, §K, §M | all pass | all pass |
| Absolute level | B6 ≈ 200–255 µs | B6 ≈ 294–311 µs (~+30% cross-round drift; G7 is within-round, drift not a gate input) |

Interpretation (within the pre-registered classification, no causal claim):
the single-record-outlier failure mode is **reproducible across both
authorized rounds** while its location/direction is not — consistent with a
variance problem in the all-core measurement path on this host rather than a
one-off transient. Two rounds cannot separate host-noise, scheduling, and
measurement-path causes.

## 7. Verdict and limitations

**Class 2 — G7 FAIL, similar outlier recurs.** Limitations: (a) n=2 rounds;
(b) Round-1 store incompletely preserved (18 records lost to the environment
snapshot policy; aggregates preserved verbatim); (c) no telemetry surrounds
the outlier invocations (U3 accepts external pinning + logs only); (d) B9's
13.02% near-miss indicates the machine's all-core variance sits close to the
frozen band; (e) one successful round would not have proven universal
stability — two failing rounds likewise bound the claim: they show the frozen
±15% contract is not reliably met by this machine/configuration, not why.

## 8. Next recommended action (single)

**Owner decision at the U1 point: designate a different acceptance machine
(and regenerate the acceptance campaign there), or issue a formal G7 scope
revision** — the tolerance must not change and the historical nine remain
preserved. Within the frozen contract as ruled, this machine/configuration has
now failed G7 twice with single-record outliers; a third identical round
would not resolve the remaining uncertainty (cause), it would only re-observe
the class. If the owner prefers diagnosis instead, the one experiment that
separates host-noise from measurement-path causes is a paired re-run with
per-sample timestamps and scheduler telemetry around each invocation (a
change of instrumentation scope requiring authorization — it is not part of
the frozen campaign).
