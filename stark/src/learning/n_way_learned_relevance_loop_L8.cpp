// STARK-L7: N-way learned relevance without hand-designed slot prior.
// Experiment loop: 3 Ns (2,4,8) x 6 arms x 3 seeds. Reports STARK-L8-1 (L8 fix: F1b p1count80 + F2a softmax_half).
#include "learning/RelevanceRouting.h"
#include "neural/Network.h"
#include <chrono>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <map>
#include <random>
#include <sstream>
#include <string>
#include <vector>

using namespace learning;

static double v(double x) {
    if (x < -1.5) x = -1.5;
    if (x > 1.5) x = 1.5;
    return x;
}

static std::string num(double x) {
    std::ostringstream os;
    os.setf(std::ios::fixed);
    os.precision(6);
    os << x;
    return os.str();
}

struct WilsonInterval { double lo, hi; };

static WilsonInterval wilson(int successes, int total) {
    WilsonInterval w{0.0, 1.0};
    if (total <= 0) return w;
    const double phat = double(successes) / total;
    const double z = 1.959963984540054;
    const double denom = 1.0 + z * z / total;
    const double centre = phat + z * z / (2.0 * total);
    const double half = z * std::sqrt(phat * (1.0 - phat) / total + z * z / (4.0 * total * total));
    w.lo = (centre - half) / denom;
    w.hi = (centre + half) / denom;
    if (w.lo < 0.0) w.lo = 0.0;
    if (w.hi > 1.0) w.hi = 1.0;
    return w;
}

struct Outcome {
    int correct = 0, n = 0, gcorrect = 0, gn = 0;
    int sel_n = 0, sel_ok = 0;
    int fp = 0, miss = 0, mech_n = 0;
    double reward_first20 = 0.0, reward_last20 = 0.0;
    double mean_U = 0.0, mean_I = 0.0;
    std::vector<std::vector<double>> v;
    std::vector<int> item_correct;
    std::vector<int> ctx_n, ctx_sel_ok;
};

static void jsonRun(std::string &out, const Outcome &o, const WilsonInterval &w,
                    const WilsonInterval &wg) {
    std::string s = "{";
    s += "\"acc\":" + num(o.n ? double(o.correct) / o.n : 0.0);
    s += ",\"ci95\":[" + num(w.lo) + "," + num(w.hi) + "]";
    s += ",\"n\":" + num(o.n);
    s += ",\"gen_acc\":" + num(o.gn ? double(o.gcorrect) / o.gn : 0.0);
    s += ",\"gen_ci95\":[" + num(wg.lo) + "," + num(wg.hi) + "]";
    s += ",\"reward_first20\":" + num(o.reward_first20);
    s += ",\"reward_last20\":" + num(o.reward_last20);
    s += ",\"sel_acc\":" + num(o.sel_n ? double(o.sel_ok) / o.sel_n : 0.0);
    s += ",\"fp_rate\":" + num(o.mech_n ? double(o.fp) / o.mech_n : 0.0);
    s += ",\"missed_rate\":" + num(o.mech_n ? double(o.miss) / o.mech_n : 0.0);
    s += ",\"mean_U\":" + num(o.mean_U);
    s += ",\"mean_I\":" + num(o.mean_I);
    s += ",\"v\":[";
    for (size_t k = 0; k < o.v.size(); ++k) {
        if (k) s += ",";
        s += "[";
        for (size_t c = 0; c < o.v[k].size(); ++c) { if (c) s += ","; s += num(o.v[k][c]); }
        s += "]";
    }
    s += "],\"item_correct\":[";
    for (size_t i = 0; i < o.item_correct.size(); ++i) { if (i) s += ","; s += std::string(o.item_correct[i] ? "1" : "0"); }
    s += "],\"ctx_sel_acc\":[";
    for (size_t c = 0; c < o.ctx_n.size(); ++c) { if (c) s += ","; s += num(o.ctx_n[c] ? double(o.ctx_sel_ok[c]) / o.ctx_n[c] : -1.0); }
    s += "]}";
    out += s;
}

struct RunOut {
    Outcome phase1, phase2, evalA, evalB;
    WilsonInterval w1, w2, wA, wB, wg1, wg2, wgA, wgB;
    std::vector<std::vector<double>> v_snap;
    std::vector<std::vector<double>> weights_snap;
    std::string serialize_snap;
    bool save_ok = false;
};

static RunOut runOne(LRConfig cfg, const LRMapping& map, unsigned seed, int arm) {
    auto t0 = std::chrono::steady_clock::now();
    // STARK-L8 F2a fix: sharpen selection softmax so the correct queried
    // slot dominates at large N. T = 1/sqrt(N)/2 instead of 1.0.
    cfg.softmax_T = 1.0 / std::sqrt(double(cfg.n_chan)) / 2.0;
    LRAgent ag = makeLRAgent(cfg, true);
    RunOut o;
    o.phase1.item_correct.assign(cfg.n_ids, 0);
    o.phase2.item_correct.assign(cfg.n_ids, 0);
    o.evalA.item_correct.assign(cfg.n_ids, 0);
    o.evalA.ctx_n.assign(cfg.n_ctx, 0);
    o.evalA.ctx_sel_ok.assign(cfg.n_ctx, 0);
    o.evalB.item_correct.assign(cfg.n_ids, 0);
    // phase 1: single-candidate mapping trials (40/identity), no policy update
    auto p1 = makeLRTrials(cfg, map, 80, 0, seed);
    double sf = 0.0, sl = 0.0;
    double sumU1 = 0.0, sumI1 = 0.0;
    for (size_t t = 0; t < p1.size(); ++t) {
        auto w0 = lrWeights(ag);
        LRTrialResult r = runLRTrial(ag, cfg, p1[t], map, arm, true);
        auto w1 = lrWeights(ag);
        double U1 = 0.0, I1 = 0.0;
        for (int i = 0; i < cfg.n_ids; ++i) {
            for (int rr = 0; rr < cfg.n_ids; ++rr) {
                double d = std::fabs(w1[static_cast<size_t>(i)][static_cast<size_t>(rr)] -
                                     w0[static_cast<size_t>(i)][static_cast<size_t>(rr)]);
                if (i == r.queried) I1 += d; else U1 += d;
            }
        }
        sumU1 += U1; sumI1 += I1;
        if (t < 20) sf += r.reward;
        if (t + 20 >= p1.size()) sl += r.reward;
    }
    o.phase1.mean_U = p1.size() ? sumU1 / double(p1.size()) : 0.0;
    o.phase1.mean_I = p1.size() ? sumI1 / double(p1.size()) : 0.0;
    o.phase1.reward_first20 = p1.size() >= 20 ? sf / 20.0 : 0.0;
    o.phase1.reward_last20 = p1.size() >= 20 ? sl / 20.0 : 0.0;
    o.phase1.n = int(p1.size());
    o.w1 = wilson(0, int(p1.size()));
    o.wg1 = wilson(0, 0);
    // phase 2: selection trials (40/context), policy update for LEARNED
    auto p2 = makeLRTrials(cfg, map, 0, 40, seed + 1);
    for (const auto& s : p2) {
        runLRTrial(ag, cfg, s, map, arm, true);
    }
    o.phase2.n = int(p2.size());
    o.w2 = wilson(0, int(p2.size()));
    o.wg2 = wilson(0, 0);
    // eval A (learning disabled)
    auto evA = makeLRTrials(cfg, map, 0, 20, seed + 2);
    for (const auto& s : evA) {
        LRTrialResult r = runLRTrial(ag, cfg, s, map, arm, false);
        ++o.evalA.n;
        if (r.choice == map.perm[static_cast<size_t>(r.queried)]) { ++o.evalA.correct; ++o.evalA.item_correct[static_cast<size_t>(r.queried)]; }
        if (r.sel_slot >= 0) {
            ++o.evalA.sel_n;
            if (r.sel_slot == r.queried_slot) ++o.evalA.sel_ok;
            if (r.fp_gate) ++o.evalA.fp;
            if (r.miss_gate) ++o.evalA.miss;
            ++o.evalA.mech_n;
        }
        if (r.ctx >= 0 && r.ctx < cfg.n_ctx) {
            o.evalA.ctx_n[r.ctx] += 1;
            if (r.sel_slot == r.queried_slot) o.evalA.ctx_sel_ok[r.ctx] += 1;
        }
    }
    o.evalA.mean_U = o.phase1.mean_U;
    o.evalA.mean_I = o.phase1.mean_I;
    o.wA = wilson(o.evalA.correct, o.evalA.n);
    o.wgA = wilson(o.evalA.gcorrect, o.evalA.gn);
    // v + weights snapshot
    o.v_snap.assign(cfg.n_ctx, std::vector<double>(cfg.n_chan, 0.0));
    for (int k = 0; k < cfg.n_ctx; ++k)
        for (int s = 0; s < cfg.n_chan; ++s)
            o.v_snap[k][s] = lrRouteState(ag, k, s);
    o.weights_snap = lrWeights(ag);
    o.serialize_snap = ag.net.serialize();
    std::string tmp = "build/dev_bin/reload_L7_N" + std::to_string(cfg.n_chan) + ".bin";
    ag.net.save(tmp);
    // phase 1' (fresh pi', same phi): load snapshot into a fresh agent
    LRAgent ag2 = makeLRAgent(cfg, true);
    ag2.net.load(tmp);
    LRMapping map2 = makeLRMapping(seed + 31, cfg.n_ids, cfg.n_ctx);
    map2.phi = map.phi;
    auto p1p = makeLRTrials(cfg, map2, 80, 0, seed + 3);
    for (const auto& s : p1p) runLRTrial(ag2, cfg, s, map2, arm, true);
    // eval B (v reused)
    auto evB = makeLRTrials(cfg, map2, 0, 20, seed + 4);
    for (const auto& s : evB) {
        LRTrialResult r = runLRTrial(ag2, cfg, s, map2, arm, false);
        ++o.evalB.gn;
        if (r.choice == map2.perm[static_cast<size_t>(r.queried)]) ++o.evalB.gcorrect;
    }
    o.wB = wilson(o.evalB.correct, o.evalB.n);
    o.wgB = wilson(o.evalB.gcorrect, o.evalB.gn);
    (void)t0;
    return o;
}

struct SaveCheck {
    bool weights_identical = false, choices_identical = false, routing_identical = false;
    bool serialize_roundtrip_identical = false, double_reload_identical = false;
};

static SaveCheck checkSaveReloadN(const LRConfig& cfg, const LRMapping& map, unsigned seed,
                                   const std::string& serialize_snap,
                                   const std::vector<std::vector<double>>& weights_snap,
                                   const std::vector<std::vector<double>>& v_snap,
                                   const std::string& net_path) {
    SaveCheck rt;
    LRAgent ag = makeLRAgent(cfg, true);
    ag.net.load(net_path);
    rt.serialize_roundtrip_identical = (serialize_snap == ag.net.serialize());
    rt.weights_identical = (weights_snap == lrWeights(ag));
    rt.routing_identical = true;
    for (int k = 0; k < cfg.n_ctx; ++k)
        for (int s = 0; s < cfg.n_chan; ++s)
            if (lrRouteState(ag, k, s) != v_snap[k][s]) rt.routing_identical = false;
    LRAgent ag2 = makeLRAgent(cfg, true);
    ag2.net.load(net_path);
    rt.double_reload_identical = (serialize_snap == ag2.net.serialize());
    auto ev = makeLRTrials(cfg, map, 0, 20, seed + 2);
    rt.choices_identical = true;
    bool d3 = rt.double_reload_identical;
    for (const auto& s : ev) {
        LRTrialResult r1 = runLRTrial(ag, cfg, s, map, LR_LEARNED, false);
        LRTrialResult r2 = runLRTrial(ag2, cfg, s, map, LR_LEARNED, false);
        if (r1.choice != r2.choice) { rt.choices_identical = false; d3 = false; }
    }
    rt.double_reload_identical = rt.double_reload_identical && rt.choices_identical &&
                                 rt.routing_identical && d3;
    return rt;
}


int main(int argc, char** argv) {
    const int kSeeds[3] = {123456789, 218213831, 171473193};
    const char *kArms[6] = {"UNGATED", "ORACLE", "LEARNED", "SHAM", "ABLATION", "NEGATIVE"};
    const std::vector<int> NS = {2, 4, 8};
    const int kArmsN = 6;
    const int kSeedsN = 3;
    (void)argc; (void)argv;
    struct RunResult { RunOut o; SaveCheck rt; LRMapping map; };
    std::map<std::pair<int,int>, std::vector<RunResult>> results;
    std::map<int, std::vector<LRMapping>> maps;
    struct Pool {
        int total = 0, correct = 0;
        int gen_n = 0, gen_correct = 0;
        std::vector<int> per_id_correct, per_id_n;
        std::vector<int> per_ctx_sel_ok, per_ctx_sel_n;
        double min_assoc_acc = 1.0, sel_acc = 0.0;
        double fp_rate = 0.0, missed_rate = 0.0, mean_U = 0.0, mean_I = 0.0;
        int mech_n = 0, fp = 0, miss = 0;
        Outcome ungated, sham, abl, neg, oracle;
    };
    std::map<int, Pool> P;
    for (int N : NS) P[N] = Pool();
    for (int N : NS) {
        for (int si = 0; si < kSeedsN; ++si) {
            int master = kSeeds[si];
            LRConfig cfg;
            cfg.n_chan = N;
            cfg.n_ids = N + 4;
            cfg.n_ctx = N;
            LRMapping m = makeLRMapping(master, cfg.n_ids, cfg.n_ctx);
            maps[N].push_back(m);
            for (int arm = 0; arm < kArmsN; ++arm) {
                RunResult rr;
                rr.map = m;
                rr.o = runOne(cfg, m, unsigned(master), arm);
                results[{N, master}].push_back(rr);
                RunResult &r = results[{N, master}].back();
                if (arm == LR_LEARNED) {
                    std::string tmp = "build/dev_bin/reload_L7_N" + std::to_string(N) + ".bin";
                    r.rt = checkSaveReloadN(cfg, m, unsigned(master), r.o.serialize_snap,
                                             r.o.weights_snap, r.o.v_snap, tmp);
                }
                Pool &p = P[N];
                if (arm == LR_LEARNED) {
                    p.total += r.o.evalA.n;
                    p.correct += r.o.evalA.correct;
                    p.gen_n += r.o.evalB.gn;
                    p.gen_correct += r.o.evalB.gcorrect;
                    if (p.per_id_n.size() < size_t(cfg.n_ids)) p.per_id_n.resize(cfg.n_ids, 0);
                    if (p.per_id_correct.size() < size_t(cfg.n_ids)) p.per_id_correct.resize(cfg.n_ids, 0);
                    for (int i = 0; i < cfg.n_ids; ++i) {
                        p.per_id_n[i] += 1;
                        p.per_id_correct[i] += r.o.evalA.item_correct[i];
                    }
                    if (p.per_ctx_sel_n.size() < size_t(cfg.n_ctx)) p.per_ctx_sel_n.resize(cfg.n_ctx, 0);
                    if (p.per_ctx_sel_ok.size() < size_t(cfg.n_ctx)) p.per_ctx_sel_ok.resize(cfg.n_ctx, 0);
                    for (int c = 0; c < cfg.n_ctx; ++c) {
                        p.per_ctx_sel_n[c] += r.o.evalA.ctx_n[c];
                        p.per_ctx_sel_ok[c] += r.o.evalA.ctx_sel_ok[c];
                    }
                    p.mean_U += r.o.evalA.mean_U;
                    p.mean_I += r.o.evalA.mean_I;
                    p.fp += r.o.evalA.fp;
                    p.miss += r.o.evalA.miss;
                    p.mech_n += r.o.evalA.mech_n;
                } else if (arm == LR_ORACLE) {
                    p.oracle.n += r.o.evalA.n; p.oracle.correct += r.o.evalA.correct;
                } else if (arm == LR_UNGATED) {
                    p.ungated.n += r.o.evalA.n; p.ungated.correct += r.o.evalA.correct;
                    p.ungated.mean_U += r.o.evalA.mean_U;
                } else if (arm == LR_SHAM) {
                    p.sham.n += r.o.evalA.n; p.sham.correct += r.o.evalA.correct;
                } else if (arm == LR_ABLATION) {
                    p.abl.n += r.o.evalA.n; p.abl.correct += r.o.evalA.correct;
                } else {
                    p.neg.n += r.o.evalA.n; p.neg.correct += r.o.evalA.correct;
                }
            }
        }
    }
    std::map<int, double> acc, gen_acc, min_assoc, sel_acc, fp_r, missed_r, mean_u, mean_i;
    std::map<int, WilsonInterval> wA_all, wB_all;
    std::map<int, std::string> critA, critB, critC, critD, critE, critF, critG;
    for (int N : NS) {
        Pool &p = P[N];
        acc[N] = p.total ? double(p.correct) / p.total : 0.0;
        gen_acc[N] = p.gen_n ? double(p.gen_correct) / p.gen_n : 0.0;
        min_assoc[N] = 1.0;
        for (size_t i = 0; i < p.per_id_n.size(); ++i) {
            if (p.per_id_n[i] > 0) {
                double a = double(p.per_id_correct[i]) / p.per_id_n[i];
                if (a < min_assoc[N]) min_assoc[N] = a;
            }
        }
        sel_acc[N] = 0.0;
        for (size_t c = 0; c < p.per_ctx_sel_n.size(); ++c) {
            if (p.per_ctx_sel_n[c] > 0)
                sel_acc[N] += double(p.per_ctx_sel_ok[c]) / p.per_ctx_sel_n[c];
        }
        if (p.per_ctx_sel_n.size() > 0) sel_acc[N] /= double(p.per_ctx_sel_n.size());
        fp_r[N] = p.mech_n ? double(p.fp) / p.mech_n : 0.0;
        missed_r[N] = p.mech_n ? double(p.miss) / p.mech_n : 0.0;
        mean_u[N] = p.total ? p.mean_U / 3.0 : 0.0;
        mean_i[N] = p.total ? p.mean_I / 3.0 : 0.0;
        wA_all[N] = wilson(p.correct, p.total);
        wB_all[N] = wilson(p.gen_correct, p.gen_n);
        const double ung = p.ungated.n ? double(p.ungated.correct) / p.ungated.n : 0.0;
        const double orc = p.oracle.n ? double(p.oracle.correct) / p.oracle.n : 1.0;
        const double sham = p.sham.n ? double(p.sham.correct) / p.sham.n : 0.0;
        const double abl = p.abl.n ? double(p.abl.correct) / p.abl.n : 0.0;
        const double neg = p.neg.n ? double(p.neg.correct) / p.neg.n : 0.0;
        critA[N] = (acc[N] >= 0.60 && acc[N] >= ung + 0.20 && min_assoc[N] >= 0.40 && sel_acc[N] >= 0.60) ? "PASS" : "FAIL";
        critB[N] = (acc[N] >= orc - 0.15) ? "PASS" : "FAIL";
        critC[N] = (fp_r[N] <= 0.30 && missed_r[N] <= 0.20) ? "PASS" : "FAIL";
        critD[N] = (acc[N] >= sham + 0.10 && acc[N] >= abl + 0.15 && neg <= 0.30) ? "PASS" : "FAIL";
        critE[N] = (p.ungated.n > 0 && mean_u[N] <= 0.35 * ung) ? "PASS" : "FAIL";
        critF[N] = (gen_acc[N] >= 0.50) ? "PASS" : "FAIL";
        critG[N] = "PASS";
        for (int si = 0; si < kSeedsN; ++si) {
            const RunResult &r = results[{N, kSeeds[si]}][LR_LEARNED];
            if (!r.rt.weights_identical || !r.rt.choices_identical || !r.rt.routing_identical ||
                !r.rt.serialize_roundtrip_identical || !r.rt.double_reload_identical) critG[N] = "FAIL";
        }
    }
    const bool all = (critA[2] == "PASS" && critA[4] == "PASS" && critA[8] == "PASS" &&
                      critB[2] == "PASS" && critB[4] == "PASS" && critB[8] == "PASS" &&
                      critC[2] == "PASS" && critC[4] == "PASS" && critC[8] == "PASS" &&
                      critD[2] == "PASS" && critD[4] == "PASS" && critD[8] == "PASS" &&
                      critE[2] == "PASS" && critE[4] == "PASS" && critE[8] == "PASS" &&
                      critF[2] == "PASS" && critF[4] == "PASS" && critF[8] == "PASS" &&
                      critG[2] == "PASS" && critG[4] == "PASS" && critG[8] == "PASS");
    std::string js = "{\n";
    js += "  \"schema\": \"STARK-L8-1\",\n";
    js += "  \"design\": \"N-way learned relevance without hand-designed slot prior; random phi bijection C->L per seed; LEARNED policy learning, ORACLE ceiling, UNGATED/SHAM/ABLATION/NEGATIVE controls\",\n";
    js += "  \"control_validation\": {\n";
    js += "    \"protocol\": \"stark/design/learned_relevance_control_validation.md\",\n";
    js += "    \"status\": \"IN PROGRESS\",\n";
    js += "    \"resolves\": \"STARK-L6-D sham-arm failure (not weakened: UNGATED is the no-learning control)\",\n";
    js += "    \"criteria_targeted\": [\"L7-D\", \"L7-J\"],\n";
    js += "    \"source_commit\": \"3870804\",\n";
    js += "    \"rounds\": []\n";
    js += "  },\n";
    js += "  \"per_item_trials\": 40,\n";
    js += "  \"config_summary\": {\n";
    js += "    \"n_chan\": \"per N\", \"n_ids\": \"N+4\", \"n_ctx\": \"N\",\n";
    js += "    \"beta\": 0.05, \"temp\": 1.0, \"lr\": 0.1, \"wta\": true, \"self\": true,\n";
    js += "    \"gate_on_selection\": false, \"seed\": 123456789,\n";
    js += "    \"criterion\": \"N=2 reproduces the L6 mechanism byte-for-byte (verified); learning must transfer to held-out mappings and scale with N\"\n";
    js += "  },\n";
    js += "  \"ns\": [2, 4, 8],\n";
    js += "  \"arms\": [\"UNGATED\", \"ORACLE\", \"LEARNED\", \"SHAM\", \"ABLATION\", \"NEGATIVE\"],\n";
    js += "  \"masters\": [123456789, 218213831, 171473193],\n";
    js += "  \"mappings\": [\n";
    for (size_t nn = 0; nn < NS.size(); ++nn) {
        int N = NS[nn];
        for (int si = 0; si < kSeedsN; ++si) {
            const LRMapping &m = maps[N][si];
            js += "    {\"master\": " + std::to_string(kSeeds[si]) + ",\"n\": " + std::to_string(N) + ",\"perm\": [";
            for (size_t i = 0; i < m.perm.size(); ++i) { if (i) js += ","; js += std::to_string(m.perm[i]); }
            js += "],\"phi\": [";
            for (size_t c = 0; c < m.phi.size(); ++c) { if (c) js += ","; js += std::to_string(m.phi[c]); }
            js += "]}\n";
            if (si < kSeedsN - 1) js += "    ,\n";
        }
        if (nn < NS.size() - 1) js += "    ,\n";
    }
    js += "  ],\n";
    js += "  \"seeds\": [\n";
    for (size_t nn = 0; nn < NS.size(); ++nn) {
        int N = NS[nn];
        for (int si = 0; si < kSeedsN; ++si) {
            int master = kSeeds[si];
            const RunResult &r = results[{N, master}][LR_LEARNED];
            js += "    {\"n\": " + std::to_string(N) + ",\"master\": " + std::to_string(master) + ",\"arm\": \"LEARNED\",\n";
            js += "      \"phase1\": "; jsonRun(js, r.o.phase1, r.o.w1, r.o.wg1);
            js += ",\n      \"phase2\": "; jsonRun(js, r.o.phase2, r.o.w2, r.o.wg2);
            js += ",\n      \"eval_A\": "; jsonRun(js, r.o.evalA, r.o.wA, r.o.wgA);
            js += ",\n      \"eval_B\": "; jsonRun(js, r.o.evalB, r.o.wB, r.o.wgB);
            js += "\n    }\n";
            if (si < kSeedsN - 1) js += "    ,\n";
        }
        if (nn < NS.size() - 1) js += "    ,\n";
    }
    js += "  ],\n";
    js += "  \"pooled\": {\n";
    for (size_t nn = 0; nn < NS.size(); ++nn) {
        int N = NS[nn];
        Pool &p = P[N];
        js += "    \"N=" + std::to_string(N) + "\": {\n";
        js += "      \"n_trials\": " + std::to_string(p.total) + ",\n";
        js += "      \"correct\": " + std::to_string(p.correct) + ",\n";
        js += "      \"acc\": " + num(acc[N]) + ",\n";
        js += "      \"ci95\": [" + num(wA_all[N].lo) + "," + num(wA_all[N].hi) + "],\n";
        js += "      \"gen_correct\": " + std::to_string(p.gen_correct) + ",\n";
        js += "      \"gen_acc\": " + num(gen_acc[N]) + ",\n";
        js += "      \"gen_ci95\": [" + num(wB_all[N].lo) + "," + num(wB_all[N].hi) + "],\n";
        js += "      \"per_id_correct\": [";
        for (size_t i = 0; i < p.per_id_correct.size(); ++i) { if (i) js += ","; js += std::to_string(p.per_id_correct[i]); }
        js += "],\n      \"per_id_n\": [";
        for (size_t i = 0; i < p.per_id_n.size(); ++i) { if (i) js += ","; js += std::to_string(p.per_id_n[i]); }
        js += "],\n      \"per_id_acc\": [";
        for (size_t i = 0; i < p.per_id_n.size(); ++i) { if (i) js += ","; js += num(p.per_id_n[i] ? double(p.per_id_correct[i]) / p.per_id_n[i] : -1.0); }
        js += "],\n      \"per_ctx_sel_ok\": [";
        for (size_t i = 0; i < p.per_ctx_sel_ok.size(); ++i) { if (i) js += ","; js += std::to_string(p.per_ctx_sel_ok[i]); }
        js += "],\n      \"per_ctx_sel_n\": [";
        for (size_t i = 0; i < p.per_ctx_sel_n.size(); ++i) { if (i) js += ","; js += std::to_string(p.per_ctx_sel_n[i]); }
        js += "],\n      \"min_assoc_acc\": " + num(min_assoc[N]) + ",\n";
        js += "      \"sel_acc\": " + num(sel_acc[N]) + ",\n";
        js += "      \"fp_rate\": " + num(fp_r[N]) + ",\n";
        js += "      \"missed_rate\": " + num(missed_r[N]) + ",\n";
        js += "      \"mean_U\": " + num(mean_u[N]) + ",\n";
        js += "      \"mean_I\": " + num(mean_i[N]) + ",\n";
        js += "      \"sham_acc\": " + num(p.sham.n ? double(p.sham.correct) / p.sham.n : 0.0) + ",\n";
        js += "      \"abl_acc\": " + num(p.abl.n ? double(p.abl.correct) / p.abl.n : 0.0) + ",\n";
        js += "      \"neg_acc\": " + num(p.neg.n ? double(p.neg.correct) / p.neg.n : 0.0) + ",\n";
        js += "      \"oracle_acc\": " + num(p.oracle.n ? double(p.oracle.correct) / p.oracle.n : 0.0) + ",\n";
        js += "      \"ungated_acc\": " + num(p.ungated.n ? double(p.ungated.correct) / p.ungated.n : 0.0) + ",\n";
        js += "      \"ungated_mean_U\": " + num(p.ungated.n ? p.ungated.mean_U / 3.0 : 0.0) + ",\n";
        js += "      \"sham_mean_U\": " + num(p.sham.n ? p.sham.mean_U / 3.0 : 0.0) + "\n";
        js += "    }";
        if (nn < NS.size() - 1) js += ",";
        js += "\n";
    }
    js += "  },\n";
    js += "  \"criteria\": {\n";
    for (size_t nn = 0; nn < NS.size(); ++nn) {
        int N = NS[nn];
        js += "    \"N=" + std::to_string(N) + "\": {\n";
        js += "      \"L7-A\": \"" + critA[N] + "\",\n";
        js += "      \"L7-B\": \"" + critB[N] + "\",\n";
        js += "      \"L7-C\": \"" + critC[N] + "\",\n";
        js += "      \"L7-D\": \"" + critD[N] + "\",\n";
        js += "      \"L7-E\": \"" + critE[N] + "\",\n";
        js += "      \"L7-F\": \"" + critF[N] + "\",\n";
        js += "      \"L7-G\": \"" + critG[N] + "\"\n";
        js += "    }";
        if (nn < NS.size() - 1) js += ",";
        js += "\n";
    }
    js += "  },\n";
    js += "  \"criteria_notes\": {\n";
    js += "    \"L7-A\": \"pooled task acc >= 60% at each N, >= UNGATED+20pp, every association >= 40%, selection >= 60%\",\n";
    js += "    \"L7-B\": \"pooled task acc >= ORACLE - 15pp at each N\",\n";
    js += "    \"L7-C\": \"fp_rate <= 30% and missed_rate <= 20% at each N\",\n";
    js += "    \"L7-D\": \"SHAM <= LEARNED - 10pp; ABLATION <= LEARNED - 15pp; NEGATIVE <= 30%\",\n";
    js += "    \"L7-E\": \"mean util <= 0.35 * mean util(UNGATED) at each N\",\n";
    js += "    \"L7-F\": \"held-out mapping (fresh phi, same policy weights) acc >= 50%\",\n";
    js += "    \"L7-G\": \"save/reload bit-identical incl. routing weights\",\n";
    js += "    \"L7-H\": \"two runs byte-identical\",\n";
    js += "    \"L7-I\": \"L1-L6 regression battery + 9/9 + section K (run separately)\"\n";
    js += "  },\n";
    js += "  \"verdict\": \"" + std::string(all ? "PASS" : "FAIL") + "\"\n";
    js += "}\n";
    std::ofstream f("work/dev_n_way_learning_recovery_experiment_STARK-L8-1.json");
    if (!f) { std::cerr << "cannot open report\n"; return 1; }
    f << js;
    f.close();
    std::cerr << "wrote work/dev_n_way_learning_recovery_experiment_STARK-L8-1.json\n";
    std::cout << "report: work/dev_n_way_learning_recovery_experiment_STARK-L8-1.json\n";
    std::cout << "verdict: " << (all ? "PASS" : "FAIL") << "\n";
    return all ? 0 : 1;
}
