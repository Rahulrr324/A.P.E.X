# STARK-L11.6 — R4 / R4b / R4c: `AMBIG11` Semantics and Proposed Definitions

**Status: UNRESOLVED. Three separate decisions.** Nothing here is authorized.
Tags: **[V]** verified · **[C]** computed · **[I]** inferred · **[P]** proposed · **[?]** unknown.

---

## 1. The three bank identities, re-verified from source and text

| Symbol | Definition | Evidence |
|---|---|---|
| **B_task** | the bank that owns the evaluated task | **[V]** protocol §6:101 `routing = 1[first_feature_group(bank) == t]`, glossed "the selected bank is the bank that owns task `t`"; realized as `res.task_bank[t] = active` (`harness:404`) |
| **B_rule** | the bank prescribed by R-majority (or by the tie-break when tied) | **[V]** specification §2.1:63–65 |
| **B_sel** | the bank actually used | **[V]** `CCResult::bank` (`ContextConditionedMemory.h:101`), assigned at `:346` |

**Two independent defects about the rule's provenance [V]:**

1. **The rule is not in the protocol.** `grep -i majority` over
   `l11_1_protocol.md` hits lines 18, 105, 169 only; `grep -i tie` hits line 106 only.
   **§4 contains neither**, so the specification's claim that the rule "is declared in
   `l11_1_protocol.md` §4" is false.
2. **Protocol §11 checks a field that no longer exists.** `:170` verifies rule
   predictions "against the writer's `intended_bank` field", which schema v0.2 removes
   (`l11_trial_schema_v0_2.md:123`).

---

## 2. The three proposed definitions

All are **[P]**. None is an acceptance criterion.

### 2.1 `Comp_task(A4)` — task-bank routing on the ambiguous arm

```
Comp_task(A4) = (1/n) Σ 1[ B_sel == B_task ]
```
| Property | Value |
|---|---|
| unit | cell `(seed, task)`, arm A4 |
| numerator | rows where the selected bank is the evaluated task's bank |
| denominator | rows with `record_status == OK`, `ROUTE` eligible (schema v0.2: `AMBIG11` is ROUTE-eligible) |
| expected `n` | 120 |
| missing | `NA:NO_TASK_BANK` cannot arise in A4 (all three banks are allocated by then) |
| status | **reported, non-criterion** |
| interpretation | "given a 1:1 cue, does the model still land on the evaluated task's bank?" — the `CROSS21` question asked of a cue that cannot answer it |

### 2.2 `Comp_rule(A4)` — compliance with the declared tie-break

```
Comp_rule(A4) = (1/n) Σ 1[ B_sel == B_rule ]
B_rule = min over the two tied groups' banks  (R4b: lowest bank index)
```
| Property | Value |
|---|---|
| unit | cell `(seed, task)`, arm A4 |
| numerator | rows where the selected bank is the prescribed bank |
| denominator | rows with `record_status == OK`, `RULE` eligible |
| expected `n` | 120 |
| missing | `NA:RULE_UNDEFINED` cannot arise (cue is non-empty, two groups present) |
| status | **reported, non-criterion** |
| interpretation | "did the model apply the declared tie-break?" — A4's charter |

### 2.3 `Read_rule(A4)` — retrieval given rule compliance (**diagnostic**)

```
Read_rule(A4) = mean( correct | rule_compliant == 1 )
correct       = 1[ choice == perm_task[queried] ]
```
| Property | Value |
|---|---|
| unit | cell `(seed, task)`, arm A4 |
| numerator | correct rows among rule-compliant rows |
| denominator | rows with `rule_compliant == 1`, `record_status == OK` |
| missing | `NA:NO_DENOM` if no row was rule-compliant; `NA:NOT_ROUTED`-class otherwise |
| **status** | **diagnostic — not an acceptance criterion, not a substitute for `Read` (R4c)** |
| interpretation | "having obeyed the tie-break, did it read its resolved bank correctly?" |

**Why it is needed [C]:** `Read` conditions on `routing_correct` (task bank). On A4 the
tie-break differs from the task bank on 0 % / 50 % / 100 % of trials (tasks 0/1/2), so a
rule-following model is **excluded from `Read`'s denominator on exactly the trials A4
exists to probe**.

---

## 3. Should A4 enter the primary composition metric?

**No.** Four independent reasons:

| # | Reason | Evidence |
|---|---|---|
| 1 | **No majority exists to compose.** `AMBIG11` is 1 from `g(t)` + 1 from `g(o)`; R-majority is undefined without a tie-break, so the cue does not test composition, it tests the tie-break | **[V]** protocol §4 |
| 2 | **The design says so explicitly.** "declared tie-break compliance only; carries no accuracy claim" | **[V]** spec §3:80 |
| 3 | **No criterion references it.** L11-A → A2; B → A2; C → A2/A3; D → A2; G → A2/A9 | **[V]** `:143–149` |
| 4 | **It would import an uncontrolled task-order dependence.** The two readings diverge 0/50/100 % by task under a standard allocation, and A4 has **no order-permuted counterpart** (unlike A2, which has A9 and L11-G) | **[C]** |

Including A4 in `Comp` would therefore weaken the primary metric by mixing in a
quantity whose expected value depends on the evaluated task's position.

---

## 4. The numerical divergence (computed, never measured)

**No `AMBIG11` implementation exists** (`git grep AMBIG11 stark/src/` → nothing), so
these are arithmetic on the construction, not observations.

Standard allocation gives `task_bank = [0,1,2]` **[V]** (`ccAllocateNext` returns the
lowest unallocated bank, `harness:404`).

| Evaluated task | `o` | `B_rule` = min bank | `B_task` | differ? |
|---|---|---|---|---|
| 0 | 1 | 0 | 0 | no |
| 0 | 2 | 0 | 0 | no |
| 1 | 0 | 0 | 1 | **yes** |
| 1 | 2 | 1 | 1 | no |
| 2 | 0 | 0 | 2 | **yes** |
| 2 | 1 | 1 | 2 | **yes** |

**Divergence: 0 % / 50 % / 100 % → 50 % overall** **[C]**. At n = 120 the standard
error at p ≈ 0.5 is ≈ 0.046, so a 0.5 gap is ≈ 11 SE **[C]**. **The two metrics are
decisively different, and the difference is task-structured.**

**Residual uncertainty [?]:** the `o` distribution is unspecified (F2), so the
*average over trials* depends on it; the per-trial definitions do not.

---

## 5. R4b — the tie-break, explicitly

**The convention must be stated, not implied.**

| Element | Proposed definition **[P]** |
|---|---|
| **Inputs** | (i) the cue's feature set; (ii) the feature→group arithmetic `group(f) = f / 4`; (iii) the **read-only** group→bank map (the driver's `task_bank` array) |
| **Rule** | count features per group; if one group has strictly more, `B_rule = bank(that group)`; on a tie, `B_rule = min(bank(g) for g in tied groups)` |
| **Output** | `int` bank index, or undefined when the cue is empty |
| **Prohibited input** | the index of the task being evaluated — a rule that can see which task is under evaluation cannot be tested for independence from it. *The allocation map is not prohibited*: a group index is not a bank index, so the map is required to name any bank at all |
| **Standard: protocol §6 says "lowest-index of the two groups"; specification §2.1 and the preregistration say "lowest bank index"** | **[V]** |

**Effect on reported metrics:**

| Allocation | `min(bank)` vs `bank(min group)` | Effect |
|---|---|---|
| standard `[0,1,2]` (today) | **identical** | **zero numeric effect** **[C]** |
| permuted `[2,1,0]` | differ for any tie spanning groups 0 and 1 (e.g. `{0,1}` → banks `{2,1}`: min bank = 1 = group 1; min group = 0 = bank 2) | changes `B_rule`, hence `Comp_rule` and `Read_rule`'s denominator |
| any non-monotone map | differ | same |

**So R4b changes `Comp_rule(A4)` and `Read_rule(A4)` — and nothing else — and only
after an order-permuted A4 arm exists.**

---

## 6. R4c — status of `Read_rule(A4)`

**Proposed: diagnostic.** Not acceptance-relevant.

| Option | Consequence |
|---|---|
| (a) descriptive only | reported without status; risks being quoted as a result |
| **(b) diagnostic** | reported, explicitly excluded from every criterion — **recommended** |
| (c) acceptance-relevant | would be a **new** criterion; no evidence supports any threshold for it |
| (d) omit | loses the only measurement of retrieval on the trials the tie-break governs |

---

## 7. What remains unresolved after R4/R4b/R4c are answered

| Item | Status |
|---|---|
| `o` distribution (**F2**) | open — determines the *expected* divergence |
| `MISLEAD` vs `SHUFFLED` (**F1**) | open — the same construction defect, different arms |
| whether A4 should exist at all | **not questioned**: it is in the frozen arm list and no criterion depends on it, so removing it would be a design change |
| whether `AMBIG11` measures anything about *capability* | **no** — it is a control under every interpretation |

---

## 8. One-sentence summary for the owner

> `AMBIG11` is a 1:1 tie, so it cannot test composition; it can only test the
> tie-break, and the two candidate readings disagree on half its trials in a
> task-dependent way. The recommendation is to publish both, named, as non-criteria,
> and to state the tie-break as the lowest **bank** index.
