/**
 * STARK-L10 validation: structural audit of the CCM agent.
 *
 * Independent of the L10 design document, this test interrogates the built
 * `CCAgent` and asserts the structural properties the milestone's claims
 * depend on:
 *
 *  1. no synapse crosses between two memory banks (banks share no plastic
 *     resource, no WTA path, no self-excitation path);
 *  2. the S->A plastic matrix of bank k touches only bank k's own neurons;
 *  3. everything that IS shared is enumerable and is only the declared
 *     inter-bank machinery (cue features -> router readouts, context neurons
 *     -> channel markers);
 *  4. the reward baselines and the router are per-bank / per-feature sized,
 *     so no bank can read another bank's baseline;
 *  5. serialization round-trips the entire agent including bank metadata and
 *     baselines (so a checkpoint cannot silently drop lifecycle state).
 *
 * The audit uses only the public Network accessors, so it does not depend on
 * CCM implementation details beyond the published agent layout.
 */

#include "learning/ContextConditionedMemory.h"

#include <iostream>
#include <map>
#include <set>
#include <string>
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

struct Placement {
    // neuron id -> role string
    std::vector<std::string> role;
};

Placement place(const CCAgent& ag) {
    Placement p;
    p.role.assign(ag.net.getNeuronCount(), "other");
    for (size_t f = 0; f < ag.cue.size(); ++f) p.role[ag.cue[f]] = "cue" + std::to_string(f);
    for (size_t k = 0; k < ag.s.size(); ++k) {
        for (size_t i = 0; i < ag.s[k].size(); ++i) p.role[ag.s[k][i]] = "S" + std::to_string(k);
        for (size_t r = 0; r < ag.a[k].size(); ++r) p.role[ag.a[k][r]] = "A" + std::to_string(k);
        p.role[ag.rr[k]] = "R" + std::to_string(k);
    }
    for (size_t c = 0; c < ag.l.size(); ++c) p.role[ag.l[c]] = "L" + std::to_string(c);
    for (size_t c = 0; c < ag.c.size(); ++c) p.role[ag.c[c]] = "C" + std::to_string(c);
    return p;
}

int bankOf(const std::string& role) {
    if (role.size() < 2) return -1;
    if (role[0] == 'S' || role[0] == 'A' || role[0] == 'R') return std::stoi(role.substr(1));
    return -1;
}

} // namespace

int main() {
    std::cout << "[test_l10_structural_audit] CCM bank isolation audit\n";

    CCConfig cfg;
    cfg.lr.n_ids = 6;
    cfg.lr.n_chan = 2;
    cfg.lr.n_ctx = 2;
    cfg.n_banks = 3;
    cfg.n_feat = 12;
    CCAgent ag = makeCCAgent(cfg, true);
    Placement p = place(ag);

    // ---- 1/3. enumerate every synapse and classify it ----
    std::map<std::string, int> classes;
    int crossing = 0;
    for (size_t id = 0; id < ag.net.getSynapseCount(); ++id) {
        const size_t pre = ag.net.getPreNeuron(id);
        const size_t post = ag.net.getPostNeuron(id);
        const std::string rp = p.role[pre], rq = p.role[post];
        const int bp = bankOf(rp), bq = bankOf(rq);
        if (bp >= 0 && bq >= 0 && bp != bq) {
            ++crossing;
            std::cerr << "  CROSS-BANK SYNAPSE: " << rp << " -> " << rq << "\n";
        }
        classes[rp.substr(0, 1) + "->" + rq.substr(0, 1)]++;
    }
    CHECK(crossing == 0);

    // ---- 2. the plastic matrix exists once per bank and is intra-bank ----
    int plastic_syn = 0;
    for (size_t k = 0; k < ag.syn.size(); ++k)
        for (size_t i = 0; i < ag.syn[k].size(); ++i)
            for (size_t r = 0; r < ag.syn[k][i].size(); ++r) {
                const size_t sid = ag.syn[k][i][r];
                CHECK(ag.net.getPreNeuron(sid) == ag.s[k][i]);
                CHECK(ag.net.getPostNeuron(sid) == ag.a[k][r]);
                const Synapse& sy = ag.net.getSynapse(sid);
                CHECK(sy.getThreeFactorEnabled());
                ++plastic_syn;
            }
    CHECK(plastic_syn == cfg.n_banks * cfg.lr.n_ids * cfg.lr.n_ids);

    // ---- 3. the shared pathways are exactly the declared ones ----
    // cue -> router readout, and context -> channel markers.
    CHECK(classes["c->R"] == cfg.n_feat * cfg.n_banks);
    CHECK(classes["C->L"] == cfg.lr.n_ctx * cfg.lr.n_chan);
    // S->A only; A->A only (WTA + self); nothing else leaves a bank.
    CHECK(classes["S->A"] == cfg.n_banks * cfg.lr.n_ids * cfg.lr.n_ids);
    CHECK(classes["A->A"] == cfg.n_banks * (cfg.lr.n_ids * (cfg.lr.n_ids - 1) + cfg.lr.n_ids));
    // no bank neuron projects to a cue, router readout, channel or context cell
    CHECK(classes.count("S->c") == 0);
    CHECK(classes.count("A->c") == 0);
    CHECK(classes.count("S->R") == 0);
    CHECK(classes.count("A->R") == 0);
    CHECK(classes.count("S->L") == 0);
    CHECK(classes.count("A->L") == 0);
    CHECK(classes.count("S->C") == 0);
    CHECK(classes.count("A->C") == 0);

    // ---- 4. router / baseline shapes are per-bank ----
    CHECK(static_cast<int>(ag.router.size()) == cfg.n_feat);
    for (const auto& row : ag.router) CHECK(static_cast<int>(row.size()) == cfg.n_banks);
    CHECK(static_cast<int>(ag.reward_baseline.size()) == cfg.n_banks);
    CHECK(static_cast<int>(ag.bank_state.size()) == cfg.n_banks);

    // ---- 5. serialization preserves lifecycle + baselines ----
    ag.bank_state = {CC_SEALED, CC_ACTIVE, CC_UNALLOCATED};
    ag.reward_baseline = {-0.25, 0.5, 0.125};
    const std::string snap = ccSerialize(ag);
    CCAgent b = makeCCAgent(cfg, true);
    ccDeserialize(b, snap);
    CHECK(b.bank_state == ag.bank_state);
    CHECK(b.reward_baseline == ag.reward_baseline);
    CHECK(ccSerialize(b) == snap);

    // a truncated record must be rejected, not silently accepted
    bool threw = false;
    try {
        CCAgent c = makeCCAgent(cfg, true);
        ccDeserialize(c, snap.substr(0, snap.size() / 2));
    } catch (const std::exception&) {
        threw = true;
    }
    CHECK(threw);

    std::cout << "PASS (" << g_checks << " assertions)\n"
              << "  synapse classes: ";
    for (const auto& kv : classes) std::cout << kv.first << "=" << kv.second << " ";
    std::cout << "\n";
    return 0;
}
