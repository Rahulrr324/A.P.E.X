# Learned-Relevance Milestone (STARK-L6) — versioned design and frozen protocol

Version: 1.1 — protocol and success criteria frozen before v1.1
evaluation (2026-10-23; v1.0 frozen and executed the same day — **v1.0
verdicts: L6-D/F PASS, L6-A/B/C/E FAIL**, report preserved as
`work/dev_learned_relevance_report_STARK-L6-v1.0-FAIL.json`). Criteria of
§5 are unchanged. v1.1 is a targeted mechanism revision for the documented
v1.0 failure mode; v1.1 results are evaluated against the identical §5
thresholds.

**v1.1 mechanism revision (diagnosed from v1.0 per-seed evidence and
pre-evaluation implementation diagnostics; not tuned on evaluation data):**
three documented defects and the final mechanism. v1.0's update applied the
policy gradient to the *evidence slot* instead of the *taken action*
(biased estimator) with tie-bias and saturating ±4 logits — identity-φ
seed reached acc 1.000 / sel 1.000 but swapped-φ seeds wrong-locked (sel
0.52/0.41, acc 0.20/0.14). Rejected intermediates (recorded per the
no-silent-changes rule): (a) ε-confidence gating (non-robust: ε 0.02/0.1
OK, 0.05 wrong-locked); (b) mapping-consistency evidence (selection
recovered, one seed still inverted — biased estimator persists when
s* ≠ s_sel). (c) **Structural finding from full-budget diagnostics:** with
single-gate credit on two-sample trials, a row's true-path drift =
P(queried ∧ selected)·δ − P(decoy ∧ selected)·δ = 0 for any slot-symmetric
policy — the outcome m conflates mapping error with selection error, so
joint learning is not identifiable (oracle escapes only by never
mis-selecting; sparse learning occurred solely via relative decay of wrong
entries). **Final v1.1:** (i) unbiased REINFORCE on the taken action
(Δv[ctx][s'] = β·m·(1{s'==s*} − a[s'])); (ii) bounded policy logits
(v clamp [−1.5, 1.5]); (iii) **training mixture with unambiguous
mapping-credit trials:** 50% single-sample trials (one candidate + the
distractor stream; the sole candidate is attended — no selection decision
exists; associations learn; no routing update) and 50% two-sample
selection trials (routing learns from m; **association updates disabled for
all arms** — the identifiability prerequisite: on two-sample trials the
outcome cannot disambiguate mapping- from selection-error). Evaluation and
generalization are pure two-sample trials (learning disabled) — the frozen
comparison isolates the relevance mechanism. π and φ remain unobservable;
association credit still never flows from reward alone (eligibility gated
by the attended candidate).

## 1. Hypothesis, and why the task must change

STARK-L5 proved that per-trial eligibility gating solves the L4 credit
cross-talk — but the L5 gate is an **oracle**: the driver supplies the
queried item identity. L6 asks whether the network can learn the relevance
selection itself.

**Information-theoretic constraint (documented before design):** on the
L4/L5 task the relevance role (query vs distractor) is perfectly confounded
with presentation order (the first cue is always the query), and for any
cue i, P(m = +1 | i active as query) converges to P(m = +1 | i active as
distractor) once items are learned. No reward statistic, scalar or
otherwise, separates the two roles for the same cue. Any mechanism claiming
"learned relevance" on that task is either using the order confound (a
hidden oracle) or is untestable. Therefore L6 **unconfounds relevance**:

**Task (context-selected two-sample memory with distractors):** each trial
presents TWO sample identities simultaneously on two tagged input slots
(L0/L1), for equal durations; a CONTEXT input (C0/C1), presented first,
indicates which **slot** is queried; the context→slot mapping φ is a seeded
per-master draw (identity or swap — unknown to the network); distractor
identities co-activate during an interference window; reward arrives after
the decision. Correct response = π(identity on slot φ(π)), π a seeded
bijective identity→response mapping. Distractors co-activate during both
training and evaluation. Held-out evaluation uses unseen sample-pair /
slot / context combinations (same identities and φ).

**Hypothesis (falsifiable):** a reward-modulated routing state — learned
only from (choice consistency, reward), never from φ — can learn φ and
route eligibility to the context-selected sample, reaching accuracy near
the oracle-gated reference and far above controls, with unintended
cross-item weight updates suppressed.

## 2. Mechanism: reward-modulated routing (REINFORCE over a 2-way softmax)

- **Routing state:** v[ctx][slot], 4 real numbers, stored as the weights of
  4 ordinary synapses C0→L0, C0→L1, C1→L0, C1→L1 (persistence free via
  STARK-007 serialization). Initialized 0.
- **Selection (per trial):** attention a = softmax(v[active ctx] / T),
  T = 1; the mechanism samples s* ~ a using the schedule's seeded
  `mech_u` draw (deterministic policy gradient exploration).
- **Actuators (both follow s*, nothing else):**
  1. attentional input gain: the sample identity on slot s* receives full
     drive; the sample on the other slot is suppressed (gain 0);
  2. the L5 eligibility gate: ON for the s* sample's row, OFF for every
     other identity row this trial (perceived distractors included).
  The mechanism receives only ordinary observations (which input neurons
  are driven: identity × slot co-activation, the context input) and the
  post-decision reward. **φ is never passed to the mechanism.**
- **Routing update (at the reward step):** s_sel = argmax_s
  w[i(s)][choice] — the slot whose sample's learned row best explains the
  chosen response (ties: lower slot index); then for both slots
  Δv[ctx][s] = β · m · (1{s == s_sel} − a[s]), β = 0.3, v clamped to
  [−4, 4]. This is the REINFORCE policy gradient for a 2-way softmax with
  binary reward and a choice-consistency baseline; it uses no answer key
  and does not assume reward identifies synapses (the row that drove the
  choice mediates credit).
- **Why this is not an oracle:** the driver never sets v, s*, or the
  gates/gain; φ is used only to score the response. The mechanism can be
  and initially is wrong; it learns φ from reward. L5's supplied-gate path
  is preserved unchanged as the reference arm and in the L5 test suite.
- Fixed structure vs learned: input slots and the context channel are
  ordinary stimulus properties (architectural prior, like stimulus
  position); **which slot the context selects is learned**. Documented as
  such; no per-association exceptions, no lookup tables.

## 3. Arms (all on identical frozen schedules and seeds)

| Arm | selection | v update | role |
|---|---|---|---|
| UNGATED | none (both samples, no gates) | — | global-modulation baseline |
| ORACLE | driver uses φ | — | upper-bound reference (L5-style supplied gate) |
| LEARNED | s* from softmax(v), seeded sampling | REINFORCE (real m) | candidate |
| SHAM | as LEARNED | REINFORCE with **reward-independent m** (seeded draw `sham_u` per trial: +1 if < 0.5 else −1) | reward-independent relevance control |
| ABLATION | none (both samples gated ON, v frozen) | none | learned-signal ablation |
| NEGATIVE | s* forced to the other slot (1 − sampled s*) | REINFORCE (real m) | misdirected relevance (predicted degradation) |

Seeds: masters {20261023, 20261024, 20261025}; π and φ seeded per master;
train = master (**480 trials: 240 single-sample + 240 two-sample**,
queried identity exactly balanced within each half; interleaved),
evaluation = master+2 (120 pure two-sample, 20× each), generalization
evaluation = master+3 (120, unseen pair/slot/context combinations).
Identical schedules across arms.

Trial: [CONTEXT 2 steps] → [SAMPLES 3 steps (both identities + slot
markers; attentional gain per arm)] → [INTERFERENCE 8 steps, distractor
identities, P(silent)=0.25] → [DECISION 6 steps, spike-count majority over
6 responses, seeded tie-breaks] → [DELAY 2] → [REWARD 1, m = ±1].

## 4. Metrics (frozen)

Per arm × seed and pooled (Wilson 95% CIs): evaluation accuracy,
generalization accuracy; per-identity accuracy and minimum; **selection
accuracy** P(s* = φ(ctx)); **false-positive relevance** P(gate on for the
non-selected sample) and **missed relevance** P(gate off for the selected
sample) on evaluation; intended vs unintended update mass (I = Σ|Δw| on
the queried identity's row per training trial, U = Σ|Δw| elsewhere);
reward trend (first 20 vs last 20); final routing state v vs φ; runtime
and memory overhead relative to L5 (same machine, same build flags).

## 5. Success criteria (frozen) — pooled over the 3 seeds

| # | Criterion | Threshold |
|---|---|---|
| L6-A | Learned selection works | LEARNED acc ≥ 70%; ≥ UNGATED + 20 pp; min per-identity ≥ 50%; generalization ≥ 60% |
| L6-B | Near oracle | LEARNED acc ≥ ORACLE acc − 15 pp |
| L6-C | Relevance quality | false-positive ≤ 30%; missed ≤ 20% (LEARNED, evaluation) |
| L6-D | Controls degrade as predicted | SHAM ≤ 55%; ABLATION ≤ 60% and ≤ LEARNED − 15 pp; NEGATIVE ≤ 40% |
| L6-E | Credit selectivity | U_learned ≤ 0.35 × U_ungated; I_learned ≥ 0.4 × I_oracle |
| L6-F | Persistence | save/reload incl. routing weights: all weights bit-identical, identical choices on every evaluation query, serialize round-trip byte-identical, double reload deterministic |
| L6-G | Determinism | two runs, byte-identical report |
| L6-H | Regression | L1–L5 reproduce byte-identically; all suites pass (incl. L5 supplied-gate tests); STARK-001..007 9/9; Phase-1 §K 5/5 |

Explicit failure criteria: if LEARNED < ABLATION, or selection accuracy
does not track φ (e.g., stays at chance across training), the mechanism is
refuted as learned relevance — reported as measured, criteria never
weakened.

## 6. Reproducibility contract

One JSON report (`schema: STARK-L6-1`) with per-arm, per-seed blocks:
accuracy tables (evaluation + generalization), per-identity accuracy,
selection accuracy, FP/missed rates, U/I mass, learning curves, final v,
save/reload flags, criteria verdicts. Two runs byte-identical.
mt19937-only randomness (schedule seeds + mechanism sampling from
schedule draws); the mechanism touches only observable inputs, its own
routing state, and post-decision reward.

## 7. Preregistered expectations (predictions, not guarantees)

From L5 measurements and the dynamics analysis: ORACLE ≈ 0.85–1.00 (the
unselected sample's response no longer races the selected one under
attentional gain); LEARNED ≈ 0.70–0.95 (v is 4 numbers; REINFORCE orients
φ within ~10–30 trials); UNGATED ≈ 0.35–0.60 (two strong attractors race;
cross-talk corrupts rows); SHAM ≈ 0.40–0.55; ABLATION ≈ 0.45–0.60;
NEGATIVE ≈ 0.15–0.40. Expected FP/missed for LEARNED ≈ 0.05–0.20 after
training. Early-training reward near 0 or negative, rising as φ is learned
(the learning curve itself is evidence of relevance learning). Known
limitations to report regardless of outcome: 2-way selection only; slots
are a structural prior; v learning depends on choice-consistency being
informative after association learning begins.

## 8. Outcome (2026-10-23)

**v1.0 (executed as frozen; FAILED):** L6-D/F PASS, L6-A/B/C/E FAIL —
report preserved at `work/dev_learned_relevance_report_STARK-L6-v1.0-FAIL.json`
(sha ac400a19…). Oracle = 1.000 (task valid); learned 0.447 pooled with the
per-seed signature recorded in the v1.1 changelog (identity-φ seed perfect,
swapped-φ seeds wrong-locked).

**v1.1 (mechanism revision as documented in the changelog; criteria
unchanged):** report `work/dev_learned_relevance_report_STARK-L6-1.json`
(schema STARK-L6-1, sha e4b37f71…). Pooled over 3 seeds; evaluation n =
360/arm; Wilson 95% CIs.

| # | Criterion | Threshold | Measured (v1.1) | Verdict |
|---|---|---|---|---|
| L6-A | Learned selection works | ≥ 70%; ≥ UNGATED + 20 pp; min item ≥ 50%; gen ≥ 60% | 0.972 [~0.96,0.98]; UNGATED 0.178; min item 0.933; gen 0.967 | PASS |
| L6-B | Near oracle | ≥ ORACLE − 15 pp | 0.972 vs 1.000 (gap 0.028) | PASS |
| L6-C | Relevance quality | FP ≤ 30%; missed ≤ 20% | FP 0.028; missed 0.028; selection acc 0.972 | PASS |
| L6-D | Controls degrade as predicted | SHAM ≤ 55%; ABLATION ≤ 60% and ≤ LEARNED − 15 pp; NEGATIVE ≤ 40% | SHAM **0.725**; ABLATION 0.406; NEGATIVE 0.028 | **FAIL** (sham only) |
| L6-E | Credit selectivity | U_learned ≤ 0.35·U_ungated; I_learned ≥ 0.4·I_oracle | U_learned **0.000** vs U_ungated 0.070; I_learned = I_oracle | PASS |
| L6-F | Persistence | exact save/reload incl. routing weights | 3/3 seeds: weights + routing bit-identical; 0/360 choice mismatches; serialize round-trip byte-identical; double reload deterministic | PASS |
| L6-G | Determinism | two runs byte-identical | `cmp` identical (wall-clock field removed from the report after the first determinism check caught it; runtime measured out-of-band) | PASS |
| L6-H | Regression | L1–L5 byte-identical; suites; 9/9; K 5/5 | all pass (below) | PASS |

**Mechanism evidence (learned relevance, not an oracle):** learned routing
state converged to φ on all 3 seeds (v = ±1.5 oriented exactly per the
seeded context→slot mapping, including both swapped-φ seeds); selection
accuracy 0.972 on held-out pair/slot/context combinations (0.967
generalization accuracy); the NEGATIVE control — same reward signal, same
learning, actuation inverted — degraded to 0.028 in the predicted
direction; UNGATED (no relevance selection) collapsed to 0.178 under
distractor co-activation. Runtime overhead vs L5: none measurable (L6 loop
0.85 s vs L5 1.09 s wall-clock; mechanism = 4 routing weights + one
softmax per trial).

**L6-D sham sub-criterion: reported FAIL as measured; criteria not
weakened.** The reward-independent sham behaved as a valid null: its
routing state is uncorrelated with φ (4/6 context rows matched = chance;
binomial P(≥4/6) = 0.34; one seed's match is luck), and its per-seed
accuracy (0.958/0.717/0.500) is consistent with a random 2-decision policy
whose null distribution has per-seed mass at ~0.1/0.5/0.9 — the frozen
threshold 0.55 sits barely above the null mean 0.5 with huge variance
(P(null ≥ 0.725) ≈ 0.25–0.35 at 3 seeds). The threshold was miscalibrated
in the frozen design (a design error documented here); per the
no-weakening rule it stands and L6-D is formally NOT met. Distinguishing
test already present in the data: the NEGATIVE arm's routing learned φ
exactly (real reward) while the sham's did not (chance-level) — reward
dependence is demonstrated; no reward-independent leak exists.

Regressions (L6-H): L1, L2, L3, L4-v1.1, and L5 reproduce byte-identically
from the committed sources (default paths untouched — this milestone
modified no existing neural or task code, only added the RelevanceRouting
module); suites 55/18/1887/1463/28/1699 assertions pass (L5's
supplied-gate tests unchanged and green); STARK-001..007 9/9; Phase-1 K 5/5.

Remaining limitations: 2-way slot selection only (6 identities); single-
sample mapping-credit trials are a task-level prerequisite (the
identifiability result of the v1.1 changelog); bounded-softmax exploration
remains in the policy at convergence (a ≈ 0.82); the L6-D sham threshold
needs owner-authorized recalibration (or acceptance of the null-model
analysis) before the milestone can be called fully passed. Next milestone:
owner ruling on L6-D; then N-way relevance (more candidates per trial) or
learned relevance without the slot prior.
