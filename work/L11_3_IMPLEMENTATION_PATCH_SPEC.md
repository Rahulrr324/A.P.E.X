# STARK-L11.3 — Implementation Patch Specification (`--emit-l11`), **UNAPPLIED**

**This document specifies a patch. No patch has been applied. No source file in
this repository has been modified by this milestone.**

- Target: `stark/src/learning/l10_validation_harness.cpp` (`697b5f8a…`, 854 lines) — **exactly one file** (C5).
- Gate: requires owner authorization (**R1**, **R6**) plus the C1–C7 tests first.
- Line numbers refer to the audited commit `deac50f`; they are anchors, not
  offsets to apply blindly.

---

## 1. Control flow as it exists today (the facts the patch is built on)

| Fact | Anchor | Consequence |
|---|---|---|
| `evalTask(...)` takes `std::vector<TrialRow>* rows` and appends inside `if (rows)` | 170–182, 263–273 | capture point is already correctly placed (C2) |
| the capture block ends **before** `if (read_only) ccDeserialize(ag, snap);` | 273 → 274 | a row is built from the pre-restore `CCResult` (C2) |
| `next_call` returns `-1` and records nothing when `!dump_rows` | 322–326 | `call_id` is dense `0..N-1` or absent |
| **eight** call sites pass `dump_rows ? &res.rows : nullptr` (`grep -c` = 8) | 500, 531, 544, 549, 553, 564, 568, 574 | ordinary **and** diagnostic rows share one vector |
| `per_bank_ctxoff` passes `nullptr` unconditionally | 592 | its trials never enter `res.rows` |
| the save/load probes pass `nullptr` and omit `call_id` | 606, 609 | they cannot contribute rows |
| `runCCTrial` call sites: 243 (inside `evalTask`), 364 (`force_initial_bank` probe), 441 (training), 516 (routing re-derivation) | — | 441 must snapshot `w0`; 243/516 must not (learning off) |
| re-derivation block 503–523 contains **zero** `push_back` | 503–523 | it cannot emit rows today |
| `w0 = ccBankWeights(ag)` under `measure \|\| maybe_opp` | 429 | stale for trials where both are false |
| `writeTrialCsv` (17 columns) and `writeTaskCsv` | 662, 624 | **must not be edited** (C1) |

### The hidden-duplication finding, from the control flow

Six of the eight `rows`-passing call sites are **diagnostics**:

| `call_purpose` (from `next_call`) | Ordinary? | Call site | Rows per task |
|---|---|---|---|
| `acquisition` | **yes** | 500 | 120 |
| `retention@step<k>` | **yes** | 531 | 120 |
| `holdout` | diagnostic | 544 | 120 |
| `context_off` | diagnostic | 549 | 120 |
| `shuffled` | diagnostic | 553 | 120 |
| `partial_cue` | diagnostic | 564 | 120 |
| `context_off_uniform` | diagnostic | 568 | 120 |
| `cross_novel` | diagnostic | 574 | 120 |
| `per_bank_off` | diagnostic | 592 | — (nullptr) |

A metric computed over `res.rows` without separating these **inflates the
denominator by up to 7×** and, worse, mixes an `OFF` row's accuracy into
`TRAIN`'s. This is why v0.2 introduces `record_class` and why the patch must write
it from the `call_id`, not from the writer's opinion.

---

## 2. Patch outline (illustrative, not applied)

### 2.1 Option parsing (C5: no new RNG, no engine file)

```
--emit-l11 <0|1>            default 0        (default-off, check 11)
--protocol-sha <64 hex>     required when --emit-l11 1; fail closed otherwise (check 12)
--run-id <string>           required when --emit-l11 1
--l11-schema-sha <64 hex>   required when --emit-l11 1
```
Validation happens **before** any agent is constructed, so a malformed invocation
cannot produce a partial artifact.

### 2.2 `TrialRow` extension (additive)

Existing fields untouched; new fields appended. `writeTrialCsv` is not edited, so
its 17 columns are unaffected.

```c++
struct L11Row {                 // new struct, not a TrialRow
    // identity
    std::string record_class;   // ORDINARY | DIAGNOSTIC
    int task, phase, trial, eval_call, eval_kind, call_purpose_id;
    // cue
    std::vector<int> cue_features;
    int cue_id, cue_category, cue_modified, held_out;
    // banks
    int task_bank, rule_bank, forced_bank, selected_bank;
    int routing_correct, rule_compliant;
    double bank_score_margin;
    // retrieval path
    std::vector<int> presented;
    int intended_slot, selected_slot /*INT_MIN = single-candidate*/, queried, choice, correct;
    int choice_matches_resolved_bank_map;
    // state + plasticity
    int active_bank, bank_state, plastic_write;
    double um_intended, um_other_in_bank, um_other_banks;
    double reward, advantage, router_l1;
};
```

`INT_MIN` is **internal only**; the writer emits `NA:SINGLE_CANDIDATE`. The
`-1` sentinel is never written to a v0.2 artifact.

### 2.3 Capture inside `evalTask` (C2 — the only permitted capture point)

Insert between the existing capture block (ends 273) and the restore (274), inside
the same `if (rows)` region, guarded additionally by `l11_enabled`:

```
at 263:  if (rows) {  ...existing TrialRow push (UNCHANGED)...  }
at 264:  if (rows && l11_enabled) {
             L11Row w;
             w.record_class = is_ordinary_purpose(call_id) ? "ORDINARY" : "DIAGNOSTIC";
             w.call_purpose_id = call_id;
             w.task_bank   = task_bank;                        // argument, not r.bank
             w.rule_bank   = intendedBankByRule(cue);          // P7: cue only
             w.forced_bank = force_eval_bank;                  // NA when < 0
             w.selected_bank = r.bank;
             w.routing_correct = (task_bank >= 0) ? (r.bank == task_bank) : NA;
             w.rule_compliant  = (w.rule_bank >= 0) ? (r.bank == w.rule_bank) : NA;
             w.presented = sched_presented;                    // from the schedule
             w.intended_slot = map.phi[s.ctx];
             w.selected_slot = r.sel_slot;                     // INT_MIN if r says -1
             w.queried = r.queried; w.choice = r.choice; w.correct = ok;
             w.choice_matches_resolved_bank_map = ...;         // NA if no perm for r.bank
             w.bank_score_margin = top1_minus_top2(ccRouterWeights(ag), cue);
             w.reward = r.reward; w.plastic_write = r.plastic_write ? 1 : 0;
             l11_rows.push_back(w);
         }
```

**Absolutely not permitted:** any capture at call sites 500/531/544/549/553/564/
568/574, or inside the re-derivation block (503–523), or after line 274.

### 2.4 Training-side capture (C3/E) at `runCCTrial` — line 441 only

```
at 428:  replace  if (measure || maybe_opp) w0 = ccBankWeights(ag);
         with     if (l11_enabled || measure || maybe_opp) w0 = ccBankWeights(ag);
at 428b: if (l11_enabled) baseline_before = reward_baseline[0];
at 441:  r = runCCTrial(...)
at 442:  if (l11_enabled) { w1 = ccBankWeights(ag);
                           record per-trial mass vs w0, advantage = r.reward - baseline_before; }
```
`w0` is refreshed **unconditionally** when L11 emission is on (E). This does *not*
change any value when the flag is off — `l11_enabled == false` reproduces the
current expression exactly. That is the whole non-interference argument for E, and
it is why T4 compares `A_on` masses against recomputation, not against `A_off`.

### 2.5 New writer (C1)

```
void writeL11Csv(const std::string& path, const L11Context& cx, const std::vector<L11Row>& rows);
```
- New function; `writeTrialCsv` and `writeTaskCsv` are **not touched**.
- Header: the 47 column names from schema v0.2 §3, in order.
- Writes `trials11_<tag>_<master>.csv`; **no file is created when `--emit-l11 0`**.
- Runs the validator's missingness rules in-process before returning; on violation
  the row is written with `record_status = INVALID` and the process exit code
  becomes non-zero at the end of the run (**fail loudly, never silently**).

### 2.6 P7 — the rule function (C4)

```
int intendedBankByRule(const std::vector<int>& cue);   // cue only — no task, no map
```
Returns the bank owning the majority of the cue's features; ties → lowest index;
empty cue → `-1` (`NA:RULE_UNDEFINED`). **The task index is deliberately not in the
signature**: that is what makes `rule_bank` independent of `task_bank` and what
prevents S1 from returning. `git grep` assertion V4 enforces it.

---

## 3. Invariants the patch must satisfy (from schema v0.2 §6, 20+ rules)

Non-exhaustive, the ones most likely to be violated by a naive implementation:

1. `selected_slot` is `NA:SINGLE_CANDIDATE` **iff** the trial has one candidate.
2. `queried == presented[intended_slot]` whenever `presented` is non-empty.
3. `routing_correct == 1[selected_bank == task_bank]`, never the reverse.
4. `NA` on `task_bank` ⟺ `NA` on `routing_correct`; same for rule.
5. `update_mass_*` are `NA` on every `record_class == DIAGNOSTIC` row and every
   evaluation row (learning is off there — a mass would be a fake zero).
6. `record_class == DIAGNOSTIC` ⇒ the row may not carry an accuracy claim in the
   eligibility set (validator test).
7. `forced_bank` numeric ⇒ `call_purpose ∈ {null_k, per_bank_off}`.
8. No field ever contains the literal `-1` as an absence marker.

---

## 4. Patch size estimate and blast radius

| Region | Added lines (est.) | Modified lines |
|---|---|---|
| option parsing + validation | ~45 | 0 |
| `L11Row` + `L11Context` | ~55 | 0 |
| `intendedBankByRule` (P7) | ~25 | 0 |
| capture in `evalTask` | ~35 | 0 |
| training capture at 428/442 | ~20 | **1** (`if (measure \|\| maybe_opp)` → `if (l11_enabled \|\| …)`) |
| `writeL11Csv` + helpers | ~85 | 0 |
| wiring in `main` | ~15 | 0 |

**One modified line in the entire file**, and its modified form is provably
equivalent when the flag is off. This is the strongest available support for C5,
and it is still only an estimate until the patch is written.

---

## 5. What this patch does **not** do

- It does not implement any learning mechanism.
- It does not implement the six new cue modes (`CROSS21`, `CROSS31`, `AMBIG11`,
  `MISLEAD`, `ORDERPERM`, and the new `OFF` null cells) — those remain class **X**
  and are not authorized here.
- It does not change any threshold, criterion, or protocol text.
- It does not modify `writeTrialCsv`, `writeTaskCsv`, any L10 artifact, or any
  engine/network/router source file.
- It has not been compiled, run, or tested. **It does not exist as code.**
