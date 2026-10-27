# STARK-L11 — Trial-Level Evidence Schema **v0.2**

**Status: PROPOSED — NOT FROZEN, NOT IN FORCE.**
Prepared by STARK-L11.3 as a documentation-only correction of v0.1.
**No official L11 evaluation has been run. Zero arms, zero trials.**
**v0.1 is preserved unmodified** at `stark/design/l11_trial_schema.md`
(sha256 `a8edd674bc9efd651e1c3a25dee1f5317dae442aaf236ae01f1b8240f8d87917`) and
remains the only schema recorded in the L11.1 pre-registration until the owner
authorizes this revision.

**Why a revision exists.** The R3 audit (`work/L11_2_R3_AUTHORIZATION_AUDIT.md`,
commit `deac50f`) found three semantic defects in v0.1 — recorded there as S1, S2
and S3 — plus four silent-corruption hazards in the implementation plan. v0.2
repairs the defects in the *specification*; the hazards are handled by the patch
specification and the test plan, not here. Every change is listed in
`work/L11_3_SCHEMA_CHANGELOG.md`.

---

## 1. Scope and invariants

1. **One row per trial.** One file per (arm, seed).
2. **Explicit absence.** No numeric sentinel ever means "missing". The string
   tokens in §2 replace v0.1's overloaded `-1`. A real `-1` is permitted only
   where it is a genuine measured state (`selected_bank = -1` means *no bank was
   selectable* — a fact about the run, not an absence).
3. **Deterministic serialization.** Fixed column order, `\n` endings, UTF-8, no
   BOM, `;`-joined multi-values. Rows sorted by
   `(arm, master, task, phase, eval_call, trial)`.
4. **No model blobs.** State identity is a hash.
5. **Additive execution.** The writer appends nothing to the model's work: no
   RNG draw, no weight update, no scoring change.
6. **Every row is classifiable.** `record_class` separates real trial evidence
   from diagnostic re-derivation, and `record_status` separates usable rows from
   invalid ones. Neither may be omitted.

---

## 2. Missing-value and status tokens

| Token | Meaning | Enters metrics? |
|---|---|---|
| `<number>` | an observed measurement | yes |
| `NA` | **not applicable**, no code needed (e.g. `forced_bank` on a non-forced call) | no |
| `NA:<code>` | **not applicable** — structurally impossible or undefined for this category/trial | no |
| `NM` | **not measured** — the arm/run does not instrument this quantity | no |
| `MISSING` | **expected but absent** — a required value did not arrive | no → row becomes `INVALID` |
| `INVALID` | **inconsistent** — contradicts other fields in the same row | no → row becomes `INVALID` |

`NA:<code>` codes (closed set):

| Code | Used for |
|---|---|
| `NA:SINGLE_CANDIDATE` | `selected_slot` on a single-candidate trial (the documented `sel_slot = -1` case) |
| `NA:RULE_UNDEFINED` | `rule_bank` / `rule_compliant` when the cue prescribes nothing (e.g. `OFF`) |
| `NA:NO_TASK_BANK` | `task_bank` / `routing_correct` when the evaluated unit owns no bank |
| `NA:NO_PERM` | `choice_matches_resolved_bank_map` when the selected bank has no mapping |
| `NA:NO_DENOM` | a metric with an empty denominator |
| `NA:STRUCT_ZERO` | a metric that is zero **by construction** for this category |
| `NA:NOT_ROUTED` | a metric conditioned on routing when no row satisfied it |

**Rule.** A structural zero may never be recorded as an observed `0`. A cell that
is `NA` is excluded from every mean and reported as `NA` with its code; it is
never averaged in as zero. This is the rule that repairs S2.

---

## 3. Field table (47 columns, fixed order)

Types: `int`, `float`, `str`, `csv` (quoted, comma-joined), `semi`
(`;`-joined ints), `enum`, `hash` (64 lowercase hex).

| # | Field | Type | Presence | Meaning |
|---|---|---|---|---|
| 1 | `schema_version` | str | required | literal `L11-TRIAL-v0.2` |
| 2 | `run_id` | str | required | `<milestone>-<arm>-<seed>-<utc>` |
| 3 | `protocol_sha256` | hash | required | registered protocol text hash |
| 4 | `schema_sha256` | hash | required | hash of **this** document; binds artifacts to a schema version |
| 5 | `arm` | str | required | declared arm id (`A0`…`A10`) |
| 6 | `master` | int | required | master seed |
| 7 | `model_hash` | hash | required | sha256 of `ccSerialize(agent)` at run start |
| 8 | `record_class` | enum | required | `LEARNING` \| `EVALUATION` \| `DIAGNOSTIC_REDERIVATION` |
| 9 | `record_status` | enum | required | `OK` \| `INVALID` |
| 10 | `task` | int | required | evaluated task index |
| 11 | `phase` | int | required | 0 evaluation, 1 commit/training, 2 post-commit training |
| 12 | `trial` | int | required | ordinal within the stream (evaluation: global ordinal across calls, mirroring the legacy `idx`) |
| 13 | `eval_call` | int | `NA:*` for training | evaluation call id |
| 14 | `eval_kind` | int | required | numeric cue code, kept for L10 comparability |
| 15 | `call_purpose` | str | `NA:*` for training | `acquisition`, `retention@stepN`, `holdout`, `context_off`, `shuffled`, `forced_bank`, `cross`, `rediagnosis` |
| 16 | `cue_features` | semi | required (empty allowed) | active feature indices, sorted, unique; **empty means context absent**, not missing |
| 17 | `cue_id` | str | required | stable label (`T1:0-2`, `X2:1-0\|2-3`, `OFF`) |
| 18 | `cue_category` | enum | required | `TRAIN, HOLDOUT, CROSS21, CROSS31, AMBIG11, PARTIAL, MISLEAD, OFF, SHUFFLED, ORDERPERM` |
| 19 | `cue_modified` | int{0,1} | required | cue altered from the intended one |
| 20 | `held_out` | int{0,1} | required | combination withheld from training |
| 21 | `task_bank` | int \| `NA:NO_TASK_BANK` | required | **bank that owns the evaluated task's mapping** — task-driver ground truth (the L10 routing denominator) |
| 22 | `rule_bank` | int \| `NA:RULE_UNDEFINED` | required | **bank prescribed by the R-majority rule for this cue** — rule ground truth, independent of which task is being evaluated |
| 23 | `forced_bank` | int \| `NA` | required | the bank forced by a forced-bank (null) evaluation call; `NA` otherwise |
| 24 | `selected_bank` | int | required | bank actually used; `-1` = no bank selectable (a real state) |
| 25 | `routing_correct` | int{0,1} \| `NA:NO_TASK_BANK` | required | `selected_bank == task_bank` |
| 26 | `rule_compliant` | int{0,1} \| `NA:RULE_UNDEFINED` | required | `selected_bank == rule_bank` |
| 27 | `bank_score_margin` | float \| `NM` | required | top1 − top2 router score at decision time |
| 28 | `presented_ids` | semi | required | candidate identities in slot order; `X` for an empty slot |
| 29 | `intended_slot` | int | required | `map.phi[ctx]` — the slot the schedule intends |
| 30 | `selected_slot` | int \| `NA:SINGLE_CANDIDATE` | required | slot the attention sample took |
| 31 | `queried` | int | required | identity driven into `selected_bank` (= `presented_ids[intended_slot]` for multi-candidate trials) |
| 32 | `choice` | int | required | emitted response |
| 33 | `correct` | int{0,1} | required | `choice == perm_task[queried]` |
| 34 | `choice_matches_resolved_bank_map` | int{0,1} \| `NA:NO_PERM` | required | `choice == perm_of(selected_bank)[queried]` — the "did the resolved bank answer its *own* mapping" check |
| 35 | `scoring_window` | int | required | decision-window length used for scoring |
| 36 | `metric_eligibility` | semi | required | subset of `ACC;ROUTE;RULE;READ;MAPCHECK` (§5) |
| 37 | `active_bank` | int | required | writable bank at trial time; `-1` = none (real state) |
| 38 | `bank_state` | csv | required | per-bank codes, 0 unallocated / 1 active / 2 sealed |
| 39 | `plastic_write` | int{0,1} | required | was a plastic write executed |
| 40 | `update_mass_intended` | float \| `NM` | required | `Σ|ΔW|` on `(selected_bank, queried)` |
| 41 | `update_mass_other_in_bank` | float \| `NM` | required | `Σ|ΔW|` in `selected_bank` outside `queried` |
| 42 | `update_mass_other_banks` | float \| `NM` | required | `Σ|ΔW|` in every other bank |
| 43 | `reward` | float | required | trial reward |
| 44 | `advantage` | float \| `NM` | required | `reward − baseline_before` (pre-call snapshot, index 0) |
| 45 | `router_update_l1` | float \| `NM` | required | `Σ|ΔW_router|` this trial |
| 46 | `checkpoint_id` | str \| `NA` | required | set only on the trial that wrote a checkpoint |
| 47 | `resume_from_trial` | int \| `NA` | required | set only on the first trial after a resume |

**Removed from v0.1:** `intended_bank` — it carried two meanings and is replaced
by `task_bank` (L10 meaning) and `rule_bank` (L11 rule meaning). This is the S1
repair.
**Renamed from v0.1:** `update_mass_other` → `update_mass_other_in_bank`
(identical meaning, disambiguated name).
**Added over v0.1 (13):** `schema_version`, `schema_sha256`, `record_class`,
`record_status`, `call_purpose`, `task_bank`, `rule_bank`, `rule_compliant`,
`forced_bank`, `presented_ids`, `choice_matches_resolved_bank_map`,
`metric_eligibility`, `update_mass_other_banks`.

---

## 4. Enforced invariants

Checked by the prototype validator
(`work/l11_3_prototype/schema_v0_2_check.py`) and required of the C++ writer.

**Type and token rules**
1. A bare `-1` is rejected in every **index or boolean** field:
   `task_bank, rule_bank, forced_bank, routing_correct, rule_compliant,
   selected_slot, intended_slot, eval_call, resume_from_trial` and the three
   `update_mass_*` magnitudes. `selected_bank` and `active_bank` may hold `-1`
   because it is a documented real state ("no bank selectable/writable").
   `reward`, `advantage` and `bank_score_margin` are genuine measurements and may
   be negative — they are never treated as markers of absence.
2. `MISSING` or `INVALID` in any required field ⇒ `record_status = INVALID`.
3. `NA:<code>` codes must come from the closed set in §2.
4. `cue_features` sorted, unique, `;`-joined; empty allowed only when
   `cue_category == OFF`.

**Semantic rules**
5. `routing_correct == 1[selected_bank == task_bank]` whenever both are numeric.
6. `rule_compliant == 1[selected_bank == rule_bank]` whenever both are numeric.
7. `routing_correct` is `NA:NO_TASK_BANK` **iff** `task_bank` is.
8. `rule_compliant` is `NA:RULE_UNDEFINED` **iff** `rule_bank` is.
9. `task_bank` and `rule_bank` are **independent** fields; they may differ
   (`AMBIG11`, `MISLEAD`, `SHUFFLED`). Neither may be derived from the other.
10. `selected_slot` is `NA:SINGLE_CANDIDATE` **iff** the trial is single-candidate
    (`presented_ids` contains exactly one non-`X` entry).
11. `queried == presented_ids[intended_slot]` on multi-candidate trials.
12. `correct == 1[choice == perm_task[queried]]`.
13. `choice_matches_resolved_bank_map` is `NA:NO_PERM` iff `selected_bank` has no
    mapping or `selected_bank == -1`.
14. `selected_bank == -1` ⇒ `plastic_write == 0` and `update_mass_* == 0.0`.
15. `record_class == DIAGNOSTIC_REDERIVATION` rows must never carry
    `ACC`/`ROUTE`/`RULE`/`READ` in `metric_eligibility`.
16. `metric_eligibility` must equal the category's declared set (§5) exactly.
17. `advantage` is `NM` unless the router actually updated on this trial.
17a. `update_mass_*` are magnitudes and must be `>= 0`.
18. `update_mass_*` are `NM` on evaluation rows (learning is disabled) and
    numeric on `LEARNING` rows.
19. `eval_call`/`call_purpose` are `NA:*` iff `phase != 0`.
20. `forced_bank` is numeric only for `call_purpose == forced_bank` calls.

---

## 5. `metric_eligibility` per category

The eligibility set is the mechanism that prevents a structural zero from being
counted as an observed failure. It is declared per category and enforced.

| Category | ACC | ROUTE | RULE | READ | MAPCHECK | Rationale |
|---|---|---|---|---|---|---|
| `TRAIN` | ✓ | ✓ | ✓ | ✓ | ✓ | ceiling reference |
| `HOLDOUT` | ✓ | ✓ | ✓ | ✓ | ✓ | interpolation control |
| `PARTIAL` | ✓ | ✓ | ✓ | ✓ | ✓ | degraded context |
| `CROSS21` | ✓ | ✓ | ✓ | ✓ | ✓ | **primary composition arm** |
| `CROSS31` | ✓ | ✓ | ✓ | ✓ | ✓ | monotonicity |
| `ORDERPERM` | ✓ | ✓ | ✓ | ✓ | ✓ | order control |
| `AMBIG11` | – | ✓ | ✓ | ✓ | ✓ | tie-break only; **no accuracy claim** (v0.1 already demoted it) |
| `MISLEAD` | – | – | ✓ | – | ✓ | accuracy and routing are 0 **by construction**; only rule-following and the resolved bank's own mapping are informative |
| `SHUFFLED` | ✓ | ✓ | – | ✓ | ✓ | `rule_compliant` is **excluded from `Comp`**: here it means "the model was successfully misled" |
| `OFF` | ✓ | ✓ | – | ✓ | ✓ | the measured null; no rule exists for an empty cue |

Reading the table: `SHUFFLED` deliberately computes `rule_compliant` but bars it
from `Comp`. `MISLEAD` computes neither accuracy nor routing into any rate.

---

## 6. Relationship to the frozen protocol

This schema does **not** change any L11 criterion value or threshold. The
impact of every field is classified in `work/L11_3_PROTOCOL_IMPACT_ASSESSMENT.md`.
In summary: for every category referenced by a criterion (`A2` = `CROSS21`,
`A3` = `CROSS31`, `A8` = `OFF`, `A9` = `ORDERPERM`), `rule_bank == task_bank`, so
`rule_compliant == routing_correct` and **no criterion number moves**. Two
pre-existing ambiguities in the protocol text are flagged there for owner
clarification; neither is resolved by this document.

---

## 7. Versioning

| Version | Date | Status |
|---|---|---|
| 0.1 | 2026-10-24 | frozen with protocol v0.1, **superseded in intent but not revoked**; preserved |
| 0.2 | 2026-10-24 | **PROPOSED**; requires owner authorization and a re-recorded schema hash before use |

v0.1 remains authoritative until the owner records a decision. If v0.2 is not
adopted, the S1/S2/S3 defects stand and `--emit-l11` must not be implemented.
