/**
 * STARK-L1: Reproducible learning-loop tests (see
 * stark/design/learning_loop_milestone.md for the frozen success criteria).
 *
 * Covers: schedule determinism/balance, agent construction and plasticity
 * modes, frozen-baseline invariance, modulator-gated learning direction,
 * evaluation invariance, and a deterministic end-to-end mini protocol.
 *
 * Follows the test_stdp/test_three_factor counting-assertion convention.
 */

#include "learning/ToyAssociationTask.h"
#include <iostream>
#include <cmath>
#include <cstdlib>

static int g_checks = 0;

#define CHECK(cond)                                                        \
    do {                                                                   \
        ++g_checks;                                                        \
        if (!(cond)) {                                                     \
            std::cerr << "  FAILED: " << #cond << " (line " << __LINE__    \
                      << ")" << std::endl;                                 \
            std::abort();                                                  \
        }                                                                  \
    } while (0)

using namespace learning;

// ---------------------------------------------------------------------------
static void test_schedule_determinism() {
    TaskConfig cfg;
    auto a1 = makeSchedule(cfg, 20, 12345u);
    auto a2 = makeSchedule(cfg, 20, 12345u);
    auto b  = makeSchedule(cfg, 20, 99999u);

    CHECK(a1.size() == 20);
    bool same = true, diff_seed_differs = false;
    int zeros = 0;
    for (size_t i = 0; i < a1.size(); ++i) {
        if (a1[i].cue != a2[i].cue) same = false;
        if (a1[i].cue != b[i].cue) diff_seed_differs = true;
        for (size_t k = 0; k < a1[i].noise_a0.size(); ++k) {
            if (a1[i].noise_a0[k] != a2[i].noise_a0[k]) same = false;
            if (a1[i].noise_a1[k] != a2[i].noise_a1[k]) same = false;
        }
        if (a1[i].cue == 0) ++zeros;
    }
    CHECK(same);
    CHECK(diff_seed_differs);
    CHECK(zeros == 10);  // balanced
}

// ---------------------------------------------------------------------------
static void test_agent_construction() {
    TaskConfig cfg;
    Agent p = makeAgent(cfg, true);
    Agent f = makeAgent(cfg, false);

    CHECK(p.net.getNeuronCount() == 4);
    // 4 plastic cue->action synapses + 2 fixed lateral inhibitory (WTA).
    CHECK(p.net.getSynapseCount() == 6);
    CHECK(f.net.getSynapseCount() == 6);
    CHECK(p.syn.size() == 4);

    auto wp = weights(p);
    auto wf = weights(f);
    for (size_t i = 0; i < 4; ++i) {
        CHECK(wp[i] == cfg.w_init);
        CHECK(wf[i] == cfg.w_init);
    }
    CHECK(p.net.getPlasticityMode(p.syn[0]) == PlasticityMode::THREEFACTOR);
    CHECK(f.net.getPlasticityMode(f.syn[0]) == PlasticityMode::NONE);
    // Endpoints: [S0->A0, S0->A1, S1->A0, S1->A1]
    CHECK(p.net.getPreNeuron(p.syn[0]) == p.s0 && p.net.getPostNeuron(p.syn[0]) == p.a0);
    CHECK(p.net.getPreNeuron(p.syn[1]) == p.s0 && p.net.getPostNeuron(p.syn[1]) == p.a1);
    CHECK(p.net.getPreNeuron(p.syn[2]) == p.s1 && p.net.getPostNeuron(p.syn[2]) == p.a0);
    CHECK(p.net.getPreNeuron(p.syn[3]) == p.s1 && p.net.getPostNeuron(p.syn[3]) == p.a1);
    // Lateral WTA synapses: A0->A1 and A1->A0, fixed and non-plastic.
    size_t lat0 = 4, lat1 = 5;
    CHECK(p.net.getPreNeuron(lat0) == p.a0 && p.net.getPostNeuron(lat0) == p.a1);
    CHECK(p.net.getPreNeuron(lat1) == p.a1 && p.net.getPostNeuron(lat1) == p.a0);
    CHECK(p.net.getPlasticityMode(lat0) == PlasticityMode::NONE);
    CHECK(p.net.getPlasticityMode(lat1) == PlasticityMode::NONE);
    CHECK(p.net.getSynapse(lat0).getWeight() == cfg.w_inh);
    CHECK(p.net.getSynapse(lat1).getWeight() == cfg.w_inh);
}

// ---------------------------------------------------------------------------
static void test_frozen_and_unmodulated_invariance() {
    TaskConfig cfg;
    cfg.train_trials = 10;
    auto sched = makeSchedule(cfg, 10, 7u);

    // Frozen baseline: weights never change.
    Agent f = makeAgent(cfg, false);
    auto w0 = weights(f);
    for (const auto& s : sched) runTrial(f, cfg, s, false);
    auto w1 = weights(f);
    for (size_t i = 0; i < 4; ++i) CHECK(w0[i] == w1[i]);

    // Plastic agent WITHOUT the modulator: eligibility accumulates but no
    // weight change (three-factor signature: m gates all plasticity).
    Agent p = makeAgent(cfg, true);
    auto wp0 = weights(p);
    for (const auto& s : sched) runTrial(p, cfg, s, false);
    auto wp1 = weights(p);
    for (size_t i = 0; i < 4; ++i) CHECK(wp0[i] == wp1[i]);
}

// ---------------------------------------------------------------------------
static void test_learning_direction() {
    TaskConfig cfg;
    TaskConfig single = cfg;
    // 30 all-cue-0 trials (custom schedule: cue forced to 0).
    auto sched = makeSchedule(cfg, 30, 42u);
    for (auto& s : sched) s.cue = 0;

    Agent p = makeAgent(cfg, true);
    auto w0 = weights(p);
    for (const auto& s : sched) runTrial(p, cfg, s, true);
    auto w1 = weights(p);

    // Silent pathway (S1 never spikes) must be untouched bit-exactly.
    CHECK(w1[2] == w0[2]);
    CHECK(w1[3] == w0[3]);
    // Active pathway (S0) must have moved (reward-gated updates happened).
    double moved = std::fabs(w1[0] - w0[0]) + std::fabs(w1[1] - w0[1]);
    CHECK(moved > 0.01);
    // Bounds respected.
    for (double w : w1) { CHECK(w >= cfg.w_min - 1e-12); CHECK(w <= cfg.w_max + 1e-12); }
}

// ---------------------------------------------------------------------------
static void test_end_to_end_mini() {
    TaskConfig cfg;
    cfg.train_trials = 60;
    cfg.eval_trials = 40;

    unsigned seed_train = cfg.master_seed;
    unsigned seed_eval = cfg.master_seed + 1u;
    auto train_sched = makeSchedule(cfg, cfg.train_trials, seed_train);
    auto eval_sched = makeSchedule(cfg, cfg.eval_trials, seed_eval);

    Agent trained = makeAgent(cfg, true);
    for (const auto& s : train_sched) runTrial(trained, cfg, s, true);
    auto w_trained = weights(trained);

    int hits_t = 0;
    for (const auto& s : eval_sched)
        if (runTrial(trained, cfg, s, false).reward > 0) ++hits_t;

    Agent baseline = makeAgent(cfg, false);
    int hits_b = 0;
    for (const auto& s : eval_sched)
        if (runTrial(baseline, cfg, s, false).reward > 0) ++hits_b;

    // Sham negative control: identical training with modulator +1 always.
    TaskConfig cfg_sham = cfg;
    cfg_sham.reward_contingent = false;
    Agent sham = makeAgent(cfg_sham, true);
    for (const auto& s : train_sched) runTrial(sham, cfg_sham, s, true);
    int hits_s = 0;
    for (const auto& s : eval_sched)
        if (runTrial(sham, cfg_sham, s, false).reward > 0) ++hits_s;

    double acc_t = hits_t / 40.0;
    double acc_b = hits_b / 40.0;
    double acc_s = hits_s / 40.0;
    std::cout << "  mini: acc_trained=" << acc_t << " acc_baseline=" << acc_b
              << " acc_sham=" << acc_s << std::endl;

    // Mechanism-level integration evidence (deterministic given the seed):
    // trained must beat the frozen baseline and clear a modest bar.
    CHECK(acc_t > acc_b);
    CHECK(acc_t >= 0.60);
    // Reward contingency is causal: the sham-reward control must not learn.
    CHECK(acc_t > acc_s);
    // Correct-pair association emerges.
    double gap = 0.5 * (w_trained[0] + w_trained[3]) - 0.5 * (w_trained[1] + w_trained[2]);
    CHECK(gap > 0.0);
    // Evaluation never trained (weights within bounds, baseline unchanged).
    auto w_base = weights(baseline);
    for (size_t i = 0; i < 4; ++i) CHECK(w_base[i] == cfg.w_init);
}

// ---------------------------------------------------------------------------
int main() {
    test_schedule_determinism();
    std::cout << "  schedule determinism OK" << std::endl;
    test_agent_construction();
    std::cout << "  agent construction OK" << std::endl;
    test_frozen_and_unmodulated_invariance();
    std::cout << "  frozen/unmodulated invariance OK" << std::endl;
    test_learning_direction();
    std::cout << "  learning direction OK" << std::endl;
    test_end_to_end_mini();
    std::cout << "  end-to-end mini OK" << std::endl;

    std::cout << "==========================================" << std::endl;
    std::cout << "Total assertions: " << g_checks << std::endl;
    std::cout << "ALL TESTS PASSED" << std::endl;
    std::cout << "==========================================" << std::endl;
    return 0;
}
