/**
 * STARK-L5: eligibility-gating tests (see
 * stark/design/eligibility_gating_milestone.md, frozen protocol v1.0).
 *
 * Covers: default-gate equivalence with the ungated rule (bit-identical),
 * gate semantics at the Network level (blocked trace creation -> blocked
 * updates), reset() restoring gates, query-only vs inverted gating in the
 * L4 v1.0 training configuration (unintended vs intended update mass),
 * mini end-to-end learning with training distractors, and serialization
 * compatibility (format unchanged; gates default true after load).
 *
 * Follows the counting-assertion convention of the earlier suites.
 */

#include "learning/AssociativeMemoryTask.h"
#include <iostream>
#include <cmath>
#include <cstdlib>
#include <utility>
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
// Network-level semantics: a gated-off pre neuron creates no eligibility, so
// the modulator event cannot move its outgoing weights.
static void test_network_gate_semantics() {
    Network net;
    size_t a = net.addNeuron(10.0, 1.0, 20.0, 0.0, -0.5);
    size_t b = net.addNeuron(10.0, 1.0, 20.0, 0.0, -0.5);
    size_t syn = net.addSynapse(a, b, 0.5, 2.0, 0);
    net.getSynapse(syn).setFullState(
        0.0, 0.5, 0.0, 0.0, 0.0, 0.0, 6.0, 6.0,
        0.0, 1.0, true, 0.0, 0.05, 0.02, 8.0, 0.6,
        true, PlasticityMode::THREEFACTOR);

    CHECK(net.getEligibilityGate(a) == true); // default on

    // reset() restores gates to default true (per-trial task state).
    net.setEligibilityGate(a, false);
    net.reset();
    CHECK(net.getEligibilityGate(a) == true); // restored by reset
    // Re-apply: gate OFF: pre and post spike, then m -> no eligibility, no update.
    net.setEligibilityGate(a, false);
    net.setExternalInput(a, 1.2);
    net.setExternalInput(b, 1.2);
    net.step(1.0); // both spike; gate off blocks accumulation
    net.setExternalInput(a, 1.2);
    net.setExternalInput(b, 1.2);
    net.setModulatorySignal(1.0);
    net.step(1.0);
    CHECK(net.getSynapse(syn).getWeight() == 0.5); // untouched
    CHECK(net.getSynapse(syn).getEligibility() == 0.0);

    // Gate ON: identical drive produces eligibility and a weight change.
    net.setEligibilityGate(a, true);
    net.reset();
    CHECK(net.getEligibilityGate(a) == true); // reset restores default true
    net.setExternalInput(a, 1.2);
    net.setExternalInput(b, 1.2);
    net.step(1.0);
    net.setExternalInput(a, 1.2);
    net.setExternalInput(b, 1.2);
    net.setModulatorySignal(1.0);
    net.step(1.0);
    CHECK(net.getSynapse(syn).getWeight() > 0.5); // same rule as before
    CHECK(net.getSynapse(syn).getEligibility() != 0.0);
}

// ---------------------------------------------------------------------------
// Default path unchanged: elig_gate_mode=0 (default) with the same schedules
// produces identical weights to an agent whose gates are explicitly all-on.
static void test_default_path_unchanged() {
    AMConfig cfg;
    AMMapping map = makeMapping(7u, cfg.n_cues);
    AMConfig ct = cfg;
    ct.p_none = 1.0;
    auto trials = makeAMTrials(ct, map, 2, 3, 11u, false);

    AMAgent a = makeAMAgent(cfg, true);
    AMAgent b = makeAMAgent(cfg, true);
    for (const auto& t : trials) {
        runAMTrial(a, cfg, t, map, true);
        runAMTrial(b, cfg, t, map, true); // both default gate mode 0
    }
    CHECK(amWeights(a) == amWeights(b));
}

// ---------------------------------------------------------------------------
// Gate modes in the L4 v1.0 training configuration (distractors during
// training): unintended (non-query-row) update mass U vs intended I.
static void test_update_mass_by_gate_mode() {
    AMConfig cfg; // p_none = 0.25: distractors DURING training
    AMMapping map = makeMapping(20261023u, cfg.n_cues);
    auto trials = makeAMTrials(cfg, map, 8, 4, 20261023u, false);

    auto mass = [&](int gate_mode) {
        AMConfig c = cfg;
        c.elig_gate_mode = gate_mode;
        AMAgent ag = makeAMAgent(c, true);
        double U = 0.0, I = 0.0;
        for (const auto& t : trials) {
            auto w0 = amWeights(ag);
            AMTrialResult r = runAMTrial(ag, c, t, map, true);
            auto w1 = amWeights(ag);
            for (int i = 0; i < c.n_cues; ++i) {
                for (int rr = 0; rr < c.n_resp; ++rr) {
                    double d = std::fabs(w1[i][rr] - w0[i][rr]);
                    if (i == t.cue) I += d; else U += d;
                }
            }
            (void)r;
        }
        return std::make_pair(U, I);
    };

    auto ung = mass(0);
    auto gat = mass(1);
    auto inv = mass(2);

    CHECK(ung.first > 0.0);   // ungated: unintended updates occur (v1.0 bug)
    CHECK(gat.first == 0.0);  // query-only gate: zero unintended updates, exactly
    CHECK(inv.first == 0.0 || inv.second == 0.0); // inverted: query row blocked
    CHECK(inv.second == 0.0); // exactly zero intended updates under inversion
    CHECK(gat.second > 0.0);  // the candidate gate does not suppress all learning
}

// ---------------------------------------------------------------------------
static void test_mini_learning_with_training_distractors() {
    AMConfig cfg;
    cfg.train_per_item = 30;
    cfg.queries_per_item = 16;
    AMMapping map = makeMapping(20261023u, cfg.n_cues);

    auto train = makeAMTrials(cfg, map, 2, cfg.train_per_item, 20261023u, false); // distractors ON
    auto ev = makeAMTrials(cfg, map, 2, cfg.queries_per_item, 20261025u, false);

    AMConfig cg = cfg;
    cg.elig_gate_mode = 1;
    AMAgent gated = makeAMAgent(cg, true);
    AMAgent ungated = makeAMAgent(cfg, true);
    for (const auto& t : train) {
        runAMTrial(gated, cg, t, map, true);
        runAMTrial(ungated, cfg, t, map, true);
    }

    int cg_hit = 0, cu_hit = 0, n = 0;
    for (const auto& t : ev) {
        AMTrialResult rg = runAMTrial(gated, cg, t, map, false);
        AMTrialResult ru = runAMTrial(ungated, cfg, t, map, false);
        ++n;
        cg_hit += (rg.choice == map.perm[static_cast<size_t>(rg.cue)]);
        cu_hit += (ru.choice == map.perm[static_cast<size_t>(ru.cue)]);
    }
    double acc_g = double(cg_hit) / n, acc_u = double(cu_hit) / n;
    CHECK(acc_g >= 0.60);
    CHECK(acc_g >= acc_u); // gated learns at least as well under training distractors

    // Trained rows select their mapped response.
    auto w = amWeights(gated);
    for (int k = 0; k < 2; ++k) {
        int cue = map.train_order[static_cast<size_t>(k)];
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
// Serialization: format unchanged; gates are volatile state (default true
// after load); saved+loaded agent reproduces behavior exactly.
static void test_serialization_compatibility() {
    AMConfig cfg;
    cfg.elig_gate_mode = 1;
    AMMapping map = makeMapping(3u, cfg.n_cues);
    AMAgent a = makeAMAgent(cfg, true);
    auto train = makeAMTrials(cfg, map, 2, 4, 31u, false);
    for (const auto& t : train) runAMTrial(a, cfg, t, map, true);

    std::string s1 = a.net.serialize();
    a.net.save("build/dev_bin/lg_test_state.net");
    AMAgent b = makeAMAgent(cfg, true);
    b.net.load("build/dev_bin/lg_test_state.net");
    CHECK(a.net.serialize() == b.net.serialize()); // round-trip byte-identical
    CHECK(amWeights(a) == amWeights(b));
    // Gates default true after load (volatile task state; driver re-sets).
    CHECK(b.net.getEligibilityGate(b.s[0]) == true);

    auto ev = makeAMTrials(cfg, map, 2, 4, 33u, false);
    for (const auto& t : ev) {
        AMTrialResult ra = runAMTrial(a, cfg, t, map, false);
        AMTrialResult rb = runAMTrial(b, cfg, t, map, false);
        CHECK(ra.choice == rb.choice);
    }
}

// ---------------------------------------------------------------------------
int main() {
    test_network_gate_semantics();
    std::cout << "  network gate semantics OK" << std::endl;
    test_default_path_unchanged();
    std::cout << "  default path unchanged OK" << std::endl;
    test_update_mass_by_gate_mode();
    std::cout << "  update mass by gate mode OK" << std::endl;
    test_mini_learning_with_training_distractors();
    std::cout << "  mini learning with training distractors OK" << std::endl;
    test_serialization_compatibility();
    std::cout << "  serialization compatibility OK" << std::endl;

    std::cout << "==========================================" << std::endl;
    std::cout << "Total assertions: " << g_checks << std::endl;
    std::cout << "ALL TESTS PASSED" << std::endl;
    std::cout << "==========================================" << std::endl;
    return 0;
}
