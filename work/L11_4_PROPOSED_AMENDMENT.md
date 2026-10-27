# STARK-L11.4 — Proposed Protocol Amendment v0.1 → v0.2 (DRAFT, UNREGISTERED)

> **THIS IS NOT A PROTOCOL.**
> It is a **proposal**. It has no hash in the preregistration, it is not frozen, and
> it authorises nothing.
> **The operative protocol remains v0.1, sha256 `322078c8…`, and remains ambiguous.**
> Until the owner explicitly ratifies this amendment and re-records the hashes, no
> official measurement may use any definition in this file.
>
> Drafted by L11.4. Not applied. Not registered. Not ratified.

---

## 0. Amendment summary

| # | Section | Change | Class | Criterion effect |
|---|---|---|---|---|
| A-1 | §6 metrics | `Comp` restricted to the three composition categories; **two named `AMBIG11` metrics** added | M | none (no criterion uses A4) |
| A-2 | §6 metrics | tie-break pinned to "lowest **bank** index" for all categories | M (wording; no numeric effect under the frozen design) | none |
| A-3 | §4 | new §4.1 "Declared rule (R-majority)" — the rule currently exists only in the specification and in §6 | M (documentary consolidation) | none |
| A-4 | §6 metrics | `Read_rule(A4)` added next to `Read` | M | none |
| A-5 | §7 criteria | **L11-C** names its metric: `MixAcc`, per cell, 0.50 | **A** | **L11-C** only |
| A-6 | §7 criteria | *no other criterion changes* | — | L11-A, B, D, E, F, G untouched |

**Explicitly NOT changed by this amendment** (each is a rejection of a temptation):

- no threshold value (0.50, 0.75, 0.90, −0.10, the 0.50 gap) changes;
- no sample size (120 trials/cell, 3 seeds, 3 tasks, 3 banks);
- no task order, mixture ratio, seed set, arm list, cue construction;
- no null construction (`Null` = three forced cells, averaged equally);
- the declared tie-break is **pinned in wording, not changed in meaning** (A-2);
- no pooled criterion is added (R5b — **declined here**, see §5);
- nothing in §1, §2, §3, §5, §8, §9, §10, §11, §12, §13, §14 changes.

---

## A-3 — new §4.1 in the protocol (insert after §4's existing text)

Rationale [V]: the specification (§2.1) says "The rule is declared in
`stark/design/l11_1_protocol.md` **§4**", but §4 contains no rule. The rule is
currently split between a specification document and one sentence of §6. This
section puts it where the specification already claims it is.

> **§4.1 Declared rule (R-majority) — frozen with this protocol**
>
> For a cue whose features come from signature groups, the **resolved bank** is the
> bank that owns the group contributing the **most features**. Ties are broken by
> the **lowest bank index**. A cue with no features (`OFF`) prescribes no bank; the
> rule is then undefined and any `rule`-class metric for that cue is recorded as
> not-applicable, never as zero.
>
> The rule is a function of the **cue and the bank allocation map only**. It must
> not read the index of the task being evaluated: a rule that can see which task is
> under evaluation cannot be tested for independence from that task.

**[P]** The last paragraph is the R4/D4 requirement expressed where it belongs.

---

## A-1 + A-2 + A-4 — replacement text for protocol §6's metric list

Original §6 lines 99–119 are retained **verbatim** except where marked
`⟨CHANGED⟩` / `⟨ADDED⟩`.

```
Per (seed, task, category), with `n` = number of valid trials:

- `routing = (1/n) Σ 1[first_feature_group(bank) == t]`
  — i.e. the selected bank is the bank that owns task `t`.
- `correct = (1/n) Σ 1[choice == perm[queried]]`
- `Comp = routing` on `CROSS21` / `CROSS31` / `ORDERPERM` — this is the
  R-majority compliance rate.⟨CHANGED: the following sentence is replaced by the
  two named metrics below.⟩
- ⟨CHANGED⟩ `Comp` is **defined only** on `CROSS21`, `CROSS31`, `ORDERPERM`. It is
  not defined on `AMBIG11`, `MISLEAD`, `SHUFFLED` or `OFF`. On the three defined
  categories the cue's majority group is the evaluated task's own group, so
  `Comp = mean(rule_compliant) = mean(routing_correct)` exactly; the two formulas
  are interchangeable there and neither is preferred.
- ⟨ADDED⟩ For `AMBIG11` two metrics are reported, **separately and by name**:
  - `Comp_task(A4) = (1/n) Σ 1[selected_bank == task_bank]`
  - `Comp_rule(A4) = (1/n) Σ 1[selected_bank == rule_bank]`
  where `rule_bank` is the bank prescribed by §4.1 (lowest bank index of the two
  tied groups). `AMBIG11` is a 1:1 tie; `task_bank` and `rule_bank` coincide only
  when the evaluated task's bank is the lower-indexed of the two. Neither number is
  `Comp`, and neither may be reported under the name `Comp`.
- `MixAcc = correct` on the composition arms.
- `Read = mean(correct | routing == 1)` — retrieval given correct resolution.
- ⟨ADDED⟩ `Read_rule(A4) = mean(correct | rule_compliant == 1)` — retrieval given
  **compliance with the declared tie-break**. Reported alongside `Read` for A4;
  never substituted for `Read`.
- `Null(t) = mean(correct)` over `OFF` trials with each bank forced in turn
  (three forced cells averaged equally) — the measured context-ignoring null,
  identical in construction to L10-K1's `acc_null`.
- `ShufAcc = correct` on `SHUFFLED`.
- Derived, reported but not criteria:
  `CompInflation = Comp(A2) − Comp(A9)`;
  `WrongBankAcc = mean(correct | routing == 0)`.

⟨CHANGED⟩ **Tie-break wording.** Everywhere this protocol says "the lowest-index of
the two groups" it means the **lowest bank index**, consistent with §4.1 and with
the registered `declared_rule`. Under a standard allocation these coincide; under a
permuted allocation they do not, and the bank index is the operative rule.

**Aggregation:** per-seed per-task values are primary. A pooled value is the
unweighted mean over the three tasks, reported alongside. No metric is ever
computed from a pooled count.
```

**Note on A-2 [V]:** under the frozen design the two tie-break wordings coincide,
because `AMBIG11` exists only in arm A4 (standard order) and `ccAllocateNext`
allocates banks `0,1,2` in presentation order, giving `task_bank = [0,1,2]`. **The
wording pin therefore changes no recorded number.** It is included because leaving
two incompatible rules in the record is itself the defect.

---

## A-5 — replacement text for L11-C in protocol §7 / specification §6

```
| ID | Criterion |
|---|---|
| **L11-C** | `MixAcc` ≥ 0.50 in **every** cell `(seed, task, arm)`, for
  `seed ∈ {primary seeds}`, `task ∈ {0,1,2}`, `arm ∈ {A2, A3}` |

  `MixAcc(seed, task, arm) = (1/n) Σ 1[correct]`
  over rows with `record_status == OK` and `ACC` in `metric_eligibility`.
  `n` is expected to be 120. A cell with `n = 0`, or a call that delivered fewer
  than 120 trials, is **INCONCLUSIVE**, never a pass. The threshold is **0.50** and
  is not adjusted after seeing any number.
```

**What A-5 fixes [V]:** the frozen text omits the metric name
(`L11_4_R5_METRIC_CONTRACT.md` §1–2). The amendment names it.

**What A-5 does *not* do:** it does not change 0.50; it does not add the pooled
≥0.75 clause (that is R5b, declined here); it does not change the arms (A2, A3); it
does not import the readiness proposal's wider scope (which said "no seed/task
cell" without naming arms — the frozen "in A2 or A3" is retained as the narrower,
later, registered scope).

**Non-monotonicity, stated for the record [I]:** the two candidate readings are
different predicates, not ordered ones. A cell with `Comp(A3)=1.00, Read(A3)=0.00`
passes under the routing reading and fails under `MixAcc`; a cell with
`Comp(A3)=0.30, WrongBankAcc=1.00` fails the first and passes the second. The
amendment must therefore be described as **redefining** L11-C, not as
"strengthening" it.

---

## 5. R5b — the pooled clause: **declined in this draft**

The readiness proposal (superseded, `ba1cfb3`) carried "`MixAcc` pooled ≥ 0.75".
It is absent from the protocol, the specification, the preregistration and the
L11.1 instrumentation record.

**Disposition: not included.** Reasons: (i) it introduces a threshold that was never
registered, and adding a threshold inside a "clarification" is the exact manoeuvre
the safeguards forbid; (ii) its pooling contract is undefined in every document —
pooled over tasks? over seeds? over A2 and A3 together? — and the only
protocol-consistent form (unweighted mean of per-task values, per §6) yields **one
value per seed per arm**, i.e. six numbers, not one.

**If the owner wants it**, it becomes amendment item A-7 with this contract:

> `MixAcc_pooled(seed, arm) = (1/3) Σ_task MixAcc(seed, task, arm)` — an unweighted
> mean of the three per-task values, never a pooled count. Criterion: every primary
> seed and both arms must satisfy `MixAcc_pooled ≥ 0.75`.

It is **not** in this draft.

---

## 6. Consistency with the existing record — checked, not assumed

| Check | Result |
|---|---|
| Does A-5 contradict L11-A? | **No** — L11-A constrains `Comp(A2)` (routing); A-5 constrains `MixAcc`. Under both, a run can pass one and fail the other, as intended |
| Does A-5 contradict L11-B? | **No** — L11-B is a *gap* against a measured null; A-5 is an absolute floor. Different predicates |
| Does A-5 contradict L11-D? | **No** — L11-D constrains retrieval *given* routing; A-5 constrains the unconditional result. Together they bound each other, not duplicate |
| Does A-1 contradict L11-G? | **No** — L11-G uses `Comp` on A2 and A9, both `CROSS21`, where A-1 keeps `Comp` unchanged **[V]** |
| Does A-1 contradict the prereg's `declared_rule`? | **No** — the prereg already says "ties broken by lowest **bank** index", which A-2 now matches. The prereg is *not* the outlier |
| Does any item touch the null construction? | **No** |
| Does any item touch thresholds or sample sizes? | **No** |
| Does any item add an arm or a cue mode? | **No** |

---

## 7. Registration checklist (all items required before this draft has any force)

1. Owner ratifies **R4, R4b, R4c, R5** explicitly, in writing, in the decision
   record.
2. Owner records a decision on **R5b** (adopt-with-contract, or reject).
3. This text is committed as `stark/design/l11_1_protocol_v0_2.md` — **a new file**;
   `l11_1_protocol.md` (v0.1) stays byte-identical.
4. Its sha256 is computed **after** the final edit and recorded in the
   preregistration as `registered_protocol_v0_2.sha256`, with
   `registered_protocol.sha256` (v0.1) retained.
5. The preregistration's `criteria_candidate["L11-C"]` is replaced and the v0.1
   string retained under `criteria_candidate_v0_1`.
6. The adopted schema hash (v0.2.1 after the L11.4 errata) is recorded.
7. R1 (thresholds) is ratified **separately** — this amendment does not ratify it.
8. Only then may R3's conditional implementation authorisation be acted on.

Until items 1–7 are complete: **the operative protocol is v0.1. It is frozen. It is
ambiguous. No official run may use it.**
