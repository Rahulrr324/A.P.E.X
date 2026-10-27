/**
 * STARK-L4: Multi-item associative-memory tests (see
 * stark/design/associative_memory_milestone.md, frozen protocol v1.0).
 *
 * Covers: trial timestep accounting, mapping validity/determinism, schedule
 * balance + distractor constraints + label-free generation, no-learning
 * invariance, attractor-based retrieval with forced bindings, memory
 * ablation (weight wipe), save/reload behavioral equivalence and
 * serialization round-trip identity, and a mini end-to-end multi-item
 * learning run with controls.
 *
 * Follows the counting-assertion convention of the earlier suites.
 */

#include "learning/AssociativeMemoryTask.h"
#include <iostream>
#include <cmath>
#include <cstdlib>
#include <vector>
#include <set>

#include <filesystem>
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
static void test_timestep_accounting() {
    AMConfig cfg;
    cfg.reward_delay = 3;
    AMAgent a = makeAMAgent(cfg, true);
    AMMapping map = makeMapping(7u, cfg.n_cues);
    auto trials = makeAMTrials(cfg, map, 2, 1, 11u, false);
    runAMTrial(a, cfg, trials[0], map, true);
    CHECK(a.net.getCurrentTimeStep() ==
          static_cast<size_t>(cfg.cue_steps + cfg.interf_steps + cfg.decision_steps + 3 + 1));

    AMConfig c0 = cfg;
    c0.reward_delay = 0;
    AMAgent a0 = makeAMAgent(c0, true);
    auto t0 = makeAMTrials(c0, map, 2, 1, 11u, false);
    runAMTrial(a0, c0, t0[0], map, true);
    CHECK(a0.net.getCurrentTimeStep() ==
          static_cast<size_t>(c0.cue_steps + c0.interf_steps + c0.decision_steps + 0 + 1));
}

// ---------------------------------------------------------------------------
static void test_mapping_validity() {
    AMMapping m1 = makeMapping(20261023u, 8);
    AMMapping m2 = makeMapping(20261023u, 8);
    AMMapping m3 = makeMapping(20261024u, 8);
    // Bijection over responses.
    std::set<int> seen;
    for (int r : m1.perm) seen.insert(r);
    CHECK(seen.size() == 8);
    for (int r = 0; r < 8; ++r) CHECK(seen.count(r) == 1);
    // Deterministic per seed; different seeds differ.
    CHECK(m1.perm == m2.perm);
    CHECK(m1.train_order == m2.train_order);
    CHECK(m1.perm != m3.perm);
    // train_order is a permutation of cue ids.
    std::set<int> cues;
    for (int c : m1.train_order) cues.insert(c);
    CHECK(cues.size() == 8);
}

// ---------------------------------------------------------------------------
// Label-free generation: distractors/noise do not depend on the response
// mapping; queries are balanced; distractors never equal the queried cue.
static void test_schedule_balance_and_no_leakage() {
    AMConfig cfg;
    AMMapping map = makeMapping(5u, cfg.n_cues);
    auto trials = makeAMTrials(cfg, map, 4, 24, 99u, false);

    CHECK(trials.size() == 96u);
    std::vector<int> cnt(8, 0);
    for (const auto& t : trials) {
        ++cnt[static_cast<size_t>(t.cue)];
        for (int d : t.distractors) {
            CHECK(d == -1 || (d >= 0 && d < 8 && d != t.cue));
        }
    }
    for (int k = 0; k < 4; ++k) {
        CHECK(cnt[static_cast<size_t>(map.train_order[static_cast<size_t>(k)])] == 24);
    }

    // Same seed, different mapping -> identical distractors and noise
    // (generation never branches on the response label).
    AMMapping map_b = map;
    std::swap(map_b.perm[0], map_b.perm[1]);
    auto trials_b = makeAMTrials(cfg, map_b, 4, 24, 99u, false);
    CHECK(trials.size() == trials_b.size());
    for (size_t t = 0; t < trials.size(); ++t) {
        CHECK(trials[t].cue == trials_b[t].cue);
        CHECK(trials[t].distractors == trials_b[t].distractors);
        CHECK(trials[t].noise == trials_b[t].noise);
        CHECK(trials[t].tie_u == trials_b[t].tie_u);
    }

    // Determinism of generation.
    auto trials_c = makeAMTrials(cfg, map, 4, 24, 99u, false);
    for (size_t t = 0; t < trials.size(); ++t) {
        CHECK(trials[t].distractors == trials_c[t].distractors);
        CHECK(trials[t].noise == trials_c[t].noise);
    }

    // Heavy schedule: no silent interference steps.
    auto heavy = makeAMTrials(cfg, map, 4, 2, 77u, true);
    for (const auto& t : heavy) {
        for (int d : t.distractors) CHECK(d != -1);
    }
}

// ---------------------------------------------------------------------------
static void test_no_learning_invariance() {
    AMConfig cfg;
    AMMapping map = makeMapping(13u, cfg.n_cues);
    auto trials = makeAMTrials(cfg, map, 2, 4, 31u, false);

    AMAgent f = makeAMAgent(cfg, false);
    auto w0 = amWeights(f);
    for (const auto& t : trials) runAMTrial(f, cfg, t, map, false);
    auto w1 = amWeights(f);
    CHECK(w0 == w1);

    AMAgent p = makeAMAgent(cfg, true);
    auto v0 = amWeights(p);
    for (const auto& t : trials) runAMTrial(p, cfg, t, map, false);
    auto v1 = amWeights(p);
    CHECK(v0 == v1);
}

// ---------------------------------------------------------------------------
// Retrieval: forced one-hot bindings (each trained cue -> ITS mapped response)
// must dominate choices through the interference window; the two cues
// retrieve different responses (no fixed action). Dynamics: the winning
// response unit ignites tonic self-sustained firing during the early
// interference window and holds it (persistent activity); challenger spikes
// are the designed interference and are measured, not asserted away.
static void test_forced_binding_retrieval() {
    AMConfig cfg;
    AMMapping map = makeMapping(2u, cfg.n_cues);
    const int u = map.train_order[0], v = map.train_order[1];
    const int ru = map.perm[static_cast<size_t>(u)];
    const int rv = map.perm[static_cast<size_t>(v)];
    CHECK(ru != rv);
    AMAgent a = makeAMAgent(cfg, false);
    for (int i = 0; i < cfg.n_cues; ++i) {
        for (int r = 0; r < cfg.n_resp; ++r) {
            double w = 0.1;
            if (i == u && r == ru) w = 0.7;
            if (i == v && r == rv) w = 0.7;
            a.net.getSynapse(a.syn[static_cast<size_t>(i)][static_cast<size_t>(r)]).setWeight(w);
        }
    }
    auto trials = makeAMTrials(cfg, map, 2, 12, 41u, false);
    int hit0 = 0, hit1 = 0, n0 = 0, n1 = 0, keep = 0, other = 0;
    for (const auto& t : trials) {
        AMTrialResult r = runAMTrial(a, cfg, t, map, false);
        if (t.cue == u) {
            ++n0;
            hit0 += (r.choice == ru);
            keep += r.spikes_correct_interf;
            other += r.spikes_other_interf;
        } else if (t.cue == v) {
            ++n1;
            hit1 += (r.choice == rv);
        }
    }
    CHECK(n0 == 12);
    CHECK(n1 == 12);
    CHECK(hit0 >= 9);   // binding retrieved despite interference
    CHECK(hit1 >= 9);   // different cue, different response (no fixed action)
    CHECK(keep >= 4 * n0); // tonic persistence across the interference window
    CHECK(other <= 2 * n0); // challengers rarely breach the held attractor
}

// ---------------------------------------------------------------------------
static void test_memory_ablation_and_save_reload() {
    AMConfig cfg;
    AMMapping map = makeMapping(3u, cfg.n_cues);
    const int u = map.train_order[0];
    const int ru = map.perm[static_cast<size_t>(u)];
    AMAgent a = makeAMAgent(cfg, true);
    for (int i = 0; i < cfg.n_cues; ++i) {
        for (int r = 0; r < cfg.n_resp; ++r) {
            double w = (i == u && r == ru) ? 0.7 : 0.1;
            a.net.getSynapse(a.syn[static_cast<size_t>(i)][static_cast<size_t>(r)]).setWeight(w);
        }
    }
    auto trials = makeAMTrials(cfg, map, 2, 8, 43u, false);

    // Save -> reload into a fresh agent: exact state + identical behavior.
    std::string s1 = a.net.serialize();
    a.net.save("build/dev_bin/am_test_state.net");
    AMAgent b = makeAMAgent(cfg, true);
    b.net.load("build/dev_bin/am_test_state.net");
    CHECK(a.net.serialize() == b.net.serialize()); // round-trip byte-identical
    CHECK(amWeights(a) == amWeights(b));           // weights bit-identical
    for (const auto& t : trials) {
        AMTrialResult ra = runAMTrial(a, cfg, t, map, false);
        AMTrialResult rb = runAMTrial(b, cfg, t, map, false);
        CHECK(ra.choice == rb.choice);
    }

    // Double reload is deterministic.
    AMAgent c = makeAMAgent(cfg, true);
    c.net.load("build/dev_bin/am_test_state.net");
    CHECK(c.net.serialize() == s1);

    // Memory ablation: wiping the stored state returns behavior to chance-
    // level retrieval while the architecture is intact.
    amWipeWeights(b, cfg);
    auto wb = amWeights(b);
    bool all_init = true;
    for (const auto& row : wb)
        for (double w : row)
            if (w != cfg.w_init) all_init = false;
    CHECK(all_init);
    int hit = 0;
    for (const auto& t : trials) {
        AMTrialResult r = runAMTrial(b, cfg, t, map, false);
        if (t.cue == u) hit += (r.choice == ru);
    }
    CHECK(hit <= 6); // no reliable retrieval left (8-way chance)
}

// ---------------------------------------------------------------------------
static void test_mini_multiitem_learning() {
    AMConfig cfg;
    cfg.train_per_item = 30;
    cfg.queries_per_item = 16;
    AMMapping map = makeMapping(20261023u, cfg.n_cues);

    // v1.1: training trials have a silent interference window.
    AMConfig cfg_train = cfg;
    cfg_train.p_none = 1.0;
    auto train = makeAMTrials(cfg_train, map, 2, cfg.train_per_item, 20261023u, false);
    auto ev = makeAMTrials(cfg, map, 2, cfg.queries_per_item, 20261025u, false);

    AMAgent trained = makeAMAgent(cfg, true);
    AMAgent base = makeAMAgent(cfg, false);
    for (const auto& t : train) runAMTrial(trained, cfg, t, map, true);

    int ct = 0, cb = 0, n = 0;
    for (const auto& t : ev) {
        AMTrialResult rt = runAMTrial(trained, cfg, t, map, false);
        AMTrialResult rb = runAMTrial(base, cfg, t, map, false);
        ++n;
        ct += (rt.choice == map.perm[static_cast<size_t>(rt.cue)]);
        cb += (rb.choice == map.perm[static_cast<size_t>(rb.cue)]);
    }
    double acc_t = double(ct) / n, acc_b = double(cb) / n;
    CHECK(acc_t > acc_b);
    CHECK(acc_t >= 0.60);

    // Learned rows are selective for their mapped response.
    auto w = amWeights(trained);
    for (int i = 0; i < 2; ++i) {
        int cue = map.train_order[static_cast<size_t>(i)];
        int correct = map.perm[static_cast<size_t>(cue)];
        double best = -1.0;
        int best_r = -1;
        for (int r = 0; r < cfg.n_resp; ++r) {
            if (w[static_cast<size_t>(cue)][static_cast<size_t>(r)] > best) {
                best = w[static_cast<size_t>(cue)][static_cast<size_t>(r)];
                best_r = r;
            }
        }
        CHECK(best_r == correct);
    }
}

// ---------------------------------------------------------------------------
int main() {

    // C4: the persistence checks below write into build/dev_bin/. Git cannot store an
    // empty directory, so a clean checkout does not have it and Network::save throws.
    // Create it here (path unchanged, so existing evidence locations stay valid).
    std::filesystem::create_directories("build/dev_bin");

    test_timestep_accounting();
    std::cout << "  timestep accounting OK" << std::endl;
    test_mapping_validity();
    std::cout << "  mapping validity OK" << std::endl;
    test_schedule_balance_and_no_leakage();
    std::cout << "  schedule balance + no leakage OK" << std::endl;
    test_no_learning_invariance();
    std::cout << "  no-learning invariance OK" << std::endl;
    test_forced_binding_retrieval();
    std::cout << "  forced binding retrieval OK" << std::endl;
    test_memory_ablation_and_save_reload();
    std::cout << "  memory ablation + save/reload OK" << std::endl;
    test_mini_multiitem_learning();
    std::cout << "  mini multi-item learning OK" << std::endl;

    std::cout << "==========================================" << std::endl;
    std::cout << "Total assertions: " << g_checks << std::endl;
    std::cout << "ALL TESTS PASSED" << std::endl;
    std::cout << "==========================================" << std::endl;
    return 0;
}
