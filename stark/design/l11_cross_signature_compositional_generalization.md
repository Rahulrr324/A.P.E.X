# STARK-L11 — Cross-Signature Compositional Generalization

**Specification v0.1 — DRAFT / NOT RATIFIED.**
**Status:** design document produced by STARK-L11.1. It defines the capability,
the metrics and the acceptance criteria. **No criterion in this document is in
force**, no official run has been performed, and nothing here demonstrates that
the capability exists.
**Ratification required before any official measurement:** the owner must approve
§6 (thresholds) and §5 (arms/seeds) by the L10 procedure (separate questions,
recorded answers, promoted text, new version). Until then this file is a proposal.
**Governing predecessor:** `stark/design/context_conditioned_memory_milestone.md`
v1.8 (L10, CLOSED). This document does not modify, reinterpret or reopen any L10
criterion.

---

## 1. Why this milestone exists

L10 established that context **selects a memory bank**: with the correct cue the
router reaches the structural ceiling (CRA 0.6667 pooled = 3/3 tasks, diagonal
forced-bank accuracy 1.0000), and context contributes measurably against a
measured context-ignoring null (L10-K1 PASS, pooled CAA 0.5799).

L10 also left one capability unmeasured and one number misunderstood:

1. **Within-bank context modulation has never been demonstrated.** Context acts at
   exactly one level — the router's bank choice. Nothing in CCM modulates what a
   bank retrieves.
2. **The reported "cross-signature" accuracy of 0.5611 is not a composition
   measurement.** STARK-L11.1 re-derived it from the raw L10.3 trial rows: on the
   mixed cue the router's *routing* rate is 0.0000 / 0.5019 / 1.0000 by task index
   and is **identical across all three primary seeds**, while accuracy *given the
   resolved bank* is **1.0000 in every cell**. The published 0.5611 is therefore
   `0.5019 × 1.0 + 0.4981 × 0.132` — allocation-order weight mass plus the
   wrong-bank chance floor. Details and evidence:
   `work/L11_1_SPECIFICATION_AND_INSTRUMENTATION.md` §C.

L11 exists to replace that number with a measurement that can actually be
falsified.

## 2. Operational definition

> **Cross-signature compositional generalization** is the ability to take a cue
> built from features that belong to **two or more distinct training signatures**,
> in a **feature-count ratio the system has never been trained on**, and
> (C1) resolve it deterministically to the bank that a **pre-declared** rule
> prescribes — on every task, on every seed, and **independently of the order in
> which banks were allocated** — and
> (C2) retrieve the correct response from that bank.

**This is not**, and must never be reported as:

- ordinary interpolation inside one signature (that is L10's `holdout` arm, 0.9981,
  and it is a *control* here, not the capability);
- a previously observed cue combination;
- "the router happened to pick a bank" — the order-permuted control arm (§5, A9)
  exists precisely to deny that reading;
- general compositional intelligence. Two-feature toy cues resolved by a declared
  counting rule are a *necessary* condition at best.

### 2.1 Declared rule (fixed in the protocol, not chosen after seeing results)

**R-majority.** For a cue with features from signature groups `g`, the resolved
bank is the bank that owns the group contributing the **most features**. Ties are
broken by the **lowest bank index**. The rule is declared in
`stark/design/l11_1_protocol.md` §4 and frozen with the protocol hash. A result
that contradicts R-majority is a result, not a mis-specification.

## 3. Cue categories

Ten categories, each with a construction, a training status and a distinct causal
reading. Codes are carried per trial as `cue_category` in the trial schema.

| Code | Construction | Seen in training? | Causal question |
|---|---|---|---|
| `TRAIN` | one of the 4 within-signature pairs used for training | yes | ceiling reference |
| `HOLDOUT` | one of the 2 withheld within-signature pairs, same group | **no** | interpolation over known features (control, not capability) |
| `CROSS21` | 2 features from group A + 1 from group B | **no** (count ratio absent from training) | **primary composition test** |
| `CROSS31` | 3 from A + 1 from B | **no** | monotonicity: a larger majority must not be harder |
| `AMBIG11` | 1 from A + 1 from B | **no** | declared tie-break compliance only; carries no accuracy claim |
| `PARTIAL` | one of the two features of a training pair | partially | degraded context |
| `MISLEAD` | all features from a *wrong* group | **no** | does the rule hold when following it yields the wrong answer? |
| `OFF` | cue empty | n/a | context removed, no bank substitution |
| `SHUFFLED` | cue taken from another task, registered procedure | mismatched | contradictory context |
| `ORDERPERM` | `CROSS21` evaluated after training in a permuted task→bank order | **no** | separates rule-following from allocation recency |

`MISLEAD` has no "correct" accuracy reading by construction (the intended task's
answer is not what the prescribed bank returns); it is scored only for
rule-compliance and for whether the resolved bank retrieves *its own* mapping.

## 4. What the milestone cannot establish

- It cannot show that context modulates retrieval *within* a bank (§1, item 1).
- It cannot show that the system would generalize to cues with more than two
  signatures at larger scale (T=3, K=3 only).
- It cannot separate "follows R-majority" from "follows *some* deterministic
  per-signature-magnitude rule" except through A3 (3:1) and A9 (order permutation);
  if both pass and a third rule also predicts them identically, the design cannot
  distinguish those rules. This is a known, accepted limitation of a two-feature
  cue space and is recorded in advance.
- No result here is evidence of general intelligence or autonomous cognition.

## 5. Seeds and arms

**Seeds (7, fixed):**

| Role | Seeds |
|---|---|
| primary (carried from L10) | 123456789, 218213831, 171473193 |
| development | 1, 2 |
| **held out from all L11 design tuning** | 7, 42 |

Honesty note: seeds 1, 2, 7, 42 were used as *auxiliary* seeds in L10.4. They are
"held out" from **L11 design decisions**, not from all prior exposure. No design
choice may be revised after seeing seed 7 or 42 results; if it is, this disclosure
must be reproduced in the report.

**Arms (per seed), all evaluated with learning disabled on a frozen snapshot:**

| ID | Arm | Training | Evaluation cue | Role |
|---|---|---|---|---|
| A0 | correct-cue ceiling | standard order | `TRAIN` | attainable ceiling |
| A1 | holdout combination | standard order | `HOLDOUT` | control (existing capability) |
| A2 | **composition 2:1** | standard order | `CROSS21` | **primary** |
| A3 | composition 3:1 | standard order | `CROSS31` | monotonicity |
| A4 | ambiguous 1:1 | standard order | `AMBIG11` | tie-break compliance |
| A5 | partial cue | standard order | `PARTIAL` | degraded context |
| A6 | misleading cue | standard order | `MISLEAD` | rule under contradiction |
| A7 | shuffled cue | standard order | `SHUFFLED` | contradictory context |
| A8 | context off | standard order | `OFF` | measured null |
| A9 | **order-permuted composition** | reversed task order | `CROSS21` | **order control** |
| A10 | frozen router | standard order | `CROSS21` | zero-weight router → lowest allocated bank |

**Matched pairs:** A2/A9 have identical evaluation and seed and differ only in
training order. A0/A2 share the training snapshot. A3 is evaluated on the same
snapshot as A2. A10 uses zero-initialised router weights, reproducing the
"no learned routing" configuration.

## 6. Acceptance criteria (candidate — require ratification)

| ID | Criterion |
|---|---|
| **L11-A** | `Comp(A2, t) ≥ 0.90` on every task `t` and every seed |
| **L11-B** | `MixAcc(A2, t) − Null(t) ≥ 0.50` on at least two of three tasks, on every seed |
| **L11-C** | no cell `(seed, task)` in A2 or A3 below **0.50** |
| **L11-D** | `Read(A2, t) ≥ 0.90` on every task and seed (retrieval preserved after resolution) |
| **L11-E** | reruns byte-identical; checkpoint/resume exact |
| **L11-F** | no new failures vs the L10 regression baseline (26/26 inherited + the L11 test set) |
| **L11-G** | `Comp(A2) − Comp(A9) ≥ −0.10` on every seed (rule-following survives a change of allocation order) |

**Statistical character of L11-A at n=120 trials/task** (exact binomial, computed
in L11.1): the pass condition is ≥108/120. `P(pass | true=0.95) = 0.9928`;
`P(pass | true=0.90) = 0.5761`; `P(pass | true=0.85) = 0.0746`. The threshold is
therefore a **discriminating** test against 0.85 (92.5 % rejection) but is a coin
flip against exactly 0.90; 95 % Wilson half-width at 0.90 is ≈5.4 pp. Reporting
must include intervals, and a pass must be phrased as "consistent with ≥0.90 at
n=120", never as "≥0.90 established".

**Deliberately not a criterion:** pooled accuracy across tasks or seeds. L10's
0.5611 is exactly the kind of pooled number that hides a 0.0/0.5/1.0 structure.
Pooled values are reported alongside per-cell values, never instead of them.

## 7. Outcome taxonomy

- **PASS** — every criterion holds on every seed with the protocol as frozen.
- **FAIL** — a criterion misses with its number, reported per cell.
- **INCONCLUSIVE** — a predefined validity condition fails (invalid eval call,
  missing rows, capacity exhaustion at K=3, non-deterministic rerun). Inconclusive
  is not a pass and not a failure and may not be re-run until the cause is fixed
  and reported.
- **SPECIFICATION FAILURE** — `Comp` low but `MixAcc` high (the rule was wrong, the
  system was not). Recorded as a failure of this specification, not of the system.
- **RETRIEVAL FAILURE** — `Comp` high, `Read` low. A different mechanism problem
  from a routing failure and must be reported separately.
- **SHORTCUT** — `Comp(A2)` high but `Comp(A9)` collapsed, or `Comp(A10)` matches
  `Comp(A2)`: the measurement is explained by allocation order or by not needing a
  router at all.

## 8. Threshold-change policy

No threshold in this document may be adjusted in response to a result. The only
permitted route is a new versioned specification with an explicit owner decision,
published **before** evidence for the revised threshold exists, preserving the
original threshold and the original result in the revision log. A criterion that
cannot measure what it claims must be **retired and replaced by a separate new
criterion** — the L10-E → L10-K1 precedent — never quietly retuned.

## 9. Explicit non-goals

No new learning algorithm. No change to CCM's dynamics, readout, router, sealing or
allocation. No change to any L10 criterion, threshold or artifact. No scale-up. No
official key result until the protocol hash is committed (this document defines the
subject; `l11_1_protocol.md` defines the run).

## 10. Revision log

| Version | Date | Change | Status |
|---|---|---|---|
| 0.1 | 2026-10-24 | initial design; capability definition, categories, arms, candidate criteria | **DRAFT — not ratified** |
