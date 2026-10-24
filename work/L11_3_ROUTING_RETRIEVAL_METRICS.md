# STARK-L11.3 — Routing and Retrieval Metric Definitions (schema v0.2)

**Status:** proposed clarification. **No threshold changes. No criterion values
change.** Two pre-existing protocol ambiguities are escalated, not resolved (§5).
No official L11 evaluation has been run: zero arms, zero trials.

---

## 1. The three banks, and why they must be separate

| Symbol | Field | Ground truth it encodes | Who knows it |
|---|---|---|---|
| **B_task** | `task_bank` | the bank that owns the mapping being evaluated | the task driver |
| **B_rule** | `rule_bank` | the bank the declared R-majority rule prescribes **for this cue** | the task driver (rule only) |
| **B_sel** | `selected_bank` | the bank the model actually used | the model |

`B_task` and `B_rule` are **independent**: they coincide on every category a
criterion references, and diverge on the two control categories.

| Category | B_task | B_rule | Coincide? |
|---|---|---|---|
| `TRAIN`, `HOLDOUT`, `PARTIAL`, `CROSS21`, `CROSS31`, `ORDERPERM` | task's bank | majority group's bank = task's bank | **yes** |
| `AMBIG11` | task's bank | lowest-index of the two tied groups — may be the *other* bank | **no** |
| `MISLEAD` | task's bank | the wrong group's bank | **no** |
| `SHUFFLED` | task's bank | the other task's bank (the rule **is** defined) | **no** |
| `OFF` | task's bank | none — an empty cue prescribes nothing | n/a |

Two derived booleans:

```
routing_correct = 1[ B_sel == B_task ]      # "did the model use the right bank"
rule_compliant  = 1[ B_sel == B_rule ]      # "did the model do what the rule says"
```

They are **not** interchangeable. Under `SHUFFLED` a model that swallows the
misleading cue scores `rule_compliant = 1` and `routing_correct = 0`. Under v0.1
that same model would have been recorded as "routing correct", because the only
bank field available was the rule's. That is defect S1 and it is closed by the
split.

---

## 2. Metric definitions

Notation: a **cell** is `(seed, task, cue_category)`. `n` is the number of rows in
the cell with `record_status == OK` **and** the relevant metric in
`metric_eligibility`. Every cell reports `{status, value, n}` — never a bare
number.

### 2.1 Accuracy (`ACC`)

```
MixAcc(cell) = observed mean of `correct` over ACC-eligible rows
correct      = 1[ choice == perm_task[queried] ]
```
For `MISLEAD`, `ACC` is not in the eligibility set: the answer is wrong by
construction because the bank holding the task's mapping was never addressed.
Recording `0` there would report an observed failure that was never observed.
Status: `NA:NO_DENOM`.

### 2.2 Routing (`ROUTE`)

```
routing(cell) = observed mean of `routing_correct` over ROUTE-eligible rows
```
`MISLEAD` is ROUTE-ineligible for the same structural reason.

### 2.3 Composition compliance (`Comp`, metric `RULE`)

```
Comp(cell) = observed mean of `rule_compliant` over RULE-eligible rows,
             restricted to COMP_CATEGORIES = {CROSS21, CROSS31, ORDERPERM, AMBIG11}
```
`SHUFFLED` computes `rule_compliant` but is **barred from `Comp`**: there,
"compliant" means "was successfully misled". `OFF` has no rule at all.
`MISLEAD` *is* RULE-eligible — following the cue is the whole point of that
control — but it is not a `COMP_CATEGORY`, so it never enters `Comp`.

**Equivalence that protects the criteria:** for `CROSS21`, `CROSS31` and
`ORDERPERM`, `B_rule == B_task`, hence `rule_compliant == routing_correct`
row-for-row, hence `Comp` under this definition **equals** the protocol's
`Comp = routing`. No criterion number moves.

### 2.4 Retrieval (`Read`)

```
Read(cell) = mean(correct | routing_correct == 1) over READ-eligible rows
```

Status rules — this is the S2 repair:

| Situation | Status | Value |
|---|---|---|
| denominator ≥ 1 | `OBSERVED` | the mean |
| `READ` not in the category's eligibility set | `NA:STRUCT_ZERO` | none |
| eligible, but no row had `routing_correct == 1` | `NA:NO_DENOM` | none |
| `routing_correct` itself is `NA` for every row | `NA:NOT_ROUTED` | none |

`Read` is **never** recorded as `0` unless at least one routed trial was observed
and answered wrongly. An empty denominator is a fact about the experiment, not a
performance result.

| Category | `Read` |
|---|---|
| `TRAIN`, `HOLDOUT`, `PARTIAL`, `CROSS21`, `CROSS31`, `ORDERPERM` | defined |
| `AMBIG11` | defined (tie-break compliance → retrieval from the prescribed bank) |
| `SHUFFLED` | defined when the model resisted the misleading cue; otherwise `NA:NO_DENOM` |
| `OFF` | defined (retrieval from whichever bank the fallback chose) |
| `MISLEAD` | **`NA:STRUCT_ZERO`** |

### 2.5 The MISLEAD replacement: `MAPCHECK`

```
MAPCHECK(cell) = mean(choice_matches_resolved_bank_map)
choice_matches_resolved_bank_map = 1[ choice == perm_of(selected_bank)[queried] ]
```
This answers the question `Read` cannot: *does the bank the model chose still
retrieve its own mapping?* A model that follows a misleading cue and then reads
its chose bank correctly scores `MAPCHECK = 1`, `rule_compliant = 1`,
`routing_correct = 0`, `correct = 0` — four facts that v0.1 could not express.

### 2.6 Null (`Null`) — the measured baseline for L11-B

```
Null(t) = (1/K) Σ_k  observed mean of `correct` over rows with
                     call_purpose == forced_bank AND forced_bank == k
```
Requires `forced_bank` (new in v0.2, gap G1). If a forced cell is absent, that
term is `NA` and `Null(t)` becomes `NA:NO_DENOM` — a missing cell is never
imputed.

### 2.7 Derived, reported, not criteria

```
CompInflation = Comp(A2) − Comp(A9)
WrongBankAcc  = mean(correct | routing_correct == 0)   (NA:NO_DENOM if no such row)
ShufAcc       = ACC on SHUFFLED
```

---

## 3. Aggregation rules

1. **Per-cell first.** Every metric is computed per `(seed, task, category)`.
2. **No pooled counts.** A pooled value is the unweighted mean over the three
   tasks' per-cell values — never `total_correct / total_trials`. (L10's 0.5611 is
   exactly the pooled number this rule exists to prevent being quoted alone.)
3. **`NA` propagates.** A cell whose value is `NA` is excluded from any mean, and
   the number of excluded cells is printed beside the mean. `NA` is never 0.
4. **Invalid rows are counted, not hidden.** `n_invalid` is reported per cell; a
   cell with any invalid row is flagged.
5. **Intervals mandatory.** Every reported proportion carries a Wilson 95 %
   interval (L11-A at n = 120 is only discriminating against 0.85; see spec §6).

---

## 4. Effect on the acceptance checks

| Criterion | Metric | v0.1 behaviour | v0.2 behaviour | Numeric change |
|---|---|---|---|---|
| **L11-A** | `Comp(A2,t)` | task-bank routing on CROSS21 | `rule_compliant` on CROSS21 ≡ task-bank routing | **none** (identical rows) |
| **L11-B** | `MixAcc(A2,t) − Null(t)` | `Null` only from the `ctxperbank` aggregate | `Null` reconstructed from `forced_bank` rows, identical construction | **none** |
| **L11-C** | "no cell below 0.50" in A2/A3 | **ambiguous metric — see §5** | unchanged, still ambiguous | none |
| **L11-D** | `Read(A2,t)` | could silently be 0 | `OBSERVED`; `NA` propagates and fails the check loudly | **none** for A2 |
| **L11-E** | determinism | n/a | unchanged | none |
| **L11-F** | regression | n/a | unchanged | none |
| **L11-G** | `Comp(A2) − Comp(A9)` | routing-based | rule-based, identical on both arms | **none** |

Only categories **not referenced by any criterion** (`AMBIG11`, `MISLEAD`,
`SHUFFLED`, `OFF` as a routing case) change their recorded semantics. That is the
whole point: the criteria were never wrong about the composition arm; the schema
was wrong about the controls that are supposed to prove the arm means something.

---

## 5. Pre-existing protocol ambiguities — escalated, not resolved

These were found while implementing the above and are **not** fixed by this
document. They are raised for the owner in
`work/L11_3_OWNER_DECISION_PROPOSED.md` (R4 and R5) and recorded in
`work/L11_3_PROTOCOL_IMPACT_ASSESSMENT.md` §4.

### A1 — `Comp` is defined twice for `AMBIG11`

Protocol §6 says `Comp = routing` (task bank) and then immediately says *"For
`AMBIG11` the prescribed bank is the lowest-index of the two groups"* (rule bank).
For `AMBIG11` those are different banks whenever the task is not lowest-index. No
criterion references A4, so **no criterion is affected**; the text is still
internally inconsistent and must be clarified before an official run reports an
`AMBIG11` number.

### A2 — `L11-C` does not say which metric

`L11-C`: *"no cell `(seed, task)` in A2 or A3 below 0.50"*. Below 0.50 **on
`Comp` or on `MixAcc`?** The two can differ sharply (a model can follow the rule
and still mis-retrieve). As written, a run could satisfy L11-C under one reading
and fail it under the other.

**Disposition: L11-C is marked `BLOCKED — owner clarification required before any
official run`.** This is a reporting of an existing defect in a preregistered
criterion; this milestone neither changes it nor picks a reading.

---

## 6. What these definitions still cannot establish

- They do not make a criterion more likely to pass or fail: every arm referenced
  by a criterion has identical numbers under v0.1 and v0.2.
- They do not measure within-bank context modulation (no such mechanism exists).
- They do not resolve the L10.4 one-trial anomaly.
- They do not constitute an L11 result. **Zero official arms and zero official
  trials have been run.**
