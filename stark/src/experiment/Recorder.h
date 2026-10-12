#pragma once

/**
 * STARK-007: Trajectory Recording
 *
 * A minimal, configurable recorder that captures selected Network state at
 * completed Network::step() boundaries. Recording modes control what is
 * captured to keep memory growth proportional to the chosen detail level.
 *
 * Memory complexity per recorded step (N = neurons, E = synapses):
 *   SPIKES_ONLY:      N bits
 *   SELECTED_NEURONS: K neurons (V, a, spike) — K << N
 *   SELECTED_SYNAPSES: L synapses (w) — L << E
 *   FULL_STATE:       N*(V+a+spike) + E*(w + traces + e)
 *   PERIODIC_SNAPSHOT: full state at intervals only
 *
 * The recorder does NOT duplicate Network dynamics. It only reads observable
 * state via the existing Network API and stores it.
 */

#include "neural/Network.h"
#include "neural/NeuralCell.h"
#include "neural/Synapse.h"
#include <vector>
#include <cstddef>
#include <string>

/// Recording mode selected per experiment.
enum class RecordMode {
    SPIKES_ONLY,          ///< Record only spike vectors per step
    SELECTED_NEURONS,     ///< Record spikes + selected neuron diagnostics
    SELECTED_SYNAPSES,    ///< Record spikes + selected synapse weights
    FULL_STATE,           ///< Record complete neuron + synapse state
    PERIODIC_SNAPSHOT     ///< Record full state every `interval` steps
};

/// One recorded timestep of spike data.
struct SpikeRecord {
    size_t step_index;           ///< Integer step index (authoritative time)
    std::vector<bool> spikes;    ///< Per-neuron spike indicator
};

/// Optional neuron-level diagnostics for a single step.
struct NeuronRecord {
    size_t step_index;
    double V;                    ///< Membrane potential
    double a;                    ///< Adaptation state
    double theta;                ///< Adaptive threshold
    double r_mean;               ///< Firing-rate EMA (Hz)
    double homeo_scale;          ///< Last homeostatic scale factor
    bool spiked;
};

/// Optional synapse-level diagnostics for a single step.
struct SynapseRecord {
    size_t step_index;
    size_t pre_neuron;
    size_t post_neuron;
    double w;                    ///< Weight
    double x_pre;                ///< Pre-synaptic trace
    double x_post;               ///< Post-synaptic trace
    double e;                    ///< Eligibility trace (THREEFACTOR only)
    PlasticityMode mode;         ///< NONE / STDP / THREEFACTOR
};

/// Full per-step snapshot (used by FULL_STATE and PERIODIC_SNAPSHOT).
struct FullSnapshot {
    size_t step_index;
    std::vector<NeuronRecord>  neurons;
    std::vector<SynapseRecord> synapses;
    double modulatory_signal;    ///< m(t) for this step (transient, captured before clear)
};

/**
 * Recorder collects trajectory data during experiment execution.
 *
 * The recorder is a consumer of Network state — it never drives simulation.
 * The experiment harness owns the Network, calls Network::step(dt), then asks
 * the recorder to snapshot the completed step boundary.
 */
class Recorder {
public:
    /**
     * Construct a recorder.
     *
     * @param mode Recording mode
     * @param neuron_ids  Neurons to track (for SELECTED_NEURONS)
     * @param synapse_ids Synapses to track (for SELECTED_SYNAPSES)
     * @param interval    Snapshot interval (for PERIODIC_SNAPSHOT)
     */
    Recorder(RecordMode mode = RecordMode::SPIKES_ONLY,
             std::vector<size_t> neuron_ids = {},
             std::vector<size_t> synapse_ids = {},
             size_t interval = 100);

    /// Capture a step boundary from the Network. Must be called immediately
    /// after Network::step() and BEFORE the next setExternalInput/clear.
    void recordStep(const Network& net);

    /// SPIKES_ONLY records only.
    const std::vector<SpikeRecord>& getSpikeRecords() const { return spike_records_; }

    /// SELECTED_NEURONS records.
    const std::vector<NeuronRecord>& getNeuronRecords() const { return neuron_records_; }

    /// SELECTED_SYNAPSES records.
    const std::vector<SynapseRecord>& getSynapseRecords() const { return synapse_records_; }

    /// FULL_STATE / PERIODIC_SNAPSHOT records.
    const std::vector<FullSnapshot>& getFullSnapshots() const { return full_snapshots_; }

    RecordMode getMode() const { return mode_; }

    /// Return the number of steps actually recorded.
    size_t size() const;

private:
    RecordMode mode_;
    std::vector<size_t> neuron_ids_;
    std::vector<size_t> synapse_ids_;
    size_t interval_;
    size_t steps_since_last_snapshot_;

    std::vector<SpikeRecord> spike_records_;
    std::vector<NeuronRecord> neuron_records_;
    std::vector<SynapseRecord> synapse_records_;
    std::vector<FullSnapshot> full_snapshots_;
};
