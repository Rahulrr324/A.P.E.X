// STARK-L10: Context-Conditioned Memory — implementation.
// Frozen protocol: stark/design/context_conditioned_memory_milestone.md v1.0.

#include "learning/ContextConditionedMemory.h"

#include <algorithm>
#include <cmath>
#include <sstream>
#include <stdexcept>

namespace learning {

namespace {

double clampAbs(double x, double lim) {
    if (x > lim) return lim;
    if (x < -lim) return -lim;
    return x;
}

// Softmax over bank scores.
std::vector<double> softmaxScores(const std::vector<double>& sc, double T) {
    std::vector<double> p(sc.size(), 0.0);
    double mx = sc.empty() ? 0.0 : *std::max_element(sc.begin(), sc.end());
    double z = 0.0;
    for (size_t k = 0; k < sc.size(); ++k) {
        p[k] = std::exp((sc[k] - mx) / T);
        z += p[k];
    }
    for (size_t k = 0; k < p.size(); ++k) p[k] /= z;
    return p;
}

} // namespace

CCAgent makeCCAgent(const CCConfig& cfg, bool plastic) {
    CCAgent ag;
    ag.cfg = cfg;
    const LRConfig& lc = cfg.lr;
    const int K = cfg.n_banks;
    const int n = lc.n_ids;

    NeuralCell scell(lc.tau_m, lc.theta_cue, lc.tau_a, lc.adapt_b, lc.v_reset);
    NeuralCell acell(lc.tau_m, lc.theta_action, lc.tau_a, lc.adapt_b, lc.v_reset);

    // --- observable cue features (input only; isolated from the banks) ---
    ag.cue.resize(static_cast<size_t>(cfg.n_feat));
    for (int f = 0; f < cfg.n_feat; ++f) ag.cue[static_cast<size_t>(f)] = ag.net.addNeuron(scell);

    // --- per-bank identity / response populations ---
    ag.s.assign(static_cast<size_t>(K), {});
    ag.a.assign(static_cast<size_t>(K), {});
    for (int k = 0; k < K; ++k) {
        ag.s[static_cast<size_t>(k)].resize(static_cast<size_t>(n));
        ag.a[static_cast<size_t>(k)].resize(static_cast<size_t>(n));
        for (int i = 0; i < n; ++i) ag.s[static_cast<size_t>(k)][static_cast<size_t>(i)] = ag.net.addNeuron(scell);
        for (int r = 0; r < n; ++r) ag.a[static_cast<size_t>(k)][static_cast<size_t>(r)] = ag.net.addNeuron(acell);
    }

    // --- shared channel markers / context neurons (L6-L9) ---
    ag.l.resize(static_cast<size_t>(lc.n_chan));
    for (int s = 0; s < lc.n_chan; ++s) ag.l[static_cast<size_t>(s)] = ag.net.addNeuron(scell);
    ag.c.resize(static_cast<size_t>(lc.n_ctx));
    for (int q = 0; q < lc.n_ctx; ++q) ag.c[static_cast<size_t>(q)] = ag.net.addNeuron(scell);

    // --- router readout cells (weights only; never driven) ---
    ag.rr.resize(static_cast<size_t>(K));
    for (int k = 0; k < K; ++k) ag.rr[static_cast<size_t>(k)] = ag.net.addNeuron(scell);

    // --- plastic S->A matrix per bank (identical to L9 per bank) ---
    ag.syn.assign(static_cast<size_t>(K), {});
    for (int k = 0; k < K; ++k) {
        ag.syn[static_cast<size_t>(k)].assign(static_cast<size_t>(n), {});
        for (int i = 0; i < n; ++i) {
            ag.syn[static_cast<size_t>(k)][static_cast<size_t>(i)].resize(static_cast<size_t>(n));
            for (int r = 0; r < n; ++r) {
                size_t id = ag.net.addSynapse(ag.s[static_cast<size_t>(k)][static_cast<size_t>(i)],
                                              ag.a[static_cast<size_t>(k)][static_cast<size_t>(r)],
                                              lc.w_init, lc.tau_s, /*delay=*/static_cast<size_t>(r / 2));
                if (plastic) {
                    ag.net.getSynapse(id).setFullState(
                        0.0, lc.w_init, 0.0, 0.0, 0.0, 0.0,
                        lc.tau_pre, lc.tau_post, lc.w_min, lc.w_max, true,
                        0.0, lc.E_plus, lc.E_minus, lc.tau_e, lc.eta_3f,
                        true, PlasticityMode::THREEFACTOR);
                }
                ag.syn[static_cast<size_t>(k)][static_cast<size_t>(i)][static_cast<size_t>(r)] = id;
            }
        }
    }

    // --- intra-bank WTA + self excitation ---
    ag.wta.assign(static_cast<size_t>(K), {});
    ag.self.assign(static_cast<size_t>(K), {});
    for (int k = 0; k < K; ++k) {
        for (int r = 0; r < n; ++r)
            for (int q = 0; q < n; ++q) {
                if (r == q) continue;
                ag.wta[static_cast<size_t>(k)].push_back(
                    ag.net.addSynapse(ag.a[static_cast<size_t>(k)][static_cast<size_t>(r)],
                                      ag.a[static_cast<size_t>(k)][static_cast<size_t>(q)],
                                      lc.w_inh, lc.tau_s, 0));
            }
        for (int r = 0; r < n; ++r)
            ag.self[static_cast<size_t>(k)].push_back(
                ag.net.addSynapse(ag.a[static_cast<size_t>(k)][static_cast<size_t>(r)],
                                  ag.a[static_cast<size_t>(k)][static_cast<size_t>(r)],
                                  lc.w_self, lc.tau_s, 0));
    }

    // --- channel routing state v[ctx][chan] (L6-L9, unchanged) ---
    ag.route.assign(static_cast<size_t>(lc.n_ctx), std::vector<size_t>(static_cast<size_t>(lc.n_chan), 0));
    for (int q = 0; q < lc.n_ctx; ++q)
        for (int s = 0; s < lc.n_chan; ++s)
            ag.route[static_cast<size_t>(q)][static_cast<size_t>(s)] =
                ag.net.addSynapse(ag.c[static_cast<size_t>(q)], ag.l[static_cast<size_t>(s)], 0.0, lc.tau_s, 0);

    // --- router weights W[feat][bank] stored in ordinary synapses ---
    ag.router.assign(static_cast<size_t>(cfg.n_feat), std::vector<size_t>(static_cast<size_t>(K), 0));
    for (int f = 0; f < cfg.n_feat; ++f)
        for (int k = 0; k < K; ++k)
            ag.router[static_cast<size_t>(f)][static_cast<size_t>(k)] =
                ag.net.addSynapse(ag.cue[static_cast<size_t>(f)], ag.rr[static_cast<size_t>(k)], 0.0, lc.tau_s, 0);

    ag.bank_state.assign(static_cast<size_t>(K), CC_UNALLOCATED);
    ag.reward_baseline.assign(static_cast<size_t>(K), 0.0);
    return ag;
}

std::vector<std::vector<double>> ccRouterWeights(const CCAgent& agent) {
    std::vector<std::vector<double>> W(agent.router.size());
    for (size_t f = 0; f < agent.router.size(); ++f) {
        W[f].resize(agent.router[f].size());
        for (size_t k = 0; k < agent.router[f].size(); ++k)
            W[f][k] = agent.net.getSynapse(agent.router[f][k]).getWeight();
    }
    return W;
}

std::vector<std::vector<std::vector<double>>> ccBankWeights(const CCAgent& agent) {
    std::vector<std::vector<std::vector<double>>> W(agent.syn.size());
    for (size_t k = 0; k < agent.syn.size(); ++k) {
        W[k].assign(agent.syn[k].size(), {});
        for (size_t i = 0; i < agent.syn[k].size(); ++i) {
            W[k][i].resize(agent.syn[k][i].size());
            for (size_t r = 0; r < agent.syn[k][i].size(); ++r)
                W[k][i][r] = agent.net.getSynapse(agent.syn[k][i][r]).getWeight();
        }
    }
    return W;
}

int ccActiveBank(const CCAgent& agent) {
    // Most recently activated bank (with sealing there is at most one; without
    // sealing — the NO-SEAL ablation — several banks stay writable and the
    // newest is the one the current task writes into).
    int active = -1;
    for (size_t k = 0; k < agent.bank_state.size(); ++k)
        if (agent.bank_state[k] == CC_ACTIVE) active = static_cast<int>(k);
    return active;
}

int ccAllocateNext(CCAgent& agent, bool seal) {
    int prev = ccActiveBank(agent);
    int next = -1;
    for (size_t k = 0; k < agent.bank_state.size(); ++k)
        if (agent.bank_state[k] == CC_UNALLOCATED) { next = static_cast<int>(k); break; }
    if (next < 0) return -1; // capacity exhausted
    if (prev >= 0 && prev != next && seal) agent.bank_state[static_cast<size_t>(prev)] = CC_SEALED;
    agent.bank_state[static_cast<size_t>(next)] = CC_ACTIVE;
    return next;
}

namespace {

// Banks eligible for selection: allocated banks only when configured (a bank
// with no memory cannot be selected), otherwise all banks.
std::vector<char> candidateMask(const CCAgent& agent) {
    std::vector<char> m(static_cast<size_t>(agent.cfg.n_banks), 0);
    bool any = false;
    for (size_t k = 0; k < m.size(); ++k) {
        const bool alloc = agent.bank_state[k] != CC_UNALLOCATED;
        if (alloc) any = true;
        m[k] = agent.cfg.route_over_allocated_only ? (alloc ? 1 : 0) : 1;
    }
    if (!any) { // nothing allocated yet: all banks are candidates
        for (size_t k = 0; k < m.size(); ++k) m[k] = 1;
    }
    return m;
}

// Bank scores for a cue pattern (sum of the active features' router weights).
std::vector<double> bankScores(const CCAgent& agent, const std::vector<int>& cue) {
    const int K = agent.cfg.n_banks;
    std::vector<double> sc(static_cast<size_t>(K), 0.0);
    for (int f : cue) {
        if (f < 0 || f >= agent.cfg.n_feat) continue;
        for (int k = 0; k < K; ++k)
            sc[static_cast<size_t>(k)] += agent.net.getSynapse(agent.router[static_cast<size_t>(f)][static_cast<size_t>(k)]).getWeight();
    }
    return sc;
}

} // namespace

int ccPreferredBank(const CCAgent& agent, const std::vector<int>& cue) {
    std::vector<double> sc = bankScores(agent, cue);
    if (sc.empty()) return -1;
    std::vector<char> mask = candidateMask(agent);
    int best = -1;
    for (size_t k = 0; k < sc.size(); ++k) {
        if (!mask[k]) continue;
        if (best < 0 || sc[k] > sc[static_cast<size_t>(best)]) best = static_cast<int>(k);
    }
    return best < 0 ? 0 : best;
}

CCResult runCCTrial(CCAgent& agent, const CCTrialSchedule& sched,
                    const LRMapping& map, int task_bank,
                    CCBankMode mode, bool learning_enabled, bool router_learning,
                    int forced_bank) {
    const LRConfig& cfg = agent.cfg.lr;
    const int n = cfg.n_ids;
    const int n_chan = cfg.n_chan;
    const int K = agent.cfg.n_banks;
    const LRTrialSchedule& s = sched.lr;
    const int total = cfg.sample_steps + cfg.interf_steps + cfg.decision_steps;

    if (static_cast<int>(s.noise.size()) != n * total)
        throw std::invalid_argument("runCCTrial: noise size mismatch");

    agent.net.reset();

    CCResult out;
    if (s.single) {
        out.queried = (s.id0 >= 0) ? s.id0 : s.id1;
    } else {
        out.queried = s.presented[static_cast<size_t>(map.phi[static_cast<size_t>(s.ctx)])];
    }

    // ---- 1. Channel attention (identical to L9) ----
    std::vector<double> a(static_cast<size_t>(n_chan), 0.0);
    {
        std::vector<double> v(static_cast<size_t>(n_chan), 0.0), m(static_cast<size_t>(n_chan), 0.0);
        double z = 0.0;
        for (int c = 0; c < n_chan; ++c) {
            v[static_cast<size_t>(c)] = agent.net.getSynapse(agent.route[static_cast<size_t>(s.ctx)][static_cast<size_t>(c)]).getWeight();
            m[static_cast<size_t>(c)] = std::exp(v[static_cast<size_t>(c)] / cfg.softmax_T);
            z += m[static_cast<size_t>(c)];
        }
        for (int c = 0; c < n_chan; ++c) a[static_cast<size_t>(c)] = m[static_cast<size_t>(c)] / z;
    }
    out.a0 = a[0];
    out.a1 = (n_chan > 1) ? a[1] : 0.0;

    int sel = -1;
    std::vector<double> gain(static_cast<size_t>(n_chan), 1.0);
    if (s.single) {
        for (int c = 0; c < n_chan; ++c)
            if (s.presented[static_cast<size_t>(c)] < 0) gain[static_cast<size_t>(c)] = 0.0;
    } else {
        int sampled;
        if (n_chan <= 2) {
            sampled = (s.mech_u < a[0]) ? 0 : 1;
        } else {
            double u = s.mech_u;
            sampled = 0;
            while (sampled < n_chan - 1 && u > a[static_cast<size_t>(sampled)]) {
                u -= a[static_cast<size_t>(sampled)];
                ++sampled;
            }
        }
        sel = sampled;
        for (int c = 0; c < n_chan; ++c)
            if (c != sel) gain[static_cast<size_t>(c)] = 0.0;
    }
    out.sel_slot = sel;

    // ---- 2. Bank selection (learned router over observable cue features) ----
    std::vector<double> sc = bankScores(agent, sched.cue);
    const std::vector<double> p_unmasked = softmaxScores(sc, agent.cfg.router_T);
    std::vector<double> p = p_unmasked;
    {
        // restrict the policy to selectable banks (allocated only)
        std::vector<char> mask = candidateMask(agent);
        double z = 0.0;
        for (int k = 0; k < K; ++k) {
            if (!mask[static_cast<size_t>(k)]) p[static_cast<size_t>(k)] = 0.0;
            z += p[static_cast<size_t>(k)];
        }
        if (z <= 0.0) { // degenerate: uniform over candidates
            int nc = 0;
            for (int k = 0; k < K; ++k) if (mask[static_cast<size_t>(k)]) ++nc;
            for (int k = 0; k < K; ++k)
                p[static_cast<size_t>(k)] = mask[static_cast<size_t>(k)] ? 1.0 / nc : 0.0;
        } else {
            for (int k = 0; k < K; ++k) p[static_cast<size_t>(k)] /= z;
        }
        // exploration mixture over selectable banks (learning only)
        if (learning_enabled && agent.cfg.explore_eps > 0.0) {
            int nc = 0;
            for (int k = 0; k < K; ++k) if (mask[static_cast<size_t>(k)]) ++nc;
            const double eps = agent.cfg.explore_eps;
            for (int k = 0; k < K; ++k) {
                const double uni = mask[static_cast<size_t>(k)] ? 1.0 / nc : 0.0;
                p[static_cast<size_t>(k)] = (1.0 - eps) * p[static_cast<size_t>(k)] + eps * uni;
            }
        }
    }
    int bank = -1;
    if (mode == CC_ORACLE) {
        bank = task_bank; // DIAGNOSTIC UPPER BOUND ONLY
    } else if (mode == CC_FROZEN) {
        bank = 0;
    } else if (forced_bank >= 0) {
        bank = forced_bank; // commitment window (allocation structure)
    } else {
        if (learning_enabled) {
            // CDF sampling with the trial's seeded draw (deterministic).
            double u = s.mech_u;
            int k = 0;
            double acc = 0.0;
            for (; k < K; ++k) { acc += p[static_cast<size_t>(k)]; if (u <= acc) break; }
            if (k >= K) k = K - 1;
            bank = k;
        } else {
            bank = ccPreferredBank(agent, sched.cue);
        }
    }
    if (bank < 0 || bank >= K) bank = 0;
    out.bank = bank;

    // Writable iff the selected bank is the active bank. With sealing
    // disabled (NO-SEAL ablation) every allocated bank stays writable.
    const bool writable =
        (agent.bank_state[static_cast<size_t>(bank)] == CC_ACTIVE) ||
        (!agent.cfg.seal_superseded && agent.bank_state[static_cast<size_t>(bank)] != CC_UNALLOCATED);
    out.plastic_write = writable;

    // ---- 3. Eligibility gates (bank-scoped) ----
    const bool mapping_credit = s.single && writable;
    for (int k = 0; k < K; ++k)
        for (int i = 0; i < n; ++i)
            agent.net.setEligibilityGate(agent.s[static_cast<size_t>(k)][static_cast<size_t>(i)],
                                         mapping_credit && k == bank && i == out.queried);

    // ---- helper: drive one timestep with only `bank` active ----
    auto stepAll = [&](double cue_drive, bool cue_on, int cand_id, int distractor_id,
                       const std::vector<double>* noise_row_off, bool drive_channels,
                       int at) {
        // cue features
        for (int f = 0; f < agent.cfg.n_feat; ++f) {
            bool on = false;
            if (cue_on)
                for (int cf : sched.cue) if (cf == f) { on = true; break; }
            agent.net.setExternalInput(agent.cue[static_cast<size_t>(f)], on ? cue_drive : 0.0);
        }
        // context neurons
        for (int q = 0; q < cfg.n_ctx; ++q)
            agent.net.setExternalInput(agent.c[static_cast<size_t>(q)],
                                       (cue_on && q == s.ctx) ? cfg.cue_current : 0.0);
        // channel markers
        for (int c = 0; c < n_chan; ++c)
            agent.net.setExternalInput(agent.l[static_cast<size_t>(c)], drive_channels ? cfg.cue_current : 0.0);
        // identities: only the active bank
        for (int k = 0; k < K; ++k) {
            for (int i = 0; i < n; ++i) {
                double d = 0.0;
                if (k == bank) {
                    if (cand_id >= 0 && i == cand_id) d = cfg.cue_current;
                    if (distractor_id >= 0 && i == distractor_id) d = cfg.cue_current;
                }
                agent.net.setExternalInput(agent.s[static_cast<size_t>(k)][static_cast<size_t>(i)], d);
            }
            for (int r = 0; r < n; ++r) {
                double d = 0.0;
                if (k == bank) {
                    d = cfg.background_current;
                    if (noise_row_off) d += (*noise_row_off)[static_cast<size_t>(r * total + at)];
                }
                agent.net.setExternalInput(agent.a[static_cast<size_t>(k)][static_cast<size_t>(r)], d);
            }
        }
        agent.net.step(cfg.dt);
    };

    // ---- 4. Cue window ----
    for (int k = 0; k < cfg.ctx_steps; ++k)
        stepAll(cfg.cue_current, /*cue_on=*/true, -1, -1, nullptr, false, 0);

    // ---- 5. Sample window ----
    for (int k = 0; k < cfg.sample_steps; ++k) {
        int cand = -1;
        if (s.single) {
            cand = (s.presented[0] >= 0) ? s.presented[0] : s.presented[1];
        } else {
            cand = s.presented[static_cast<size_t>(sel)];
        }
        stepAll(0.0, false, cand, -1, &s.noise, true, k);
    }

    // ---- 6. Interference window ----
    for (int k = 0; k < cfg.interf_steps; ++k)
        stepAll(0.0, false, -1, s.distractors[static_cast<size_t>(k)], &s.noise, false,
                cfg.sample_steps + k);

    // ---- 7. Decision window (spike-count majority over the active bank) ----
    std::vector<int> counts(static_cast<size_t>(n), 0);
    std::vector<long> first(static_cast<size_t>(n), -1);
    for (int k = 0; k < cfg.decision_steps; ++k) {
        stepAll(0.0, false, -1, -1, &s.noise, false, cfg.sample_steps + cfg.interf_steps + k);
        const std::vector<bool>& sp = agent.net.getSpikesThisStep();
        for (int r = 0; r < n; ++r)
            if (sp[agent.a[static_cast<size_t>(bank)][static_cast<size_t>(r)]]) {
                ++counts[static_cast<size_t>(r)];
                if (first[static_cast<size_t>(r)] < 0) first[static_cast<size_t>(r)] = k;
            }
    }

    int choice = 0, best = -1;
    for (int r = 0; r < n; ++r)
        if (counts[static_cast<size_t>(r)] > best) { best = counts[static_cast<size_t>(r)]; choice = r; }
    std::vector<int> tied;
    for (int r = 0; r < n; ++r)
        if (counts[static_cast<size_t>(r)] == best) tied.push_back(r);
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
            int idx = static_cast<int>(s.tie_u * static_cast<double>(tied2.size()));
            if (idx >= static_cast<int>(tied2.size())) idx = static_cast<int>(tied2.size()) - 1;
            choice = tied2[static_cast<size_t>(idx)];
        }
    }
    out.choice = choice;
    out.reward = (choice == map.perm[static_cast<size_t>(out.queried)]) ? 1.0 : -1.0;

    // ---- 8. Quiet delay ----
    for (int k = 0; k < cfg.reward_delay; ++k) stepAll(0.0, false, -1, -1, nullptr, false, 0);

    // ---- 9. Reward step: modulator, channel REINFORCE, router REINFORCE ----
    if (learning_enabled) agent.net.setModulatorySignal(cfg.reward_contingent ? out.reward : 1.0);
    agent.net.step(cfg.dt);

    // channel policy (L6-L9, unchanged: multi-candidate trials only)
    if (learning_enabled && !s.single && sel >= 0) {
        for (int c = 0; c < n_chan; ++c) {
            const double grad = (c == sel) ? (1.0 - a[static_cast<size_t>(c)]) : (0.0 - a[static_cast<size_t>(c)]);
            size_t sid = agent.route[static_cast<size_t>(s.ctx)][static_cast<size_t>(c)];
            double vw = agent.net.getSynapse(sid).getWeight();
            vw = clampAbs(vw + cfg.beta_route * out.reward * grad, cfg.v_clamp);
            agent.net.getSynapse(sid).setWeight(vw);
        }
    }

    // router policy: every trial (including single-candidate mapping trials and
    // the probe) carries an observable outcome.
    if (learning_enabled && router_learning && mode == CC_LEARNED && forced_bank < 0) {
        // Per-bank running reward baseline: the advantage of the TAKEN bank.
        double adv = out.reward;
        if (agent.cfg.use_reward_baseline) {
            const size_t bi = agent.cfg.baseline_per_bank ? static_cast<size_t>(bank) : 0u;
            const double b = agent.reward_baseline[bi];
            adv = out.reward - b;
            agent.reward_baseline[bi] = b + agent.cfg.baseline_rate * (out.reward - b);
        }
        const std::vector<double>& p_credit =
            agent.cfg.router_credit_unmasked ? p_unmasked : p;
        for (int f : sched.cue) {
            if (f < 0 || f >= agent.cfg.n_feat) continue;
            for (int k = 0; k < K; ++k) {
                const double grad = ((k == bank) ? 1.0 : 0.0) - p_credit[static_cast<size_t>(k)];
                size_t sid = agent.router[static_cast<size_t>(f)][static_cast<size_t>(k)];
                double w = agent.net.getSynapse(sid).getWeight();
                w = clampAbs(w + agent.cfg.beta_route_bank * adv * grad, cfg.v_clamp);
                agent.net.getSynapse(sid).setWeight(w);
            }
        }
    }

    return out;
}

std::string ccSerialize(const CCAgent& agent) {
    std::ostringstream os;
    os << "CCM2|" << agent.net.serialize() << "|";
    for (size_t k = 0; k < agent.bank_state.size(); ++k) {
        if (k) os << ",";
        os << agent.bank_state[k];
    }
    os << "|";
    os.precision(17);
    for (size_t k = 0; k < agent.reward_baseline.size(); ++k) {
        if (k) os << ",";
        os << agent.reward_baseline[k];
    }
    os << "|end";
    return os.str();
}

void ccDeserialize(CCAgent& agent, const std::string& data) {
    const std::string head = "CCM2|";
    if (data.size() < head.size() + 4 || data.compare(0, head.size(), head) != 0)
        throw std::invalid_argument("ccDeserialize: bad header");
    if (data.compare(data.size() - 4, 4, "|end") != 0)
        throw std::invalid_argument("ccDeserialize: missing trailer");
    const std::string body = data.substr(head.size(), data.size() - head.size() - 4);
    const size_t sep_base = body.rfind('|');
    if (sep_base == std::string::npos || sep_base == 0)
        throw std::invalid_argument("ccDeserialize: truncated record");
    const std::string baseline_field = body.substr(sep_base + 1);
    std::vector<double> baselines;
    {
        std::istringstream is(baseline_field);
        std::string item;
        while (std::getline(is, item, ',')) baselines.push_back(std::stod(item));
    }
    const std::string body2 = body.substr(0, sep_base);
    const size_t sep = body2.rfind('|');
    if (sep == std::string::npos || sep + 1 >= body2.size())
        throw std::invalid_argument("ccDeserialize: truncated record");
    const std::string net_part = body2.substr(0, sep);
    const std::string flags = body2.substr(sep + 1);

    std::vector<int> st;
    {
        std::istringstream is(flags);
        std::string item;
        while (std::getline(is, item, ',')) st.push_back(std::stoi(item));
    }
    if (st.size() != agent.bank_state.size())
        throw std::invalid_argument("ccDeserialize: bank count mismatch");
    if (baselines.size() != agent.bank_state.size())
        throw std::invalid_argument("ccDeserialize: baseline count mismatch");
    agent.net.deserialize(net_part);
    agent.bank_state = st;
    agent.reward_baseline = baselines;
}

} // namespace learning
