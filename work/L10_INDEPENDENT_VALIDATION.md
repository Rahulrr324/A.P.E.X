# STARK-L10 — Independent Validation

**Disposition: REPRODUCED**, with two published criteria that remain **FAILED**
(L10-E, L10-F), one **reporting defect found and fixed** (unmeasured controls
serialized as `0.0`), and one new evidence-backed explanation of why L10-F is
vacuous under the frozen protocol.

The engineering milestone passes validation: the published numbers are real,
the controls were run as documented, and no leakage was found. The *scientific*
outcome is unchanged — L10-E and L10-F still fail, and nothing in this document
relaxes them.

---

## 1. Repository and provenance

| Item | Value |
|---|---|
| Repository | `Rahulrr324/A.P.E.X` (GitHub, private), default branch `main` |
| Validation branch | `validation/l10-independent` (created from the audited L10 commit) |
| Validation start SHA | `49cc6ba18650c0d9614bb9e8918fe65453ec5a02` |
| Audited L10 commits | `9930d7d` (implementation), `791ce82` (reports), `49cc6ba` (report SHA note) |
| Branch base | `5f5a57717509623bd4c79460d50c05f7cbc605c3` (grafted/shallow boundary `563395f1…`) |
| PR #2 | **OPEN, unmerged**, head `arena/c90f7329-a-p-e-x` @ `5f5a577…` — untouched by this work |
| PR #3 | OPEN, head `arena/86da64f9-a-p-e-x` @ `49cc6ba…` — not modified by this work |

Verified with `git status`, `git remote -v`, `git log`, `git ls-remote origin`,
`gh repo view`, `gh pr view 2`, `gh pr view 3`.

**Checkout is shallow and grafted** at `5f5a577` (`.git/shallow` lists
`563395f1…` and `5f5a577`). Consequences, stated so they are not mistaken for
defects: history before L9 is not present locally, so "reproduce at the verified
base" for the Phase-1 gates was done at the L10 commit instead (§7), and the
L9 → L10 delta was reviewed with `git diff 5f5a577 49cc6ba` rather than per-commit
blame.

## 2. Source inspected

Read in full, not summarised from the report:

| File | What was checked |
|---|---|
| `stark/src/learning/ContextConditionedMemory.h` | agent layout, config surface, declared lifecycle states |
| `stark/src/learning/ContextConditionedMemory.cpp` | bank construction, plasticity scoping, routing math, baseline update, probe/commit paths, serialization |
| `stark/src/learning/context_conditioned_memory_loop.cpp` | arm definitions, task/cue generation, evaluation seeds, aggregation, JSON emission |
| `stark/tests/test_context_conditioned_memory.cpp` | what the 330 assertions actually pin |
| `stark/design/context_conditioned_memory_milestone.md` | frozen thresholds, revision log v1.0–v1.6, non-leakage claims |
| `stark/src/neural/Network.{h,cpp}`, `Synapse.cpp` | eligibility-gate semantics (per **pre-synaptic neuron**), what `reset()` does and does not clear |
| `stark/src/learning/RelevanceRouting.cpp` | L9 path reused unchanged (S→A matrix, channel REINFORCE) |

### 2.1 Architecture findings (code-level)

- **Banks are structurally disjoint.** Each bank owns its own S and A
  populations, WTA and self-excitation. This is *necessary*, not stylistic: the
  STARK-L5 gate is per pre-synaptic neuron (`Network.cpp:336`), so plasticity can
  only be scoped to a bank if the bank owns its S neurons. Verified exhaustively
  by the new `test_l10_structural_audit` (§5.1): 0 cross-bank synapses, and the
  only inter-bank pathways in the whole network are `cue→R` (36) and `C→L` (4).
- **Plasticity is scoped twice over**: eligibility gate ON only for
  `S[k*][queried]`, *and* `writable` requires the bank to be active. Mapping
  credit additionally requires a single-candidate trial — the same rule L9 uses.
- **No task-specific initialisation.** All banks are constructed with
  `w_init = 0.35` and identical parameters; nothing is seeded per task.
- **Router state** is stored in ordinary `cue[f]→R[k]` synapses and read
  directly, like L9's `v`; it is serialized by STARK-007 with the rest of the
  network.
- **Baseline update reads only the current trial's reward.** It is inside the
  `learning_enabled && router_learning && mode == CC_LEARNED && forced_bank < 0`
  block, so no evaluation outcome and no future trial can enter it. It is a
  scalar state carried in the composite serialization.
- **Evaluation cannot perturb learning** in every L10 arm: the harness
  snapshots with `ccSerialize` and restores with `ccDeserialize` around each
  evaluation. The `SEQ-L9` parity arm deliberately does **not**, so that it
  reproduces L9's perturbing evaluation order — and that is exactly why it
  reproduces L9's numbers (§3.2).
- **Held-out cue pairs never enter training.** Training draws only from
  `train_cues` (4 pairs per task); held-out evaluation draws only from
  `holdout_cues` (2 pairs). There is no model selection, no early stopping and no
  checkpoint selection anywhere, so held-out data has no influence on any
  learned quantity. The *features* of held-out pairs do occur in training pairs —
  that is the intended, disclosed design (§7.4).

## 3. Reproduction

All work was done from a **clean extracted snapshot** of the audited commit
(`git archive 49cc6ba`), not from the working tree:

- compiler `g++ (Debian 12.2.0-14+deb12u1) 12.2.0`, `-O2 -std=c++17`
- no cmake in this sandbox; targets built from the explicit source lists in
  `stark/CMakeLists.txt`
- 2 vCPU / 3 GB, Linux; frozen benchmark 21.8 s per run
- source sha256 recorded in `work/l10_raw/independent_validation_20261024/MANIFEST.md`

### 3.1 L10 frozen evaluation — reproduced

```
cd stark && g++ -O2 -std=c++17 -Isrc -o ccm \
  src/learning/context_conditioned_memory_loop.cpp \
  src/learning/ContextConditionedMemory.cpp src/learning/RelevanceRouting.cpp \
  src/neural/NeuralCell.cpp src/neural/Synapse.cpp src/neural/Network.cpp
./ccm        # 8 arms x 3 frozen seeds
```

| Comparison | Result |
|---|---|
| Raw JSON md5 vs committed raw artifact | differs (`42d7719f…` vs `b38736bb…`) — **wall-clock fields only** |
| Results after removing `env.total_seconds` and per-seed `seconds` | **identical**, sha256 `5554710d03619ac9118ad660d7030cc47f32cfc23154765a7934cc65b8d34c0e` |
| That hash vs the committed first run | identical |
| That hash vs the committed determinism rerun | identical |
| First differing field (deep walk) | **none** |

So this is a *numerically identical* reproduction of every reported value, and
the committed determinism claim (two runs agree) is confirmed by a third
independent run. The raw JSON is not byte-identical across runs because it
embeds wall-clock timings — worth stating plainly, since "byte-identical" was
loosely used in the original report for the *results*.

### 3.2 L9 baseline — reproduced byte-identically

`continual_learning_loop` at the audited commit, clean tree:

- output md5 **`a00b62b330bf231fdecf2b4991ec44fa`** — identical to the md5 the
  L9 report records, and identical to the artifact committed by the previous
  milestone.
- All six arms reproduce the published pooled figures, e.g. `SEQUENTIAL`
  acq `[1.000000, 0.666667, 0.563889]`, mean forgetting `0.467593`, final
  average `0.275926`; `REPLAY` `0.366667 / 0.206481`; `FRESH-TRAINING`
  `0.116667 / 0.052778`.

### 3.3 Aggregation re-derived from raw trial rows

The frozen driver aggregates inside C++. To test the aggregation itself, a
**separate** harness (`stark/src/learning/l10_validation_harness.cpp`,
written for this validation) re-implements the frozen protocol from the design
document on the public CCM API, dumps every evaluation trial, and recomputes the
metrics in Python from those rows only:

- all 3 CCM seeds and all 3 SEQ-L9 seeds reproduce the frozen per-seed
  acquisition, final retention, mean forgetting and final average to 1e-12;
- pooled `CCM` 0.000 / 1.000, `SEQ-L9` 0.467593 / 0.275926 — identical;
- the per-task accounting is visible: `SEQ-L9` forgetting is seed 123456789
  `0.3944`, 218213831 `0.5972`, 171473193 `0.4111` (pooled 0.4676), which the
  frozen report only showed pooled.

The one apparent mismatch found while doing this (`171473193` final average
`0.205556` vs `0.205555`) is a float-format difference of 1e-6, not a
discrepancy.

## 4. Control validity

For each control: hypothesis, intervention, what stays constant, what changes,
expected, observed, and what it does / does not support.

### 4.1 `SEQ-L9` — baseline parity

- **Hypothesis:** the L10 harness is a faithful L9 baseline.
- **Intervention:** 1 bank, no cue, no probe, no commitment window, L9's own
  perturbing evaluation order.
- **Constant / changed:** identical task stream, seeds and trial counts;
  memory partitioned down to one bank.
- **Observed:** `0.467593 / 0.275926`, matching the published L9 SEQUENTIAL arm
  to 6 decimals and per seed.
- **Supports:** the comparison "CCM vs the L9 failure mode" is honest.
- **Does not support:** anything about cue or routing — this arm has neither.
- **Confound:** none material. Pooled acquisition `[1.000000, 0.666667,
  0.563889]`, mean forgetting `0.467593`, final average `0.275926` and held-out
  `0.402778` all match the production L9 `SEQUENTIAL` arm exactly; L9's
  `REPLAY-ABLATED` and `ORACLE` arms report the same figures, which is the
  documented L9 result that replay without benefit reproduces sequential
  learning.

### 4.2 `CCM` — the mechanism

- **Hypothesis:** context-conditioned bank selection lets conflicting mappings
  coexist.
- **Intervention:** 3 banks, learned router, probe→allocate→seal, 480-trial
  commitment window.
- **Observed:** acquisition 1.000/1.000/1.000 on every seed; mean forgetting
  0.000; final average 1.000; routing accuracy 1.000; held-out 1.000/0.997/0.997;
  unintended update mass 0.000 on both other rows and other banks.
- **Supports:** the capability claim, at toy scale.
- **Does not support:** any claim about long-horizon CL, real sensory context, or
  capacity beyond the supplied banks (§7).

### 4.3 `ORACLE-BANK` — routing ceiling

- **Intervention:** the driver forces the bank holding the current task.
- **Observed:** equal to `CCM` on every performance metric (1.000/1.000/1.000,
  forgetting 0.000, final average 1.000); the records differ only in
  `seconds`, `curve`/`acq_speed_trials` (forcing a bank changes when
  acquisition succeeds) and held-out (`1.000/1.000/0.997` vs `1.000/0.997/0.997`,
  a 1/360 difference on one trial).
- **Supports:** the learned router **attains** the diagnostic ceiling on this
  task stream — a stronger statement than "oracle is an upper bound".
- **Does not support:** any claim about how hard routing would be with more
  contexts, noisier cues, or overlapping signatures (where the oracle would
  separate from the learned router).
- **Usage caveat:** uses the task index, so it is diagnostic only. It is
  correctly labelled and is not part of any success criterion.

### 4.4 `SHUFFLED-CUE` — cue causality

- **Intervention:** at evaluation only, each trial's cue is replaced by a seeded
  cue drawn from a *different* task; everything else identical.
- **Observed:** pooled **0.1324** (final average 0.1352); refusals are
  structured, not random — accuracy falls to the rate at which the *wrong*
  bank's mapping happens to agree with the target task.
- Note: this control (like `CONTEXT-OFF`) is applied to the standard evaluation
  only; the held-out evaluation runs with intact cues, which is why held-out
  accuracy stays 0.992–1.000 in both arms.
- **Supports:** accuracy is causally mediated by the context cue.
- **Does not support:** a claim that the mechanism "detects" a bad cue — it
  simply routes faithfully to a wrong bank.

### 4.5 `CONTEXT-OFF` — the failed control, fully explained (§5)

- **Intervention:** all cue features zeroed at evaluation.
- **Observed:** pooled **0.426**, above the frozen 0.40.
- **Verdict:** FAIL, unchanged. The value is *predictable from the permutations*,
  and it demonstrates the absence of any residual context channel rather than the
  presence of one (§5).

### 4.6 `NO-SEAL` — sealing ablation, provably vacuous here (§6)

- **Intervention:** `seal_superseded = false`; every allocated bank stays
  writable; only the `writable` predicate changes.
- **Observed:** numerically identical to `CCM` on **every** metric (verified
  field-by-field in the raw JSON, and independently in the harness).
- **Verdict:** L10-F FAIL, unchanged. New evidence (§6) shows the ablation has
  **no opportunity to act** under this protocol, and that it does matter once the
  commitment window is removed (0.000 → ≈0.52 mean forgetting).

### 4.7 `K2-STRESS` — capacity

- **Intervention:** 2 banks for 3 tasks.
- **Observed:** 0.271 mean forgetting (= (0 + 0.8139 + 0)/3), 0.6361 final
  average; task-2 retention 0.025–0.325 while tasks 0–1 stay at 1.000; routing
  still 1.000 because the harness forces the (reused) bank.
- **Supports:** the capability is bounded by bank count.
- **Confound (material, resolved):** at exhaustion the driver *also un-seals* the
  reused bank, so the arm changes capacity **and** protection simultaneously. The
  confound was checked and is measurably inert (sealing is vacuous under the
  protocol — §6), but it is still a confounded intervention and is recorded as
  such rather than defended.

### 4.8 `FROZEN-ROUTER` — learned routing

- **Intervention:** router never updated; allocation and the commitment window
  still active.
- **Observed:** pooled final average **0.425926**; acquisition collapses to
  1.000 / 0.167 / 0.333-ish per seed while retention of the already-learned banks
  stays 1.000; routing accuracy is 1.000 on task 0 and **0.000 on tasks 1–2**
  (every evaluation trial selects bank 0); pooled held-out 0.9972 / 0.1111 /
  0.1694.
- **Supports:** the *learned* router carries the capability — extra neurons alone
  do not. Note the router weights are exactly `0.0` in this arm versus
  `[1.064, -0.532, -0.532, 0.936, …]` in `CCM`.
- **Does not support:** a decomposition of routing error versus wasted
  selection trials; both are consequences of the same intervention.
- **Cross-check (new):** this arm's evaluation metrics are **field-for-field
  identical to `CONTEXT-OFF`** (acquisition, all retentions, final average,
  routing, bank map, update mass) on all three seeds, differing only in
  `curve`, `acq_speed_trials`, `holdout` and `router`. Both reduce to "always
  bank 0", which is an independent confirmation of the fallback mechanism in §5.

### 4.9 Leakage audit

No leakage found. Specifically checked: no `π`/`φ`/task-index read inside the
mechanism (only the reward computation and analysis); no held-out pair in any
training stream; no model/checkpoint/hyperparameter selection on held-out data;
baseline updated only from the current trial's reward on learning trials; probe
uses no labels; evaluation state-restoring. The one remaining channel — that the
*driver* decides when to probe/allocate/commit — is disclosed structure, not
leakage, and is now demonstrated to matter (§6).

## 5. L10-E investigation (context-off > threshold)

The published explanation was "arithmetically floored near ⅓". That was a
hand-wave. The floor is exactly computable, and it is **not** ≈0.333.

**Mechanism.** With all cue features zeroed, every router score is 0, the
softmax is uniform, and the masked argmax returns the **lowest-index allocated
bank** — always bank 0, which holds π₀. A context-off trial's accuracy under
task `t` is therefore 1 if `π₀(q) == π_t(q)` and 0 otherwise, for each queried
identity `q`.

**Prediction from the actual permutations** (dumped from `makeLRMapping`, see
`analysis/l10e_context_off_decomposition.txt`):

Per-task rows (task indices 0-based, as emitted by the driver; bank 0 holds task 0):

| seed | task 0 | task 1 | task 2 | per-seed mean (measured = analytic) | banks used |
|---|---|---|---|---|---|
| 123456789 | 1.0000 / 1.0000 | 0.1667 / 0.1667 | 0.3333 / 0.3333 | 0.5000 | {0} |
| 218213831 | 1.0000 / 1.0000 | 0.1667 / 0.1667 | 0.1667 / 0.1667 | 0.4444 | {0} |
| 171473193 | 1.0000 / 1.0000 | 0.0000 / 0.0000 | 0.0000 / 0.0000 | 0.3333 | {0} |

(each cell is *measured / analytic*; the exact table is in
`analysis/l10e_context_off_decomposition.txt`)

Pooled measured **0.425926** = analytic **0.425926**, and the identity of the
fallback bank is confirmed directly from the trial rows (all 120 trials per
task-eval select bank 0).

**Conclusions.**

1. The measured value is fully determined by the three permutations; it is not a
   defect, not residual context information, and not information leaking through
   bank identity, allocation order, or shared weights. Enumerating all network
   pathways (§5.1) leaves exactly two inter-bank paths — `cue→R` and `C→L` — and
   neither carries bank identity into the decision.
2. The floor is **not** "≈⅓": it is the mean over tasks of the π₀-vs-π_t agreement
   rate, which happens to be 0.4259 for these three seeds. The original report's
   "≈0.33" approximation was wrong in value (right in spirit).
3. **The criterion as frozen cannot be satisfied.** Any correct implementation
   must return one bank when the cue is removed, and that bank is right for
   exactly one task. For task 0 the context-off accuracy is 1.000 by
   construction. Only a mechanism that *refuses to answer* when uncertain could
   score below 0.40 — which is a different, and arguably better, behavioural
   requirement.
4. The pre-registered substitute L10-E2 (per-task margin ≥ 0.60 on ≥ 2 of 3
   tasks) is satisfied (2/3 and 3/3 per seed), and is the informative statement:
   removing the cue costs 0.833–1.000 on the non-fallback tasks.

No threshold was changed. L10-E remains **FAIL**.

### 5.1 Structural audit added

`stark/tests/test_l10_structural_audit.cpp` (new, 357 assertions) enumerates
every synapse in the agent and asserts: 0 cross-bank synapses; exactly one
`n_ids × n_ids` plastic matrix per bank with correct endpoints and three-factor
enabled; the complete pathway census is `S→A=108, A→A=108, cue→R=36, C→L=4`
and nothing else leaves a bank; router and baseline arrays are per-bank sized;
serialization round-trips lifecycle state and baselines; truncated records are
rejected.

## 6. L10-F investigation (NO-SEAL ≡ CCM)

**Implementation level.** The `NO-SEAL` arm differs from `CCM` in exactly one
config bit (`seal_superseded = false`), which feeds exactly one expression: the
`writable` predicate. `bank_state` is still maintained (never `SEALED`), and
every other conditional is untouched. Verified by diffing the two arms' raw
per-seed records field by field: `acq`, `ret_t1_t2/t3`, `routing`, `holdout`,
`task_bank`, `update_mass`, `curve` are **bit-identical** on all three seeds.
The only differing fields are `seconds` (wall clock), `bank_state` (the intended
effect — never `SEALED`), and — *after* the fix in §10 — `shuffled`/`ctx_off`,
which are `null` for `NO-SEAL` because it does not evaluate those controls. In
the **original** artifact `CCM` reported those controls as measured values
(0.132407 / 0.425926) while `NO-SEAL` reported `0.0` — i.e. the reporting defect
of §10 made the two arms differ in exactly the fields where `NO-SEAL` had not
measured anything; that difference was never a behavioural one. `NO-SEAL` ≡
`CCM` on every performance metric in both the original and the corrected
artifact.

**Experiment level — the ablation is vacuous under this protocol.** From the
trial rows:

| seed | training trials | unforced phase-1 (mapping-credit) trials | phase-1 trials on a non-active bank | trials where a write was blocked |
|---|---|---|---|---|
| 123456789 | 2160 | **0** | **0** | 62 |
| 218213831 | 2160 | **0** | **0** | 67 |
| 171473193 | 2160 | **0** | **0** | 64 |

The causal chain is complete and unavoidable: mapping credit exists only on
single-candidate trials → single-candidate trials exist only in phase 1 → phase 1
is exactly the 480-trial commitment window → during the window the router is
*forced* to the active bank. A write to a non-active bank is therefore impossible
by construction, so the `writable` predicate can never bind on a trial that could
have written. **NO-SEAL ≡ CCM is a theorem of the protocol, not a null result
about sealing.** (The 62–67 "blocked" trials are phase-2 selection trials on
non-active banks, which are non-writable for *both* arms because they are
single=false — they carry no mapping credit in either arm.)

**Provoked experiment (clearly exploratory).** Removing only the commitment
window (`commit_trials = 0`) gives the ablation an opportunity:

| seed | arm | acq T1/T2/T3 | mean forgetting | final average |
|---|---|---|---|---|
| 123456789 | seal ON | 1.000/1.000/1.000 | **0.000** | 1.000 |
| 123456789 | seal OFF | 1.000/1.000/1.000 | **0.522** | 0.478 |
| 218213831 | seal ON | 1.000/1.000/1.000 | **0.000** | 1.000 |
| 218213831 | seal OFF | 1.000/0.833/0.842 | **0.533** | 0.358 |
| 171473193 | seal ON | 1.000/1.000/1.000 | **0.000** | 1.000 |
| 171473193 | seal OFF | 1.000/1.000/1.000 | **0.511** | 0.489 |

**Conclusion.** Sealing is genuinely redundant *for the frozen protocol*, and
genuinely load-bearing *without the commitment window*. The original report's
conclusion ("context-conditioned selection, not write protection, confines
plasticity") is correct for the frozen protocol, but incomplete: it attributed
the redundancy to selection in general, whereas the precise cause is that the
commitment window already excludes every trial that could write elsewhere.

**L10-F remains FAILED.** Satisfying it would require either an implementation
change (make the commitment window partial) or a specification change to L10-F.
Neither was made here; §10 records this as an open decision for the project
owner, not something this validation may decide.

## 7. Evidence-quality assessment

### 7.1 What the controls isolate

| Control | Isolates | Confound |
|---|---|---|
| SEQ-L9 | baseline parity | none |
| NO-SEAL | write protection | **vacuous under the protocol** (§6) |
| K2-STRESS | capacity | also un-seals the reused bank (inert, but confounded) |
| FROZEN-ROUTER | learned routing | conflates routing error with wasted selection trials |
| SHUFFLED-CUE / CONTEXT-OFF | cue dependence | reflects the fallback bank's mapping, by construction |
| ORACLE-BANK | routing ceiling | uses the task index (diagnostic only) |

### 7.2 Held-out generalisation — real but narrow

The held-out pairs (e.g. task 1: `(1,3)`, `(2,3)`) are never trained, and each of
their features appears in *other* training pairs, so a linear-softmax router
generalises by construction. Accuracy 0.9917–1.000 confirms the router is
feature-compositional rather than pattern-memorising — but that is the expected
behaviour of the chosen model class, not evidence of broad generalisation.

**Exploratory stress test:** cross-signature cue pairs (one feature from the
target task's group, one from another task's group) — a combination that never
occurs in training and that a purely additive router *must* mis-handle:

| seed | task 1 | task 2 | task 3 | held-out (within-signature) |
|---|---|---|---|---|
| 123456789 | 0.258 | 0.633 | 1.000 | 1.000 / 1.000 / 0.992 |
| 218213831 | 0.133 | 0.542 | 1.000 | 1.000 / 1.000 / 1.000 |
| 171473193 | 0.000 | 0.483 | 1.000 | 1.000 / 0.992 / 1.000 |

As predicted: the router degrades to a weighted average on out-of-distribution
combinations. Honest reading — the held-out result is *within-distribution
composition*, and the "meaningful generalisation" claim should stay narrow.

### 7.3 What is **not** established

The task is 6 identities, 2 channels, 3 permutations, 12 cue features, 3 seeds;
each bank is a full `6×6` mapping trained with 720 labeled trials. This shows the
architecture *can* represent and select conflicting mappings; it says nothing
about:
- long-horizon continual learning, non-stationary or adversarial streams;
- mapping capacity per bank (each bank is used for exactly one task);
- cue structures with overlapping signatures or noisy/partial cues;
- whether the probe rule would trigger correctly with realistic, drifting input;
- deployment behaviour on the target hardware.

## 8. Additional exploratory results (separate from the frozen evaluation)

All in `work/l10_raw/independent_validation_20261024/exploratory/`, 3 seeds
unless noted. None of this replaces or overwrites the frozen results.

| Experiment | Result | Reading |
|---|---|---|
| 10 seeds (3 frozen + 7 new) | CCM mean forgetting **0.0000** (sd 0.0000), final avg **0.9989** (min 0.9944), min acquisition 0.9833; L9 on the same seeds 0.4339 ± 0.0798 forget, 0.2919 final | The result is not seed-specific |
| 4 tasks / 3 banks | forgetting 0.213, final avg 0.719, min acquisition 0.508 | Capacity is the binding constraint; no graceful degradation |
| 5 tasks / 5 banks | 0.000 / 0.999 | Scales with supplied banks |
| 6 tasks / 6 banks, 24 cue features | 0.000 / 0.989, min acquisition 0.833 | Holds to 6 tasks; acquisition slips slightly |
| Order 0,1,0 with 2 banks (revisit) | 1.000 across all steps | A sealed bank is **not** consulted on revisit; prior learning is preserved |
| Wrong-bank start (task 1 forced into bank 1) | forgetting 0.271, final avg 0.636 | A bad initial allocation costs far more than it should — the commitment window is unforgiving |
| Process restart (state file → new process) | final retention, bank map, and post-restart acquisition identical to the uninterrupted run (3/3 seeds) | Cross-process checkpoint recovery is exact |

Practicality: 27.7–28.1 KB of serialized state per agent, 21.8 s for the whole
8-arm × 3-seed benchmark, peak RSS 7.2 MB. Memory growth is linear in banks ×
identities² — fine at this scale, unexamined for a personal assistant with
thousands of contexts.

## 9. Regressions

Built from the clean snapshot with the explicit source lists (no cmake
available). **Working directory: `stark/`** (canonical layout; see the fixture
note).

| Suite | Exit | Result |
|---|---|---|
| `test_neuron`, `test_params`, `test_synapse`, `test_integration`, `test_network` | 0 | pass |
| `test_stdp` | 0 | All tests passed |
| `test_homeostasis`, `test_three_factor`, `test_serialization` | 0 | ALL TESTS PASSED |
| `test_learning_loop`, `test_delayed_reward`, `test_sequential_context` | 0 | ALL TESTS PASSED |
| `test_associative_memory`, `test_eligibility_gating`, `test_learned_relevance`, `test_n_way_learned_relevance` | 0 | ALL TESTS PASSED |
| `test_context_conditioned_memory` | 0 | **PASS (330 assertions)** — claim confirmed |
| `test_phase1_profiler` / `_accounting` / `_budget` / `_records` / `_reproducibility` | 0 | PASS (34 / 67 / 55 / 72 / 37 assertions) |
| `test_phase1_gates` | 0 | **PASS, 437 assertions, 0 failures** — claim confirmed |
| `test_phase1_affinity` | — | **does not compile** on Linux: `DWORD_PTR` not declared (Win32-only source). Pre-existing; not executed, therefore **not** claimed to pass |
| `n_way_learned_relevance_loop_L8` | 0 | `verdict: PASS` |
| new `test_l10_structural_audit` | 0 | PASS (357 assertions) |

Re-checked after the fix in §10: all suites above still exit 0.

**Final re-run from the validation working tree** (log:
`regression/final_rerun_20261024.txt`): all four affected binaries rebuilt with
exit 0; the frozen evaluation reproduces normalized sha256 `fe76eb2a…` (the
fixed build) with the criteria block unchanged; `test_context_conditioned_memory`
330/330 and `test_l10_structural_audit` 357/357 pass; the independent harness's
six metrics CSVs are **byte-identical** to the archived `harness_frozen/` run;
and the integrity checker exits 1 on the frozen pre-fix report and 0 on the
fixed one. The three frozen artifacts were re-hashed and are unmodified
(`b38736bb…`, `17beb41e…`, `a00b62b3…`).

**Fixture dependence (verified, then corrected for).** Run from a directory
without `build/dev_bin/`, four learning suites abort with
`Network::save: cannot open file: …` and `test_phase1_gates` reports exactly
19 failures (14 × `copy_file` at line 1509 plus 5 clean/dirty directory checks).
Created `build/dev_bin/` in the run directory: all four suites pass with exit 0,
and `test_phase1_gates` passes 437/437. Re-verified the 19-failure form in a
second isolated directory (`regression/test_phase1_gates_isolated_cwd.txt`). The
"19 known failures" are therefore a **working-directory artifact**, not a gate
regression, and no test source was modified. Tests that were not executed
(`test_phase1_affinity`) are not reported as passing.

## 10. Defect found and fixed

### 10.1 Unmeasured controls were serialized as measured zeros

**Defect.** `context_conditioned_memory_loop.cpp` wrote `shuffled_cue_mean: 0.0`
and `context_off_mean: 0.0` into the report for **every arm**, but only the
`CCM` arm (`context_controls = true`) ever evaluates those controls. Six of the
eight arms therefore published `0.000000`, which is indistinguishable from a
measured 0 %. This is a reporting-integrity defect, not a computational one: the
criteria were computed from the CCM arm only, so no verdict changes.

**Impact on published claims:** none of the L10 criteria; the L10-E / L10-F
verdicts are unchanged. Impact on readers: an arm that *never ran* the control
appeared to have run it and scored 0 — which is exactly the kind of thing a
validation must not leave in place.

**Fix (smallest justified change):** emit `null` when an arm did not evaluate a
control, plus an explicit `context_controls_measured` boolean per arm. No
threshold, metric definition, or measured value changed.

**Before / after, verified:**

- every previously *measured* value is unchanged — a field-by-field comparison
  of all 8 arms × 3 seeds found **zero** unexpected differences;
- `CCM` still reports `shuffled_cue_mean = 0.132407`, `context_off_mean =
  0.425926`;
- the criteria block is byte-identical before and after;
- the other seven arms now report `null` with `context_controls_measured:
  false`;
- the fixed binary reproduces the same results on two independent runs
  (normalized sha256 `fe76eb2a…`).

**Regression test:** `work/l10_raw/check_report_integrity.py` fails the pre-fix
report (8 × "no `context_controls_measured` flag") and passes the post-fix
report. Added alongside: `test_l10_structural_audit` (§5.1).

**Files changed by this validation:**

```
stark/src/learning/context_conditioned_memory_loop.cpp   report serialization only (context controls -> null + flag)
stark/src/learning/l10_validation_harness.cpp            NEW independent harness (reproduction + exploration)
stark/tests/test_l10_structural_audit.cpp                NEW structural audit (357 assertions)
stark/CMakeLists.txt                                     two targets added
work/l10_raw/check_report_integrity.py                   NEW regression check for the defect
work/L10_INDEPENDENT_VALIDATION.md                       this report
work/L10_INDEPENDENT_VALIDATION.json                     machine-readable results
work/l10_raw/independent_validation_20261024/**           new raw evidence (original artifacts untouched)
```

No frozen threshold, historical result, acceptance record, or L10 source file
was modified. The original `work/l10_raw/final_run/` artifacts are preserved
byte-for-byte; the corrected report is written to the separate
`independent_validation_20261024/post_fix/` directory.

## 11. Limitations and remaining uncertainty

1. **Shallow checkout.** History before `5f5a577` is absent locally, so
   "reproduce a pre-existing failure at the verified base" was done at the L10
   commit rather than at the L9 base. No pre-existing failure was found that
   needed base comparison, except the fixture-layout artifact, which was
   reproduced in two independent directories.
2. **Windows-only suite not executed.** `test_phase1_affinity` cannot be built
   here. Its status is unknown, not passing.
3. **No cmake.** Targets were built from the CMake source lists by hand; the
   build graph itself (link order, target properties) was not exercised.
4. **My harness is a re-implementation, not the production driver.** It is
   evidence *about* the frozen protocol, and it agrees with the production driver
   to 1e-12 on every frozen number — but it is not an independent implementation
   of the *mechanism*, which is shared code.
5. **Exploratory results are single-configuration.** No hyperparameter sweeps, no
   confidence intervals on the exploratory arms beyond 3 seeds.
6. **The K2-STRESS confound and the FROZEN-ROUTER conflation** remain; they were
   characterised, not eliminated.
7. **L10-E and L10-F are unresolved as scientific criteria.** Both need a
   specification decision (a refusal-to-answer metric; a partial commitment
   window), which is the owner's call, not this validation's.

## 12. A.P.E.X. progress

Previous estimate **≈50%** (a judgement, not a measurement). **Unchanged at
≈50%.**

Validation adds confidence, not capability, and the guidance is explicit that
file count and green tests must not move the number. What this milestone
establishes: L10's numbers are real and reproducible to 1e-12, its controls run
as documented, the bank architecture is structurally disjoint, and there is no
leakage. What it does *not* establish: any new capability, any resolution of
L10-E/L10-F, or any evidence beyond a 3-task toy domain. Two of L10's criteria
remain failed, one of them provably unachievable as written.
