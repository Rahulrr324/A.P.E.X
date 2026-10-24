# STARK-L11.5 — Schema v0.2 Audit Matrix (D1–D9)

**Method: static source inspection only.** No binary was compiled, no harness was
run, no trial row was produced. **Nothing in this document is a runtime
verification**, and no test is claimed to have passed. The one test that *has* been
executed in the L11 chain is the L11.3 schema validator's 32 self-tests against
synthetic rows (`work/l11_3_prototype/schema_v0_2_check.py`, exit 0) — that is a
property test of a Python validator, not of the C++ writer.

Subject: `stark/design/l11_trial_schema_v0_2.md`, sha256
`1ce1525b83f9c02a3f1d996ec2736b0d10fcc0beefe7c1b1362f886279d96ad8` (222 lines).
This milestone **does not modify it**; all corrections below are proposals for a
later v0.2.1.

Tags: **[V]** verified in source/file · **[C]** computed here · **[I]** inferred ·
**[P]** proposed · **[?]** unresolved.

---

## 0. Summary

| ID | L11.4 claim | Verified here | Severity | Runtime test still needed? |
|---|---|---|---|---|
| D1 | `selected_bank = -1` unreachable | **CONFIRMED** | high | yes (assert `min(selected_bank) ≥ 0` on a real file) |
| D2 | margin must be candidate-masked | **CONFIRMED** | high | yes (compare recorded margin vs recomputed) |
| D3 | `X` token undefined | **CONFIRMED**, and worse than reported | medium | no (static) |
| D4 | P7 requires the group→bank map; V4 assertion invalid | **CONFIRMED** | high | no (static); a unit test is required later |
| D5 | `Read(AMBIG11)` is task-conditioned | **CONFIRMED** | medium | no (definitional) |
| D6 | `advantage` baseline index is config-dependent | **CONFIRMED** | medium | yes (assert `baseline_per_bank == false`) |
| D7 | router-update predicate narrower than stated | **CONFIRMED** | low | yes (recompute `advantage` from a state dump) |
| D8 | invariant 20 excludes `per_bank_off` | **CONFIRMED** | low | no (static) |
| D9 | `update_mass_* = NM` on evaluation rows is consistent | **CONFIRMED** | none | — |

No L11.4 finding was **disproved**. Two were **understated** (D1, D3).

---

## D1 — `selected_bank = -1` is unreachable

| Field | Content |
|---|---|
| **Artifact** | `stark/design/l11_trial_schema_v0_2.md` — field 24 (line 98); type rule 1 (lines 141–146); invariant 13 (line 164); invariant 14 (line 165). Also `stark/design/l11_1_protocol.md` §8(i), lines 130–131 |
| **Requirement as written** | "`selected_bank` … `-1` = no bank selectable (**a real state**)"; invariant 14: "`selected_bank == -1` ⇒ `plastic_write == 0` and `update_mass_* == 0.0`"; protocol §8(i): a trial is invalid if `selected_bank == -1` |
| **Observed implementation [V]** | `ContextConditionedMemory.cpp:345–346`: `if (bank < 0 \|\| bank >= K) bank = 0;` then `out.bank = bank;`. Every branch that assigns `bank` is followed by this clamp: `CC_ORACLE` → `task_bank`; `CC_FROZEN` → `0`; `forced_bank >= 0` → `forced_bank`; `CC_UNIFORM_FALLBACK` → `0` or a candidate; learned path → sampled index or `ccPreferredBank`. `ccPreferredBank` itself returns `best < 0 ? 0 : best` (`:215`) |
| **Status** | **CONFIRMED — `CCResult::bank ∈ [0, K)` for all `K ≥ 1`.** The `-1` initialiser at `ContextConditionedMemory.h:101` is always overwritten |
| **Consequences** | (a) invariant 14 is **vacuous**; (b) invariant 13's `-1` clause is **dead**; (c) **protocol §8(i) can never fire** — it is an inert validity rule and must not be counted as an exclusion path in any run report; (d) the phrase "a real state" is factually wrong for this codebase |
| **Minimal correction [P]** | v0.2.1: `selected_bank` is `int`, required, **always ≥ 0**; a `-1` is `INVALID` (its presence would prove the schema disagrees with the engine); keep `active_bank = -1` (that one *is* returnable by `ccActiveBank`). Record that protocol §8(i) is inert |
| **Runtime test still required** | **yes** — assert `min(selected_bank) >= 0` over a real `trials11_*.csv`. Static proof is strong but a writer could emit a sentinel that the engine never produces |

---

## D2 — `bank_score_margin` must be candidate-masked

| Field | Content |
|---|---|
| **Artifact** | v0.2 field 27 (line 102): "top1−top2 of `Σ_{f∈cue} W[f][k]`" — no masking mentioned |
| **Requirement** | the recorded margin should be the margin the router actually used |
| **Observed implementation [V]** | `bankScores()` sums over **all** `K` banks (`ContextConditionedMemory.cpp:192–201`). `ccPreferredBank` then applies `candidateMask(agent)` and only masked banks compete (`:205–215`). `candidateMask` returns allocated banks when `agent.cfg.route_over_allocated_only` is true (`:177–190`), which is the default (`ContextConditionedMemory.h:61`) and is **never overridden by the harness** (`grep route_over_allocated_only l10_validation_harness.cpp` → no matches) |
| **Status** | **CONFIRMED.** An unmasked top1−top2 is not the router's margin. With one allocated bank there is no runner-up at all, yet an unmasked computation would report a number against banks that could not be selected |
| **Consequence** | a plausible-looking, systematically wrong diagnostic — the most dangerous class for a measurement milestone |
| **Minimal correction [P]** | `bank_score_margin := sc_(1) − sc_(2)` over the **candidate-masked** set; `NA:LT2_CANDIDATES` when fewer than 2 candidates. Add the code to the closed set in §2 |
| **Runtime test still required** | **yes** — recompute the masked margin from the dumped router weights and compare |

---

## D3 — the `X` token is undefined (and the type is wrong)

| Field | Content |
|---|---|
| **Artifact** | v0.2 field 28 (line 102): `` `presented_ids` \| semi \| required \| candidate identities in slot order; `X` for an empty slot ``; invariant 10 (line 161): "`presented_ids` contains exactly one non-`X` entry" |
| **Requirement** | a closed token set: §2 defines `NA`, `NA:<code>` (7 codes), `NM`, `MISSING`, `INVALID`. **`X` is not among them** |
| **Observed implementation [V]** | `presented` holds `-1` for unused channels on single-candidate trials: `if (s.presented[c] < 0) gain[c] = 0.0;` (`ContextConditionedMemory.cpp:257–260`); `out.queried = s.presented[map.phi[s.ctx]]` (`:238`) |
| **Status** | **CONFIRMED, and understated in L11.4.** Two defects, not one: (a) `X` is undefined in the closed set; (b) the field type is `semi` (`;`-joined **ints**), which cannot hold a token at all. Additionally, invariant 11 (`queried == presented_ids[intended_slot]`) has undefined indexing semantics once `X` appears |
| **Minimal correction [P]** | define `NA:UNUSED_CHANNEL`; change the type from `semi` to `semi` **of tokens** (i.e. each element is an int or `NA:UNUSED_CHANNEL`); rewrite invariant 10 to "exactly one entry that is not `NA:UNUSED_CHANNEL`"; state that `intended_slot` indexes positionally into the token list and that it must not index a `NA:UNUSED_CHANNEL` entry on a multi-candidate trial |
| **Runtime test still required** | no (static), but the validator must be extended — it currently accepts only pure-int `presented_ids` |

**Additional finding D3a [V]:** the evaluation schedule is **all-pair**
(`makeLRTrials(cfg.lr, map, 0, 20, seed)` → 6 × 20 = 120 multi-candidate trials,
`l10_validation_harness.cpp:507`; `RelevanceRouting.cpp:39–60`), so
`NA:UNUSED_CHANNEL` **cannot occur on evaluation rows**. It **does** occur on the
training stream (80 single + 40 pair per item = 480 + 240, harness `:338–342`), i.e.
**two thirds of training rows**. The schema should say this explicitly; it currently
says nothing about where the token is expected.

---

## D4 — P7 cannot be computed from the cue alone

| Field | Content |
|---|---|
| **Artifact** | v0.2 field 22 (line 99) `rule_bank`; L11.3 patch spec §2.6 and verification assertion **V4** (`work/L11_3_IMPLEMENTATION_PATCH_SPEC.md`): *"the function's argument list contains the cue only (no task index, no mapping)"* |
| **Requirement** | `rule_bank` = the bank prescribed by R-majority, ties by lowest bank index |
| **Observed implementation / data [V]** | cue features are `int` ids in `[0, n_feat)`; the group of a feature is `f / 4` (`VTask::signature`, harness `:91`, `b = 4 * t` at `:97`). **A group index is not a bank index.** The group→bank map is `res.task_bank`, produced at run time by `ccAllocateNext` (`ContextConditionedMemory.cpp:163–172`) and assigned at `l10_validation_harness.cpp:404`. Under a reversed order it is `[2,1,0]`. `first_feature_group` — the function named in protocol §6 — **exists nowhere in the source** (`git grep` → documentation only) |
| **Status** | **CONFIRMED. P7 as specified is not implementable.** The map is required even when the majority is unique (to *name* the bank), not only to break ties |
| **Consequence** | L11.3's V4 assertion is **wrong** and, if enforced, would force a wrong implementation or a fabricated bank identity |
| **Minimal correction [P]** | signature `int intendedBankByRule(const std::vector<int>& cue, const std::vector<int>& group_to_bank)`. Independence from the **task index** is the property that prevents defect S1; independence from the **allocation map** is neither achievable nor required. Rewrite V4 as: "the signature contains no task index; the map argument is `res.task_bank`, passed read-only". Add `first_feature_group` to the protocol's glossary or replace it with the arithmetic `f / 4` |
| **Runtime test still required** | **yes**, later — the protocol §11 exactness unit test (enumerate all `CROSS21`/`CROSS31` cues and compare with the rule table) has **never been executed**; it cannot run until the arms exist |

---

## D5 — `Read` for `AMBIG11` is task-conditioned

| Field | Content |
|---|---|
| **Artifact** | v0.2 §5 eligibility table (line 192): `AMBIG11` → `READ = ✓`; L11.3 §2.4: `Read = mean(correct \| routing_correct == 1)` |
| **Requirement** | a rule-following model on A4 must not have its informative trials dropped from a reported metric without that being stated |
| **Observed behaviour [V]** | `routing_correct = 1[selected_bank == task_bank]` (v0.2 invariant 5). On A4, the tie-break bank differs from the task bank on ~50 % of trials **[C]**, so those trials have `routing_correct = 0` and leave `Read`'s denominator |
| **Status** | **CONFIRMED** as a semantic gap, not an arithmetic error. `Read(A4)` is well defined; it answers a different question from the one A4 was created to ask |
| **Minimal correction [P]** | either add `Read_rule(A4) = mean(correct \| rule_compliant == 1)` alongside `Read`, or mark `Read(A4)` as `NA:NO_DEFINITION`. **Recommend the former** (R4c) |
| **Runtime test still required** | no (definitional) |

---

## D6 — `advantage` baseline index is config-dependent

| Field | Content |
|---|---|
| **Artifact** | v0.2 field 44 / invariant 17: `advantage = reward − baseline_before[0]` |
| **Observed implementation [V]** | `ContextConditionedMemory.cpp:487`: `const size_t bi = agent.cfg.baseline_per_bank ? static_cast<size_t>(bank) : 0u;` — the engine reads index `bank` when `baseline_per_bank` is true, index `0` otherwise |
| **Config state [V]** | `baseline_per_bank = false` default (`ContextConditionedMemory.h:69`); the harness never sets it (`grep` → no matches). So `bi = 0` **today** |
| **Status** | **CONFIRMED as a latent defect.** "Index 0" is correct by *default*, not by *contract* |
| **Consequence** | any future arm that sets `baseline_per_bank = true` would make every recorded `advantage` silently wrong, with plausible magnitudes |
| **Minimal correction [P]** | record `baseline_index` as a column and have the writer use the same expression as the engine; alternatively assert `baseline_per_bank == false` for the L11 config. **Prefer recording the index** — an assertion can be forgotten |
| **Runtime test still required** | **yes** — assert the recorded index equals the engine's and recompute `advantage` from a pre-call dump |

---

## D7 — router-update predicate is narrower than "unless the router updated"

| Field | Content |
|---|---|
| **Artifact** | v0.2 invariant 17: "`advantage` is `NM` unless the router actually updated on this trial" |
| **Observed implementation [V]** | `ContextConditionedMemory.cpp:483`: `if (learning_enabled && router_learning && mode == CC_LEARNED && forced_bank < 0) {` … `}` |
| **Status** | **CONFIRMED.** The invariant is true but underspecified. In particular `forced_bank >= 0` **suppresses the router update even on a learning trial**, so such a row must carry `advantage = NM` despite learning being enabled |
| **Minimal correction [P]** | state the predicate literally: `advantage` is numeric **iff** `phase != 0 && mode == CC_LEARNED && router_learning && forced_bank < 0` |
| **Runtime test still required** | **yes** — recompute `advantage` on a forced-bank learning row and assert `NA`/`NM` |

---

## D8 — invariant 20 excludes a legitimate forced-bank diagnostic

| Field | Content |
|---|---|
| **Artifact** | v0.2 invariant 20 (line 172): "`forced_bank` is numeric only for `call_purpose == forced_bank` calls" |
| **Observed implementation [V]** | the `per_bank_ctxoff` sweep calls `evalTask(..., call_id = -1, force_eval_bank = kb)` (`l10_validation_harness.cpp:592`), passing `rows = nullptr` so it emits nothing **today** |
| **Status** | **CONFIRMED as a latent defect.** Capturing that sweep is the natural way to obtain `Null(t)` per bank, and doing so would violate the invariant on legitimate data |
| **Minimal correction [P]** | widen to `call_purpose ∈ {forced_bank, per_bank_off}` |
| **Runtime test still required** | no (static) |

---

## D9 — `update_mass_* = NM` on evaluation rows is consistent

| Field | Content |
|---|---|
| **Artifact** | v0.2 invariant 18: "`update_mass_*` are `NM` on evaluation rows (learning is disabled) and numeric on `LEARNING` rows" |
| **Observed implementation [V]** | `evalTask` calls `runCCTrial(..., /*learning=*/false, /*router_learning=*/false, force_eval_bank)` (`l10_validation_harness.cpp:243–247`) |
| **Status** | **CONFIRMED CONSISTENT.** No change proposed |
| **Runtime test still required** | no |

---

## Independent re-verification of the other L11.4 structural claims

These were asserted in L11.4; each is re-checked here against the current tree.

| Claim | Re-check | Verdict |
|---|---|---|
| 8 `dump_rows` call sites, one of which passes `nullptr` | `grep -c "dump_rows ? &res.rows : nullptr"` = **8**; the `nullptr` site is `:592` | **confirmed** |
| the re-derivation block emits no rows | lines 503–523 contain **zero** `push_back` | **confirmed** |
| capture block ends before the restore | `if (rows)` ends at `:272`; `ccDeserialize` at `:274` | **confirmed** |
| `next_call` encodes purpose and returns `-1` when rows are off | `:322–326` | **confirmed** |
| evaluation routing is a deterministic masked argmax | `:342` → `ccPreferredBank` (no RNG anywhere in the path) | **confirmed** |
| the router update is gated by four conditions | `:483` | **confirmed** |
| `sel_slot = -1` ⇔ single-candidate trial | `int sel = -1` at `:256`, overwritten only in the `else` branch `:258–277` | **confirmed** |
| evaluation schedule is all-pair, 120 trials | `:507`, `RelevanceRouting.cpp:39–60` | **confirmed** |
| training stream is 480 single + 240 pair | `:338–342` (80 single + 40 pair per identity × 6) | **confirmed** |

---

## What this audit did not do

- It did not compile anything, run the harness, or produce a row.
- It did not modify the schema, the protocol, or any source file.
- It did not re-run the L11.3 Python validator; its 32/32 result stands as recorded
  but is a property test of the validator, not of the writer.
- **No runtime behaviour is claimed anywhere in this document.**
