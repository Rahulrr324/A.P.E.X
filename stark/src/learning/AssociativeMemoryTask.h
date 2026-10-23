#pragma once

/**
 * STARK-L4: Multi-item associative memory (see
 * stark/design/associative_memory_milestone.md, frozen protocol v1.0).
 *
 * Task: N distinct cue->response bindings are learned from rewarded
 * retrieval trials and queried after an interference window of unrelated
 * item cues. Correct response = mapping pi(cue) (seeded permutation).
 *
 * Layer separation (kept honest everywhere):
 *   - Architecture: 8 cue + 8 response neurons, pairwise WTA among response
 *     units, per-unit self-excitation attractor, fixed delivery delays
 *     floor(r/2) as label-free exploration rungs (NOT learned).
 *   - Learned: the 8x8 S->A weight matrix via the STARK-006 three-factor
 *     rule; the N bindings live in the trained rows.
 *   - Stored state: the weight matrix (persisted by Network::save/serialize).
 *   - Retrieval: cue kick -> attractor competition -> spike-count readout
 *     after the interference window.
 *
 * Everything is deterministic: schedules and mappings are functions of
 * recorded mt19937 seeds; evaluation-time learning is disabled.
 */

#include "neural/Network.h"
#include <vector>
#include <cstddef>

namespace learning {

/// Full parameterization (defaults implement frozen protocol v1.0 §3).
struct AMConfig {
    // Protocol
    int cue_steps = 3;
    int interf_steps = 8;      // interference window length K
    int decision_steps = 6;
    int reward_delay = 2;
    int n_cues = 8;            // C
    int n_resp = 8;            // R
    int train_per_item = 40;
    int queries_per_item = 24;
    double dt = 1.0;

    // Environment drive
    double cue_current = 1.2;
    double background_current = 0.08; // tonic drive on response units
    double noise_cue = 0.04;
    double noise_seq = 0.04;
    double noise_decision = 0.10;
    double p_none = 0.25;      // P(interference step is silent); heavy eval: 0.0

    // Neuron parameters (STARK-001)
    double tau_m = 10.0;
    double tau_a = 20.0;
    double theta_cue = 0.6;
    double theta_action = 1.2;
    double adapt_b = 0.0;
    double v_reset = -0.5;

    // Synapse parameters (STARK-002/006)
    double tau_s = 2.0;
    double w_init = 0.35;
    double w_min = 0.0;
    double w_max = 0.7;
    double E_plus = 0.05;
    double E_minus = 0.02;
    double tau_e = 8.0;
    double eta_3f = 0.6;
    double tau_pre = 20.0;
    double tau_post = 20.0;
    double w_inh = -1.2;
    double w_self = 1.05;      // memory-structure ablation: 0.0

    bool reward_contingent = true; // false -> sham (m = +1 always)

    // STARK-L5 eligibility gate (pre-synaptic side; default 0 = existing
    // ungated rule, bit-identical behavior). 1 = query-only gate (candidate:
    // eligibility created only for the queried cue's rows); 2 = inverted
    // (query OFF, distractor cues ON) — signal-specificity control. The gate
    // is set from the presented query identity only — never from pi, rewards,
    // or evaluation labels. See stark/design/eligibility_gating_milestone.md.
    int elig_gate_mode = 0;
};

/// Controlled association assignment (seeded, label-free construction).
struct AMMapping {
    std::vector<int> perm;       // perm[cue] = correct response (bijection)
    std::vector<int> train_order; // cue shuffle; load N trains first N
};

/// Seeded permutation of responses and seeded cue shuffle (deterministic).
AMMapping makeMapping(unsigned seed, int n_cues);

/// One retrieval trial's precomputed schedule.
struct AMTrialSchedule {
    int cue = 0;
    std::vector<int> distractors; // interf_steps entries: -1 silent, else cue id != cue
    std::vector<double> noise;    // n_resp * (cue+interf+decision) entries, unit-major
    double tie_u = 0.5;
};

/// Balanced queries (each trained item exactly `per_item` times, shuffled),
/// distractor streams (never the queried cue; never branched on the response
/// label), noise, tie draws — all from the recorded seed. heavy=true sets
/// p_none = 0 (every interference step presents an unrelated item).
std::vector<AMTrialSchedule> makeAMTrials(const AMConfig& cfg,
                                         const AMMapping& map, int n_items,
                                         int per_item, unsigned seed, bool heavy);

/// Multi-item agent: C cue + R response neurons. Synapses syn[cue][resp]
/// (plastic, THREEFACTOR or NONE), pairwise WTA + self-excitation (fixed).
struct AMAgent {
    Network net;
    std::vector<size_t> s, a;
    std::vector<std::vector<size_t>> syn;
    std::vector<size_t> wta;
    std::vector<size_t> self;
};

/// plastic=true -> THREEFACTOR; false -> NONE (frozen baseline).
AMAgent makeAMAgent(const AMConfig& cfg, bool plastic);

struct AMTrialResult {
    int cue = 0;
    int choice = 0;
    double reward = 0;
    double modulator = 0;
    int spikes_correct_interf = 0; // interference-window spikes on pi(cue)
    int spikes_other_interf = 0;   // interference-window spikes on other units
};

/**
 * Execute one trial: cue window -> unrelated-item interference -> decision
 * (spike-count majority over R; ties: earliest first spike, then seeded
 * draw) -> quiet reward-delay -> one outcome step (sham: +1). net.reset()
 * first; weights persist across trials.
 */
AMTrialResult runAMTrial(AMAgent& agent, const AMConfig& cfg,
                         const AMTrialSchedule& sched, const AMMapping& map,
                         bool learning_enabled);

/// Current S->A weights as [cue][resp].
std::vector<std::vector<double>> amWeights(const AMAgent& agent);

/// Reset every S->A weight to w_init (memory ablation; architecture intact).
void amWipeWeights(AMAgent& agent, const AMConfig& cfg);

} // namespace learning
