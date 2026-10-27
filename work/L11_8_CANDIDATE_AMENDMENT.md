# STARK-L11 — Candidate Acceptance Contract, revision 3 — `L11-AC-v0.3-candidate`

> # ⚠ NOT REGISTERED — NOT AUTHORIZED
>
> This document is **not a protocol**, has **no official hash**, is **not frozen**, and
> **authorizes nothing**. Its hashes must never be recorded as protocol hashes.
>
> The operative documents remain, byte-identical:
> - `stark/design/l11_1_protocol.md` v0.1 `322078c8…` (§7 **PENDING OWNER RATIFICATION**)
> - `stark/design/l11_cross_signature_compositional_generalization.md` v0.1 `d9cd7dc4…`
>   (§6 criteria, `DRAFT_NOT_RATIFIED`)
> - `work/L11_1_PREREGISTRATION.json` `57a8139d…` (`PENDING_OWNER_DECISION`)
>
> Revision history of the **candidate** line: rev 1 = `work/L11_5_AMENDMENT_DRAFT.md`;
> rev 2 = `work/L11_6_CANDIDATE_AMENDMENT.md`; rev 3 = this document. All three remain
> unregistered; none withdraws another.

---

## 1. What changes, and what does not

**Does not change:** 0.90 (A, C, D), 0.50 (C), −0.10 (G), 120 trials, 3 tasks, 3 seeds,
the metric definitions of `Comp`, `Read`, `MixAcc`, `Null`, and every frozen artifact.

**Changes:** the **aggregation rule** for A, the **statistic** for B, the **scope** of C,
the **reporting** of D, the **test** for G, and the **scientific claim** the whole thing
supports.

---

## 2. Item-by-item before/after

### AC-1 — the scientific claim *(CLAIM CHANGE)*

| Before | After |
|---|---|
| implicit: "the system generalizes compositionally" | explicit: *"on a fixed three-task battery, over three independent runs, the system resolves 2:1 and 3:1 cross-signature cues to the signature owning the majority of features — and retrieves from that signature — in every task, on at least two of the three runs"* |
| no scope limit | states that 3 tasks and 3 seeds are a **demonstration**, not a sample; no task-population inference |
| no mechanism statement | states that R-majority is **emergent from the additive router** `sc[k] = Σ_f w[f][k]` **[V]**, and that the claim is about additive cue integration, not symbolic composition |

### AC-2 — L11-A aggregation *(NEW ACCEPTANCE CRITERION)*

```
Before:  Comp(A2,t) ≥ 0.90 on every task and every seed          (9 cells)
After:   for every primary seed, at least two of the three tasks satisfy
         Comp(A2,t) ≥ 0.90;  all nine per-cell values are reported;
         the joint power at a true 0.90 (0.231) is printed beside the result
```
Rationale: matches the wording of the claim; dependence spread 0.039 versus 0.569 **[D]**.
Cost, to be stated: a model perfect on two runs and catastrophic on the third can pass.

### AC-3 — L11-B statistic *(NEW ACCEPTANCE CRITERION)*

```
Before:  MixAcc(A2,t) − Null(t) ≥ 0.50 on ≥2 of 3 tasks, every seed
After:   NG(t) = (MixAcc(A2,t) − Null(t)) / (1 − Null(t)) ≥ 0.75 on ≥2 of 3 tasks,
         every seed, subject to:
           Null(t) < 1 and all three forced cells present with n = 120;
           Null(t) > 0.75 ⇒ cell NOT INTERPRETABLE (INCONCLUSIVE, never a pass);
           any missing forced cell ⇒ INCOMPUTABLE;
         MixAcc(t), Null(t) ± se and NG(t) are always reported.
```
Rationale: the frozen rule demands `MixAcc` between 0.833 and 1.000 because the measured
null is 0.333–0.500 **[V]**; at `Null = 0.50` it demands exactly 120/120 **[D]**. The
normalized form has slope 0.25 in the nuisance parameter instead of 1.00 **[D]**.

### AC-4 — L11-C scope *(NEW ACCEPTANCE CRITERION)*

```
Before:  no (seed, task) cell in A2 or A3 below 0.50   (metric unnamed; 18 cells)
After:   MixAcc(CROSS31, seed, task) ≥ 0.50 for all nine A3 cells;
         MixAcc on A2 is REPORTED and is not an acceptance criterion.
         The 0.50 is described as a collapse detector — 10 % of headroom
         above a context-ignoring null — not as a composition threshold.
```
Rationale: on A2 the pair (A, D) covers every failure C could catch, and `MixAcc` is
**raised** by wrong-bank leakage **[D]**. On A3 nothing else gates.

### AC-5 — L11-D reporting *(CLARIFICATION)*

```
Before:  Read(A2,t) ≥ 0.90 on every task and seed
After:   unchanged threshold; Read is reported with n_elig, and a cell with
         n_elig < 30 is NOT ESTIMABLE — INCONCLUSIVE, never a pass.
```

### AC-6 — L11-G test *(CLARIFICATION — the design is already paired)*

```
Before:  Comp(A2) − Comp(A9) ≥ −0.10 on every seed            (no test)
After:   same threshold; evaluated as a PAIRED (McNemar) one-sided comparison on the
         360 matched cues per seed, with var(d) = (ψ − δ²)/360; the seed family is
         reported with its multiplicity.
```

### AC-7 — statistical reporting *(CLARIFICATION, NEW POLICY)*

Every L11 report prints: the joint power of the aggregation rule actually used; `n_elig`
for every conditional mean; the measured `Null(t)` with its standard error; the number of
independent runs (3) and tasks (3) beside every method-level claim; and the statement that
a pass is "consistent with" the threshold at n = 120.

### AC-8 — new diagnostics, **not criteria** *(UNRESOLVED)*

```
M:  Comp(CROSS31) − Comp(CROSS21)     — the additive model's ordering prediction
K:  Comp(A2) − Comp(A10)              — learned routing vs the default tie-break
```
Both are **proposed for reporting only**. **No threshold is proposed** because the evidence
does not support one: A3 has never been measured and A10 has never been run **[U]**.

### AC-9 — determinism / regression *(UNCHANGED)*

L11-E and L11-F are untouched. L11-F remains blocked by R2.

---

## 3. Migration and compatibility

| Item | Class | Frozen artifact touched | Numeric effect on an existing cell verdict |
|---|---|---|---|
| AC-1 claim | **CHANGE IN SCIENTIFIC CLAIM** | none files; the specification's §1 wording | none |
| AC-2 aggregation | **NEW ACCEPTANCE CRITERION** | spec §6 L11-A | 0.007 → 0.231 power at 0.90; a single bad seed stops deciding |
| AC-3 B statistic | **NEW ACCEPTANCE CRITERION** | spec §6 L11-B | turns an infeasible gate into a satisfiable one |
| AC-4 C scope | **NEW ACCEPTANCE CRITERION** | spec §6 L11-C | removes 9 A2 predicates; no coverage loss **[D]** |
| AC-5 D reporting | clarification | spec §6 L11-D | none at `Comp ≥ 0.90` |
| AC-6 G test | clarification | spec §6 L11-G | none; tightens slightly |
| AC-7 reporting | clarification | none | none |
| AC-8 M, K | **NEW DIAGNOSTICS, not criteria** | none | none |
| protocol §5 seed table (F4) | clarification | protocol §5 | none; **still open** |
| `Comp` on A4 / tie-break (R4, R4b) | clarification | protocol §6 | none; **still open** |
| schema v0.2 errata D1–D8 | clarification | schema v0.2 proposal | none; **still open** |

### 3.1 Artifact compatibility

| Artifact | State after this amendment | Action required |
|---|---|---|
| `l11_1_protocol.md` v0.1 | **untouched, forever** | a **new** `l11_1_protocol_v0_2.md` would be committed only on ratification |
| `l11_cross_signature_…md` v0.1 | **untouched** | its §6 table would be superseded by a new §6 in the v0.2 spec |
| `l11_trial_schema.md` v0.1 | **untouched** | retained |
| `l11_trial_schema_v0_2.md` | **untouched** | must be corrected (D1–D8) before implementation; AC-3 additionally requires a **forced-cell count** and a `null_measurement_id` field |
| `L11_1_PREREGISTRATION.json` | **untouched**; `PENDING_OWNER_DECISION` | a ratification would **add** `protocol_sha256_v0_2`, `criteria_sha256`, `ratified_by`, `ratified_at` — additive only (R6) |
| L10 evidence and figures | **untouched**; not reinterpreted | none |
| L11.1–L11.7 reports | **untouched** | none |

**AC-3 has one schema consequence [P]:** `Null(t)` is currently reconstructible only by
grouping three forced-bank calls, with no field saying which three belong together. A
`null_measurement_id` (or an equivalent grouping key) is required for AC-3 to be
unambiguous. This is a **new schema requirement** and is listed as **U4**.

---

## 4. What would have to be true before this revision could be registered

1. S1, S2, S3, S4 decided (AC-1 … AC-4).
2. R4, R4b, R4c, R5, R5b, R6 decided.
3. F1, F2, F4 decided.
4. U1 (A10 contrast) and U2 (A3 ordering) decided — **as criteria or as diagnostics**.
5. U3 (claim wording) accepted.
6. U4 (schema grouping key) designed.
7. R1 ratified **as the revision, not the original**.
8. C1–C7 satisfied.
9. Only then: a hash computed after the final edit, and the hash registered (R6).

**Until all nine hold, the operative text is v0.1 — frozen, ambiguous, and not
executable.**
