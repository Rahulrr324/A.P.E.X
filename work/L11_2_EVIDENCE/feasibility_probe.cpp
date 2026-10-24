// STARK-L11.2 read-only feasibility probe (NOT part of the repository build).
//
// Question: can every field of the L11 trial schema be produced by the HARNESS
// alone, using only the public API, so that ContextConditionedMemory.cpp never
// has to be modified?
//
// This file is compiled in /tmp against a copy of stark/src and is never added
// to the repository. It performs no learning experiment: it constructs an agent,
// runs ONE trial, and prints the observability surface.

#include "learning/ContextConditionedMemory.h"
#include "learning/RelevanceRouting.h"

#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

using namespace learning;

static uint64_t fnv1a(const std::string& s) {
    uint64_t h = 1469598103934665603ULL;
    for (unsigned char c : s) { h ^= c; h *= 1099511628211ULL; }
    return h;
}

int main() {
    CCConfig cfg;                       // defaults: 3 banks, 12 features
    CCAgent ag = makeCCAgent(cfg, /*plastic=*/true);
    const unsigned master = 123456789u;

    // --- run-level identity ---
    const std::string state0 = ccSerialize(ag);
    std::printf("serialize_len=%zu state_fingerprint=%016llx\n",
                state0.size(), (unsigned long long)fnv1a(state0));

    // --- static metadata available to a writer ---
    std::printf("bank_state_size=%zu reward_baseline_size=%zu active_bank=%d\n",
                ag.bank_state.size(), ag.reward_baseline.size(), ccActiveBank(ag));

    // --- router surface: scores, margin, preferred bank ---
    LRMapping map = makeLRMapping(master + 0.0, cfg.lr.n_ids, cfg.lr.n_ctx);
    auto sched = makeLRTrials(cfg.lr, map, 0, 20, master);
    const LRTrialSchedule& lr = sched.front();

    std::vector<int> cue = {0, 1};      // a within-signature training pair
    auto W = ccRouterWeights(ag);       // [feat][bank]
    std::vector<double> score(cfg.n_banks, 0.0);
    for (int f : cue) for (int k = 0; k < cfg.n_banks; ++k) score[k] += W[f][k];
    std::printf("router_weights=%zux%zu score=[%.3f %.3f %.3f] preferred=%d\n",
                W.size(), W.empty() ? 0 : W[0].size(), score[0], score[1], score[2],
                ccPreferredBank(ag, cue));

    // --- bank weights: update-mass attribution source ---
    auto Wb0 = ccBankWeights(ag);       // [bank][id][resp]
    std::printf("bank_weights=%zux%zux%zu\n", Wb0.size(), Wb0[0].size(), Wb0[0][0].size());

    // --- one trial, learning ON, and the CCResult surface ---
    CCTrialSchedule s;
    s.lr = lr;
    s.cue = cue;
    CCResult r = runCCTrial(ag, s, map, /*task_bank=*/-1, CC_LEARNED, true, true, -1);
    std::printf("result: queried=%d choice=%d bank=%d sel_slot=%d plastic_write=%d "
                "reward=%.6f a0=%.4f a1=%.4f\n",
                r.queried, r.choice, r.bank, r.sel_slot, (int)r.plastic_write,
                r.reward, r.a0, r.a1);

    // --- intended slot / identity are driver-side, from the mapping ---
    std::printf("intended_slot=%d presented_size=%zu ctx=%d\n",
                map.phi[(size_t)lr.ctx], lr.presented.size(), lr.ctx);

    // --- update mass after the trial ---
    auto Wb1 = ccBankWeights(ag);
    double mass_queried = 0.0, mass_bank = 0.0;
    for (size_t a = 0; a < Wb1[(size_t)r.bank].size(); ++a)
        for (size_t b = 0; b < Wb1[(size_t)r.bank][a].size(); ++b) {
            double d = Wb1[(size_t)r.bank][a][b] - Wb0[(size_t)r.bank][a][b];
            if (d < 0) d = -d;
            mass_bank += d;
            if ((int)a == r.queried) mass_queried += d;
        }
    auto W1 = ccRouterWeights(ag);
    double router_l1 = 0.0;
    for (size_t f = 0; f < W1.size(); ++f)
        for (size_t k = 0; k < W1[f].size(); ++k) {
            double d = W1[f][k] - W[f][k];
            if (d < 0) d = -d;
            router_l1 += d;
        }
    std::printf("update_mass: bank=%.6f queried=%.6f router_l1=%.6f baseline=%.6f\n",
                mass_bank, mass_queried, router_l1, ag.reward_baseline[0]);

    const std::string state1 = ccSerialize(ag);
    std::printf("state_changed=%d\n", (int)(state1 != state0));
    return 0;
}
