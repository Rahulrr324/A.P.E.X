# STARK-L11 — Trial-Level Evidence Schema v0.1

**Status:** design, frozen with the protocol text (`l11_1_protocol.md`).
**Purpose:** make every primary metric **independently reconstructable from one
row**, so that a single deviating trial is diagnosable without a new experiment.
**Prototype implementation:** `work/l11_1_prototype/schema_check.py` (executable
schema + validator + 17 self-tests, all passing) and
`work/l11_1_prototype/recompute_from_trials.py` (metric reconstruction proven on
L10.3 evidence). Both are **PROTOTYPE_ONLY**.

---

## 1. Why the existing record is insufficient

The L10 trial CSV has 17 columns:
`master, task, phase, trial, queried, choice, bank, bank_is_task_bank, correct,
reward, forced, writable, eval_kind, call, single, active, opp`.

Measured coverage against this schema: **13 of 35 required fields (37.1 %)**.
Missing, and each one cost L10 something:

| Missing field | Consequence already observed in L10 |
|---|---|
| `selected_slot` | the L10.4 one-trial anomaly cannot be attributed: the value **exists in memory** (`CCResult::sel_slot`) but is never written |
| `cue_features`, `cue_category` | a mixed cue is indistinguishable from a correct one in the record; only the aggregate code `eval_kind` remains |
| `intended_bank` | "routing correct" is a boolean with no record of what the router *should* have chosen under a declared rule |
| `bank_score_margin` | no way to distinguish a near-tie from a decisive wrong choice |
| `update_mass_*` | the L10.1 sealing telemetry aggregated mass, so per-trial credit cannot be reconstructed |
| `protocol_sha256`, `run_id`, `model_hash` | artifact provenance lives only in directory names |

## 2. Design rules

1. **One row per trial**, one file per (arm, seed). No nested structures.
2. **Explicit absence.** A missing/unmeasured value is the empty field (JSON
   `null`). Zero is a *measurement*, never a stand-in for "unknown".
3. **Declared types and closed value sets**; `cue_category` is enumerated.
4. **Deterministic ordering**: rows sorted by `(arm, master, phase, eval_call,
   trial)`; fields in the fixed order below; `\n` line endings; UTF-8; no BOM.
5. **CSV safety**: `cue_features` is `;`-joined so the field never contains a
   comma; `bank_state` is `,`-joined **inside a quoted field**.
6. **No model dumps.** State identity is carried as a hash, never as a blob.
7. **Additive only.** The writer appends fields; it must not change any RNG draw,
   clamp, weight update, or scoring path (asserted by the §10 non-interference
   test in the protocol).

## 3. Field table

| # | Field | Type | Null? | Meaning |
|---|---|---|---|---|
| 1 | `run_id` | str | no | unique run identifier, `<milestone>-<arm>-<seed>-<utc>` |
| 2 | `protocol_sha256` | str(64h) | no | hash of the registered protocol text |
| 3 | `arm` | str | no | declared arm id (`A0` … `A10`) |
| 4 | `master` | int | no | master seed |
| 5 | `model_hash` | str(64h) | no | sha256 of the serialized agent at run start |
| 6 | `task` | int | no | intended task index |
| 7 | `phase` | int | no | 0 = evaluation, 1 = commit/training, 2 = post-commit training |
| 8 | `trial` | int | no | index within the stream |
| 9 | `eval_call` | int | yes | evaluation call id; null for training rows |
| 10 | `eval_kind` | int | no | numeric cue-category code (kept for L10 compatibility) |
| 11 | `cue_features` | cue | no | active feature indices, sorted, unique, `;`-joined; **empty is legal** (context absent) |
| 12 | `cue_id` | str | no | stable label, e.g. `T1:0-2`, `X2:1-0\|2-3`, `OFF` |
| 13 | `cue_category` | enum | no | `TRAIN, HOLDOUT, CROSS21, CROSS31, AMBIG11, PARTIAL, MISLEAD, OFF, SHUFFLED, ORDERPERM` |
| 14 | `cue_modified` | int{0,1} | no | cue was altered from the intended one |
| 15 | `held_out` | int{0,1} | no | this combination was withheld from training |
| 16 | `intended_bank` | int | yes | bank prescribed by the declared rule; **null when the rule is undefined** (e.g. `SHUFFLED`) |
| 17 | `selected_bank` | int | no | bank actually used; `-1` = none available |
| 18 | `routing_correct` | int{0,1} | yes | `selected_bank == intended_bank`; null iff `intended_bank` is null |
| 19 | `bank_score_margin` | float | yes | top1 − top2 router score; null if not computed for this arm |
| 20 | `intended_slot` | int | yes | channel slot implied by `map.phi[ctx]` |
| 21 | `selected_slot` | int | yes | channel slot the attention sample took |
| 22 | `queried` | int | no | identity driven into the bank |
| 23 | `choice` | int | no | emitted response |
| 24 | `correct` | int{0,1} | no | `choice == perm[queried]` |
| 25 | `scoring_window` | int | no | decision-window length used for scoring |
| 26 | `active_bank` | int | no | writable bank at trial time; `-1` = none |
| 27 | `bank_state` | str | no | quoted `,`-joined per-bank codes (0 unallocated, 1 active, 2 sealed) |
| 28 | `plastic_write` | int{0,1} | no | was a plastic write executed |
| 29 | `update_mass_intended` | float | yes | `Σ|ΔW|` on `(selected_bank, queried)`; null when the arm does not measure mass |
| 30 | `update_mass_other` | float | yes | `Σ|ΔW|` in `selected_bank` outside `queried` |
| 31 | `reward` | float | no | trial reward |
| 32 | `advantage` | float | yes | `reward − baseline`; null when the router did not learn this trial |
| 33 | `router_update_l1` | float | yes | `Σ|ΔW_router|`; null when no router update |
| 34 | `checkpoint_id` | str | yes | set only on the trial that wrote a checkpoint |
| 35 | `resume_from_trial` | int | yes | set only on the first trial after a resume |

## 4. Enforced invariants (prototype implements all of these)

1. Sorted, unique, `;`-joined `cue_features`.
2. Non-nullable fields may not be empty; nullable fields may be empty but may not
   contain `0` as a stand-in for absence (distinguishable only by the writer rule:
   absence is always empty).
3. `routing_correct` is null iff `intended_bank` is null.
4. `routing_correct == 1[selected_bank == intended_bank]` when both are present.
5. `cue_category == OFF` ⇒ `cue_features` empty.
6. `cue_category ∈ {CROSS21, CROSS31, AMBIG11, MISLEAD}` ⇒ features span ≥ 2
   groups; `CROSS21` ⇒ exactly 3 features, `CROSS31` ⇒ exactly 4, `AMBIG11` ⇒ 2,
   `MISLEAD` ⇒ 2 from one wrong group.
7. `correct ∈ {0,1}`, `cue_modified ∈ {0,1}`, `held_out ∈ {0,1}`, `plastic_write ∈ {0,1}`.
8. `selected_bank == -1` ⇒ `plastic_write == 0`.
9. `eval_call` is null exactly when `phase != 0`.

## 5. Independent reconstruction procedure

From the rows alone (implemented in `recompute_from_trials.py`):

| Metric | Reconstruction |
|---|---|
| `routing` | `mean(routing_correct)` over non-null rows |
| `correct` / `MixAcc` | `mean(correct)` |
| `Comp` | `mean(routing_correct)` for the composition categories |
| `Read` | `mean(correct \| routing_correct == 1)`; `null` if no such row |
| `WrongBankAcc` | `mean(correct \| routing_correct == 0)`; `null` if none |
| `Null` | mean of the three forced-bank cells, each `mean(correct)` |
| non-interference | projected 17-column byte comparison between on/off runs |
| determinism | file-level sha256 comparison |

**Demonstrated on real evidence (PROTOTYPE_ONLY):** the reconstruction reproduces
the published L10.3 aggregate exactly for all three primary seeds
(`match = true`, max |Δ| < 5e-7) and exposes the routing/retrieval split that the
L10 record only reported as a pooled route rate.

## 6. Deliberate omissions

- No per-synapse dump (model hash + update mass is sufficient for every metric and
  every diagnostic in scope; a full dump would be O(state) per trial).
- No wall-clock or host fields (non-reproducible, and irrelevant to the claim).
- No free-text fields.
- `eval_kind` is retained alongside `cue_category` purely for L10 comparability;
  `cue_category` is authoritative.

## 7. File layout

```
<out>/<arm>/<seed>/
  trials_<arm>_<seed>.csv        # required, one row per trial
  calls_<arm>_<seed>.csv         # eval_call -> purpose, task, cue_category
  metrics_<arm>_<seed>.csv       # aggregate (for convenience, never authoritative)
  manifest.sha256                # sha256 of each file above
```

Aggregates are **derived**; if they ever disagree with the reconstruction, the
reconstruction wins and the disagreement is a defect to be reported.
