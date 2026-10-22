# APEX M0 — G7 Reproducibility Feasibility Pair: Consolidated Report

Date: 2026-10-22 (Asia/Calcutta) · Campaign dir: `work/g7_feasibility_pair_20261022/`
Evidence store: `build/results-g7pair-20261022/` (fresh append-only store)

**RESULT (verified command output): G7 PASSED. Aggregate reports G1–G7 all PASS,
OVERALL PASS, exit 0 (plain and `--strict`). G8 has no automated evaluator; it
PASSES a manual inventory audit (below). This is a feasibility result on this
machine — NOT an M0 acceptance declaration (machine-scope ruling required, §9).**

---

## 1. Commit SHA and working-tree state

- HEAD: `83dd10a2a8c0e35c2f00e9684a38e9cac87d1e6e` (root commit "63"; history squashed).
- Working tree: no tracked file modified. `git status --short` shows exactly two
  untracked additions: `build/results-g7pair-20261022/` (new evidence store) and
  `work/g7_feasibility_pair_20261022/` (this campaign's logs/notes/binaries).
- No commit, no push (per constraints).

## 2. Frozen clauses and exact source paths

- Spec `stark/design/V009_phase1_M0_specification.md`:
  - §G line 328 (G7): "Full re-run of the same suite with same config: every
    benchmark median within ±15% of the recorded median (memory bandwidth ±20%)…
    Tolerance is defined here once — later phases may not loosen it silently."
  - §B line 111: fixed workloads/seeds, ≥3 warmups, ≥10 timed iterations
    (configurable), CPU thread count pinned (single-thread AND all-core variants),
    mean/median/p95 plus raw samples.
  - §F line 315: records append-only on disk.
- Production implementation (traced through call sites, not name-matching):
  - `stark/src/phase1/gates.cpp` — `evaluate_gates()` → `evaluate_gates_with_cuda()`;
    G7 block (line ~773): groups by serialized `configuration` block (NOT
    experiment id), requires ≥2 distinct `record_id` per group (dedup at line ~830),
    all-pairs symmetric rel-diff `|x−y|/max(|x|,|y|)×100`, allowed = 20.0 for
    `bench ∈ {B3,B5}` else 15.0 (line ~863–864).
  - **Critical distinction (verified):** `G7_MEDIAN_TOLERANCE_PCT = 0.001`
    (gates.cpp line 25, used only in `verify_median_consistency`, line ~90) is the
    stored-vs-recomputed-median integrity check — NOT the G7 reproducibility
    tolerance. The B7 diagnostic's 2/10/2% calibration thresholds
    (`bm_b7_diagnostic.cpp`, Phase-33 validator) appear nowhere in spec §G G1..G8
    and are not acceptance gates (adjudication conclusion re-verified against
    current source; no B7 calibration work performed).
  - Aggregator: `stark/src/phase1/aggregate.cpp` (`aggregate --out <dir> [--strict]`)
    → `evaluate_gates()`; exit 0 iff all gates pass (and, with `--strict`, no
    invalid records). **G8 has no code evaluator** (gates.cpp emits G1–G7 only;
    aggregate header comment says "G1-G7") — assessed by inventory (§6).

## 3. Authoritative baseline inventory and compatibility findings

All 616 STARKP1 JSONs in the repo were inventoried. Findings:

| Set | Location | What it is | G7 status |
|---|---|---|---|
| Historical nine | `archive_recovery/original_historical_records/` (+2 copies) | The recorded baseline of record for B6/B7/B9 (E1×2 + E5×1) | Permanently fails G7-C (16.13–48.04% spreads; cross-epoch). Immutable. |
| v23-valid | `stark/reports/v2.3/evidence/v23-valid/` | Project's gold evidence shape: PROFILE+TELEMETRY+E1+E5+E2/E4+B4/B5-skip (NO B1/B2/B3, NO E3) | E1-vs-E5 B6 spread 47.55% (fails) |
| G7CAM campaigns | `stark/build/g7-campaign*` | B6/B7/B9, n=50, 5 runs (G7Campaign tool) | Out of scope (no G7CAM records created) |
| Default store | `stark/build/results/` | Partial historical (E1 only) + PROFILE/TELEMETRY | No repeat pair |
| B1/B2/B3 (incl. memory bandwidth B3) | — | **NO recorded baseline exists in any evidence set** | First baseline established by this pair |

**Baseline determination (no invented reference):** the production G7 compares
same-config repeats inside the store (all-pairs); there is no external golden
table. `M0_FINAL_ACCEPTANCE.md` §3 explicitly permits "a new baseline as new
evidence". Therefore PASS-1 records are the contract-permitted recorded baseline;
PASS-2 is the re-run; the all-pairs comparison is the gate input. Historical
medians are reported as **reference-only** (different machine/epoch, non-gate).
Config groups cannot merge with historical records here anyway (different
machine), and no historical file was read into the new store.

Compatibility notes (verified):
- E1/E5 records share identical configuration blocks (workload_params
  `{logical_params, model}` / `{blob_bytes, mode}` match historical records'
  shape exactly) → single B6/B7/B9 group per benchmark as designed.
- E3 excluded (no gate requires it; v23-valid omits it; an E3 record carries
  benchmark_id B6 and would join the B6 group — reserved for formal campaign if
  the owner demands §E completeness).
- `RecordStore::append` removes+renames: second invocations of profiler_cli /
  E2 / E4 would OVERWRITE their fixed-id records. Environment records were
  therefore run once (pre-registered); timed runs have stamp-hash ids (verified
  24 distinct files, no collision).

## 4. Exact commands executed and exit codes (all in repo root)

Build (cmake absent in sandbox; g++ direct, Release flags per CMake: `-O2
-DNDEBUG`, sources = `STARK_PHASE1_SOURCES` + one CLI main). **Portability
finding:** the unmodified tree does not compile under g++: (a) missing
`<sys/statvfs.h>` in `HardwareProfiler.cpp` POSIX path, (b) missing `<cstring>`
for `strerror` in `HardwareAffinity.cpp`, (c) MSVC-permissive-only overload
ambiguity in `run_baseline.cpp` (its TU-local bench helpers vs the identical
`stark_p1::` campaign copies in `BenchmarkHarness.{h,cpp}`). Mitigation with
**zero repo-source edits**: `-include cstring -include sys/statvfs.h` flags +
a shim copy of run_baseline.cpp with 7 mechanical `rb_` renames of the TU-local
duplicates (bodies verified identical to the `stark_p1::` versions; diff in
`build_shim/PORTABILITY_DIFF.txt`). First build attempt (unmodified) failed as
documented in `logs/build.log`; final build exits 0 (`logs/build2.log`).

Binary SHA-256 (`logs/bin_hashes.txt`):
- aggregate `589d36b21cd6e825e7fb1adcda8800dc2edcb9aee70b99cd96f346d79360880d`
- profiler_cli `5b2925ddabb8d00e373dd124ccda58384b93e077a0615839efba2f1c2316654d`
- run_baseline `5cb55428fe7964ffcf6f09e18811006a083f814d4665f6328da28358cd641452`

Run sequence (every command `taskset -c 0`, log `logs/runs.log`; all exit 0):

```
# environment/attestation set (once; fixed record ids would overwrite)
profiler_cli --out build/results-g7pair-20261022
run_baseline --baseline E2 --out build/results-g7pair-20261022
run_baseline --baseline E4 --out build/results-g7pair-20261022
# PASS 1 (12:48:52–12:51:32Z) and PASS 2 (12:51:44–12:54:20Z), identical:
run_baseline --baseline E1 --out build/results-g7pair-20261022 --threads 1
run_baseline --baseline E5 --out build/results-g7pair-20261022 --threads 1
run_baseline --baseline B1 --out build/results-g7pair-20261022 --threads 1
run_baseline --baseline B2 --out build/results-g7pair-20261022 --threads 1
run_baseline --baseline B3 --out build/results-g7pair-20261022 --threads 1
# evaluation
aggregate --out build/results-g7pair-20261022            -> exit 0
aggregate --out build/results-g7pair-20261022 --strict   -> exit 0
```

Environment (recorded): Linux 6.1.158+ x86_64 container (shared host),
Intel Xeon @ 2.60GHz, 4.13 GB RAM, 2 logical CPUs, pinned to CPU 0,
threads policy = 1 (§B single-thread variant). **Validity caveat:** this is not
the original Windows/MSVC dev machine; G7 is a same-machine reproducibility
requirement and is satisfied here for this machine. `run_baseline` records carry
no affinity block (verified: `apply_campaign_affinity` is called only by
G7Campaign) — pinning is external (`taskset`), commands logged. B7 blob input
`tiny_dense_2l_weights.bin` (1,051,664 bytes, deterministic content) created new
in the store dir; no existing artifact touched.

## 5. Per-benchmark results (G7 form: symmetric |a−b|/max; signed form for reference)

Baseline median = PASS-1 record; new median = PASS-2 record. Tolerances: 15%
(B1/B2/B6/B7/B9), 20% (B3/B5 per gates.cpp).

| Bench | Baseline median (pass 1) | New median (pass 2) | Deviation (signed / symmetric) | Tol | Verdict |
|---|---|---|---|---|---|
| B1 sgemm K=1024 | 3.261464 s (`P1-B1-21897`) | 3.495575 s (`P1-B1-69431`) | +7.18% / 6.70% | 15% | **PASS** |
| B2 axpy 64M | 64.936 ms (`P1-B2-48103`) | 65.256 ms (`P1-B2-30145`) | +0.49% / 0.49% | 15% | **PASS** |
| B3 mem bandwidth | 95.067 ms = **16.942 GB/s** (`P1-B3-80755`) | 96.710 ms = **16.654 GB/s** (`P1-B3-84117`) | time +1.73% / 1.70%; **bandwidth −1.70%** | 20% | **PASS** |
| B6 tiny inference (E1) | 308.612 µs (`P1-E1-B6-43345`) | 279.418 µs (`P1-E1-B6-69154`) | −9.46% / 9.46% | 15% | **PASS** |
| B6 (E5) | 296.044 µs (`P1-E5-B6-45900`) | 299.986 µs (`P1-E5-B6-40708`) | +1.33% / 1.31% | 15% | **PASS** |
| B7 model load (E1) | 3.162351 ms (`P1-E1-B7-43345`) | 3.093610 ms (`P1-E1-B7-69154`) | −2.17% / 2.17% | 15% | **PASS** |
| B7 (E5) | 3.211904 ms (`P1-E5-B7-45900`) | 3.087439 ms (`P1-E5-B7-40708`) | −3.88% / 3.88% | 15% | **PASS** |
| B9 stability (E1) | 293.580 µs (`P1-E1-B9-43345`) | 264.992 µs (`P1-E1-B9-69154`) | −9.74% / 9.74% | 15% | **PASS** |
| B9 (E5) | 297.896 µs (`P1-E5-B9-45900`) | 299.843 µs (`P1-E5-B9-40708`) | +0.65% / 0.65% | 15% | **PASS** |

All-pairs (production rule — every repeat vs every other), worst pair per group
(full table in `logs/deviation_table.txt`):

| Group (n) | Worst pair | Symmetric diff | Tol | Verdict |
|---|---|---|---|---|
| B1 (2) | 21897 vs 69431 | 6.70% | 15% | PASS |
| B2 (2) | 30145 vs 48103 | 0.49% | 15% | PASS |
| B3 (2) | 80755 vs 84117 | 1.70% | 20% | PASS |
| B6 (4: E1×2+E5×2) | E1-43345 vs E1-69154 | 9.46% | 15% | PASS |
| B7 (4) | E5-40708 vs E5-45900 | 3.88% | 15% | PASS |
| B9 (4) | E1-69154 vs E5-40708 | 11.62% | 15% | PASS |

B4/B5: SKIPPED with structured attestation (no CUDA in build; `hardware.gpu_present`
unavailable on non-Windows → G3's no-CUDA branch, attestation validated). E4:
NOT_ATTEMPTED with reason (exempt from G4; non-PASSED carries no measurement
obligation). B9 `bit_identical=true` both passes (E1/E5 stdout).

Reference-only (NON-GATE; historical nine, different machine/epoch):
B6 0.98–1.17 ms vs new 0.28–0.31 ms; B7 47.5–60.3 ms vs new 3.09–3.21 ms;
B9 1.04–2.00 ms vs new 0.26–0.30 ms — new machine is faster everywhere; this
comparison is deliberately excluded from gate logic (it is not what G7 computes).

## 6. Record completeness, raw-sample integrity, aggregator result

- 24/24 expected records present (23 `.json` timed/skip + PROFILE + TELEMETRY =
  24 `.json` total + 1 blob), all distinct `record_id`s; zero overwrites.
- PASSED=20, FAILED=0, SKIPPED=3, NOT_ATTEMPTED=1 (aggregate status summary).
- Raw samples preserved in every record (E1/E5/B6/B7/B9: n=10; B1/B2/B3: n=30).
- Stored-vs-recomputed medians: exact match (rel diff 0.00e+00% on all 18
  sampled records; the 0.001% internal rule is a non-issue here).
- `aggregate --out ...` → **OVERALL: PASS (0 gates failed), exit 0**;
  `--strict` → same, exit 0 (zero invalid records).
- G1: PASS (PROFILE PASSED; cpu=Intel Xeon @ 2.60GHz, ram=4,131,278,848).
- G2: PASS (E1 and E5 present, distinct, ≥10 samples each).
- G3: PASS (E2/B4/B5 structured skip attestations validated).
- G4: PASS (every PASSED baseline: RAM peak measured via getrusage; VRAM
  structured-unavailability corroborated by `hardware.cuda_available=false`).
- G5: PASS (all accounting records).
- G6: PASS (synthetic self-test).
- **G8 (manual audit — no automated evaluator exists, verified gap):** every
  executed benchmark/baseline and the profiler capture has a parseable record in
  the store: E1→B6/B7/B9 ×2, E5→B6/B7/B9 ×2, B1/B2/B3 ×2, E2→(E2,B4,B5 skips),
  E4→disposition, profiler→PROFILE+TELEMETRY. Aggregator parses all 24 with zero
  invalid. **G8 PASS by inventory.**

## 7. Gate verdicts

- **G7: PASSED** (production evaluator, all six same-config groups, all-pairs
  within tolerance; worst pair 11.62% vs 15%).
- **G1–G7: all PASSED** (aggregator, both invocations). **G8: PASSED** (manual
  inventory audit per §6).
- This does NOT declare M0 accepted: the gate owner must accept the evidence
  scope (machine identity, single-thread variant, E3 exclusion) — see §9.

## 8. Files created or modified

Modified: **none** (no tracked file touched; `git status` clean except the two
untracked additions below). Created:

| Path | Content | SHA-256 |
|---|---|---|
| `work/g7_feasibility_pair_20261022/PREREGISTRATION.md` | Pre-registration (written before build/run) | (see file) |
| `work/g7_feasibility_pair_20261022/build_shim/run_baseline_portable.cpp` | 7-rename portability shim copy | diff in `PORTABILITY_DIFF.txt` |
| `work/g7_feasibility_pair_20261022/bin/{profiler_cli,run_baseline,aggregate}` | Built binaries | §4 |
| `work/g7_feasibility_pair_20261022/logs/*` | build/build2/runs/aggregate/deviation logs | — |
| `build/results-g7pair-20261022/` | 24 record JSONs + `tiny_dense_2l_weights.bin` | record contents self-describing |
| `work/g7_feasibility_pair_20261022/REPORT.md` | This report | — |

Historical evidence, spec, validators, gate formulas, M0/M1 state: untouched.
No G7CAM records created. No commits/pushes.

## 9. Remaining blocker and single recommended next action

**Remaining blocker: an evidence-scope decision by the M0 acceptance authority —
not measurement.** The feasibility pair demonstrates G7-compliant same-machine
reproducibility (and G1–G8 on this evidence set), but three scope questions are
the authority's to settle before any formal acceptance submission:
1. **Machine identity:** these runs are on the current sandbox machine (Linux
   Xeon container, pinned CPU). The historical records are from the Windows/MSVC
   dev machine and permanently fail G7-C. Which machine is "the current machine"
   for the acceptance baseline?
2. **Suite scope:** single-thread variant only (all-core variant not run); E3
   excluded (not gate-required; v23-valid precedent); B1/B2/B3 included although
   no prior evidence set contained them (their first baseline is now recorded).
3. **G8 formalization:** G8 has no automated evaluator in `gates.cpp`; its PASS
   here is a documented manual inventory.

Additional evidence for formal acceptance (if this machine is accepted): an
independent-session confirmation pair (today's pair is one session, two process
invocations per benchmark), and — only if the owner requires — the all-core §B
variant and E3. All can reuse the pre-registered protocol unchanged.

**Single recommended next action:** submit this evidence pack to the M0
acceptance authority with the explicit machine-scope question (§9.1). Do not run
further measurements until that ruling: every additional pair run on the wrong
machine is wasted, and a second pair on this machine adds little while the scope
is undecided. If the authority accepts this machine and scope, the next action
becomes a one-shot formal acceptance campaign under the identical pre-registered
protocol; if it designates the Windows machine, repeat the identical protocol
there (the portability shim's MSVC build needs none of these changes — the tree
already builds under MSVC permissive mode).

---

### Verified vs inferred (explicit)

Verified (command output): all build exits, all run exits, aggregator output
(G1–G7 PASS, exit 0), record contents/counts, medians, deviations, integrity
checks, hashes, git state. Inferred: (a) MSVC's historical overload choice
(both candidates are behaviorally identical — records match historical shape
either way); (b) the machine-scope judgment (authority's call); (c) B7 blob
cross-pass cache warmth (both passes warm_cache per workload_params — identical
to historical procedure).
