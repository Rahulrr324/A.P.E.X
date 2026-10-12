#include "Experiment.h"
#include <stdexcept>

Experiment::Experiment(Network& net, double dt, size_t steps,
                       const std::vector<std::vector<double>>& external_inputs,
                       const std::vector<double>& modulatory_signals,
                       Recorder recorder)
    : net_(net),
      dt_(dt),
      steps_(steps),
      external_inputs_(external_inputs),
      modulatory_signals_(modulatory_signals),
      recorder_(std::move(recorder)) {
    if (dt_ <= 0.0 || !std::isfinite(dt_)) {
        throw std::invalid_argument("Experiment: dt must be > 0 and finite");
    }
    if (!net_.validateDt(dt_)) {
        throw std::invalid_argument("Experiment: dt is invalid for network components");
    }

    meta_.num_neurons = net_.getNeuronCount();
    meta_.num_synapses = net_.getSynapseCount();
    meta_.dt = dt_;
    meta_.steps = steps;
    meta_.checkpoint_interval = 0;  // No automatic checkpoints
    meta_.format_magic = "STARK006";
    meta_.schema_version = 2;

    // Resize external inputs if needed
    if (external_inputs_.size() > steps) {
        external_inputs_.resize(steps);
    }
}

void Experiment::run() {
    for (size_t t = 0; t < steps_; ++t) {
        // Apply external input schedule
        net_.clearExternalInputs();
        if (t < external_inputs_.size()) {
            const auto& input = external_inputs_[t];
            for (size_t i = 0; i < input.size() && i < net_.getNeuronCount(); ++i) {
                if (std::isfinite(input[i])) {
                    net_.setExternalInput(i, input[i]);
                }
            }
        }

        // Apply modulatory signal schedule
        if (t < modulatory_signals_.size() && std::isfinite(modulatory_signals_[t])) {
            net_.setModulatorySignal(modulatory_signals_[t]);
        } else {
            net_.clearModulatorySignal();
        }

        // Execute one step
        net_.step(dt_);

        // Record at step boundary (after step, before next setExternalInput)
        recorder_.recordStep(net_);
    }
}

void Experiment::saveCheckpoint(const std::string& path) const {
    try {
        net_.save(path);
    } catch (const std::exception& e) {
        throw std::runtime_error(std::string("Experiment::saveCheckpoint failed: ") + e.what());
    }
}

void Experiment::loadCheckpoint(const std::string& path) {
    try {
        net_.load(path);
        // Reset experiment state to reflect loaded network
        meta_.num_neurons = net_.getNeuronCount();
        meta_.num_synapses = net_.getSynapseCount();
        recorder_ = Recorder(recorder_.getMode(),
                             recorder_.getNeuronRecords().empty() ? std::vector<size_t>() : std::vector<size_t>(),
                             recorder_.getSynapseRecords().empty() ? std::vector<size_t>() : std::vector<size_t>(),
                             100);
    } catch (const std::exception& e) {
        throw std::runtime_error(std::string("Experiment::loadCheckpoint failed: ") + e.what());
    }
}
