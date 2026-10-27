# STARK-L11.3 — C1–C7 Verification Matrix

**Authority:** the conditions are quoted **verbatim** from the committed audit
report `work/L11_2_R3_AUTHORIZATION_AUDIT.md` §8 (commit `deac50f`). They were
read from the file, not reconstructed. The audit's §5 additions (7′, 9–14) are
quoted verbatim as well.

**State at the end of this milestone:** no condition is *satisfied* — C1, C2, C3,
C5, C6 and C7 can only be satisfied by an implementation and a test run, and the
implementation is still unauthorized. What this milestone delivers is, for each
condition: **how it will be verified**, **the test that proves it**, **what that
test does not prove**, **the failure mode if it is ignored**, and **its current
status**.

Status vocabulary: `SPECIFIED` (a test exists on paper) · `BLOCKED-ON-CODE` ·
`BLOCKED-ON-RUN` · `SATISFIABLE-NOW` · `SATISFIED`.

---

## 1. The seven conditions

| ID | Verbatim condition (audit §8) | Status now | Satisfied by |
|---|---|---|---|
| **C1** | *Separate writer only; `writeTrialCsv` and `writeTaskCsv` are not edited; legacy files must hash-match the disabled run* | BLOCKED-ON-CODE | V1 + T1 |
| **C2** | *Capture lives inside `evalTask`'s `if (rows)` block and **before** the restore at line 275; nothing is captured at any `runCCTrial` call site; the routing re-derivation block (505–521) emits no rows* | BLOCKED-ON-CODE | V2 + T2/T3 |
| **C3** | *Update mass is captured per trial (no reuse of a stale `w0`); `advantage` uses a pre-call baseline snapshot at index 0* | BLOCKED-ON-CODE | V3 + T4/T5 |
| **C4** | *Schema v0.2 first: add `task_bank`, `rule_bank`, `rule_compliant`, `presented[]`, `choice_matches_resolved_bank_map`; define `routing_correct := selected == task_bank`; implement P7 against `rule_bank`* | **SATISFIED (specification half)** | this milestone, §2 |
| **C5** | *Exactly one source file changes; no new RNG engine anywhere; no engine file touched* | BLOCKED-ON-CODE | V5 |
| **C6** | *The non-interference run must include checks 1–8 plus 7′, 9, 10, 11, 12, 13, 14 (§5) before any arm is implemented* | BLOCKED-ON-RUN | V6 |
| **C7** | *`ccSerialize` only at run start and task boundaries, never per trial* | BLOCKED-ON-CODE | V7 |

---

## 2. C4 — the only condition this milestone can advance, and it does

C4 has two halves: the **schema** and the **implementation of P7**.

| C4 requirement | Delivered in v0.2 | Where | Verified how |
|---|---|---|---|
| add `task_bank` | yes (field 21) | schema §3 | validator invariant 5/7 |
| add `rule_bank` | yes (field 22) | schema §3 | validator invariant 6/8 |
| add `rule_compliant` | yes (field 26) | schema §3 | validator invariant 6/8 |
| add `presented[]` | yes (`presented_ids`, field 28) | schema §3 | validator invariant 11 |
| add `choice_matches_resolved_bank_map` | yes (field 34) | schema §3 | validator invariants 13, plus the MISLEAD metric tests |
| `routing_correct := selected == task_bank` | yes | schema §4 rule 5 | validator rejects any other mapping (negative control) |
| subset of `record_class` for P7 | yes — P7 must use `rule_bank`, never `task_bank` | `work/L11_3_IMPLEMENTATION_PATCH_SPEC.md` §3 | `git grep` assertion in V4 |

**C4 specification status: SATISFIED.** C4 *implementation* status: not started
(no code authorized). The audit's own note applies — C4 must land **before** P7 is
written, which is exactly the ordering this milestone preserves.

**Executed evidence (not prose):** the v0.2 invariants are executable.
`work/l11_3_prototype/schema_v0_2_check.py --selftest` → **32/32 PASS**, exit 0,
including five negative controls that specifically reject a v0.1-style
`SHUFFLED`/`MISLEAD` scoring and three metric tests proving `Read` returns
`NA:STRUCT_ZERO` rather than `0` for `MISLEAD`.

---

## 3. Verification column: the exact procedure for each condition

### V1 / C1 — separate writer, untouched legacy

```
git diff --name-only <base> <impl> -- stark/            # must be one path
git grep -n "writeTrialCsv\|writeTaskCsv" <impl-col>
sha256sum trials_*.csv  (instrumented run)  vs  (disabled run)   # must be equal, file by file
```
**Proves:** the legacy artifacts were produced by unmodified code and are
bit-identical with instrumentation on and off.
**Does not prove:** anything about the new file's correctness.
**If ignored:** check 7 becomes vacuous (audit §5) and a column reordering in the
legacy writer would silently invalidate every L10-derived comparison.

### V2 / C2 — no hidden trial duplication

Three independent checks, because this is the highest-severity hazard:

1. **Static:** `evalTask`'s capture block must be inside `if (rows)`; no
   `push_back` may appear anywhere in lines 503–523 (the re-derivation block).
   Assert with `git grep -c push_back` over that range → **must be 0**.
2. **Row-count:** for every evaluation call, `rows_for_call == 120`. The
   re-derivation pass would add 3 × 120 = 360 to an `eval_kind == 0` run; the
   committed audit artifact shows **720** rows across 6 calls, so a leak is
   arithmetically unmistakable (1080 ≠ 720).
3. **Ordinal:** evaluation `trial` must be the global `rows->size()` ordinal, so
   projecting the new file onto the legacy 17 columns reproduces `trials_*.csv`
   row-for-row (this is also check 7′).

**Proves:** diagnostic calls cannot enter ordinary denominators.
**Does not prove:** that the diagnostic behaviour itself is unchanged — that is
covered by the 18-file legacy comparison.
**If ignored:** every accuracy and routing rate is diluted by 360 phantom trials,
silently and uniformly, in a direction that always *improves* apparent
composition (the re-derivation uses the same schedule and would score high).

### V3 / C3 — update mass and advantage

```
per trial i:  w0 = ccBankWeights(ag)          # unconditionally, when --emit-l11
              baseline_before = reward_baseline[0]
              r = runCCTrial(...)
              w1 = ccBankWeights(ag)
```
Tests T4 (mass) and T5 (advantage) recompute both quantities from task-boundary
state dumps and require agreement with the recorded values.
**Proves:** the recorded learning quantities describe *this* trial.
**Does not prove:** that the engine's own update is correct — that is the L10
suite's job.
**If ignored:** pair trials (which never refresh `w0` under the current
`measure || maybe_opp` condition at line 429) report a stale delta. The numbers
stay plausible and wrong — the worst class of defect for a measurement milestone.

### V4 / C4 (implementation half) — P7 against the rule, not the task

`git grep -n "intendedBankByRule"` must show that the function's argument list
contains the cue **only** (no task index, no mapping), and that every caller
assigns it to `rule_bank`.
**If ignored:** the rule is computed from the task and can never disagree with
`task_bank`, which would make `rule_compliant` a duplicate of `routing_correct`
and quietly restore defect S1 in the data.

### V5 / C5 — one file, no new RNG, no engine file

```
git diff --stat <base> <impl> -- stark/   # exactly one path, and it must be l10_validation_harness.cpp
git diff <base> <impl> -- stark/ | grep -E '^\+.*(mt19937|random_device|uniform_|normal_distribution)'
```
The grep must be empty. `ContextConditionedMemory.*`, `RelevanceRouting.*`,
`Network.*`, `NeuralCell.*`, `Synapse.*` must not appear in the diff.
**Proves:** the blast radius and the RNG-stream claim (risk 1 of the audit).
**Does not prove:** runtime non-interference — only C6 does.

### V6 / C6 — the full comparison battery

Checks 1–8 **plus** the audit §5 additions, all required before *any* arm is
implemented:

| # | Check | What it uniquely proves |
|---|---|---|
| 1 | inputs and targets identical | the schedule is untouched |
| 2 | trial order identical | no reordering from buffering |
| 3 | predictions and routing identical | the decision path is untouched |
| 4 | state transitions and updates identical | plasticity is untouched |
| 5 | final state identical | the endpoint is untouched |
| 6 | RNG behaviour (per-trial `selected_slot`) | the draw stream is untouched |
| 7 | legacy artifacts hash-match | the legacy writer is untouched |
| **7′** | **projection equality, row-for-row against `trials_*.csv`** | **turns check 7 from vacuous into a real per-trial comparison** |
| **9** | **non-degenerate arm (routing < 1, accuracy < 1)** | a saturated arm cannot exercise the interesting branches |
| **10** | **record correctness (recompute mass, advantage, router L1)** | behaviour-preservation cannot catch a *recording* bug |
| **11** | **`--emit-l11 0` produces no `trials11_*.csv`** | the default-off claim |
| **12** | **missing/malformed `--protocol-sha` fails closed** | error paths (audit risk 9) |
| **13** | **boundary state hashes at every task step** | localises divergence instead of only detecting it |
| **14** | **new file byte-identical across two runs** | determinism of the *new* artifact, which checks 1–8 never test |

**Proves:** under the tested conditions, instrumentation is observationally inert
and the records are correct.
**Does not prove:** non-interference outside those conditions (other arms, K≠3,
other compilers). The claim must stay scoped to what ran — this is the audit's
own rule and it is preserved here.

### V7 / C7 — serialization at boundaries only

Code review plus the audit's measured overhead: `ccSerialize` is ≈ 1.2–1.5 ms per
call (~9× a plain trial); the weight copies are free. A per-trial serialize would
add ≈ 2.5 s per 2,160-trial run — tolerable but pointless, and it inflates the
surface for no evidentiary gain.
**Proves:** the cost model.
**Does not prove:** anything about correctness.

---

## 4. Condition → test → deliverable

| Condition | Test IDs (validation plan) | Deliverable that specifies it |
|---|---|---|
| C1 | T1, 7, 7′, 11 | `work/L11_3_NON_INTERFERENCE_AND_REGRESSION_PLAN.md` §2.1 |
| C2 | T2, T3, 7′ | ibid. §2.2 |
| C3 | T4, T5, 10 | ibid. §2.3 |
| C4 | schema self-test 32/32 (done), V4 grep | `work/l11_3_prototype/schema_v0_2_check.py` |
| C5 | T6, V5 | ibid. §2.4 |
| C6 | T7–T19 | ibid. §2.5 |
| C7 | T20, code review | ibid. §2.6 |

---

## 5. Honest status statement

- **C4: satisfied in specification**, and only there.
- **C1, C2, C3, C5, C7: not verifiable yet** — they constrain code that does not
  exist. Marking them "verified" would be a false claim.
- **C6: not runnable yet** — it needs an instrumented binary.
- No condition is satisfied by this milestone's documentation alone, and this
  document does not claim otherwise.
