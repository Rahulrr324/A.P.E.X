/**
 * STARK-L3: sequential-context experiment (schema STARK-L3-1).
 *
 * Frozen protocol: stark/design/sequential_context_milestone.md v1.1.
 * Conditions C1..C4 x seeds {20261023..25} x {trained, sham, baseline};
 * standard evaluation + recency-probe evaluation; pooled Wilson CIs;
 * criteria L3-A..F verdicts. Exit 0 iff every evaluated criterion passes.
 *
 * Determinism: every schedule is a function of its recorded seed; identical
 * seeds replay identical trials. Determinism check (L3-G) is run out-of-band
 * by executing this binary twice and comparing reports byte-for-byte.
 */

#include "learning/ToyAssociationTask.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

using namespace learning;

namespace {

struct CondSpec {
    std::string id;
    int K, D;
    double w_self;
};

// Frozen condition table (design §4).
const CondSpec kConds[] = {
    {"C1-SHORT",   4,  2, 1.2},
    {"C2-LONG",   12,  2, 1.2},
    {"C3-LONG-D8",12,  8, 1.2},
    {"C4-ABLATE", 12,  2, 0.0},
};

const unsigned kSeeds[3] = {20261023u, 20261024u, 20261025u};
const int kTrain = 100, kEval = 50;

struct Wilson { double p, lo, hi; };

Wilson wilson(int k, int n) {
    Wilson w{0.0, 0.0, 0.0};
    if (n <= 0) return w;
    const double z = 1.959963984540054;
    const double ph = static_cast<double>(k) / n;
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

struct EvalOut {
    int n = 0, correct = 0;
    int n_cue[2] = {0, 0}, correct_cue[2] = {0, 0};
    std::vector<int> cues, choices; // for pooled aggregation
};

struct AgentOut {
    EvalOut std_eval;      // standard eval
    EvalOut probe;         // recency probe (acc_first = correct)
    std::vector<double> w_final;
    double pair_gap = 0.0;
    double reward_first20 = 0.0, reward_last20 = 0.0;
    double seq_spikes_aligned = 0.0; // mean A spikes in SEQ on correct-side
};

void accumulate(EvalOut& e, int cue, int choice) {
    ++e.n;
    e.cues.push_back(cue);
    e.choices.push_back(choice);
    if (choice == cue) ++e.correct;
    ++e.n_cue[cue];
    if (choice == cue) ++e.correct_cue[cue];
}

double accOf(const EvalOut& e) { return e.n ? double(e.correct) / e.n : 0.0; }

AgentOut runOne(const SeqConfig& cfg, unsigned seed, int mode /*0 trained,1 sham,2 baseline*/) {
    SeqConfig c = cfg;
    if (mode == 1) c.reward_contingent = false;

    std::vector<SeqTrialSchedule> train = makeSeqSchedule(c, kTrain, seed, false);
    std::vector<SeqTrialSchedule> eval_s = makeSeqSchedule(c, kEval, seed + 1, false);
    std::vector<SeqTrialSchedule> probe_s = makeSeqSchedule(c, kEval, seed + 2, true);

    SeqAgent ag = makeSeqAgent(c, /*plastic=*/mode != 2);

    AgentOut o;
    if (mode != 2) {
        double sum_first = 0.0, sum_last = 0.0;
        double seq_sum = 0.0;
        int seq_n = 0;
        for (int t = 0; t < kTrain; ++t) {
            SeqTrialResult r = runSeqTrial(ag, c, train[static_cast<size_t>(t)], true);
            if (t < 20) sum_first += r.r.reward;
            if (t >= kTrain - 20) sum_last += r.r.reward;
            seq_sum += (r.r.cue == 0) ? r.spikes_a0_seq : r.spikes_a1_seq;
            ++seq_n;
        }
        o.reward_first20 = sum_first / 20.0;
        o.reward_last20 = sum_last / 20.0;
        o.seq_spikes_aligned = seq_n ? seq_sum / seq_n : 0.0;
    }

    for (const SeqTrialSchedule& s : eval_s) {
        SeqTrialResult r = runSeqTrial(ag, c, s, false);
        accumulate(o.std_eval, r.r.cue, r.r.choice);
    }
    for (const SeqTrialSchedule& s : probe_s) {
        SeqTrialResult r = runSeqTrial(ag, c, s, false);
        accumulate(o.probe, r.r.cue, r.r.choice);
    }

    o.w_final = seqWeights(ag);
    if (o.w_final.size() == 4) {
        o.pair_gap = 0.5 * ((o.w_final[0] - o.w_final[1]) + (o.w_final[3] - o.w_final[2]));
    }
    return o;
}

void jsonEval(std::ostream& os, const EvalOut& e) {
    Wilson w = wilson(e.correct, e.n);
    os << "{\"n\":" << e.n << ",\"acc\":" << accOf(e)
       << ",\"ci95\":[" << w.lo << "," << w.hi << "],\"per_cue\":["
       << (e.n_cue[0] ? double(e.correct_cue[0]) / e.n_cue[0] : 0.0) << ","
       << (e.n_cue[1] ? double(e.correct_cue[1]) / e.n_cue[1] : 0.0) << "]}";
}

void jsonAgent(std::ostream& os, const AgentOut& a) {
    os << "{\"eval\":";
    jsonEval(os, a.std_eval);
    os << ",\"probe\":{\"n\":" << a.probe.n
       << ",\"acc_first\":" << accOf(a.probe)
       << ",\"acc_last\":" << (a.probe.n ? 1.0 - accOf(a.probe) : 0.0)
       << ",\"ci95_first\":[" << wilson(a.probe.correct, a.probe.n).lo << ","
       << wilson(a.probe.correct, a.probe.n).hi << "]}"
       << ",\"weights\":[" << a.w_final[0] << "," << a.w_final[1] << ","
       << a.w_final[2] << "," << a.w_final[3] << "]"
       << ",\"pair_gap\":" << a.pair_gap
       << ",\"reward_first20\":" << a.reward_first20
       << ",\"reward_last20\":" << a.reward_last20
       << ",\"seq_spikes_aligned\":" << a.seq_spikes_aligned << "}";
}

// Merge evals across seeds for pooled metrics.
void mergeEval(EvalOut& dst, const EvalOut& src) {
    dst.correct += src.correct;
    dst.n += src.n;
    dst.correct_cue[0] += src.correct_cue[0];
    dst.correct_cue[1] += src.correct_cue[1];
    dst.n_cue[0] += src.n_cue[0];
    dst.n_cue[1] += src.n_cue[1];
}

} // namespace

int main(int argc, char** argv) {
    std::string out_path;
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--out" && i + 1 < argc) out_path = argv[++i];
    }
    if (out_path.empty()) {
        std::cerr << "usage: sequential_context_loop --out <report.json>\n";
        return 2;
    }

    struct Pooled {
        EvalOut trained, sham, baseline;
        EvalOut probe_trained;
        double seq_spikes[3] = {0, 0, 0};
        int seq_n[3] = {0, 0, 0};
    };
    std::map<std::string, Pooled> pooled;
    std::map<std::string, std::vector<std::array<AgentOut, 3>>> per_seed;
    std::map<std::string, SeqConfig> cfgs;

    for (const CondSpec& cs : kConds) {
        SeqConfig cfg;
        cfg.seq_steps = cs.K;
        cfg.reward_delay = cs.D;
        cfg.w_self = cs.w_self;
        cfgs[cs.id] = cfg;

        for (unsigned seed : kSeeds) {
            std::array<AgentOut, 3> ags;
            for (int m = 0; m < 3; ++m) ags[m] = runOne(cfg, seed, m);
            per_seed[cs.id].push_back(ags);

            Pooled& p = pooled[cs.id];
            mergeEval(p.trained, ags[0].std_eval);
            mergeEval(p.sham, ags[1].std_eval);
            mergeEval(p.baseline, ags[2].std_eval);
            mergeEval(p.probe_trained, ags[0].probe);
            for (int m = 0; m < 3; ++m) {
                p.seq_spikes[m] += ags[m].seq_spikes_aligned;
                p.seq_n[m] += 1;
            }
        }
    }

    // ---- Criteria (frozen, design §6), pooled over seeds ----
    const EvalOut& C1t = pooled["C1-SHORT"].trained;
    const EvalOut& C1s = pooled["C1-SHORT"].sham;
    const EvalOut& C1b = pooled["C1-SHORT"].baseline;
    const EvalOut& C2t = pooled["C2-LONG"].trained;
    const EvalOut& C2b = pooled["C2-LONG"].baseline;
    const EvalOut& C2p = pooled["C2-LONG"].probe_trained;
    const EvalOut& C3t = pooled["C3-LONG-D8"].trained;
    const EvalOut& C3s = pooled["C3-LONG-D8"].sham;
    const EvalOut& C4t = pooled["C4-ABLATE"].trained;

    struct Crit { std::string id, detail; bool pass; };
    std::vector<Crit> crits;
    {
        double acc = accOf(C1t);
        double pc0 = C1t.n_cue[0] ? double(C1t.correct_cue[0]) / C1t.n_cue[0] : 0.0;
        double pc1 = C1t.n_cue[1] ? double(C1t.correct_cue[1]) / C1t.n_cue[1] : 0.0;
        bool ok = acc >= 0.80 && acc >= accOf(C1b) + 0.25 && pc0 >= 0.75 && pc1 >= 0.75;
        std::ostringstream d;
        d << "acc=" << acc << " base=" << accOf(C1b) << " per_cue=[" << pc0 << "," << pc1 << "]";
        crits.push_back({"L3-A", d.str(), ok});
    }
    {
        double acc = accOf(C2t);
        bool ok = acc >= 0.70 && acc >= accOf(C2b) + 0.20;
        std::ostringstream d;
        d << "acc=" << acc << " base=" << accOf(C2b);
        crits.push_back({"L3-B", d.str(), ok});
    }
    {
        double acc = accOf(C3t);
        bool ok = acc >= 0.60 && acc >= accOf(C3s) + 0.15;
        std::ostringstream d;
        d << "acc=" << acc << " sham=" << accOf(C3s);
        crits.push_back({"L3-C", d.str(), ok});
    }
    {
        double af = accOf(C2p);
        double al = C2p.n ? 1.0 - af : 0.0;
        bool ok = af >= 0.60 && (af - al) >= 0.20;
        std::ostringstream d;
        d << "acc_first=" << af << " acc_last=" << al;
        crits.push_back({"L3-D", d.str(), ok});
    }
    {
        double gap = accOf(C2t) - accOf(C4t);
        bool ok = gap >= 0.20;
        std::ostringstream d;
        d << "acc_C2=" << accOf(C2t) << " acc_C4=" << accOf(C4t) << " gap=" << gap;
        crits.push_back({"L3-E", d.str(), ok});
    }
    {
        double s1 = accOf(pooled["C1-SHORT"].sham);
        double s2 = accOf(pooled["C2-LONG"].sham);
        double s3 = accOf(pooled["C3-LONG-D8"].sham);
        double s4 = accOf(pooled["C4-ABLATE"].sham);
        bool ok = s1 <= 0.65 && s2 <= 0.65 && s3 <= 0.65 && s4 <= 0.65 &&
                  (accOf(C1t) - s1) >= 0.25;
        std::ostringstream d;
        d << "sham=[" << s1 << "," << s2 << "," << s3 << "," << s4
          << "] C1_gap=" << (accOf(C1t) - s1);
        crits.push_back({"L3-F", d.str(), ok});
    }

    bool all = true;
    for (const Crit& c : crits) all = all && c.pass;

    // ---- Report (schema STARK-L3-1) ----
    std::ostringstream js;
    js.setf(std::ios::fixed);
    js.precision(6);
    js << "{\n  \"schema\": \"STARK-L3-1\",\n  \"design\": \"stark/design/sequential_context_milestone.md v1.1\",\n";
    js << "  \"config\": {\"train_trials\":" << kTrain << ",\"eval_trials\":" << kEval
       << ",\"seeds\":[" << kSeeds[0] << "," << kSeeds[1] << "," << kSeeds[2]
       << "],\"tau_e\":8.0,\"tau_pre\":20.0,\"w_max\":0.7,\"w_self\":\"per condition\"},\n";

    js << "  \"conditions\": [\n";
    bool first_cond = true;
    for (const CondSpec& cs : kConds) {
        if (!first_cond) js << ",\n";
        first_cond = false;
        const SeqConfig& cfg = cfgs[cs.id];
        js << "    {\"id\": \"" << cs.id << "\", \"K\":" << cs.K << ", \"D\":" << cs.D
           << ", \"w_self\":" << cs.w_self << ",\n     \"seeds\": [\n";
        const auto& vec = per_seed[cs.id];
        for (size_t s = 0; s < vec.size(); ++s) {
            js << "      {\"master\":" << kSeeds[s]
               << ", \"trained\": "; jsonAgent(js, vec[s][0]);
            js << ", \"sham\": "; jsonAgent(js, vec[s][1]);
            js << ", \"baseline\": "; jsonAgent(js, vec[s][2]);
            js << "}" << (s + 1 < vec.size() ? "," : "") << "\n";
        }
        js << "     ],\n     \"pooled\": {\"trained\": ";
        jsonEval(js, pooled[cs.id].trained);
        js << ", \"sham\": "; jsonEval(js, pooled[cs.id].sham);
        js << ", \"baseline\": "; jsonEval(js, pooled[cs.id].baseline);
        js << ", \"probe_trained\": {\"acc_first\":" << accOf(pooled[cs.id].probe_trained)
           << ", \"acc_last\":" << 1.0 - accOf(pooled[cs.id].probe_trained)
           << ", \"n\":" << pooled[cs.id].probe_trained.n << "},\n"
           << "      \"seq_spikes_aligned\": {\"trained\": "
           << (pooled[cs.id].seq_n[0] ? pooled[cs.id].seq_spikes[0] / pooled[cs.id].seq_n[0] : 0.0)
           << ", \"sham\": "
           << (pooled[cs.id].seq_n[1] ? pooled[cs.id].seq_spikes[1] / pooled[cs.id].seq_n[1] : 0.0)
           << ", \"baseline\": "
           << (pooled[cs.id].seq_n[2] ? pooled[cs.id].seq_spikes[2] / pooled[cs.id].seq_n[2] : 0.0)
           << "}}}";
    }
    js << "\n  ],\n";

    // Length effect and diagnostics (reported, no pass/fail bound).
    js << "  \"length_effect\": {\"C1_minus_C2\":" << (accOf(C1t) - accOf(C2t)) << "},\n";
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

    std::cout << "STARK-L3 sequential-context experiment\n";
    for (const Crit& c : crits) {
        std::cout << "  " << c.id << ": " << (c.pass ? "PASS" : "FAIL") << "  " << c.detail << "\n";
    }
    std::cout << "report: " << out_path << "\nverdict: " << (all ? "PASS" : "FAIL") << "\n";
    return all ? 0 : 1;
}
