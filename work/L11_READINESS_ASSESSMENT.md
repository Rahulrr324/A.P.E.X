# STARK-L11 Readiness Assessment

**Date:** 2026-10-24
**Prepared under:** STARK-L10.6 (verification and planning only)
**Basis:** L10 closed at specification v1.8 (`aafd00aa…`); evidence verified and
criteria independently reproduced in `work/L10_6_MILESTONE_SIGNOFF.md`.
**Status of this document:** assessment and **proposal**. It authorises nothing,
registers no protocol, runs no experiment and changes no source file.

---

## A. Verdict

# READY WITH PREREQUISITES

L11 can start on a sound and auditable basis. It should **not** start until four
prerequisites are met, because each one would otherwise corrupt the first
official L11 result:

| # | Prerequisite | Why it blocks L11 |
|---|---|---|
| **P1** | **Write and freeze an L11 acceptance specification** (v1.0) with owner-ratified thresholds, *before* any official run | No L11 specification exists anywhere in the repository (verified by search). L10's credibility comes entirely from thresholds being fixed before evidence; repeating that discipline is the whole point. |
| **P2** | **Trial-granular instrumentation for novel/mixed-cue arms** | The L10.4 anomaly cannot be attributed today because the forced-bank sweep stores aggregate-only rows. An L11 capability defined on ambiguous cues would inherit exactly that blindness. |
| **P3** | **Declare the composition semantics in the protocol text** | "What should happen when a cue contains features of two signatures?" is currently undefined. Without a declared rule, any mixed-cue result is uninterpretable and unfalsifiable — the number could always be re-narrated after the fact. |
| **P4** | **Restore or formally exclude `test_phase1_affinity`** | It cannot build on this platform. It must either be ported to a portable mask type or explicitly excluded from the L11 regression gate in writing. Silence about it is not acceptable. |

Independently of P1–P4, **the L10.4 anomaly remains unresolved** and should be
carried into L11 as a documented limitation on the context-ignoring null. It does
not block L11 (it is not decision-relevant at any L10 threshold), but the L11
null measurement must not be assumed to be noise-free.

---

## B. Readiness by dimension

### B.1 Specification readiness — **adequate, needs one new document**

| Aspect | Assessment |
|---|---|
| L10 specification quality | Strong: frozen §8 criteria, §13 revision log with owner decisions, explicit "what did not change" clauses, additive-only diffs verified in L10.6 |
| Governance precedent | Established and reusable: propose → publish proposal → owner answers separately → promote with additive diff → freeze hash before running |
| L11 specification | **Absent.** No L11 criteria, no L11 protocol, no L11 seed list |
| Risk | Without a new spec, L11 work would be governed by whatever is written after results are seen — the failure mode L10 spent five subtasks avoiding |

### B.2 Reproducibility readiness — **strong**

- Every L10 evidence set is hash-manifested and re-verified in this task
  (L10.1 275, L10.2 275, L10.3 245, L10.4 124 + 129, L10.5 10).
- The two manifest discrepancies are **explained by git history**, not patched;
  the byte-identity check (L10.2 `R0` vs L10.4 `K1`, 6/6) proves the harness
  amendment changed no number.
- Determinism, checkpoint resume and persistence are criterion-verified in L10-H.
- Registered protocol hashes are fixed before runs (`e32043c`, corrected in
  `9b8f5af`); the L10 evaluation is re-derivable from committed per-seed rows
  with the committed evaluator (`987a3ff3…`).
- Known friction (documented, not a blocker): no `cmake` in this environment, so
  the build is explicit `g++ -O2 -std=c++17 -Isrc`; the harness writes restart
  output to the working directory and needs per-seed `--out`.

### B.3 Architectural readiness — **sufficient for the proposed L11, with one real gap**

| Component | State |
|---|---|
| Bank router | Observable and testable: `ccPreferredBank`, `ccRouterWeights`, `ccBankWeights`, `ccAllocateNext`, `ccActiveBank`, `ccSerialize` / `ccDeserialize` |
| Trial path | Well-defined and inspectable: eligibility gates → cue window → sample window → interference → decision window (spike-count majority, earliest-spike then seeded tie-break) → REINFORCE |
| Context lever | Exists at exactly **one** level — bank selection. There is no within-bank, feature-level, or slot-level modulation of retrieval |
| Gap | **The architecture has no representation for "a cue that is partially task A and partially task B."** The router is asked a question with no declared answer; L10.3's 0.5611 pooled / 0.0 minimum is the measurement of that gap |

That gap is precisely why the proposed L11 is a *composition* milestone and not a
capacity milestone: capacity is already shown to be adequate (0.9993 / 0.9989 /
0.9920 with zero forgetting).

### B.4 Learning and memory limits — **documented, and they shape the proposal**

| Limit | Evidence |
|---|---|
| Routing at ceiling under adequate banks | CRA pooled 0.6667 = structural ceiling; diagonals 1.000000 over 1,080 trials |
| Capacity is the binding constraint only under scarcity | K=2/T=3 → 0.6361 final, 0.2713 forgetting; K≥4 per task → ≈1.0 |
| Forgetting absent in the tested regime | CCM mean forgetting ≤ 0.10, final ≥ 0.85 on all masters |
| Sealing matters | L10-F2 PASSED at `commit_trials = 240`; at 480 no sealing opportunity arises at all |
| **Within-bank retrieval is not context-modulated** | Structural, not a measurement gap: no mechanism exists |
| **Composition across signatures is weak** | Pooled 0.5611; per-task 0.0–1.0; task-order dependent |

### B.5 Regression readiness — **inherited, not re-executed, and one hole**

- 26/26 inherited from L10.4 (including `test_l10_1_sealing` 276 assertions,
  `test_phase1_gates` 437, `n_way_learned_relevance_loop_L8` PASS). **Not re-run
  in L10.6**; no source changed since, so the status is expected to hold —
  expected, not measured.
- **Hole 1:** `test_context_conditioned_memory.cpp` contains **2 assertions** for
  the entire CCM subsystem. Behavioural regression protection is effectively
  absent; structural coverage lives in `test_l10_structural_audit.cpp`.
- **Hole 2:** `test_phase1_affinity` is **UNEXECUTED** (Windows-only `DWORD_PTR`).
- **Implication:** an L11 that changes routing must ship real behavioural tests,
  not just criterion arms, or the next milestone inherits the same blind spot.

### B.6 Implementation readiness — **ready**

Targets are committed and build (`context_conditioned_memory_loop`,
`test_context_conditioned_memory`, `test_l10_structural_audit`,
`l10_validation_harness`, `test_l10_1_sealing`); the harness has a documented CLI
(`--tag` mandatory for matched arms, `--mode restart` per-seed `--out`); an
existing evaluator can be reused. The work needed for L11 is instrumentation and
a new protocol, not a build system.

### B.7 Acceptance-design readiness — **ready, with a named discipline**

L10's acceptance design is the template: separately registered criterion, metric
defined analytically where possible, a *measured* null rather than a nominal one,
per-seed plus pooled reporting, and a written statement of what a PASS does not
mean. Two lessons must carry over:

1. **Define the metric where it cannot be gamed** — L10-E failed as a criterion
   because its context-off half is arithmetically floored at ≈1/3 by the task
   draw (pass probability 0.1512 for a perfect router). L11 must define the
   composition metric against a measured null, not against an absolute accuracy
   floor.
2. **Never let one deviating cell become an explanation.** The L10.4 anomaly is
   tolerable only because it is bounded and reported. L11 should make it
   observable.

---

## C. Why this L11 and not another

Candidate directions were weighed against the actual architecture and the actual
L10 limitations:

| Candidate | Verdict |
|---|---|
| More capacity / more banks | **Rejected as the next milestone**: capacity is already at ceiling (0.992–0.999) with zero forgetting; it would test a solved dimension and add little knowledge |
| Within-bank context modulation | Attractive (it is a genuine L10 gap) but **too large for one milestone**: it requires a new mechanism, not just a measurement, and there is currently no evidence about *which* within-bank variable context should modulate. Needs a scoping study first |
| Longer horizons / scale-up | Rejected for now: cannot be evaluated honestly before the composition gap is characterised |
| **Cross-signature compositional generalization** | **Selected**: it is the weakest *measured* capability (pooled 0.5611, minimum 0.0), it follows directly from the architecture's single-level context lever, it is measurable with the existing harness plus one instrumentation change, and it has a fixed, non-gameable null available |

---

## D. The prerequisites are the milestone's first week

An acceptable L11 sequence, in order:

1. Port `test_phase1_affinity` or record its exclusion (P4) — documentation task.
2. Add opt-in per-trial instrumentation (P2) — additive, default-off, no
   behaviour change; verified by rerunning L10's `K1` arm and confirming
   byte-identical aggregate CSVs. This is the one place where re-running an L10
   arm is *legitimate*, because the requirement is "identical output", not a new
   result.
3. Write the L11 protocol and specification v1.0 with thresholds and the
   composition rule declared (P1, P3); freeze the hash; owner ratification.
4. Only then run the official L11 evaluation.

---

## E. Proposed L11 — one concrete milestone

> **STARK-L11 — Cross-Signature Compositional Generalization**
> Every element below is **PROPOSED**. No part of it has been executed, and the
> thresholds are proposals requiring owner ratification; this document has no
> authority to fix them.

### E.1 Capability under test

When a cue contains features belonging to **more than one** learned signature, the
system must resolve it **deterministically, consistently with a declared
composition rule**, and still read out the correct response from the bank it
resolves to.

This is deliberately narrower than "compositional intelligence". It asserts one
falsifiable thing: *ambiguous context has a defined, stable, pre-declared
resolution, and it does not destroy within-bank retrieval.*

### E.2 Why it follows from the actual architecture

The context lever is a single router mapping a binary cue to a bank. With a mixed
cue that argmax has **no declared answer** — the router's output is whatever the
learned weights happen to produce, and L10.3 measured that: 0.5611 pooled, 0.0 on
one seed/task, 1.0 on another, i.e. task-order dependent rather than systematic.
The capability being tested is exactly the missing semantics at the one place the
architecture touches context.

### E.3 L10 limitations this addresses

| L10 limitation | How L11 addresses it |
|---|---|
| Cross-signature generalization weak / order-dependent (§F.2, §E.5 of sign-off) | becomes the primary criterion with per-seed and per-task reporting, and a no-seed-below-floor clause |
| No within-bank measurement | §E.6 clause D requires readout accuracy to be preserved *given* the resolved bank, isolating composition from retrieval |
| Aggregate-only diagnostics / unresolved anomaly | per-trial rows with `sel_slot`, `intended_slot`, `retrieved_id`, `counts_top2` |
| Thin CCM test coverage | a behavioural test suite ships with the milestone (minimum: composition determinism, rule consistency, failed-resolution handling) |
| L10-E structurally weak | L11's null is measured (forced-bank / shuffled), never an absolute accuracy floor |

### E.4 Minimum viable scope

- Tasks/banks: **T=3, K=3** (the L10 configuration) — no new scale dimension.
- Seeds: the three primary masters **plus** the four exploratory seeds; two held
  back from any tuning and reported as **held-out seeds**.
- Cue arms: pure signature; 2-signature mixture (balanced and unbalanced, e.g.
  2:1 features); unseen novel 3-feature combination; single-feature partial cue.
- **No new learning algorithm in phase 1.** Phase 1 measures whether the existing
  router already implements a consistent rule. A mechanism is added only if the
  measurement identifies a specific deficit, and only in a separately specified
  phase 2.
- Declared composition rule (must be fixed in the protocol text before running,
  and must be one of these, not chosen after seeing results):
  **R-majority** — the bank whose task signature shares the most features wins;
  ties broken by the lowest bank index. Written explicitly so that a result can
  contradict it.

### E.5 Pre-registered measurable protocol (sketch, to be frozen)

For each seed, task `t`, and composition arm `c`:

- `Comp(t) = fraction of mixed-cue trials whose resolved bank equals the bank
  predicted by R-majority`
- `MixAcc(t) = accuracy on mixed-cue trials`
- `Null(t) = mean accuracy over forced-bank trials with the cue removed`
  (the same measured null as L10-K1 — never a nominal floor)
- `Read(t) = accuracy of readout restricted to trials where the resolved bank was
  correct` (within-bank readout, isolated from routing)

Aggregation: unweighted mean over the three tasks per seed, then per-seed values
reported individually (pooled values reported alongside, never instead).

### E.6 Baselines, controls, ablations, held-out

**Baselines:** correct-cue ceiling (L10 ceiling ≈1.0); shuffled-cue floor;
random-bank floor; `R-majority` rule applied by a non-learned reference
implementation.

**Controls:** forced-bank null (cue removed); bank-scarcity control (K=2/T=3) to
show a composition failure is not a capacity failure; identical-seed rerun for
determinism.

**Ablations:** cue with one feature dropped; K=2 and K=6; composition arm with
balanced vs unbalanced mixtures; router frozen vs plastic.

**Held-out:** novel cue combinations never trained on; two held-out seeds; a
held-out task ordering (to test the order dependence L10.3 exposed).

### E.7 Determinism, persistence, regression requirements

- Two full reruns must produce **byte-identical** CSVs (all seeds).
- Checkpoint save/resume must be exact, per the L10-H method.
- L10 regression must be **26/26 with zero new failures**, `test_phase1_affinity`
  resolved or formally excluded, and the L10 criteria must be **unchanged** —
  L11 does not re-open, re-score or reinterpret L10.
- Every artifact manifested and hashed at creation; no post-hoc repair.

### E.8 Fixed pass/fail (proposed; requires owner ratification before the run)

| ID | Criterion |
|---|---|
| **L11-A** | `Comp(t) ≥ 0.90` on **every** task, on **every** seed |
| **L11-B** | `MixAcc(t) − Null(t) ≥ 0.50` for at least two of three tasks, on every seed |
| **L11-C** | `MixAcc` pooled ≥ 0.75 **and** no seed/task cell below 0.50 (the clause that would have caught L10.3's 0.0 cell) |
| **L11-D** | `Read(t) ≥ 0.90` on every task — composition must not damage within-bank readout |
| **L11-E** | reruns byte-identical; checkpoint resume exact |
| **L11-F** | regression: no new failures vs the L10 baseline |

All six must hold. Anything less is a recorded failure with its number.

### E.9 What counts as genuine failure

- A criterion missed under the frozen thresholds **with the protocol as written**.
- In particular: `Comp` high but `MixAcc` low means the rule is followed and the
  readout still fails — a *retrieval* failure, and a genuinely interesting one.
- `Comp` low with `MixAcc` high means the system succeeds without following the
  declared rule — a **specification** failure: the rule was wrong, not the model.
- A held-out seed failing while training seeds pass is a **generalization**
  failure and must be reported as such, not averaged away.

### E.10 What triggers redesign rather than threshold adjustment

**Redesign triggers (architectural):**
1. `Comp` below 0.60 on a majority of seeds → the single-level router cannot
   express composition; add a compositional cue representation or two-stage
   routing, and specify it as a new milestone.
2. `Read` failing while `Comp` passes → composition is being achieved by
   disturbing within-bank retrieval; the bank-scoped readout needs restructuring.
3. Held-out seeds failing systematically while training seeds pass → the
   evaluation split, not the model, is doing the work.

**Threshold adjustment:** **never** a response to a miss. The only acceptable
route is a **new versioned specification with an owner decision**, published
before any evidence for the revised threshold exists, with the original threshold
and result preserved in the revision log — the exact procedure L10 used for
L10-K1, L10-F2 and L10-G2. If the failure is structural (the criterion cannot
measure what it claims, as with L10-E's floored context-off half), the correct
response is a **new separate criterion**, not a change to the old one.

---

## F. Relationship to the unresolved L10 anomaly

`work/L10_6_PROPOSED_channel_slot_diagnostic.md` (**PROPOSED / NOT EXECUTED**) is
a *separate* diagnostic, not part of L11 and not a prerequisite for it. If it is
ever authorised and run, it should precede L11's official evaluation because L11's
`Null(t)` uses the same forced-bank arm. If it is never run, L11 must state in its
specification that the null carries a known, quantified, sub-0.001 uncertainty.

---

## G. Bottom line

**READY WITH PREREQUISITES.** The evidence chain, the governance precedent and the
determinism story are strong enough to build on; the specification for L11 does not
yet exist, the instrumentation to observe an ambiguous-cue decision does not yet
exist, and the composition semantics are undefined. Fix those four things, freeze
the thresholds, and the milestone can begin. Progress toward the project goal is
**≈57 %** and is unchanged by this document.
