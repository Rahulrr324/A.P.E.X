// STARK-L10 independent validation harness.
//
// Purpose: a SEPARATE experiment driver used to validate the L10 milestone.
// It is not part of the milestone's frozen evaluation path and it does not
// modify any L10 source. It re-implements the frozen protocol from the design
// document (stark/design/context_conditioned_memory_milestone.md v1.6) on top
// of the public CCM API, so that:
//
//   1. the frozen per-seed numbers can be reproduced by an independently
//      written aggregation (rather than re-reading the production report);
//   2. per-TRIAL rows can be emitted and metrics recomputed offline, which
//      makes the aggregation formulas auditable;
//   3. exploratory variants (more seeds, more tasks, capacity exhaustion,
//      different orders, structurally novel contexts, process-restart
//      recovery, forced wrong-bank routing) can be run without touching the
//      frozen driver.
//
// Modes
//   --mode frozen                      reproduce the 3 frozen seeds, arms CCM + SEQ-L9, emit trials
//   --mode seeds --seeds a,b,c         exploratory: arbitrary seeds, CCM + SEQ-L9
//   --mode tasks --tasks T --banks K    exploratory: T tasks over K banks
//   --mode order --order 2,0,1          exploratory: present the T tasks in a different order
//   --mode ctxnovel                    exploratory: cross-signature cue combinations
//   --mode restart --stage save|load --state FILE   process-restart recovery
//   --mode wrongbank                   exploratory: force the router to start on the wrong bank
//
// Output: CSV of per-trial rows and a CSV of per-task metrics. Nothing is
// written outside the --out directory.

#include "learning/ContextConditionedMemory.h"
#include "learning/RelevanceRouting.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
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
const double kPiOffsets[6] = {0.0, 10007.0, 20011.0, 30013.0, 40009.0, 50021.0};

std::vector<std::string> split(const std::string& s, char sep) {
    std::vector<std::string> out;
    std::string cur;
    std::istringstream is(s);
    while (std::getline(is, cur, sep)) if (!cur.empty()) out.push_back(cur);
    return out;
}

enum CueMode { CM_TRAIN = 0, CM_HOLDOUT = 1, CM_OFF = 2, CM_SHUFFLED = 3, CM_CROSS = 4 };

struct VTask {
    LRMapping map;
    std::vector<std::pair<int, int>> train_cues;
    std::vector<std::pair<int, int>> holdout_cues;
    std::vector<int> signature;   // feature indices belonging to this task
};

VTask makeVTask(unsigned master, int t) {
    VTask d;
    d.map = makeLRMapping(master + static_cast<unsigned>(kPiOffsets[t]), 6, 2);
    const int b = 4 * t;
    d.train_cues = {{b + 0, b + 1}, {b + 0, b + 2}, {b + 0, b + 3}, {b + 1, b + 2}};
    d.holdout_cues = {{b + 1, b + 3}, {b + 2, b + 3}};
    d.signature = {b + 0, b + 1, b + 2, b + 3};
    return d;
}

std::vector<int> cueOf(std::pair<int, int> p) { return {p.first, p.second}; }

struct TrialRow {
    int task = 0, phase = 0, idx = 0, queried = 0, choice = -1, bank = -1;
    int bank_is_task_bank = 0, correct = 0, forced = 0, writable = 0;
    double reward = 0.0;
    int eval_kind = -1;   // -1 = training, else CueMode used at evaluation
    int call = -1;        // evaluation call id (-1 = training)
};

struct TaskMetrics {
    double acquisition = 0.0;
    int acq_n = 0, acq_correct = 0;
    double routing = 0.0;
    int route_n = 0, route_correct = 0;
};

struct StreamResult {
    std::vector<TaskMetrics> acq;
    std::vector<std::vector<double>> ret;   // [task][step]
    std::vector<double> holdout, off, shuffled, cross;
    std::vector<double> unintended_rows, unintended_banks, intended;
    std::vector<int> task_bank;
    std::vector<int> bank_state;
    bool save_load_state = false, save_load_choices = false;
    std::vector<TrialRow> rows;
    std::vector<std::string> calls;   // call_id -> "<purpose>,<task>"
};

struct StreamSpec {
    int n_tasks = 3;
    int n_banks = 3;
    std::vector<int> order;                 // order[k] = task index presented at step k
    bool use_cue = true;
    bool seal = true;
    bool probe = true;
    bool curve = false;
    int commit_trials = 480;
    int force_initial_bank = -1;            // wrongbank experiment
    CueMode eval_cue = CM_TRAIN;
    bool context_controls = true;
    bool novel_context = false;
};

// ---------------------------------------------------------------- evaluation
// Independent re-implementation of the frozen evaluation:
//   20 multi-candidate trials per identity, learning disabled, cue drawn
//   uniformly from the task's cue table with a seeded RNG.
// The agent is snapshotted and restored so that measuring cannot perturb
// learning (this is the v1.6 harness property; the frozen driver does the
// same for every arm except its SEQ-L9 parity arm).
double evalTask(CCAgent& ag, const std::vector<VTask>& tasks, int task, unsigned seed,
                CueMode mode, int task_bank, bool want_routing, bool read_only,
                std::vector<TrialRow>* rows, unsigned shuffle_seed,
                std::vector<double>* out_off, std::vector<double>* out_cross, int n_tasks,
                int call_id = -1) {
    std::string snap;
    if (read_only) snap = ccSerialize(ag);

    auto sched = makeLRTrials(ag.cfg.lr, tasks[static_cast<size_t>(task)].map, 0, 20, seed);
    std::mt19937 rng_cue(seed ^ 0x5bd1e995u);
    std::uniform_int_distribution<int> pick4(0, 3);
    std::mt19937 rng_shuf(shuffle_seed);
    std::uniform_int_distribution<int> pick_pair(0, 3);

    int n = 0, correct = 0, rn = 0, rc = 0;
    double off_sum = 0.0;
    int off_n = 0;
    double cross_sum = 0.0;
    int cross_n = 0;

    for (const auto& lr : sched) {
        std::vector<int> cue;
        switch (mode) {
            case CM_TRAIN:
                cue = cueOf(tasks[static_cast<size_t>(task)].train_cues[static_cast<size_t>(pick4(rng_cue))]);
                break;
            case CM_HOLDOUT:
                cue = cueOf(tasks[static_cast<size_t>(task)].holdout_cues[static_cast<size_t>(pick4(rng_cue) & 1)]);
                break;
            case CM_OFF:
                cue.clear();
                break;
            case CM_SHUFFLED: {
                std::vector<int> others;
                for (int t = 0; t < n_tasks; ++t) if (t != task) others.push_back(t);
                std::uniform_int_distribution<int> pick_other(0, static_cast<int>(others.size()) - 1);
                const int ot = others[static_cast<size_t>(pick_other(rng_shuf))];
                cue = cueOf(tasks[static_cast<size_t>(ot)].train_cues[static_cast<size_t>(pick_pair(rng_shuf))]);
                break;
            }
            case CM_CROSS: {
                // one feature from this task's signature group and one from a
                // DIFFERENT group: a combination that never occurs in training
                // and that a purely compositional router must mis-handle.
                const int b = 4 * task;
                std::vector<int> others;
                for (int t = 0; t < n_tasks; ++t) if (t != task) others.push_back(t);
                std::uniform_int_distribution<int> pick_other(0, static_cast<int>(others.size()) - 1);
                const int ot = others[static_cast<size_t>(pick_other(rng_shuf))];
                const int b2 = 4 * ot;
                cue = {b + (pick_pair(rng_shuf) % 4), b2 + (pick_pair(rng_shuf) % 4)};
                break;
            }
        }
        CCTrialSchedule s;
        s.lr = lr;
        s.cue = cue;
        CCResult r = runCCTrial(ag, s, tasks[static_cast<size_t>(task)].map, task_bank,
                                CC_LEARNED, /*learning=*/false, /*router_learning=*/false);
        ++n;
        const bool ok = (r.choice == tasks[static_cast<size_t>(task)].map.perm[static_cast<size_t>(r.queried)]);
        if (ok) ++correct;
        if (want_routing && task_bank >= 0) {
            ++rn;
            if (r.bank == task_bank) ++rc;
        }
        if (mode == CM_OFF && out_off) {
            // accuracy of the bank the agent fell back to, under THIS task's key
            off_sum += ok ? 1.0 : 0.0;
            ++off_n;
        }
        if (mode == CM_CROSS && out_cross) {
            cross_sum += ok ? 1.0 : 0.0;
            ++cross_n;
        }
        if (rows) {
            TrialRow tr;
            tr.task = task; tr.phase = 0; tr.idx = static_cast<int>(rows->size());
            tr.queried = r.queried; tr.choice = r.choice; tr.bank = r.bank;
            tr.bank_is_task_bank = (r.bank == task_bank) ? 1 : 0;
            tr.correct = ok ? 1 : 0;
            tr.reward = r.reward;
            tr.eval_kind = mode;
            tr.call = call_id;
            rows->push_back(tr);
        }
    }
    if (read_only) ccDeserialize(ag, snap);
    (void)out_off; (void)out_cross; (void)off_sum; (void)off_n;
    (void)cross_sum; (void)cross_n; (void)rn; (void)rc;
    return n ? double(correct) / n : 0.0;
}

// ---------------------------------------------------------------- one stream
StreamResult runStream(const StreamSpec& spec, unsigned master, bool dump_rows,
                       int start_step = 0, int stop_after = -1,
                       const std::string& state_in = "", const std::string& state_out = "",
                       std::vector<int> prev_task_bank = {}) {
    StreamResult res;
    const int T = spec.n_tasks;

    CCConfig cfg;
    cfg.lr.n_ids = 6;
    cfg.lr.n_chan = 2;
    cfg.lr.n_ctx = 2;
    cfg.lr.softmax_T = 1.0 / std::sqrt(2.0) / 2.0;   // frozen F2a value
    cfg.n_banks = spec.n_banks;
    cfg.n_feat = 4 * T;
    cfg.seal_superseded = spec.seal;

    std::vector<VTask> tasks(static_cast<size_t>(T));
    for (int t = 0; t < T; ++t) tasks[static_cast<size_t>(t)] = makeVTask(master, t);
    const std::vector<int> phi0 = tasks[0].map.phi;
    for (int t = 1; t < T; ++t) tasks[static_cast<size_t>(t)].map.phi = phi0;  // shared phi (frozen)

    CCAgent ag = makeCCAgent(cfg, true);
    if (spec.n_banks == 1) ag.bank_state[0] = CC_ACTIVE;
    if (!state_in.empty()) {
        // process-restart: adopt the state written by a previous process
        std::ifstream f(state_in, std::ios::binary);
        std::stringstream ss;
        ss << f.rdbuf();
        ccDeserialize(ag, ss.str());
    }

    std::vector<int> order = spec.order;
    if (order.empty()) for (int t = 0; t < T; ++t) order.push_back(t);
    const int steps = static_cast<int>(order.size());

    res.acq.resize(static_cast<size_t>(T));
    res.ret.assign(static_cast<size_t>(T), std::vector<double>(static_cast<size_t>(steps), 0.0));
    res.task_bank.assign(static_cast<size_t>(T), -1);

    int call_seq = 0;
    auto next_call = [&](const std::string& purpose, int task, CueMode kind) {
        if (!dump_rows) return -1;
        res.calls.push_back(purpose + "," + std::to_string(task) + "," + std::to_string(int(kind)));
        return call_seq++;
    };

    if (!prev_task_bank.empty())
        for (int t = 0; t < T && t < static_cast<int>(prev_task_bank.size()); ++t)
            res.task_bank[static_cast<size_t>(t)] = prev_task_bank[static_cast<size_t>(t)];

    const int last_step = (stop_after >= 0) ? std::min(stop_after, steps) : steps;
    for (int step = start_step; step < last_step; ++step) {
        const int t = order[static_cast<size_t>(step)];
        const VTask& td = tasks[static_cast<size_t>(t)];

        // trial stream (frozen seeds: master + t*1000, phase-2 uses +1)
        std::vector<LRTrialSchedule> p1 = makeLRTrials(cfg.lr, td.map, 80, 0,
                                                       master + static_cast<unsigned>(t) * 1000u);
        std::vector<LRTrialSchedule> p2 = makeLRTrials(cfg.lr, td.map, 0, 40,
                                                       master + static_cast<unsigned>(t) * 1000u + 1u);
        std::vector<LRTrialSchedule> trials;
        trials.insert(trials.end(), p1.begin(), p1.end());
        trials.insert(trials.end(), p2.begin(), p2.end());

        // cue assignment (frozen seed: master + 6001 + t)
        std::vector<int> cue_idx(trials.size());
        {
            std::mt19937 rng(master + 6001u + static_cast<unsigned>(t));
            std::uniform_int_distribution<int> pick(0, 3);
            for (size_t i = 0; i < trials.size(); ++i) cue_idx[i] = pick(rng);
        }

        // probe + allocation (architecture-supplied; frozen seed master + 6100 + t)
        if (spec.probe) {
            auto pool = makeLRTrials(cfg.lr, td.map, 10, 0, master + 6100u + static_cast<unsigned>(t));
            std::vector<double> rew(static_cast<size_t>(spec.n_banks), 0.0);
            std::vector<int> cnt(static_cast<size_t>(spec.n_banks), 0);
            for (size_t i = 0; i < pool.size(); ++i) {
                const int bank = static_cast<int>(i) % spec.n_banks;
                CCTrialSchedule s;
                s.lr = pool[i];
                s.cue = cueOf(td.train_cues[i % td.train_cues.size()]);
                CCResult r = runCCTrial(ag, s, td.map, bank, CC_ORACLE, false, false);
                rew[static_cast<size_t>(bank)] += r.reward;
                ++cnt[static_cast<size_t>(bank)];
            }
            int best = 0;
            for (int k = 1; k < spec.n_banks; ++k)
                if (rew[static_cast<size_t>(k)] > rew[static_cast<size_t>(best)]) best = k;
            const double best_rew = cnt[static_cast<size_t>(best)]
                ? rew[static_cast<size_t>(best)] / cnt[static_cast<size_t>(best)] : -1.0;
            const bool familiar = (ag.bank_state[static_cast<size_t>(best)] != CC_UNALLOCATED) &&
                                  (best_rew >= cfg.theta_alloc);
            if (familiar) {
                for (int k = 0; k < spec.n_banks; ++k)
                    if (k != best && ag.bank_state[static_cast<size_t>(k)] == CC_ACTIVE)
                        ag.bank_state[static_cast<size_t>(k)] = CC_SEALED;
                ag.bank_state[static_cast<size_t>(best)] = CC_ACTIVE;
            } else {
                int nb = ccAllocateNext(ag, cfg.seal_superseded);
                if (nb < 0) {
                    int worst = 0;
                    for (int k = 1; k < spec.n_banks; ++k)
                        if (rew[static_cast<size_t>(k)] < rew[static_cast<size_t>(worst)]) worst = k;
                    ag.bank_state[static_cast<size_t>(worst)] = CC_ACTIVE;
                    if (cfg.seal_superseded)
                        for (int k = 0; k < spec.n_banks; ++k)
                            if (k != worst) ag.bank_state[static_cast<size_t>(k)] = CC_ACTIVE;
                }
            }
        }
        // wrongbank experiment: force an allocated bank to a non-preferred one
        int active = ccActiveBank(ag);
        if (spec.force_initial_bank >= 0 && step == 0) {
            ag.bank_state[static_cast<size_t>(active)] = CC_SEALED;
            ag.bank_state[static_cast<size_t>(spec.force_initial_bank)] = CC_ACTIVE;
            active = spec.force_initial_bank;
        }
        res.task_bank[static_cast<size_t>(t)] = active;

        // ---- training ----
        double sum_int = 0.0, sum_ur = 0.0, sum_ub = 0.0;
        int n_mass = 0;
        std::vector<std::vector<std::vector<double>>> w0;
        for (size_t i = 0; i < trials.size(); ++i) {
            const bool measure = (i < 480) && trials[i].single;
            if (measure) w0 = ccBankWeights(ag);
            const bool commit = (spec.commit_trials > 0) &&
                                (static_cast<int>(i) < spec.commit_trials) && active >= 0;
            CCTrialSchedule s;
            s.lr = trials[i];
            if (spec.use_cue)
                s.cue = cueOf(td.train_cues[static_cast<size_t>(cue_idx[i])]);
            CCResult r = runCCTrial(ag, s, td.map, -1, CC_LEARNED, true,
                                    /*router_learning=*/!commit,
                                    /*forced_bank=*/commit ? active : -1);
            if (measure) {
                auto w1 = ccBankWeights(ag);
                double I = 0.0, UR = 0.0, UB = 0.0;
                for (size_t k = 0; k < w1.size(); ++k)
                    for (size_t a = 0; a < w1[k].size(); ++a)
                        for (size_t b = 0; b < w1[k][a].size(); ++b) {
                            const double d = std::fabs(w1[k][a][b] - w0[k][a][b]);
                            if (static_cast<int>(k) != r.bank) { UB += d; continue; }
                            if (static_cast<int>(a) == r.queried) I += d; else UR += d;
                        }
                sum_int += I; sum_ur += UR; sum_ub += UB; ++n_mass;
            }
            if (dump_rows) {
                TrialRow tr;
                tr.task = t; tr.phase = commit ? 1 : (i < 480 ? 1 : 2);
                tr.idx = static_cast<int>(i);
                tr.queried = r.queried; tr.choice = r.choice; tr.bank = r.bank;
                tr.bank_is_task_bank = (r.bank == active) ? 1 : 0;
                tr.correct = (r.choice == td.map.perm[static_cast<size_t>(r.queried)]) ? 1 : 0;
                tr.reward = r.reward;
                tr.forced = commit ? 1 : 0;
                tr.writable = r.plastic_write ? 1 : 0;
                tr.eval_kind = -1;
                res.rows.push_back(tr);
            }
        }
        if (n_mass) {
            res.intended.push_back(sum_int / n_mass);
            res.unintended_rows.push_back(sum_ur / n_mass);
            res.unintended_banks.push_back(sum_ub / n_mass);
        }

        // ---- acquisition + retention (frozen eval seeds master + 5001 + task) ----
        TaskMetrics tm;
        {
            const unsigned es = master + 5001u + static_cast<unsigned>(t);
            const int acq_call = next_call("acquisition", t, spec.eval_cue);
            double acc = evalTask(ag, tasks, t, es, spec.eval_cue, active, true, true,
                                  dump_rows ? &res.rows : nullptr, master + 9300u, nullptr, nullptr, T,
                                  acq_call);
            tm.acquisition = acc;
            // routing accuracy, re-derived from the same schedule
            {
                std::string snap = ccSerialize(ag);
                auto sched = makeLRTrials(cfg.lr, td.map, 0, 20, es);
                std::mt19937 rng_cue(es ^ 0x5bd1e995u);
                std::uniform_int_distribution<int> pick4(0, 3);
                int rn = 0, rc = 0;
                for (const auto& lr : sched) {
                    CCTrialSchedule s;
                    s.lr = lr;
                    int ci = pick4(rng_cue);
                    if (spec.use_cue) s.cue = cueOf(td.train_cues[static_cast<size_t>(ci)]);
                    CCResult r = runCCTrial(ag, s, td.map, active, CC_LEARNED, false, false);
                    ++rn;
                    if (r.bank == active) ++rc;
                }
                ccDeserialize(ag, snap);
                tm.routing = rn ? double(rc) / rn : 0.0;
                tm.route_n = rn; tm.route_correct = rc;
            }
        }
        res.acq[static_cast<size_t>(t)] = tm;

        for (int prev_step = 0; prev_step < step; ++prev_step) {
            const int prev = order[static_cast<size_t>(prev_step)];
            const unsigned es = master + 5001u + static_cast<unsigned>(prev);
            const int rc_call = next_call("retention@step" + std::to_string(step), prev, spec.eval_cue);
            const double acc = evalTask(ag, tasks, prev, es, spec.eval_cue,
                                        res.task_bank[static_cast<size_t>(prev)], false, true,
                                        dump_rows ? &res.rows : nullptr, master + 9300u, nullptr,
                                        nullptr, T, rc_call);
            res.ret[static_cast<size_t>(prev)][static_cast<size_t>(step)] = acc;
        }
    }

    // ---- post-stream diagnostics (all banks now exist) ----
    for (int t = 0; t < T; ++t) {
        const int tb = res.task_bank[static_cast<size_t>(t)];
        const unsigned hseed = master + 8001u + static_cast<unsigned>(t);
        const int hc = next_call("holdout", t, CM_HOLDOUT);
        res.holdout.push_back(evalTask(ag, tasks, t, hseed, CM_HOLDOUT, tb, false, true,
                                       dump_rows ? &res.rows : nullptr, master + 9300u, nullptr, nullptr, T, hc));
        if (spec.context_controls) {
            const int oc = next_call("context_off", t, CM_OFF);
            res.off.push_back(evalTask(ag, tasks, t, master + 5001u + static_cast<unsigned>(t),
                                       CM_OFF, tb, true, true, dump_rows ? &res.rows : nullptr,
                                       master + 9300u, nullptr, nullptr, T, oc));
            const int sc = next_call("shuffled", t, CM_SHUFFLED);
            res.shuffled.push_back(evalTask(ag, tasks, t, master + 5001u + static_cast<unsigned>(t),
                                            CM_SHUFFLED, tb, false, true,
                                            dump_rows ? &res.rows : nullptr,
                                            master + 9100u + static_cast<unsigned>(t), nullptr, nullptr, T, sc));
        }
        if (spec.novel_context) {
            const int xc = next_call("cross_novel", t, CM_CROSS);
            res.cross.push_back(evalTask(ag, tasks, t, master + 5001u + static_cast<unsigned>(t),
                                         CM_CROSS, tb, true, true, dump_rows ? &res.rows : nullptr,
                                         master + 9400u + static_cast<unsigned>(t), nullptr, nullptr, T, xc));
        }
    }

    // ---- persistence ----
    {
        const std::string snap = ccSerialize(ag);
        CCAgent ag2 = makeCCAgent(cfg, true);
        ccDeserialize(ag2, snap);
        res.save_load_state = (snap == ccSerialize(ag2));
        const int t0 = 0;
        const double c1 = evalTask(ag, tasks, t0, master + 7001u, CM_TRAIN,
                                   res.task_bank[static_cast<size_t>(t0)], false, true,
                                   nullptr, master + 77u, nullptr, nullptr, T);
        const double c2 = evalTask(ag2, tasks, t0, master + 7001u, CM_TRAIN,
                                   res.task_bank[static_cast<size_t>(t0)], false, true,
                                   nullptr, master + 77u, nullptr, nullptr, T);
        res.save_load_choices = (std::fabs(c1 - c2) < 1e-12);
    }
    res.bank_state = ag.bank_state;
    if (!state_out.empty()) {
        std::ofstream f(state_out, std::ios::binary);
        f << ccSerialize(ag);
        std::ofstream g(state_out + ".bankmap");
        for (int t = 0; t < T; ++t) g << res.task_bank[static_cast<size_t>(t)] << " ";
    }
    return res;
}

void writeTaskCsv(const std::string& path, const StreamSpec& spec, unsigned master,
                  const StreamResult& r, const std::vector<VTask>& tasks) {
    std::ofstream f(path);
    f.setf(std::ios::fixed);
    f.precision(6);
    f << "master,n_tasks,n_banks,use_cue,seal,step_task,task_bank,acquisition,routing,"
         "final_retention,forgetting,holdout,context_off,shuffled,cross_novel,"
         "unintended_rows,unintended_banks\n";
    const int T = spec.n_tasks;
    std::vector<int> order = spec.order;
    if (order.empty()) for (int t = 0; t < T; ++t) order.push_back(t);
    const int nsteps = static_cast<int>(order.size());
    for (int step = 0; step < nsteps; ++step) {
        const int t = order[static_cast<size_t>(step)];
        const double fin = (step == nsteps - 1) ? r.acq[static_cast<size_t>(t)].acquisition
                                               : r.ret[static_cast<size_t>(t)][static_cast<size_t>(nsteps - 1)];
        f << master << "," << T << "," << spec.n_banks << "," << (spec.use_cue ? 1 : 0) << ","
          << (spec.seal ? 1 : 0) << "," << step << "," << r.task_bank[static_cast<size_t>(t)] << ","
          << r.acq[static_cast<size_t>(t)].acquisition << ","
          << r.acq[static_cast<size_t>(t)].routing << ","
          << fin << "," << (r.acq[static_cast<size_t>(t)].acquisition - fin) << ","
          << (t < (int)r.holdout.size() ? r.holdout[static_cast<size_t>(t)] : -1.0) << ","
          << (t < (int)r.off.size() ? r.off[static_cast<size_t>(t)] : -1.0) << ","
          << (t < (int)r.shuffled.size() ? r.shuffled[static_cast<size_t>(t)] : -1.0) << ","
          << (t < (int)r.cross.size() ? r.cross[static_cast<size_t>(t)] : -1.0) << ","
          << (t < (int)r.unintended_rows.size() ? r.unintended_rows[static_cast<size_t>(t)] : -1.0) << ","
          << (t < (int)r.unintended_banks.size() ? r.unintended_banks[static_cast<size_t>(t)] : -1.0)
          << "\n";
    }
    (void)tasks;
}

void writeCallsCsv(const std::string& path, const StreamResult& r) {
    std::ofstream f(path);
    f << "call,purpose,task,eval_kind\n";
    for (size_t i = 0; i < r.calls.size(); ++i) f << i << "," << r.calls[i] << "\n";
}

void writeTrialCsv(const std::string& path, unsigned master, const StreamResult& r) {
    std::ofstream f(path);
    f << "master,task,phase,trial,queried,choice,bank,bank_is_task_bank,correct,reward,forced,writable,eval_kind,call\n";
    for (const TrialRow& t : r.rows) {
        f << master << "," << t.task << "," << t.phase << "," << t.idx << "," << t.queried << ","
          << t.choice << "," << t.bank << "," << t.bank_is_task_bank << "," << t.correct << ","
          << t.reward << "," << t.forced << "," << t.writable << "," << t.eval_kind << ","
          << t.call << "\n";
    }
}

} // namespace

int main(int argc, char** argv) {
    std::string mode = "frozen";
    std::string out = ".";
    std::string seed_arg, order_arg, state_file;
    int n_tasks = 3, n_banks = 3, stage = 0, force_bank = -1, commit = 480, seal = 1;

    for (int i = 1; i < argc; ++i) {
        if (!std::strcmp(argv[i], "--mode") && i + 1 < argc) mode = argv[++i];
        else if (!std::strcmp(argv[i], "--out") && i + 1 < argc) out = argv[++i];
        else if (!std::strcmp(argv[i], "--seeds") && i + 1 < argc) seed_arg = argv[++i];
        else if (!std::strcmp(argv[i], "--order") && i + 1 < argc) order_arg = argv[++i];
        else if (!std::strcmp(argv[i], "--tasks") && i + 1 < argc) n_tasks = std::atoi(argv[++i]);
        else if (!std::strcmp(argv[i], "--banks") && i + 1 < argc) n_banks = std::atoi(argv[++i]);
        else if (!std::strcmp(argv[i], "--state") && i + 1 < argc) state_file = argv[++i];
        else if (!std::strcmp(argv[i], "--stage") && i + 1 < argc) stage = std::atoi(argv[++i]);
        else if (!std::strcmp(argv[i], "--force-bank") && i + 1 < argc) force_bank = std::atoi(argv[++i]);
        else if (!std::strcmp(argv[i], "--commit") && i + 1 < argc) commit = std::atoi(argv[++i]);
        else if (!std::strcmp(argv[i], "--seal") && i + 1 < argc) seal = std::atoi(argv[++i]);
    }
    if (n_tasks < 1 || n_tasks > 6) { std::cerr << "n_tasks must be 1..6\n"; return 2; }
    if (n_banks < 1 || n_banks > 6) { std::cerr << "n_banks must be 1..6\n"; return 2; }

    std::vector<unsigned> masters;
    if (!seed_arg.empty()) {
        for (const auto& s : split(seed_arg, ',')) masters.push_back(static_cast<unsigned>(std::stoul(s)));
    } else if (mode == "frozen") {
        masters = {123456789u, 218213831u, 171473193u};
    } else {
        masters = {987654321u};
    }

    StreamSpec spec;
    spec.n_tasks = n_tasks;
    spec.n_banks = n_banks;
    spec.force_initial_bank = force_bank;
    spec.commit_trials = commit;
    spec.seal = (seal != 0);
    if (!order_arg.empty()) {
        for (const auto& s : split(order_arg, ',')) spec.order.push_back(std::stoi(s));
        // The order may be shorter, equal, or longer than n_tasks; a longer
        // sequence revisits an already-trained task (a scenario the frozen
        // protocol does not contain).
        for (int t : spec.order)
            if (t < 0 || t >= n_tasks) { std::cerr << "--order entries must be < --tasks\n"; return 2; }
    }

    if (mode == "frozen" || mode == "seeds") {
        // CCM (3 banks, cue, probe, seal) and the single-bank L9-style arm
        for (unsigned m : masters) {
            StreamSpec ccm = spec;
            StreamResult r = runStream(ccm, m, true);
            writeTaskCsv(out + "/metrics_ccm_" + std::to_string(m) + ".csv", ccm, m, r, {});
            writeTrialCsv(out + "/trials_ccm_" + std::to_string(m) + ".csv", m, r);
            writeCallsCsv(out + "/calls_ccm_" + std::to_string(m) + ".csv", r);

            StreamSpec seq;
            seq.n_tasks = n_tasks;
            seq.n_banks = 1;
            seq.use_cue = false;
            seq.seal = false;
            seq.probe = false;
            seq.commit_trials = 0;
            seq.context_controls = false;
            StreamResult r2 = runStream(seq, m, true);
            writeTaskCsv(out + "/metrics_seql9_" + std::to_string(m) + ".csv", seq, m, r2, {});
            writeTrialCsv(out + "/trials_seql9_" + std::to_string(m) + ".csv", m, r2);
            writeCallsCsv(out + "/calls_seql9_" + std::to_string(m) + ".csv", r2);
            std::cerr << "seed " << m << " done\n";
        }
    } else if (mode == "tasks" || mode == "order" || mode == "ctxnovel" || mode == "wrongbank") {
        if (mode == "ctxnovel") spec.novel_context = true;
        for (unsigned m : masters) {
            StreamResult r = runStream(spec, m, true);
            std::string tag = mode + "_T" + std::to_string(n_tasks) + "_K" + std::to_string(n_banks) +
                              "_" + std::to_string(m);
            writeTaskCsv(out + "/metrics_" + tag + ".csv", spec, m, r, {});
            writeTrialCsv(out + "/trials_" + tag + ".csv", m, r);
            writeCallsCsv(out + "/calls_" + tag + ".csv", r);
            std::cerr << tag << " done\n";
        }
    } else if (mode == "restart") {
        // Real process handover: stage 0 trains steps 0..1 and writes the
        // composite state to disk; a SEPARATE process (stage 1) loads that
        // file, continues with step 2, and reports the final metrics. The
        // result is compared against the uninterrupted run.
        unsigned m = masters[0];
        StreamSpec s3;
        s3.n_tasks = 3;
        s3.n_banks = 3;
        if (stage == 0) {
            runStream(s3, m, false, 0, 2, "", state_file, {});
            std::cerr << "stage0: wrote " << state_file << " after 2 task steps\n";
        } else {
            std::vector<int> bankmap;
            {
                std::ifstream g(state_file + ".bankmap");
                int v = 0;
                while (g >> v) bankmap.push_back(v);
            }
            StreamResult r = runStream(s3, m, false, 2, -1, state_file, "", bankmap);
            std::ofstream f(out + "/restart_stage1.csv");
            f.setf(std::ios::fixed); f.precision(6);
            f << "master,task,task_bank,acquisition,final_retention\n";
            for (int t = 0; t < 3; ++t) {
                const double fin = (t == 2) ? r.acq[2].acquisition : r.ret[static_cast<size_t>(t)][2];
                f << m << "," << t << "," << r.task_bank[static_cast<size_t>(t)] << ","
                  << r.acq[static_cast<size_t>(t)].acquisition << "," << fin << "\n";
            }
            std::cerr << "stage1: resumed from " << state_file << " and finished\n";
        }
    } else {
        std::cerr << "unknown mode " << mode << "\n";
        return 2;
    }
    return 0;
}
