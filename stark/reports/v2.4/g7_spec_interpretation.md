# v2.4 — G7 Specification Interpretation (Classification)

**Date:** 2026-10-05
**Frozen source:** `design/V009_phase1_M0_specification.md` (rev 1.1), gate G7 at §G,
benchmark methodology at §B, record rules at §F (append-only).
**Classification: G7-C — historical baseline permanently fails.**
The nine recovered records are immutable (append-only, byte-verified) historical evidence and
genuinely fail the frozen ±15% same-config median criterion. No threshold, sample, grouping
key, formula, median definition or record was altered; the v2.4 G7 output over the historical
set is numerically **identical to v2.2 and v2.3** (16.13 / 18.38 / 21.26 / 27.65 / 28.18 /
48.04 %).

---

## 1. The exact frozen text

**G7 (§G):**

> Full re-run of the same suite with same config: every benchmark median within ±15% of the
> recorded median (memory bandwidth ±20%). Determinism check per rev-1.1: … Tolerance is
> defined here once — later phases may not loosen it silently.

**§B (methodology):** fixed workload sizes, fixed seeds, ≥3 warmup iterations, ≥10 timed
iterations (configurable), CPU thread count pinned, report mean/median/p95 plus raw samples.

**§F (records):** raw samples always stored; "records are append-only on disk".

## 2. The eight questions

### Q1 — Is the ±15% tolerance immutable?

**Yes.** "Tolerance is defined here once — later phases may not loosen it silently." v2.4
does not change it (verified: `G7_MEDIAN_TOLERANCE_PCT` semantics, the 15%/20% split and the
pairwise comparison are untouched; the historical G7 detail text is byte-for-byte the same
numbers as v2.2/v2.3). The sentence bars *later phases* from loosening; M0 itself loosening
the frozen tolerance would be the same violation by another name.

### Q2 — Is n=10 immutable?

**No — it is a floor, not a fixed value.** §B: "≥10 timed iterations (configurable)". More
samples are spec-compliant; fewer are not. But *existing* records' n is frozen with them
(append-only): you cannot re-sample historical runs. Changing n also changes the recorded
configuration, which changes the "same config" grouping key (see Q7) — so a higher-n campaign
forms **new** groups, not replacements.

### Q3 — Is the current benchmark methodology immutable?

**Yes, as to workload definition.** §B fixes workload sizes and seeds (B6: N=200 inferences of
TINY-DENSE-2L, etc.); changing the workload would be changing the specification, not applying
it. Measurement *mechanics* the spec leaves configurable (sample count, warmup count, recorded
affinity) may vary within the stated bounds — but such variants are new configurations, as
above.

### Q4 — Are warmup counts immutable?

**They are a floor (≥3), not an exact value.** More warmup is compliant and recorded in
`warmup_count` (part of the configuration block). The historical records' warmup=3 is frozen
inside those records.

### Q5 — Are CPU affinity/power-state controls allowed?

**Affinity: yes — it is a first-class recorded field.** §F's configuration block explicitly
contains `affinity`, and §B requires pinned thread counts. Pinning affinity is therefore a
spec-sanctioned, *recorded* control — and because it participates in the grouping key, runs
with different affinity are legitimately different configurations. **Power-state controls**
(thermal/turbo/AC policies): V009 neither requires, forbids, nor records them; they are
environmental, invisible to the grouping key, and therefore permitted but unauditable. They
cannot retroactively affect any recorded comparison.

### Q6 — Is a fresh baseline allowed?

**Yes — as NEW evidence.** G7 *is* a re-run contract ("Full re-run of the same suite…"), and
records are append-only: new runs create new records alongside the old. A fresh baseline can
establish that a **new** group of runs is self-consistent; it can never delete, overwrite, or
excuse the historical records, and a new baseline passing is **not** proof that the old
baseline passed.

### Q7 — Does G7 compare historical records specifically, or a newly generated baseline?

**It compares same-configuration recorded medians — and historical records ARE recorded
evidence.** The frozen text says "within ±15% of **the recorded median**" for runs with "same
config"; it contains no historical carve-out and no grandfathering clause. The production
implementation evaluates **every** same-configuration group present in the record store
(all-pairs max-spread; grouping key = serialized `configuration`; independence by distinct
`record_id`). The nine recovered records form three same-config groups (E1×2 + E5×1 for each
of B6/B7/B9) and fail **internally**: the three historical runs of each group mutually differ
by more than 15% (B6 16.13%, B7 18.38%/21.26%, B9 27.65%/28.18%/48.04%). Because the failure
exists *among the recorded runs themselves*, it holds under any reading — all-pairs or
reference-based — so the pairwise-vs-reference ambiguity of the frozen wording is moot here.

### Q8 — Can a future controlled measurement replace the current benchmark records?

**No.** §F: "records are append-only on disk." A future controlled measurement is a **new**
record classified as new evidence. It cannot replace, re-label, or retroactively validate the
current records. Any future campaign that passes G7 is a **new baseline**, not a retroactive
pass of the historical one.

## 3. Why not G7-A (implementation defect)?

- Stored medians == recomputed medians for all nine records (independently verified v2.2
  `[V]` from raw samples only; re-confirmed by the v2.4 run's median-consistency check, which
  every record passes before any comparison is made).
- The grouping key (serialized configuration) faithfully implements "same config";
  E1 and E5 runs share one configuration by construction; no unrelated configurations are
  merged and no sample is excluded.
- The tolerance split (15% timing / 20% bandwidth) matches the frozen "(memory bandwidth
  ±20%)" — note the production code applies the 20% band to B3 *and* B5 (PCIe transfer is a
  bandwidth metric); no evaluated group in any current evidence set hinges on that choice, and
  B5 groups were never part of the historical failure set (the nine contain only B6/B7/B9).
- Deduplication by `record_id`, minimum-10-samples, finiteness and median-consistency checks
  are evidence validation, not threshold changes.
- **No implementation defect violating the gate's own contract was found → G7-A does not
  apply.** (Independently: data corruption, grouping error and stored-median drift were ruled
  out in v2.2 §5.)

## 4. Why not G7-B (valid methodology, insufficient reproducibility — fix environment)?

G7-B would apply if the *implementation were correct* but the environment too noisy, **and**
an environment fix could resolve the gate. Here:

- The spec's permitted sampling levers (n>10, warmup>3, pinned affinity) apply only to
  **future** records — they cannot touch the immutable historical groups.
- Every fresh campaign actually run under the frozen minimal configuration **also fails**:
  v2.1 diagnostics (12 runs/benchmark): B6 spread 59.06%, B7 19.03%, B9 59.78% (v2.2
  independently reproduced); v2.3 fresh candidate: B6 E1-vs-E5 47.55%; v2.1 diagnostics
  aggregate in v2.4: B6 pairs 32.41%–53.99%.
- No evidence exists that a better-controlled campaign would pass; running one would produce
  **new baseline evidence**, not resolve the historical failure (Q6/Q8).

So while the spec *permits* environmental controls (Q5), adopting them cannot reclassify the
historical blocker — G7-B's "implement the minimum compliant improvement and rerun" would not
change M0's outcome and is deliberately **not** taken (no unnecessary experiments).

## 5. Why not G7-D (specification conflict)?

There is exactly one G7 definition in the frozen documents; §G fixes the tolerance once;
§B fixes the methodology; §F fixes append-only storage. They agree. The only textual
under-determination — "the recorded median" when a group holds several records — is moot for
the historical set because the recorded runs disagree with each other under any comparison
convention (Q7). **No conflict to document → G7-D does not apply.**

## 6. Classification: G7-C

**G7-C — Historical baseline permanently fails.**

- The nine recovered records are **immutable historical evidence** (append-only; byte-identity
  re-verified in v2.4: 9/9 match the v2.0 inventory in both `aggregator_input/` and
  `original_historical_records/`).
- They **genuinely fail** the frozen ±15% criterion, by margins recomputed from raw samples
  independently (v2.2) and reproduced identically by the v2.4 binaries:
  B6 16.13%; B7 18.38% / 21.26%; B9 27.65% / 28.18% / 48.04%.
- Therefore **G7 over the historical M0 evidence is a permanent, non-repairable blocker**:
  no legitimate v2.4 action can make it pass, and none was attempted —
  no threshold change, no sample deletion/replacement, no grouping change, no formula or
  median-definition change, no n change, no cherry-picking, no merging of configurations, no
  relabelling of historical records, no "new baseline = old baseline passed" claim.
- Any future improved benchmark is a **new baseline** (new records, possibly new
  configuration groups), classified as new evidence — not a retroactive pass.
- Independently of history, G7 also FAILs over every fresh candidate set tried to date
  (v2.1 diagnostics, v2.3 candidate) — so no evidence set currently in the project satisfies
  G7 either.

**Consequence for M0:** G7 remains a FAIL gate. M0 cannot be accepted while the acceptance
evidence includes the historical record set; and no alternative evidence set in the project
passes G7 today. See `blocker_resolution.md` and `M0_FINAL_REPORT_v2.4.md`.
