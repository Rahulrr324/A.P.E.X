# STARK-L11.5 — L11 Arm Implementation Inventory

**No arm implementation is authorized in this milestone.** This document inventories
what exists, what is missing, and what each arm would need before it could be
eligible for an official evaluation.

**Method:** static reading of `stark/src/learning/l10_validation_harness.cpp`
(sha256 `697b5f8a…`) and `ContextConditionedMemory.cpp/.h`. No binary was built, no
run was performed, no trial was produced.

---

## 1. The harness as it actually is

### 1.1 Cue modes that exist [V]

`l10_validation_harness.cpp:83–85`:

```c++
enum CueMode { CM_TRAIN = 0, CM_HOLDOUT = 1, CM_OFF = 2, CM_SHUFFLED = 3, CM_CROSS = 4,
               CM_PARTIAL = 5, CM_OFF_UNIFORM = 6 };
```

**Seven values.** `git grep AMBIG11 -- stark/src/` → **no matches**;
`git grep CROSS21 -- stark/src/` → **no matches**.

### 1.2 The decisive structural gap [V]

`spec.eval_cue` (`:153`) is initialised to `CM_TRAIN` and **is never assigned
anywhere in the file** (occurrences: declaration at 153, reads at 499, 500, 530,
531). There is no `--eval-cue` flag — the complete CLI surface is:

```
--mode --out --seeds --order --ctx-contribution --tasks --banks --state --stage
--force-bank --commit --seal --misroute --ctxperbank --tag --bank-mode --reuse-seal
```

**Consequence: the primary ("acquisition") and retention evaluations are hard-wired
to `TRAIN`.** No L11 arm can be *selected*. Every novel-cue evaluation that exists is
a fixed post-stream diagnostic, not a selectable arm.

### 1.3 The eight row-emitting evaluation calls, and their routing flags [V]

| # | Line | `call_purpose` | Cue mode | `want_routing` | `read_only` | Rows? |
|---|---|---|---|---|---|---|
| 1 | 500 | `acquisition` | `spec.eval_cue` = **`CM_TRAIN`** | **true** | true | yes |
| 2 | 531 | `retention@step<k>` | `spec.eval_cue` = **`CM_TRAIN`** | false | true | yes |
| 3 | 544 | `holdout` | `CM_HOLDOUT` | false | true | yes |
| 4 | 549 | `context_off` | `CM_OFF` | true | true | yes |
| 5 | 553 | `shuffled` | `CM_SHUFFLED` | false | true | yes |
| 6 | 564 | `partial_cue` | `CM_PARTIAL` | true | true | yes |
| 7 | 568 | `context_off_uniform` | `CM_OFF_UNIFORM` | true | true | yes |
| 8 | 574 | `cross_novel` | `CM_CROSS` | true | true | yes |
| — | 592 | (`call_id = -1`) | `CM_OFF` | false | true | **no** (`nullptr`) |

Note: `want_routing = false` means the **aggregate** routing counters are skipped
(`:250–253`); `TrialRow::bank_is_task_bank` is nevertheless recorded on every row
(`:268`). So per-row capture would supply routing for arms 2, 3 and 5 that the L10
aggregate does not compute.

### 1.4 `CM_CROSS` is a 1:1 cue, not `CROSS21` [V]

`l10_validation_harness.cpp:223–233`: one feature from `4*task + idx`, one from
`4*ot + idx` where `ot` is a **uniformly drawn other task**. That is
**`1 from g(t) + 1 from g(o)`** — the protocol's **`AMBIG11`** construction, not
`CROSS21` (2+1) and not `CROSS31` (3+1).

### 1.5 `CM_SHUFFLED` is constructionally identical to `MISLEAD` [V]

`l10_validation_harness.cpp:215–222` draws `tasks[ot].train_cues[pick_pair]` — i.e.
**two features from another task's group**. Protocol §4 defines `MISLEAD` as
"2 features from `g(o)` only (the wrong group)" and `SHUFFLED` as "`TRAIN` pair of
another task". **These are the same construction.** See finding A6-A7 below.

---

## 2. The eleven arms

Legend for "Implementation": **EXISTS** = a cue mode with the required construction
is reachable; **PARTIAL** = the construction exists but under a different draw
stream / selection path and is not selectable as an arm; **ABSENT** = no code.

| Arm | Protocol role | Required cue semantics | Implementation | Selectable as an L11 arm? |
|---|---|---|---|---|
| **A0** `TRAIN` | attainable ceiling | one of the task's 4 training pairs | **EXISTS** (`CM_TRAIN`, `:195–197`), and is the hard-wired primary eval | **no** — it is the acquisition path, but there is no arm selection |
| **A1** `HOLDOUT` | interpolation control | one of the task's 2 withheld pairs | **EXISTS** (`CM_HOLDOUT`, `:198–200`) | **no** — fixed post-stream diagnostic, `want_routing=false` |
| **A2** `CROSS21` | **primary composition** | 2 from `g(t)`, 1 from `g(o)`, distinct indices | **ABSENT** | **no** |
| **A3** `CROSS31` | monotonicity | 3 from `g(t)`, 1 from `g(o)`, distinct indices | **ABSENT** | **no** |
| **A4** `AMBIG11` | tie-break compliance | 1 from `g(t)`, 1 from `g(o)` | **PARTIAL** (`CM_CROSS` has this construction, but a different stream and no rule machinery) | **no** |
| **A5** `PARTIAL` | degraded context | one feature of a training pair, alternating | **EXISTS** (`CM_PARTIAL`, `:205–214`) | **no** — diagnostic only |
| **A6** `MISLEAD` | rule under contradiction | 2 features from `g(o)` only | **PARTIAL** (`CM_SHUFFLED` has this construction — see A6-A7) | **no** |
| **A7** `SHUFFLED` | contradictory context | a `TRAIN` pair of another task | **EXISTS** (`CM_SHUFFLED`, `:215–222`) | **no** — diagnostic only |
| **A8** `OFF` | measured null | empty cue | **EXISTS** (`CM_OFF`, `:201–203`; `CM_OFF_UNIFORM` `:204`) | **no** — diagnostic only |
| **A9** `ORDERPERM` | order control | `CROSS21` after training in order `[2,1,0]` | **PARTIAL** — `--order` exists (`:767`, mode `perm`), but the `CROSS21` cue does not | **no** |
| **A10** frozen router | zero-weight router → lowest allocated bank | `CROSS21` with `--bank-mode frozen` | **PARTIAL** — the mechanism exists (`CC_FROZEN`, `:244`), the cue does not | **no** |

**Summary:** 0 of 11 arms are selectable. 6 of 11 have their cue construction present
somewhere in the harness (A0, A1, A5, A7, A8 fully; A4, A6 as a different mode). 3 of
11 (A2, A3, A9-with-CROSS21) require **new cue synthesis**. A9 and A10 additionally
require the A2 cue.

**[V]** This is stricter than the L11.4 statement "five of eleven arms do not exist":
the five are indeed absent, **and** none of the remaining six is reachable as an
*arm*.

---

## 3. Missing **arm implementation** vs missing **instrumentation**

These are different work items with different authorization requirements and must not
be conflated.

### 3.1 Missing arm implementation (class **X** — experimental design; **not authorized**)

| Item | Needed by | Nature |
|---|---|---|
| `CM_CROSS21` cue synthesis: draw 1 task group + 1 other group, 2 distinct features from the task group | A2, A9, A10 | new `CueMode` + within-group distinct-index logic + the protocol's redraw rule (at most 4 redraws, then `cue_modified=1`) |
| `CM_CROSS31`: 3 from `g(t)` + 1 from `g(o)` | A3 | same machinery, different counts |
| `CM_AMBIG11`: 1 + 1 with the protocol's `rng_cross` stream and a **specified `o` distribution** | A4 | new mode; the `o` distribution is **not specified anywhere** (§5) |
| `CM_MISLEAD` distinguished from `CM_SHUFFLED` | A6 | requires a decision, because the two constructions are identical (§4) |
| **arm-selection mechanism** (`--eval-cue` or an `--arm` selector) | **every arm** | the harness has none; without it no arm is addressable |
| per-arm training-state control (each arm evaluated on the correct snapshot) | every arm | the current design evaluates all diagnostics on **one** post-stream snapshot; A9 needs a *different* training run |
| `rule_bank` computation (P7) with the group→bank map | A4, A6, A7 and every RULE metric | driver-side function; see schema audit D4 |
| protocol §11 exactness unit test (enumerate `CROSS21`/`CROSS31` rule predictions) | A2, A3 | **never executed**; cannot run until the cues exist |

### 3.2 Missing instrumentation (the C1–C7 work package; **not authorized**)

| Item | Needed by | Note |
|---|---|---|
| `--emit-l11` flag, default off | all | L11.3 patch spec §2.1 |
| separate writer `writeL11Csv` | all | C1 |
| 47-field v0.2 row capture inside `evalTask`'s `if (rows)`, before the restore | all | C2 |
| `record_class` derived from `call_id` | all | distinguishes ordinary from diagnostic rows |
| per-trial `w0` refresh and pre-call baseline snapshot | learning rows | C3, D6, D7 |
| masked `bank_score_margin` | all | D2 |
| `NA:UNUSED_CHANNEL` handling in `presented_ids` | training rows | D3 |
| `rule_bank` / `rule_compliant` fields populated | all | depends on P7 |
| `forced_bank` on the `per_bank_off` path | `Null(t)` reconstruction | D8 |
| in-process validator on write; `record_status = INVALID` + non-zero exit | all | L11.3 §2.5 |

**Key point [I]:** instrumentation can be written and validated **without** any arm
(the C6 battery runs on the existing `TRAIN`/`HOLDOUT`/`OFF`/`SHUFFLED` conditions),
but **no L11 arm can be evaluated without the arm implementation**. The two blockers
are independent and neither is currently authorized.

---

## 4. Finding A6-A7 — `MISLEAD` and `SHUFFLED` are the same cue construction

| Aspect | Detail |
|---|---|
| Protocol §4 [V] | `MISLEAD`: "2 features from `g(o)` only (the *wrong* group)"; `SHUFFLED`: "`TRAIN` pair of another task" |
| Specification §3 [V] | `MISLEAD`: "all features from a *wrong* group"; `SHUFFLED`: "cue taken from another task, registered procedure" |
| Code [V] | one mode: `CM_SHUFFLED` draws `tasks[ot].train_cues[pick_pair]` — a training pair from another task, i.e. 2 features from `g(o)` |
| Conclusion [I] | **The two arms are constructionally identical.** A `TRAIN` pair of another task *is* 2 features from that task's group. Unless the intended difference is the *sampling* of `o` (e.g. `MISLEAD` targets one designated wrong group deterministically, `SHUFFLED` samples uniformly), A6 and A7 would produce the same distribution and could not answer different causal questions |
| Status | **UNRESOLVED — reported, not decided.** It is a pre-existing protocol defect of the same family as R4, discovered by building this inventory |
| Proposed default [P] | keep both arms but **differentiate them explicitly**: `MISLEAD` = the wrong group that is *nearest in index* to the task group (deterministic, so "following the rule yields the wrong answer" is guaranteed and controlled); `SHUFFLED` = a uniformly drawn other task (as the code already does). Record the distinction in protocol §4. If the owner prefers, merge A6 into A7 and drop one arm — but that is an experimental-design change and requires explicit authorization |
| Interaction with R4 | independent of R4's `AMBIG11` question, but it is the *same* underlying defect: protocol §4's table names categories without making them mutually distinguishable in construction |

**This finding does not create a new authorization.** It is recorded so the owner can
decide before A6/A7 are implemented.

---

## 5. Finding A4-o — the `o` distribution is unspecified

| Aspect | Detail |
|---|---|
| Protocol §4 [V] | `CROSS21`: "first draw selects `o`"; `AMBIG11`: "same stream, separate prefix". **No distribution is stated for `o`** in any category |
| Code [V] | `CM_CROSS` uses `std::uniform_int_distribution<int> pick_other(0, n_tasks-1)` over a list of the other tasks → uniform |
| Consequence [C] | the *per-trial* metrics are well defined regardless, but their **expected values** depend on the `o` distribution. For `AMBIG11` this directly determines the divergence between `Comp_task` and `Comp_rule` (0 %, 50 %, 100 % by task under uniformity) |
| Status | **UNRESOLVED.** Not a blocker for A2/A3 (task bank is always the majority there), a real question for A4 |
| Proposed default [P] | adopt the code's existing uniform-over-other-tasks draw, and state it in protocol §4. This changes no recorded number because no L11 number exists |

---

## 6. Per-arm requirements before official eligibility

| Arm | Missing implementation | Required instrumentation fields | Required controls | Determinism | Tests needed first |
|---|---|---|---|---|---|
| A0 | none | full v0.2 row | A2 shares its snapshot | byte-identical rerun; fixed cue stream `rng_cue(seed ^ 0x5bd1e995)` | C6 checks 1–8, 7′, 9–14 |
| A1 | none (diagnostic form) | full row, `want_routing` irrelevant per row | shares A0 snapshot | same stream, index `pick & 1` | same |
| **A2** | `CM_CROSS21`; arm selector | `task_bank`, `rule_bank`, `rule_compliant`, `presented_ids`, `selected_slot`, `choice_matches_resolved_bank_map` | A9 and A10 on the same snapshot | `rng_cross(seed ^ 0x1f83d9ab)`, fixed prefixes, ≤4 redraws | §11 rule unit test; C6 battery; non-degeneracy (check 9) |
| **A3** | `CM_CROSS31` | as A2 | shares A2's snapshot | separate stream prefix | monotonicity sanity; §11 unit test |
| **A4** | `CM_AMBIG11` **+ `o` distribution decision** | as A2 plus `Comp_task`/`Comp_rule` separation | no order-permuted counterpart exists | separate prefix | R4/R4b/R4c must be ratified first |
| A5 | none (diagnostic form) | full row | shares A0 snapshot | `trial_i % 2` alternation | C6 battery |
| **A6** | distinction from A7 (**A6-A7 finding**) | `rule_compliant`, `choice_matches_resolved_bank_map` | must differ from A7 or be merged | per §4 once resolved | the A6-A7 decision |
| A7 | none (diagnostic form) | as A2 | A6 | `rng_shuf(master + 9100 + t)` | C6 battery |
| A8 | none (diagnostic form) | `forced_bank` for the null cells (D8) | `per_bank_off` sweep currently emits no rows | fixed | `Null(t)` reconstruction test |
| **A9** | `CM_CROSS21` + `--order 2,1,0` | as A2 | matched to A2 (identical eval seed) | identical streams to A2 | L11-G pairing test |
| **A10** | `CM_CROSS21` + `--bank-mode frozen` | as A2 | zero-weight router; must select the lowest allocated bank | deterministic | assert bank 0 selection |

---

## 7. What this inventory proves and does not prove

**Proves [V]:** no L11 arm is selectable today; three cue constructions are absent;
two are constructionally underspecified (`AMBIG11`'s `o` distribution, `MISLEAD` vs
`SHUFFLED`); the arm-selector mechanism itself does not exist.

**Does not prove:** that the existing modes behave as their comments claim at
runtime — that requires a run, and none was performed. It also does not prove that
implementing the missing modes is sufficient: the C6 non-interference battery and the
§11 exactness unit test must both pass first, and neither has ever been executed.
