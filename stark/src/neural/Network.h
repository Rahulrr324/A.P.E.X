#pragma once

/**
 * STARK-003: Centralized Sparse Network
 * 
 * Manages a collection of NeuralCell instances connected by Synapse instances.
 * Provides deterministic fixed-timestep simulation with spike routing,
 * transmission delays, and full diagnostic access.
 * 
 * Architecture:
 * - Neurons: std::vector<NeuralCell> indexed by neuron_id [0..N-1]
 * - Synapses: std::vector<SynapseInstance> indexed by synapse_id [0..E-1]
 * - Adjacency: outgoing[neuron_id] = vector of synapse_ids
 *              incoming[neuron_id] = vector of synapse_ids
 * - Delays: delayed_spikes[neuron_id] = vector of (synapse_id, delivery_timestep)
 * 
 * Mathematical model: see math/network_specification.md
 * Convention: Spikes at timestep t produce synaptic current effective at t+1
 */

#include "NeuralCell.h"
#include "Synapse.h"
#include <vector>
#include <stdexcept>
#include <cstddef>
#include <utility>
#include <limits>
#include <string>

class Network {
public:
    /**
     * Synapse instance combining connection topology with Synapse object.
     */
    struct SynapseInstance {
        size_t pre_neuron;     // Source neuron ID
        size_t post_neuron;    // Target neuron ID
        Synapse synapse;       // Synapse object (state + parameters)
        size_t delay;          // Transmission delay in timesteps (0 = immediate)
        
        SynapseInstance(size_t pre, size_t post, const Synapse& s, size_t d)
            : pre_neuron(pre), post_neuron(post), synapse(s), delay(d) {}
    };

    /// Default constructor
    Network() = default;
    
    /// Default destructor
    ~Network() = default;

    // ============================================================
    // Neuron Management
    // ============================================================

    /**
     * Add a neuron to the network.
     * @param neuron NeuralCell to add (copied)
     * @return neuron_id assigned to this neuron
     */
    size_t addNeuron(const NeuralCell& neuron);

    /**
     * Add a neuron with specified parameters (convenience).
     * @return neuron_id assigned to this neuron
     */
    size_t addNeuron(double tau_m, double theta_0, double tau_a, double b, double v_reset);

    /**
     * Get mutable reference to neuron.
     * @throws std::out_of_range if id invalid
     */
    NeuralCell& getNeuron(size_t id);

    /**
     * Get const reference to neuron.
     * @throws std::out_of_range if id invalid
     */
    const NeuralCell& getNeuron(size_t id) const;

    /**
     * Get number of neurons in network.
     */
    size_t getNeuronCount() const { return neurons_.size(); }

    // ============================================================
    // Synapse Management
    // ============================================================

    /**
     * Add a directed synapse from pre_id to post_id.
     * @param pre_id Source neuron ID
     * @param post_id Target neuron ID
     * @param weight Synaptic weight (positive = excitatory, negative = inhibitory)
     * @param tau_s Synaptic time constant (default: 2.0)
     * @param delay Transmission delay in timesteps (default: 0)
     * @return synapse_id assigned to this synapse
     * @throws std::invalid_argument if neuron IDs invalid or delay parameters invalid
     */
    size_t addSynapse(size_t pre_id, size_t post_id, double weight, double tau_s = 2.0, size_t delay = 0);

    /**
     * Get mutable reference to synapse.
     * @throws std::out_of_range if id invalid
     */
    Synapse& getSynapse(size_t id);

    /**
     * Get const reference to synapse.
     * @throws std::out_of_range if id invalid
     */
    const Synapse& getSynapse(size_t id) const;

    /**
     * Get number of synapses in network.
     */
    size_t getSynapseCount() const { return synapses_.size(); }

    // ============================================================
    // Connectivity Queries
    // ============================================================

    /**
     * Get outgoing synapse IDs for a neuron.
     * @throws std::out_of_range if neuron_id invalid
     */
    const std::vector<size_t>& getOutgoingSynapses(size_t neuron_id) const;

    /**
     * Get incoming synapse IDs for a neuron.
     * @throws std::out_of_range if neuron_id invalid
     */
    const std::vector<size_t>& getIncomingSynapses(size_t neuron_id) const;

    /**
     * Check if a connection exists from pre to post.
     */
    bool hasConnection(size_t pre_id, size_t post_id) const;

    /**
     * Get the pre-synaptic neuron ID for a synapse (STARK-007 observability).
     * @throws std::out_of_range if synapse_id is invalid
     */
    size_t getPreNeuron(size_t synapse_id) const;

    /**
     * Get the post-synaptic neuron ID for a synapse (STARK-007 observability).
     * @throws std::out_of_range if synapse_id is invalid
     */
    size_t getPostNeuron(size_t synapse_id) const;

    /**
     * Get the transmission delay for a synapse (STARK-007 observability).
     * @throws std::out_of_range if synapse_id is invalid
     */
    size_t getDelay(size_t synapse_id) const;

    // ============================================================
    // External Input
    // ============================================================

    /**
     * Set external input for a neuron for the NEXT timestep.
     * @param neuron_id Target neuron
     * @param I External input current (must be finite)
     * @throws std::out_of_range if neuron_id invalid
     * @throws std::invalid_argument if I is not finite
     */
    void setExternalInput(size_t neuron_id, double I);

    /**
     * Clear all external inputs (set to 0).
     */
    void clearExternalInputs();

    // ============================================================
    // Simulation Control
    // ============================================================

    /**
     * Validate that a time step is valid for all neurons and synapses.
     * @param dt Time step to validate
     * @return true if valid for all components
     */
    bool validateDt(double dt) const;

    /**
     * Perform a single simulation timestep.
     * @param dt Time step size (must be valid for all components)
     * @throws std::invalid_argument if dt is invalid
     */
    void step(double dt);

    /**
     * Configure homeostatic plasticity parameters (STARK-005).
     *
     * Uses multiplicative synaptic scaling driven by postsynaptic firing-rate
     * estimation in physical Hz units.
     *
     * @param tau_r Rate estimation time constant (seconds, > 0)
     * @param kappa Homeostatic scaling rate (dimensionless, > 0)
     * @param target_hz Target firing rate (Hz, >= 0)
     * @param hysteresis_hz Hysteresis dead-zone threshold (Hz, >= 0)
     * @throws std::invalid_argument if parameters are invalid
     */
    void setHomeostasisParameters(double tau_r, double kappa, double target_hz, double hysteresis_hz);
    
    /**
     * Apply homeostatic weight updates (STARK-005).
     * 
     * @param dt Timestep size (seconds)
     */
    void homeostaticUpdate(double dt);

    /**
     * Reset firing rate estimates (STARK-005).
     */
    void resetFiringRates();

    /**
     * Enable STDP plasticity for a synapse.
     * 
     * @param synapse_id Synapse to enable plasticity for
     * @param A_plus LTP learning rate (A_+ > 0)
     * @param A_minus LTD learning rate (A_- > 0)
     * @param tau_pre Pre-synaptic trace time constant (tau_pre > 0)
     * @param tau_post Post-synaptic trace time constant (tau_post > 0)
     * @param w_min Minimum weight bound (w_min <= current weight)
     * @param w_max Maximum weight bound (w_max >= current weight)
     * @throws std::invalid_argument if parameters are invalid
     */
    void enablePlasticity(size_t synapse_id, double A_plus, double A_minus, 
                         double tau_pre, double tau_post, double w_min, double w_max);

    // ============================================================
    // STARK-006: Three-factor modulator-gated plasticity
    // ============================================================

    /**
     * Set the modulatory signal m(t) for the current timestep (STARK-006).
     * The signal is a dimensionless scalar broadcast to all THREEFACTOR-mode synapses.
     * Must be finite. Cleared at the end of each step().
     *
     * @param m Modulatory signal (dimensionless, finite)
     * @throws std::invalid_argument if m is NaN or Inf
     */
    void setModulatorySignal(double m);

    /**
     * Get the current modulatory signal (STARK-006).
     */
    double getModulatorySignal() const { return modulatory_signal_; }

    /**
     * Clear the modulatory signal to 0 (transient, reset each step).
     */
    void clearModulatorySignal() { modulatory_signal_ = 0.0; }

    /**
     * Enable three-factor modulator-gated plasticity for a synapse (STARK-006).
     *
     * Switches the synapse into THREEFACTOR mode, suppressing the immediate STDP weight
     * update. The synapse maintains an eligibility trace that accumulates signed STDP-style
     * credit, and weight changes only occur when a modulatory signal m(t) is present.
     *
     * @param synapse_id Synapse to configure
     * @param E_plus Eligibility potentiation amplitude (>= 0)
     * @param E_minus Eligibility depression amplitude (>= 0)
     * @param tau_e Eligibility time constant (seconds, > 0)
     * @param eta_3f Three-factor learning rate (dimensionless, > 0)
     * @param w_min Minimum weight bound
     * @param w_max Maximum weight bound
     * @throws std::invalid_argument if parameters are invalid
     * @throws std::out_of_range if synapse_id is invalid
     */
    void enableThreeFactor(size_t synapse_id, double E_plus, double E_minus,
                          double tau_e, double eta_3f, double w_min, double w_max);

    /**
     * Get the eligibility trace value for a synapse (STARK-006 diagnostic).
     * @throws std::out_of_range if synapse_id is invalid
     */
    double getEligibility(size_t synapse_id) const;

    /**
     * Get the plasticity mode of a synapse (STARK-006).
     * @throws std::out_of_range if synapse_id is invalid
     */
    PlasticityMode getPlasticityMode(size_t synapse_id) const;

    /**
     * Run multiple simulation timesteps.
     * @param steps Number of timesteps to run
     * @param dt Time step size
     * @throws std::invalid_argument if dt is invalid
     */
    void run(size_t steps, double dt);

    /**
     * Reset the entire network to initial state.
     * Resets all neurons, synapses, timestep counter, inputs, and delay queues.
     */
    void reset();

    // ============================================================
    // State Inspection
    // ============================================================

    /**
     * Get current simulation timestep (number of steps executed since reset).
     */
    size_t getCurrentTimeStep() const { return timestep_; }

    /**
     * Get spikes that occurred in the MOST RECENT step() call.
     * Returns vector<bool> of size N, true where neuron spiked.
     * Only valid after at least one step() call.
     */
    const std::vector<bool>& getSpikesThisStep() const { return spikes_this_step_; }

    /**
     * Get current external inputs for all neurons.
     */
    const std::vector<double>& getExternalInputs() const { return external_inputs_; }

    // ============================================================
    // Structured Connectivity Builders (Convenience)
    // ============================================================

    /**
     * Create random sparse connectivity with E/I balance.
     * @param connection_probability Probability of connection between any pair (0.0-1.0)
     * @param exc_weight Weight for excitatory connections
     * @param inh_weight Weight for inhibitory connections (should be negative)
     * @param exc_tau_s Time constant for excitatory synapses
     * @param inh_tau_s Time constant for inhibitory synapses
     * @param exc_ratio Fraction of connections that are excitatory (0.0-1.0)
     * @param delay Transmission delay for all created synapses (default: 0)
     * @note Does not create self-connections. Clears existing synapses.
     */
    void connectRandomSparse(double connection_probability,
                             double exc_weight, double inh_weight,
                             double exc_tau_s, double inh_tau_s,
                             double exc_ratio = 0.8,
                             size_t delay = 0);

    /**
     * Create local connectivity: each neuron connects to neurons within radius.
     * @param radius Maximum index distance for connections
     * @param weight Synaptic weight
     * @param tau_s Synaptic time constant
     * @param delay Transmission delay (default: 0)
     * @note Includes both directions (i→j and j→i for |i-j| ≤ radius, i≠j)
     */
    void connectLocal(size_t radius, double weight, double tau_s, size_t delay = 0);

    /**
     * Create all-to-all connectivity (excluding self-connections).
     * @param weight Synaptic weight
     * @param tau_s Synaptic time constant
     * @param delay Transmission delay (default: 0)
     * @note Clears existing synapses.
     */
    void connectAllToAll(double weight, double tau_s, size_t delay = 0);

private:
    // Core state
    std::vector<NeuralCell> neurons_;
    std::vector<SynapseInstance> synapses_;
    std::vector<std::vector<size_t>> outgoing_;   // per neuron: list of synapse indices
    std::vector<std::vector<size_t>> incoming_;   // per neuron: list of synapse indices

    // Simulation state
    size_t timestep_ = 0;
    std::vector<double> external_inputs_;         // per neuron, for next step
    std::vector<bool> spikes_this_step_;          // per neuron, from last step

    // Delayed spike delivery queue
    // delayed_spikes_[target_neuron] = vector of (synapse_id, delivery_timestep)
    std::vector<std::vector<std::pair<size_t, size_t>>> delayed_spikes_;

    // Homeostatic plasticity state (STARK-005)
    std::vector<double> r_mean_;              // Per-neuron firing rate estimate (Hz)
    std::vector<double> homeostatic_scale_;   // Per-neuron last applied scale (diagnostic)
    double homeostasis_tau_r_ = 1.0;          // Rate estimation time constant (seconds)
    double homeostasis_kappa_ = 0.001;        // Homeostatic scaling rate (dimensionless)
    double homeostasis_target_hz_ = 5.0;      // Target firing rate (Hz)
    double homeostasis_hysteresis_hz_ = 0.1;  // Hysteresis threshold (Hz)
    bool homeostasis_enabled_ = false;        // Whether homeostasis is enabled

    // STARK-006: modulatory signal (transient, cleared each step)
    double modulatory_signal_ = 0.0;

    // Helper methods
    void validateNeuronId(size_t id) const;
    void validateSynapseId(size_t id) const;
    void ensureNeuronCapacity(size_t n);
    void ensureSynapseCapacity(size_t e);
    void deliverSpikes(double dt);
    void processDelayedDeliveries();

public:
    // Public getters for homeostatic state (for testing)
    const std::vector<double>& getFiringRates() const { return r_mean_; }
    bool isHomeostasisEnabled() const { return homeostasis_enabled_; }
    double getHomeostasisTauR() const { return homeostasis_tau_r_; }
    double getHomeostasisKappa() const { return homeostasis_kappa_; }
    double getHomeostasisTargetHz() const { return homeostasis_target_hz_; }
    double getHomeostasisHysteresisHz() const { return homeostasis_hysteresis_hz_; }

    /**
     * Get the last homeostatic scaling factor applied to a neuron's incoming
     * synapses (STARK-005 diagnostic). Returns 1.0 if no scaling was applied.
     * @throws std::out_of_range if neuron_id invalid
     */
    double getHomeostaticScale(size_t neuron_id) const;

    // ============================================================
    // Serialization / Checkpointing (STARK-006)
    // ============================================================

    /**
     * Serialize the FULL network state to a deterministic, versioned, text
     * token string. The output round-trips the exact double values (using
     * max_digits10 with defaultfloat) so a saved+loaded Network continues
     * producing identical future dynamics on the same build/platform.
     */
    std::string serialize() const;

    /**
     * Transactionally restore the network state from a serialized string.
     * The ENTIRE state is parsed and validated with no partial mutation BEFORE
     * being committed, so a failed deserialize leaves the Network unchanged.
     * @throws std::invalid_argument on any malformed/invalid input
     */
    void deserialize(const std::string& data);

    /**
     * Save the network state to a text file (STARK-006 checkpoint).
     * @throws std::runtime_error if the file cannot be opened/written
     */
    void save(const std::string& path) const;

    /**
     * Load the network state from a text file.
     * Transactional: on failure the Network is left unchanged.
     * @throws std::runtime_error if the file cannot be opened
     * @throws std::invalid_argument if the contents are invalid
     */
    void load(const std::string& path);
};