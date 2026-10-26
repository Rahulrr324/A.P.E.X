/**
 * STARK-L6: learned-relevance tests (see
 * stark/design/learned_relevance_milestone.md, frozen protocol v1.0).
 *
 * Covers: timestep accounting, mapping/schedule validity and balance,
 * query construction (queried identity on slot phi(ctx), distractors never
 * the samples), mechanism isolation (selection from routing state only),
 * routing-state persistence through save/load, control degradation
 * (negative misdirection, ablation, sham), and a mini end-to-end learned-
 * relevance run with distractors during training.
 *
 * Follows the counting-assertion convention of the earlier suites.
 */

#include "learning/RelevanceRouting.h"
#include <iostream>
#include <cmath>
#include <cstdlib>
#include <set>
#include <vector>

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
    LRConfig cfg;
    cfg.reward_delay = 3;
    LRAgent a = makeLRAgent(cfg, true);
    LRMapping map = makeLRMapping(7u, cfg.n_ids);
    auto trials = makeLRTrials(cfg, map, 0, 1, 11u);
    runLRTrial(a, cfg, trials[0], map, LR_LEARNED, true);
    CHECK(a.net.getCurrentTimeStep() ==
          static_cast<size_t>(cfg.ctx_steps + cfg.sample_steps + cfg.interf_steps +
                              cfg.decision_steps + 3 + 1));
}

// ---------------------------------------------------------------------------
static void test_mapping_and_schedule_validity() {
    LRConfig cfg;
    LRMapping m1 = makeLRMapping(20261023u, cfg.n_ids);
    LRMapping m2 = makeLRMapping(20261023u, cfg.n_ids);
    CHECK(m1.perm == m2.perm);
    CHECK(m1.phi[0] == m2.phi[0] && m1.phi[1] == m2.phi[1]);
    CHECK(m1.phi[1] == 1 - m1.phi[0]); // phi is identity or swap
    std::set<int> seen;
    for (int r : m1.perm) seen.insert(r);
    CHECK(seen.size() == 6); // bijection

    auto trials = makeLRTrials(cfg, m1, 10, 10, 20261023u);
    CHECK(trials.size() == 120u);
    std::vector<int> cnt(6, 0);
    for (const auto& t : trials) {
        // Queried identity sits on slot phi(ctx) for pair trials; single
        // trials have one candidate; partner is distinct.
        int queried, partner = -1;
        if (t.single) {
            queried = (t.id0 >= 0) ? t.id0 : t.id1;
        } else {
            queried = (m1.phi[t.ctx] == 0) ? t.id0 : t.id1;
            partner = (m1.phi[t.ctx] == 0) ? t.id1 : t.id0;
            CHECK(queried != partner);
        }
        ++cnt[queried];
        // Distractors never the presented samples (unrelated items only).
        for (int d : t.distractors) {
            CHECK(d == -1 || (d != t.id0 && d != t.id1 && d >= 0 && d < 6));
        }
        CHECK(partner >= -1);
    }
    for (int i = 0; i < 6; ++i) CHECK(cnt[i] == 20); // exactly balanced

    // Determinism.
    auto trials2 = makeLRTrials(cfg, m1, 10, 10, 20261023u);
    for (size_t t = 0; t < trials.size(); ++t) {
        CHECK(trials[t].id0 == trials2[t].id0);
        CHECK(trials[t].distractors == trials2[t].distractors);
        CHECK(trials[t].noise == trials2[t].noise);
        CHECK(trials[t].mech_u == trials2[t].mech_u);
    }
}

// ---------------------------------------------------------------------------
// Mechanism isolation: selection follows the routing state and the seeded
// sampling draw only. phi is never consulted (verified by construction of
// the API; here we verify the behavioral dependence on v).
static void test_selection_follows_routing_state() {
    LRConfig cfg;
    LRMapping map = makeLRMapping(2u, cfg.n_ids);
    LRAgent a = makeLRAgent(cfg, false);
    // Force routing state: ctx 0 strongly prefers slot 0.
    a.net.getSynapse(a.route[0][0]).setWeight(3.0);
    a.net.getSynapse(a.route[0][1]).setWeight(-3.0);

    auto trials = makeLRTrials(cfg, map, 0, 6, 41u);
    int sel0 = 0, n0 = 0;
    for (const auto& t : trials) {
        if (t.ctx != 0) continue;
        ++n0;
        LRTrialResult r = runLRTrial(a, cfg, t, map, LR_LEARNED, false);
        CHECK(r.sel_slot == 0); // a0 ~ 0.997; mech_u < 0.997 always here
        CHECK(r.a0 > 0.9);
        if (r.sel_slot == 0) ++sel0;
    }
    CHECK(n0 > 0);
    CHECK(sel0 == n0);

    // Negative arm inverts the actuation.
    LRTrialResult rn = runLRTrial(a, cfg, trials[0], map, LR_NEGATIVE, false);
    CHECK(rn.sel_slot == 1 - (rn.a0 > trials[0].mech_u ? 0 : 1));
}

// ---------------------------------------------------------------------------
static void test_routing_persistence() {
    LRConfig cfg;
    LRMapping map = makeLRMapping(3u, cfg.n_ids);
    LRAgent a = makeLRAgent(cfg, true);
    auto train = makeLRTrials(cfg, map, 2, 2, 31u);
    for (const auto& t : train) runLRTrial(a, cfg, t, map, LR_LEARNED, true);

    double v00 = lrRouteState(a, 0, 0), v01 = lrRouteState(a, 0, 1);
    std::string s1 = a.net.serialize();
    a.net.save("build/dev_bin/lr_test_state.net");
    LRAgent b = makeLRAgent(cfg, true);
    b.net.load("build/dev_bin/lr_test_state.net");
    CHECK(a.net.serialize() == b.net.serialize()); // round-trip byte-identical
    CHECK(lrWeights(a) == lrWeights(b));
    CHECK(lrRouteState(b, 0, 0) == v00);           // routing state persisted
    CHECK(lrRouteState(b, 0, 1) == v01);

    auto ev = makeLRTrials(cfg, map, 0, 2, 33u);
    for (const auto& t : ev) {
        LRTrialResult ra = runLRTrial(a, cfg, t, map, LR_LEARNED, false);
        LRTrialResult rb = runLRTrial(b, cfg, t, map, LR_LEARNED, false);
        CHECK(ra.choice == rb.choice);
        CHECK(ra.sel_slot == rb.sel_slot);
    }
}

// ---------------------------------------------------------------------------
static void test_mini_learned_relevance() {
    LRConfig cfg;
    LRMapping map = makeLRMapping(20261023u, cfg.n_ids);
    auto train = makeLRTrials(cfg, map, 30, 30, 20261023u);   // 360 mixed
    auto ev = makeLRTrials(cfg, map, 0, 10, 20261025u);       // pure two-sample

    LRAgent learned = makeLRAgent(cfg, true);
    LRAgent ablation = makeLRAgent(cfg, true);
    LRAgent negative = makeLRAgent(cfg, true);
    for (const auto& t : train) {
        runLRTrial(learned, cfg, t, map, LR_LEARNED, true);
        runLRTrial(ablation, cfg, t, map, LR_ABLATION, true);
        runLRTrial(negative, cfg, t, map, LR_NEGATIVE, true);
    }

    int cl = 0, cn = 0, ca = 0, n = 0, sel_ok = 0, sel_n = 0;
    for (const auto& t : ev) {
        LRTrialResult rl = runLRTrial(learned, cfg, t, map, LR_LEARNED, false);
        LRTrialResult rn = runLRTrial(negative, cfg, t, map, LR_NEGATIVE, false);
        LRTrialResult ra = runLRTrial(ablation, cfg, t, map, LR_ABLATION, false);
        ++n;
        cl += (rl.choice == map.perm[rl.queried]);
        cn += (rn.choice == map.perm[rn.queried]);
        ca += (ra.choice == map.perm[ra.queried]);
        if (rl.sel_slot == rl.queried_slot) ++sel_ok;
        ++sel_n;
    }
    double acc_l = double(cl) / n, acc_n = double(cn) / n, acc_a = double(ca) / n;
    CHECK(acc_l >= 0.55);
    CHECK(acc_l > acc_a);      // learned relevance beats ablation
    CHECK(acc_l > acc_n);      // misdirected relevance degrades
    CHECK(double(sel_ok) / sel_n >= 0.70); // routing learned phi
}

// ---------------------------------------------------------------------------
int main() {

    // C4: the persistence checks below write into build/dev_bin/. Git cannot store an
    // empty directory, so a clean checkout does not have it and Network::save throws.
    // Create it here (path unchanged, so existing evidence locations stay valid).
    std::filesystem::create_directories("build/dev_bin");

    test_timestep_accounting();
    std::cout << "  timestep accounting OK" << std::endl;
    test_mapping_and_schedule_validity();
    std::cout << "  mapping + schedule validity OK" << std::endl;
    test_selection_follows_routing_state();
    std::cout << "  selection follows routing state OK" << std::endl;
    test_routing_persistence();
    std::cout << "  routing persistence OK" << std::endl;
    test_mini_learned_relevance();
    std::cout << "  mini learned relevance OK" << std::endl;

    std::cout << "==========================================" << std::endl;
    std::cout << "Total assertions: " << g_checks << std::endl;
    std::cout << "ALL TESTS PASSED" << std::endl;
    std::cout << "==========================================" << std::endl;
    return 0;
}
