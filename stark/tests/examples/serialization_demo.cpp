/**
 * STARK-007: Checkpoint/Resume Demonstration
 *
 * Demonstrates that a Network saved at step K and loaded into a fresh Network
 * continues producing identical future dynamics to a network that ran continuously.
 *
 * Runs 200 steps:
 *   - Steps 0..99: build up state (STDP + three-factor + homeostasis)
 *   - Step 100: save checkpoint
 *   - Steps 101..199: continue running original network
 *
 * Then loads checkpoint into fresh network and runs steps 101..199.
 * Final states must be bitwise-identical (same build/platform).
 */

#include "neural/Network.h"
#include "neural/NeuralCell.h"
#include "neural/Synapse.h"
#include "experiment/Recorder.h"
#include <iostream>
#include <iomanip>
#include <cmath>
#include <algorithm>
#include <fstream>

static constexpr double DT = 0.1;
static constexpr double I_DRIVE = 15.0;
static constexpr size_t SAVE_AT = 100;
static constexpr size_t TOTAL = 200;
static constexpr const char* CHECKPOINT_PATH = "checkpoint.stark";

int main() {
    std::cout << "=== STARK-007 Checkpoint/Resume Demonstration ===\n\n";

    // ---- Build network with all mechanisms active ----
    Network net1;
    size_t A = net1.addNeuron(10.0, 1.0, 20.0, 0.1, 0.0);
    size_t B = net1.addNeuron(10.0, 1.0, 20.0, 0.1, 0.0);
    size_t C = net1.addNeuron(10.0, 1.0, 20.0, 0.1, 0.0);
    size_t s_stdp = net1.addSynapse(A, B, 0.5, 2.0, 0);
    size_t s_tf = net1.addSynapse(C, B, 0.3, 2.0, 0);
    net1.enablePlasticity(s_stdp, 0.01, 0.01, 20.0, 20.0, 0.0, 1.0);
    net1.enableThreeFactor(s_tf, 0.01, 0.01, 50.0, 0.5, 0.0, 1.0);
    net1.setHomeostasisParameters(1.0, 0.01, 10.0, 0.0);

    std::cout << "Built network: " << net1.getNeuronCount() << " neurons, "
              << net1.getSynapseCount() << " synapses\n";
    std::cout << "  Synapse " << s_stdp << ": mode="
              << (net1.getPlasticityMode(s_stdp) == PlasticityMode::STDP ? "STDP" : "OTHER")
              << ", w=" << net1.getSynapse(s_stdp).getWeight() << "\n";
    std::cout << "  Synapse " << s_tf << ": mode="
              << (net1.getPlasticityMode(s_tf) == PlasticityMode::THREEFACTOR ? "TF" : "OTHER")
              << ", w=" << net1.getSynapse(s_tf).getWeight() << "\n\n";

    // ---- Run first half continuously ----
    for (size_t t = 0; t < SAVE_AT; ++t) {
        net1.setExternalInput(A, I_DRIVE);
        net1.setExternalInput(B, 0.0);
        net1.setExternalInput(C, I_DRIVE * 0.5);
        net1.setModulatorySignal((t % 50 < 25) ? 1.0 : 0.0);
        net1.step(DT);
    }

    std::cout << "Ran steps 0.." << SAVE_AT - 1 << " continuously.\n";
    std::cout << "  Timestep: " << net1.getCurrentTimeStep() << "\n";
    std::cout << "  Spike count at step " << SAVE_AT - 1
              << ": A=" << net1.getSpikesThisStep()[A]
              << ", B=" << net1.getSpikesThisStep()[B]
              << ", C=" << net1.getSpikesThisStep()[C] << "\n";
    std::cout << "  w_STDP=" << net1.getSynapse(s_stdp).getWeight()
              << ", w_TF=" << net1.getSynapse(s_tf).getWeight() << "\n";
    std::cout << "  e_TF=" << net1.getEligibility(s_tf) << "\n";
    std::cout << "  r_mean_A=" << net1.getFiringRates()[A] << " Hz\n\n";

    // ---- Save checkpoint ----
    net1.save(CHECKPOINT_PATH);
    std::cout << "Saved checkpoint to " << CHECKPOINT_PATH << "\n";

    // ---- Continue first network to completion ----
    for (size_t t = SAVE_AT; t < TOTAL; ++t) {
        net1.setExternalInput(A, I_DRIVE);
        net1.setExternalInput(B, 0.0);
        net1.setExternalInput(C, I_DRIVE * 0.5);
        net1.setModulatorySignal((t % 50 < 25) ? 1.0 : 0.0);
        net1.step(DT);
    }

    std::cout << "Ran steps " << SAVE_AT << ".." << TOTAL - 1 << " (continuous).\n";
    std::cout << "  Timestep: " << net1.getCurrentTimeStep() << "\n";
    std::cout << "  w_STDP=" << net1.getSynapse(s_stdp).getWeight()
              << ", w_TF=" << net1.getSynapse(s_tf).getWeight() << "\n";
    std::cout << "  e_TF=" << net1.getEligibility(s_tf) << "\n";

    double w_stdp_cont = net1.getSynapse(s_stdp).getWeight();
    double w_tf_cont = net1.getSynapse(s_tf).getWeight();
    double e_tf_cont = net1.getEligibility(s_tf);
    double r_a_cont = net1.getFiringRates()[A];
    size_t ts_cont = net1.getCurrentTimeStep();
    bool spike_A_cont = net1.getSpikesThisStep()[A];
    bool spike_B_cont = net1.getSpikesThisStep()[B];

    // ---- Load checkpoint into fresh network ----
    Network net2;
    net2.load(CHECKPOINT_PATH);

    std::cout << "\nLoaded checkpoint into fresh network.\n";
    std::cout << "  Neurons: " << net2.getNeuronCount()
              << ", Synapses: " << net2.getSynapseCount()
              << ", Timestep: " << net2.getCurrentTimeStep() << "\n";

    // Verify pre-continuation equivalence
    if (net2.getNeuronCount() != 3 || net2.getSynapseCount() != 2) {
        std::cerr << "ERROR: topology mismatch after load\n";
        return 1;
    }
    if (net2.getCurrentTimeStep() != SAVE_AT) {
        std::cerr << "ERROR: timestep mismatch after load (expected " << SAVE_AT
                  << ", got " << net2.getCurrentTimeStep() << ")\n";
        return 1;
    }

    // ---- Run second network through same remaining steps ----
    for (size_t t = SAVE_AT; t < TOTAL; ++t) {
        net2.setExternalInput(A, I_DRIVE);
        net2.setExternalInput(B, 0.0);
        net2.setExternalInput(C, I_DRIVE * 0.5);
        net2.setModulatorySignal((t % 50 < 25) ? 1.0 : 0.0);
        net2.step(DT);
    }

    std::cout << "Ran steps " << SAVE_AT << ".." << TOTAL - 1 << " from checkpoint.\n";
    std::cout << "  Timestep: " << net2.getCurrentTimeStep() << "\n";
    std::cout << "  w_STDP=" << net2.getSynapse(s_stdp).getWeight()
              << ", w_TF=" << net2.getSynapse(s_tf).getWeight() << "\n";
    std::cout << "  e_TF=" << net2.getEligibility(s_tf) << "\n";

    // ---- Compare final states ----
    std::cout << "\n=== Comparison ===\n";
    bool ok = true;

    auto compare_double = [&](const std::string& name, double a, double b, double tol) {
        if (std::fabs(a - b) > tol) {
            std::cerr << "  FAIL: " << name << " differs: " << a << " vs " << b
                      << " (tol=" << tol << ")\n";
            ok = false;
        } else {
            std::cout << "  PASS: " << name << " = " << a << "\n";
        }
    };

    compare_double("w_STDP", net2.getSynapse(s_stdp).getWeight(), w_stdp_cont, 1e-12);
    compare_double("w_TF", net2.getSynapse(s_tf).getWeight(), w_tf_cont, 1e-12);
    compare_double("e_TF", net2.getEligibility(s_tf), e_tf_cont, 1e-12);
    compare_double("r_mean_A", net2.getFiringRates()[A], r_a_cont, 1e-12);
    compare_double("V_A", net2.getNeuron(A).getV(), net1.getNeuron(A).getV(), 1e-12);
    compare_double("V_B", net2.getNeuron(B).getV(), net1.getNeuron(B).getV(), 1e-12);
    compare_double("V_C", net2.getNeuron(C).getV(), net1.getNeuron(C).getV(), 1e-12);
    compare_double("a_A", net2.getNeuron(A).getA(), net1.getNeuron(A).getA(), 1e-12);
    compare_double("a_B", net2.getNeuron(B).getA(), net1.getNeuron(B).getA(), 1e-12);
    compare_double("a_C", net2.getNeuron(C).getA(), net1.getNeuron(C).getA(), 1e-12);
    compare_double("theta_A", net2.getNeuron(A).getTheta(), net1.getNeuron(A).getTheta(), 1e-12);

    auto& spikes1 = net1.getSpikesThisStep();
    auto& spikes2 = net2.getSpikesThisStep();
    for (size_t i = 0; i < net1.getNeuronCount(); ++i) {
        if (spikes1[i] != spikes2[i]) {
            std::cerr << "  FAIL: spike[" << i << "] differs\n";
            ok = false;
        } else {
            std::cout << "  PASS: spike[" << i << "] = " << (spikes1[i] ? 1 : 0) << "\n";
        }
    }

    if (net2.getCurrentTimeStep() != ts_cont) {
        std::cerr << "  FAIL: timestep mismatch: " << net2.getCurrentTimeStep()
                  << " vs " << ts_cont << "\n";
        ok = false;
    } else {
        std::cout << "  PASS: timestep = " << ts_cont << "\n";
    }

    // ---- Verify determinism of serialize output ----
    std::string serialized1 = net1.serialize();
    std::string serialized2 = net2.serialize();
    if (serialized1 != serialized2) {
        std::cerr << "  FAIL: serialized outputs differ\n";
        ok = false;
    } else {
        std::cout << "  PASS: deterministic serialization (bit-identical strings)\n";
    }

    std::cout << "\n";
    if (ok) {
        std::cout << "=== Checkpoint/Resume VERIFIED ===\n";
        std::cout << "Net saved at step " << SAVE_AT
                  << " resumes identically to continuous run.\n";
        return 0;
    } else {
        std::cerr << "=== Checkpoint/Resume FAILED ===\n";
        return 1;
    }
}
