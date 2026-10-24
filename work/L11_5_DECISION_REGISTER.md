# STARK-L11.5 — Decision Register

**Prepared:** 2026-10-24 · **Milestone:** STARK-L11.5
**Nature:** documentation only. **Nothing in this register is ratified or applied.**

Three status axes are kept strictly separate, because conflating them is how
"approved in principle" turns into "authorized" without anyone deciding:

| Axis | Question it answers |
|---|---|
| **Approval** | has the owner said yes *in principle*? |
| **Work** | has the change actually been *made*? |
| **Authority** | is the *result* formally authorized for official use? |

An item can be approved but not done (R2/R3), done but not authorized (the schema
v0.2 proposal), or neither.

---

## A. Inherited decisions

### R1 — Ratify the L11 acceptance criteria and thresholds

| | |
|---|---|
| Approval | **NOT RATIFIED** |
| Work | criteria drafted; **one of them (L11-C) is not evaluable as written** |
| Authority | none — prereg `criteria_candidate.ratification = PENDING_OWNER_DECISION` **[V]** |
| Blocking | **yes** — every official run |
| Changed by L11.5 | none. L11.5 does not ratify and does not presume ratification |

### R2 — `test_phase1_affinity` disposition

| | |
|---|---|
| Approval | **approved in principle** (behaviour-preserving portability change) |
| Work | **UNAPPLIED** — `stark/tests/test_phase1_affinity.cpp` sha256 `9dab81ee…` unchanged **[V]** |
| Authority | n/a (a test fix, not a protocol act) |
| Blocking | the L11-F regression gate, formally |
| Test status | **UNEXECUTED — build failure** (`DWORD_PTR` undeclared, 6 errors) |

### R3 — Authorise the instrumented harness change under C1–C7

| | |
|---|---|
| Approval | **conditionally approved in principle**, subject to C1–C7 |
| Work | **UNAPPLIED** — no harness edit exists; `l10_validation_harness.cpp` sha256 `697b5f8a…` unchanged **[V]** |
| Authority | **none**. A conditional recommendation is not a completed authorization, and this register does not treat it as one |
| Prerequisite added by L11.5 | the v0.2.1 errata (D1–D8) and the P7 signature correction (D4) must precede implementation, or the patch would encode two unreachable invariants, one wrong diagnostic, one undefined token and an unimplementable helper |

---

## B. This milestone's decisions

### R4 — `Comp` for `AMBIG11`

| | |
|---|---|
| Question | Is `Comp(AMBIG11)` task-bank routing, or compliance with the declared tie-break? |
| **Status** | **OPEN.** Analysed; recommendation stated; not resolved |
| Approval | none requested yet — the recommendation is put to the owner |
| Work | analysis complete (`L11_5_R4_DECISION_TABLE.md`) |
| Authority | none |
| Recommendation | **report `Comp_task(A4)` and `Comp_rule(A4)` separately, named**; keep `Comp` on `CROSS21`/`CROSS31`/`ORDERPERM` |
| What it changes | no criterion (none references A4); no arm; no threshold |
| What it does **not** resolve | the tie-break wording (R4b), `Read` conditioning (R4c), the `o` distribution (finding A4-o), and the fact that the rule is absent from every ratified document (amendment item A-3) |

### R4b — tie-break: "lowest group index" vs "lowest bank index"

| | |
|---|---|
| **Status** | **OPEN** |
| Facts | protocol §6 says "groups"; specification §2.1 and the prereg say "bank" **[V]** |
| Numeric effect today | **zero** **[C]** — `AMBIG11` runs only in A4, standard order, `task_bank = [0,1,2]`, so `min(bank) ≡ min(group)` |
| When it bites | any order-permuted `AMBIG11`, different `T`, or different allocation policy |
| Recommendation | pin to **lowest bank index** (matches the prereg and the spec; the protocol is the outlier) |

### R4c — `Read` conditioning for `AMBIG11`

| | |
|---|---|
| **Status** | **OPEN** |
| Facts | v0.2 marks `READ` eligible for A4 **[V]**; `Read` is conditioned on `routing_correct` (task bank), so rule-following trials leave the denominator **[I]** |
| Recommendation | add `Read_rule(A4) = mean(correct \| rule_compliant == 1)` alongside `Read` |

### R5 — L11-C metric

| | |
|---|---|
| Question | which metric does "no cell below 0.50" refer to? |
| **Status** | **OPEN.** Analysed; recommendation stated; not resolved |
| Approval | none |
| Work | analysis complete (`L11_5_R5_METRIC_AND_THRESHOLD.md`) |
| **Authorization classification** | **boundary between category 2 and 3; cannot be assigned conclusively** — category 2 *in content* (a documented definition the freeze declared unchanged), category 3 *in authority* (no criterion was ever authorized, so adopting it is a new owner decision). **Operative classification for process: category 3** |
| Recommendation | `L11-C := MixAcc`, per `(seed, task, arm ∈ {A2, A3})` cell, **threshold 0.50 unchanged** |
| Decisive fact | L11-C's only decision-relevant content is the **A3** clause; on A2 it is implied by L11-A ∧ L11-D (`MixAcc ≥ 0.81`) **[C]** and the criteria are conjunctive |
| Honest caveat | the two readings are **different predicates, not ordered ones** — not a strengthening |
| Threshold justification | **none exists in the record** **[V]**; 0.50 is defensible only as a collapse-detector at the L10-measured floor 0.4259 (`P(pass \| floor) = 0.061`) **[C]**, and is a coin flip at exactly 0.50 (`P(pass \| 0.50) = 0.536`) |
| Blocking | **every** official run |

### R5b — "pooled ≥ 0.75"

| | |
|---|---|
| **Status** | **OPEN — not adopted** |
| Facts | appears only in the superseded readiness proposal **[V]**; no pooling contract is defined anywhere **[V]** |
| Recommendation | decide separately; if adopted, use an unweighted mean of the three per-task values (protocol §6 forbids pooled counts), giving one value per seed per arm |
| Why separate | it is a threshold that was never registered; folding it into a "clarification" is the manoeuvre the safeguards exist to prevent |

### R6 — record the adopted schema hash

| | |
|---|---|
| **Status** | **OPEN** |
| Update from L11.4 | the schema to record is now **v0.2.1** (v0.2 + errata D1–D8), not v0.2 |
| Recommendation | add `schema_sha256_v0_2_1` and retain the v0.1 record untouched |

---

## C. Findings raised by this milestone that need an owner answer

These are **not** new decisions in the sense of "a new proposal"; they are
pre-existing defects discovered while building the arm inventory. They are recorded
so they are not silently resolved by whoever implements first.

### F1 — `MISLEAD` and `SHUFFLED` are the same cue construction (finding A6-A7)

| | |
|---|---|
| Facts | protocol §4: `MISLEAD` = "2 features from `g(o)` only"; `SHUFFLED` = "`TRAIN` pair of another task". A training pair of another task **is** 2 features from `g(o)` **[V]**. The code has one mode (`CM_SHUFFLED`, `:215–222`) |
| Status | **UNRESOLVED** |
| Proposed default | differentiate explicitly: `MISLEAD` = a deterministic wrong group (nearest index), `SHUFFLED` = a uniformly drawn other task (as coded). Alternatively merge them — but that is an experimental-design change needing authorization |
| Blocking | A6/A7 implementation only |

### F2 — the `o` sampling distribution is unspecified (finding A4-o)

| | |
|---|---|
| Facts | protocol §4 fixes only `o ≠ t`; no distribution anywhere **[V]** |
| Status | **UNRESOLVED** |
| Proposed default | adopt the code's existing uniform-over-other-tasks draw and state it in protocol §4 |
| Impact | determines the expected `Comp_task`/`Comp_rule` divergence on A4 **[C]**; irrelevant to A2/A3 |

### F3 — protocol §11 references the removed `intended_bank` field

| | |
|---|---|
| Facts | protocol §11 line 170 checks rule predictions "against the writer's `intended_bank` field"; schema v0.2 **removes** `intended_bank` **[V]** |
| Status | **UNRESOLVED** (documentation defect) |
| Proposed default | amend §11 to reference `rule_bank`, and extend its enumeration to cover the categories the owner wants covered |

---

## D. Status board

| ID | Approval | Work | Authority | Blocks |
|---|---|---|---|---|
| **R1** | **NOT RATIFIED** | drafted (L11-C not evaluable) | none | any official run |
| **R2** | approved in principle | **unapplied** | n/a | L11-F gate |
| **R3** | conditionally approved in principle | **unapplied** | none | instrumentation |
| **R4** | none | analysed | none | protocol unambiguity |
| **R4b** | none | analysed | none | nothing today |
| **R4c** | none | analysed | none | completeness of A4 reporting |
| **R5** | none | analysed | none | **every official run** |
| **R5b** | none | analysed, declined for now | none | nothing today |
| **R6** | none | specified | none | preregistration completeness |
| **F1** | none | identified | none | A6/A7 implementation |
| **F2** | none | identified | none | A4 implementation |
| **F3** | none | identified | none | §11 correctness |

---

## E. What the owner actually has to do

Nothing in this repository can move R4, R4b, R4c, R5, R5b, R6, F1, F2 or F3. Each
needs one sentence from the owner. Everything else — the schema errata, the patch, the
battery, the arms — is downstream of those sentences.

**The single highest-value action is R5**, because it is the only open decision that
blocks *every* official run regardless of what else is resolved.
