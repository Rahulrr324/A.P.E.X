#include "ToyAssociationTask.h"
#include <random>
#include <algorithm>
#include <stdexcept>

namespace learning {

std::vector<TrialSchedule> makeSchedule(const TaskConfig& cfg, int trials, unsigned seed) {
    if (trials <= 0) throw std::invalid_argument("makeSchedule: trials must be > 0");
    if (cfg.cue_steps <= 0) throw std::invalid_argument("makeSchedule: cue_steps must be > 0");

    // Balanced cue sequence: half 0 / half 1; odd counts alternate the extra.
    std::vector<int> cues(static_cast<size_t>(trials));
    int half = trials / 2;
    for (int i = 0; i < trials; ++i) {
        cues[static_cast<size_t>(i)] = (i < half) ? 0 : 1;
    }
    if (trials % 2 == 1) {
        cues[static_cast<size_t>(trials - 1)] = (half % 2 == 0) ? 0 : 1;
    }

    // Seeded shuffle of cue assignment.
    std::mt19937 rng(seed);
    std::shuffle(cues.begin(), cues.end(), rng);

    // Seeded per-step noise for both action neurons plus a per-trial tie-break
    // draw (all from the SAME stream so the schedule is a function of `seed`).
    std::uniform_real_distribution<double> noise_dist(-cfg.noise_amp, cfg.noise_amp);
    std::uniform_real_distribution<double> tie_dist(0.0, 1.0);
    std::vector<TrialSchedule> sched(static_cast<size_t>(trials));
    for (int t = 0; t < trials; ++t) {
        TrialSchedule& s = sched[static_cast<size_t>(t)];
        s.cue = cues[static_cast<size_t>(t)];
        s.noise_a0.resize(static_cast<size_t>(cfg.cue_steps));
        s.noise_a1.resize(static_cast<size_t>(cfg.cue_steps));
        for (int k = 0; k < cfg.cue_steps; ++k) {
            s.noise_a0[static_cast<size_t>(k)] = noise_dist(rng);
            s.noise_a1[static_cast<size_t>(k)] = noise_dist(rng);
        }
        s.tie_u = tie_dist(rng);
    }
    return sched;
}

Agent makeAgent(const TaskConfig& cfg, bool plastic) {
    Agent a;
    NeuralCell cell(cfg.tau_m, cfg.theta_0, cfg.tau_a, cfg.adapt_b, cfg.v_reset);
    a.s0 = a.net.addNeuron(cell);
    a.s1 = a.net.addNeuron(cell);
    a.a0 = a.net.addNeuron(cell);
    a.a1 = a.net.addNeuron(cell);

    const size_t pairs[4][2] = {
        {a.s0, a.a0}, {a.s0, a.a1}, {a.s1, a.a0}, {a.s1, a.a1}
    };
    for (const auto& p : pairs) {
        size_t id = a.net.addSynapse(p[0], p[1], cfg.w_init, cfg.tau_s, /*delay=*/0);
        if (plastic) {
            // Configure THREEFACTOR state AND the pre/post trace constants in
            // one transactional restore (see TaskConfig note on tau_pre/tau_post).
            a.net.getSynapse(id).setFullState(
                /*x=*/0.0, cfg.w_init, /*x_pre=*/0.0, /*x_post=*/0.0,
                /*A_plus=*/0.0, /*A_minus=*/0.0,
                cfg.tau_pre, cfg.tau_post,
                cfg.w_min, cfg.w_max, /*plasticity_enabled=*/true,
                /*e=*/0.0, cfg.E_plus, cfg.E_minus, cfg.tau_e, cfg.eta_3f,
                /*three_factor_enabled=*/true, PlasticityMode::THREEFACTOR);
        }
        a.syn.push_back(id);
    }

    // Winner-take-all lateral inhibition between action neurons: fixed,
    // non-plastic (PlasticityMode::NONE). NOT part of the plastic synapse list.
    // (Synapse::applyThreeFactor no-ops on non-THREEFACTOR synapses, so these
    // are untouched by the reward modulator.)
    a.net.addSynapse(a.a0, a.a1, cfg.w_inh, cfg.tau_s, /*delay=*/0);
    a.net.addSynapse(a.a1, a.a0, cfg.w_inh, cfg.tau_s, /*delay=*/0);
    return a;
}

std::vector<double> weights(const Agent& agent) {
    std::vector<double> w;
    w.reserve(agent.syn.size());
    for (size_t id : agent.syn) w.push_back(agent.net.getSynapse(id).getWeight());
    return w;
}

TrialResult runTrial(Agent& agent, const TaskConfig& cfg,
                     const TrialSchedule& sched, bool learning_enabled) {
    if (sched.cue != 0 && sched.cue != 1)
        throw std::invalid_argument("runTrial: cue must be 0 or 1");
    if (static_cast<int>(sched.noise_a0.size()) != cfg.cue_steps ||
        static_cast<int>(sched.noise_a1.size()) != cfg.cue_steps)
        throw std::invalid_argument("runTrial: noise length must equal cue_steps");

    // Fresh trial state; weights persist across trials.
    agent.net.reset();

    size_t cued = (sched.cue == 0) ? agent.s0 : agent.s1;
    size_t uncued = (sched.cue == 0) ? agent.s1 : agent.s0;

    // Cue phase: drive + noise; count action spikes.
    int count_a0 = 0, count_a1 = 0;
    long first_a0 = -1, first_a1 = -1;
    for (int k = 0; k < cfg.cue_steps; ++k) {
        agent.net.setExternalInput(cued, cfg.cue_current);
        agent.net.setExternalInput(uncued, 0.0);
        agent.net.setExternalInput(agent.a0, cfg.background_current + sched.noise_a0[static_cast<size_t>(k)]);
        agent.net.setExternalInput(agent.a1, cfg.background_current + sched.noise_a1[static_cast<size_t>(k)]);
        agent.net.step(cfg.dt);

        const std::vector<bool>& spikes = agent.net.getSpikesThisStep();
        if (spikes[agent.a0]) { ++count_a0; if (first_a0 < 0) first_a0 = k; }
        if (spikes[agent.a1]) { ++count_a1; if (first_a1 < 0) first_a1 = k; }
    }

    // Decision: most spikes wins; tie -> earlier first spike; still tied (or
    // no spikes at all) -> the schedule's seeded draw (never a fixed default).
    int choice;
    if (count_a0 != count_a1) {
        choice = (count_a0 > count_a1) ? 0 : 1;
    } else if (first_a0 >= 0 && first_a1 >= 0 && first_a0 != first_a1) {
        choice = (first_a0 < first_a1) ? 0 : 1;
    } else {
        choice = (sched.tie_u < 0.5) ? 0 : 1;
    }

    TrialResult r;
    r.cue = sched.cue;
    r.choice = choice;
    r.reward = (choice == sched.cue) ? 1.0 : -1.0;

    // Quiet delay (STARK-L2): zero input, no modulator. Eligibility and traces
    // decay each step (inside Network::step); any residual post-decision
    // spikes are deterministic. The delay cannot affect the choice above.
    for (int k = 0; k < cfg.reward_delay; ++k) {
        agent.net.step(cfg.dt);
    }

    // Outcome step: modulator for exactly one timestep (task reward, or +1
    // for the sham negative control). Inputs are zero; timestep count is
    // identical with learning disabled.
    if (learning_enabled) {
        r.modulator = cfg.reward_contingent ? r.reward : 1.0;
        agent.net.setModulatorySignal(r.modulator);
    }
    agent.net.step(cfg.dt);

    return r;
}

} // namespace learning
