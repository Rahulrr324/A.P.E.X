# STARK-L11.6 — L11-A … L11-G Acceptance Matrix

**Compiled from the frozen specification §6** (`…generalization.md:143–149`, sha256
`d9cd7dc4…`) and the preregistration's `criteria_candidate`
(`work/L11_1_PREREGISTRATION.json:52–60`, sha256 `57a8139d…`).

**Ratification status of every row: NOT RATIFIED.** `criteria_candidate.ratification`
= `PENDING_OWNER_DECISION` **[V]**.

Threshold provenance key: **FZ** = present verbatim in a verified frozen artifact ·
**PR** = proposed value, not in a frozen artifact · **UN** = unresolved.

---

## 1. The matrix

| ID | Exact metric (frozen text) | Evaluation unit | Scope | Threshold | Seeds / trials | Missing-data behaviour | Statistical interpretation | Depends on | Threshold source | Ratified |
|---|---|---|---|---|---|---|---|---|---|---|
| **L11-A** | `Comp(A2, t)` | cell (seed, task), arm A2 | per-cell conjunction; **"on every task `t` and every seed"** = 9 cells | **≥ 0.90** | 3 primary seeds × 3 tasks × 120 trials | protocol §8: invalid trial excluded; short call ⇒ whole call INCONCLUSIVE; `NA` never imputed **[V]** | single-cell power documented (P=0.576 at 0.90) — **joint power not documented, and is 0.0070 at 0.90** **[C]** | R4 (defines `Comp`), R5 (indirectly) | **FZ** | **NO** |
| **L11-B** | `MixAcc(A2, t) − Null(t)` | cell (seed, task), arm A2 vs the measured null | **"at least two of three tasks, on every seed"** | **≥ 0.50** (a *difference*) | as above; `Null` from 3 forced `OFF` cells | `Null` needs `forced_bank` capture; a missing forced cell ⇒ `Null` `NA` ⇒ INCONCLUSIVE, never imputed **[I]** | **none documented**; the test (paired? normal? exact?) is unspecified **[V]**; approximate power computed below **[C]** | F2 (`o` affects `MixAcc`), R4 | **FZ** | **NO** |
| **L11-C** | *metric unnamed in the frozen text* | cell (seed, task), arms A2 **and** A3 | per-cell conjunction; **cell count unstated** (9 or 18) | **0.50** | as above | no metric ⇒ no missing-data rule; short call ⇒ INCONCLUSIVE per §8 **[V]** | none documented; **joint power 1.3 × 10⁻⁵ at a true 0.50 over 18 cells** **[C]** | **R5 (defines the metric)** | **FZ** (value) / **UN** (metric) | **NO** |
| **L11-D** | `Read(A2, t)` | cell (seed, task), arm A2 | **"on every task and seed"** = 9 cells | **≥ 0.90** | 3 seeds × 3 tasks; denominator is **random** (routes only) | protocol §8(i): `selected_bank == -1` excluded — but that state is **unreachable** **[V]** `CCM.cpp:345`, so the rule is inert; empty denominator ⇒ `NA:NO_DENOM`, never 0 | single-cell power depends on `Comp`; **joint 0.0028 at Read=0.90 with Comp=0.90** **[C]** | R4 | **FZ** | **NO** |
| **L11-E** | determinism: two reruns byte-identical; checkpoint/resume exact | run (arm, seed) | run-level | **exact equality** (not a rate) | all seeds | n/a | not a proportion — no statistical character needed | **F4** (stream seeds must be correct) | **FZ** | **NO** |
| **L11-F** | regression: no new failures vs the L10 baseline | test suite | suite-level | **zero new failures**; "26/26 inherited + the L11 test set" | all | a test that cannot run is **UNEXECUTED**, never passed | not a proportion | R2 (`test_phase1_affinity` is one of the 26 and cannot build) | **FZ** | **NO** |
| **L11-G** | `Comp(A2) − Comp(A9)` | seed-level paired difference | **"on every seed"** = 3 comparisons | **≥ −0.10** | 3 seeds | both terms must exist; a missing arm ⇒ INCONCLUSIVE | **none documented**; A2 and A9 are different training runs, so the difference is not a within-run paired statistic **[I]** | R4 | **FZ** | **NO** |

---

## 2. Threshold provenance, sorted

| Source | Criteria |
|---|---|
| **FZ — verbatim in frozen artifacts** | all seven thresholds (0.90, 0.50, 0.50, 0.90, exact, zero-new, −0.10) |
| **PR — proposed, not frozen** | "`MixAcc` pooled ≥ 0.75" (R5b) — **not in any frozen artifact** **[V]** |
| **UN — unresolved** | L11-C's **metric**; L11-C's **cell count**; L11-B's **test**; L11-G's **test**; L11-D's effective denominator rule |

**Important distinction:** every *number* is frozen; almost every *definition* that
would let the number be computed is not.

---

## 3. Statistical character: what is documented vs what is true

Only L11-A has a documented statistical character, and it describes **one cell**
**[V]** `…generalization.md:151–157`. All seven criteria are conjunctions. Computed here
**[C]** by exact binomial at n = 120 unless noted:

### L11-A (≥ 108/120 per cell, 9 cells)

| true `Comp` | per cell | **all 9 cells** |
|---|---|---|
| 0.85 | 0.0746 | **7.2 × 10⁻¹¹** |
| 0.90 | 0.5761 | **0.00699** |
| 0.95 | 0.9928 | **0.9371** |

**The documented "coin flip at 0.90" is a coin flip only if the criterion were one
cell. As written it is a 0.7 % event at 0.90 and a 94 % event at 0.95** — the criterion
discriminates between 0.90 and 0.95, not between 0.85 and 0.90.

### L11-C (≥ 60/120 per cell; 9 or 18 cells)

| true `MixAcc` | per cell | joint over 18 | joint over 9 |
|---|---|---|---|
| 0.45 | 0.1564 | 3.2 × 10⁻¹⁵ | 1.9 × 10⁻⁸ |
| 0.50 | 0.5363 | **1.3 × 10⁻⁵** | 0.0037 |
| 0.55 | 0.8833 | **0.107** | 0.328 |
| 0.60 | 0.9895 | **0.828** | 0.910 |
| 0.65 | 0.9997 | 0.995 | 0.997 |

**A criterion that reads like a 0.50 floor is in practice a ~0.55–0.60 requirement.**

### L11-D (`Read` over a random denominator, 9 cells)

Conditioning on `routing == 1` makes the denominator random. Computed by compounding two
binomials over `r ∼ Bin(120, Comp)`:

| `Comp` = 0.90, `Read` = 0.90 | per cell **0.5205**, joint over 9 **0.0028** |
|---|---|
| `Comp` = 0.90, `Read` = 0.95 | per cell 0.9848, joint 0.871 |

### L11-B (difference ≥ 0.50, ≥ 2 of 3 tasks, every seed)

No test is specified **[V]**. Under a normal approximation **[C]**:

| true `MixAcc`, true `Null` | difference | P(pass \| task) | P(≥ 2 of 3) |
|---|---|---|---|
| 0.90, 0.40 | 0.500 | 0.500 | **0.500** |
| 0.85, 0.4259 (the L10-measured floor) | 0.424 | 0.086 | **0.021** |
| 0.80, 0.4259 | 0.374 | 0.015 | **0.0007** |
| 0.90, 0.30 | 0.600 | 0.977 | 0.9985 |

**This is an approximation, not the protocol's test** — the protocol has none. It is
offered to show that the criterion's power is undocumented and materially depends on
`Null`, which is measured, not fixed.

### L11-G

No test specified. A2 and A9 are **different training runs**, so `Comp(A2) − Comp(A9)`
is a difference of two proportions from independent runs, not a paired statistic. The
marginal is documented nowhere **[V]**.

---

## 4. Findings that require an explicit owner acknowledgement

| # | Finding | Evidence |
|---|---|---|
| **M1** | **All seven criteria are conjunctions, and their statistical character is documented for single cells only.** L11-A at a true 0.90 has joint power **0.7 %**. | **[C]** |
| **M2** | **L11-C's metric is unnamed and its cell count is unstated**; the two readings of "cell" differ by three orders of magnitude in joint power. | **[V]** + **[C]** |
| **M3** | **L11-B and L11-G specify no test.** "≥ 0.50" and "≥ −0.10" are stated as bare comparisons with no paired/unpaired, exact/approximate, or interval rule. | **[V]** |
| **M4** | **L11-D's denominator is random** and its sole documented exclusion rule (§8(i)) is inert because `selected_bank = -1` cannot occur. | **[V]**+**[C]** |
| **M5** | **L11-F depends on a test that cannot build** (`test_phase1_affinity`, `DWORD_PTR` undeclared). | **[V]** |

**None of these is a proposal to change a threshold.** They are reasons the contract
cannot be described as settled.

---

## 5. Status statement

> **The acceptance contract is NOT ratified, and is not ready to be ratified as
> written.** Seven thresholds are frozen; the definitions needed to compute four of the
> seven are not (L11-C's metric, L11-B's and L11-G's tests, L11-D's denominator rule),
> and the multiplicity of every conjunction is undocumented.

**The protocol is frozen. It is not unambiguous. It is not ready to execute.**
