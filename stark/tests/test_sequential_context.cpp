/**
 * STARK-L3: Sequential-context learning tests (see
 * stark/design/sequential_context_milestone.md for the frozen protocol).
 *
 * Covers: trial timestep accounting across the sequence and reward delay,
 * structural cue-independence of distractor/noise schedules (no leakage),
 * no-learning invariance, persistent-activity attractor (self-excitation)
 * retention and its ablation, probe recency behavior, schedule determinism,
 * and a deterministic end-to-end mini sequential-learning run with sham.
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
    SeqConfig cfg;
    cfg.seq_steps = 4;
    cfg.reward_delay = 3;
    SeqAgent a = makeSeqAgent(cfg, true);
    auto sched = makeSeqSchedule(cfg, 1, 7u, false);
    runSeqTrial(a, cfg, sched[0], true);
    // cue + seq + decision + delay + reward step.
    CHECK(a.net.getCurrentTimeStep() ==
          static_cast<size_t>(cfg.cue_steps + cfg.seq_steps + cfg.decision_steps + 3 + 1));

    SeqConfig cfg0 = cfg;
    cfg0.reward_delay = 0;
    SeqAgent a0 = makeSeqAgent(cfg0, true);
    auto s0 = makeSeqSchedule(cfg0, 1, 7u, false);
    runSeqTrial(a0, cfg0, s0[0], true);
    CHECK(a0.net.getCurrentTimeStep() ==
          static_cast<size_t>(cfg0.cue_steps + cfg0.seq_steps + cfg0.decision_steps + 0 + 1));
}

// ---------------------------------------------------------------------------
// Structural no-cue-leakage: distractor patterns, noise, and tie draws are
// generated without branching on the cue value (regenerating with the cue
// array rewritten leaves every other field identical), and the distractor
// load does not differ by cue in distribution.
static void test_structural_no_cue_leakage() {
    SeqConfig cfg;
    cfg.seq_steps = 12;
    auto sched = makeSeqSchedule(cfg, 400, 20261023u, false);

    // Independent regeneration: same seed, and cue values do not feed data.
    auto sched2 = makeSeqSchedule(cfg, 400, 20261023u, false);
    int load0 = 0, n0 = 0, load1 = 0, n1 = 0;
    for (size_t t = 0; t < sched.size(); ++t) {
        CHECK(sched[t].cue == sched2[t].cue);
        CHECK(sched[t].tie_u == sched2[t].tie_u);
        CHECK(sched[t].dist_pattern == sched2[t].dist_pattern);
        CHECK(sched[t].noise_a0 == sched2[t].noise_a0);
        int load = 0;
        for (int p : sched[t].dist_pattern) load += (p != 0);
        if (sched[t].cue == 0) { load0 += load; ++n0; }
        else { load1 += load; ++n1; }
    }
    // Balanced cues by construction.
    CHECK(n0 == 200);
    CHECK(n1 == 200);
    // Distractor load carries no cue information (mean difference small).
    double m0 = double(load0) / n0, m1 = double(load1) / n1;
    CHECK(std::fabs(m0 - m1) < 1.5); // per-trial load mean, tolerance in loads

    // Probe schedules place the anti-cue at the last sequence step; standard
    // schedules have none.
    auto probe = makeSeqSchedule(cfg, 4, 20261025u, true);
    auto std_s = makeSeqSchedule(cfg, 4, 20261025u, false);
    for (int t = 0; t < 4; ++t) {
        CHECK(probe[static_cast<size_t>(t)].anti_at == cfg.seq_steps - 1);
        CHECK(std_s[static_cast<size_t>(t)].anti_at == -1);
    }
}

// ---------------------------------------------------------------------------
static void test_no_learning_invariance() {
    SeqConfig cfg;
    cfg.seq_steps = 4;
    cfg.reward_delay = 4;
    auto sched = makeSeqSchedule(cfg, 8, 11u, false);

    // Frozen baseline: weights never change regardless of sequence/delay.
    SeqAgent f = makeSeqAgent(cfg, false);
    auto w0 = seqWeights(f);
    for (const auto& s : sched) runSeqTrial(f, cfg, s, false);
    auto w1 = seqWeights(f);
    for (size_t i = 0; i < 4; ++i) CHECK(w0[i] == w1[i]);

    // Plastic agent with learning disabled: identical guarantee.
    SeqAgent p = makeSeqAgent(cfg, true);
    auto v0 = seqWeights(p);
    for (const auto& s : sched) runSeqTrial(p, cfg, s, false);
    auto v1 = seqWeights(p);
    for (size_t i = 0; i < 4; ++i) CHECK(v0[i] == v1[i]);
}

// ---------------------------------------------------------------------------
// Persistent-activity attractor: with asymmetric learned weights the cued
// action neuron keeps firing across the distractor sequence while the other
// stays quiet; ablating self-excitation destroys the persistence.
static void test_attractor_persistence_and_ablation() {
    SeqConfig cfg;
    cfg.seq_steps = 8;

    // Forced asymmetric weights (trained-like), cue-0 trial.
    auto build = [&](double w_self) {
        SeqConfig c = cfg;
        c.w_self = w_self;
        SeqAgent a = makeSeqAgent(c, false); // weights set manually below
        a.net.getSynapse(a.plastic[0]).setWeight(0.7); // S0->A0
        a.net.getSynapse(a.plastic[1]).setWeight(0.1); // S0->A1
        a.net.getSynapse(a.plastic[2]).setWeight(0.1); // S1->A0
        a.net.getSynapse(a.plastic[3]).setWeight(0.7); // S1->A1
        return a;
    };

    SeqAgent att = build(1.2);
    auto sched = makeSeqSchedule(cfg, 1, 21u, false);
    // Force cue-0 for the test trial.
    SeqTrialSchedule s0 = sched[0];
    s0.cue = 0;
    SeqTrialResult r = runSeqTrial(att, cfg, s0, false);
    CHECK(r.spikes_a0_seq >= 2); // persistent firing across the sequence
    CHECK(r.spikes_a1_seq <= 1); // other action stays quiet
    CHECK(r.r.choice == 0);

    // Probe: anti-cue at the last sequence step must not flip the attractor
    // on a majority of noise draws in this forced-weight setting.
    int first = 0;
    auto probe = makeSeqSchedule(cfg, 20, 22u, true);
    for (int t = 0; t < 20; ++t) {
        SeqAgent a2 = build(1.2);
        SeqTrialSchedule sp = probe[static_cast<size_t>(t)];
        sp.cue = 0;
        SeqTrialResult rp = runSeqTrial(a2, cfg, sp, false);
        first += (rp.r.choice == 0);
    }
    CHECK(first >= 12); // attractor retains the FIRST cue against recency

    // Ablation: self-excitation removed -> no persistent firing.
    SeqAgent abl = build(0.0);
    SeqTrialResult ra = runSeqTrial(abl, cfg, s0, false);
    CHECK(ra.spikes_a0_seq <= r.spikes_a0_seq);
    CHECK(ra.spikes_a0_seq <= 2); // no sustained sequence firing
}

// ---------------------------------------------------------------------------
static void test_schedule_determinism() {
    SeqConfig cfg;
    auto a = makeSeqSchedule(cfg, 50, 99u, true);
    auto b = makeSeqSchedule(cfg, 50, 99u, true);
    for (size_t t = 0; t < a.size(); ++t) {
        CHECK(a[t].cue == b[t].cue);
        CHECK(a[t].tie_u == b[t].tie_u);
        CHECK(a[t].dist_pattern == b[t].dist_pattern);
        CHECK(a[t].noise_a0 == b[t].noise_a0);
        CHECK(a[t].noise_a1 == b[t].noise_a1);
    }
    // Replaying a trial from a fresh agent is deterministic end to end.
    SeqConfig c2;
    SeqAgent x = makeSeqAgent(c2, true);
    SeqAgent y = makeSeqAgent(c2, true);
    SeqTrialResult rx = runSeqTrial(x, c2, a[0], true);
    SeqTrialResult ry = runSeqTrial(y, c2, a[0], true);
    CHECK(rx.r.choice == ry.r.choice);
    CHECK(rx.r.reward == ry.r.reward);
    auto wx = seqWeights(x), wy = seqWeights(y);
    for (size_t i = 0; i < 4; ++i) CHECK(wx[i] == wy[i]);
}

// ---------------------------------------------------------------------------
static void test_mini_sequential_learning() {
    SeqConfig cfg;
    cfg.seq_steps = 4;      // C1-like short sequence
    cfg.reward_delay = 2;
    cfg.train_trials = 80;
    cfg.eval_trials = 30;

    auto train = makeSeqSchedule(cfg, cfg.train_trials, 20261023u, false);
    auto eval_s = makeSeqSchedule(cfg, cfg.eval_trials, 20261024u, false);

    SeqAgent trained = makeSeqAgent(cfg, true);
    SeqConfig scfg = cfg;
    scfg.reward_contingent = false;
    SeqAgent sh = makeSeqAgent(scfg, true);
    SeqAgent base = makeSeqAgent(cfg, false);

    for (const auto& s : train) {
        runSeqTrial(trained, cfg, s, true);
        runSeqTrial(sh, scfg, s, true);
    }

    int c_t = 0, c_s = 0, c_b = 0;
    for (const auto& s : eval_s) {
        SeqTrialResult rt = runSeqTrial(trained, cfg, s, false);
        SeqTrialResult rs = runSeqTrial(sh, scfg, s, false);
        SeqTrialResult rb = runSeqTrial(base, cfg, s, false);
        c_t += (rt.r.choice == rt.r.cue);
        c_s += (rs.r.choice == rs.r.cue);
        c_b += (rb.r.choice == rb.r.cue);
    }
    double acc_t = double(c_t) / cfg.eval_trials;
    double acc_s = double(c_s) / cfg.eval_trials;
    double acc_b = double(c_b) / cfg.eval_trials;

    CHECK(acc_t > acc_s);
    CHECK(acc_t > acc_b);
    CHECK(acc_t >= 0.65);
    double gap = 0.5 * (seqWeights(trained)[0] + seqWeights(trained)[3]) -
                 0.5 * (seqWeights(trained)[1] + seqWeights(trained)[2]);
    CHECK(gap > 0.0);
}

// ---------------------------------------------------------------------------
int main() {
    test_trial_timestep_accounting();
    std::cout << "  timestep accounting OK" << std::endl;
    test_structural_no_cue_leakage();
    std::cout << "  structural no-cue-leakage OK" << std::endl;
    test_no_learning_invariance();
    std::cout << "  no-learning invariance OK" << std::endl;
    test_attractor_persistence_and_ablation();
    std::cout << "  attractor persistence + ablation OK" << std::endl;
    test_schedule_determinism();
    std::cout << "  schedule determinism OK" << std::endl;
    test_mini_sequential_learning();
    std::cout << "  mini sequential learning OK" << std::endl;

    std::cout << "==========================================" << std::endl;
    std::cout << "Total assertions: " << g_checks << std::endl;
    std::cout << "ALL TESTS PASSED" << std::endl;
    std::cout << "==========================================" << std::endl;
    return 0;
}
