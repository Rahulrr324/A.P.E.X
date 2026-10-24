# STARK-L11.8 — Owner Decision Register

**Every row: NOT APPROVED.** No decision in this repository has been authorised. This
milestone resolves none of them. New decisions are appended (U1–U7).

---

## Part I — decisions that affect the **scientific claim**

| ID | Question | Evidence | Recommendation **[P]** | Blocks |
|---|---|---|---|---|
| **S4** | per-task or pooled? | pooled is the metric that hid the historical 0.0/0.5/1.0 collapse; the specification forbids substitution **[V]**; pooled is 75× more powerful at 0.90 **[D]** | **per-task**, with pooled reported and labelled | the whole contract |
| **AC-1 / U3** | is the claim wording accepted — fixed battery, 3 runs, additive integration, "consistent with"? | `bankScores` is additive **[V]**; 3 tasks are fixed, not sampled **[V]** | accept the wording as written | any report |
| **S1** | aggregation rule for L11-A | D0 0.007 / D3 0.231 / D4 0.161 / D5 0.526 at a true 0.90 **[D]**; D3 dependence spread 0.039 vs D0 0.569 | **D3** — every task on ≥ 2 of 3 runs | L11-A |
| **U1** | is `Comp(A2) − Comp(A10)` a criterion? | **the contract contains no test that isolates learning** **[V]**; A10 has never been run, so no δ exists **[U]** | report it; **do not** gate until measured | the deepest gap remains open |
| **U2** | is `Comp(CROSS31) − Comp(CROSS21)` a criterion? | the additive model predicts 3:1 ≥ 2:1; A3 has no criterion **[V]**; no measured value exists **[U]** | report it; **do not** gate until measured | A3 interpretation |

---

## Part II — decisions that affect **metric definitions**

| ID | Question | Evidence | Recommendation | Blocks |
|---|---|---|---|---|
| **S2 / AC-3** | replace `MixAcc − Null ≥ 0.50` with `NG ≥ 0.75`? | measured null 0.333–0.500 **[V]**; frozen rule demands up to 120/120 **[D]**; NG slope 0.25 vs 1.00 **[D]** | adopt AC-3 with its validity domain | every run |
| **S3 / AC-4** | restrict L11-C to A3? | on A2, A ∧ D covers every mode C could catch; `MixAcc` is raised by leakage **[D]** | restrict to A3; keep 0.50; label it a collapse detector | L11-C |
| **AC-5** | `Read` reported with `n_elig`; `< 30` ⇒ NOT ESTIMABLE? | denominator is `120·Comp`, itself a criterion **[D]**; `Comp = 0` is undefined **[U]** | adopt | L11-D |
| **AC-6** | McNemar for L11-G? | A2/A9 are matched on identical cues and streams **[V]** | adopt | L11-G |
| **R5** | L11-C metric name | carried forward; **now subsumed** by S3/AC-4 | — | — |
| **R5b** | pooled ≥ 0.75 | carried forward; no population, formula or derivation | **defer** | — |
| **R4 / R4b / R4c** | A4 metrics, tie-break, `Read_rule` status | carried forward unchanged; `AMBIG11` still unimplemented **[V]** | as in L11.6 | unambiguity |
| **F1** | `MISLEAD` vs `SHUFFLED` | carried forward; constructionally identical | distinguish by `o`-selection, or merge | A6/A7 |
| **F2** | `o` distribution | carried forward; none stated anywhere | uniform over the other two | all cross-family arms |

---

## Part III — decisions that affect **implementation**

| ID | Question | Status | Blocks |
|---|---|---|---|
| **F4** | protocol §5's stream seeds disagree with the code (`9300`/`9500`/`9600` documented vs `5001+t`/`9100+t`/`9400+t` implemented) **[V]** | open | L11-E, C6 check 14 |
| **R2** | `test_phase1_affinity` cannot build (`DWORD_PTR`) **[V]** | open | L11-F |
| **U4** | schema needs a grouping key so the three forced cells forming one `Null(t)` are identifiable **[P]** | new | AC-3 |
| **C1–C7** | readiness conditions | **0 of 7** | implementation |
| **A10 / A3 arms** | must actually be *run* before U1/U2 can acquire thresholds | **[X]** never run | U1, U2 |

---

## Part IV — decisions that affect **artifact registration**

| ID | Question | Recommendation | Blocks |
|---|---|---|---|
| **R1** | ratify L11-A…G | **do not ratify v0.1**; ratify the revision once S1–S4 and AC-1…AC-8 are decided | any official run |
| **R6** | hash recording | additive; retain v0.1 hashes | provenance |
| **AC-9** | E, F unchanged | no action | — |

---

## Part V — what this milestone did **not** do

- Did not change any frozen artifact (11 verified byte-identical).
- Did not change a threshold value.
- Did not register, freeze or apply the candidate contract.
- Did not implement an arm, run a trial, or execute a test.
- Did not mark any decision approved, even where a recommendation is unambiguous.

---

## Part VI — the queue, ordered by blocking power

1. **S4** — per-task or pooled (the claim).
2. **S1** — aggregation (D3).
3. **S2** — the L11-B statistic (AC-3).
4. **S3** — the L11-C scope (AC-4).
5. **U3** — claim wording.
6. **U1, U2** — the two missing discriminators (report-only recommended).
7. **U4** — the schema grouping key.
8. **R1, R4, R4b, R4c, R5, R5b, R6** — carried forward.
9. **F1, F2, F4, R2** — carried forward.
10. **C1–C7** — readiness.

**Seventeen distinct decisions. None has been made.**
