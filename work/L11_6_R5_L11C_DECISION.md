# STARK-L11.6 — R5: L11-C Metric, Threshold, and Exact Amendment Text

**Status: UNRESOLVED. Requires owner decision.** No amendment is registered or applied.
Tags: **[V]** verified · **[A]** artifact · **[C]** computed here · **[I]** inferred ·
**[P]** proposed · **[?]** unknown.

---

## 1. The frozen object, exactly

**Verbatim [V]**, from `stark/design/l11_cross_signature_compositional_generalization.md:145`:

> | **L11-C** | no cell `(seed, task)` in A2 or A3 below **0.50** |

Identical in intent in `work/L11_1_PREREGISTRATION.json:55` (registered),
`work/L11_1_SPECIFICATION_AND_INSTRUMENTATION.json:127` and `.md:252`.
**None names a metric.**
`git grep -n "L11-C"` over the whole repository returns no implementation **[V]**.

---

## 2. The five questions the mission requires, answered separately

### 2.1 Was `MixAcc` ever explicitly authorized?

**No.** Evidence, all **[V]**:

| Artifact | Question | Answer |
|---|---|---|
| Preregistration `criteria_candidate.ratification` | is anything ratified? | `PENDING_OWNER_DECISION` |
| Preregistration `status` | — | `PROTOCOL_FROZEN_FOR_REVIEW / THRESHOLDS_PENDING_OWNER_RATIFICATION` |
| Protocol §7 | — | "**Status: PENDING OWNER RATIFICATION.** … it does not itself authorise an official run." |
| Preregistration `owner_decisions_required` R1 | — | "L11 thresholds L11-A..L11-G", `blocking: true` |
| Readiness proposal `E.8` heading | is the proposal authoritative? | "Fixed pass/fail (**proposed; requires owner ratification before the run**)" |

**Finding [V]: no L11 acceptance criterion, and no L11 metric name, has ever been
authorized.** The word "authorized" does not appear in connection with L11-C anywhere
in the repository.

### 2.2 Does the proposal restore an intended definition, or create a new one?

**It is a restoration in content and a new decision in authority. The two do not
coincide, and the evidence cannot make them coincide.**

| Evidence for *restoration* | Evidence against *authorization* |
|---|---|
| The readiness proposal (commit `ba1cfb3`) states L11-C with **`MixAcc`** **[V]** `L11_READINESS_ASSESSMENT.md:254` | that document is explicitly "proposed; requires owner ratification" **[V]** `:245` |
| `ba1cfb3` is a **verified ancestor** of the freeze `77d261a` **[V]** (`git merge-base --is-ancestor`) | being an ancestor does not make a proposal authoritative |
| The freeze declares the criteria "**unchanged from the readiness proposal except where marked**" and marks **only** L11-G **[V]** `L11_1_SPECIFICATION_AND_INSTRUMENTATION.md:250–253` | the frozen text nevertheless omits the metric name, and no record explains the omission |
| The motivating statistic is an accuracy statistic — pooled 0.5611 with a 0.0 cell **[V]** `L10_6_MILESTONE_SIGNOFF.md:252` | the *pooled clause* was dropped at the same time, so the omission was not selective |

**[I]** The omission is best explained as a drafting regression. But a drafting
regression that was never ratified is still an unauthorised definition, and adopting it
now is an owner decision.

**Classification (operative): a new acceptance-criterion decision** — with the
restoration evidence as its justification, and the limitation stated plainly: the
repository contains no ratification record, so categories cannot be separated
conclusively.

### 2.3 Does the threshold have an evidence-backed scientific justification?

**No. Stated plainly: the 0.50 threshold has no derivation anywhere in the record.**

| Artifact | Justification given |
|---|---|
| `L11_READINESS_ASSESSMENT.md:254` | **none**. The only gloss is the parenthetical "(the clause that would have caught L10.3's 0.0 cell)" — a *purpose*, not a *derivation* |
| protocol, specification, preregistration | none **[V]** |
| `L11_1_PREREGISTRATION.json.statistical_character` | covers **L11-A only**; nothing for L11-C **[V]** |

What *can* be said without inventing anything **[C]** (n = 120 per cell, pass iff
≥ 60/120):

| true MixAcc | P(pass), single cell |
|---|---|
| 0.167 (naive chance) | 0.0000 |
| 0.333 (routing chance) | 0.0001 |
| **0.4259 (L10-measured fallback floor)** | **0.0612** |
| **0.50 (the threshold)** | **0.5363** |
| 0.55 | 0.8833 |
| 0.60 | 0.9895 |

Wilson 95 % half-width at 0.50 ≈ **0.088**.

**So:** 0.50 is a defensible **collapse detector against the measured floor of 0.4259**
(rejecting it 94 % of the time), and a **coin flip at its own value**. That is the
entire defensible content. It is not a capability threshold and must not be reported as
one. **I will not manufacture a derivation for it.**

### 2.4 Does the rule behave sensibly when routing succeeds but retrieval fails?

| A3 cell | `Comp` | `Read` | `MixAcc` | `(b) Comp` reading | `(a) MixAcc` reading |
|---|---|---|---|---|---|
| routes perfectly, reads nothing | 1.00 | 0.00 | **0.00** | **PASS** | **FAIL** |
| reads perfectly from the wrong bank | 0.00 | — | ≈1.00 | FAIL | **PASS** |
| uniformly mediocre | 0.55 | 0.55 | ≈0.55 | PASS | PASS |

**The `Comp` reading passes a routing-only system that has lost retrieval — the exact
inverse of the L10 failure shape L11-C was written to catch.** The `MixAcc` reading
fails it, and instead passes a system that ignores routing entirely — a different
failure. **Neither reading dominates; they are different predicates [C].**

### 2.5 Is the per-cell scope and aggregation fully specified?

| Aspect | Specified in the frozen text? |
|---|---|
| metric | **no** |
| unit (cell = seed × task) | yes, implicitly ("cell `(seed, task)`") |
| arms | yes — "in A2 or A3" |
| numerator / denominator | **no** |
| minimum `n` / short-call policy | **no** for L11-C (protocol §8(ii) covers it generally) |
| aggregation / conjunction over cells | **no** — "no cell … below 0.50" implies a conjunction, but the cell count is never stated |
| missing-cell policy | **no** |
| statistical reporting requirement | **no** (only L11-A has one) |

**Finding [C], new:** the conjunction's size is unstated and matters enormously. If
"every `(seed, task)` in A2 or A3" means 3 seeds × 3 tasks × 2 arms = **18 cells**, then
at a true `MixAcc` of 0.50 the joint probability of passing is **1.3 × 10⁻⁵**, and at
0.55 it is **0.107**. At 0.60 it is 0.83. **A criterion that reads like a 0.50 floor is
in practice a ~0.55–0.60 requirement.**

---

## 3. Recommendation

**[P] Adopt (a): `L11-C := MixAcc`, per `(seed, task, arm)` cell, `arm ∈ {A2, A3}`,
threshold 0.50 unchanged, no pooled clause.**

Grounds, none of which is a score (no L11 data exists — the arms are unimplemented
**[V]**):

1. The only artifacts naming the metric say `MixAcc` **[A]**, and the freeze declared
   L11-C unchanged **[V]**.
2. It is the only reading that fails the failure mode the criterion was chartered to
   catch on its only non-redundant cell (§2.4) **[C]**.
3. It matches the motivating statistic's kind (accuracy, not routing) **[V]**.
4. It changes no threshold and adds no clause.

**Rejected:** (b) `Comp` — passes "reads nothing"; (c) conjoined — adds a routing floor
on A3 that no criterion requests, which is a *new requirement*, not a clarification;
(d) undefined — an evaluable criterion that is not evaluated blocks every run.

**Explicitly stated:** the change is **not monotone** and **is not a strengthening**.
It is a redefinition, and it must be registered as one.

---

## 4. Exact amendment text for owner approval

> **§7, L11-C (replaces the single frozen line)**
>
> | **L11-C** | `MixAcc` ≥ 0.50 in **every** cell `(seed, task, arm)`, for every primary
> seed, every task `t ∈ {0,1,2}`, and `arm ∈ {A2, A3}`. |
>
> `MixAcc(seed, task, arm) = (1/n) Σ 1[choice == perm_task[queried]]` over rows with
> `record_status == OK` and `ACC` in `metric_eligibility`. `n` is expected to be 120.
> A cell with `n = 0`, or an evaluation call that delivered fewer than 120 trials, is
> **INCONCLUSIVE** — never a pass, never imputed, never dropped (protocol §7, §8).
> The threshold is **0.50**. It is not adjusted after any number is seen.
> A pass is reported as "consistent with ≥ 0.50 at n = 120 in all N cells", stating N,
> and never as "≥ 0.50 established".

**Nothing else in §7 changes.** L11-A, B, D, E, F and G are untouched by R5.

---

## 5. R5b — kept separate, and not adopted

**A pooled threshold cannot be evaluated until four things are fixed. They are fixed
below as a candidate, not as a requirement:**

| Element | Candidate |
|---|---|
| **Population of observations** | rows in arm ∈ {A2, A3}, `record_status == OK`, `ACC`-eligible, at the primary seeds and tasks `{0,1,2}` |
| **Aggregation formula** | `MixAcc_pooled(seed, arm) = (1/3) Σ_{t∈{0,1,2}} MixAcc(seed, t, arm)` — an **unweighted mean of per-task values**, never a pooled count (protocol §6 forbids counts) |
| **Threshold** | 0.75 (as in the readiness proposal), to be applied to every primary seed and both arms |
| **Missing-cell policy** | if any of the three per-task cells is `NA`/INCONCLUSIVE, the pooled value is `NA` and the criterion is INCONCLUSIVE; it is never computed over the surviving cells |

**Status: NOT ADOPTED.** It was absent from every frozen artifact **[V]**, its
population was undefined **[V]**, and adding a threshold under the heading of a
clarification is precisely what the safeguards forbid. If adopted it is a **separate
acceptance-criterion change**.

---

## 6. What would settle R5

One sentence from the owner. Nothing else. The analysis is complete; further documents
cannot substitute for the decision.
