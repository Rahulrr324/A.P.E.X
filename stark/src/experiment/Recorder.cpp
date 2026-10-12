#include "Recorder.h"
#include <algorithm>

Recorder::Recorder(RecordMode mode,
                   std::vector<size_t> neuron_ids,
                   std::vector<size_t> synapse_ids,
                   size_t interval)
    : mode_(mode),
      neuron_ids_(std::move(neuron_ids)),
      synapse_ids_(std::move(synapse_ids)),
      interval_(interval),
      steps_since_last_snapshot_(0) {}

void Recorder::recordStep(const Network& net) {
    const size_t step = net.getCurrentTimeStep();
    const size_t N = net.getNeuronCount();
    const size_t E = net.getSynapseCount();
    const auto& spikes = net.getSpikesThisStep();

    switch (mode_) {
        case RecordMode::SPIKES_ONLY: {
            SpikeRecord sr;
            sr.step_index = step;
            sr.spikes.assign(N, false);
            for (size_t i = 0; i < N; ++i) sr.spikes[i] = spikes[i];
            spike_records_.push_back(std::move(sr));
            break;
        }

        case RecordMode::SELECTED_NEURONS: {
            SpikeRecord sr;
            sr.step_index = step;
            sr.spikes.assign(N, false);
            for (size_t i = 0; i < N; ++i) sr.spikes[i] = spikes[i];
            spike_records_.push_back(std::move(sr));

            for (size_t nid : neuron_ids_) {
                if (nid >= N) continue;
                const NeuralCell& nc = net.getNeuron(nid);
                NeuronRecord nr;
                nr.step_index = step;
                nr.V = nc.getV();
                nr.a = nc.getA();
                nr.theta = nc.getTheta();
                nr.spiked = spikes[nid];
                if (net.isHomeostasisEnabled()) {
                    nr.r_mean = net.getFiringRates()[nid];
                    nr.homeo_scale = net.getHomeostaticScale(nid);
                } else {
                    nr.r_mean = 0.0;
                    nr.homeo_scale = 1.0;
                }
                neuron_records_.push_back(std::move(nr));
            }
            break;
        }

        case RecordMode::SELECTED_SYNAPSES: {
            SpikeRecord sr;
            sr.step_index = step;
            sr.spikes.assign(N, false);
            for (size_t i = 0; i < N; ++i) sr.spikes[i] = spikes[i];
            spike_records_.push_back(std::move(sr));

            for (size_t sid : synapse_ids_) {
                if (sid >= E) continue;
                const Synapse& s = net.getSynapse(sid);
                SynapseRecord srec;
                srec.step_index = step;
                srec.pre_neuron = net.getPreNeuron(sid);
                srec.post_neuron = net.getPostNeuron(sid);
                srec.w = s.getWeight();
                srec.x_pre = s.getPreTrace();
                srec.x_post = s.getPostTrace();
                srec.e = s.getEligibility();
                srec.mode = s.getPlasticityMode();
                synapse_records_.push_back(std::move(srec));
            }
            break;
        }

        case RecordMode::FULL_STATE: {
            FullSnapshot snap;
            snap.step_index = step;
            snap.neurons.reserve(N);
            for (size_t i = 0; i < N; ++i) {
                const NeuralCell& nc = net.getNeuron(i);
                NeuronRecord nr;
                nr.step_index = step;
                nr.V = nc.getV();
                nr.a = nc.getA();
                nr.theta = nc.getTheta();
                nr.spiked = spikes[i];
                if (net.isHomeostasisEnabled()) {
                    nr.r_mean = net.getFiringRates()[i];
                    nr.homeo_scale = net.getHomeostaticScale(i);
                } else {
                    nr.r_mean = 0.0;
                    nr.homeo_scale = 1.0;
                }
                snap.neurons.push_back(std::move(nr));
            }
            snap.synapses.reserve(E);
            for (size_t k = 0; k < E; ++k) {
                const Synapse& s = net.getSynapse(k);
                SynapseRecord srec;
                srec.step_index = step;
                srec.pre_neuron = net.getPreNeuron(k);
                srec.post_neuron = net.getPostNeuron(k);
                srec.w = s.getWeight();
                srec.x_pre = s.getPreTrace();
                srec.x_post = s.getPostTrace();
                srec.e = s.getEligibility();
                srec.mode = s.getPlasticityMode();
                snap.synapses.push_back(std::move(srec));
            }
            snap.modulatory_signal = net.getModulatorySignal();
            full_snapshots_.push_back(std::move(snap));
            break;
        }

        case RecordMode::PERIODIC_SNAPSHOT: {
            SpikeRecord sr;
            sr.step_index = step;
            sr.spikes.assign(N, false);
            for (size_t i = 0; i < N; ++i) sr.spikes[i] = spikes[i];
            spike_records_.push_back(std::move(sr));

            if (steps_since_last_snapshot_ >= interval_) {
                FullSnapshot snap;
                snap.step_index = step;
                snap.neurons.reserve(N);
                for (size_t i = 0; i < N; ++i) {
                    const NeuralCell& nc = net.getNeuron(i);
                    NeuronRecord nr;
                    nr.step_index = step;
                    nr.V = nc.getV();
                    nr.a = nc.getA();
                    nr.theta = nc.getTheta();
                    nr.spiked = spikes[i];
                    if (net.isHomeostasisEnabled()) {
                        nr.r_mean = net.getFiringRates()[i];
                        nr.homeo_scale = net.getHomeostaticScale(i);
                    } else {
                        nr.r_mean = 0.0;
                        nr.homeo_scale = 1.0;
                    }
                    snap.neurons.push_back(std::move(nr));
                }
                snap.synapses.reserve(E);
                for (size_t k = 0; k < E; ++k) {
                    const Synapse& s = net.getSynapse(k);
                    SynapseRecord srec;
                    srec.step_index = step;
                    srec.pre_neuron = net.getPreNeuron(k);
                    srec.post_neuron = net.getPostNeuron(k);
                    srec.w = s.getWeight();
                    srec.x_pre = s.getPreTrace();
                    srec.x_post = s.getPostTrace();
                    srec.e = s.getEligibility();
                    srec.mode = s.getPlasticityMode();
                    snap.synapses.push_back(std::move(srec));
                }
                snap.modulatory_signal = net.getModulatorySignal();
                full_snapshots_.push_back(std::move(snap));
                steps_since_last_snapshot_ = 0;
            } else {
                ++steps_since_last_snapshot_;
            }
            break;
        }
    }
}

size_t Recorder::size() const {
    return spike_records_.size();
}
