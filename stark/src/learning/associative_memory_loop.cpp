/**
 * STARK-L4: multi-item associative-memory experiment (schema STARK-L4-1).
 *
 * Frozen protocol: stark/design/associative_memory_milestone.md v1.0.
 * Loads N in {2,4,6,8} x seeds {20261023..25} x {trained, sham, baseline};
 * amnesic (memory-ablation) at N=4,8; heavy interference at N=8; save/reload
 * at N=8. Criteria L4-A..G verdicts. Exit 0 iff every criterion passes.
 * Determinism (L4-H) and regression (L4-I) run out-of-band.
 */

#include "learning/AssociativeMemoryTask.h"

#include <array>
#include <cmath>
#include <fstream>
#include <iostream>
#include <map>
#include <set>
#include <sstream>
#include <string>
#include <vector>

using namespace learning;

namespace {

const int kLoads[4] = {2, 4, 6, 8};
const unsigned kSeeds[3] = {20261023u, 20261024u, 20261025u};
const int kModes = 4; // trained, sham, baseline, amnesic

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
    int n = 0, correct = 0;
    std::vector<int> item_n, item_correct;   // by cue id
    std::vector<int> choice_hist;            // by response id
    double hijack = 0.0, keep = 0.0;
    double reward_first20 = 0.0, reward_last20 = 0.0;
    double val_acc = -1.0;
    std::vector<std::vector<double>> w_final;
};

RunOut runOne(const AMConfig& cfg, const AMMapping& map, int N, unsigned seed,
              int mode, bool want_val, bool want_heavy, bool* heavy_acc_ok,
              double* heavy_acc) {
    AMConfig c = cfg;
    if (mode == 1) c.reward_contingent = false;

    AMAgent ag = makeAMAgent(c, mode != 2);
    RunOut o;
    o.item_n.assign(static_cast<size_t>(cfg.n_cues), 0);
    o.item_correct.assign(static_cast<size_t>(cfg.n_cues), 0);
    o.choice_hist.assign(static_cast<size_t>(cfg.n_resp), 0);

    if (mode != 2) {
        // v1.1: training trials use a silent interference window (eligibility
        // confined to the queried item; see design §1/§2 v1.1 changelog).
        AMConfig ct = c;
        ct.p_none = 1.0;
        auto train = makeAMTrials(ct, map, N, c.train_per_item, seed, false);
        double sf = 0.0, sl = 0.0, hi = 0.0, kp = 0.0;
        for (size_t t = 0; t < train.size(); ++t) {
            AMTrialResult r = runAMTrial(ag, c, train[t], map, true);
            if (t < 20) sf += r.reward;
            if (t + 20 >= train.size()) sl += r.reward;
            hi += r.spikes_other_interf;
            kp += r.spikes_correct_interf;
        }
        o.reward_first20 = sf / 20.0;
        o.reward_last20 = sl / 20.0;
        o.hijack = hi / double(train.size());
        o.keep = kp / double(train.size());
        if (mode == 3) amWipeWeights(ag, c);
    }

    // Evaluation (learning disabled): headline metrics.
    auto ev = makeAMTrials(c, map, N, c.queries_per_item, seed + 2, false);
    for (const auto& s : ev) {
        AMTrialResult r = runAMTrial(ag, c, s, map, false);
        ++o.n;
        ++o.item_n[static_cast<size_t>(r.cue)];
        ++o.choice_hist[static_cast<size_t>(r.choice)];
        if (r.choice == map.perm[static_cast<size_t>(r.cue)]) {
            ++o.correct;
            ++o.item_correct[static_cast<size_t>(r.cue)];
        }
    }

    if (want_val) {
        auto va = makeAMTrials(c, map, N, c.queries_per_item, seed + 1, false);
        int vc = 0;
        for (const auto& s : va) {
            AMTrialResult r = runAMTrial(ag, c, s, map, false);
            if (r.choice == map.perm[static_cast<size_t>(r.cue)]) ++vc;
        }
        o.val_acc = double(vc) / va.size();
    }

    if (want_heavy) {
        auto hv = makeAMTrials(c, map, N, c.queries_per_item, seed + 3, true);
        int hc = 0;
        for (const auto& s : hv) {
            AMTrialResult r = runAMTrial(ag, c, s, map, false);
            if (r.choice == map.perm[static_cast<size_t>(r.cue)]) ++hc;
        }
        if (heavy_acc) *heavy_acc = double(hc) / hv.size();
        if (heavy_acc_ok) *heavy_acc_ok = true;
    }

    o.w_final = amWeights(ag);
    return o;
}

struct SaveReloadOut {
    bool weights_identical = false;
    bool serialize_roundtrip_identical = false;
    bool choices_identical = false;
    bool double_reload_identical = false;
    int n_queries = 0, n_choice_mismatch = 0;
};

SaveReloadOut checkSaveReload(const AMConfig& cfg, const AMMapping& map, int N,
                              unsigned seed, const std::string& net_path) {
    SaveReloadOut o;
    AMAgent ag = makeAMAgent(cfg, true);
    AMConfig ct = cfg;
    ct.p_none = 1.0;
    auto train = makeAMTrials(ct, map, N, cfg.train_per_item, seed, false);
    for (const auto& s : train) runAMTrial(ag, cfg, s, map, true);

    std::string s1 = ag.net.serialize();
    ag.net.save(net_path);
    std::vector<std::vector<double>> w1 = amWeights(ag);

    AMAgent ag2 = makeAMAgent(cfg, true);
    ag2.net.load(net_path);
    std::string s2 = ag2.net.serialize();
    o.serialize_roundtrip_identical = (s1 == s2);
    std::vector<std::vector<double>> w2 = amWeights(ag2);
    o.weights_identical = (w1 == w2); // exact double equality

    AMAgent ag3 = makeAMAgent(cfg, true);
    ag3.net.load(net_path);
    std::string s3 = ag3.net.serialize();
    o.double_reload_identical = (s2 == s3);

    auto ev = makeAMTrials(cfg, map, N, cfg.queries_per_item, seed + 2, false);
    o.choices_identical = true;
    o.double_reload_identical = o.double_reload_identical;
    bool d3 = true;
    for (const auto& s : ev) {
        AMTrialResult r1 = runAMTrial(ag, cfg, s, map, false);
        AMTrialResult r2 = runAMTrial(ag2, cfg, s, map, false);
        AMTrialResult r3 = runAMTrial(ag3, cfg, s, map, false);
        ++o.n_queries;
        if (r1.choice != r2.choice) {
            ++o.n_choice_mismatch;
            o.choices_identical = false;
        }
        if (r2.choice != r3.choice) d3 = false;
    }
    o.double_reload_identical = o.serialize_roundtrip_identical && o.choices_identical && d3;
    return o;
}

void jsonRun(std::ostream& os, const RunOut& o) {
    Wilson w = wilson(o.correct, o.n);
    os << "{\"n\":" << o.n << ",\"acc\":" << (o.n ? double(o.correct) / o.n : 0.0)
       << ",\"ci95\":[" << w.lo << "," << w.hi << "],\"val_acc\":" << o.val_acc
       << ",\"reward_first20\":" << o.reward_first20
       << ",\"reward_last20\":" << o.reward_last20
       << ",\"hijack\":" << o.hijack << ",\"keep\":" << o.keep
       << ",\"choice_hist\":[";
    for (size_t r = 0; r < o.choice_hist.size(); ++r) {
        if (r) os << ",";
        os << o.choice_hist[r];
    }
    os << "],\"item_correct\":[";
    for (size_t i = 0; i < o.item_correct.size(); ++i) {
        if (i) os << ",";
        os << o.item_correct[i];
    }
    os << "],\"item_n\":[";
    for (size_t i = 0; i < o.item_n.size(); ++i) {
        if (i) os << ",";
        os << o.item_n[i];
    }
    os << "],\"weights\":[";
    for (size_t i = 0; i < o.w_final.size(); ++i) {
        if (i) os << ",";
        os << "[";
        for (size_t r = 0; r < o.w_final[i].size(); ++r) {
            if (r) os << ",";
            os << o.w_final[i][r];
        }
        os << "]";
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
        std::cerr << "usage: associative_memory_loop --out <report.json>\n";
        return 2;
    }

    AMConfig cfg;
    std::map<int, std::array<SaveReloadOut, 3>> sr_out;
    std::map<int, std::vector<std::array<RunOut, kModes>>> per_seed; // by load
    std::map<int, std::array<double, 3>> heavy;                      // by load (only 8)
    std::map<int, std::vector<AMMapping>> maps;

    for (int li = 0; li < 4; ++li) {
        const int N = kLoads[li];
        for (int si = 0; si < 3; ++si) {
            const unsigned seed = kSeeds[si];
            AMMapping map = makeMapping(seed, cfg.n_cues);
            maps[N].push_back(map);
            std::array<RunOut, kModes> runs;
            for (int m = 0; m < kModes; ++m) {
                const bool wv = (m == 0);
                const bool wh = (N == 8 && m == 0);
                bool ok = false;
                double ha = -1.0;
                runs[m] = runOne(cfg, map, N, seed, m, wv, wh, &ok, &ha);
                if (wh) heavy[N][si] = ha;
            }
            per_seed[N].push_back(runs);
            if (N == 8) {
                sr_out[N][si] = checkSaveReload(
                    cfg, map, N, seed,
                    out_path + ".net.s" + std::to_string(si));
            }
        }
    }

    // ---- Pooled metrics ----
    struct Pool {
        int n = 0, correct = 0;
        std::vector<int> item_n, item_correct;
        int max_choice = 0;
    };
    std::map<int, std::array<Pool, kModes>> pool;
    std::map<int, double> heavy_pool_acc;
    std::map<int, int> heavy_pool_n, heavy_pool_c;
    for (int li = 0; li < 4; ++li) {
        const int N = kLoads[li];
        for (int si = 0; si < 3; ++si) {
            for (int m = 0; m < kModes; ++m) {
                const RunOut& o = per_seed[N][si][m];
                Pool& p = pool[N][m];
                if (p.item_n.empty()) {
                    p.item_n.assign(static_cast<size_t>(cfg.n_cues), 0);
                    p.item_correct.assign(static_cast<size_t>(cfg.n_cues), 0);
                }
                p.n += o.n;
                p.correct += o.correct;
                for (int i = 0; i < cfg.n_cues; ++i) {
                    p.item_n[static_cast<size_t>(i)] += o.item_n[static_cast<size_t>(i)];
                    p.item_correct[static_cast<size_t>(i)] += o.item_correct[static_cast<size_t>(i)];
                }
            }
            if (N == 8) {
                heavy_pool_n[0] += cfg.queries_per_item * N;
                heavy_pool_c[0] += int(std::round(heavy[N][si] * cfg.queries_per_item * N));
            }
        }
    }
    auto pooledAcc = [&](int N, int m) {
        const Pool& p = pool[N][m];
        return p.n ? double(p.correct) / p.n : 0.0;
    };
    double heavy8 = heavy_pool_n[0] ? double(heavy_pool_c[0]) / heavy_pool_n[0] : 0.0;

    // ---- Criteria (frozen, design §6) ----
    struct Crit { std::string id, detail; bool pass; };
    std::vector<Crit> crits;
    {
        double acc = pooledAcc(4, 0), base = pooledAcc(4, 2);
        bool ok = acc >= 0.70 && acc >= base + 0.25;
        std::ostringstream d;
        d << "acc4=" << acc << " base4=" << base;
        crits.push_back({"L4-A", d.str(), ok});
    }
    {
        double mn = 2.0;
        int arg = -1;
        for (int i = 0; i < cfg.n_cues; ++i) {
            const Pool& p = pool[4][0];
            if (p.item_n[static_cast<size_t>(i)] == 0) continue;
            double a = double(p.item_correct[static_cast<size_t>(i)]) /
                       p.item_n[static_cast<size_t>(i)];
            if (a < mn) { mn = a; arg = i; }
        }
        bool ok = mn >= 0.55;
        std::ostringstream d;
        d << "min_item_acc4=" << mn << " (cue " << arg << ")";
        crits.push_back({"L4-B", d.str(), ok});
    }
    {
        double acc = pooledAcc(8, 0), base = pooledAcc(8, 2);
        bool ok = acc >= 0.55 && acc >= base + 0.20;
        std::ostringstream d;
        d << "acc8=" << acc << " base8=" << base;
        crits.push_back({"L4-C", d.str(), ok});
    }
    {
        bool ok = heavy8 >= 0.45;
        std::ostringstream d;
        d << "acc_heavy8=" << heavy8 << " std8=" << pooledAcc(8, 0)
          << " delta=" << (pooledAcc(8, 0) - heavy8);
        crits.push_back({"L4-D", d.str(), ok});
    }
    {
        double am4 = pooledAcc(4, 3);
        bool ok = am4 <= 0.35 && (pooledAcc(4, 0) - am4) >= 0.35;
        std::ostringstream d;
        d << "amnesic4=" << am4 << " gap=" << (pooledAcc(4, 0) - am4);
        crits.push_back({"L4-E", d.str(), ok});
    }
    {
        bool ok = true;
        std::ostringstream d;
        d << "sham/base=[";
        for (int li = 0; li < 4; ++li) {
            int N = kLoads[li];
            double s = pooledAcc(N, 1), b = pooledAcc(N, 2);
            if (s > 0.40 || b > 0.35) ok = false;
            d << s << "/" << b << (li < 3 ? "," : "");
        }
        // Fixed-action detector at N=8 trained.
        double maxshare = 0.0;
        const Pool& p8 = pool[8][0];
        for (int r = 0; r < cfg.n_resp; ++r) {
            int c = 0;
            for (int si = 0; si < 3; ++si)
                c += per_seed[8][si][0].choice_hist[static_cast<size_t>(r)];
            maxshare = std::max(maxshare, p8.n ? double(c) / p8.n : 0.0);
        }
        if (maxshare > 0.40) ok = false;
        d << "] max_share8=" << maxshare;
        crits.push_back({"L4-F", d.str(), ok});
    }
    {
        bool ok = true;
        int mism = 0, nq = 0;
        for (int si = 0; si < 3; ++si) {
            const SaveReloadOut& o = sr_out[8][si];
            ok = ok && o.weights_identical && o.serialize_roundtrip_identical &&
                 o.choices_identical && o.double_reload_identical;
            mism += o.n_choice_mismatch;
            nq += o.n_queries;
        }
        std::ostringstream d;
        d << "seeds_ok=" << (ok ? 3 : 0) << " choice_mismatches=" << mism
          << "/" << nq;
        crits.push_back({"L4-G", d.str(), ok});
    }

    bool all = true;
    for (const Crit& c : crits) all = all && c.pass;

    // ---- Report (schema STARK-L4-1) ----
    std::ostringstream js;
    js.setf(std::ios::fixed);
    js.precision(6);
    js << "{\n  \"schema\": \"STARK-L4-1\",\n  \"design\": \"stark/design/associative_memory_milestone.md v1.0\",\n";
    js << "  \"config\": {\"train_per_item\":" << cfg.train_per_item
       << ",\"queries_per_item\":" << cfg.queries_per_item
       << ",\"seeds\":[" << kSeeds[0] << "," << kSeeds[1] << "," << kSeeds[2]
       << "],\"w_init\":0.35,\"w_max\":0.7,\"w_self\":1.05,\"w_inh\":-1.2,\"tau_e\":8,\"tau_pre\":20},\n";

    js << "  \"mappings\": [\n";
    for (int si = 0; si < 3; ++si) {
        const AMMapping& m = maps[8][si];
        js << "    {\"master\":" << kSeeds[si] << ",\"perm\":[";
        for (size_t i = 0; i < m.perm.size(); ++i) {
            if (i) js << ",";
            js << m.perm[i];
        }
        js << "],\"train_order\":[";
        for (size_t i = 0; i < m.train_order.size(); ++i) {
            if (i) js << ",";
            js << m.train_order[i];
        }
        js << "]}" << (si < 2 ? "," : "") << "\n";
    }
    js << "  ],\n";

    js << "  \"loads\": [\n";
    for (int li = 0; li < 4; ++li) {
        const int N = kLoads[li];
        js << "    {\"N\":" << N << ", \"seeds\": [\n";
        for (int si = 0; si < 3; ++si) {
            js << "      {\"master\":" << kSeeds[si];
            for (int m = 0; m < kModes; ++m) {
                static const char* names[kModes] = {"trained","sham","baseline","amnesic"};
                js << ", \"" << names[m] << "\": ";
                jsonRun(js, per_seed[N][si][m]);
            }
            if (N == 8) {
                js << ", \"heavy_acc\":" << heavy[N][si]
                   << ", \"save_reload\": {\"weights_identical\": "
                   << (sr_out[N][si].weights_identical ? "true" : "false")
                   << ", \"serialize_roundtrip_identical\": "
                   << (sr_out[N][si].serialize_roundtrip_identical ? "true" : "false")
                   << ", \"choices_identical\": "
                   << (sr_out[N][si].choices_identical ? "true" : "false")
                   << ", \"double_reload_identical\": "
                   << (sr_out[N][si].double_reload_identical ? "true" : "false")
                   << ", \"n_queries\": " << sr_out[N][si].n_queries
                   << ", \"n_choice_mismatch\": " << sr_out[N][si].n_choice_mismatch << "}";
            }
            js << "}" << (si < 2 ? "," : "") << "\n";
        }
        js << "     ],\n     \"pooled\": {";
        for (int m = 0; m < kModes; ++m) {
            static const char* names[kModes] = {"trained","sham","baseline","amnesic"};
            Wilson w = wilson(pool[N][m].correct, pool[N][m].n);
            js << (m ? ", " : "") << "\"" << names[m] << "\": {\"acc\": "
               << pooledAcc(N, m) << ", \"ci95\": [" << w.lo << "," << w.hi
               << "], \"n\": " << pool[N][m].n << "}";
        }
        if (N == 8) js << ", \"heavy_acc\": " << heavy8;
        js << "}}";
        if (li < 3) js << ",";
        js << "\n";
    }
    js << "  ],\n";

    js << "  \"criteria\": {\n";
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

    std::cout << "STARK-L4 associative-memory experiment\n";
    for (const Crit& c : crits) {
        std::cout << "  " << c.id << ": " << (c.pass ? "PASS" : "FAIL")
                  << "  " << c.detail << "\n";
    }
    std::cout << "report: " << out_path << "\nverdict: " << (all ? "PASS" : "FAIL") << "\n";
    return all ? 0 : 1;
}
