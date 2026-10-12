#pragma once

/**
 * STARK-007: Deterministic Experiment Harness
 *
 * A thin, replayable experiment runner that holds explicit deterministic
 * inputs and modulatory signals, calls Network::step(dt) at each step,
 * and records trajectory state through a Recorder.
 *
 * The harness does NOT implement any simulation logic — it only drives the
 * existing Network API with deterministic schedules.
 *
 * Usage:
 *   Experiment exp(net, dt, steps, external_inputs, modulatory_signals);
 *   exp.run();
 *   auto spike_records = exp.getRecorder().getSpikeRecords();
 */

#include "Recorder.h"
#include "neural/Network.h"
#include <vector>
#include <cstddef>

/// Metadata describing an experiment run.
struct ExperimentMetadata {
    size_t num_neurons;
    size_t num_synapses;
    double dt;                  ///< Fixed timestep (seconds)
    size_t steps;               ///< Total steps executed
    size_t checkpoint_interval; ///< 0 = no checkpoints
    std::string format_magic;   ///< e.g., "STARK006"
    int schema_version;         ///< e.g., 2
};

/**
 * Deterministic experiment harness.
 *
 * Holds optional explicit input schedules and a recorder.
 * Run executes the step loop. Checkpoints can be saved at intervals.
 */
class Experiment {
public:
    /**
     * Construct an experiment.
     *
     * @param net          Network to drive (must already be configured)
     * @param dt           Fixed timestep in seconds
     * @param steps        Number of timesteps to execute
     * @param external_inputs  Optional per-step per-neuron external current schedule
     * @param modulatory_signals Optional per-step modulator signal schedule
     * @param recorder     Optional recorder for trajectory capture
     */
    Experiment(Network& net, double dt, size_t steps,
               const std::vector<std::vector<double>>& external_inputs = {},
               const std::vector<double>& modulatory_signals = {},
               Recorder recorder = Recorder(RecordMode::SPIKES_ONLY));

    /// Run the experiment steps.
    void run();

    /// Save a checkpoint at the current step boundary.
    void saveCheckpoint(const std::string& path) const;

    /// Load a checkpoint into the network (replaces current state).
    void loadCheckpoint(const std::string& path);

    const Recorder& getRecorder() const { return recorder_; }
    const ExperimentMetadata& getMetadata() const { return meta_; }
    size_t getCurrentStep() const { return net_.getCurrentTimeStep(); }

private:
    Network& net_;
    double dt_;
    size_t steps_;
    std::vector<std::vector<double>> external_inputs_;
    std::vector<double> modulatory_signals_;
    Recorder recorder_;
    ExperimentMetadata meta_;
};
