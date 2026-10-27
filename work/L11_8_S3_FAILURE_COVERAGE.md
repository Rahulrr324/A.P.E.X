# STARK-L11.8 — S3: L11-C and Failure-Mode Coverage

**Nature:** analysis only. **No metric or threshold adopted.** **[P]** for every candidate.

---

## 1. The failure mode L11-C was written for, stated exactly

Historic record **[V]** (`work/L10_4_OFFICIAL_EVALUATION.md`, spec §1):

> on the mixed cue the router's routing rate is **0.0000 / 0.5019 / 1.0000** by task index
> and is **identical across all three primary seeds**, while accuracy given the resolved
> bank is 1.0000 in every cell. The published 0.5611 is
> `0.5019 × 1.0 + 0.4981 × 0.132`.

So the failure mode is:

> **Task-structured routing collapse.** On one task the router never selects the correct
> bank, and composition accuracy on that cell falls to the wrong-bank floor. The pooled
> number stays respectable because the other tasks carry it.

Three properties follow, and they constrain any repair:
(i) it is **cell-local**, so a pooled gate cannot see it;
(ii) it is **deterministic across seeds** (0.0000 on every seed), so a seed-based
robustness rule cannot see it either;
(iii) it is **invisible in `MixAcc` at the pooled level** — 0.5611 clears a 0.50 floor.

---

## 2. Coverage matrix **[D]**

`A` = `Comp ≥ 0.90` per task; `D` = `Read ≥ 0.90`; `C` = `MixAcc ≥ 0.50` per cell.

| Failure mode | `Comp` | `Read` | `MixAcc` | **A** | **D** | **C** |
|---|---|---|---|---|---|---|
| routing collapse on one task | 0.00 | undefined | 0.132 | **FAIL** | UNDEF | FAIL |
| uniform wrong routing, retrieval fine | 0.50 | 1.00 | 0.566 | **FAIL** | PASS | **PASS** |
| retrieval collapse, routing perfect | 0.99 | 0.00 | 0.002 | PASS | **FAIL** | FAIL |
| wrong-bank leakage (same routing, higher wrong-bank acc.) | 0.90 | 1.00 | **0.960** | PASS | PASS | **PASS** |
| retrieval drop (0.90) at `Comp` 0.90 | 0.90 | 0.90 | 0.827 | PASS | PASS | PASS |
| on target | 0.90 | 1.00 | 0.917 | PASS | PASS | PASS |

### 2.1 Findings

1. **`C` never rejects a mode that `A` and `D` both accept.** It carries no unique verdict
   on A2.
2. **`C` passes two modes that `A` rejects or that are diagnostic failures** — uniform
   wrong routing (`MixAcc` 0.566 > 0.50) and wrong-bank leakage (`MixAcc` 0.960, *raised*
   by the leakage).
3. **`C` is the only gate that fails the routing-collapse cell when `D` is undefined** —
   but `A` already fails it outright. Coverage is not lost by removing `C` from A2.
4. The historic 0.5611 **would pass a 0.50 floor at the pooled level**. `C` only catches
   L10.3 because the collapse is task-structured (one cell at 0.132). **A metric that
   catches a failure by accident of that failure's structure is not evidence that the
   metric is right.**

---

## 3. The three candidate scopes

| ID | Scope | Cells | What it adds |
|---|---|---|---|
| **X0** | every cell (A2 and A3) | 18 | status quo |
| **X1** | **A3 only** (`CROSS31`) | 9 | covers the arm nothing else gates |
| **X2** | diagnostic only, retain A and D as the gates | 0 gates | smallest possible contract |

### 3.1 Does restricting to A3 leave any intended failure mode undetected?

| Intended mode | On A2 | On A3 |
|---|---|---|
| task-structured routing collapse | caught by **A** | **not caught by anything else** |
| retrieval collapse | caught by **D** | not caught by anything else |
| uniform wrong routing | caught by **A** | not caught by anything else |
| leakage | **not caught by anything, anywhere** | not caught by anything |

**Answer: on A2, no mode is lost — every mode is caught by A or D. On A3, `C` is the only
gate, so restricting to A3 preserves the only coverage `C` uniquely provides.**

Conversely **X2 (diagnostic only) loses A3 coverage entirely.** That is the cost of X2 and
the reason X1 is preferred over it.

---

## 4. Non-monotonicity, restated for the record

`MixAcc = Comp·Read + (1−Comp)·WrongBankAcc`, so
`dMixAcc/dComp = Read − WrongBankAcc`. Therefore:

- **Raising `Comp` lowers `MixAcc` whenever `Read < WrongBankAcc`.** A model that reads
  better from the wrong bank than the right one is **punished for better routing**.
- **Raising `WrongBankAcc` raises `MixAcc` at fixed `Comp`, `Read`** — the leakage
  direction. Worked example **[D]**: at `Comp = 0.90`, `Read = 1.00`:

| `WrongBankAcc` | `MixAcc` | `NG` (vs Null 4/9) |
|---|---|---|
| 0.167 (no leakage) | 0.9167 | 0.850 |
| 0.600 (leakage) | **0.9600** | **0.928** |

**Both `MixAcc` and `NG` reward the leakage.** Any criterion built on them inherits this.
The only gates that do not are `Comp` (A) and `Read` (D), which measure the two mechanisms
separately.

**This is the decisive reason not to build a criterion on `MixAcc`.** It is not that the
number is wrong — it is that the number is **optimisable in the wrong direction**.

---

## 5. Missing data and invalid denominators **[P]**

| Situation | Frozen behaviour | Candidate behaviour |
|---|---|---|
| cell has `n < 120` | whole call INVALID (§8(ii)) **[V]** | retained |
| `Comp = 0`, so `Read` has no denominator | **unhandled** **[U]**; §8(i)'s exclusion key is unreachable (L11.6 D1) | `Read` = NOT ESTIMABLE; `D` INCONCLUSIVE on that cell, and a separate rule says INCONCLUSIVE ≠ PASS |
| `n_elig < 30` | unhandled | `Read` NOT ESTIMABLE → `D` INCONCLUSIVE |
| `MixAcc` with `n = 0` | INVALID | retained |
| `Null` missing a forced cell | unhandled | `NG` INCOMPUTABLE |
| `Null = 1` | unhandled | `NG` structural NA |
| tie in `rule_bank` | unhandled (R4b open) | unchanged — **R4b still blocking** |

**A policy rule that must appear in the ratified text [P]:** *INCONCLUSIVE is never
counted as PASS, and never silently dropped. A run with any INCONCLUSIVE cell has no
verdict.*

---

## 6. Recommendation **[P]**

1. **Restrict `C` to A3 (X1).** It is the only place it uniquely covers anything.
2. **Keep the 0.50 value unchanged** on A3, and label it honestly: it is a **collapse
   detector**, 10 % of headroom above a context-ignoring policy, **not** a composition
   threshold.
3. **Do not extend `C` to any metric that can be raised by wrong-bank leakage** without
   stating that property in the criterion's text.
4. **On A2, replace `C`'s role with the explicit pair (A, D)** — routing and retrieval
   gated separately, each interpretable, neither optimisable in the wrong direction.

**Justification, stated in the terms the mission demands:** this is *not* "keep the metric
because it caught a historical failure". The metric is kept only where nothing else
covers the arm, at the smallest scope, with its limitations written down — and it is
removed from A2 because **A ∧ D already covers every failure it could catch there, and
`MixAcc` additionally rewards a failure they do not.** 
