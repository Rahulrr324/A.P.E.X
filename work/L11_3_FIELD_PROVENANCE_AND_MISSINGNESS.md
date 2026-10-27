# STARK-L11.3 — Field-Level Provenance and Missingness Table (schema v0.2)

Every v0.2 field, traced to its **actual** source in
`stark/src/learning/l10_validation_harness.cpp` (sha256 `697b5f8a…`) and
`ContextConditionedMemory.{h,cpp}`, with the missingness rule that governs it.

Classes: **D** direct · **V** driver-derived · **A** existing public API ·
**O** operator-supplied · **X** blocked (needs an arm that does not exist).

---

## 1. Provenance

| # | Field | Class | Source (file : symbol) | Absence rule |
|---|---|---|---|---|
| 1 | `schema_version` | O | literal | never absent |
| 2 | `run_id` | O | `--run-id` | required; run refuses to start if absent |
| 3 | `protocol_sha256` | O | `--protocol-sha`, 64-hex validated | required |
| 4 | `schema_sha256` | O | hash of the v0.2 document | required |
| 5 | `arm` | D | `--tag` / `StreamSpec` | never absent |
| 6 | `master` | D | `masters` vector | never absent |
| 7 | `model_hash` | A+O | `ccSerialize(ag)` at run start, hashed outside C++ | required |
| 8 | `record_class` | V | writer's call site | never absent |
| 9 | `record_status` | V | validator outcome | never absent |
| 10 | `task` | D | loop variable / `evalTask` argument | never absent |
| 11 | `phase` | D | `commit ? 1 : (i < 480 ? 1 : 2)`, `0` in `evalTask` | never absent |
| 12 | `trial` | D | `i` (training) / `rows->size()` (evaluation, global ordinal) | never absent |
| 13 | `eval_call` | D | `next_call(...)` (line 322) | `NA` when `phase != 0` |
| 14 | `eval_kind` | D | `CueMode` | never absent |
| 15 | `call_purpose` | D | the `next_call` purpose string | `NA` when `phase != 0` |
| 16 | `cue_features` | D | `sched.cue` / `s.cue` | **empty = context absent** (a value, not an absence) |
| 17 | `cue_id` | V | cue + task → canonical label | never absent |
| 18 | `cue_category` | V | `CueMode`; 6 of 10 values **X** (arms not implemented) | never absent |
| 19 | `cue_modified` | V | `mis_task[i] >= 0` (line ~434) | never absent |
| 20 | `held_out` | V | from category | never absent |
| 21 | `task_bank` | V | `res.task_bank[t]` / the `active` bank that owns the task | `NA:NO_TASK_BANK` when none |
| 22 | `rule_bank` | V | **R-majority over the cue** (new driver helper P7) | `NA:RULE_UNDEFINED` when the cue prescribes nothing (`OFF`) |
| 23 | `forced_bank` | D | `force_eval_bank` argument of `evalTask` (line ~180) | `NA` on non-forced calls |
| 24 | `selected_bank` | D | `CCResult::bank` | never absent; `-1` = no bank selectable (real state) |
| 25 | `routing_correct` | V | `selected_bank == task_bank` | `NA:NO_TASK_BANK` iff `task_bank` is |
| 26 | `rule_compliant` | V | `selected_bank == rule_bank` | `NA:RULE_UNDEFINED` iff `rule_bank` is |
| 27 | `bank_score_margin` | A | `ccRouterWeights(ag)` → top1−top2 of `Σ_{f∈cue} W[f][k]` | `NM` when weights are not captured for the arm |
| 28 | `presented_ids` | D | `LRTrialSchedule::presented` | never absent |
| 29 | `intended_slot` | D | `map.phi[s.ctx]` | required |
| 30 | `selected_slot` | D | `CCResult::sel_slot` — the **sampled** channel, not the argmax | `NA:SINGLE_CANDIDATE` when the trial is single-candidate |
| 31 | `queried` | D | `CCResult::queried` = `presented[phi[ctx]]` | never absent |
| 32 | `choice` | D | `CCResult::choice` | never absent |
| 33 | `correct` | V | `choice == map.perm[queried]` | never absent |
| 34 | `choice_matches_resolved_bank_map` | V | `choice == perm_of(selected_bank)[queried]` | `NA:NO_PERM` when the selected bank has no mapping or `-1` |
| 35 | `scoring_window` | D | `cfg.lr.decision_steps` (= 6) | never absent |
| 36 | `metric_eligibility` | V | category → declared set (schema §5) | never absent |
| 37 | `active_bank` | D | `ccActiveBank(ag)` | never absent; `-1` = none (real state) |
| 38 | `bank_state` | D | `agent.bank_state` | never absent |
| 39 | `plastic_write` | D | `CCResult::plastic_write` | never absent |
| 40 | `update_mass_intended` | A | `ccBankWeights` before/after, `(selected_bank, queried)` | `NM` on evaluation rows |
| 41 | `update_mass_other_in_bank` | A | same, rest of `selected_bank` | `NM` on evaluation rows |
| 42 | `update_mass_other_banks` | A | same, all other banks | `NM` on evaluation rows |
| 43 | `reward` | D | `CCResult::reward` | never absent |
| 44 | `advantage` | A | `reward − baseline_before[0]`, snapshotted **before** `runCCTrial` | `NM` unless the router actually updated |
| 45 | `router_update_l1` | A | `ccRouterWeights` before/after | `NM` unless the router updated |
| 46 | `checkpoint_id` | O | driver `--stage save` | `NA` otherwise |
| 47 | `resume_from_trial` | O | driver `--stage load` | `NA` otherwise |

**Class tally:** D 17 · V 11 · A 5 · O 6 · X 1 (the six unimplemented cue
categories, which block `cue_category` values but no other field).

---

## 2. Missingness decision table

The five statuses are not decoration: each one changes what a metric may do.

| Field group | Observed | Not applicable | Not measured | Missing unexpectedly | Invalid |
|---|---|---|---|---|---|
| `selected_slot` | int | `NA:SINGLE_CANDIDATE` | — | `MISSING` | token from outside the set |
| `rule_bank` / `rule_compliant` | int / 0·1 | `NA:RULE_UNDEFINED` | — | `MISSING` | disagrees with `selected_bank` |
| `task_bank` / `routing_correct` | int / 0·1 | `NA:NO_TASK_BANK` | — | `MISSING` | disagrees with `selected_bank` |
| `forced_bank` | int | `NA` | — | `MISSING` | numeric on a non-forced call |
| `choice_matches_resolved_bank_map` | 0·1 | `NA:NO_PERM` | — | `MISSING` | disagrees with `choice` |
| `bank_score_margin` | float (may be negative) | — | `NM` | `MISSING` | non-numeric |
| `update_mass_*` | float ≥ 0 | — | `NM` (evaluation rows) | `MISSING` | negative, or numeric on an evaluation row |
| `advantage` | float (may be negative) | — | `NM` (router did not update) | `MISSING` | computed from a post-call baseline |
| `router_update_l1` | float ≥ 0 | — | `NM` | `MISSING` | negative |
| `checkpoint_id` / `resume_from_trial` | str / int | `NA` | — | `MISSING` | id without a matching row |
| **any** | — | — | — | record → `record_status = INVALID` | record → `record_status = INVALID` |

### The rule that matters

`MISSING` and `INVALID` do not merely annotate a field: they set
`record_status = INVALID`, and invalid rows are excluded from **every** metric
while the count of invalid rows is reported. A row is never silently repaired, and
a missing measurement never becomes a zero.

---

## 3. Removal of numeric sentinels

| v0.1 / legacy pattern | Where it existed | v0.2 replacement |
|---|---|---|
| `sel_slot = -1` | `CCResult::sel_slot` on single-candidate trials | `selected_slot = NA:SINGLE_CANDIDATE` |
| `cross_novel = -1.0` | `writeTaskCsv` (lines 644–652) when an arm did not run | `NM`, or the metric cell is `NA:*` with a code |
| `per_bank_off = -1.0` | `StreamResult::per_bank_off`, "not evaluated" | `forced_bank = NA` (row absent) |
| `eval_call = -1` | `TrialRow::call` for training rows | `eval_call = NA` |
| `call = -1` in `metrics` | training rows | `call_purpose = NA` |
| `unintended_* = -1.0` | aggregate only | no v0.2 field claims this; reported as an L10.1 aggregate only |

The legacy files keep their sentinels — **v0.2 governs the new file only**, and
the legacy artifacts are not rewritten (C1).

---

## 4. Fields that exist but must never be inferred

| Field | If the source is unavailable, the correct value is | Never |
|---|---|---|
| `model_hash` | `MISSING` → `record_status = INVALID` for the run | a hash of anything other than the serialized state |
| `protocol_sha256` | the run fails to start | a stale hash (the `e32043c` defect) |
| `schema_sha256` | the run fails to start | "latest schema" |
| `rule_bank` for `SHUFFLED` | the other task's bank — **it is defined**, contrary to v0.1's claim | `NA:RULE_UNDEFINED` |
| `task_bank` for `MISLEAD` | the evaluated task's bank — **it is defined** | the bank the cue suggests |
| `choice_matches_resolved_bank_map` | `NA:NO_PERM` only when no mapping exists | `0` as a stand-in for "not computed" |
