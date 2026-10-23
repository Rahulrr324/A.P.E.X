#pragma once

/**
 * STARK-L1: Toy association task + agent driver for the reproducible
 * reward-modulated learning loop (see stark/design/learning_loop_milestone.md).
 *
 * Environment: two-cue, two-action discrimination.
 *   - Each trial presents one cue (0 or 1); the correct action is the cue id.
 *   - Reward: +1 for the correct action, -1 otherwise.
 *
 * Agent: 4 neurons S0,S1 (sensory), A0,A1 (action); 4 synapses S_i -> A_j.
 *   - Plastic agent: all synapses in THREEFACTOR mode (STARK-006); the reward
 *     is delivered as the modulatory signal m for exactly one timestep.
 *   - Frozen baseline: identical construction, PlasticityMode::NONE.
 *
 * Everything is deterministic: all schedules (cues, noise) are generated from
 * recorded std::mt19937 seeds and replayed identically to trained and
 * baseline agents. No other randomness exists.
 *
 * Design/success criteria: stark/design/learning_loop_milestone.md
 * (criteria are frozen there; this code may not change them).
 */

#include "neural/Network.h"
#include <vector>
#include <cstddef>

namespace learning {

/// Full parameterization of task, agent, and protocol. Defaults implement the
/// frozen milestone protocol (100 training / 50 evaluation trials).
struct TaskConfig {
    // Protocol
    int train_trials = 100;
    int eval_trials  = 50;
    int cue_steps    = 12;    // decision window (timesteps)
    double dt        = 1.0;
    // STARK-L2: quiet steps between the decision (end of cue window) and the
    // reward step. Eligibility decays as exp(-D/tau_e) across the delay; the
    // delay can never influence the choice because it occurs after it.
    int reward_delay = 0;

    // Environment drive
    double cue_current       = 1.2;   // to the cued sensory neuron
    double background_current = 0.25; // baseline drive on action neurons
    double noise_amp         = 0.15;  // uniform noise amplitude on action neurons

    // Neuron parameters (STARK-001)
    double tau_m   = 10.0;
    double theta_0 = 1.0;
    double tau_a   = 20.0;
    double adapt_b = 0.5;
    double v_reset = -0.5;

    // Synapse parameters (STARK-002/006)
    double tau_s  = 2.0;
    double w_init = 0.5;
    double w_min  = 0.0;
    double w_max  = 1.0;
    double E_plus  = 0.05;   // eligibility potentiation
    double E_minus = 0.02;   // eligibility depression (LTP-heavy: causal pre->post order)
    double tau_e   = 8.0;    // eligibility time constant (seconds)
    double eta_3f  = 0.6;    // three-factor learning rate
    // Lateral inhibition between action neurons (A0->A1, A1->A0), fixed and
    // non-plastic (PlasticityMode::NONE). Winner-take-all competition makes the
    // chosen action dominate the trial's spiking, so eligibility concentrates
    // on the chosen cue->action pathway instead of co-potentiating both.
    double w_inh = -1.2;
    // Pre/post STDP traces feed eligibility (x_pre at post spikes). The
    // Synapse defaults (tau_pre=tau_post=1.0) decay within one dt=1 step and
    // starve the trace; the milestone uses persistent traces configured via
    // Synapse::setFullState (the only API that sets tau_pre/tau_post without
    // switching the synapse out of THREEFACTOR mode).
    double tau_pre  = 6.0;
    double tau_post = 6.0;

    // Reproducibility
    unsigned master_seed = 20261023u;

    // Negative control: if false, the modulator is +1 on every trial instead
    // of the task reward (sham reward). Task reward (TrialResult.reward) is
    // still computed from correctness so accuracy stays comparable. A sham
    // agent should NOT learn the task — reward contingency is the causal
    // factor under test.
    bool reward_contingent = true;
};

/// One trial's precomputed environment schedule (from the seed).
struct TrialSchedule {
    int cue = 0;                      // 0 or 1
    std::vector<double> noise_a0;     // per cue-step noise for A0
    std::vector<double> noise_a1;     // per cue-step noise for A1
    double tie_u = 0.5;               // seeded uniform draw for decision ties
};

/// Result of one executed trial.
struct TrialResult {
    int cue = 0;
    int choice = 0;     // 0 or 1
    double reward = 0;  // task reward +1 / -1 (from correctness)
    double modulator = 0; // m actually delivered (0 = none; +1 for sham)
    // STARK-L3 diagnostics (0 when unused): total action-neuron spikes.
    int spikes_a0 = 0;
    int spikes_a1 = 0;
};

/**
 * Generate a deterministic trial schedule: exactly half cue-0 and half cue-1
 * trials (odd counts alternate the extra cue), shuffled with mt19937(seed),
 * with per-step action-neuron noise draws.
 */
std::vector<TrialSchedule> makeSchedule(const TaskConfig& cfg, int trials, unsigned seed);

/// The 4-neuron / 4-synapse agent. Synapse order: [S0->A0, S0->A1, S1->A0, S1->A1].
struct Agent {
    Network net;
    size_t s0 = 0, s1 = 0, a0 = 0, a1 = 0;
    std::vector<size_t> syn;
};

/// Build the agent. plastic=true -> THREEFACTOR mode; false -> NONE (frozen).
Agent makeAgent(const TaskConfig& cfg, bool plastic);

/**
 * Execute one trial on the agent.
 *
 * Cue phase: external drive to the cued sensory neuron plus seeded noise on
 * the action neurons for cfg.cue_steps timesteps. The choice is the action
 * neuron with more spikes (tie: first spike wins; no spikes at all: action 0).
 *
 * Delay (STARK-L2): cfg.reward_delay quiet steps (zero input, no modulator)
 * separate the decision from the reward step; eligibility decays across them.
 *
 * Outcome: reward = (choice == cue) ? +1 : -1. If learning_enabled, the
 * reward is set as the modulator for exactly one timestep
 * (dw = eta * r * e on THREEFACTOR synapses). Timestep count, inputs and
 * spiking are identical for learning_enabled true/false — only the modulator
 * differs.
 *
 * Decision ties (equal spike counts with equal first-spike times, or no
 * spikes at all) are broken by the schedule's seeded draw tie_u — never by a
 * fixed default action (a fixed default would bias the policy toward one
 * action and fake cue0 performance).
 */
TrialResult runTrial(Agent& agent, const TaskConfig& cfg,
                     const TrialSchedule& sched, bool learning_enabled);

/// Current weights in synapse order [S0->A0, S0->A1, S1->A0, S1->A1].
std::vector<double> weights(const Agent& agent);

// ============================================================================
// STARK-L3: sequential-context task (early cue, distractor sequence, delayed
// reward). See stark/design/sequential_context_milestone.md (frozen protocol).
// The L1/L2 sections above are untouched; the L3 section is additive.
// ============================================================================

/// Full parameterization of the sequential task / agent / protocol. Defaults
/// implement the frozen milestone protocol v1.1.
struct SeqConfig {
    // Protocol
    int cue_steps = 2;        // encoding window (S_cued spikes both steps)
    int seq_steps = 4;        // K: distractor-sequence length (condition)
    int decision_steps = 6;
    int reward_delay = 2;     // D: quiet steps between decision and reward
    int train_trials = 100;
    int eval_trials = 50;
    double dt = 1.0;

    // Environment drive
    double cue_current = 1.2;        // to the cued sensory neuron
    double anti_cue_current = 1.2;   // probe: single step at last sequence step
    double background_current = 0.08; // tonic drive on action neurons only
    double noise_cue = 0.04;
    double noise_seq = 0.04;
    double noise_decision = 0.10;    // exploration noise (the decision window)
    double p_dist_none = 0.25;       // distractor pattern: none | D0 | D1
    double p_dist_d0 = 0.375;        // remainder -> D1
    double dist_current = 1.2;       // drives the D neuron of the pattern

    // Neuron parameters (STARK-001)
    double tau_m = 10.0;
    double tau_a = 20.0;
    double theta_cue = 0.6;    // S/D: single-step pulses must transduce
    double theta_action = 1.2;
    double adapt_b = 0.0;      // no adaptation (see design v1.1)
    double v_reset = -0.5;

    // Synapse parameters (STARK-002/006)
    double tau_s = 2.0;
    double w_init = 0.5;
    double w_min = 0.0;
    double w_max = 0.7;
    double E_plus = 0.05;
    double E_minus = 0.02;
    double tau_e = 8.0;
    double eta_3f = 0.6;
    double tau_pre = 20.0;
    double tau_post = 20.0;
    // Fixed architecture: WTA + persistent-activity attractor + distractor drive.
    double w_inh = -1.2;
    double w_self = 1.2;       // C4-ABLATE condition: 0.0
    double w_dist = 0.15;

    // Reproducibility
    unsigned master_seed = 20261023u;
    bool reward_contingent = true; // false -> sham (m = +1 always)
};

/// One sequential trial's precomputed schedule (from the seed).
struct SeqTrialSchedule {
    int cue = 0;                          // 0 or 1; correct action = cue id
    std::vector<int> dist_pattern;        // seq_steps entries: 0 none, 1 D0, 2 D1
    std::vector<double> noise_a0;         // cue+seq+decision steps
    std::vector<double> noise_a1;
    double tie_u = 0.5;
    int anti_at = -1;                     // probe: sequence step of the anti-cue (-1 none)
};

/// Result of one executed sequential trial (TrialResult + retention diagnostic).
struct SeqTrialResult {
    TrialResult r;
    int spikes_a0_seq = 0;  // action spikes during the SEQ window (attractor persistence)
    int spikes_a1_seq = 0;
};

/**
 * Sequential-task agent (6 neurons: S0,S1,A0,A1,D0,D1).
 * Synapse order:
 *   plastic[0..3] = S0->A0, S0->A1, S1->A0, S1->A1 (THREEFACTOR or NONE)
 *   wta[0..1]     = A0->A1, A1->A0 (inhibition)
 *   self[0..1]    = A0->A0, A1->A1 (attractor; weight cfg.w_self)
 *   dist[0..3]    = D0->A0, D0->A1, D1->A0, D1->A1 (symmetric nuisance drive)
 */
struct SeqAgent {
    Network net;
    size_t s0 = 0, s1 = 0, a0 = 0, a1 = 0, d0 = 0, d1 = 0;
    std::vector<size_t> plastic;
    std::vector<size_t> wta;
    std::vector<size_t> self;
    std::vector<size_t> dist;
};

/// plastic=true -> THREEFACTOR; false -> NONE (frozen baseline).
SeqAgent makeSeqAgent(const SeqConfig& cfg, bool plastic);

/**
 * Deterministic sequential schedules: cues exactly half/half (seeded shuffle),
 * distractor patterns drawn independently of the cue value, action-neuron
 * noise, tie draws. probe=true places a single anti-cue at the last sequence
 * step (evaluation of context vs most-recent input); probe schedules use a
 * distinct seed.
 */
std::vector<SeqTrialSchedule> makeSeqSchedule(const SeqConfig& cfg, int trials,
                                              unsigned seed, bool probe);

/**
 * Execute one sequential trial: cue window -> distractor sequence -> decision
 * window (spike-count majority; ties: first spike, then seeded draw) ->
 * quiet reward-delay steps -> one outcome step with the modulator
 * (sham: +1 when learning_enabled). network.reset() is called first; weights
 * persist across trials exactly as in L1/L2.
 */
SeqTrialResult runSeqTrial(SeqAgent& agent, const SeqConfig& cfg,
                           const SeqTrialSchedule& sched, bool learning_enabled);

/// Current S->A weights [w00, w01, w10, w11].
std::vector<double> seqWeights(const SeqAgent& agent);

} // namespace learning
