# N-Way Learned Relevance Milestone (STARK-L7) — versioned design and frozen protocol

Version: 1.0 — **protocol and success criteria frozen before implementation**
(2026-10-23). Implementation may not alter §6–§8. Post-results revisions
must be versioned with the reason recorded BEFORE re-evaluation; v1.0
verdicts stand as measured.

## 1. Hypothesis and identifiability analysis (before implementation)

**Hypothesis:** the L6 relevance-routing mechanism (softmax policy over
input channels, REINFORCE on the taken action, attentional gain + L5
eligibility gate as actuators) generalizes from two-way slot selection to
N-way candidate selection without a hand-designed slot prior, and the
learned relevance remains selective and transferable under distractor
co-activation.

**Task (N-way):** N candidates are presented simultaneously on N fixed
input channels (identity i on channel i — the channels are the observable
stimulus representation; the mapping from context to which channel is
queried is the LEARNED part); a context input (N contexts) indicates the
queried channel via a seeded bijection φ: ctx → channel; distractor
identities (from a pool of n_ids − N identities) co-activate during the
interference window; reward follows the decision. Correct response =
π(identity on channel φ(ctx)), π a seeded bijection identity→response.

**Identifiability (documented before freezing):**

- *Selection learning (selection trials):* with the STARK-L5 gate OFF for
  all identities (rows frozen), m = +1 iff the selected channel's
  candidate is the queried one. The policy gradient
  Δv[ctx][c] = β·m·(1{c==s*} − a[c]) then learns φ. Identifiable for any
  N; the gradient is well-defined (bounded logits).
- *Mapping learning (mapping-credit trials):* single-candidate trials have
  no selection decision; the sole candidate is attended directly and
  gated; m = +1 iff its row is correct. Rows learn π. Identifiable.
- *The confound (why phased training):* on selection trials with the gate
  ON for the selected candidate only, row drift for candidate i is
  E[dw_i] = P(s*=i)·(2·acc_i − 1)·δ — non-selective growth (all presented
  candidates' rows drift up equally under a uniform policy), and m
  conflates selection-error with mapping-error. The L6 v1.1 mixture
  avoided this by freezing rows on selection trials; L7 uses **phased
  training** (mapping-credit phase first, selection phase second) — the
  smallest design that separates the two credit channels cleanly.
- *Routing identifiability:* v is n_ctx × n_chan real state stored in
  ordinary C→L synapse weights; φ is a bijection; the policy gradient
  recovers it from (choice, reward) without φ, π, or labels.

## 2. Mechanism (N-way generalization of the L6 mechanism)

- **Routing state:** v[ctx][channel], n_ctx × n_chan real numbers, stored
  as the weights of ordinary synapses C→L (persistence via STARK-007).
  Initialized 0; clamped to [−1.5, 1.5] (bounded logits — exploration and
  corrective gradients persist).
- **Selection (per selection trial):** attention shares
  a = softmax(v[active ctx] / T), T = 1, over n_chan channels; the
  mechanism samples s* ~ a using the schedule's seeded `mech_u` draw.
- **Actuators (follow s*, nothing else):** (1) attentional input gain:
  the candidate on channel s* receives full drive; all other presented
  candidates are suppressed (gain 0); (2) the STARK-L5 eligibility gate:
  ON for the identity on channel s*, OFF for every other identity. The
  mechanism receives only ordinary observations (which input neurons are
  driven: identity × channel co-activation, the context input) and the
  post-decision reward. φ is never passed to the mechanism; the driver
  actuates from the mechanism's selection signal, not from φ.
- **Routing update (at the reward step of selection trials):**
  Δv[ctx][c] = β · m · (1{c == s*} − a[c]), β = 0.3, m = task reward
  (LEARNED/NEGATIVE) or the seeded reward-independent draw (SHAM). This is
  the unbiased REINFORCE policy gradient for an N-way softmax with binary
  reward. No answer key, no future reward, no hidden query identity.
- **Persistence lifecycle:** v lives in synapse weights → saved and
  restored by Network::save/serialize (STARK-007); gates are per-trial
  volatile task state (reset() restores default on); the driver re-sets
  gates/gains each trial from the mechanism's selection.
- **What is architecture vs learned:** the N channels and the context
  channel are ordinary stimulus representation (like position); **which
  channel each context selects is learned**. No per-association
  exceptions, no lookup tables, no hard-coded context→candidate mapping.

## 3. Arms (identical frozen schedules and seeds)

| Arm | selection | gates (mapping phase) | v update | role |
|---|---|---|---|---|
| UNGATED | none (all candidates full gain) | none | — | global-modulation baseline |
| ORACLE | driver uses φ | on sole candidate | — | upper-bound reference (L5-style) |
| LEARNED | softmax(v), seeded sampling | on sole candidate | REINFORCE (real m) | candidate |
| SHAM | as LEARNED | on sole candidate | REINFORCE (reward-independent) | null control |
| ABLATION | none (all candidates full gain) | on all presented | — | learned-signal ablation |
| NEGATIVE | 1 − sampled s* | on sole candidate | REINFORCE (real m) | misdirected relevance |

## 4. Schedules and seeds

Candidate counts N ∈ {2, 4, 8}; n_ids = N + 4 (candidates + 4 distractor
identities); n_ctx = N; n_resp = n_ids. Masters {20261023, 20261024,
20261025}; π and φ seeded per master (φ a bijection ctx→channel).

Trial structure: [CONTEXT 2 steps] → [CANDIDATES 3 steps (all presented
candidates, gain per arm; channel markers driven)] → [INTERFERENCE 8
steps, distractor identities, P(silent)=0.25] → [DECISION 6 steps,
spike-count majority over n_resp, seeded tie-breaks] → [DELAY 2] →
[REWARD 1, m = ±1].

**Training (phased):** Phase 1 (mapping credit): 40 single-candidate
trials per candidate identity (the queried candidate alone presented on
its channel; gates on it for all arms except UNGATED; no selection, no
policy update). Phase 2 (selection): 40 selection trials per context
(the queried candidate + N−1 others presented; context active; gates OFF
for every arm — rows frozen; policy update for LEARNED/SHAM/NEGATIVE).

**Evaluation:** Eval A: 20 pure selection trials per identity (disjoint
seeds, learning disabled, fresh distractor streams). Eval B (held-out
mappings): a fresh π' — Phase 1' re-trains rows for π' (single-candidate
trials; the routing state v is REUSED unchanged — it is π-independent by
construction), then 20 selection trials per identity with π'.

Held-out combinations: Eval A uses disjoint trial streams (fresh
candidate subsets, distractor sets, noise, orderings — unseen
combinations of context × candidate-subset × distractor-set); Eval B
holds out the mapping itself. Per-context selection accuracy is reported
for every context (the context×channel combinations).

## 5. Metrics (frozen)

Per arm × seed × N: Eval A accuracy (Wilson 95% CI); Eval B (π') accuracy;
per-identity accuracy and minimum; per-context selection accuracy
P(s* = φ(ctx)) and pooled; false-positive relevance P(gain on a non-queried
candidate) and missed relevance P(no gain on the queried candidate) on
Eval A; intended vs unintended update mass (phase 1: I = Σ|Δw| on the
sole candidate's row, U = Σ|Δw| elsewhere; phase 2: gates off → 0 by
construction, reported); phase-2 reward trend (first 20 vs last 20);
final routing state v vs φ; runtime and memory overhead relative to L6
(same build flags); save/reload incl. routing weights.

## 6. Success criteria (frozen) — pooled over the 3 seeds, per N

| # | Criterion | Threshold |
|---|---|---|
| L7-A | Learned N-way selection works | acc(N) ≥ 60% for N=2,4,8; ≥ UNGATED + 20 pp; min per-association ≥ 40%; selection acc ≥ 60% |
| L7-B | Near oracle | acc(N) ≥ ORACLE(N) − 15 pp for each N |
| L7-C | Relevance quality | FP ≤ 30%; missed ≤ 20% (LEARNED, Eval A) |
| L7-D | Controls degrade as predicted | SHAM ≤ LEARNED − 10 pp at each N; ABLATION ≤ LEARNED − 15 pp; NEGATIVE ≤ 30% |
| L7-E | Credit selectivity | U_learned ≤ 0.35 × U_ungated (phase 1, each N) |
| L7-F | Generalization across mappings | Eval B (π') acc ≥ 50% for each N |
| L7-G | Persistence | save/reload incl. routing weights: all weights bit-identical, identical choices on every Eval A query, serialize round-trip byte-identical, double reload deterministic |
| L7-H | Determinism | two runs, byte-identical report |
| L7-I | Regression | L1–L6 reproduce byte-identically; all suites pass (incl. L5 supplied-gate and L6 two-slot tests); STARK-001..007 9/9; Phase-1 §K 5/5 |
| L7-J | Control validation | the separate L6-D control-validation study (learned_relevance_control_validation.md) satisfies its predeclared rules R1–R3 at N=2 and N=4 |

Explicit failure criteria: if LEARNED < ABLATION at any N, or selection
accuracy does not track φ across training, the mechanism is refuted as
learned relevance at that N — reported as measured, criteria never
weakened. The L6-D FAIL verdict stands unchanged; L7-J records the new
control-validation evidence separately.

## 7. Reproducibility contract

One JSON report (`schema: STARK-L7-1`) at
`work/dev_n_way_learned_relevance_report_STARK-L7-1.json`: per-arm,
per-seed, per-N blocks with Eval A/B accuracy tables, per-identity and
per-context selection accuracy, FP/missed rates, U/I mass, learning
curves, final v, save/reload flags, criteria verdicts. Two runs
byte-identical. mt19937-only randomness; the mechanism touches only
observable inputs, its own routing state, and post-decision reward.

## 8. Preregistered expectations (predictions, not guarantees)

From the L6 v1.1 measurements and the phased-training analysis: ORACLE
≈ 1.00 at all N (selection is exact; rows learned in phase 1); LEARNED
≈ 0.90–0.99 at N=2/4, ≈ 0.80–0.95 at N=8 (the N-way policy gradient is
well-defined but the per-channel signal is diluted); UNGATED ≈ 0.1–0.3
(all-candidate races + distractor contamination); SHAM ≈ 1/N; ABLATION
≈ 1/N or below; NEGATIVE ≈ 0–0.1. Selection accuracy ≈ task accuracy
(rows are correct from phase 1). Eval B (π') ≈ Eval A (the routing is
π-independent). Known limitations to report regardless of outcome: the
channel prior (candidates on fixed channels) is structural; phased
training is a task-level prerequisite for clean credit separation;
bounded-softmax exploration persists at convergence.
