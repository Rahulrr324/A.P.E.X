# STARK-L11.3 — Non-Interference and Regression Test Plan (for a later gate)

**Status:** plan only. **No test in this document has been executed against an
instrumented binary**, because no instrumented binary exists. Every entry is
marked `UNEXECUTED`. The one test that *has* been run — the v0.2 schema
validator's 32 self-tests — is separately identified.

The claim this plan is built to support is deliberately narrow:

> Under the tested conditions, enabling `--emit-l11` does not change APEX's
> behaviour, and the values it records are correct.

It cannot support the wider claim that instrumentation is inert under all
conditions. Checks 1–8 establish behavioural identity along *observable* channels;
they cannot prove that a channel nobody observed is unchanged. This is the audit's
own limitation and it is retained verbatim.

---

## 1. Two instrumented builds, one comparison

```
A_off  = build(base+patch),  --emit-l11 0     # instrumentation compiled in, disabled
A_on   = build(base+patch),  --emit-l11 1     # instrumentation enabled
A_base = build(base),        no flag
```
Three comparisons, each answering a different question:

| Comparison | Question | Metric |
|---|---|---|
| `A_off` vs `A_base` | is the *build* inert? | all 18 artifact files byte-identical |
| `A_on` vs `A_off` | is the *execution* inert? | checks 1–8 identical |
| `A_on` vs `A_on` (rerun) | is the new artifact deterministic? | `trials11_*.csv` byte-identical |

`A_off ≈ A_base ≠ A_on` would prove a build-level defect; `A_off ≠ A_base` would
prove the patch is not opt-in. Both are fatal.

---

## 2. Hazard coverage — every listed hazard, with the test that closes it

### 2.1 Hidden-trial duplication (C1)

**Hazard.** `evalTask` is called by diagnostics that are legitimately separate.
If a future capture is placed below the `if (rows)` guard, or above the line-275
restore, the diagnostics become ordinary rows: 360 phantom trials in a 720-row
run, invisibly improving accuracy.

| ID | Test | Proves | Does **not** prove |
|---|---|---|---|
| T1 | project the new file onto the 17 legacy columns and diff against `trials_*.csv`; require row-for-row equality | each ordinary row corresponds to exactly one ordinary trial | that *diagnostic* trials are absent — T2 does |
| T2 | for every `eval_call`, `rows_for_call == 120`; assert the run total against a per-run table | no extra rows were pushed in any call | that the extra rows would have been *wrong*, only that they are not there |
| T3 | static: `git grep -c push_back` over lines 503–523 → **0**; and `if (rows)` must dominate the capture | the re-derivation block cannot emit rows *today* | that a future edit will not move the capture — that is review, not test |

**Status: UNEXECUTED** (needs code).

### 2.2 The `w0` staleness (C3/E)

**Hazard.** `w0` is refreshed only when `measure || maybe_opp` (line 429). A pair
trial reusing the previous trial's `w0` reports a delta spanning two trials — a
plausible, wrong, systematically inflated update mass.

| ID | Test | Proves | Does **not** prove |
|---|---|---|---|
| T4 | recompute each trial's mass from consecutive boundary dumps; compare against the recorded `update_mass_*` | every recorded mass belongs to its own trial | that the engine update itself is correct |
| T5 | assert `advantage == reward − baseline_before_at_index_0`, with the baseline snapshotted before `runCCTrial` | the baseline is pre-call | that `reward_baseline[0]` is the right baseline to use — a design question the protocol already answered |

**Status: UNEXECUTED.**

### 2.3 Misrouting bank identity (A / C4)

**Hazard.** Using `task_bank` where `rule_bank` belongs makes `rule_compliant ≡
routing_correct`, silently restoring defect S1.

| ID | Test | Proves | Does **not** prove |
|---|---|---|---|
| T8 | on `SHUFFLED`, assert `rule_bank == other task's bank` and `rule_bank != task_bank` on at least one row | the two banks genuinely differ in the data | that the model's behaviour is sensible |
| T9 | assert `routing_correct == (selected_bank == task_bank)` and `rule_compliant == (selected_bank == rule_bank)` over the whole file | the two booleans are independent | that the *aggregation* uses them correctly — see the metric tests |
| T10 | validator + metric layer (`--selftest`, 32/32) | `SHUFFLED` cannot enter `Comp`; `MISLEAD` cannot claim `ACC`/`ROUTE`/`Read` | that real data will not violate the rule — the validator runs on real files too |

**Status: T10 EXECUTED (32/32 PASS); T8, T9 UNEXECUTED.**

### 2.4 Structural-zero `Read` (B / S2)

**Hazard.** `Read` averaging over an empty denominator yields `0` or `NaN`, which
reads as measured failure.

| ID | Test | Proves | Does **not** prove |
|---|---|---|---|
| T11 | on a real file, every `MISLEAD` cell reports `Read = NA:STRUCT_ZERO`, and no cell reports `Read = 0` without at least one routed trial | the metric layer refuses empty denominators | that cell values in routed categories are computed with the intended weighting |

**Status: EXECUTED in the validator's metric layer; UNEXECUTED against real data.**

### 2.5 Retrieval-path reconstruction (C / S3)

| ID | Test | Proves | Does **not** prove |
|---|---|---|---|
| T12 | `queried == presented[intended_slot]` on every row, and `choice == presented[selected_slot]` whenever `selected_slot` is an integer | slot semantics survived the port | that the model "intended" anything |
| T13 | `selected_slot` is `NA:SINGLE_CANDIDATE` iff the trial has one candidate | the `-1` sentinel was not reintroduced | — |

**Status: UNEXECUTED** (validator covers the invariants on synthetic rows only).

### 2.6 Silent-zero statuses (F)

| ID | Test | Proves | Does **not** prove |
|---|---|---|---|
| T14 | no metric cell is emitted as a bare number: every cell carries `{status, n}` | no silent zero survives to a report | that the *decision* to use `NA` was correct in each case |

**Status: EXECUTED at the validator level.**

### 2.7 Routing/retrieval semantics (A–C, metric layer)

| ID | Test | Proves | Does **not** prove |
|---|---|---|---|
| T15 | **golden hand-computed file**: 12 rows spanning all 10 categories, every metric checked by hand against §2 of `L11_3_ROUTING_RETRIEVAL_METRICS.md` | the implementation matches the written definition | that the written definition is the one the owner wants — that is R4/R5 |
| T16 | `Comp(A2) == routing(A2)` on `CROSS21/CROSS31/ORDERPERM` (the equivalence claim) | the clarification changed no criterion value | — |
| T17 | `AMBIG11` `rule_bank` = lowest-index tied group; `TRAIN`/`HOLDOUT` `rule_bank == task_bank` | the rule is the rule, not the task | the tie-break's *scientific* defensibility |

**Status: T16, T17 partially covered by validator and by the provenance table; all UNEXECUTED against real data.**

### 2.8 Non-interference proper (C5/C6)

| ID | Test | Proves | Does **not** prove |
|---|---|---|---|
| T6 | `git diff --stat` over `stark/` shows exactly one file; RNG grep empty | blast radius, no new RNG | runtime identity |
| T7 | checks 1–8 on `A_on` vs `A_off` | behavioural identity along observed channels | unobserved channels |
| T18 | checks 7′, 9–14 (audit §5) | the battery now catches vacuous check 7, degenerate arms, recording bugs, failed defaults, and non-determinism | non-interference outside the tested matrix |
| T19 | non-degenerate arm requirement: routing < 1.0 and accuracy < 1.0 on at least one seed/task | the arm exercises both branches of every conditional | representativeness of that arm |

**Status: UNEXECUTED.** Note that check 9 is what makes the whole battery
non-vacuous: on a saturated arm every comparison is a tautology.

### 2.9 C7

| ID | Test | Proves | Does **not** prove |
|---|---|---|---|
| T20 | code review + instrumented-timing probe: `ccSerialize` appears only at run start and task boundaries | the cost/benefit decision was followed | — |

**Status: UNEXECUTED.** The underlying overhead measurement (~1.2–1.5 ms per
serialize, ~9× a trial) is prior L11.2 evidence, not re-measured here.

---

## 3. Regression battery — what must be rerun

Everything that already exists must still pass, unmodified:

| Suite | Artifact | Rerun trigger |
|---|---|---|
| L10.1 determinism | 18-file byte-identical double run | any harness edit |
| L10.2 observer non-perturbation | probe artifact | any harness edit |
| L10.3 reconstruction | `reconstruction_fresh_evalkind0.json` (720 rows) | any capture edit |
| L10.4 one-trial anomaly | recorded anomaly | untouched by this plan |
| L10.5 overhead | timing table | any serialize/mass-copy edit |
| L10.6 checkpoint | round-trip | any state-format edit |
| L11.2 R7 non-degenerate | 6/6 | any arm edit |
| Schema v0.1 coverage | 13/35 | any schema edit (v0.2 supersedes the *file*, not the coverage report) |

**Rule:** no test may be modified to accommodate the patch. If a regression test
needs editing, the patch is wrong. This mirrors the audit's stance and is the only
defence against "fix the test until it passes".

---

## 4. Failure response

| Observation | Interpretation | Action |
|---|---|---|
| `A_off ≠ A_base` | the patch is not opt-in | revert; the patch is rejected |
| any of checks 1–6 differs | instrumentation perturbs behaviour | revert; do not investigate the metric layer until fixed |
| legacy hash differs | C1 violated | revert |
| row count ≠ 120 per call | duplication | revert |
| recorded mass ≠ recomputed | recording bug | fix capture, not the test |
| `trials11_*.csv` differs across identical runs | non-determinism | revert |
| a metric cell is `0` with `n = 0` | silent zero | fix the metric layer |

**No exit criterion is satisfied by relaxing a check.** The only permissible
outcome of a failure is a rejected patch.

---

## 5. What this plan deliberately does not include

- No test that modifies model dynamics to make a comparison pass.
- No test that treats an unexecuted check as passed.
- No test of the learning mechanism itself — L11's mechanism does not exist.
- No threshold, and no criterion, is altered anywhere in this document.
