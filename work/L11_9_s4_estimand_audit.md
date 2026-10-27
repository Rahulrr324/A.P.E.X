# STARK-L11.9 — Audit E: Per-task versus Pooled Estimands

**Nature:** independent review of S4 as proposed in `work/L11_8_S4_PER_TASK_VS_POOLED.md`.

---

## 1. The two estimands, restated and checked

| | per-task | pooled |
|---|---|---|
| estimand | `min_t θ_t`, `θ_t = E_s[θ_{s,t}]` | `θ̄ = (1/3) Σ_t θ_t` |
| unit | task | battery summary |
| weighting | equal (identical to trial-weighting: every cell is 120 trials) | equal |
| missing cell | INCOMPUTABLE (`min` undefined) | **must also be INCOMPUTABLE**; reweighting changes the estimand |
| compensation | none | one weak task offset by two strong ones |
| what it justifies | "each of these three tasks reaches the bar" | "the average of these three tasks reaches the bar" |

**Audit E-1 [D]:** the equality of equal-task and trial weighting holds exactly, because
every cell contributes 120 trials. This is a genuine simplification, and L11.8 states it
correctly. **It does not hold for any design with unequal per-cell trial counts**, so the
ratified text must make it conditional rather than a general claim.

---

## 2. Does the per-task gate match the fixed-battery claim?

**Yes.** The claim quantifies over **each task** explicitly ("in every task"), and the
battery is fixed and enumerated. A per-task gate is the direct operationalisation.
**Audit E-2:** there is no mismatch between the per-task gate and the claim — the mismatch
found in `claim_audit.md` §3 (CA-1) is about the **retrieval** clause's aggregation, not
about task-versus-battery.

---

## 3. How pooling conceals a task-specific failure

| model | `θ` by task | `θ̄` | pooled at 0.90 | per-task at 0.90 |
|---|---|---|---|---|
| historic L10.3 shape | 0.13 / 0.57 / 1.00 | **0.567** | **FAIL** (below 0.90) | **FAIL** |
| one weak task | 0.75 / 0.95 / 1.00 | **0.900** | **PASS** | **FAIL** |
| one severe task | 0.72 / 1.00 / 1.00 | 0.907 | **PASS** | **FAIL** |

**Audit E-3:** pooling at 0.90 admits a task at **0.72–0.75**. This is not a proof that
pooling is wrong — it is a precise statement of what it licenses, and the owner must decide
whether that is acceptable. **It is a scientific value judgment, not an arithmetic
consequence.**

The historical case is subtler than "pooling hid it": the L10.3 **pooled** number 0.5611
would *fail* a 0.90 pooled gate. What pooling concealed was the **structure** — a 0.0 cell
alongside a 1.0 cell. So the correct statement is:

> pooling is not unsafe because it passes bad models at 0.90; it is unsafe because **its
> value is uninformative about the per-task distribution**, whatever the threshold.

**Audit E-4** corrects a possible overstatement in L11.8: the danger of pooling is
**loss of information**, not automatically a false pass at any given threshold.

---

## 4. Does the pooled result have a legitimate secondary descriptive role?

**Yes**, and the frozen specification already prescribes it:

> *"Pooled values are reported alongside per-cell values, never instead of them."* **[V]**

`MixAcc` pooled is the number L10.3 published (0.5611), so reporting it preserves
comparability with the prior literature of this project. **Audit E-5:** secondary reporting
is correct and requires no decision; only **gating** on it does.

---

## 5. Inference beyond the three fixed tasks

**Not supported. [V]** There is no task-sampling frame: the three tasks are constructed by
the same permutation generator and are fixed by the prerequisite. A population claim would
require either (i) tasks drawn i.i.d. from a defined family, or (ii) a hierarchical model
with the task family specified. **Neither exists.** The same applies to seeds: three runs
estimate the procedure weakly, and no run-population model is stated.

**Audit E-6:** any L11 report must state: *"this is a demonstration on a fixed three-task
battery over three training runs; it is not an inference to a task population."*
L11.8 states this; Audit E confirms it is correct and necessary.

---

## 6. Audit E verdict

| Question | Verdict |
|---|---|
| Is the per-task gate matched to the fixed-battery claim? | **yes** |
| Does pooling conceal task-specific failure? | **yes** — it licenses a task at 0.72–0.75 |
| Is the L11.8 "pooling hid the failure" framing exact? | **not quite** — the concealment is structural, not a threshold artefact (E-4) |
| Does pooled have a legitimate secondary role? | **yes**, mandated by the frozen spec |
| Is beyond-battery inference supported? | **no**, and no sampling frame exists |

**Recommendation carried forward unchanged (not adopted): per-task primary, pooled reported
and labelled. Owner decision MET/CLM-1 (S4) remains open.**
