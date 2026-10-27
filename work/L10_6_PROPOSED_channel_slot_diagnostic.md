# STARK-L10.6 — Proposed Diagnostic: Per-Trial Channel-Slot Attribution

**Status:** **PROPOSED / NOT EXECUTED.**
**Type:** diagnostic protocol proposal, not a criterion and not an experiment.
**Date:** 2026-10-24
**Registration:** none — this document is not registered and authorises nothing.
**Parent question:** the one-trial discrepancy at `(seed 218213831, task 1,
forced bank 2)`, reported by L10.4 and carried unresolved through L10.5.
**Authorisation required:** an explicit owner or maintainer instruction to run
it. This proposal deliberately does **not** authorise itself.

---

## 1. The precise question

> In the forced-bank sweep with the cue removed, when a bank answers a trial
> "correctly" against a task whose permutation has **no** fixed point with that
> bank's permutation, which of the following produced the answer:
> (a) the **retrieved identity** differed from the intended identity because the
> channel-attention policy selected a different presented slot, or
> (b) the **readout** from the correct identity produced a different action
> because the decision-window spike-count majority (or its tie-break) deviated?

Nothing else. This is an attribution question about one class of rare trial; it
is not a re-evaluation of L10 and it cannot change any L10 outcome.

## 2. Why the existing evidence cannot answer it

| Fact | Consequence |
|---|---|
| `runStream` calls `evalTask(..., rows = nullptr)` for the per-bank sweep, so the sweep emits **only** `ctxperbank_*.csv` with one aggregate accuracy per (task, bank) | the deviating trial cannot be located at all |
| `TrialRow` records `queried, choice, bank, correct, …` but **no selected channel slot** and **no retrieved identity** | even the evaluation rows that do exist cannot distinguish (a) from (b) |
| The readout is a spike-count majority with earliest-spike and seeded tie-breaks (`ContextConditionedMemory.cpp` §7), not a deterministic table lookup | a readout deviation is physically plausible and not observable in the current record |

Recorded consequence: the anomaly is **unresolved** and stays so unless this or an
equivalent diagnostic is authorised.

## 3. What the diagnostic would add (no behaviour change)

A single opt-in instrumentation flag on the harness, off by default, that adds
four columns to the emitted trial rows **for the forced-bank sweep only**:

| Column | Meaning |
|---|---|
| `sel_slot` | the channel slot the attention sample selected on that trial |
| `intended_slot` | `map.phi[s.ctx]`, the slot the schedule intended |
| `retrieved_id` | the identity actually driven into the bank on that trial |
| `counts_top2` | the top two decision-window spike counts and the tie-break branch taken |

With these, each deviating trial is classified mechanically:

- `sel_slot != intended_slot` ⇒ **channel-attention mis-selection** (mechanism a);
- `sel_slot == intended_slot` and `retrieved_id == queried` ⇒ **readout deviation**
  (mechanism b);
- neither ⇒ a third mechanism, which would be a genuinely new finding.

## 4. Minimal scope and non-invasiveness

- Additive only: a new `bool emit_slot_trace` on `StreamSpec`, default `false`, and
  four extra CSV columns. The flag is **off** unless explicitly passed, so every
  registered protocol and every frozen artifact is byte-reproducible by
  construction.
- **Not** permitted in this protocol: changing thresholds, the readout, the
  router, the task construction, the seeds, or any historical artifact.

## 5. Proposed evaluation (exploratory; no pass/fail)

- Seeds: the three primary masters **plus** the four exploratory seeds, to raise
  the number of observed forced-bank trials from 3,240 to 7,560.
- Arms: the frozen CCM configuration only. No new mechanism.
- Metrics: per-deviating-trial classification; the total deviation rate per
  mechanism with a Wilson interval; the diagonal (bank k / task k) slip count as
  the low-noise reference.
- **No criterion.** This diagnostic informs mechanism hygiene; it cannot pass or
  fail anything, and no L10 result may be revised because of it.

## 6. Predicted outcome and what would refute it

The L10.4/L10.5 working hypothesis is that a rare per-trial deviation (either
mechanism) produced one coincidental match out of ~3240 forced-bank trials, with
≈1/6 chance of matching by coincidence. If authorised, the diagnostic should
find the deviating trial and place it in one of the two classes.

**It would refute the hypothesis** if the deviating trial shows the correct
channel slot, the correct retrieved identity, and a decision-window majority for
the wrong action — i.e. a readout error that the scoring then failed to catch —
or if no deviation can be found at all in the larger sample (which would suggest
the single event is rarer than the current evidence suggests, not that it did not
happen).

## 7. Non-authorisation clause

This document records a proposal only. No file in the repository has been
modified to execute it, no run has been performed, and the anomaly remains
**UNRESOLVED** in every L10.6 deliverable. Executing it requires a separate,
explicitly authorised task and its own protocol registration with a frozen hash
before the first run.
