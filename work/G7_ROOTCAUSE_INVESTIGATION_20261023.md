# G7 Root-Cause Investigation — Corrective Resolution Report (2026-10-23, v1)

Supersedes no prior report (additive; `G7_DIAGNOSIS_AND_M0_RECOVERY_20261023.md`
remains the fast-track summary). All analysis is from committed evidence and
source; no new measurements were run; no frozen artifact, threshold, or record
was modified; E3 not executed; nothing signed.

## 1. State verification and failure reproduction

- Branch `arena/c90f7329-a-p-e-x`, PR #2 OPEN at `95f0d6400aa9f3730ecf544b8f7c8b648b1d2be9`
  (== `git ls-remote` tip; `main` = `563395f1…`). The sandbox had re-cloned at
  base again; local HEAD restored to `95f0d64` after pairwise hash-verification
  of working-tree vs pushed blobs (`e0e01700…`, `351a78fe…`). Store intact
  (43 records), manifests intact.
- **Reproduction (production evaluator, rebuilt from committed source):**
  `aggregate --out build/results` and `--strict` → 43 records, G1–G6 PASS,
  **G7 FAIL**, exit 1/1, with the Round-2 deviations reproduced bit-for-bit:
  B7 runs 1–3 16.35%, 2–3 25.50%, 3–4 21.83% (allowed 15.00%).
  Logs: `work/g7_rootcause_20261023/reproduce_{normal,strict}.txt`.
- Frozen G7 rules confirmed unchanged: V009 L328 ±15%/±20%; gates.cpp
  symmetric all-pairs |a−b|/max(a,b) on `configuration.dump()` groups
  (L831–875). Record count, paths, and unsigned addendum status preserved.

## 2. Root-cause analysis — confirmed facts vs hypotheses

### Confirmed facts (each reproducible from committed evidence)

**F1 — The Round-2 failure is a real sustained timing shift, not estimator
noise.** Bootstrap 95% CIs (10 000 resamples of the committed samples):
outlier `P1-E5-B7-67375` median 4184.5 µs, CI [4163.0, 4227.6]; all three
peers' CIs ([3163.7, 3936.0], [3238.4, 3637.9], [3083.4, 3179.2]) do **not**
overlap the outlier. The outlier's 10 samples are flat (CV 1.5%, first3/last3
decay +1.1%) — a uniform slower plateau for its whole ~60 ms window.

**F2 — CPU frequency change is ruled out for the Round-2 failure.** Within the
same process (`--baseline E5`, PASS 2), the compute records immediately before
the B7 window were normal: B6 median 296.9 µs and B9 297.2 µs (group range
294–311) while B7 ran +30% slow. The B7/B6 ratio jumps from 10.4–11.2×
(other three invocations) to **14.10×** in the failing one. A 30% frequency
step would have moved B6/B9 proportionally; it did not. The slowdown is
**specific to the bandwidth/IO-bound workload** in that window.

**F3 — The B7 measurement path is an amplifier, not an intrinsic noise
source.** `bench_model_load_time` (BenchmarkHarness.cpp L298–315) times
open + full 1,051,664-byte read + `deserializeWeights` per sample (blob write
is un-timed, L301–306). Counterevidence to path-intrinsic failure: (a) the
same path's PASS-2 E1 record (3117.6 µs, CV 1.8%) was the **fastest** of the
four, ~200 ms before the slowest; (b) the single-thread feasibility round
produced 4/4 tight B7 records (medians 3087–3212, ±2%) on the same VM shape.

**F4 — Short-record × host-state interaction is the failure mechanism.**
Each record's median spans only 10 timed samples (≈50–60 ms for B7). Observed
host speed states shift at exactly that scale: PASS-1 records decay
slow→fast within the record (B7-63147 first3 3904.6 → last3 3120.1 µs, decay
+20.1%; B7-72185 +11.4%) while PASS-2 records are flat plateaus (E1-B7 flat
fast; E5-B7 flat slow). A ~60 ms state change mid-campaign repositions a
record's entire median. Round-1's failure (one whole invocation uniformly
fast across B6/B7/B9) is the same class of host state in the fast direction.

**F5 — Demonstrated implementation/spec defects (exact locations):**
- **D1 — workload-size divergence (E1/E5 family).** V009 §B table: B6 =
  "latency distribution over **N=200 inferences**" (L122); B9 = "Same input
  **200×**" (L125). Implementation executes `warmup_count=3,
  measurement_count=10` (run_baseline.cpp `make_cfg` L256–258) = 13 forwards.
  The general §B line (L111, "≥3 warmup, ≥10 timed iterations (configurable)")
  and G2 (L323) accept ≥10 — so the gate and the owner's U2 valid-run ruling
  are satisfied while the table's N=200 is not. **Spec ambiguity (table vs
  general line) is itself a fact; its resolution belongs to the spec
  authority.** Impact if the table governs: acceptance runs under-sample the
  stated distribution by 20×, and the demonstrated F4 failure mode is exactly
  what short windows produce.
- **D2 — B9 metadata is false regardless of D1's resolution.**
  `workload_params {"repeats":"200"}` (BenchmarkHarness.cpp L330) and the
  comment "200 repeats" (L327) vs 13 executed forwards. The implementing
  comment records the uncertainty: "200 repeats handled by repeated
  measurement? spec: 200 inferences" (run_baseline.cpp L282).
- **D3 — B7 cold-cache mode missing.** V009 L123: "warm **and cold** cache";
  implementation measures warm only (`mode: "warm_cache"`, L310); no cold-cache
  code exists. Not causal for G7 (identical method both rounds).
- Non-defects verified: B1 k=1024 ✓, B2 n=67 108 864 (64M) ✓, B3
  working_set 768 MB ≥ 512 ✓; median conventions of evaluator and harness are
  the same linear-interpolation rule (gates.cpp `recompute_median`;
  zero median-validity rejections in both campaigns); timer = steady_clock in
  seconds (BenchmarkHarness.cpp L110–116); E1/E5 share one code path
  (run_baseline.cpp L265–269).

### Hypotheses for the state source — status

| Hypothesis | Supporting | Contradicting | Status |
|---|---|---|---|
| H1 external memory/IO bandwidth contention (co-tenant) | F2 (bandwidth-specific), F3, F4 | single-thread round clean (different time-of-day) | **Open — leading** |
| H2 CPU frequency/governor | Round-1 fast outlier consistent | F2 rules it out for Round-2 | **Ruled out (R2)**; possible for R1 only |
| H3 measurement-path intrinsic defect | B7 mixes IO+deserialize | F3 (E1-B7 fastest 200 ms prior; 4/4 single-thread tight) | **Ruled out as primary** |
| H4 kernel page-cache/writeback state (triggered by the un-timed 1 MB blob write before timing) | B7-only sensitivity; plateau shape | untestable from existing data | **Open** |
| H5 evaluator/grouping defect | — | reproduction matches exactly; code audit clean | **Ruled out** |
| H6 median-estimator noise (n=10) | n=10 is small | F1 non-overlapping CIs | **Ruled out as the shift's cause; D1 remains the amplifier** |
| H7 config/environment non-equivalence between rounds | 30% absolute drift R1→R2 | identical config; MemTotal now = PROFILE byte-exact (4,131,278,848) | Config **ruled out**; hour-scale host drift is a fact |

**Remaining uncertainty (explicit):** whether the ~60 ms state changes come
from co-tenant bandwidth (H1) or kernel-side cache/writeback transitions (H4).
Existing samples cannot distinguish them; scheduler/bandwidth telemetry over
the B7 window can.

## 3. Experiments performed (this investigation)

1. G7 reproduction from preserved store — reproduced exactly (exit 1).
2. Same-process compute-vs-IO divergence (F2) — frequency ruled out for R2.
3. Bootstrap CIs on all four B7 medians (F1) — real shift confirmed.
4. Within-record decay/CV structure (F4) — plateau-vs-decay phenotypes mapped.
5. Single-thread B7 comparison (F3) — path ruled out as primary.
6. Environment fingerprint (F5 non-defect list) — VM shape identical to
   PROFILE; container restarted after Round 2 (uptime-s 02:24).
7. Evaluator + harness + spec compliance audit (D1–D3, non-defects).
No experiment failed; the two sandbox re-clones were recovered by hash-
verified `git reset --hard` to pushed commits (documented in §1).

## 4. Corrective resolution — exact changes, prepared NOT applied

The demonstrated cause (F4 = D1 short windows × host plateaus, hitting the
bandwidth-bound B7) has one smallest code-side fix that also resolves the
compliance defect. **It changes benchmark methodology and therefore needs
explicit owner authorization (boundary respected — nothing applied):**

**C1 — restore V009 §B N=200 for the E1/E5 family (recommended):**
```diff
--- a/stark/src/phase1/baselines/run_baseline.cpp
+++ b/stark/src/phase1/baselines/run_baseline.cpp
@@ make_cfg (L256-258)
-        c.measurement_count = 10;
+        c.measurement_count = 200;   // V009 §B L122/L125: N=200 (B6), 200× (B9)
```
plus truthful B9 metadata (`repeats` already "200" — becomes true; delete the
uncertain comment L282). Effects: medians estimated over ~2–6 s windows
(median survives a ≤100 ms plateau instead of being defined by it — the
demonstrated F4 failure); G2/G7 gates unchanged (≥10 floor; thresholds frozen);
`measurement_count` is not part of `Configuration` (gates.cpp L831), so a
compliant campaign must run into a **fresh store** (mixed n=10/n=200 groups
must not be created). Expected campaign cost: E1/E5 invocations ~2 s each;
total campaign ≈ minutes. Expected result: G7 PASS if the host shows no
multi-second states; if it still fails, the state source is severe and C2/C3
follow. Regression: rebuild all binaries; §K five tests must stay green
(test_phase1_reproducibility exercises the statistics path).
**Not applied.** If the spec authority instead rules the general §B line
(≥10, configurable) governing, then D1 disappears as a defect and the G7
recovery route becomes C2/C3 only; D2's metadata fix still applies.

**C2 — decisive state-source diagnostic (needs instrumentation approval):**
as previously specified (per-sample timestamps + scheduler/frequency/bandwidth
telemetry around paired all-core runs into `build/diag-g7-*/`, DIAGNOSTIC
label). Runs only if C1 is rejected or a post-C1 campaign still fails.

**C3 — dedicated acceptance machine** (owner decision) if the designated host
cannot be controlled. Requirements/procedure unchanged from the fast-track
report §4.

**C4 (follow-up, low priority):** B7 cold-cache variant (V009 L123) — spec
authority should either authorize implementation or annotate the row.

## 5. Build/test results and acceptance status

Evaluator rebuilt clean from committed source; reproduction exit 1 (G7 FAIL —
expected, it reproduces the recorded failure). No other builds/tests run (no
code changed). **M0 = FAIL; M1 = LOCKED; addendum unsigned.** No acceptance
campaign was run (not authorized; not needed for this diagnosis).

## 6. Required owner decisions — exact approval wording

> **"I authorize corrective change C1:** raise the E1/E5-family
> `measurement_count` from 10 to 200 in `run_baseline.cpp` (warmup ≥3
> unchanged; all workloads, seeds, tolerances, gates, and validators frozen),
> make the B9 metadata truthful, run the five §K tests, and execute one
> acceptance campaign into a fresh clean `build/results/` (both single-thread
> and all-core variants per U2; E3 disposition-only). D1's resolution (table
> N=200 vs general ≥10) is recorded as adopting the §B table text."

Optional second line (only if C1 is rejected): authorize C2's instrumented
diagnostic as previously worded.

## 7. Single best next action

**Owner grants the C1 approval above.** It is the fastest defensible route: it
simultaneously fixes the demonstrated compliance defect (D1), removes the
demonstrated failure amplifier (F4 short windows), needs no threshold or
acceptance-rule change, and yields a decidable campaign in minutes; C2/C3 are
pre-staged only if that campaign still fails.
