/**
 * STARK-L2: Delayed-reward learning tests (see
 * stark/design/delayed_reward_milestone.md for the frozen protocol).
 *
 * Covers: trial timestep accounting across the delay, weight-level
 * degradation of learning with delay, no-learning invariance with delay,
 * baseline delay-invariance (decision precedes the reward), and a
 * deterministic end-to-end mini delayed-learning run with sham control.
 *
 * Follows the test_stdp/test_three_factor counting-assertion convention.
 */

#include "learning/ToyAssociationTask.h"
#include <iostream>
#include <cmath>
#include <cstdlib>
#include <vector>

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
static void test_trial_timestep_accounting() {
    TaskConfig cfg;
    cfg.reward_delay = 4;
    Agent a = makeAgent(cfg, true);
    auto sched = makeSchedule(cfg, 1, 7u);
    runTrial(a, cfg, sched[0], true);
    // cue window + delay + reward step.
    CHECK(a.net.getCurrentTimeStep() == static_cast<size_t>(cfg.cue_steps + 4 + 1));

    TaskConfig cfg0 = cfg;
    cfg0.reward_delay = 0;
    Agent a0 = makeAgent(cfg0, true);
    auto s0 = makeSchedule(cfg0, 1, 7u);
    runTrial(a0, cfg0, s0[0], true);
    CHECK(a0.net.getCurrentTimeStep() == static_cast<size_t>(cfg0.cue_steps + 0 + 1));
}

// ---------------------------------------------------------------------------
static void test_no_learning_invariance_with_delay() {
    TaskConfig cfg;
    cfg.reward_delay = 8;
    auto sched = makeSchedule(cfg, 8, 11u);

    // Frozen baseline: weights never change regardless of delay.
    Agent f = makeAgent(cfg, false);
    auto w0 = weights(f);
    for (const auto& s : sched) runTrial(f, cfg, s, false);
    auto w1 = weights(f);
    for (size_t i = 0; i < 4; ++i) CHECK(w0[i] == w1[i]);

    // Plastic agent without modulator across a delay: unchanged.
    Agent p = makeAgent(cfg, true);
    auto wp0 = weights(p);
    for (const auto& s : sched) runTrial(p, cfg, s, false);
    auto wp1 = weights(p);
    for (size_t i = 0; i < 4; ++i) CHECK(wp0[i] == wp1[i]);
}

// ---------------------------------------------------------------------------
// Weight-level degradation: identical training at D=0 vs D=8 must produce
// smaller total weight movement at D=8 (eligibility decays across the delay).
static void test_delay_reduces_weight_updates() {
    TaskConfig cfg;
    cfg.train_trials = 25;
    auto sched = makeSchedule(cfg, 25, 42u);

    auto total_move = [&](int delay) {
        TaskConfig c = cfg;
        c.reward_delay = delay;
        Agent a = makeAgent(c, true);
        auto w0 = weights(a);
        for (const auto& s : sched) runTrial(a, c, s, true);
        auto w1 = weights(a);
        double m = 0;
        for (size_t i = 0; i < 4; ++i) m += std::fabs(w1[i] - w0[i]);
        return m;
    };

    double move_d0 = total_move(0);
    double move_d8 = total_move(8);
    std::cout << "  weight movement: D0=" << move_d0 << " D8=" << move_d8 << std::endl;
    CHECK(move_d0 > 0.05);
    CHECK(move_d8 < move_d0);          // degradation with delay
    CHECK(move_d8 > 0.0);              // but not zero at D=8 (tau_e=8)
}

// ---------------------------------------------------------------------------
// Baseline choices are delay-invariant: the decision is made before the delay.
static void test_baseline_delay_invariance() {
    TaskConfig cfg;
    auto sched = makeSchedule(cfg, 30, 99u);

    auto choices = [&](int delay) {
        TaskConfig c = cfg;
        c.reward_delay = delay;
        Agent a = makeAgent(c, false);
        std::vector<int> cs;
        for (const auto& s : sched) cs.push_back(runTrial(a, c, s, false).choice);
        return cs;
    };
    auto c0 = choices(0);
    auto c16 = choices(16);
    bool identical = true;
    for (size_t i = 0; i < c0.size(); ++i)
        if (c0[i] != c16[i]) identical = false;
    CHECK(identical);
}

// ---------------------------------------------------------------------------
static void test_mini_delayed_learning() {
    TaskConfig cfg;
    cfg.train_trials = 60;
    cfg.eval_trials = 40;
    cfg.reward_delay = 4;

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

    TaskConfig cfg_sham = cfg;
    cfg_sham.reward_contingent = false;
    Agent sham = makeAgent(cfg_sham, true);
    for (const auto& s : train_sched) runTrial(sham, cfg_sham, s, true);
    int hits_s = 0;
    for (const auto& s : eval_sched)
        if (runTrial(sham, cfg_sham, s, false).reward > 0) ++hits_s;

    double acc_t = hits_t / 40.0, acc_b = hits_b / 40.0, acc_s = hits_s / 40.0;
    std::cout << "  mini(D=4): trained=" << acc_t << " baseline=" << acc_b
              << " sham=" << acc_s << std::endl;

    CHECK(acc_t > acc_b);
    CHECK(acc_t > acc_s);
    CHECK(acc_t >= 0.60);
    double gap = 0.5 * (w_trained[0] + w_trained[3]) - 0.5 * (w_trained[1] + w_trained[2]);
    CHECK(gap > 0.0);
}

// ---------------------------------------------------------------------------
int main() {
    test_trial_timestep_accounting();
    std::cout << "  timestep accounting OK" << std::endl;
    test_no_learning_invariance_with_delay();
    std::cout << "  no-learning invariance OK" << std::endl;
    test_delay_reduces_weight_updates();
    std::cout << "  delay reduces weight updates OK" << std::endl;
    test_baseline_delay_invariance();
    std::cout << "  baseline delay invariance OK" << std::endl;
    test_mini_delayed_learning();
    std::cout << "  mini delayed learning OK" << std::endl;

    std::cout << "==========================================" << std::endl;
    std::cout << "Total assertions: " << g_checks << std::endl;
    std::cout << "ALL TESTS PASSED" << std::endl;
    std::cout << "==========================================" << std::endl;
    return 0;
}
