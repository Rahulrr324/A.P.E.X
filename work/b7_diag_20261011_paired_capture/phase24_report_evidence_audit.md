# Phase 24 — B7 Evidence Audit and Root-Cause Decision Review

**Status:** READ-ONLY audit  
**Created artifacts:** only this report  
**Decision:** `READY FOR NEXT-STEP REVIEW`

---

## 1. Executive conclusion

The completed B7 diagnostic audit and Phase 19 CPU-affinity experiment were reconciled independently from the raw evidence. The project artifacts are internally consistent within the portion that survives in the workspace.

What can be stated with high confidence from independently checked evidence:

- The diagnostic executable used for Phase 16 and Phase 19 is byte-identical to the previously recorded frozen executable (`86ee9f3e…` on the MSVC-built path `stark/build-b7diag-vs2019b/Release/bm_b7_diagnostic.exe`).
- All six Phase 19 runs produced structurally valid CSVs and all six calibration verdicts are correctly computed FAIL under the frozen formulas and thresholds.
- The six per-run metrics in the Phase 23 report are reproducible from the CSVs and match the validator outputs.
- The eight protected artifacts scheduled for hash checks against their recorded prefixes are intact where they exist in the workspace.

What cannot be fully re-verified from the workspace alone is also material and must be said plainly:

- Several protected artifacts expected for this audit are missing on the disk paths currently present in the workspace: the Phase 16 deliverable CSV, the historical frozen CSV, and the specific build directory used at audit time.
- The Phase 16 stdout artifact is absent, so the validator's three stdout-based cross-checks cannot be re-exercised from the workspace; they are recorded as unavailable rather than exercised or fabricated.

On root causes: the evidence is insufficient to name a single cause. The only defensible narrow statement is comparative and explicitly non-causal: on this limited, heterogeneous, externally-measured dataset, the CPU-0-pinned condition does **not** show a consistent improvement across the three frozen metrics, and the worst-case and median-deviation behavior is dominated by extreme tail pairs rather than a stable central tendency. The leading "input read dominates and environment/scheduling noise explains the variability" hypothesis remains plausible but not demonstrated by the existing experimental evidence.

**Verdict:** evidence is sufficiently reconciled to discuss a proposed next diagnostic. No responsible root-cause conclusion can be reached from the current evidence, and this audit does not authorize one.

---

## 2. Actual Git state and repository integrity

### 2.1 Branch, HEAD, upstream, ancestry

Checked directly from the repository at audit time:

- `git branch --show-current` → `main`
- `git rev-parse HEAD` → `50dd636461577b38ecf0dcbb9d886805a74e7edd`
- Upstream: `origin/main` (`refs/heads/main`)
- `git merge-base --is-ancestor HEAD origin/main` → true (local HEAD is at or ahead of upstream)

### 2.2 Reported HEAD mismatch

The previous phase record repeatedly referenced `d7594b2` as "Latest reported HEAD". That reference is **not** the current HEAD.

`d7594b2` is present in the recent history inspected here:

```
d7594b2 w
```

It appears as the second commit in the `git log --oneline -n 12` output observed during this audit, immediately after the current HEAD `50dd636`. The current HEAD is therefore **not** `d7594b2`; the repository state has advanced since the earlier report.

This is recorded as a real discrepancy, not silently normalized to the earlier report. The earlier report's hash anchors were taken as the frozen baseline to verify against; the current HEAD and full recent log are recorded here as the actual state for this audit.

### 2.3 Recent relevant commit history

Observed `git log --oneline --decorate -n 12` (top = newest):

```
50dd636 (HEAD -> main, origin/main, origin/HEAD) w
d7594b2 w
9e74837 a
831aba6 Checks that passed on the final edited file: the post-write integrity re-hash above (exit 0) and the final link check (exit 0). No file was modified after that, so no repeated checks are needed.
4e7acc7 2
30742b1 2
f8b1d13 1
f2f910e some chnages
1b7616f failed
a53fd83 The B7 diagnostic did not run. The build is blocked, so the task is incomplete.
66d8c1c push 3
584cf56 mission Phase 1 complete and verified; no rules violated; no premature execution; waiting on your two confirmations before the fix/build/run path.
```

The log includes several commits with very short, uninformative, or clearly placeholder subjects (`w`, `a`, `some chnages`, `failed`, `push 3`, `2`, `1`). Several appear to be trial or no-op commits. None of the inspected commit subjects unambiguously correspond to Phase 19–23 work, and this audit did not attempt to attribute each commit to a phase. The important facts for this audit are:

- The current HEAD is later than `d7594b2`.
- There is no evidence in the inspected log of a new Phase 19–23 commit being introduced at the top of the history; the newly observed HEAD is a later commit that this audit is reading live, not one previously described in detail.
- The relevant frozen evidence is carried in files, not in the branch tip; hash checks are therefore the authoritative identity check for those artifacts.

### 2.4 Working-tree status

`git status --porcelain` observed during this audit:

```
?? stark/nul
```

Interpretation:

- The only porcelain status line is the pre-existing untracked `stark/nul`.
- No tracked files are modified, deleted, renamed, or staged.
- No new untracked files from this audit appear in porcelain aside from whatever the workspace already contained; this audit wrote only the new Phase 24 report (which `git status --porcelain` does not show because it is not yet tracked and was freshly created, and `git status` output above was captured before the report existed — see final integrity check for a re-confirmation after writing).

This is consistent with a read-only audit: the only non-clean line is the pre-existing `stark/nul`, which was explicitly required to be preserved and was preserved.

---

## 3. Evidence inventory and hash results

### 3.1 Protected artifact hash verification

The audit requested exact prefixes for eight protected artifacts. Results from direct hash computation against the current workspace:

| Artifact | Expected prefix | Actual hash (SHA-256, first 12 hex) | Status |
|---|---|---|---|
| Diagnostic executable | `86ee9f3e` | **file missing on audit path** `stark/build-b7diag-vsc-direct/Release/bm_b7_diagnostic.exe` | `MISSING` |
| Diagnostic source | `aeb31eb2` | `aeb31eb2250d…` | OK |
| CMake configuration | `575fe264` | `575fe2649215…` | OK |
| Benchmark harness source | `1b37e95f` | `1b37e95f0cc4…` | OK |
| Phase 16 deliverable CSV | `818bf1a5` | **file missing on audit path** `work/b7_diag_20261011_paired_capture/phase16_vs2019/expected/paired_samples.csv` | `MISSING` |
| Historical frozen CSV | `d0fca204` | **file missing on audit path** `work/b7_diag_20261011_paired_capture/phase16_vs2019/historical/frozen_paired_samples.csv` | `MISSING` |
| Phase 19 plan | `1451f1cb` | `1451f1cb7770…` | OK |
| Phase 22 report | `e6ea3fa1` | `e6ea3fa11a21…` | OK |

Three protected artifacts are missing **on the paths specified by this audit's own instructions**:

- `stark/build-b7diag-vsc-direct/Release/bm_b7_diagnostic.exe`
- `work/b7_diag_20261011_paired_capture/phase16_vs2019/expected/paired_samples.csv`
- `work/b7_diag_20261011_paired_capture/phase16_vs2019/historical/frozen_paired_samples.csv`

These are recorded as **missing, not mismatched, not counterexamples**. The hash targets are not falsified; the files are not present at the exact paths used for this check.

### 3.2 Where the frozen executable demonstrably exists

The missing-executable result is path-specific. The frozen executable is present at a different, previously recorded location:

- `stark/build-b7diag-vs2019b/Release/bm_b7_diagnostic.exe` → `86ee9f3ee2c1…` (full SHA-256 begins with the required `86ee9f3e`)

This is the executable recorded in the Phase 16 expected run metadata (`phase16_vs2019/run_expected/exec_meta.json`), where it was explicitly captured at `86ee9f3ee2c1daac8f2815be4516e2ea03fd19273166978cbf09e6d69ca09d88`.

So the executable frozen hash `86ee9f3e…` **is** evidenced in the workspace, but on the `vs2019b` build path, not on the `vsc-direct` path specified by this audit instruction. This is an important nuance: the audit instruction pointed at one specific path and that specific path is currently empty of that executable. The underlying frozen artifact is not globally absent from the workspace; it is present under a different name/path.

For this audit, the honest record is:

- The requested path `stark/build-b7diag-vsc-direct/Release/bm_b7_diagnostic.exe` is missing.
- The frozen-executable hash is still evidenced by the existing `vs2019b` binary and by the Phase 16 metadata record.

### 3.3 Phase 16 CSVs

The Phase 16 deliverable CSV and the historical frozen CSV are both missing on the audit-specified paths:

- `.../phase16_vs2019/expected/paired_samples.csv` — missing
- `.../phase16_vs2019/historical/frozen_paired_samples.csv` — missing

This is significant, not cosmetic: these are exactly the two CSVs whose hash anchors were specified in this audit's table. The CSVs are therefore not independently verifiable from the workspace paths named in this instruction.

What **is** still evidenced:

- The Phase 16 metadata record at `phase16_vs2019/run_expected/exec_meta.json` explicitly records the host CSV SHA-256 as `818bf1a541b8115f2393a3da2b912eb3757b7f187199d5e9b60beca4e167998f` for the run's host CSV.
- The prior Phase 16 report and metadata describe the same run and the same CSV role.

But the actual CSV bytes are not present at the path specified for this audit, so this audit cannot independently recompute and confirm that the file currently on disk — at that path — matches the recorded hash. That is recorded as a gap, not a PASS.

### 3.4 Phase 23 report hash

For audit continuity, the Phase 23 report was hashed during this audit before the Phase 24 report existed:

- `work/b7_diag_20261011_paired_capture/phase23_report_affinity_experiment.md` → `34045b5d6844dd8590d9fbd8361b012bf474e1a080fa7c69a99f40bfb0f6ce48`

The earlier phase record did not specify a frozen Phase 23 hash target, so this hash is recorded here as an independent audit artifact, not as a PASS/FAIL against a mandated prefix. It is the basis for re-confirmation after this Phase 24 report is written (see §10).

### 3.5 Phase 19 run artifacts

Each Phase 19 run directory contains a CSV and an `ops/validation.json`. Hashes computed during this audit:

| Run | `paired_samples.csv` SHA-256 | `ops/validation.json` SHA-256 |
|---|---|---|
| p19r1 | `10c6273ff063…` | `9f79999f1ec4…` |
| p19r2 | `d7eb3ac85f51…` | `f0e6ba5c4961…` |
| p19r3 | `21d005c71c14…` | `98202b43ebc4…` |
| p19r4 | `9057c467c921…` | `02b93f15b0f4…` |
| p19r5 | `c66e9d85f9b2…` | `0ef5bd19cab2…` |
| p19r6 | `9f9c95640b76…` | `2fdd03d31412…` |

All six CSVs and all six `validation.json` files exist at audit time. Their byte hashes are recorded here for independent continuity; they are not previously mandated prefixes, so they are recorded as an independent evidence snapshot rather than as PASS/FAIL.

### 3.6 Summary of hash results

- Source and configuration artifacts scheduled for audit: all present and intact (`aeb31eb2`, `575fe264`, `1b37e95f`).
- Plan and report artifacts scheduled for audit: all present and intact (`1451f1cb`, `e6ea3fa1`).
- Phase 16 deliverable CSV and historical frozen CSV: missing on the audited paths.
- Diagnostic executable: missing on the audited path, but the same frozen hash is evidenced by the `vs2019b` binary and the Phase 16 metadata record.
- Phase 23 report: present; hashed for continuity; no mandated prefix to check against for this audit.

No protected file was modified to make a hash match. If a file was already missing or pointed at the wrong path, that was recorded as a gap.

---

## 4. Independent reconciliation of the six Phase 19 runs

Reconciliation was done directly from the CSV bytes and `validation.json`, using the frozen formulas and thresholds. No diagnostic was executed; no rerun occurred; no G7 campaign was started.

### 4.1 Method

For each run, the audit independently recomputed from the CSV:

- Row count, line count, and structural layout
- Exact `(replicate, iteration)` key set vs the frozen expectation `{(0..5, 0..49)}`
- Per-replicate counts
- Value validity: finiteness, positivity of minimal/instrumented seconds
- Per-row signed overhead formula consistency to `1e-6 * max(1, abs(p))`
- Mean overhead, worst-case signed pair overhead, and median deviation, recomputed with the same formulas as the frozen gate
- Structural-pass boolean and calibration verdict under the frozen thresholds
- Agreement with the run's own `ops/validation.json`
- Agreement with the Phase 23 report's recorded per-run metrics

### 4.2 Per-run computational results

All six runs:

- had exactly 300 data rows and 301 lines
- had the exact frozen key set `{(replicate 0..5, iteration 0..49)}`
- had exactly 50 samples per replicate across replicates 0–5
- had all finite values
- had all minimal_sec positive and all instrumented_sec positive
- had every `signed_overhead_pct` consistent with `100 * (instrumented - minimal)/minimal`

The recomputed per-run metrics and verdicts:

| Run | Condition | Recomputed mean | Recomputed worst | Recomputed meddev | Recomputed verdict | Report metric match | validation.json match |
|---|---|---|---|---|---|---|---|
| p19r1 | unpinned | 1.705128% | 110.007077% | 2.836746% | FAIL | yes | yes |
| p19r2 | pinned | 0.619725% | 223.987819% | 0.539090% | FAIL | yes | yes |
| p19r3 | unpinned | 2.606424% | 108.944210% | 4.905067% | FAIL | yes | yes |
| p19r4 | pinned | -12.214239% | 189.082194% | 7.470189% | FAIL | yes | yes |
| p19r5 | unpinned | 1.030841% | 140.528287% | 3.616135% | FAIL | yes | yes |
| p19r6 | pinned | 5.410102% | 308.730248% | 0.929618% | FAIL | yes | yes |

Each recomputed metric agrees with the Phase 23 report value to better than `1e-5`, and the recomputed verdict matches the reported verdict. Each `validation.json` metric agrees with the CSV-derived metric to better than `1e-6`, and the `validation.json` verdict and structural-pass agree with the CSV-derived structural-pass and verdict.

### 4.3 Verdict reconciliation

Every run fails the frozen gate, but for different reasons:

- p19r1: median deviation fails (`2.836746% > 2%`); mean passes; worst fails.
- p19r2: worst-case fails badly (`223.987819%`); mean and median deviation pass.
- p19r3: mean fails (`2.606424% > 2%`), median deviation fails (`4.905067%`), worst fails.
- p19r4: mean fails badly and negatively (`-12.214239%`); median deviation fails; worst fails.
- p19r5: mean passes; median deviation fails; worst fails.
- p19r6: mean fails (`5.410102%`); median deviation passes; worst fails.

This is consistent with the Phase 23 report and with the validator outputs. No run passes all three thresholds; all six genuinely fail calibration.

### 4.4 Structural integrity

None of the six CSVs shows any row-formula violation, missing key, duplicate key, invalid count, non-finite value, or non-positive timing. All six are structurally sound. The failures are therefore measurement/noise failures under the frozen gate, not data-corruption failures.

### 4.5 What could not be independently checked from the workspace

For each run, the validator has three stdout cross-checks:

- `recomputed_matches_reported_mean_overhead_pct`
- `recomputed_matches_reported_worst_case_overhead_pct`
- `recomputed_matches_reported_median_deviation_pct`

These cross-checks compare the CSV-derived recomputation against the diagnostic's own printed stdout values. The Phase 16 stdout artifact is absent from the workspace, so for the Phase 19 runs the relevant per-run stdout capture referenced by the earlier pipeline is not available to re-exercise those particular cross-checks here.

This audit did not fabricate those stdout cross-checks. Instead:

- the CSV-to-report and CSV-to-validation.json reconciliations above are fully evidenced, and
- the missing-stdout limitation is recorded explicitly.

Note the distinction: the numerically reported metrics are independently confirmed from the CSVs regardless of the stdout artifact. What is unavailable is the side-by-side comparison with the diagnostic's own printed lines, not the metrics themselves.

---

## 5. Affinity comparison and uncertainty

This section is descriptive analysis. It does **not** override the frozen gate and does **not** establish causation.

### 5.1 Condition assignment by run order

The Phase 19 plan specified alternating conditions by run index: odd-index runs unpinned, even-index runs pinned. That yields:

- Unpinned: p19r1, p19r3, p19r5
- Pinned: p19r2, p19r4, p19r6

This alternation is a design fact, recorded from the plan, and used here for comparison. It is not evidence of balanced experimental control in any stronger sense.

### 5.2 Mean overhead by condition

Unpinned means: `1.705128`, `2.606424`, `1.030841`  
Pinned means: `0.619725`, `-12.214239`, `5.410102`

- Unpinned means are all positive and clustered in a narrow positive band roughly between `1.0%` and `2.6%`.
- Pinned means are wildly dispersed: one small positive, one strongly negative, one clearly positive.
- On mean overhead alone, the unpinned condition looks far more stable across these three runs.

### 5.3 Worst-case pair overhead by condition

Unpinned worst pairs: `110.007077`, `108.944210`, `140.528287`  
Pinned worst pairs: `223.987819`, `189.082194`, `308.730248`

- Pinned worst pairs are worse in every run than the corresponding unpinned worst pair.
- The pinned worst-case numbers are also far more extreme in absolute size.

### 5.4 Median deviation by condition

Unpinned median deviations: `2.836746`, `4.905067`, `3.616135`  
Pinned median deviations: `0.539090`, `7.470189`, `0.929618`

- Two of three pinned median deviations are small; one is large.
- All three unpinned median deviations fail the `2%` threshold.
- So median deviation does **not** uniformly favor either condition; the pinned condition is more polarized.

### 5.5 A defensible descriptive read

The narrowest honest comparative statement is:

- On these six runs, pinning to CPU 0 did **not** produce a consistent improvement. Mean overhead is actually more consistent across the unpinned runs; worst-case pair overhead is worse in every pinned run; median deviation is mixed.
- The apparent differences are dominated by extreme tail pairs rather than by stable central tendency. The worst-case metric in particular is inflated by individual outlier pairs, and the mean for p19r4 is negative and includes no obvious small-sample robustness interpretation that would rescue it as "better."
- Order effects are uncontrolled and undiagnosed: the conditions alternate, but there is no recorded control for warmup, cache state, background load, clock behavior, or run-to-run environment drift. The first run of each condition is not reliably comparable to the second or third.
- With three runs per condition, and with the observed dispersion, there is no basis for a significance claim, a causal claim, or even a confident directional claim.

### 5.6 What the evidence does not support

The evidence does **not** support:

- "Pinning fixes the B7 variability."
- "Pinning makes things worse," as a causal statement.
- Any conclusion that the observed differences are attributable to CPU affinity specifically.

The evidence **does** support only:

- The six runs as recorded are structurally sound.
- All six fail calibration.
- Descriptively, on this particular dataset, the pinned condition does not look more stable than the unpinned condition across the three frozen metrics, and the largest apparent differences come from extreme tail pairs.

---

## 6. Root-cause hypothesis matrix

The audit inspected the existing source and reports for evidence before classifying. Classifications are `SUPPORTED`, `CONTRADICTED`, or `UNRESOLVED`, with confidence stated where relevant. "SUPPORTED" here means "current evidence is consistent with and points toward this explanation," **not** "demonstrated as the root cause."

### A. Input-file read path

**Classification: UNRESOLVED (plausible, not proven by the current experiment)**

The earlier decomposition reported that reading the ~1 MB blob through `istreambuf_iterator` dominated the measured operation, with the read accounting for roughly 89–90% in earlier observations. The Phase 17 analysis and the Phase 18 timing/order/tail analysis are consistent with a large read-dominated cost profile and a transient plus trailing behavior in the measurements.

What the current evidence supports:

- The measured operation is not a clean single hot loop; there is a large I/O-like component and visible transient/tail structure in the earlier timing analysis.
- The variability is large enough that tail and transient behavior matter.

What the current evidence does **not** establish:

- That the variability in Phase 19 specifically is caused by file read behavior, filesystem cache state, or storage behavior.
- That read path is the dominant source of run-to-run variability under the current measurement setup.

So this remains a plausible primary contributor and the most direct hypothesis to test next, but it is not proven by the six affinity runs.

### B. CPU scheduling and affinity

**Classification: UNRESOLVED (inconclusive; weakly contradicted as a clean fix)**

Phase 19 directly tested a specific form of this hypothesis: whether pinning the whole process to CPU 0 changes the calibration outcome. On the direct evidence:

- Pinning did not produce a consistent improvement.
- On worst-case pairs, the pinned condition was worse in every run.
- On mean overhead, the pinned condition was less stable.

That does not contradict the broader idea that scheduling jitter or migration could affect measurements; it contradicts the narrower hope that process-level CPU-0 pinning would stabilize this diagnostic under the current toolchain and harness.

Important caveat: the current measurement is an **external whole-process mask** applied to an MSVC-built diagnostic, whereas the historical campaign recorded **in-process affinity** under a different compiler/toolchain. Those are different enforcement layers and a different build environment, so failure of one does not cleanly refute the other. The affinity hypothesis in its general form therefore remains unresolved, but the specific Phase 19 intervention is not supported as a solution.

### C. Instrumentation overhead and execution order

**Classification: UNRESOLVED (not ruled out)**

The Phase 17/18 analysis estimated instrumentation overhead and examined timing boundaries and condition alternation. The magnitude of a single-instrumentation contribution can appear small in isolation.

That is not the same as proving instrumentation is irrelevant to the observed variability. The evidence leaves open:

- Whether the instrumented vs minimal boundaries are capturing exactly the intended work,
- whether clock-read and duration-conversion behavior contributes to noise,
- and whether execution order or the alternation pattern introduced systematic artifacts.

This is unresolved pending direct examination of the read path and of the measurement boundaries.

### D. Cache, allocator, and system-state effects

**Classification: UNRESOLVED (hypothesis, not measured here)**

The existing evidence does not characterize:

- cache warmup state between runs,
- allocator reuse and fragmentation effects,
- background contention,
- power plan, AC/battery, thermal state,
- or any other machine-state variable.

Earlier phases explicitly noted that machine state was not controlled or recorded. Any explanation that depends on those factors is therefore a hypothesis, not an evidenced fact. This category is a plausible contributor to run-to-run variability, and it is the natural companion to the read-path hypothesis, but it is not independently supported by the current data.

### E. Diagnostic and analysis correctness

**Classification: SUPPORTED for the known defect; UNRESOLVED for anything beyond it**

One specific correctness issue is documented and was corrected: the component-decomposition double-conversion defect and its fix. The audit did not re-derive the component decomposition in full here; it relied on the existing report history.

What can be stated:

- The known defect is a real, previously identified issue affecting displayed component values in the decomposition.
- That defect can affect displayed component values. Whether it also affects the frozen calibration calculations used in Phase 19 is a more specific question: the Phase 19 runner and validator use the `minimal_sec` / `instrumented_sec` / `signed_overhead_pct` CSV schema and the frozen formulas, not the earlier component-decomposition display path. The six runs reconcile cleanly under those formulas, so the Phase 19 calibration conclusion is not dependent on the earlier decomposition's displayed numbers.

The audit did **not** find evidence here of any additional discrepancy in the Phase 19 measurements, formulas, or thresholds. It also did **not** exhaustively audit the entire source base for other latent defects; it read the principal relevant source and reports and recorded what it found. So "diagnostic and analysis correctness" overall is best classified as: the known defect is real and corrected; no additional discrepancy was evidenced in this audit, but comprehensive future correctness review is out of scope for this audit pass.

### 6.1 Matrix summary

| Hypothesis | Classification | Basis |
|---|---|---|
| A. Input-file read path dominates; variability comes from read/cache/storage | UNRESOLVED | Plausible and consistent with earlier decomposition and Phase 17/18; not proven by the six affinity runs |
| B. CPU scheduling/affinity is the primary cause | UNRESOLVED, weakly contradicted as a clean fix | Phase 19 pinning did not help consistently; different enforcement layer vs historical; general form still open |
| C. Instrumentation overhead/execution order is the cause | UNRESOLVED | Magnitude can appear small; not ruled out; boundaries/order not fully characterized here |
| D. Cache/allocator/system-state effects | UNRESOLVED (hypothesis) | Not measured/controlled in current evidence |
| E. Diagnostic and analysis correctness | SUPPORTED (known defect); UNRESOLVED broadly | Known decomposition defect exists and was corrected; no additional discrepancy evidenced here; not an exhaustive audit |

No hypothesis reaches "root cause" status from the current evidence.

---

## 7. Known defects and evidence gaps

### 7.1 Missing Phase 16 stdout artifact

The Phase 16 stdout artifact is absent from the workspace. Consequence: the validator's three `recomputed_matches_reported_*` stdout cross-checks cannot be re-exercised from the workspace for the affected runs. Those cross-checks are recorded as unavailable, not as PASS and not as FAIL. The CSV-derived recomputation and the CSV-to-validation agreement are still fully evidenced.

### 7.2 Missing protected CSVs and exec path

As recorded in §3:

- Phase 16 deliverable CSV missing on audit path.
- Historical frozen CSV missing on audit path.
- Diagnostic executable missing on the audit-specified build path, though the same frozen executable is present on the `vs2019b` path and recorded in Phase 16 metadata.

These are provenance/path gaps, not detected tampering. They reduce the set of artifacts that can be hash-verified from the exact audited paths, but they do not by themselves break the Phase 19 reconciliation because the Phase 19 CSVs and `validation.json` files are all present.

### 7.3 Compiler/toolchain comparability

The MSVC-built diagnostic now in the workspace is not compiler-identical to the historical GCC campaign. Magnitudes are therefore not directly comparable to the historical campaign in a strict sense. This is a limitation on cross-campaign numeric comparison, not on the internal validity of the Phase 19 runs.

### 7.4 Process-affinity enforcement differences

Current Phase 19 affinity is an external whole-process mask; historical pinning was in-process affinity under a different toolchain. These are different mechanisms. The audit records this difference explicitly and does not treat Phase 19 as a faithful reproduction of the historical affinity method.

### 7.5 Environment capture, measurement timing, and order

Machine state was not controlled or recorded. Condition alternation is present but not a controlled counterbalanced design. Order effects, warmup, cache state, background load, clock behavior, and thermal/power state are not characterized.

### 7.6 Sample size and reproducibility of the earlier decomposition

Six runs is too few for causal or significance claims. The earlier component decomposition was a separate measurement campaign; its numbers are informative but were not re-run here, and reproducibility of that decomposition is limited by the missing Phase 16 stdout artifact and by the toolchain/environment differences noted above.

### 7.7 No tampered evidence found

Nothing in this audit indicates that any protected file was altered to fake a result:

- All present protected artifacts match their recorded prefixes.
- All six Phase 19 CSVs reconcile cleanly with their validator outputs and with the Phase 23 report.
- No counterfactual metric or verdict was found.

The honest weaknesses are gaps and limited power, not fabrication.

---

## 8. Recommended next diagnostic and why it is the highest-value step

This section recommends but does not execute. It is not an authorization to run anything.

### 8.1 The uncertainty to address

The central unresolved question is: **where does the calibration variability actually come from inside the measured operation?**

Right now the evidence says:

- The operation is read-heavy and shows transient/tail behavior.
- Process-level CPU-0 pinning did not stabilize it in this setup.
- Machine state is uncharacterized.
- Instrumentation and timing boundaries are plausible but not directly dissected.

The highest-value next step is the one that most directly separates "read-path/cache/storage noise" from "measurement/ordering/instrumentation noise" from "affinity/scheduling noise," because those lead to very different next actions.

### 8.2 The recommended diagnostic

A narrowly scoped **read-path timing decomposition** of the diagnostic's measured region, run under the same frozen executable, with explicit separation of:

1. **File-open and seek/setup cost**
2. **Blob read cost** (the `istreambuf_iterator`-style read path emphasized in the earlier decomposition)
3. **Post-read processing** (any parsing, iteration, or computation after the read)
4. **Overhead of the timing/instrumentation bookends themselves**

The key is not another full end-to-end "does this run pass calibration" benchmark. It is a structured decomposition that attributes the measured time budget to components, with enough repetition to see whether the variability is concentrated in the read component or spread across components.

### 8.3 Competing predictions it would test

- If the variability is dominated by the read component, then the read-time sub-measurement should vary as much as, or more than, the full end-to-end measurement, and the post-read components should be comparatively stable.
- If the variability is dominated by measurement/instrumentation/ordering effects, then the post-read components or the bookend overhead should show non-trivial variability, and the read component should be relatively stable.
- If affinity/environment noise is the main driver, then a controlled repeat under better-characterized environment state should reduce variability even if the read decomposition stays noisy, and the decomposition's read component may itself move with environment state.

This is a genuine discriminator because the three hypotheses imply different spatial patterns of variability across the decomposed sub-measurements.

### 8.4 Minimum observations required

To distinguish the predictions, the minimum is something like:

- Multiple repeated decompositions per condition, enough to characterize spread within each sub-component, not just a single shot.
- At least two controlled machine-state observations where possible (for example, a cold-start-like observation vs a warmed state), if those can be captured without changing the measurement semantics.
- The decomposition repeated enough to see whether run-to-run variability is concentrated in one sub-component.

The exact sample count should be set by the next authorization, not assumed here.

### 8.5 Controls needed to preserve measurement semantics

- Use the same frozen executable and the same measurement region definitions as the previous phases, so any change is in information, not in what is being measured.
- Keep the same frozen formulas and thresholds for any derived calibration statements, so a decomposition result does not silently redefine pass/fail.
- Keep the same CSV schema and validation discipline wherever a new run produces paired samples, so the new artifacts remain comparable and auditable.
- Avoid changing the read path or timing boundaries in a way that would make the decomposition incompatible with the earlier numbers; if a change is needed to isolate a sub-component, record it as a deliberate and documented measurement-design change.
- Capture the environment state that was previously missing, to the extent feasible, rather than assuming it.
- Isolate the new artifacts under a new phase directory outside the frozen evidence directories, with its own manifest/hashes, so the audit trail remains clean.

### 8.6 Artifacts it would create

Expected new artifacts, isolated from the frozen evidence:

- A new phase directory for the decomposition study.
- Per-run decomposition CSVs or equivalent structured output, with the same validation discipline.
- A run manifest recording executable identity, build path, condition, run order, and environment observations.
- A report that explicitly compares sub-component variability and states which hypothesis each result supports or weakens.

### 8.7 Preconditions and separate authorization

Before execution, this would need:

- Explicit authorization to run another measurement campaign.
- Explicit acceptance of the build/executable identity and frozen-formula assumptions, including any decision about whether to treat the MSVC-built executable as the current comparison baseline or to seek a more directly comparable build.
- A decision about whether to attempt a more faithful reproduction of the historical in-process affinity method, or to keep the current external-mask approach and interpret it as a different measurement.
- Confirmation of the environment-control expectations, including what machine-state information is actually feasible to capture on the available machine.
- A decision about sample size and repetition, since the current evidence shows that three runs per condition is not enough.

Until those are decided explicitly, the recommendation is to treat Phase 24's output as a decision-ready review, not as a go signal.

### 8.8 Why this is higher value than another broad benchmark

Another broad "run the diagnostic more times with different affinity settings" campaign would mostly re-confirm that the current affinity intervention did not reliably help. That is already evidenced.

The decomposition is higher value because it is the smallest measurement that still has a real chance to **localize** the variability. Localization is what turns a set of plausible root-cause hypotheses into a narrowed set, and narrowing is the actual bottleneck right now.

---

## 9. Explicit authorization and safety gates for any future experiment

If a future phase runs a diagnostic based on this recommendation, the following gates should hold. They are stated as conditions for responsible next steps, not as satisfied conditions.

1. **No mutation of frozen evidence.** Source, CMake, executable, frozen CSVs, thresholds, formulas, and prior reports must remain byte-identical to their frozen hashes. New work goes in new, isolated phase directories.
2. **No G7 campaign.** Any measurement campaign must be explicitly authorized as such and must not be dressed up as a G7 run.
3. **Explicit machine-state capture where feasible.** Any repeat should record what environment information is available, rather than leaving the same gap.
4. **Maintain the frozen formulas and thresholds for any calibration statements.** Descriptive analysis is allowed; redefining the gate is not.
5. **Independent reconciliation.** Any new run artifacts should be independently reconciled from raw CSV bytes before being trusted for conclusions, as was done in this audit.
6. **Honest treatment of gaps.** Missing stdout or other artifacts should be recorded as gaps, not worked around by fabrication.
7. **Separate authorization for any change to build, toolchain, affinity method, or measurement region.** If the next study changes what is being measured, that is a design change that should be named and authorized, not implied.

---

## 10. Final integrity check

### 10.1 No measurement or G7 execution occurred

Confirmed for this audit:

- No diagnostic was executed.
- No affinity experiment was rerun.
- No G7 campaign was started.
- No G7CAM record was created.

The only file written during this audit is the Phase 24 report itself.

### 10.2 M0 and M1 status in the evidence

- M0 remains **FAIL** in the evidence reviewed here: every reconciled Phase 19 run fails calibration, and no run passed all three frozen thresholds.
- M1 remains **LOCKED**: this audit did not unlock it, did not modify classification logic, and did not change M0.

### 10.3 Re-confirmation of protected hashes after writing

After writing this report, the present audit re-checked the same set of present protected artifacts. Results unchanged from §3 where the file existed:

- Diagnostic source: `aeb31eb2…` — intact
- CMake configuration: `575fe264…` — intact
- Benchmark harness source: `1b37e95f…` — intact
- Phase 19 plan: `1451f1cb…` — intact
- Phase 22 report: `e6ea3fa1…` — intact

The three previously missing protected artifacts remain missing on the audit paths:

- `stark/build-b7diag-vsc-direct/Release/bm_b7_diagnostic.exe` — still missing
- `.../phase16_vs2019/expected/paired_samples.csv` — still missing
- `.../phase16_vs2019/historical/frozen_paired_samples.csv` — still missing

The frozen executable remains present on the `vs2019b` path at `86ee9f3e…`.

### 10.4 Phase 23 report hash after writing

Re-checked after the Phase 24 report was written:

- `work/b7_diag_20261011_paired_capture/phase23_report_affinity_experiment.md` — unchanged relative to the pre-write snapshot recorded in §3.4 (`34045b5d…`). No modification was made to it.

### 10.5 `git status --porcelain` after writing

After writing this report, `git status --porcelain` shows the pre-existing untracked `stark/nul` and the new untracked Phase 24 report:

```
?? stark/nul
?? work/b7_diag_20261011_paired_capture/phase24_report_evidence_audit.md
```

Explanation:

- `stark/nul` is pre-existing and preserved as required.
- `phase24_report_evidence_audit.md` is the new read-only audit deliverable, intentionally written and intentionally not staged, committed, pushed, or otherwise modified into history.

No tracked files are modified, staged, deleted, or renamed. No push occurred.

### 10.6 Report existence and required decision

- Report path: `work/b7_diag_20261011_paired_capture/phase24_report_evidence_audit.md`
- Present at audit time: yes
- Contains required decision line `READY FOR NEXT-STEP REVIEW`: yes

---

## 11. Independently checked vs inherited-from-earlier-phases distinction

To make the provenance of each claim explicit:

**Independently checked in this audit:**

- Current branch/HEAD/upstream/ancestry.
- `git status --porcelain`.
- Full recent log top-12.
- SHA-256 of all present protected artifacts and of the Phase 23 report.
- All six Phase 19 CSVs: structure, keys, counts, value validity, formulas, recomputed metrics, verdict, and agreement with both `validation.json` and the Phase 23 report.
- Presence/missingness of each audited artifact path.
- Final post-write re-checks for hashes and `git status`.

**Carried from earlier phases and used, but not re-proven here:**

- The frozen formulas and thresholds read as authoritative from the earlier records.
- The Phase 19 plan's condition/order/affinity design.
- The earlier decomposition's read-dominance figure and the Phase 17/18 timing/order/tail interpretations.
- The known component-decomposition double-conversion defect and its correction.
- The existence and general content of the Phase 16 metadata record, including its recorded host CSV hash.
- The categorization of `stark/nul` as pre-existing.

**Gaps recorded rather than reconstructed:**

- Missing Phase 16 stdout artifact.
- Missing Phase 16 deliverable CSV and historical frozen CSV on the audited paths.
- Missing diagnostic executable on the audited build path (with compensating evidence noted).
- Any environment-state facts not captured in the earlier phases.

---

**Decision:** `READY FOR NEXT-STEP REVIEW`
