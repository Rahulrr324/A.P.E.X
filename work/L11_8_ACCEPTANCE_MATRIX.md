# STARK-L11.8 — Candidate L11-A…G Acceptance Matrix (UNREGISTERED)

> **CANDIDATE. NOT REGISTERED. NOT AUTHORIZED.** No row is ratified. No threshold here
> overrides a frozen artifact. Frozen values are marked **[F]**; every change is **[P]**.

**All arithmetic:** `work/L11_8_power/claim_audit.py` (transcript in
`work/L11_8_power/claim_audit_output.txt`). Nothing was executed on STARK **[X]**.

---

## 1. The matrix

| ID | Metric & exact formula | Evaluation unit | Sampling unit | Structure | Threshold **[F]** / rationale | Test or gate | H₀ / H₁ | Dependence | Missing data | Multiplicity | Power target | PASS means | FAIL means |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **A** | `Comp = (1/n)Σ1[selected_bank == task_bank]` on `CROSS21` | (seed, task) | trial | 3 seeds × 3 tasks × 120 | **0.90 [F]**; equals a one-sided 5 % test of `p ≤ 0.8430`, not of `p ≤ 0.90` **[D]** | per-cell exact binomial gate | none stated immediately; equivalently `H₀: p ≤ 0.8430` at α = 0.05 | **not stated [U]**; cells share checkpoints and task difficulty | call < 120 ⇒ INVALID **[F]** | per-task 2-of-3 (D3) **[P]** replaces the 9-fold conjunction | ≥ 0.90 per seed for a "consistent with" claim | "every task reached 0.90 on ≥ 2 of 3 runs" | "some task failed on ≥ 2 runs" — informative about **which**, not about luck |
| **B** | `NG = (MixAcc − Null)/(1 − Null)` **[P]**, `MixAcc = Comp·Read + (1−Comp)·Wrong` **[D]**, `Null` = mean of 3 forced-bank cells **[F]** | (seed, task) | trial (both terms) | 3 × 3; 360 forced trials per cell for the null | **0.75 of headroom [P]** — justified by the L10-K1 precedent (72 % of headroom) **[V]**, not derived | gate on a ratio, with a validity domain | none — a gate on a standardised effect | **not stated [U]**; `MixAcc` and `Null` come from the same run, so they are likely **positively** correlated, making the rule conservative | any missing forced cell ⇒ INCOMPUTABLE | ≥ 2 of 3 tasks per seed | 0.9164 per cell at `MixAcc` 0.90 **[D]** | "routing beats a context-ignoring policy by 75 % of headroom on ≥ 2 tasks" | "the composition did not demonstrably beat the null" |
| **C** | `MixAcc ≥ 0.50` on `CROSS31` only **[P]** | (seed, task) | trial | 3 × 3 | **0.50 [F]** retained; **10 % of headroom** — a collapse detector, not a composition threshold **[D]** | per-cell gate | none | not stated | as A | 9 cells, no correction | 1.3 × 10⁻⁵ at a true 0.50 over 18; 0.107 at 0.55 **[D]** | "no CROSS31 cell collapsed" | "a CROSS31 cell fell below half the bar" |
| **D** | `Read = mean(correct | routing == 1)`, **reported with `n_elig`** | (seed, task) | trial | 3 × 3 | **0.90 [F]** | per-cell gate, `n_elig ≥ 30` **[P]** | none | denominator is random and determined by A **[D]** | `n_elig < 30` ⇒ NOT ESTIMABLE; `Comp = 0` ⇒ undefined **[U]** | 9 cells | 0.479 per cell at Comp = 0.90 **[D]** | "retrieval from the resolved bank is intact" | "retrieval degraded, or not estimable" |
| **E** | byte identity of two runs; checkpoint/resume exact **[F]** | run | run | 2 runs/seed | exact **[F]** | deterministic | n/a | none | n/a | n/a | n/a | determinism holds | nondeterminism |
| **F** | suite pass count vs the L10 baseline **[F]** | suite | test | 26 inherited + L11 set | 0 new failures **[F]** | deterministic | n/a | n/a | `test_phase1_affinity` cannot build **[V]** | n/a | n/a | no regressions | regressions |
| **G** | `Comp(A2) − Comp(A9)`, **paired (McNemar)** **[P]** | seed | trial, matched across arms | 3 seeds × 360 matched cues | **−0.10 [F]**; ~2.5–7.7 paired sd of slack ⇒ nearly non-binding **[D]** | one-sided gate; `H₀: δ ≤ −0.10` | as stated | **paired by construction** — identical eval seed and streams **[V]** | unstated **[U]** | 3 seeds ⇒ family error ≤ 3α **[D]** | 0.5 at its own margin | "order invariance held" | "allocation order changed routing by more than 0.10" |
| **M** *(new, U2)* | `Comp(CROSS31) − Comp(CROSS21)` | (seed, task) | trial, matched | 9 | **threshold UNRESOLVED — no evidence supports any value [U]** | *proposed:* report only until justified | — | paired | — | — | — | **not proposed as a gate** | |
| **K** *(new, U1)* | `Comp(A2) − Comp(A10)` | seed | trial, matched | 3 × 360 | **δ UNRESOLVED — A10 has never been measured [U]** | *proposed:* report only until justified | — | paired | — | — | — | **not proposed as a gate** | |

---

## 2. Thresholds versus hypothesis tests — the distinction the frozen text never makes

| Criterion | Is it a threshold or a test? | What it can claim |
|---|---|---|
| A | **threshold** (a screening gate) | "consistent with ≥ 0.90 at n = 120"; NOT "≥ 0.90 established" |
| B | **threshold on a standardised effect** | "closed ≥ 75 % of the headroom" — a gate, with no α |
| C | threshold | collapse detection only |
| D | threshold | retrieval guard, conditional on its denominator |
| E, F | deterministic | binary facts |
| G | threshold ≈ test at α ≈ 0 | nearly non-binding |
| D5 (pooled alternative) | **a genuine test** at α = 0.05 → 989/1080 **[D]** | "the pooled rate exceeds 0.90" — a different claim |

**Only D5 would be a hypothesis test.** Everything else is a gate. The ratified text must
say which is which; calling the conjunction a "test at 5 %" would be false, because no α
exists and the familywise error is undefined **[D]**.

---

## 3. False-pass / false-fail scenario table **[D]**

Assumptions: cells conditionally independent (stated, **not** justified — see L11.7 §2);
`Wrong` = 1/6 unless stated; `Null` from the protocol's forced-bank shape; the frozen
figure uses the L10.4 **measured** per-cell nulls.

| Scenario | `Comp` | `Read` | `MixAcc` | **Frozen contract** | **Candidate contract** |
|---|---|---|---|---|---|
| perfect model | 0.99 | 1.00 | 0.992 | **0.598** | 1.000 |
| good model | 0.95 | 1.00 | 0.958 | **0.0087** | 0.9995 |
| model exactly on target | 0.90 | 1.00 | 0.917 | **3.5 × 10⁻⁸** | 0.230 |
| wrong-bank leakage, same routing | 0.90 | 1.00 | 0.960 | 8.3 × 10⁻⁵ | 0.231 |
| retrieval drop | 0.90 | 0.90 | 0.827 | 2.1 × 10⁻²⁴ | **0.0000** |
| retrieval collapse | 0.99 | 0.00 | 0.002 | 0 | **0.0000** |
| uniform wrong routing | 0.50 | 1.00 | 0.566 | 4.1 × 10⁻²⁸⁴ | **0.0000** |

### 3.1 The two facts that matter most

1. **The frozen contract rejects a model with 0.99 accuracy 40 % of the time.** (`P = 0.598`
   is the *complete* pass probability of a near-perfect system.) That is not a strict
   standard; it is a broken one.
2. **The candidate contract still rejects every failure model at ≈ 0**, and now passes a
   good model 99.95 % of the time and a perfect one always. Specificity is preserved;
   sensitivity is repaired.

### 3.2 What is *not* claimed

- These are **not** simulations of STARK **[X]**.
- The independence assumption is an assumption; the true dependence is **[U]**, and L11.7
  showed D0's joint spans 0.007–0.576 while D3's spans 0.191–0.231.
- No familywise error rate is claimed for the candidate contract, because it is still a
  conjunction of gates — the honest statement is the per-criterion power table, printed
  beside every result.

---

## 4. What the candidate contract does and does not fix

| Problem | Fixed? |
|---|---|
| L11-B infeasible under a measured null | **yes** — NG floor is 0.861 against a real null of 0.444, not 1.000 |
| Contract's operating point is ~0.99 | **partly** — now ~0.90–0.92 per cell; still a high bar |
| Nine-fold conjunction with no dependence model | **yes** — D3 is dependence-robust (spread 0.039) |
| No test / α / power stated anywhere | **yes** — each row names its gate or test and its power |
| L11-C redundant and leak-prone | **yes** — restricted to A3, where it is the only gate |
| `Read` without a denominator | **yes** — denominator required, `n_elig < 30` ⇒ NOT ESTIMABLE |
| No evidence isolating *learning* | **no** — U1 (A10 contrast) is proposed but **unresolved**; this remains the deepest gap |
| No test of the additive-model prediction | **no** — U2 (A3 ordering) is proposed but **unresolved** |
| Pseudoreplication (n = 3 runs) | **no** — cannot be fixed by any rule; must be disclosed |
| Per-task claim is not a population claim | **no** — must be disclosed |

---

## 5. Status

Every row of §1 that carries **[P]** is a proposal. Every **[U]** is a genuine gap that no
amount of arithmetic can close. **The matrix is not a contract until an owner signs it, and
it is not executable until C1–C7 are satisfied.**
