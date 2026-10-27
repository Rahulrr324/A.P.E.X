# STARK-L11 — Proposed Protocol Amendment v0.1 → v0.2

> # ⚠ UNREGISTERED — PENDING OWNER DECISION
>
> **This is not a protocol.** It has no hash in the preregistration, it is not
> frozen, and it authorizes nothing.
>
> **The operative protocol remains `stark/design/l11_1_protocol.md` v0.1, sha256
> `322078c8345b5c72c4954a6de529329065d8875f2a103626039e92f09a810c32`, and it
> remains ambiguous.** No official measurement may use any definition in this file
> until the owner ratifies it and the hashes are re-recorded.
>
> Drafted by L11.5. Not applied. Not registered. Not ratified. The frozen v0.1 file
> is **byte-identical** to its registered state and must never be edited.

---

## 0. Why an amendment and not a schema revision

The protocol is frozen **by hash**, and that hash is recorded in
`work/L11_1_PREREGISTRATION.json`. Any textual change produces a different document.
The only lawful mechanism is therefore:

- **`l11_1_protocol.md` stays exactly as it is** (v0.1, `322078c8…`);
- a **new file** `stark/design/l11_1_protocol_v0_2.md` carries the amended text;
- the preregistration records **both** hashes (`protocol_sha256` retained,
  `protocol_sha256_v0_2` added).

A schema revision (v0.2 → v0.2.1) is a *separate, smaller* act that changes only how
a trial is recorded. It is not sufficient for any item below, because every item here
changes how a **result is defined**.

---

## 1. Amendment items

| # | Section | Change | Class | Criterion effect | Owner decision |
|---|---|---|---|---|---|
| **A-1** | §6 | `Comp` restricted to the three composition categories; **two named `AMBIG11` metrics** added | metric-definition | none | **R4** |
| **A-2** | §6 | tie-break pinned to "lowest **bank** index" | metric-definition (wording) | none; **zero numeric effect** under the frozen design | **R4b** |
| **A-3** | new §4.1 | state R-majority and the tie-break inside the protocol (currently absent from every ratified document) | metric-definition (consolidation) | none | **R4** |
| **A-4** | §6 | add `Read_rule(A4)` | metric-definition | none | **R4c** |
| **A-5** | §7 | **L11-C names its metric**: `MixAcc`, per cell, 0.50 unchanged | **acceptance-criterion** | **L11-C only** | **R5** |
| **A-6** | §11 | the exactness check must reference `rule_bank`, not the removed `intended_bank` | serialization-only | none | **F3** |
| **A-7** | §4 | state the `o` sampling distribution; make `MISLEAD` and `SHUFFLED` distinguishable | experimental-design (**not proposed for adoption here**) | none | **F1, F2** |

**Not changed by this amendment** — each is a deliberate refusal:

- no threshold value (0.50, 0.75, 0.90, −0.10, the 0.50 gap) is altered;
- no sample size (120/cell, 3 seeds, 3 tasks, 3 banks, 6 identities);
- no task order, seed set, mixture ratio, arm list, or cue construction for the
  categories the criteria use;
- no null construction (`Null` = three forced cells, averaged equally, §6);
- **no pooled criterion is added** (R5b is declined here — see §5);
- nothing in §1, §2, §3, §5, §8, §9, §10, §12, §13, §14 changes.

**A-7 is listed but deliberately NOT drafted into the text**: it is an
experimental-design change (class X), it is not authorized, and drafting a specific
`o` distribution would prejudge a decision the owner has not taken. It appears here
only so its absence is deliberate rather than an oversight.

---

## 2. Before-and-after comparison

### 2.1 `Comp` (§6)

| | Before (v0.1, `322078c8…`) | After (proposed v0.2) |
|---|---|---|
| Definition | "`Comp = routing` on `CROSS21` / `CROSS31` / `ORDERPERM` — this is the R-majority compliance rate. For `AMBIG11` the prescribed bank is the **lowest-index** of the two groups (declared tie-break)." | "`Comp` is **defined only** on `CROSS21`, `CROSS31`, `ORDERPERM`… On the three defined categories `Comp = mean(rule_compliant) = mean(routing_correct)` exactly." |
| `AMBIG11` | one sentence asserting a "prescribed bank", with no named metric | two named metrics: `Comp_task(A4)` and `Comp_rule(A4)` |
| Ambiguity | two definitions in two consecutive sentences | one definition per name; `Comp` never means two things |
| Numbers changed | — | **none on any category `Comp` is defined for** |

### 2.2 Tie-break (§4.1 / §6)

| | Before | After |
|---|---|---|
| Where stated | §6 only, and only for `AMBIG11`; spec §2.1 claims §4 states it (it does not) | new §4.1 states the rule and the tie-break for all categories |
| Wording | "lowest-index of the two **groups**" | "**lowest bank index**" |
| Numeric effect today | — | **zero** (`task_bank = [0,1,2]` in A4 ⇒ `min(bank) ≡ min(group)`) **[C]** |
| Effect under a permuted allocation | undefined by v0.1 | unambiguous |

### 2.3 L11-C (§7)

| | Before | After |
|---|---|---|
| Text | "no cell `(seed, task)` in A2 or A3 below **0.50**" | "`MixAcc` ≥ 0.50 in every cell `(seed, task, arm)`, `arm ∈ {A2, A3}`" |
| Metric | **unnamed** | `MixAcc` |
| Threshold | 0.50 | **0.50 — unchanged** |
| Scope | A2, A3 | A2, A3 — unchanged |
| Aggregation | per cell (implied) | per cell, explicitly; never pooled |
| Missing data | silent | `n = 0` or short call ⇒ **INCONCLUSIVE**, never a pass |
| Statistical phrasing | none | "consistent with ≥ 0.50 at n = 120", never "≥ 0.50 established" |
| Pooled clause | absent | **still absent** (R5b declined) |
| Predicate changed? | — | **yes** — a cell with `Comp(A3)=1.00, Read(A3)=0.00` passed before this draft and fails after it; a cell with `Comp(A3)=0.30, WrongBankAcc=1.00` failed before and passes after. **Not monotone** |

### 2.4 `Read` for A4 (§6)

| | Before | After |
|---|---|---|
| `Read` | `mean(correct \| routing == 1)` | unchanged |
| A4 eligibility | `READ` eligible (v0.2 §5) | unchanged |
| Rule-conditioned retrieval | not measured | `Read_rule(A4) = mean(correct \| rule_compliant == 1)` **added alongside** |

### 2.5 §11 exactness check

| | Before | After |
|---|---|---|
| Field referenced | "the writer's `intended_bank` field" — **removed by schema v0.2** | "the writer's `rule_bank` field" |
| Categories enumerated | `CROSS21`/`CROSS31` | unchanged (the amendment does not extend it; that would be a new requirement) |

---

## 3. Exact proposed text

### 3.1 New §4.1 (insert at the end of §4)

> **§4.1 Declared rule (R-majority) — frozen with this protocol**
>
> For a cue whose features come from signature groups, the **resolved bank** is the
> bank that owns the group contributing the **most features**. Ties are broken by the
> **lowest bank index**. A cue with no features (`OFF`) prescribes no bank: the rule
> is then undefined and any rule-class metric for that cue is recorded as
> not-applicable, never as zero.
>
> The rule is a function of the **cue and the bank allocation map only**. It must not
> read the index of the task being evaluated. (It *must* read the allocation map: a
> feature group index is not a bank index, and the map is what names a bank.)

### 3.2 Replacement for the `Comp` bullet in §6

Original lines retained verbatim except where marked.

```
- `routing = (1/n) Σ 1[first_feature_group(bank) == t]`
  — i.e. the selected bank is the bank that owns task `t`.
- `correct = (1/n) Σ 1[choice == perm[queried]]`
- `Comp = routing` on `CROSS21` / `CROSS31` / `ORDERPERM` — this is the
  R-majority compliance rate.⟨CHANGED: the trailing sentence about AMBIG11 is
  removed from this bullet and replaced by the two named metrics below.⟩
- ⟨CHANGED⟩ `Comp` is **defined only** on `CROSS21`, `CROSS31` and `ORDERPERM`. On
  those categories the cue's majority group is the evaluated task's own group, so
  `Comp = mean(rule_compliant) = mean(routing_correct)` exactly; the two formulas
  are interchangeable there and neither is preferred. `Comp` is **not defined** on
  `AMBIG11`, `MISLEAD`, `SHUFFLED` or `OFF`.
- ⟨ADDED⟩ For `AMBIG11` two metrics are reported, **separately and by name**:
  - `Comp_task(A4) = (1/n) Σ 1[selected_bank == task_bank]`
  - `Comp_rule(A4) = (1/n) Σ 1[selected_bank == rule_bank]`
  where `rule_bank` is the bank prescribed by §4.1. `AMBIG11` is a 1:1 tie with no
  majority group; `task_bank` and `rule_bank` coincide only when the evaluated
  task's bank is the lower-indexed of the two. Neither number is `Comp`, and neither
  may be reported under the name `Comp`.
- `MixAcc = correct` on the composition arms.
- `Read = mean(correct | routing == 1)` — retrieval given correct resolution.
- ⟨ADDED⟩ `Read_rule(A4) = mean(correct | rule_compliant == 1)` — retrieval given
  compliance with the declared tie-break. Reported alongside `Read` for A4; never
  substituted for `Read`.
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

### 3.3 Replacement for L11-C in §7

```
| **L11-C** | `MixAcc` ≥ 0.50 in **every** cell `(seed, task, arm)`, for
  `seed ∈ {primary seeds}`, `task ∈ {0,1,2}`, `arm ∈ {A2, A3}` |

  `MixAcc(seed, task, arm) = (1/n) Σ 1[correct]` over rows with
  `record_status == OK` and `ACC` in `metric_eligibility`; `n` is expected to be 120.
  A cell with `n = 0`, or an evaluation call that delivered fewer than 120 trials, is
  **INCONCLUSIVE**, never a pass. The threshold is **0.50** and is not adjusted after
  seeing any number. A pass is reported as "consistent with ≥ 0.50 at n = 120",
  never as "≥ 0.50 established".
```

### 3.4 §11 exactness check, repaired

```
- R-majority predictions for every distinct `CROSS21`/`CROSS31` cue are enumerated
  and checked against the writer's `rule_bank` field before any run is scored
  (a unit test, not a measurement).
```

---

## 4. Compatibility analysis

### 4.1 Against the frozen protocol v0.1

| Item | Compatible? | Note |
|---|---|---|
| A-1 | **yes** — narrows `Comp` to where §6 already defines it, and names two new reported quantities | no criterion moves |
| A-2 | **yes** — a wording pin with zero numeric effect **[C]** | — |
| A-3 | **yes** — adds a statement the specification already claims exists | — |
| A-4 | **yes** — additive reported metric | — |
| A-5 | **no — a deliberate redefinition** | must be registered as such; see §2.3 |
| A-6 | **yes** — repairs a dangling reference | requires v0.2 schema adoption |
| A-7 | **would be a design change** — not proposed | — |

### 4.2 Against the preregistration

| Prereg field | Impact | Handling |
|---|---|---|
| `registered_protocol.sha256` | must remain valid for v0.1 | **retain** |
| (new) `registered_protocol_v0_2.sha256` | records the amendment | add only on ratification |
| `companion_documents.specification.sha256` | the spec's "declared in protocol §4" claim becomes true once §4.1 exists | no re-record needed for A-3; a spec edit would need one |
| `companion_documents.trial_schema.sha256` | v0.1 superseded in intent by v0.2.1 | record v0.2.1; retain v0.1 |
| `criteria_candidate["L11-C"]` | text changes under A-5 | replace; retain the old string under `criteria_candidate_v0_1` |
| `criteria_candidate` A, B, D, E, F, G | **unchanged** | untouched |
| `declared_rule.statement` | already says "lowest **bank** index" — matches A-2 | untouched |
| `declared_rule.applies_to` | already lists `AMBIG11 (tie-break clause)` | untouched |
| seeds, arms, thresholds, sample sizes, ordering, mixture ratios, null construction | **no change proposed anywhere** | untouched |

**No field of the preregistration is modified by this draft.**

### 4.3 Against schema v0.2

| Schema element | Compatible with the amendment? |
|---|---|
| `task_bank`, `rule_bank`, `rule_compliant` | **yes** — exactly what A-1 needs |
| `choice_matches_resolved_bank_map` | **yes** — supports `Comp_rule` diagnostics |
| `presented_ids` with `X` | **no** — D3; needs `NA:UNUSED_CHANNEL` |
| `bank_score_margin` unmasked | **no** — D2 |
| `selected_bank = -1` described as real | **no** — D1 |
| P7 "cue only" | **no** — D4 |
| invariant 20 | **no** — D8 |

The amendment therefore **depends on** the v0.2.1 errata (D1–D8). Adopting the
amendment with v0.2 as written would specify two unreachable invariants, one wrong
diagnostic, one undefined token and an unimplementable helper.

### 4.4 Against prior reports

| Report | Effect |
|---|---|
| L11.1 (protocol/spec/schema/prereg) | **preserved untouched**; the amendment is a new document alongside |
| L11.2 (audit) | `work/L11_2_R3_AUTHORIZATION_AUDIT.md` is **frozen and must not be edited**. Its line 190–193 claim about `AMBIG11` is wrong and is corrected *here*, not there |
| L11.3 (schema v0.2) | **preserved untouched**; errata proposed separately |
| L11.4 (R4/R5 review) | **preserved untouched**; L11.5 re-verified its findings and refined two of them (R5's category classification; the `MISLEAD`/`SHUFFLED` collision) |
| L10 evidence | **preserved untouched**; L10's published figures use task-bank routing under L10's own ratified protocol and are not reinterpreted |

---

## 5. R5b — declined in this draft

The readiness proposal's "`MixAcc` pooled ≥ 0.75" is **not included**:

- it introduces a threshold that was never registered;
- its pooling contract is undefined in every document;
- adding a threshold inside a "clarification" is exactly what the safeguards forbid.

If adopted later it becomes item **A-8** with this contract:

> `MixAcc_pooled(seed, arm) = (1/3) Σ_task MixAcc(seed, task, arm)` — an unweighted
> mean of the three per-task values, never a pooled count. Criterion: every primary
> seed and both arms must satisfy `MixAcc_pooled ≥ 0.75`.

---

## 6. Decisions requiring explicit owner ratification

| # | Decision | What the owner is ratifying |
|---|---|---|
| 1 | **R4** | `Comp` confined to three categories; A4 reported as two named metrics |
| 2 | **R4b** | tie-break = lowest **bank** index |
| 3 | **R4c** | `Read_rule(A4)` added |
| 4 | **R5** | L11-C metric = `MixAcc`; threshold 0.50 retained; **acceptance-criterion change** |
| 5 | **R5b** | adopt-with-contract or reject the pooled clause |
| 6 | **R6** | record the v0.2 protocol hash **and** the v0.2.1 schema hash |
| 7 | **R1** | ratify the criteria and thresholds (separate; not implied by 1–6) |
| 8 | **F1 / F2** | `MISLEAD` vs `SHUFFLED` differentiation; `o` distribution (blocks A-7, blocks A4/A6/A7 implementation) |

**Item 4 is the only one that changes an acceptance criterion.** Items 1, 2, 3 and 6
change no criterion. Item 7 is not caused by this amendment and cannot be discharged
by it.

---

## 7. Implementation changes that must wait for ratification

| # | Change | Blocked by |
|---|---|---|
| 1 | `--emit-l11` and the separate writer (C1) | R3 + items 1–6 |
| 2 | row capture in `evalTask` (C2) | R3 + v0.2.1 errata |
| 3 | per-trial `w0`, pre-call baseline, `baseline_index` (C3/D6/D7) | R3 |
| 4 | `rule_bank` / P7 with the group→bank map (C4/D4) | item 1 + D4 errata |
| 5 | masked `bank_score_margin` (D2) | v0.2.1 errata |
| 6 | `NA:UNUSED_CHANNEL` in `presented_ids` (D3) | v0.2.1 errata |
| 7 | `forced_bank` on `per_bank_off` (D8) | v0.2.1 errata |
| 8 | **any metric computation** | item 4 (R5) — a metric whose definition is unratified cannot be computed into a report |
| 9 | `CM_CROSS21`, `CM_CROSS31`, `CM_AMBIG11`, `CM_MISLEAD`, arm selector | **class X, not authorized at all**; plus items 1–8 |
| 10 | `test_phase1_affinity` port | R2 (approved in principle; unapplied) |

---

## 8. Readiness matrix

| Gate | Blocks | Status |
|---|---|---|
| R4 / R4b / R4c ratified | protocol unambiguity | **open** |
| R5 ratified | **every official run** | **open** |
| R5b decided | nothing today | open |
| v0.2.1 errata adopted | any correct implementation | open |
| R6 hashes re-recorded | preregistration completeness | open |
| R1 ratified | any official run | **open — not ratified** |
| R2 affinity port | L11-F gate | open, independent |
| R3 implementation | instrumentation | open |
| C1–C7 satisfied | implementation correctness | **none satisfied** |
| C6 battery | non-interference | not run |
| arms implemented | any L11 measurement | **not authorized, not started** |
| §11 rule unit test | composition correctness | **never executed** |

**An official L11 run cannot be authorized while any row above is open.**

---

## 9. Registration checklist

1. Owner ratifies items 1–5 and 8 in writing.
2. Owner records a decision on R5b.
3. This text is committed as `stark/design/l11_1_protocol_v0_2.md` — **a new file**;
   `l11_1_protocol.md` (v0.1) stays byte-identical.
4. Its sha256 is computed **after** the final edit and recorded in the preregistration
   as `registered_protocol_v0_2.sha256`, with the v0.1 hash retained.
5. `criteria_candidate["L11-C"]` is replaced; the v0.1 string is retained under
   `criteria_candidate_v0_1`.
6. The adopted schema hash (v0.2.1) is recorded.
7. **R1 is ratified separately.**
8. Only then may R3's conditional authorization be acted on.

Until 1–7 are complete: **the operative protocol is v0.1. It is frozen. It is
ambiguous. No official run may use it.**
