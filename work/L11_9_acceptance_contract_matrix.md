# STARK-L11.9 — Audit H: A–G Acceptance-Contract Matrix

One row per criterion. **No p-value is invented and no familywise control is claimed
anywhere in this table.** Where a criterion has no error control, the row says so.

Legend — **Impl.:** `absent` / `partial` / `present` (code state) ·
**Evid.:** `none` / `static` / `simulated` (evidence state) ·
**Power:** `computed` / `not computed` / `not applicable` ·
**Owner:** the decision id that must be resolved first.

---

| # | criterion | metric | unit | experimental unit | rule | rationale | H0 | H1 | dependence | missing data | multiplicity | power | owner dec. | Impl. | Evid. |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **A** | L11-A composition | `Comp` = correct composition rate | cell `(seed,task)`; test = per task over 3 seeds | **training run** | **≥ 2 of 3 runs per task clear their cell** (proposed AC-2) | failed for 10 milestones | `Comp ≤ chance` | `≥ 0.90 per task` | **none assumed**; 2-of-3 is dependence-robust **[D]** | INVALID ⇒ study fails; no imputation | none — **no error control** | **0.2306** complete at true 0.90 **[D]** | STC-1, STC-5 | **absent** (no 3-feature cue) | **none** |
| **B** | L11-B headroom | `NG = (MixAcc−Null)/(1−Null)` | cell | training run | `NG ≥ 0.75` ⟺ `MixAcc ≥ 0.75+0.25·Null` | L10-K1 precedent (72 % of headroom) | `NG ≤ 0` | `NG ≥ 0.75` | none | missing/null=1 ⇒ **INCOMPUTABLE**; NaN/∞ ⇒ INVALID | none | **0.9164** at `MixAcc = 0.90`, conditional on null shape **[D]** | STC-2, STC-3 | **absent** | **simulated** |
| **C** | L11-C failure floor | `MixAcc` | cell | training run | **`MixAcc ≥ 0.50` on A3** (proposed AC-4) | L10.3 routing collapse | `MixAcc < 0.50` on some cell | no cell < 0.50 | none | `Comp = 0` ⇒ NOT ESTIMABLE | none | not computed (secondary) | MET-1 | **absent** | **simulated** |
| **D** | L11-D baseline drift | `Comp–Null` | **battery**, not cell | training run | `|Comp−Null| ≤ 0.10` **per run**, mean over runs | catches order/scale drift | `|Δ| > 0.10` | `|Δ| ≤ 0.10` | per-run only, **no cross-run dependence assumed** | any null unavailable ⇒ INVALID | none — **this is the criterion the audit flags** | not computed | CLM-1 | **absent** | **static** |
| **E** | L11-E retrieval-from-own-mapping | `Read` | cell | training run | **`Read ≥ 0.90`** (mean) with `Comp > 0`, `n_elig ≥ 30` | separation never demonstrated | `Read ≤ chance` | `≥ 0.90` | none | NOT ESTIMABLE ⇒ INCONCLUSIVE | none | not computed | MET-2, MET-3 | **absent** | **static** |
| **F** | L11-F ambiguity resolution | `Comp`, `Mis` | cell `(seed, ambiguity)` | training run | ties + ambiguous cues never out-perform unambiguous | prevents resolution-by-indecision | `Comp(ambig) ≥ Comp(unambig)` | strict inequality in the stated direction | none | NOT ESTIMABLE | none | not computed | MET-8, MET-10 | **absent** | **none** |
| **G** | L11-G order invariance | `Comp(A2) − Comp(A9)` | arm comparison, **battery mean** | training run | **`≥ −0.10`** | A14-2 lesson | `Δ < −0.10` | `Δ ≥ −0.10` | none | INVALID | none | not computed | — | **absent** | **none** |

---

## 1. Cross-checks performed while building this matrix

| check | result |
|---|---|
| Does any row state a p-value? | **no** — deliberately; only substitution probabilities are quoted |
| Does any row claim familywise control? | **no** — the matrix says "none" seven times |
| Is every experimental unit the **training run**? | **yes**, except D and G which are battery-level summaries of runs |
| Are the three power levels conflated? | **no** — A's 0.2306 is labelled *complete contract*; B's 0.9164 is a *single-cell/lower-level* figure |
| Is any row's `Impl.` anything but `absent`? | **no** — **not one criterion is implemented** |
| Is any row's `Evid.` `runtime`? | **no** — the strongest is `simulated` (B, C) |

**Audit H-1 (finding):** **all seven criteria have `Impl. = absent`.** The L11.8 package
describes a contract that **no code implements**. This is consistent with its own
"C1–C7 at 0/7" status but is worth stating in these words: *the acceptance contract is a
specification, not a program.*

**Audit H-2 (finding):** rows B and C have `Evid. = simulated` — those are *analyses of a
model*, not measurements. Rows A, D, E, F, G have `Evid.` of `none` or `static` only.

---

## 2. What the matrix shows about the package as a whole

| property | status |
|---|---|
| every criterion has a stated metric and rule | **yes** |
| every criterion states its H0/H1 | **yes** |
| every criterion states its experimental unit | **yes** |
| every criterion states missing-data behaviour | **for the proposed text, yes**; **for the frozen text, often no** |
| any criterion has an error rate control | **no** |
| any criterion is implemented | **no** |
| any criterion has official evidence | **no** |
| the required owner decision is named per row | **yes** |

**The matrix is complete in the sense the task requires and empty in the sense that it
describes nothing that exists.** That is the honest summary of where APEX stands on L11.
