// STARK-L10: Context-conditioned memory benchmark (schema STARK-L10-1).
// Frozen protocol: stark/design/context_conditioned_memory_milestone.md v1.0.
//
// Task stream is the L9 stream (identical pi/phi/seed derivation and the same
// 720 learning trials per task); L10 adds the observable cue and the
// bank-selection mechanism. The SEQ-L9 arm is a bit-parity check against the
// published L9 SEQUENTIAL numbers.

#include "learning/ContextConditionedMemory.h"
#include "learning/RelevanceRouting.h"
#include "neural/Network.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <fstream>
#include <iostream>
#include <map>
#include <numeric>
#include <random>
#include <sstream>
#include <string>
#include <vector>

using namespace learning;

namespace {

// ---------------------------------------------------------------- utilities
std::string num(double x) {
    std::ostringstream os;
    os.setf(std::ios::fixed);
    os.precision(6);
    os << x;
    return os.str();
}

double meanOf(const std::vector<double>& v) {
    if (v.empty()) return 0.0;
    return std::accumulate(v.begin(), v.end(), 0.0) / double(v.size());
}

double sdOf(const std::vector<double>& v) {
    if (v.size() < 2) return 0.0;
    const double m = meanOf(v);
    double s = 0.0;
    for (double x : v) s += (x - m) * (x - m);
    return std::sqrt(s / double(v.size() - 1));
}

long peakRssKb() {
    std::ifstream f("/proc/self/status");
    std::string line;
    while (std::getline(f, line))
        if (line.rfind("VmHWM:", 0) == 0) {
            std::istringstream is(line.substr(6));
            long kb = 0;
            is >> kb;
            return kb;
        }
    return -1;
}

// ---------------------------------------------------------------- arm spec
enum EvalCue { CUE_NORMAL = 0, CUE_HELDOUT = 1, CUE_SHUFFLED = 2, CUE_OFF = 3 };

struct ArmSpec {
    std::string name;
    int n_banks = 3;
    bool use_cue = true;
    bool router_learning = true;
    bool seal = true;
    bool probe = true;
    CCBankMode mode = CC_LEARNED;
    EvalCue eval_cue = CUE_NORMAL;
    bool context_controls = false; // also evaluate shuffled/off within this arm
    // Read-only evaluation: snapshot/restore the full agent state around every
    // evaluation so that measuring never perturbs learning. Required for exact
    // determinism and for the acquisition curve. The SEQ-L9 parity arm
    // disables this to reproduce L9's (perturbing) evaluation order verbatim.
    bool read_only_eval = true;
    bool curve = true;             // diagnostic acquisition-curve evals
    int commit_trials = 480;       // commitment window after allocation
};

// ---------------------------------------------------------------- task def
struct TaskDef {
    LRMapping map;
    std::vector<std::pair<int, int>> train_cues;
    std::vector<std::pair<int, int>> holdout_cues;
};

// Cue structure (frozen design 4.1): signature groups of 4 features per task;
// 4 training pairs, 2 held-out pairs. Every held-out feature also occurs in a
// training pair of the same signature group.
TaskDef makeTaskDef(unsigned master, int t, int n_ids, int n_ctx) {
    TaskDef d;
    // L9 derivation: pi_k from master + {0, 10007, 20011}; the trial stream
    // uses master + k*1000 (see makeTaskTrials). phi is taken from task 1.
    const unsigned map_seed = master + ((t == 0) ? 0u : (t == 1) ? 10007u : 20011u);
    d.map = makeLRMapping(map_seed, n_ids, n_ctx);
    const int b = 4 * t;
    d.train_cues = {{b + 0, b + 1}, {b + 0, b + 2}, {b + 0, b + 3}, {b + 1, b + 2}};
    d.holdout_cues = {{b + 1, b + 3}, {b + 2, b + 3}};
    return d;
}

std::vector<int> cueVec(std::pair<int, int> c) { return {c.first, c.second}; }

// ---------------------------------------------------------------- schedules
// L9 training stream for one task: 80 single + 40 pair trials per identity.
std::vector<LRTrialSchedule> makeTaskTrials(const LRConfig& cfg, const LRMapping& map,
                                            unsigned seed) {
    std::vector<LRTrialSchedule> all;
    auto p1 = makeLRTrials(cfg, map, 80, 0, seed);
    auto p2 = makeLRTrials(cfg, map, 0, 40, seed + 1);
    all.insert(all.end(), p1.begin(), p1.end());
    all.insert(all.end(), p2.begin(), p2.end());
    return all;
}

// Probe pool: 10 single-candidate trials per identity (60), split round-robin
// over the K banks (20 measurement trials per bank).
std::vector<LRTrialSchedule> makeProbePool(const LRConfig& cfg, const LRMapping& map,
                                           unsigned seed) {
    return makeLRTrials(cfg, map, 10, 0, seed);
}

// ---------------------------------------------------------------- results
struct TaskEvalRes {
    double acc = 0.0;
    int n = 0, correct = 0;
    double routing_acc = 0.0; // argmax bank == the bank holding this task
    int routing_n = 0, routing_correct = 0;
};

struct SeedRun {
    std::vector<TaskEvalRes> acq;               // [task]
    std::vector<std::vector<TaskEvalRes>> ret;  // [task][step]
    std::vector<TaskEvalRes> holdout;           // [task]
    std::vector<TaskEvalRes> shuffled;          // [task] (context controls)
    std::vector<TaskEvalRes> ctx_off;           // [task]
    std::vector<std::vector<double>> curve;     // [task] diagnostic checkpoints
    std::vector<double> curve_frac;             // checkpoint fractions
    std::vector<double> acq_speed;              // [task] trials to reach 0.80 (-1 = not reached)
    double mean_U = 0.0, mean_I_rows = 0.0, mean_I_banks = 0.0;
    std::vector<int> task_bank;                 // bank holding each task (-1 if none)
    int n_allocations = 0;
    double final_route_t1 = 0.0;                // routing state v diagnostic
    bool save_reload_state = false, save_reload_choices = false;
    bool determinism_intra = false;             // second in-process replay identical
    double seconds = 0.0;
    std::vector<double> final_frame;            // compact per-task final accuracies
    std::vector<std::vector<double>> router;    // [feat][bank] final router weights
    std::vector<int> bank_state;                // final bank lifecycle state
};

struct Bench {
    CCAgent agent;
    std::vector<std::vector<LRTrialSchedule>> trials;   // [task][train trial]
    std::vector<std::vector<int>> cue_assignment;       // [task][train trial] -> index into train_cues
    std::vector<LRMapping> maps;
    std::vector<int> task_bank;
};

// cue index per training trial, deterministic from (master, task)
std::vector<int> makeCueAssignment(const TaskDef& d, size_t n_trials, unsigned seed) {
    std::mt19937 rng(seed);
    std::uniform_int_distribution<int> pick(0, static_cast<int>(d.train_cues.size()) - 1);
    std::vector<int> a(n_trials);
    for (size_t i = 0; i < n_trials; ++i) a[i] = pick(rng);
    return a;
}

CCTrialSchedule withCue(const LRTrialSchedule& lr, const std::vector<int>& cue) {
    CCTrialSchedule s;
    s.lr = lr;
    s.cue = cue;
    return s;
}

// ---------------------------------------------------------------- evaluation
// Evaluates one task with a cue policy. Learning disabled => no weight change.
TaskEvalRes evalTask(CCAgent& ag, const Bench& bench, int task,
                     unsigned seed, EvalCue cue_mode, int task_bank,
                     bool want_routing, unsigned shuffle_seed,
                     CCBankMode bank_mode = CC_LEARNED, bool read_only = true) {
    TaskEvalRes te;
    std::string snapshot;
    if (read_only) snapshot = ccSerialize(ag);
    auto sched = makeLRTrials(ag.cfg.lr, bench.maps[static_cast<size_t>(task)], 0, 20, seed);
    std::mt19937 rng_shuffle(shuffle_seed);
    // cue sequence for NORMAL / HELDOUT / OFF
    std::mt19937 rng_cue(seed ^ 0x5bd1e995u);
    std::uniform_int_distribution<int> pick_train(0, 3);
    for (const auto& lr : sched) {
        std::vector<int> cue;
        switch (cue_mode) {
            case CUE_NORMAL: {
                const int b = 4 * task;
                const int idx = pick_train(rng_cue);
                const std::pair<int, int> pairs[4] = {{b + 0, b + 1}, {b + 0, b + 2},
                                                      {b + 0, b + 3}, {b + 1, b + 2}};
                cue = cueVec(pairs[idx]);
                break;
            }
            case CUE_HELDOUT: {
                const int b = 4 * task;
                const int idx = pick_train(rng_cue) & 1;
                const std::pair<int, int> pairs[2] = {{b + 1, b + 3}, {b + 2, b + 3}};
                cue = cueVec(pairs[idx]);
                break;
            }
            case CUE_SHUFFLED: {
                // cue from a DIFFERENT task (seeded)
                std::vector<int> others;
                for (int t = 0; t < 3; ++t)
                    if (t != task) others.push_back(t);
                std::uniform_int_distribution<int> pick_other(0, (int)others.size() - 1);
                const int ot = others[static_cast<size_t>(pick_other(rng_shuffle))];
                const int b = 4 * ot;
                const std::pair<int, int> pairs[4] = {{b + 0, b + 1}, {b + 0, b + 2},
                                                      {b + 0, b + 3}, {b + 1, b + 2}};
                std::uniform_int_distribution<int> pick_pair(0, 3);
                cue = cueVec(pairs[pick_pair(rng_shuffle)]);
                break;
            }
            case CUE_OFF:
            default:
                cue.clear();
                break;
        }
        CCTrialSchedule s = withCue(lr, cue);
        CCResult r = runCCTrial(ag, s, bench.maps[static_cast<size_t>(task)], task_bank,
                                bank_mode, /*learning=*/false, /*router_learning=*/false);
        ++te.n;
        if (r.choice == bench.maps[static_cast<size_t>(task)].perm[static_cast<size_t>(r.queried)]) ++te.correct;
        if (want_routing && task_bank >= 0) {
            ++te.routing_n;
            if (r.bank == task_bank) ++te.routing_correct;
        }
    }
    te.acc = te.n ? double(te.correct) / te.n : 0.0;
    te.routing_acc = te.routing_n ? double(te.routing_correct) / te.routing_n : 0.0;
    if (read_only) ccDeserialize(ag, snapshot);
    return te;
}

// ---------------------------------------------------------------- one arm/seed
SeedRun runArm(const ArmSpec& spec, unsigned master, const std::vector<int>& masters_unused) {
    (void)masters_unused;
    const clock_t t0 = clock();
    SeedRun out;

    CCConfig cfg;
    cfg.lr.n_ids = 6;
    cfg.lr.n_chan = 2;
    cfg.lr.n_ctx = 2;
    cfg.lr.softmax_T = 1.0 / std::sqrt(double(cfg.lr.n_chan)) / 2.0; // L9 F2a
    cfg.n_banks = spec.n_banks;
    cfg.n_feat = 12;
    cfg.seal_superseded = spec.seal;

    // ---- 3 tasks (L9 derivation: master, +10007, +20011; shared phi) ----
    std::vector<TaskDef> tasks(3);
    for (int t = 0; t < 3; ++t) tasks[static_cast<size_t>(t)] = makeTaskDef(master, t, cfg.lr.n_ids, cfg.lr.n_ctx);
    tasks[1].map.phi = tasks[0].map.phi;
    tasks[2].map.phi = tasks[0].map.phi;

    Bench bench;
    bench.maps = {tasks[0].map, tasks[1].map, tasks[2].map};
    bench.trials.resize(3);
    bench.cue_assignment.resize(3);
    bench.task_bank.assign(3, -1);

    CCAgent ag = makeCCAgent(cfg, true);

    // Bank 0 is active from the start for K=1 (L9 parity); otherwise the first
    // task's probe allocates it.
    if (spec.n_banks == 1) ag.bank_state[0] = CC_ACTIVE;

    out.acq.resize(3);
    out.ret.assign(3, std::vector<TaskEvalRes>(3));
    out.holdout.resize(3);
    out.shuffled.resize(3);
    out.ctx_off.resize(3);
    out.curve.assign(3, {});
    out.acq_speed.assign(3, -1.0);
    out.task_bank.assign(3, -1);

    const double kCurveFracs[7] = {0.0, 0.1667, 0.3333, 0.5, 0.6667, 0.8333, 1.0};
    for (double f : kCurveFracs) out.curve_frac.push_back(f);

    for (int t = 0; t < 3; ++t) {
        const TaskDef& td = tasks[static_cast<size_t>(t)];
        bench.trials[static_cast<size_t>(t)] = makeTaskTrials(cfg.lr, td.map, master + static_cast<unsigned>(t) * 1000u);
        bench.cue_assignment[static_cast<size_t>(t)] =
            makeCueAssignment(td, bench.trials[static_cast<size_t>(t)].size(), master + 6001u + static_cast<unsigned>(t));

        // ---- probe + allocation (architecture-supplied resource rule) ----
        if (spec.probe) {
            auto pool = makeProbePool(cfg.lr, td.map, master + 6100u + static_cast<unsigned>(t));
            // Probe = the agent measuring its own banks on the current input
            // stream: forced bank, plasticity off (learning disabled), no
            // router update. No task label, no answer key.
            std::vector<double> rew(static_cast<size_t>(spec.n_banks), 0.0);
            std::vector<int> cnt(static_cast<size_t>(spec.n_banks), 0);
            for (size_t i = 0; i < pool.size(); ++i) {
                const int bank = static_cast<int>(i) % spec.n_banks;
                CCTrialSchedule s = withCue(pool[i], cueVec(td.train_cues[i % td.train_cues.size()]));
                CCResult r = runCCTrial(ag, s, td.map, bank, CC_ORACLE,
                                        /*learning=*/false, /*router_learning=*/false);
                rew[static_cast<size_t>(bank)] += r.reward;
                ++cnt[static_cast<size_t>(bank)];
            }
            int best = 0;
            for (int k = 1; k < spec.n_banks; ++k)
                if (rew[static_cast<size_t>(k)] > rew[static_cast<size_t>(best)]) best = k;
            const double best_rew = cnt[static_cast<size_t>(best)] ? rew[static_cast<size_t>(best)] / cnt[static_cast<size_t>(best)] : -1.0;
            const bool familiar = (ag.bank_state[static_cast<size_t>(best)] != CC_UNALLOCATED) &&
                                  (best_rew >= cfg.theta_alloc);
            if (familiar) {
                // Reuse the recognised bank; seal the others if sealing is on.
                for (int k = 0; k < spec.n_banks; ++k)
                    if (k != best && ag.bank_state[static_cast<size_t>(k)] == CC_ACTIVE) ag.bank_state[static_cast<size_t>(k)] = CC_SEALED;
                if (ag.bank_state[static_cast<size_t>(best)] != CC_ACTIVE)
                    ag.bank_state[static_cast<size_t>(best)] = CC_ACTIVE;
            } else {
                int nb = ccAllocateNext(ag, cfg.seal_superseded);
                if (nb < 0) {
                    // capacity exhausted: reuse the lowest-scoring allocated bank
                    int worst = 0;
                    for (int k = 1; k < spec.n_banks; ++k)
                        if (rew[static_cast<size_t>(k)] < rew[static_cast<size_t>(worst)]) worst = k;
                    ag.bank_state[static_cast<size_t>(worst)] = CC_ACTIVE;
                    if (cfg.seal_superseded)
                        for (int k = 0; k < spec.n_banks; ++k)
                            if (k != worst && ag.bank_state[static_cast<size_t>(k)] == CC_SEALED) ag.bank_state[static_cast<size_t>(k)] = CC_ACTIVE;
                    nb = worst;
                }
                ++out.n_allocations;
                (void)nb;
            }
        }

        const int active = ccActiveBank(ag);
        bench.task_bank[static_cast<size_t>(t)] = active;
        out.task_bank[static_cast<size_t>(t)] = active;

        // ---- training: phase 1 (mapping credit) then phase 2 (selection) ----
        size_t next_ckpt = 0;
        const std::vector<double> ckpt_trials = {0.0, 120.0, 240.0, 360.0, 480.0, 600.0};
        double sumU = 0.0, sumI_rows = 0.0, sumI_banks = 0.0;
        int nU = 0;
        bool speed_found = false;

        for (size_t i = 0; i < bench.trials[static_cast<size_t>(t)].size(); ++i) {
            if (spec.curve && next_ckpt < ckpt_trials.size() && double(i) >= ckpt_trials[next_ckpt]) {
                ++next_ckpt;
                // diagnostic checkpoint (learning disabled)
                TaskEvalRes ck = evalTask(ag, bench, t, master + 7000u + static_cast<unsigned>(t) * 31u + static_cast<unsigned>(i),
                                          spec.use_cue ? CUE_NORMAL : CUE_OFF, bench.task_bank[static_cast<size_t>(t)],
                                          false, master + 991u, spec.mode, spec.read_only_eval);
                out.curve[static_cast<size_t>(t)].push_back(ck.acc);
                if (!speed_found && ck.acc >= 0.80) {
                    out.acq_speed[static_cast<size_t>(t)] = double(i);
                    speed_found = true;
                }
            }
            const LRTrialSchedule& lr = bench.trials[static_cast<size_t>(t)][i];
            std::vector<int> cue;
            if (spec.use_cue) {
                const int ci = bench.cue_assignment[static_cast<size_t>(t)][i];
                cue = cueVec(tasks[static_cast<size_t>(t)].train_cues[static_cast<size_t>(ci)]);
            }
            CCTrialSchedule s = withCue(lr, cue);

            // weight-update mass on phase-1 mapping trials
            const bool measure = (i < 480) && lr.single;
            std::vector<std::vector<std::vector<double>>> w0;
            int sel_bank = -1;
            if (measure) w0 = ccBankWeights(ag);

            const bool commit = (spec.commit_trials > 0) &&
                                (static_cast<int>(i) < spec.commit_trials) &&
                                bench.task_bank[static_cast<size_t>(t)] >= 0;
            CCResult r = runCCTrial(ag, s, tasks[static_cast<size_t>(t)].map,
                                    spec.mode == CC_ORACLE ? bench.task_bank[static_cast<size_t>(t)] : -1,
                                    spec.mode, /*learning=*/true,
                                    spec.router_learning && !commit,
                                    commit ? bench.task_bank[static_cast<size_t>(t)] : -1);
            sel_bank = r.bank;

            if (measure && w0.size() == ag.syn.size()) {
                auto w1 = ccBankWeights(ag);
                double U = 0.0, Ir = 0.0, Ib = 0.0;
                for (size_t k = 0; k < ag.syn.size(); ++k)
                    for (size_t ii = 0; ii < ag.syn[k].size(); ++ii)
                        for (size_t rr = 0; rr < ag.syn[k][ii].size(); ++rr) {
                            const double dw = std::fabs(w1[k][ii][rr] - w0[k][ii][rr]);
                            if (static_cast<int>(k) != sel_bank) { Ib += dw; continue; }
                            if (static_cast<int>(ii) == r.queried) Ir += dw; else U += dw;
                        }
                sumU += U; sumI_rows += Ir; sumI_banks += Ib;
                ++nU;
            }
        }
        // final curve point (after all 720 learning trials), normal cue
        {
            TaskEvalRes ck = evalTask(ag, bench, t, master + 8000u + static_cast<unsigned>(t) * 37u,
                                      spec.use_cue ? CUE_NORMAL : CUE_OFF,
                                      bench.task_bank[static_cast<size_t>(t)], false, master + 992u,
                                      spec.mode, spec.read_only_eval);
            out.curve[static_cast<size_t>(t)].push_back(ck.acc);
            if (!speed_found && ck.acc >= 0.80) {
                out.acq_speed[static_cast<size_t>(t)] = 720.0;
            }
        }
        if (nU > 0) {
            out.mean_U += sumU / nU;
            out.mean_I_rows += sumI_rows / nU;
            out.mean_I_banks += sumI_banks / nU;
        }

        // ---- acquisition + retention evaluations ----
        out.acq[static_cast<size_t>(t)] = evalTask(ag, bench, t, master + 5001u + static_cast<unsigned>(t),
                                                   spec.eval_cue, bench.task_bank[static_cast<size_t>(t)],
                                                   true, master + 900u + static_cast<unsigned>(t), spec.mode, spec.read_only_eval);
        for (int prev = 0; prev < t; ++prev) {
            out.ret[static_cast<size_t>(prev)][static_cast<size_t>(t)] =
                evalTask(ag, bench, prev, master + 5001u + static_cast<unsigned>(prev),
                         spec.eval_cue, bench.task_bank[static_cast<size_t>(prev)], true,
                         master + 900u + static_cast<unsigned>(t), spec.mode, spec.read_only_eval);
        }
    }

    // ---- held-out cue combinations (never used in training) ----
    for (int t = 0; t < 3; ++t) {
        out.holdout[static_cast<size_t>(t)] =
            evalTask(ag, bench, t, master + 8001u + static_cast<unsigned>(t), CUE_HELDOUT,
                     bench.task_bank[static_cast<size_t>(t)], true, master + 9300u + static_cast<unsigned>(t), spec.mode, spec.read_only_eval);
    }

    // ---- context controls (measured once ALL banks exist, so that the
    // withheld-context condition cannot be answered by a single candidate) ----
    if (spec.context_controls) {
        for (int t = 0; t < 3; ++t) {
            out.shuffled[static_cast<size_t>(t)] =
                evalTask(ag, bench, t, master + 5001u + static_cast<unsigned>(t), CUE_SHUFFLED,
                         bench.task_bank[static_cast<size_t>(t)], true,
                         master + 9100u + static_cast<unsigned>(t), spec.mode, spec.read_only_eval);
            out.ctx_off[static_cast<size_t>(t)] =
                evalTask(ag, bench, t, master + 5001u + static_cast<unsigned>(t), CUE_OFF,
                         bench.task_bank[static_cast<size_t>(t)], true,
                         master + 9200u + static_cast<unsigned>(t), spec.mode, spec.read_only_eval);
        }
    }

    // ---- persistence ----
    {
        const std::string snap = ccSerialize(ag);
        CCAgent ag2 = makeCCAgent(cfg, true);
        ccDeserialize(ag2, snap);
        out.save_reload_state = (snap == ccSerialize(ag2));
        TaskEvalRes e1 = evalTask(ag, bench, 0, master + 7001u, spec.eval_cue, bench.task_bank[0], false, master + 77u, spec.mode, spec.read_only_eval);
        TaskEvalRes e2 = evalTask(ag2, bench, 0, master + 7001u, spec.eval_cue, bench.task_bank[0], false, master + 77u, spec.mode, spec.read_only_eval);
        out.save_reload_choices = (e1.correct == e2.correct && e1.n == e2.n);
    }

    out.final_frame = {out.ret[0][2].acc, out.ret[1][2].acc, out.acq[2].acc};
    out.router = ccRouterWeights(ag);
    out.bank_state = ag.bank_state;
    out.final_route_t1 = ag.net.getSynapse(ag.route[0][0]).getWeight();
    out.seconds = double(clock() - t0) / CLOCKS_PER_SEC;
    return out;
}

// ---------------------------------------------------------------- self tests
// Save/load + checkpoint-resume equivalence (learning-disabled comparison of
// the full post-training eval frame, plus bit-identical serialized state).
struct SelfTest {
    bool load_state_identical = false;
    bool load_choices_identical = false;
    bool checkpoint_resume_identical = false;
    int checkpoint_trial = -1;
    std::string state_md5_free_hash; // simple length+checksum signature
};

std::string stateSignature(const std::string& s) {
    unsigned long long h = 1469598103934665603ULL;
    for (unsigned char c : s) { h ^= c; h *= 1099511628211ULL; }
    std::ostringstream os;
    os << std::hex << h << ":" << std::dec << s.size();
    return os.str();
}

SelfTest runSelfTest(unsigned master) {
    SelfTest st;
    CCConfig cfg;
    cfg.lr.n_ids = 6;
    cfg.lr.n_chan = 2;
    cfg.lr.n_ctx = 2;
    cfg.lr.softmax_T = 1.0 / std::sqrt(2.0) / 2.0;
    cfg.n_banks = 3;
    cfg.n_feat = 12;

    std::vector<TaskDef> tasks(3);
    for (int t = 0; t < 3; ++t) tasks[static_cast<size_t>(t)] = makeTaskDef(master, t, 6, 2);
    tasks[1].map.phi = tasks[0].map.phi;
    tasks[2].map.phi = tasks[0].map.phi;

    std::vector<std::vector<LRTrialSchedule>> trials(3);
    std::vector<std::vector<int>> cues(3);
    for (int t = 0; t < 3; ++t) {
        trials[static_cast<size_t>(t)] = makeTaskTrials(cfg.lr, tasks[static_cast<size_t>(t)].map,
                                                        master + static_cast<unsigned>(t) * 1000u);
        cues[static_cast<size_t>(t)] = makeCueAssignment(tasks[static_cast<size_t>(t)],
                                                         trials[static_cast<size_t>(t)].size(),
                                                         master + 6001u + static_cast<unsigned>(t));
    }

    // Reference: uninterrupted run over task 1 (probe + 720 trials), bank 0.
    CCAgent ref = makeCCAgent(cfg, true);
    ref.bank_state[0] = CC_ACTIVE;
    const int cut = 360; // checkpoint inside task 1 phase 1
    for (int i = 0; i < cut; ++i) {
        CCTrialSchedule s = withCue(trials[0][static_cast<size_t>(i)],
                                    cueVec(tasks[0].train_cues[static_cast<size_t>(cues[0][static_cast<size_t>(i)])]));
        runCCTrial(ref, s, tasks[0].map, -1, CC_LEARNED, true, true);
    }
    st.checkpoint_trial = cut;
    const std::string snap = ccSerialize(ref);

    // Save/load equivalence
    CCAgent loaded = makeCCAgent(cfg, true);
    ccDeserialize(loaded, snap);
    st.load_state_identical = (ccSerialize(loaded) == snap);
    st.state_md5_free_hash = stateSignature(snap);

    // Continue both to the end of task 1 and compare the full eval frame.
    CCAgent a = makeCCAgent(cfg, true);
    ccDeserialize(a, snap);
    for (int i = cut; i < 720; ++i) {
        CCTrialSchedule s = withCue(trials[0][static_cast<size_t>(i)],
                                    cueVec(tasks[0].train_cues[static_cast<size_t>(cues[0][static_cast<size_t>(i)])]));
        runCCTrial(a, s, tasks[0].map, -1, CC_LEARNED, true, true);
    }
    for (int i = cut; i < 720; ++i) {
        CCTrialSchedule s = withCue(trials[0][static_cast<size_t>(i)],
                                    cueVec(tasks[0].train_cues[static_cast<size_t>(cues[0][static_cast<size_t>(i)])]));
        runCCTrial(ref, s, tasks[0].map, -1, CC_LEARNED, true, true);
    }
    st.checkpoint_resume_identical = (ccSerialize(a) == ccSerialize(ref));

    // Eval-choice equivalence on the reloaded agent
    Bench bench;
    bench.maps = {tasks[0].map, tasks[1].map, tasks[2].map};
    bench.task_bank.assign(3, -1);
    TaskEvalRes e1 = evalTask(ref, bench, 0, master + 7001u, CUE_NORMAL, 0, false, master + 77u);
    TaskEvalRes e2 = evalTask(a, bench, 0, master + 7001u, CUE_NORMAL, 0, false, master + 77u);
    st.load_choices_identical = (e1.correct == e2.correct && e1.n == e2.n);
    return st;
}

// ---------------------------------------------------------------- reporting
std::string jsonArm(const ArmSpec& spec, const std::vector<SeedRun>& runs,
                    const std::vector<unsigned>& masters, const std::string& indent) {
    std::ostringstream js;
    js << indent << "\"" << spec.name << "\": {\n";
    // per-seed
    js << indent << "  \"per_seed\": [\n";
    for (size_t si = 0; si < runs.size(); ++si) {
        const SeedRun& r = runs[si];
        js << indent << "    { \"master\": " << masters[si]
           << ", \"acq\": [" << num(r.acq[0].acc) << "," << num(r.acq[1].acc) << "," << num(r.acq[2].acc) << "]"
           << ", \"ret_t1_t2\": " << num(r.ret[0][1].acc)
           << ", \"ret_t1_t3\": " << num(r.ret[0][2].acc)
           << ", \"ret_t2_t3\": " << num(r.ret[1][2].acc)
           << ", \"final_avg\": " << num(meanOf(r.final_frame))
           << ", \"routing\": [" << num(r.acq[0].routing_acc) << "," << num(r.acq[1].routing_acc)
           << "," << num(r.acq[2].routing_acc) << "]"
           << ", \"holdout\": [" << num(r.holdout[0].acc) << "," << num(r.holdout[1].acc)
           << "," << num(r.holdout[2].acc) << "]"
           << ", \"shuffled\": " << (spec.context_controls
                  ? ("[" + num(r.shuffled[0].acc) + "," + num(r.shuffled[1].acc) + "," +
                     num(r.shuffled[2].acc) + "]")
                  : std::string("null"))
           << ", \"ctx_off\": " << (spec.context_controls
                  ? ("[" + num(r.ctx_off[0].acc) + "," + num(r.ctx_off[1].acc) + "," +
                     num(r.ctx_off[2].acc) + "]")
                  : std::string("null"))
           << ", \"update_mass\": {\"intended_rows\": " << num(r.mean_I_rows)
           << ", \"unintended_rows\": " << num(r.mean_U)
           << ", \"unintended_banks\": " << num(r.mean_I_banks) << "}"
           << ", \"task_bank\": [" << r.task_bank[0] << "," << r.task_bank[1] << "," << r.task_bank[2] << "]"
           << ", \"allocations\": " << r.n_allocations
           << ", \"curve\": [";
        bool first = true;
        for (int t = 0; t < 3; ++t) {
            for (size_t k = 0; k < r.curve[static_cast<size_t>(t)].size(); ++k) {
                if (!first) js << ",";
                js << num(r.curve[static_cast<size_t>(t)][k]);
                first = false;
            }
        }
        js << "]"
           << ", \"curve_layout\": \"task-major, 6 checkpoints each\""
           << ", \"acq_speed_trials\": [" << num(r.acq_speed[0]) << "," << num(r.acq_speed[1])
           << "," << num(r.acq_speed[2]) << "]"
           << ", \"persist_state\": " << (r.save_reload_state ? "true" : "false")
           << ", \"persist_choices\": " << (r.save_reload_choices ? "true" : "false")
           << ", \"router\": [";
        {
            bool f1 = true;
            for (size_t fi = 0; fi < r.router.size(); ++fi)
                for (size_t bi = 0; bi < r.router[fi].size(); ++bi) {
                    if (!f1) js << ",";
                    js << num(r.router[fi][bi]);
                    f1 = false;
                }
        }
        js << "]"
           << ", \"bank_state\": [";
        for (size_t bi = 0; bi < r.bank_state.size(); ++bi) {
            if (bi) js << ",";
            js << r.bank_state[bi];
        }
        js << "]"
           << ", \"seconds\": " << num(r.seconds) << " }";
        if (si + 1 < runs.size()) js << ",";
        js << "\n";
    }
    js << indent << "  ],\n";

    // pooled
    std::vector<double> acq[3], forget[3], final_avg, routing[3], holdout[3], shuffled, ctx_off;
    std::vector<double> u_rows, u_banks, u_other_rows;
    for (const SeedRun& r : runs) {
        for (int t = 0; t < 3; ++t) {
            acq[t].push_back(r.acq[static_cast<size_t>(t)].acc);
            const double final_ret = (t == 2) ? r.acq[2].acc : r.ret[static_cast<size_t>(t)][2].acc;
            forget[t].push_back(r.acq[static_cast<size_t>(t)].acc - final_ret);
            routing[t].push_back(r.acq[static_cast<size_t>(t)].routing_acc);
            holdout[t].push_back(r.holdout[static_cast<size_t>(t)].acc);
        }
        final_avg.push_back(meanOf(r.final_frame));
        for (int t = 0; t < 3; ++t) {
            shuffled.push_back(r.shuffled[static_cast<size_t>(t)].acc);
            ctx_off.push_back(r.ctx_off[static_cast<size_t>(t)].acc);
        }
        u_rows.push_back(r.mean_I_rows);
        u_banks.push_back(r.mean_I_banks);
        u_other_rows.push_back(r.mean_U);
    }
    std::vector<double> mean_forget;
    {
        std::vector<double> mf;
        for (size_t si = 0; si < runs.size(); ++si)
            mf.push_back((forget[0][si] + forget[1][si] + forget[2][si]) / 3.0);
        mean_forget = mf;
    }
    js << indent << "  \"pooled\": {\n";
    js << indent << "    \"acquisition_mean\": [" << num(meanOf(acq[0])) << "," << num(meanOf(acq[1]))
       << "," << num(meanOf(acq[2])) << "],\n";
    js << indent << "    \"acquisition_sd\": [" << num(sdOf(acq[0])) << "," << num(sdOf(acq[1]))
       << "," << num(sdOf(acq[2])) << "],\n";
    js << indent << "    \"forgetting_mean\": [" << num(meanOf(forget[0])) << "," << num(meanOf(forget[1]))
       << "," << num(meanOf(forget[2])) << "],\n";
    js << indent << "    \"mean_forgetting\": " << num(meanOf(mean_forget))
       << ", \"mean_forgetting_sd\": " << num(sdOf(mean_forget)) << ",\n";
    js << indent << "    \"final_avg_mean\": " << num(meanOf(final_avg))
       << ", \"final_avg_sd\": " << num(sdOf(final_avg)) << ",\n";
    js << indent << "    \"routing_mean\": [" << num(meanOf(routing[0])) << "," << num(meanOf(routing[1]))
       << "," << num(meanOf(routing[2])) << "],\n";
    js << indent << "    \"holdout_mean\": [" << num(meanOf(holdout[0])) << "," << num(meanOf(holdout[1]))
       << "," << num(meanOf(holdout[2])) << "],\n";
    // These two controls are only evaluated for arms that request them
    // (spec.context_controls). Emitting 0.0 for an arm that never ran them
    // would be indistinguishable from a measured 0% (fixed in L10 validation).
    js << indent << "    \"context_controls_measured\": "
       << (spec.context_controls ? "true" : "false") << ",\n";
    js << indent << "    \"shuffled_cue_mean\": "
       << (spec.context_controls ? num(meanOf(shuffled)) : std::string("null")) << ",\n";
    js << indent << "    \"context_off_mean\": "
       << (spec.context_controls ? num(meanOf(ctx_off)) : std::string("null")) << ",\n";
    js << indent << "    \"update_mass\": {\"intended_rows\": " << num(meanOf(u_rows))
       << ", \"unintended_rows\": " << num(meanOf(u_other_rows))
       << ", \"unintended_banks\": " << num(meanOf(u_banks)) << "},\n";
    js << indent << "    \"persistence_state_all\": "
       << ([&] { for (auto& r : runs) if (!r.save_reload_state) return false; return true; }() ? "true" : "false")
       << ",\n";
    js << indent << "    \"persistence_choices_all\": "
       << ([&] { for (auto& r : runs) if (!r.save_reload_choices) return false; return true; }() ? "true" : "false")
       << "\n";
    js << indent << "  }\n";
    js << indent << "}";
    return js.str();
}

} // namespace

int main(int argc, char** argv) {
    std::string out_json = "work/dev_context_conditioned_memory_report_STARK-L10-1.json";
    std::string raw_out = "work/l10_raw";
    for (int i = 1; i < argc; ++i) {
        if (std::strcmp(argv[i], "--json") == 0 && i + 1 < argc) out_json = argv[++i];
        else if (std::strcmp(argv[i], "--raw") == 0 && i + 1 < argc) raw_out = argv[++i];
    }

    bool dev_mode = false;
    for (int i = 1; i < argc; ++i)
        if (std::strcmp(argv[i], "--dev") == 0) dev_mode = true;
    // Dev seed: used only for mechanism development, never part of the frozen
    // evaluation set.
    std::vector<unsigned> masters = {123456789u, 218213831u, 171473193u};
    if (dev_mode) masters = {987654321u};

    std::vector<ArmSpec> arms;
    {
        ArmSpec a;
        a.name = "SEQ-L9"; a.n_banks = 1; a.use_cue = false; a.router_learning = false;
        a.seal = false; a.probe = false; a.mode = CC_LEARNED;
        a.read_only_eval = false; a.curve = false; a.commit_trials = 0; arms.push_back(a);

        a = ArmSpec(); a.name = "CCM"; arms.push_back(a);

        a = ArmSpec(); a.name = "ORACLE-BANK"; a.mode = CC_ORACLE; a.router_learning = false;
        arms.push_back(a);

        a = ArmSpec(); a.name = "SHUFFLED-CUE"; a.eval_cue = CUE_SHUFFLED; arms.push_back(a);

        a = ArmSpec(); a.name = "CONTEXT-OFF"; a.eval_cue = CUE_OFF; arms.push_back(a);

        a = ArmSpec(); a.name = "NO-SEAL"; a.seal = false; arms.push_back(a);

        a = ArmSpec(); a.name = "K2-STRESS"; a.n_banks = 2; arms.push_back(a);

        a = ArmSpec(); a.name = "FROZEN-ROUTER"; a.router_learning = false; arms.push_back(a);
    }
    // the CCM arm also carries the within-arm context controls
    arms[1].context_controls = true;

    std::map<std::string, std::vector<SeedRun>> results;
    const clock_t t_start = clock();
    for (const ArmSpec& spec : arms) {
        std::cerr << "[arm] " << spec.name << " ..." << std::flush;
        std::vector<SeedRun> runs;
        for (unsigned m : masters) runs.push_back(runArm(spec, m, {}));
        results[spec.name] = runs;
        std::cerr << " done\n";
    }
    const double total_seconds = double(clock() - t_start) / CLOCKS_PER_SEC;
    SelfTest st = runSelfTest(masters[0]);

    // ---- JSON report ----
    std::ostringstream js;
    js << "{\n";
    js << "  \"schema\": \"STARK-L10-1\",\n";
    js << "  \"design\": \"Context-conditioned memory and continual learning\",\n";
    js << "  \"protocol\": \"stark/design/context_conditioned_memory_milestone.md v1.0 (frozen before evaluation)\",\n";
    js << "  \"baseline\": \"STARK-L9 continual_learning_loop (report STARK-L9-1)\",\n";
    js << "  \"n_ids\": 6, \"n_chan\": 2, \"n_ctx\": 2, \"n_feat\": 12,\n";
    js << "  \"masters\": [123456789, 218213831, 171473193],\n";
    js << "  \"task_sequence\": \"3 tasks, distinct pi, shared phi, 720 learning trials/task (80 single + 40 selection per identity); L10 adds a 60-trial bank probe per task\",\n";
    js << "  \"cue_structure\": \"12 features, signature groups of 4 per task; 4 training pairs, 2 held-out pairs per task\",\n";
    js << "  \"curve_checkpoints_trials\": [0,120,240,360,480,600,720],\n";
    js << "  \"arms\": [";
    for (size_t i = 0; i < arms.size(); ++i) js << "\"" << arms[i].name << "\"" << (i + 1 < arms.size() ? "," : "");
    js << "],\n";
    js << "  \"results\": {\n";
    for (size_t i = 0; i < arms.size(); ++i) {
        js << jsonArm(arms[i], results[arms[i].name], masters, "    ");
        js << (i + 1 < arms.size() ? ",\n" : "\n");
    }
    js << "  },\n";

    // ---- criteria ----
    auto P = [&](const std::string& arm) { return results[arm]; };
    auto meanForget = [&](const std::string& arm) {
        std::vector<double> v;
        for (const SeedRun& r : P(arm)) {
            double f = 0.0;
            for (int t = 0; t < 3; ++t)
                f += r.acq[static_cast<size_t>(t)].acc -
                     ((t == 2) ? r.acq[2].acc : r.ret[static_cast<size_t>(t)][2].acc);
            v.push_back(f / 3.0);
        }
        return meanOf(v);
    };
    auto meanFinal = [&](const std::string& arm) {
        std::vector<double> v;
        for (const SeedRun& r : P(arm)) v.push_back(meanOf(r.final_frame));
        return meanOf(v);
    };
    auto minAcq = [&](const std::string& arm) {
        double m = 1.0;
        for (const SeedRun& r : P(arm))
            for (int t = 0; t < 3; ++t) m = std::min(m, r.acq[static_cast<size_t>(t)].acc);
        return m;
    };
    auto minRouting = [&](const std::string& arm) {
        double m = 1.0;
        for (const SeedRun& r : P(arm))
            for (int t = 0; t < 3; ++t) m = std::min(m, r.acq[static_cast<size_t>(t)].routing_acc);
        return m;
    };
    auto minHoldout = [&](const std::string& arm) {
        double m = 1.0;
        for (const SeedRun& r : P(arm))
            for (int t = 0; t < 3; ++t) m = std::min(m, r.holdout[static_cast<size_t>(t)].acc);
        return m;
    };
    double ccm_forget = meanForget("CCM");
    double ccm_final = meanFinal("CCM");
    double ccm_shuf = meanOf([&] { std::vector<double> v; for (auto& r : P("CCM")) for (int t = 0; t < 3; ++t) v.push_back(r.shuffled[static_cast<size_t>(t)].acc); return v; }());
    double ccm_off = meanOf([&] { std::vector<double> v; for (auto& r : P("CCM")) for (int t = 0; t < 3; ++t) v.push_back(r.ctx_off[static_cast<size_t>(t)].acc); return v; }());
    bool persist_all = true, persist_choices = true;
    for (const SeedRun& r : P("CCM")) {
        if (!r.save_reload_state) persist_all = false;
        if (!r.save_reload_choices) persist_choices = false;
    }

    struct Crit { std::string id, text, result; };
    std::vector<Crit> crit;
    crit.push_back({"L10-A", "CCM mean forgetting <= 0.10 and final avg >= 0.85",
                    (ccm_forget <= 0.10 && ccm_final >= 0.85) ? "PASS" : "FAIL"});
    crit.push_back({"L10-B", "CCM acquisition >= 0.85 on every task",
                    (minAcq("CCM") >= 0.85) ? "PASS" : "FAIL"});
    crit.push_back({"L10-C", "CCM routing accuracy >= 0.90 on every task",
                    (minRouting("CCM") >= 0.90) ? "PASS" : "FAIL"});
    crit.push_back({"L10-D", "CCM held-out cue combination >= 0.80 per task",
                    (minHoldout("CCM") >= 0.80) ? "PASS" : "FAIL"});
    crit.push_back({"L10-E", "shuffled-cue <= 0.40 and context-off <= 0.40",
                    (ccm_shuf <= 0.40 && ccm_off <= 0.40) ? "PASS" : "FAIL"});
    crit.push_back({"L10-F", "NO-SEAL mean forgetting > CCM mean forgetting",
                    (meanForget("NO-SEAL") > ccm_forget) ? "PASS" : "FAIL"});
    crit.push_back({"L10-G", "K2-STRESS worse than CCM (forgetting or final avg)",
                    (meanForget("K2-STRESS") > ccm_forget || meanFinal("K2-STRESS") < ccm_final) ? "PASS" : "FAIL"});
    crit.push_back({"L10-H", "persistence + determinism + checkpoint resume exact",
                    (persist_all && persist_choices && st.load_state_identical &&
                     st.load_choices_identical && st.checkpoint_resume_identical) ? "PASS" : "FAIL"});
    crit.push_back({"L10-I", "no new regressions vs L9 baseline (see markdown report)", "SEE-REPORT"});
    crit.push_back({"L10-J", "limitations reported honestly; no threshold nudged", "SEE-REPORT"});

    js << "  \"criteria\": {\n";
    for (size_t i = 0; i < crit.size(); ++i) {
        js << "    \"" << crit[i].id << "\": {\"criterion\": \"" << crit[i].text
           << "\", \"result\": \"" << crit[i].result << "\"}" << (i + 1 < crit.size() ? "," : "") << "\n";
    }
    js << "  },\n";
    js << "  \"selftest\": {\"load_state_identical\": " << (st.load_state_identical ? "true" : "false")
       << ", \"load_choices_identical\": " << (st.load_choices_identical ? "true" : "false")
       << ", \"checkpoint_resume_identical\": " << (st.checkpoint_resume_identical ? "true" : "false")
       << ", \"checkpoint_trial\": " << st.checkpoint_trial
       << ", \"state_signature\": \"" << st.state_md5_free_hash << "\"},\n";
    js << "  \"env\": {\"compiler\": \"g++ 12.2.0 (Debian 12.2.0-14+deb12u1)\", \"cxx_std\": 17, \"total_seconds\": "
       << num(total_seconds) << ", \"peak_rss_kb\": " << peakRssKb() << "},\n";
    js << "  \"verdict\": \"SEE work/dev_context_conditioned_memory_report_STARK-L10-1.md\"\n";
    js << "}\n";

    std::ofstream f(out_json);
    if (!f) { std::cerr << "cannot open " << out_json << "\n"; return 1; }
    f << js.str();
    f.close();

    // ---- raw per-seed CSV ----
    std::ofstream csv(raw_out + "/per_seed.csv");
    if (csv) {
        csv << "arm,master,acq_t1,acq_t2,acq_t3,ret_t1_t2,ret_t1_t3,ret_t2_t3,mean_forgetting,final_avg,"
               "route_t1,route_t2,route_t3,holdout_t1,holdout_t2,holdout_t3,shuffled_mean,ctx_off_mean,"
               "u_intended_rows,u_unintended_rows,u_unintended_banks,persist_state,persist_choices,seconds\n";
        csv.setf(std::ios::fixed);
        csv.precision(6);
        for (const ArmSpec& spec : arms) {
            const auto& arm_runs = results[spec.name];
            for (size_t si = 0; si < arm_runs.size(); ++si) {
                const SeedRun& r = arm_runs[si];
                double f = 0.0;
                for (int t = 0; t < 3; ++t)
                    f += r.acq[static_cast<size_t>(t)].acc -
                         ((t == 2) ? r.acq[2].acc : r.ret[static_cast<size_t>(t)][2].acc);
                csv << spec.name << "," << masters[si] << ","
                    << num(r.acq[0].acc) << "," << num(r.acq[1].acc) << "," << num(r.acq[2].acc) << ","
                    << num(r.ret[0][1].acc) << "," << num(r.ret[0][2].acc) << "," << num(r.ret[1][2].acc) << ","
                    << num(f / 3.0) << "," << num(meanOf(r.final_frame)) << ","
                    << num(r.acq[0].routing_acc) << "," << num(r.acq[1].routing_acc) << "," << num(r.acq[2].routing_acc) << ","
                    << num(r.holdout[0].acc) << "," << num(r.holdout[1].acc) << "," << num(r.holdout[2].acc) << ","
                    << num(meanOf(std::vector<double>{r.shuffled[0].acc, r.shuffled[1].acc, r.shuffled[2].acc})) << ","
                    << num(meanOf(std::vector<double>{r.ctx_off[0].acc, r.ctx_off[1].acc, r.ctx_off[2].acc})) << ","
                    << num(r.mean_I_rows) << "," << num(r.mean_U) << "," << num(r.mean_I_banks) << ","
                    << (r.save_reload_state ? 1 : 0) << "," << (r.save_reload_choices ? 1 : 0) << ","
                    << num(r.seconds) << "\n";
            }
        }
        csv.close();
    }

    // ---- console summary ----
    std::cerr << "\n=== STARK-L10 pooled (3 seeds) ===\n";
    for (const ArmSpec& spec : arms) {
        std::cerr << spec.name << ": acq=[" << num(meanOf([&] { std::vector<double> v; for (auto& r : results[spec.name]) v.push_back(r.acq[0].acc); return v; }()))
                  << "," << num(meanOf([&] { std::vector<double> v; for (auto& r : results[spec.name]) v.push_back(r.acq[1].acc); return v; }()))
                  << "," << num(meanOf([&] { std::vector<double> v; for (auto& r : results[spec.name]) v.push_back(r.acq[2].acc); return v; }()))
                  << "] mean_forget=" << num(meanForget(spec.name))
                  << " final_avg=" << num(meanFinal(spec.name))
                  << " routing=" << num(minRouting(spec.name))
                  << " holdout_min=" << num(minHoldout(spec.name)) << "\n";
    }
    std::cerr << "\n=== criteria ===\n";
    for (const Crit& c : crit) std::cerr << c.id << ": " << c.result << "  (" << c.text << ")\n";
    std::cerr << "\nwrote " << out_json << " and " << raw_out << "/per_seed.csv\n";
    std::cerr << "total_seconds=" << num(total_seconds) << " peak_rss_kb=" << peakRssKb() << "\n";
    return 0;
}
