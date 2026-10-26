// STARK-L7 tests: N-way learned relevance mechanism.
#include "learning/RelevanceRouting.h"
#include "neural/Network.h"
#include <cassert>
#include <cmath>
#include <iostream>
#include <set>
#include <string>
#include <vector>

#include <filesystem>
using namespace learning;

static int g_pass = 0, g_fail = 0;
#define CHECK(cond) do { if (cond) { ++g_pass; } else { ++g_fail; \
    std::cerr << "FAIL: " #cond " (line " << __LINE__ << ")\n"; } } while(0)

static bool isBijection(const std::vector<int>& v, int n) {
    std::set<int> s(v.begin(), v.end());
    if (int(s.size()) != n) return false;
    for (int x : v) if (x < 0 || x >= n) return false;
    return true;
}

int main() {

    // C4: the persistence checks below write into build/dev_bin/. Git cannot store an
    // empty directory, so a clean checkout does not have it and Network::save throws.
    // Create it here (path unchanged, so existing evidence locations stay valid).
    std::filesystem::create_directories("build/dev_bin");

    // --- makeLRMapping: perm and phi are bijections for N=2,4,8 ---
    for (int N : {2, 4, 8}) {
        LRConfig cfg;
        cfg.n_chan = N;
        cfg.n_ids = N + 4;
        cfg.n_ctx = N;
        for (unsigned seed : {123456789u, 218213831u, 171473193u}) {
            LRMapping m = makeLRMapping(seed, cfg.n_ids, cfg.n_ctx);
            CHECK(isBijection(m.perm, cfg.n_ids));
            CHECK(isBijection(m.phi, cfg.n_ctx));
            CHECK(int(m.perm.size()) == cfg.n_ids);
            CHECK(int(m.phi.size()) == cfg.n_ctx);
        }
    }
    // --- N=2 mapping matches the L6 structure (phi[0]+phi[1]=1) ---
    {
        LRConfig cfg; cfg.n_chan = 2; cfg.n_ids = 6; cfg.n_ctx = 2;
        LRMapping m = makeLRMapping(123456789u, 6, 2);
        CHECK(m.phi[0] + m.phi[1] == 1);
        CHECK((m.phi[0] == 0 && m.phi[1] == 1) || (m.phi[0] == 1 && m.phi[1] == 0));
    }
    // --- makeLRTrials: single trials have one candidate; pair trials have n_chan ---
    for (int N : {2, 4, 8}) {
        LRConfig cfg;
        cfg.n_chan = N;
        cfg.n_ids = N + 4;
        cfg.n_ctx = N;
        LRMapping m = makeLRMapping(123456789u, cfg.n_ids, cfg.n_ctx);
        auto single = makeLRTrials(cfg, m, 40, 0, 123456789u);
        int single_count = 0;
        for (const auto& t : single) {
            if (t.single) {
                ++single_count;
                int cnt = 0;
                for (int k = 0; k < cfg.n_chan; ++k)
                    if (t.presented[static_cast<size_t>(k)] >= 0) ++cnt;
                CHECK(cnt == 1);  // single trial: exactly one candidate
            }
        }
        CHECK(single_count == 40 * cfg.n_ids);
        auto pair = makeLRTrials(cfg, m, 0, 40, 123456789u + 1);
        int pair_count = 0;
        for (const auto& t : pair) {
            if (!t.single) {
                ++pair_count;
                int cnt = 0;
                for (int k = 0; k < cfg.n_chan; ++k)
                    if (t.presented[static_cast<size_t>(k)] >= 0) ++cnt;
                CHECK(cnt == cfg.n_chan);  // pair trial: all n_chan candidates
            }
        }
        CHECK(pair_count == 40 * cfg.n_ids);
    }
    // --- runLRTrial: ORACLE selects the queried channel (phi) ---
    for (int N : {2, 4, 8}) {
        LRConfig cfg;
        cfg.n_chan = N;
        cfg.n_ids = N + 4;
        cfg.n_ctx = N;
        LRMapping m = makeLRMapping(123456789u, cfg.n_ids, cfg.n_ctx);
        LRAgent ag = makeLRAgent(cfg, true);
        auto trials = makeLRTrials(cfg, m, 0, 20, 123456789u);
        int orc_ok = 0, orc_n = 0;
        for (const auto& t : trials) {
            LRTrialResult r = runLRTrial(ag, cfg, t, m, LR_ORACLE, false);
            if (r.sel_slot >= 0) {
                ++orc_n;
                if (r.sel_slot == r.queried_slot) ++orc_ok;
            }
        }
        CHECK(orc_n > 0);
        CHECK(orc_ok == orc_n);  // ORACLE always selects the queried channel
    }
    // --- runLRTrial: NEGATIVE inverts the selection ---
    {
        LRConfig cfg; cfg.n_chan = 2; cfg.n_ids = 6; cfg.n_ctx = 2;
        LRMapping m = makeLRMapping(123456789u, 6, 2);
        LRAgent ag = makeLRAgent(cfg, true);
        auto trials = makeLRTrials(cfg, m, 0, 20, 123456789u);
        int neg_neg = 0, neg_n = 0;
        for (const auto& t : trials) {
            LRTrialResult r = runLRTrial(ag, cfg, t, m, LR_NEGATIVE, false);
            if (r.sel_slot >= 0) {
                ++neg_n;
                // NEGATIVE: inverted selection → reward mostly -1
                if (r.reward < 0.0) ++neg_neg;
            }
        }
        CHECK(neg_n > 0);
        CHECK(neg_neg > neg_n / 2);  // majority negative reward
    }
    // --- save/reload: N-way routing weights preserved ---
    for (int N : {2, 4, 8}) {
        LRConfig cfg;
        cfg.n_chan = N;
        cfg.n_ids = N + 4;
        cfg.n_ctx = N;
        LRMapping m = makeLRMapping(123456789u, cfg.n_ids, cfg.n_ctx);
        LRAgent ag = makeLRAgent(cfg, true);
        auto train = makeLRTrials(cfg, m, cfg.train_trials / (2 * cfg.n_ids),
                                  cfg.train_trials / (2 * cfg.n_ids), 123456789u);
        for (const auto& t : train) runLRTrial(ag, cfg, t, m, LR_LEARNED, true);
        std::string s1 = ag.net.serialize();
        std::string path = "build/dev_bin/reload_test_L7_N" + std::to_string(N) + ".bin";
        ag.net.save(path);
        auto w1 = lrWeights(ag);
        std::vector<std::vector<double>> v1 = lrRouteStateAll(ag);
        LRAgent ag2 = makeLRAgent(cfg, true);
        ag2.net.load(path);
        CHECK(s1 == ag2.net.serialize());
        CHECK(w1 == lrWeights(ag2));
        bool routing_ok = true;
        for (int k = 0; k < cfg.n_ctx; ++k)
            for (int s = 0; s < cfg.n_chan; ++s)
                if (lrRouteState(ag2, k, s) != v1[static_cast<size_t>(k)][static_cast<size_t>(s)])
                    routing_ok = false;
        CHECK(routing_ok);
    }
    // --- lrRouteStateAll returns n_ctx x n_chan ---
    for (int N : {2, 4, 8}) {
        LRConfig cfg;
        cfg.n_chan = N;
        cfg.n_ids = N + 4;
        cfg.n_ctx = N;
        LRAgent ag = makeLRAgent(cfg, true);
        auto v = lrRouteStateAll(ag);
        CHECK(int(v.size()) == cfg.n_ctx);
        for (const auto& row : v) CHECK(int(row.size()) == cfg.n_chan);
    }
    std::cout << "Total assertions: " << (g_pass + g_fail) << "\n";
    if (g_fail == 0) {
        std::cout << "ALL TESTS PASSED\n";
        return 0;
    }
    std::cout << g_fail << " FAILED\n";
    return 1;
}
