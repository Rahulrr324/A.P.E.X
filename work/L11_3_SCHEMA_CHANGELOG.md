# STARK-L11.3 — Schema Change Log: v0.1 → v0.2

**Status:** documentation-only change, **PROPOSED**.
**v0.1 preserved unmodified** — `stark/design/l11_trial_schema.md`, sha256
`a8edd674bc9efd651e1c3a25dee1f5317dae442aaf236ae01f1b8240f8d87917`, unchanged in
this milestone and still the schema recorded in the L11.1 pre-registration.
**v0.2 proposed** — `stark/design/l11_trial_schema_v0_2.md`, sha256
`1ce1525b83f9c02a3f1d996ec2736b0d10fcc0beefe7c1b1362f886279d96ad8`.

No field is renamed silently; no meaning is quietly redefined. Every row below is
one decision.

---

## 1. Structural summary

| | v0.1 | v0.2 |
|---|---|---|
| Fields | 35 | **47** |
| Removed | — | 1 (`intended_bank`) |
| Renamed | — | 1 (`update_mass_other` → `update_mass_other_in_bank`) |
| Added | — | 13 |
| Missing-value tokens | empty field only | `NA`, `NA:<code>`, `NM`, `MISSING`, `INVALID` |
| Row classes | none | `record_class`, `record_status` |
| Metric denominators | implicit | explicit `metric_eligibility` |

35 − 1 + 13 = 47. ✔

---

## 2. The three audit defects, and exactly how each is closed

### S1 — `intended_bank` carried two meanings

| | v0.1 | v0.2 |
|---|---|---|
| Field | `intended_bank` — *"bank prescribed by the declared rule; null when the rule is undefined (e.g. `SHUFFLED`)"* | `task_bank` (**bank owning the evaluated task**) **and** `rule_bank` (**bank the R-majority rule prescribes**), two independent fields |
| Derived | `routing_correct := selected == intended_bank` | `routing_correct := selected == task_bank`; **new** `rule_compliant := selected == rule_bank` |
| `SHUFFLED` | rule declared "undefined"; a model that followed the misleading cue and matched *the rule* would have been scored `routing_correct = 1` | `task_bank` = the evaluated task's bank; `rule_bank` = the other task's bank; a misled model gets `rule_compliant = 1` **and** `routing_correct = 0`, which is the truth |
| `MISLEAD` | same conflation | same separation; `rule_compliant` answers "did it follow the cue", `routing_correct` answers "did it select the task's bank" |

**Why this is a correction and not a change of standard:** the frozen protocol §6
already defines `routing` as *"the selected bank is the bank that owns task t"* —
the `task_bank` meaning. v0.2 restores that meaning to the field that claims to
implement it. L10.3's published `shuffled` routing of 0.0000 is reproduced, not
contradicted (verified in the audit, §6.3 of
`work/L11_2_R3_AUTHORIZATION_AUDIT.md`).

### S2 — `Read` for `MISLEAD`

| | v0.1 | v0.2 |
|---|---|---|
| `Read` | `mean(correct \| routing_correct == 1)`; for `MISLEAD` the denominator is empty, so the value is undefined and a careless implementation writes `0` | `Read` is `NA:STRUCT_ZERO` for `MISLEAD`, `NA:NO_DENOM` when a valid denominator is empty, otherwise `OBSERVED`. Never `0` unless a row was genuinely observed |
| Reporting | a single number | every metric cell carries `{status, value, n}` |
| Enforcement | prose | `metric_eligibility` is a required column and is checked against the declared per-category set |

New field: `choice_matches_resolved_bank_map` — `choice == perm_of(selected_bank)[queried]`
— which is what makes `MISLEAD` answerable ("did the resolved bank answer its
**own** mapping") without inventing a value.

### S3 — `presented[]` missing

| | v0.1 | v0.2 |
|---|---|---|
| Candidates | not recorded | `presented_ids` (`id0;id1`, `X` for an empty slot) |
| Attended identity | unrecoverable | recoverable as `presented_ids[selected_slot]` |
| Single-candidate case | `sel_slot = -1` documented in the code only | `selected_slot = NA:SINGLE_CANDIDATE`, enforced by an invariant |

The documented meaning of the legacy `sel_slot = -1` is preserved exactly: it
means **not applicable** (single-candidate trial), and it is now encoded as
`NA:SINGLE_CANDIDATE` instead of a numeric sentinel.

---

## 3. Two gaps found during this milestone (beyond the audit's S1–S3)

### G1 — `forced_bank` was absent, so the L11-B null was not reconstructible

`Null(t)` (protocol §6) is the mean over forced-bank trials. v0.1 has no field
identifying a forced-bank trial, so the null could only come from the aggregate
`ctxperbank_*.csv`, not from trial rows — defeating the "reconstruct every metric
from rows" requirement.

**v0.2 adds `forced_bank`** (int, or `NA`), and invariant 20 ties it to
`call_purpose == forced_bank`.

### G2 — `record_class` was absent, so diagnostic re-derivation rows were indistinguishable

`evalTask` re-derives routing with 120 extra model calls per task (source lines
505–521). Today those calls emit nothing. A future writer placed at the wrong
site would emit them indistinguishably from real trials.

**v0.2 adds `record_class`** with the value `DIAGNOSTIC_REDERIVATION`, and
invariant 15 bars such rows from `ACC/ROUTE/RULE/READ` eligibility.

---

## 4. Field-by-field diff

| v0.1 field | v0.2 treatment | Change class |
|---|---|---|
| `run_id` | kept | none |
| `protocol_sha256` | kept | none |
| — | **`schema_version`** added | serialization |
| — | **`schema_sha256`** added | serialization (binds artifacts to a schema edition) |
| `arm` | kept | none |
| `master` | kept | none |
| `model_hash` | kept | none |
| — | **`record_class`** added | instrumentation |
| — | **`record_status`** added | missingness |
| `task` | kept | none |
| `phase` | kept | none |
| `trial` | kept; ordinal definition made explicit | serialization |
| `eval_call` | kept, now `NA` on training | missingness |
| `eval_kind` | kept (L10 comparability) | none |
| — | **`call_purpose`** added | instrumentation (makes forced-bank calls identifiable) |
| `cue_features` | kept | none |
| `cue_id` | kept | none |
| `cue_category` | kept, 10 values | none |
| `cue_modified` | kept | none |
| `held_out` | kept | none |
| `intended_bank` | **removed**, split into `task_bank` + `rule_bank` | **metric-definition (S1)** |
| — | **`task_bank`** added | metric-definition |
| — | **`rule_bank`** added | metric-definition |
| — | **`forced_bank`** added | instrumentation (G1) |
| `selected_bank` | kept; `-1` = no bank selectable (real state) | none |
| `routing_correct` | kept, **redefined** as `selected == task_bank` | **metric-definition (S1)** |
| — | **`rule_compliant`** added | metric-definition |
| `bank_score_margin` | kept; may be negative | none |
| — | **`presented_ids`** added | instrumentation (S3) |
| `intended_slot` | kept | none |
| `selected_slot` | kept; `-1` → `NA:SINGLE_CANDIDATE` | **missingness (S3)** |
| `queried` | kept; invariant ties it to `presented_ids[intended_slot]` | serialization |
| `choice` | kept | none |
| `correct` | kept | none |
| — | **`choice_matches_resolved_bank_map`** added | metric-definition (S2) |
| `scoring_window` | kept | none |
| — | **`metric_eligibility`** added | metric-definition (S2 denominators) |
| `active_bank` | kept | none |
| `bank_state` | kept | none |
| `plastic_write` | kept | none |
| `update_mass_intended` | kept | none |
| `update_mass_other` | **renamed** `update_mass_other_in_bank` | serialization (name only) |
| — | **`update_mass_other_banks`** added | instrumentation (completes the L10.1 I/UR/UB decomposition) |
| `reward` | kept; may be negative | none |
| `advantage` | kept; `NM` unless the router updated | missingness |
| `router_update_l1` | kept | none |
| `checkpoint_id` | kept; `null` → `NA` | missingness |
| `resume_from_trial` | kept; `null` → `NA` | missingness |

**Change-class tally:** serialization 4 · instrumentation 5 · missingness 4 ·
metric-definition 5 · acceptance-criterion **0** · experimental-design **0**.

No threshold, arm, seed, sample size, mixture ratio, tie-break or aggregation rule
is touched. See `work/L11_3_PROTOCOL_IMPACT_ASSESSMENT.md`.

---

## 5. What v0.2 deliberately does **not** change

- The ten cue categories and their constructions.
- The seven seeds, the eleven arms, 120 trials per cell.
- `Comp`, `MixAcc`, `Null`, `ShufAcc` and `WrongBankAcc` numeric definitions for
  every category a criterion references.
- L11-A … L11-G thresholds.
- The L10 criteria or any frozen L10 artifact.

Two **pre-existing** protocol ambiguities were found while writing this change log.
They are *not* resolved here and are escalated in
`work/L11_3_PROTOCOL_IMPACT_ASSESSMENT.md` §4.
