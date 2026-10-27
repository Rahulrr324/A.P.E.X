# STARK-L11 — Candidate Protocol Amendment v0.1 → v0.2 (CANDIDATE, UNREGISTERED)

> # ⚠ CANDIDATE — NOT REGISTERED — NOT AUTHORIZED
>
> **This is not a protocol.** It has **no official hash**, it is **not frozen**, it is
> **not recorded in the preregistration**, and it **authorizes nothing**.
>
> The operative protocol remains `stark/design/l11_1_protocol.md` v0.1, sha256
> `322078c8345b5c72c4954a6de529329065d8875f2a103626039e92f09a810c32`. It is frozen and
> it is **ambiguous**.
>
> **Hashes of this candidate are not protocol hashes** and must never be recorded as
> such. If the owner adopts this text, a *new file* is committed, its hash is computed
> **after** the final edit, and only then is it registered (R6).
>
> Prepared by L11.6. Supersedes nothing. Replaces no prior draft's status: the L11.5
> draft (`work/L11_5_AMENDMENT_DRAFT.md`, `883312d9…`) remains an unregistered draft
> and is **not** withdrawn or amended by this file.

---

## 0. What changed since the L11.5 draft

This candidate is **narrower** than L11.5's in three ways, and adds one item:

| Difference | Reason |
|---|---|
| **L11-A … L11-G multiplicity findings are attached** (new §8) | computed in L11.6; the owner must see them before ratifying R1 |
| **F4 added** (protocol §5 stream seeds disagree with the code) | verified in L11.6 |
| **`Read_rule(A4)` status fixed as diagnostic** | R4c; L11.5's draft left it implicitly criterion-adjacent |
| **L11-C text now states the cell count and the reporting rule explicitly** | L11.6 §3 of the R5 analysis showed the cell count is unstated and materially changes power |
| **R5b remains excluded** | unchanged: a pooled threshold needs its own decision |

---

## 1. Source sections requiring change

| Item | File | Section | Change | Class |
|---|---|---|---|---|
| **A-1** | `l11_1_protocol.md` | §6 metrics | `Comp` restricted to 3 categories; `Comp_task(A4)`, `Comp_rule(A4)` added, named | metric-definition |
| **A-2** | `l11_1_protocol.md` | §6 | tie-break pinned to "lowest **bank** index" | metric-definition (wording) |
| **A-3** | `l11_1_protocol.md` | new **§4.1** | R-majority stated inside the protocol (it is absent today) | metric-definition (consolidation) |
| **A-4** | `l11_1_protocol.md` | §6 | `Read_rule(A4)` added, **diagnostic only** | metric-definition |
| **A-5** | `l11_1_protocol.md` | §7 / spec §6 | **L11-C names its metric and its cells** | **acceptance-criterion** |
| **A-6** | `l11_1_protocol.md` | §11 | exactness check references `rule_bank`, not the removed `intended_bank` | serialization-only |
| **A-7** | `l11_1_protocol.md` | §5 | stream-seed table corrected to the implemented seeds; new cross-family constant assigned | serialization-only (precondition for L11-E) |
| **A-8** | `l11_1_protocol.md` | §7 / spec §6 | **L11-B and L11-G tests stated** (paired/unpaired, exact/approximate, interval rule) | **acceptance-criterion (specification gap)** |
| **A-9** | `l11_1_protocol.md` | §7 | L11-A/D reporting rule states the **joint** power, not the per-cell power | **acceptance-criterion (reporting)** |
| **A-10** | `l11_1_protocol.md` | §4 | `o` distribution stated; `MISLEAD`/`SHUFFLED` distinguished | **experimental-design — NOT DRAFTED** |

**A-10 is listed and deliberately not drafted.** It is class **X**; drafting a specific
distribution would prejudge F1/F2, which the owner has not answered.

---

## 2. Before-and-after

### 2.1 `Comp` (§6)

| | Before (v0.1) | Candidate v0.2 |
|---|---|---|
| `Comp` defined on | `CROSS21`, `CROSS31`, `ORDERPERM` **and** a sentence prescribing a bank for `AMBIG11` | `CROSS21`, `CROSS31`, `ORDERPERM` **only** |
| `AMBIG11` | one sentence, no metric name | `Comp_task(A4)` and `Comp_rule(A4)`, named, non-criterion |
| Ambiguity | two readings in two consecutive sentences | one reading per name |
| Numbers changed on the 3 categories | — | **none** (there `rule_bank == task_bank`) **[V]** |

### 2.2 The rule (§4 / new §4.1)

| | Before | Candidate |
|---|---|---|
| Where | Specification §2.1, which claims it is in protocol §4 — **it is not** **[V]** | new protocol §4.1 |
| Tie-break | §6 says "lowest-index of the two **groups**"; spec and prereg say "lowest **bank** index" | "lowest **bank** index" |
| Inputs | unstated | the cue, `group(f) = f/4`, and the **read-only** group→bank map; **never** the evaluated task's index |
| Numeric effect today | — | **zero** (`task_bank = [0,1,2]` in A4) **[C]** |

### 2.3 L11-C (§7)

| | Before | Candidate |
|---|---|---|
| Text | "no cell `(seed, task)` in A2 or A3 below 0.50" | `MixAcc` ≥ 0.50 in every `(seed, task, arm)` cell, `arm ∈ {A2, A3}` |
| Metric | **unnamed** | `MixAcc` |
| Cell count | unstated | **18** (3 seeds × 3 tasks × 2 arms), stated explicitly |
| Threshold | 0.50 | **0.50 — unchanged** |
| Missing cell | unstated | INCONCLUSIVE, never imputed, never dropped |
| Reporting | unstated | "consistent with ≥ 0.50 in all 18 cells at n = 120"; the **joint** power table is printed beside the result |
| Pooled clause | absent | **still absent** (R5b) |
| Monotone? | — | **no** — a cell with `Comp(A3)=1.00, Read(A3)=0.00` passed before and fails now; `Comp(A3)=0.30, WrongBankAcc=1.00` failed before and passes now |

### 2.4 L11-B / L11-G tests (A-8)

| | Before | Candidate |
|---|---|---|
| L11-B | "`MixAcc(A2,t) − Null(t) ≥ 0.50` on at least two of three tasks, every seed" — **no test** | a two-sided 95 % interval on the difference of two independent proportions (n = 120 each), requiring the **lower** bound ≥ 0.50. Exact (Clopper–Pearson based) rather than normal-approximate. The interval is reported per task. |
| L11-G | "`Comp(A2) − Comp(A9) ≥ −0.10` on every seed" — **no test** | difference of two independent proportions (A2 and A9 are different training runs, so not paired), lower 95 % bound ≥ −0.10, reported per seed |

**These are proposed tests, not existing requirements — [P], and they change how the criteria are decided.**

### 2.5 A-9 reporting rule

| | Before | Candidate |
|---|---|---|
| L11-A / L11-D | per-cell power documented (0.5761 at 0.90) | per-cell power **and joint power over the 9 cells** (0.00699 at 0.90) printed beside the result **[C]** |

---

## 3. Exact text

### 3.1 New §4.1

> **§4.1 Declared rule (R-majority) — frozen with this protocol**
>
> For a cue whose features come from signature groups, the **resolved bank** is the
> bank that owns the group contributing the most features. Ties are broken by the
> **lowest bank index** among the tied groups' banks. A cue with no features (`OFF`)
> prescribes no bank: the rule is undefined and any rule-class metric for that cue is
> not-applicable, never zero.
>
> The rule is a function of the cue, the arithmetic `group(f) = f / 4`, and the
> read-only group→bank map. It must **not** read the index of the task being evaluated.
> The map is required: a group index is not a bank index.

### 3.2 Replacement for the `Comp` bullet in §6

```
- `routing = (1/n) Σ 1[first_feature_group(bank) == t]`   (unchanged)
- `correct = (1/n) Σ 1[choice == perm[queried]]`           (unchanged)
- `Comp = mean(rule_compliant)` on `CROSS21` / `CROSS31` / `ORDERPERM`, and on no
  other category. On those categories the majority group is the evaluated task's own
  group, so `Comp = mean(routing_correct)` exactly; the two formulas are
  interchangeable there.
- For `AMBIG11` (a 1:1 tie with no majority group) two non-criterion metrics are
  reported, separately and by name:
      Comp_task(A4) = (1/n) Σ 1[selected_bank == task_bank]
      Comp_rule(A4) = (1/n) Σ 1[selected_bank == rule_bank]
  Neither is `Comp`; neither may be reported under the name `Comp`.
- `MixAcc = correct` on the composition arms.        (unchanged)
- `Read = mean(correct | routing == 1)`.             (unchanged)
- `Read_rule(A4) = mean(correct | rule_compliant == 1)` — a DIAGNOSTIC. It is not an
  acceptance criterion, does not replace `Read`, and is reported beside it.
- `Null(t)`, `ShufAcc`, `CompInflation`, `WrongBankAcc` — unchanged.
```

### 3.3 Replacement for L11-C in §7

```
| **L11-C** | `MixAcc` ≥ 0.50 in every (seed, task, arm) cell, for every primary seed,
  every task t ∈ {0,1,2}, and arm ∈ {A2, A3} — 18 cells in total. |

  MixAcc(seed, task, arm) = (1/n) Σ 1[choice == perm_task[queried]] over rows with
  record_status == OK and ACC in metric_eligibility; n is expected to be 120.
  A cell with n = 0, or an evaluation call delivering fewer than 120 trials, is
  INCONCLUSIVE — never a pass, never imputed, never dropped.
  The threshold is 0.50 and is not adjusted after any number is seen.
  A pass is reported as "consistent with ≥ 0.50 in all 18 cells at n = 120", together
  with the joint power at a true 0.50 (1.3e-5) and at a true 0.55 (0.107).
```

### 3.4 §11 repair

```
- R-majority predictions for every distinct `CROSS21`/`CROSS31` cue are enumerated and
  checked against the writer's `rule_bank` field before any run is scored (a unit
  test, not a measurement).
```

### 3.5 §5 stream table repair (A-7)

| Stream | Protocol v0.1 says | Code actually uses | Candidate |
|---|---|---|---|
| evaluation schedule | `master + 9300` | `master + 5001 + t` | `master + 5001 + t` |
| shuffled-cue draw | `master + 9500` | `master + 9100 + t` | `master + 9100 + t` |
| cross-family draw | `master + 9600` | `master + 9400 + t` (`CM_CROSS` only) | `master + 9400 + t` for the existing diagnostic; **the new L11 cross-family stream must be assigned an unused constant** |

All three verified in this milestone **[V]**.

---

## 4. Artifact compatibility and migration table

| Artifact | Current state | Effect of adopting this candidate | Migration |
|---|---|---|---|
| `stark/design/l11_1_protocol.md` v0.1 `322078c8…` | frozen, ambiguous | **untouched, forever** | none — a **new** `l11_1_protocol_v0_2.md` is committed alongside |
| `work/L11_1_PREREGISTRATION.json` `57a8139d…` | pins v0.1 protocol, spec, schema v0.1; ratification pending | must gain the v0.2 protocol hash **and** a v0.2.1 schema hash | **additive only**; v0.1 keys retained (R6) |
| `criteria_candidate["L11-C"]` | "no (seed, task) cell in A2 or A3 below 0.50" | replaced by the A-5 text | retain the old string under `criteria_candidate_v0_1` |
| `criteria_candidate` L11-A, B, D, E, F, G | frozen strings | B and G gain a stated test (A-8); A and D gain a joint-power reporting rule (A-9) | those four are **acceptance-criterion changes** and need explicit approval |
| `stark/design/l11_trial_schema.md` v0.1 `a8edd674…` | frozen | superseded in intent by v0.2.1 | retained; `schema_sha256_v0_2_1` recorded |
| `stark/design/l11_trial_schema_v0_2.md` `1ce1525b…` | proposal, 9 errata | needs D1–D8 corrections (v0.2.1) | the amendment **depends on** the errata |
| `stark/design/l11_cross_signature_compositional_generalization.md` `d9cd7dc4…` | `DRAFT_NOT_RATIFIED`; its "declared in protocol §4" becomes true under A-3 | no edit strictly required; an edit would change its recorded hash | prefer **no edit**; the string becomes true |
| L11.1 / L11.2 / L11.3 / L11.4 / L11.5 reports | committed | untouched | none |
| L10 evidence and criteria | frozen, ratified in the L10 chain | untouched; L11 does not reinterpret L10 | none |
| Published L10 figures (e.g. pooled accuracy 0.5611) | task-bank/routing-based under L10's own protocol | **not reinterpreted** | none |

---

## 5. Acceptance-criterion changes vs semantic clarifications

| Item | Type | Why |
|---|---|---|
| A-1 `Comp` + two named A4 metrics | **semantic clarification** | no criterion references A4 |
| A-2 tie-break wording | **semantic clarification** | zero numeric effect today |
| A-3 §4.1 rule statement | **semantic clarification** | states what the spec already asserts exists |
| A-4 `Read_rule(A4)` diagnostic | **semantic clarification** | explicit non-criterion |
| **A-5 L11-C metric** | **ACCEPTANCE-CRITERION CHANGE** | the metric changes from unnamed to `MixAcc`; the predicate changes, and **not monotonically** |
| A-6 §11 field name | semantic clarification | dangling reference |
| A-7 §5 stream seeds | semantic clarification | docs-to-code alignment |
| **A-8 L11-B / L11-G tests** | **ACCEPTANCE-CRITERION CHANGE** | adds a decision rule where none existed |
| **A-9 joint-power reporting** | **ACCEPTANCE-CRITERION CHANGE (reporting)** | changes how a pass is phrased |
| A-10 F1/F2 | **experimental design — NOT DRAFTED** | class X |

**Three acceptance-criterion changes: A-5, A-8, A-9.** A-8 and A-9 are *new* in this
candidate; L11.5's draft proposed only A-5.

---

## 6. Remaining owner decisions

| ID | Question | Blocks |
|---|---|---|
| **R5** | L11-C = `MixAcc` per cell, 0.50? | every official run |
| **R4** | report two named A4 metrics? | unambiguity |
| **R4b** | tie-break = lowest bank index? | A4 |
| **R4c** | `Read_rule(A4)` diagnostic? | nothing |
| **R5b** | pooled 0.75 — adopt with contract, or reject? | nothing today |
| **F1** | `MISLEAD` vs `SHUFFLED`? | A6/A7 |
| **F2** | `o` distribution? | all cross-family arms |
| **F4** | correct §5 to the code? | L11-E |
| **R6** | record hashes additively? | provenance |
| **R1** | ratify A–G — including A-8/A-9 and the joint-power disclosure? | any official run |

---

## 7. Conditions required before implementation authorization

1. R4, R4b, R4c, R5 ratified; R5b decided.
2. F1, F2, F4 answered.
3. R1 ratified **with** the A-8/A-9 text and the joint-power disclosure.
4. Schema v0.2.1 errata (D1–D8) adopted.
5. R6 hashes recorded.
6. **Only then** may R3's conditional authorization be acted on (the C1–C7 patch).
7. **Separately**, a class-X authorization is required for arm implementation.

**Until 1–5 are complete, the operative protocol is v0.1. It is frozen. It is
ambiguous. No official run may use it.**
