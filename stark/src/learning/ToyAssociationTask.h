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

} // namespace learning
