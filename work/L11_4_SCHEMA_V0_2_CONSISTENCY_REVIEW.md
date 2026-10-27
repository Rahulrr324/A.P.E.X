# STARK-L11.4 — Schema v0.2 Consistency Review

**Subject:** `stark/design/l11_trial_schema_v0_2.md`, sha256
`1ce1525b83f9c02a3f1d996ec2736b0d10fcc0beefe7c1b1362f886279d96ad8` (222 lines,
47 fields), reviewed against the **actual source** and the frozen record.

**Scope:** review and errata **proposals**. The v0.2 document is **not modified**
in this milestone, and neither is any L11.3 document. Findings that require a
schema change are written here as proposals for a **v0.2.1** revision; they are not
applied.

Labels: **[V]** verified in source/file · **[A]** committed artifact · **[I]**
inferred · **[P]** proposed · **[?]** unknown/blocked.

---

## 1. Does v0.2 keep the eight concepts apart?

The mission's central check. Each concept must have its own field and no field may
serve two:

| Concept | Field in v0.2 | Distinct? | Evidence |
|---|---|---|---|
| task-associated bank | `task_bank` (21) | **yes** | set from the `task_bank` argument / `res.task_bank[t]` **[V, harness:404]** |
| composition-rule-prescribed bank | `rule_bank` (22) | **yes** | separate field; may differ (§2 R4) |
| model-selected bank | `selected_bank` (24) | **yes** | `CCResult::bank` **[V, CCM.h:101]** |
| task correctness | `correct` (33) | **yes** | `choice == map.perm[queried]` **[V, harness:246]** |
| rule compliance | `rule_compliant` (26) | **yes** | `selected_bank == rule_bank` |
| retrieval correctness | `correct`, `choice_matches_resolved_bank_map` (34), `Read` | **yes** | `MAPCHECK` separates "the chosen bank answered its own mapping" from "the task was answered" |
| missing measurements | `NM`, `MISSING` | **yes** | closed token set **[V, §2]** |
| structurally inapplicable measurements | `NA`, `NA:<code>` | **yes** | 7-code closed set **[V, §2]** |

**Verdict: the eight concepts are properly separated.** No field carries two
meanings. This is the property v0.1 lacked and it survives review. Findings below
are about *reachability, computation and token completeness*, not conflation.

---

## 2. Findings

### D1 — `selected_bank = -1` is unreachable; the schema describes it as a live state

| | |
|---|---|
| v0.2 claim | field 24: "`-1` = no bank selectable (**a real state**)"; type rule 1: "`selected_bank` and `active_bank` may hold `-1` because it is a documented real state"; invariant 14: "`selected_bank == -1` ⇒ `plastic_write == 0` and `update_mass_* == 0.0`"; protocol §8(i) relies on it as a validity condition |
| Source | `ContextConditionedMemory.cpp:345`: `if (bank < 0 \|\| bank >= K) bank = 0;` — immediately after every branch that sets `bank`. `ccPreferredBank` (205–215) returns `best < 0 ? 0 : best`. `ccActiveBank` may return -1, but `out.bank` cannot. **[V]** |
| Verdict | **`CCResult::bank` is always in `[0, K)` for K ≥ 1.** `selected_bank == -1` cannot occur. |
| Consequences | (a) invariant 14 is **vacuous**; (b) invariant 13's `selected_bank == -1` clause is **dead**; (c) **protocol §8(i) is an inert validity rule** — it can never fire, so no trial is ever excluded by it; (d) the description "a real state" is **wrong** for this codebase |
| Proposal [P] | contract v0.2 → v0.2.1: `selected_bank` is `int`, required, **always ≥ 0**; a `-1` in `selected_bank` is `INVALID` (it would prove the schema disagrees with the engine). Keep `active_bank = -1` (genuinely returnable by `ccActiveBank` **[V, CCM.cpp]**). Record that protocol §8(i) is inert and must not be counted as an exclusion path. |

### D2 — `bank_score_margin` is defined over all banks, but the router scores only candidates

| | |
|---|---|
| v0.2 claim | field 27: "top1−top2 of `Σ_{f∈cue} W[f][k]`" |
| Source | `bankScores()` computes over all `K` banks **[V, CCM.cpp:192–201]**, but `ccPreferredBank` applies `candidateMask(agent)` and only masked banks compete **[V, CCM.cpp:205–215]**. `candidateMask` = allocated banks when `route_over_allocated_only` **[V, CCM.cpp:177–190]**, and the harness never overrides it, so the default `true` applies **[V, CCM.h:61; harness sets no such field]** |
| Verdict | **An unmasked margin is not the margin the router used.** With 1 allocated bank the true "margin" is undefined (no runner-up), while an unmasked top1−top2 would report a number computed against banks that could not be selected. **[I]** this is a plausible-looking, wrong diagnostic — the worst kind. |
| Proposal [P] | `bank_score_margin := sc_(1) − sc_(2)` over the **candidate-masked** set; `NA:LT2_CANDIDATES` when fewer than 2 candidates. Add that code to the closed set. |

### D3 — `presented_ids` uses a placeholder token that v0.2 never defines

| | |
|---|---|
| v0.2 claim | invariant 10: "`selected_slot` is `NA:SINGLE_CANDIDATE` **iff** the trial is single-candidate (`presented_ids` contains exactly one non-`X` entry)" |
| Source | `presented` holds `-1` for unused channels on single-candidate trials (`if (s.presented[c] < 0) gain[c] = 0.0;`) **[V, CCM.cpp:257–260]**; `int sel = -1` is assigned only inside the non-single branch (`if (s.single) { … } else { … sel = sampled; }`) **[V, CCM.cpp:256–277]** |
| Verdict | **Two defects.** (a) There is **no `X` token** in v0.2's closed set (§2 lists `NA`, `NA:<code>`, `NM`, `MISSING`, `INVALID`) — the invariant references an undefined symbol. (b) Raw `-1` placeholders would violate type rule 1's ban on bare `-1`. |
| Proposal [P] | Define `NA:UNUSED_CHANNEL` for `presented_ids` entries that are absent on single-candidate trials, and replace `X` in invariant 10 with it. Writer maps `-1 → NA:UNUSED_CHANNEL`. |

### D4 — `rule_bank` cannot be computed from the cue alone (erratum to the L11.3 patch spec)

| | |
|---|---|
| v0.2 claim | field 22: `rule_bank` = "R-majority over the cue (new driver helper P7)" |
| L11.3 patch spec claim | `int intendedBankByRule(const std::vector<int>& cue);   // cue only — no task, no map`, plus verification assertion **V4**: "the function's argument list contains the cue only (no task index, no mapping)" |
| Source | Cue features are `int` ids in `[0, n_feat)`; group index = `f / 4`. **A group index is not a bank index.** `bank(g) = task_bank[g]`, and `task_bank` is produced by `ccAllocateNext` at run time **[V, harness:381, 404; CCM.cpp:163–172]**. Under reversed order `task_bank = [2,1,0]`. **[I]** |
| Verdict | **P7 as specified is not implementable.** It cannot resolve a tie "by lowest bank index" without the group→bank map. For non-tied cues the majority group is unique and the map is still needed to name a bank. So the map is required in every case, not only ties. |
| Consequences | L11.3's **V4 assertion is wrong** and would, if enforced, force a wrong implementation; the note "the cue only" conflates two different independence requirements. |
| Proposal [P] | Signature `int intendedBankByRule(const std::vector<int>& cue, const std::vector<int>& group_to_bank)`. Independence from the **task index** is what prevents defect S1 (the rule must not be able to read which task is being evaluated); independence from the **allocation map** is neither achievable nor required. Rewrite V4 as: "the signature contains no task index; the map argument is `res.task_bank` and is read-only". |

**[V]** This erratum does not weaken C4 — C4 requires the split fields, and the split
still holds. It corrects the L11.3 *specification of the helper*, which was never
applied to code.

### D5 — `Read` for `AMBIG11` is conditioned on task routing, not on rule compliance

| | |
|---|---|
| v0.2 claim | `AMBIG11` `READ = ✓` (eligibility table, line 192) |
| v0.2 metric definition | L11.3 §2.4: `Read = mean(correct \| routing_correct == 1)` |
| Interaction | For `AMBIG11` a rule-following model has `routing_correct = 0` on the trials where the tie-break points at the other bank. Those trials are **excluded** from `Read`'s denominator, and the model's accuracy on exactly the trials that matter is never averaged. **[I]** |
| Verdict | **Not an error, but an undocumented consequence.** `Read(AMBIG11)` answers "if the model picked the task's bank despite the tie, did it read correctly?" — a coherent question, but **not** "retrieval after following the rule". Under R4's C-d recommendation the second question needs `Read` conditioned on `rule_compliant`, which does not exist as a metric. |
| Proposal [P] | Either (i) record `Read_rule(A4) := mean(correct \| rule_compliant == 1)` alongside `Read_task(A4)`, or (ii) mark `Read(AMBIG11)` as `NA:NO_DEFINITION` and rely on `MAPCHECK`. Recommend **(i)**, which is consistent with R4's "report both, name distinctly" resolution. Owner decision **R4c**. |

### D6 — `advantage`'s baseline index is config-dependent

| | |
|---|---|
| v0.2 / L11.3 claim | `advantage = reward − reward_baseline[0]`, snapshotted before the call |
| Source | `const size_t bi = agent.cfg.baseline_per_bank ? bank : 0u;` **[V, CCM.cpp:487–490]**. Default `baseline_per_bank = false` **[V, CCM.h:69]**, and the harness never sets it **[V: no occurrence in `l10_validation_harness.cpp`]** → `bi = 0` today |
| Verdict | **Correct today, but by default rather than by contract.** If any arm ever sets `baseline_per_bank = true`, `reward_baseline[0]` is the wrong baseline and every `advantage` value is silently wrong. |
| Proposal [P] | The writer must read the same index the engine used: `bi = cfg.baseline_per_bank ? selected_bank : 0`, and record `baseline_index` as a column (or assert `baseline_per_bank == false` for the L11 config). Prefer recording the index — an assertion can be forgotten. |

### D7 — the router-update predicate is narrower than "unless the router updated"

| | |
|---|---|
| v0.2 claim | invariant 17: "`advantage` is `NM` unless the router actually updated on this trial" |
| Source | The update runs only when `learning_enabled && router_learning && mode == CC_LEARNED && forced_bank < 0` **[V, CCM.cpp:483]** |
| Verdict | The invariant is correct but underspecified for a writer. In particular `forced_bank >= 0` **suppresses the router update** even on a learning trial, so a forced-bank row must record `advantage = NM` even though learning was enabled. |
| Proposal [P] | v0.2.1 should state the predicate literally: `advantage` is numeric **iff** `phase != 0 && mode == CC_LEARNED && router_learning && forced_bank < 0`. |

### D8 — invariant 20 excludes a legitimate forced-bank diagnostic

| | |
|---|---|
| v0.2 claim | invariant 20: "`forced_bank` is numeric only for `call_purpose == forced_bank` calls" |
| Source | `per_bank_ctxoff` passes `force_eval_bank = kb` **and** `call_id = -1` **[V, harness:592]** (and `rows = nullptr`, so it emits no rows *today*) |
| Verdict | If L11 ever captures that sweep — which is the natural way to obtain `Null(t)` per bank — the row would have a numeric `forced_bank` with `call_purpose = NA`, violating invariant 20 on legitimate data. |
| Proposal [P] | widen to `{forced_bank, per_bank_off}`. |

### D9 — `update_mass_*` `NM` on evaluation rows matches the source

| | |
|---|---|
| v0.2 claim | invariant 18: `update_mass_*` are `NM` on evaluation rows, numeric on `LEARNING` rows |
| Source | `evalTask` calls `runCCTrial(..., /*learning=*/false, /*router_learning=*/false, ...)` **[V, harness:243–247]** |
| Verdict | **Consistent [V].** No change. Recorded as a positive verification. |

---

## 3. Verified-consistent items (no change proposed)

| Item | Evidence | Status |
|---|---|---|
| `sel_slot = -1` ⇔ single-candidate trial | `int sel = -1` (256) is only overwritten in the `else` (non-single) branch **[V, CCM.cpp:256–277]** | **correct** |
| `NA:SINGLE_CANDIDATE` never occurs on evaluation rows | evaluation schedule is all-pair: `makeLRTrials(cfg.lr, map, 0, 20, seed)` → 6×20 = 120 multi-candidate **[V, harness:507; RelevanceRouting.cpp:39–60]** | **correct**, and worth stating explicitly |
| `NA:SINGLE_CANDIDATE` **does** occur on training rows | training stream = 80 single + 40 pair per item = 480 + 240 **[V, harness:338–342]** | correct; must be stated |
| `queried == presented[intended_slot]` on multi-candidate trials | `out.queried = s.presented[map.phi[s.ctx]]` **[V, CCM.cpp:238]**, and `s.single` else-branch uses `id0/id1` **[V, CCM.cpp:236]** | **correct**, and correctly scoped by invariant 11 |
| diagnostic re-derivation calls emit no rows | lines 503–523 contain zero `push_back` **[V]** | correct |
| `record_class` separation is derivable from `call_id` | `next_call` returns `-1` when `!dump_rows` and records `"<purpose>,<task>,<kind>"` **[V, harness:322–326]** | correct; the writer can classify from `call_id` without guessing |
| `Null(t)` needs `forced_bank` | protocol §6's three forced cells | correct (gap G1 closed) |

---

## 4. What this review did and did not do

- **Verified against source:** every claim in §2 and §3 marked **[V]**. Files read:
  `ContextConditionedMemory.cpp/.h`, `l10_validation_harness.cpp`,
  `RelevanceRouting.cpp/.h`.
- **Not verified:** no binary was built, no run was performed, no row was
  produced. **No runtime behaviour is claimed.** Everything here is static source
  reading. **[V]** means "the code says this", never "the code was observed doing
  this".
- `--emit-l11` remains **unimplemented**; the v0.2 schema remains **unadopted**.
- Schema v0.2 and every L11.3 document are **byte-unchanged** by this milestone.
  The errata above are proposals for a later revision.

---

## 5. Errata summary (proposals only)

| # | Severity | One-line |
|---|---|---|
| D1 | **high** — describes an impossible state as real | `selected_bank` is always ≥ 0; `-1` must be `INVALID`; protocol §8(i) is inert |
| D2 | **high** — silent wrong diagnostic | `bank_score_margin` must be masked; add `NA:LT2_CANDIDATES` |
| D3 | medium — undefined token | define `NA:UNUSED_CHANNEL` for `presented_ids`; `X` is undefined |
| D4 | **high** — unimplementable as specified | P7 needs the group→bank map; L11.3's V4 assertion is wrong |
| D5 | medium — semantic gap | `Read(AMBIG11)` is task-conditioned; add `Read_rule` or mark `NA` (R4c) |
| D6 | medium — latent | `advantage` baseline index is config-dependent; record it |
| D7 | low — underspecified | state the router-update predicate literally |
| D8 | low — latent | invariant 20 must allow `per_bank_off` |
| D9 | none | consistent |
