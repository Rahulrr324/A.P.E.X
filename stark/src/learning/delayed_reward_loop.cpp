/**
 * STARK-L2: Delayed-reward learning experiment (see
 * stark/design/delayed_reward_milestone.md — protocol and criteria frozen).
 *
 * Question: does STARK-006 three-factor plasticity assign credit across a
 * temporal gap between decision and reward, and does learning degrade as the
 * gap grows relative to tau_e?
 *
 * Conditions (paired: identical schedules/seeds for all):
 *   C-D0 / C-D4 / C-D8 / C-D16 : delay D quiet steps, tau_e = 8
 *   C-RESCUE                   : delay 16, tau_e = 32
 * Each with trained (task reward), sham (m = +1 always), frozen baseline.
 *
 * Usage:
 *   delayed_reward_loop --out report.json [--seed N] [--train N] [--eval N]
 *
 * Exit 0 iff every frozen criterion (L2-A..G) passes.
 */

#include "learning/ToyAssociationTask.h"
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <iomanip>
#include <stdexcept>
#include <cmath>
#include <vector>
#include <array>

using namespace learning;

namespace {

struct Args {
    std::string out = "delayed_reward_report.json";
    unsigned seed = 0;
    int train = -1;
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

std::string num(double v) {
    std::ostringstream os;
    os << std::fixed << std::setprecision(6) << v;
    return os.str();
}

/// Wilson 95% confidence interval for a binomial proportion.
std::array<double, 2> wilson(int hits, int n) {
    const double z = 1.959963984540054;
    double p = static_cast<double>(hits) / n;
    double d = 1.0 + z * z / n;
    double c = (p + z * z / (2 * n)) / d;
    double h = z * std::sqrt(p * (1 - p) / n + z * z / (4.0 * n * n)) / d;
    return {c - h, c + h};
}

struct AgentOutcome {
    double acc = 0;
    int hits = 0;
    std::array<double, 2> ci{0, 0};
    double acc_cue0 = 0, acc_cue1 = 0;
    int chose0_cue0 = 0, chose0_cue1 = 0;
    std::vector<double> rewards;
    std::vector<double> w;
    double pair_gap = 0;
};

AgentOutcome evaluate(Agent& a, const TaskConfig& cfg,
                      const std::vector<TrialSchedule>& eval_sched,
                      const std::vector<double>& w) {
    AgentOutcome o;
    o.w = w;
    int hits0 = 0, hits1 = 0, n0 = 0, n1 = 0;
    for (const TrialSchedule& s : eval_sched) {
        TrialResult r = runTrial(a, cfg, s, /*learning_enabled=*/false);
        o.rewards.push_back(r.reward);
        if (r.reward > 0) ++o.hits;
        if (r.cue == 0) { ++n0; if (r.reward > 0) ++hits0; if (r.choice == 0) ++o.chose0_cue0; }
        else            { ++n1; if (r.reward > 0) ++hits1; if (r.choice == 0) ++o.chose0_cue1; }
    }
    int n = static_cast<int>(eval_sched.size());
    o.acc = static_cast<double>(o.hits) / n;
    o.ci = wilson(o.hits, n);
    o.acc_cue0 = n0 ? static_cast<double>(hits0) / n0 : 0.0;
    o.acc_cue1 = n1 ? static_cast<double>(hits1) / n1 : 0.0;
    o.pair_gap = 0.5 * (w[0] + w[3]) - 0.5 * (w[1] + w[2]);
    return o;
}

struct CondSpec {
    const char* name;
    int delay;
    double tau_e;
};

} // namespace

int main(int argc, char** argv) {
    try {
        Args args = parseArgs(argc, argv);
        TaskConfig base;
        if (args.seed != 0) base.master_seed = args.seed;
        if (args.train > 0) base.train_trials = args.train;
        if (args.eval > 0) base.eval_trials = args.eval;

        const unsigned seed_train = base.master_seed;
        const unsigned seed_eval = base.master_seed + 1u;

        // Shared schedules for ALL conditions (paired design).
        std::vector<TrialSchedule> train_sched =
            makeSchedule(base, base.train_trials, seed_train);
        std::vector<TrialSchedule> eval_sched =
            makeSchedule(base, base.eval_trials, seed_eval);

        const std::array<CondSpec, 5> conds = {{
            {"C-D0",      0,  8.0},
            {"C-D4",      4,  8.0},
            {"C-D8",      8,  8.0},
            {"C-D16",    16,  8.0},
            {"C-RESCUE", 16, 32.0},
        }};

        struct CondRun {
            CondSpec spec;
            AgentOutcome trained, sham, baseline;
            double first20 = 0, last20 = 0;
            std::vector<double> w_trained, w_sham, w_baseline;
        };
        std::vector<CondRun> runs;

        for (const CondSpec& cs : conds) {
            CondRun cr;
            cr.spec = cs;
            TaskConfig cfg = base;
            cfg.reward_delay = cs.delay;
            cfg.tau_e = cs.tau_e;

            // Trained: task reward as modulator.
            Agent trained = makeAgent(cfg, /*plastic=*/true);
            std::vector<double> w_init = weights(trained);
            (void)w_init;
            for (const TrialSchedule& s : train_sched)
                runTrial(trained, cfg, s, /*learning_enabled=*/true);
            cr.w_trained = weights(trained);

            // Sham: modulator +1 every trial (reward_contingent=false).
            TaskConfig cfg_sham = cfg;
            cfg_sham.reward_contingent = false;
            Agent sham = makeAgent(cfg_sham, /*plastic=*/true);
            for (const TrialSchedule& s : train_sched)
                runTrial(sham, cfg_sham, s, /*learning_enabled=*/true);
            cr.w_sham = weights(sham);

            // Frozen baseline.
            Agent baseline = makeAgent(cfg, /*plastic=*/false);
            cr.w_baseline = weights(baseline);

            // Held-out evaluation (no modulator ever set).
            cr.trained = evaluate(trained, cfg, eval_sched, cr.w_trained);
            cr.sham = evaluate(sham, cfg_sham, eval_sched, cr.w_sham);
            cr.baseline = evaluate(baseline, cfg, eval_sched, cr.w_baseline);

            // Training reward trend from a fresh replay of the trained log.
            // (Re-run to collect the per-trial log without storing 5x Agent.)
            Agent t2 = makeAgent(cfg, /*plastic=*/true);
            double f20 = 0, l20 = 0;
            for (int t = 0; t < cfg.train_trials; ++t) {
                TrialResult r = runTrial(t2, cfg, train_sched[static_cast<size_t>(t)],
                                         /*learning_enabled=*/true);
                if (t < 20) f20 += r.reward;
                if (t >= cfg.train_trials - 20) l20 += r.reward;
            }
            cr.first20 = f20 / 20.0;
            cr.last20 = l20 / 20.0;
            // Replay determinism guard: t2 must end at identical weights.
            std::vector<double> w_replay = weights(t2);
            for (size_t i = 0; i < w_replay.size(); ++i)
                if (w_replay[i] != cr.w_trained[i])
                    throw std::runtime_error("training replay is not deterministic");

            runs.push_back(cr);
        }

        // ---- Cross-condition metrics ----
        // OLS slope of trained accuracy vs delay over the tau_e=8 conditions.
        double sx = 0, sy = 0, sxx = 0, sxy = 0;
        int m = 4; // C-D0..C-D16
        for (int i = 0; i < m; ++i) {
            double x = runs[static_cast<size_t>(i)].spec.delay;
            double y = runs[static_cast<size_t>(i)].trained.acc;
            sx += x; sy += y; sxx += x * x; sxy += x * y;
        }
        double ols_slope = (m * sxy - sx * sy) / (m * sxx - sx * sx);

        // Baseline delay-invariance (decision precedes delay).
        bool baseline_invariant = true;
        for (int i = 1; i < m; ++i)
            if (runs[static_cast<size_t>(i)].baseline.hits !=
                runs[0].baseline.hits) baseline_invariant = false;

        // C-D0 must reproduce the committed L1 result (same config/seed).
        const std::array<double, 4> l1_w = {1.0, 0.322017, 0.471444, 1.0};
        bool d0_matches_l1 = (runs[0].trained.hits == base.eval_trials); // acc == 1.0
        for (size_t i = 0; i < 4; ++i)
            if (std::fabs(runs[0].w_trained[i] - l1_w[i]) > 2e-6) d0_matches_l1 = false;

        // ---- Frozen criteria (delayed_reward_milestone.md §6) ----
        bool a = runs[1].trained.acc >= 0.80 &&
                 (runs[1].trained.acc - runs[1].baseline.acc) >= 0.25;
        bool b = (runs[0].trained.acc - runs[3].trained.acc) >= 0.15 && ols_slope < 0.0;
        bool c = (runs[4].trained.acc - runs[3].trained.acc) >= 0.10;
        bool d = runs[0].sham.acc <= 0.65 && runs[3].sham.acc <= 0.65 &&
                 (runs[0].trained.acc - runs[0].sham.acc) >= 0.25;
        // L2-E (determinism) is checked externally by running the binary twice.
        bool g = baseline_invariant && d0_matches_l1;

        // ---- Report ----
        std::ostringstream j;
        j << "{\n";
        j << "  \"schema\": \"STARK-L2-1\",\n";
        j << "  \"seeds\": { \"master\": " << base.master_seed
          << ", \"train\": " << seed_train << ", \"eval\": " << seed_eval << " },\n";
        j << "  \"config\": { \"train_trials\": " << base.train_trials
          << ", \"eval_trials\": " << base.eval_trials
          << ", \"cue_steps\": " << base.cue_steps
          << ", \"dt\": " << num(base.dt)
          << ", \"eta_3f\": " << num(base.eta_3f)
          << ", \"E_plus\": " << num(base.E_plus)
          << ", \"E_minus\": " << num(base.E_minus)
          << ", \"tau_pre\": " << num(base.tau_pre)
          << ", \"tau_post\": " << num(base.tau_post)
          << ", \"tau_e_default\": " << num(base.tau_e)
          << ", \"w_inh\": " << num(base.w_inh)
          << ", \"noise_amp\": " << num(base.noise_amp)
          << ", \"cue_current\": " << num(base.cue_current)
          << ", \"background_current\": " << num(base.background_current) << " },\n";

        j << "  \"conditions\": [\n";
        for (size_t k = 0; k < runs.size(); ++k) {
            const CondRun& cr = runs[k];
            auto emit_agent = [&](const char* key, const AgentOutcome& o,
                                  const std::vector<double>& w, bool with_log) {
                j << "    \"" << key << "\": { \"accuracy\": " << num(o.acc)
                  << ", \"ci95\": [" << num(o.ci[0]) << ", " << num(o.ci[1]) << "]"
                  << ", \"acc_cue0\": " << num(o.acc_cue0)
                  << ", \"acc_cue1\": " << num(o.acc_cue1)
                  << ", \"chose0_cue0\": " << o.chose0_cue0
                  << ", \"chose0_cue1\": " << o.chose0_cue1
                  << ", \"weights\": [" << num(w[0]) << ", " << num(w[1]) << ", "
                  << num(w[2]) << ", " << num(w[3]) << "]"
                  << ", \"pair_gap\": " << num(o.pair_gap);
                if (with_log) {
                    j << ", \"rewards\": [";
                    for (size_t i = 0; i < o.rewards.size(); ++i)
                        j << (i ? ", " : "") << num(o.rewards[i]);
                    j << "]";
                }
                j << " }";
            };
            j << "    { \"name\": \"" << cr.spec.name
              << "\", \"delay\": " << cr.spec.delay
              << ", \"tau_e\": " << num(cr.spec.tau_e) << ",\n";
            emit_agent("trained", cr.trained, cr.w_trained, true);
            j << ",\n";
            emit_agent("sham", cr.sham, cr.w_sham, true);
            j << ",\n";
            emit_agent("baseline", cr.baseline, cr.w_baseline, true);
            j << ",\n";
            j << "      \"training_summary\": { \"first20_mean_reward\": "
              << num(cr.first20) << ", \"last20_mean_reward\": " << num(cr.last20)
              << " }\n";
            j << "    }" << (k + 1 < runs.size() ? "," : "") << "\n";
        }
        j << "  ],\n";

        j << "  \"trend\": { \"ols_slope_acc_per_step\": " << num(ols_slope)
          << ", \"acc_by_delay\": {";
        for (int i = 0; i < m; ++i) {
            j << (i ? ", " : "") << " \"D" << runs[static_cast<size_t>(i)].spec.delay
              << "\": " << num(runs[static_cast<size_t>(i)].trained.acc);
        }
        j << " } },\n";

        j << "  \"consistency\": { \"baseline_delay_invariant\": "
          << (baseline_invariant ? "true" : "false")
          << ", \"d0_matches_L1\": " << (d0_matches_l1 ? "true" : "false") << " },\n";

        j << "  \"criteria\": { \"L2-A\": " << (a ? "true" : "false")
          << ", \"L2-B\": " << (b ? "true" : "false")
          << ", \"L2-C\": " << (c ? "true" : "false")
          << ", \"L2-D\": " << (d ? "true" : "false")
          << ", \"L2-G\": " << (g ? "true" : "false") << " }\n";
        j << "}\n";

        std::ofstream f(args.out);
        if (!f) throw std::runtime_error("cannot write " + args.out);
        f << j.str();
        f.close();

        std::cout << "STARK-L2 delayed-reward learning\n";
        std::cout << "  cond      delay tau_e  trained   [95% CI]        sham   base   gap\n";
        for (const CondRun& cr : runs) {
            std::cout << "  " << std::left << std::setw(9) << cr.spec.name
                      << std::right << std::setw(3) << cr.spec.delay << "  "
                      << std::setw(4) << cr.spec.tau_e << "  "
                      << num(cr.trained.acc) << "  [" << num(cr.trained.ci[0])
                      << ", " << num(cr.trained.ci[1]) << "]  "
                      << num(cr.sham.acc) << "  " << num(cr.baseline.acc) << "  "
                      << num(cr.trained.pair_gap) << "\n";
        }
        std::cout << "  OLS slope (acc vs delay, tau_e=8): " << num(ols_slope)
                  << " per step\n";
        std::cout << "  consistency: baseline_delay_invariant="
                  << (baseline_invariant ? "yes" : "NO")
                  << " d0_matches_L1=" << (d0_matches_l1 ? "yes" : "NO") << "\n";
        std::cout << "  criteria L2-A..D,G: " << (a ? "PASS" : "FAIL") << " "
                  << (b ? "PASS" : "FAIL") << " " << (c ? "PASS" : "FAIL") << " "
                  << (d ? "PASS" : "FAIL") << " " << (g ? "PASS" : "FAIL") << "\n"
                  << "  report: " << args.out << "\n";

        return (a && b && c && d && g) ? 0 : 1;
    } catch (const std::exception& e) {
        std::cerr << "delayed_reward_loop: " << e.what() << "\n";
        return 2;
    }
}
