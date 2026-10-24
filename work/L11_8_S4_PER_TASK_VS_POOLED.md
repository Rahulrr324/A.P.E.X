# STARK-L11.8 — S4: Per-Task versus Pooled

**Nature:** analysis only. **No claim adopted.** **[P]** for the recommendation.

---

## 1. The two estimands, defined

Let `θ_{s,t}` be the accuracy of the model trained with seed `s` on task `t` with cue
category `CROSS21`, measured over 120 trials.

| | **Per-task claim** | **Pooled claim** |
|---|---|---|
| Estimand | `min_t θ_t` where `θ_t = E_s[θ_{s,t}]` | `θ̄ = (1/3) Σ_t θ_t` |
| Claim form | `min_t θ_t ≥ 0.90` | `θ̄ ≥ 0.90` |
| Unit | task | battery |
| Weighting | equal per task (all cells are 120 trials, so equal per task = equal per trial) | same |
| Aggregation formula | `min` over tasks — **not** a mean | unweighted mean of three per-task means; equivalently `Σ_t X_t / 360` |
| Handling of a task failure | **the claim fails**; no compensation | one weak task can be offset by two strong ones |
| Missing cell | claim INCOMPUTABLE (min is undefined) | **must also be INCOMPUTABLE** — reweighting would change the estimand |
| What a result justifies | "every one of these three tasks reaches the bar" | "the average over these three tasks reaches the bar" |

### 1.1 The population question, and why it cannot be answered here

Neither estimand characterises a **task population**. There is no defined sampling frame
for L11 tasks: the three tasks are fixed, named, and constructed by the same generator with
different permutations **[V]**. Therefore:

- A per-task claim is a **demonstration on a fixed, fully specified battery**.
- A pooled claim is a **summary of the same battery**.

**Neither supports "tasks in general".** Any attempt to read a task-population estimand
into three fixed tasks is **[U]** and must be refused in the ratified text. The same
applies, transitively, to the seed dimension: three seeds estimate the training procedure,
weakly.

---

## 2. Why pooled is the wrong summary *for this programme* — decisive evidence

The failure L11 exists to repair **was invisible in the pooled number**:

| quantity | value | source |
|---|---|---|
| L10.3 published cross-cue accuracy (pooled) | **0.5611** | **[V]** |
| same run, routing rate by task | **0.0000 / 0.5019 / 1.0000** | **[V]** |
| same run, accuracy given resolved bank | **1.0000** in every cell | **[V]** |

The pooled number looked like a partial success. The cell structure was a total failure on
one task, a coin flip on another, and perfection on the third. **A pooled criterion at any
threshold between 0.13 and 1.0 is compatible with that state.**

The frozen specification already draws this conclusion explicitly:

> *"Deliberately not a criterion: pooled accuracy across tasks or seeds. L10's 0.5611 is
> exactly the kind of pooled number that hides a 0.0/0.5/1.0 structure. Pooled values are
> reported alongside per-cell values, never instead of them."* **[V]**

**Adopting a pooled criterion would reverse the single most explicit design principle in
the specification.** That is an owner decision of the largest possible kind — it is a
change in the scientific claim, not a statistical convenience.

---

## 3. Power — the honest motivation for wanting pooled **[D]**

| rule | `P(pass | p = 0.90)` | `P(pass | p = 0.95)` | claim |
|---|---|---|---|---|
| per-cell, all 9 (D0) | 0.00699 | 0.9371 | every cell |
| per-task, 2 of 3 runs (D3) | 0.2306 | 0.9995 | every task, robust to one run |
| run-level mean ≥ 0.90 (D4) | 0.1612 | 0.9999 | battery mean, every run |
| pooled 1080 trials (D5) | 0.5256 | 1.0000 | pooled rate |

So pooled is 75× more powerful than D0 at the target. **But it is more powerful precisely
because it stops asking the question L11 was created to ask.**

**Note also:** D3 is *more* powerful than D4 (0.231 vs 0.161) while making a *stronger*
claim. There is no version of this trade in which the pooled or mean-based rule is the
efficient choice — the apparent power gain only appears when the claim weakens all the way
down to a single pooled proportion.

---

## 4. What pooled would allow, concretely

At `θ = (0.99, 0.99, 0.60)`: `θ̄ = 0.86` — pooled **fails** 0.90, so this particular
example is not a false pass. At `θ = (1.00, 1.00, 0.72)`: `θ̄ = 0.907` — pooled **passes**
with one task at 0.72. At `θ = (1.00, 0.95, 0.75)`: `θ̄ = 0.90` — pooled **passes** with one
task at three-quarters of the bar.

**A pooled claim at 0.90 is compatible with a task at 0.72–0.75.** Whether that is
acceptable is a scientific judgement, not a statistical one — but it must be made
explicitly, and the specification has already made it in the opposite direction.

---

## 5. Secondary results that must be reported either way **[P]**

Regardless of which claim is primary, every L11 report should print:

1. the nine per-cell `Comp` values with exact binomial intervals;
2. `Read` **with its denominator** (`n_elig`);
3. the measured `Null(t)` per cell with standard error;
4. `MixAcc` per cell, and the pooled `MixAcc` **labelled as pooled**;
5. the joint power implied by the aggregation rule actually used;
6. the number of independent runs (3) and the number of tasks (3), stated next to every
   claim about the method;
7. `AMBIG11` behaviour as diagnostic only (R4 open);
8. the `A2` vs `A10` contrast and the `A2` vs `A3` ordering (both **[U]** as criteria).

**Reporting pooled is not the problem. Gating on pooled is.**

---

## 6. Recommendation **[P]**

**Adopt the per-task claim, with the "at least two of three runs" robustness form (D3).**

| Consideration | Verdict |
|---|---|
| Preserves the programme's stated principle | yes **[V]** |
| Detects the historical failure mode | yes — the L10.3-shaped model fails with probability 10⁻¹⁶¹ **[D]** |
| Power at the target | 0.231, 33× D0 — adequate for a screening gate, still modest |
| Dependence-robust | yes — spread 0.039 across dependence assumptions **[D]** |
| Honest about scope | states a fixed-battery demonstration, not a population claim |

**Conditions attached to the recommendation:**
- the report must print the joint power beside the result;
- the report must state that 3 tasks and 3 seeds are a demonstration, not a sample;
- the pooled number is still reported, **labelled pooled**, and never substitutes for a
  per-task result.

**Not recommended:** the pooled criterion (reverses a stated principle), the run-mean
criterion (dominated by D3), and any claim about a task population (no sampling frame).

---

## 7. Status

**PROPOSED. Not ratified. The frozen text remains "every task and every seed", which is
D0 — the least powerful of the four.**
