# STARK-L11.2 — Field Provenance Matrix

Every field of `stark/design/l11_trial_schema.md` v0.1 traced to its **actual**
source in the current code. Availability classes:

- **D** direct, read from an existing value at the point of capture
- **V** derived by the driver from values it already holds
- **A** available through an existing public API call (no engine change)
- **O** operator/runner supplied — must not be invented by the code
- **X** not obtainable without a change this milestone is not authorized to make

| # | Field | Class | Source | Caveat / note |
|---|---|---|---|---|
| 1 | `run_id` | O | `--run-id` | required when enabled; absent ⇒ run refuses to start |
| 2 | `protocol_sha256` | O | `--protocol-sha` | validated 64-hex; prevents the stale-hash defect of `e32043c` |
| 3 | `arm` | D | `StreamSpec`/tag | existing `--tag` |
| 4 | `master` | D | `masters` vector | existing |
| 5 | `model_hash` | A+O | `ccSerialize(ag)` dump → external sha256 | **not** computed in C++; no crypto added |
| 6 | `task` | D | loop variable | existing |
| 7 | `phase` | D | `commit ? 1 : (i<480?1:2)` | existing |
| 8 | `trial` | D | `i` / trial index | existing |
| 9 | `eval_call` | D | `call_id` | null for training rows |
| 10 | `eval_kind` | D | `CueMode` | existing |
| 11 | `cue_features` | D | `sched.cue` / `s.cue` | **empty is meaningful** (context absent), not missing |
| 12 | `cue_id` | V | cue + task | canonical string, e.g. `T1:0-2` |
| 13 | `cue_category` | V | `CueMode` | **only the 6 existing values are producible today** (`TRAIN`, `HOLDOUT`, `PARTIAL`, `OFF`, `SHUFFLED`, `CROSS` 1:1); `CROSS21/31`, `AMBIG11`, `MISLEAD`, `ORDERPERM` need the arms, which do not exist (class **X**) |
| 14 | `cue_modified` | V | `mis_task[i] >= 0` | training-side corruption flag |
| 15 | `held_out` | V | from category | — |
| 16 | `intended_bank` | V | **R-majority over the cue** (driver) | must be computed driver-side; the engine must never see it (non-leakage) |
| 17 | `selected_bank` | D | `r.bank` | `-1` ⇒ no bank available, a real value |
| 18 | `routing_correct` | V | `r.bank == intended_bank` | null iff `intended_bank` null |
| 19 | `bank_score_margin` | A | `ccRouterWeights()` → top1−top2 of `Σ_f W[f][k]` | `bankScores` is private; the weights are public, so this is reproducible without an accessor |
| 20 | `intended_slot` | D | `map.phi[s.ctx]` | driver holds `map` |
| 21 | `selected_slot` | D | `r.sel_slot` | **`-1` means "not applicable" (single-candidate trial), not missing** ⇒ must be written empty |
| 22 | `queried` | D | `r.queried` | identity at the **intended** slot, not at the selected slot |
| — | *(new, required)* `presented[]` | D | `lr.presented` | needed to reconstruct the identity actually attended; add to the writer, not to the schema's frozen field list — recorded as a **proposed schema addition** |
| 23 | `choice` | D | `r.choice` | — |
| 24 | `correct` | V | `choice == map.perm[queried]` | already computed by the harness |
| 25 | `scoring_window` | D | `cfg.lr.decision_steps` (= 6) | run-level constant copied per row |
| 26 | `active_bank` | D | `ccActiveBank(ag)` / existing `active` | — |
| 27 | `bank_state` | D | `ag.bank_state` | public member; quoted `,`-joined |
| 28 | `plastic_write` | D | `r.plastic_write` | — |
| 29 | `update_mass_intended` | A | `ccBankWeights()` before/after, over `(bank, queried)` | null for evaluation rows (learning disabled) |
| 30 | `update_mass_other` | A | same, rest of the bank | idem |
| 31 | `reward` | D | `r.reward` | — |
| 32 | `advantage` | A | `reward − baseline_before` | **baseline must be snapshotted before `runCCTrial`**; null unless the router actually updated |
| 33 | `router_update_l1` | A | `ccRouterWeights()` before/after | null when no update |
| 34 | `checkpoint_id` | O | driver `--stage save` | null otherwise |
| 35 | `resume_from_trial` | O | driver `--stage load` | null otherwise |

## Summary

| Class | Count |
|---|---|
| D direct | 16 |
| V driver-derived | 7 |
| A public API | 5 |
| O operator-supplied | 4 |
| **X blocked (missing arms)** | **1** (`cue_category` for the six L11 categories) |
| Proposed additions | 1 (`presented[]`) |

Constraints that shaped the design:

1. **Nothing requires an engine change.** The probe in
   `work/L11_2_EVIDENCE/feasibility_probe.cpp` exercises every API-based field.
2. **`-1` sentinels exist in the current record for two different meanings**
   (`sel_slot = -1` ⇒ not applicable; aggregate `-1.0` ⇒ not measured). Neither may
   be carried into the L11 record as a value; both become explicit absences.
3. **The arms are missing.** Instrumentation can be finished without them, but no
   official L11 measurement can exist until they do. This is a milestone-ordering
   fact, not a defect.

## Proposed schema change (documented, not applied)

`model_hash` produced by an external hash of a state dump rather than by C++ code,
and the addition of `presented[]`. Both are **engineering** refinements of a draft
schema; if accepted at implementation time they require re-freezing
`stark/design/l11_trial_schema.md` and re-recording the protocol hash — not a
silent edit.
