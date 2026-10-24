# STARK-L11.5 — R4 Decision Table: `Comp`, `AMBIG11`, and the Two Bank Identities

**Status:** analysis and recommendation only. **Nothing applied, registered, or
ratified.** Documentation-only milestone; no source file was modified.

**Evidence tags** — **[V]** verified directly in the file/source at the cited
location · **[A]** supported by a committed artifact · **[C]** computed in this
milestone by exact arithmetic · **[I]** inferred · **[P]** proposed · **[?]**
unknown or blocked.

Base commit: `effb56aa6cb861934eedbf38df2da054db309d5c` (L11.4), working tree clean.

---

## 1. The three bank identities, as actually defined

| Symbol | Artifact | Exact definition | Where |
|---|---|---|---|
| **B_task** | protocol §6 | the bank that owns the evaluated task `t` | **[V]** `l11_1_protocol.md:101` — `routing = (1/n) Σ 1[first_feature_group(bank) == t]`, glossed "i.e. the selected bank is the bank that owns task `t`" |
| **B_rule** | specification §2.1 | "the bank that owns the group contributing the **most features**"; ties → "the **lowest bank index**" | **[V]** `l11_cross_signature_compositional_generalization.md:63–66` |
| **B_sel** | engine | `CCResult::bank`, the bank actually used | **[V]** `ContextConditionedMemory.h:101`; assigned at `ContextConditionedMemory.cpp:346` |

Derived in schema v0.1 and v0.2 respectively:

| Schema | Field | Formula | Where |
|---|---|---|---|
| v0.1 | `intended_bank` | "bank prescribed by the declared rule" | **[V]** `l11_trial_schema.md:65` |
| v0.1 | `routing_correct` | `selected_bank == intended_bank` | **[V]** `l11_trial_schema.md:67` |
| v0.2 | `task_bank` | bank owning the evaluated task | **[V]** `l11_trial_schema_v0_2.md:98` |
| v0.2 | `rule_bank` | R-majority prediction for the cue | **[V]** `l11_trial_schema_v0_2.md:99` |
| v0.2 | `routing_correct` | `selected_bank == task_bank` | **[V]** invariant 5 |
| v0.2 | `rule_compliant` | `selected_bank == rule_bank` | **[V]** invariant 6 |

**Finding R4-1 [V].** Schema **v0.1 already conflated the two**: its
`routing_correct` is rule-based (`== intended_bank`), while protocol §6's `routing`
is task-based (`first_feature_group(bank) == t`). The v0.1 artifact and the frozen
protocol therefore disagree on what "routing" means, independently of `AMBIG11`.
This is the defect the L11.2 audit labelled S1, and it is real.

---

## 2. The actual rule text: where it is, and where it is claimed to be

**[V]** `grep -i majority stark/design/l11_1_protocol.md` returns exactly three
lines: 18 (§1 purpose, naming R-majority without defining it), 105 (§6, inside the
`Comp` bullet), 169 (§11, an exactness check). **`grep -i tie` returns one line:
106.**

| Section | Contains | Contains the rule? |
|---|---|---|
| protocol §4 "Cue constructions (exact)" (lines 50–79) | a construction table only | **NO** — no "majority", no "tie", no resolution rule |
| protocol §6 (lines 97–119) | `Comp = routing` + "For `AMBIG11` the prescribed bank is the lowest-index of the two groups" | **partially** — a prescription, not a rule statement |
| protocol §11 (lines 163–171) | "R-majority predictions for every distinct `CROSS21`/`CROSS31` cue are enumerated and checked against the writer's `intended_bank` field" | references the rule, does not state it |
| specification §2.1 (lines 62–67) | the full rule + tie-break | **YES**, but it is a `DRAFT_NOT_RATIFIED` companion document |

**Finding R4-2 [V].** Specification §2.1 states: *"The rule is declared in
`stark/design/l11_1_protocol.md` **§4** and frozen with the protocol hash."* **That
is false.** §4 contains no rule. The frozen protocol never states R-majority in
full; the complete statement lives only in an unratified companion draft. The rule
is *named* in the protocol, *referenced* in §11, and *half-stated* in §6.

**Finding R4-3 [V].** Protocol §11's exactness check targets the writer's
`intended_bank` field — a **v0.1 field that schema v0.2 removes**
(`l11_trial_schema_v0_2.md:123`). Adopting v0.2 without an amendment would leave a
frozen §11 check referring to a field that no longer exists. §11 also enumerates
rule predictions **only for `CROSS21`/`CROSS31`**, never for `AMBIG11`.

---

## 3. Does `Comp` mix task accuracy, rule compliance, or both?

| Category | B_task vs B_rule | `Comp` per §6 formula (= B_task) | `Comp` per §6 sentence ("R-majority compliance" = B_rule) | Mixed? |
|---|---|---|---|---|
| `TRAIN`, `HOLDOUT`, `PARTIAL` | identical by construction | same | same | no |
| `CROSS21`, `CROSS31`, `ORDERPERM` | identical by construction (majority group = task group) **[V]** protocol §4 | same | same | **no** |
| `AMBIG11` | **diverge** (1:1 tie) | task routing | tie-break compliance | **YES** |
| `MISLEAD` | diverge (cue is entirely another group) | task routing | compliance with *the wrong bank* | **YES** |
| `SHUFFLED` | diverge | task routing | compliance with *the wrong bank* | **YES** |
| `OFF` | no rule exists | task routing | undefined | n/a |

**Finding R4-4 [V].** `Comp` does **not** mix anything on the three categories the
protocol defines it for — there, task routing and rule compliance are the same
event, exactly. The mixing occurs only where §6 does not define `Comp`: the three
control categories. `AMBIG11` is one of them.

**Finding R4-5 [I].** `MISLEAD` and `SHUFFLED` have the same structural problem as
`AMBIG11`, and the audit named them; `AMBIG11` was missed because the audit assumed
the majority group always equals the task group. This is the origin of R4.

---

## 4. Can `AMBIG11` legitimately contribute to the primary composition metric?

| Test | Result | Evidence |
|---|---|---|
| Does any acceptance criterion reference A4? | **no** | **[V]** `…generalization.md:143–149`; prereg `criteria_candidate` |
| Is A4 designated a composition measure? | **no** — "declared tie-break compliance **only**; carries no accuracy claim" | **[V]** `…generalization.md:80`; arms table line 126 role = "tie-break compliance" |
| Is there a majority to compose? | **no** — 1:1 tie | **[V]** protocol §4 |
| Is A4's cue ratio absent from training? | yes (1:1 is not a training pair structure) — but so is 2:1 | **[V]** |
| Would scoring it against `task_bank` reward rule compliance? | **no — it penalises it** | **[C]** see §5 |

**Verdict [I]: `AMBIG11` cannot legitimately enter the primary composition metric.**
It is a control whose purpose is to test the declared tie-break. Adding it to
`Comp` would (a) contradict the specification's explicit "no accuracy claim", (b)
import a task-order-dependent quantity into a metric that no criterion references,
and (c) make the metric's value depend on the evaluated task's position in the
allocation order.

---

## 5. Numerical implications (computed, not measured)

No `AMBIG11` implementation exists — **[V]** `git grep AMBIG11 -- stark/src/`
returns nothing — so **no `AMBIG11` number has ever been produced**. The following
is arithmetic on the construction, not a result.

**Allocation fact [V]:** `ccAllocateNext` (`ContextConditionedMemory.cpp:163–172`)
returns the lowest unallocated bank and the harness records
`res.task_bank[t] = active` (`l10_validation_harness.cpp:404`). Under the standard
order this yields `task_bank = [0, 1, 2]`, i.e. `bank(group t) = t`.

**Divergence of B_task vs B_rule under the tie-break "lowest bank index", with `o`
uniform over the two other tasks [C]:**

| Evaluated task | `o` | tie-break bank | B_task | differ? | share of that task's A4 trials |
|---|---|---|---|---|---|
| 0 | 1 | 0 | 0 | no | 0/2 = **0 %** |
| 0 | 2 | 0 | 0 | no | |
| 1 | 0 | 0 | 1 | **yes** | 1/2 = **50 %** |
| 1 | 2 | 1 | 1 | no | |
| 2 | 0 | 0 | 2 | **yes** | 2/2 = **100 %** |
| 2 | 1 | 1 | 2 | **yes** | |

**Overall expected divergence = 50 %** ((0 + 0.5 + 1.0)/3) **[C]**.

**Consequences [C]/[I]:**
- The two candidate metrics differ by up to 1.0 on task 2 and by 0 on task 0 — a
  **task-structured** difference, not noise.
- With n = 120 per cell, the standard error at p ≈ 0.5 is ≈ 0.046, so a 0.5-wide
  systematic gap is ~11 standard errors: the two definitions are not merely
  different, they are **decisively** different.
- `AMBIG11` has **no order-permuted counterpart arm**, so unlike `CROSS21` (which
  has A9 and criterion L11-G) there is no control for an allocation-order artefact
  in A4. Any A4 number inherits an uncontrolled task-order dependence.

**Residual uncertainty [I]:** the divergence figures assume `o` uniform over the
two other tasks. Protocol §4 fixes only `o ≠ t`; the sampling distribution is
nowhere stated, and no implementation exists to settle it. With a different `o`
distribution the *expected* divergence changes (the per-trial metric does not).

---

## 6. R4 decision table

### 6.1 The competing definitions

| ID | Definition | Formula | What it measures | Verdict |
|---|---|---|---|---|
| **C-a** | task routing | `mean(1[B_sel == B_task])` | "did the model pick the evaluated task's bank?" | **Rejected** |
| **C-b** | rule compliance, tie-break = lowest **bank** index | `mean(1[B_sel == min(bank(g_t), bank(g_o))])` | "did the model apply the declared tie-break?" | **Recommended (as one of two)** |
| **C-c** | rule compliance, tie-break = lowest **group** index | `mean(1[B_sel == min(g_t, g_o)])` | same, different tie-break | **Recommended (as one of two); equals C-b under the frozen design** |
| **C-d** | report both, named | `Comp_task(A4)` = C-a; `Comp_rule(A4)` = C-b | both questions, separately | **RECOMMENDED** |
| **C-e** | undefined | `NA:NO_DEFINITION` | nothing | Rejected (loses information at no saving) |
| **C-f** | stability under ambiguity | modal-bank consistency over repeated identical cues | "is the response principled?" | **Rejected — unimplementable** |

**Why C-f is impossible [V]:** evaluation routing is `bank = ccPreferredBank(...)`
(`ContextConditionedMemory.cpp:342`) — a candidate-masked argmax with **no RNG**.
Repeating an identical cue on a frozen snapshot returns the identical bank every
time, so any consistency statistic is identically 1.0 for every model.

### 6.2 Ten-dimension evaluation

| Dimension | C-a (task) | C-b/C-c (rule) | C-d (both) |
|---|---|---|---|
| 1. Exact formula | `mean(1[sel==B_task])` | `mean(1[sel==B_rule])` | both, separately |
| 2. Unit of analysis | `(seed, task)` cell, A4 | same | same |
| 3. Num / denom | compliant routings / ROUTE-eligible valid rows | same, RULE-eligible | two independent pairs |
| 4. In / out | all A4 ordinary rows; `INVALID` excluded and counted | same | same |
| 5. Missing / NA | `NA:NO_TASK_BANK` cannot occur in A4 (all banks allocated) | `NA:RULE_UNDEFINED` cannot occur (cue non-empty, two groups) | both |
| 6. Defined for control arms | yes, but A4 then measures the same thing as every other arm | yes — A4 answers a question no other arm answers | yes, both |
| 7. Cross-task/seed comparability | clean | **partly compromised**: unbiased for a rule-follower, but a failure on task 0 and a failure on task 2 are structurally different events | both visible side by side |
| 8. Hidden order / denominator advantage | none | none in the *value*, but the **interpretation** is task-ordered (§5) | the pairing makes the order dependence visible rather than hidden |
| 9. Routing vs retrieval distinction | preserved | preserved | **explicitly** preserved |
| 10. Scientific reading | "does a 1:1 cue still land on the task bank?" — silently repeals the tie-break | "does the model apply the declared tie-break?" | both questions named |

### 6.3 Recommendation

**[P] Adopt C-d.** Report `Comp_task(A4)` and `Comp_rule(A4)` separately and by
name; keep `Comp` confined to `CROSS21 / CROSS31 / ORDERPERM`.

**Grounds, in order of weight:**
1. **Changes no criterion [V]** — no criterion references A4.
2. **Keeps two genuinely different quantities apart [C]** — they differ on 50 % of
   A4 trials, task-structured.
3. **Refuses to repeal the declared tie-break** — C-a alone would score a
   rule-following model as failing on tasks 1 and 2.
4. **Refuses to hide a routing failure** — C-b alone would report a model that
   never routes to the task bank as fully compliant.
5. **Cannot be chosen on a score** — no A4 data exists.

### 6.4 Does C-d *fully* resolve the ambiguity?

**No — [I].** It resolves the **reporting** ambiguity (which number to publish) but
leaves three items open, which is why R4 remains a live decision:

| Item | Status after C-d | Decision |
|---|---|---|
| Tie-break wording: "lowest group index" (§6) vs "lowest bank index" (spec §2.1, prereg) | **open** | **R4b** |
| `Read(A4)` is conditioned on task routing, so rule-following trials leave the denominator | **open** | **R4c** |
| The `o`-sampling distribution is unspecified | **open** | recorded as residual uncertainty; no decision proposed (it is a cue-construction detail that belongs with the arm implementation) |
| Rule is never stated in a ratified document (R4-2) | **open** | amendment item A-3 (consolidate §4.1) |

### 6.5 Does any resolution change the design, the criteria, or prior results?

| Question | Answer | Evidence |
|---|---|---|
| Experiment design? | **No** — no arm added, removed, or re-specified | **[V]** |
| Acceptance criteria? | **No** — no criterion references A4 | **[V]** |
| Interpretation of previously reported results? | **No** — there are **zero** official L11 results, and L10's published routing figures are task-bank figures under a different, already-ratified protocol | **[V]** `work/L10_3_CONTEXT_CONTRIBUTION.md:100` uses bank-based routing; L10's criteria were ratified in the L10 chain and are not reopened |

---

## 7. R4b — tie-break wording

| Aspect | Finding |
|---|---|
| Disagreement [V] | protocol §6 line 106: "lowest-index of the two **groups**"; specification §2.1 line 65: "lowest **bank** index"; prereg `declared_rule.statement`: "ties broken by lowest **bank** index" |
| Numeric effect today [V]/[C] | **zero.** `AMBIG11` exists only in A4, which runs in standard order where `bank(group t) = t`, so `min(bank)` ≡ `min(group)` for every trial |
| When it would matter [I] | the moment an order-permuted `AMBIG11` arm, a different `T`, or a different allocation policy is introduced |
| Recommendation [P] | pin to **lowest bank index** — it is what the prereg (the registration record) and the specification both say, and it is the quantity the driver can compute from state it already holds |
| Decision status | **OPEN** — "zero effect today" is a reason it is cheap, not a reason to skip it |

---

## 8. R4c — `Read` conditioning on A4

| Aspect | Finding |
|---|---|
| v0.2 declares `READ` eligible for `AMBIG11` | **[V]** `l11_trial_schema_v0_2.md:192` |
| L11.3 defines `Read = mean(correct \| routing_correct == 1)` | **[A]** `L11_3_ROUTING_RETRIEVAL_METRICS.md:§2.4` |
| Consequence [I] | on A4, a rule-following model has `routing_correct = 0` whenever the tie-break points elsewhere; those trials leave `Read`'s denominator, so the model's accuracy on exactly the trials the rule governs is never averaged |
| Is it wrong? | No — it answers "given the model nonetheless chose the task bank, did it read correctly?" |
| Is it the intended question? | Not for A4, whose declared role is tie-break compliance |
| Recommendation [P] | add `Read_rule(A4) = mean(correct \| rule_compliant == 1)` **alongside** `Read`; never replace it |
| Decision status | **OPEN** (R4c) |

---

## 9. Documents that must be amended if R4 is ratified

| Document | Section | Required change | Frozen? |
|---|---|---|---|
| `stark/design/l11_1_protocol.md` | §4 | insert new §4.1 stating R-majority and the tie-break (currently absent) | **frozen** — cannot be edited; a v0.2 *new file* is required |
| `stark/design/l11_1_protocol.md` | §6 | `Comp` restricted to 3 categories; add `Comp_task(A4)`, `Comp_rule(A4)`, `Read_rule(A4)`; tie-break wording pinned | **frozen** — same |
| `stark/design/l11_1_protocol.md` | §11 | the exactness check references the removed `intended_bank`; must reference `rule_bank`, and its enumeration currently omits `AMBIG11` | **frozen** — same |
| `stark/design/l11_cross_signature_compositional_generalization.md` | §2.1 | the "declared in protocol §4" cross-reference is wrong | `DRAFT_NOT_RATIFIED` — correctable, but its hash is recorded in the prereg, so any edit must be re-recorded |
| `work/L11_1_PREREGISTRATION.json` | `criteria_candidate`, `companion_documents` | add the v0.2 protocol hash; retain v0.1 | **registration record** — must not be edited in place without a decision |
| `stark/design/l11_trial_schema_v0_2.md` | §3, §5, §6 | errata D1–D8 (see the schema audit matrix) | proposal — not adopted |

**No amendment is applied in this milestone.** The draft is
`work/L11_5_AMENDMENT_DRAFT.md`, marked **UNREGISTERED — PENDING OWNER DECISION**.

---

## 10. Decision status

| Decision | Status |
|---|---|
| **R4** | **Open.** Analysed; recommendation C-d stated; requires owner ratification. Not resolved merely because a recommendation exists. |
| **R4b** | **Open.** Zero numeric effect today; wording must still be pinned. |
| **R4c** | **Open.** New in L11.4, verified here. |

**R4 cannot be closed by further documentation.** The remaining act is a
ratification.
