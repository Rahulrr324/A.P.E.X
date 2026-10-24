# STARK-L10 — Context-Conditioned Memory and Continual Learning

**Version:** 1.8 (2026-10-24)
**Version history:** **v1.6 (frozen 2026-10-24, before the reported evaluation)**
is the version every L10 result was produced and reported under. **v1.7** added
the criterion **L10-K1** in §8, ratified by the repository owner on 2026-10-24.
**v1.8** records the owner's milestone-closure decisions A, B and C
(2026-10-24): three annotation rows and a status line, no change to any criterion,
threshold, metric, seed or historical result (see §13).
**Schema:** STARK-L10-1
**Baseline:** STARK-L9 (`continual_learning_loop`, report `STARK-L9-1`, branch
`arena/c90f7329-a-p-e-x`, head commit `5f5a577`)

§1–§12 are the design. §13 is the append-only revision log: every mechanism
change made during development, the measurement that motivated it, and the
preserved failure. No success threshold in §8 was ever altered; the two
criterion records that were clarified are documented there before the reported
evaluation.

---

## 1. Problem statement carried forward from L9

L9 established (reproduced in this milestone, see the L10 report §2):

- The LRAgent has **one** shared plastic S→A matrix with one row per identity
  (`dw = eta_3f · m · e_`, clamp [0.0, 0.7]). Two tasks that require different
  responses for the same identity cannot both be stored.
- 3-task permutations with a shared φ produce mean forgetting 0.468 and final
  average accuracy 0.276 (SEQUENTIAL, 3 seeds).
- Replay and consolidation reduce forgetting only by destroying new-task
  acquisition (zero-sum on the shared rows); the oracle-selection arm is
  identical to SEQUENTIAL, so the bottleneck is the mapping, not channel
  routing.
- `FRESH-TRAINING` (all 3 tasks interleaved) reaches 0.053 ≈ chance.

L9's conclusion was that the minimum architectural prerequisite is **separate
plastic resources that can be selected from observable context**.

## 2. Hypothesis

H1 (primary). A network whose plastic memory is partitioned into K banks,
where (a) the bank used on a trial is chosen by a **learned** policy over
**observable context-cue features**, (b) plasticity is confined to the
selected bank's queried row, and (c) superseded banks are write-protected,
can acquire 3 conflicting identity→action mappings with mean forgetting
≤ 0.10 and final average accuracy ≥ 0.85, while the L9 shared-matrix baseline
stays at ≈0.47 forgetting / ≈0.28 final average on the identical task stream.

H2 (generalization). Because the routing policy is a linear-softmax over cue
*features* (not over whole cue patterns), what it learns from feature subsets
should transfer to **held-out cue combinations** never presented, giving
≥ 0.80 accuracy on those combinations.

H3 (causality). If accuracy depends on the context cue, then shuffling the
cue at evaluation and zeroing the cue at evaluation must both degrade
accuracy substantially (see L10-E / L10-E2).

H4 (capacity, honest limit). The mechanism cannot exceed the capacity it is
given: with K = 2 banks and 3 tasks one task must share a bank and forgetting
must reappear.

## 3. Architecture: Context-Conditioned Memory (CCM), v1.6

Extends `learning::LRAgent` (STARK-L6/L7/L8) and reuses STARK-001/002/003/005/
006/007 unchanged. One `Network` holds everything, so STARK-007 serialization
still applies.

### 3.1 Neurons

| group | count | role |
|---|---|---|
| `cue[f]` | `n_feat = 12` | observable context-cue features (input only) |
| `S[k][i]` | K × `n_ids` = 6 | identity neurons, one set **per bank** |
| `A[k][r]` | K × `n_ids` = 6 | response neurons, one set **per bank** |
| `L[s]` | `n_chan = 2` | channel markers (unchanged from L6–L9) |
| `C[c]` | `n_ctx = 2` | context neurons (unchanged from L6–L9) |
| `R[k]` | K | router readout cells (weight storage only; never driven) |

Per-bank S/A populations are what make bank-scoped eligibility possible: the
STARK-L5 gate is per *pre-synaptic neuron*, so an S→A row can be gated per
bank only if each bank owns its own S population.

### 3.2 Synapses

- Plastic `S[k][i] → A[k][r]`, delay `floor(r/2)`, THREEFACTOR (STARK-006),
  parameters identical to L6–L9 (`eta_3f = 0.6`, `E_plus = 0.05`,
  `E_minus = 0.02`, `tau_e = 8`, clamp `[0.0, 0.7]`).
- Intra-bank WTA (`w_inh = -1.2`) and self-excitation (`w_self = 1.05`), same
  as L9 but within a bank only.
- Channel routing `C[c] → L[s]` holds the L6–L9 routing state `v`; mechanism
  unchanged (REINFORCE, `beta_route = 0.3`, clamp ±1.5).
- Router `cue[f] → R[k]` holds router weight `W[f][k]`; read directly (like
  `v`), updated by REINFORCE, clamped to ±`v_clamp` = ±1.5.

### 3.3 Trial flow (per trial)

1. `Network::reset()` (eligibility gates restored ON).
2. Channel attention (unchanged): `a = softmax(v[ctx] / softmax_T)`; on
   multi-candidate trials the mechanism samples the channel `s*` and applies
   attentional input gain to the other channels; on single-candidate trials
   no selection decision is made. Identical to L9.
3. **Bank selection (new).** Scores `score[k] = Σ_{f ∈ active features}
   W[f][k]`. The **behaviour** distribution is the softmax over
   `score / router_T` (`router_T = 0.5`) masked to *selectable* banks
   (allocated banks only), mixed with a uniform exploration component
   `explore_eps = 0.2` during learning. Sample `k*` while learning; take
   `argmax` when evaluating.
4. Cue window: active cue features driven with `cue_current`; C neurons
   driven as in L9.
5. Sample / interference / decision windows: **only bank `k*`** receives
   candidate drive, channel drive, background and noise. All other banks are
   silent. Spike-count majority over bank `k*`'s A neurons with the L9
   tie-breaking rule.
6. Reward: `+1` if `choice == π(queried)`, `-1` otherwise (L9).
7. Eligibility gates: **single-candidate trials** — gate ON for
   `S[k*][queried]` only, and only while bank `k*` is writable; every other S
   neuron gated OFF. **Multi-candidate trials** — all gates OFF (identical to
   L9, where selection trials carry no mapping credit).
8. Router REINFORCE, only when the bank was chosen by the policy (not forced):
   `adv = r − b`, with `b` a single slow **global** running baseline
   (`baseline_rate = 0.02`, `b ← b + rate·(r − b)`);
   `ΔW[f][k] = beta_route_bank · adv · (1[k = k*] − p_full[k])` for each active
   feature `f`, `beta_route_bank = 0.5`, clamped to ±1.5. `p_full` is the
   **unmasked** softmax over all banks (counterfactual credit, §13 v1.2).

### 3.4 Resource lifecycle (architecture-supplied structure — declared)

- A bank is **unallocated** (never written), **active** (writable), or
  **sealed** (read-only; all its S gates forced OFF).
- **Probe:** before each task's training, `n_probe_per_bank = 20` trials per
  bank are run with plasticity OFF and no router update, each bank forced in
  round-robin. The probe is the agent measuring its own banks on the current
  input stream; it uses no task label and no answer key.
- **Allocation rule:** if the best bank's mean probe reward `< θ_alloc = 0.5`,
  allocate the lowest-indexed unallocated bank as the new active bank and seal
  the previously active bank. Otherwise keep the best bank active (recognised
  context reuses its memory).
- **Commitment window:** the first `commit_trials = 480` learning trials after
  an allocation are forced to that bank with router updates suppressed. The
  resource must acquire content before its routing can be judged.
- If no unallocated bank remains when allocation is required, the
  lowest-scoring allocated bank is reused (capacity exhaustion → expected
  interference; measured, not hidden).

**This lifecycle is structure, not learning**, and is reported as such. The
learned quantities are: which bank each cue routes to, and each bank's
identity→response mapping.

### 3.5 Explicit non-leakage guarantees

- The mechanism never reads `π`, `φ`, the task index, or the answer table.
  `π` is consulted only by the driver to compute the scalar reward and by the
  analyser to score accuracy.
- `ORACLE-BANK` (driver forces the bank holding the task) exists **only** as
  a diagnostic upper bound and is labelled as such everywhere.
- Held-out cue combinations are generated after training and are never
  present in any training stream, router update, checkpoint selection,
  hyperparameter choice or seed choice.
- No task-boundary signal is given to the mechanism: task boundaries exist
  only in the driver and the mechanism sees a continuous trial stream
  (the probe/commitment schedule is driven by the *allocation* event, which is
  itself caused by observable reward).
- Every evaluation is read-only (`snapshot → evaluate → restore`).

## 4. Task stream (matched to L9)

- `n_ids = 6`, `n_chan = 2`, `n_ctx = 2`, `n_feat = 12`.
- 3 tasks, each a **full permutation** π of the 6 identities; φ is shared
  (identical to L9: `makeLRMapping(master)`, `+10007`, `+20011`, φ from
  task 1).
- Training budget per task, **identical to L9**: phase 1 = 80 single-candidate
  trials per identity (480), phase 2 = 40 multi-candidate selection trials
  per identity (240); same trial generation (`makeLRTrials`, same seeds), same
  `softmax_T = 1/(2√n_chan)`. L10 adds only the probe (60 trials/task) and
  the cue features, so CCM and the L9 baseline remain directly comparable.

### 4.1 Cue (context) structure

12 features in three signature sets of four:

| Task | signature features | training cues (2 active features) | held-out cues |
|---|---|---|---|
| 1 | `f0 f1 f2 f3` | (0,1) (0,2) (0,3) (1,2) | (1,3) (2,3) |
| 2 | `f4 f5 f6 f7` | (4,5) (4,6) (4,7) (5,6) | (5,7) (6,7) |
| 3 | `f8 f9 f10 f11` | (8,9) (8,10) (8,11) (9,10) | (9,11) (10,11) |

Every feature of a held-out pair also appears in that task's training cues
(individually, in other combinations), so a *componential* router can
generalise while a *pattern-memorising* router cannot. The cue-cluster → task
relation is discoverable only from the observable stream.

## 5. Arms

All arms use the same task stream, seeds and evaluation protocol.

1. **SEQ-L9** — L9 SEQUENTIAL reproduced inside the L10 harness: 1 bank, no
   probe, no cue, gated writes as L9, L9's own (perturbing) evaluation order.
   Must match L9's published SEQUENTIAL numbers exactly; a mismatch is a
   harness defect and is reported.
2. **CCM** — the proposed mechanism: K = 3, learned router, sealing, probe
   allocation, commitment window.
3. **ORACLE-BANK** — diagnostic upper bound: the driver forces the bank that
   holds the current task's mapping. Never a success claim.
4. **SHUFFLED-CUE** — CCM trained normally, evaluated with each trial's cue
   replaced (seeded) by a cue from a *different* task. Negative control for
   cue causality.
5. **CONTEXT-OFF** — CCM trained normally, evaluated with all cue features
   zeroed. Negative control.
6. **NO-SEAL** — CCM without write protection: every allocated bank stays
   writable. Ablation isolating protection from routing.
7. **K2-STRESS** — CCM with K = 2 for 3 tasks. Capacity-exhaustion limit.
8. **FROZEN-ROUTER** — CCM with the router never updated (scores stay zero →
   selection is uniform during learning, lowest-index bank at evaluation),
   allocation and commitment still enabled. Ablation isolating learned
   routing.

## 6. Evaluation protocol

- 20 trials per identity = 120 trials per task, learning disabled.
- After task 1: eval task 1. After task 2: eval tasks 1,2. After task 3: eval
  tasks 1,2,3. Evaluation never influences learning (read-only).
- Additional learning-disabled diagnostics:
  - held-out cue combinations per task, after task 3;
  - shuffled-cue and context-off evaluations after task 3 (all banks now
    exist, so the withheld-context condition is meaningful);
  - routing accuracy (argmax bank vs the bank that holds the task);
  - acquisition curve: 30-trial eval of the current task at 0/120/240/360/
    480/600 and 720 training trials.

## 7. Metrics

1. Acquisition accuracy per task.
2. Retention accuracy per task after each subsequent task.
3. Forgetting per task = acquisition − final retention.
4. Final average accuracy (mean of the 3 tasks' final retention).
5. Routing accuracy per task (analysis-time diagnostic; the mechanism never
   sees the task index).
6. Held-out cue-combination accuracy per task.
7. Shuffled-cue and context-off accuracy per task.
8. Weight-update mass per phase-1 mapping trial: intended (|Δw| on
   `S[k*][queried]`), unintended-rows (other rows of the same bank),
   unintended-banks (every other bank).
9. Acquisition speed = first diagnostic checkpoint reaching 0.80.
10. Per-seed results plus mean and sample standard deviation.
11. Wall-clock runtime and peak RSS.
12. Determinism (two runs byte-identical), save/load equivalence
    (bit-identical state, identical eval choices), checkpoint-resume
    equivalence (mid-training save + resume == uninterrupted run).

## 8. Frozen success criteria

| ID | Criterion |
|---|---|
| L10-A | CCM mean forgetting ≤ 0.10 **and** final average ≥ 0.85 |
| L10-B | CCM acquisition ≥ 0.85 on **every** task |
| L10-C | CCM routing accuracy ≥ 0.90 on every task |
| L10-D | CCM held-out cue-combination accuracy ≥ 0.80 per task |
| L10-E | shuffled-cue mean accuracy ≤ 0.40 **and** context-off mean ≤ 0.40 (see §13: the context-off half is arithmetically floored at ≈0.33; reported as-is) |
| L10-E (status, added in v1.8) | **RETAINED AND CLOSED as a historical failure** (owner decision A, 2026-10-24). The criterion, its 0.40 threshold, its metric and its measured FAILED result (context-off 0.425926, shuffled-cue 0.132407) are preserved exactly and are not withdrawn. Closure records that the outcome is final for the milestone; it does **not** convert the result to a PASS, does **not** rescind the failure, and does **not** assert that context is unnecessary. The context-off half is dominated by the random task draw (the fixed-point agreement of the fallback bank's permutation; expected 4/9; a perfect router passes the ≤ 0.40 bound with probability 0.1512 — see §13 and `work/L10_3_CONTEXT_CONTRIBUTION.md`), which is why the separate criterion L10-K1 now carries the context-contribution claim. |
| L10-E2 | correct-context minus context-off accuracy ≥ 0.60 for at least two of three tasks, and correct-context minus shuffled-cue ≥ 0.60 for at least two of three tasks |
| L10-K1 | **context contribution** (added in v1.7, owner decision 2026-10-24). On **every** primary seed: (a) `CAA_pooled ≥ 0.40`; (b) `CAA(t) ≥ 0.25` for at least two of the three tasks; (c) `CRA_pooled ≥ 0.50`. Where `CAA(t) = acc_correct(t) − acc_null(t)`, `acc_null(t) = (1/K)·Σ_k A(k,t)` is the accuracy of a context-ignoring policy measured by forcing each bank with the cue removed, `CRA(t) = R_correct(t) − 1/K`, and `R_correct(t)` is the fraction of correct-cue trials whose selected bank is the task's bank. Per-seed aggregation is the unweighted mean over the three tasks. **L10-K1 is separate from L10-E and does not reinterpret it** (see §13). |
| L10-F | NO-SEAL mean forgetting > CCM mean forgetting |
| L10-F (status, added in v1.8) | **SUPERSEDED AND CLOSED by L10-F2** (owner decision B, 2026-10-24). The original criterion and its FAILED result are preserved in full: under the v1.0 protocol (`commit_trials = 480`) no sealing opportunity arises, so the criterion was unsatisfiable **by construction** rather than unmet by the mechanism. The requirement is now carried by L10-F2 (owner ratification A-1, 2026-10-24; `SEAL-PAIR` with `commit_trials = 240`), which PASSED on all four pre-registered conditions on all three masters. Supersession does not delete or relabel the original failure. |
| L10-G | K2-STRESS worse than CCM (forgetting or final average) |
| L10-G (status, added in v1.8) | **SUPERSEDED by L10-G2** (owner decision C, 2026-10-24). The historical PASS was produced on a **confounded** arm: K2-STRESS simultaneously reused a bank and un-sealed the others (L10.1 diagnosis), so it could not isolate capacity. Both the original PASS and its confound disclosure are preserved. The capacity claim is now carried by L10-G2 (owner ratification A-3, 2026-10-24; capacity arm run with `--reuse-seal 0`, original decision rule unchanged), which PASSED (K2 final 0.6361 / forgetting 0.2713 vs CCM 1.0000 / 0.0000). Superseding a PASS here strengthens rather than weakens the record. |
| L10-H | persistence + determinism + checkpoint resume exact |
| L10-I | L1–L9 + STARK-001–007 + §K suites show no new failures vs the L9 baseline |
| L10-J | failures and limitations reported honestly; no threshold nudged |

A "PASS" requires the run output that supports it. Failures are reported as
FAIL with their number.

**Milestone closure status (v1.8).** L10 is **CLOSED** as of 2026-10-24, by owner
decisions A, B and C recorded in `stark/reports/L10_5_OWNER_DECISION.md`. Every
criterion has a final recorded outcome: L10-A/B/C/D/E2/K1/F2/G2/H satisfied,
**L10-E retained and closed as a historical failure**, **L10-F superseded and
closed by L10-F2**, **L10-G superseded by L10-G2**. Closure is a governance act:
it does not alter any measured value or any pass/fail outcome, and the superseded
criteria remain in this document permanently with their original results.

**Relationship between L10-E and L10-K1 (v1.7).** L10-E is retained exactly as
frozen in v1.6 and its reported result stands: **FAILED**, measured pooled
context-off 0.425926 > 0.40. L10-K1 is an additional, separately registered
criterion that measures context *contribution* against a measured
context-ignoring null; it is satisfied or not satisfied on its own evidence.
**Passing L10-K1 does not convert L10-E into a pass, and does not rescind,
reinterpret or downgrade L10-E's failure.** Both are reported side by side. The
reason a second criterion exists is recorded in §13 and in
`work/L10_3_CONTEXT_CONTRIBUTION.md`: the context-off half of L10-E is a
deterministic function of the random task draw (the fixed-point agreement of the
fallback bank's permutation), which a perfect model passes only 15.12 % of the
time, so it cannot measure context use.

## 9. Seeds

Evaluation masters: `123456789`, `218213831`, `171473193` (L8/L9 masters).
Task seeds: `master`, `master+10007`, `master+20011`. Training-schedule seeds
exactly as L9 (`master + k*1000`, `+1` for phase 2). Cue assignment seed
`master + 6001 + k`. Probe seed `master + 6100 + k`. Eval seeds
`master + 5001..5003` (L9-compatible) and `master + 8001..8003` for held-out
cue evaluation. Development seed (not evaluated): `987654321`.

## 10. Regression commands

Executed from `stark/` with g++ (this environment has no cmake; the commands
are the CMake targets' source lists, recorded in the report):

- L1–L9: `test_learning_loop`, `test_delayed_reward`,
  `test_sequential_context`, `test_associative_memory`,
  `test_eligibility_gating`, `test_learned_relevance`,
  `test_n_way_learned_relevance`, `n_way_learned_relevance_loop_L8`,
  `continual_learning_loop`.
- Neural: `test_neuron`, `test_params`, `test_synapse`, `test_integration`,
  `test_network`, `test_stdp`, `test_homeostasis`, `test_three_factor`,
  `test_serialization`.
- §K / M0 track: `test_phase1_*` — run and reported; known baseline failures
  tracked separately and **not** treated as L10 regressions.
- New: `test_context_conditioned_memory`, `context_conditioned_memory_loop`.

## 11. Persistence and lifecycle

- Persistent state: all bank S→A weights, router weights `W`, channel routing
  `v`, per-bank reward baselines, and bank metadata (allocation/seal flags).
  Metadata and baselines are serialized in a deterministic composite record
  (`CCM2|<network serialization>|<flags>|<baselines>|end`) because STARK-007
  serializes a `Network`, not agent-level metadata.
- Reset between trials: traces, eligibility gates, inputs (via
  `Network::reset()`); weights are never reset.
- Checkpoint-resume: serialize mid-task, reload into a fresh agent, continue;
  the final state and eval choices must equal the uninterrupted run's.

## 12. Integrity constraints

- L9 source, report and raw output are **not modified**; the L9 report is
  cited by reproduced hash.
- No M0/G7 threshold, evaluator, acceptance record or historical evidence is
  touched; M0/M1 status is untouched by this milestone.
- E3 is not executed. No acceptance campaign is started. PR #2 is not merged
  and no new PR is created.
- No hidden task labels, oracle routing (outside the labelled diagnostic
  arm), future rewards or evaluation labels enter training.

## 13. Protocol revisions (append-only)

All revisions below were made **before** the reported evaluation and without
changing any success threshold in §8. Each failure that motivated a revision
is preserved as evidence.

### v1.0 — engineering run (FAILED; preserved)

`work/l10_raw/protocol_v1.0_engineering_run/` holds a complete run of the
mechanism exactly as first specified (routing softmax over ALL banks, raw
reward REINFORCE, no commitment window, perturbing evaluation). Result:
`CCM` acquisition [0.447, 0.719, 0.519], mean forgetting −0.005, final
average 0.567, routing accuracy 0.000 on every task, held-out 0.125. Two
defects were identified:

1. **Structural waste.** With every bank in the candidate set, 2/3 of the
   mapping-credit trials landed on a bank that could never write, so the
   active bank saw ~1/3 of the credit it needed (acquisition 0.447 on a task
   the L9 baseline learns to 1.000).
2. **Evaluation was not read-only.** Diagnostic evaluations perturb
   persistent STDP traces (`A_plus`/`A_minus` are not cleared by
   `Network::reset()`), which broke bit-parity with L9.

### v1.1 — routing restricted to allocated banks + reward baseline

`route_over_allocated_only = true`: a bank that holds no memory cannot be
selected (resource-policy constraint, not a task hint). Reward baseline
introduced.

### v1.2 — counterfactual routing credit

Behaviour stays masked to allocated banks, but the REINFORCE gradient is
computed against the **unmasked** softmax, because a masked gradient is
exactly zero when only one candidate exists (task 1 therefore learned no
routing preference at all: the router row for `f00..f03` was identically 0.0,
so its correct routing rested on the argmax tie-break rather than on
learning).

### v1.3 — exploration mixture

`explore_eps`: the softmax committed to whichever bank won the first few
trials before a freshly allocated bank could learn its mapping (measured on
the development seed: p collapsed to 0.97 on a wrong bank within ~100 trials
of task 3).

### v1.4 — commitment window

`commit_trials = 480` (= exactly the phase-1 mapping-credit trials). Router
updates are suppressed during the window (off-policy), so routing is learned
only from choices the policy actually made. Without it the fresh bank
received 8–27 trials per identity and stayed at chance (task-3 acquisition
0.258–0.367).

### v1.5 — global slow reward baseline

The per-bank baseline converged to each bank's own success rate, which
silently switched routing learning off once the policy was correct and left
rarely observed cue features under-trained (task-3 held-out combinations
0.55). Replaced by a single slow global baseline (`baseline_rate = 0.02`),
`beta_route_bank = 0.5`, `explore_eps = 0.2`.

### v1.6 — evaluation made read-only in the harness

`snapshot → evaluate → restore` around every evaluation, so a measurement can
never change a result. Applied to all L10 arms. The `SEQ-L9` parity arm keeps
L9's perturbing evaluation order verbatim in order to reproduce the published
L9 numbers exactly; this is stated wherever those numbers are compared.

### Criterion records (before the reported evaluation)

**L10-E** as frozen in §8 is arithmetically unachievable in one of its two
halves, by construction and independently of any measurement: with the cue
withheld the routing policy must still select one bank, and that bank returns
its stored mapping for the queried identity, which is *correct* for exactly
one of the three tasks. The context-off mean therefore has a floor near
(accuracy of the fallback bank's task)/3 ≈ 0.33 rather than 0. L10-E is
retained and reported unchanged, and the supplementary criterion **L10-E2**
(per-task context margin) was added in §8 before the run.

### Development seed

Mechanism development after v1.0 used the single development seed
`987654321`, which is **not** one of the three evaluation masters. No
hyperparameter of v1.1–v1.6 was selected on an evaluation seed, and no
threshold in §8 was altered. The v1.0 engineering run *did* execute the
evaluation seeds; that run is preserved in full above rather than discarded.

### v1.7 — acceptance specification update: L10-K1 added (owner decision)

**Trigger.** L10.3 (`work/L10_3_CONTEXT_CONTRIBUTION.md`,
`stark/reports/L10_3_ACCEPTANCE_DECISION.md`) demonstrated, from the source and
from the registered permutations rather than from any measurement, that the
context-off half of L10-E is the fixed-point agreement between the fallback
bank's permutation and each task's permutation, with expected pooled value
4/9 = 0.4444 and attainable range [1/3, 1]. A perfect router therefore passes
the ≤ 0.40 threshold with probability 0.1512. The criterion's own hypothesis
(H3: *"if accuracy depends on the context cue, then … zeroing the cue must
degrade accuracy substantially"*) is still tested by it in the weak sense that a
degradation is observed, but the threshold cannot distinguish a system that uses
context from one that does not.

**Decision.** The repository owner was asked directly to choose among three
dispositions and selected **Option B**: *retain L10-E unchanged and add L10-K1
as a separate criterion*. Recorded 2026-10-24 in
`stark/reports/L10_3_ACCEPTANCE_DECISION.md` §5, and transcribed into §8 here.
The agent proposed the option and recorded the answer; it approved nothing.

**What changed.** Exactly one row was added to §8 (L10-K1) plus the
relationship note beneath the table. L10-E, L10-E2, L10-A–L10-J, their
thresholds, the seeds, the evaluation semantics, the task distribution and every
reported number are untouched. L10-E remains **FAILED at 0.425926** and is
reported as such everywhere.

**What did not change.** The frozen v1.6 content is preserved verbatim; this
entry is appended, not substituted. Any future change to §8 must be recorded the
same way, with an owner decision, in a new version — never edited in place.

### v1.8 — owner-governed milestone closure

**Trigger.** Every L10 experiment had been run and every criterion had a recorded
outcome; what remained was governance. L10.5 put three closure decisions to the
repository owner **separately** (`stark/reports/L10_5_OWNER_DECISION.md`); the
proposed change set was published as
`stark/design/context_conditioned_memory_milestone_v1_8_proposal.md` and was not
in force until the answers existed.

**Decisions and answers.**
- **A — L10-E:** *retain the original failure and formally close the criterion as
  a historical result.*
- **B — L10-F:** *mark the original failure as superseded and closed by L10-F2,
  preserving the historical failure.*
- **C — L10-G:** *record the historical confounded result as superseded by
  L10-G2, preserving the original result and the confound disclosure.*

**What changed.** Three annotation rows (§8) and the milestone-closure status
line, plus this entry. Nothing else: no criterion text, threshold, metric, seed,
evaluation rule, measured value or pass/fail outcome was altered, and the v1.6
and v1.7 text is preserved verbatim. Verified by diff: the change is purely
additive apart from the version line.

**What did not change.** L10-E remains **FAILED at 0.425926** against its
unchanged 0.40 threshold. L10-F remains recorded as FAILED. L10-G remains
recorded as a PASS on a confounded arm. L10-K1 remains an official PASS under its
registered protocol (v1.1, sha256 `249d5074…`, registration commit `e32043c`,
evidence `work/l10_raw/official_evaluation_20261024/`), with its 0.40 / 0.25 /
0.50 thresholds untouched. No evidence was regenerated.

**Standing rule.** Any future change to §8 requires an owner decision and a new
version. Superseded and closed criteria stay in this document permanently with
their original results; they are annotated, never removed or rewritten.
