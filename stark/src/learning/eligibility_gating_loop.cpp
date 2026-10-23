/**
 * STARK-L5: eligibility-gated credit assignment experiment
 * (schema STARK-L5-1).
 *
 * Frozen protocol: stark/design/eligibility_gating_milestone.md v1.0.
 * Multi-association training WITH distractor cues present (the L4 v1.0
 * failure configuration) under four arms: UNGATED (existing rule,
 * reference), GATED (pre-side eligibility gate on the queried cue),
 * INVERTED (gate on distractor cues only — signal-specificity control),
 * SHAM (gated, m = +1). Loads N = 8 (primary) and N = 4 x seeds
 * {20261023..25}; per-association accuracy; unintended vs intended
 * per-trial weight-update mass; save/reload; criteria L5-A..E. Exit 0 iff
 * every evaluated criterion passes. Determinism (L5-F) and regression
 * (L5-G) run out-of-band.
 */

#include "learning/AssociativeMemoryTask.h"

#include <array>
#include <cmath>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

using namespace learning;

namespace {

const int kLoads[2] = {8, 4};
const unsigned kSeeds[3] = {20261023u, 20261024u, 20261025u};
const int kArms = 4; // ungated, gated, inverted, sham

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
    std::vector<int> item_n, item_correct;
    double mean_U = 0.0, mean_I = 0.0; // unintended / intended update mass
    double reward_first20 = 0.0, reward_last20 = 0.0;
    double val_acc = -1.0;
    std::vector<std::vector<double>> w_final;
};

RunOut runOne(const AMConfig& base, const AMMapping& map, int N, unsigned seed,
              int arm /*0 ungated,1 gated,2 inverted,3 sham*/, bool want_val) {
    AMConfig c = base;
    c.elig_gate_mode = (arm == 0) ? 0 : (arm == 2) ? 2 : 1;
    if (arm == 3) c.reward_contingent = false;

    AMAgent ag = makeAMAgent(c, true);
    RunOut o;
    o.item_n.assign(static_cast<size_t>(c.n_cues), 0);
    o.item_correct.assign(static_cast<size_t>(c.n_cues), 0);

    // Training WITH distractors (frozen protocol §3): per-trial weight
    // snapshots separate unintended (non-query rows) from intended updates.
    auto train = makeAMTrials(c, map, N, c.train_per_item, seed, false);
    double sumU = 0.0, sumI = 0.0, sf = 0.0, sl = 0.0;
    for (size_t t = 0; t < train.size(); ++t) {
        auto w0 = amWeights(ag);
        AMTrialResult r = runAMTrial(ag, c, train[t], map, true);
        auto w1 = amWeights(ag);
        double U = 0.0, I = 0.0;
        for (int i = 0; i < c.n_cues; ++i) {
            for (int rr = 0; rr < c.n_resp; ++rr) {
                double d = std::fabs(w1[static_cast<size_t>(i)][static_cast<size_t>(rr)] -
                                     w0[static_cast<size_t>(i)][static_cast<size_t>(rr)]);
                if (i == train[t].cue) I += d;
                else U += d;
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

    // Evaluation with distractors, learning disabled.
    auto ev = makeAMTrials(c, map, N, c.queries_per_item, seed + 2, false);
    for (const auto& s : ev) {
        AMTrialResult r = runAMTrial(ag, c, s, map, false);
        ++o.n;
        ++o.item_n[static_cast<size_t>(r.cue)];
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

SaveReloadOut checkSaveReload(const AMConfig& base, const AMMapping& map, int N,
                              unsigned seed, const std::string& net_path) {
    SaveReloadOut o;
    AMConfig c = base;
    c.elig_gate_mode = 1;
    AMAgent ag = makeAMAgent(c, true);
    auto train = makeAMTrials(c, map, N, c.train_per_item, seed, false);
    for (const auto& s : train) runAMTrial(ag, c, s, map, true);

    std::string s1 = ag.net.serialize();
    ag.net.save(net_path);
    auto w1 = amWeights(ag);

    AMAgent ag2 = makeAMAgent(c, true);
    ag2.net.load(net_path);
    std::string s2 = ag2.net.serialize();
    o.serialize_roundtrip_identical = (s1 == s2);
    o.weights_identical = (w1 == amWeights(ag2));

    AMAgent ag3 = makeAMAgent(c, true);
    ag3.net.load(net_path);
    o.double_reload_identical = (s2 == ag3.net.serialize());

    auto ev = makeAMTrials(c, map, N, c.queries_per_item, seed + 2, false);
    o.choices_identical = true;
    bool d3 = o.double_reload_identical;
    for (const auto& s : ev) {
        AMTrialResult r1 = runAMTrial(ag, c, s, map, false);
        AMTrialResult r2 = runAMTrial(ag2, c, s, map, false);
        AMTrialResult r3 = runAMTrial(ag3, c, s, map, false);
        ++o.n_queries;
        if (r1.choice != r2.choice) {
            ++o.n_choice_mismatch;
            o.choices_identical = false;
        }
        if (r2.choice != r3.choice) d3 = false;
    }
    o.double_reload_identical = o.double_reload_identical && o.choices_identical && d3;
    return o;
}

void jsonRun(std::ostream& os, const RunOut& o) {
    Wilson w = wilson(o.correct, o.n);
    os << "{\"n\":" << o.n << ",\"acc\":" << (o.n ? double(o.correct) / o.n : 0.0)
       << ",\"ci95\":[" << w.lo << "," << w.hi << "],\"val_acc\":" << o.val_acc
       << ",\"mean_U\":" << o.mean_U << ",\"mean_I\":" << o.mean_I
       << ",\"reward_first20\":" << o.reward_first20
       << ",\"reward_last20\":" << o.reward_last20
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
        std::cerr << "usage: eligibility_gating_loop --out <report.json>\n";
        return 2;
    }

    AMConfig cfg; // default p_none=0.25: distractors DURING training
    std::map<int, std::array<SaveReloadOut, 3>> sr_out;
    std::map<int, std::vector<std::array<RunOut, kArms>>> per_seed;

    for (int li = 0; li < 2; ++li) {
        const int N = kLoads[li];
        for (int si = 0; si < 3; ++si) {
            const unsigned seed = kSeeds[si];
            AMMapping map = makeMapping(seed, cfg.n_cues);
            std::array<RunOut, kArms> runs;
            for (int m = 0; m < kArms; ++m) {
                runs[m] = runOne(cfg, map, N, seed, m, /*want_val=*/m <= 1);
            }
            per_seed[N].push_back(runs);
            if (N == 8) {
                sr_out[N][si] = checkSaveReload(
                    cfg, map, N, seed,
                    out_path + ".net.s" + std::to_string(si));
            }
        }
    }

    // ---- Pooled ----
    struct Pool {
        int n = 0, correct = 0;
        std::vector<int> item_n, item_correct;
        double sumU = 0.0, sumI = 0.0;
        int trials = 0;
    };
    std::map<int, std::array<Pool, kArms>> pool;
    for (int li = 0; li < 2; ++li) {
        const int N = kLoads[li];
        for (int si = 0; si < 3; ++si) {
            for (int m = 0; m < kArms; ++m) {
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
                p.sumU += o.mean_U * cfg.train_per_item * N;
                p.sumI += o.mean_I * cfg.train_per_item * N;
                p.trials += cfg.train_per_item * N;
            }
        }
    }
    auto pooledAcc = [&](int N, int m) {
        const Pool& p = pool[N][m];
        return p.n ? double(p.correct) / p.n : 0.0;
    };
    auto pooledU = [&](int N, int m) {
        const Pool& p = pool[N][m];
        return p.trials ? p.sumU / p.trials : 0.0;
    };
    auto pooledI = [&](int N, int m) {
        const Pool& p = pool[N][m];
        return p.trials ? p.sumI / p.trials : 0.0;
    };

    // ---- Criteria (frozen, design §5) ----
    struct Crit { std::string id, detail; bool pass; };
    std::vector<Crit> crits;
    {
        double g = pooledAcc(8, 1), u = pooledAcc(8, 0);
        double mn = 2.0;
        int arg = -1;
        const Pool& p = pool[8][1];
        for (int i = 0; i < cfg.n_cues; ++i) {
            if (p.item_n[static_cast<size_t>(i)] == 0) continue;
            double a = double(p.item_correct[static_cast<size_t>(i)]) /
                       p.item_n[static_cast<size_t>(i)];
            if (a < mn) { mn = a; arg = i; }
        }
        bool ok = g >= 0.80 && g >= u + 0.30 && mn >= 0.55;
        std::ostringstream d;
        d << "gated8=" << g << " ungated8=" << u << " min_item=" << mn
          << " (cue " << arg << ")";
        crits.push_back({"L5-A", d.str(), ok});
    }
    {
        double Ug = pooledU(8, 1), Uu = pooledU(8, 0), Ig = pooledI(8, 1);
        bool ok = Ug <= 0.25 * Uu && (Ig > 0 ? Ug / Ig <= 0.25 : Ug == 0.0);
        std::ostringstream d;
        d << "U_gated=" << Ug << " U_ungated=" << Uu << " I_gated=" << Ig
          << " U/I=" << (Ig > 0 ? Ug / Ig : 0.0);
        crits.push_back({"L5-B", d.str(), ok});
    }
    {
        double Ig = pooledI(8, 1), Iu = pooledI(8, 0);
        double inv = pooledAcc(8, 2);
        double Uinv = pooledU(8, 2), Iinv = pooledI(8, 2);
        bool ok = Ig >= 0.5 * Iu && inv <= 0.35 && Uinv >= Iinv;
        std::ostringstream d;
        d << "I_gated=" << Ig << " I_ungated=" << Iu << " inverted_acc=" << inv
          << " U_inv=" << Uinv << " I_inv=" << Iinv;
        crits.push_back({"L5-C", d.str(), ok});
    }
    {
        double s8 = pooledAcc(8, 3), s4 = pooledAcc(4, 3);
        bool ok = s8 <= 0.35 && s4 <= 0.35;
        std::ostringstream d;
        d << "sham8=" << s8 << " sham4=" << s4;
        crits.push_back({"L5-D", d.str(), ok});
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
        crits.push_back({"L5-E", d.str(), ok});
    }

    bool all = true;
    for (const Crit& c : crits) all = all && c.pass;

    // ---- Report (schema STARK-L5-1) ----
    std::ostringstream js;
    js.setf(std::ios::fixed);
    js.precision(6);
    js << "{\n  \"schema\": \"STARK-L5-1\",\n  \"design\": \"stark/design/eligibility_gating_milestone.md v1.0\",\n";
    js << "  \"config\": {\"train_per_item\":" << cfg.train_per_item
       << ",\"queries_per_item\":" << cfg.queries_per_item
       << ",\"train_distractors\":true,\"p_none\":0.25"
       << ",\"seeds\":[" << kSeeds[0] << "," << kSeeds[1] << "," << kSeeds[2]
       << "],\"gate_modes\":{\"ungated\":0,\"gated\":1,\"inverted\":2,\"sham\":1}},\n";

    js << "  \"loads\": [\n";
    for (int li = 0; li < 2; ++li) {
        const int N = kLoads[li];
        js << "    {\"N\":" << N << ", \"seeds\": [\n";
        for (int si = 0; si < 3; ++si) {
            js << "      {\"master\":" << kSeeds[si];
            for (int m = 0; m < kArms; ++m) {
                static const char* names[kArms] = {"ungated","gated","inverted","sham"};
                js << ", \"" << names[m] << "\": ";
                jsonRun(js, per_seed[N][si][m]);
            }
            if (N == 8) {
                js << ", \"save_reload\": {\"weights_identical\": "
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
        for (int m = 0; m < kArms; ++m) {
            static const char* names[kArms] = {"ungated","gated","inverted","sham"};
            Wilson w = wilson(pool[N][m].correct, pool[N][m].n);
            js << (m ? ", " : "") << "\"" << names[m] << "\": {\"acc\": "
               << pooledAcc(N, m) << ", \"ci95\": [" << w.lo << "," << w.hi
               << "], \"n\": " << pool[N][m].n
               << ", \"mean_U\": " << pooledU(N, m)
               << ", \"mean_I\": " << pooledI(N, m) << "}";
        }
        js << "}}";
        if (li < 1) js << ",";
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

    std::cout << "STARK-L5 eligibility-gating experiment\n";
    for (const Crit& c : crits) {
        std::cout << "  " << c.id << ": " << (c.pass ? "PASS" : "FAIL")
                  << "  " << c.detail << "\n";
    }
    std::cout << "report: " << out_path << "\nverdict: " << (all ? "PASS" : "FAIL") << "\n";
    return all ? 0 : 1;
}
