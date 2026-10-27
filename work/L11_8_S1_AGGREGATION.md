# STARK-L11.8 — S1: The L11-A Aggregation Rule

**Nature:** analysis only. **The per-cell threshold 108/120 is not changed.** **[P]** for every candidate.

---

## 1. The exact rule as frozen, reconstructed

| Element | Value | Source |
|---|---|---|
| Criterion text | `Comp(A2,t) ≥ 0.90` on **every** task `t` and every seed | spec §6 **[V]** |
| Metric | `Comp = routing = (1/n) Σ 1[selected_bank == task_bank]` on `CROSS21` | protocol §6 **[V]** |
| Trials per cell | `n = 120` | protocol §3 **[V]** |
| Tasks | 3 (indices 0,1,2) | **[V]** |
| Seeds | 3 primary: `123456789`, `218213831`, `171473193` | prereg **[V]** |
| Cells | 3 × 3 = **9** | **[D]** |
| Pass count per cell | ≥ 108 | **[D]** per-cell power 0.5761 at a true 0.90 | **[D]** |
| Test | **none stated** | **[V]** |
| Dependence assumption | **none stated** | **[V]** |
| Multiplicity control | **none stated** | **[V]** |

---

## 2. The four candidate rules

| ID | Rule | Verbatim claim it supports |
|---|---|---|
| **D0** | all 9 cells ≥ 108/120 | "every task, on every run" |
| **D3** | every task passes on ≥ 2 of its 3 seeds | "every task, on at least two of three runs" |
| **D4** | every run's mean over tasks ≥ 0.90 (i.e. 324/360 per seed) | "the battery mean reaches 0.90 on every run" |
| **D5** | one pooled estimate over all 9 cells ≥ 0.90 (972/1080) | "the pooled composition rate exceeds 0.90" |

---

## 3. Power **[D]**

| true per-cell `p` | per-cell `q` | **D0** | **D3** | **D4** | **D5** |
|---|---|---|---|---|---|
| 0.80 | 0.0025 | 0.00000 | 0.00000 | 0.00000 | 0.00000 |
| 0.85 | 0.0746 | 0.00000 | 0.00000 | 0.00000 | 0.00000 |
| **0.90** | 0.5761 | **0.00699** | **0.23060** | **0.16119** | **0.52560** |
| 0.92 | 0.8367 | 0.20095 | 0.80099 | 0.80131 | 0.99195 |
| 0.93 | 0.9225 | 0.48404 | 0.94966 | 0.96141 | 0.99990 |
| 0.95 | 0.9928 | 0.93710 | 0.99954 | 0.99990 | 1.00000 |

**D3 dominates D4 on both axes**: it makes the stronger claim ("every task") *and* has
higher power at the target (0.231 vs 0.161). There is no trade-off justifying D4.

**D5 is the most powerful and the weakest claim** — and it is explicitly forbidden by the
frozen specification: *"pooled values are reported alongside per-cell values, never
instead of them"* **[V]**. Adopting D5 reverses a stated design principle.

---

## 4. Failure models **[D]**

| failure model | D0 | D3 | D4 | D5 |
|---|---|---|---|---|
| uniform 0.85 | 7.2 × 10⁻¹¹ | 4.0 × 10⁻⁶ | 0.00000 | 0.00000 |
| task-structured 0.99/0.99/0.60 | 1.2 × 10⁻³⁸ | 1.6 × 10⁻²⁵ | 0.00000 | 0.00005 |
| task-structured 0.99/0.99/0.13 (L10.3-shaped) | 6.8 × 10⁻²⁴² | 5.0 × 10⁻¹⁶¹ | 0.00000 | 0.00000 |
| uniform 0.50 | 3.5 × 10⁻¹⁸¹ | 1.3 × 10⁻¹¹⁹ | 0.00000 | 0.00000 |

**No candidate is permissive.** Even D5, the most powerful rule, rejects every failure
model examined. The design's problem is never false-pass; it is false-fail.

---

## 5. Dependence sensitivity **[D]**

| rule | independent | worst plausible dependence | spread |
|---|---|---|---|
| **D0** | 0.0070 | 0.5761 (comonotone) | **0.5691** |
| **D3** | 0.2306 | 0.1912 (within-seed comonotone) | **0.0394** |
| **D4** | 0.1612 | 0.5442 (perfectly correlated runs) | 0.3830 |
| **D5** | 0.5256 | — (single pooled statistic) | 0 |

**D3 is the most dependence-robust rule by an order of magnitude.** The direction is
counter-intuitive and worth stating plainly: for a k-of-n requirement with `k > n·q`,
**positive** dependence *lowers* the pass probability, because the three cells in a run
succeed or fail together rather than filling in for each other. The all-cells conjunction
(D0) does the opposite and swings by a factor of 82.

**This is the single strongest argument for D3:** it is the only rule whose verdict is
nearly invariant to the assumption the protocol never states.

---

## 6. Effective sample size and the experimental unit

| Level | Count | What it supports |
|---|---|---|
| trials per cell | 120 | precision of `θ̂_{s,t}` for one fixed checkpoint |
| cells | 9 | coverage of 3 fixed tasks × 3 runs |
| **independent training runs** | **3** | the only replication of the training procedure |
| tasks | 3 | a **fixed** factor, not a sample |

All four rules treat cells as exchangeable draws. **They are not**: cells share checkpoints
and share task difficulty. D0 and D4 are strongly affected; D3 much less; D5 not at all
(it never looks at a cell).

---

## 7. Multiplicity

If each per-cell gate were read as a one-sided 5 % test, the nine-fold conjunction would
have a familywise error of up to 9α. L11.7 showed that controlling this at α = 0.05 costs
**117/120 per cell** and leaves joint power at a true 0.95 of **2.7 × 10⁻⁸** **[D]**.

**Conclusion [D]:** at n = 120 and nine cells, a 5 %-level all-cells test is unattainable.
The design must choose between (i) a **screening gate with no error-rate claim** (D0/D3,
honestly labelled) and (ii) a **weaker claim with a real test** (D5). It cannot have both.

D3 sits on the defensible side of that line: it is a screening gate, and the report must
say so.

---

## 8. Recommendation **[P]**

**Adopt D3.** Reasons, in order of weight:

1. **Rule–claim match.** "At least two of three runs" is the literal operationalisation of
   a robustness claim; D0's "every cell" is a claim about luck at n = 120.
2. **Dependence robustness.** Spread 0.039 versus D0's 0.569.
3. **Claim strength retained.** Every task is still required, so the task-structured
   failure L11 was created to detect still fails — at 10⁻¹⁶¹.
4. **Precedent.** L11-B already uses a "2 of 3 tasks" structure **[V]**, so D3 adds no new
   concept to the contract.

**Costs that must be stated in the ratified text:**
- a model perfect on two runs and catastrophic on the third can pass;
- at a true 0.90 per cell the rule still passes only 23 % of the time — the report must
  print this;
- D3 does not fix the *claim* problem, only the *rule* problem.

---

## 9. What is NOT proposed

- Changing 108/120 or 0.90 — frozen.
- Raising `n` — a configuration change, not this milestone's to propose, though §7 shows it
  is the only real cure.
- Adding more seeds — same.
- Any PASS/FAIL verdict — **no run exists** **[X]**.

**Status: PROPOSED. Not ratified. Not applied.**
