/**
 * STARK-L6: learned-relevance experiment (schema STARK-L6-1).
 *
 * Frozen protocol: stark/design/learned_relevance_milestone.md v1.0.
 * Six arms on identical schedules/seeds: UNGATED, ORACLE, LEARNED, SHAM,
 * ABLATION, NEGATIVE. Metrics: evaluation + generalization accuracy,
 * per-identity accuracy, selection accuracy vs phi, FP/missed relevance,
 * intended/unintended update mass, learning curves, routing state,
 * save/reload (incl. routing weights), per-seed results. Criteria L6-A..F;
 * determinism (L6-G) and regression (L6-H) run out-of-band. Exit 0 iff
 * every evaluated criterion passes.
 */

#include "learning/RelevanceRouting.h"

#include <array>
#include <chrono>
#include <cmath>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

using namespace learning;

namespace {

const unsigned kSeeds[3] = {20261023u, 20261024u, 20261025u};
const int kArms = 6;

struct Wilson { double p, lo, hi; };
Wilson wilson(int k, int n) {
    Wilson w{0.0, 0.0, 0.0};
    if (n <= 0) return w;
    const double z = 1.959963984540054;
    const double ph = double(k) / n;
    const double z2 = z * z, nn = n;
    const double denom = 1.0 + z2 / nn;
    const double center = (ph + z2 / (2.0 * nn)) / denom;
    const double half = (z / denom) *
        std::sqrt(ph * (1.0 - ph) / nn + z2 / (4.0 * nn * nn));
    w.p = ph;
    w.lo = std::max(0.0, center - half);
    w.hi = std::min(1.0, center + half);
    return w;
}

struct RunOut {
    int n = 0, correct = 0;                    // evaluation
    int gn = 0, gcorrect = 0;                  // generalization
    std::vector<int> item_n, item_correct;     // evaluation, by queried identity
    int sel_ok = 0, sel_n = 0;                 // selection accuracy (eval)
    int fp = 0, miss = 0, mech_n = 0;          // relevance quality (eval)
    double mean_U = 0.0, mean_I = 0.0;
    double reward_first20 = 0.0, reward_last20 = 0.0;
    double v[2][2] = {{0, 0}, {0, 0}};
    double seconds = 0.0;
};

RunOut runOne(const LRConfig& cfg, const LRMapping& map, unsigned seed, int arm) {
    auto t0 = std::chrono::steady_clock::now();
    LRAgent ag = makeLRAgent(cfg, true);
    RunOut o;
    o.item_n.assign(static_cast<size_t>(cfg.n_ids), 0);
    o.item_correct.assign(static_cast<size_t>(cfg.n_ids), 0);

    // Training (distractors active): v1.1 mixture — 50% single-sample
    // mapping-credit trials, 50% two-sample selection trials.
    auto train = makeLRTrials(cfg, map, cfg.train_trials / (2 * cfg.n_ids),
                              cfg.train_trials / (2 * cfg.n_ids), seed);
    double sumU = 0.0, sumI = 0.0, sf = 0.0, sl = 0.0;
    for (size_t t = 0; t < train.size(); ++t) {
        auto w0 = lrWeights(ag);
        LRTrialResult r = runLRTrial(ag, cfg, train[t], map, arm, true);
        auto w1 = lrWeights(ag);
        double U = 0.0, I = 0.0;
        for (int i = 0; i < cfg.n_ids; ++i) {
            for (int rr = 0; rr < cfg.n_ids; ++rr) {
                double d = std::fabs(w1[static_cast<size_t>(i)][static_cast<size_t>(rr)] -
                                     w0[static_cast<size_t>(i)][static_cast<size_t>(rr)]);
                if (i == r.queried) I += d; else U += d;
            }
        }
        sumU += U;
        sumI += I;
        if (t < 20) sf += r.reward;
        if (t + 20 >= train.size()) sl += r.reward;
    }
    o.mean_U = sumU / double(train.size());
    o.mean_I = sumI / double(train.size());
    o.reward_first20 = sf / 20.0;
    o.reward_last20 = sl / 20.0;

    // Evaluation (learning disabled; distractors active; pure two-sample).
    auto ev = makeLRTrials(cfg, map, 0, cfg.eval_trials / cfg.n_ids, seed + 2);
    for (const auto& s : ev) {
        LRTrialResult r = runLRTrial(ag, cfg, s, map, arm, false);
        ++o.n;
        ++o.item_n[static_cast<size_t>(r.queried)];
        if (r.choice == map.perm[static_cast<size_t>(r.queried)]) {
            ++o.correct;
            ++o.item_correct[static_cast<size_t>(r.queried)];
        }
        if (r.sel_slot >= 0) {
            ++o.sel_n;
            if (r.sel_slot == r.queried_slot) ++o.sel_ok;
            if (r.fp_gate) ++o.fp;
            if (r.miss_gate) ++o.miss;
            ++o.mech_n;
        }
    }

    // Generalization: unseen pair/slot/context combinations (same pi, phi).
    auto gn = makeLRTrials(cfg, map, 0, cfg.eval_trials / cfg.n_ids, seed + 3);
    for (const auto& s : gn) {
        LRTrialResult r = runLRTrial(ag, cfg, s, map, arm, false);
        ++o.gn;
        if (r.choice == map.perm[static_cast<size_t>(r.queried)]) ++o.gcorrect;
    }

    for (int k = 0; k < 2; ++k)
        for (int s = 0; s < 2; ++s)
            o.v[k][s] = lrRouteState(ag, k, s);

    o.seconds = std::chrono::duration<double>(
        std::chrono::steady_clock::now() - t0).count();
    return o;
}

struct SaveReloadOut {
    bool weights_identical = false;
    bool serialize_roundtrip_identical = false;
    bool choices_identical = false;
    bool double_reload_identical = false;
    bool routing_identical = false;
    int n_queries = 0, n_choice_mismatch = 0;
};

SaveReloadOut checkSaveReload(const LRConfig& cfg, const LRMapping& map,
                              unsigned seed, const std::string& net_path) {
    SaveReloadOut o;
    LRAgent ag = makeLRAgent(cfg, true);
    auto train = makeLRTrials(cfg, map, cfg.train_trials / (2 * cfg.n_ids),
                              cfg.train_trials / (2 * cfg.n_ids), seed);
    for (const auto& s : train) runLRTrial(ag, cfg, s, map, LR_LEARNED, true);

    std::string s1 = ag.net.serialize();
    ag.net.save(net_path);
    auto w1 = lrWeights(ag);
    double v1[2][2];
    for (int k = 0; k < 2; ++k)
        for (int s = 0; s < 2; ++s) v1[k][s] = lrRouteState(ag, k, s);

    LRAgent ag2 = makeLRAgent(cfg, true);
    ag2.net.load(net_path);
    o.serialize_roundtrip_identical = (s1 == ag2.net.serialize());
    o.weights_identical = (w1 == lrWeights(ag2));
    o.routing_identical = true;
    for (int k = 0; k < 2; ++k)
        for (int s = 0; s < 2; ++s)
            if (lrRouteState(ag2, k, s) != v1[k][s]) o.routing_identical = false;

    LRAgent ag3 = makeLRAgent(cfg, true);
    ag3.net.load(net_path);
    o.double_reload_identical = (s1 == ag3.net.serialize());

    auto ev = makeLRTrials(cfg, map, 0, cfg.eval_trials / cfg.n_ids, seed + 2);
    o.choices_identical = true;
    bool d3 = o.double_reload_identical;
    for (const auto& s : ev) {
        LRTrialResult r1 = runLRTrial(ag, cfg, s, map, LR_LEARNED, false);
        LRTrialResult r2 = runLRTrial(ag2, cfg, s, map, LR_LEARNED, false);
        LRTrialResult r3 = runLRTrial(ag3, cfg, s, map, LR_LEARNED, false);
        ++o.n_queries;
        if (r1.choice != r2.choice) {
            ++o.n_choice_mismatch;
            o.choices_identical = false;
        }
        if (r2.choice != r3.choice) d3 = false;
    }
    o.double_reload_identical = o.double_reload_identical && o.choices_identical &&
                                o.routing_identical && d3;
    return o;
}

void jsonRun(std::ostream& os, const RunOut& o) {
    Wilson w = wilson(o.correct, o.n);
    Wilson wg = wilson(o.gcorrect, o.gn);
    os << "{\"acc\":" << (o.n ? double(o.correct) / o.n : 0.0)
       << ",\"ci95\":[" << w.lo << "," << w.hi << "],\"n\":" << o.n
       << ",\"gen_acc\":" << (o.gn ? double(o.gcorrect) / o.gn : 0.0)
       << ",\"gen_ci95\":[" << wg.lo << "," << wg.hi << "]"
       << ",\"sel_acc\":" << (o.sel_n ? double(o.sel_ok) / o.sel_n : -1.0)
       << ",\"fp\":" << (o.mech_n ? double(o.fp) / o.mech_n : -1.0)
       << ",\"miss\":" << (o.mech_n ? double(o.miss) / o.mech_n : -1.0)
       << ",\"mean_U\":" << o.mean_U << ",\"mean_I\":" << o.mean_I
       << ",\"reward_first20\":" << o.reward_first20
       << ",\"reward_last20\":" << o.reward_last20
       << ",\"v\":[[" << o.v[0][0] << "," << o.v[0][1] << "],["
       << o.v[1][0] << "," << o.v[1][1] << "]]"
       << ",\"item_correct\":[";
    for (size_t i = 0; i < o.item_correct.size(); ++i) {
        if (i) os << ",";
        os << o.item_correct[i];
    }
    os << "],\"item_n\":[";
    for (size_t i = 0; i < o.item_n.size(); ++i) {
        if (i) os << ",";
        os << o.item_n[i];
    }
    os << "]}";
}

} // namespace

int main(int argc, char** argv) {
    std::string out_path;
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--out" && i + 1 < argc) out_path = argv[++i];
    }
    if (out_path.empty()) {
        std::cerr << "usage: learned_relevance_loop --out <report.json>\n";
        return 2;
    }

    LRConfig cfg;
    cfg.train_trials = 480; // 240 single + 240 two-sample (design v1.1)
    std::map<int, LRMapping> maps;
    std::vector<std::array<RunOut, kArms>> per_seed;
    std::array<SaveReloadOut, 3> sr_out;

    for (int si = 0; si < 3; ++si) {
        const unsigned seed = kSeeds[si];
        maps[si] = makeLRMapping(seed, cfg.n_ids);
        std::array<RunOut, kArms> runs;
        for (int m = 0; m < kArms; ++m) runs[m] = runOne(cfg, maps[si], seed, m);
        per_seed.push_back(runs);
        sr_out[si] = checkSaveReload(cfg, maps[si], seed,
                                     out_path + ".net.s" + std::to_string(si));
    }

    // ---- Pooled ----
    struct Pool {
        int n = 0, correct = 0, gn = 0, gcorrect = 0;
        std::vector<int> item_n, item_correct;
        int sel_ok = 0, sel_n = 0, fp = 0, miss = 0, mech_n = 0;
        double sumU = 0.0, sumI = 0.0;
        int trials = 0;
    };
    std::array<Pool, kArms> pool;
    for (int si = 0; si < 3; ++si) {
        for (int m = 0; m < kArms; ++m) {
            const RunOut& o = per_seed[si][m];
            Pool& p = pool[m];
            if (p.item_n.empty()) {
                p.item_n.assign(static_cast<size_t>(cfg.n_ids), 0);
                p.item_correct.assign(static_cast<size_t>(cfg.n_ids), 0);
            }
            p.n += o.n; p.correct += o.correct;
            p.gn += o.gn; p.gcorrect += o.gcorrect;
            for (int i = 0; i < cfg.n_ids; ++i) {
                p.item_n[static_cast<size_t>(i)] += o.item_n[static_cast<size_t>(i)];
                p.item_correct[static_cast<size_t>(i)] += o.item_correct[static_cast<size_t>(i)];
            }
            p.sel_ok += o.sel_ok; p.sel_n += o.sel_n;
            p.fp += o.fp; p.miss += o.miss; p.mech_n += o.mech_n;
            p.sumU += o.mean_U * cfg.train_trials;
            p.sumI += o.mean_I * cfg.train_trials;
            p.trials += cfg.train_trials;
        }
    }
    auto pAcc = [&](int m) { return pool[m].n ? double(pool[m].correct) / pool[m].n : 0.0; };
    auto gAcc = [&](int m) { return pool[m].gn ? double(pool[m].gcorrect) / pool[m].gn : 0.0; };
    auto pU = [&](int m) { return pool[m].trials ? pool[m].sumU / pool[m].trials : 0.0; };
    auto pI = [&](int m) { return pool[m].trials ? pool[m].sumI / pool[m].trials : 0.0; };

    // ---- Criteria (frozen, design §5) ----
    struct Crit { std::string id, detail; bool pass; };
    std::vector<Crit> crits;
    {
        double L = pAcc(LR_LEARNED), U = pAcc(LR_UNGATED), G = gAcc(LR_LEARNED);
        double mn = 2.0;
        int arg = -1;
        for (int i = 0; i < cfg.n_ids; ++i) {
            if (pool[LR_LEARNED].item_n[static_cast<size_t>(i)] == 0) continue;
            double a = double(pool[LR_LEARNED].item_correct[static_cast<size_t>(i)]) /
                       pool[LR_LEARNED].item_n[static_cast<size_t>(i)];
            if (a < mn) { mn = a; arg = i; }
        }
        bool ok = L >= 0.70 && L >= U + 0.20 && mn >= 0.50 && G >= 0.60;
        std::ostringstream d;
        d << "learned=" << L << " ungated=" << U << " min_item=" << mn
          << " (id " << arg << ") gen=" << G;
        crits.push_back({"L6-A", d.str(), ok});
    }
    {
        double L = pAcc(LR_LEARNED), O = pAcc(LR_ORACLE);
        bool ok = L >= O - 0.15;
        std::ostringstream d;
        d << "learned=" << L << " oracle=" << O << " gap=" << (O - L);
        crits.push_back({"L6-B", d.str(), ok});
    }
    {
        double fp = pool[LR_LEARNED].mech_n ? double(pool[LR_LEARNED].fp) / pool[LR_LEARNED].mech_n : 1.0;
        double ms = pool[LR_LEARNED].mech_n ? double(pool[LR_LEARNED].miss) / pool[LR_LEARNED].mech_n : 1.0;
        double sel = pool[LR_LEARNED].sel_n ? double(pool[LR_LEARNED].sel_ok) / pool[LR_LEARNED].sel_n : 0.0;
        bool ok = fp <= 0.30 && ms <= 0.20;
        std::ostringstream d;
        d << "fp=" << fp << " miss=" << ms << " sel_acc=" << sel;
        crits.push_back({"L6-C", d.str(), ok});
    }
    {
        double S = pAcc(LR_SHAM), A = pAcc(LR_ABLATION), N = pAcc(LR_NEGATIVE), L = pAcc(LR_LEARNED);
        bool ok = S <= 0.55 && A <= 0.60 && A <= L - 0.15 && N <= 0.40;
        std::ostringstream d;
        d << "sham=" << S << " ablation=" << A << " negative=" << N << " learned=" << L;
        crits.push_back({"L6-D", d.str(), ok});
    }
    {
        double Ul = pU(LR_LEARNED), Uu = pU(LR_UNGATED), Il = pI(LR_LEARNED), Io = pI(LR_ORACLE);
        bool ok = Ul <= 0.35 * Uu && (Io > 0 ? Il >= 0.4 * Io : Il > 0);
        std::ostringstream d;
        d << "U_learned=" << Ul << " U_ungated=" << Uu << " I_learned=" << Il
          << " I_oracle=" << Io;
        crits.push_back({"L6-E", d.str(), ok});
    }
    {
        bool ok = true;
        int mism = 0, nq = 0;
        for (int si = 0; si < 3; ++si) {
            const SaveReloadOut& o = sr_out[si];
            ok = ok && o.weights_identical && o.serialize_roundtrip_identical &&
                 o.choices_identical && o.routing_identical && o.double_reload_identical;
            mism += o.n_choice_mismatch;
            nq += o.n_queries;
        }
        std::ostringstream d;
        d << "seeds_ok=" << (ok ? 3 : 0) << " choice_mismatches=" << mism << "/" << nq;
        crits.push_back({"L6-F", d.str(), ok});
    }

    bool all = true;
    for (const Crit& c : crits) all = all && c.pass;

    // ---- Report (schema STARK-L6-1) ----
    std::ostringstream js;
    js.setf(std::ios::fixed);
    js.precision(6);
    js << "{\n  \"schema\": \"STARK-L6-1\",\n  \"design\": \"stark/design/learned_relevance_milestone.md v1.0\",\n";
    js << "  \"config\": {\"train_trials\":" << cfg.train_trials
       << ",\"eval_trials\":" << cfg.eval_trials
       << ",\"seeds\":[" << kSeeds[0] << "," << kSeeds[1] << "," << kSeeds[2]
       << "],\"beta_route\":0.3,\"softmax_T\":1.0,\"w_init\":0.35,\"w_max\":0.7},\n";

    js << "  \"mappings\": [\n";
    for (int si = 0; si < 3; ++si) {
        const LRMapping& m = maps[si];
        js << "    {\"master\":" << kSeeds[si] << ",\"perm\":[";
        for (size_t i = 0; i < m.perm.size(); ++i) {
            if (i) js << ",";
            js << m.perm[i];
        }
        js << "],\"phi\":[" << m.phi[0] << "," << m.phi[1] << "]}"
           << (si < 2 ? "," : "") << "\n";
    }
    js << "  ],\n  \"seeds\": [\n";
    for (int si = 0; si < 3; ++si) {
        js << "    {\"master\":" << kSeeds[si];
        for (int m = 0; m < kArms; ++m) {
            static const char* names[kArms] =
                {"ungated","oracle","learned","sham","ablation","negative"};
            js << ", \"" << names[m] << "\": ";
            jsonRun(js, per_seed[si][m]);
        }
        js << ", \"save_reload\": {\"weights_identical\": "
           << (sr_out[si].weights_identical ? "true" : "false")
           << ", \"routing_identical\": "
           << (sr_out[si].routing_identical ? "true" : "false")
           << ", \"serialize_roundtrip_identical\": "
           << (sr_out[si].serialize_roundtrip_identical ? "true" : "false")
           << ", \"choices_identical\": "
           << (sr_out[si].choices_identical ? "true" : "false")
           << ", \"double_reload_identical\": "
           << (sr_out[si].double_reload_identical ? "true" : "false")
           << ", \"n_queries\": " << sr_out[si].n_queries
           << ", \"n_choice_mismatch\": " << sr_out[si].n_choice_mismatch << "}";
        js << "}" << (si < 2 ? "," : "") << "\n";
    }
    js << "  ],\n  \"pooled\": {";
    for (int m = 0; m < kArms; ++m) {
        static const char* names[kArms] =
            {"ungated","oracle","learned","sham","ablation","negative"};
        Wilson w = wilson(pool[m].correct, pool[m].n);
        js << (m ? ", " : "") << "\"" << names[m] << "\": {\"acc\": " << pAcc(m)
           << ", \"ci95\": [" << w.lo << "," << w.hi << "]"
           << ", \"gen_acc\": " << gAcc(m)
           << ", \"sel_acc\": " << (pool[m].sel_n ? double(pool[m].sel_ok) / pool[m].sel_n : -1.0)
           << ", \"fp\": " << (pool[m].mech_n ? double(pool[m].fp) / pool[m].mech_n : -1.0)
           << ", \"miss\": " << (pool[m].mech_n ? double(pool[m].miss) / pool[m].mech_n : -1.0)
           << ", \"mean_U\": " << pU(m) << ", \"mean_I\": " << pI(m)
           << ", \"min_item_acc\": " << [&] {
                    double mn = 2.0;
                    for (int i = 0; i < cfg.n_ids; ++i) {
                        if (pool[m].item_n[static_cast<size_t>(i)] == 0) continue;
                        double a = double(pool[m].item_correct[static_cast<size_t>(i)]) /
                                   pool[m].item_n[static_cast<size_t>(i)];
                        if (a < mn) mn = a;
                    }
                    return mn < 2.0 ? mn : -1.0;
                }() << "}";
    }
    js << "},\n  \"criteria\": {\n";
    for (size_t i = 0; i < crits.size(); ++i) {
        js << "    \"" << crits[i].id << "\": {\"detail\": \"" << crits[i].detail
           << "\", \"pass\": " << (crits[i].pass ? "true" : "false") << "}"
           << (i + 1 < crits.size() ? "," : "") << "\n";
    }
    js << "  },\n  \"verdict\": \"" << (all ? "PASS" : "FAIL") << "\"\n}\n";

    {
        std::ofstream f(out_path);
        if (!f) {
            std::cerr << "cannot write " << out_path << "\n";
            return 2;
        }
        f << js.str();
    }

    std::cout << "STARK-L6 learned-relevance experiment\n";
    for (const Crit& c : crits) {
        std::cout << "  " << c.id << ": " << (c.pass ? "PASS" : "FAIL")
                  << "  " << c.detail << "\n";
    }
    std::cout << "report: " << out_path << "\nverdict: " << (all ? "PASS" : "FAIL") << "\n";
    return all ? 0 : 1;
}
