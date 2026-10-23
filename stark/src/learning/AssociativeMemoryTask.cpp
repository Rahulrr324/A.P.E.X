#include "AssociativeMemoryTask.h"
#include <random>
#include <algorithm>
#include <stdexcept>

namespace learning {

namespace {
int amTotalSteps(const AMConfig& cfg) {
    return cfg.cue_steps + cfg.interf_steps + cfg.decision_steps;
}
} // namespace

AMMapping makeMapping(unsigned seed, int n_cues) {
    if (n_cues <= 1) throw std::invalid_argument("makeMapping: n_cues must be > 1");
    AMMapping m;
    m.perm.resize(static_cast<size_t>(n_cues));
    m.train_order.resize(static_cast<size_t>(n_cues));
    for (int i = 0; i < n_cues; ++i) {
        m.perm[static_cast<size_t>(i)] = i;
        m.train_order[static_cast<size_t>(i)] = i;
    }
    // Two independent seeded streams: response permutation and cue order.
    std::mt19937 rng_pi(seed ^ 0x9E3779B9u);
    std::mt19937 rng_sigma(seed);
    std::shuffle(m.perm.begin(), m.perm.end(), rng_pi);
    std::shuffle(m.train_order.begin(), m.train_order.end(), rng_sigma);
    return m;
}

std::vector<AMTrialSchedule> makeAMTrials(const AMConfig& cfg,
                                         const AMMapping& map, int n_items,
                                         int per_item, unsigned seed, bool heavy) {
    if (n_items <= 0 || n_items > cfg.n_cues)
        throw std::invalid_argument("makeAMTrials: bad n_items");
    if (per_item <= 0) throw std::invalid_argument("makeAMTrials: per_item must be > 0");
    if (cfg.p_none < 0.0 || cfg.p_none > 1.0)
        throw std::invalid_argument("makeAMTrials: p_none must be in [0,1]");
    if (static_cast<int>(map.train_order.size()) != cfg.n_cues)
        throw std::invalid_argument("makeAMTrials: mapping size mismatch");

    // Balanced query list: each trained item exactly `per_item` times, shuffled.
    std::vector<int> queries;
    queries.reserve(static_cast<size_t>(n_items * per_item));
    for (int k = 0; k < n_items; ++k) {
        int cue = map.train_order[static_cast<size_t>(k)];
        for (int t = 0; t < per_item; ++t) queries.push_back(cue);
    }

    std::mt19937 rng(seed);
    std::shuffle(queries.begin(), queries.end(), rng);

    const int total = amTotalSteps(cfg);
    const double p_none = heavy ? 0.0 : cfg.p_none;
    std::uniform_real_distribution<double> unif(0.0, 1.0);

    std::vector<AMTrialSchedule> out(queries.size());
    for (size_t t = 0; t < queries.size(); ++t) {
        AMTrialSchedule& s = out[t];
        s.cue = queries[t];

        // Interference: unrelated item cues only; with replacement; never
        // branched on the response label (no answer leakage).
        s.distractors.resize(static_cast<size_t>(cfg.interf_steps));
        for (int k = 0; k < cfg.interf_steps; ++k) {
            double u = unif(rng);
            if (u < p_none) {
                s.distractors[static_cast<size_t>(k)] = -1;
            } else {
                int j = static_cast<int>(unif(rng) * (cfg.n_cues - 1));
                if (j > s.cue) ++j; // skip the queried cue
                if (j >= cfg.n_cues) j = cfg.n_cues - 1;
                if (j == s.cue) j = (j + 1) % cfg.n_cues;
                s.distractors[static_cast<size_t>(k)] = j;
            }
        }

        // Noise per response unit over cue+interf+decision steps (unit-major).
        s.noise.resize(static_cast<size_t>(cfg.n_resp * total));
        for (int r = 0; r < cfg.n_resp; ++r) {
            for (int k = 0; k < total; ++k) {
                double amp = (k < cfg.cue_steps) ? cfg.noise_cue
                           : (k < cfg.cue_steps + cfg.interf_steps) ? cfg.noise_seq
                           : cfg.noise_decision;
                s.noise[static_cast<size_t>(r * total + k)] =
                    (unif(rng) * 2.0 - 1.0) * amp;
            }
        }
        s.tie_u = unif(rng);
    }
    return out;
}

AMAgent makeAMAgent(const AMConfig& cfg, bool plastic) {
    AMAgent a;
    NeuralCell scell(cfg.tau_m, cfg.theta_cue, cfg.tau_a, cfg.adapt_b, cfg.v_reset);
    NeuralCell acell(cfg.tau_m, cfg.theta_action, cfg.tau_a, cfg.adapt_b, cfg.v_reset);
    a.s.resize(static_cast<size_t>(cfg.n_cues));
    a.a.resize(static_cast<size_t>(cfg.n_resp));
    for (int i = 0; i < cfg.n_cues; ++i) a.s[static_cast<size_t>(i)] = a.net.addNeuron(scell);
    for (int r = 0; r < cfg.n_resp; ++r) a.a[static_cast<size_t>(r)] = a.net.addNeuron(acell);

    // Plastic S->A matrix; delivery delay floor(r/2) = fixed exploration rung
    // (label-free architecture scaffold).
    a.syn.resize(static_cast<size_t>(cfg.n_cues));
    for (int i = 0; i < cfg.n_cues; ++i) {
        a.syn[static_cast<size_t>(i)].resize(static_cast<size_t>(cfg.n_resp));
        for (int r = 0; r < cfg.n_resp; ++r) {
            size_t id = a.net.addSynapse(a.s[static_cast<size_t>(i)],
                                         a.a[static_cast<size_t>(r)],
                                         cfg.w_init, cfg.tau_s,
                                         /*delay=*/static_cast<size_t>(r / 2));
            if (plastic) {
                a.net.getSynapse(id).setFullState(
                    /*x=*/0.0, cfg.w_init, /*x_pre=*/0.0, /*x_post=*/0.0,
                    /*A_plus=*/0.0, /*A_minus=*/0.0,
                    cfg.tau_pre, cfg.tau_post,
                    cfg.w_min, cfg.w_max, /*plasticity_enabled=*/true,
                    /*e=*/0.0, cfg.E_plus, cfg.E_minus, cfg.tau_e, cfg.eta_3f,
                    /*three_factor_enabled=*/true, PlasticityMode::THREEFACTOR);
            }
            a.syn[static_cast<size_t>(i)][static_cast<size_t>(r)] = id;
        }
    }

    // Fixed WTA (pairwise) + per-unit attractor (self-excitation).
    for (int r = 0; r < cfg.n_resp; ++r) {
        for (int q = 0; q < cfg.n_resp; ++q) {
            if (r == q) continue;
            a.wta.push_back(a.net.addSynapse(a.a[static_cast<size_t>(r)],
                                             a.a[static_cast<size_t>(q)],
                                             cfg.w_inh, cfg.tau_s, /*delay=*/0));
        }
    }
    for (int r = 0; r < cfg.n_resp; ++r) {
        a.self.push_back(a.net.addSynapse(a.a[static_cast<size_t>(r)],
                                          a.a[static_cast<size_t>(r)],
                                          cfg.w_self, cfg.tau_s, /*delay=*/0));
    }
    return a;
}

AMTrialResult runAMTrial(AMAgent& agent, const AMConfig& cfg,
                         const AMTrialSchedule& sched, const AMMapping& map,
                         bool learning_enabled) {
    if (sched.cue < 0 || sched.cue >= cfg.n_cues)
        throw std::invalid_argument("runAMTrial: cue out of range");
    const int total = amTotalSteps(cfg);
    if (static_cast<int>(sched.noise.size()) != cfg.n_resp * total)
        throw std::invalid_argument("runAMTrial: noise size mismatch");
    if (static_cast<int>(sched.distractors.size()) != cfg.interf_steps)
        throw std::invalid_argument("runAMTrial: distractors size mismatch");

    agent.net.reset();
    AMTrialResult out;
    out.cue = sched.cue;
    const int correct = map.perm[static_cast<size_t>(sched.cue)];

    // 1. Encoding window: drive the queried cue for cue_steps (3 spikes).
    for (int k = 0; k < cfg.cue_steps; ++k) {
        for (int i = 0; i < cfg.n_cues; ++i) {
            agent.net.setExternalInput(agent.s[static_cast<size_t>(i)],
                                       (i == sched.cue) ? cfg.cue_current : 0.0);
        }
        for (int r = 0; r < cfg.n_resp; ++r) {
            agent.net.setExternalInput(
                agent.a[static_cast<size_t>(r)],
                cfg.background_current +
                    sched.noise[static_cast<size_t>(r * total + k)]);
        }
        agent.net.step(cfg.dt);
    }

    // 2. Interference window: unrelated item cues only.
    for (int k = 0; k < cfg.interf_steps; ++k) {
        const int j = sched.distractors[static_cast<size_t>(k)];
        for (int i = 0; i < cfg.n_cues; ++i) {
            agent.net.setExternalInput(agent.s[static_cast<size_t>(i)],
                                       (i == j) ? cfg.cue_current : 0.0);
        }
        for (int r = 0; r < cfg.n_resp; ++r) {
            agent.net.setExternalInput(
                agent.a[static_cast<size_t>(r)],
                cfg.background_current +
                    sched.noise[static_cast<size_t>(r * total + cfg.cue_steps + k)]);
        }
        agent.net.step(cfg.dt);

        const std::vector<bool>& sp = agent.net.getSpikesThisStep();
        for (int r = 0; r < cfg.n_resp; ++r) {
            if (sp[agent.a[static_cast<size_t>(r)]]) {
                if (r == correct) ++out.spikes_correct_interf;
                else ++out.spikes_other_interf;
            }
        }
    }

    // 3. Decision window: spike-count majority (tie: first spike, then seed).
    std::vector<int> counts(static_cast<size_t>(cfg.n_resp), 0);
    std::vector<long> first(static_cast<size_t>(cfg.n_resp), -1);
    for (int k = 0; k < cfg.decision_steps; ++k) {
        for (int i = 0; i < cfg.n_cues; ++i) {
            agent.net.setExternalInput(agent.s[static_cast<size_t>(i)], 0.0);
        }
        for (int r = 0; r < cfg.n_resp; ++r) {
            agent.net.setExternalInput(
                agent.a[static_cast<size_t>(r)],
                cfg.background_current +
                    sched.noise[static_cast<size_t>(r * total + cfg.cue_steps +
                                                    cfg.interf_steps + k)]);
        }
        agent.net.step(cfg.dt);

        const std::vector<bool>& sp = agent.net.getSpikesThisStep();
        for (int r = 0; r < cfg.n_resp; ++r) {
            if (sp[agent.a[static_cast<size_t>(r)]]) {
                ++counts[static_cast<size_t>(r)];
                if (first[static_cast<size_t>(r)] < 0) first[static_cast<size_t>(r)] = k;
            }
        }
    }

    int choice = -1;
    int best = -1;
    for (int r = 0; r < cfg.n_resp; ++r) {
        if (counts[static_cast<size_t>(r)] > best) {
            best = counts[static_cast<size_t>(r)];
            choice = r;
        }
    }
    // Ties on count: earliest first spike; still tied: the seeded draw.
    std::vector<int> tied;
    for (int r = 0; r < cfg.n_resp; ++r) {
        if (counts[static_cast<size_t>(r)] == best) tied.push_back(r);
    }
    if (tied.size() > 1) {
        long fmin = 1L << 30;
        for (int r : tied) {
            long f = first[static_cast<size_t>(r)];
            if (f >= 0 && f < fmin) fmin = f;
        }
        std::vector<int> tied2;
        for (int r : tied) {
            long f = first[static_cast<size_t>(r)];
            if (f < 0 || f == fmin) tied2.push_back(r);
        }
        if (tied2.size() == 1) {
            choice = tied2[0];
        } else {
            // Seeded draw among the remaining tied units (never a fixed default).
            int idx = static_cast<int>(sched.tie_u * static_cast<double>(tied2.size()));
            if (idx >= static_cast<int>(tied2.size())) idx = static_cast<int>(tied2.size()) - 1;
            choice = tied2[static_cast<size_t>(idx)];
        }
    }

    out.choice = choice;
    out.reward = (choice == correct) ? 1.0 : -1.0;

    // 4. Quiet reward delay: zero task input; tonic baseline persists.
    for (int k = 0; k < cfg.reward_delay; ++k) {
        for (int i = 0; i < cfg.n_cues; ++i)
            agent.net.setExternalInput(agent.s[static_cast<size_t>(i)], 0.0);
        for (int r = 0; r < cfg.n_resp; ++r)
            agent.net.setExternalInput(agent.a[static_cast<size_t>(r)],
                                       cfg.background_current);
        agent.net.step(cfg.dt);
    }

    // 5. Outcome step: one modulator timestep (task reward or sham +1).
    for (int i = 0; i < cfg.n_cues; ++i)
        agent.net.setExternalInput(agent.s[static_cast<size_t>(i)], 0.0);
    for (int r = 0; r < cfg.n_resp; ++r)
        agent.net.setExternalInput(agent.a[static_cast<size_t>(r)],
                                   cfg.background_current);
    if (learning_enabled) {
        out.modulator = cfg.reward_contingent ? out.reward : 1.0;
        agent.net.setModulatorySignal(out.modulator);
    }
    agent.net.step(cfg.dt);

    return out;
}

std::vector<std::vector<double>> amWeights(const AMAgent& agent) {
    std::vector<std::vector<double>> w(agent.syn.size());
    for (size_t i = 0; i < agent.syn.size(); ++i) {
        w[i].resize(agent.syn[i].size());
        for (size_t r = 0; r < agent.syn[i].size(); ++r) {
            w[i][r] = agent.net.getSynapse(agent.syn[i][r]).getWeight();
        }
    }
    return w;
}

void amWipeWeights(AMAgent& agent, const AMConfig& cfg) {
    for (size_t i = 0; i < agent.syn.size(); ++i) {
        for (size_t r = 0; r < agent.syn[i].size(); ++r) {
            agent.net.getSynapse(agent.syn[i][r]).setWeight(cfg.w_init);
        }
    }
}

} // namespace learning
