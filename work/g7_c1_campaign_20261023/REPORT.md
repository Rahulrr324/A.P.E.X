# C1 Campaign Report — 2026-10-23 (fresh store `build/results-c1-20261023/`)

**Verdict: G7 FAIL (new pattern). M0 remains FAIL; M1 remains LOCKED.**
Authorization: owner 2026-10-23 (C1 scope: measurement_count 10→200 +
L282 comment, §K regression, one fresh-store campaign both variants, E3
disposition-only, frozen gates/thresholds, normal+strict, §M, manual G8).

## 1. Change applied and regression

`run_baseline.cpp`: `make_cfg` `measurement_count` 10→200 + L282 comment
cleanup — git diff exactly 2 insertions / 2 deletions (authorized scope only).
§K regression **5/5 PASS** (265 assertions). Historical evidence untouched
(Round-1/Round-2 stores and archives preserved; manifests intact).

## 2. Campaign execution

Fresh store `build/results-c1-20261023/` (Round-2 `build/results/` left
untouched as tracked evidence — U8 literal-path nuance in the gaps note).
43/43 expected records; zero overwrites (SNAP 7/7 after every append); env set
ONCE (PROFILE/TELEMETRY/E2/B4/B5/E4) + E3 disposition (`P1-E3-notattempted`,
NOT_ATTEMPTED, no statistics; E3 never executed). Both variants per U2:
single-thread (`--threads 1`, `taskset -c 0`) and all-core (`--threads 2`,
`taskset -c 0,1`), 2 passes each of E1/E5/B1/B2/B3. All 20 invocations exit 0.
Full command/timestamp log: `logs/run_log.txt`. Aggregates: exit 1/1,
G1–G6 PASS, G7 FAIL (`logs/aggregate_normal.txt`, `logs/aggregate_strict.txt`).

## 3. G7 results — C1's targets FIXED; new failures elsewhere

| Group (variant) | Deviations | Verdict |
|---|---|---|
| **B7 both variants (200 samples)** | worst 4.1% | **PASS — fixed** (was 16.4–25.5% at n=10) |
| **B9 both variants (200 samples)** | worst 5.4% | **PASS** |
| B6 single-thread (200 samples) | worst 0.7% | PASS |
| B6 all-core | run4 `P1-E5-*` 358.12 µs vs 294.86/293.76 = 17.66/17.97% | **FAIL** (60 ms window caught a state) |
| B1 all-core pair | 3185.0 vs 2636.4 ms = 17.23% | **FAIL** |
| B2 single-thread pair | 52.9 vs 85.5 ms = **38.10%** | **FAIL** |
| B3 single-thread pair | 69.3 vs 91.6 ms = 24.28% (allowed 20%) | **FAIL** |

Sample-level phenotype (facts): the failing B2 window is a **uniform sustained
shift** (min 70.7 ms > passing record's max 54.7 ms; CV 8%); B3 same shape;
B1's failing pair overlaps in spread with an 18%-CV fast-side record. Not
spikes; not estimator noise.

## 4. Root-cause class — now distinguished

- **C1 controlled the measurement-path variable and it worked where windows
  lengthened:** B7 (0.6 s windows) went from the standing failure to 2.9–4.1%;
  B9 clean. Short 60 ms windows (B6/B9 at 200×0.3 ms) remain luck-sensitive
  (one B6 record caught a state).
- **B1/B2/B3 (untouched methodology, 30 samples, seconds-long windows) now
  fail on uniform sustained shifts** — the host exhibits throughput states
  lasting ≥ seconds, moving medians 17–38%. Within one campaign, coherent
  per-block co-directional shifts across independent benchmarks (ST PASS-2
  block slower: B1 +8.7/B2 +62/B3 +32%; AC PASS-2 block faster: B1 −17/B2 −8/
  B3 −8.6%) rule out per-benchmark noise and simple monotonic thermal drift.
  Compute windows normal during bandwidth shifts; B7 (the only file-I/O path)
  was the calmest benchmark — kernel-FS and frequency explanations disfavored.
- **Conclusion (high confidence for the class, source still H1-vs-host-internal):**
  environmental sustained bandwidth/throughput interference on this shared
  container, at seconds-to-minutes scale, weighted toward bandwidth-bound
  workloads. Measurement-path defect, evaluator defect, and sample-count noise
  are ruled out as the cause of these failures.
- **Preregistered prediction check:** "PASS if host states remain sub-second" —
  **falsified**; states are multi-second to minute-scale. Per authorization,
  no repeat of the same campaign is being run.

## 5. Why another identical round is not the answer

Pair-based groups under all-pairs comparison fail whenever one record's window
lands in a shifted state; more samples cannot fix between-invocation state
differences, and more records make all-pairs stricter. On this host the
observed bandwidth-state swings (up to ±38%) exceed the frozen ±15/±20%
tolerances as a matter of course. Passing G7 here is luck-dependent.

## 6. Status and next action

G1–G6 PASS, G7 FAIL → **M0 = FAIL; M1 = LOCKED**. §K 5/5, §M M1–M10 PASS
(standing properties verified), manual G8 checklist PASS (43/43 records
present/parseable/schema-valid/append-only — see §7). No signature applied.

**Single next action: the owner designates the dedicated acceptance machine
(C3)** — minimum requirements and run procedure as in
`G7_DIAGNOSIS_AND_M0_RECOVERY_20261023.md` §4. Evidence basis: three campaigns
now show environmental state swings beyond frozen tolerance on this host,
while the C1 fix demonstrably stabilizes the measurement path. (C2 telemetry
remains available if the owner prefers source attribution before moving.)

## 7. Manual G8 checklist (U5)

| Item | Result |
|---|---|
| Every executed benchmark/capture has a record | PASS — 43/43 (2 PROFILE/TELEMETRY, 3 SKIPPED, 2 NOT_ATTEMPTED, 36 measured) |
| All parseable by production reader | PASS — aggregate enumerated 43/43, 0 malformed |
| Schema-valid | PASS |
| Append-only integrity | PASS — SNAP chain 7/7 verified after all appends |
| Records at designated path | PASS with noted nuance — store is `build/results-c1-20261023/` (U8 literal `build/results/` wording in gaps note) |

§K: profiler 34, accounting 67, budget 55, records 72, reproducibility 37 —
all PASS. §M: M1–M10 all PASS as standing properties against this campaign's
evidence.
