# L10.5 — Owner Decision Record: Milestone Closure

**Date:** 2026-10-24
**Type:** Governance / specification decision artifact. **Not** an implementation task.
**Authority:** repository owner (`Rahulrr324`). The acceptance specification
(`stark/design/context_conditioned_memory_milestone.md`) §8 contains no delegation
clause, and its own §13 (v1.7 entry) states: *"Any future change to §8 must be
recorded the same way, with an owner decision, in a new version — never edited in
place."* No agent, tool or report may close a criterion or amend §8.
**Milestone:** STARK-L10.5 — owner-governed milestone closure.
**Status of every decision below: `PENDING`.** No closure decision has been
authorised. Nothing in this record is in force.

---

## 0. What is being asked

Three decisions, recorded **separately**. They are not bundled, and no answer to
one implies an answer to another. Each is a pure *governance* act: none changes a
threshold, a metric, a measured value or a pass/fail outcome. Each changes only
whether a criterion's already-recorded outcome is treated as **final** for the
milestone.

| ID | Subject | Recommendation | Status |
|---|---|---|---|
| **A** | L10-E (context) | retain the historical **FAILED** result and formally close the criterion | **PENDING** |
| **B** | L10-F (sealing ablation) | record the historical **FAILED** result as **superseded and closed** by L10-F2 | **PENDING** |
| **C** | L10-G (capacity, confounded arm) | record the historical **PASS** as **superseded** by L10-G2, preserving the result and the confound disclosure | **PENDING** |

Until all three are authorised, **L10 remains formally OPEN** even though every
experiment has been run and every criterion has a recorded outcome.

## 1. Facts common to all three decisions

| Fact | Value | Source |
|---|---|---|
| L10-E threshold | shuffled-cue ≤ 0.40 **and** context-off ≤ 0.40 — unchanged since v1.6 | `context_conditioned_memory_milestone.md` §8 |
| L10-E measured | shuffled **0.132407**, context-off **0.425926** → **FAILED** | re-derived for this record from `work/l10_raw/official_evaluation_20261024/K1/metrics_*.csv` (9 rows) |
| L10-K1 official | **PASS** (CAA 0.5185 / 0.5917 / 0.6296; CRA 0.6667 each seed) | `work/L10_4_OFFICIAL_EVALUATION.json`; evidence `work/l10_raw/official_evaluation_20261024/` |
| L10-F | **FAILED** — NO-SEAL ≡ CCM under v1.0 (zero sealing opportunities at `commit_trials = 480` by construction) | `work/l10_raw/spec_ratification_20261024/` |
| L10-F2 | **PASS** (owner ratification A-1, 2026-10-24) | `stark/reports/L10_2_OWNER_DECISION.md` |
| L10-G | **PASS**, but on a **confounded** arm (K2-STRESS conjoined capacity with unseal-on-reuse) | `work/L10_1_CONTROL_VALIDATION.md` §C table, "confounded" |
| L10-G2 | **PASS** with the confound removed (`--reuse-seal 0`) (owner ratification A-3, 2026-10-24) | `stark/reports/L10_2_OWNER_DECISION.md` |
| Evidence integrity | L10.4 manifest **129/129**, L10.3 manifest **245/245** verified | this record, §5 |

---

## Decision A — L10-E

**Options put to the owner.**

1. **Retain the original L10-E failure and formally close the criterion as a
   historical result.** *(recommended)*
2. Keep L10-E unresolved and leave L10 open.
3. Another disposition, with its implications explained.

**Recommendation: option 1 — retain and close, changing nothing.**

**What closing would and would not do.**

- *Would:* record L10-E's outcome as final for the milestone, so that L10 can be
  closed without re-opening it; keep the criterion, its text, its 0.40 threshold,
  its metric, its measured 0.425926 and its **FAILED** status exactly as they
  stand, permanently visible in §8 and §13.
- *Would not:* change the threshold; change the metric; convert the result to
  PASS; delete the failure; or imply that context is unnecessary.

**Why retention rather than resolution is the honest option.** The context-off
half of L10-E does not measure what its own hypothesis (H3) claims. With the cue
withheld, every router score is exactly 0.0, the strict-argmax tie-break selects
the lowest allocated bank (bank 0 in every seed), and the scored quantity reduces
to the **fixed-point agreement between the fallback bank's random permutation and
each task's permutation**. That was derived analytically and confirmed to zero
deviation on all nine cells (`work/L10_3_CONTEXT_CONTRIBUTION.md` §4–§5). Its
expected pooled value is 4/9 = 0.4444 and its attainable range is [1/3, 1], so a
**flawless** router passes the ≤ 0.40 threshold only **15.12 %** of the time.

Two things follow, and they must not be confused:

- the criterion is **not a valid instrument** for detecting context use;
- the **result is nonetheless a real result** — the system as built does produce
  0.425926 under the frozen v1.6 protocol, and that is what L10-E recorded.

Closing the criterion as a historical failure acknowledges both. It is not a
claim that the model passed, and not a claim that context is unnecessary: the
separately registered **L10-K1** shows the opposite — context contributes
**CAA 0.5799** over a measured context-ignoring null, **CRA 0.6667** (= the 1−1/K
ceiling) on every seed, and the v1.6 supplement **L10-E2** (per-task context
margins ≥ 0.60 on ≥ 2 of 3 tasks) also passes on all three seeds.

**Explicitly not claimed.** The failure does not demonstrate that context is
unnecessary; it demonstrates that this particular measurement, on this task
construction, is dominated by the permutation draw. Conversely, L10-K1's pass
does not retroactively make L10-E a pass — that separation is already normative
in §8 (v1.7) and would survive closure unchanged.

**Implication of option 2 (leave open).** L10 would remain permanently open on a
criterion that no mechanism change can satisfy, and the project would carry an
unclosable milestone — the state L10.4 was created to avoid.

---

## Decision B — L10-F

**Options put to the owner.**

1. **Mark the original L10-F failure as superseded and closed by L10-F2, while
   preserving the historical failure.** *(recommended)*
2. Keep L10-F unresolved and leave L10 open.
3. Another disposition, with its implications explained.

**Recommendation: option 1.**

**Evidence.** Under the v1.0 protocol, evaluation occurs at `commit_trials = 480`
— exactly the length of the phase-1 mapping-credit window — so **no trial ever
presents a sealing opportunity**: the sealing predicate is never exercised and the
NO-SEAL arm is field-for-field identical to CCM. L10-F therefore failed *by
construction*, not by measurement: "NO-SEAL mean forgetting > CCM mean forgetting"
was unsatisfiable, with 0 opportunities on every seed. L10.1 diagnosed this; L10.2
registered `SEAL-PAIR` (`commit_trials = 240`, matched arms differing only in
`cfg.seal_superseded`), the owner ratified it as **A-1**, and it **passed** on all
four pre-registered conditions on all three masters (sealed forgetting 0.0000 vs
unsealed 0.4509 pooled; 185 opportunities, 185 blocked, 184 executed; |ΔW| into
sealed banks exactly 0).

**What closing would and would not do.**

- *Would:* record that L10-F's requirement is now carried by L10-F2, which passed
  on its own registered evidence; keep the original FAILED row and its reason
  (zero opportunities) visible for good.
- *Would not:* delete the failure, relabel it a pass, or alter L10-F2.

**Governance note.** A-1 ratified *what replaces the protocol*, it did not
authorise an agent to declare the original criterion closed. Superseding a
criterion in the acceptance record is a distinct act and needs this decision.

---

## Decision C — L10-G

**Options put to the owner.**

1. **Record the historical L10-G result as superseded by the approved L10-G2
   evaluation, preserving the original result and the confound disclosure.**
   *(recommended)*
2. Leave both L10-G and L10-G2 recorded as-is with no supersession note.
3. Another disposition, with its implications explained.

**Recommendation: option 1.**

**Current recorded disposition (verified, not assumed).** L10-G is recorded as
**PASS** on an arm that L10.1 diagnosed as **confounded**: the K2-STRESS
exhaustion branch both *reuses* a bank **and** *un-seals* the others, so two
interventions were varied in one arm (`work/L10_1_CONTROL_VALIDATION.md` §C). The
L10.2 report annotates the row as "historical, confounded arm; superseded in
practice by L10-G2", but that is report prose — **no owner decision has recorded
a supersession**, and §8 still lists the original L10-G rule.

**Evidence for the replacement.** A-3 (owner, 2026-10-24) ratified running the
capacity arm with `--reuse-seal 0` so that the arm varies capacity only, with the
original decision rule unchanged ("K2 worse than CCM on forgetting or final
average"). **L10-G2 PASSED**: K2 final 0.6361 / forgetting 0.2713 vs CCM 1.0000 /
0.0000. The capacity effect is real and does not depend on the unseal-on-reuse
quirk.

**Note on the direction of this decision.** Unlike A and B, the historical result
here is a PASS. Superseding it is a **strengthening**, not a weakening: the
original PASS was produced by an arm that could not isolate capacity, and the
replacement PASS was produced by an arm that can. Preserving the original result
and its confound disclosure alongside the replacement is what keeps the record
honest.

---

## 2. Approval record

| Field | Value |
|---|---|
| Decision A (L10-E) | **PENDING** |
| Decision B (L10-F) | **PENDING** |
| Decision C (L10-G) | **PENDING** |
| Decided by | — (repository owner only) |
| Date | — |
| Recorded by | engineering (Arena cloud agent) — drafted the options; approved nothing |
| Agent authority | **none.** The agent has not inferred authorisation from the A-1/A-3 ratifications, from the L10.3 Option B decision, or from any earlier engineering recommendation |
| Effect until decided | L10-E stays **FAILED**; L10-F stays **FAILED**; L10-G stays **PASS on a confounded arm**; §8 stays at **v1.7**; **L10 remains OPEN** |

**What a decision would trigger.** On an explicit answer for each item, this
table is filled in verbatim, the corresponding change is made to the **proposed**
v1.8 document (`stark/design/context_conditioned_memory_milestone_v1_8_proposal.md`),
and — only then — that text is promoted to the authoritative
`context_conditioned_memory_milestone.md` v1.8 with the approval authority
recorded. No criterion outcome changes at any step.

## 3. Provenance of this record

- Branch `validation/l10-5-milestone-closeout`, created from the verified L10.4
  head `aed9c304cdadf6b855d682bf5dfbbc811eab8dcf` (local == remote).
- No experiment was run for this record. Every number above is cited from
  committed evidence, and the L10-E figures were re-derived from the L10.4
  metrics artifacts rather than copied from a report.
- This record quotes no owner answer, because none has been given.
