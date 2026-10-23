#pragma once

/**
 * STARK-L6: context-selected two-sample associative memory with a
 * LEARNED relevance-routing mechanism (see
 * stark/design/learned_relevance_milestone.md, frozen protocol v1.0).
 *
 * Task: two sample identities are presented on tagged slots; a context
 * input indicates which slot is queried (mapping phi is seeded, unknown to
 * the mechanism); distractor identities co-activate during an interference
 * window; reward follows the decision. Correct = pi(identity on slot
 * phi(ctx)).
 *
 * Mechanism (arms LEARNED/SHAM/NEGATIVE): routing state v[ctx][slot]
 * stored in 4 ordinary synapses C->L; per-trial selection s* ~ softmax(v);
 * actuators = attentional input gain (unselected sample suppressed) + the
 * STARK-L5 eligibility gate (only the selected identity row accumulates
 * eligibility). v is updated by REINFORCE from (choice consistency,
 * reward) only — phi is never observable to the mechanism.
 *
 * Arms: UNGATED (no selection), ORACLE (driver selects via phi — reference
 * upper bound), LEARNED, SHAM (reward-independent v updates), ABLATION
 * (no selection, both samples eligible), NEGATIVE (selection inverted).
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
/// (ctx->slot, identity or swap) — both seeded; phi is never given to the
/// mechanism.
struct LRMapping {
    std::vector<int> perm;    // perm[identity] = response
    int phi[2];               // phi[ctx] = queried slot
};

LRMapping makeLRMapping(unsigned seed, int n_ids);

/// One trial's precomputed schedule.
struct LRTrialSchedule {
    int ctx = 0;                     // 0 or 1 (context input driven)
    int id0 = 0, id1 = -1;           // identity on slot 0 / slot 1 (-1: none)
    bool single = false;             // single-sample mapping-credit trial
    std::vector<int> distractors;    // interf_steps: -1 silent, else identity
    std::vector<double> noise;       // n_ids_resp * (sample+interf+decision) steps, unit-major
    double tie_u = 0.5;
    double mech_u = 0.5;             // mechanism's policy sampling draw
    double sham_u = 0.5;             // reward-independent control draw
};

/**
 * Mixed schedules (v1.1): `single_per_item` single-sample trials per
 * identity (one candidate + distractors; mapping credit) and
 * `pair_per_item` two-sample trials per queried identity (selection
 * credit), interleaved deterministically. Queried identity placed on slot
 * phi(ctx) (task construction); distractors exclude the samples; all draws
 * seeded. Evaluation/generalization use (0, per_item): pure two-sample.
 */
std::vector<LRTrialSchedule> makeLRTrials(const LRConfig& cfg,
                                          const LRMapping& map,
                                          int single_per_item, int pair_per_item,
                                          unsigned seed);

/// Agent: identities S, responses A, slot markers L, context neurons C.
/// Synapses: plastic[s][r] S->A (delay rung floor(r/2)); WTA + self on A;
/// route[c][slot] C->L weights hold the routing state v.
struct LRAgent {
    Network net;
    std::vector<size_t> s, a, l, c;
    std::vector<std::vector<size_t>> syn;
    std::vector<size_t> wta, self;
    size_t route[2][2];
};

LRAgent makeLRAgent(const LRConfig& cfg, bool plastic);

struct LRTrialResult {
    int queried = 0, partner = 0, ctx = 0, queried_slot = 0;
    int choice = 0;
    double reward = 0;
    double modulator = 0;
    int sel_slot = -1;       // mechanism selection (-1 = none/ablation/ungated)
    double a0 = 0.0, a1 = 0.0; // attention shares (mechanism)
    int s_sel = -1;          // diagnostic choice-consistency slot (-1 = none)
    bool fp_gate = false;    // attention/perception on the non-queried sample
    bool miss_gate = false;  // attention/perception off for the queried sample
};

/**
 * Execute one trial. The mechanism sees only observable inputs (context
 * and identity/slot co-activation) and, at the reward step, the reward and
 * the chosen response. phi is consulted ONLY to score the response and
 * (in the ORACLE arm) to actuate the reference selection.
 */
LRTrialResult runLRTrial(LRAgent& agent, const LRConfig& cfg,
                         const LRTrialSchedule& sched, const LRMapping& map,
                         int arm, bool learning_enabled);

/// Current S->A weights as [identity][response].
std::vector<std::vector<double>> lrWeights(const LRAgent& agent);

/// Current routing state v[ctx][slot].
double lrRouteState(const LRAgent& agent, int ctx, int slot);

} // namespace learning
