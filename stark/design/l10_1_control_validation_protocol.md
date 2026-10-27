# STARK-L10.1 — Experimental Control Repair: pre-registered protocol

**Version:** v1.0
**Written:** 2026-10-25, before any L10.1 experiment was run.
**Status:** frozen on commit of this file. Any later change is a new version
(v1.1, …) appended to §9 with its motivation and the run id that preceded it.

This protocol governs the L10.1 milestone. It does **not** replace, amend or
reinterpret the frozen L10 protocol
(`stark/design/context_conditioned_memory_milestone.md`, v1.0 protocol, v1.6
mechanism), and it changes no L10 threshold, metric definition, evaluation
distribution or historical result.

---

## 1. Tracks

Every experiment in L10.1 belongs to exactly one track. Results from different
tracks are never pooled and never substituted for one another.

| Track | Purpose | May it change L10 verdicts? |
|---|---|---|
| **P-FROZEN** | Reproduce the frozen L10 protocol unchanged | No — it can only *confirm* or *contradict* the published numbers |
| **D-SEAL** | Corrected diagnostics for the sealing ablation (L10-F) | No — L10-F stays failed until the frozen criterion is met or an owner-approved amendment exists |
| **D-CTX** | Corrected diagnostics for the context-off control (L10-E) | No — L10-E stays failed; 0.40 is not lowered |
| **D-CTRL** | Audit of the remaining controls (confounding, interpretability) | No — findings are documented, not "fixed away" |
| **E-GEN** | Exploratory generalisation tests | No — never evidence for an L10 criterion |

The frozen L10 report (`work/dev_context_conditioned_memory_report_STARK-L10-1.{md,json}`),
its raw artifacts (`work/l10_raw/final_run/`, `determinism/`, `l9_reproduction/`,
`protocol_v1.0_engineering_run/`) and the L10 independent-validation evidence
(`work/l10_raw/independent_validation_20261024/`) are **read-only** for this
milestone. All new artifacts go to `work/l10_raw/control_validation_20261025/`.

## 2. Frozen references used for comparison

| Item | Value |
|---|---|
| Audited milestone commit | `49cc6ba18650c0d9614bb9e8918fe65453ec5a02` |
| Validation commit (branch base) | `123ef65a6ad200dfafb4ce736f7ed94260267898` |
| Frozen protocol | `context_conditioned_memory_milestone.md` v1.0, mechanism v1.6 |
| Frozen seeds | `123456789`, `218213831`, `171473193` |
| Frozen task/bank configuration | 3 tasks, 3 banks, 720 learning trials/task, `commit_trials = 480`, 20 probe trials/bank, `explore_eps = 0.2`, `theta_alloc = 0.5` |
| Frozen evaluation | 120 trials/task (20 per identity), learning off, snapshot/restore |
| Frozen criteria | L10-A…L10-J as published (unchanged) |
| Frozen L10-E threshold | context-off mean ≤ 0.40 **and** shuffled-cue mean ≤ 0.40 |
| Frozen L10-F criterion | NO-SEAL mean forgetting > CCM mean forgetting |
| Pre-registered supplement | L10-E2 (per-task context margin ≥ 0.60 on ≥ 2 of 3 tasks) |

## 3. P-FROZEN — reproduction contract

1. Rebuild the L10 driver from the exact tree of the working branch.
2. Run the full 8-arm × 3-seed evaluation twice.
3. Accept the run as reproducing iff, after removing the wall-clock fields
   (`env`, per-seed `seconds`), the normalized JSON hash equals the value
   produced by the *same source* in the previous milestone
   (`5554710d…` pre-fix / `fe76eb2a…` post-fix), and the `criteria` block is
   unchanged.
4. Exit codes and assertion totals of the canonical suites are recorded; a test
   that cannot run (Windows-only `test_phase1_affinity`) is reported as
   **not executed**, never as passing.

Telemetry resolution is **1 µs** and stdout/stderr ASCII for control characters
only (see §7).

## 4. D-SEAL — corrected sealing diagnostics

### 4.1 The property under test

Sealing (`cfg.seal_superseded = true`) is supposed to prevent plastic writes to
a bank that has been superseded. In the code the only consumer of the seal flag
is the `writable` predicate in `runCCTrial`:

```
writable = (bank_state[bank] == CC_ACTIVE)
        || (!seal_superseded && bank_state[bank] != CC_UNALLOCATED)
mapping_credit = single_candidate && writable
```

so sealing can only matter on a trial that is (a) single-candidate and (b)
routed to a non-active, already-allocated bank. Call such a trial a **sealing
opportunity**. L10.1 measures the opportunity count explicitly rather than
inferring it.

### 4.2 Why the frozen protocol cannot test the property

Pre-declared and to be verified independently from trial records: the frozen
protocol contains zero sealing opportunities, because single-candidate mapping
credit exists only while the bank is writable, and non-active banks are never
selected unforced inside the commitment window. If the count is zero, the
frozen NO-SEAL arm is *analytically identical* to CCM and L10-F is untestable as
written, not merely negative.

### 4.3 Corrected protocols (matched pairs)

Two independent opportunity generators. In each, the **only** difference
between the two arms is `seal_superseded`.

**D-SEAL-A — `short-commit`.** Identical to the frozen protocol except
`commit_trials = 60` (frozen: 480). Rationale: the commitment window is
architecture-supplied scaffolding that hides routing error; shortening it lets
the *unmodified* mechanism produce unforced trials on banks that are still
being written. Declared as a protocol variant, applied identically to both arms.

**D-SEAL-B — `misroute-stress`.** Identical to the frozen protocol (including
`commit_trials = 480`) except that, during learning, with probability
`p = 0.15` the trial's cue is drawn from a *different* task (declared context
corruption, seeded independently of the arm). Rationale: this is the failure
mode sealing exists for — an occasional mis-routed context — and it is applied
identically to both arms, so the difference between arms remains exactly the
sealing toggle.

Both variants keep matched: seeds, task permutations, cue assignment for
non-corrupted trials, initialisation, learning budget, probe schedule,
evaluation schedules, and evaluation conditions.

### 4.4 Metrics (per arm, per seed, and pooled)

- acquisition per task; final retention per task; final average; mean forgetting;
- **opportunities**: single-candidate learning trials with `bank != active`;
- **executed writes on non-active banks** (weight change on those banks);
- **blocked writes**: opportunities where `plastic_write == false`;
- unintended update mass (bank-level), as in the frozen protocol.

### 4.5 Pre-declared expectations

Written before the runs; deviations are reported as results, not as failures of
the protocol:

1. D-SEAL-A and D-SEAL-B both produce **> 0** sealing opportunities on every
   seed. If not, the generator failed and is reported as such.
2. With sealing ON, blocked writes > 0 and executed writes on sealed banks = 0.
3. With sealing OFF, executed writes on non-active banks > 0.
4. Mean forgetting(seal OFF) > mean forgetting(seal ON) in at least one of the
   two variants; if neither shows an effect, that is a substantive negative
   result about the necessity of sealing under occasional mis-routing.
5. No claim is made that L10-F passes.

### 4.6 Seeds

Frozen seeds `123456789`, `218213831`, `171473193` (primary), plus exploratory
seeds `1`, `2`, `7`, `42` (labelled exploratory, never pooled with primary).

## 5. D-CTX — corrected context-off diagnostics

### 5.1 Analytic floor

With every cue feature at zero, all router scores are 0, the softmax is uniform,
and the masked argmax returns the lowest-index *allocated* bank. If that bank
holds task 0, the context-off accuracy for task `t` equals the agreement rate

```
A(t) = (1/6) · |{q : π0(q) = πt(q)}|
```

and the pooled context-off mean is `(1/T) · Σ_t A(t)`. This is computed in
Python directly from the permutations emitted by `makeLRMapping` and compared
with the measured per-seed numbers to 1e-9.

### 5.2 What the frozen criterion intends vs what it measures

Pre-declared interpretation:

- L10-E's context-off half intends to test *"is accuracy mediated by context?"*
  by destroying the context signal.
- Because the mechanism must still select a bank, the measurement conflates
  (i) the absence of context information with (ii) the deterministic fallback
  to a fixed bank. The fallback contributes exactly `A(t)` — a quantity fixed by
  the task permutations alone, independent of the agent.
- Therefore the informative causal statistic is the **excess over fallback**
  `E = measured − predicted`, which must be ≈ 0 for a correct implementation,
  and the **per-task margin** `M(t) = accuracy(correct cue) − accuracy(cue off)`,
  which is large when the cue actually carries information.

### 5.3 Corrected diagnostics

- **D-CTX-1**: analytic floor vs measured, per seed and per task (§5.1).
- **D-CTX-2**: excess over fallback per seed/task; pre-declared expectation
  |E| ≤ 1e-9.
- **D-CTX-3**: per-bank context-off sweep — evaluate each task with the cue
  zeroed *and each allocated bank forced in turn*, measuring the stored memory
  content of every bank independently of the fallback rule. This isolates
  "what is stored" from "which bank answers". It uses a frozen, seeded
  evaluation schedule; no task-distribution change.
- **D-CTX-4**: per-task margins `M(t)` and the pre-registered L10-E2 statement.

### 5.4 Threshold policy

0.40 is **not** touched. L10-E remains **FAIL**. If the diagnostic shows the
criterion is unsatisfiable under its unchanged protocol, §8 records a proposed
amendment for **owner approval**; the proposal is not applied, and no result in
this milestone is labelled a pass of L10-E.

## 6. D-CTRL — control audit

For each of SEQ-L9, ORACLE-BANK, CCM, K2-STRESS, FROZEN-ROUTER, CONTEXT-OFF,
SHUFFLED-CUE, NO-SEAL verify from code and artifacts: intended hypothesis,
intervention, matched variables, measured variables, interpretation, and
confounds. Claims from the previous audit carrying a specific number
(cross-bank synapse count, inter-bank pathway census, K2 unsealing, the
FROZEN-ROUTER ≡ CONTEXT-OFF equality) are re-derived here, not accepted.

Where a control is confounded, the **frozen arm is preserved** and a corrected
variant is offered only inside the D-track with a new name.

## 7. E-GEN — exploratory generalisation (explicitly non-frozen)

Declared tests, each with the information available to the model stated:

| Test | What varies | Available information |
|---|---|---|
| G1 novel cue recombination | held-out pairs of *trained* features | cue features only |
| G2 cross-signature cues | one feature from each of two task groups | cue features only |
| G3 conflicting mappings | 4 tasks / 4 banks, distinct π | cue + reward |
| G4 new task orderings | permutations, with and without revisit | cue + reward |
| G5 memory demand | 5–8 tasks with equal bank counts | cue + reward |
| G6 ambiguous context | cues mixing two signatures at learning time | cue + reward |
| G7 error recovery | forced wrong initial bank, measure recovery | cue + reward |

No task index, answer key, or future information is available to the mechanism
in any of these; the driver's knowledge of the schedule is architecture, exactly
as in L10 and disclosed in the frozen design.

These tests never modify, replace or supplement a frozen L10 criterion.

## 8. Proposed amendments (proposals only — not applied)

Recorded here in advance so they cannot be shaped by results:

- **A-1 (L10-F).** The criterion "NO-SEAL forgetting > CCM forgetting" is
  untestable under the frozen protocol because the opportunity count is 0.
  Proposed replacement, subject to owner approval: *"In a protocol variant that
  provably contains sealing opportunities (opportunity count > 0 on every
  seed), NO-SEAL mean forgetting exceeds sealed mean forgetting by a
  pre-declared margin, with matched streams and only the seal flag differing."*
  The specific margin is intentionally left blank until the diagnostic data
  exist; proposing a number afterwards must be marked as post-hoc.
- **A-2 (L10-E).** The criterion "context-off mean ≤ 0.40" is unsatisfiable for
  any implementation that answers when the cue is removed, because the fallback
  bank is correct for exactly one task. Proposed replacement: *"context-off
  excess over the analytic fallback prediction ≤ 0.02 (i.e. removing the cue
  reveals no context information), and the per-task context margin ≥ 0.60 on at
  least two of three tasks (L10-E2)."*
- **A-3 (controls).** K2-STRESS should have its two interventions (capacity and
  seal-on-reuse) split into separate arms in a future protocol version.
  FROZEN-ROUTER should report routing error separately from wasted selection
  trials.

## 9. Version log

- **v1.0** — 2026-10-25. Initial L10.1 protocol, written before any L10.1 run.
