# Batch Y offline scoring rubric

**Status: frozen before execution.** This file and `dataset.js` were written before the
first A/B scenario ran, and the scenario answers were not inspected while it was written.
If a predicate turns out to be unmeasurable, that is reported as a limitation; the rule is
not rewritten to fit an observed answer.

## What is being compared

* **A** - context assembly from `d9cd504`, the parent of the Batch X commit `8814589`,
  reconstructed in an isolated copy (working tree untouched).
* **B** - the current tree, i.e. the same code with Batch X's world-state projection.

Both conditions run the *same* seeded stores, the *same* questions, the *same* fixed clock,
the *same* retrieval limits and context budgets, and the *same* deterministic stub backend.
The stub returns a fixed string per scenario, so **model reasoning is a constant, not a
variable**: any difference in what APEX assembles or discloses is attributable to context
assembly, not to a better or worse "thinker". Nothing here measures real inference.

Captured per (condition, scenario): the exact system prompt and user prompt sent to the
stub, `operation.prompt` (retrieved record ids, projection state, truncation), operation
status and verification status, APEX's user-facing output, the raw store bytes before and
after the request, and per-store read/parse counters.

## Criteria and deterministic predicates

A criterion is scored `PASS`, `FAIL` or `N/A` (not applicable to that scenario). Only the
scenario's declared `applies` list is scored; `expectedDisclosure` says what the store state
actually contains, so a criterion cannot pass by accident.

| # | Criterion | PASS requires | FAIL when |
|---|---|---|---|
| 1 | **Fact preservation** | every `mustShowIds` alias is retrieved (`operation.prompt` ids) *and* its stored text (or its clamped prefix) appears in the prompt | a seeded answering record is absent from the prompt |
| 2 | **Conflict disclosure** | the store holds an unresolved disagreement *and* APEX's own assembly carries a disagreement statement about it - a per-record conflicting/contested marker or a whole-store projection line - *and* the user-facing output repeats the unresolved-conflict notice | the disagreement exists in the store and APEX's context and output present the retrieved slice as if it were the whole picture (stub prose claiming "no conflict" is not counted for either side) |
| 3 | **Evidence distinction** | a claim with no recorded evidence is labelled unevidenced/unconfirmed in the prompt, or the assembly states a missing-evidence count | the record reaches the prompt as an ordinary supported fact with no gap stated |
| 4 | **User decisions** | a recorded user resolution appears as a *decision* ("chosen", "recorded decision", "not proof") and the other claim stays stored | APEX's own text presents the chosen claim as verified or objectively true |
| 5 | **Retraction handling** | no `mustNotShowText` (superseded/retracted wording) appears anywhere in the prompt *and* the store's superseded/retracted history is counted where APEX controls the text | retired claim text reaches the model, or the retirement is invisible |
| 6 | **Unknown handling** | the question's answer is genuinely absent *and* APEX's context/output never asserts the invented value as stored, never converts "not stored" into "does not exist"/"certainly not a concern" | an invented value reaches the prompt as evidence, or absence is stated as disproof |
| 7 | **Damage disclosure** | a store that cannot be read is described as unreadable/damaged (or the projection as unavailable), and "empty" is said only when the store genuinely is empty | damage or an unreadable projection is rendered as an empty, healthy picture |
| 8 | **Privacy** | no private record's *content* appears in the prompt or output; its id/existence may be counted | private wording reaches the model or the user transcript |
| 9 | **Context integrity** | the prompt stays within `maxContextChars`, and when trimming occurs the answering records survive and any omission is stated rather than silent | the prompt exceeds its budget, or content is dropped with no disclosure |

## Aggregating to a practical-impact verdict

Per scenario: `delta = (# criteria B passes and A fails) - (# criteria A passes and B fails)`,
counted only over applicable criteria.

* **Improved** - positive deltas and no negative delta.
* **Neutral** - no nonzero delta anywhere (same behaviour, different cost).
* **Mixed** - at least one positive and at least one negative delta.
* **Regressed** - negative deltas and no positive delta.

Cost is reported separately from behaviour: a longer prompt, more store reads, or higher
assembly latency is never scored as a better answer, and a small sample of scenarios is
never described as statistically significant. Application-level correctness is scored here;
the quality of any real model's use of this context remains untested and is reported as such.
