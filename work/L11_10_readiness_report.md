# STARK-L11.10 — Readiness Report

**Question:** does the repository now contain the experimental instrument L11 needs, and
what still stands between this commit and an authorized run?

**Short answer:** the **stimulus** can now be constructed, deterministically and testably, for
all three cross-family ratios. The **experiment** still cannot be run: no driver calls the
constructor, no acceptance criterion is implemented, the contract has an unresolved internal
contradiction, and nothing is registered or authorized.

---

## 1. What this milestone closes

| L11.9 finding | status after L11.10 |
|---|---|
| **IMP-4** — "the harness cannot construct the required cross-family cue" | **CLOSED** — the constructor exists, is unit-tested (276 assertions), and is verified against the real router |
| "A2 and A3 are not measurable" | **partly closed** — the *stimulus* is measurable; the *arms* are still unimplemented |
| "no cue generator and no criterion" (learning-contrast audit) | **half closed** — the generator exists; the criterion still does not |

## 2. What it does not close

| blocker | owner |
|---|---|
| **CA-1** — the claim says "≥2 of 3 runs" for both clauses, but `L11-D` (retrieval) aggregates over all 9 cells | **owner decision** |
| **S3-1** — `L11-C` is provably redundant on `A2` (`Comp ∧ Read ≥ 0.90 ⇒ MixAcc ≥ 0.81`) | **owner decision** whether to restrict it to `A3` |
| **DL-1** — L11.8's "17 decisions" matches none of its own enumerations (queue 19, register 22) | documentation; the count must be fixed before ratification |
| **DL-2** — C1–C7 are runtime conditions, not approvable decisions | documentation |
| **S2-2** — the acceptance rule is tie-sensitive and must be specified in exact arithmetic | implementation, before any run |
| **E-4** — "pooling hid the historical failure" is imprecise; the danger is loss of structure | documentation |
| the 26 canonical decisions L11.9 enumerated (17 value judgments, 5 engineering, 4 authorization) | **owner** |
| the 7 runtime conditions C1–C7 | engineering, **0 / 7** |
| registration and authorization | **owner** |

---

## 3. The new blocker this milestone exposes

**Nothing calls the constructor.** Wiring it into an evaluation driver would:

- add arms `A2`, `A3`, `A4` to the L10 harness, or create a new driver;
- add new RNG stream constants — and L11.6's `F4` already found the protocol's §5 stream
  table does not match the code;
- add a new aggregation path that must implement the (unresolved) acceptance rules.

Under the preservation rules of L11.9 and L11.10 that is out of scope. **It is also the
point at which the contract's unresolved decisions become code**: a driver must encode
*which* aggregation rule and *which* null policy it implements. Writing it before those are
resolved would hard-code a contract that is still open.

---

## 4. Ordered path from here

| # | step | kind | depends on |
|---|---|---|---|
| 1 | resolve **CA-1** and **S3-1** | owner decision | — |
| 2 | resolve the statistical contract (aggregation, null policy, per-task) | owner decision | 1 |
| 3 | fix **S2-2** (exact-arithmetic rule) and **DL-1/DL-2** (counts, C1–C7 framing) | documentation/implementation | 2 |
| 4 | implement a driver that calls `L11CueConstruction` and runs `A2`/`A3`/`A4` | engineering | 2, 3 |
| 5 | implement `C1–C7`, resolve `F4` | engineering | 4 |
| 6 | register the contract, record hashes | **owner** | 1–5 |
| 7 | authorize implementation, then evaluation | **owner** | 6 |
| 8 | run | — | 7 |

**Step 4 is now possible.** Before L11.10 it was not: there was no way to build the cue.

---

## 5. Driver checklist (derived from the leakage audit)

Whoever writes step 4 must:

1. derive the expected bank as `bank_allocated_to(task)` — **never** from
   `cue.majority_group` (which equals the bank index only under the standard order, and
   breaks under `A9`);
2. assert all three banks are `CC_ACTIVE` before evaluating (an unallocated majority bank
   cannot be selected, for reasons unrelated to the cue);
3. filter rows by `eval_kind`/`call` before aggregating — five existing modes share one
   identity schedule and will double-count if pooled (leakage audit §7.2);
4. select cues from `enumerateCrossFamilyCues` with its own seeded RNG, and record the
   chosen feature identities in the trial row;
5. reconcile its own recomputed metric against `evalTask`'s return value (leakage audit
   §7.1);
6. allocate a **new** RNG stream constant for the cross-family draw, per `F4`.

---

## 6. Validation status

| check | status |
|---|---|
| unit tests of the constructor | **EXECUTED** — 276 assertions, exit 0, twice, byte-identical |
| mutation sensitivity | **EXECUTED** — 3 injected defects, all detected |
| existing related tests | **EXECUTED** — `test_context_conditioned_memory` (330), `test_l10_structural_audit` (357), `test_l10_1_sealing` (276), all pass |
| CMake build of the new target | **UNEXECUTED** — `cmake` is not installed in this environment; a direct `g++` compile with the identical source list was used instead |
| full CMake test suite | **UNEXECUTED** — same reason |
| any L11 arm or evaluation | **NOT RUN** — 0 arms, 0 trials |
| frozen-artifact integrity | **VERIFIED** — 11 / 11 unchanged |

---

## 7. Authorization state

| item | state |
|---|---|
| Protocol registered | **no** |
| Criteria ratified | **no** |
| Implementation authorized | **no** |
| Official evaluation authorized | **no** |
| Official arms run | **0** |
| Official trials run | **0** |
| Authority granted by this milestone | **none** |

**Building the instrument is not building the experiment, and neither is running it.**
