#pragma once

/**
 * STARK-L6/L7: context-selected associative memory with a LEARNED
 * relevance-routing mechanism (see stark/design/learned_relevance_milestone.md
 * v1.0/v1.1 and n_way_learned_relevance_milestone.md v1.0).
 *
 * Task: candidates are presented on tagged channels; a context input
 * indicates which channel is queried (mapping phi is seeded, unknown to
 * the mechanism); distractor identities co-activate during an interference
 * window; reward follows the decision. Correct = pi(identity on channel
 * phi(ctx)).
 *
 * Mechanism (arms LEARNED/SHAM/NEGATIVE): routing state v[ctx][channel]
 * stored in ordinary synapses C->L; per-trial selection s* ~ softmax(v);
 * actuators = attentional input gain (unselected candidates suppressed) +
 * the STARK-L5 eligibility gate (only the selected identity row accumulates
 * eligibility). v is updated by REINFORCE from (choice consistency,
 * reward) only — phi is never observable to the mechanism.
 *
 * STARK-L7 generalization: n_chan candidate channels and n_ctx contexts
 * (defaults 2/2 reproduce STARK-L6 v1.1 byte-identically). No hand-designed
 * slot prior: the channels are ordinary stimulus representation; which
 * channel each context selects is learned.
 *
 * Arms: UNGATED (no selection), ORACLE (driver selects via phi — reference
 * upper bound), LEARNED, SHAM (reward-independent v updates), ABLATION
 * (no selection, all candidates eligible), NEGATIVE (selection inverted).
 */

#include "neural/Network.h"
#include <vector>
#include <cstddef>

namespace learning {

enum LRArm {
    LR_UNGATED = 0,
    LR_ORACLE = 1,
    LR_LEARNED = 2,
    LR_SHAM = 3,
    LR_ABLATION = 4,
    LR_NEGATIVE = 5,
};

/// Full parameterization (defaults implement frozen protocol v1.0 §2–3).
struct LRConfig {
    // Protocol
    int n_ids = 6;            // identities and responses
    int n_chan = 2;           // STARK-L7: candidate channels (N-way; 2 = L6)
    int n_ctx = 2;            // STARK-L7: contexts (N-way; 2 = L6)
    int ctx_steps = 2;
    int sample_steps = 3;
    int interf_steps = 8;
    int decision_steps = 6;
    int reward_delay = 2;
    int train_trials = 300;
    int eval_trials = 120;
    double dt = 1.0;

    // Environment drive
    double cue_current = 1.2;
    double background_current = 0.08;
    double noise_sample = 0.04;
    double noise_interf = 0.04;
    double noise_decision = 0.10;
    double p_none = 0.25;      // interference silent-step probability

    // Neurons (STARK-001)
    double tau_m = 10.0;
    double tau_a = 20.0;
    double theta_cue = 0.6;
    double theta_action = 1.2;
    double adapt_b = 0.0;
    double v_reset = -0.5;

    // Synapses (STARK-002/006)
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
    double w_self = 1.05;

    // Routing (learned relevance)
    double beta_route = 0.3;   // REINFORCE rate
    double v_clamp = 1.5;      // v1.1: bounded policy confidence (see design)
    double softmax_T = 1.0;

    bool reward_contingent = true;
};

/// Controlled assignment: pi (identity->response bijection) and phi
/// (ctx->channel bijection) — both seeded; phi is never given to the
/// mechanism.
struct LRMapping {
    std::vector<int> perm;    // perm[identity] = response
    std::vector<int> phi;     // phi[ctx] = queried channel (size n_ctx)
};

LRMapping makeLRMapping(unsigned seed, int n_ids, int n_ctx = 2);

/// One trial's precomputed schedule.
struct LRTrialSchedule {
    int ctx = 0;                     // context input driven (0..n_ctx-1)
    std::vector<int> presented;     // identity on channel s (-1: none)
    int id0 = 0, id1 = -1;           // derived: presented[0], presented[1]
    bool single = false;             // single-candidate mapping-credit trial
    std::vector<int> distractors;    // interf_steps: -1 silent, else identity
    std::vector<double> noise;       // n_ids_resp * (sample+interf+decision) steps, unit-major
    double tie_u = 0.5;
    double mech_u = 0.5;             // mechanism's policy sampling draw
    double sham_u = 0.5;             // reward-independent control draw
};

/**
 * Mixed schedules (v1.1): `single_per_item` single-candidate trials per
 * identity (mapping credit) and `pair_per_item` multi-candidate trials per
 * queried identity (selection credit), interleaved deterministically.
 * Queried identity placed on channel phi(ctx) (task construction); other
 * candidates on the remaining channels; distractors exclude the presented
 * identities; all draws seeded. Evaluation/generalization use (0, per_item):
 * pure multi-candidate.
 */
std::vector<LRTrialSchedule> makeLRTrials(const LRConfig& cfg,
                                          const LRMapping& map,
                                          int single_per_item, int pair_per_item,
                                          unsigned seed);

/// Agent: identities S, responses A, channel markers L, context neurons C.
/// Synapses: plastic[s][r] S->A (delay rung floor(r/2)); WTA + self on A;
/// route[ctx][channel] C->L weights hold the routing state v.
struct LRAgent {
    Network net;
    std::vector<size_t> s, a, l, c;
    std::vector<std::vector<size_t>> syn;
    std::vector<size_t> wta, self;
    std::vector<std::vector<size_t>> route;  // route[ctx][channel]
};

LRAgent makeLRAgent(const LRConfig& cfg, bool plastic);

struct LRTrialResult {
    int queried = 0, partner = 0, ctx = 0, queried_slot = 0;
    int choice = 0;
    double reward = 0;
    double modulator = 0;
    int sel_slot = -1;       // mechanism selection (-1 = none/ablation/ungated)
    std::vector<double> shares; // STARK-L7: attention shares over channels
    double a0 = 0.0, a1 = 0.0; // derived: shares[0], shares[1] (L6 compat)
    int s_sel = -1;          // diagnostic choice-consistency slot (-1 = none)
    bool fp_gate = false;    // attention/perception on a non-queried candidate
    bool miss_gate = false;  // attention/perception off for the queried sample
};

/**
 * Execute one trial. The mechanism sees only observable inputs (context
 * and identity/channel co-activation) and, at the reward step, the reward
 * and the chosen response. phi is consulted ONLY to score the response and
 * (in the ORACLE arm) to actuate the reference selection.
 */
LRTrialResult runLRTrial(LRAgent& agent, const LRConfig& cfg,
                         const LRTrialSchedule& sched, const LRMapping& map,
                         int arm, bool learning_enabled);

/// Current S->A weights as [identity][response].
std::vector<std::vector<double>> lrWeights(const LRAgent& agent);

/// Current routing state v[ctx][channel].
double lrRouteState(const LRAgent& agent, int ctx, int channel);

/// STARK-L7: full routing state as [ctx][channel].
std::vector<std::vector<double>> lrRouteStateAll(const LRAgent& agent);

} // namespace learning
