// STARK-L6/L7: learned relevance routing (see design docs).
// STARK-L7: N-way generalization (n_chan/n_ctx); defaults 2/2 reproduce
// STARK-L6 v1.1 byte-identically.

#include "learning/RelevanceRouting.h"

#include <algorithm>
#include <cmath>
#include <random>
#include <stdexcept>

namespace learning {

int lrSampleSteps(const LRConfig& cfg) {
    return cfg.sample_steps + cfg.interf_steps + cfg.decision_steps;
}

LRMapping makeLRMapping(unsigned seed, int n_ids, int n_ctx) {
    LRMapping m;
    m.perm.resize(static_cast<size_t>(n_ids));
    for (int i = 0; i < n_ids; ++i) m.perm[static_cast<size_t>(i)] = i;
    // STARK-L6 v1.1 byte-identity: perm shuffled with a xor-seeded RNG.
    std::mt19937 rng_pi(seed ^ 0x9E3779B9u);
    std::shuffle(m.perm.begin(), m.perm.end(), rng_pi);
    m.phi.resize(static_cast<size_t>(n_ctx));
    for (int i = 0; i < n_ctx; ++i) m.phi[static_cast<size_t>(i)] = i;
    std::mt19937 rng_phi(seed);
    if (n_ctx == 2) {
        // STARK-L6 v1.1 byte-identity: phi from the low bit of the first
        // output of a separate phi RNG.
        m.phi[0] = static_cast<int>(rng_phi() & 1u);
        m.phi[1] = 1 - m.phi[0];
    } else {
        std::shuffle(m.phi.begin(), m.phi.end(), rng_phi);
    }
    return m;
}

std::vector<LRTrialSchedule> makeLRTrials(const LRConfig& cfg,
                                          const LRMapping& map,
                                          int single_per_item, int pair_per_item,
                                          unsigned seed) {
    if (single_per_item < 0 || pair_per_item < 0 ||
        (single_per_item + pair_per_item) <= 0)
        throw std::invalid_argument("makeLRTrials: bad per-item counts");
    if (static_cast<int>(map.perm.size()) != cfg.n_ids)
        throw std::invalid_argument("makeLRTrials: mapping size mismatch");
    if (static_cast<int>(map.phi.size()) != cfg.n_ctx)
        throw std::invalid_argument("makeLRTrials: phi size mismatch");

    std::mt19937 rng(seed);
    std::uniform_real_distribution<double> unif(0.0, 1.0);

    // Balanced queried-identity lists for each half.
    std::vector<int> q_single, q_pair;
    for (int i = 0; i < cfg.n_ids; ++i) {
        for (int t = 0; t < single_per_item; ++t) q_single.push_back(i);
        for (int t = 0; t < pair_per_item; ++t) q_pair.push_back(i);
    }
    std::shuffle(q_single.begin(), q_single.end(), rng);
    std::shuffle(q_pair.begin(), q_pair.end(), rng);

    // Interleave deterministically (single/pair alternating as available).
    std::vector<int> order;
    {
        size_t is = 0, ip = 0;
        bool take_single = true;
        while (is < q_single.size() || ip < q_pair.size()) {
            if (take_single && is < q_single.size()) order.push_back(q_single[is++]);
            else if (!take_single && ip < q_pair.size()) {
                // encode pair trials as (id + 1000) marker
                order.push_back(q_pair[ip++] + 1000);
            } else if (is < q_single.size()) order.push_back(q_single[is++]);
            else order.push_back(q_pair[ip++] + 1000);
            take_single = !take_single;
        }
    }

    const int total = lrSampleSteps(cfg);
    std::vector<LRTrialSchedule> out(order.size());
    for (size_t t = 0; t < order.size(); ++t) {
        LRTrialSchedule& s = out[t];
        const bool single = (order[t] < 1000);
        const int queried = single ? order[t] : (order[t] - 1000);
        s.single = single;

        s.ctx = static_cast<int>(unif(rng) * cfg.n_ctx);
        const int qslot = map.phi[s.ctx];
        s.presented.assign(static_cast<size_t>(cfg.n_chan), -1);
        if (single) {
            // Sole candidate on channel 0 (observable); the queried item is
            // that candidate (no selection decision).
            s.presented[0] = queried;
        } else {
            // Queried candidate on channel phi(ctx); the remaining
            // candidates on the other channels (task construction).
            s.presented[static_cast<size_t>(qslot)] = queried;
            std::vector<bool> taken(static_cast<size_t>(cfg.n_ids), false);
            taken[static_cast<size_t>(queried)] = true;
            for (int c = 0; c < cfg.n_chan; ++c) {
                if (c == qslot) continue;
                int j = static_cast<int>(unif(rng) * (cfg.n_ids - 1));
                if (j >= queried) ++j;
                while (taken[static_cast<size_t>(j)])
                    j = (j + 1) % cfg.n_ids;
                taken[static_cast<size_t>(j)] = true;
                s.presented[static_cast<size_t>(c)] = j;
            }
        }
        s.id0 = s.presented.size() > 0 ? s.presented[0] : -1;
        s.id1 = s.presented.size() > 1 ? s.presented[1] : -1;

        // Distractors: identities other than the presented candidates.
        s.distractors.resize(static_cast<size_t>(cfg.interf_steps));
        for (int k = 0; k < cfg.interf_steps; ++k) {
            double u = unif(rng);
            if (u < cfg.p_none) {
                s.distractors[static_cast<size_t>(k)] = -1;
            } else {
                int j = -1;
                do {
                    j = static_cast<int>(unif(rng) * cfg.n_ids);
                    if (j >= cfg.n_ids) j = cfg.n_ids - 1;
                } while (std::find(s.presented.begin(), s.presented.end(), j) !=
                         s.presented.end());
                s.distractors[static_cast<size_t>(k)] = j;
            }
        }

        // Noise on response units over sample+interf+decision (unit-major).
        s.noise.resize(static_cast<size_t>(cfg.n_ids * total));
        for (int r = 0; r < cfg.n_ids; ++r) {
            for (int k = 0; k < total; ++k) {
                double amp = (k < cfg.sample_steps) ? cfg.noise_sample
                           : (k < cfg.sample_steps + cfg.interf_steps) ? cfg.noise_interf
                           : cfg.noise_decision;
                s.noise[static_cast<size_t>(r * total + k)] =
                    (unif(rng) * 2.0 - 1.0) * amp;
            }
        }
        s.tie_u = unif(rng);
        s.mech_u = unif(rng);
        s.sham_u = unif(rng);
    }
    return out;
}

LRAgent makeLRAgent(const LRConfig& cfg, bool plastic) {
    LRAgent a;
    NeuralCell scell(cfg.tau_m, cfg.theta_cue, cfg.tau_a, cfg.adapt_b, cfg.v_reset);
    NeuralCell acell(cfg.tau_m, cfg.theta_action, cfg.tau_a, cfg.adapt_b, cfg.v_reset);
    a.s.resize(static_cast<size_t>(cfg.n_ids));
    a.a.resize(static_cast<size_t>(cfg.n_ids));
    a.l.resize(static_cast<size_t>(cfg.n_chan));
    a.c.resize(static_cast<size_t>(cfg.n_ctx));
    for (int i = 0; i < cfg.n_ids; ++i) a.s[static_cast<size_t>(i)] = a.net.addNeuron(scell);
    for (int r = 0; r < cfg.n_ids; ++r) a.a[static_cast<size_t>(r)] = a.net.addNeuron(acell);
    for (int k = 0; k < cfg.n_chan; ++k) a.l[static_cast<size_t>(k)] = a.net.addNeuron(scell);
    for (int k = 0; k < cfg.n_ctx; ++k) a.c[static_cast<size_t>(k)] = a.net.addNeuron(scell);

    // Plastic S->A matrix; delivery delay floor(r/2) = exploration rung.
    a.syn.resize(static_cast<size_t>(cfg.n_ids));
    for (int i = 0; i < cfg.n_ids; ++i) {
        a.syn[static_cast<size_t>(i)].resize(static_cast<size_t>(cfg.n_ids));
        for (int r = 0; r < cfg.n_ids; ++r) {
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

    for (int r = 0; r < cfg.n_ids; ++r) {
        for (int q = 0; q < cfg.n_ids; ++q) {
            if (r == q) continue;
            a.wta.push_back(a.net.addSynapse(a.a[static_cast<size_t>(r)],
                                             a.a[static_cast<size_t>(q)],
                                             cfg.w_inh, cfg.tau_s, /*delay=*/0));
        }
    }
    for (int r = 0; r < cfg.n_ids; ++r) {
        a.self.push_back(a.net.addSynapse(a.a[static_cast<size_t>(r)],
                                          a.a[static_cast<size_t>(r)],
                                          cfg.w_self, cfg.tau_s, /*delay=*/0));
    }

    // Routing state v[ctx][channel] stored as ordinary C->L synapse weights
    // (persistence free via STARK-007 serialization).
    a.route.assign(static_cast<size_t>(cfg.n_ctx),
                   std::vector<size_t>(static_cast<size_t>(cfg.n_chan), 0));
    for (int k = 0; k < cfg.n_ctx; ++k) {
        for (int s = 0; s < cfg.n_chan; ++s) {
            a.route[static_cast<size_t>(k)][static_cast<size_t>(s)] =
                a.net.addSynapse(a.c[static_cast<size_t>(k)],
                                 a.l[static_cast<size_t>(s)],
                                 0.0, cfg.tau_s, /*delay=*/0);
        }
    }
    return a;
}

LRTrialResult runLRTrial(LRAgent& agent, const LRConfig& cfg,
                         const LRTrialSchedule& sched, const LRMapping& map,
                         int arm, bool learning_enabled) {
    if (sched.id0 < -1 || sched.id0 >= cfg.n_ids || sched.id1 < -1 ||
        sched.id1 >= cfg.n_ids || sched.id0 == sched.id1 ||
        (sched.id0 < 0 && sched.id1 < 0))
        throw std::invalid_argument("runLRTrial: bad sample identities");
    const int total = lrSampleSteps(cfg);
    if (static_cast<int>(sched.noise.size()) != cfg.n_ids * total)
        throw std::invalid_argument("runLRTrial: noise size mismatch");

    agent.net.reset(); // eligibility gates restored to default ON

    LRTrialResult out;
    out.ctx = sched.ctx;
    if (sched.single) {
        out.queried = (sched.id0 >= 0) ? sched.id0 : sched.id1;
        out.queried_slot = (sched.id0 >= 0) ? 0 : 1;
        out.partner = -1;
    } else {
        out.queried_slot = map.phi[sched.ctx];
        out.queried = sched.presented[static_cast<size_t>(out.queried_slot)];
        out.partner = -1;  // STARK-L7: N-way; no single partner (was id0/id1 for N=2)
    }

    // ---- Mechanism selection (observable inputs + routing state only) ----
    // Attention shares from the routing state of the active context.
    // STARK-L7: softmax over n_chan channels (N=2: identical to L6 v1.1).
    std::vector<double> v(static_cast<size_t>(cfg.n_chan), 0.0);
    std::vector<double> m(static_cast<size_t>(cfg.n_chan), 0.0);
    double z = 0.0;
    for (int s = 0; s < cfg.n_chan; ++s) {
        v[static_cast<size_t>(s)] =
            agent.net.getSynapse(agent.route[static_cast<size_t>(sched.ctx)]
                                 [static_cast<size_t>(s)]).getWeight();
        m[static_cast<size_t>(s)] = std::exp(v[static_cast<size_t>(s)] / cfg.softmax_T);
        z += m[static_cast<size_t>(s)];
    }
    std::vector<double> a(static_cast<size_t>(cfg.n_chan), 0.0);
    for (int s = 0; s < cfg.n_chan; ++s)
        a[static_cast<size_t>(s)] = m[static_cast<size_t>(s)] / z;
    out.shares = a;
    out.a0 = a[0];
    out.a1 = (cfg.n_chan > 1) ? a[1] : 0.0;

    // v1.1: single-sample trials carry NO selection decision (sole
    // candidate); multi-candidate trials run the policy. sel_slot is scored
    // only on multi-candidate trials.
    int sel = -1;
    std::vector<double> gain(static_cast<size_t>(cfg.n_chan), 1.0);
    if (sched.single) {
        for (int s = 0; s < cfg.n_chan; ++s)
            if (sched.presented[static_cast<size_t>(s)] < 0) gain[static_cast<size_t>(s)] = 0.0;
    } else {
        if (arm == LR_ORACLE) {
            sel = out.queried_slot; // reference: driver-supplied selection (phi)
        } else if (arm == LR_LEARNED || arm == LR_SHAM || arm == LR_NEGATIVE) {
            int sampled;
            if (cfg.n_chan <= 2) {
                sampled = (sched.mech_u < a[0]) ? 0 : 1; // L6 v1.1 byte-identity
            } else {
                // CDF sampling over n_chan channels.
                double u = sched.mech_u;
                sampled = 0;
                while (sampled < cfg.n_chan - 1 && u > a[static_cast<size_t>(sampled)]) {
                    u -= a[static_cast<size_t>(sampled)];
                    ++sampled;
                }
            }
            sel = (arm == LR_NEGATIVE) ? ((sampled + 1) % cfg.n_chan) : sampled;
        } // UNGATED / ABLATION: sel = -1 (no selection)
        for (int s = 0; s < cfg.n_chan; ++s)
            if (sel >= 0 && s != sel) gain[static_cast<size_t>(s)] = 0.0;
    }

    out.sel_slot = sel;
    const int sel_id = (sel >= 0) ? sched.presented[static_cast<size_t>(sel)] : -1;

    // ---- Actuators: attentional input gain + STARK-L5 eligibility gate ----
    // v1.1: eligibility gates on SINGLE-sample trials (mapping credit —
    // distractor rows excluded); ALL gates OFF on multi-candidate selection
    // trials for every arm (identifiability prerequisite: the outcome
    // cannot disambiguate mapping- from selection-error there; see design).
    if (sched.single) {
        if (arm != LR_UNGATED) {
            for (int i = 0; i < cfg.n_ids; ++i)
                agent.net.setEligibilityGate(agent.s[static_cast<size_t>(i)],
                                             i == out.queried);
        }
    } else {
        for (int i = 0; i < cfg.n_ids; ++i)
            agent.net.setEligibilityGate(agent.s[static_cast<size_t>(i)], false);
        // Relevance quality (scored on multi-candidate trials):
        // attention/perception of the queried vs the decoy candidates.
        if (arm == LR_LEARNED || arm == LR_SHAM || arm == LR_NEGATIVE || arm == LR_ORACLE) {
            const double gain_q = gain[static_cast<size_t>(out.queried_slot)];
            out.fp_gate = false;
            for (int s = 0; s < cfg.n_chan; ++s) {
                if (s == out.queried_slot) continue;
                if (gain[static_cast<size_t>(s)] > 0.0) out.fp_gate = true;
            }
            out.miss_gate = (gain_q == 0.0);
        }
    }

    // ---- 1. Context window ----
    for (int k = 0; k < cfg.ctx_steps; ++k) {
        for (int q = 0; q < cfg.n_ctx; ++q)
            agent.net.setExternalInput(agent.c[static_cast<size_t>(q)],
                                       (q == sched.ctx) ? cfg.cue_current : 0.0);
        for (int q = 0; q < cfg.n_chan; ++q)
            agent.net.setExternalInput(agent.l[static_cast<size_t>(q)], 0.0);
        for (int i = 0; i < cfg.n_ids; ++i)
            agent.net.setExternalInput(agent.s[static_cast<size_t>(i)], 0.0);
        for (int r = 0; r < cfg.n_ids; ++r)
            agent.net.setExternalInput(agent.a[static_cast<size_t>(r)],
                                       cfg.background_current);
        agent.net.step(cfg.dt);
    }

    // ---- 2. Sample window (candidates; attentional gain per selection) ----
    for (int k = 0; k < cfg.sample_steps; ++k) {
        for (int i = 0; i < cfg.n_ids; ++i) {
            double d = 0.0;
            for (int s = 0; s < cfg.n_chan; ++s)
                if (sched.presented[static_cast<size_t>(s)] == i)
                    d = cfg.cue_current * gain[static_cast<size_t>(s)];
            agent.net.setExternalInput(agent.s[static_cast<size_t>(i)], d);
        }
        for (int q = 0; q < cfg.n_chan; ++q)
            agent.net.setExternalInput(agent.l[static_cast<size_t>(q)], cfg.cue_current);
        for (int q = 0; q < cfg.n_ctx; ++q)
            agent.net.setExternalInput(agent.c[static_cast<size_t>(q)], 0.0);
        for (int r = 0; r < cfg.n_ids; ++r) {
            agent.net.setExternalInput(
                agent.a[static_cast<size_t>(r)],
                cfg.background_current + sched.noise[static_cast<size_t>(r * total + k)]);
        }
        agent.net.step(cfg.dt);
    }

    // ---- 3. Interference window (distractor identities co-activate) ----
    for (int k = 0; k < cfg.interf_steps; ++k) {
        const int j = sched.distractors[static_cast<size_t>(k)];
        for (int i = 0; i < cfg.n_ids; ++i)
            agent.net.setExternalInput(agent.s[static_cast<size_t>(i)],
                                       (i == j) ? cfg.cue_current : 0.0);
        for (int q = 0; q < cfg.n_chan; ++q)
            agent.net.setExternalInput(agent.l[static_cast<size_t>(q)], 0.0);
        for (int q = 0; q < cfg.n_ctx; ++q)
            agent.net.setExternalInput(agent.c[static_cast<size_t>(q)], 0.0);
        for (int r = 0; r < cfg.n_ids; ++r) {
            agent.net.setExternalInput(
                agent.a[static_cast<size_t>(r)],
                cfg.background_current +
                    sched.noise[static_cast<size_t>(r * total + cfg.sample_steps + k)]);
        }
        agent.net.step(cfg.dt);
    }

    // ---- 4. Decision window (spike-count majority; seeded tie-breaks) ----
    std::vector<int> counts(static_cast<size_t>(cfg.n_ids), 0);
    std::vector<long> first(static_cast<size_t>(cfg.n_ids), -1);
    for (int k = 0; k < cfg.decision_steps; ++k) {
        for (int i = 0; i < cfg.n_ids; ++i)
            agent.net.setExternalInput(agent.s[static_cast<size_t>(i)], 0.0);
        for (int q = 0; q < cfg.n_chan; ++q)
            agent.net.setExternalInput(agent.l[static_cast<size_t>(q)], 0.0);
        for (int q = 0; q < cfg.n_ctx; ++q)
            agent.net.setExternalInput(agent.c[static_cast<size_t>(q)], 0.0);
        for (int r = 0; r < cfg.n_ids; ++r) {
            agent.net.setExternalInput(
                agent.a[static_cast<size_t>(r)],
                cfg.background_current +
                    sched.noise[static_cast<size_t>(r * total + cfg.sample_steps +
                                                    cfg.interf_steps + k)]);
        }
        agent.net.step(cfg.dt);

        const std::vector<bool>& sp = agent.net.getSpikesThisStep();
        for (int r = 0; r < cfg.n_ids; ++r) {
            if (sp[agent.a[static_cast<size_t>(r)]]) {
                ++counts[static_cast<size_t>(r)];
                if (first[static_cast<size_t>(r)] < 0) first[static_cast<size_t>(r)] = k;
            }
        }
    }

    int choice = 0;
    int best = -1;
    for (int r = 0; r < cfg.n_ids; ++r) {
        if (counts[static_cast<size_t>(r)] > best) {
            best = counts[static_cast<size_t>(r)];
            choice = r;
        }
    }
    std::vector<int> tied;
    for (int r = 0; r < cfg.n_ids; ++r)
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
            int idx = static_cast<int>(sched.tie_u * static_cast<double>(tied2.size()));
            if (idx >= static_cast<int>(tied2.size())) idx = static_cast<int>(tied2.size()) - 1;
            choice = tied2[static_cast<size_t>(idx)];
        }
    }

    out.choice = choice;
    out.reward = (choice == map.perm[static_cast<size_t>(out.queried)]) ? 1.0 : -1.0;

    // ---- 5. Quiet delay ----
    for (int k = 0; k < cfg.reward_delay; ++k) {
        for (int i = 0; i < cfg.n_ids; ++i)
            agent.net.setExternalInput(agent.s[static_cast<size_t>(i)], 0.0);
        for (int q = 0; q < cfg.n_chan; ++q) agent.net.setExternalInput(agent.l[static_cast<size_t>(q)], 0.0);
        for (int q = 0; q < cfg.n_ctx; ++q) agent.net.setExternalInput(agent.c[static_cast<size_t>(q)], 0.0);
        for (int r = 0; r < cfg.n_ids; ++r)
            agent.net.setExternalInput(agent.a[static_cast<size_t>(r)], cfg.background_current);
        agent.net.step(cfg.dt);
    }

    // ---- 6. Reward step: modulator + routing update ----
    for (int i = 0; i < cfg.n_ids; ++i)
        agent.net.setExternalInput(agent.s[static_cast<size_t>(i)], 0.0);
    for (int q = 0; q < cfg.n_chan; ++q) agent.net.setExternalInput(agent.l[static_cast<size_t>(q)], 0.0);
    for (int q = 0; q < cfg.n_ctx; ++q) agent.net.setExternalInput(agent.c[static_cast<size_t>(q)], 0.0);
    for (int r = 0; r < cfg.n_ids; ++r)
        agent.net.setExternalInput(agent.a[static_cast<size_t>(r)], cfg.background_current);
    if (learning_enabled) {
        out.modulator = cfg.reward_contingent ? out.reward : 1.0;
        agent.net.setModulatorySignal(out.modulator);
    }
    agent.net.step(cfg.dt);

    // Diagnostic: choice-consistency evidence slot (reported; not used for
    // the policy update — the update acts on the taken action s*).
    if (!sched.single) {
        double w0 = agent.net.getSynapse(
            agent.syn[static_cast<size_t>(sched.id0)][static_cast<size_t>(choice)]).getWeight();
        double w1 = agent.net.getSynapse(
            agent.syn[static_cast<size_t>(sched.id1)][static_cast<size_t>(choice)]).getWeight();
        out.s_sel = (w1 > w0) ? 1 : (w0 > w1) ? 0 : -1;
    }

    // v1.1 REINFORCE: unbiased policy gradient on the TAKEN action (the
    // mechanism's selection), evaluated by the outcome. LEARNED/SHAM/
    // NEGATIVE only; multi-candidate selection trials only (single-sample
    // trials carry no selection decision). No pi/phi access; association
    // credit flows only through the eligibility gate.
    // STARK-L7: gradient over all n_chan channels (N=2: identical to L6).
    if (learning_enabled && !sched.single && sel >= 0 &&
        (arm == LR_LEARNED || arm == LR_SHAM || arm == LR_NEGATIVE)) {
        const double m_v = (arm == LR_SHAM)
            ? ((sched.sham_u < 0.5) ? 1.0 : -1.0) // reward-independent control
            : out.modulator;
        for (int s = 0; s < cfg.n_chan; ++s) {
            const double grad = (s == sel) ? (1.0 - a[static_cast<size_t>(s)])
                                           : (0.0 - a[static_cast<size_t>(s)]);
            double vw = agent.net.getSynapse(
                agent.route[static_cast<size_t>(sched.ctx)][static_cast<size_t>(s)]).getWeight();
            vw += cfg.beta_route * m_v * grad;
            if (vw > cfg.v_clamp) vw = cfg.v_clamp;
            if (vw < -cfg.v_clamp) vw = -cfg.v_clamp;
            agent.net.getSynapse(
                agent.route[static_cast<size_t>(sched.ctx)][static_cast<size_t>(s)]).setWeight(vw);
        }
    }

    return out;
}

std::vector<std::vector<double>> lrWeights(const LRAgent& agent) {
    std::vector<std::vector<double>> w(agent.syn.size());
    for (size_t i = 0; i < agent.syn.size(); ++i) {
        w[i].resize(agent.syn[i].size());
        for (size_t r = 0; r < agent.syn[i].size(); ++r)
            w[i][r] = agent.net.getSynapse(agent.syn[i][r]).getWeight();
    }
    return w;
}

double lrRouteState(const LRAgent& agent, int ctx, int channel) {
    return agent.net.getSynapse(agent.route[static_cast<size_t>(ctx)]
                                [static_cast<size_t>(channel)]).getWeight();
}

std::vector<std::vector<double>> lrRouteStateAll(const LRAgent& agent) {
    std::vector<std::vector<double>> v(agent.route.size());
    for (size_t k = 0; k < agent.route.size(); ++k) {
        v[k].resize(agent.route[k].size());
        for (size_t s = 0; s < agent.route[k].size(); ++s)
            v[k][s] = agent.net.getSynapse(agent.route[k][s]).getWeight();
    }
    return v;
}

} // namespace learning
