/**
 * STARK-L10.1: focused regression test for the sealing toggle.
 *
 * The L10.1 audit found that L10-F's NO-SEAL ablation is vacuous under the
 * frozen protocol: every single-candidate (mapping-credit) trial lies inside
 * the commitment window, where the router is forced to the active bank, so the
 * seal predicate never has an opportunity to bind. That is a property of the
 * protocol, not of the mechanism.
 *
 * This test therefore checks the MECHANISM directly, at the level where the
 * toggle acts, and pins the three properties the corrected diagnostic relies on:
 *
 *   1. a single-candidate trial routed to a SEALED bank writes nothing
 *      (plastic_write == false, that bank's weights are bit-identical, and its
 *      mapping-credit gates stay off);
 *   2. the same trial with seal_superseded = false DOES write to that bank
 *      (the toggle changes exactly the intended behaviour, nothing else);
 *   3. a sealed bank is still READABLE — sealing is write protection, not
 *      deletion (its stored mapping still answers queries correctly);
 *   4. sealing does not grant or remove credit on multi-candidate trials: those
 *      carry no mapping credit in either arm (so the toggle cannot be confused
 *      with the L9 selection-trial rule).
 *
 * Before this test, nothing in the suite asserted (1)/(2): the L10 unit test
 * checks routing and forgetting, not the write predicate.
 */

#include "learning/ContextConditionedMemory.h"

#include <cmath>
#include <cstdlib>
#include <iostream>
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

namespace {

CCConfig baseConfig(bool seal) {
    CCConfig cfg;
    cfg.lr.n_ids = 6;
    cfg.lr.n_chan = 2;
    cfg.lr.n_ctx = 2;
    cfg.n_banks = 3;
    cfg.n_feat = 12;
    cfg.lr.softmax_T = 1.0 / std::sqrt(2.0) / 2.0;   // frozen F2a decision temperature
    cfg.commit_trials = 0;          // no commitment window: the router chooses
    cfg.seal_superseded = seal;
    return cfg;
}

// Sum |w - w0| over one bank's plastic matrix.
double bankDelta(const CCAgent& ag, int bank,
                 const std::vector<std::vector<std::vector<double>>>& w0) {
    const auto w1 = ccBankWeights(ag);
    double d = 0.0;
    for (size_t a = 0; a < w1[static_cast<size_t>(bank)].size(); ++a)
        for (size_t b = 0; b < w1[static_cast<size_t>(bank)][a].size(); ++b)
            d += std::fabs(w1[static_cast<size_t>(bank)][a][b] -
                           w0[static_cast<size_t>(bank)][a][b]);
    return d;
}

// Train a bank so it holds a real mapping, then seal it.
// Returns the agent with bank 0 SEALED (holding task 0's mapping) and bank 1
// ACTIVE (holding task 1's mapping).
CCAgent trainedTwoBankAgent(bool seal, const LRMapping& map0, const LRMapping& map1,
                            unsigned seed) {
    CCAgent ag = makeCCAgent(baseConfig(seal), true);
    ag.bank_state[0] = CC_ACTIVE;
    // bank 0 <- task 0
    {
        auto trials = makeLRTrials(ag.cfg.lr, map0, 720, 0, seed);
        for (const auto& t : trials) {
            CCTrialSchedule s;
            s.lr = t;
            s.cue = {0, 1};
            runCCTrial(ag, s, map0, -1, CC_LEARNED, true, false, /*forced_bank=*/0);
        }
    }
    ag.bank_state[1] = CC_ACTIVE;
    ag.bank_state[0] = CC_SEALED;   // supersede bank 0
    // bank 1 <- task 1
    {
        auto trials = makeLRTrials(ag.cfg.lr, map1, 720, 0, seed + 1);
        for (const auto& t : trials) {
            CCTrialSchedule s;
            s.lr = t;
            s.cue = {4, 5};
            runCCTrial(ag, s, map1, -1, CC_LEARNED, true, false, /*forced_bank=*/1);
        }
    }
    return ag;
}

// A fresh agent with bank 0 SEALED (untrained) and bank 1 ACTIVE. Nothing has
// been learned yet, so any weight change on the trial below is attributable to
// the toggle alone (and not to a saturated matrix).
CCAgent freshSealedAgent(bool seal) {
    CCAgent ag = makeCCAgent(baseConfig(seal), true);
    ag.bank_state[0] = CC_SEALED;
    ag.bank_state[1] = CC_ACTIVE;
    return ag;
}

} // namespace

int main() {
    std::cout << "[test_l10_1_sealing] sealing toggle behaviour\n";

    const unsigned seed = 424242u;
    const LRMapping map0 = makeLRMapping(seed + 0u, 6, 2);
    const LRMapping map1 = makeLRMapping(seed + 333u, 6, 2);

    // ---------------------------------------------------------------- 1 & 2
    // A single-candidate trial routed (forced) to the SEALED bank.
    CCTrialSchedule s;
    {
        auto trials = makeLRTrials(baseConfig(true).lr, map0, 1, 0, seed + 900u);
        s.lr = trials.at(0);
        s.cue = {0, 1};
    }
    CHECK(s.lr.single);   // mapping credit is possible on this schedule

    // (1) sealing ON
    {
        CCAgent ag = freshSealedAgent(true);
        CHECK(ag.bank_state[0] == CC_SEALED);
        CHECK(ag.bank_state[1] == CC_ACTIVE);
        const auto w0 = ccBankWeights(ag);
        CCResult r = runCCTrial(ag, s, map0, -1, CC_LEARNED, true, false, /*forced_bank=*/0);
        CHECK(r.bank == 0);
        CHECK(r.plastic_write == false);           // the seal predicate binds
        CHECK(bankDelta(ag, 1, w0) == 0.0);        // and nothing leaked to bank 1
        CHECK(bankDelta(ag, 0, w0) == 0.0);        // sealed bank unchanged
        // history-independence of the gate state: the credit gates are off
        for (size_t i = 0; i < ag.s[0].size(); ++i)
            CHECK(ag.net.getEligibilityGate(ag.s[0][i]) == false);
        std::cout << "  sealed bank: write blocked (0 weight change)  ok\n";
    }

    // (2) sealing OFF — the only difference is the config flag
    {
        CCAgent ag = freshSealedAgent(false);
        CHECK(ag.bank_state[0] == CC_SEALED);   // lifecycle state is still SEALED
        CHECK(ag.bank_state[1] == CC_ACTIVE);
        const auto w0 = ccBankWeights(ag);
        CCResult r = runCCTrial(ag, s, map0, -1, CC_LEARNED, true, false, /*forced_bank=*/0);
        CHECK(r.bank == 0);
        CHECK(r.plastic_write == true);            // the toggle changes the predicate
        CHECK(bankDelta(ag, 0, w0) > 0.0);         // and a real write happened
        CHECK(bankDelta(ag, 1, w0) == 0.0);        // still confined to the selected bank
        std::cout << "  unsealed bank: write executed  ok\n";
    }

    // ---------------------------------------------------------------- 3
    // A sealed bank is still readable: sealing is not deletion.
    // The readout accuracy of the sealed bank must be IDENTICAL before and
    // after the seal is applied (note: accuracy here is < 1 because this agent
    // is trained on single-candidate trials only and therefore never tunes the
    // shared channel policy `v`, which multi-candidate trials train).
    {
        CCAgent ag = trainedTwoBankAgent(true, map0, map1, seed);
        auto readAcc = [&](CCAgent& a) {
            std::string snap = ccSerialize(a);
            int ok = 0, n = 0;
            for (const auto& t : makeLRTrials(a.cfg.lr, map0, 0, 20, seed + 700u)) {
                CCTrialSchedule e;
                e.lr = t;
                e.cue = {0, 1};
                CCResult r = runCCTrial(a, e, map0, -1, CC_LEARNED, false, false,
                                        /*forced_bank=*/0);
                CHECK(r.bank == 0);
                ++n;
                if (r.choice == map0.perm[static_cast<size_t>(r.queried)]) ++ok;
            }
            ccDeserialize(a, snap);   // measurement must not perturb the agent
            return double(ok) / double(n);
        };
        const double acc_sealed = readAcc(ag);
        ag.bank_state[0] = CC_ACTIVE;     // temporarily unseal
        const double acc_unsealed = readAcc(ag);
        ag.bank_state[0] = CC_SEALED;
        CHECK(acc_sealed == acc_unsealed);       // sealing does not change readout
        CHECK(acc_sealed > 0.5);                 // and the bank really holds a mapping
        std::cout << "  sealed bank still answers its own mapping (acc "
                  << acc_sealed << ", unchanged by the seal)  ok\n";
    }

    // ---------------------------------------------------------------- 4
    // Multi-candidate trials carry no mapping credit in either arm.
    {
        auto multi = makeLRTrials(baseConfig(true).lr, map0, 0, 1, seed + 901u);
        CHECK(!multi.at(0).single);
        for (int seal = 0; seal <= 1; ++seal) {
            CCAgent ag = freshSealedAgent(seal != 0);
            const auto w0 = ccBankWeights(ag);
            CCTrialSchedule m;
            m.lr = multi.at(0);
            m.cue = {0, 1};
            CCResult r = runCCTrial(ag, m, map0, -1, CC_LEARNED, true, false,
                                    /*forced_bank=*/0);
            (void)r;
            CHECK(bankDelta(ag, 0, w0) == 0.0);
            for (size_t i = 0; i < ag.s[0].size(); ++i)
                CHECK(ag.net.getEligibilityGate(ag.s[0][i]) == false);
        }
        std::cout << "  multi-candidate trials: no credit in either arm  ok\n";
    }

    std::cout << "PASS (" << g_checks << " assertions)\n";
    return 0;
}
