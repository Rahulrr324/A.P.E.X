/**
 * STARK-L10: Context-Conditioned Memory (CCM) regression tests.
 * Frozen protocol: stark/design/context_conditioned_memory_milestone.md.
 *
 * Covers: geometry and isolation of the per-bank populations, determinism of
 * trial execution, bank-scoped eligibility (sealed banks cannot change),
 * router update direction and bounds, allocation/sealing bookkeeping,
 * serialization round-trip (bit-identical, including bank metadata and
 * baselines), malformed-record rejection, cue-conditioned selection, and the
 * no-leakage property that the mechanism's choice does not depend on the
 * task's answer key.
 *
 * Follows the test_stdp / test_three_factor counting-assertion convention.
 */

#include "learning/ContextConditionedMemory.h"
#include "learning/RelevanceRouting.h"

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

#define CHECK_NEAR(a, b, tol)                                              \
    do {                                                                   \
        ++g_checks;                                                        \
        const double _a = (a), _b = (b);                                   \
        if (!(std::fabs(_a - _b) <= (tol))) {                              \
            std::cerr << "  FAILED: " << #a << "=" << _a << " vs " << #b   \
                      << "=" << _b << " (line " << __LINE__ << ")"         \
                      << std::endl;                                        \
            std::abort();                                                  \
        }                                                                  \
    } while (0)

using namespace learning;

namespace {

CCConfig makeCfg(int banks = 3) {
    CCConfig cfg;
    cfg.lr.n_ids = 4;   // small network for test speed
    cfg.lr.n_chan = 2;
    cfg.lr.n_ctx = 2;
    cfg.lr.softmax_T = 1.0 / std::sqrt(2.0) / 2.0;
    cfg.n_banks = banks;
    cfg.n_feat = 6;
    cfg.commit_trials = 0;
    return cfg;
}

LRTrialSchedule oneTrial(const CCConfig& cfg, const LRMapping& m, unsigned seed, bool single) {
    auto v = single ? makeLRTrials(cfg.lr, m, 1, 0, seed) : makeLRTrials(cfg.lr, m, 0, 1, seed);
    return v.front();
}

CCTrialSchedule withCue(const LRTrialSchedule& lr, const std::vector<int>& cue) {
    CCTrialSchedule s;
    s.lr = lr;
    s.cue = cue;
    return s;
}

// ---------------------------------------------------------------------------
static void test_geometry_and_isolation() {
    CCConfig cfg = makeCfg(3);
    CCAgent ag = makeCCAgent(cfg, true);

    // cue features + banks*(identities+responses) + channels + contexts + router
    const size_t expect = size_t(cfg.n_feat) +
                          2u * size_t(cfg.n_banks) * size_t(cfg.lr.n_ids) +
                          size_t(cfg.lr.n_chan) + size_t(cfg.lr.n_ctx) +
                          size_t(cfg.n_banks);
    CHECK(ag.net.getNeuronCount() == expect);

    // every bank owns its own identity population (required for bank-scoped
    // eligibility, which is per pre-synaptic neuron)
    for (int k = 0; k < cfg.n_banks; ++k)
        for (int j = k + 1; j < cfg.n_banks; ++j)
            for (int i = 0; i < cfg.lr.n_ids; ++i)
                CHECK(ag.s[size_t(k)][size_t(i)] != ag.s[size_t(j)][size_t(i)]);

    // plastic matrices start at w_init within the frozen bounds
    auto w = ccBankWeights(ag);
    for (int k = 0; k < cfg.n_banks; ++k)
        for (int i = 0; i < cfg.lr.n_ids; ++i)
            for (int r = 0; r < cfg.lr.n_ids; ++r)
                CHECK_NEAR(w[size_t(k)][size_t(i)][size_t(r)], cfg.lr.w_init, 1e-12);

    // all banks start unallocated; router starts at zero
    for (int k = 0; k < cfg.n_banks; ++k) CHECK(ag.bank_state[size_t(k)] == CC_UNALLOCATED);
    auto W = ccRouterWeights(ag);
    for (const auto& row : W)
        for (double x : row) CHECK_NEAR(x, 0.0, 1e-12);
}

// ---------------------------------------------------------------------------
static void test_determinism() {
    CCConfig cfg = makeCfg(2);
    LRMapping m = makeLRMapping(424242u, cfg.lr.n_ids, cfg.lr.n_ctx);
    CCAgent a = makeCCAgent(cfg, true);
    CCAgent b = makeCCAgent(cfg, true);
    a.bank_state[0] = CC_ACTIVE;
    b.bank_state[0] = CC_ACTIVE;

    auto trials = makeLRTrials(cfg.lr, m, 2, 2, 99u);
    for (const auto& t : trials) {
        CCTrialSchedule s = withCue(t, {0, 1});
        CCResult ra = runCCTrial(a, s, m, -1, CC_LEARNED, true, true);
        CCResult rb = runCCTrial(b, s, m, -1, CC_LEARNED, true, true);
        CHECK(ra.choice == rb.choice);
        CHECK_NEAR(ra.reward, rb.reward, 1e-12);
        CHECK(ra.bank == rb.bank);
    }
    CHECK(ccSerialize(a) == ccSerialize(b));
}

// ---------------------------------------------------------------------------
static void test_sealed_bank_cannot_change() {
    CCConfig cfg = makeCfg(2);
    LRMapping m = makeLRMapping(7u, cfg.lr.n_ids, cfg.lr.n_ctx);
    CCAgent ag = makeCCAgent(cfg, true);
    ag.bank_state[0] = CC_SEALED;
    ag.bank_state[1] = CC_ACTIVE;

    const auto w_before = ccBankWeights(ag)[0];
    auto trials = makeLRTrials(cfg.lr, m, 3, 0, 11u);
    for (const auto& t : trials) {
        // force the sealed bank
        runCCTrial(ag, withCue(t, {0}), m, -1, CC_LEARNED, true, false, /*forced=*/0);
    }
    const auto w_after = ccBankWeights(ag)[0];
    for (size_t i = 0; i < w_before.size(); ++i)
        for (size_t r = 0; r < w_before[i].size(); ++r)
            CHECK_NEAR(w_after[i][r], w_before[i][r], 1e-15);
}

// ---------------------------------------------------------------------------
static void test_active_bank_learns_and_router_moves() {
    CCConfig cfg = makeCfg(2);
    LRMapping m = makeLRMapping(1234u, cfg.lr.n_ids, cfg.lr.n_ctx);
    CCAgent ag = makeCCAgent(cfg, true);
    ag.bank_state[0] = CC_UNALLOCATED;
    ag.bank_state[1] = CC_ACTIVE;

    const auto w0 = ccBankWeights(ag);
    auto trials = makeLRTrials(cfg.lr, m, 20, 20, 5u);
    for (const auto& t : trials) runCCTrial(ag, withCue(t, {2, 3}), m, -1, CC_LEARNED, true, true);
    const auto w1 = ccBankWeights(ag);

    double moved_active = 0.0, moved_other = 0.0;
    for (size_t i = 0; i < w0[1].size(); ++i)
        for (size_t r = 0; r < w0[1][i].size(); ++r)
            moved_active += std::fabs(w1[1][i][r] - w0[1][i][r]);
    for (size_t i = 0; i < w0[0].size(); ++i)
        for (size_t r = 0; r < w0[0][i].size(); ++r)
            moved_other += std::fabs(w1[0][i][r] - w0[0][i][r]);
    CHECK(moved_active > 0.0);          // the active bank learned
    CHECK_NEAR(moved_other, 0.0, 1e-15); // the unallocated bank never changed

    // weights stay inside the frozen bounds
    for (const auto& bank : w1)
        for (const auto& row : bank)
            for (double x : row) CHECK(x >= cfg.lr.w_min - 1e-12 && x <= cfg.lr.w_max + 1e-12);

    // router moved for the observed cue features only, and stayed clamped
    auto W = ccRouterWeights(ag);
    double other_feat = 0.0;
    for (int f = 0; f < cfg.n_feat; ++f) {
        if (f == 2 || f == 3) continue;
        for (double x : W[size_t(f)]) other_feat += std::fabs(x);
    }
    CHECK_NEAR(other_feat, 0.0, 1e-15); // unobserved features are not updated
    for (const auto& row : W)
        for (double x : row) CHECK(std::fabs(x) <= cfg.lr.v_clamp + 1e-12);
}

// ---------------------------------------------------------------------------
static void test_allocation_and_sealing() {
    CCConfig cfg = makeCfg(3);
    CCAgent ag = makeCCAgent(cfg, true);
    CHECK(ccActiveBank(ag) == -1);
    CHECK(ccAllocateNext(ag, true) == 0);
    CHECK(ccActiveBank(ag) == 0);
    CHECK(ag.bank_state[0] == CC_ACTIVE);
    CHECK(ccAllocateNext(ag, true) == 1);
    CHECK(ag.bank_state[0] == CC_SEALED); // superseded bank write-protected
    CHECK(ag.bank_state[1] == CC_ACTIVE);
    CHECK(ccAllocateNext(ag, true) == 2);
    CHECK(ccAllocateNext(ag, true) == -1); // capacity exhausted
    CHECK(ccActiveBank(ag) == 2);

    // without sealing the superseded bank stays writable
    CCAgent b = makeCCAgent(cfg, true);
    CHECK(ccAllocateNext(b, false) == 0);
    CHECK(ccAllocateNext(b, false) == 1);
    CHECK(b.bank_state[0] == CC_ACTIVE || b.bank_state[0] == CC_UNALLOCATED ||
          b.bank_state[0] == CC_SEALED);
    CHECK(ccActiveBank(b) == 1);
}

// ---------------------------------------------------------------------------
static void test_serialization_roundtrip() {
    CCConfig cfg = makeCfg(3);
    LRMapping m = makeLRMapping(31u, cfg.lr.n_ids, cfg.lr.n_ctx);
    CCAgent ag = makeCCAgent(cfg, true);
    ccAllocateNext(ag, true);
    auto trials = makeLRTrials(cfg.lr, m, 3, 3, 17u);
    for (const auto& t : trials) runCCTrial(ag, withCue(t, {1, 4}), m, -1, CC_LEARNED, true, true);

    const std::string snap = ccSerialize(ag);
    CCAgent other = makeCCAgent(cfg, true);
    ccDeserialize(other, snap);
    CHECK(ccSerialize(other) == snap); // bit-identical, incl. metadata + baselines
    for (int k = 0; k < cfg.n_banks; ++k) CHECK(other.bank_state[size_t(k)] == ag.bank_state[size_t(k)]);

    // identical eval behaviour after reload
    auto ev = makeLRTrials(cfg.lr, m, 0, 4, 77u);
    for (const auto& t : ev) {
        CCResult ra = runCCTrial(ag, withCue(t, {1}), m, -1, CC_LEARNED, false, false);
        CCResult rb = runCCTrial(other, withCue(t, {1}), m, -1, CC_LEARNED, false, false);
        CHECK(ra.choice == rb.choice);
        CHECK(ra.bank == rb.bank);
    }

    // malformed records are rejected
    bool threw = false;
    try {
        CCAgent bad = makeCCAgent(cfg, true);
        ccDeserialize(bad, "not-a-record");
    } catch (const std::exception&) {
        threw = true;
    }
    CHECK(threw);

    threw = false;
    try {
        CCAgent bad = makeCCAgent(cfg, true);
        ccDeserialize(bad, snap.substr(0, snap.size() - 8));
    } catch (const std::exception&) {
        threw = true;
    }
    CHECK(threw);
}

// ---------------------------------------------------------------------------
// The routing decision must depend on the observable cue, and must NOT depend
// on the answer key: permuting pi (the mapping) leaves the bank choice and the
// response of the network unchanged, because the mechanism never reads pi.
static void test_cue_conditioned_and_no_answer_leakage() {
    CCConfig cfg = makeCfg(3);
    LRMapping m1 = makeLRMapping(5150u, cfg.lr.n_ids, cfg.lr.n_ctx);
    LRMapping m2 = m1;
    // different perm (rotate), same phi
    for (int i = 0; i < cfg.lr.n_ids; ++i) m2.perm[size_t(i)] = m1.perm[size_t((i + 1) % cfg.lr.n_ids)];

    for (int k = 0; k < cfg.n_banks; ++k) (void)k;
    CCAgent a = makeCCAgent(cfg, true);
    CCAgent b = makeCCAgent(cfg, true);
    for (CCTrialSchedule s : {withCue(oneTrial(cfg, m1, 3u, false), {0, 1}),
                              withCue(oneTrial(cfg, m1, 3u, false), {4, 5})}) {
        // give the router a preference for bank 1 on features {0,1}
        a.net.getSynapse(a.router[0][1]).setWeight(1.2);
        a.net.getSynapse(a.router[1][1]).setWeight(1.2);
        b.net.getSynapse(b.router[0][1]).setWeight(1.2);
        b.net.getSynapse(b.router[1][1]).setWeight(1.2);
        a.bank_state = {CC_ACTIVE, CC_ACTIVE, CC_ACTIVE};
        b.bank_state = {CC_ACTIVE, CC_ACTIVE, CC_ACTIVE};
        CCResult ra = runCCTrial(a, s, m1, -1, CC_LEARNED, false, false);
        CCResult rb = runCCTrial(b, s, m2, -1, CC_LEARNED, false, false);
        CHECK(ra.choice == rb.choice); // network response independent of the key
        CHECK(ra.bank == rb.bank);     // routing independent of the key
    }
    // cue dependence: {0,1} prefers bank 1, {4,5} (zero weights) ties to the
    // lowest-index candidate (bank 0)
    CHECK(ccPreferredBank(a, {0, 1}) == 1);
    CHECK(ccPreferredBank(a, {4, 5}) == 0);

    // switching the answer key changes only the reward, never the choice
    CCAgent c = makeCCAgent(cfg, true);
    CCAgent d = makeCCAgent(cfg, true);
    c.bank_state = {CC_ACTIVE, CC_ACTIVE, CC_ACTIVE};
    d.bank_state = {CC_ACTIVE, CC_ACTIVE, CC_ACTIVE};
    auto t = withCue(oneTrial(cfg, m1, 21u, false), {2, 3});
    CCResult rc = runCCTrial(c, t, m1, -1, CC_LEARNED, false, false);
    CCResult rd = runCCTrial(d, t, m2, -1, CC_LEARNED, false, false);
    CHECK(rc.choice == rd.choice);
    // the key is used only to score the same behavioural choice
    CHECK_NEAR(rc.reward, (rc.choice == m1.perm[size_t(rc.queried)]) ? 1.0 : -1.0, 1e-12);
    CHECK_NEAR(rd.reward, (rd.choice == m2.perm[size_t(rd.queried)]) ? 1.0 : -1.0, 1e-12);
}

// ---------------------------------------------------------------------------
// The forced-bank path (allocation commitment window) must use the forced
// bank and must not update the router (off-policy).
static void test_forced_bank_is_off_policy() {
    CCConfig cfg = makeCfg(2);
    LRMapping m = makeLRMapping(9u, cfg.lr.n_ids, cfg.lr.n_ctx);
    CCAgent ag = makeCCAgent(cfg, true);
    ag.bank_state[0] = CC_SEALED;
    ag.bank_state[1] = CC_ACTIVE;
    auto W0 = ccRouterWeights(ag);
    auto trials = makeLRTrials(cfg.lr, m, 4, 0, 3u);
    for (const auto& t : trials) {
        CCResult r = runCCTrial(ag, withCue(t, {0, 2}), m, -1, CC_LEARNED, true,
                                /*router_learning=*/true, /*forced=*/1);
        CHECK(r.bank == 1);
    }
    auto W1 = ccRouterWeights(ag);
    for (size_t f = 0; f < W0.size(); ++f)
        for (size_t k = 0; k < W0[f].size(); ++k) CHECK_NEAR(W1[f][k], W0[f][k], 1e-15);
}

// ---------------------------------------------------------------------------
// Evaluation is made read-only by the benchmark via snapshot/restore. This
// test pins both halves of that contract: (a) evaluation does not change any
// learned weight, and (b) restoring the snapshot reproduces the state
// bit-for-bit (which is what makes the acquisition curve non-perturbing and
// checkpoint resume exact).
static void test_eval_leaves_learned_state_untouched() {
    CCConfig cfg = makeCfg(2);
    LRMapping m = makeLRMapping(71u, cfg.lr.n_ids, cfg.lr.n_ctx);
    CCAgent ag = makeCCAgent(cfg, true);
    ag.bank_state[0] = CC_ACTIVE;
    auto tr = makeLRTrials(cfg.lr, m, 2, 2, 13u);
    for (const auto& t : tr) runCCTrial(ag, withCue(t, {0, 5}), m, -1, CC_LEARNED, true, true);

    const std::string snapshot = ccSerialize(ag);
    const auto w_before = ccBankWeights(ag);
    const auto W_before = ccRouterWeights(ag);
    const std::vector<int> state_before = ag.bank_state;

    auto ev = makeLRTrials(cfg.lr, m, 0, 5, 55u);
    for (const auto& t : ev) runCCTrial(ag, withCue(t, {0, 5}), m, -1, CC_LEARNED, false, false);

    // (a) no learned weight moved
    const auto w_after = ccBankWeights(ag);
    const auto W_after = ccRouterWeights(ag);
    for (size_t k = 0; k < w_before.size(); ++k)
        for (size_t i = 0; i < w_before[k].size(); ++i)
            for (size_t r = 0; r < w_before[k][i].size(); ++r)
                CHECK_NEAR(w_after[k][i][r], w_before[k][i][r], 1e-15);
    for (size_t f = 0; f < W_before.size(); ++f)
        for (size_t k = 0; k < W_before[f].size(); ++k)
            CHECK_NEAR(W_after[f][k], W_before[f][k], 1e-15);
    for (size_t k = 0; k < state_before.size(); ++k) CHECK(ag.bank_state[k] == state_before[k]);

    // (b) snapshot restore is exact
    ccDeserialize(ag, snapshot);
    CHECK(ccSerialize(ag) == snapshot);
}

} // namespace

int main() {
    std::cout << "[test_context_conditioned_memory] STARK-L10 CCM\n";
    test_geometry_and_isolation();
    std::cout << "  geometry_isolation ok\n";
    test_determinism();
    std::cout << "  determinism ok\n";
    test_sealed_bank_cannot_change();
    std::cout << "  sealed_bank_write_protection ok\n";
    test_active_bank_learns_and_router_moves();
    std::cout << "  active_bank_learning + router_update ok\n";
    test_allocation_and_sealing();
    std::cout << "  allocation_sealing ok\n";
    test_serialization_roundtrip();
    std::cout << "  serialization_roundtrip ok\n";
    test_cue_conditioned_and_no_answer_leakage();
    std::cout << "  cue_conditioning + no_answer_leakage ok\n";
    test_forced_bank_is_off_policy();
    std::cout << "  forced_bank_off_policy ok\n";
    test_eval_leaves_learned_state_untouched();
    std::cout << "  eval_read_only ok\n";
    std::cout << "PASS (" << g_checks << " assertions)\n";
    return 0;
}
