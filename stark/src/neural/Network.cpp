#include "Network.h"
#include <algorithm>
#include <random>
#include <cmath>
#include <stdexcept>
#include <limits>
#include <string>
#include <sstream>
#include <iomanip>
#include <fstream>
#include <vector>
#include <iterator>
#include <cstdlib>
#include <cerrno>
#include <utility>

void Network::validateNeuronId(size_t id) const {
    if (id >= neurons_.size()) {
        throw std::out_of_range(
            "Network: invalid neuron_id=" + std::to_string(id) +
            ", network has " + std::to_string(neurons_.size()) + " neurons"
        );
    }
}

void Network::validateSynapseId(size_t id) const {
    if (id >= synapses_.size()) {
        throw std::out_of_range(
            "Network: invalid synapse_id=" + std::to_string(id) +
            ", network has " + std::to_string(synapses_.size()) + " synapses"
        );
    }
}

void Network::ensureNeuronCapacity(size_t n) {
    if (neurons_.size() < n) {
        size_t old_size = neurons_.size();
        neurons_.resize(n);
        outgoing_.resize(n);
        incoming_.resize(n);
        external_inputs_.resize(n, 0.0);
        spikes_this_step_.resize(n, false);
        delayed_spikes_.resize(n);
        // STARK-L5: keep eligibility gates sized with neurons (default true).
        eligibility_gates_.resize(n, true);
        (void)old_size;
    }
}

void Network::ensureSynapseCapacity(size_t e) {
    // Not strictly needed since we push_back, but kept for symmetry
    (void)e;
}

size_t Network::addNeuron(const NeuralCell& neuron) {
    size_t id = neurons_.size();
    neurons_.push_back(neuron);
    outgoing_.push_back({});
    incoming_.push_back({});
    external_inputs_.push_back(0.0);
    spikes_this_step_.push_back(false);
    delayed_spikes_.push_back({});
    // Extend homeostatic state for the new neuron ONLY (preserve existing state)
    r_mean_.push_back(0.0);
    homeostatic_scale_.push_back(1.0);
    // STARK-L5: eligibility gate defaults to on (existing behavior).
    eligibility_gates_.push_back(true);
    return id;
}

size_t Network::addNeuron(double tau_m, double theta_0, double tau_a, double b, double v_reset) {
    NeuralCell neuron(tau_m, theta_0, tau_a, b, v_reset);
    return addNeuron(neuron);
}

NeuralCell& Network::getNeuron(size_t id) {
    validateNeuronId(id);
    return neurons_[id];
}

const NeuralCell& Network::getNeuron(size_t id) const {
    validateNeuronId(id);
    return neurons_[id];
}

size_t Network::addSynapse(size_t pre_id, size_t post_id, double weight, double tau_s, size_t delay) {
    validateNeuronId(pre_id);
    validateNeuronId(post_id);

    if (!std::isfinite(weight)) {
        throw std::invalid_argument("Network: weight must be finite, got " + std::to_string(weight));
    }
    if (tau_s <= 0.0 || !std::isfinite(tau_s)) {
        throw std::invalid_argument("Network: tau_s must be > 0 and finite, got " + std::to_string(tau_s));
    }

    Synapse synapse(weight, tau_s);
    SynapseInstance instance(pre_id, post_id, synapse, delay);

    size_t synapse_id = synapses_.size();
    synapses_.push_back(std::move(instance));

    // Update adjacency lists
    outgoing_[pre_id].push_back(synapse_id);
    incoming_[post_id].push_back(synapse_id);

    return synapse_id;
}

Synapse& Network::getSynapse(size_t id) {
    validateSynapseId(id);
    return synapses_[id].synapse;
}

const Synapse& Network::getSynapse(size_t id) const {
    validateSynapseId(id);
    return synapses_[id].synapse;
}

const std::vector<size_t>& Network::getOutgoingSynapses(size_t neuron_id) const {
    validateNeuronId(neuron_id);
    return outgoing_[neuron_id];
}

const std::vector<size_t>& Network::getIncomingSynapses(size_t neuron_id) const {
    validateNeuronId(neuron_id);
    return incoming_[neuron_id];
}

bool Network::hasConnection(size_t pre_id, size_t post_id) const {
    validateNeuronId(pre_id);
    validateNeuronId(post_id);

    // Check outgoing synapses from pre_id
    for (size_t syn_id : outgoing_[pre_id]) {
        if (synapses_[syn_id].post_neuron == post_id) {
            return true;
        }
    }
    return false;
}

size_t Network::getPreNeuron(size_t synapse_id) const {
    validateSynapseId(synapse_id);
    return synapses_[synapse_id].pre_neuron;
}

size_t Network::getPostNeuron(size_t synapse_id) const {
    validateSynapseId(synapse_id);
    return synapses_[synapse_id].post_neuron;
}

size_t Network::getDelay(size_t synapse_id) const {
    validateSynapseId(synapse_id);
    return synapses_[synapse_id].delay;
}

void Network::setExternalInput(size_t neuron_id, double I) {
    validateNeuronId(neuron_id);
    if (!std::isfinite(I)) {
        throw std::invalid_argument(
            "Network: external input must be finite, got " + std::to_string(I)
        );
    }
    external_inputs_[neuron_id] = I;
}

void Network::clearExternalInputs() {
    std::fill(external_inputs_.begin(), external_inputs_.end(), 0.0);
}

bool Network::validateDt(double dt) const {
    if (dt <= 0.0 || !std::isfinite(dt)) {
        return false;
    }

    // Check all neurons
    for (const auto& neuron : neurons_) {
        if (!neuron.validateDt(dt)) {
            return false;
        }
    }

    // Check all synapses
    for (const auto& syn : synapses_) {
        if (!syn.synapse.validateDt(dt)) {
            return false;
        }
    }

    return true;
}

void Network::reset() {
    // Reset all neurons
    for (auto& neuron : neurons_) {
        neuron.reset();
    }

    // Reset all synapses
    for (auto& syn : synapses_) {
        syn.synapse.reset();
    }

    // Reset simulation state
    timestep_ = 0;
    std::fill(external_inputs_.begin(), external_inputs_.end(), 0.0);
    std::fill(spikes_this_step_.begin(), spikes_this_step_.end(), false);

    // Clear delayed spike queues
    for (auto& queue : delayed_spikes_) {
        queue.clear();
    }

    // Reset homeostatic state (STARK-005) — preserves configuration
    resetFiringRates();

    // Reset STARK-006 modulatory signal
    modulatory_signal_ = 0.0;

    // STARK-L5: eligibility gates are per-trial task state; restore default.
    std::fill(eligibility_gates_.begin(), eligibility_gates_.end(), true);
}

void Network::step(double dt) {
    if (!validateDt(dt)) {
        throw std::invalid_argument(
            "Network: dt=" + std::to_string(dt) + " is invalid for network components"
        );
    }

    const size_t N = neurons_.size();
    const size_t E = synapses_.size();

    // Step 1: Decay all synaptic traces (pre and post)
    // This happens at the beginning of the timestep to ensure traces are ready for STDP
    for (size_t syn_id = 0; syn_id < E; ++syn_id) {
        synapses_[syn_id].synapse.decayTraces(dt);
    }

    // Step 2: Decay eligibility traces for STARK-006 three-factor synapses
    for (size_t syn_id = 0; syn_id < E; ++syn_id) {
        if (synapses_[syn_id].synapse.getPlasticityMode() == PlasticityMode::THREEFACTOR) {
            synapses_[syn_id].synapse.decayEligibility(dt);
        }
    }

    // Step 2: Compute total input for each neuron (external + synaptic from PREVIOUS step)
    std::vector<double> total_input(N);
    for (size_t i = 0; i < N; ++i) {
        total_input[i] = external_inputs_[i];

        // Add synaptic currents from incoming synapses
        for (size_t syn_id : incoming_[i]) {
            const SynapseInstance& syn = synapses_[syn_id];
            total_input[i] += syn.synapse.getWeight() * syn.synapse.getState();
        }
    }

    // Step 3: Update all neurons with their total input
    // This determines spikes at current timestep t
    spikes_this_step_.assign(N, false);
    for (size_t i = 0; i < N; ++i) {
        bool spiked = neurons_[i].update(total_input[i], dt);
        spikes_this_step_[i] = spiked;

        // Update post-synaptic traces for all incoming synapses
        if (spiked) {
            for (size_t syn_id : incoming_[i]) {
                synapses_[syn_id].synapse.updatePostTrace();
            }
        }
    }

    // Step 4: Deliver spikes to synapses (for next timestep's current)
    // Immediate delivery (delay=0): update synapse state now
    // Delayed delivery: schedule for future timestep
    for (size_t i = 0; i < N; ++i) {
        if (spikes_this_step_[i]) {
            // Neuron i spiked, deliver to its outgoing synapses
            for (size_t syn_id : outgoing_[i]) {
                SynapseInstance& syn = synapses_[syn_id];
                if (syn.delay == 0) {
                    // Immediate: receive spike now, current ready for t+1
                    syn.synapse.receiveSpike(true, dt);
                } else {
                    // Delayed: schedule delivery
                    size_t delivery_timestep = timestep_ + syn.delay;
                    delayed_spikes_[syn.post_neuron].push_back({syn_id, delivery_timestep});
                }
            }
        } else {
            // Neuron i did not spike, synapses just decay
            for (size_t syn_id : outgoing_[i]) {
                SynapseInstance& syn = synapses_[syn_id];
                if (syn.delay == 0) {
                    syn.synapse.receiveSpike(false, dt);
                }
                if (syn.delay > 0) {
                    syn.synapse.receiveSpike(false, dt);
                }
            }
        }
    }

    // Step 5: Apply STDP weight updates
    // Standard STDP model:
    // - On post-synaptic spike: dw = A_+ * x_pre (LTP based on recent pre-synaptic activity)
    // - On pre-synaptic spike: dw = -A_- * x_post (LTD based on recent post-synaptic activity)
    for (size_t syn_id = 0; syn_id < E; ++syn_id) {
        SynapseInstance& syn = synapses_[syn_id];
        bool pre_spiked = spikes_this_step_[syn.pre_neuron];
        bool post_spiked = spikes_this_step_[syn.post_neuron];

        // Apply LTP when post-synaptic neuron spikes
        // (strengthens synapse based on recent pre-synaptic activity)
        if (post_spiked) {
            syn.synapse.applyLTP();
        }

        // Apply LTD when pre-synaptic neuron spikes
        // (weakens synapse based on recent post-synaptic activity)
        if (pre_spiked) {
            syn.synapse.applyLTD();
        }
    }

    // Step 6: Accumulate eligibility credit for STARK-006 three-factor synapses
    // Uses the same pre/post spike flags as STDP. The post contribution is applied
    // first (matching STARK-004's same-timestep convention), then the pre contribution.
    // STARK-L5: eligibility gates (pre-synaptic side) block accumulation at trace
    // creation for gated-off neurons. Default all-on: identical behavior to the
    // ungated rule (the accumulate call is skipped exactly when the gate is off).
    for (size_t syn_id = 0; syn_id < E; ++syn_id) {
        if (synapses_[syn_id].synapse.getPlasticityMode() == PlasticityMode::THREEFACTOR) {
            if (!eligibility_gates_[synapses_[syn_id].pre_neuron]) continue;
            bool pre_spiked = spikes_this_step_[synapses_[syn_id].pre_neuron];
            bool post_spiked = spikes_this_step_[synapses_[syn_id].post_neuron];
            synapses_[syn_id].synapse.accumulateEligibility(pre_spiked, post_spiked);
        }
    }

    // Step 7: Apply three-factor modulator-gated weight updates (STARK-006)
    // Only THREEFACTOR-mode synapses are updated; STDP-mode synapses are skipped
    // (applyLTP/applyLTD suppress themselves in THREEFACTOR mode, so no double apply).
    if (modulatory_signal_ != 0.0) {
        for (size_t syn_id = 0; syn_id < E; ++syn_id) {
            synapses_[syn_id].synapse.applyThreeFactor(modulatory_signal_);
        }
    }

    // Step 8: Update physical-Hz firing-rate EMA and apply multiplicative homeostasis (STARK-005)
    homeostaticUpdate(dt);

    // Step 9: Process delayed spike deliveries arriving at this timestep (t+1)
    // Note: current timestep is still timestep_, deliveries scheduled for timestep_ + 1
    // Actually, we process deliveries for the NEW timestep (timestep_ + 1)
    size_t new_timestep = timestep_ + 1;

    for (size_t i = 0; i < N; ++i) {
        auto& queue = delayed_spikes_[i];
        // Process all deliveries scheduled for new_timestep
        // We iterate backwards so we can erase efficiently
        for (auto it = queue.begin(); it != queue.end(); ) {
            if (it->second == new_timestep) {
                size_t syn_id = it->first;
                // Synapse has already decayed for this step (in the loop above)
                // Now add the spike contribution
                synapses_[syn_id].synapse.receiveSpike(true, dt);
                it = queue.erase(it);
            } else {
                ++it;
            }
        }
    }

    // Step 10: Advance time
    timestep_ = new_timestep;

    // Clear external inputs and modulatory signal (transient inputs for the completed step)
    clearExternalInputs();
    clearModulatorySignal();
}

void Network::setHomeostasisParameters(double tau_r, double kappa, double target_hz, double hysteresis_hz) {
    if (tau_r <= 0.0 || !std::isfinite(tau_r)) {
        throw std::invalid_argument("Network: tau_r must be > 0 and finite");
    }
    if (kappa <= 0.0 || !std::isfinite(kappa)) {
        throw std::invalid_argument("Network: kappa must be > 0 and finite");
    }
    if (target_hz < 0.0 || !std::isfinite(target_hz)) {
        throw std::invalid_argument("Network: target_hz must be >= 0 and finite");
    }
    if (hysteresis_hz < 0.0 || !std::isfinite(hysteresis_hz)) {
        throw std::invalid_argument("Network: hysteresis_hz must be >= 0 and finite");
    }

    // Validate ALL parameters before committing to avoid partial mutation.
    size_t N = neurons_.size();
    std::vector<double> r_mean_new(N, 0.0);
    std::vector<double> scale_new(N, 1.0);

    homeostasis_tau_r_ = tau_r;
    homeostasis_kappa_ = kappa;
    homeostasis_target_hz_ = target_hz;
    homeostasis_hysteresis_hz_ = hysteresis_hz;
    homeostasis_enabled_ = true;

    r_mean_            = std::move(r_mean_new);
    homeostatic_scale_ = std::move(scale_new);
}

void Network::resetFiringRates() {
    std::fill(r_mean_.begin(), r_mean_.end(), 0.0);
    std::fill(homeostatic_scale_.begin(), homeostatic_scale_.end(), 1.0);
}

void Network::homeostaticUpdate(double dt) {
    if (!homeostasis_enabled_) return;

    const size_t N = neurons_.size();

    // Ensure homeostatic state vectors are sized for all neurons
    if (r_mean_.size() != N) {
        r_mean_.assign(N, 0.0);
    }
    if (homeostatic_scale_.size() != N) {
        homeostatic_scale_.assign(N, 1.0);
    }

    // STEP 9 in Network::step() ordering:
    // Update firing rate estimates using exact exponential decay with physical Hz units.
    // r_inst = spike ? 1.0/dt : 0.0  (Hz)  -- one spike over dt seconds
    // r_mean(t+dt) = r_mean(t) * exp(-dt/tau_r) + r_inst * (1 - exp(-dt/tau_r))
    double decay_factor = std::exp(-dt / homeostasis_tau_r_);
    double input_factor = 1.0 - decay_factor;

    for (size_t i = 0; i < N; ++i) {
        double spike = spikes_this_step_[i] ? 1.0 : 0.0;
        double r_inst = spike > 0 ? 1.0 / dt : 0.0;  // Hz
        r_mean_[i] = r_mean_[i] * decay_factor + r_inst * input_factor;
    }

    // STEP 10 in Network::step() ordering:
    // Apply multiplicative homeostatic scaling to incoming synapses.
    // scale = exp(kappa * error * dt) where error = target_hz - r_mean
    // Only scale when outside hysteresis dead-zone.
    for (size_t i = 0; i < N; ++i) {
        double error = homeostasis_target_hz_ - r_mean_[i];

        // Only adjust if error exceeds hysteresis threshold (dead zone)
        if (std::abs(error) > homeostasis_hysteresis_hz_) {
            // kappa is dimensionless, error is Hz (1/s), dt is seconds -> dimensionless exponent
            double scale = std::exp(homeostasis_kappa_ * error * dt);

            // Guard against pathological scale values (should never happen with
            // validated parameters, but protects against extreme inputs)
            if (!std::isfinite(scale) || scale <= 0.0) {
                homeostatic_scale_[i] = 1.0;
                continue;
            }

            homeostatic_scale_[i] = scale;

            // Apply to all incoming synapses (postsynaptic / incoming homeostasis):
            // to control neuron i's firing rate we adjust the synapses DRIVING it.
            for (size_t syn_id : incoming_[i]) {
                synapses_[syn_id].synapse.scaleWeight(scale);
            }
        } else {
            // Inside hysteresis dead-zone: no scaling applied this step.
            homeostatic_scale_[i] = 1.0;
        }
    }
}

void Network::run(size_t steps, double dt) {
    for (size_t i = 0; i < steps; ++i) {
        step(dt);
    }
}

void Network::connectRandomSparse(double connection_probability,
                                  double exc_weight, double inh_weight,
                                  double exc_tau_s, double inh_tau_s,
                                  double exc_ratio, size_t delay) {
    if (connection_probability < 0.0 || connection_probability > 1.0) {
        throw std::invalid_argument("connection_probability must be in [0, 1]");
    }
    if (exc_ratio < 0.0 || exc_ratio > 1.0) {
        throw std::invalid_argument("exc_ratio must be in [0, 1]");
    }
    if (!std::isfinite(exc_weight) || !std::isfinite(inh_weight) ||
        !std::isfinite(exc_tau_s) || !std::isfinite(inh_tau_s)) {
        throw std::invalid_argument("All weight and tau_s parameters must be finite");
    }
    if (exc_tau_s <= 0.0 || inh_tau_s <= 0.0) {
        throw std::invalid_argument("tau_s must be > 0");
    }

    // Clear existing synapses
    synapses_.clear();
    for (auto& vec : outgoing_) vec.clear();
    for (auto& vec : incoming_) vec.clear();

    size_t N = neurons_.size();
    if (N < 2) return;  // No connections possible

    std::mt19937 rng(42);  // Fixed seed for determinism
    std::uniform_real_distribution<double> dist(0.0, 1.0);

    for (size_t pre = 0; pre < N; ++pre) {
        for (size_t post = 0; post < N; ++post) {
            if (pre == post) continue;  // No self-connections

            if (dist(rng) < connection_probability) {
                // Determine E/I type
                bool is_excitatory = dist(rng) < exc_ratio;
                double weight = is_excitatory ? exc_weight : inh_weight;
                double tau_s = is_excitatory ? exc_tau_s : inh_tau_s;

                addSynapse(pre, post, weight, tau_s, delay);
            }
        }
    }
}

void Network::connectLocal(size_t radius, double weight, double tau_s, size_t delay) {
    if (!std::isfinite(weight) || !std::isfinite(tau_s)) {
        throw std::invalid_argument("weight and tau_s must be finite");
    }
    if (tau_s <= 0.0) {
        throw std::invalid_argument("tau_s must be > 0");
    }

    // Clear existing synapses
    synapses_.clear();
    for (auto& vec : outgoing_) vec.clear();
    for (auto& vec : incoming_) vec.clear();

    size_t N = neurons_.size();
    if (N < 2) return;

    for (size_t pre = 0; pre < N; ++pre) {
        for (size_t post = 0; post < N; ++post) {
            if (pre == post) continue;
            if (std::max(pre, post) - std::min(pre, post) <= radius) {
                addSynapse(pre, post, weight, tau_s, delay);
            }
        }
    }
}

void Network::enablePlasticity(size_t synapse_id, double A_plus, double A_minus,
                              double tau_pre, double tau_post, double w_min, double w_max) {
    validateSynapseId(synapse_id);

    Synapse& synapse = getSynapse(synapse_id);
    synapse.setPlasticityParameters(A_plus, A_minus, tau_pre, tau_post, w_min, w_max);
}

// ============================================================
// STARK-006: Three-factor modulator-gated plasticity
// ============================================================

void Network::setModulatorySignal(double m) {
    if (!std::isfinite(m)) {
        throw std::invalid_argument(
            "Network::setModulatorySignal: modulator must be finite. Got m=" + std::to_string(m)
        );
    }
    modulatory_signal_ = m;
}

void Network::setEligibilityGate(size_t neuron_id, bool on) {
    validateNeuronId(neuron_id);
    eligibility_gates_[neuron_id] = on;
}

bool Network::getEligibilityGate(size_t neuron_id) const {
    validateNeuronId(neuron_id);
    return eligibility_gates_[neuron_id];
}

void Network::enableThreeFactor(size_t synapse_id, double E_plus, double E_minus,
                              double tau_e, double eta_3f, double w_min, double w_max) {
    validateSynapseId(synapse_id);
    Synapse& synapse = getSynapse(synapse_id);
    synapse.enableThreeFactor(E_plus, E_minus, tau_e, eta_3f, w_min, w_max);
}

double Network::getEligibility(size_t synapse_id) const {
    validateSynapseId(synapse_id);
    return synapses_[synapse_id].synapse.getEligibility();
}

PlasticityMode Network::getPlasticityMode(size_t synapse_id) const {
    validateSynapseId(synapse_id);
    return synapses_[synapse_id].synapse.getPlasticityMode();
}

void Network::connectAllToAll(double weight, double tau_s, size_t delay) {
    if (!std::isfinite(weight) || !std::isfinite(tau_s)) {
        throw std::invalid_argument("weight and tau_s must be finite");
    }
    if (tau_s <= 0.0) {
        throw std::invalid_argument("tau_s must be > 0");
    }

    // Clear existing synapses
    synapses_.clear();
    for (auto& vec : outgoing_) vec.clear();
    for (auto& vec : incoming_) vec.clear();

    size_t N = neurons_.size();
    if (N < 2) return;

    for (size_t pre = 0; pre < N; ++pre) {
        for (size_t post = 0; post < N; ++post) {
            if (pre != post) {
                addSynapse(pre, post, weight, tau_s, delay);
            }
        }
    }
}

double Network::getHomeostaticScale(size_t neuron_id) const {
    validateNeuronId(neuron_id);
    if (homeostatic_scale_.empty()) return 1.0;
    return homeostatic_scale_[neuron_id];
}

// ---------------------------------------------------------------------------
// STARK-006 Serialization / Checkpointing
// ---------------------------------------------------------------------------
//
// Simple deterministic token-based text format. Uses max_digits10 with
// defaultfloat so double values round-trip exactly on the same build/compiler.
// The format is versioned and every field is validated on load; deserialize()
// is transactional (no partial mutation on failure).

namespace {
std::vector<std::string> stark_tokenize(const std::string& s) {
    std::istringstream iss(s);
    std::vector<std::string> out;
    std::string t;
    while (iss >> t) out.push_back(t);
    return out;
}
}

std::string Network::serialize() const {
    std::ostringstream os;
    os << std::setprecision(std::numeric_limits<double>::max_digits10);

    const size_t N = neurons_.size();
    const size_t E = synapses_.size();

    os << "STARK006 2\n";
    os << "N " << N << " " << E << " " << timestep_
       << " " << (homeostasis_enabled_ ? 1 : 0) << "\n";
    os << "H " << homeostasis_tau_r_ << " " << homeostasis_kappa_ << " "
       << homeostasis_target_hz_ << " " << homeostasis_hysteresis_hz_ << "\n";

    os << "R";
    for (size_t i = 0; i < N; ++i) os << " " << (i < r_mean_.size() ? r_mean_[i] : 0.0);
    os << "\n";

    os << "S";
    for (size_t i = 0; i < N; ++i) os << " " << (i < homeostatic_scale_.size() ? homeostatic_scale_[i] : 1.0);
    os << "\n";

    os << "SP";
    for (size_t i = 0; i < N; ++i) os << " " << (spikes_this_step_[i] ? 1 : 0);
    os << "\n";

    os << "E";
    for (size_t i = 0; i < N; ++i) os << " " << external_inputs_[i];
    os << "\n";

    for (size_t i = 0; i < N; ++i) {
        const NeuralCell& nc = neurons_[i];
        os << "NC " << i
           << " " << nc.getTauM()
           << " " << nc.getTheta0()
           << " " << nc.getTauA()
           << " " << nc.getB()
           << " " << nc.getVReset()
           << " " << nc.getV()
           << " " << nc.getA()
           << " " << (nc.getSpike() ? 1 : 0)
           << "\n";
    }

    for (size_t k = 0; k < E; ++k) {
        const SynapseInstance& si = synapses_[k];
        const Synapse& s = si.synapse;
        os << "SC " << k
           << " " << si.pre_neuron
           << " " << si.post_neuron
           << " " << si.delay
           << " " << s.getTauS()
           << " " << s.getWeight()
           << " " << s.getState()
           << " " << s.getPreTrace()
           << " " << s.getPostTrace()
           << " " << s.getWeightMin()
           << " " << s.getWeightMax()
           << " " << s.getAPlus()
           << " " << s.getAMinus()
           << " " << s.getTauPre()
           << " " << s.getTauPost()
           << " " << (s.getPlasticityEnabled() ? 1 : 0)
           << " " << s.getEligibility()
           << " " << s.getEPlus()
           << " " << s.getEMinus()
           << " " << s.getTauE()
           << " " << s.getEta3f()
           << " " << (s.getThreeFactorEnabled() ? 1 : 0)
           << " " << static_cast<int>(s.getPlasticityMode())
           << "\n";
    }

    os << "M " << modulatory_signal_ << "\n";

    os << "DQ " << N << "\n";
    for (size_t i = 0; i < N; ++i) {
        os << "Q " << delayed_spikes_[i].size();
        for (const auto& p : delayed_spikes_[i]) {
            os << " " << p.first << " " << p.second;
        }
        os << "\n";
    }

    return os.str();
}

void Network::deserialize(const std::string& data) {
    std::vector<std::string> tok = stark_tokenize(data);
    size_t pos = 0;

    auto nextTok = [&]() -> const std::string& {
        if (pos >= tok.size()) {
            throw std::invalid_argument("deserialize: premature end of data");
        }
        return tok[pos++];
    };
    auto expectTok = [&](const std::string& expected) {
        if (nextTok() != expected) {
            throw std::invalid_argument("deserialize: expected token '" + expected + "'");
        }
    };
    auto parseDouble = [&]() -> double {
        const std::string& t = nextTok();
        errno = 0;
        char* end = nullptr;
        double v = std::strtod(t.c_str(), &end);
        if (end == t.c_str() || (end != nullptr && *end != '\0') || errno == ERANGE) {
            throw std::invalid_argument("deserialize: invalid numeric token '" + t + "'");
        }
        return v;
    };
    auto parseSize = [&]() -> size_t {
        const std::string& t = nextTok();
        if (t.empty() || t.find_first_not_of("0123456789") != std::string::npos) {
            throw std::invalid_argument("deserialize: invalid size token '" + t + "'");
        }
        errno = 0;
        char* end = nullptr;
        unsigned long long v = std::strtoull(t.c_str(), &end, 10);
        if (end == t.c_str() || (end != nullptr && *end != '\0') || errno == ERANGE) {
            throw std::invalid_argument("deserialize: invalid size token '" + t + "'");
        }
        return static_cast<size_t>(v);
    };

    // Header
    expectTok("STARK006");
    std::string version = nextTok();
    bool v2 = (version == "2");
    if (!v2 && version != "1") {
        throw std::invalid_argument("deserialize: unsupported version");
    }

    expectTok("N");
    const size_t nN = parseSize();
    const size_t nE = parseSize();
    const size_t timestep = parseSize();
    const size_t homeo_flag = parseSize();
    if (homeo_flag > 1) {
        throw std::invalid_argument("deserialize: invalid homeostasis enabled flag");
    }
    const bool h_enabled = (homeo_flag != 0);

    expectTok("H");
    const double h_tau_r = parseDouble();
    const double h_kappa = parseDouble();
    const double h_target = parseDouble();
    const double h_hyst = parseDouble();
    if (!std::isfinite(h_tau_r) || !std::isfinite(h_kappa) ||
        !std::isfinite(h_target) || !std::isfinite(h_hyst)) {
        throw std::invalid_argument("deserialize: non-finite homeostatic parameter");
    }
    if (h_enabled) {
        if (h_tau_r <= 0.0) throw std::invalid_argument("deserialize: tau_r must be > 0");
        if (h_kappa <= 0.0) throw std::invalid_argument("deserialize: kappa must be > 0");
        if (h_target < 0.0) throw std::invalid_argument("deserialize: target must be >= 0");
        if (h_hyst < 0.0) throw std::invalid_argument("deserialize: hysteresis must be >= 0");
    }

    // Rate, scale, spike, external-input arrays
    std::vector<double> r_mean_tmp(nN, 0.0);
    std::vector<double> scale_tmp(nN, 1.0);
    std::vector<bool> spikes_tmp(nN, false);
    std::vector<double> ext_tmp(nN, 0.0);

    expectTok("R");
    for (size_t i = 0; i < nN; ++i) {
        double v = parseDouble();
        if (!std::isfinite(v) || v < 0.0) {
            throw std::invalid_argument("deserialize: invalid firing rate");
        }
        r_mean_tmp[i] = v;
    }
    expectTok("S");
    for (size_t i = 0; i < nN; ++i) {
        double v = parseDouble();
        if (!std::isfinite(v) || v <= 0.0) {
            throw std::invalid_argument("deserialize: invalid homeostatic scale");
        }
        scale_tmp[i] = v;
    }
    expectTok("SP");
    for (size_t i = 0; i < nN; ++i) {
        size_t v = parseSize();
        if (v > 1) throw std::invalid_argument("deserialize: invalid spike flag");
        spikes_tmp[i] = (v != 0);
    }
    expectTok("E");
    for (size_t i = 0; i < nN; ++i) {
        double v = parseDouble();
        if (!std::isfinite(v)) throw std::invalid_argument("deserialize: non-finite external input");
        ext_tmp[i] = v;
    }

    // Neurons
    std::vector<NeuralCell> neurons_tmp;
    neurons_tmp.reserve(nN);
    for (size_t i = 0; i < nN; ++i) {
        expectTok("NC");
        const size_t idx = parseSize();
        if (idx != i) throw std::invalid_argument("deserialize: neuron index mismatch");
        const double tau_m = parseDouble();
        const double theta0 = parseDouble();
        const double tau_a = parseDouble();
        const double b = parseDouble();
        const double v_reset = parseDouble();
        const double V = parseDouble();
        const double a = parseDouble();
        const size_t spiked = parseSize();
        if (spiked > 1) throw std::invalid_argument("deserialize: invalid neuron spike flag");
        NeuralCell nc(tau_m, theta0, tau_a, b, v_reset);
        nc.setActiveState(V, a, spiked != 0);
        neurons_tmp.push_back(std::move(nc));
    }

    // Synapses (rebuild adjacency from stored topology)
    std::vector<SynapseInstance> synapses_tmp;
    synapses_tmp.reserve(nE);
    std::vector<std::vector<size_t>> outgoing_tmp(nN);
    std::vector<std::vector<size_t>> incoming_tmp(nN);
    for (size_t k = 0; k < nE; ++k) {
        expectTok("SC");
        const size_t idx = parseSize();
        if (idx != k) throw std::invalid_argument("deserialize: synapse index mismatch");
        const size_t pre = parseSize();
        const size_t post = parseSize();
        if (pre >= nN || post >= nN) {
            throw std::invalid_argument("deserialize: synapse references invalid neuron");
        }
        const size_t delay = parseSize();
        const double tau_s = parseDouble();
        const double w = parseDouble();
        const double x = parseDouble();
        const double x_pre = parseDouble();
        const double x_post = parseDouble();
        const double w_min = parseDouble();
        const double w_max = parseDouble();
        const double A_plus = parseDouble();
        const double A_minus = parseDouble();
        const double tau_pre = parseDouble();
        const double tau_post = parseDouble();
        const size_t plast = parseSize();
        if (plast > 1) throw std::invalid_argument("deserialize: invalid plasticity flag");

        // Parse three-factor fields (present in version 2 only)
        double e_val = 0.0;
        double e_plus_val = 0.0;
        double e_minus_val = 0.0;
        double tau_e_val = 1.0;
        double eta_3f_val = 0.0;
        bool three_factor_enabled_val = false;
        PlasticityMode mode_val = PlasticityMode::NONE;
        if (v2) {
            e_val = parseDouble();
            e_plus_val = parseDouble();
            e_minus_val = parseDouble();
            tau_e_val = parseDouble();
            eta_3f_val = parseDouble();
            three_factor_enabled_val = (parseSize() != 0);
            int mode_int = static_cast<int>(parseSize());
            if (mode_int < 0 || mode_int > 2) {
                throw std::invalid_argument("deserialize: invalid plasticity mode");
            }
            mode_val = static_cast<PlasticityMode>(mode_int);
        }

        // Enforce plasticity-state consistency invariant.
        if (!plast) {
            if (three_factor_enabled_val || mode_val != PlasticityMode::NONE) {
                throw std::invalid_argument("deserialize: plasticity disabled but TF/mode inconsistent");
            }
        } else if (!three_factor_enabled_val) {
            if (mode_val != PlasticityMode::STDP) {
                throw std::invalid_argument("deserialize: plasticity enabled but mode not STDP when TF disabled");
            }
        } else {
            if (mode_val != PlasticityMode::THREEFACTOR) {
                throw std::invalid_argument("deserialize: TF enabled but mode not THREEFACTOR");
            }
        }

        Synapse s(w, tau_s);
        s.setFullState(x, w, x_pre, x_post, A_plus, A_minus,
                       tau_pre, tau_post, w_min, w_max, plast != 0,
                       e_val, e_plus_val, e_minus_val, tau_e_val, eta_3f_val,
                       three_factor_enabled_val, mode_val);
        synapses_tmp.emplace_back(pre, post, s, delay);
        outgoing_tmp[pre].push_back(k);
        incoming_tmp[post].push_back(k);
    }

    // Parse modulatory signal (version 2 only)
    double modulator = 0.0;
    if (v2) {
        expectTok("M");
        modulator = parseDouble();
        if (!std::isfinite(modulator)) {
            throw std::invalid_argument("deserialize: non-finite modulator");
        }
    }

    // Delay queues
    expectTok("DQ");
    const size_t qcount = parseSize();
    if (qcount != nN) throw std::invalid_argument("deserialize: delay queue count mismatch");
    std::vector<std::vector<std::pair<size_t, size_t>>> delayed_tmp(nN);
    for (size_t i = 0; i < nN; ++i) {
        expectTok("Q");
        const size_t qsize = parseSize();
        auto& q = delayed_tmp[i];
        q.reserve(qsize);
        for (size_t j = 0; j < qsize; ++j) {
            const size_t syn_id = parseSize();
            const size_t deliver = parseSize();
            if (syn_id >= nE) {
                throw std::invalid_argument("deserialize: delay queue references invalid synapse");
            }
            // Verify the synapse actually targets this neuron.
            if (synapses_tmp[syn_id].post_neuron != i) {
                throw std::invalid_argument("deserialize: delay queue entry references wrong target neuron");
            }
            // Delivery timestep must not be in the past relative to checkpoint.
            if (deliver < timestep) {
                throw std::invalid_argument("deserialize: delay queue has past-due delivery timestep");
            }
            q.push_back(std::make_pair(syn_id, deliver));
        }
    }

    // All validation passed: commit atomically (no throws below).
    neurons_ = std::move(neurons_tmp);
    synapses_ = std::move(synapses_tmp);
    outgoing_ = std::move(outgoing_tmp);
    incoming_ = std::move(incoming_tmp);
    timestep_ = timestep;
    external_inputs_ = std::move(ext_tmp);
    spikes_this_step_ = std::move(spikes_tmp);
    delayed_spikes_ = std::move(delayed_tmp);
    r_mean_ = std::move(r_mean_tmp);
    homeostatic_scale_ = std::move(scale_tmp);
    // STARK-L5: eligibility gates are volatile per-trial task state and are
    // NOT serialized; restore the default (all on) for the restored neurons.
    eligibility_gates_.assign(neurons_.size(), true);
    homeostasis_tau_r_ = h_tau_r;
    homeostasis_kappa_ = h_kappa;
    homeostasis_target_hz_ = h_target;
    homeostasis_hysteresis_hz_ = h_hyst;
    homeostasis_enabled_ = h_enabled;
    modulatory_signal_ = modulator;
}

void Network::save(const std::string& path) const {
    std::ofstream ofs(path);
    if (!ofs) {
        throw std::runtime_error("Network::save: cannot open file: " + path);
    }
    ofs << serialize();
    if (!ofs) {
        throw std::runtime_error("Network::save: write failed: " + path);
    }
    ofs.close();
}

void Network::load(const std::string& path) {
    std::ifstream ifs(path);
    if (!ifs) {
        throw std::runtime_error("Network::load: cannot open file: " + path);
    }
    std::stringstream ss;
    ss << ifs.rdbuf();
    deserialize(ss.str());
}
