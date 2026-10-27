# STARK-L10.1 — Experimental Control Repair and Sealing Validation

**Disposition:** the L10 controls were repaired and re-tested.
**L10-F is now *explained and testable***, but **remains FAILED** under its frozen
criterion, which was not changed. **L10-E remains FAILED** (0.40 untouched); its
mathematical floor is confirmed exactly and a replacement criterion is *proposed*,
not applied. One new mechanism finding and one new protocol finding are recorded.

Version: L10.1 v1.0 · Branch `validation/l10-1-control-repair` · Protocol
`stark/design/l10_1_control_validation_protocol.md` (written before any run)

---

## A. Provenance

Verified against actual refs and GitHub, before any change.

| Item | Value |
|---|---|
| Repository | `Rahulrr324/A.P.E.X` (private) |
| Starting branch | `validation/l10-independent` |
| Starting SHA | `123ef65a6ad200dfafb4ce736f7ed94260267898` |
| L10 milestone commit | `49cc6ba18650c0d9614bb9e8918fe65453ec5a02` |
| Milestone base | `5f5a57717509623bd4c79460d50c05f7cbc605c3` (grafted; `.git/shallow` = `563395f1`, `5f5a577`) |
| Working branch | `validation/l10-1-control-repair`, created from `123ef65` |
| PR #2 | **OPEN, unmerged**, head `arena/c90f7329-a-p-e-x` @ `5f5a577…`, base `main`, 202 files |
| PR #3 | **OPEN, unmerged**, head `arena/86da64f9-a-p-e-x` @ `49cc6ba…`, base `arena/c90f7329-a-p-e-x`, 48 files |
| New PR | none created |

Original evidence re-hashed before starting, all unchanged:

| Artifact | MD5 |
|---|---|
| `work/l10_raw/final_run/report_raw.json` | `b38736bb8a2a4574e6226f192a617627` |
| `work/l10_raw/determinism/report_rerun.json` | `17beb41e342fa268d7a6efa47512df08` |
| `work/l10_raw/l9_reproduction/report_reproduced.json` | `a00b62b330bf231fdecf2b4991ec44fa` |

`work/l10_raw/independent_validation_20261024/` was read but not written.

**Files inspected** (read in full, not summarised): `ContextConditionedMemory.h`,
`ContextConditionedMemory.cpp` (routing, gates, `writable`, seal lifecycle,
serialization), `context_conditioned_memory_loop.cpp` (arm specs, JSON emission),
`l10_validation_harness.cpp`, `test_context_conditioned_memory.cpp`,
`test_l10_structural_audit.cpp`, `RelevanceRouting.{h,cpp}` (trial construction),
`Network.cpp` (three-factor gate semantics, homeostasis, serialization),
`stark/design/context_conditioned_memory_milestone.md`,
`work/L10_INDEPENDENT_VALIDATION.{md,json}`, and the frozen raw artifacts.

## B. Sealing (L10-F)

### B.1 The mechanism, traced

`cfg.seal_superseded` has **exactly one consumer** in the whole engine:

```cpp
// ContextConditionedMemory.cpp, runCCTrial section 2-3
writable = (bank_state[bank] == CC_ACTIVE)
        || (!cfg.seal_superseded && bank_state[bank] != CC_UNALLOCATED);
mapping_credit = sched.single && writable;   // -> S[k*][queried] eligibility gate
```

Every plastic write in the agent flows through `mapping_credit`: the only plastic
synapses are the per-bank `S→A` three-factor matrices (verified again by the
structural test: `S→A=108, A→A=108` where `A→A` is *not* plastic, `cue→R=36`,
`C→L=4`). The router (`cue→R`) and the channel policy (`C→L`) are updated by their
own REINFORCE rules and are **not** covered by the seal — see §D.6.

So sealing is supposed to prevent: *a mapping write into a bank that is no longer
the agent's current context.* It can only act on a trial that is **(a) single
candidate** and **(b) routed to a non-active, allocated bank**. Call that a
*sealing opportunity*.

### B.2 The frozen control was vacuous — proven two ways

**(a) Schedule arithmetic.** Training is `makeLRTrials(80 single)/identity`
followed by `makeLRTrials(0 selection, 40)/identity`. For 6 identities that is
480 single-candidate trials followed by 240 multi-candidate trials. `commit_trials
= 480`. The sets are *identical*: **every mapping-credit trial in the frozen
protocol lies inside the forced window.** During a forced trial the router is
bypassed (`forced_bank = active`), so `bank` is by definition the active bank and
`writable` is true in both arms.

**(b) Telemetry.** With new per-trial counters (`single`, `active`, `opp`):

| protocol | arm | single trials routed off the active bank | writes blocked | writes executed |
|---|---|---|---|---|
| frozen (commit 480) | seal ON | **0** | 0 | 0 |
| frozen (commit 480) | seal OFF | **0** | 0 | 0 |

Therefore `NO-SEAL` is *analytically identical* to `CCM` under the frozen
protocol, and L10-F cannot be satisfied there — not because sealing is useless,
but because the protocol never gives it a trial. This is a **specification
incompatibility**, not a mechanism defect.

### B.3 Corrected diagnostics (matched pairs, pre-declared)

Both arms share seeds, permutations, cue assignment, initialisation, budgets and
evaluation. The **only** difference is `cfg.seal_superseded`. Three opportunity
generators, all declared in the protocol before the runs:

- **D-SEAL-A** — `commit_trials = 60` (shortened window; unforced single-candidate
  trials now exist).
- **D-SEAL-A′** — `commit_trials = 240` (same idea, milder).
- **D-SEAL-B** — `commit_trials = 240` **and** 20 % declared cue corruption during
  learning (mis-routed contexts — the failure mode sealing exists for), drawn from
  a stream seeded by `(master, task)` only, never by the arm flag.

3 primary seeds (the frozen ones) and 4 exploratory seeds (1, 2, 7, 42):

| protocol | arm | min acq | final avg | mean forget | opp | blocked | executed | \|dW\| into sealed banks |
|---|---|---|---|---|---|---|---|---|
| frozen 480 | seal ON | 1.0000 | 1.0000 | **0.0000** | 0 | 0 | 0 | 0.000 |
| frozen 480 | seal OFF | 1.0000 | 1.0000 | **0.0000** | 0 | 0 | 0 | 0.000 |
| A (60) | seal ON | 1.0000 | 1.0000 | **0.0000** | 345 | 345 | 0 | 0.000 |
| A (60) | seal OFF | 1.0000 | 0.4667 | **0.5333** | 342 | 0 | 342 | 43.143 |
| A′ (240) | seal ON | 1.0000 | 1.0000 | **0.0000** | 185 | 185 | 0 | 0.000 |
| A′ (240) | seal OFF | 1.0000 | 0.5491 | **0.4509** | 184 | 0 | 184 | 30.358 |
| B (240 + 20 % miscue) | seal ON | 1.0000 | 0.5194 | **0.4806** | 403 | 403 | 0 | 0.000 |
| B (240 + 20 % miscue) | seal OFF | 1.0000 | 0.4361 | **0.5639** | 503 | 0 | 503 | 47.058 |
| A, seeds 1/2/7/42 | seal ON | 0.9833 | 0.9979 | **0.0000** | 563 | 563 | 0 | 0.000 |
| A, seeds 1/2/7/42 | seal OFF | 0.8333 | 0.4958 | **0.4882** | 673 | 0 | 673 | 55.729 |
| B, seeds 1/2/7/42 | seal ON | 0.9833 | 0.4833 | **0.5146** | 559 | 559 | 0 | 0.000 |
| B, seeds 1/2/7/42 | seal OFF | 0.9833 | 0.4632 | **0.5347** | 643 | 0 | 643 | 61.346 |

All five pre-declared expectations held: opportunities > 0 on every seed in the
corrected protocols; with sealing ON **every** opportunity is blocked and no
weight reaches a sealed bank; with sealing OFF every opportunity executes a write.

### B.4 What this establishes, and what it does not

**Established.** Sealing genuinely prevents cross-bank interference *when the
protocol contains opportunities*: in D-SEAL-A the sealed arm keeps forgetting at
**0.0000** while the unsealed arm loses **45–53 %** of earlier tasks' accuracy,
across 7 seeds. The effect is large, reproducible, and attributable to the toggle.

**Important nuance.** In D-SEAL-B (mis-routed cues) sealing still helps
(0.4806 vs 0.5639, 0.5146 vs 0.5347), but far less, because a mis-routed *active*
bank is corrupted by the same mechanism and sealing cannot prevent that. Sealing
protects *bank identity*; it does not protect against garbage arriving in the
current bank.

**Not established.** Nothing about L10-F's official status.

### B.5 L10-F verdict

| Question | Answer |
|---|---|
| Was the original control vacuous? | **Yes** — 0 opportunities, proven by schedule arithmetic and telemetry |
| Corrected diagnostic result | Sealing reduces forgetting from ≈0.45–0.53 to **0.000** (D-SEAL-A/A′), and from ≈0.53–0.56 to ≈0.48–0.51 (D-SEAL-B) |
| Does sealing genuinely prevent interference? | **Yes**, for writes into non-active banks, whenever such writes are possible |
| Can the original criterion be satisfied unchanged? | **No** — under the unchanged protocol the opportunity count is 0 by construction, so `NO-SEAL forgetting > CCM forgetting` can never hold |
| Does L10-F remain failed? | **YES.** Unchanged. The corrected diagnostic is *not* an L10-F pass |

**Proposed amendment A-1 (for owner approval, not applied):** replace L10-F with
*"in a protocol that provably contains sealing opportunities (opportunity count
> 0 on every seed), NO-SEAL mean forgetting exceeds sealed mean forgetting by a
pre-declared margin, with matched streams and only the seal flag differing."*
The band's exact value is deliberately left open until the owner decides; any
number proposed after these results must be labelled post-hoc. The natural
pre-declared threshold from the frozen design's own scale is the L10-A band
(`≤ 0.10`), i.e. amendment would read *"sealed ≤ 0.10 and unsealed > sealed by
≥ 0.10"* — **post-hoc, therefore only a suggestion.**

## C. Context-off (L10-E)

### C.1 The mechanism, verified

With the cue withheld, every `cue→R` input is 0, all router scores are 0, the
softmax is uniform, and `ccPreferredBank` (masked argmax over allocated banks)
returns the **lowest-index allocated bank** — bank 0, which holds task 0's mapping
π₀. A trial of task *t* then scores 1 iff `π₀(q) = π_t(q)`.

The floor is therefore not "≈⅓" (the L10 document's approximation) but

```
A(t) = |{q : π₀(q) = π_t(q)}| / 6 ,      pooled floor = (1/3)·Σ_t A(t)
```

computed from the permutations dumped directly out of `makeLRMapping`:

| seed | A(0) | A(1) | A(2) | pooled |
|---|---|---|---|---|
| 123456789 | 1.0000 | 0.1667 | 0.3333 | 0.5000 |
| 218213831 | 1.0000 | 0.1667 | 0.1667 | 0.4444 |
| 171473193 | 1.0000 | 0.0000 | 0.0000 | 0.3333 |

### C.2 Measured vs analytic

| seed | task | acquisition | measured ctx-off | analytic A(t) | excess | margin | shuffled |
|---|---|---|---|---|---|---|---|
| 123456789 | 0/1/2 | 1.0 / 1.0 / 1.0 | 1.0000 / 0.1667 / 0.3333 | identical | 0 / 3e-7 / -3e-7 | 0.00 / 0.83 / 0.67 | 0.267 / 0.167 / 0.258 |
| 218213831 | 0/1/2 | 1.0 / 1.0 / 1.0 | 1.0000 / 0.1667 / 0.1667 | identical | 0 / 3e-7 / 3e-7 | 0.00 / 0.83 / 0.83 | 0.142 / 0.083 / 0.100 |
| 171473193 | 0/1/2 | 1.0 / 1.0 / 1.0 | 1.0000 / 0.0000 / 0.0000 | identical | all 0 | 0.00 / 1.00 / 1.00 | 0.000 / 0.100 / 0.075 |

**Pooled measured 0.425926 = analytic 0.425926, excess 7.4e-08 (float
formatting).** The measured value is fully determined by the task permutations.

### C.3 New diagnostic — per-bank context-off sweep

The frozen control forces one number out of a mechanism that must pick a bank.
D-CTX-3 withholds the cue but **forces each allocated bank in turn**, measuring
stored content independently of the fallback rule:

| seed | bank 0 | bank 1 | bank 2 |
|---|---|---|---|
| 123456789, task 0 | **1.0000** | 0.1667 | 0.3333 |
| 123456789, task 1 | 0.1667 | **1.0000** | 0.1667 |
| 123456789, task 2 | 0.3333 | 0.1667 | **1.0000** |
| 218213831, tasks 0/1/2 | **1.0** / 0.167 / 0.167 | 0.167 / **1.0** / 0.0 | 0.167 / 0.008 / **1.0** |
| 171473193, tasks 0/1/2 | **1.0** / 0.0 / 0.0 | 0.0 / **1.0** / 0.167 | 0.0 / 0.167 / **1.0** |

Every bank answers its **own** mapping at 1.000 with the cue removed; the frozen
CONTEXT-OFF number is exactly the bank-0 column. So the control measures *which
bank the fallback picks*, and nothing about what the cue contributes.

### C.4 Answers to the four questions

1. **What does L10-E intend to measure?** That accuracy is causally mediated by
   context — destroy the context signal and performance should collapse.
2. **Is chance the right floor?** No. The task structure imposes the permutation-
   determined floor `A(t)`; a mechanism that answers at all must be exactly right
   on task 0 and wrong on the others at the π₀-agreement rate. Pooled floor here
   is **0.425926**, not 0.40 or 0.33.
3. **Does selecting bank 0 expose unavailable information?** No. Bank 0's content
   is the agent's own memory of task 0; nothing about the current task is read.
   The 0.426 is stored-task similarity, not leakage.
4. **Does the control isolate the causal contribution of context?** No — it
   conflates "no context information" with "deterministic fallback". The clean
   statistics are the **excess over fallback** (0 within float precision, i.e.
   *no* context information survives) and the **per-task margin** (0.67–1.00 on
   the two non-fallback tasks).
5. **Can it be isolated without changing the task distribution?** Yes, and it was:
   excess-over-fallback, the per-bank sweep, and the pre-registered L10-E2 margins.
   **L10-E2 passes 3/3 seeds** (ctx margin ≥ 0.60 on 2 of 3 tasks; shuffled margin
   ≥ 0.60 on 3 of 3 tasks).

### C.5 L10-E verdict

| Question | Answer |
|---|---|
| Verified mathematical floor | **0.425926** pooled (0.5000 / 0.4444 / 0.3333 per seed), exact to 1e-7 |
| Original result | 0.425926 > 0.40 → **FAIL**, unchanged |
| Corrected diagnostic | excess over fallback = 0; per-bank sweep shows perfect per-bank content; L10-E2 passes |
| Does L10-E remain failed? | **YES.** 0.40 was not lowered or reinterpreted |
| Amendment needed? | **Proposed (A-2), not applied** |

**Proposed amendment A-2 (for owner approval, not applied):** *"context-off
accuracy must exceed the analytic fallback prediction by no more than 0.02 (no
context information survives the removal), **and** the per-task context margin
must be ≥ 0.60 on at least two of three tasks (L10-E2)."* This keeps the intent
(no leak of context information) and removes the unsatisfiable absolute bound.

## D. Remaining controls (D-CTRL)

| Control | Hypothesis | Verdict | Evidence / confound |
|---|---|---|---|
| **SEQ-L9** | harness parity with L9 | **valid** | reproduces pooled `[1.0, 0.666667, 0.563889]`, forget 0.467593, final 0.275926 exactly |
| **ORACLE-BANK** | routing ceiling | **valid, and tight** | equals CCM on every performance metric — the learned router *attains* the diagnostic ceiling here (holdout differs by 1/360 on one trial) |
| **CCM** | the mechanism | **valid** | 0 forgetting, 1.000 final, 1.000 routing, 0.998 held-out |
| **K2-STRESS** | capacity | **confounded** | the exhaustion branch both reuses *and* un-seals a bank; two interventions in one arm. The seal half is inert under this protocol (§B.2), but the arm should still be split |
| **FROZEN-ROUTER** | learned routing | **confounded (documented)** | conflates routing error with wasted selection trials; also **field-for-field identical to CONTEXT-OFF** on all seeds — both reduce to "always bank 0" (router weights exactly 0.0) |
| **CONTEXT-OFF** | cue necessity | **uninformative as an absolute number** | measures the fallback bank's mapping (§C); corrected diagnostics in §C.3 |
| **SHUFFLED-CUE** | cue causality | **valid** | pooled 0.132407 |
| **NO-SEAL** | write protection | **vacuous under the frozen protocol** | 0 opportunities (§B.2); corrected diagnostics in §B.3 |

### D.6 Two new findings

**(1) "No mapping credit" ≠ "no learning".** Multi-candidate trials carry no
`S→A` credit (all eligibility gates off), yet they materially change behaviour:

| condition | eval accuracy of the same bank |
|---|---|
| 480 single-candidate trials only | 0.55 |
| + 240 multi-candidate trials, `learning=on` | **1.00** |
| + 240 multi-candidate trials, `learning=off` | 0.55 |

Bank `S→A` weights are **identical** in all three cases (`|ΔW| = 0` over the
block) and the state round-trips through `ccSerialize`; the difference is the L9
**channel policy** `v` (`C→L`), which changes by `|Δv| = 4.32448` during exactly
that block. Any ablation that removes multi-candidate trials is therefore *not* a
learning-free control. This does not invalidate L10 — every L10 arm includes the
block — but it corrects the description of what a selection trial does.

**(2) Sealing protects bank memory, not shared policies.** The seal predicate
gates only per-bank `S→A` credit. Router weights (`cue→R`) and the channel policy
(`C→L`) stay updatable while a bank is sealed, so a mis-routed trial still
degrades *routing* even when the sealed bank's content is untouched.

## E. Generalisation (E-GEN — exploratory, never frozen evidence)

3 frozen seeds; mechanism sees only cue features and the scalar reward.

| Test | Configuration | Result | Reading |
|---|---|---|---|
| G1 held-out recombination | trained feature pairs in unseen combination | 0.9981 mean, min 0.9917 | recombines **within** a signature group |
| G2 cross-signature cues | one feature from each of two groups | mean **0.5611**, min 0.0000 | **fails** — the router is not generally compositional |
| G3 conflicting mappings, 4/4 | 4 tasks, 4 banks | forgetting 0.0000, final 0.9993 | holds |
| G5 memory demand | 5/5, 6/6, **8/8** | 0.000 forgetting; final 0.9989 / 0.9894 / 0.9920; min acq 0.833 | holds to 8 banks; acquisition is the first thing to slip |
| G4 ordering | `2,0,1` | forgetting −0.0009, final 1.0000 | order-independent |
| G4 revisit | `0,1,0`, 2 banks | 1.000 throughout | a sealed bank is not overwritten on revisit |
| G6 ambiguous context | 20 % mis-cued learning | forgetting 0.2778, final 0.7222 | degrades gracefully but not robustly |
| G7 error recovery | wrong initial bank | forgetting 0.2713, final 0.6361 | a bad early allocation is expensive and only partly recovered |

**What is actually generalised:** recombination of *trained features within a
context signature*, rotation of task order, and retention up to 8 contexts when
banks are not exhausted. **Not** generalised: cues composed across signatures,
mis-specified contexts, and mis-allocated banks. This is finite cue recombination
over a linear-softmax router, **not** compositional intelligence.

## F. Tests and determinism

### F.1 Frozen reproduction (P-FROZEN)

Two independent runs of the frozen 8-arm × 3-seed driver from this branch:

- run 1 normalized sha256 `fe76eb2a7a626be5714fa3c48a3943f56b2b4284a5fd911065586c6e2628787d`
- run 2 identical; **matches the previous milestone's post-fix build** exactly
- criteria block byte-identical; **L10-E FAIL, L10-F FAIL** unchanged

### F.2 Canonical regression battery (cwd `stark/`)

26 targets built, **all exit 0**:

| Group | Result |
|---|---|
| `test_neuron`, `test_params`, `test_synapse`, `test_integration`, `test_network`, `test_stdp`, `test_homeostasis`, `test_three_factor`, `test_serialization` | pass |
| `test_learning_loop`, `test_delayed_reward`, `test_sequential_context`, `test_associative_memory`, `test_eligibility_gating`, `test_learned_relevance`, `test_n_way_learned_relevance` | pass |
| `test_context_conditioned_memory` | **PASS (330 assertions)** |
| `test_l10_structural_audit` | **PASS (357 assertions)** |
| `test_l10_1_sealing` | **PASS (276 assertions)** — new |
| `n_way_learned_relevance_loop_L8` | `verdict: PASS` |
| `test_phase1_{profiler, accounting, budget, records, reproducibility, gates}` | PASS (34 / 67 / 55 / 72 / 37 / **437**, 0 failures) |
| `test_phase1_affinity` | **NOT EXECUTED** — `DWORD_PTR` not declared (Win32-only). Reported as unknown, **not** as passing |

### F.3 New focused regression test

`stark/tests/test_l10_1_sealing.cpp` (276 assertions) pins the behaviour the
L10.1 diagnostic relies on, at the level where the toggle acts:

1. single-candidate trial routed to a **sealed** bank → `plastic_write == false`,
   `|ΔW| == 0`, all `S[0][*]` eligibility gates off;
2. identical trial with `seal_superseded = false` → `plastic_write == true` and a
   real weight change confined to the selected bank;
3. a sealed bank's readout accuracy is **identical before and after sealing**
   (sealing is write protection, not deletion);
4. multi-candidate trials leave both banks unchanged in both arms (no credit).

Before this, no test asserted the write predicate itself.

### F.4 Determinism of the new diagnostics

`metrics_*.csv` from the new harness are byte-identical to the archived
`independent_validation_20261024/harness_frozen/` files for all six seed/arm
pairs, i.e. the L10.1 harness changes did not perturb reproducibility. The new
`sealing_*.csv` and `ctxperbank_*.csv` are deterministic by construction (fixed
seeds, no wall-clock content).

## G. Deliverables

- `work/L10_1_CONTROL_VALIDATION.md` (this file)
- `work/L10_1_CONTROL_VALIDATION.json` (machine-readable)
- `work/l10_raw/control_validation_20261025/` (270 hashed artifacts):
  `protocol/`, `frozen/`, `dseal/` (metrics + sealing + gzipped trials),
  `dctx/` (permutations, per-bank sweep), `egen/`, `regression/`, `analysis/`,
  `MANIFEST.md`

### Reproduction commands

```bash
cd stark
CORE="src/learning/ContextConditionedMemory.cpp src/learning/RelevanceRouting.cpp \
      src/neural/NeuralCell.cpp src/neural/Synapse.cpp src/neural/Network.cpp"
g++ -O2 -std=c++17 -Isrc -o ccm     src/learning/context_conditioned_memory_loop.cpp $CORE
g++ -O2 -std=c++17 -Isrc -o harness src/learning/l10_validation_harness.cpp $CORE
g++ -O2 -std=c++17 -Isrc -o t_seal  tests/test_l10_1_sealing.cpp $CORE
./ccm                                  # track P-FROZEN (writes work/…report…json; run in a scratch dir)
./t_seal                               # 276 assertions
./harness --mode perm --seeds 123456789,218213831,171473193 --tasks 3        # D-CTX-1 input
./harness --mode tasks --out DIR --seeds 123456789,218213831,171473193 --seal 1 --tag _sealON
./harness --mode tasks --out DIR --seeds 123456789,218213831,171473193 --seal 0 --tag _sealOFF
# D-SEAL-A   : add --commit 60      (and --commit 240 for A')
# D-SEAL-B   : add --commit 240 --misroute 0.20
# D-CTX-3    : add --ctxperbank
# E-GEN      : --tasks 8 --banks 8 | --order 2,0,1 | --mode ctxnovel | --mode wrongbank
```

## H. Status, uncertainty, and what needs owner approval

### Status

| Criterion | Status | Changed by L10.1? |
|---|---|---|
| L10-A, B, C, D, G, H | PASS | no |
| L10-E | **FAIL** (0.425926 > 0.40) | **no** — threshold and meaning untouched |
| L10-E2 (supplement) | PASS, 3/3 seeds | re-verified |
| L10-F | **FAIL** (NO-SEAL ≡ CCM) | **no** — criterion untouched; now proven untestable as written |
| L10-I | no new failures vs L9 baseline | re-verified (26 targets) |
| L10-J | reported honestly | satisfied |

### Requires owner approval (not decided here)

1. **A-1 (L10-F):** replace with an opportunity-bearing protocol + pre-declared
   margin. Without it, L10-F can never pass, whatever the mechanism does.
2. **A-2 (L10-E):** replace "context-off ≤ 0.40" with "excess over analytic
   fallback ≤ 0.02 **and** per-task margin ≥ 0.60 on ≥ 2 of 3 tasks".
3. **A-3 (controls):** split K2-STRESS into capacity and seal-on-reuse arms;
   report FROZEN-ROUTER routing error separately from wasted selection trials.

### Remaining uncertainty

- The corrected sealing diagnostics are still a 3-task toy domain; the magnitude
  (0.53 → 0.00) is a property of this task structure, not a forecast.
- D-SEAL-B is a *combined* generator (short window **and** cue corruption); its
  two ingredients are not separated. D-SEAL-A isolates the window change.
- 8-task runs are the largest tested; bank-exhaustion behaviour beyond that is
  unexamined.
- `test_phase1_affinity` remains unexecuted on Linux.
- Every exploratory number (E-GEN, extra seeds) is separate from the frozen
  evidence and must not be quoted as acceptance evidence.

### A.P.E.X. progress

**Unchanged at ≈50 %.** This milestone repairs experimental controls and
corrects two descriptions of the system; it adds no capability. Two official
criteria remain failed, one of them provably untestable as written, and the
capability is still a 3-context toy demonstration. If anything, the estimate
should be read as *slightly better established* at the same numeric value — not
higher.

### Recommended next milestone

**L10.2 — Specification amendment and re-acceptance:** have the owner decide A-1
and A-2, fold the accepted text into a v1.1 protocol, re-run the frozen battery
under the amended criteria, and only then consider L11. The alternative — starting
L11 with two criteria that cannot pass — would carry a known-broken acceptance
record forward.
