# STARK-L11.7 — Candidate Acceptance-Contract Redesign (UNREGISTERED)

> # ⚠ CANDIDATE — NOT REGISTERED — NOT AUTHORIZED
>
> Nothing here is a criterion. Nothing here is ratified. **No frozen threshold is
> changed.** Every item is a proposal for owner decision and carries **[P]**.
> The operative document remains
> `stark/design/l11_cross_signature_compositional_generalization.md` §6 (unratified,
> `DRAFT_NOT_RATIFIED`) and `l11_1_protocol.md` §7 (`PENDING OWNER RATIFICATION`).

---

## 1. The three defects the redesign must answer

| # | Defect | Evidence |
|---|---|---|
| **δ1** | **The contract is a conjunction of nine screening gates with no stated error rate, and its operating point is ~0.94–0.99, not 0.90.** | joint power at a true 0.90 = 0.007 (independent) / [0, 0.576] (Fréchet); true `p` needed for 80 % joint power = 0.9412 **[D]** |
| **δ2** | **L11-B's baseline is a measured nuisance quantity**, so "0.50 above the null" means "0.86–1.00 MixAcc", and on two measured cells it means **exactly 1.000** | §4 of the audit, measured `Null(t)` from L10.4 **[V]** |
| **δ3** | **The trial is treated as the unit of inference; the model run is.** 120 trials per cell share one checkpoint; independent replication is `n = 3` seeds | **[D]** — see §2 |

δ3 is the one that frames all the others: **`n = 120` describes measurement precision
for a fixed model, not evidence about a method.** All of the audit's power numbers are
conditional on a *fixed* per-cell `p`; the run-to-run variance of `p` itself is estimated
from three runs and is not modelled anywhere in the frozen artifacts **[U]**.

---

## 2. Per-criterion specification — defined vs undefined

| ID | Purpose | Definition | Threshold | Decision rule | Missing / ties | Status |
|---|---|---|---|---|---|---|
| **L11-A** | resolution must be correct for **every** task | `Comp = mean(routing_correct)` on `CROSS21` **[V]** | 0.90, cells ≥ 108/120 **[V]** | per-cell gate, all 9 **[V]** | `n<120` ⇒ whole call INVALID **[V]** | **defined; over-conjunctive** |
| **L11-B** | composition beats a context-ignoring policy | `MixAcc − Null(t)`; `Null(t)` = forced-bank mean **[V]** | 0.50 absolute **[V]** | ≥ 2 of 3 tasks, every seed **[V]** | forced-cell count **unstated** **[U]** | **defined but miscalibrated; near-infeasible** |
| **L11-C** | no composition cell collapses | **metric unnamed** **[V]** | 0.50 **[V]** | "no cell below" (cell count unstated; 9 or 18) **[U]** | none stated **[U]** | **underspecified; near-vacuous** |
| **L11-D** | retrieval survives resolution | `Read = mean(correct|routing==1)` **[V]** | 0.90 **[V]** | per-cell gate, all 9 | **denominator random**; `Comp=0` ⇒ UNDEFINED **[D]** | **defined; denominator not controlled** |
| **L11-E** | determinism / resume | byte identity **[V]** | exact | exact | n/a | **defined; deterministic, not statistical** |
| **L11-F** | no regressions | suite pass count **[V]** | 0 new failures | suite | one inherited test cannot build **[V]** | **blocked by R2** |
| **L11-G** | rule-following survives order change | `Comp(A2) − Comp(A9)` **[V]** | −0.10 **[V]** | per seed, pooled over tasks | unstated | **defined; nearly non-binding** |

**Undefined in the frozen text:** the test statistic for any criterion; α; power; the
multiplicity rule; the dependence model; the cell count for L11-C; the missing-data
policy for B, C and G; the aggregation for G (per-task or pooled).

---

## 3. Candidate statistical tests **[P]**

### 3.1 L11-B — four candidate specifications

Let `m = MixAcc(A2,t)`, `N(t)` = forced-bank null, `n = 120`.

| ID | Candidate | What it claims | Why |
|---|---|---|---|
| **B1** | **headroom-normalised**: `(m − N)/(1 − N) ≥ τ`, τ = 0.75 | the model closes 75 % of the gap between a context-ignoring policy and perfection | removes the nuisance parameter from the threshold's meaning; τ has a fixed interpretation on every cell |
| **B2** | **absolute floor**: `m ≥ 0.90` on ≥ 2 of 3 tasks, every seed | composition accuracy of 0.90 on two tasks | what "0.50 above ≈0.40" was evidently intended to mean; simple, and does not depend on a measured baseline |
| **B3** | **difference with an honest variance**: two-sample z on `m − N̂`, `se = sqrt(p̂₁(1−p̂₁)/120 + (1/9)Σ_k p̂_k(1−p̂_k)/120)`, one-sided α = 0.05, Bonferroni over tasks | the difference exceeds `δ` with stated confidence | `Null` is a mean of three proportions, so its variance is `(1/9)Σ p_k(1−p_k)/n`, **not** `p(1−p)/n` as a naive test would assume |
| **B4** | **paired contrast against A10** (frozen router) | learned routing beats the no-learned-routing fallback on the *same cues* | A10 exists, is matched, and gives a true paired comparison — but it tests a **different claim** ("is the router learned", not "is context used") |

**Recommended [P]: B1 for the claim, B2 as the reporting line.** B4 is scientifically
cleaner but changes the claim and must be an owner decision, not an arithmetic one.

Quantified, at a true `m = 0.95` and the measured nulls: B1 with τ = 0.75 requires
`m ≥ N + 0.75(1−N)`, i.e. 0.875 (N=0.50) to 0.833 (N=0.333) — **satisfiable**; B2
requires 0.90 — satisfiable; the frozen B requires up to 1.000 — **not**.

### 3.2 L11-G — three candidate specifications

| ID | Candidate | Claim | Note |
|---|---|---|---|
| **G1** | status quo: `d_s ≥ −0.10` per seed, no test | none stated | fails with probability < 10⁻⁴ at zero effect ⇒ **nearly non-binding** |
| **G2** | **paired (McNemar) one-sided test**, `H0: δ ≤ −0.10`, lower 95 % bound of `d` ≥ −0.10, per seed | rule-following survives order change, with stated confidence | correct given the matched design **[V]**; `var(d) = (ψ − δ²)/360` |
| **G3** | **pooled fixed-effect** over 3 seeds (CMH), one one-sided test | the order effect is not worse than −0.10 overall | one test instead of three; must be declared **before** seeing seeds |

**Recommended [P]: G2**, with G3 reported alongside. Note that neither changes what the
criterion can detect: at three seeds the run-to-run variance dominates.

### 3.3 L11-A — aggregation candidates (threshold unchanged at 108/120)

| ID | Rule | Claim | `P(pass)` at 0.90 / 0.93 / 0.95 **[D]** |
|---|---|---|---|
| **D0** | all 9 | every task, every seed | 0.007 / 0.484 / 0.937 |
| **D1** | ≥ 7 of 9 | at most two cells below bar | 0.189 / 0.973 / 1.000 |
| **D2** | ≥ 8 of 9 | at most one cell below bar | 0.053 / 0.850 / 0.998 |
| **D3** | every task on ≥ 2 of 3 seeds | every task, robust to one bad run | 0.231 / 0.950 / 0.9995 |

**Recommended [P]: D3**, because it preserves the "every task" claim (the scientific
point of L11-A) while removing the one-seed-one-lottery property, and it uses a
k-of-n structure the contract already uses elsewhere.

---

## 4. Candidate acceptance matrix **[P]**

Reported per criterion; **none ratified**.

| ID | Metric | Unit | Cells | Threshold (unchanged unless marked) | Statistic | α | Multiplicity | Missing data | Joint effect |
|---|---|---|---|---|---|---|---|---|---|
| A | `Comp` on CROSS21 | (seed, task), 120 trials | 9 | 0.90 (108/120) | exact binomial gate | none (gate) | **D3: per-task 2-of-3** | call < 120 ⇒ INVALID | dominant routing gate |
| B | `MixAcc − Null` | (seed, task) | 3 seeds × 2 of 3 | **τ = 0.75 of headroom** *(proposed)* | normal-difference with honest `se` | 0.05 one-sided | Bonferroni /3 | forced-cell count must be fixed | gates composition use |
| C | `MixAcc` on **A3 only** *(proposed)* | (seed, task) | 9 | 0.50 *(retained)* | exact binomial gate | none | — | as A | residual only |
| D | `Read` + **denominator** | (seed, task) | 9 | 0.90 | exact gate on `n_elig` | none | — | `n_elig < 30` ⇒ NOT ESTIMABLE | retrieval gate |
| E | byte identity | run | 2 runs/seed | exact | — | — | — | — | deterministic |
| F | suite | suite | 1 | 0 new failures | — | — | — | R2 must be resolved first | blocking |
| G | `Comp(A2) − Comp(A9)` | seed | 3 | −0.10 | **McNemar, paired** *(proposed)* | 0.05 one-sided | 3 seeds ⇒ ≤ 3α | unstated | order control |

**Reporting additions [P]:** every cell reports its `n`; every pass is phrased
"consistent with ≥ X at n = 120"; the **joint power is printed beside every conjunctive
result**; and the number of **independent runs (3)** is stated wherever a claim about the
method is made.

---

## 5. Migration table

| Item | Class | Frozen text affected | Numeric effect on existing criteria |
|---|---|---|---|
| State the test statistic for B and G | **clarification** | none — fills an absence | none |
| State α and the multiplicity rule | **clarification (new policy)** | none | none |
| Report `Read` with its denominator; `n_elig < 30` ⇒ NOT ESTIMABLE | **clarification** | L11-D | none on pass/fail at `Comp ≥ 0.90` |
| Replace "all 9 cells" with "every task on ≥ 2 of 3 seeds" (D3) | **NEW ACCEPTANCE CRITERION** | L11-A | raises power at 0.90 by 33× |
| Replace `MixAcc − Null ≥ 0.50` with headroom `τ = 0.75` (B1) | **NEW ACCEPTANCE CRITERION** | L11-B | turns a near-infeasible gate into a satisfiable one |
| Restrict L11-C to A3 | **NEW ACCEPTANCE CRITERION** | L11-C | removes 9 predicates; no coverage loss given A ∧ D |
| Adopt McNemar for G | **clarification** (the design is already paired) | L11-G | none at δ = 0; tightens the margin slightly |
| Report joint power beside every result | **clarification (reporting)** | none | none |
| Add "independent replicates = 3 seeds" to every claim | **CLARIFIES THE SCIENTIFIC CLAIM** | spec §6 (character paragraph) | none numerically; **changes what a PASS means** |
| Adopt B4 (paired A10 contrast) instead of the forced-bank null | **CHANGES THE SCIENTIFIC CLAIM** | L11-B | different hypothesis entirely |
| Replace the conjunction with a global pooled statistic (§8.1 of the audit) | **CHANGES THE SCIENTIFIC CLAIM** | L11-A | supports "pooled rate > 0.90", **not** "every task" |

**Four items change the claim; four change acceptance criteria; the rest are
clarifications.** The specification's explicit prohibition on pooled substitution
("pooled values are reported alongside per-cell values, never instead of them" **[V]**)
means the last row cannot be adopted without the owner deliberately reversing a stated
design principle.

---

## 6. Readiness — what must be ratified before implementation

| # | Gate | Current |
|---|---|---|
| 1 | R5 (L11-C metric) | **open** |
| 2 | R4, R4b, R4c | **open** |
| 3 | F1, F2, F4 | **open** |
| 4 | R5b | **deferred** |
| 5 | R1 — ratify A–G, **now including the aggregation rule and the statistical reporting** | **open** |
| 6 | R6 — hash recording | **open** |
| 7 | C1–C7 | **0 of 7** |
| 8 | R2 — the non-building inherited test | **open** |
| 9 | **NEW: choose an aggregation rule (D0/D1/D2/D3) and an L11-B specification (B1/B2/B3/B4)** | **open** |
| 10 | **NEW: decide whether the claim is "every task" or "pooled"** | **open** |

**Implementation remains unauthorised. Official evaluation remains unauthorised.**
