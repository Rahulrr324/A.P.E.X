/**
 * STARK-L1: Reproducible reward-modulated learning loop (experiment runner).
 *
 * Protocol (frozen: stark/design/learning_loop_milestone.md):
 *   1. Train a THREEFACTOR agent on the two-cue/two-action task for
 *      cfg.train_trials trials (reward r delivered as modulator m).
 *   2. Evaluate it on cfg.eval_trials held-out trials with m never set.
 *   3. Evaluate a frozen (PlasticityMode::NONE) baseline with identical
 *      initial weights on the identical evaluation schedule.
 *   4. Write one deterministic JSON report (schema STARK-L1-1) with config,
 *      seeds, per-trial log, metrics, weights, and criterion verdicts.
 *
 * Two runs with the same seed produce byte-identical reports (criterion C5).
 *
 * Usage:
 *   learning_loop --out report.json [--seed N] [--train N] [--eval N]
 */

#include "learning/ToyAssociationTask.h"
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <iomanip>
#include <stdexcept>
#include <cstdlib>

using namespace learning;

namespace {

struct Args {
    std::string out = "learning_loop_report.json";
    unsigned seed = 0;   // 0 = use cfg.master_seed
    int train = -1;      // -1 = use cfg default
    int eval = -1;
};

Args parseArgs(int argc, char** argv) {
    Args a;
    for (int i = 1; i < argc; ++i) {
        std::string s = argv[i];
        auto next = [&]() -> std::string {
            if (i + 1 >= argc) throw std::runtime_error("missing value for " + s);
            return argv[++i];
        };
        if (s == "--out") a.out = next();
        else if (s == "--seed") a.seed = static_cast<unsigned>(std::stoul(next()));
        else if (s == "--train") a.train = std::stoi(next());
        else if (s == "--eval") a.eval = std::stoi(next());
        else throw std::runtime_error("unknown argument: " + s);
    }
    return a;
}

/// Deterministic JSON number formatting (fixed 6 decimals).
std::string num(double v) {
    std::ostringstream os;
    os << std::fixed << std::setprecision(6) << v;
    return os.str();
}

} // namespace

int main(int argc, char** argv) {
    try {
        Args args = parseArgs(argc, argv);
        TaskConfig cfg;
        if (args.seed != 0) cfg.master_seed = args.seed;
        if (args.train > 0) cfg.train_trials = args.train;
        if (args.eval > 0) cfg.eval_trials = args.eval;

        const unsigned seed_train = cfg.master_seed;
        const unsigned seed_eval  = cfg.master_seed + 1u;

        // Precomputed deterministic schedules (replayed identically to both
        // agents where they overlap — evaluation).
        std::vector<TrialSchedule> train_sched =
            makeSchedule(cfg, cfg.train_trials, seed_train);
        std::vector<TrialSchedule> eval_sched =
            makeSchedule(cfg, cfg.eval_trials, seed_eval);

        // --- Trained agent ---
        Agent trained = makeAgent(cfg, /*plastic=*/true);
        std::vector<double> w_init = weights(trained);

        struct LogRow { int trial, cue, choice; double reward; };
        std::vector<LogRow> log;
        log.reserve(static_cast<size_t>(cfg.train_trials));
        for (int t = 0; t < cfg.train_trials; ++t) {
            TrialResult r = runTrial(trained, cfg, train_sched[static_cast<size_t>(t)],
                                     /*learning_enabled=*/true);
            log.push_back({t, r.cue, r.choice, r.reward});
        }
        std::vector<double> w_trained = weights(trained);

        // Evaluation: modulator never set => no weight change by construction.
        std::vector<TrialResult> eval_trained;
        for (const TrialSchedule& s : eval_sched)
            eval_trained.push_back(runTrial(trained, cfg, s, /*learning_enabled=*/false));
        std::vector<double> w_after_eval = weights(trained);

        // --- Frozen baseline: identical init, identical eval schedule ---
        Agent baseline = makeAgent(cfg, /*plastic=*/false);
        std::vector<TrialResult> eval_baseline;
        for (const TrialSchedule& s : eval_sched)
            eval_baseline.push_back(runTrial(baseline, cfg, s, /*learning_enabled=*/false));
        std::vector<double> w_baseline = weights(baseline);

        // --- Sham negative control: identical protocol, modulator +1 on
        // every trial instead of the task reward (reward_contingent=false).
        // Tests that reward contingency, not weight drift, drives learning. ---
        TaskConfig cfg_sham = cfg;
        cfg_sham.reward_contingent = false;
        Agent sham = makeAgent(cfg_sham, /*plastic=*/true);
        for (int t = 0; t < cfg.train_trials; ++t)
            runTrial(sham, cfg_sham, train_sched[static_cast<size_t>(t)],
                     /*learning_enabled=*/true);
        std::vector<double> w_sham = weights(sham);
        std::vector<TrialResult> eval_sham;
        for (const TrialSchedule& s : eval_sched)
            eval_sham.push_back(runTrial(sham, cfg_sham, s, /*learning_enabled=*/false));

        // --- Metrics ---
        double acc_t = 0, acc_b = 0, acc_s = 0;
        for (const TrialResult& r : eval_trained) acc_t += (r.reward > 0) ? 1.0 : 0.0;
        for (const TrialResult& r : eval_baseline) acc_b += (r.reward > 0) ? 1.0 : 0.0;
        for (const TrialResult& r : eval_sham) acc_s += (r.reward > 0) ? 1.0 : 0.0;
        acc_t /= static_cast<double>(cfg.eval_trials);
        acc_b /= static_cast<double>(cfg.eval_trials);
        acc_s /= static_cast<double>(cfg.eval_trials);

        auto mean_reward = [&](int from, int to) {
            double m = 0;
            for (int i = from; i < to; ++i) m += log[static_cast<size_t>(i)].reward;
            return m / static_cast<double>(to - from);
        };
        int tail = cfg.train_trials < 20 ? cfg.train_trials : 20;
        double first20 = mean_reward(0, tail);
        double last20 = mean_reward(cfg.train_trials - tail, cfg.train_trials);

        double correct_pair = 0.5 * (w_trained[0] + w_trained[3]); // S0->A0, S1->A1
        double wrong_pair   = 0.5 * (w_trained[1] + w_trained[2]); // S0->A1, S1->A0
        double pair_gap = correct_pair - wrong_pair;

        // --- Frozen criteria (learning_loop_milestone.md §5) ---
        bool c1 = acc_t >= 0.80;
        bool c2 = (acc_t - acc_b) >= 0.25;
        bool c3 = last20 > first20;
        bool c4 = pair_gap > 0.10;
        bool eval_weights_unchanged = true;
        for (size_t i = 0; i < w_trained.size(); ++i)
            if (w_trained[i] != w_after_eval[i]) eval_weights_unchanged = false;

        // --- Report (deterministic formatting) ---
        std::ostringstream j;
        j << std::fixed << std::setprecision(6);
        j << "{\n";
        j << "  \"schema\": \"STARK-L1-1\",\n";
        j << "  \"config\": {\n";
        j << "    \"train_trials\": " << cfg.train_trials << ",\n";
        j << "    \"eval_trials\": " << cfg.eval_trials << ",\n";
        j << "    \"cue_steps\": " << cfg.cue_steps << ",\n";
        j << "    \"dt\": " << num(cfg.dt) << ",\n";
        j << "    \"cue_current\": " << num(cfg.cue_current) << ",\n";
        j << "    \"background_current\": " << num(cfg.background_current) << ",\n";
        j << "    \"noise_amp\": " << num(cfg.noise_amp) << ",\n";
        j << "    \"tau_m\": " << num(cfg.tau_m) << ", \"theta_0\": " << num(cfg.theta_0)
          << ", \"tau_a\": " << num(cfg.tau_a) << ", \"adapt_b\": " << num(cfg.adapt_b)
          << ", \"v_reset\": " << num(cfg.v_reset) << ",\n";
        j << "    \"tau_s\": " << num(cfg.tau_s) << ", \"w_init\": " << num(cfg.w_init)
          << ", \"w_min\": " << num(cfg.w_min) << ", \"w_max\": " << num(cfg.w_max)
          << ", \"w_inh\": " << num(cfg.w_inh) << ",\n";
        j << "    \"E_plus\": " << num(cfg.E_plus) << ", \"E_minus\": " << num(cfg.E_minus)
          << ", \"tau_e\": " << num(cfg.tau_e) << ", \"eta_3f\": " << num(cfg.eta_3f)
          << ", \"tau_pre\": " << num(cfg.tau_pre) << ", \"tau_post\": " << num(cfg.tau_post) << "\n";
        j << "  },\n";
        j << "  \"seeds\": { \"master\": " << cfg.master_seed
          << ", \"train\": " << seed_train << ", \"eval\": " << seed_eval << " },\n";

        j << "  \"training\": [\n";
        for (size_t i = 0; i < log.size(); ++i) {
            const LogRow& e = log[i];
            j << "    {\"trial\": " << e.trial << ", \"cue\": " << e.cue
              << ", \"choice\": " << e.choice << ", \"reward\": " << num(e.reward) << "}"
              << (i + 1 < log.size() ? "," : "") << "\n";
        }
        j << "  ],\n";

        j << "  \"training_summary\": { \"first20_mean_reward\": " << num(first20)
          << ", \"last20_mean_reward\": " << num(last20) << " },\n";

        j << "  \"eval_trained\": { \"accuracy\": " << num(acc_t) << ", \"trials\": [";
        for (size_t i = 0; i < eval_trained.size(); ++i) {
            const TrialResult& e = eval_trained[i];
            j << (i ? ", " : "") << "{\"cue\": " << e.cue << ", \"choice\": " << e.choice
              << ", \"reward\": " << num(e.reward) << "}";
        }
        j << "] },\n";

        j << "  \"eval_baseline\": { \"accuracy\": " << num(acc_b) << ", \"trials\": [";
        for (size_t i = 0; i < eval_baseline.size(); ++i) {
            const TrialResult& e = eval_baseline[i];
            j << (i ? ", " : "") << "{\"cue\": " << e.cue << ", \"choice\": " << e.choice
              << ", \"reward\": " << num(e.reward) << "}";
        }
        j << "] },\n";

        j << "  \"eval_sham\": { \"accuracy\": " << num(acc_s) << ", \"note\": \"sham reward: modulator +1 every trial\", \"trials\": [";
        for (size_t i = 0; i < eval_sham.size(); ++i) {
            const TrialResult& e = eval_sham[i];
            j << (i ? ", " : "") << "{\"cue\": " << e.cue << ", \"choice\": " << e.choice
              << ", \"reward\": " << num(e.reward) << "}";
        }
        j << "] },\n";

        j << "  \"weights_init\": [" << num(w_init[0]) << ", " << num(w_init[1]) << ", "
          << num(w_init[2]) << ", " << num(w_init[3]) << "],\n";
        j << "  \"weights_trained\": [" << num(w_trained[0]) << ", " << num(w_trained[1])
          << ", " << num(w_trained[2]) << ", " << num(w_trained[3]) << "],\n";
        j << "  \"weights_baseline\": [" << num(w_baseline[0]) << ", " << num(w_baseline[1])
          << ", " << num(w_baseline[2]) << ", " << num(w_baseline[3]) << "],\n";
        j << "  \"weights_sham\": [" << num(w_sham[0]) << ", " << num(w_sham[1])
          << ", " << num(w_sham[2]) << ", " << num(w_sham[3]) << "],\n";
        j << "  \"pair_gap\": " << num(pair_gap) << ",\n";
        j << "  \"criteria\": { \"C1\": " << (c1 ? "true" : "false")
          << ", \"C2\": " << (c2 ? "true" : "false")
          << ", \"C3\": " << (c3 ? "true" : "false")
          << ", \"C4\": " << (c4 ? "true" : "false")
          << ", \"eval_weights_unchanged\": " << (eval_weights_unchanged ? "true" : "false")
          << " }\n";
        j << "}\n";

        std::ofstream f(args.out);
        if (!f) throw std::runtime_error("cannot write " + args.out);
        f << j.str();
        f.close();

        std::cout << "STARK-L1 learning loop\n"
                  << "  trained accuracy:  " << num(acc_t) << "\n"
                  << "  baseline accuracy: " << num(acc_b) << "\n"
                  << "  sham accuracy:     " << num(acc_s) << "\n"
                  << "  first20/last20 reward: " << num(first20) << " / " << num(last20) << "\n"
                  << "  pair gap (correct-wrong): " << num(pair_gap) << "\n"
                  << "  criteria C1..C4: " << (c1 ? "PASS" : "FAIL") << " "
                  << (c2 ? "PASS" : "FAIL") << " " << (c3 ? "PASS" : "FAIL") << " "
                  << (c4 ? "PASS" : "FAIL") << "\n"
                  << "  eval weights unchanged: " << (eval_weights_unchanged ? "yes" : "NO") << "\n"
                  << "  report: " << args.out << "\n";

        return (c1 && c2 && c3 && c4 && eval_weights_unchanged) ? 0 : 1;
    } catch (const std::exception& e) {
        std::cerr << "learning_loop: " << e.what() << "\n";
        return 2;
    }
}
