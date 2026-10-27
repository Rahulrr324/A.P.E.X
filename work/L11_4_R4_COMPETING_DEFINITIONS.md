# STARK-L11.4 — R4: Competing Definitions of `Comp` for `AMBIG11`

**Status of this document:** analysis and recommendation only. Nothing is applied,
registered, or ratified. Documentation-only milestone.

**Evidence labels used throughout**

| Tag | Meaning |
|---|---|
| **[V]** | Directly verified — read in source code or in the committed file at the cited line |
| **[A]** | Supported by a committed artifact — the artifact says it, and the artifact is in Git |
| **[I]** | Inferred — a reasoning step that follows from [V]/[A] but is not itself stated |
| **[P]** | Proposed — this milestone's recommendation, not an existing requirement |
| **[?]** | Unknown or blocked — cannot be established from the repository |

---

## 1. Every place the concept occurs

| # | Location | Exact text | What it computes | Class |
|---|---|---|---|---|
| 1 | `stark/design/l11_1_protocol.md:101` (§6) | ``routing = (1/n) Σ 1[first_feature_group(bank) == t]`` — "i.e. the selected bank is the bank that owns task `t`" | task-bank routing | **[V]** |
| 2 | `stark/design/l11_1_protocol.md:104` (§6) | ``Comp = routing`` on `CROSS21`/`CROSS31`/`ORDERPERM` — "this is the R-majority compliance rate" | task-bank routing, *asserted to equal* rule compliance | **[V]** |
| 3 | `stark/design/l11_1_protocol.md:105–106` (§6) | "For `AMBIG11` the prescribed bank is the **lowest-index** of the two groups (declared tie-break)." | rule bank, for `AMBIG11` only | **[V]** |
| 4 | `stark/design/l11_1_protocol.md:117` (§6) | "No metric is ever computed from a pooled count." | aggregation rule | **[V]** |
| 5 | `stark/design/l11_cross_signature_compositional_generalization.md:63–68` (§2.1) | "R-majority … the bank that owns the group contributing the **most features**. Ties are broken by the **lowest bank index**." | rule, tie-break on **bank** index | **[V]** |
| 6 | `…generalization.md:80` (§3 table) | `AMBIG11` … "declared tie-break compliance only; carries no accuracy claim" | A4's purpose | **[V]** |
| 7 | `…generalization.md:84–86` (§3 prose) | "`MISLEAD` has no 'correct' accuracy reading by construction …" | closest sibling treatment | **[V]** |
| 8 | `…generalization.md:126` (§5 arms) | `A4` ambiguous 1:1 … role "tie-break compliance" | A4's purpose, again | **[V]** |
| 9 | `…generalization.md:145` (§6) | `L11-C` "no cell `(seed, task)` in A2 or A3 below **0.50**" | **metric unnamed** (see R5) | **[V]** |
| 10 | `work/L11_1_PREREGISTRATION.json` `declared_rule` | "ties broken by **lowest bank index**"; `applies_to`: `["CROSS21","CROSS31","AMBIG11 (tie-break clause)"]` | registered rule | **[V]** |
| 11 | `work/L11_2_R3_AUTHORIZATION_AUDIT.md:198` | ``rule_bank   int    R-majority prediction for this cue       (L11 Comp meaning)`` | **Comp is identified with rule compliance** | **[V]** |
| 12 | `work/L11_2_R3_AUTHORIZATION_AUDIT.md:192` | "They coincide for `TRAIN`, `HOLDOUT`, `PARTIAL`, `CROSS21`, `CROSS31` **and `AMBIG11`** (by construction the majority group *is* the intended task's group)" | **factually wrong for `AMBIG11`** — see §2 | **[V]** (text), **[I]** (it is an error) |
| 13 | `stark/design/l11_trial_schema_v0_2.md:192` | eligibility: `AMBIG11` `ACC = –`, `ROUTE = ✓`, `RULE = ✓`, `READ = ✓`, `MAPCHECK = ✓` | no accuracy claim | **[A]** |
| 14 | `work/L11_3_ROUTING_RETRIEVAL_METRICS.md:23,72,106` | `rule_bank` for `AMBIG11` = "lowest-index of the two tied groups — may be the *other* bank"; `Comp` over `COMP_CATEGORIES` incl. `AMBIG11` | proposes rule-based `Comp` | **[A]** |
| 15 | `stark/src/learning/ContextConditionedMemory.cpp:205–215` | `ccPreferredBank` — argmax over **candidate-masked** banks, strict `>`, ties → lowest index | model's actual choice mechanism | **[V]** |
| 16 | `stark/src/learning/l10_validation_harness.cpp:381,404`; `ContextConditionedMemory.cpp:163–172` | `ccAllocateNext` returns the lowest unallocated bank; `res.task_bank[t] = active` | allocation order → bank index | **[V]** |

**Finding 1 [V].** No implementation of `AMBIG11` exists. `git grep AMBIG11` over
`stark/src/` returns **nothing** — the mode is declared in the protocol, the
specification and the schema, but there is no `CM_AMBIG11` in the harness. Every
statement about `AMBIG11` in this document is therefore about a *specified but
unbuilt* condition, and no `AMBIG11` number has ever been produced.

---

## 2. The construction, and why definition 12 above is wrong

**[V]** Protocol §4: `AMBIG11` = "1 feature from `g(t)`, 1 from `g(o)`". That is a
**1:1 tie** — there is no majority group. The audit's claim that "the majority group
*is* the intended task's group" for `AMBIG11` cannot hold: there is no majority.
The tie is resolved by the declared tie-break, and the tie-break points at
`min(bank(g(t)), bank(g(o)))`, which is the **other** task's bank whenever
`bank(g(o)) < bank(g(t))`.

**[V]** Under standard order, `ccAllocateNext` allocates 0, 1, 2 in presentation
order, and `res.task_bank[t] = active` (harness 404), so `task_bank = [0,1,2]`,
i.e. `bank(g(t)) = t`.

**[I]** With `o` drawn uniformly from the two other tasks (protocol §4 says only
`o ≠ t`; no distribution is fixed, so uniformity is assumed), the two candidate
definitions diverge as follows:

| Evaluated task | `o` | tie-break bank | task bank | coincide? | share of that task's `AMBIG11` trials that differ |
|---|---|---|---|---|---|
| 0 | 1 or 2 | 0 | 0 | **yes** | 0 % |
| 1 | 0 | 0 | 1 | no | 50 % |
| 1 | 2 | 1 | 1 | yes | |
| 2 | 0 or 1 | 0 or 1 | 2 | **no** | 100 % |

**Expected divergence ≈ 50 % of `AMBIG11` trials** ((0 + 0.5 + 1.0)/3). The
divergence is **structurally task-dependent**: task 0 can never diverge, task 2
always does. This number is arithmetic on the construction, not a measurement.

**The consequence that decides the framing [I]:** the two readings do not merely
differ in magnitude — they differ *by task*. A metric whose value depends on the
task's position in the allocation order is not comparable across tasks, and
`AMBIG11` has no order-permuted counterpart arm (no "A4-under-A9") with which to
control that dependence. This is the same confound that `L11-G` exists to detect
for `CROSS21` (`Comp(A2) − Comp(A9)`), and `AMBIG11` has no such guard.

---

## 3. What is `Comp` *supposed* to measure in the ambiguous condition?

Four candidate quantities, kept separate as required:

| Quantity | Question it answers | Definition that measures it |
|---|---|---|
| **Q1 task-correct routing** | did the model route to the bank that owns the evaluated task? | `routing_correct` |
| **Q2 composition-rule compliance** | did the model apply the declared R-majority rule, tie-break included? | `rule_compliant` |
| **Q3 retrieval after routing** | having routed, did it read correctly? | `Read` / `MAPCHECK` |
| **Q4 behaviour under genuine ambiguity** | is the model's response to a 1:1 tie *stable, licensed and non-arbitrary*? | **no existing field measures this** |

**[A]** The specification assigns `AMBIG11` to **Q2 only**: "declared tie-break
compliance only; carries no accuracy claim" (§3 table), and A4's role is
"tie-break compliance" (§5 arms table). **[A]** The audit independently calls
`rule_bank` "the L11 Comp meaning". **[V]** The protocol's own §6 sentence 3
assigns a prescribed bank for `AMBIG11` — which is only meaningful if
`Comp(AMBIG11)` is meant to test compliance with it.

**[I]** So the *declared scientific question* for A4 is Q2. But Q2 as specified has
a defect (§2), and Q4 — the question one would naturally ask of an ambiguous input
— is **not measured by the protocol at all**. A single 1:1 trial tells you which
bank was chosen; it does not tell you whether the choice was principled. Repeated
presentation of the same cue would; the protocol does not do that.

**[V/Critical]** An ambiguous input must not be scored as though it had a unique
correct answer. Under **Q1**, `AMBIG11` would be scored against the task's bank —
but the cue does not uniquely determine that bank, so a model that follows the
declared rule can only score `routing_correct = 0` for tasks 1 and 2. That is a
penalty for obeying the rule the protocol declares.

---

## 4. Candidate definitions, evaluated on all ten required dimensions

### C-a — `Comp(AMBIG11) := mean(routing_correct)` (task bank)

| Dimension | Answer |
|---|---|
| 1. Formula | `(1/n) Σ 1[selected_bank == task_bank]` |
| 2. Unit | `(seed, task)` cell, arm A4 |
| 3. Num / denom | correct-task routings / ROUTE-eligible valid rows |
| 4. Included / excluded | all A4 rows; `record_status != OK` excluded; no other arm |
| 5. Missing / invalid / NA | `NA:NO_TASK_BANK` never occurs in A4 (all banks allocated) **[V]**; invalid rows excluded and counted |
| 6. Defined for control arms? | yes, trivially — but it measures the same thing in every arm, so A4 stops being a control |
| 7. Comparable across tasks/seeds? | **yes** — same question for every task; no structural per-task heterogeneity |
| 8. Hidden order / weight / denominator advantage? | **no** — the task's bank is well defined regardless of allocation order |
| 9. Preserves routing/retrieval distinction? | yes |
| 10. Scientific reading | "given a 1:1 cue, does the model still pick the evaluated task's bank?" — i.e. *it drops the tie-break question entirely*; A4 becomes a low-count `CROSS21` |

**Fatal objection [I]:** it penalises compliance. A model that applies the declared
tie-break scores 0 on 2 of 3 tasks. Adopting C-a silently repeals the tie-break
declared in protocol §6 and registered in the prereg.

### C-b — `Comp(AMBIG11) := mean(rule_compliant)` with tie-break = **lowest bank index**

| Dimension | Answer |
|---|---|
| 1. Formula | `(1/n) Σ 1[selected_bank == min(bank(g(t)), bank(g(o)))]` |
| 2. Unit | `(seed, task)` cell, A4 |
| 3. Num / denom | rule-compliant rows / RULE-eligible valid rows |
| 4. In / out | all A4 rows; invalid excluded |
| 5. NA | `NA:RULE_UNDEFINED` does not occur (cue non-empty, both groups present) |
| 6. Defined for control arms? | yes — and it is the only definition that makes A4 answer a question no other arm answers |
| 7. Comparable across tasks/seeds? | **partly** — see below |
| 8. Hidden advantage? | **yes, a hidden *penalty***: the tie-break coincides with the task bank for task 0 (never differs), half the time for task 1, never for task 2. A model that *always* follows the rule scores 1.0 on all tasks — so the metric itself is unbiased — but a model with a *task-2-specific* preference is scored differently from an identical model with a task-0-specific preference |
| 9. Preserves routing/retrieval distinction? | yes — `routing_correct` is still recorded separately |
| 10. Scientific reading | "did the model apply the declared tie-break?" — the declared question |

**Caveat [I]:** unbiased for a rule-following model, but the *diagnostic content* of
a failure is task-dependent, because a failure on task 0 vs task 2 means different
things. Not disqualifying; must be documented.

### C-c — `Comp(AMBIG11) := mean(rule_compliant)` with tie-break = **lowest group (task) index**

Identical to C-b on every dimension, **except**: it is what protocol §6's literal
words say ("lowest-index of the two **groups**"), whereas §2.1 of the
specification and the preregistration both say "lowest **bank** index".

| Dimension | Answer |
|---|---|
| 7. Comparable across tasks/seeds? | **differently** — a group-index tie-break is invariant to allocation order; a bank-index tie-break is not |
| 8. Hidden advantage? | the **group** version has *no* order dependence; the **bank** version inherits one |

**Finding 2 [V] — a second, narrower ambiguity (call it R4b).** Protocol §6 says
"lowest-index of the two **groups**"; spec §2.1 and the preregistration say "lowest
**bank** index". They are different rules in general.

**Finding 3 [V] — R4b has no numeric effect under the frozen design.** `AMBIG11`
exists only in arm A4, which runs in standard order, where `bank(g(t)) = t` for all
`t` **[V, §2]**. Therefore `min(bank)` ≡ `min(group)` in A4. R4b is a *latent*
defect: it matters the moment anyone adds an order-permuted `AMBIG11` arm, changes
`T`, or changes the allocation policy — not before.

**Finding 4 [V] — a dangling cross-reference.** Specification §2.1 says "The rule
is declared in `stark/design/l11_1_protocol.md` **§4** and frozen with the protocol
hash." Protocol §4 is *Cue constructions (exact)* — a table of how each category's
cue is built. It contains **no** R-majority rule and **no** tie-break. The
tie-break text lives in protocol **§6** (metrics). So the specification points at
the wrong section, and there is no single section of the frozen protocol that
states the rule in full. This is the structural cause of R4: the rule is
distributed across a table (§4), a metric definition (§6) and a separate
specification document, and the three do not say the same thing.

### C-d — report **both**, named separately

| Dimension | Answer |
|---|---|
| 1. Formula | `Comp_task(A4) := mean(routing_correct)` and `Comp_rule(A4) := mean(rule_compliant)` |
| 3. Num / denom | as C-a and C-b, reported separately with separate `n` |
| 6. Defined for control arms? | yes — supplies both readings, commits to neither |
| 7–8 | inherits C-a's and C-b's properties separately; neither number is contaminated by the other |
| 9. Preserves the distinction? | **yes, explicitly** — this is the definition that keeps Q1 and Q2 from being confused |
| 10. Scientific reading | both questions are answered and named; the reader can see whether a model that appears to fail Q1 was in fact obeying Q2 |

### C-e — `Comp(AMBIG11)` is **undefined**; report `NA` and describe A4 qualitatively

| Dimension | Answer |
|---|---|
| 1. Formula | none |
| 3. Num / denom | none; `NA:NO_DEFINITION` |
| 6. Control arms | A4 remains a descriptive control only |
| 9 | trivially preserved |
| 10. Scientific reading | loses the tie-break question entirely, but claims nothing it cannot support |

### C-f — measure Q4 (behaviour under genuine ambiguity) directly

Requires repeated presentation of the identical cue with a consistency statistic
(e.g. the fraction of the 20 repeats that resolve to the same bank, or the
entropy of the bank distribution). Per-trial rows already support it *if* the same
cue is presented repeatedly.

| Dimension | Answer |
|---|---|
| 1. Formula | `TieConsistency(A4) := max_b (count of repeats choosing b) / n_repeats`, per cue |
| 3. Num / denom | modal-bank repeats / repeats of that cue |
| 6. Defined for control arms? | yes, and it is defined for `MISLEAD`/`SHUFFLED` too |
| 8. Hidden advantage? | none |
| 10. Scientific reading | "is the response to an ambiguous input stable and rule-licensed?" |

**But [V]:** evaluation routing is **deterministic** — on non-learning trials
`bank = ccPreferredBank(...)` (`ContextConditionedMemory.cpp:342`), a masked argmax
with no RNG. Repeating the same cue therefore yields the **same bank every time**;
`TieConsistency` would be identically 1.0 for every model and measure nothing. C-f
is **not implementable** against this router. It would require a stochastic
evaluation policy, which would be an experimental-design change (class **X**), and
is not proposed.

---

## 5. Recommendation

**R4 recommendation: adopt C-d — report both `Comp_task(A4)` and `Comp_rule(A4)`,
named distinctly — and keep the frozen `Comp` used by L11-A / L11-G restricted to
`CROSS21`, `CROSS31`, `ORDERPERM`.**

Rationale, in order of weight:

1. **It changes no criterion. [V]** No criterion references A4: L11-A and L11-G are
   defined on A2/A9 (`CROSS21`), L11-C on A2/A3 (`CROSS21`/`CROSS31`), L11-B on A2,
   L11-D on A2. A4 is reported only. **(C-d) therefore cannot move any pass/fail.**
2. **Q1 and Q2 are genuinely different quantities [I]**, differing on ≈50 % of
   `AMBIG11` trials with a task-dependent pattern (§2). Collapsing them into one
   number would either penalise rule compliance (C-a) or hide a routing failure
   behind a compliance success (C-b alone).
3. **The protocol already asserts they coincide where the criteria look**
   (§6: "`Comp = routing` … this is the R-majority compliance rate"), which is
   exactly true on the three composition categories **[V]** and exactly false on
   `AMBIG11`. C-d keeps the sentence true where it is true and stops it from being
   applied where it is false.
4. **It is the only option that resolves the ambiguity without choosing a
   scientific position** the owner has not taken, and it is the L11.3
   recommendation, so it adds no new churn.
5. **C-a is rejected on principle**, not on score: it makes the declared rule
   unscoreable.
6. **C-e is rejected as strictly less informative** for the same cost.
7. **C-f is rejected as unimplementable** against a deterministic router.

**Sub-recommendation R4b (latent, no numeric effect):** pin the tie-break as
**lowest bank index** for the implementation, because (i) the preregistration — the
registration record — says "bank", (ii) the specification §2.1 says "bank", and
(iii) it is the quantity the driver can compute from state it already owns. Record
that protocol §6's "groups" wording is the outlier, and that the two coincide under
the frozen design so **no recorded number changes**. Owner confirmation requested;
implementation may proceed under either wording without effect until an
order-permuted `AMBIG11` arm exists.

### Explicitly rejected framing

- **Not choosing on the basis of which definition passes.** No `AMBIG11` data
  exists (the arm is unimplemented, **[V]**), so no definition can be selected on
  its score. The recommendation is derived from the construction arithmetic, the
  declared rule, and the redundancy structure of the criteria.
- **Not claiming `AMBIG11` becomes a capability measure.** Under any of C-a…C-e,
  A4 is a *control*. It carries no accuracy claim **[A]** and its two candidate
  metrics disagree by construction, so it cannot support a capability statement.

---

## 6. What this analysis does **not** establish

- **[?]** The `(t, o)` draw distribution is not fixed in code (no `AMBIG11`
  implementation exists). The "≈50 %" figure assumes uniform `o`; the protocol
  fixes only `o ≠ t`.
- **[?]** No `AMBIG11` number exists, so the size of the divergence is arithmetic,
  not measured.
- **[I]** The claim that a task-2-specific preference is scored differently from a
  task-0-specific one is a property of the metric, not an observation of any model.
- The recommendation is **[P]**, not ratified, and adopts nothing.
